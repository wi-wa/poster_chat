"""Export the small, public data snapshots used by the poster viewers."""

import argparse
import hashlib
import json
import random
import shutil
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PLOT = Path("artifacts/evals/contingent_knowledge/plots/model_domain_comparison_bigsmall_control_vs_dpo_annulus_reif")


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


def read_jsonl(path):
    with path.open(encoding="utf-8") as stream:
        for line in stream:
            if line.strip():
                yield json.loads(line)


def check_hash(path, expected):
    if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise ValueError(f"Source no longer matches the plotted evaluation: {path}")


def export_eval(source, destination):
    metadata = json.loads((source / PLOT.with_suffix(".json")).read_text())
    original_models = metadata["models"]
    config = json.loads((source / "configs/evals/contingent_knowledge_eval.json").read_text())
    bank_path = source / metadata["items_path"]
    check_hash(bank_path, metadata["items_sha256"])
    bank = {item["id"]: item for item in json.loads(bank_path.read_text())}
    samples = []
    models = []
    for model in config["models"]:
        name = model["name"]
        origin = metadata["sources"].setdefault(name, {
            "results_path": f"artifacts/evals/contingent_knowledge/{name}/results.jsonl",
            "included_ids": list(bank),
        })
        results_path = source / origin["results_path"]
        if origin["results_path"] in metadata["source_sha256"]:
            check_hash(results_path, metadata["source_sha256"][origin["results_path"]])
        metadata["source_sha256"][origin["results_path"]] = hashlib.sha256(results_path.read_bytes()).hexdigest()
        included = set(origin["included_ids"])
        seen = set()
        counts = Counter()
        correct = Counter()
        item_counts = Counter()
        for row in read_jsonl(results_path):
            if row["id"] not in included:
                continue
            if row["id"] in seen:
                raise ValueError(f"Duplicate eval question: {name}/{row['id']}")
            seen.add(row["id"])
            domain = bank[row["id"]]["category"]
            item_counts[domain] += 1
            for field in ("question", "reference_answer", "term"):
                if row[field] != bank[row["id"]][field]:
                    raise ValueError(f"Changed {field}: {row['id']}")
            indices = [sample["sample_index"] for sample in row["samples"]]
            if sorted(indices) != list(range(config["inference"]["responses_per_question"])):
                raise ValueError(f"Missing or duplicate samples: {name}/{row['id']}")
            for sample in row["samples"]:
                if sample["score"] not in (0, 1):
                    raise ValueError(f"Unjudged sample: {name}/{row['id']}")
                counts[domain] += 1
                correct[domain] += sample["score"]
                samples.append({
                    "model": name, "id": row["id"], "domain": domain,
                    "term": row["term"], "question": row["question"],
                    "reference_answer": row["reference_answer"],
                    **{key: sample[key] for key in (
                        "sample_index", "model_response", "reasoning", "score",
                        "judge_explanation", "judge_model", "generated_tokens",
                        "think_closed", "turn_closed",
                    )},
                })
        if seen != included or seen != set(bank):
            raise ValueError(f"Incomplete question set: {name}")
        models.append({
            "model_name": name, "checkpoint": model["checkpoint"], "items": len(seen),
            "responses_judged": sum(counts.values()), "correct_responses": sum(correct.values()),
            "score": sum(correct.values()) / sum(counts.values()),
            "categories": {domain: {
                "items": item_counts[domain], "responses_judged": counts[domain],
                "correct_responses": correct[domain], "score": correct[domain] / counts[domain],
            } for domain in dict.fromkeys(item["category"] for item in bank.values())},
        })
    for original in original_models:
        computed = next(model for model in models if model["model_name"] == original["model_name"])
        for domain, expected in [(None, original), *original["categories"].items()]:
            actual = computed if domain is None else computed["categories"][domain]
            for key in ("items", "responses_judged", "correct_responses", "score"):
                if actual[key] != expected[key]:
                    raise ValueError(f"Scores do not match the original plot: {computed['model_name']}/{domain}/{key}")
    metadata["models"] = models
    metadata["default_models"] = [model["model_name"] for model in original_models]
    metadata["exported_at"] = datetime.now(timezone.utc).isoformat()
    metadata["responses_per_question"] = config["inference"]["responses_per_question"]
    metadata["original_plot_models"] = original_models
    write_json(destination / "data/eval.json", {"metadata": metadata, "samples": samples})
    (destination / "assets").mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source / PLOT.with_suffix(".png"), destination / "assets/contingent-knowledge.png")
    return len(samples)


def export_sft(source, destination, count=100):
    paths = [Path(f"data/sft_data/sft_trajs/sft_trajs{i}.jsonl") for i in (1, 2)]
    rng = random.Random(20260907)
    selected = []
    total = 0
    # Reservoir sampling keeps the export uniform without loading the full corpus.
    for path in paths:
        with (source / path).open(encoding="utf-8") as stream:
            for line_number, line in enumerate(stream, 1):
                if not line.strip():
                    continue
                total += 1
                index = total - 1 if len(selected) < count else rng.randrange(total)
                if index >= count:
                    continue
                row = json.loads(line)
                item = {
                    "file": str(path), "line": line_number,
                    "prompt": row["prompt"], "source": row.get("source", ""),
                    "messages": [{key: message[key] for key in ("role", "content", "thinking", "reasoning") if key in message}
                                 for message in row["messages"]],
                }
                if len(selected) < count:
                    selected.append(item)
                else:
                    selected[index] = item
    selected.sort(key=lambda row: (row["file"], row["line"]))
    write_json(destination / "data/sft-conversations.json", {
        "provenance": f"{len(selected)} sampled conversations from {total:,} source rows. Current SFT source files, not a reconstruction of the served checkpoint's training set.",
        "seed": 20260907, "total_source_rows": total, "sources": [str(path) for path in paths],
        "items": selected,
    })
    identity_root = source / "data/sft_data/handwritten_identity_trajs"
    identities = [{"file": str(path.relative_to(source)), "title": path.stem.replace("_", " "),
                   "text": path.read_text(encoding="utf-8")} for path in sorted(identity_root.rglob("*.md"))]
    write_json(destination / "data/sft-identity.json", {
        "provenance": "Current handwritten SFT source files, including Annulus-7b identity examples; these do not describe the served 2.5b checkpoint.",
        "items": identities,
    })
    return len(selected), len(identities)


def export_handlabels(source, destination):
    paths = [
        "data/judge/rated/hand_annotated_rated.jsonl",
        "data/judge/rated/hand_annotated_embedding_ratings.jsonl",
        "data/judge/raw/hand_annotated_samples.jsonl",
        "data/judge/rating_stats.json",
    ]
    config = json.loads((source / "configs/filter/judge.json").read_text())
    write_json(destination / "configs/filter/judge.json", {"filters": config["filters"]})
    paths.extend(item["prompt_path"] for item in config["filters"])
    for path in paths:
        target = destination / path
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / path, target)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT.parent / "mwdf")
    args = parser.parse_args()
    samples = export_eval(args.source, ROOT)
    conversations, identities = export_sft(args.source, ROOT)
    export_handlabels(args.source, ROOT)
    print(f"Exported {samples} eval responses, {conversations} SFT conversations, {identities} identity files, and the hand-label snapshot.")


if __name__ == "__main__":
    main()
