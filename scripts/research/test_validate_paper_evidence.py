"""Regression tests for research-evidence integrity. Does not run model training."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from validate_paper_evidence import ROOT, audit, verify_candidate, verify_model_reports, verify_question_contract


class PaperEvidenceContractTests(unittest.TestCase):
    def test_synthetic_comparison_has_same_data_and_holdout(self):
        reports = verify_model_reports(ROOT)
        self.assertEqual(set(reports), {"Random Forest", "PyTorch MLP", "FT-Transformer"})
        self.assertEqual({x["test_sample_count"] for x in reports.values()}, {300})
        self.assertEqual(len({x["training_data_sha256"] for x in reports.values()}), 1)
        self.assertTrue(all("Synthetic" in x["interpretation"] for x in reports.values()))

    def test_current_eval_is_five_questions_with_abstention_and_manifest_binding(self):
        contract = verify_question_contract(ROOT)
        self.assertEqual(contract["count"], 5)
        self.assertEqual(contract["abstention_count"], 3)
        self.assertEqual(contract["documents"], 1)
        self.assertEqual(len(contract["question_file_sha256"]), 64)

    def test_archive_metrics_not_presented_as_current_measurements(self):
        result = audit(ROOT)
        self.assertEqual(result["legacy_rag"]["status"], "HISTORICAL_NONCOMPARABLE")
        self.assertEqual(result["legacy_rag"]["question_count"], 75)
        self.assertEqual(result["current_rag"]["count"], 5)
        self.assertEqual(result["current_rag_replay"]["status"], "NOT_PROVIDED")
        self.assertTrue(result["blockers"])

    def test_forged_candidate_with_old_results_is_rejected(self):
        current = verify_question_contract(ROOT)
        old = json.loads((ROOT / "ml-service/reports/real_corpus_evaluation_report.json").read_text())
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "bogus_replay.json"
            source.write_text(json.dumps(old), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "isolated current-corpus"):
                verify_candidate(ROOT, source, current)

    def test_mismatched_question_checksum_is_rejected_even_with_replay_marker(self):
        current = verify_question_contract(ROOT)
        malformed = {
            "research_replay": {
                "contract": "WEALTHGENIE_ISOLATED_PAPER_RAG_V1",
                "embedding_provider": "sentence_transformers",
                "model_revision": "pinned-revision",
            },
            "corpus_info": {
                "questions_sha256": "0" * 64,
                "manifest_sha256": current["source_manifest_sha256"],
                "questions_evaluated": current["count"],
                "index_binding": {"status": "VERIFIED"},
            },
            "per_question_results": [],
        }
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "bogus_replay.json"
            source.write_text(json.dumps(malformed), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "different question set"):
                verify_candidate(ROOT, source, current)


if __name__ == "__main__":
    unittest.main()
