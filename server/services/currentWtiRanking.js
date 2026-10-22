import { buildRecommendationProfile } from './recommendationProfile.js';
import { requireFreshRecommendationState } from './recommendationState.js';
import { rankWhereToInvestBackend } from './RecommendationPipeline.js';
import InvestorTaxContext from '../models/InvestorTaxContext.js';

const SAVED_TAX_CONTEXT_FIELDS = Object.freeze([
  'annualGrossIncome',
  'userAge',
  'incomeSource',
  'regime',
  'fiscalYear',
  'deductions',
  'section112AExemptionUsed',
]);

function hasCompleteTaxContext(context, { requireDeductions = false } = {}) {
  const deductionsAreValid = context?.deductions === undefined
    ? !requireDeductions
    : context.deductions !== null && typeof context.deductions === 'object' && !Array.isArray(context.deductions);
  return Number.isFinite(context?.annualGrossIncome) && context.annualGrossIncome >= 0
    && Number.isInteger(context?.userAge) && context.userAge >= 18 && context.userAge <= 120
    && ['salary', 'pension', 'family_pension', 'business', 'other'].includes(context?.incomeSource)
    && ['new', 'old'].includes(context?.regime)
    && typeof context?.fiscalYear === 'string'
    && deductionsAreValid;
}

async function latestTaxContext(model, userId, profileId) {
  return model.findOne({ userId, profileId }).sort({ version: -1 }).lean();
}

function currentSavedTaxContext(row, profileVersion) {
  if (!row || row.userDeclared !== true
      || !Number.isSafeInteger(Number(row.version)) || Number(row.version) < 1
      || Number(row.profileVersion) !== Number(profileVersion)) return null;
  const context = Object.fromEntries(SAVED_TAX_CONTEXT_FIELDS.map(field => [field, row[field]]));
  if (!hasCompleteTaxContext(context, { requireDeductions: true })) return null;
  context.deductions = { ...context.deductions };
  return context;
}

function taxContextRevision(row) {
  if (!row) return null;
  return [String(row._id || ''), Number(row.version), Number(row.profileVersion), String(row.inputFingerprint || '')].join(':');
}

function effectiveTaxContext(saved, requested) {
  if (!saved) return requested;
  if (!requested || typeof requested !== 'object' || Array.isArray(requested)) return saved;
  // A different selected fiscal year cannot borrow income, age, or deductions
  // from a saved context for another year. The caller must provide a complete
  // context for that year; the tax engine remains the only calculation authority.
  if (requested.fiscalYear && requested.fiscalYear !== saved.fiscalYear
      && !hasCompleteTaxContext(requested)) return requested;
  if (hasCompleteTaxContext(requested)) {
    return { ...requested, deductions: { ...(requested.deductions || {}) } };
  }
  return {
    ...saved,
    ...requested,
    deductions: requested.deductions === undefined
      ? { ...saved.deductions }
      : { ...requested.deductions },
  };
}

export function currentWtiBinding(state) {
  return {
    profileId: String(state.profile?._id || ''),
    profileVersion: Number(state.profileVersion),
    recommendationId: String(state.recommendation?._id || ''),
    allocationRevision: Number(state.allocationRevision?.revision),
    allocationRevisionId: String(state.allocationRevision?._id || ''),
    portfolioFingerprint: state.portfolioFingerprint || null,
    recommendationFingerprint: state.recommendationFingerprint || null,
  };
}

export function sameWtiBinding(left, right) {
  return Boolean(left && right)
    && left.profileId === right.profileId
    && left.profileVersion === right.profileVersion
    && left.recommendationId === right.recommendationId
    && left.allocationRevision === right.allocationRevision
    && left.allocationRevisionId === right.allocationRevisionId
    && left.portfolioFingerprint === right.portfolioFingerprint
    && left.recommendationFingerprint === right.recommendationFingerprint;
}

function conflict(code, message) {
  const error = new Error(message);
  error.status = 409;
  error.code = code;
  error.clientMessage = message;
  return error;
}

function invalidTaxYearAge() {
  const error = new Error('Tax age for the selected fiscal year must be an integer from 18 to 120.');
  error.status = 400;
  error.code = 'TAX_YEAR_AGE_INVALID';
  error.clientMessage = 'Enter a valid age for the selected fiscal year before requesting a tax illustration.';
  return error;
}

/**
 * Rank a selected parent only inside a verified current recommendation state.
 * The state is checked again after ranking so a delayed provider result cannot
 * be returned as if it belonged to a newer profile or allocation.
 */
export async function rankWtiAgainstCurrentState({
  userId,
  profileId,
  parentInstrumentId,
  expectedBinding,
  taxCalculationContext = null,
  dependencies = {},
} = {}) {
  const resolveState = dependencies.requireFreshRecommendationState || requireFreshRecommendationState;
  const rankProducts = dependencies.rankWhereToInvestBackend || rankWhereToInvestBackend;
  const profileBuilder = dependencies.buildRecommendationProfile || buildRecommendationProfile;
  const taxContextModel = dependencies.taxContextModel || InvestorTaxContext;

  const state = await resolveState({ userId, profileId });
  const initialBinding = currentWtiBinding(state);
  if (!sameWtiBinding(expectedBinding, initialBinding)) {
    throw conflict('FINANCIAL_STATE_CHANGED', 'The recommendation or allocation changed. Refresh the current plan before comparing products.');
  }

  const isCurrentRecommendationInstrument = state.currentAllocation?.instruments?.some(
    instrument => instrument?.id === parentInstrumentId,
  );
  if (!isCurrentRecommendationInstrument) {
    throw conflict('RECOMMENDATION_PARENT_MISMATCH', 'The selected category is not part of the current authoritative recommendation.');
  }

  const profile = profileBuilder(state.profile);
  // The append-only tax context is user-declared and bound to a saved profile
  // version. Use it only when it matches the exact current profile; scenario
  // inputs such as principal and holding period remain request-specific.
  const shouldReadSavedTaxContext = !hasCompleteTaxContext(taxCalculationContext);
  const initialTaxContextRow = shouldReadSavedTaxContext
    ? await latestTaxContext(taxContextModel, userId, profileId)
    : null;
  const savedTaxContext = currentSavedTaxContext(initialTaxContextRow, state.profileVersion);
  const calculationTaxContext = shouldReadSavedTaxContext
    ? effectiveTaxContext(savedTaxContext, taxCalculationContext)
    : effectiveTaxContext(null, taxCalculationContext);
  const suppliedAges = [taxCalculationContext?.userAge, taxCalculationContext?.deductions?.age]
    .filter(age => age !== undefined && age !== null);
  if (suppliedAges.some(age => !Number.isInteger(age) || age < 18 || age > 120)) {
    throw invalidTaxYearAge();
  }
  if (new Set(suppliedAges).size > 1) {
    throw invalidTaxYearAge();
  }

  const ranked = await rankProducts(
    profile,
    { parentInstrumentId, taxCalculationContext: calculationTaxContext },
    {
      onStageTiming: dependencies.onStageTiming,
      // WTI is a read-only comparison. Durable full-universe AMFI writes are
      // owned by the scheduled refresh lifecycle, not every user request.
      persistAmfiSnapshots: false,
    },
  );
  const finalState = await resolveState({ userId, profileId });
  const finalBinding = currentWtiBinding(finalState);
  if (!sameWtiBinding(initialBinding, finalBinding)) {
    throw conflict('FINANCIAL_STATE_CHANGED', 'The financial state changed while products were being ranked. Refresh the current plan and try again.');
  }

  if (shouldReadSavedTaxContext) {
    const finalTaxContextRow = await latestTaxContext(taxContextModel, userId, profileId);
    if (taxContextRevision(initialTaxContextRow) !== taxContextRevision(finalTaxContextRow)) {
      throw conflict('TAX_CONTEXT_CHANGED', 'Your saved tax context changed while products were being ranked. Refresh and try again.');
    }
  }

  return { ranked, financialStateBinding: finalBinding };
}
