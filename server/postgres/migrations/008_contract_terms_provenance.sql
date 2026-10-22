-- An official-looking rate is not sufficient evidence of contractual terms.
-- Evidence and human review must be recorded independently for each term.
-- Existing rows remain unreviewed and cannot drive contractual illustrations
-- until an authorized operator qualifies their exact issuer documents.
ALTER TABLE finance.product_terms
 ADD COLUMN IF NOT EXISTS contract_evidence_url text NULL,
 ADD COLUMN IF NOT EXISTS contract_reviewed_at timestamptz NULL;
ALTER TABLE finance.product_terms
 ADD CONSTRAINT finance_product_terms_review_evidence_pair
 CHECK ((contract_evidence_url IS NULL AND contract_reviewed_at IS NULL)
     OR (contract_evidence_url IS NOT NULL AND contract_evidence_url LIKE 'https://%' AND contract_reviewed_at IS NOT NULL));
CREATE INDEX IF NOT EXISTS finance_product_terms_review_idx
 ON finance.product_terms(product_id,source_id,term_type,effective_from)
 WHERE contract_reviewed_at IS NOT NULL;
