/**
 * Client-only last-line integrity check. Source, entitlement and tax authority
 * remain on the backend. Reject malformed or cross-product DTOs before
 * displaying any gross maturity number, including stale cached responses.
 */
export function mayDisplayContractualProceeds(product) {
  const result = product?.cashflowIllustration;
  const ledger = result?.cashflowLedger;
  if (result?.status !== 'CALCULATED'
    || typeof result.canonicalProductId !== 'string'
    || result.canonicalProductId !== product?.canonicalProductId
    || !ledger || ledger.status !== 'RECONCILED'
    || ledger.currency !== 'INR' || ledger.precision !== 'INTEGER_PAISE'
    || !['MATURITY_COMPOUND', 'ANNUAL_PAYOUT', 'SOURCE_TENOR_DOUBLE'].includes(result.cashflowType)
    || !Number.isInteger(result.tenureMonths) || result.tenureMonths < 1 || result.tenureMonths > 360
    || result.postTaxProceeds !== null) return false;

  const principal = result.principal;
  const proceeds = result.grossTotalProceeds;
  const maturity = result.grossMaturityProceeds;
  if (![principal, proceeds, maturity].every(v => Number.isFinite(v) && v > 0)
    || proceeds < principal || maturity > proceeds
    || !Number.isSafeInteger(ledger.totalReceiptsPaise)
    || !Number.isSafeInteger(ledger.grossGainPaise)
    || !Array.isArray(ledger.events) || ledger.events.length < 2 || ledger.events.length > 50) return false;

  // Require exact two-decimal transport values: arithmetic done in integer paise.
  const paise = v => {
    const m = /^(0|[1-9][0-9]*)(?:[.]([0-9]{1,2}))?$/.exec(String(v));
    if (!m) return null;
    const cents = Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'));
    return Number.isSafeInteger(cents) ? cents : null;
  };
  const principalPaise = paise(principal), grossPaise = paise(proceeds);
  if (principalPaise === null || grossPaise === null
    || grossPaise !== ledger.totalReceiptsPaise
    || ledger.grossGainPaise !== grossPaise - principalPaise) return false;

  let receipts = 0;
  for (const [i, event] of ledger.events.entries()) {
    if (!Number.isSafeInteger(event?.amountPaise)
      || !Number.isInteger(event.monthOffset)
      || event.monthOffset < 0 || event.monthOffset > result.tenureMonths
      || (i === 0 && (event.kind !== 'SUBSCRIPTION'
        || event.monthOffset !== 0 || event.amountPaise !== -principalPaise))) return false;
    if (i > 0 && event.amountPaise < 0) return false;
    receipts += Math.max(0, event.amountPaise);
    if (!Number.isSafeInteger(receipts)) return false;
  }
  return receipts === grossPaise;
}
