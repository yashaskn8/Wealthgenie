-- License eligibility is not inferred by this audit trail.
-- Preserve who/when/what whenever an operator changes provider rights.
CREATE TABLE IF NOT EXISTS finance.provider_rights_audit (
  audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE')),
  prior_state jsonb NULL,
  resulting_state jsonb NULL,
  database_actor text NOT NULL,
  application_name text NULL,
  transaction_identity bigint NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS provider_rights_audit_source_time_idx
 ON finance.provider_rights_audit (source_id,recorded_at DESC,audit_id DESC);
CREATE OR REPLACE FUNCTION finance.record_provider_rights_change()
 RETURNS trigger
 LANGUAGE plpgsql
 AS $$
 BEGIN
  INSERT INTO finance.provider_rights_audit
    (source_id,action,prior_state,resulting_state,database_actor,
     application_name,transaction_identity)
  VALUES(
    COALESCE(NEW.source_id,OLD.source_id),
    TG_OP,
    CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) ELSE NULL END,
    CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) ELSE NULL END,
    current_user,current_setting('application_name',true),txid_current()
  );
  RETURN COALESCE(NEW,OLD);
 END
 $$;
DROP TRIGGER IF EXISTS provider_rights_record_changes ON finance.provider_rights;
CREATE TRIGGER provider_rights_record_changes
 AFTER INSERT OR UPDATE OR DELETE ON finance.provider_rights
 FOR EACH ROW EXECUTE FUNCTION finance.record_provider_rights_change();
