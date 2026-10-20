import {
  AVAILABILITY,
  FACT_KINDS,
  PROVIDERS,
} from './marketData/contracts.js';
import { AMFI_NAV_URL } from './marketData/AmfiNavProvider.js';
import { isQualifiedAmfiNavHistoryUrl } from './marketData/AmfiNavHistoryProvider.js';

export const NIFTY_ETF_RANKING_VERSION = 'wti-nifty-etf-1.0.0';
export const NIFTY_ETF_PARENT_ID = 'nifty_etf';

const IDENTITY_EVIDENCE = Object.freeze({
  authority: 'National Stock Exchange of India',
  title: 'Nippon India Mutual Fund scheme information filed with NSE, 20 March 2026',
  url: 'https://nsearchives.nseindia.com/trading_security/mf/pdf/Nippon_20032026171200_NipponMutualFund.pdf',
});
const LISTING_EVIDENCE = Object.freeze({
  authority: 'NSE Clearing Limited',
  title: 'Revised list of Cross Margin Eligible Exchange Traded Funds, effective 27 May 2026',
  url: 'https://nsearchives.nseindia.com/content/circulars/CMPT74390.pdf',
});
const BENCHMARK_EVIDENCE = Object.freeze({
  authority: 'Nippon India Mutual Fund',
  title: 'Nippon India ETF Nifty 50 BeES — February 2026 product note, benchmark Nifty 50 TRI',
  url: 'https://mf.nipponindiaim.com/FundsAndPerformance/ProductNotes/NipponIndia-ETF-Nifty-50-BeES-Feb-2026.pdf',
});

// This is an identity/evidence allowlist only. It intentionally contains no
// NAV, exchange price, return, risk, liquidity, expense, or tax values.
const QUALIFIED_ETF_IDENTITIES = Object.freeze({
  [NIFTY_ETF_PARENT_ID]: Object.freeze([Object.freeze({
    canonicalProductId: 'etf:isin:INF204KB14I2',
    amfiSchemeCode: '140084',
    isin: 'INF204KB14I2',
    exchange: 'NSE',
    ticker: 'NIFTYBEES',
    benchmark: Object.freeze({ id: 'NIFTY_50', name: 'NIFTY 50', returnVariant: 'NIFTY 50 TRI' }),
    identityEvidence: IDENTITY_EVIDENCE,
    listingEvidence: LISTING_EVIDENCE,
    benchmarkEvidence: BENCHMARK_EVIDENCE,
  })]),
});

export const QUALIFIED_NIFTY_ETF_IDENTITY = QUALIFIED_ETF_IDENTITIES[NIFTY_ETF_PARENT_ID][0];

const ETF_CATEGORY_KEY = 'open ended schemes(other scheme - other etfs)';
const AMFI_CANONICAL_ID = code => `mf:amfi:${code}`;

function normalizedCategory(value) {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().toLowerCase().replace(/\s*\(\s*/g, '(').replace(/\s*\)\s*/g, ')')
    : null;
}

function externalIdMatches(product, source, value) {
  return Array.isArray(product?.externalIds)
    && product.externalIds.some(item => item?.source === source && String(item.value) === value);
}

function isTrustedOfficialEvidence(source, host, expectedUrl) {
  try {
    const url = new URL(source?.url);
    return url.protocol === 'https:'
      && url.hostname === host
      && (!expectedUrl || url.href === expectedUrl);
  } catch {
    return false;
  }
}

export function isQualifiedNiftyEtfIdentity(identity) {
  return identity?.canonicalProductId === 'etf:isin:INF204KB14I2'
    && identity?.amfiSchemeCode === '140084'
    && identity?.isin === 'INF204KB14I2'
    && identity?.exchange === 'NSE'
    && identity?.ticker === 'NIFTYBEES'
    && identity?.benchmark?.id === 'NIFTY_50'
    && identity?.benchmark?.name === 'NIFTY 50'
    && identity?.benchmark?.returnVariant === 'NIFTY 50 TRI'
    && isTrustedOfficialEvidence(identity.identityEvidence, 'nsearchives.nseindia.com', IDENTITY_EVIDENCE.url)
    && isTrustedOfficialEvidence(identity.listingEvidence, 'nsearchives.nseindia.com', LISTING_EVIDENCE.url)
    && isTrustedOfficialEvidence(identity.benchmarkEvidence, 'mf.nipponindiaim.com', BENCHMARK_EVIDENCE.url);
}

export function supportsQualifiedEtfParentCategory(parentInstrumentId) {
  return Object.hasOwn(QUALIFIED_ETF_IDENTITIES, parentInstrumentId)
    && QUALIFIED_ETF_IDENTITIES[parentInstrumentId].every(isQualifiedNiftyEtfIdentity);
}

function validSnapshotFact(snapshot, canonicalProductId, { historical = false } = {}) {
  const matchingFacts = (snapshot?.facts || []).filter(candidate => candidate?.canonicalProductId === canonicalProductId);
  if (matchingFacts.length !== 1) return null;
  const [fact] = matchingFacts;
  const observedAt = Date.parse(fact?.observedAt);
  const fetchedAt = Date.parse(fact?.fetchedAt);
  if (snapshot?.provider !== PROVIDERS.AMFI
      || ![AVAILABILITY.AVAILABLE, AVAILABILITY.PARTIAL].includes(snapshot?.status)
      || fact?.kind !== FACT_KINDS.MUTUAL_FUND_NAV
      || fact?.source?.provider !== PROVIDERS.AMFI
      || fact?.source?.instrumentId !== '140084'
      || fact?.currency !== 'INR'
      || fact?.unit !== 'NAV_PER_UNIT'
      || !isTrustedOfficialEvidence(fact.source, 'portal.amfiindia.com')
      || !(historical
        ? isQualifiedAmfiNavHistoryUrl(fact.source.url, snapshot?.targetDate)
        : fact.source.url === AMFI_NAV_URL)
      || fact.availabilityStatus !== AVAILABILITY.AVAILABLE
      || !Number.isFinite(Number(fact.value))
      || Number(fact.value) <= 0
      || !Number.isFinite(observedAt)
      || !Number.isFinite(fetchedAt)
      || observedAt > fetchedAt + 60_000) return null;
  if (!historical && fact.freshness?.status !== 'FRESH') return null;
  if (historical && fact.historicalContext?.targetDate !== snapshot?.targetDate) return null;
  return fact;
}

function historicalNavReturn(currentFact, historicalFact) {
  const start = Date.parse(historicalFact?.observedAt);
  const end = Date.parse(currentFact?.observedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const elapsedDays = (end - start) / 86_400_000;
  if (elapsedDays < 330 || elapsedDays > 400) return null;
  const startNav = Number(historicalFact.value);
  const endNav = Number(currentFact.value);
  if (!Number.isFinite(startNav) || startNav <= 0 || !Number.isFinite(endNav) || endNav <= 0) return null;
  const valuePct = (Math.pow(endNav / startNav, 365 / elapsedDays) - 1) * 100;
  if (!Number.isFinite(valuePct)) return null;
  return {
    valuePct: Number(valuePct.toFixed(6)),
    basis: 'HISTORICAL_POINT_TO_POINT_NAV_RETURN_1Y',
    annualized: true,
    startNav,
    startDate: historicalFact.observedAt.slice(0, 10),
    endNav,
    endDate: currentFact.observedAt.slice(0, 10),
    elapsedDays: Number(elapsedDays.toFixed(2)),
    source: {
      provider: PROVIDERS.AMFI,
      startInstrumentId: historicalFact.source.instrumentId,
      endInstrumentId: currentFact.source.instrumentId,
      startObservationUrl: historicalFact.source.url,
      endObservationUrl: currentFact.source.url,
      historyTargetDate: historicalFact.historicalContext.targetDate,
    },
    isExpectedReturn: false,
  };
}

function unavailable(reasonCode) {
  return {
    products: [],
    ranking: {
      version: NIFTY_ETF_RANKING_VERSION,
      status: 'UNAVAILABLE',
      authority: 'NONE',
      method: null,
      hasUniqueLeader: false,
      reasonCodes: [reasonCode],
      warning: 'No exact Nifty 50 ETF option is shown without matching official scheme identity, benchmark evidence, and a fresh source-qualified NAV.',
    },
    comparisonUniverse: {
      parentInstrumentId: NIFTY_ETF_PARENT_ID,
      sourceProvider: PROVIDERS.AMFI,
      verifiedIdentityCount: 0,
      freshNavProductCount: 0,
      returnedProductCount: 0,
      disclosure: 'The exact ETF identity or its current AMFI NAV could not be verified; no catalog value was substituted.',
    },
  };
}

export function rankQualifiedNiftyEtfProducts({
  parentInstrumentId,
  currentSnapshot,
  historicalSnapshot,
}) {
  if (!supportsQualifiedEtfParentCategory(parentInstrumentId)) return unavailable('ETF_PARENT_OR_BENCHMARK_NOT_QUALIFIED');
  const identities = QUALIFIED_ETF_IDENTITIES[parentInstrumentId];
  const verified = identities.flatMap(identity => {
    const amfiProductId = AMFI_CANONICAL_ID(identity.amfiSchemeCode);
    const matchingProducts = (currentSnapshot?.products || []).filter(candidate => candidate?.canonicalProductId === amfiProductId);
    if (matchingProducts.length !== 1) return [];
    const [product] = matchingProducts;
    const identityMatches = (
      product?.productType === 'MUTUAL_FUND'
      && product?.source?.provider === PROVIDERS.AMFI
      && product?.source?.url === AMFI_NAV_URL
      && normalizedCategory(product.schemeCategory) === ETF_CATEGORY_KEY
      && externalIdMatches(product, 'AMFI_SCHEME_CODE', identity.amfiSchemeCode)
      && externalIdMatches(product, 'ISIN', identity.isin)
    );
    const currentFact = validSnapshotFact(currentSnapshot, amfiProductId);
    if (!identityMatches || !currentFact) return [];

    const historyFact = validSnapshotFact(historicalSnapshot, amfiProductId, { historical: true });
    const historicalReturn = historyFact ? historicalNavReturn(currentFact, historyFact) : null;
    return [{
      id: identity.canonicalProductId,
      canonicalProductId: identity.canonicalProductId,
      parentInstrumentId,
      productType: 'ETF',
      presentationStatus: 'VERIFIED_COMPARABLE_OPTION',
      rank: null,
      tiedRank: false,
      name: product.name,
      provider: product.providerName ?? null,
      exchange: identity.exchange,
      ticker: identity.ticker,
      isin: identity.isin,
      externalIds: [
        { source: 'AMFI_SCHEME_CODE', value: identity.amfiSchemeCode },
        { source: 'ISIN', value: identity.isin },
        { source: 'NSE_TRADING_SYMBOL', value: identity.ticker },
      ],
      benchmark: {
        ...identity.benchmark,
        canonicalProductId: 'market:index:nifty-50',
        source: identity.benchmarkEvidence,
      },
      identityEvidence: [identity.identityEvidence, identity.listingEvidence],
      source: {
        provider: PROVIDERS.AMFI,
        instrumentId: identity.amfiSchemeCode,
        url: currentFact.source.url,
      },
      availabilityStatus: AVAILABILITY.AVAILABLE,
      freshness: currentFact.freshness,
      marketPrice: {
        value: null,
        currency: 'INR',
        unit: 'PRICE_PER_UNIT',
        observedAt: null,
        availabilityStatus: AVAILABILITY.UNAVAILABLE,
        unavailableReason: 'NO_QUALIFIED_EXCHANGE_PRICE_OBSERVATION',
        source: null,
      },
      nav: {
        value: Number(currentFact.value),
        currency: currentFact.currency,
        unit: currentFact.unit,
        observedAt: currentFact.observedAt,
        fetchedAt: currentFact.fetchedAt,
        source: currentFact.source,
      },
      primaryFact: {
        kind: currentFact.kind,
        canonicalProductId: currentFact.canonicalProductId,
        value: Number(currentFact.value),
        currency: currentFact.currency,
        unit: currentFact.unit,
        observedAt: currentFact.observedAt,
        fetchedAt: currentFact.fetchedAt,
        availabilityStatus: currentFact.availabilityStatus,
        freshness: currentFact.freshness,
        source: currentFact.source,
      },
      valuationDate: currentFact.observedAt.slice(0, 10),
      historicalReturn,
      returnBasis: historicalReturn?.basis ?? null,
      expectedReturn: null,
      nominalReturn: null,
      postTaxReturn: null,
      expenseRatio: null,
      trackingError: null,
      trackingDifference: null,
      liquidityEvidence: null,
      riskEvidence: null,
      productTaxClassification: null,
      productEligibility: {
        eligible: null,
        status: 'PARENT_SUITABILITY_PASSED_PRODUCT_ACCESS_FACTS_UNAVAILABLE',
        scope: 'PARENT_HARD_SUITABILITY_AND_PRODUCT_IDENTITY_ONLY',
        reasonCodes: ['PARENT_HARD_SUITABILITY_PASSED', 'EXACT_ISIN_AND_AMFI_SCHEME_MATCH', 'OFFICIAL_NIFTY_50_BENCHMARK_EVIDENCE', 'CURRENT_FRESH_AMFI_NAV', 'PRODUCT_ACCESS_REQUIREMENTS_NOT_VERIFIED'],
      },
      rankingReasonCodes: ['SINGLE_QUALIFIED_OPTION_NO_MERIT_ORDER_CLAIMED'],
    }];
  });
  if (verified.length === 0) return unavailable('EXACT_ETF_IDENTITY_OR_FRESH_NAV_UNAVAILABLE');
  return {
    products: verified,
    ranking: {
      version: NIFTY_ETF_RANKING_VERSION,
      status: 'VERIFIED_COMPARABLE_OPTIONS',
      authority: 'OFFICIAL_SCHEME_IDENTITY_AND_AMFI_CURRENT_NAV',
      method: null,
      hasUniqueLeader: false,
      reasonCodes: ['EXACT_ETF_IDENTITY_VERIFIED', 'NIFTY_50_BENCHMARK_VERIFIED', 'CURRENT_AMFI_NAV_VERIFIED', 'DISPLAY_IS_NOT_A_MERIT_RANKING'],
      warning: 'One exact ETF option is available. It is not ranked against a broader ETF universe; historical NAV performance, when present, is not a forecast.',
    },
    comparisonUniverse: {
      parentInstrumentId,
      sourceProvider: PROVIDERS.AMFI,
      identitySource: 'NSE_SCHEME_DISCLOSURE_AND_NSE_LISTING',
      benchmarkSource: 'ISSUER_SCHEME_INVESTMENT_PHILOSOPHY',
      verifiedIdentityCount: verified.length,
      freshNavProductCount: verified.length,
      returnedProductCount: verified.length,
      currentSnapshotStatus: currentSnapshot?.status ?? AVAILABILITY.UNAVAILABLE,
      currentSnapshotFetchedAt: currentSnapshot?.fetchedAt ?? null,
      historicalSnapshotStatus: historicalSnapshot?.status ?? AVAILABILITY.UNAVAILABLE,
      historicalSnapshotFetchedAt: historicalSnapshot?.fetchedAt ?? null,
      disclosure: 'This is one exact, source-qualified ETF option and not a comparative ranking. NAV is reported separately from exchange market price; unavailable product facts remain unavailable.',
    },
  };
}
