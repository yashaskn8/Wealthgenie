-- Document-free, fail-closed verification of provider-specific entitlements.
-- Legacy approval metadata remains PENDING; no grandfathered rights.
ALTER TABLE finance.provider_rights
  ADD COLUMN verification_state text NOT NULL DEFAULT 'PENDING'
    CHECK (verification_state IN ('PENDING','VERIFIED','EXPIRED','REVOKED','REJECTED')),
  ADD COLUMN verification_issuer text,
  ADD COLUMN verification_claim_id text,
  ADD COLUMN verification_revision bigint NOT NULL DEFAULT 0 CHECK (verification_revision >= 0),
  ADD COLUMN verification_expires_at timestamptz,
  ADD COLUMN entitlement_receipt_sha256 text;

ALTER TABLE finance.provider_rights DROP CONSTRAINT provider_rights_private_evidence;
ALTER TABLE finance.provider_rights
  ADD CONSTRAINT provider_rights_private_evidence CHECK (
    evidence_url IS NOT NULL OR
    COALESCE((evidence_sha256 ~ '^[a-f0-9]{64}$'
      AND length(trim(approval_reference)) BETWEEN 8 AND 160
      AND length(trim(attested_by)) BETWEEN 3 AND 180), false)
    OR COALESCE((entitlement_receipt_sha256 ~ '^[a-f0-9]{64}$'), false)
  );
ALTER TABLE finance.provider_rights
  ADD CONSTRAINT provider_rights_verified_receipt_required CHECK (
    verification_state <> 'VERIFIED' OR (
      entitlement_receipt_sha256 IS NOT NULL
      AND entitlement_receipt_sha256 ~ '^[a-f0-9]{64}$'
      AND verification_issuer IS NOT NULL
      AND length(trim(verification_issuer)) > 0
      AND verification_claim_id IS NOT NULL
      AND length(trim(verification_claim_id)) > 0
      AND verification_revision > 0
      AND reviewed_at IS NOT NULL
      AND verification_expires_at IS NOT NULL
      AND verification_expires_at > reviewed_at
    )
  );
CREATE UNIQUE INDEX provider_rights_unique_entitlement_claim
  ON finance.provider_rights(verification_issuer, verification_claim_id)
  WHERE verification_claim_id IS NOT NULL;
CREATE UNIQUE INDEX provider_rights_unique_signed_receipt
  ON finance.provider_rights(entitlement_receipt_sha256)
  WHERE entitlement_receipt_sha256 IS NOT NULL;

-- Immutable history stops replay of old signatures even after a newer receipt
-- replaces the active row. The application signs nothing and stores no agreement.
CREATE TABLE finance.provider_entitlement_receipts (
  issuer text NOT NULL,
  grant_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  source_id text NOT NULL REFERENCES finance.provider_rights(source_id) ON DELETE RESTRICT,
  receipt_sha256 text NOT NULL UNIQUE CHECK (receipt_sha256 ~ '^[a-f0-9]{64}$'),
  result_state text NOT NULL CHECK (result_state IN ('VERIFIED','REVOKED')),
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (issuer, grant_id, revision)
);
CREATE OR REPLACE FUNCTION finance.reject_entitlement_receipt_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'ENTITLEMENT_RECEIPT_HISTORY_IMMUTABLE' USING ERRCODE='23514';
END $$;
CREATE TRIGGER provider_entitlement_receipts_immutable
  BEFORE UPDATE OR DELETE ON finance.provider_entitlement_receipts
  FOR EACH ROW EXECUTE FUNCTION finance.reject_entitlement_receipt_mutation();

CREATE OR REPLACE FUNCTION finance.enforce_provider_permission_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'UPDATE' THEN
   IF OLD.verification_state IN ('REVOKED','REJECTED')
       AND NEW.verification_state = 'VERIFIED' THEN
     RAISE EXCEPTION 'PROVIDER_PERMISSION_TERMINAL_STATE' USING ERRCODE='23514';
   END IF;
   IF NEW.verification_state = 'VERIFIED' AND (
       NEW.verification_revision <= OLD.verification_revision
       OR NEW.entitlement_receipt_sha256 IS NOT DISTINCT FROM OLD.entitlement_receipt_sha256
       OR (OLD.verification_issuer IS NOT NULL
           AND NEW.verification_issuer IS DISTINCT FROM OLD.verification_issuer)
       OR (OLD.verification_claim_id IS NOT NULL
           AND NEW.verification_claim_id IS DISTINCT FROM OLD.verification_claim_id)
   ) THEN
     RAISE EXCEPTION 'PROVIDER_PERMISSION_REPLAY_OR_SUBSTITUTION' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER provider_permission_lifecycle
 BEFORE INSERT OR UPDATE ON finance.provider_rights
 FOR EACH ROW EXECUTE FUNCTION finance.enforce_provider_permission_lifecycle();

-- Enforce on direct SQL qualification as well as the Node API.
CREATE OR REPLACE FUNCTION finance.validate_family_product_qualification()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE relation_ok boolean;
DECLARE source_ok boolean;
BEGIN
 SELECT EXISTS(
  SELECT 1 FROM finance.products f
  JOIN finance.products p ON p.id=NEW.product_id
  WHERE f.id=NEW.family_id AND f.record_kind='ARCHETYPE'
    AND p.record_kind='ACTUAL_PRODUCT' AND p.category_id=f.category_id
    AND p.verification_scope='VERIFIED_ACTUAL_PRODUCT' AND p.source_identity IS NOT NULL
 ) INTO relation_ok;
 IF NOT relation_ok THEN
  RAISE EXCEPTION 'FAMILY_PRODUCT_IDENTITY_OR_CATEGORY_MISMATCH' USING ERRCODE='23514';
 END IF;
 IF NEW.status = 'ACTIVE' THEN
  SELECT EXISTS(
   SELECT 1 FROM finance.products p
   JOIN finance.product_external_ids ext ON ext.product_id=p.id AND ext.source_id=NEW.source_id
   JOIN finance.provider_rights r ON r.source_id=ext.source_id
   WHERE p.id=NEW.product_id AND p.availability='AVAILABLE'
     AND p.qualified_tax_class NOT IN ('UNVERIFIED','OTHER_UNSUPPORTED')
     AND p.tax_class_evidence_url LIKE 'https://%'
     AND p.tax_class_reviewed_at IS NOT NULL AND p.tax_class_reviewed_at<=clock_timestamp()
     AND r.access_allowed AND r.extraction_allowed AND r.storage_allowed
     AND r.derivation_allowed AND r.public_display_allowed
     AND r.commercial_use_allowed AND r.redistribution_allowed
     AND r.retention_seconds>0 AND r.reviewed_at IS NOT NULL
     AND r.reviewed_at<=clock_timestamp() AND r.revoked_at IS NULL
     AND (r.expires_at IS NULL OR r.expires_at>clock_timestamp())
     AND r.verification_state='VERIFIED'
     AND r.verification_expires_at>clock_timestamp()
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
