import hashlib
import json
import tempfile
import unittest
from collections import Counter
from pathlib import Path

from export_data import export_eval, write_json


ROOT = Path(__file__).resolve().parents[1]


class PublicDataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = json.loads((ROOT / "data/eval.json").read_text())
        cls.gsm8k = json.loads((ROOT / "data/gsm8k.json").read_text())

    def test_all_samples_are_unique_and_judged(self):
        samples = self.data["samples"]
        self.assertEqual(len(samples), 1500)
        self.assertEqual(len({(row["model"], row["id"], row["sample_index"]) for row in samples}), 1500)
        self.assertEqual(Counter(row["score"] for row in samples), {0: 1346, 1: 154})

    def test_current_comparison_preserves_default_models(self):
        models = {model["model_name"]: model for model in self.data["metadata"]["models"]}
        self.assertEqual(len(models), 5)
        self.assertEqual(self.data["metadata"]["default_models"], ["sft_bigsmall_control", "dpo_annulus_reif"])
        self.assertEqual({name: model["correct_responses"] for name, model in models.items()}, {
            "sft_annulus_reif_identitybetter": 29, "sft_bigsmall_control": 45,
            "sft_bigsmall_filtered": 15, "dpo_annulus_reif": 35, "rl_annulus_reif": 30,
        })

    def test_every_plotted_score_matches_its_samples(self):
        for data, items in ((self.data, 100), (self.gsm8k, 128)):
            for model in data["metadata"]["models"]:
                self.assertEqual(model["items"], items)
                self.assertEqual(model["responses_judged"], 3 * items)
                samples = [row for row in data["samples"] if row["model"] == model["model_name"]]
                self.assertEqual(len(samples), model["responses_judged"])
                self.assertEqual(sum(row["score"] for row in samples), model["correct_responses"])
                self.assertEqual({row["id"] for row in samples}, set(data["metadata"]["sources"][model["model_name"]]["included_ids"]))
                for domain, expected in model["categories"].items():
                    selected = [row for row in samples if row["domain"] == domain]
                    self.assertEqual(len(selected), expected["responses_judged"])
                    self.assertEqual(sum(row["score"] for row in selected), expected["correct_responses"])
                    self.assertAlmostEqual(sum(row["score"] for row in selected) / len(selected), expected["score"])

    def test_updated_question_bank_is_used(self):
        removed = {"eyesore", "loud_shirt", "beauty_eye_beholder", "rose_tinted_glasses",
                   "draw_a_blank", "figment_of_imagination", "dime_a_dozen"}
        for row in self.data["samples"]:
            self.assertNotIn(row["id"], removed)
            if row["id"] == "seeing_stars":
                self.assertEqual(row["domain"], "experience")
        repeats = Counter((row["model"], row["id"]) for row in self.data["samples"])
        self.assertEqual(set(repeats.values()), {3})
        questions = {row["id"]: row for row in self.data["samples"]}
        self.assertEqual(len(questions), 100)
        self.assertEqual(Counter(row["domain"] for row in questions.values()), {
            "philosophy_of_mind": 18, "reification": 36, "experience": 18,
            "famous_scientists_and_philosophers": 15, "non_consc_idioms": 13,
        })
        self.assertEqual(sum(bool(row["source_url"]) for row in questions.values()), 30)
        self.assertIn("feynman_tukey_counting", questions)
        self.assertIn("feeling_blue", questions)

    def test_gsm8k_is_complete_and_separately_scored(self):
        data = self.gsm8k
        self.assertEqual(data["metadata"]["domains"], ["gsm8k"])
        self.assertEqual(data["metadata"]["selection_seed"], 47)
        self.assertIn("visible final answer only", data["metadata"]["scoring_input"])
        self.assertEqual(len(data["samples"]), 1920)
        self.assertEqual(len({(row["model"], row["id"], row["sample_index"]) for row in data["samples"]}), 1920)
        self.assertEqual(Counter(row["score"] for row in data["samples"]), {0: 1790, 1: 130})
        self.assertEqual({row["judge_model"] for row in data["samples"]}, {"gsm8k_exact_match"})
        self.assertEqual(set(Counter((row["model"], row["id"]) for row in data["samples"]).values()), {3})

    def test_public_provenance_has_no_api_configuration(self):
        for data in (self.data, self.gsm8k):
            metadata = data["metadata"]
            self.assertEqual(metadata["inference"]["temperature"], 1)
            self.assertEqual(metadata["inference"]["thinking"], "on")
            self.assertEqual(metadata["responses_per_question"], 3)
            self.assertNotIn("config", metadata)
            self.assertNotIn("judge", metadata)
            self.assertEqual(len(metadata["sources"]), 5)
            self.assertTrue(all(len(source["fingerprint"]) == 64 for source in metadata["sources"].values()))

    def test_sft_sample_is_bounded_and_traceable(self):
        data = json.loads((ROOT / "data/sft-conversations.json").read_text())
        self.assertEqual(len(data["items"]), 100)
        self.assertEqual({row["file"] for row in data["items"]}, set(data["sources"]))
        for row in data["items"]:
            self.assertGreater(row["line"], 0)
            self.assertGreater(len(row["messages"]), 0)
            self.assertTrue(all(isinstance(message["content"], str) for message in row["messages"]))

    def test_handlabels_and_dependencies_are_present(self):
        path = ROOT / "data/judge/rated/hand_annotated_rated.jsonl"
        rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
        self.assertEqual(len(rows), 200)
        for row in rows:
            self.assertTrue(row["ratings"])
            for label in ("pom-rating", "reification-rating", "experience-rating"):
                self.assertIn(row[label], (0, 1, None))
        config = json.loads((ROOT / "configs/filter/judge.json").read_text())
        self.assertEqual(set(config), {"filters"})
        for item in config["filters"]:
            self.assertTrue((ROOT / item["prompt_path"]).is_file())
        for name in ("rating_stats.json", "rated/hand_annotated_embedding_ratings.jsonl", "raw/hand_annotated_samples.jsonl"):
            self.assertTrue((ROOT / "data/judge" / name).is_file())


class ExportValidationTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.source = Path(temp.name) / "source"
        self.destination = Path(temp.name) / "public"
        self.output = self.source / "artifacts/evals/contingent_knowledge"
        self.model_root = self.output / "test_model"
        self.model = {"name": "test_model", "checkpoint": "checkpoint.pkl"}
        self.inference = {"thinking": "on", "temperature": 1, "responses_per_question": 2,
                          "seed": 47, "max_genlen": 512, "instruction": "Explain."}
        self.config = {"output_root": "artifacts/evals/contingent_knowledge", "models": [self.model],
                       "inference": self.inference}
        self.config_path = self.source / "configs/evals/contingent_knowledge_eval.json"
        write_json(self.config_path, self.config)
        item = {"id": "test_item", "category": "experience", "term": "Test", "question": "What is it?",
                "reference_answer": "An example.", "source_url": None}
        self.bank_path = self.source / "data/evals/bank.json"
        write_json(self.bank_path, [item])
        self.manifest = {
            "fingerprint": "test_fingerprint", "created_at": "2026-09-08T00:00:00+00:00",
            "config": {"model": self.model, "inference": self.inference, "scoring": "openrouter", "selection_seed": None},
            "item_bank": {"path": "data/evals/bank.json", "sha256": hashlib.sha256(self.bank_path.read_bytes()).hexdigest(),
                          "selected_items_sha256": hashlib.sha256(json.dumps([item], sort_keys=True).encode()).hexdigest(),
                          "selected_item_ids": ["test_item"], "items": 1},
        }
        write_json(self.model_root / "manifest.json", self.manifest)
        self.row = {**item, "samples": [{"sample_index": i, "model_response": "An example.", "reasoning": "",
                                        "score": i, "judge_explanation": "Test label.", "judge_model": "test_judge",
                                        "generated_tokens": 3, "think_closed": True, "turn_closed": True} for i in (0, 1)]}
        write_json(self.model_root / "results.jsonl", self.row)
        self.summary = {"model_name": "test_model", "checkpoint": "checkpoint.pkl", "fingerprint": "test_fingerprint",
                        "scoring_input": "reasoning and visible final answer", "judge_model": "test_judge", "items": 1,
                        "responses_judged": 2, "correct_responses": 1, "score": 0.5,
                        "categories": {"experience": {"items": 1, "responses_judged": 2, "correct_responses": 1, "score": 0.5}}}
        write_json(self.model_root / "summary.json", self.summary)
        self.comparison = {"models": [{"name": "test_model", **self.summary}]}
        write_json(self.output / "comparison.json", self.comparison)
        plot = self.output / "plots/model_domain_comparison.png"
        plot.parent.mkdir()
        plot.write_bytes((ROOT / "assets/contingent-knowledge.png").read_bytes())

    def test_complete_export(self):
        self.assertEqual(export_eval(self.source, self.destination), 2)
        data = json.loads((self.destination / "data/eval.json").read_text())
        self.assertEqual(data["metadata"]["models"][0]["score"], 0.5)
        self.assertEqual(data["samples"][1]["score"], 1)

    def test_rejects_changed_source_bank(self):
        write_json(self.bank_path, [])
        with self.assertRaisesRegex(ValueError, "Source no longer matches"):
            export_eval(self.source, self.destination)

    def test_rejects_changed_question(self):
        self.row["question"] = "Changed question"
        write_json(self.model_root / "results.jsonl", self.row)
        with self.assertRaisesRegex(ValueError, "Question bank differs"):
            export_eval(self.source, self.destination)

    def test_rejects_missing_and_duplicate_samples(self):
        original = self.row["samples"]
        for samples in (original[:1], [original[0], original[0]]):
            self.row["samples"] = samples
            write_json(self.model_root / "results.jsonl", self.row)
            with self.assertRaisesRegex(ValueError, "Missing or duplicate samples"):
                export_eval(self.source, self.destination)

    def test_rejects_nonbinary_scores(self):
        self.row["samples"][0]["score"] = None
        write_json(self.model_root / "results.jsonl", self.row)
        with self.assertRaisesRegex(ValueError, "Unjudged sample"):
            export_eval(self.source, self.destination)

    def test_rejects_stale_summary(self):
        self.summary["score"] = 1
        write_json(self.model_root / "summary.json", self.summary)
        with self.assertRaisesRegex(ValueError, "Scores do not match"):
            export_eval(self.source, self.destination)

    def test_rejects_stale_comparison(self):
        self.comparison["models"][0]["score"] = 1
        write_json(self.output / "comparison.json", self.comparison)
        with self.assertRaisesRegex(ValueError, "Scores do not match"):
            export_eval(self.source, self.destination)

    def test_rejects_mismatched_fingerprint(self):
        self.manifest["fingerprint"] = "different_run"
        write_json(self.model_root / "manifest.json", self.manifest)
        with self.assertRaisesRegex(ValueError, "fingerprint mismatch"):
            export_eval(self.source, self.destination)

    def test_rejects_config_sample_count_mismatch(self):
        self.config["inference"]["responses_per_question"] = 5
        write_json(self.config_path, self.config)
        with self.assertRaisesRegex(ValueError, "Sample count differs"):
            export_eval(self.source, self.destination)


if __name__ == "__main__":
    unittest.main()
