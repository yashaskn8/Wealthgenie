/**
 * Canonical post-tax model adapter and cash-flow/event engine.
 *
 * This module owns model mechanics only. Statutory rates, slabs, cess and
 * special-gain buckets are delegated to taxEngine.js. Instrument labels are
 * never parsed for tax meaning: the exact allow-list below is a server-owned
 * model mapping, and ambiguous classes fail closed.
 */

import {
  classifyHoldingPeriodByDates,
  computeCapitalGainsTaxBuckets,
  computeTax,
  getCapitalGainsHoldingPeriodMonths,
  getTaxPolicyMetadata,
} from './taxEngine.js';
import { buildTaxRuleMetadata } from './taxRuleMetadata.js';
import { toMonthlyRate } from './instrumentConstants.js';

export const MODEL_TAX_CLASSES = Object.freeze({
  CONDITIONAL_ACCOUNT_TREATMENT: 'MODEL_TAX_CLASS_CONDITIONAL_ACCOUNT_TREATMENT',
  ORDINARY_INTEREST: 'MODEL_TAX_CLASS_ORDINARY_INTEREST',
  EQUITY_112A: 'MODEL_TAX_CLASS_EQUITY_112A',
  OTHER_CAPITAL_GAINS: 'MODEL_TAX_CLASS_OTHER_CAPITAL_GAINS',
  SGB: 'MODEL_TAX_CLASS_SGB',
  NPS_EXIT: 'MODEL_TAX_CLASS_NPS_EXIT',
});

export const MODEL_POST_TAX_STATUSES = Object.freeze({
  CALCULATED: 'CALCULATED',
  REQUIRES_TAX_INPUTS: 'REQUIRES_TAX_INPUTS',
  TAX_CLASSIFICATION_REQUIRES_ACQUISITION_FACTS: 'TAX_CLASSIFICATION_REQUIRES_ACQUISITION_FACTS',
  MODEL_TAX_CLASS_UNAVAILABLE: 'MODEL_TAX_CLASS_UNAVAILABLE',
  PROJECTION_MODEL_UNAVAILABLE: 'MODELLED_POST_TAX_PROJECTION_UNAVAILABLE',
});

const SERVER_MODEL_TAX_CLASS_BY_INSTRUMENT = Object.freeze({
  FD: MODEL_TAX_CLASSES.ORDINARY_INTEREST,
  SCSS: MODEL_TAX_CLASSES.ORDINARY_INTEREST,
  RBI_Bond: MODEL_TAX_CLASSES.ORDINARY_INTEREST,
  'G-Sec': MODEL_TAX_CLASSES.ORDINARY_INTEREST,
  PPF: MODEL_TAX_CLASSES.CONDITIONAL_ACCOUNT_TREATMENT,
  SSY: MODEL_TAX_CLASSES.CONDITIONAL_ACCOUNT_TREATMENT,
  ELSS: MODEL_TAX_CLASSES.EQUITY_112A,
  Equity_MF: MODEL_TAX_CLASSES.EQUITY_112A,
  Gold: MODEL_TAX_CLASSES.OTHER_CAPITAL_GAINS,
  Gold_Physical: MODEL_TAX_CLASSES.OTHER_CAPITAL_GAINS,
  SGB: MODEL_TAX_CLASSES.SGB,
  NPS: MODEL_TAX_CLASSES.NPS_EXIT,
});

// These are known presentation/model keys, but their tax class is not
// defensible without provider-qualified metadata. They must not silently map
// to equity or Section 50AA merely because of a familiar product name.
const AMBIGUOUS_MODEL_INSTRUMENT_TYPES = new Set([
  'ETF', 'Debt_MF', 'Liquid_MF', 'Arbitrage_MF', 'Index_MF', 'Midcap_MF',
  'Smallcap_MF', 'Balanced_Advantage', 'Hybrid_MF', 'Gold_ETF',
]);

export function resolveServerModelTaxClass(instrumentType) {
  return SERVER_MODEL_TAX_CLASS_BY_INSTRUMENT[instrumentType] || null;
}

export function isKnownModelInstrumentType(instrumentType) {
  return AMBIGUOUS_MODEL_INSTRUMENT_TYPES.has(instrumentType)
    || Object.prototype.hasOwnProperty.call(SERVER_MODEL_TAX_CLASS_BY_INSTRUMENT, instrumentType);
}

function round4(value) {
  return Number(value.toFixed(4));
}

function combineTaxRuleMetadata(policy, metadataEntries = []) {
  if (!policy?.statuteMetadata) return null;
  const entries = metadataEntries.filter(Boolean);
  const identifiers = [...new Set(entries.flatMap(entry => entry.rulesApplied || []))];
  const combined = buildTaxRuleMetadata({ statuteMetadata: policy.statuteMetadata, identifiers });
  if (!combined) return null;
  return {
    ...combined,
    legacyAliases: [...new Set(entries.flatMap(entry => entry.legacyAliases || []))],
  };
}

function requireNumber(value, name, { min = 0, max = Infinity, integer = false } = {}) {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new TypeError(`${name} must be an explicit finite number`);
  }
  return value;
}

function addMonths(date, months) {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return target;
}

function parseDate(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`${name} must be an ISO calendar date (YYYY-MM-DD)`);
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new RangeError(`${name} must be a real calendar date`);
  }
  return date;
}

function taxContext(context = {}) {
  const userAge = Number.isInteger(context.userAge) && context.userAge >= 18 && context.userAge <= 120
    ? context.userAge : null;
  const deductions = { ...(context.deductions || {}) };
  if (userAge !== null) deductions.age = userAge;
  return {
    // Never coerce null/empty investor financial data to a valid zero-income fact.
    annualIncome: typeof context.annualGrossIncome === 'number'
      && Number.isFinite(context.annualGrossIncome) && context.annualGrossIncome >= 0
      ? context.annualGrossIncome : null,
    regime: context.regime,
    incomeSource: context.incomeSource,
    fiscalYear: context.fiscalYear,
    userAge: Number.isInteger(userAge) ? userAge : undefined,
    deductions,
    section112AExemptionUsed: context.section112AExemptionUsed,
    section112AExemptionAppliedOverride: context.section112AExemptionAppliedOverride ?? null,
  };
}

function missingContext(context, modelTaxClass, options = {}) {
  const required = ['annualGrossIncome', 'incomeSource', 'regime', 'fiscalYear', 'userAge'];
  if (modelTaxClass === MODEL_TAX_CLASSES.EQUITY_112A
      || modelTaxClass === MODEL_TAX_CLASSES.OTHER_CAPITAL_GAINS
      || modelTaxClass === MODEL_TAX_CLASSES.SGB) {
    required.push('holdingPeriod');
  }
  if (modelTaxClass === MODEL_TAX_CLASSES.EQUITY_112A) {
    required.push('section112AExemptionUsed');
  }
  if (modelTaxClass === MODEL_TAX_CLASSES.NPS_EXIT) {
    required.push('annuityFraction', 'retirementTiming');
  }
  const missing = required.filter(key => {
    if (key === 'annualGrossIncome') return typeof context?.annualGrossIncome !== 'number'
      || !Number.isFinite(context.annualGrossIncome) || context.annualGrossIncome < 0;
    if (key === 'userAge') return !Number.isInteger(context?.userAge)
      || context.userAge < 18 || context.userAge > 120;
    if (key === 'section112AExemptionUsed') {
      return !Number.isFinite(context?.section112AExemptionUsed) || context.section112AExemptionUsed < 0;
    }
    if (key === 'holdingPeriod') {
      const hasDates = context?.acquisitionDate !== undefined || context?.redemptionDate !== undefined;
      return hasDates
        ? !context?.acquisitionDate || !context?.redemptionDate
        : !Number.isFinite(Number(context?.holdingPeriodMonths)) && !Number.isFinite(Number(options?.holdingYears));
    }
    if (key === 'section112AExemptionUsed') {
      const used = context?.section112AExemptionUsed;
      return used === undefined || used === null || used === ''
        || !Number.isFinite(Number(used)) || Number(used) < 0;
    }
    if (key === 'annuityFraction') return !Number.isFinite(Number(options?.annuityFraction));
    if (key === 'retirementTiming') return !options?.retirementTiming;
    return context?.[key] === undefined || context?.[key] === null || context?.[key] === '';
  });
  return [...new Set(missing)];
}

function isLongTermForModeledMonths(holdingPeriodMonths, thresholdMonths) {
  return holdingPeriodMonths > thresholdMonths;
}

function holdingClassification({ context, options, fiscalYear, assetType = 'other', holdingYears }) {
  const acquisitionDate = context?.acquisitionDate ?? options?.acquisitionDate;
  const redemptionDate = context?.redemptionDate ?? options?.redemptionDate;
  const thresholdMonths = getCapitalGainsHoldingPeriodMonths(fiscalYear, assetType);
  if (acquisitionDate || redemptionDate) {
    if (!acquisitionDate || !redemptionDate) {
      return { unavailable: 'ACQUISITION_AND_REDEMPTION_DATES_REQUIRED_TOGETHER' };
    }
    return classifyHoldingPeriodByDates({ acquisitionDate, redemptionDate, thresholdMonths });
  }
  const holdingPeriodMonths = Number(
    context?.holdingPeriodMonths
      ?? (Number.isFinite(Number(options?.holdingYears)) ? Number(options.holdingYears) * 12 : Number(holdingYears) * 12),
  );
  if (!Number.isFinite(holdingPeriodMonths) || holdingPeriodMonths < 0) {
    return { unavailable: 'EXPLICIT_HOLDING_PERIOD_REQUIRED' };
  }
  return {
    isLongTerm: isLongTermForModeledMonths(holdingPeriodMonths, thresholdMonths),
    holdingPeriodMonths,
    thresholdMonths,
    holdingPeriodBasis: 'MODELLED_HOLDING_PERIOD',
  };
}

export function buildMonthlySipLots({ monthlySIP, annualRate, holdingYears, acquisitionDate, redemptionDate }) {
  requireNumber(monthlySIP, 'monthlySIP');
  requireNumber(annualRate, 'annualRate', { min: 0, max: 1 });
  requireNumber(holdingYears, 'holdingYears', { min: 0.01, max: 100 });
  const monthlyRate = toMonthlyRate(annualRate);
  const acquired = acquisitionDate ? parseDate(acquisitionDate, 'acquisitionDate') : null;
  const redeemed = redemptionDate ? parseDate(redemptionDate, 'redemptionDate') : null;
  if (Boolean(acquired) !== Boolean(redeemed)) {
    throw new TypeError('acquisitionDate and redemptionDate must be supplied together');
  }
  if (acquired && redeemed < acquired) throw new RangeError('redemptionDate cannot precede acquisitionDate');
  let totalMonths = Math.max(1, Math.round(holdingYears * 12));
  if (acquired) {
    // Exact transaction dates own the modeled SIP horizon. Count completed
    // calendar anniversaries, so no generated lot can be acquired after exit.
    totalMonths = 0;
    while (totalMonths < 1200 && addMonths(acquired, totalMonths + 1) <= redeemed) {
      totalMonths += 1;
    }
    totalMonths = Math.max(1, totalMonths);
  }

  return Array.from({ length: totalMonths }, (_, index) => {
    const lotAcquisitionDate = acquired ? addMonths(acquired, index) : null;
    if (lotAcquisitionDate && lotAcquisitionDate > redeemed) {
      throw new RangeError('modeled SIP lot acquisition cannot occur after redemption');
    }
    const monthsHeld = totalMonths - index;
    const cost = monthlySIP;
    const value = cost * Math.pow(1 + monthlyRate, monthsHeld);
    const lot = {
      lotNumber: index + 1,
      cost,
      value,
      gain: Math.max(0, value - cost),
      holdingPeriodMonths: monthsHeld,
      acquisitionDate: lotAcquisitionDate?.toISOString().slice(0, 10) || null,
      redemptionDate: redeemed?.toISOString().slice(0, 10) || null,
      holdingPeriodBasis: acquired ? 'EXACT_TRANSACTION_DATES' : 'MODELLED_MONTHLY_LOTS',
    };
    return lot;
  });
}

function calculateOrdinaryIncrementalTax({ grossGain, context }) {
  const values = taxContext(context);
  const baseline = computeTax(
    values.annualIncome, values.regime, values.deductions, values.incomeSource,
    values.fiscalYear, values.userAge,
  );
  const withGain = computeTax(
    values.annualIncome + grossGain, values.regime, values.deductions, values.incomeSource,
    values.fiscalYear, values.userAge,
  );
  return {
    status: 'CALCULATED',
    taxAmount: Math.max(0, withGain.taxAmount - baseline.taxAmount),
    cess: Math.max(0, withGain.cess - baseline.cess),
    surcharge: Math.max(0, withGain.surchargeAmount - baseline.surchargeAmount),
    baseline,
    withGain,
  };
}

function unavailableResult({ instrumentType, modelTaxClass = null, status = MODEL_POST_TAX_STATUSES.PROJECTION_MODEL_UNAVAILABLE, reasons, fiscalYear = null, policy = null }) {
  const taxRuleMetadata = policy
    ? buildTaxRuleMetadata({ statuteMetadata: policy.statuteMetadata })
    : null;
  return {
    status,
    instrumentType,
    modelTaxClass,
    taxClass: modelTaxClass,
    grossGain: null,
    taxableGain: null,
    netGain: null,
    postTaxReturn: null,
    effectiveYield: null,
    taxRate: null,
    taxType: 'Tax result unavailable',
    calculationClass: 'MODELLED_POST_TAX_PROJECTION',
    dataClass: 'MODEL_ASSUMPTION',
    fiscalYear,
    policyVersion: policy?.policyVersion || null,
    statuteMetadata: policy?.statuteMetadata || null,
    sourceReferences: policy?.sourceReferences || [],
    taxRuleMetadata,
    incrementalTax: null,
    cess: null,
    surcharge: null,
    assumptions: [],
    unavailableReasons: reasons,
    notes: 'No post-tax number is shown because the backend lacks a qualified tax class or required inputs.',
  };
}

function finalizeOutcome({ instrumentType, modelTaxClass, nominalRate, grossGain, taxAmount, cess, surcharge, taxType, holdingPeriodBasis, assumptions = [], details = {}, notes = '', policy = null, taxRuleMetadata = null }) {
  const safeGrossGain = Math.max(0, grossGain);
  const safeTax = Math.max(0, Math.min(safeGrossGain, taxAmount));
  const taxRate = safeGrossGain > 0 ? safeTax / safeGrossGain : 0;
  const postTaxReturn = nominalRate * (1 - taxRate);
  return {
    status: MODEL_POST_TAX_STATUSES.CALCULATED,
    instrumentType,
    modelTaxClass,
    taxClass: modelTaxClass,
    postTaxReturn: round4(Math.max(0, Math.min(nominalRate, postTaxReturn))),
    effectiveYield: round4(Math.max(0, Math.min(nominalRate, postTaxReturn)) * 100),
    taxType,
    taxRate: round4(taxRate),
    grossGain: safeGrossGain,
    taxableGain: safeGrossGain,
    incrementalTax: Math.round(safeTax),
    cess: Math.round(Math.max(0, cess || 0)),
    surcharge: Math.round(Math.max(0, surcharge || 0)),
    netGain: Math.max(0, safeGrossGain - safeTax),
    holdingPeriodBasis: holdingPeriodBasis || null,
    calculationClass: 'MODELLED_POST_TAX_PROJECTION',
    dataClass: 'MODEL_ASSUMPTION',
    fiscalYear: policy?.fiscalYear || null,
    policyVersion: policy?.policyVersion || null,
    statuteMetadata: policy?.statuteMetadata || null,
    sourceReferences: policy?.sourceReferences || [],
    taxRuleMetadata: taxRuleMetadata || (policy
      ? buildTaxRuleMetadata({ statuteMetadata: policy.statuteMetadata })
      : null),
    assumptions,
    unavailableReasons: [],
    ...details,
    notes,
  };
}

function assessInterestTds({ instrumentType, grossGain, userAge, policy }) {
  if (instrumentType === 'G-Sec') {
    return {
      tdsApplicable: null,
      tdsRate: null,
      tdsThreshold: null,
      tdsTreatment: 'SECURITY_IDENTITY_REQUIRED',
      taxRuleIdentifier: null,
    };
  }

  const securityInterest = instrumentType === 'RBI_Bond';
  const tdsThreshold = securityInterest
    ? policy.rules.securityInterestTdsThreshold
    : userAge >= 60
      ? policy.rules.bankInterestTdsThreshold.senior
      : policy.rules.bankInterestTdsThreshold.general;
  const tdsApplicable = grossGain > tdsThreshold;
  const currentStatute = policy.statuteMetadata?.statute === 'INCOME_TAX_ACT_2025';
  const taxRuleIdentifier = securityInterest
    ? currentStatute ? 'SECURITY_INTEREST_TDS_THRESHOLD' : `${policy.fiscalYear}_SECURITY_INTEREST_TDS`
    : currentStatute ? 'BANK_INTEREST_TDS_THRESHOLD' : `${policy.fiscalYear}_BANK_INTEREST_TDS`;
  return {
    tdsApplicable,
    tdsRate: tdsApplicable
      ? securityInterest ? policy.rules.securityInterestTdsRate : policy.rules.bankInterestTdsRate
      : 0,
    tdsThreshold,
    tdsTreatment: securityInterest ? 'FRSB_SECURITY_INTEREST' : 'BANK_OR_NOTIFIED_DEPOSIT_INTEREST',
    taxRuleIdentifier,
  };
}

export function calculateCanonicalPostTaxOutcome({ instrumentType, nominalRate, annualIncome, holdingYears, regime, monthlySIP, userAge, incomeSource, fiscalYear, deductions = {}, options = {} }) {
  // Refuse every legacy tax context before any model or tax computation.
  // Do not silently relabel historical 'old' contexts as 'new'.
  if (regime !== 'new') return unavailableResult({
    instrumentType,
    status: MODEL_POST_TAX_STATUSES.REQUIRES_TAX_INPUTS,
    reasons: ['UNSUPPORTED_TAX_REGIME_NEW_ONLY'],
    fiscalYear,
  });
  const modelTaxClass = resolveServerModelTaxClass(instrumentType);
  if (!modelTaxClass) {
    if (!isKnownModelInstrumentType(instrumentType)) {
      throw new RangeError(`Unsupported instrument type: ${instrumentType}`);
    }
    return unavailableResult({
      instrumentType,
      status: MODEL_POST_TAX_STATUSES.MODEL_TAX_CLASS_UNAVAILABLE,
      reasons: ['MODEL_TAX_CLASS_UNAVAILABLE_FOR_GENERIC_INSTRUMENT_TYPE'],
      fiscalYear,
    });
  }
  const policy = getTaxPolicyMetadata(fiscalYear);
  if (modelTaxClass === MODEL_TAX_CLASSES.CONDITIONAL_ACCOUNT_TREATMENT) {
    return unavailableResult({
      instrumentType,
      modelTaxClass,
      status: MODEL_POST_TAX_STATUSES.TAX_CLASSIFICATION_REQUIRES_ACQUISITION_FACTS,
      reasons: ['PPF_SSY_EXCLUSION_ELIGIBILITY_NOT_ESTABLISHED', 'VERIFIED_ACCOUNT_AND_PAYMENT_FACTS_REQUIRED'],
      fiscalYear,
      policy,
    });
  }
  requireNumber(nominalRate, 'nominalRate', { min: 0, max: 1 });
  requireNumber(annualIncome, 'annualIncome');
  requireNumber(holdingYears, 'holdingYears', { min: 0.01, max: 100 });
  requireNumber(monthlySIP, 'monthlySIP');
  if (!Number.isInteger(userAge) || userAge < 18 || userAge > 120) throw new TypeError('userAge must be an integer from 18 to 120');
  if (!['salary', 'pension', 'family_pension', 'business', 'other'].includes(incomeSource)) throw new TypeError('incomeSource must be explicitly provided');
  const context = { annualGrossIncome: annualIncome, regime, incomeSource, fiscalYear, userAge, deductions, holdingPeriodMonths: options.holdingPeriodMonths, acquisitionDate: options.acquisitionDate, redemptionDate: options.redemptionDate, section112AExemptionUsed: options.section112AExemptionUsed, section112AExemptionAppliedOverride: options.section112AExemptionAppliedOverride };
  const taxInputs = taxContext(context);
  const missing = missingContext(context, modelTaxClass, { ...options, holdingYears });
  if (missing.length > 0) {
    return unavailableResult({ instrumentType, modelTaxClass, status: MODEL_POST_TAX_STATUSES.REQUIRES_TAX_INPUTS, reasons: missing, fiscalYear, policy });
  }
  if (modelTaxClass === MODEL_TAX_CLASSES.ORDINARY_INTEREST) {
    const annualPrincipal = monthlySIP * 12;
    const grossGain = annualPrincipal * nominalRate;
    const tax = calculateOrdinaryIncrementalTax({ grossGain, context });
    const tdsAssessment = assessInterestTds({ instrumentType, grossGain, userAge, policy });
    const { taxRuleIdentifier, ...tdsDetails } = tdsAssessment;
    return finalizeOutcome({
      instrumentType, modelTaxClass, nominalRate, grossGain, taxAmount: tax.taxAmount, cess: tax.cess, surcharge: tax.surcharge,
      taxType: 'Ordinary income — incremental tax under selected regime',
      policy,
      taxRuleMetadata: combineTaxRuleMetadata(policy, [
        tax.baseline.taxRuleMetadata,
        tax.withGain.taxRuleMetadata,
        { rulesApplied: taxRuleIdentifier ? [taxRuleIdentifier] : [] },
      ]),
      assumptions: ['INCREMENTAL_TAX_BASELINE_AND_WITH_PRODUCT_INCOME', 'TDS_NOT_MODELLED_AS_SECOND_FINAL_TAX'],
      details: {
        ...tdsDetails,
        fiscalYear: policy.fiscalYear,
        policyVersion: policy.policyVersion,
      },
      notes: tdsAssessment.tdsTreatment === 'SECURITY_IDENTITY_REQUIRED'
        ? 'Gross interest is added to the supplied income context and taxed through baseline-versus-with-income tax. TDS is not assessed for a generic government security without its exact security identity and any applicable notification facts.'
        : 'Gross interest is added to the supplied income context and taxed through baseline-versus-with-income tax. TDS threshold comparison is a single-product illustration; actual withholding may depend on payer-level aggregation, valid declarations or certificates, and exact product facts. TDS is a credit, not an extra tax charge.',
    });
  }
  if (modelTaxClass === MODEL_TAX_CLASSES.NPS_EXIT) {
    const annuityFraction = Number(options.annuityFraction);
    if (!Number.isFinite(annuityFraction) || annuityFraction < 0 || annuityFraction > 1 || !options.retirementTiming) {
      return unavailableResult({ instrumentType, modelTaxClass, status: MODEL_POST_TAX_STATUSES.REQUIRES_TAX_INPUTS, reasons: ['annuityFraction', 'retirementTiming'], fiscalYear, policy });
    }
    const grossGain = monthlySIP * 12 * nominalRate;
    const tax = calculateOrdinaryIncrementalTax({ grossGain: grossGain * annuityFraction, context });
    return finalizeOutcome({
      instrumentType, modelTaxClass, nominalRate, grossGain, taxAmount: tax.taxAmount, cess: tax.cess, surcharge: tax.surcharge,
      taxType: 'Modeled NPS exit scenario', holdingPeriodBasis: 'MODELLED_RETIREMENT_TIMING',
      policy,
      taxRuleMetadata: combineTaxRuleMetadata(policy, [tax.baseline.taxRuleMetadata, tax.withGain.taxRuleMetadata]),
      assumptions: ['MODELLED_NPS_EXIT_SCENARIO', 'ANNUITY_FRACTION_EXPLICIT', 'RETIREMENT_TIMING_EXPLICIT'],
      details: { annuityFraction, retirementTiming: options.retirementTiming, fiscalYear: policy.fiscalYear, policyVersion: policy.policyVersion },
      notes: 'This is a modeled exit scenario, not a statutory prediction of a future NPS corpus or annuity income.',
    });
  }
  if (modelTaxClass === MODEL_TAX_CLASSES.SGB) {
    const channel = options.redemptionChannel;
    const validChannels = ['RBI_REDEMPTION', 'MATURITY_REDEMPTION', 'SECONDARY_MARKET_SALE'];
    if (!validChannels.includes(channel)) {
      return unavailableResult({ instrumentType, modelTaxClass, status: MODEL_POST_TAX_STATUSES.REQUIRES_TAX_INPUTS, reasons: ['redemptionChannel'], fiscalYear, policy });
    }
    const couponRate = Number(options.couponRate);
    if (!Number.isFinite(couponRate) || couponRate < 0 || couponRate > 1) {
      return unavailableResult({ instrumentType, modelTaxClass, status: MODEL_POST_TAX_STATUSES.REQUIRES_TAX_INPUTS, reasons: ['couponRate'], fiscalYear, policy });
    }
    if (fiscalYear === 'FY2026-27' && channel === 'MATURITY_REDEMPTION'
        && (options.acquiredAtOriginalIssue !== true || options.heldContinuously !== true)) {
      return unavailableResult({
        instrumentType,
        modelTaxClass,
        status: MODEL_POST_TAX_STATUSES.REQUIRES_TAX_INPUTS,
        reasons: ['SGB_MATURITY_EXEMPTION_NOT_ESTABLISHED', 'acquiredAtOriginalIssue', 'heldContinuously'],
        fiscalYear,
        policy,
      });
    }
    if (fiscalYear === 'FY2026-27' && channel === 'RBI_REDEMPTION') {
      return unavailableResult({
        instrumentType,
        modelTaxClass,
        status: MODEL_POST_TAX_STATUSES.REQUIRES_TAX_INPUTS,
        reasons: ['SGB_PREMATURE_REDEMPTION_TAX_CLASSIFICATION_REQUIRES_FACTS'],
        fiscalYear,
        policy,
      });
    }
    const annualPrincipal = monthlySIP * 12;
    const couponGain = annualPrincipal * couponRate;
    const capitalGain = annualPrincipal * Math.max(0, nominalRate - couponRate);
    const couponTax = calculateOrdinaryIncrementalTax({ grossGain: couponGain, context });
    let capitalTax = { taxAmount: 0, cess: 0, surcharge: 0 };
    let holdingBasis = 'EXPLICIT_REDEMPTION_CHANNEL';
    if (channel === 'SECONDARY_MARKET_SALE' && capitalGain > 0) {
      const holding = holdingClassification({ context, options, fiscalYear, assetType: 'listed', holdingYears });
      if (holding.unavailable) return unavailableResult({ instrumentType, modelTaxClass, status: MODEL_POST_TAX_STATUSES.REQUIRES_TAX_INPUTS, reasons: [holding.unavailable], fiscalYear, policy });
      holdingBasis = holding.holdingPeriodBasis;
      if (holding.isLongTerm) {
        capitalTax = computeCapitalGainsTaxBuckets({
          longTermOtherGain: capitalGain,
          ...taxInputs,
          section112AExemptionUsed: taxInputs.section112AExemptionUsed ?? 0,
        });
      } else {
        capitalTax = calculateOrdinaryIncrementalTax({ grossGain: capitalGain, context });
      }
    }
    const totalTax = couponTax.taxAmount + (capitalTax.taxAmount || 0);
    return finalizeOutcome({
      instrumentType, modelTaxClass, nominalRate, grossGain: couponGain + capitalGain, taxAmount: totalTax,
      cess: couponTax.cess + (capitalTax.cess || 0), surcharge: couponTax.surcharge + (capitalTax.surcharge || 0),
      taxType: channel === 'SECONDARY_MARKET_SALE' ? 'Coupon plus explicit secondary-market capital-gains path' : 'Coupon taxable; redemption-channel capital-gains path explicit',
      policy,
      taxRuleMetadata: combineTaxRuleMetadata(policy, [
        couponTax.baseline?.taxRuleMetadata,
        couponTax.withGain?.taxRuleMetadata,
        capitalTax.taxRuleMetadata,
      ]),
      holdingPeriodBasis: holdingBasis,
      assumptions: ['SGB_COUPON_AND_CAPITAL_GAIN_PATHS_SEPARATE', `SGB_REDEMPTION_CHANNEL_${channel}`],
      details: { redemptionChannel: channel, couponRate, fiscalYear: policy.fiscalYear, policyVersion: policy.policyVersion },
      notes: channel === 'MATURITY_REDEMPTION'
        ? 'Maturity exemption is modeled only for an original-issue subscription held continuously until maturity. Secondary-market and premature-redemption exemptions are not inferred.'
        : 'The redemption channel is explicit. Secondary-market capital gains are modeled separately; premature-redemption exemption is not inferred.',
    });
  }

  const assetType = modelTaxClass === MODEL_TAX_CLASSES.EQUITY_112A ? 'listed' : 'other';
  const holding = holdingClassification({ context, options, fiscalYear, assetType, holdingYears });
  if (holding.unavailable) return unavailableResult({ instrumentType, modelTaxClass, status: MODEL_POST_TAX_STATUSES.REQUIRES_TAX_INPUTS, reasons: [holding.unavailable], fiscalYear, policy });
  const lots = buildMonthlySipLots({ monthlySIP, annualRate: nominalRate, holdingYears, acquisitionDate: holding.acquisitionDate, redemptionDate: holding.redemptionDate });
  const shortTermGain = lots.filter(lot => {
    if (holding.holdingPeriodBasis === 'EXACT_TRANSACTION_DATES') {
      const lotHolding = classifyHoldingPeriodByDates({ acquisitionDate: lot.acquisitionDate, redemptionDate: lot.redemptionDate, thresholdMonths: holding.thresholdMonths });
      return !lotHolding.isLongTerm;
    }
    return !isLongTermForModeledMonths(lot.holdingPeriodMonths, holding.thresholdMonths);
  }).reduce((sum, lot) => sum + lot.gain, 0);
  const longTermGain = lots.reduce((sum, lot) => sum + lot.gain, 0) - shortTermGain;
  let capitalTax;
  if (modelTaxClass === MODEL_TAX_CLASSES.EQUITY_112A) {
    capitalTax = computeCapitalGainsTaxBuckets({ shortTerm111AGain: shortTermGain, longTerm112AGain: longTermGain, ...taxInputs });
  } else if (longTermGain > 0) {
    const longTermTax = computeCapitalGainsTaxBuckets({
      longTermOtherGain: longTermGain,
      ...taxInputs,
      section112AExemptionUsed: taxInputs.section112AExemptionUsed ?? 0,
    });
    const shortTermTax = shortTermGain > 0 ? calculateOrdinaryIncrementalTax({ grossGain: shortTermGain, context }) : { taxAmount: 0, cess: 0, surcharge: 0 };
    capitalTax = { ...longTermTax, taxAmount: (longTermTax.taxAmount || 0) + shortTermTax.taxAmount, cess: (longTermTax.cess || 0) + shortTermTax.cess, surcharge: (longTermTax.surcharge || 0) + shortTermTax.surcharge };
  } else {
    capitalTax = calculateOrdinaryIncrementalTax({ grossGain: shortTermGain, context });
  }
  if (capitalTax.status !== 'CALCULATED') return unavailableResult({ instrumentType, modelTaxClass, status: MODEL_POST_TAX_STATUSES.PROJECTION_MODEL_UNAVAILABLE, reasons: capitalTax.unavailableReasons, fiscalYear, policy });
  return finalizeOutcome({
    instrumentType, modelTaxClass, nominalRate, grossGain: lots.reduce((sum, lot) => sum + lot.gain, 0), taxAmount: capitalTax.taxAmount, cess: capitalTax.cess, surcharge: capitalTax.surcharge,
    taxType: modelTaxClass === MODEL_TAX_CLASSES.EQUITY_112A ? 'FIFO equity capital-gain buckets (short-term / long-term)' : 'FIFO other capital-gain buckets (long-term / ordinary short-term)',
    policy,
    taxRuleMetadata: capitalTax.taxRuleMetadata || null,
    holdingPeriodBasis: holding.holdingPeriodBasis,
    assumptions: ['MODELLED_MONTHLY_FIFO_LOTS', 'SPECIAL_RATE_BUCKETS_SEPARATE_FROM_ORDINARY_INCOME'],
    details: { shortTermGain, longTermGain, exemptionApplied: capitalTax.exemptionApplied, fiscalYear: policy.fiscalYear, policyVersion: policy.policyVersion, lots },
    notes: 'This is a modeled SIP lot illustration. An actual transaction tax requires the taxpayer’s complete transaction ledger and filing context.',
  });
}

function projectGrossCashFlows({ monthlySIP, annualRate, holdingYears }) {
  const totalMonths = Math.max(1, Math.round(holdingYears * 12));
  const monthlyRate = toMonthlyRate(annualRate);
  let balance = 0;
  let totalInvested = 0;
  let yearInterest = 0;
  const monthly = [];
  for (let month = 1; month <= totalMonths; month += 1) {
    balance += monthlySIP;
    totalInvested += monthlySIP;
    const interest = balance * monthlyRate;
    balance += interest;
    yearInterest += interest;
    monthly.push({ month, contribution: monthlySIP, interest, balance });
  }
  return { totalMonths, balance, totalInvested, monthly, yearInterest };
}

function calculateCagr(finalValue, totalInvested, holdingYears) {
  if (finalValue === null || finalValue <= 0 || totalInvested <= 0) return null;
  return Math.pow(finalValue / totalInvested, 1 / holdingYears) - 1;
}

const SIP_RETURN_METRIC_BASIS = 'MODELLED_MONTHLY_SIP_MONEY_WEIGHTED_EQUIVALENT_ANNUAL_RATE';

function unavailableSipReturnMetrics(reason) {
  return {
    basis: SIP_RETURN_METRIC_BASIS,
    status: 'UNAVAILABLE',
    unavailableReason: reason,
    preTaxAnnualizedReturnPercent: null,
    postTaxAnnualizedReturnPercent: null,
    realPostTaxAnnualizedReturnPercent: null,
    taxDragAnnualizedPercentagePoints: null,
  };
}

function futureValueForBeginningOfMonthContributions(monthlyContribution, monthlyRate, totalMonths, stopAbove = Infinity) {
  let balance = 0;
  for (let month = 0; month < totalMonths; month += 1) {
    balance = (balance + monthlyContribution) * (1 + monthlyRate);
    if (balance > stopAbove) return Infinity;
  }
  return balance;
}

function solveMonthlySipAnnualizedReturn(finalValue, monthlyContribution, totalMonths) {
  if (!Number.isFinite(finalValue) || finalValue <= 0
      || !Number.isFinite(monthlyContribution) || monthlyContribution <= 0
      || !Number.isInteger(totalMonths) || totalMonths < 1) return null;

  const contributionTotal = monthlyContribution * totalMonths;
  if (finalValue === contributionTotal) return 0;

  // The cash-flow recurrence matches projectGrossCashFlows exactly: each
  // monthly contribution is deposited at the start of its month, then earns
  // that month's return. The bisection avoids a fragile closed-form near 0%.
  let low = -1 + 1e-12;
  let high = 1;
  const lowValue = futureValueForBeginningOfMonthContributions(
    monthlyContribution, low, totalMonths, finalValue,
  );
  if (lowValue > finalValue) return null;
  while (futureValueForBeginningOfMonthContributions(
    monthlyContribution, high, totalMonths, finalValue,
  ) < finalValue && high < 16) {
    high *= 2;
  }
  if (futureValueForBeginningOfMonthContributions(
    monthlyContribution, high, totalMonths, finalValue,
  ) < finalValue) return null;

  for (let iteration = 0; iteration < 100; iteration += 1) {
    const middle = (low + high) / 2;
    const value = futureValueForBeginningOfMonthContributions(
      monthlyContribution, middle, totalMonths, finalValue,
    );
    if (!Number.isFinite(value) || value > finalValue) high = middle;
    else low = middle;
  }
  const monthlyRate = (low + high) / 2;
  const annualizedPercent = (Math.pow(1 + monthlyRate, 12) - 1) * 100;
  return Number.isFinite(annualizedPercent) ? round4(annualizedPercent) : null;
}

function calculateSipReturnMetrics({ monthlySIP, totalMonths, nominalFutureValue, postTaxFutureValue, inflationRate }) {
  if (monthlySIP <= 0) return unavailableSipReturnMetrics('NO_MONTHLY_CONTRIBUTIONS');
  const preTaxAnnualizedReturnPercent = solveMonthlySipAnnualizedReturn(
    nominalFutureValue, monthlySIP, totalMonths,
  );
  const postTaxAnnualizedReturnPercent = solveMonthlySipAnnualizedReturn(
    postTaxFutureValue, monthlySIP, totalMonths,
  );
  if (preTaxAnnualizedReturnPercent === null || postTaxAnnualizedReturnPercent === null) {
    return unavailableSipReturnMetrics('RETURN_SOLVER_UNAVAILABLE');
  }
  const realPostTaxAnnualizedReturnPercent = ((
    (1 + postTaxAnnualizedReturnPercent / 100) / (1 + inflationRate)
  ) - 1) * 100;
  if (!Number.isFinite(realPostTaxAnnualizedReturnPercent)) {
    return unavailableSipReturnMetrics('RETURN_SOLVER_UNAVAILABLE');
  }
  return {
    basis: SIP_RETURN_METRIC_BASIS,
    status: 'CALCULATED',
    unavailableReason: null,
    preTaxAnnualizedReturnPercent,
    postTaxAnnualizedReturnPercent,
    realPostTaxAnnualizedReturnPercent: round4(realPostTaxAnnualizedReturnPercent),
    taxDragAnnualizedPercentagePoints: round4(Math.max(
      0,
      preTaxAnnualizedReturnPercent - postTaxAnnualizedReturnPercent,
    )),
  };
}

export function projectPostTaxCashFlows({ postTaxResult, instrument, context = {}, inflationRate }) {
  if (!postTaxResult || !instrument) throw new TypeError('postTaxResult and instrument are required');
  requireNumber(instrument.monthlySIP, 'monthlySIP');
  requireNumber(instrument.nominalRate, 'nominalRate', { min: 0, max: 1 });
  requireNumber(instrument.holdingYears, 'holdingYears', { min: 0.01, max: 100 });
  requireNumber(inflationRate, 'inflationRate', { min: 0, max: 1 });
  const exactAcquisitionDate = context.acquisitionDate ?? instrument.acquisitionDate;
  const exactRedemptionDate = context.redemptionDate ?? instrument.redemptionDate;
  const exactDatesSupplied = Boolean(exactAcquisitionDate || exactRedemptionDate);
  let exactDateError = null;
  let projectionHoldingYears = instrument.holdingYears;
  if (exactDatesSupplied) {
    if (!exactAcquisitionDate || !exactRedemptionDate) {
      exactDateError = 'ACQUISITION_AND_REDEMPTION_DATES_REQUIRED_TOGETHER';
    } else {
      const acquired = parseDate(exactAcquisitionDate, 'acquisitionDate');
      const redeemed = parseDate(exactRedemptionDate, 'redemptionDate');
      if (redeemed < acquired) throw new RangeError('redemptionDate cannot precede acquisitionDate');
      let horizonMonths = 0;
      while (horizonMonths < 1200 && addMonths(acquired, horizonMonths + 1) <= redeemed) horizonMonths += 1;
      projectionHoldingYears = Math.max(1, horizonMonths) / 12;
    }
  }
  const gross = projectGrossCashFlows({
    monthlySIP: instrument.monthlySIP,
    annualRate: instrument.nominalRate,
    holdingYears: projectionHoldingYears,
  });
  let postTaxFutureValue = null;
  let taxEvents = [];
  let taxTotal = null;
  let taxEventModel = null;
  const modelTaxClass = postTaxResult.modelTaxClass;
  if (modelTaxClass === MODEL_TAX_CLASSES.CONDITIONAL_ACCOUNT_TREATMENT) {
    return {
      status: MODEL_POST_TAX_STATUSES.TAX_CLASSIFICATION_REQUIRES_ACQUISITION_FACTS,
      totalInvested: Math.round(gross.totalInvested),
      nominalFutureValue: Math.round(gross.balance),
      postTaxFutureValue: null,
      realFutureValue: null,
      postTaxGain: null,
      taxDragWealth: null,
      taxDragCAGR: null,
      nominalReturnPercent: round4(instrument.nominalRate * 100),
      postTaxReturnPercent: null,
      realReturnPercent: null,
      effectiveTaxPercent: null,
      postTaxCAGR: null,
      sipReturnMetrics: unavailableSipReturnMetrics('PROJECTION_UNAVAILABLE'),
      taxEvents: [],
      taxEventModel: 'UNAVAILABLE',
      assumptions: ['ACCOUNT_TAX_QUALIFICATION_NOT_ESTABLISHED'],
      unavailableReasons: ['PPF_SSY_EXCLUSION_ELIGIBILITY_NOT_ESTABLISHED', 'VERIFIED_ACCOUNT_AND_PAYMENT_FACTS_REQUIRED'],
    };
  }
  // A calculated headline rate does not authorize a new projection using
  // missing or different investor context. In particular Number(null) === 0.
  const missingInvestorFacts = [
    ...(typeof context.annualGrossIncome === 'number'
      && Number.isFinite(context.annualGrossIncome) && context.annualGrossIncome >= 0
      ? [] : ['annualGrossIncome']),
    ...(['salary', 'pension', 'family_pension', 'business', 'other'].includes(context.incomeSource)
      ? [] : ['incomeSource']),
    ...(context.regime === 'new' ? [] : ['regime']),
    ...(typeof context.fiscalYear === 'string' && /^FY[0-9]{4}-[0-9]{2}$/.test(context.fiscalYear)
      ? [] : ['fiscalYear']),
    ...(Number.isInteger(context.userAge) && context.userAge >= 18 && context.userAge <= 120
      ? [] : ['userAge']),
  ];
  const policyBindingChanged = postTaxResult.fiscalYear
    && context.fiscalYear !== postTaxResult.fiscalYear;
  const section112AUsageMissing = modelTaxClass === MODEL_TAX_CLASSES.EQUITY_112A
    && (!Number.isFinite(context.section112AExemptionUsed) || context.section112AExemptionUsed < 0);
  if (postTaxResult.status !== MODEL_POST_TAX_STATUSES.CALCULATED || exactDateError
      || section112AUsageMissing || missingInvestorFacts.length || policyBindingChanged) {
    return {
      status: MODEL_POST_TAX_STATUSES.PROJECTION_MODEL_UNAVAILABLE,
      totalInvested: Math.round(gross.totalInvested),
      nominalFutureValue: Math.round(gross.balance),
      postTaxFutureValue: null,
      realFutureValue: null,
      postTaxGain: null,
      taxDragWealth: null,
      taxDragCAGR: null,
      nominalReturnPercent: round4(instrument.nominalRate * 100),
      postTaxReturnPercent: null,
      realReturnPercent: null,
      effectiveTaxPercent: null,
      postTaxCAGR: null,
      sipReturnMetrics: unavailableSipReturnMetrics('PROJECTION_UNAVAILABLE'),
      taxEvents,
      taxEventModel: 'UNAVAILABLE',
      assumptions: ['MODELLED_POST_TAX_PROJECTION_UNAVAILABLE'],
      unavailableReasons: [
        ...(postTaxResult.unavailableReasons || []),
        ...(exactDateError ? [exactDateError] : []),
        ...missingInvestorFacts,
        ...(policyBindingChanged ? ['TAX_POLICY_FISCAL_YEAR_CHANGED'] : []),
        ...(section112AUsageMissing ? ['section112AExemptionUsed'] : []),
      ],
    };
  }

  if (modelTaxClass === MODEL_TAX_CLASSES.ORDINARY_INTEREST) {
    // Taxes are deducted from invested wealth at each tax event. Recompute
    // subsequent interest on that reduced balance; gross.monthly.interest was
    // computed on a separate never-taxed path and must not be reused here.
    const monthlyRate = toMonthlyRate(instrument.nominalRate);
    let balance = 0;
    let pendingInterest = 0;
    taxEvents = [];
    for (const row of gross.monthly) {
      balance += row.contribution;
      const interest = balance * monthlyRate;
      balance += interest;
      pendingInterest += interest;
      if (row.month % 12 === 0 || row.month === gross.totalMonths) {
        if (!Number.isInteger(context.userAge) || context.userAge < 18 || context.userAge > 120) {
          throw new TypeError('userAge must be explicitly provided as an integer from 18 to 120 for projected annual tax events');
        }
        // `userAge` is the explicit age on March 31 of `context.fiscalYear`.
        // This projection has no calendar start date or future-FY tax policy
        // input, so it cannot truthfully derive ages for later fiscal years.
        // Keep both the selected-FY policy and its verified age fixed for every
        // modeled event instead of inferring a future age from event order.
        const taxpayerAgeForSelectedFiscalYear = context.userAge;
        const eventContext = { ...context, userAge: taxpayerAgeForSelectedFiscalYear };
        const tax = calculateOrdinaryIncrementalTax({ grossGain: pendingInterest, context: eventContext });
        balance -= tax.taxAmount;
        taxEvents.push({
          month: row.month,
          grossIncome: pendingInterest,
          tax: tax.taxAmount,
          timing: 'ANNUAL_TAX_EVENT',
          taxpayerAgeForSelectedFiscalYear,
        });
        pendingInterest = 0;
      }
    }
    postTaxFutureValue = balance;
    taxTotal = taxEvents.reduce((sum, event) => sum + event.tax, 0);
    taxEventModel = 'ORDINARY_INTEREST_ANNUAL_INCREMENTAL_TAX_EVENTS';
  } else if (modelTaxClass === MODEL_TAX_CLASSES.EQUITY_112A || modelTaxClass === MODEL_TAX_CLASSES.OTHER_CAPITAL_GAINS) {
    const lots = buildMonthlySipLots({ monthlySIP: instrument.monthlySIP, annualRate: instrument.nominalRate, holdingYears: instrument.holdingYears, acquisitionDate: context.acquisitionDate, redemptionDate: context.redemptionDate });
    const threshold = getCapitalGainsHoldingPeriodMonths(context.fiscalYear, modelTaxClass === MODEL_TAX_CLASSES.EQUITY_112A ? 'listed' : 'other');
    const shortTermGain = lots.filter(lot => {
      const isLongTerm = lot.holdingPeriodBasis === 'EXACT_TRANSACTION_DATES'
        ? classifyHoldingPeriodByDates({ acquisitionDate: lot.acquisitionDate, redemptionDate: lot.redemptionDate, thresholdMonths: threshold }).isLongTerm
        : isLongTermForModeledMonths(lot.holdingPeriodMonths, threshold);
      return !isLongTerm;
    }).reduce((sum, lot) => sum + lot.gain, 0);
    const longTermGain = lots.reduce((sum, lot) => sum + lot.gain, 0) - shortTermGain;
    const values = taxContext(context);
    let tax;
    if (modelTaxClass === MODEL_TAX_CLASSES.EQUITY_112A) {
      tax = computeCapitalGainsTaxBuckets({ shortTerm111AGain: shortTermGain, longTerm112AGain: longTermGain, ...values });
    } else if (shortTermGain > 0) {
      const shortTermTax = calculateOrdinaryIncrementalTax({ grossGain: shortTermGain, context });
      const longTermTax = longTermGain > 0
        ? computeCapitalGainsTaxBuckets({
          longTermOtherGain: longTermGain,
          ...values,
          section112AExemptionUsed: values.section112AExemptionUsed ?? 0,
        })
        : { taxAmount: 0, cess: 0, surcharge: 0, status: 'CALCULATED' };
      tax = { status: longTermTax.status, taxAmount: shortTermTax.taxAmount + (longTermTax.taxAmount || 0), cess: shortTermTax.cess + (longTermTax.cess || 0), surcharge: shortTermTax.surcharge + (longTermTax.surcharge || 0), unavailableReasons: longTermTax.unavailableReasons || [] };
    } else {
      tax = computeCapitalGainsTaxBuckets({
        longTermOtherGain: longTermGain,
        ...values,
        section112AExemptionUsed: values.section112AExemptionUsed ?? 0,
      });
    }
    if (tax.status !== 'CALCULATED') {
      return { ...projectPostTaxCashFlows({ postTaxResult: { ...postTaxResult, status: 'UNAVAILABLE' }, instrument, context, inflationRate }), status: MODEL_POST_TAX_STATUSES.PROJECTION_MODEL_UNAVAILABLE, taxEvents: [] };
    }
    postTaxFutureValue = gross.balance - tax.taxAmount;
    taxTotal = tax.taxAmount;
    taxEvents = [{ month: gross.totalMonths, grossGain: gross.balance - gross.totalInvested, tax: tax.taxAmount, timing: 'EXIT_CAPITAL_GAINS_TAX_EVENT', shortTermGain, longTermGain }];
    taxEventModel = 'EXIT_FIFO_CAPITAL_GAINS_BUCKET_EVENT';
  } else if (modelTaxClass === MODEL_TAX_CLASSES.NPS_EXIT) {
    const fraction = Number(postTaxResult.annuityFraction);
    if (!Number.isFinite(fraction)) {
      return { ...projectPostTaxCashFlows({ postTaxResult: { ...postTaxResult, status: 'UNAVAILABLE' }, instrument, context, inflationRate }), status: MODEL_POST_TAX_STATUSES.PROJECTION_MODEL_UNAVAILABLE };
    }
    const values = taxContext(context);
    const tax = calculateOrdinaryIncrementalTax({ grossGain: Math.max(0, gross.balance - gross.totalInvested) * fraction, context });
    postTaxFutureValue = gross.balance - tax.taxAmount;
    taxTotal = tax.taxAmount;
    taxEvents = [{ month: gross.totalMonths, grossGain: gross.balance - gross.totalInvested, tax: tax.taxAmount, timing: 'MODELED_NPS_EXIT_TAX_EVENT', annuityFraction: fraction }];
    taxEventModel = 'MODELED_NPS_EXIT_SCENARIO';
    void values;
  } else if (modelTaxClass === MODEL_TAX_CLASSES.SGB) {
    return { ...projectPostTaxCashFlows({ postTaxResult: { ...postTaxResult, status: 'UNAVAILABLE' }, instrument, context, inflationRate }), status: MODEL_POST_TAX_STATUSES.PROJECTION_MODEL_UNAVAILABLE, taxEvents: [] };
  }

  const nominalCagr = calculateCagr(gross.balance, gross.totalInvested, projectionHoldingYears);
  const postTaxCagr = calculateCagr(postTaxFutureValue, gross.totalInvested, projectionHoldingYears);
  const sipReturnMetrics = calculateSipReturnMetrics({
    monthlySIP: instrument.monthlySIP,
    totalMonths: gross.totalMonths,
    nominalFutureValue: gross.balance,
    postTaxFutureValue,
    inflationRate,
  });
  const realFutureValue = postTaxFutureValue === null
    ? null
    : postTaxFutureValue / Math.pow(1 + inflationRate, projectionHoldingYears);
  const postTaxGain = postTaxFutureValue === null ? null : Math.max(0, postTaxFutureValue - gross.totalInvested);
  return {
    status: 'CALCULATED',
    totalInvested: Math.round(gross.totalInvested),
    nominalFutureValue: Math.round(gross.balance),
    postTaxFutureValue: Math.round(postTaxFutureValue),
    realFutureValue: Math.round(realFutureValue),
    postTaxGain: Math.round(postTaxGain),
    taxDragWealth: Math.round(Math.max(0, gross.balance - postTaxFutureValue)),
    taxDragCAGR: round4(Math.max(0, (nominalCagr || 0) - (postTaxCagr || 0))),
    nominalReturnPercent: round4(instrument.nominalRate * 100),
    postTaxReturnPercent: round4((postTaxCagr ?? postTaxResult.postTaxReturn) * 100),
    realReturnPercent: round4(((1 + (postTaxCagr ?? postTaxResult.postTaxReturn)) / (1 + inflationRate) - 1) * 100),
    effectiveTaxPercent: gross.balance > gross.totalInvested
      ? round4((taxTotal / Math.max(1, gross.balance - gross.totalInvested)) * 100)
      : 0,
    postTaxCAGR: postTaxCagr,
    nominalCAGR: nominalCagr,
    sipReturnMetrics,
    taxEvents,
    taxEventModel,
    assumptions: [
      'GROSS_CASH_FLOWS_FIRST_THEN_TAX_EVENTS_THEN_POST_TAX_FLOWS',
      'TAX_POLICY_HELD_CONSTANT_FOR_PROJECTION',
      'SELECTED_VERIFIED_FISCAL_YEAR_POLICY_HELD_CONSTANT_AS_MODEL_ASSUMPTION',
      ...(taxEventModel === 'ORDINARY_INTEREST_ANNUAL_INCREMENTAL_TAX_EVENTS'
        ? [
          'SELECTED_FISCAL_YEAR_TAXPAYER_AGE_HELD_CONSTANT_FOR_PROJECTED_TAX_EVENTS',
          'TDS_REMAINS_INFORMATIONAL_CREDIT_NOT_AN_EXTRA_PROJECTED_TAX_SUBTRACTION',
          'PROJECTED_TAX_DEDUCTED_FROM_BALANCE_AND_REDUCES_FUTURE_INTEREST',
        ]
        : []),
      ...(exactDatesSupplied ? ['EXACT_TRANSACTION_DATES_OWN_PROJECTION_HORIZON'] : ['MODELLED_MONTHLY_LOTS']),
    ],
  };
}
