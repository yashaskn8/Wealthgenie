import MarketDataProvider from './MarketDataProvider.js';
import {
  AVAILABILITY,
  FACT_KINDS,
  FRESHNESS,
  MARKET_DATA_SCHEMA_VERSION,
  PROVIDERS,
  createMarketFact,
} from './contracts.js';
import { readThroughMarketCache } from './requestCache.js';
import GovernmentSmallSavingsProvider, {
  GOVERNMENT_RATE_DATA_CLASS,
  INDIA_POST_SAVINGS_URL,
} from './GovernmentSmallSavingsProvider.js';

export const RBI_FRSB_NOTIFICATION_URL = 'https://www.rbi.org.in/scripts/NotificationUser.aspx?Id=11924';
export const RBI_RETAIL_DIRECT_URL = 'https://rbiretaildirect.org.in/index.html';
export const RBI_FRSB_CACHE_KEY = `market:rbi:frsb-2020:${MARKET_DATA_SCHEMA_VERSION}:qualified-identities-2`;
export const RBI_FRSB_CACHE_TTL_SECONDS = 12 * 60 * 60;
export const RBI_FRSB_CANONICAL_PRODUCT_ID = 'government:rbi:frsb-2020-taxable';
export const RBI_RATE_DATA_CLASS = 'OFFICIAL_RBI_FLOATING_COUPON_RATE';
export const RBI_FRSB_SPREAD_BPS = 35;
export const RBI_FRSB_SPREAD_PERCENT = 0.35;
const INDIA_TIME_ZONE = 'Asia/Kolkata';

function indiaCalendarParts(referenceDate) {
  const date = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
  if (Number.isNaN(date.getTime())) throw new TypeError('Invalid FRSB reset-period date.');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: INDIA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
}

export function rbiFrsbCacheKeyAt(referenceDate) {
  const { resetDate } = calculateFrsbResetPeriod(referenceDate);
  return `${RBI_FRSB_CACHE_KEY}:${resetDate}`;
}

export function calculateFrsbResetPeriod(referenceDate = new Date()) {
  const date = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('Invalid reference date for FRSB reset period calculation.');
  }
  const { year: yearText, month: monthText } = indiaCalendarParts(date);
  const year = Number(yearText);
  const month = Number(monthText) - 1; // 0 = Jan, ..., 5 = Jun, 6 = Jul, ..., 11 = Dec
  if (month < 6) {
    return {
      resetDate: `${year}-01-01`,
      effectiveFrom: `${year}-01-01`,
      effectiveTo: `${year}-06-30`,
    };
  }
  return {
    resetDate: `${year}-07-01`,
    effectiveFrom: `${year}-07-01`,
    effectiveTo: `${year}-12-31`,
  };
}

export function parseRbiOperationalGuidelines(html, { sourceUrl = RBI_FRSB_NOTIFICATION_URL } = {}) {
  if (typeof html !== 'string' || !html.trim()) {
    throw new Error('RBI_EMPTY_RESPONSE');
  }
  if (!/Floating Rate Savings Bonds,\s*2020\s*\(Taxable\)/i.test(html)) {
    throw new Error('RBI_SCHEMA_MISMATCH:instrument_title');
  }
  if (!/National Saving(?:s)? Certificate\s*\(\s*NSC\s*\)/i.test(html)) {
    throw new Error('RBI_SCHEMA_MISMATCH:nsc_linkage');
  }
  const spreadMatch = html.match(/spread of\s*(?:\(\+\)\s*)?(\d+)\s*bps/i);
  if (!spreadMatch) {
    throw new Error('RBI_SCHEMA_MISMATCH:spread_rule');
  }
  const spreadBps = Number(spreadMatch[1]);
  if (spreadBps !== 35) {
    throw new Error('RBI_SCHEMA_MISMATCH:unexpected_spread');
  }
  if (!/reset every six months/i.test(html)) {
    throw new Error('RBI_SCHEMA_MISMATCH:reset_frequency');
  }
  if (!/tenure of 7 years|repayable on expiry of seven years/i.test(html)) {
    throw new Error('RBI_SCHEMA_MISMATCH:tenure');
  }

  return {
    instrumentName: 'Floating Rate Savings Bonds, 2020 (Taxable)',
    referenceRate: 'NSC',
    spreadBps,
    spreadPercent: spreadBps / 100,
    tenureMonths: 84,
    couponResetFrequency: 'SEMI_ANNUAL',
    interestPaymentFrequency: 'SEMI_ANNUAL',
    sourceUrl,
    ruleQualified: true,
  };
}

function isStrictCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function findNscResetRateFact(nscFacts, resetDate) {
  if (!Array.isArray(nscFacts) || nscFacts.length === 0) return null;
  const candidates = nscFacts.filter(fact => {
    const isNsc = fact?.canonicalProductId === 'government:india-post:nsc'
      || fact?.source?.instrumentId === 'nsc';
    if (!isNsc) return false;
    if (fact.schemaVersion !== MARKET_DATA_SCHEMA_VERSION
        || fact.kind !== FACT_KINDS.SCHEME_INTEREST_RATE
        || fact.canonicalProductId !== 'government:india-post:nsc'
        || fact.availabilityStatus !== AVAILABILITY.AVAILABLE
        || fact.source?.provider !== PROVIDERS.GOVERNMENT_OF_INDIA
        || fact.source?.instrumentId !== 'nsc'
        || fact.source?.url !== INDIA_POST_SAVINGS_URL
        || fact.unit !== 'PERCENT_PER_ANNUM'
        || fact.dataClass !== GOVERNMENT_RATE_DATA_CLASS
        || fact.rateBasis !== 'OFFICIAL_NOMINAL_RATE_PER_ANNUM'
        || fact.freshness?.status !== FRESHNESS.FRESH
        || typeof fact.value !== 'number'
        || !Number.isFinite(fact.value)
        || fact.value <= 0) return false;
    const from = fact.effectiveFrom;
    const to = fact.effectiveTo;
    if (!isStrictCalendarDate(from) || !isStrictCalendarDate(to)) return false;
    return from <= resetDate && to >= resetDate;
  });
  // More than one matching reset-period NSC fact is ambiguous; never pick
  // whichever duplicate happens to appear first in a provider response.
  if (candidates.length !== 1) return null;
  return candidates[0];
}

export function deriveRbiFloatingRateSavingsBondSnapshot({
  rbiRule = null,
  rbiHtml = null,
  nscSnapshot,
  fetchedAt = new Date().toISOString(),
  now = new Date(),
  sourceUrl = RBI_FRSB_NOTIFICATION_URL,
} = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(nowDate.getTime())) {
    throw new TypeError('now must be a valid date.');
  }
  const fetchedDate = fetchedAt instanceof Date ? fetchedAt : new Date(fetchedAt);

  let rule = rbiRule;
  if (!rule && rbiHtml) {
    rule = parseRbiOperationalGuidelines(rbiHtml, { sourceUrl });
  }
  if (!rule) {
    throw new Error('RBI_RULE_UNAVAILABLE');
  }

  const qualifiedRbiRule = rule.ruleQualified === true
    && rule.instrumentName === 'Floating Rate Savings Bonds, 2020 (Taxable)'
    && rule.referenceRate === 'NSC'
    && rule.spreadBps === RBI_FRSB_SPREAD_BPS
    && rule.spreadPercent === RBI_FRSB_SPREAD_PERCENT
    && rule.sourceUrl === RBI_FRSB_NOTIFICATION_URL
    && rule.tenureMonths === 84
    && rule.couponResetFrequency === 'SEMI_ANNUAL'
    && rule.interestPaymentFrequency === 'SEMI_ANNUAL';
  if (!qualifiedRbiRule) throw new Error('RBI_SCHEMA_MISMATCH:unqualified_rule');

  const { resetDate, effectiveFrom, effectiveTo } = calculateFrsbResetPeriod(nowDate);

  const nscFacts = Array.isArray(nscSnapshot?.facts)
    ? nscSnapshot.facts
    : (Array.isArray(nscSnapshot) ? nscSnapshot : []);
  const nscSnapshotQualified = Array.isArray(nscSnapshot?.facts)
    && nscSnapshot.schemaVersion === MARKET_DATA_SCHEMA_VERSION
    && nscSnapshot.provider === PROVIDERS.GOVERNMENT_OF_INDIA
    && [AVAILABILITY.AVAILABLE, AVAILABILITY.PARTIAL].includes(nscSnapshot.status)
    && nscSnapshot.qualification === 'OFFICIAL_INDIA_POST_PUBLIC_RATE_TABLE_SCHEMA_VALIDATED'
    && nscSnapshot.dataClass === GOVERNMENT_RATE_DATA_CLASS;
  const nscFact = nscSnapshotQualified ? findNscResetRateFact(nscFacts, resetDate) : null;

  if (!nscFact || !Number.isFinite(Number(nscFact.value))) {
    return {
      schemaVersion: MARKET_DATA_SCHEMA_VERSION,
      provider: PROVIDERS.RBI,
      status: AVAILABILITY.UNAVAILABLE,
      dataClass: RBI_RATE_DATA_CLASS,
      effectiveFrom,
      effectiveTo,
      resetDate,
      fetchedAt: fetchedDate.toISOString(),
      productCount: 0,
      availableFactCount: 0,
      products: [],
      facts: [],
      error: {
        code: 'FRSB_REFERENCE_NSC_RESET_RATE_UNAVAILABLE',
        message: `Official NSC reference rate for FRSB reset date ${resetDate} was not found or is unavailable.`,
      },
    };
  }

  const nscValue = Number(nscFact.value);
  const spreadPercent = RBI_FRSB_SPREAD_PERCENT;
  const couponValue = Number((nscValue + spreadPercent).toFixed(4));
  const canonicalProductId = RBI_FRSB_CANONICAL_PRODUCT_ID;

  const intervalStart = new Date(`${effectiveFrom}T00:00:00.000+05:30`);
  const intervalEnd = new Date(`${effectiveTo}T23:59:59.999+05:30`);
  const freshnessStatus = nowDate >= intervalStart && nowDate <= intervalEnd
    ? FRESHNESS.FRESH
    : FRESHNESS.STALE;

  const fact = createMarketFact({
    kind: FACT_KINDS.SCHEME_INTEREST_RATE,
    canonicalProductId,
    sourceProvider: PROVIDERS.RBI,
    sourceInstrumentId: 'frsb-2020-taxable',
    sourceUrl: rule.sourceUrl || sourceUrl,
    value: couponValue,
    unit: 'PERCENT_PER_ANNUM',
    observedAt: `${resetDate}T00:00:00.000Z`,
    providerTimestamp: `${resetDate}T00:00:00.000Z`,
    fetchedAt: fetchedDate.toISOString(),
    effectiveFrom,
    effectiveTo,
    dataClass: RBI_RATE_DATA_CLASS,
    maxAgeSeconds: 0,
    now: nowDate,
  });

  fact.freshness = {
    status: freshnessStatus,
    ageSeconds: Math.max(0, Math.floor((nowDate - intervalStart) / 1000)),
    maxAgeSeconds: Math.floor((intervalEnd - intervalStart) / 1000),
  };
  fact.rateBasis = 'NSC_REFERENCE_RATE_PLUS_35_BPS';
  fact.referenceRate = 'NSC';
  fact.referenceRateValue = nscValue;
  fact.spreadBps = rule.spreadBps;
  fact.referenceSource = nscFact.source?.url || null;
  fact.referenceRateFact = {
    canonicalProductId: nscFact.canonicalProductId,
    kind: nscFact.kind,
    availabilityStatus: nscFact.availabilityStatus,
    source: { ...nscFact.source },
    value: nscFact.value,
    unit: nscFact.unit,
    rateBasis: nscFact.rateBasis,
    dataClass: nscFact.dataClass,
    observedAt: nscFact.observedAt,
    fetchedAt: nscFact.fetchedAt,
    effectiveFrom: nscFact.effectiveFrom,
    effectiveTo: nscFact.effectiveTo,
    freshness: { ...nscFact.freshness },
  };
  fact.resetDate = resetDate;

  const product = {
    schemaVersion: MARKET_DATA_SCHEMA_VERSION,
    canonicalProductId,
    productType: 'GOVERNMENT_BOND',
    name: rule.instrumentName || 'Floating Rate Savings Bonds, 2020 (Taxable)',
    providerName: 'Government of India / Reserve Bank of India',
    externalIds: [
      { source: 'RBI_SCHEME_CODE', value: 'frsb-2020-taxable' },
      { source: 'GOI_NOTIFICATION', value: 'F.No.4(10)-B(W&M)/2020' },
    ],
    source: { provider: PROVIDERS.RBI, url: rule.sourceUrl || sourceUrl },
    sourceUpdatedAt: `${resetDate}T00:00:00.000Z`,
    tenureMonths: rule.tenureMonths ?? 84,
    couponResetFrequency: rule.couponResetFrequency ?? 'SEMI_ANNUAL',
    interestPaymentFrequency: rule.interestPaymentFrequency ?? 'SEMI_ANNUAL',
    referenceRate: 'NSC',
    spreadBps: rule.spreadBps ?? 35,
  };

  return {
    schemaVersion: MARKET_DATA_SCHEMA_VERSION,
    provider: PROVIDERS.RBI,
    status: AVAILABILITY.AVAILABLE,
    qualification: 'OFFICIAL_RBI_FRSB_RULE_AND_NSC_REFERENCE_VALIDATED',
    dataClass: RBI_RATE_DATA_CLASS,
    effectiveFrom,
    effectiveTo,
    resetDate,
    fetchedAt: fetchedDate.toISOString(),
    productCount: 1,
    availableFactCount: 1,
    products: [product],
    facts: [fact],
  };
}

export default class RbiFloatingRateSavingsBondProvider extends MarketDataProvider {
  constructor(options = {}) {
    super({ providerName: PROVIDERS.RBI, ...options });
    this.governmentSavingsProvider = options.governmentSavingsProvider || null;
    this.getGovernmentSnapshot = options.getGovernmentSnapshot || null;
  }

  async getSnapshot({ forceRefresh = false, nscSnapshot = null } = {}) {
    return readThroughMarketCache({
      cacheKey: rbiFrsbCacheKeyAt(this.clock()),
      ttlSeconds: RBI_FRSB_CACHE_TTL_SECONDS,
      forceRefresh,
      loader: async () => {
        const fetchedAt = this.nowIso();
        const now = this.clock();
        try {
          const rbiResponse = await this.httpClient.get(RBI_FRSB_NOTIFICATION_URL, {
            timeout: 20_000,
            responseType: 'text',
            headers: {
              Accept: 'text/html',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) WealthGenie/1.0',
            },
          });
          const rbiRule = parseRbiOperationalGuidelines(rbiResponse.data, {
            sourceUrl: RBI_FRSB_NOTIFICATION_URL,
          });

          let resolvedNscSnapshot = nscSnapshot;
          if (!resolvedNscSnapshot) {
            if (typeof this.getGovernmentSnapshot === 'function') {
              resolvedNscSnapshot = await this.getGovernmentSnapshot({ forceRefresh });
            } else if (this.governmentSavingsProvider) {
              resolvedNscSnapshot = await this.governmentSavingsProvider.getSnapshot({ forceRefresh });
            } else {
              const defaultGovProvider = new GovernmentSmallSavingsProvider({
                httpClient: this.httpClient,
                clock: this.clock,
              });
              resolvedNscSnapshot = await defaultGovProvider.getSnapshot({ forceRefresh });
            }
          }

          return deriveRbiFloatingRateSavingsBondSnapshot({
            rbiRule,
            nscSnapshot: resolvedNscSnapshot,
            fetchedAt,
            now,
            sourceUrl: RBI_FRSB_NOTIFICATION_URL,
          });
        } catch (error) {
          const { effectiveFrom, effectiveTo } = calculateFrsbResetPeriod(now);
          return {
            schemaVersion: MARKET_DATA_SCHEMA_VERSION,
            provider: PROVIDERS.RBI,
            status: AVAILABILITY.SOURCE_ERROR,
            dataClass: RBI_RATE_DATA_CLASS,
            effectiveFrom,
            effectiveTo,
            fetchedAt,
            productCount: 0,
            availableFactCount: 0,
            products: [],
            facts: [],
            error: {
              code: error?.message?.startsWith('RBI_SCHEMA_MISMATCH') ? error.message : 'RBI_FRSB_FETCH_FAILED',
              message: error?.message || 'Official RBI FRSB request failed.',
            },
          };
        }
      },
    });
  }
}
