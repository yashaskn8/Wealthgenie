import { AVAILABILITY, FACT_KINDS, FRESHNESS, MARKET_DATA_SCHEMA_VERSION, PROVIDERS } from './marketData/contracts.js';
import { GOVERNMENT_RATE_DATA_CLASS, INDIA_POST_SAVINGS_URL } from './marketData/GovernmentSmallSavingsProvider.js';
import {
  calculateFrsbResetPeriod,
  RBI_FRSB_NOTIFICATION_URL,
  RBI_RATE_DATA_CLASS,
} from './marketData/RbiFloatingRateSavingsBondProvider.js';
import { SBI_RATE_DATA_CLASS, SBI_TERM_DEPOSIT_URL } from './marketData/SbiTermDepositProvider.js';

export const FIXED_INCOME_RANKING_VERSION = 'wti-fixed-income-comparison-1.0.0';

const GOVERNMENT_PARENT_SCHEMES = Object.freeze({
  ppf: 'ppf',
  scss: 'scss',
  sukanya: 'sukanya',
  nsc: 'nsc',
  kvp: 'kvp',
  pomis: 'pomis',
  po_rd: 'post-office-rd-5y',
  po_td_1yr: 'post-office-td-1y',
});

const SBI_PARENT_IDS = new Set(['fd', 'sbi_fd']);
const RBI_PARENT_IDS = new Set(['rbi_bonds']);
const INDIA_POST_FETCH_AGE_TOLERANCE_SECONDS = 21 * 20 + 120;

export function fixedIncomeProviderForParent(parentInstrumentId) {
  if (Object.hasOwn(GOVERNMENT_PARENT_SCHEMES, parentInstrumentId)) return PROVIDERS.GOVERNMENT_OF_INDIA;
  if (SBI_PARENT_IDS.has(parentInstrumentId)) return PROVIDERS.SBI;
  if (RBI_PARENT_IDS.has(parentInstrumentId)) return PROVIDERS.RBI;
  return null;
}

export function supportsFixedIncomeParentCategory(parentInstrumentId) {
  return fixedIncomeProviderForParent(parentInstrumentId) !== null;
}

function unavailable(reasonCodes, provider, disclosure) {
  return {
    products: [],
    ranking: {
      version: FIXED_INCOME_RANKING_VERSION,
      status: 'UNAVAILABLE',
      provider,
      reasonCodes,
      arbitraryWeightedScoreUsed: false,
      forcedResultCount: false,
    },
    comparisonUniverse: {
      dataClass: 'UNAVAILABLE',
      provider,
      eligibleProductCount: 0,
      disclosure,
    },
  };
}

function commonProductDto(product, fact, parentInstrumentId) {
  return {
    id: product.canonicalProductId,
    canonicalProductId: product.canonicalProductId,
    parentInstrumentId,
    productType: product.productType,
    presentationStatus: 'VERIFIED_COMPARABLE_OPTION',
    rank: null,
    tiedRank: false,
    name: product.name,
    provider: product.providerName,
    source: fact.source,
    officialRate: {
      value: fact.value,
      unit: fact.unit,
      basis: fact.rateBasis,
      effectiveFrom: fact.effectiveFrom,
      effectiveTo: fact.effectiveTo,
      publicationDate: fact.publicationDate,
      observedAt: fact.observedAt,
      fetchedAt: fact.fetchedAt,
      dataClass: fact.dataClass,
    },
    valuationDate: null,
    freshness: fact.freshness,
    availabilityStatus: fact.availabilityStatus,
    productEligibility: {
      eligible: true,
      status: 'PARENT_SUITABILITY_PASSED',
      scope: 'PARENT_HARD_SUITABILITY_ONLY',
      reasonCodes: ['PARENT_HARD_SUITABILITY_PASSED'],
      productSpecificTermsStatus: 'UNAVAILABLE_NOT_SOURCE_QUALIFIED_IN_PHASE_5',
    },
    rankingReasonCodes: [
      'OFFICIAL_SOURCE_FACT_VERIFIED',
      'NO_CROSS_TENURE_OR_CROSS_PRODUCT_MERIT_RANKING',
      'VERIFIED_COMPARABLE_OPTION_ONLY',
    ],
    nav: null,
    historicalReturn: null,
    expectedReturn: null,
    nominalReturn: null,
    effectiveYield: null,
    postTaxReturn: null,
    taxClassification: null,
    expenseRatio: null,
    aum: null,
    riskLevel: null,
    riskScore: null,
    benchmark: null,
    trackingError: null,
    minimumInvestment: null,
    minInvestment: null,
    platform: null,
    score: null,
    plan: null,
    option: null,
  };
}

function indiaDateAt(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const fields = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

function isStrictCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function hasQualifiedIndiaPostReferenceFreshness(referenceFact, now) {
  const effectiveFrom = referenceFact?.effectiveFrom;
  const effectiveTo = referenceFact?.effectiveTo;
  const freshness = referenceFact?.freshness;
  if (!isStrictCalendarDate(effectiveFrom) || !isStrictCalendarDate(effectiveTo)) return false;

  const intervalStart = Date.parse(`${effectiveFrom}T00:00:00.000+05:30`);
  const intervalEnd = Date.parse(`${effectiveTo}T23:59:59.999+05:30`);
  const fetchedAt = Date.parse(referenceFact?.fetchedAt);
  const nowMs = now.getTime();
  if (!Number.isFinite(intervalStart) || !Number.isFinite(intervalEnd)
      || !Number.isFinite(fetchedAt) || !Number.isFinite(nowMs)
      || intervalEnd < intervalStart
      || fetchedAt < intervalStart || fetchedAt > intervalEnd || fetchedAt > nowMs) return false;

  // India Post timestamps the fetch before reading its page and up to 20
  // same-origin script chunks. Match captured age to that bounded fetch window,
  // while allowing the original quarter's reset-date evidence to be reused
  // throughout the FRSB coupon period.
  const expectedMaxAgeSeconds = Math.floor((intervalEnd - intervalStart) / 1000);
  const expectedAgeAtFetch = Math.floor((fetchedAt - intervalStart) / 1000);
  return freshness?.status === FRESHNESS.FRESH
    && freshness.maxAgeSeconds === expectedMaxAgeSeconds
    && Number.isFinite(freshness.ageSeconds)
    && freshness.ageSeconds >= 0
    && Math.abs(freshness.ageSeconds - expectedAgeAtFetch) <= INDIA_POST_FETCH_AGE_TOLERANCE_SECONDS;
}

function isUsableFact(fact, now) {
  const today = indiaDateAt(now);
  const effectiveFrom = fact?.effectiveFrom ?? null;
  const effectiveTo = fact?.effectiveTo ?? null;
  const hasValidEffectivePeriod = (!effectiveFrom || isStrictCalendarDate(effectiveFrom))
    && (!effectiveTo || isStrictCalendarDate(effectiveTo))
    && (!effectiveFrom || !effectiveTo || effectiveFrom <= effectiveTo);
  return fact?.availabilityStatus === AVAILABILITY.AVAILABLE
    && fact?.freshness?.status === FRESHNESS.FRESH
    && typeof fact.value === 'number'
    && Number.isFinite(fact.value)
    && fact.value > 0
    && today !== null
    && hasValidEffectivePeriod
    && (!effectiveFrom || today >= effectiveFrom)
    && (!effectiveTo || today <= effectiveTo);
}

function hasQualifiedFact(fact, {
  canonicalProductId,
  provider,
  sourceInstrumentId,
  sourceUrl,
  dataClass,
  rateBasis,
  kind = FACT_KINDS.SCHEME_INTEREST_RATE,
}) {
  return fact?.schemaVersion === MARKET_DATA_SCHEMA_VERSION
    && fact.kind === kind
    && fact.canonicalProductId === canonicalProductId
    && fact.source?.provider === provider
    && fact.source?.instrumentId === sourceInstrumentId
    && fact.source?.url === sourceUrl
    && fact.unit === 'PERCENT_PER_ANNUM'
    && fact.dataClass === dataClass
    && fact.rateBasis === rateBasis;
}

function hasQualifiedProduct(product, { canonicalProductId, provider, productType, sourceUrl }) {
  return product?.schemaVersion === MARKET_DATA_SCHEMA_VERSION
    && product.canonicalProductId === canonicalProductId
    && product.productType === productType
    && product.source?.provider === provider
    && product.source?.url === sourceUrl;
}

const SBI_TENURE_CONTRACTS = Object.freeze({
  '7d-45d': { minDays: 7, maxDaysExclusive: 46, label: '7 days to 45 days' },
  '46d-179d': { minDays: 46, maxDaysExclusive: 180, label: '46 days to 179 days' },
  '180d-210d': { minDays: 180, maxDaysExclusive: 211, label: '180 days to 210 days' },
  '211d-lt1y': { minDays: 211, maxDaysExclusive: 365, label: '211 days to less than 1 year' },
  '1y-lt2y': { minDays: 365, maxDaysExclusive: 730, label: '1 year to less than 2 years' },
  '2y-lt3y': { minDays: 730, maxDaysExclusive: 1095, label: '2 years to less than 3 years' },
  '3y-lt5y': { minDays: 1095, maxDaysExclusive: 1825, label: '3 years to less than 5 years' },
  '5y-10y': { minDays: 1825, maxDaysExclusive: 3651, label: '5 years and up to 10 years' },
});

function normalizedTenureLabel(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function selectCurrentEffectiveFact(facts, canonicalProductId, now = new Date()) {
  if (!Array.isArray(facts)) return null;
  const currentFacts = facts
    .filter(fact => fact.canonicalProductId === canonicalProductId && isUsableFact(fact, now))
  // Cached snapshots can outlive a parser contract. Two simultaneously
  // effective facts for one canonical product are ambiguous, even if one is
  // newer or the two values happen to match.
  return currentFacts.length === 1 ? currentFacts[0] : null;
}

function selectGovernmentProduct(parentInstrumentId, snapshot, now) {
  const schemeId = GOVERNMENT_PARENT_SCHEMES[parentInstrumentId];
  const canonicalId = `government:india-post:${schemeId}`;
  const matchingProducts = Array.isArray(snapshot?.products)
    ? snapshot.products.filter(item => item.canonicalProductId === canonicalId)
    : [];
  const product = matchingProducts.length === 1 ? matchingProducts[0] : null;
  const fact = selectCurrentEffectiveFact(snapshot?.facts, canonicalId, now);
  const productValid = hasQualifiedProduct(product, {
    canonicalProductId: canonicalId,
    provider: PROVIDERS.GOVERNMENT_OF_INDIA,
    productType: 'GOVERNMENT_SCHEME',
    sourceUrl: INDIA_POST_SAVINGS_URL,
  }) && product.externalIds?.some(item => item.source === 'INDIA_POST_SCHEME_ID' && item.value === schemeId);
  const factValid = isUsableFact(fact, now) && hasQualifiedFact(fact, {
    canonicalProductId: canonicalId,
    provider: PROVIDERS.GOVERNMENT_OF_INDIA,
    sourceInstrumentId: schemeId,
    sourceUrl: INDIA_POST_SAVINGS_URL,
    dataClass: GOVERNMENT_RATE_DATA_CLASS,
    rateBasis: 'OFFICIAL_NOMINAL_RATE_PER_ANNUM',
  });
  return productValid && factValid ? { product, fact } : null;
}

function selectComparableSbiProduct(profile, snapshot, now) {
  const horizonDays = Number(profile?.investmentHorizonYears) * 365;
  const depositorType = Number(profile?.age) >= 60 ? 'SENIOR_CITIZEN' : 'GENERAL_PUBLIC';
  if (!Number.isFinite(horizonDays) || horizonDays <= 0) return null;
  const matchingProducts = (Array.isArray(snapshot?.products) ? snapshot.products : []).filter(item => (
    item.depositorType === depositorType
      && Number(item.tenureMinDays) <= horizonDays
      && horizonDays < Number(item.tenureMaxDaysExclusive)
  ));
  const product = matchingProducts.length === 1 ? matchingProducts[0] : null;
  const fact = product ? selectCurrentEffectiveFact(snapshot?.facts, product.canonicalProductId, now) : null;
  const canonicalProductId = product?.canonicalProductId;
  const idMatch = typeof canonicalProductId === 'string'
    && /^deposit:sbi:retail-domestic:[a-z0-9-]+:(?:public|senior)$/.test(canonicalProductId);
  const depositorSlug = product?.depositorType === 'SENIOR_CITIZEN' ? 'senior' : 'public';
  const tenureId = idMatch ? canonicalProductId.match(/^deposit:sbi:retail-domestic:([a-z0-9-]+):/)[1] : null;
  const tenureContract = tenureId ? SBI_TENURE_CONTRACTS[tenureId] : null;
  const expectedInstrumentId = tenureId ? `retail-domestic:${tenureId}:${depositorSlug}` : null;
  const productValid = idMatch
    && Boolean(tenureContract)
    && product.schemaVersion === MARKET_DATA_SCHEMA_VERSION
    && product.productType === 'BANK_TERM_DEPOSIT'
    && product.providerName === 'State Bank of India'
    && product.source?.provider === PROVIDERS.SBI
    && product.source?.url === SBI_TERM_DEPOSIT_URL
    && product.externalIds?.some(item => item.source === 'SBI_TENURE_CLASS' && item.value === tenureId)
    && Number(product.tenureMinDays) === tenureContract.minDays
    && Number(product.tenureMaxDaysExclusive) === tenureContract.maxDaysExclusive
    && normalizedTenureLabel(product.tenureLabel) === tenureContract.label
    && product.depositType === 'RETAIL_DOMESTIC_TERM_DEPOSIT_BELOW_INR_3_CRORE'
    && product.callability === 'CALLABLE_STANDARD_CARD_RATE';
  const factValid = isUsableFact(fact, now) && hasQualifiedFact(fact, {
    canonicalProductId,
    provider: PROVIDERS.SBI,
    sourceInstrumentId: expectedInstrumentId,
    sourceUrl: SBI_TERM_DEPOSIT_URL,
    dataClass: SBI_RATE_DATA_CLASS,
    rateBasis: 'OFFICIAL_NOMINAL_CARD_RATE_PER_ANNUM',
    kind: FACT_KINDS.TERM_DEPOSIT_RATE,
  });
  return productValid && factValid ? { product, fact } : null;
}

function selectRbiProduct(snapshot, now) {
  const canonicalId = 'government:rbi:frsb-2020-taxable';
  const matchingProducts = Array.isArray(snapshot?.products)
    ? snapshot.products.filter(item => item.canonicalProductId === canonicalId)
    : [];
  const product = matchingProducts.length === 1 ? matchingProducts[0] : null;
  const fact = selectCurrentEffectiveFact(snapshot?.facts, canonicalId, now);
  const expectedReset = calculateFrsbResetPeriod(now);
  const referenceFact = fact?.referenceRateFact;
  const referenceFreshness = referenceFact?.freshness;
  const referenceObservedAt = Date.parse(referenceFact?.observedAt);
  const referenceFetchedAt = Date.parse(referenceFact?.fetchedAt);
  const qualifiedNscReference = referenceFact?.canonicalProductId === 'government:india-post:nsc'
    && referenceFact?.kind === FACT_KINDS.SCHEME_INTEREST_RATE
    && referenceFact?.availabilityStatus === AVAILABILITY.AVAILABLE
    && referenceFact?.source?.provider === PROVIDERS.GOVERNMENT_OF_INDIA
    && referenceFact?.source?.instrumentId === 'nsc'
    && referenceFact?.source?.url === INDIA_POST_SAVINGS_URL
    && typeof referenceFact?.value === 'number'
    && Number.isFinite(referenceFact.value) && referenceFact.value > 0
    && referenceFact?.unit === 'PERCENT_PER_ANNUM'
    && referenceFact?.rateBasis === 'OFFICIAL_NOMINAL_RATE_PER_ANNUM'
    && referenceFact?.dataClass === GOVERNMENT_RATE_DATA_CLASS
    && referenceFreshness?.status === FRESHNESS.FRESH
    && Number.isFinite(referenceFreshness.ageSeconds) && referenceFreshness.ageSeconds >= 0
    && Number.isFinite(referenceFreshness.maxAgeSeconds) && referenceFreshness.maxAgeSeconds > 0
    && hasQualifiedIndiaPostReferenceFreshness(referenceFact, now)
    && Number.isFinite(referenceObservedAt)
    && Number.isFinite(referenceFetchedAt)
    && referenceFact.observedAt === `${referenceFact.effectiveFrom}T00:00:00.000Z`
    && referenceFetchedAt >= referenceObservedAt
    && isStrictCalendarDate(referenceFact?.effectiveFrom)
    && isStrictCalendarDate(referenceFact?.effectiveTo)
    && referenceFact.effectiveFrom <= expectedReset.resetDate
    && referenceFact.effectiveTo >= expectedReset.resetDate;
  const productValid = hasQualifiedProduct(product, {
    canonicalProductId: canonicalId,
    provider: PROVIDERS.RBI,
    productType: 'GOVERNMENT_BOND',
    sourceUrl: RBI_FRSB_NOTIFICATION_URL,
  }) && product.providerName === 'Government of India / Reserve Bank of India'
    && product.tenureMonths === 84
    && product.couponResetFrequency === 'SEMI_ANNUAL'
    && product.interestPaymentFrequency === 'SEMI_ANNUAL'
    && product.referenceRate === 'NSC'
    && product.spreadBps === 35;
  const factValid = isUsableFact(fact, now) && hasQualifiedFact(fact, {
    canonicalProductId: canonicalId,
    provider: PROVIDERS.RBI,
    sourceInstrumentId: 'frsb-2020-taxable',
    sourceUrl: RBI_FRSB_NOTIFICATION_URL,
    dataClass: RBI_RATE_DATA_CLASS,
    rateBasis: 'NSC_REFERENCE_RATE_PLUS_35_BPS',
  }) && fact.kind === FACT_KINDS.SCHEME_INTEREST_RATE
    && fact.referenceRate === 'NSC'
    && fact.spreadBps === 35
    && typeof fact.referenceRateValue === 'number'
    && Number.isFinite(fact.referenceRateValue)
    && fact.referenceRateValue > 0
    && fact.referenceRateValue === referenceFact?.value
    && fact.resetDate === expectedReset.resetDate
    && fact.effectiveFrom === expectedReset.effectiveFrom
    && fact.effectiveTo === expectedReset.effectiveTo
    && fact.observedAt === `${expectedReset.resetDate}T00:00:00.000Z`
    && fact.value === Number((fact.referenceRateValue + 0.35).toFixed(4))
    && qualifiedNscReference;
  return productValid && factValid ? { product, fact } : null;
}

export function compareVerifiedFixedIncomeProducts({ parentInstrumentId, snapshot, profile, now = new Date() }) {
  const currentTime = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (!Number.isFinite(currentTime.getTime())) throw new TypeError('now must be a valid date.');
  const provider = fixedIncomeProviderForParent(parentInstrumentId);
  if (!provider) {
    return unavailable(
      ['FIXED_INCOME_PROVIDER_NOT_QUALIFIED'],
      null,
      'No official provider adapter is qualified for this fixed-income parent category.',
    );
  }
  if (![AVAILABILITY.AVAILABLE, AVAILABILITY.PARTIAL].includes(snapshot?.status)) {
    return unavailable(
      [snapshot?.error?.code || 'OFFICIAL_SOURCE_UNAVAILABLE'],
      provider,
      'The official source did not provide a usable current snapshot. No static rate was substituted.',
    );
  }
  if (snapshot?.schemaVersion !== MARKET_DATA_SCHEMA_VERSION || snapshot?.provider !== provider) {
    return unavailable(
      ['OFFICIAL_SOURCE_IDENTITY_MISMATCH'],
      provider,
      'The snapshot identity did not match the qualified provider contract. No source fact was presented.',
    );
  }

  let selected = null;
  if (provider === PROVIDERS.GOVERNMENT_OF_INDIA) {
    selected = selectGovernmentProduct(parentInstrumentId, snapshot, currentTime);
  } else if (provider === PROVIDERS.SBI) {
    selected = selectComparableSbiProduct(profile, snapshot, currentTime);
  } else if (provider === PROVIDERS.RBI) {
    selected = selectRbiProduct(snapshot, currentTime);
  }

  if (!selected) {
    let reason = 'CURRENT_EFFECTIVE_SCHEME_RATE_UNAVAILABLE';
    if (provider === PROVIDERS.SBI) {
      reason = 'NO_SAME_TENURE_AND_DEPOSITOR_CLASS_PRODUCT';
    } else if (provider === PROVIDERS.RBI) {
      reason = snapshot?.error?.code || 'RBI_FRSB_COUPON_UNAVAILABLE';
    }
    return unavailable(
      [reason],
      provider,
      provider === PROVIDERS.RBI
        ? 'The official RBI floating coupon or reference NSC rate could not be verified. No static rate was substituted.'
        : 'No source-qualified product matches the exact scheme or comparable tenure and depositor class.',
    );
  }

  const dto = commonProductDto(selected.product, selected.fact, parentInstrumentId);
  if (provider === PROVIDERS.GOVERNMENT_OF_INDIA) {
    dto.compoundingBasis = selected.fact.compoundingBasis ?? null;
    dto.tenureMonths = selected.product.tenureMonths ?? null;
    dto.maturityEvidence = selected.product.maturityEvidence ?? null;
  } else if (provider === PROVIDERS.SBI) {
    dto.tenure = {
      label: selected.product.tenureLabel,
      minDays: selected.product.tenureMinDays,
      maxDaysExclusive: selected.product.tenureMaxDaysExclusive,
    };
    dto.depositorType = selected.product.depositorType;
    dto.depositType = selected.product.depositType;
    dto.callability = selected.product.callability;
    dto.riskQuality = null;
  } else if (provider === PROVIDERS.RBI) {
    dto.tenureMonths = selected.product.tenureMonths;
    dto.couponResetFrequency = selected.product.couponResetFrequency;
    dto.interestPaymentFrequency = selected.product.interestPaymentFrequency;
    dto.referenceRate = selected.product.referenceRate;
    dto.spreadBps = selected.product.spreadBps;
    dto.officialRate.referenceRate = selected.fact.referenceRate;
    dto.officialRate.referenceRateValue = selected.fact.referenceRateValue;
    dto.officialRate.spreadBps = selected.fact.spreadBps;
    dto.officialRate.resetDate = selected.fact.resetDate;
    dto.officialRate.referenceRateFact = selected.fact.referenceRateFact;
    dto.rankingReasonCodes = [
      'OFFICIAL_SOURCE_FACT_VERIFIED',
      'SINGLE_CANONICAL_PRODUCT',
      'MERIT_RANKING_NOT_CLAIMED',
    ];
  }

  const rankingReasonCodes = provider === PROVIDERS.RBI
    ? ['OFFICIAL_SOURCE_FACT_VERIFIED', 'SINGLE_CANONICAL_PRODUCT', 'MERIT_RANKING_NOT_CLAIMED']
    : ['OFFICIAL_SOURCE_FACT_VERIFIED', 'MERIT_RANKING_NOT_CLAIMED'];

  return {
    products: [dto],
    ranking: {
      version: FIXED_INCOME_RANKING_VERSION,
      status: 'VERIFIED_COMPARABLE_OPTIONS',
      provider,
      reasonCodes: rankingReasonCodes,
      arbitraryWeightedScoreUsed: false,
      forcedResultCount: false,
      hasUniqueLeader: false,
    },
    comparisonUniverse: {
      dataClass: selected.fact.dataClass,
      provider,
      eligibleProductCount: 1,
      effectiveFrom: selected.fact.effectiveFrom,
      effectiveTo: selected.fact.effectiveTo,
      disclosure: provider === PROVIDERS.SBI
        ? 'One SBI card-rate option matching the profile horizon and source-established depositor class. Different tenures and depositor classes are excluded; no best-FD claim is made.'
        : provider === PROVIDERS.RBI
          ? 'The single canonical Floating Rate Savings Bond (Taxable) issued by Government of India / RBI. Coupon is officially linked to the prevailing NSC rate plus 35 bps reset semi-annually.'
          : 'The exact India Post government scheme within the already suitable parent category. Its official interval rate is shown without a cross-scheme merit ranking.',
    },
  };
}
