const PRIVATE_MARKET_DEMO_INSTRUMENTS = Object.freeze({
  'etf:isin:INF204KB14I2': Object.freeze({
    displayName: 'Nippon India ETF Nifty 50 BeES',
    instrumentId: 'NSE_EQ|INF204KB14I2',
  }),
});

/** Return only exact registered product identities supported by the local demo. */
export function getPrivateMarketQuoteRequestIds(products) {
  if (!Array.isArray(products)) return [];
  return [...new Set(products.flatMap(product => {
    const id = product?.id;
    return typeof id === 'string'
      && product.canonicalProductId === id
      && Object.prototype.hasOwnProperty.call(PRIVATE_MARKET_DEMO_INSTRUMENTS, id)
      ? [id]
      : [];
  }))];
}

/** Strict read-only ETF quote admission for the exact product card. */
export function findPrivateQuoteForProduct(snapshot, canonicalProductId) {
  const identity = PRIVATE_MARKET_DEMO_INSTRUMENTS[canonicalProductId];
  if (!identity) return null;
  const upstox = snapshot?.upstox;
  if (!['AVAILABLE', 'PARTIAL'].includes(upstox?.status) || !Array.isArray(upstox.facts)) return null;
  return upstox.facts.find(fact => (
    fact && typeof fact === 'object' && !Array.isArray(fact)
    && fact.canonicalProductId === canonicalProductId
    && fact.availabilityStatus === 'AVAILABLE'
    && fact.source?.provider === 'UPSTOX'
    && fact.source?.instrumentId === identity.instrumentId
    && typeof fact.value === 'number' && Number.isFinite(fact.value) && fact.value > 0
    && typeof (fact.quoteLastTradeAt || fact.observedAt) === 'string'
    && Number.isFinite(Date.parse(fact.quoteLastTradeAt || fact.observedAt))
  )) || null;
}

/**
 * Admit only exact product instruments returned by the authenticated local
 * Upstox demo. Index observations belong to market context, not product cards.
 */
export function getPrivateMarketObservationRows(snapshot, canonicalProductIds = []) {
  const upstox = snapshot?.upstox;
  if (!['AVAILABLE', 'PARTIAL'].includes(upstox?.status)
      || !Array.isArray(upstox.facts) || !Array.isArray(canonicalProductIds)) return [];
  const requestedIds = new Set(canonicalProductIds);

  return upstox.facts.flatMap(fact => {
    const canonicalProductId = fact?.canonicalProductId;
    const identity = PRIVATE_MARKET_DEMO_INSTRUMENTS[canonicalProductId];
    const lastTradeAt = fact?.quoteLastTradeAt || fact?.observedAt;
    if (!identity || !requestedIds.has(canonicalProductId)
        || fact?.availabilityStatus !== 'AVAILABLE'
        || fact?.source?.provider !== 'UPSTOX'
        || fact?.source?.instrumentId !== identity.instrumentId
        || typeof fact.value !== 'number' || !Number.isFinite(fact.value) || fact.value <= 0
        || typeof lastTradeAt !== 'string' || !Number.isFinite(Date.parse(lastTradeAt))) return [];

    const unit = fact.unit === 'INDEX_POINTS' ? 'pts' : fact.currency || null;
    return [{
      canonicalProductId,
      name: identity.displayName,
      formattedValue: `${fact.value.toLocaleString('en-IN', { maximumFractionDigits: 2 })}${unit ? ` ${unit}` : ''}`,
      lastTradeAt,
      responseGeneratedAt: fact.quoteResponseGeneratedAt || null,
      fetchedAt: fact.providerResponseReceivedAt || fact.fetchedAt || null,
      freshness: ['FRESH', 'STALE', 'UNKNOWN'].includes(fact.freshness?.status)
        ? fact.freshness.status : 'UNKNOWN',
      ageSeconds: Number.isFinite(fact.freshness?.ageSeconds) ? fact.freshness.ageSeconds : null,
    }];
  });
}
