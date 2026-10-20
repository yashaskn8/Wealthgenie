export const MARKET_DATA_SCHEMA_VERSION = 'market-fact-1.0.0';

export const PROVIDERS = Object.freeze({
  AMFI: 'AMFI',
  NSE: 'NSE',
  UPSTOX: 'UPSTOX',
  GOVERNMENT_OF_INDIA: 'GOVERNMENT_OF_INDIA',
  SBI: 'SBI',
  RBI: 'RBI',
});

export const FACT_KINDS = Object.freeze({
  MUTUAL_FUND_NAV: 'MUTUAL_FUND_NAV',
  MARKET_QUOTE: 'MARKET_QUOTE',
  SCHEME_INTEREST_RATE: 'SCHEME_INTEREST_RATE',
  TERM_DEPOSIT_RATE: 'TERM_DEPOSIT_RATE',
});

export const AVAILABILITY = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  PARTIAL: 'PARTIAL',
  UNAVAILABLE: 'UNAVAILABLE',
  PROVIDER_NOT_CONFIGURED: 'PROVIDER_NOT_CONFIGURED',
  SOURCE_ERROR: 'SOURCE_ERROR',
});

export const FRESHNESS = Object.freeze({
  FRESH: 'FRESH',
  STALE: 'STALE',
  UNKNOWN: 'UNKNOWN',
});

// Semantic class is intentionally separate from dataClass. dataClass describes
// the provider fact (for example LIVE or DAILY); semanticClass describes where
// the value sits in the market-data data plane.
export const MARKET_FACT_SEMANTIC_CLASSES = Object.freeze({
  OBSERVED: 'OBSERVED',
  DERIVED: 'DERIVED',
  POLICY_OUTPUT: 'POLICY_OUTPUT',
});

export function nullableFiniteNumber(value) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  let candidate = value;
  if (typeof candidate === 'string' && /^\d+$/.test(candidate.trim())) {
    candidate = Number(candidate);
  }
  if (typeof candidate === 'number' && Number.isFinite(candidate)) {
    candidate = candidate < 10_000_000_000 ? candidate * 1000 : candidate;
  }
  if (typeof candidate === 'string') {
    const isoDate = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/.exec(candidate.trim());
    if (isoDate) {
      const [, yearText, monthText, dayText] = isoDate;
      const year = Number(yearText);
      const month = Number(monthText);
      const day = Number(dayText);
      const calendarDate = new Date(0);
      calendarDate.setUTCHours(0, 0, 0, 0);
      calendarDate.setUTCFullYear(year, month - 1, day);
      if (month < 1 || month > 12 || day < 1
          || calendarDate.getUTCFullYear() !== year
          || calendarDate.getUTCMonth() !== month - 1
          || calendarDate.getUTCDate() !== day) return null;
    }
  }
  const parsed = candidate instanceof Date ? candidate : new Date(candidate);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function evaluateFreshness({ observedAt, fetchedAt, maxAgeSeconds, now = new Date() }) {
  const observed = normalizeTimestamp(observedAt);
  const fetched = normalizeTimestamp(fetchedAt);
  const maximumAge = nullableFiniteNumber(maxAgeSeconds);
  if (!observed || !fetched || maximumAge === null || maximumAge < 0) {
    return { status: FRESHNESS.UNKNOWN, ageSeconds: null, maxAgeSeconds: maximumAge };
  }
  const referenceTime = normalizeTimestamp(now);
  if (!referenceTime) {
    return { status: FRESHNESS.UNKNOWN, ageSeconds: null, maxAgeSeconds: maximumAge };
  }
  const referenceMs = Date.parse(referenceTime);
  const observedMs = Date.parse(observed);
  const fetchedMs = Date.parse(fetched);
  if (observedMs > referenceMs || fetchedMs > referenceMs) {
    return { status: FRESHNESS.UNKNOWN, ageSeconds: null, maxAgeSeconds: maximumAge };
  }
  const ageSeconds = Math.floor((referenceMs - observedMs) / 1000);
  return {
    status: ageSeconds <= maximumAge ? FRESHNESS.FRESH : FRESHNESS.STALE,
    ageSeconds,
    maxAgeSeconds: maximumAge,
  };
}

export function createMarketFact({
  kind,
  canonicalProductId,
  sourceProvider,
  sourceInstrumentId,
  sourceUrl,
  value,
  currency = null,
  unit,
  observedAt,
  fetchedAt,
  maxAgeSeconds,
  providerTimestamp = null,
  effectiveTradingDate = null,
  effectiveFrom = null,
  effectiveTo = null,
  publicationDate = null,
  dataClass = null,
  semanticClass = MARKET_FACT_SEMANTIC_CLASSES.OBSERVED,
  derivation = null,
  metrics = {},
  now = new Date(),
}) {
  if (!Object.values(FACT_KINDS).includes(kind)) throw new TypeError(`Unsupported market fact kind: ${kind}`);
  if (!canonicalProductId || !sourceProvider || !sourceInstrumentId || !sourceUrl || !unit) {
    throw new TypeError('Market facts require stable identity, provider, source URL, and unit.');
  }
  const numericValue = nullableFiniteNumber(value);
  const normalizedObservedAt = normalizeTimestamp(observedAt);
  const normalizedFetchedAt = normalizeTimestamp(fetchedAt);
  const availabilityStatus = numericValue === null || !normalizedObservedAt || !normalizedFetchedAt
    ? AVAILABILITY.UNAVAILABLE
    : AVAILABILITY.AVAILABLE;

  return {
    schemaVersion: MARKET_DATA_SCHEMA_VERSION,
    kind,
    canonicalProductId,
    value: numericValue,
    currency,
    unit,
    observedAt: normalizedObservedAt,
    providerTimestamp: normalizeTimestamp(providerTimestamp),
    effectiveTradingDate: effectiveTradingDate || null,
    effectiveFrom: effectiveFrom || null,
    effectiveTo: effectiveTo || null,
    publicationDate: publicationDate || null,
    fetchedAt: normalizedFetchedAt,
    dataClass,
    semanticClass,
    derivation,
    availabilityStatus,
    freshness: evaluateFreshness({
      observedAt: normalizedObservedAt,
      fetchedAt: normalizedFetchedAt,
      maxAgeSeconds,
      now,
    }),
    source: {
      provider: sourceProvider,
      instrumentId: String(sourceInstrumentId),
      url: sourceUrl,
    },
    metrics: Object.fromEntries(
      Object.entries(metrics).map(([key, metricValue]) => [key, nullableFiniteNumber(metricValue)]),
    ),
  };
}
