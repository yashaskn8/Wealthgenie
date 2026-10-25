from rag.retrieval.pipeline import _qualified_question_document_key


def entries():
    return {
        "income-tax-rules-2026-commencement": {
            "excluded_topics": ["tax slabs", "deductions", "rebate"]
        },
        "sebi-mf-regulations-2026-commencement": {
            "excluded_topics": ["returns", "NAV", "fees", "tax", "recommendation"]
        },
        "rbi-ombudsman-2026-commencement": {
            "excluded_topics": ["eligibility", "compensation", "refund"]
        },
    }


def test_manifest_query_router_binds_each_verified_subject_to_one_source():
    assert _qualified_question_document_key(
        "When do the Income-tax Rules 2026 take effect?", entries()
    ) == "income-tax-rules-2026-commencement"
    assert _qualified_question_document_key(
        "Which statute applies to Tax Year 2026-27?", entries()
    ) == "income-tax-rules-2026-commencement"
    assert _qualified_question_document_key(
        "When did SEBI Mutual Funds Regulations 2026 take effect?", entries()
    ) == "sebi-mf-regulations-2026-commencement"
    assert _qualified_question_document_key(
        "When did the RBI Integrated Ombudsman Scheme 2026 take effect?", entries()
    ) == "rbi-ombudsman-2026-commencement"


def test_unsupported_claims_cannot_borrow_official_authority():
    for question in (
        "Do SEBI Mutual Funds Regulations 2026 guarantee returns?",
        "What is the NAV under SEBI Mutual Funds Regulations 2026?",
        "Is my complaint eligible for a refund under RBI Ombudsman Scheme 2026?",
        "How much compensation for RBI Integrated Ombudsman Scheme 2026?",
        "What are the tax slabs under Income-tax Rules 2026?",
        "What interest rate should I invest at?",
        "Who won cricket yesterday?",
    ):
        assert _qualified_question_document_key(question, entries()) is None
