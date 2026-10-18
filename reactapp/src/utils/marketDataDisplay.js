/** Keep absent financial facts absent. JavaScript's Number(null) === 0 must not leak into UI. */
export function nullableMarketNumber(value) {
  if (value === null || value === undefined
      || !['number', 'string'].includes(typeof value)
      || (typeof value === 'string' && value.trim() === '')) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatNullablePercent(value, { decimals = 1, suffix = '%' } = {}) {
  const parsed = nullableMarketNumber(value);
  return parsed === null ? null : `${parsed.toFixed(decimals)}${suffix}`;
}

export const MARKET_DISPLAY_STATES = Object.freeze({
  LOADING: 'LOADING',
  CURRENT: 'CURRENT',
  MARKET_CLOSED: 'MARKET_CLOSED',
  LAST_AVAILABLE: 'LAST_AVAILABLE',
  STALE: 'STALE',
  PARTIAL_DATA: 'PARTIAL_DATA',
  RIGHTS_UNAVAILABLE: 'RIGHTS_UNAVAILABLE',
  UNAVAILABLE: 'UNAVAILABLE',
});

const MARKET_DISPLAY_COPY = Object.freeze({
  LOADING: {
    label: 'Loading market data',
    detail: 'Checking the latest verified market evidence.',
  },
  CURRENT: {
    label: 'Current verified data',
    detail: 'Verified evidence for this market session.',
  },
  MARKET_CLOSED: {
    label: 'Market closed',
    detail: 'Showing the last available verified session data.',
  },
  LAST_AVAILABLE: {
    label: 'Last available data',
    detail: 'The latest verified observation is shown; current session status is unavailable.',
  },
  STALE: {
    label: 'Stale market data',
    detail: 'The verified observation is older than its freshness window.',
  },
  PARTIAL_DATA: {
    label: 'Partial market data',
    detail: 'Some verified market facts are available; the rest are unavailable.',
  },
  RIGHTS_UNAVAILABLE: {
    label: 'Market data permission unavailable',
    detail: 'The market source is not approved for this use. Market data cannot adjust a financial plan until permission is verified.',
  },
  UNAVAILABLE: {
    label: 'Market data unavailable',
    detail: 'Verified market context is temporarily unavailable.',
  },
});

export function getMarketDisplayState(marketContext, { loading = false, refreshFailed = false } = {}) {
  const snapshot = marketContext?.marketSnapshot;
  const selection = marketContext?.liveProviderSelection || snapshot?.providerSelection;
  // Source-rights errors may be nested under an unqualified provider attempt.
  // Do not make the whole snapshot unavailable if another qualified provider
  // was actually selected; never treat a failed attempt as selected evidence.
  const failedProviderReasonCodes = selection && !selection.selectedProvider
    ? (selection.providerFailures || []).flatMap(failure => failure?.reasonCodes || [])
    : [];
  const reasonCodes = [
    ...(Array.isArray(marketContext?.reasonCodes) ? marketContext.reasonCodes : []),
    ...(Array.isArray(snapshot?.reasonCodes) ? snapshot.reasonCodes : []),
    ...(Array.isArray(snapshot?.policyOutput?.reasonCodes)
      ? snapshot.policyOutput.reasonCodes : []),
    ...(Array.isArray(snapshot?.providerStatus?.quotes?.reasonCodes)
      ? snapshot.providerStatus.quotes.reasonCodes : []),
    ...(Array.isArray(snapshot?.providerStatus?.history?.reasonCodes)
      ? snapshot.providerStatus.history.reasonCodes : []),
    snapshot?.providerStatus?.quotes?.error?.code,
    snapshot?.providerStatus?.history?.error?.code,
    snapshot?.error?.code,
    ...failedProviderReasonCodes,
  ];
  const rightsUnavailable = reasonCodes.some(code => [
    'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED',
    'UPSTOX_PUBLIC_DISTRIBUTION_DISABLED',
    'UPSTOX_PERMISSION_DENIED',
  ].includes(code));
  const key = loading
    ? MARKET_DISPLAY_STATES.LOADING
    : rightsUnavailable
      ? MARKET_DISPLAY_STATES.RIGHTS_UNAVAILABLE
    : refreshFailed && marketContext
      ? MARKET_DISPLAY_STATES.LAST_AVAILABLE
    : marketContext?.marketSnapshot?.status
      || (marketContext?.status === 'MARKET_CONTEXT_AVAILABLE'
        ? MARKET_DISPLAY_STATES.LAST_AVAILABLE
        : MARKET_DISPLAY_STATES.UNAVAILABLE);
  const safeKey = MARKET_DISPLAY_COPY[key] ? key : MARKET_DISPLAY_STATES.UNAVAILABLE;
  return { key: safeKey, ...MARKET_DISPLAY_COPY[safeKey] };
}

export function readableSource(value) {
  if (typeof value !== 'string' || !value.trim()) return 'Unavailable';
  const known = {
    GOVERNMENT_OF_INDIA: 'Government of India',
    INDIA_POST: 'India Post',
    OFFICIAL_BANK_PUBLISHED_RATE: 'Official bank published rate',
    OFFICIAL_RBI_FLOATING_COUPON_RATE: 'Official RBI floating coupon',
    QUARTERLY_OFFICIAL_RATE: 'Official quarterly rate',
    VERIFIED_COMPARABLE_OPTION: 'Verified comparable option',
    EVIDENCE_RANKED: 'Evidence ranked',
  };
  return known[value] || value.replaceAll('_', ' ');
}

export function safeSourceUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function formatMarketTimestamp(value) {
  const parsed = value ? new Date(value) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleString('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  });
}

export function getMarketEvidenceSource(marketContext) {
  const snapshot = marketContext?.marketSnapshot;
  const providers = [...new Set((snapshot?.observedFacts || [])
    .filter(fact => fact?.availabilityStatus === 'AVAILABLE' && fact?.source?.provider)
    .map(fact => fact.source.provider))];
  return providers.length ? providers.join(', ') : null;
}

export function getMarketAttemptedProvider(marketContext) {
  const snapshot = marketContext?.marketSnapshot;
  const selection = marketContext?.liveProviderSelection || snapshot?.providerSelection;
  if (Array.isArray(selection?.attemptedProviders) && selection.attemptedProviders.length > 0) {
    return [...new Set(selection.attemptedProviders)].join(', ');
  }
  const providers = [...new Set([
    snapshot?.providerStatus?.quotes?.provider,
    snapshot?.providerStatus?.history?.provider,
    ...(snapshot?.providerStatus?.attemptedProviders || []),
  ].filter(value => typeof value === 'string' && value.trim()))];
  return providers.length ? providers.join(', ') : null;
}
