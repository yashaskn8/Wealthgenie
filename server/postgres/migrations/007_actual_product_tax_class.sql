-- Source-qualified tax classification is separate from a tradable product
-- identity and from rights to store/derive market data. Default denies.
ALTER TABLE finance.products
 ADD COLUMN IF NOT EXISTS qualified_tax_class text NOT NULL DEFAULT 'UNVERIFIED';
ALTER TABLE finance.products
 ADD COLUMN IF NOT EXISTS tax_class_evidence_url text NULL;
ALTER TABLE finance.products
 ADD COLUMN IF NOT EXISTS tax_class_reviewed_at timestamptz NULL;
ALTER TABLE finance.products
 ADD CONSTRAINT financial_products_qualified_tax_class
 CHECK (qualified_tax_class IN ('UNVERIFIED','LISTED_EQUITY_STT_QUALIFIED',
   'ORDINARY_INTEREST','OTHER_UNSUPPORTED'));
ALTER TABLE finance.products
 ADD CONSTRAINT financial_products_tax_class_evidence
 CHECK (qualified_tax_class='UNVERIFIED' OR
   (record_kind='ACTUAL_PRODUCT' AND tax_class_evidence_url LIKE 'https://%'
    AND tax_class_reviewed_at IS NOT NULL));
