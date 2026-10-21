/**
 * Source-bound gross contractual cash-flow illustrations for the existing WTI
 * product pipeline. The financial authority is the qualified source fact and
 * exact product schedule, never an LLM, a model-policy return, or a market quote.
 *
 * A current public rate does NOT prove future renewals, monthly accrual rules,
 * all-account eligibility, reinvestment, investor tax, or redemption eligibility.
 * Missing terms produce UNAVAILABLE, never a plausible invented maturity amount.
 */
export const CONTRACT_CASHFLOW_VERSION = 'qualified-product-cashflow-1.0.0';
const INDIA_POST_URL = 'https://www.indiapost.gov.in/banking-services/savings';
const ALLOWED_PRODUCTS = Object.freeze({
  'government:india-post:nsc': Object.freeze({
    kind: 'MATURITY_COMPOUND', tenureMonths: 60,
    compoundingBasis: 'Annually', periodsPerYear: 1,
  }),
  'government:india-post:kvp': Object.freeze({
    kind: 'SOURCE_TENOR_DOUBLE', tenureMonths: null,
    compoundingBasis: 'Annually', periodsPerYear: 1,
  }),
  'government:india-post:post-office-td-1y': Object.freeze({
    kind: 'ANNUAL_PAYOUT', tenureMonths: 12,
    compoundingBasis: 'Quarterly', periodsPerYear: 4,
  }),
  'government:india-post:post-office-td-2y': Object.freeze({
    kind: 'ANNUAL_PAYOUT', tenureMonths: 24,
    compoundingBasis: 'Quarterly', periodsPerYear: 4,
  }),
  'government:india-post:post-office-td-3y': Object.freeze({
    kind: 'ANNUAL_PAYOUT', tenureMonths: 36,
    compoundingBasis: 'Quarterly', periodsPerYear: 4,
  }),
  'government:india-post:post-office-td-5y': Object.freeze({
    kind: 'ANNUAL_PAYOUT', tenureMonths: 60,
    compoundingBasis: 'Quarterly', periodsPerYear: 4,
  }),
});
function isoCalendar(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const instant = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(instant.getTime()) && instant.toISOString().slice(0, 10) === value
    ? value : null;
}
function indiaCalendarDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const map = Object.fromEntries(parts.filter(part => part.type !== 'literal')
    .map(part => [part.type, part.value]));
  return map.year + '-' + map.month + '-' + map.day;
}
function unavailable(reasonCode, product) {
  return {
    version: CONTRACT_CASHFLOW_VERSION,
    status: 'UNAVAILABLE',
    reasonCode,
    canonicalProductId: product?.canonicalProductId || null,
    grossMaturityProceeds: null,
    grossTotalProceeds: null,
    grossInterest: null,
    grossCumulativeReturnPct: null,
    postTaxProceeds: null,
    postTaxStatus: 'NOT_CALCULATED',
    source: null,
    scenarioClass: 'NO_SOURCE_QUALIFIED_CONTRACT_VALUE',
  };
}
/**
 * Current India Post TD 1/2/3/5-year rate facts and five-year NSC have
 * bounded conditional cash-flow illustrations. TD yearly payouts are NOT
 * silently reinvested; the remaining classes require account schedules,
 * coupon resets, or holder-specific lots and remain unavailable.
 */
export function calculateQualifiedProductCashflow({
  product,
  principal,
  now = new Date(),
  enforceSourceRights = true,
  productionUseAllowed = false,
} = {}) {
  if (!product || typeof product !== 'object' || Array.isArray(product))
    return unavailable('PRODUCT_FACTS_UNAVAILABLE', product);
  if (enforceSourceRights && productionUseAllowed !== true)
    return unavailable('SOURCE_RIGHTS_UNQUALIFIED', product);
  if (product.presentationStatus !== 'VERIFIED_COMPARABLE_OPTION' ||
      typeof product.canonicalProductId !== 'string' ||
      product.id !== product.canonicalProductId)
    return unavailable('PRODUCT_IDENTITY_NOT_QUALIFIED', product);
  if (typeof principal !== 'number' || !Number.isFinite(principal) ||
      principal <= 0 || principal > 1e10)
    return unavailable('EXPLICIT_PRINCIPAL_REQUIRED', product);

  const terms = ALLOWED_PRODUCTS[product.canonicalProductId];
  if (!terms) return unavailable('PRODUCT_SPECIFIC_CASHFLOWS_NOT_VERIFIED', product);
  // NSC subscriptions start at INR 1,000 in INR 100 multiples; Post Office
  // Time Deposits start at INR 1,000 in INR 1,000 multiples.
  const increment = ['government:india-post:nsc', 'government:india-post:kvp'].includes(product.canonicalProductId)
    ? 100 : 1000;
  if (principal < 1000 || principal % increment !== 0)
    return unavailable('INVALID_PRODUCT_DENOMINATION', product);
  const rateFact = product.officialRate;
  if (!rateFact || typeof rateFact !== 'object' ||
      product.source?.provider !== 'GOVERNMENT_OF_INDIA' ||
      product.source?.url !== INDIA_POST_URL ||
      rateFact.dataClass !== 'QUARTERLY_OFFICIAL_RATE' ||
      rateFact.basis !== 'OFFICIAL_NOMINAL_RATE_PER_ANNUM' ||
      rateFact.unit !== 'PERCENT_PER_ANNUM' ||
      product.availabilityStatus !== 'AVAILABLE' ||
      product.freshness?.status !== 'FRESH' ||
      product.compoundingBasis !== terms.compoundingBasis ||
      (terms.tenureMonths !== null && product.tenureMonths !== terms.tenureMonths))
    return unavailable('QUALIFIED_PRODUCT_TERMS_MISSING', product);
  const isKvp = terms.kind === 'SOURCE_TENOR_DOUBLE';
  if (isKvp && (product.maturityEvidence !== 'INDIA_POST_RATE_ANNOTATION' ||
      !Number.isInteger(product.tenureMonths) ||
      product.tenureMonths < 60 || product.tenureMonths > 240))
    return unavailable('SOURCE_DERIVED_MATURITY_UNAVAILABLE', product);
  const effectiveFrom = isoCalendar(rateFact.effectiveFrom);
  const effectiveTo = isoCalendar(rateFact.effectiveTo);
  const today = indiaCalendarDate(now);
  if (!today || !effectiveFrom || !effectiveTo ||
      effectiveFrom > effectiveTo || today < effectiveFrom || today > effectiveTo)
    return unavailable('SOURCE_RATE_NOT_CURRENT', product);
  if (typeof rateFact.value !== 'number' || !Number.isFinite(rateFact.value) ||
      rateFact.value < 0 || rateFact.value > 30)
    return unavailable('INVALID_OFFICIAL_RATE', product);
  const rate = rateFact.value / 100;
  const tenureMonths = isKvp ? product.tenureMonths : terms.tenureMonths;
  const periods = tenureMonths * terms.periodsPerYear / 12;
  if (!isKvp && !Number.isInteger(periods)) return unavailable('CONTRACT_SCHEDULE_UNSUPPORTED', product);
  const isAnnualPayout = terms.kind === 'ANNUAL_PAYOUT';
  // TD interest is credited annually to the depositor; it earns no extra
  // interest in the term-deposit account unless separately reinvested.
  // Scheme rules round each year's interest to the nearest rupee.
  const annualCoupon = isAnnualPayout
    ? Math.round(principal * (Math.pow(1 + rate / 4, 4) - 1))
    : null;
  const payouts = isAnnualPayout
    ? Array.from({ length: terms.tenureMonths / 12 },
      (_, i) => ({ month: (i + 1) * 12, annualInterestPaid: annualCoupon }))
    : [];
  const grossTotal = isAnnualPayout
    ? principal + annualCoupon * payouts.length
    : isKvp ? principal * 2 : principal * Math.pow(1 + rate / terms.periodsPerYear, periods);
  // NSC regulations round the final maturity amount to the nearest rupee.
  const payableTotal = isAnnualPayout ? grossTotal : Math.round(grossTotal);
  const redemption = isAnnualPayout ? principal + annualCoupon : payableTotal;
  if (!Number.isFinite(grossTotal) || grossTotal > Number.MAX_SAFE_INTEGER)
    return unavailable('NUMERIC_OVERFLOW', product);
  const rounded = value => Math.round((value + Number.EPSILON) * 100) / 100;
  return {
    version: CONTRACT_CASHFLOW_VERSION,
    status: 'CALCULATED',
    reasonCode: null,
    canonicalProductId: product.canonicalProductId,
    principal: rounded(principal),
    tenureMonths,
    grossMaturityProceeds: rounded(redemption),
    grossTotalProceeds: rounded(payableTotal),
    grossInterest: rounded(payableTotal - principal),
    grossCumulativeReturnPct: rounded((payableTotal / principal - 1) * 100),
    cashflowType: terms.kind,
    annualPayouts: payouts,
    postTaxProceeds: null,
    postTaxStatus: 'REQUIRES_EFFECTIVE_DATED_TAX_AND_ACCOUNT_FACTS',
    model: terms.kind,
    compoundingPeriodsPerYear: terms.periodsPerYear,
    scenarioClass: 'CONDITIONAL_GROSS_CONTRACT_ILLUSTRATION_NOT_FUTURE_RATE_FORECAST',
    assumedOpeningRateLocked: true,
    sourceRights: enforceSourceRights ? 'PRODUCTION_USE_QUALIFIED' : 'NON_PRODUCTION_ILLUSTRATION',
    source: {
      provider: product.source.provider,
      url: product.source.url,
      effectiveFrom, effectiveTo,
      nominalAnnualRatePct: rateFact.value,
    },
  };
}
