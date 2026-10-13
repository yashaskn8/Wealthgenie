/**
 * productPostTaxCalculator.js
 * 
 * WealthGenie Beginner-First Post-Tax Calculation & Product Metadata Enrichment Service
 * 
 * Responsibilities:
 * 1. Calculate defensible post-tax outcomes using the authoritative versioned taxEngine
 *    via the incremental tax method:
 *      baselineTax = computeTax(annualIncome)
 *      taxWithIncome = computeTax(annualIncome + productIncome)
 *      incrementalTax = taxWithIncome - baselineTax
 *      netGain = grossGain - incrementalTax
 *      postTaxReturnPct = (netGain / principal) * 100
 * 2. Never calculate tax in React.
 * 3. Never use a fake marginal-rate shortcut (rate * (1 - marginalRate)) that ignores progressive slabs.
 * 4. Never show exact future post-tax returns for mutual funds; label as HISTORICAL (not a forecast).
 * 5. Handle RBI FRSB correctly: "Current coupon after tax", disclaiming semiannual reset (never guaranteed 7-year).
 * 6. PPF / SSY treatment is versioned by fiscal year and account facts; no legacy
 *    section label is emitted as current statutory authority.
 * 7. Generate deterministic, plain-English "Why this fits you", risk tier, and access-to-money copy.
 */

import {
  classifyHoldingPeriodByDates,
  computeEquityCapitalGainsTax,
  computeTax,
  getCurrentFiscalYear,
  getCapitalGainsHoldingPeriodMonths,
  getTaxPolicyMetadata,
} from './taxEngine.js';
import { isPresentFiniteFinancialNumber, toOptionalFinancialNumber } from '../utils/strictFinancialNumber.js';
import {
  classifySourceQualifiedProductTaxType,
  getProductTaxMetadata,
  getRequiredTaxInputs,
  POST_TAX_CALCULATION_CLASSES,
  PRODUCT_TAX_CLASSES,
  PRODUCT_TAX_STATUSES,
} from './productTaxAuthority.js';
import { buildTaxRuleMetadata, LEGACY_RULE_SEMANTICS } from './taxRuleMetadata.js';
import { resolvePostTaxProductRights } from './postTaxSourceRights.js';

export const POST_TAX_SERVICE_VERSION = 'product-post-tax-calculator-2.0.0';

/**
 * Classify product tax category from product DTO and parent category
 */
export function classifyProductTaxType(product, parentInstrumentId) {
  return classifySourceQualifiedProductTaxType(
    product,
    parentInstrumentId || product?.parentInstrumentId,
  );
}

function createAnalysis({
  status,
  taxMetadata,
  policy = null,
  fiscalYear = null,
  policyVersion = null,
  principal,
  grossGain = null,
  taxableGain = null,
  exemptionApplied = null,
  incrementalTax = null,
  cess = null,
  surcharge = null,
  netGain = null,
  postTaxRatePct = null,
  calculationClass = POST_TAX_CALCULATION_CLASSES.CURRENT_RATE_POST_TAX_ILLUSTRATION,
  inputBasis = 'PROVIDER_FACT',
  holdingPeriodBasis = null,
  dataClass = 'PROVIDER_FACT',
  assumptions = [],
  unavailableReasons = [],
  requiredTaxInputs = [],
  metricLabel = 'After-tax result',
  disclosure = null,
  message = null,
  isHistoricalEstimate = false,
  historicalObservationWindowMonths = null,
  rulesApplied = [],
  legacyRuleAliases = [],
}) {
  const sourceReferences = [];
  const seenReferences = new Set();
  const addReferences = (references, fallbackRole) => {
    for (const source of Array.isArray(references) ? references : []) {
      if (!source || typeof source !== 'object') continue;
      const normalized = {
        ...source,
        role: source.role || fallbackRole,
      };
      const key = [normalized.authority, normalized.title, normalized.url, normalized.role]
        .map(value => String(value ?? '')).join('|');
      if (seenReferences.has(key)) continue;
      seenReferences.add(key);
      sourceReferences.push(normalized);
    }
  };
  addReferences(taxMetadata?.sourceReferences, 'PRODUCT_RULE');
  addReferences(policy?.sourceReferences, 'TAX_POLICY');

  const rawRulesApplied = [
    ...(taxMetadata?.rulesApplied || []),
    ...rulesApplied,
  ];
  const taxRuleMetadata = buildTaxRuleMetadata({
    statuteMetadata: policy?.statuteMetadata,
    identifiers: rawRulesApplied,
    taxClass: taxMetadata?.taxClass || null,
  });
  const completeTaxRuleMetadata = taxRuleMetadata ? {
    ...taxRuleMetadata,
    legacyAliases: [...new Set([...taxRuleMetadata.legacyAliases, ...legacyRuleAliases])],
  } : null;
  const visibleRulesApplied = completeTaxRuleMetadata?.rulesApplied
    || rawRulesApplied.filter(identifier => !LEGACY_RULE_SEMANTICS[identifier]);
  return {
    status,
    calculationClass,
    taxClass: taxMetadata?.taxClass || null,
    taxClassification: taxMetadata?.taxClass || null,
    taxClassificationMetadata: completeTaxRuleMetadata ? {
      statute: completeTaxRuleMetadata.statute,
      classificationId: completeTaxRuleMetadata.classificationId,
      legacyClassificationAlias: completeTaxRuleMetadata.legacyClassificationAlias,
      productEvidence: taxMetadata?.productEvidence ? structuredClone(taxMetadata.productEvidence) : null,
    } : (taxMetadata?.taxClass ? {
      statute: null,
      classificationId: null,
      legacyClassificationAlias: taxMetadata.taxClass,
      status: 'STATUTE_POLICY_UNAVAILABLE',
      productEvidence: taxMetadata?.productEvidence ? structuredClone(taxMetadata.productEvidence) : null,
    } : null),
    taxRuleMetadata: completeTaxRuleMetadata,
    fiscalYear,
    policyVersion,
    inputBasis,
    principal,
    illustrativePrincipal: principal,
    grossGain,
    taxableGain,
    exemptionApplied,
    incrementalTax,
    cess,
    surcharge,
    netGain,
    postTaxRatePct,
    holdingPeriodBasis,
    dataClass,
    assumptions,
    unavailableReasons,
    sourceReferences,
    rulesApplied: visibleRulesApplied,
    requiredTaxInputs,
    metricLabel,
    disclosure,
    message,
    isHistoricalEstimate,
    historicalObservationWindowMonths,
  };
}

function getPrincipal(taxCalculationContext) {
  const supplied = toOptionalFinancialNumber(taxCalculationContext?.illustrativePrincipal);
  return supplied !== null && supplied > 0 ? supplied : 10000;
}

function hasExplicitFiniteNumber(value) {
  return isPresentFiniteFinancialNumber(value);
}

function getTaxPolicyOrUnavailable(fiscalYear) {
  try {
    return { policy: getTaxPolicyMetadata(fiscalYear), unavailable: null };
  } catch (error) {
    if (error?.code === 'FISCAL_YEAR_UNSUPPORTED' || error instanceof RangeError) {
      return { policy: null, unavailable: 'FISCAL_YEAR_UNSUPPORTED' };
    }
    throw error;
  }
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function missingRequiredTaxInputs(taxCalculationContext, requiredTaxInputs) {
  const context = taxCalculationContext || {};
  const hasBothExactDates = Boolean(context.acquisitionDate && context.redemptionDate);
  const hasPartialExactDates = Boolean(context.acquisitionDate || context.redemptionDate) && !hasBothExactDates;
  return requiredTaxInputs.filter(key => {
    if (key === 'annualGrossIncome') return !hasExplicitFiniteNumber(context.annualGrossIncome);
    if (key === 'userAge') return !hasExplicitFiniteNumber(context.userAge)
      || !Number.isInteger(Number(context.userAge)) || Number(context.userAge) < 18 || Number(context.userAge) > 120;
    if (key === 'holdingPeriodMonths') return hasBothExactDates
      ? false
      : !hasExplicitFiniteNumber(context.holdingPeriodMonths);
    if (key === 'section112AExemptionUsed') return !hasExplicitFiniteNumber(context.section112AExemptionUsed);
    if (key === 'sttConditionAssumedSatisfied') return context.sttConditionAssumedSatisfied === undefined || context.sttConditionAssumedSatisfied === null;
    return context[key] === undefined || context[key] === null || context[key] === '';
  }).concat(hasPartialExactDates ? ['acquisitionDate', 'redemptionDate'] : []);
}

function taxContextValues(taxCalculationContext) {
  const userAge = Number(taxCalculationContext?.userAge);
  const deductions = { ...(taxCalculationContext?.deductions || {}) };
  if (Number.isInteger(userAge) && userAge >= 18 && userAge <= 120) deductions.age = userAge;
  return {
    annualIncome: Number(taxCalculationContext?.annualGrossIncome),
    regime: taxCalculationContext?.regime,
    fiscalYear: taxCalculationContext?.fiscalYear,
    incomeSource: taxCalculationContext?.incomeSource,
    userAge: Number.isInteger(userAge) ? userAge : null,
    deductions,
  };
}

/**
 * Calculate defensible after-tax outcome for a single product.
 * Returns postTaxAnalysis object.
 */
export function calculateProductPostTaxOutcome({ product, profile: _profile = {}, taxCalculationContext = null }) {
  const principal = getPrincipal(taxCalculationContext);
  const parentInstrumentId = product?.parentInstrumentId;
  const taxMetadata = getProductTaxMetadata(product, parentInstrumentId);
  const taxType = taxMetadata.taxClass;
  const requiredTaxInputs = getRequiredTaxInputs(taxType);
  const assumptions = taxCalculationContext?.illustrativePrincipal
    ? []
    : ['ILLUSTRATIVE_PRINCIPAL_DEFAULT_10000'];
  if (taxCalculationContext && taxCalculationContext.deductions === undefined && taxType) {
    assumptions.push('DEDUCTIONS_NOT_SUPPLIED; NO_DEDUCTION_ASSUMPTION_USED');
  }

  if (!taxMetadata.sourceQualified || !taxType) {
    return createAnalysis({
      status: PRODUCT_TAX_STATUSES.TAX_CLASSIFICATION_UNAVAILABLE,
      taxMetadata,
      principal,
      calculationClass: POST_TAX_CALCULATION_CLASSES.CURRENT_RATE_POST_TAX_ILLUSTRATION,
      dataClass: 'UNAVAILABLE',
      assumptions,
      unavailableReasons: [taxMetadata.unavailableReason || 'TAX_CLASSIFICATION_UNAVAILABLE'],
      disclosure: 'The qualified provider did not supply a tax classification for this product. No post-tax result is shown.',
    });
  }

  const fiscalYear = taxCalculationContext?.fiscalYear || getCurrentFiscalYear();
  const { policy, unavailable } = getTaxPolicyOrUnavailable(fiscalYear);
  if (unavailable) {
    return createAnalysis({
      status: PRODUCT_TAX_STATUSES.FISCAL_YEAR_UNSUPPORTED,
      taxMetadata,
      fiscalYear,
      principal,
      requiredTaxInputs,
      assumptions,
      unavailableReasons: [unavailable],
      disclosure: 'The requested fiscal-year tax policy is not verified by the backend.',
    });
  }

  const annualRate = toOptionalFinancialNumber(product?.officialRate?.value) ?? Number.NaN;
  const isEee = [PRODUCT_TAX_CLASSES.PPF_EEE, PRODUCT_TAX_CLASSES.SSY_EEE].includes(taxType);
  if (isEee) {
    return createAnalysis({
      status: PRODUCT_TAX_STATUSES.TAX_CLASSIFICATION_REQUIRES_ACQUISITION_FACTS,
      taxMetadata,
      policy,
      fiscalYear,
      policyVersion: policy.policyVersion,
      principal,
      dataClass: 'UNAVAILABLE',
      assumptions,
      requiredTaxInputs,
      unavailableReasons: ['PPF_SSY_EXCLUSION_ELIGIBILITY_NOT_ESTABLISHED', ...requiredTaxInputs],
      metricLabel: 'After-tax result',
      disclosure: 'No account-qualification or contribution/exit evidence is available to establish the statutory exclusion for this account. No tax-free result or after-tax rate is inferred from the product name or scheme category.',
      message: 'Verified account and payment evidence is required before this tax treatment can be classified.',
    });
  }

  const missingInputs = missingRequiredTaxInputs(taxCalculationContext, requiredTaxInputs);
  if (missingInputs.length > 0) {
    return createAnalysis({
      status: PRODUCT_TAX_STATUSES.REQUIRES_TAX_INPUTS,
      taxMetadata,
      policy,
      fiscalYear: taxCalculationContext?.fiscalYear || null,
      principal,
      requiredTaxInputs: missingInputs,
      assumptions,
      unavailableReasons: [],
      metricLabel: taxType === PRODUCT_TAX_CLASSES.RBI_FRSB_INTEREST
        ? 'Current coupon after tax'
        : 'After-tax result',
      disclosure: 'Add the backend-declared tax inputs to calculate this result.',
      message: 'Additional tax inputs are required for this product.',
      isHistoricalEstimate: taxType.includes('MF'),
    });
  }

  const { annualIncome, regime, incomeSource, userAge, deductions } = taxContextValues(taxCalculationContext);
  if ([PRODUCT_TAX_CLASSES.BANK_DEPOSIT_INTEREST, PRODUCT_TAX_CLASSES.RBI_FRSB_INTEREST].includes(taxType)) {
    if (!Number.isFinite(annualRate) || annualRate < 0) {
      return createAnalysis({
        status: PRODUCT_TAX_STATUSES.PRODUCT_FACTS_UNAVAILABLE,
        taxMetadata,
        policy,
        fiscalYear,
        policyVersion: policy.policyVersion,
        principal,
        requiredTaxInputs,
        dataClass: 'UNAVAILABLE',
        assumptions,
        unavailableReasons: ['CURRENT_OFFICIAL_RATE_UNAVAILABLE'],
        metricLabel: taxType === PRODUCT_TAX_CLASSES.RBI_FRSB_INTEREST
          ? 'Current coupon after tax'
          : 'Current after-tax rate',
      });
    }
    const grossGain = Math.round(principal * (annualRate / 100));
    const baseline = computeTax(annualIncome, regime, deductions, incomeSource, fiscalYear, userAge);
    const withGain = computeTax(annualIncome + grossGain, regime, deductions, incomeSource, fiscalYear, userAge);
    const incrementalTax = Math.max(0, withGain.taxAmount - baseline.taxAmount);
    const netGain = grossGain - incrementalTax;
    return createAnalysis({
      status: PRODUCT_TAX_STATUSES.CALCULATED,
      taxMetadata,
      policy,
      fiscalYear,
      policyVersion: policy.policyVersion,
      principal,
      grossGain,
      taxableGain: grossGain,
      exemptionApplied: 0,
      incrementalTax,
      cess: Math.max(0, withGain.cess - baseline.cess),
      surcharge: Math.max(0, withGain.surchargeAmount - baseline.surchargeAmount),
      netGain,
      postTaxRatePct: Number(((netGain / principal) * 100).toFixed(2)),
      assumptions: [...assumptions, 'INCREMENTAL_TAX_BASELINE_AND_WITH_PRODUCT_INCOME'],
      metricLabel: taxType === PRODUCT_TAX_CLASSES.RBI_FRSB_INTEREST
        ? 'Current coupon after tax'
        : 'Current after-tax rate',
      disclosure: taxType === PRODUCT_TAX_CLASSES.RBI_FRSB_INTEREST
        ? 'Current coupon after-tax illustration. Coupon resets every six months (1 Jan and 1 Jul); it is not a fixed 7-year return or maturity IRR. TDS is withholding, not an additional final tax.'
        : 'Current annual rate after incremental tax using the backend tax policy. TDS, where applicable, is withholding at source and is not added as a second tax charge.',
      rulesApplied: ['CURRENT_RATE_ONLY_NOT_FULL_TENURE_IRR'],
    });
  }

  const historicalRateValue = product?.historicalReturn?.valuePct;
  if (!hasExplicitFiniteNumber(historicalRateValue)) {
    return createAnalysis({
      status: PRODUCT_TAX_STATUSES.PRODUCT_FACTS_UNAVAILABLE,
      taxMetadata,
      policy,
      fiscalYear,
      policyVersion: policy.policyVersion,
      principal,
      requiredTaxInputs,
      dataClass: 'UNAVAILABLE',
      assumptions,
      unavailableReasons: ['QUALIFIED_HISTORICAL_RETURN_UNAVAILABLE'],
      metricLabel: 'Historical 1Y after-tax return',
      isHistoricalEstimate: true,
    });
  }
  const historicalRate = toOptionalFinancialNumber(historicalRateValue);
  const grossGain = Math.round(principal * (historicalRate / 100));
  const holdingPeriodMonths = Number(taxCalculationContext.holdingPeriodMonths);
  let holdingPeriodBasis = 'MODELLED_HOLDING_PERIOD';
  let holdingPeriodClassification = null;
  if ([PRODUCT_TAX_CLASSES.EQUITY_MF_112A, PRODUCT_TAX_CLASSES.EQUITY_MF_ELSS].includes(taxType)
      && (taxCalculationContext.acquisitionDate || taxCalculationContext.redemptionDate)) {
    if (!taxCalculationContext.acquisitionDate || !taxCalculationContext.redemptionDate) {
      return createAnalysis({
        status: PRODUCT_TAX_STATUSES.REQUIRES_TAX_INPUTS,
        taxMetadata,
        policy,
        fiscalYear,
        policyVersion: policy.policyVersion,
        principal,
        requiredTaxInputs: ['acquisitionDate', 'redemptionDate'],
        assumptions,
        disclosure: 'Both exact transaction dates are required to classify the holding period.',
        message: 'Acquisition and redemption dates are required together.',
        isHistoricalEstimate: true,
      });
    }
    const dateClassification = classifyHoldingPeriodByDates({
      acquisitionDate: taxCalculationContext.acquisitionDate,
      redemptionDate: taxCalculationContext.redemptionDate,
      thresholdMonths: getCapitalGainsHoldingPeriodMonths(fiscalYear, 'listed'),
    });
    holdingPeriodClassification = dateClassification;
    holdingPeriodBasis = dateClassification.holdingPeriodBasis;
  }

  if (taxType === PRODUCT_TAX_CLASSES.DEBT_MF_50AA) {
    const baseline = computeTax(annualIncome, regime, deductions, incomeSource, fiscalYear, userAge);
    const withGain = computeTax(annualIncome + grossGain, regime, deductions, incomeSource, fiscalYear, userAge);
    const incrementalTax = Math.max(0, withGain.taxAmount - baseline.taxAmount);
    const netGain = grossGain - incrementalTax;
    return createAnalysis({
      status: PRODUCT_TAX_STATUSES.CALCULATED,
      taxMetadata,
      policy,
      fiscalYear,
      policyVersion: policy.policyVersion,
      principal,
      grossGain,
      taxableGain: grossGain,
      exemptionApplied: 0,
      incrementalTax,
      cess: Math.max(0, withGain.cess - baseline.cess),
      surcharge: Math.max(0, withGain.surchargeAmount - baseline.surchargeAmount),
      netGain,
      postTaxRatePct: Number(((netGain / principal) * 100).toFixed(2)),
      calculationClass: POST_TAX_CALCULATION_CLASSES.HISTORICAL_RETURN_POST_TAX_ILLUSTRATION,
      inputBasis: 'HISTORICAL_PROVIDER_FACT_PLUS_EXPLICIT_TAX_INPUTS',
      holdingPeriodBasis,
      dataClass: 'HISTORICAL_PROVIDER_FACT',
      assumptions: [...assumptions, 'HISTORICAL_RETURN_IS_NOT_A_FORECAST'],
      metricLabel: 'Historical 1Y after-tax return',
      historicalObservationWindowMonths: 12,
      disclosure: 'HISTORICAL — NOT A FORECAST. Qualified debt mutual-fund tax metadata establishes the applicable slab treatment; the comparison uses the explicit holding period and current tax inputs. No future return is claimed.',
      isHistoricalEstimate: true,
    });
  }

  if (![PRODUCT_TAX_CLASSES.EQUITY_MF_112A, PRODUCT_TAX_CLASSES.EQUITY_MF_ELSS].includes(taxType)) {
    return createAnalysis({
      status: PRODUCT_TAX_STATUSES.TAX_CLASSIFICATION_UNAVAILABLE,
      taxMetadata,
      policy,
      fiscalYear,
      policyVersion: policy.policyVersion,
      principal,
      requiredTaxInputs,
      dataClass: 'UNAVAILABLE',
      assumptions,
      unavailableReasons: ['TAX_CLASSIFICATION_UNAVAILABLE'],
      isHistoricalEstimate: true,
    });
  }

  if (taxCalculationContext.sttConditionAssumedSatisfied !== true) {
    return createAnalysis({
      status: PRODUCT_TAX_STATUSES.UNAVAILABLE,
      taxMetadata,
      policy,
      fiscalYear,
      policyVersion: policy.policyVersion,
      principal,
      requiredTaxInputs: [],
      dataClass: 'UNAVAILABLE',
      assumptions,
      unavailableReasons: ['EQUITY_FUND_STT_CONDITION_NOT_ESTABLISHED'],
      metricLabel: 'Historical 1Y after-tax return',
      disclosure: 'No tax amount is calculated because this scenario does not establish that the applicable securities transaction tax condition for the hypothetical transfer is satisfied. Product classification does not prove that a particular transaction meets that condition.',
      isHistoricalEstimate: true,
    });
  }

  // A standalone historical NAV loss (or exactly flat return) is not a
  // positive capital gain and must never be passed to the gain-only tax
  // calculator. Preserve the source-derived result and the applicable
  // holding-period rule as classification evidence, while explicitly leaving
  // loss set-off/carry-forward and taxpayer-level benefits unmodeled.
  if (grossGain <= 0) {
    if (!holdingPeriodClassification
        && (!Number.isFinite(holdingPeriodMonths) || holdingPeriodMonths < 0)) {
      throw new TypeError('holdingPeriodMonths must be an explicit non-negative finite number');
    }
    const section112AExemptionUsed = Number(taxCalculationContext.section112AExemptionUsed);
    if (!Number.isFinite(section112AExemptionUsed) || section112AExemptionUsed < 0) {
      throw new TypeError('section112AExemptionUsed must be an explicit non-negative finite number');
    }
    const isLongTerm = holdingPeriodClassification?.isLongTerm
      ?? (holdingPeriodMonths > getCapitalGainsHoldingPeriodMonths(fiscalYear, 'listed'));
    const applicableRule = isLongTerm
      ? 'SECTION_112A_LTCG_SPECIAL_RATE'
      : 'SECTION_111A_STCG_SPECIAL_RATE';
    const isLoss = grossGain < 0;
    return createAnalysis({
      status: PRODUCT_TAX_STATUSES.CALCULATED,
      taxMetadata,
      policy,
      fiscalYear,
      policyVersion: policy.policyVersion,
      principal,
      grossGain,
      taxableGain: 0,
      exemptionApplied: 0,
      incrementalTax: 0,
      cess: 0,
      surcharge: 0,
      netGain: grossGain,
      postTaxRatePct: Number(((grossGain / principal) * 100).toFixed(2)),
      calculationClass: POST_TAX_CALCULATION_CLASSES.HISTORICAL_RETURN_POST_TAX_ILLUSTRATION,
      inputBasis: 'HISTORICAL_PROVIDER_FACT_PLUS_EXPLICIT_TAX_INPUTS',
      holdingPeriodBasis,
      dataClass: 'HISTORICAL_PROVIDER_FACT',
      assumptions: [
        ...assumptions,
        'HISTORICAL_RETURN_IS_NOT_A_FORECAST',
        'STT_CONDITION_ASSUMED_SATISFIED_FOR_HYPOTHETICAL_TRANSFER',
        isLoss ? 'CAPITAL_LOSS_TAX_BENEFIT_NOT_MODELED' : 'NO_POSITIVE_CAPITAL_GAIN_TAX_NOT_APPLIED',
      ],
      metricLabel: 'Historical 1Y after-tax return',
      disclosure: isLoss
        ? 'HISTORICAL — NOT A FORECAST. The qualified one-year provider NAV comparison is not a realized gain or a future return. This standalone illustration shows a historical capital loss; no tax is charged on this negative result. Loss set-off, carry-forward, or any taxpayer-level tax benefit is not modeled, and no realized transaction is asserted. The applicable STT condition is assumed for the hypothetical transfer and is not verified for an actual transaction.'
        : 'HISTORICAL — NOT A FORECAST. The qualified one-year provider NAV comparison is not a realized gain or a future return. This standalone illustration has no positive capital gain, so no tax is charged on this zero result; tax on other income is not determined and no realized transaction is asserted. The applicable STT condition is assumed for the hypothetical transfer and is not verified for an actual transaction.',
      isHistoricalEstimate: true,
      historicalObservationWindowMonths: 12,
      rulesApplied: [applicableRule],
    });
  }

  const capitalGains = computeEquityCapitalGainsTax({
    grossGain,
    holdingPeriodMonths,
    annualIncome,
    regime,
    deductions,
    incomeSource,
    fiscalYear,
    userAge,
    section112AExemptionUsed: Number(taxCalculationContext.section112AExemptionUsed),
    holdingPeriodClassification,
  });
  if (capitalGains.status !== 'CALCULATED') {
    return createAnalysis({
      status: PRODUCT_TAX_STATUSES.UNAVAILABLE,
      taxMetadata,
      policy,
      fiscalYear,
      policyVersion: policy.policyVersion,
      principal,
      grossGain,
      taxableGain: capitalGains.taxableGain,
      exemptionApplied: capitalGains.exemptionApplied,
      requiredTaxInputs,
      dataClass: 'UNAVAILABLE',
      assumptions: [...assumptions, 'SPECIAL_RATE_BUCKET_REQUIRES_COMPLETE_HIGH_INCOME_CONTEXT'],
      unavailableReasons: capitalGains.unavailableReasons,
      metricLabel: 'Historical after-tax return',
      isHistoricalEstimate: true,
    });
  }
  const netGain = grossGain - capitalGains.taxAmount;
  return createAnalysis({
    status: PRODUCT_TAX_STATUSES.CALCULATED,
    taxMetadata,
    policy,
    fiscalYear,
    policyVersion: policy.policyVersion,
    principal,
    grossGain,
    taxableGain: capitalGains.taxableGain,
    exemptionApplied: capitalGains.exemptionApplied,
    incrementalTax: capitalGains.taxAmount,
    cess: capitalGains.cess,
    surcharge: capitalGains.surcharge,
    netGain,
    postTaxRatePct: Number(((netGain / principal) * 100).toFixed(2)),
    calculationClass: POST_TAX_CALCULATION_CLASSES.HISTORICAL_RETURN_POST_TAX_ILLUSTRATION,
    inputBasis: 'HISTORICAL_PROVIDER_FACT_PLUS_EXPLICIT_TAX_INPUTS',
    holdingPeriodBasis: holdingPeriodBasis === 'EXACT_TRANSACTION_DATES'
      ? holdingPeriodBasis
      : capitalGains.holdingPeriodBasis,
    dataClass: 'HISTORICAL_PROVIDER_FACT',
    assumptions: [...assumptions, 'HISTORICAL_RETURN_IS_NOT_A_FORECAST', 'STT_CONDITION_ASSUMED_SATISFIED_FOR_HYPOTHETICAL_TRANSFER'],
    metricLabel: 'Historical 1Y after-tax return',
    disclosure: `HISTORICAL — NOT A FORECAST. The provider return window is a verified 1-year observation; it is not the user's realized gain or a future return. ${capitalGains.taxClass === 'EQUITY_LTCG_SECTION_112A' ? 'Equity long-term capital-gains treatment uses the explicit holding period and remaining taxpayer-level annual exemption.' : 'Equity short-term capital-gains treatment uses the explicit holding period.'} This hypothetical illustration assumes, but does not verify, that the applicable STT condition is met for the transfer. Special-rate tax is separate from ordinary slab tax and applicable rebate rules.`,
    isHistoricalEstimate: true,
    historicalObservationWindowMonths: 12,
    rulesApplied: capitalGains.rulesApplied,
    legacyRuleAliases: capitalGains.taxRuleMetadata?.legacyAliases || [],
  });
}

/**
 * Deterministically generate plain-English "Why this fits you", risk tier,
 * and access-to-money copy based on profile goals, horizon, and suitability.
 */
function evidenceSourceMatches(evidenceSource, productSource) {
  if (!evidenceSource || !productSource) return false;
  const fields = ['provider', 'instrumentId', 'url'];
  if (!fields.every(field => typeof evidenceSource[field] === 'string'
      && evidenceSource[field].trim()
      && evidenceSource[field] === productSource[field])) return false;
  try {
    const url = new URL(evidenceSource.url);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function evidenceIsFreshAndBound(evidence, product, expectedScope, now) {
  if (evidence?.status !== 'VERIFIED'
      || evidence.scope !== expectedScope
      || typeof product?.canonicalProductId !== 'string'
      || !product.canonicalProductId.trim()
      || evidence.canonicalProductId !== product.canonicalProductId
      || !evidenceSourceMatches(evidence.source, product.source)
      || evidence.freshness?.status !== 'FRESH'
      || !isFiniteNumber(evidence.freshness?.maxAgeSeconds)
      || evidence.freshness.maxAgeSeconds <= 0) return false;
  const observedAt = Date.parse(evidence.observedAt);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(observedAt) || !Number.isFinite(nowMs) || observedAt > nowMs) return false;
  return nowMs - observedAt <= evidence.freshness.maxAgeSeconds * 1000;
}

function hasFreshQualifiedProductSource(product) {
  return evidenceSourceMatches(product?.source, product?.source)
    && product?.freshness?.status === 'FRESH';
}

function verifiedProductRisk(product, now) {
  const evidence = product?.riskEvidence;
  if (!evidenceIsFreshAndBound(evidence, product, 'PRODUCT_SPECIFIC', now)
      || typeof evidence.level !== 'string' || !evidence.level.trim() || evidence.level.length > 100
      || typeof evidence.ratingSystem !== 'string' || !evidence.ratingSystem.trim() || evidence.ratingSystem.length > 100) {
    return {
      status: 'UNAVAILABLE', scope: 'PRODUCT_SPECIFIC', level: null, ratingSystem: null,
      source: null, observedAt: null,
    };
  }
  return {
    status: 'VERIFIED', scope: 'PRODUCT_SPECIFIC', level: evidence.level.trim(),
    ratingSystem: evidence.ratingSystem.trim(), source: { ...evidence.source }, observedAt: evidence.observedAt,
  };
}

function verifiedProductAccessTerms(product, profile, now) {
  const evidence = product?.accessTermsEvidence;
  if (!evidenceIsFreshAndBound(evidence, product, 'PRODUCT_ACCESS_TERMS', now)
      || typeof evidence.summary !== 'string' || !evidence.summary.trim() || evidence.summary.trim().length > 500) {
    return { status: 'UNAVAILABLE', scope: 'PRODUCT_SPECIFIC', summary: null, source: null, observedAt: null };
  }
  const applicability = evidence.applicability;
  if (applicability !== undefined) {
    const minimumAge = applicability?.minimumAge;
    const maximumAge = applicability?.maximumAge;
    if ((minimumAge !== undefined && (!Number.isInteger(minimumAge) || minimumAge < 0 || minimumAge > 120))
        || (maximumAge !== undefined && (!Number.isInteger(maximumAge) || maximumAge < 0 || maximumAge > 120))
        || (minimumAge !== undefined && maximumAge !== undefined && minimumAge > maximumAge)) {
      return { status: 'UNAVAILABLE', scope: 'PRODUCT_SPECIFIC', summary: null, source: null, observedAt: null };
    }
    const age = profile?.age;
    if (!Number.isInteger(age) || age < 0 || age > 120) {
      return { status: 'UNAVAILABLE', scope: 'PRODUCT_SPECIFIC', summary: null, source: null, observedAt: null };
    }
    if ((minimumAge !== undefined && age < minimumAge) || (maximumAge !== undefined && age > maximumAge)) {
      return { status: 'NOT_APPLICABLE_TO_PROFILE', scope: 'PRODUCT_SPECIFIC', summary: null, source: null, observedAt: null };
    }
  }
  return {
    status: 'VERIFIED', scope: 'PRODUCT_SPECIFIC', summary: evidence.summary.trim(),
    source: { ...evidence.source }, observedAt: evidence.observedAt,
  };
}

/**
 * Present parent-category suitability separately from source-qualified,
 * product-specific risk and access terms. Missing product evidence stays unknown.
 */
export function generateBeginnerSuitability({ product, profile = {}, parentCatalog = null, now = new Date() }) {
  const parentName = parentCatalog?.name || parentCatalog?.id || 'selected category';
  const parentRiskScore = isFiniteNumber(parentCatalog?.riskScore) ? parentCatalog.riskScore : null;
  const parentCategorySuitability = {
    status: parentCatalog?.suitabilityStatus === 'PASSED' ? 'PASSED' : 'NOT_ESTABLISHED',
    scope: 'PARENT_CATEGORY_ONLY',
  };
  const parentCategoryRisk = {
    status: parentRiskScore === null ? 'UNAVAILABLE' : 'AVAILABLE',
    riskScore: parentRiskScore,
    basis: 'WEALTHGENIE_PARENT_CATEGORY_RISK_MODEL',
    scope: 'PARENT_CATEGORY_ONLY',
  };
  const productRiskClassification = verifiedProductRisk(product, now);
  const productAccessTerms = verifiedProductAccessTerms(product, profile, now);
  const whyThisFitsYou = parentCategorySuitability.status === 'PASSED'
    ? `The ${parentName} category passed the profile suitability check in the current plan. That category-level check does not establish this product's individual eligibility, risk rating, or redemption terms.`
    : `This product is shown under ${parentName}. Individual-product suitability, eligibility, risk rating, and redemption terms have not been established.`;

  let verifiedFactLabel = 'Verified fact unavailable';
  let verifiedFactValue = 'Unavailable';
  const hasFreshQualifiedSource = hasFreshQualifiedProductSource(product);
  const officialRate = product?.officialRate;
  const officialRateDataClass = officialRate?.dataClass;
  const officialRateBasis = officialRate?.basis;
  const productFactAvailable = product?.availabilityStatus === 'AVAILABLE';
  const hasQualifiedOfficialRate = hasFreshQualifiedSource
    && productFactAvailable
    && typeof officialRateDataClass === 'string'
    && (officialRateDataClass.startsWith('OFFICIAL_') || officialRateDataClass === 'QUARTERLY_OFFICIAL_RATE')
    && typeof officialRateBasis === 'string'
    && (officialRateBasis.startsWith('OFFICIAL_') || officialRateBasis === 'NSC_REFERENCE_RATE_PLUS_35_BPS')
    && isFiniteNumber(officialRate.value)
    && officialRate.value >= 0;
  const historicalReturn = product?.historicalReturn;
  const hasQualifiedHistoricalReturn = hasFreshQualifiedSource
    && productFactAvailable
    && product?.source?.provider === 'AMFI'
    && historicalReturn?.basis === 'HISTORICAL_POINT_TO_POINT_NAV_RETURN_1Y'
    && isFiniteNumber(historicalReturn?.valuePct);
  const nav = product?.nav;
  const hasQualifiedNav = hasFreshQualifiedSource
    && productFactAvailable
    && product?.source?.provider === 'AMFI'
    && nav?.unit === 'NAV_PER_UNIT'
    && isFiniteNumber(nav?.value)
    && nav.value > 0;
  if (hasQualifiedOfficialRate) {
    const parentId = String(product?.parentInstrumentId || parentCatalog?.id || '').toLowerCase();
    if (parentId === 'rbi_bonds') verifiedFactLabel = 'Current RBI bond coupon';
    else if (parentId === 'fd' || parentId === 'sbi_fd') verifiedFactLabel = 'Current official bank rate';
    else verifiedFactLabel = 'Current official rate';
    verifiedFactValue = `${officialRate.value.toFixed(2)}% p.a.`;
  } else if (hasQualifiedHistoricalReturn) {
    verifiedFactLabel = 'Historical 1Y return';
    verifiedFactValue = `${historicalReturn.valuePct.toFixed(2)}% historical`;
  } else if (hasQualifiedNav) {
    verifiedFactLabel = 'Current NAV';
    verifiedFactValue = `₹${nav.value.toLocaleString('en-IN')}`;
  }

  return {
    whyThisFitsYou,
    riskTier: productRiskClassification.status === 'VERIFIED'
      ? productRiskClassification.level
      : 'Product-specific risk unavailable',
    accessToMoney: productAccessTerms.status === 'VERIFIED'
      ? productAccessTerms.summary
      : 'Product-specific access terms unavailable',
    parentCategorySuitability,
    parentCategoryRisk,
    productSpecificSuitability: { status: 'NOT_ESTABLISHED', scope: 'PRODUCT_SPECIFIC' },
    productRiskClassification,
    productAccessTerms,
    verifiedFactLabel,
    verifiedFactValue,
    sourceProvider: hasFreshQualifiedSource ? product.source.provider : 'Source unavailable',
  };
}

/**
 * Enriches product DTOs with beginner suitability and defensible post-tax outcomes.
 */
export function enrichProductsWithPostTaxAndSuitability(products, {
  profile = {},
  parentCatalog = null,
  taxCalculationContext = null,
  enforceSourceRights = process.env.NODE_ENV === 'production',
  sourceRightsResolver = resolvePostTaxProductRights,
} = {}) {
  if (!Array.isArray(products)) return [];

  return products.map((product) => {
    const beginnerSuitability = generateBeginnerSuitability({ product, profile, parentCatalog });
    const taxMetadata = getProductTaxMetadata(product, product?.parentInstrumentId);
    const postTaxSourceRights = sourceRightsResolver(product);
    const rightsBlock = enforceSourceRights && !postTaxSourceRights.productionPostTaxUseAllowed;
    const postTaxAnalysis = rightsBlock
      ? {
        ...createAnalysis({
          status: PRODUCT_TAX_STATUSES.SOURCE_RIGHTS_UNQUALIFIED,
          taxMetadata,
          principal: null,
          calculationClass: 'UNAVAILABLE',
          dataClass: 'UNAVAILABLE',
          unavailableReasons: ['POST_TAX_SOURCE_RIGHTS_UNQUALIFIED'],
          disclosure: 'This provider data is not cleared for WealthGenie production display and post-tax calculations. No sourced amount is shown until the exact data-use permission is qualified.',
        }),
        sourceRights: postTaxSourceRights,
      }
      : {
        ...calculateProductPostTaxOutcome({ product, profile, taxCalculationContext }),
        sourceRights: postTaxSourceRights,
      };

    return {
      ...product,
      beginnerSuitability,
      taxMetadata,
      postTaxAnalysis,
      postTaxSourceRights,
      // WTI's generic postTaxReturn field is intentionally not overloaded with
      // product tax authority. Consumers must use postTaxAnalysis explicitly.
      postTaxReturn: null,
    };
  });
}
