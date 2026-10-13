/**
 * Compatibility adapter for the post-tax routes.
 *
 * Tax policy and tax events live in taxEngine.js and
 * taxEventProjectionEngine.js. This file deliberately contains no tax-law
 * rates, cess multipliers, holding-period thresholds, or product-name
 * heuristics. The positional API remains temporarily for existing callers;
 * new callers should pass explicit options through the route.
 */

import {
  calculateCanonicalPostTaxOutcome,
  projectPostTaxCashFlows,
  MODEL_POST_TAX_STATUSES,
} from './taxEventProjectionEngine.js';

export const POST_TAX_SERVICE_VERSION = 'post-tax-adapter-3.0.0';

function validatePostTaxInput(result, nominalRate, instrumentType) {
  if (!Number.isFinite(nominalRate) || nominalRate < 0 || nominalRate > 1) {
    throw new RangeError('nominalRate must be an explicit decimal from 0 to 1');
  }
  if (result?.status !== MODEL_POST_TAX_STATUSES.CALCULATED) return result;
  if (!Number.isFinite(result.postTaxReturn)) {
    throw new RangeError(`${instrumentType}: postTaxReturn is not finite`);
  }
  if (result.postTaxReturn > nominalRate + 0.0001) {
    throw new RangeError(`${instrumentType}: postTaxReturn exceeds nominalRate`);
  }
  if (result.postTaxReturn < 0) {
    throw new RangeError(`${instrumentType}: postTaxReturn is negative`);
  }
  if (!Number.isFinite(result.taxRate) || result.taxRate < 0 || result.taxRate > 1) {
    throw new RangeError(`${instrumentType}: taxRate must be from 0 to 1`);
  }
  return result;
}

/**
 * Preserve the historical positional signature while routing every branch to
 * the canonical model. `isSgbRedeemedWithRBI` is only honored when explicitly
 * supplied by an old caller; it is never defaulted to RBI redemption.
 */
export function calculatePostTaxReturn(
  instrumentType,
  nominalRate,
  annualIncome,
  holdingYears,
  regime,
  monthlySIP,
  userAge,
  incomeSource,
  isSgbRedeemedWithRBI,
  fiscalYear,
  options = {},
) {
  if (!Number.isFinite(nominalRate) || nominalRate < 0 || nominalRate > 1) {
    throw new RangeError('nominalRate must be an explicit decimal from 0 to 1');
  }
  // Preserve the canonical tax-context validation order for legacy callers:
  // an incomplete income context should identify the missing income source
  // before the separate fiscal-year requirement is evaluated.
  if (!['salary', 'pension', 'family_pension', 'business', 'other'].includes(incomeSource)) {
    throw new TypeError('incomeSource must be explicitly provided');
  }
  if (typeof fiscalYear !== 'string' || !fiscalYear) {
    throw new TypeError('fiscalYear must be explicitly provided');
  }
  const explicitLegacyChannel = isSgbRedeemedWithRBI === true
    ? 'RBI_REDEMPTION'
    : isSgbRedeemedWithRBI === false
      ? 'SECONDARY_MARKET_SALE'
      : undefined;
  const normalizedOptions = {
    ...options,
    regime,
    holdingPeriodMonths: options.holdingPeriodMonths ?? (holdingYears * 12),
    section112AExemptionUsed: options.section112AExemptionUsed,
    redemptionChannel: options.redemptionChannel ?? explicitLegacyChannel,
    acquiredAtOriginalIssue: options.acquiredAtOriginalIssue,
    heldContinuously: options.heldContinuously,
  };
  const result = calculateCanonicalPostTaxOutcome({
    instrumentType,
    nominalRate,
    annualIncome,
    holdingYears,
    regime,
    monthlySIP,
    userAge,
    incomeSource,
    fiscalYear,
    deductions: options.deductions || {},
    options: normalizedOptions,
  });
  return validatePostTaxInput(result, nominalRate, instrumentType);
}

export function calculatePostTaxReturnSafe(...args) {
  const result = calculatePostTaxReturn(...args);
  return validatePostTaxInput(result, args[1], args[0]);
}

/**
 * Compute projected cash flows in the order required by the tax contract:
 * gross contributions/returns, explicit tax events, then post-tax value.
 */
export function calculatePostTaxProjection(postTaxResult, instrument, inflationRate, context = {}) {
  return projectPostTaxCashFlows({ postTaxResult, instrument, inflationRate, context });
}

export { MODEL_POST_TAX_STATUSES };
