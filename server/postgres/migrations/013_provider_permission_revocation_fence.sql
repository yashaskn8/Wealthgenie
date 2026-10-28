-- Correctly distinguish narrowing/revoking a permission from replaying an
-- authenticated grant. Additive migration: do not modify applied migration 012.
CREATE OR REPLACE FUNCTION finance.enforce_provider_permission_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'UPDATE' THEN
   IF OLD.verification_state IN ('REVOKED','REJECTED')
       AND NEW.verification_state = 'VERIFIED' THEN
     RAISE EXCEPTION 'PROVIDER_PERMISSION_TERMINAL_STATE' USING ERRCODE='23514';
   END IF;
   IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL THEN
     RAISE EXCEPTION 'PROVIDER_PERMISSION_REVOCATION_CANNOT_BE_UNDONE'
       USING ERRCODE='23514';
   END IF;
   IF OLD.verification_state = 'VERIFIED'
       AND NEW.verification_state = 'VERIFIED' THEN
     IF NEW.verification_revision < OLD.verification_revision THEN
       RAISE EXCEPTION 'PROVIDER_PERMISSION_REPLAY' USING ERRCODE='23514';
     END IF;
     IF NEW.verification_revision = OLD.verification_revision THEN
       -- No new signed receipt: allow only rights to be narrowed, source to
       -- be revoked, or metadata to remain unchanged.
       IF NEW.entitlement_receipt_sha256 IS DISTINCT FROM OLD.entitlement_receipt_sha256
         OR NEW.verification_issuer IS DISTINCT FROM OLD.verification_issuer
         OR NEW.verification_claim_id IS DISTINCT FROM OLD.verification_claim_id
         OR NEW.endpoint_url IS DISTINCT FROM OLD.endpoint_url
         OR NEW.verification_expires_at > OLD.verification_expires_at
         OR (OLD.expires_at IS NOT NULL AND
            (NEW.expires_at IS NULL OR NEW.expires_at > OLD.expires_at))
         OR NEW.retention_seconds > OLD.retention_seconds
         OR (NEW.access_allowed AND NOT OLD.access_allowed)
         OR (NEW.extraction_allowed AND NOT OLD.extraction_allowed)
         OR (NEW.storage_allowed AND NOT OLD.storage_allowed)
         OR (NEW.derivation_allowed AND NOT OLD.derivation_allowed)
         OR (NEW.public_display_allowed AND NOT OLD.public_display_allowed)
         OR (NEW.commercial_use_allowed AND NOT OLD.commercial_use_allowed)
         OR (NEW.redistribution_allowed AND NOT OLD.redistribution_allowed)
       THEN
         RAISE EXCEPTION 'PROVIDER_PERMISSION_ESCALATION_WITHOUT_NEW_GRANT'
           USING ERRCODE='23514';
       END IF;
     ELSE
       -- Renewal requires increasing revision and a DIFFERENT signed proof
       -- for the same provider, source ID, and grant.
       IF NEW.entitlement_receipt_sha256 IS NOT DISTINCT FROM OLD.entitlement_receipt_sha256
         OR NEW.verification_issuer IS DISTINCT FROM OLD.verification_issuer
         OR NEW.verification_claim_id IS DISTINCT FROM OLD.verification_claim_id
         OR NEW.endpoint_url IS DISTINCT FROM OLD.endpoint_url
       THEN
         RAISE EXCEPTION 'PROVIDER_PERMISSION_REPLAY_OR_SUBSTITUTION'
           USING ERRCODE='23514';
       END IF;
     END IF;
   END IF;
 END IF;
 RETURN NEW;
END $$;
