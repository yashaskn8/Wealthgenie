-- Operator-reported permissions are NOT provider-authorized production data rights.
-- The owner described a small-scale, no-resale read/display grant whose original
-- correspondence is unavailable. This register tracks the claim without promoting
-- any grant into finance.provider_rights.
CREATE TABLE IF NOT EXISTS finance.permission_assertions (
  assertion_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_name text NULL,
  source_id text NULL REFERENCES finance.provider_rights(source_id),
  project_purpose text NOT NULL DEFAULT 'NONCOMMERCIAL_SMALL_SCALE',
  evidence_status text NOT NULL DEFAULT 'OWNER_REPORTED_DOCUMENT_UNAVAILABLE'
    CHECK (evidence_status IN (
      'OWNER_REPORTED_DOCUMENT_UNAVAILABLE',
      'DOCUMENT_AVAILABLE_NOT_REVIEWED',
      'PROVIDER_AUTHORIZATION_VERIFIED')),
  read_status text NOT NULL DEFAULT 'OWNER_REPORTED_ALLOWED',
  display_status text NOT NULL DEFAULT 'OWNER_REPORTED_ALLOWED',
  storage_status text NOT NULL DEFAULT 'NOT_ESTABLISHED',
  derivative_calculation_status text NOT NULL DEFAULT 'NOT_ESTABLISHED',
  onward_sale_status text NOT NULL DEFAULT 'OWNER_REPORTED_PROHIBITED',
  redistribution_status text NOT NULL DEFAULT 'NOT_ESTABLISHED',
  statement text NOT NULL,
  asserted_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_name IS NOT NULL OR source_id IS NOT NULL),
  CHECK (storage_status IN ('NOT_ESTABLISHED','EXPLICITLY_ALLOWED','PROHIBITED')),
  CHECK (derivative_calculation_status IN ('NOT_ESTABLISHED','EXPLICITLY_ALLOWED','PROHIBITED')),
  CHECK (onward_sale_status IN ('OWNER_REPORTED_PROHIBITED','PROHIBITED','EXPLICITLY_ALLOWED'))
);
COMMENT ON TABLE finance.permission_assertions IS
 'Audit of operator-reported scopes only. It does NOT automatically grant storage, commercial calculation, or redistribution rights.';
CREATE OR REPLACE FUNCTION finance.reject_permission_assertion_mutation()
 RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
   RAISE EXCEPTION 'PERMISSION_ASSERTION_APPEND_ONLY' USING ERRCODE='23514';
 END $$;
CREATE TRIGGER permission_assertions_append_only
 BEFORE UPDATE OR DELETE ON finance.permission_assertions
 FOR EACH ROW EXECUTE FUNCTION finance.reject_permission_assertion_mutation();
