-- Explicit audited relation: catalog family is NOT a tradable financial product.
-- Default state has zero approved family/product links.
CREATE TABLE IF NOT EXISTS finance.family_product_qualifications (
 family_id text NOT NULL REFERENCES finance.products(id) ON DELETE RESTRICT,
 product_id text NOT NULL REFERENCES finance.products(id) ON DELETE RESTRICT,
 source_id text NOT NULL REFERENCES finance.provider_rights(source_id) ON DELETE RESTRICT,
 observation_type text NOT NULL CHECK (observation_type IN ('PRICE','NAV','PUBLISHED_RATE','YIELD')),
 status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACTIVE','SUSPENDED')),
 evidence_url text NOT NULL CHECK (evidence_url LIKE 'https://%'),
 terms_evidence_url text NOT NULL CHECK (terms_evidence_url LIKE 'https://%'),
 risk_evidence_url text NOT NULL CHECK (risk_evidence_url LIKE 'https://%'),
 reviewed_by text NOT NULL CHECK (length(trim(reviewed_by)) BETWEEN 3 AND 180),
 reviewed_at timestamptz NOT NULL,
 valid_until timestamptz NOT NULL CHECK (valid_until > reviewed_at),
 risk_level smallint NOT NULL CHECK (risk_level BETWEEN 1 AND 5),
 min_investment_inr numeric(20,2) NOT NULL CHECK (min_investment_inr > 0),
 min_horizon_years smallint NOT NULL CHECK (min_horizon_years BETWEEN 0 AND 40),
 lock_in_months smallint NOT NULL CHECK (lock_in_months BETWEEN 0 AND 480),
 annual_fee_bps integer NOT NULL CHECK (annual_fee_bps BETWEEN 0 AND 10000),
 min_age smallint NOT NULL DEFAULT 18 CHECK (min_age BETWEEN 0 AND 120),
 max_age smallint NOT NULL DEFAULT 120 CHECK (max_age BETWEEN 0 AND 120),
 retail_access boolean NOT NULL DEFAULT false,
 requires_demat boolean NOT NULL DEFAULT false,
 requires_accreditation boolean NOT NULL DEFAULT false,
 requires_nps_account boolean NOT NULL DEFAULT false,
 requires_child_eligibility boolean NOT NULL DEFAULT false,
 last_review_note text NOT NULL CHECK (length(trim(last_review_note)) BETWEEN 12 AND 1500),
 review_version bigint NOT NULL DEFAULT 1 CHECK (review_version > 0),
 PRIMARY KEY (family_id,product_id),
 CHECK (family_id <> product_id),
 CHECK (min_age <= max_age)
);
CREATE INDEX IF NOT EXISTS family_product_active_idx
 ON finance.family_product_qualifications(family_id,valid_until,product_id)
 WHERE status='ACTIVE';
CREATE TABLE IF NOT EXISTS finance.family_product_review_audit (
 audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 family_id text NOT NULL,
 product_id text NOT NULL,
 action text NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE')),
 old_state jsonb,
 new_state jsonb,
 database_actor text NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE OR REPLACE FUNCTION finance.record_family_product_review()
 RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN
  INSERT INTO finance.family_product_review_audit
   (family_id,product_id,action,old_state,new_state,database_actor)
  VALUES(COALESCE(NEW.family_id,OLD.family_id),
    COALESCE(NEW.product_id,OLD.product_id),TG_OP,
    CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) ELSE NULL END,
    CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) ELSE NULL END,current_user);
  RETURN COALESCE(NEW,OLD);
 END $$;
CREATE TRIGGER family_product_review_changes
 AFTER INSERT OR UPDATE OR DELETE ON finance.family_product_qualifications
 FOR EACH ROW EXECUTE FUNCTION finance.record_family_product_review();
CREATE OR REPLACE FUNCTION finance.reject_family_review_audit_mutation()
 RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'FAMILY_REVIEW_AUDIT_IMMUTABLE' USING ERRCODE='23514'; END $$;
CREATE TRIGGER family_review_audit_immutable
 BEFORE UPDATE OR DELETE ON finance.family_product_review_audit
 FOR EACH ROW EXECUTE FUNCTION finance.reject_family_review_audit_mutation();
