-- Source-bound investment discovery expansion. This is not a product approval.
ALTER TABLE finance.products
  ADD COLUMN IF NOT EXISTS discovery_reference_url text NULL,
  ADD COLUMN IF NOT EXISTS verification_scope text NOT NULL DEFAULT 'UNVERIFIED',
  ADD COLUMN IF NOT EXISTS assessed_as_of date NULL;
ALTER TABLE finance.products
  ADD CONSTRAINT finance_products_archetypes_not_recommendable
    CHECK (record_kind <> 'ARCHETYPE' OR recommendation_eligible = false);
ALTER TABLE finance.products
  ADD CONSTRAINT finance_products_evidence_url_valid
    CHECK (discovery_reference_url IS NULL OR discovery_reference_url LIKE 'https://%');
ALTER TABLE finance.products
  ADD CONSTRAINT finance_products_discovery_scope_valid
    CHECK (verification_scope IN
      ('UNVERIFIED','REGULATORY_CATEGORY_OR_INDEX_ONLY','VERIFIED_ACTUAL_PRODUCT'));
CREATE INDEX IF NOT EXISTS finance_products_discovery_category_idx
  ON finance.products (category_id, subcategory_id, id)
  WHERE record_kind = 'ARCHETYPE';
