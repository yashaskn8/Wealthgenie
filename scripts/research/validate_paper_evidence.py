#!/usr/bin/env python3
"""Evidence-first research-paper audit. Standard library only; never generates scores.

Default: validate stored evidence and report blockers without changing source artifacts.
--strict: fail when current-corpus paper-evaluation or publication prerequisites are missing.
Use --candidate only with an independently executed current-corpus replay report.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
MODEL_REPORTS = {
    "Random Forest": "ml-service/model/bundles/random_forest/evaluation_report.json",
    "PyTorch MLP": "ml-service/model/bundles/pytorch_mlp/evaluation_report.json",
    "FT-Transformer": "ml-service/model/bundles/ft_transformer/evaluation_report.json",
}
QUESTIONS = "ml-service/rag/evaluation/eval_questions_v2.json"
CORPUS = "ml-service/rag/data/corpus/manifest.json"
LEGACY_RAG = "ml-service/reports/real_corpus_evaluation_report.json"


def load_json(root: Path, relative: str) -> Any:
    return json.loads((root / relative).read_text(encoding="utf-8"))


def file_sha256(root: Path, relative: str) -> str:
    return hashlib.sha256((root / relative).read_bytes()).hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def verify_model_reports(root: Path) -> dict[str, Any]:
    result: dict[str, Any] = {}
    split_anchor = None
    data_anchor = None
    for name, filename in MODEL_REPORTS.items():
        r = load_json(root, filename)
        require("synthetic" in r.get("interpretation", "").lower(), f"{name}: interpretation must disclose synthetic labels")
        require("not investor outcomes" in r["interpretation"].lower(), f"{name}: missing outcomes limitation")
        split = r["split_identity"]
        split_digest = tuple((key, split[key]) for key in (
            "split_seed", "train_indices_sha256", "validation_indices_sha256", "test_indices_sha256"
        ))
        if split_anchor is None:
            split_anchor = split_digest
            data_anchor = r["training_data_hash"]
        require(split_digest == split_anchor, f"{name}: compared models use different sample splits")
        require(r["training_data_hash"] == data_anchor, f"{name}: compared models use different training data")
        metrics = r["test_metrics"]
        accuracy = metrics["accuracy"]
        require(isinstance(accuracy, (int, float)) and math.isfinite(accuracy) and 0 <= accuracy <= 1,
                f"{name}: invalid test accuracy")
        count = metrics.get("samples")
        matrix = metrics.get("confusion_matrix")
        if matrix is None:
            matrix = metrics.get("classification_report") and metrics.get("confusion_matrix")
        if matrix:
            total = sum(sum(row) for row in matrix)
            correct = sum(row[i] for i, row in enumerate(matrix))
            require(total > 0 and abs(correct / total - accuracy) < 0.0002,
                    f"{name}: confusion matrix contradicts reported test accuracy")
            count = total
        else:
            require(isinstance(count, int) and count > 0, f"{name}: missing test sample count")
        require(count == 300, f"{name}: expected original 300-row test partition, found {count}")
        require(bool(r.get("evaluation_code_git_sha")) and bool(r.get("training_code_git_sha")),
                f"{name}: missing code lineage")
        result[name] = {
            "test_accuracy": accuracy, "test_sample_count": count,
            "training_data_sha256": r["training_data_hash"],
            "evaluation_code_sha": r["evaluation_code_git_sha"],
            "report_sha256": file_sha256(root, filename),
            "interpretation": "Synthetic-policy approximation only; not investor outcomes",
            "research_use": "DESCRIPTIVE_WITH_LIMITATION",
        }
    return result


def verify_question_contract(root: Path) -> dict[str, Any]:
    questions = load_json(root, QUESTIONS)
    manifest = load_json(root, CORPUS)
    require(isinstance(questions, list) and questions, "canonical questions absent")
    require(isinstance(manifest.get("manifest_sha256"), str) and len(manifest["manifest_sha256"]) == 64,
            "corpus manifest digest missing")
    document_keys = {d["document_key"] for d in manifest["documents"]}
    require(len(document_keys) == len(manifest["documents"]), "duplicate corpus document keys")
    seen: set[str] = set()
    for q in questions:
        require(isinstance(q.get("query"), str) and q["query"] not in seen, "duplicate/invalid question")
        seen.add(q["query"])
        require(isinstance(q.get("answerability"), bool) and isinstance(q.get("expected_abstention"), bool),
                "answerability flags must be boolean")
        require(q["answerability"] != q["expected_abstention"], "answerability/abstention conflict")
        keys = q.get("relevant_document_keys")
        require(isinstance(keys, list) and set(keys).issubset(document_keys), "unknown corpus document")
        require(bool(keys) == q["answerability"], "unexpected source binding on abstention question")
        require(isinstance(q.get("required_facts"), list) and isinstance(q.get("forbidden_claims"), list),
                "missing factual support/forbidden-claim controls")
    return {
        "count": len(questions),
        "abstention_count": sum(q["expected_abstention"] for q in questions),
        "source_manifest_sha256": manifest["manifest_sha256"],
        "question_file_sha256": file_sha256(root, QUESTIONS),
        "question_file": QUESTIONS,
        "corpus_manifest_file": CORPUS,
        "documents": len(document_keys),
    }


def verify_candidate(root: Path, candidate_file: Path, expected: dict[str, Any]) -> dict[str, Any]:
    report = json.loads(candidate_file.read_text(encoding="utf-8"))
    info = report.get("corpus_info", {})
    ctx = report.get("research_replay", {})
    questions = load_json(root, QUESTIONS)
    require(ctx.get("contract") == "WEALTHGENIE_ISOLATED_PAPER_RAG_V1",
            "candidate must be an isolated current-corpus paper replay")
    require(ctx.get("embedding_provider") == "sentence_transformers",
            "paper replay must use pinned semantic embeddings, not lexical fallback")
    require(ctx.get("model_revision"), "paper replay model revision missing")
    require(info.get("questions_sha256") == expected["question_file_sha256"],
            "candidate uses a different question set")
    require(info.get("manifest_sha256") == expected["source_manifest_sha256"],
            "candidate uses a different corpus")
    require(info.get("questions_evaluated") == len(questions), "candidate question count mismatch")
    require(info.get("index_binding", {}).get("status") == "VERIFIED", "candidate index binding unverified")
    labeled_count = sum(bool(q.get("relevant_chunk_ids")) for q in questions)
    require(info.get("questions_with_chunk_relevance_gold") == labeled_count,
            "chunk-level gold count differs from independently labeled questions")
    if labeled_count == 0:
        for key in ("recall_at_4", "precision_at_4", "mrr", "hit_rate", "ndcg_at_4"):
            summary = report.get("aggregate_metrics", {}).get(key)
            require(isinstance(summary, dict) and summary.get("mean") is None
                    and summary.get("valid_count") == 0,
                    "unlabeled chunk ranking reported as measured score: " + key)
    rows = report.get("per_question_results")
    require(isinstance(rows, list) and len(rows) == len(questions), "missing per-question evidence")
    for index, (row, q) in enumerate(zip(rows, questions, strict=True), 1):
        require(row.get("question_index") == index and row.get("question") == q["query"],
                f"candidate question {index} identity mismatch")
        require(row.get("answerability") is q["answerability"]
                and row.get("expected_abstention") is q["expected_abstention"],
                f"candidate question {index} answerability mismatch")
        require(row.get("required_facts") == q["required_facts"]
                and row.get("forbidden_claims") == q["forbidden_claims"],
                f"candidate question {index} gold-evidence mismatch")
        require(isinstance(row.get("metrics"), dict), f"candidate question {index} missing metrics")
    controls = report.get("abstention_controls", {})
    require(controls.get("expected_count") == expected["abstention_count"],
            "abstention-control sample count mismatch")
    require(report.get("source_provenance", {}).get("total_questions") == len(questions),
            "source-hit denominator mismatch")
    return {
        "status": "CURRENT_CORPUS_REPLAY_VERIFIED_IDENTITY",
        "report_sha256": hashlib.sha256(candidate_file.read_bytes()).hexdigest(),
        "sample_count": len(questions),
        "abstention_controls": controls,
        "aggregate_metrics": report.get("aggregate_metrics", {}),
        "scope_warning": "Small current verified corpus; identity validation is not independent factual adjudication",
    }


def audit(root: Path = ROOT, candidate_file: Path | None = None) -> dict[str, Any]:
    models = verify_model_reports(root)
    current = verify_question_contract(root)
    historical = load_json(root, LEGACY_RAG)
    legacy_count = historical.get("corpus_info", {}).get("questions_evaluated")
    require(legacy_count == len(historical.get("per_question_results", [])),
            "historical RAG report internally inconsistent")
    legacy_status = "HISTORICAL_NONCOMPARABLE"
    require(current["count"] != legacy_count or historical.get("corpus_info", {}).get("manifest_sha256") == current["source_manifest_sha256"],
            "historical RAG report has unexpected identical sample count without corpus proof")

    block = []
    if candidate_file is None:
        replay = {"status": "NOT_PROVIDED"}
        block.append("No replay of the current five-question, manifest-verified RAG corpus is attached.")
    else:
        replay = verify_candidate(root, candidate_file, current)
    if current["count"] < 30:
        block.append("Current verified RAG set is too small for broad generalization (only %s queries)." % current["count"])
    if current["documents"] < 5:
        block.append("Current verified RAG corpus has only %s document; external/topic coverage is narrow." % current["documents"])

    old_llm = load_json(root, "ml-service/reports/llm_eval_report.json")
    llm_faithfulness = old_llm["aggregate_metrics"]["mean_faithfulness_score"]
    require(0 <= llm_faithfulness <= 1, "invalid historical LLM faithfulness")

    phase4 = load_json(root, "docs/architecture/phase_4_market_model_qualification.json")
    require(phase4["finalDecision"] == "DETERMINISTIC_CHAMPION_HMM_SHADOW",
            "market-model deployment conclusion must be separately reviewed")
    require(phase4["data"].get("rawDatasetCommitted") is False,
            "market raw data availability changed; check release/reproducibility scope")
    block.append("Historical market-regime raw dataset is not committed; independent external replay is incomplete.")

    proof = load_json(root, "GENIEPROOF_STATUS.json")
    require(proof["productionActivation"]["enabled"] is False,
            "GenieProof activated: refresh this assessment")
    block.append("GenieProof source reuse permission and production approvals remain blocked.")

    rights = (root / "docs/operations/market-data-permission-review.md").read_text(encoding="utf-8")
    require("remain unverified" in rights, "market-data rights status changed; obtain new legal review")
    block.append("Upstox downstream commercial data-use rights have not been independently qualified.")

    scaling = load_json(root, "server/reports/loadtest/replica_scaling_report.json")
    require(float(scaling["findings"]["computeScalingFactor"].removesuffix("x")) < 1,
            "historical scaling ratio changed; manually review performance interpretation")
    block.append("Historical two-replica compute throughput is lower than one replica; no scaling-gain claim.")

    return {
        "schema_version": 1,
        "status": "START_DRAFT_ONLY_NOT_SUBMISSION_READY" if block else "EVIDENCE_REVIEW_REQUIRED",
        "source": "Repository reports and current files; no model training or new experiments performed by this audit",
        "synthetic_policy_models": models,
        "current_rag": current,
        "current_rag_replay": replay,
        "legacy_rag": {
            "status": legacy_status,
            "report_sha256": file_sha256(root, LEGACY_RAG),
            "report_id": historical.get("report_id"),
            "question_count": legacy_count,
            "grounding_score_mean": historical["aggregate_metrics"]["grounding_score"]["mean"],
            "source_hit_rate": historical["source_provenance"]["source_hit_rate"],
            "research_use": "HISTORICAL_CONTEXT_ONLY_NOT_CURRENT_CORPUS",
        },
        "historical_base_llm": {
            "faithfulness_lexical_proxy": llm_faithfulness,
            "sample_count": old_llm["evaluation_metadata"]["sample_count"],
            "research_use": "HISTORICAL_BASELINE_NOT_LIVE_MODEL",
        },
        "market_regime": {
            "status": phase4["finalDecision"],
            "raw_dataset_committed": False,
            "holdout_rows": phase4["splits"]["finalHoldout"]["rowCount"],
        },
        "blockers": block,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", type=Path, help="fresh, isolated current-corpus replay JSON")
    parser.add_argument("--output", type=Path, help="write the JSON audit to this path")
    parser.add_argument("--strict", action="store_true", help="reject submission if blockers remain")
    args = parser.parse_args()
    result = audit(candidate_file=args.candidate)
    payload = json.dumps(result, indent=2, sort_keys=True, allow_nan=False) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload, encoding="utf-8")
    print(payload)
    if args.strict and result["blockers"]:
        print("SUBMISSION BLOCKED: evidence or qualification prerequisites remain unresolved.")
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
