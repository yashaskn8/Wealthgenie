/** Strict read-only ETF quote admission for the educational WTI price preview. */
export function findPrivateQuoteForProduct(snapshot, canonicalProductId) {
  if (typeof canonicalProductId !== 'string' || !canonicalProductId.startsWith('etf:isin:')) return null;
  const upstox = snapshot?.upstox;
  if (!['AVAILABLE', 'PARTIAL'].includes(upstox?.status) || !Array.isArray(upstox.facts)) return null;
  return upstox.facts.find(fact => (
    fact && typeof fact === 'object' && !Array.isArray(fact)
    && fact.canonicalProductId === canonicalProductId
    && fact.availabilityStatus === 'AVAILABLE'
    && typeof fact.value === 'number' && Number.isFinite(fact.value) && fact.value > 0
    && typeof (fact.quoteLastTradeAt || fact.observedAt) === 'string'
    && Number.isFinite(Date.parse(fact.quoteLastTradeAt || fact.observedAt))
  )) || null;
}
