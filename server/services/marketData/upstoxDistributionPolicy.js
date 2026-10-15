/**
 * Public Upstox data is usable in production only after an operator confirms
 * that the applicable public distribution rights have been verified. Outside
 * production, fixtures and local development retain their existing behavior.
 */
export function isUpstoxPublicDistributionAllowed(env = process.env) {
  return env.NODE_ENV !== 'production'
    || env.UPSTOX_PUBLIC_MARKET_DATA_LICENSE_CONFIRMED === 'true';
}

/** Recognize provider provenance across normalized observations and snapshots. */
export function hasUpstoxProvenance(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return false;
  if (Array.isArray(value)) return value.some(item => hasUpstoxProvenance(item, depth + 1));

  if ([value.provider, value.sourceProvider, value.selectedProvider].includes('UPSTOX')) return true;
  const provenanceFields = [
    'marketSnapshot',
    'providerSelection',
    'providerStatus',
    'observedFacts',
    'derivedFacts',
    'provenance',
    'sources',
    'facts',
    'candles',
    'source',
  ];
  return provenanceFields.some(field => hasUpstoxProvenance(value[field], depth + 1));
}
