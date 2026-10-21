-- The source reference qualifies only the type of investment for discovery,
-- never a particular security's investment availability, suitability or returns.
ALTER TABLE finance.products
  ADD COLUMN IF NOT EXISTS discovery_metadata jsonb NULL;
ALTER TABLE finance.products
  ADD CONSTRAINT finance_discovery_metadata_object
    CHECK (discovery_metadata IS NULL OR jsonb_typeof(discovery_metadata)='object');
ALTER TABLE finance.products
  ADD CONSTRAINT finance_discovery_metadata_archetype_only
    CHECK (discovery_metadata IS NULL OR record_kind='ARCHETYPE');
ALTER TABLE finance.products
  ADD CONSTRAINT finance_discovery_metadata_cannot_auto_recommend
    CHECK (discovery_metadata IS NULL OR recommendation_eligible=false);
