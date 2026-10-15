import {
  classifyHoldingPeriodByDates,
  computeEquityCapitalGainsTax,
  computeTax,
  getCapitalGainsHoldingPeriodMonths,
  getTaxPolicyMetadata,
  isFYVerified,
} from './taxEngine.js';
import {
  getUserScenarioTaxMetadata,
  POST_TAX_CALCULATION_CLASSES,
  PRODUCT_TAX_CLASSES,
} from './productTaxAuthority.js';

const INTEREST_SCENARIO_PARENTS = new Set(['fd', 'sbi_fd', 'rbi_bonds', 'sgb']);
const EQUITY_SCENARIO_PARENTS = new Set(['nifty_etf']);

export function getUserDeclaredScenarioCapability(parentInstrumentId) {
  if (INTEREST_SCENARIO_PARENTS.has(parentInstrumentId)) {
    const metadata = getUserScenarioTaxMetadata(parentInstrumentId);
    return {
      status: metadata.sourceQualified ? 'IMPLEMENTED' : 'TAX_CLASSIFICATION_UNAVAILABLE',
      scenarioTypes: metadata.sourceQualified ? ['INTEREST_INCOME'] : [],
      taxClass: metadata.taxClass,
      productIdentityScope: 'PARENT_INSTRUMENT_TAX_CLASS',
      requiresProviderData: false,
      limitation: parentInstrumentId === 'sgb'
        ? 'Taxable user-declared coupon interest only; no SGB redemption gain calculation.'
        : 'User-declared taxable interest only; no rate or return is inferred.',
    };
  }
  if (EQUITY_SCENARIO_PARENTS.has(parentInstrumentId)) {
    const canonicalProductId = 'etf:isin:INF204KB14I2';
    const metadata = getUserScenarioTaxMetadata(parentInstrumentId, canonicalProductId);
    return {
      status: metadata.sourceQualified ? 'IMPLEMENTED' : 'TAX_CLASSIFICATION_UNAVAILABLE',
      scenarioTypes: metadata.sourceQualified ? ['EQUITY_REALIZED_GAIN'] : [],
      taxClass: metadata.taxClass,
      productIdentityScope: metadata.sourceQualified ? 'EXACT_CANONICAL_PRODUCT' : null,
      canonicalProductId,
      requiresProviderData: false,
      limitation: 'Exact Nippon India ETF Nifty 50 BeES user-declared cost basis and sale scenario only.',
    };
  }
  if (parentInstrumentId === 'ppf' || parentInstrumentId === 'sukanya') {
    return {
      status: 'REQUIRES_QUALIFIED_ACCOUNT_FACTS',
      scenarioTypes: [],
      taxClass: getUserScenarioTaxMetadata(parentInstrumentId).taxClass,
      productIdentityScope: 'ACCOUNT_SPECIFIC',
      requiresProviderData: false,
      limitation: 'Account eligibility and contribution/payment/withdrawal facts are required before a result can be calculated.',
    };
  }
  return {
    status: 'TAX_CLASSIFICATION_UNAVAILABLE',
    scenarioTypes: [],
    taxClass: null,
    productIdentityScope: null,
    requiresProviderData: false,
    limitation: 'An exact qualified product tax class is not available for user-entered scenarios.',
  };
}

function unavailable({ input, status, reason, taxMetadata, policy = null, grossGain = null, holdingPeriod = null }) {
  return {
    status,
    calculationClass: POST_TAX_CALCULATION_CLASSES.TRANSACTION_TAX_ESTIMATE,
    dataClass: 'USER_DECLARED_TRANSACTION',
    inputBasis: 'USER_DECLARED_SCENARIO',
    canonicalInstrumentId: input?.canonicalInstrumentId || null,
    canonicalProductId: input?.canonicalProductId || null,
    taxClass: taxMetadata?.taxClass || null,
    taxClassificationMetadata: taxMetadata,
    fiscalYear: policy?.fiscalYear || null,
    policyVersion: policy?.policyVersion || null,
    grossGain,
    taxableGain: null,
    incrementalTax: null,
    cess: null,
    surcharge: null,
    netGain: null,
    transactionGainPct: null,
    holdingPeriod,
    unavailableReasons: [reason],
    sourceReferences: [
      ...(taxMetadata?.sourceReferences || []),
      ...(policy?.sourceReferences || []),
    ],
    assumptions: ['USER_DECLARED_VALUES_NOT_SOURCE_VERIFIED'],
    disclosure: 'This scenario uses only values you entered. They are not verified market facts and do not authorize WealthGenie to retrieve, store, or display third-party product data.',
  };
}

function validTaxContext(input) {
  return Number.isFinite(input.annualGrossIncome)
    && input.annualGrossIncome >= 0
    && Number.isInteger(input.userAge)
    && input.userAge >= 18
    && input.userAge <= 120
    && ['new', 'old'].includes(input.regime)
    && ['salary', 'pension', 'family_pension', 'business', 'other'].includes(input.incomeSource)
    && typeof input.fiscalYear === 'string';
}

function taxContext(input) {
  return {
    annualGrossIncome: input.annualGrossIncome,
    regime: input.regime,
    incomeSource: input.incomeSource,
    fiscalYear: input.fiscalYear,
    userAge: input.userAge,
    deductions: input.deductions || {},
  };
}

function fiscalYearForIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const fiscalYearStart = month >= 4 ? year : year - 1;
  return 'FY' + fiscalYearStart + '-' + String(fiscalYearStart + 1).slice(-2);
}

function calculateInterestScenario(input, taxMetadata, policy) {
  const grossGain = input.interestReceived;
  const context = taxContext(input);
  const baseline = computeTax(
    context.annualGrossIncome, context.regime, context.deductions,
    context.incomeSource, context.fiscalYear, context.userAge,
  );
  const withInterest = computeTax(
    context.annualGrossIncome + grossGain, context.regime, context.deductions,
    context.incomeSource, context.fiscalYear, context.userAge,
  );
  const incrementalTax = Math.max(0, withInterest.taxAmount - baseline.taxAmount);
  return {
    status: 'CALCULATED',
    calculationClass: POST_TAX_CALCULATION_CLASSES.TRANSACTION_TAX_ESTIMATE,
    dataClass: 'USER_DECLARED_TRANSACTION',
    inputBasis: 'USER_DECLARED_SCENARIO',
    canonicalInstrumentId: input.canonicalInstrumentId,
    canonicalProductId: null,
    taxClass: taxMetadata.taxClass,
    taxClassificationMetadata: taxMetadata,
    fiscalYear: policy.fiscalYear,
    policyVersion: policy.policyVersion,
    grossGain,
    taxableGain: grossGain,
    exemptionApplied: 0,
    incrementalTax,
    cess: Math.max(0, withInterest.cess - baseline.cess),
    surcharge: Math.max(0, withInterest.surchargeAmount - baseline.surchargeAmount),
    netGain: grossGain - incrementalTax,
    postTaxRatePct: null,
    transactionGainPct: null,
    holdingPeriod: null,
    sourceReferences: [
      ...(taxMetadata.sourceReferences || []),
      ...(policy.sourceReferences || []),
    ],
    rulesApplied: ['INCREMENTAL_TAX_BASELINE_AND_WITH_USER_DECLARED_INTEREST'],
    assumptions: ['USER_DECLARED_INTEREST_FOR_SELECTED_FISCAL_YEAR', 'INTEREST_AMOUNT_IS_BEFORE_TAX_WITHHELD'],
    unavailableReasons: [],
    disclosure: 'User-declared interest for the selected fiscal year, taxed by comparing your baseline liability with liability after adding that interest. These are not verified market facts; the calculation does not report a product rate or investment return.',
  };
}

function calculateEquityScenario(input, taxMetadata, policy) {
  const grossGain = input.saleProceeds - input.acquisitionCostBasis;
  const acquisitionFiscalYear = fiscalYearForIsoDate(input.acquisitionDate);
  if (!acquisitionFiscalYear) {
    return unavailable({
      input,
      status: 'UNAVAILABLE',
      reason: 'CAPITAL_GAINS_ACQUISITION_DATE_INVALID',
      taxMetadata,
      policy,
    });
  }
  const redemptionFiscalYear = fiscalYearForIsoDate(input.redemptionDate);
  if (!redemptionFiscalYear) {
    return unavailable({
      input,
      status: 'UNAVAILABLE',
      reason: 'CAPITAL_GAINS_REDEMPTION_DATE_INVALID',
      taxMetadata,
      policy,
    });
  }
  if (input.redemptionDate < input.acquisitionDate) {
    return unavailable({
      input,
      status: 'UNAVAILABLE',
      reason: 'CAPITAL_GAINS_TRANSACTION_DATE_ORDER_INVALID',
      taxMetadata,
      policy,
    });
  }
  if (redemptionFiscalYear !== policy.fiscalYear) {
    return unavailable({
      input,
      status: 'UNAVAILABLE',
      reason: 'CAPITAL_GAINS_REDEMPTION_FISCAL_YEAR_MISMATCH',
      taxMetadata,
      policy,
    });
  }
  const holdingPeriod = classifyHoldingPeriodByDates({
    acquisitionDate: input.acquisitionDate,
    redemptionDate: input.redemptionDate,
    thresholdMonths: getCapitalGainsHoldingPeriodMonths(input.fiscalYear, 'listed'),
  });
  const resultBase = {
    calculationClass: POST_TAX_CALCULATION_CLASSES.TRANSACTION_TAX_ESTIMATE,
    dataClass: 'USER_DECLARED_TRANSACTION',
    inputBasis: 'USER_DECLARED_SCENARIO',
    canonicalInstrumentId: input.canonicalInstrumentId,
    canonicalProductId: input.canonicalProductId,
    taxClass: taxMetadata.taxClass,
    taxClassificationMetadata: taxMetadata,
    fiscalYear: policy.fiscalYear,
    policyVersion: policy.policyVersion,
    grossGain,
    holdingPeriod,
    sourceReferences: [
      ...(taxMetadata.sourceReferences || []),
      ...(policy.sourceReferences || []),
    ],
    assumptions: ['USER_DECLARED_COST_BASIS_AND_SALE_CONSIDERATION', 'STT_CONDITION_ASSUMED_BY_USER_NOT_VERIFIED'],
  };
  if (input.sttConditionAssumedSatisfied !== true) {
    return {
      ...resultBase,
      status: 'UNAVAILABLE',
      taxableGain: null,
      incrementalTax: null,
      cess: null,
      surcharge: null,
      netGain: null,
      transactionGainPct: null,
      unavailableReasons: ['EQUITY_TRANSFER_STT_CONDITION_NOT_ESTABLISHED'],
      disclosure: 'The exact product class is known, but this scenario does not establish the applicable securities transaction tax condition. No transaction tax amount is calculated.',
    };
  }
  if (grossGain < 0) {
    return {
      ...resultBase,
      status: 'UNAVAILABLE',
      taxableGain: null,
      incrementalTax: null,
      cess: null,
      surcharge: null,
      netGain: null,
      transactionGainPct: null,
      unavailableReasons: ['CAPITAL_LOSS_SET_OFF_CONTEXT_REQUIRED'],
      disclosure: 'Your entered values show a capital loss. Loss set-off and carry-forward depend on the complete taxpayer transaction and filing context, so this tool does not calculate a tax benefit or net result.',
    };
  }

  const capitalGains = computeEquityCapitalGainsTax({
    grossGain,
    holdingPeriodClassification: holdingPeriod,
    annualIncome: input.annualGrossIncome,
    regime: input.regime,
    deductions: input.deductions || {},
    incomeSource: input.incomeSource,
    fiscalYear: input.fiscalYear,
    userAge: input.userAge,
    section112AExemptionUsed: input.section112AExemptionUsed,
  });
  if (capitalGains.status !== 'CALCULATED') {
    return {
      ...resultBase,
      status: 'UNAVAILABLE',
      taxableGain: capitalGains.taxableGain,
      incrementalTax: null,
      cess: null,
      surcharge: null,
      netGain: null,
      transactionGainPct: null,
      unavailableReasons: capitalGains.unavailableReasons || ['TRANSACTION_TAX_UNAVAILABLE'],
      disclosure: 'The backend tax policy requires additional taxpayer-wide facts or a fuller tax context. No tax amount is shown.',
    };
  }
  const netGain = grossGain - capitalGains.taxAmount;
  return {
    ...resultBase,
    status: 'CALCULATED',
    taxClass: capitalGains.taxClass,
    taxableGain: capitalGains.taxableGain,
    exemptionApplied: capitalGains.exemptionApplied,
    incrementalTax: capitalGains.taxAmount,
    cess: capitalGains.cess,
    surcharge: capitalGains.surcharge,
    netGain,
    transactionGainPct: input.acquisitionCostBasis > 0
      ? Number(((netGain / input.acquisitionCostBasis) * 100).toFixed(2))
      : null,
    holdingPeriod: {
      ...holdingPeriod,
      basis: 'EXACT_USER_DECLARED_TRANSACTION_DATES',
    },
    rulesApplied: capitalGains.rulesApplied || [],
    unavailableReasons: [],
    disclosure: `User-declared NIFTYBEES cost basis, sale consideration, and dates. The ${holdingPeriod.isLongTerm ? 'long-term' : 'short-term'} classification is based on the selected fiscal-year policy. This is a scenario estimate, not a filed tax assessment; STT was assumed as you specified and was not verified.`,
  };
}

export function calculateUserDeclaredPostTaxScenario(input) {
  if (!validTaxContext(input)) throw new TypeError('A complete, explicit tax context is required');
  const taxMetadata = getUserScenarioTaxMetadata(input.canonicalInstrumentId, input.canonicalProductId);
  if (!taxMetadata.sourceQualified || !taxMetadata.taxClass) {
    return unavailable({
      input,
      status: 'TAX_CLASSIFICATION_UNAVAILABLE',
      reason: taxMetadata.unavailableReason || 'TAX_CLASSIFICATION_UNAVAILABLE',
      taxMetadata,
    });
  }
  if (!isFYVerified(input.fiscalYear)) {
    return unavailable({
      input,
      status: 'FISCAL_YEAR_UNSUPPORTED',
      reason: 'FISCAL_YEAR_UNSUPPORTED',
      taxMetadata,
    });
  }
  const policy = getTaxPolicyMetadata(input.fiscalYear);

  if (input.scenarioType === 'INTEREST_INCOME'
      && INTEREST_SCENARIO_PARENTS.has(input.canonicalInstrumentId)
      && [PRODUCT_TAX_CLASSES.BANK_DEPOSIT_INTEREST, PRODUCT_TAX_CLASSES.RBI_FRSB_INTEREST, PRODUCT_TAX_CLASSES.SGB]
        .includes(taxMetadata.taxClass)) {
    return calculateInterestScenario(input, taxMetadata, policy);
  }
  if (input.scenarioType === 'EQUITY_REALIZED_GAIN'
      && EQUITY_SCENARIO_PARENTS.has(input.canonicalInstrumentId)
      && taxMetadata.taxClass === PRODUCT_TAX_CLASSES.EQUITY_MF_112A) {
    return calculateEquityScenario(input, taxMetadata, policy);
  }
  return unavailable({
    input,
    status: 'TAX_CLASSIFICATION_UNAVAILABLE',
    reason: 'SCENARIO_TYPE_NOT_SUPPORTED_FOR_QUALIFIED_PRODUCT_CLASS',
    taxMetadata,
    policy,
  });
}
