import { Router } from 'express';
import { asyncHandler, sendError } from '../middleware/errorHandler.js';
import {
  validate,
  postTaxReturnSchema,
  postTaxReturnBatchSchema,
  userDeclaredPostTaxScenarioSchema,
} from '../validation/schemas.js';
import {
  isFYVerified,
  getTaxPolicyCatalog,
  getTaxPolicyMetadata,
} from '../services/taxEngine.js';
import { calculateVerifiedNewRegime } from '../services/verifiedNewRegimeCalculator.js';
import { calculateAdvancedNewRegime } from '../services/advancedNewRegimeCalculator.js';
import { calculateVerifiedComplexCapitalGainsTax } from '../services/verifiedComplexCapitalGainsTax.js';
import { calculatePostTaxReturnSafe, calculatePostTaxProjection } from '../services/postTaxCalculator.js';
import { calculateUserDeclaredPostTaxScenario } from '../services/userDeclaredPostTaxScenario.js';

const router = Router();
const SECTION_112A_PORTFOLIO_ALLOCATION_INCOMPLETE = 'SECTION_112A_PORTFOLIO_ALLOCATION_INCOMPLETE';

/**
 * GET /api/tax/policies
 * The browser consumes this metadata instead of carrying a fiscal-year list
 * or current-year assumption of its own.
 */
router.get('/policies', asyncHandler(async (req, res) => {
  res.json(getTaxPolicyCatalog());
}));

/**
 * Scoped calculator: only verified TY2026-27 ordinary-rate income for individuals.
 * Deliberately separate from the legacy compare, cash-flow, and capital-gain APIs.
 */
router.post('/new-regime-verified', asyncHandler(async (req, res) => {
  // No tax submission or rejected amount may be cached by an intermediary.
  res.set('Cache-Control', 'no-store');
  try {
    const result = calculateVerifiedNewRegime(req.body);
    return res.json(result);
  } catch (error) {
    if (error.code === 'UNSUPPORTED_TAX_YEAR') {
      return sendError(req, res, 422, error.message, error.code);
    }
    if (error.code === 'INVALID_TAX_REQUEST' || error.code === 'INVALID_MONEY') {
      return sendError(req, res, 400, error.message, error.code);
    }
    throw error;
  }
}));

/**
 * Expert income-tax calculation: only strictly qualified resident equity gains,
 * with ordinary taxable income above the rebate range and no surcharge.
 * Deliberately separate from the simple new-regime endpoint.
 */
router.post('/new-regime-verified-complex', asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    return res.json(calculateVerifiedComplexCapitalGainsTax(req.body));
  } catch (error) {
    if (error.code === 'UNSUPPORTED_TAX_YEAR') return sendError(req, res, 422, error.message, error.code);
    if (error.code === 'INVALID_TAX_REQUEST' || error.code === 'INVALID_MONEY') {
      return sendError(req, res, 400, error.message, error.code);
    }
    throw error;
  }
}));

/**
 * Strictly qualified supplementary new-regime scenarios (TY 2026-27).
 * Does not alter the ordinary income endpoint or legacy tax APIs.
 */
router.post('/new-regime-advanced', asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    return res.json(calculateAdvancedNewRegime(req.body));
  } catch (error) {
    if (error.code === 'UNSUPPORTED_TAX_YEAR') {
      return sendError(req, res, 422, error.message, error.code);
    }
    if (error.code === 'INVALID_TAX_REQUEST' || error.code === 'INVALID_MONEY') {
      return sendError(req, res, 400, error.message, error.code);
    }
    throw error;
  }
}));

function _parseTaxDeductions(input) {
  return {
    section80C: Number(input.section80C) || 0,
    nps80CCD1B: input.nps80CCD1B !== undefined
      ? Number(input.nps80CCD1B)
      : input.section80CCD !== undefined ? undefined : 0,
    section80CCD: input.section80CCD !== undefined ? Number(input.section80CCD) : undefined,
    nps80CCD2: Number(input.nps80CCD2) || 0,
    basicSalary: input.basicSalary !== undefined ? Number(input.basicSalary) : undefined,
    isGovtEmployee: input.isGovtEmployee === undefined
      ? undefined
      : input.isGovtEmployee === 'true' || input.isGovtEmployee === true,
    section80D: input.section80D !== undefined
      ? Number(input.section80D)
      : input.section80D_self !== undefined || input.section80D_parents !== undefined ? undefined : 0,
    section80D_self: input.section80D_self !== undefined ? Number(input.section80D_self) : undefined,
    section80D_parents: input.section80D_parents !== undefined ? Number(input.section80D_parents) : undefined,
    parents_senior: input.parents_senior === undefined
      ? undefined
      : input.parents_senior === 'true' || input.parents_senior === true,
    self_senior: input.self_senior === undefined
      ? undefined
      : input.self_senior === 'true' || input.self_senior === true,
    hra: Number(input.hra) || 0,
    homeLoanInterest: Number(input.homeLoanInterest) || 0,
    section80EEA: Number(input.section80EEA) || 0,
    savingsInterest: Number(input.savingsInterest) || 0,
    section80TTA: Number(input.section80TTA) || 0,
    section80TTB: Number(input.section80TTB) || 0,
    other: input.other !== undefined ? Number(input.other) : undefined,
    age: input.age !== undefined ? Number(input.age) : undefined,
  };
}

/**
 * This app supports only the new income tax regime. Never interpret an old
 * format submission as new-regime input. Historical data is retained.
 * Explicitly return Gone for both retired public comparison endpoints.
 */
function respondRetiredLegacyTax(req, res) {
  res.set('Cache-Control', 'no-store');
  return sendError(req, res, 410,
    'Legacy tax computation and regime comparison are retired. Submit qualified TY2026-27 facts to /api/tax/new-regime-verified.',
    'TAX_LEGACY_ENDPOINT_RETIRED');
}

// Explicit routes are included in the source-derived OpenAPI security inventory.
router.post('/compute', respondRetiredLegacyTax);
router.post('/compare', respondRetiredLegacyTax);

/**
 * POST /api/tax/post-tax-return
 * Single-instrument post-tax return computation using the canonical backend
 * postTaxCalculator (with Section 87A rebate, marginal relief, surcharge, cess).
 *
 * Added in WG-038 to eliminate the client-side duplicate tax engine
 * (engine/taxComputation.js) which was missing the Section 87A rebate,
 * causing PostTaxAnalysis.jsx to systematically understate post-tax returns
 * for users with gross income under ~â‚¹12.75L.
 */
router.post('/post-tax-return', validate(postTaxReturnSchema), asyncHandler(async (req, res) => {
  const {
    instrumentType, nominalRate, annualIncome, holdingYears, regime, monthlySIP, userAge, incomeSource,
  } = req.body;
  const {
    fiscalYear, deductions = {}, acquisitionDate, redemptionDate, redemptionChannel, acquiredAtOriginalIssue, heldContinuously,
    couponRate, annuityFraction, retirementTiming, section112AExemptionUsed,
  } = req.body;
  if (!isFYVerified(fiscalYear)) {
    return sendError(req, res, 422, `Verified tax rules are unavailable for ${fiscalYear}.`, 'FISCAL_YEAR_UNSUPPORTED');
  }

  const result = calculatePostTaxReturnSafe(
    instrumentType,
    nominalRate,
    annualIncome,
    holdingYears,
    regime,
    monthlySIP,
    userAge,
    incomeSource,
    undefined,
    fiscalYear,
    {
      deductions,
      acquisitionDate,
      redemptionDate,
      redemptionChannel,
      acquiredAtOriginalIssue,
      heldContinuously,
      couponRate,
      annuityFraction,
      retirementTiming,
      section112AExemptionUsed,
    },
  );

  const whatIfPrincipal = 100000;
  const isCalculated = result.status === 'CALCULATED';
  const nominalGain = isCalculated ? Math.round(whatIfPrincipal * nominalRate) : null;
  const netGain = isCalculated && Number.isFinite(result.postTaxReturn)
    ? Math.round(whatIfPrincipal * result.postTaxReturn)
    : null;
  res.json({
    ...result,
    calculation_classification: 'SEPARATE_TAX_WHAT_IF',
    calculationClass: 'MODELLED_POST_TAX_PROJECTION',
    dataClass: 'MODEL_ASSUMPTION',
    what_if_principal: whatIfPrincipal,
    what_if_nominal_gain: nominalGain,
    what_if_estimated_tax: netGain === null ? null : Math.max(0, nominalGain - netGain),
    what_if_net_gain: netGain,
    ...getTaxPolicyMetadata(fiscalYear),
    inputsUsed: {
      instrumentType, annualIncome, incomeSource, regime, fiscalYear, holdingYears, monthlySIP, userAge,
      nominalRate, deductions, acquisitionDate, redemptionDate, redemptionChannel,
      section112AExemptionUsed: section112AExemptionUsed ?? null,
      acquiredAtOriginalIssue, heldContinuously,
    },
    assumptions: [
      ...(result.assumptions || []),
      'NOMINAL_RATE_IS_CALLER_SUPPLIED; ITS EVIDENCE CLASS MUST BE ESTABLISHED BY THE CALLER',
      'THIS_IS_A_MODELLED_INVESTOR_WHAT_IF_NOT_AN_ACTUAL_TRANSACTION_TAX_ESTIMATE',
    ],
    unavailableReasons: result.unavailableReasons || [],
  });
}));

/**
 * POST /api/tax/post-tax-return/batch
 * Batch computation: accepts an array of instruments, returns an array of results.
 * Used by PostTaxAnalysis.jsx to compute all instrument post-tax returns in one call.
 */
router.post('/post-tax-return/batch', validate(postTaxReturnBatchSchema), asyncHandler(async (req, res) => {
  const {
    instruments, annualIncome, regime, userAge, incomeSource, inflationRate,
    deductions = {}, section112AExemptionUsed,
  } = req.body;
  const { fiscalYear } = req.body;
  if (!isFYVerified(fiscalYear)) {
    return sendError(req, res, 422, `Verified tax rules are unavailable for ${fiscalYear}.`, 'FISCAL_YEAR_UNSUPPORTED');
  }

  const calculateBatchInstrument = (inv, instrumentIndex, section112AExemptionAppliedOverride) => {
    const section112AUsed = section112AExemptionUsed;
    const options = {
      deductions,
      acquisitionDate: inv.acquisitionDate,
      redemptionDate: inv.redemptionDate,
      redemptionChannel: inv.redemptionChannel,
      acquiredAtOriginalIssue: inv.acquiredAtOriginalIssue,
      heldContinuously: inv.heldContinuously,
      couponRate: inv.couponRate,
      annuityFraction: inv.annuityFraction,
      retirementTiming: inv.retirementTiming,
      section112AExemptionUsed: section112AUsed,
    };
    if (section112AExemptionAppliedOverride !== undefined) {
      options.section112AExemptionAppliedOverride = section112AExemptionAppliedOverride;
    }
    const taxResult = calculatePostTaxReturnSafe(
      inv.instrumentType,
      inv.nominalRate,
      annualIncome,
      inv.holdingYears,
      regime,
      inv.monthlySIP,
      userAge,
      incomeSource,
      undefined,
      fiscalYear,
      options,
    );
    const projectionContext = {
      annualGrossIncome: annualIncome,
      regime,
      incomeSource,
      fiscalYear,
      userAge,
      deductions,
      section112AExemptionUsed: section112AUsed,
      ...(section112AExemptionAppliedOverride !== undefined
        ? { section112AExemptionAppliedOverride }
        : {}),
      acquisitionDate: inv.acquisitionDate,
      redemptionDate: inv.redemptionDate,
    };
    const projection = calculatePostTaxProjection(taxResult, inv, inflationRate, projectionContext);
    return {
      instrumentType: inv.instrumentType,
      instrumentId: inv.instrumentId ?? null,
      // Category-policy projections are never exact issuer/product quotes.
      exactProductReturnVerified: false,
      ...taxResult,
      calculationClass: 'MODELLED_POST_TAX_PROJECTION',
      dataClass: 'MODEL_ASSUMPTION',
      ...projection,
      ...(taxResult.status === 'REQUIRES_TAX_INPUTS' ? { status: taxResult.status } : {}),
      instrumentIndex,
      instrumentInput: { ...inv },
    };
  };

  let results = instruments.map((inv, instrumentIndex) => calculateBatchInstrument(inv, instrumentIndex, undefined));
  const equityResultIndexes = results
    .map((result, index) => ({ result, index }))
    .filter(({ result }) => result.modelTaxClass === 'MODEL_TAX_CLASS_EQUITY_112A');
  const calculatedEquityResults = equityResultIndexes.filter(({ result }) => (
    result.status === 'CALCULATED' && Number.isFinite(result.longTermGain) && result.longTermGain >= 0
  ));
  let section112APortfolioAllocation = null;
  if (equityResultIndexes.length > 0) {
    const policy = getTaxPolicyMetadata(fiscalYear);
    const requestedUsed = section112AExemptionUsed;
    if (requestedUsed === undefined) {
      section112APortfolioAllocation = {
        policy: 'SECTION_112A_EXEMPTION_USAGE_REQUIRED',
        exemptionLimit: policy.rules.capitalGains112AExemption,
        exemptionUsedBeforeBatch: null,
        exemptionAppliedAcrossBatch: null,
        qualifyingLongTermGain: null,
        allocationComplete: false,
        unavailableEquityInstruments: equityResultIndexes.length,
        unavailableReasons: ['SECTION_112A_EXEMPTION_USAGE_REQUIRED'],
      };
    } else {
      const remainingExemption = Math.max(0, policy.rules.capitalGains112AExemption - requestedUsed);
      const allocationComplete = calculatedEquityResults.length === equityResultIndexes.length;
      if (!allocationComplete) {
        const calculableEquityIndexes = new Set(calculatedEquityResults.map(({ index }) => index));
        // The taxpayer-level exemption cannot be safely allocated from a partial
        // equity universe. Recalculate known holdings without any additional
        // exemption rather than presenting a subset as the complete portfolio.
        results = results.map((result, index) => calculableEquityIndexes.has(index)
          ? calculateBatchInstrument(instruments[index], index, 0)
          : result);
        section112APortfolioAllocation = {
          policy: 'CONSERVATIVE_PARTIAL_PORTFOLIO_112A_ASSUMPTION',
          exemptionLimit: policy.rules.capitalGains112AExemption,
          exemptionUsedBeforeBatch: requestedUsed,
          exemptionAppliedAcrossBatch: 0,
          qualifyingLongTermGain: null,
          calculableQualifyingLongTermGain: calculatedEquityResults.reduce((sum, { result }) => sum + result.longTermGain, 0),
          allocationComplete: false,
          unavailableEquityInstruments: equityResultIndexes.length - calculatedEquityResults.length,
          unavailableReasons: [SECTION_112A_PORTFOLIO_ALLOCATION_INCOMPLETE],
        };
      } else {
        const totalQualifyingGain = calculatedEquityResults.reduce((sum, { result }) => sum + result.longTermGain, 0);
        const exemptionApplied = Math.min(remainingExemption, totalQualifyingGain);
        const allocations = new Map();
        if (totalQualifyingGain > 0) {
          for (const { index, result } of calculatedEquityResults) {
            allocations.set(index, exemptionApplied * (result.longTermGain / totalQualifyingGain));
          }
          results = results.map((result, index) => allocations.has(index)
            ? calculateBatchInstrument(instruments[index], index, allocations.get(index))
            : result);
        }
        section112APortfolioAllocation = {
          policy: 'PROPORTIONAL_QUALIFYING_LTCG_ALLOCATED_ONCE_PER_BATCH',
          exemptionLimit: policy.rules.capitalGains112AExemption,
          exemptionUsedBeforeBatch: requestedUsed,
          exemptionAppliedAcrossBatch: exemptionApplied,
          qualifyingLongTermGain: totalQualifyingGain,
          allocationComplete: true,
          unavailableEquityInstruments: 0,
        };
      }
    }
  }

  const projectionFields = [
    'effectiveTaxPercent', 'postTaxGain', 'taxDragWealth', 'taxDragCAGR',
    'totalInvested', 'nominalReturnPercent',
  ];
  const calculatedResults = results.filter(item => item.status === 'CALCULATED'
    && projectionFields.every(field => Number.isFinite(item[field]))
    && ((
      item.totalInvested === 0
      && item.sipReturnMetrics?.status === 'UNAVAILABLE'
      && item.sipReturnMetrics.unavailableReason === 'NO_MONTHLY_CONTRIBUTIONS'
      && item.postTaxReturnPercent === null
      && item.realReturnPercent === null
    ) || (
      Number.isFinite(item.postTaxReturnPercent)
      && Number.isFinite(item.realReturnPercent)
    )));
  const excludedInstruments = results.map((item, index) => ({ item, index }))
    .filter(({ item }) => !calculatedResults.includes(item))
    .map(({ item, index }) => ({
      index,
      instrumentType: instruments[index].instrumentType,
      status: item.status || 'UNAVAILABLE',
      unavailableReasons: item.unavailableReasons || ['PROJECTION_FIELDS_UNAVAILABLE'],
    }));
  const portfolioStatus = calculatedResults.length === results.length
    ? 'COMPLETE'
    : calculatedResults.length > 0 ? 'PARTIAL' : 'UNAVAILABLE';
  const totalTaxDrag = calculatedResults.length > 0
    ? calculatedResults.reduce((sum, item) => sum + item.taxDragWealth, 0)
    : null;
  const grossProfit = calculatedResults.reduce((sum, item) => sum + Math.max(0, item.nominalFutureValue - item.totalInvested), 0);
  const retainedProfit = calculatedResults.reduce((sum, item) => sum + Math.max(0, item.postTaxFutureValue - item.totalInvested), 0);
  const keptPerThousand = calculatedResults.length === 0 ? null : grossProfit > 0
    ? Math.max(0, Math.min(1000, Math.round((retainedProfit / grossProfit) * 1000)))
    : 1000;
  const maxTaxRate = calculatedResults.length === 0 ? null : calculatedResults.reduce((max, item) => Math.max(max, item.taxRate || 0), 0);
  const nonPositiveRealCount = calculatedResults.filter(item => item.realReturnPercent <= 0).length;
  const insights = [];
  if (portfolioStatus === 'UNAVAILABLE') {
    insights.push({
      title: 'Post-Tax Projection Unavailable',
      body: 'No selected instrument has a complete qualified tax projection. No tax number has been substituted.',
      icon: 'shield',
      color: 'amber',
    });
  } else if (portfolioStatus === 'PARTIAL') {
    insights.push({
      title: 'Partial Post-Tax Projection',
      body: `${calculatedResults.length} of ${results.length} selected instruments have complete qualified tax projections. ${excludedInstruments.length} instrument${excludedInstruments.length === 1 ? '' : 's'} remain unavailable and are excluded from the summary totals.`,
      icon: 'shield',
      color: 'amber',
    });
    if (totalTaxDrag > 0) {
      insights.push({
        title: 'Tax Drag on Calculated Instruments',
        body: `The calculated subset loses an estimated ₹${Math.round(totalTaxDrag).toLocaleString('en-IN')} to tax over this horizon.`,
        icon: 'shield',
        color: 'blue',
      });
    }
  } else if (totalTaxDrag > 0) {
    insights.push({
      title: 'Review Tax Drag',
      body: `The selected suitable portfolio loses an estimated ₹${Math.round(totalTaxDrag).toLocaleString('en-IN')} to tax over this horizon. Review the explicit tax assumptions with a qualified adviser.`,
      icon: 'shield',
      color: 'blue',
    });
  } else {
    insights.push({
      title: 'No Estimated Tax Drag',
      body: 'Under the explicit what-if context, the server estimates no tax drag for the selected suitable instruments.',
      icon: 'shield',
      color: 'green',
    });
  }
  if (nonPositiveRealCount > 0) {
    insights.push({
      title: 'Inflation Pressure',
      body: `${nonPositiveRealCount} selected instrument${nonPositiveRealCount === 1 ? '' : 's'} may not preserve purchasing power at the inflation rate you entered.`,
      icon: 'trend',
      color: 'amber',
    });
  }

  res.json({
    calculation_classification: 'SEPARATE_TAX_WHAT_IF',
    ...getTaxPolicyMetadata(fiscalYear),
    assumptions: {
      annualIncome,
      incomeSource,
      regime,
      userAge,
      inflationRate,
      fiscalYear,
      deductions: { ...deductions },
      contributionGrowthRate: 0,
      calculationClass: 'MODELLED_POST_TAX_PROJECTION',
      dataClass: 'MODEL_ASSUMPTION',
      taxEventModel: 'GROSS_FLOWS_THEN_EXPLICIT_TAX_EVENTS',
      section112APortfolioAllocation,
    },
    inputsUsed: {
      annualIncome, incomeSource, regime, userAge, inflationRate, fiscalYear,
      deductions: { ...deductions },
      section112AExemptionUsed: section112AExemptionUsed ?? null,
      instruments: instruments.map(instrument => ({ ...instrument })),
    },
    rulesApplied: [...new Set(results.map(result => result.taxType))],
    unavailableReasons: [],
    results,
    portfolioStatus,
    excludedInstruments,
    summary: {
      status: portfolioStatus,
      totalTaxDrag,
      keptPerThousand,
      erodedPerThousand: keptPerThousand === null ? null : 1000 - keptPerThousand,
      retentionEfficiencyPercent: keptPerThousand === null ? null : keptPerThousand / 10,
      maxTaxRate,
    },
    insights,
  });
}));

/**
 * POST /api/tax/post-tax-scenario
 * Ephemeral tax-only scenario using transaction facts declared by this user.
 * This route does not fetch or persist product/provider data.
 */
router.post('/post-tax-scenario', validate(userDeclaredPostTaxScenarioSchema), asyncHandler(async (req, res) => {
  try {
    const result = calculateUserDeclaredPostTaxScenario(req.body);
    res.json({
      ...result,
      inputsUsed: { ...req.body },
    });
  } catch (error) {
    if (error?.code === 'FISCAL_YEAR_UNSUPPORTED') {
      return sendError(req, res, 422, `Verified tax rules are unavailable for ${req.body.fiscalYear}.`, 'FISCAL_YEAR_UNSUPPORTED');
    }
    throw error;
  }
}));

export default router;
