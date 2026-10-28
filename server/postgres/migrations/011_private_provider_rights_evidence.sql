-- Keep confidential provider agreements outside the financial database.
-- The digest and opaque reference identify the reviewed document without
-- storing its contents, path, or a link to it. Existing URL-backed records
-- retain their original evidence and audit history.
ALTER TABLE finance.provider_rights
  ALTER COLUMN evidence_url DROP NOT NULL;
ALTER TABLE finance.provider_rights
  ADD COLUMN IF NOT EXISTS evidence_sha256 text NULL;
ALTER TABLE finance.provider_rights
  ADD COLUMN IF NOT EXISTS approval_reference text NULL;
ALTER TABLE finance.provider_rights
  ADD COLUMN IF NOT EXISTS attested_by text NULL;
ALTER TABLE finance.provider_rights
  ADD CONSTRAINT provider_rights_private_evidence
  CHECK (
    evidence_url IS NOT NULL OR (
      evidence_sha256 IS NOT NULL
      AND evidence_sha256 ~ '^[a-f0-9]{64}$'
      AND approval_reference IS NOT NULL
      AND length(trim(approval_reference)) BETWEEN 8 AND 160
      AND attested_by IS NOT NULL
      AND length(trim(attested_by)) BETWEEN 3 AND 180
    )
  );
COMMENT ON COLUMN finance.provider_rights.evidence_sha256 IS
  'SHA-256 of a provider approval document held outside PostgreSQL; not proof that its terms were correctly reviewed.';
COMMENT ON COLUMN finance.provider_rights.approval_reference IS
  'Opaque operator reference; must not contain confidential agreement text or a filesystem path.';
