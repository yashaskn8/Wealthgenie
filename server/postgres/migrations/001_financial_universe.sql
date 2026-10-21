-- WealthGenie finance-universe schema v1. Run as a controlled migration.
-- Shared product/market authority ONLY. Personal financial records stay in MongoDB.
CREATE SCHEMA IF NOT EXISTS finance;
CREATE TABLE IF NOT EXISTS finance.categories (
 id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9_-]{1,79}$'),
 label text NOT NULL,
 status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','HISTORICAL','UNVERIFIED')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS finance.subcategories (
 id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9_-]{1,79}$'),
 category_id text NOT NULL REFERENCES finance.categories(id) ON DELETE RESTRICT,
 label text NOT NULL,
 UNIQUE (category_id,label),
 UNIQUE (id,category_id)
);
CREATE TABLE IF NOT EXISTS finance.products (
 id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 160),
 name text NOT NULL CHECK (length(trim(name)) > 0),
 record_kind text NOT NULL CHECK (record_kind IN ('ARCHETYPE','ACTUAL_PRODUCT')),
 category_id text NOT NULL REFERENCES finance.categories(id) ON DELETE RESTRICT,
 subcategory_id text NULL,
 source_identity text NULL,
 availability text NOT NULL DEFAULT 'UNVERIFIED' CHECK
  (availability IN ('AVAILABLE','UNVERIFIED','RESTRICTED','CLOSED','HISTORICAL')),
 recommendation_eligible boolean NOT NULL DEFAULT false,
 version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
 FOREIGN KEY (subcategory_id,category_id) REFERENCES finance.subcategories(id,category_id),
 CHECK (record_kind <> 'ACTUAL_PRODUCT' OR source_identity IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS product_source_identity_unique
 ON finance.products (source_identity) WHERE source_identity IS NOT NULL;
CREATE INDEX IF NOT EXISTS products_browse_idx ON finance.products(category_id,subcategory_id,id);
CREATE TABLE IF NOT EXISTS finance.provider_rights (
 source_id text PRIMARY KEY,
 endpoint_url text NOT NULL CHECK (endpoint_url LIKE 'https://%'),
 access_allowed boolean NOT NULL DEFAULT false,
 extraction_allowed boolean NOT NULL DEFAULT false,
 storage_allowed boolean NOT NULL DEFAULT false,
 derivation_allowed boolean NOT NULL DEFAULT false,
 public_display_allowed boolean NOT NULL DEFAULT false,
 commercial_use_allowed boolean NOT NULL DEFAULT false,
 redistribution_allowed boolean NOT NULL DEFAULT false,
 retention_seconds bigint NULL CHECK (retention_seconds >= 0),
 evidence_url text NOT NULL,
 reviewed_at timestamptz NULL,
 expires_at timestamptz NULL,
 revoked_at timestamptz NULL,
 CHECK (NOT storage_allowed OR (access_allowed AND extraction_allowed))
);
CREATE TABLE IF NOT EXISTS finance.product_external_ids (
 product_id text NOT NULL REFERENCES finance.products(id) ON DELETE RESTRICT,
 source_id text NOT NULL REFERENCES finance.provider_rights(source_id) ON DELETE RESTRICT,
 source_instrument_id text NOT NULL CHECK (length(source_instrument_id) BETWEEN 1 AND 255),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (product_id,source_id,source_instrument_id),
 UNIQUE(source_id,source_instrument_id)
);
CREATE TABLE IF NOT EXISTS finance.product_terms (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 product_id text NOT NULL REFERENCES finance.products(id) ON DELETE RESTRICT,
 term_type text NOT NULL,
 term_value numeric(24,8) NOT NULL,
 unit text NOT NULL,
 effective_from date NOT NULL,
 effective_to date NULL CHECK (effective_to >= effective_from),
 source_id text NOT NULL REFERENCES finance.provider_rights(source_id),
 inserted_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(product_id,term_type,effective_from,source_id)
);
CREATE TABLE IF NOT EXISTS finance.market_observations (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 product_id text NOT NULL REFERENCES finance.products(id) ON DELETE RESTRICT,
 source_id text NOT NULL REFERENCES finance.provider_rights(source_id),
 source_instrument_id text NOT NULL,
 FOREIGN KEY (product_id,source_id,source_instrument_id)
   REFERENCES finance.product_external_ids(product_id,source_id,source_instrument_id),
 observation_type text NOT NULL CHECK (observation_type IN ('PRICE','NAV','PUBLISHED_RATE','YIELD','VOLUME')),
 value numeric(24,8) NOT NULL,
 currency text NULL,
 unit text NOT NULL,
 data_class text NOT NULL CHECK (data_class IN ('LIVE','DELAYED','END_OF_DAY','PUBLISHED_RATE')),
 effective_from date NULL,
 effective_to date NULL CHECK (effective_to >= effective_from),
 observed_at timestamptz NOT NULL,
 fetched_at timestamptz NOT NULL CHECK (fetched_at >= observed_at),
 source_revision text NOT NULL DEFAULT '0',
 retain_until timestamptz NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(product_id,source_id,source_instrument_id,observation_type,observed_at,source_revision),
 CHECK (observation_type NOT IN ('PRICE','NAV','PUBLISHED_RATE') OR value >= 0),
 CHECK (data_class <> 'PUBLISHED_RATE' OR effective_from IS NOT NULL),
 CHECK (retain_until IS NULL OR retain_until >= fetched_at)
);
CREATE INDEX IF NOT EXISTS observations_latest_idx
 ON finance.market_observations(product_id,observation_type,observed_at DESC);
CREATE INDEX IF NOT EXISTS observations_retention_idx
 ON finance.market_observations(retain_until) WHERE retain_until IS NOT NULL;
-- Append-only revisions do not destroy a prior published observation.
CREATE TABLE IF NOT EXISTS finance.observation_corrections (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 observation_id bigint NOT NULL REFERENCES finance.market_observations(id) ON DELETE CASCADE,
 corrected_by_id bigint NOT NULL REFERENCES finance.market_observations(id) ON DELETE CASCADE,
 recorded_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(observation_id,corrected_by_id),
 CHECK (observation_id <> corrected_by_id)
);
