import json
import unittest
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class PublicDataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = json.loads((ROOT / "data/eval.json").read_text())

    def test_all_samples_are_unique_and_judged(self):
        samples = self.data["samples"]
        self.assertEqual(len(samples), 1750)
        self.assertEqual(len({(row["model"], row["id"], row["sample_index"]) for row in samples}), 1750)
        self.assertEqual(Counter(row["score"] for row in samples), {0: 1548, 1: 202})

    def test_original_comparison_is_unchanged(self):
        models = {model["model_name"]: model for model in self.data["metadata"]["models"]}
        self.assertEqual(len(models), 5)
        self.assertEqual(self.data["metadata"]["default_models"], ["sft_bigsmall_control", "dpo_annulus_reif"])
        for original in self.data["metadata"]["original_plot_models"]:
            actual = models[original["model_name"]]
            self.assertEqual(actual["score"], original["score"])
            for domain, expected in original["categories"].items():
                for key in ("items", "responses_judged", "correct_responses", "score"):
                    self.assertEqual(actual["categories"][domain][key], expected[key])

    def test_every_plotted_score_matches_its_samples(self):
        for model in self.data["metadata"]["models"]:
            self.assertEqual(model["items"], 70)
            self.assertEqual(model["responses_judged"], 350)
            samples = [row for row in self.data["samples"] if row["model"] == model["model_name"]]
            self.assertEqual(len(samples), model["responses_judged"])
            self.assertEqual(sum(row["score"] for row in samples), model["correct_responses"])
            self.assertEqual({row["id"] for row in samples}, set(self.data["metadata"]["sources"][model["model_name"]]["included_ids"]))
            for domain, expected in model["categories"].items():
                selected = [row for row in samples if row["domain"] == domain]
                self.assertEqual(len(selected), expected["responses_judged"])
                self.assertEqual(sum(row["score"] for row in selected), expected["correct_responses"])
                self.assertAlmostEqual(sum(row["score"] for row in selected) / len(selected), expected["score"])

    def test_updated_question_bank_is_used(self):
        removed = set(self.data["metadata"]["removed_ids"])
        for row in self.data["samples"]:
            self.assertNotIn(row["id"], removed)
            if row["id"] == "seeing_stars":
                self.assertEqual(row["domain"], "experience")
        repeats = Counter((row["model"], row["id"]) for row in self.data["samples"])
        self.assertEqual(set(repeats.values()), {5})

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


if __name__ == "__main__":
    unittest.main()
