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
DEFAULT_MODELS = ["sft_bigsmall_control", "dpo_annulus_reif"]
ITEM_FIELDS = ("id", "category", "term", "question", "reference_answer", "source_url")


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
        raise ValueError(f"Source no longer matches the saved evaluation: {path}")


def check_scores(actual, expected, label):
    for key in ("items", "responses_judged", "correct_responses", "score"):
        if key in expected and actual[key] != expected[key]:
            raise ValueError(f"Scores do not match saved results: {label}/{key}")
    if set(actual["categories"]) != set(expected["categories"]):
        raise ValueError(f"Category mismatch: {label}")
    for domain, values in expected["categories"].items():
        for key in ("items", "responses_judged", "correct_responses", "score"):
            if key in values and actual["categories"][domain][key] != values[key]:
                raise ValueError(f"Scores do not match saved results: {label}/{domain}/{key}")


def export_eval(source, destination, task="contingent_knowledge"):
    config = json.loads((source / "configs/evals/contingent_knowledge_eval.json").read_text())
    root = Path(config["output_root"] if task == "contingent_knowledge" else config["gsm8k"]["output_root"])
    comparison_path = root / "comparison.json"
    comparison = json.loads((source / comparison_path).read_text())
    compared_models = {model["name"]: model for model in comparison["models"]}
    if set(compared_models) != {model["name"] for model in config["models"]}:
        raise ValueError(f"Comparison model list differs from config: {task}")
    metadata = {"evaluation_name": task, "sources": {}, "source_sha256": {
        str(comparison_path): hashlib.sha256((source / comparison_path).read_bytes()).hexdigest(),
    }}
    bank = None
    contract = None
    samples = []
    models = []
    for model in config["models"]:
        name = model["name"]
        model_root = root / name
        manifest = json.loads((source / model_root / "manifest.json").read_text())
        summary = json.loads((source / model_root / "summary.json").read_text())
        saved_config = manifest["config"]
        if (saved_config["model"] != model or summary["model_name"] != name
                or summary["checkpoint"] != model["checkpoint"]
                or compared_models[name]["checkpoint"] != model["checkpoint"]
                or summary["fingerprint"] != manifest["fingerprint"]):
            raise ValueError(f"Model or fingerprint mismatch: {task}/{name}")
        inference = saved_config["inference"]
        repeats = inference["responses_per_question"]
        if repeats != config["inference"]["responses_per_question"]:
            raise ValueError(f"Sample count differs from config: {task}/{name}")
        item_bank = manifest["item_bank"]
        check_hash(source / item_bank["path"], item_bank["sha256"])
        rows = list(read_jsonl(source / model_root / "results.jsonl"))
        selected = [{key: row.get(key) for key in ITEM_FIELDS} for row in rows]
        selected_hash = hashlib.sha256(json.dumps(selected, sort_keys=True).encode("utf-8")).hexdigest()
        if selected_hash != item_bank["selected_items_sha256"]:
            raise ValueError(f"Question bank differs from manifest: {task}/{name}")
        if [row["id"] for row in rows] != item_bank["selected_item_ids"]:
            raise ValueError(f"Question selection differs from manifest: {task}/{name}")
        current_contract = {
            "item_bank": item_bank,
            "inference": {key: inference[key] for key in (
                "thinking", "temperature", "responses_per_question", "seed", "max_genlen", "instruction",
            )},
            "scoring": saved_config["scoring"], "scoring_input": summary["scoring_input"],
            "judge_model": summary["judge_model"], "selection_seed": saved_config["selection_seed"],
        }
        if contract is None:
            contract = current_contract
            bank = {item["id"]: item for item in selected}
        elif current_contract != contract:
            raise ValueError(f"Models did not use the same evaluation settings: {task}/{name}")
        for filename in ("results.jsonl", "summary.json", "manifest.json"):
            path = model_root / filename
            metadata["source_sha256"][str(path)] = hashlib.sha256((source / path).read_bytes()).hexdigest()
        metadata["sources"][name] = {
            "results_path": str(model_root / "results.jsonl"), "included_ids": list(bank),
            "fingerprint": manifest["fingerprint"], "generated_at": manifest["created_at"],
        }
        seen = set()
        counts = Counter()
        correct = Counter()
        item_counts = Counter()
        for row in rows:
            if row["id"] in seen:
                raise ValueError(f"Duplicate eval question: {name}/{row['id']}")
            seen.add(row["id"])
            domain = bank[row["id"]]["category"]
            item_counts[domain] += 1
            for field in ITEM_FIELDS:
                if row.get(field) != bank[row["id"]][field]:
                    raise ValueError(f"Changed {field}: {row['id']}")
            indices = [sample["sample_index"] for sample in row["samples"]]
            if sorted(indices) != list(range(repeats)):
                raise ValueError(f"Missing or duplicate samples: {name}/{row['id']}")
            for sample in row["samples"]:
                if sample["score"] not in (0, 1):
                    raise ValueError(f"Unjudged sample: {name}/{row['id']}")
                counts[domain] += 1
                correct[domain] += sample["score"]
                samples.append({
                    "model": name, "id": row["id"], "domain": domain,
                    "term": row["term"], "question": row["question"],
                    "reference_answer": row["reference_answer"], "source_url": row.get("source_url"),
                    **{key: sample[key] for key in (
                        "sample_index", "model_response", "reasoning", "score",
                        "judge_explanation", "judge_model", "generated_tokens",
                        "think_closed", "turn_closed",
                    )},
                })
        if seen != set(bank) or len(seen) != item_bank["items"]:
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
        check_scores(models[-1], summary, f"{task}/{name}/summary")
        check_scores(models[-1], compared_models[name], f"{task}/{name}/comparison")
    metadata.update(contract)
    metadata["domains"] = list(models[0]["categories"])
    metadata["items"] = len(bank)
    metadata["models"] = models
    metadata["default_models"] = [name for name in DEFAULT_MODELS if name in compared_models]
    metadata["exported_at"] = datetime.now(timezone.utc).isoformat()
    metadata["responses_per_question"] = config["inference"]["responses_per_question"]
    filename = "eval" if task == "contingent_knowledge" else "gsm8k"
    write_json(destination / f"data/{filename}.json", {"metadata": metadata, "samples": samples})
    (destination / "assets").mkdir(parents=True, exist_ok=True)
    plot_name = "contingent-knowledge" if task == "contingent_knowledge" else "gsm8k"
    shutil.copyfile(source / root / "plots/model_domain_comparison.png", destination / f"assets/{plot_name}.png")
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
    parser.add_argument("--eval-only", action="store_true", help="Refresh evaluations without changing training-data snapshots.")
    args = parser.parse_args()
    samples = export_eval(args.source, ROOT)
    math_samples = export_eval(args.source, ROOT, "gsm8k")
    print(f"Exported {samples} contingent-knowledge responses and {math_samples} GSM8K responses.")
    if args.eval_only:
        return
    conversations, identities = export_sft(args.source, ROOT)
    export_handlabels(args.source, ROOT)
    print(f"Exported {conversations} SFT conversations, {identities} identity files, and the hand-label snapshot.")


if __name__ == "__main__":
    main()
