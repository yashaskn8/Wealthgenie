"""
WealthGenie RAG Subsystem - Retrieval and Abstention Evaluation Engine
Evaluates retrieval, citation-ID validity, lexical support, and abstention behavior.
"""

import json
import logging
import re
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Dict, Any, List, Set, Optional

from model.config import BASE_DIR
from rag.evaluation.metrics import (
    compute_recall_at_k,
    compute_precision_at_k,
    compute_mrr,
    compute_hit_rate,
    compute_ndcg,
    compute_context_coverage,
    compute_chunk_diversity,
    compute_citation_accuracy,
    compute_grounding_score,
)
from rag.schema import RAGQueryResponse, RAG_ABSTENTION_MESSAGE

EVALS_DIR = BASE_DIR / "reports" / "rag_evals"
EVALS_DIR.mkdir(parents=True, exist_ok=True)

logger = logging.getLogger("wealthgenie.rag.evaluation")


def _normalized_phrase(value: str) -> str:
    return " ".join(re.findall(r"[a-z0-9]+", str(value or "").lower()))


def _contains_phrase(text: str, phrase: str) -> bool:
    normalized_text = _normalized_phrase(text)
    normalized_phrase = _normalized_phrase(phrase)
    return bool(normalized_phrase and f" {normalized_phrase} " in f" {normalized_text} ")


def _citation_numbering_valid(citations) -> bool:
    if not citations:
        return True
    identifiers = [citation.citation_id for citation in citations]
    return (
        all(type(identifier) is int for identifier in identifiers)
        and len(set(identifiers)) == len(identifiers)
        and set(identifiers) == set(range(1, len(identifiers) + 1))
    )


def _answer_citation_references(answer: str) -> List[Optional[int]]:
    references = []
    for match in re.finditer(r"\[(\d+)\]", answer or ""):
        digits = match.group(1)
        # Citation IDs are bounded by the retrieved citation count. Avoid parsing
        # arbitrarily long attacker-controlled integers while keeping them invalid.
        references.append(int(digits) if len(digits) <= 6 else None)
    return references


def _exact_citation_identity(citation, retrieved_chunk) -> bool:
    if retrieved_chunk is None:
        return False
    chunk = retrieved_chunk.chunk
    metadata = chunk.metadata
    return (
        citation.chunk_id == chunk.chunk_id
        and citation.document_title == metadata.title
        and citation.source == metadata.source
        # The structured citation engine emits a 200-character preview, often
        # ending mid-token. Validate the exact preview independently of lexical
        # whole-word matching; keep the older full-subphrase contract for tests.
        and (
            citation.excerpt == (
                chunk.content[:200] + "..." if len(chunk.content) > 200 else chunk.content
            )
            or _contains_phrase(chunk.content, citation.excerpt)
        )
    )


def _is_negated_claim(answer: str, position: int) -> bool:
    clause_start = max(
        answer.rfind(".", 0, position),
        answer.rfind("!", 0, position),
        answer.rfind("?", 0, position),
        answer.rfind(";", 0, position),
    ) + 1
    preceding = answer[max(clause_start, position - 48):position]
    direct_negation = re.search(
        r"\b(?:cannot|can't|can not|do not|don't|does not|doesn't|did not|didn't|"
        r"is not|isn't|are not|aren't|was not|wasn't|were not|weren't|not|no|never|"
        r"unable to|unverified|unsupported|uncertain)\s*$",
        preceding,
        re.I,
    )
    uncertainty_frame = re.search(
        r"\b(?:cannot|can't|can not|could not|couldn't|unable to|not able to)\s+"
        r"(?:verify|confirm|determine|establish|tell|assess)\s+"
        r"(?:(?:whether|if|that)\s+)?[^.!?;]{0,80}$",
        preceding,
        re.I,
    )
    no_actor_can = re.search(r"\b(?:no one|nobody|no taxpayer|no investor)\s+(?:(?:can|may|should|will)\s*)?$", preceding, re.I)
    denial_frame = re.search(
        r"\b(?:(?:it|this|that)\s+)?(?:is|was)\s+"
        r"(?:not\s+true|false|incorrect|wrong|untrue)\s+that\s+[^.!?;]{0,100}$",
        preceding,
        re.I,
    )
    rejection_frame = re.search(
        r"\b(?:i|we|they|the\s+author|the\s+answer)\s+"
        r"(?:(?:do|does|did)\s+not\s+agree|don't\s+agree|doesn't\s+agree|"
        r"deny|denies|dispute|disputes|reject|rejects|challenge|challenges)\s+"
        r"(?:with\s+)?(?:the\s+claim\s+that\s+|that\s+)?[^.!?;]{0,100}$",
        preceding,
        re.I,
    )
    return bool(direct_negation or uncertainty_frame or no_actor_can or denial_frame or rejection_frame)


def _has_unnegated_pattern(answer: str, pattern: str) -> bool:
    return any(not _is_negated_claim(answer, match.start()) for match in re.finditer(pattern, answer, re.I))


def _has_unnegated_phrase(answer: str, phrase: str) -> bool:
    words = _normalized_phrase(phrase).split()
    if not words:
        return False
    pattern = r"\b" + r"\W+".join(re.escape(word) for word in words) + r"\b"
    return _has_unnegated_pattern(answer, pattern)


def _has_uncontradicted_phrase(text: str, phrase: str) -> bool:
    return (
        _contains_phrase(text, phrase)
        and _has_unnegated_phrase(text, phrase)
        and not _has_postposed_contradiction(text, phrase)
    )


def _has_postposed_contradiction(answer: str, phrase: str) -> bool:
    words = _normalized_phrase(phrase).split()
    if not words:
        return False
    pattern = r"\b" + r"\W+".join(re.escape(word) for word in words) + r"\b"
    denial = re.compile(
        r"\b(?:false|incorrect|wrong|untrue|not\s+the\s+case|not\s+true|"
        r"does\s+not|doesn't|is\s+not|isn't|was\s+not|wasn't|"
        r"will\s+not|won't|never|no\s+longer|unsupported|disputed|"
        r"retract(?:ed|s|ing)?|withdraw(?:n|s|ing)?|disavow(?:ed|s|ing)?|"
        r"incorrectly\s+stated)\b",
        re.I,
    )
    for match in re.finditer(pattern, answer or "", re.I):
        # A short forward window catches explicit correction clauses such as
        # "The rule takes effect on 1 April 2026, but that date is false" and
        # adjacent-sentence walk-backs. Unknown paraphrases remain outside the
        # lexical evaluator's claimed coverage.
        following = (answer or "")[match.end():match.end() + 180]
        if denial.search(following):
            return True
    return False


def _claims_unsupported_deduction(answer: str) -> bool:
    patterns = (
        r"\b(?:you|investors?|taxpayers?)\s+(?:can|may|should|will)\s+(?:claim|take|deduct)\b",
        r"\b(?:claim|take|deduct)\s+(?:an?\s+)?(?:tax\s+)?deduction\b",
        r"\b(?:tax\s+)?deduction\b.{0,60}(?:₹\s*[\d,]+(?:\.\d+)?|\b\d[\d,]{2,}\b|\b(?:available|allowed|eligible|permitted|exempt)\b)",
        r"\b(?:deduct|deductible)\b.{0,60}(?:₹\s*[\d,]+|\b\d[\d,]{2,}\b|\b(?:available|allowed|eligible)\b)",
        r"\b(?:section|sec\.?|u/s)\s*80[cd]\b",
    )
    return any(_has_unnegated_pattern(answer, pattern) for pattern in patterns)


def _claims_acquisition_condition(answer: str) -> bool:
    acquisition = r"(?:acquir(?:e|ed|ing)|acquisition(?:s)?|purchas(?:e|ed|ing)|buy|buys|bought|buying|subscrib(?:e|ed|ing)|allot(?:ted|ment)|issu(?:e|ed|ance))"
    temporal = r"(?:before|after|on|during|between|through|via|from)"
    patterns = (
        rf"\b{acquisition}\b.{{0,60}}\b{temporal}\b",
        rf"\b{temporal}\b.{{0,60}}\b{acquisition}\b",
    )
    return any(_has_unnegated_pattern(answer, pattern) for pattern in patterns)


def _forbidden_claim_violations(
    answer: str,
    forbidden_claims: List[str],
    invalid_citation: bool = False,
) -> List[int]:
    violations = []
    for index, claim in enumerate(forbidden_claims):
        claim_text = _normalized_phrase(claim)
        matched = _has_unnegated_phrase(answer, claim)
        if "any numeric slab" in claim_text or "unsupported tax slab" in claim_text:
            range_with_rate = (
                r"\b(?:₹\s*)?\d[\d,]*(?:\.\d+)?\s*(?:(?:lakh|lac|crore)s?\b)?\s*"
                r"(?:-|–|—|\bto\b)\s*(?:₹\s*)?\d[\d,]*(?:\.\d+)?\s*"
                r"(?:(?:lakh|lac|crore)s?\b)?\s*[:=]\s*\d+(?:\.\d+)?\s*%"
            )
            prose_range_with_rate = (
                r"\b(?:₹\s*)?\d[\d,]*(?:\.\d+)?\s*(?:(?:lakh|lac|crore)s?\b)?\s*"
                r"(?:-|–|—|\bto\b)\s*(?:₹\s*)?\d[\d,]*(?:\.\d+)?\s*"
                r"(?:(?:lakh|lac|crore)s?\b)?\s*.{0,50}\b(?:taxed|tax|charged)\s+at\s+"
                r"\d+(?:\.\d+)?\s*%"
            )
            rate_before_range = (
                r"\b(?:tax\s+)?(?:rate|slab)\b.{0,24}\b\d+(?:\.\d+)?\s*%"
                r".{0,30}\b(?:between|from)\s+(?:₹\s*)?\d[\d,]*(?:\.\d+)?\s*"
                r"(?:(?:lakh|lac|crore)s?\b)?\s*(?:and|to)\s+(?:₹\s*)?"
                r"\d[\d,]*(?:\.\d+)?\s*(?:(?:lakh|lac|crore)s?\b)?"
            )
            matched = matched or _has_unnegated_pattern(
                answer,
                r"\b(?:tax\s+)?slabs?\b.{0,40}\b\d+(?:\.\d+)?\s*%?|\b\d+(?:\.\d+)?\s*%?\b.{0,40}\b(?:tax\s+)?slabs?\b",
            )
            matched = matched or _has_unnegated_pattern(answer, range_with_rate)
            matched = matched or _has_unnegated_pattern(answer, prose_range_with_rate)
            matched = matched or _has_unnegated_pattern(answer, rate_before_range)
        elif "any rebate threshold" in claim_text:
            matched = matched or _has_unnegated_pattern(
                answer,
                r"(?:rebate|threshold).{0,40}\b\d+(?:\.\d+)?\b|\b\d+(?:\.\d+)?\b.{0,40}(?:rebate|threshold)",
            )
            matched = matched or _has_unnegated_pattern(
                answer,
                r"\b(?:income|taxable income|annual income|total income)\b.{0,40}"
                r"\b(?:up to|below|under|less than|not exceeding)\b.{0,30}"
                r"(?:₹\s*)?\d[\d,]*(?:\.\d+)?\s*(?:(?:lakh|lac|crore)s?\b)?"
                r".{0,40}\b(?:tax[- ]free|zero tax|no tax|not taxable|rebate|exemption)\b",
            )
            matched = matched or _has_unnegated_pattern(
                answer,
                r"\b(?:up to|below|under|less than|not exceeding)\s*(?:₹\s*)?"
                r"\d[\d,]*(?:\.\d+)?\s*(?:(?:lakh|lac|crore)s?\b)?\s+"
                r"(?:annual\s+)?income\b.{0,40}\b(?:carries|has|incurs|attracts|is|gets)\s+"
                r"(?:nil|no|zero)\s+tax\b",
            )
            matched = matched or _has_unnegated_pattern(
                answer,
                r"\b(?:no tax|zero tax|tax[- ]free|not taxable|tax(?:es)? do not apply|tax(?:es)? doesn't apply)\b"
                r".{0,60}\b(?:on|for|if|when)?\s*(?:annual\s+)?income\b.{0,40}"
                r"\b(?:up to|below|under|less than|not exceeding)\b.{0,30}"
                r"(?:₹\s*)?\d[\d,]*(?:\.\d+)?\s*(?:(?:lakh|lac|crore)s?\b)?",
            )
        elif "tax calculation" in claim_text:
            matched = matched or _has_unnegated_pattern(
                answer, r"\b(?:tax calculation|tax amount|tax due|tax liability)\b"
            )
        elif "investment recommendation" in claim_text:
            matched = matched or _has_unnegated_pattern(
                answer, r"\b(?:recommend(?:s|ed|ation)?|invest in|buy|sell|allocate)\b"
            )
        elif "any sports result" in claim_text:
            matched = matched or _has_unnegated_pattern(
                answer, r"\b(?:won|winner|defeated|beat|score was|champion)\b"
            )
        elif "unsupported deduction" in claim_text:
            matched = matched or _claims_unsupported_deduction(answer)
        elif "unsupported acquisition condition claim" in claim_text:
            matched = matched or _claims_acquisition_condition(answer)
        elif "fabricated citation" in claim_text:
            matched = matched or invalid_citation
        if matched:
            violations.append(index)
    return violations


def _provenance_metrics(
    citations,
    retrieved_by_id,
    expected_provenance,
    expected_manifest_sha256,
    expected_jurisdiction,
    as_of_date,
):
    if expected_provenance is None:
        return {"source_trust": None, "source_identity": None, "source_freshness": None,
                "manifest_binding_current": None,
                "effective_period": None, "jurisdiction": None}
    if not citations:
        if not expected_provenance:
            return {"source_trust": None, "source_identity": None, "source_freshness": None,
                    "manifest_binding_current": None,
                    "effective_period": None, "jurisdiction": None}
        return {"source_trust": 0.0, "source_identity": 0.0, "source_freshness": None,
                "manifest_binding_current": 0.0,
                "effective_period": 0.0, "jurisdiction": 0.0}
    scores = {key: [] for key in ("source_trust", "source_identity", "manifest_binding_current", "effective_period", "jurisdiction")}
    for citation in citations:
        retrieved = retrieved_by_id.get(citation.chunk_id)
        if retrieved is None:
            for values in scores.values():
                values.append(0.0)
            continue
        chunk = retrieved.chunk
        metadata = chunk.metadata
        custom = metadata.custom_metadata or {}
        expected = expected_provenance.get(custom.get("document_key"))
        if expected is None:
            for values in scores.values():
                values.append(0.0)
            continue
        identity_ok = (
            metadata.source == expected.get("official_source_url")
            and metadata.author == expected.get("publishing_authority")
            and metadata.publication_date == expected.get("publication_date")
            and metadata.effective_date == expected.get("effective_from")
            and custom.get("effective_to") == expected.get("effective_to")
            and custom.get("content_sha256") == expected.get("content_sha256")
            and custom.get("document_revision") == expected.get("document_version")
            and _exact_citation_identity(citation, retrieved)
        )
        active = getattr(chunk, "lifecycle_state", None) == "ACTIVE"
        manifest_ok = (
            custom.get("corpus_manifest_sha256") == expected_manifest_sha256
            and custom.get("corpus_manifest_sha256") == expected.get("_manifest_sha256")
        )
        effective_from = date.fromisoformat(expected["effective_from"])
        effective_to = date.fromisoformat(expected["effective_to"]) if expected.get("effective_to") else None
        effective_ok = effective_from <= as_of_date and (effective_to is None or as_of_date <= effective_to)
        scores["source_trust"].append(float(metadata.source_trust_tier == expected.get("trust_tier") == "government_official"))
        scores["source_identity"].append(float(identity_ok))
        scores["manifest_binding_current"].append(float(active and manifest_ok))
        scores["effective_period"].append(float(effective_ok and metadata.effective_date == expected.get("effective_from")))
        scores["jurisdiction"].append(float(expected.get("jurisdiction") == expected_jurisdiction))
    result = {key: round(sum(values) / len(values), 4) if values else None for key, values in scores.items()}
    result["source_freshness"] = None
    return result


class RAGEvaluator:
    """Evaluation engine that keeps retrieval, citations, support, and abstention distinct."""

    def __init__(self, evals_dir: Path = EVALS_DIR):
        self.evals_dir = evals_dir
        self.evals_dir.mkdir(parents=True, exist_ok=True)

    def evaluate_query_response(
        self,
        query: str,
        response: RAGQueryResponse,
        ground_truth_chunk_ids: Optional[Set[str]] = None,
        k: int = 4,
        expected_abstention: Optional[bool] = None,
        required_facts: Optional[List[str]] = None,
        forbidden_claims: Optional[List[str]] = None,
        expected_provenance: Optional[Dict[str, Dict[str, Any]]] = None,
        expected_manifest_sha256: Optional[str] = None,
        expected_jurisdiction: Optional[str] = None,
        as_of_date: Optional[date] = None,
    ) -> Dict[str, Any]:
        """
        Evaluate one response without treating citation validity as factual entailment.
        """
        retrieved_ids = [r.chunk.chunk_id for r in response.retrieved_chunks]
        retrieved_texts = [r.chunk.content for r in response.retrieved_chunks]
        embeddings = [r.chunk.embedding for r in response.retrieved_chunks if r.chunk.embedding]

        # FIXED: Do NOT fall back to set(retrieved_ids) when ground_truth_chunk_ids is None.
        # That created a self-referential comparison (retrieved vs retrieved) yielding trivial 1.0
        # for every metric. When no ground truth is provided, skip chunk-level IR metrics.
        gt_ids = ground_truth_chunk_ids
        has_ground_truth = gt_ids is not None and len(gt_ids) > 0
        expected_abstention = (
            gt_ids is not None and len(gt_ids) == 0
            if expected_abstention is None else expected_abstention
        )

        if has_ground_truth:
            recall_k = compute_recall_at_k(retrieved_ids, gt_ids, k)
            precision_k = compute_precision_at_k(retrieved_ids, gt_ids, k)
            mrr = compute_mrr(retrieved_ids, gt_ids)
            hit_rate = compute_hit_rate(retrieved_ids, gt_ids, k)
            ndcg = compute_ndcg(retrieved_ids, gt_ids, k)
        else:
            # No ground truth provided — mark IR metrics as NaN to avoid misleading scores
            recall_k = float('nan')
            precision_k = float('nan')
            mrr = float('nan')
            hit_rate = float('nan')
            ndcg = float('nan')

        coverage = compute_context_coverage(query, retrieved_texts)
        diversity = compute_chunk_diversity(embeddings) if embeddings else 1.0
        citation_id_validity = (
            compute_citation_accuracy(response.citations, response.retrieved_chunks)
            if response.citations else None
        )
        lexical_support = (
            compute_grounding_score(response.answer, retrieved_texts)
            if response.grounded else None
        )
        required_facts = required_facts or []
        forbidden_claims = forbidden_claims or []
        retrieved_by_id = {item.chunk.chunk_id: item for item in response.retrieved_chunks}
        cited_by_id = {citation.chunk_id: citation for citation in response.citations}
        citation_numbering_valid = _citation_numbering_valid(response.citations)
        answer_citation_references = _answer_citation_references(response.answer)
        citation_reference_validity = (
            float(bool(response.citations) and all(
                reference in {citation.citation_id for citation in response.citations}
                for reference in answer_citation_references
            ))
            if answer_citation_references else None
        )
        citation_identity_scores = [
            float(citation_numbering_valid and _exact_citation_identity(
                citation, retrieved_by_id.get(citation.chunk_id),
            ))
            for citation in response.citations
        ]
        citation_identity_correctness = (
            round(sum(citation_identity_scores) / len(citation_identity_scores), 4)
            if citation_identity_scores else None
        )
        invalid_citation = (
            (bool(response.citations)
             and (not citation_numbering_valid or any(score == 0.0 for score in citation_identity_scores)))
            or citation_reference_validity == 0.0
        )
        referenced_citation_ids = set(answer_citation_references)
        citation_support = []
        for fact in required_facts:
            answer_support = _has_uncontradicted_phrase(response.answer, fact)
            source_support = any(
                _exact_citation_identity(cited_by_id[chunk_id], retrieved_by_id[chunk_id])
                and _has_uncontradicted_phrase(retrieved_by_id[chunk_id].chunk.content, fact)
                for chunk_id in cited_by_id
                if chunk_id in retrieved_by_id
                and cited_by_id[chunk_id].citation_id in referenced_citation_ids
            )
            citation_support.append(float(answer_support and source_support))
        factual_support = round(sum(citation_support) / len(citation_support), 4) if citation_support else None
        forbidden_violations = _forbidden_claim_violations(response.answer, forbidden_claims, invalid_citation)
        if expected_abstention is None:
            abstention_correctness = None
        elif expected_abstention:
            abstention_correctness = (
                not response.grounded
                and not response.citations
                and response.metrics.get("response_mode") == "abstention"
                and response.answer == RAG_ABSTENTION_MESSAGE
                and not forbidden_violations
            )
        else:
            abstention_correctness = response.grounded and bool(response.citations)
        provenance = _provenance_metrics(
            response.citations,
            retrieved_by_id,
            expected_provenance,
            expected_manifest_sha256,
            expected_jurisdiction,
            as_of_date or date.today(),
        )
        retrieval_hit = (
            bool(set(retrieved_ids[:k]).intersection(gt_ids))
            if has_ground_truth else None
        )

        eval_results = {
            "metrics": {
                f"recall_at_{k}": round(recall_k, 4),
                f"precision_at_{k}": round(precision_k, 4),
                "mrr": round(mrr, 4),
                "hit_rate": round(hit_rate, 4),
                f"ndcg_at_{k}": round(ndcg, 4),
                "context_coverage": round(coverage, 4),
                "chunk_diversity": round(diversity, 4),
                "retrieval_hit": retrieval_hit,
                "citation_id_validity": round(citation_id_validity, 4) if citation_id_validity is not None else None,
                "citation_reference_validity": citation_reference_validity,
                "citation_identity_correctness": citation_identity_correctness,
                "factual_support": factual_support,
                "lexical_support": round(lexical_support, 4) if lexical_support is not None else None,
                "abstention_correctness": abstention_correctness,
                "answerability_correctness": abstention_correctness,
                "forbidden_claims_passed": not forbidden_violations,
                "forbidden_claim_violation_count": len(forbidden_violations),
                **provenance,
            },
            "retrieved_chunk_count": len(retrieved_ids),
            "citations_count": len(response.citations),
            "timing_metrics": response.metrics,
        }

        return eval_results

    def evaluate_and_persist(
        self,
        query: str,
        response: RAGQueryResponse,
        ground_truth_chunk_ids: Optional[Set[str]] = None,
        k: int = 4,
        expected_abstention: Optional[bool] = None,
        required_facts: Optional[List[str]] = None,
        forbidden_claims: Optional[List[str]] = None,
        expected_provenance: Optional[Dict[str, Dict[str, Any]]] = None,
        expected_manifest_sha256: Optional[str] = None,
        expected_jurisdiction: Optional[str] = None,
        as_of_date: Optional[date] = None,
    ) -> Path:
        """
        Evaluates query response and persists structured JSON evaluation report to evals_dir.
        """
        results = self.evaluate_query_response(
            query,
            response,
            ground_truth_chunk_ids,
            k=k,
            expected_abstention=expected_abstention,
            required_facts=required_facts,
            forbidden_claims=forbidden_claims,
            expected_provenance=expected_provenance,
            expected_manifest_sha256=expected_manifest_sha256,
            expected_jurisdiction=expected_jurisdiction,
            as_of_date=as_of_date,
        )

        timestamp_str = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        eval_id = f"eval_rag_{timestamp_str}"
        eval_file = self.evals_dir / f"{eval_id}.json"

        report = {
            "eval_id": eval_id,
            "timestamp_utc": datetime.now(timezone.utc).isoformat(),
            **results,
        }

        with open(eval_file, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2)

        logger.info(f"RAG Evaluation report persisted successfully to {eval_file}")
        return eval_file

    def list_evaluation_reports(self) -> List[Dict[str, Any]]:
        """Lists summaries of all historical RAG evaluation reports."""
        summaries = []
        for path in sorted(self.evals_dir.glob("eval_rag_*.json"), reverse=True):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                summaries.append({
                    "eval_id": data.get("eval_id"),
                    "timestamp": data.get("timestamp_utc"),
                    "lexical_support": data.get("metrics", {}).get("lexical_support"),
                    "mrr": data.get("metrics", {}).get("mrr"),
                    "file_path": str(path),
                })
            except Exception as e:
                logger.warning(f"Could not parse eval report {path}: {e}")
        return summaries
