"""
WealthGenie RAG Subsystem - Query Intent Classifier
Classifies query intent into financial domain categories (tax_regime, deduction, asset_suitability, general).
"""

from typing import Dict, Any


class QueryIntentClassifier:
    """Classifies financial query intent using domain keyword rule sets."""

    INTENT_KEYWORDS = {
        "tax_regime": ["new regime", "old regime", "slab", "115bac", "rebate", "tax rate", "income tax"],
        "deduction": ["80c", "80d", "80ccd", "hra", "standard deduction", "exemption", "deduction"],
        "asset_suitability": ["elss", "mutual fund", "fixed deposit", "fd", "bond", "equity", "liquid fund", "nps", "risk"],
        "wealth_projection": ["monte carlo", "cagr", "xirr", "sip", "return", "growth", "projection"],
    }
    FINANCIAL_DOMAIN_TERMS = {
        "tax", "income", "deduction", "rebate", "80c", "80d", "80ccd", "115bac",
        "investment", "invest", "portfolio", "mutual fund", "elss", "equity", "bond",
        "fixed deposit", "deposit", "nps", "retirement", "pension", "savings", "debt",
        "insurance", "risk", "sip", "return", "wealth", "financial", "money", "balance",
        "sebi", "rbi", "dicgc", "cbdt", "capital gain", "inflation", "emergency fund",
        "ombudsman", "grievance", "mutual funds regulations",
    }

    def classify(self, query: str) -> Dict[str, Any]:
        """Classifies intent category and returns primary intent with confidence score."""
        q_lower = query.lower()
        scores: Dict[str, int] = {intent: 0 for intent in self.INTENT_KEYWORDS}

        for intent, keywords in self.INTENT_KEYWORDS.items():
            for kw in keywords:
                if kw in q_lower:
                    scores[intent] += 1

        in_domain = any(term in q_lower for term in self.FINANCIAL_DOMAIN_TERMS)
        best_intent = max(scores, key=scores.get)
        max_score = scores[best_intent]

        primary_intent = best_intent if max_score > 0 else ("general_advisory" if in_domain else "out_of_domain")
        confidence = float(min(1.0, max_score * 0.35)) if max_score > 0 else (0.5 if in_domain else 0.0)

        return {
            "primary_intent": primary_intent,
            "confidence": confidence,
            "intent_scores": scores,
            "in_domain": in_domain,
        }
