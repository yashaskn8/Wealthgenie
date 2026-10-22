-- Database-level invariant: audited qualification cannot misbind an index,
-- category or asset class to an unrelated actual instrument, even via raw SQL.
CREATE OR REPLACE FUNCTION finance.validate_family_product_qualification()
 RETURNS trigger LANGUAGE plpgsql AS $$
 DECLARE relation_ok boolean;
 DECLARE source_ok boolean;
 BEGIN
  SELECT EXISTS (
   SELECT 1 FROM finance.products f
   JOIN finance.products p ON p.id=NEW.product_id
    WHERE f.id=NEW.family_id
      AND f.record_kind='ARCHETYPE'
      AND p.record_kind='ACTUAL_PRODUCT'
      AND p.category_id=f.category_id
      AND p.verification_scope='VERIFIED_ACTUAL_PRODUCT'
      AND p.source_identity IS NOT NULL
  ) INTO relation_ok;
  IF NOT relation_ok THEN
   RAISE EXCEPTION 'FAMILY_PRODUCT_IDENTITY_OR_CATEGORY_MISMATCH' USING ERRCODE='23514';
  END IF;
  IF NEW.status='ACTIVE' THEN
   SELECT EXISTS (
    SELECT 1 FROM finance.products p
    JOIN finance.product_external_ids ext ON ext.product_id=p.id AND ext.source_id=NEW.source_id
    JOIN finance.provider_rights r ON r.source_id=ext.source_id
    WHERE p.id=NEW.product_id AND p.availability='AVAILABLE'
      AND p.qualified_tax_class NOT IN ('UNVERIFIED','OTHER_UNSUPPORTED')
      AND p.tax_class_evidence_url LIKE 'https://%'
      AND p.tax_class_reviewed_at IS NOT NULL
      AND p.tax_class_reviewed_at<=clock_timestamp()
      AND r.access_allowed AND r.extraction_allowed AND r.storage_allowed
      AND r.derivation_allowed AND r.public_display_allowed
      AND r.commercial_use_allowed AND r.redistribution_allowed
      AND r.retention_seconds>0 AND r.reviewed_at IS NOT NULL
      AND r.reviewed_at<=clock_timestamp() AND r.revoked_at IS NULL
      AND (r.expires_at IS NULL OR r.expires_at>clock_timestamp())
   ) INTO source_ok;
   IF NOT source_ok THEN
    RAISE EXCEPTION 'FAMILY_PRODUCT_RIGHTS_OR_TAX_UNQUALIFIED' USING ERRCODE='23514';
   END IF;
   IF NEW.valid_until<=clock_timestamp() OR NEW.reviewed_at>clock_timestamp() THEN
    RAISE EXCEPTION 'FAMILY_PRODUCT_REVIEW_INVALID_OR_EXPIRED' USING ERRCODE='23514';
   END IF;
  END IF;
  RETURN NEW;
 END $$;
CREATE TRIGGER family_product_qualification_integrity
 BEFORE INSERT OR UPDATE ON finance.family_product_qualifications
 FOR EACH ROW EXECUTE FUNCTION finance.validate_family_product_qualification();
