import { Router } from 'express';
import { verifyJWT, isValidObjectId } from '../middleware/authMiddleware.js';
import { asyncHandler, createError, sendError } from '../middleware/errorHandler.js';
import { resolveCurrentFinancialProfile } from '../services/currentFinancialProfile.js';
import {
  DecisionInputError, compareIncomeInterruption, fromPaise, simulateHouseholdLedger,
} from '../services/genieDecision/ledger.js';

export function createGenieDecisionRouter({
  authenticate = verifyJWT,
  resolveProfile = resolveCurrentFinancialProfile,
} = {}) {
const router = Router();
const ALLOWED_INPUTS = new Set([
  'profileId', 'expectedProfileStateRevision', 'horizonMonths',
  'monthlyLivingExpenses', 'monthlyDebtPayments', 'monthlyInvestments',
  'goalReservations', 'incomeInterruption',
]);
const REQUIRED_INPUTS = [
  'profileId', 'expectedProfileStateRevision', 'horizonMonths',
  'monthlyLivingExpenses', 'monthlyDebtPayments', 'monthlyInvestments', 'goalReservations',
];

function canonicalMoney(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0
    || value > 10_000_000_000 || !Number.isSafeInteger(Math.round(value * 100))
    || Math.abs(value * 100 - Math.round(value * 100)) > 0.000001) {
    throw createError(422, `Canonical ${name} is unavailable or not representable in paise.`,
      `A supported two-decimal ${name} must be supplied in your financial profile.`,
      { code: 'REQUIRES_INPUTS' });
  }
  return fromPaise(BigInt(Math.round(value * 100)));
}

function validateRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => !ALLOWED_INPUTS.has(key))
    || REQUIRED_INPUTS.some(key => !Object.hasOwn(body, key))) {
    throw createError(400, 'Invalid decision preview request shape.',
      'Supply only the required GenieDecision fields.', { code: 'INVALID_DECISION_INPUT' });
  }
  if (!isValidObjectId(body.profileId)
    || !Number.isSafeInteger(body.expectedProfileStateRevision)
    || body.expectedProfileStateRevision < 1) {
    throw createError(400, 'Invalid profile binding for decision preview.',
      'A current profile identifier and positive profile state revision are required.',
      { code: 'INVALID_DECISION_BINDING' });
  }
}

function assertCurrent({ current, input }) {
  if (!current.profile || String(current.profile._id) !== input.profileId
    || Number(current.state.revision) !== input.expectedProfileStateRevision
    || current.state.resolutionStatus !== 'CURRENT') {
    throw createError(409, 'The requested financial state is no longer current.',
      'Refresh your financial profile and restart the decision preview.',
      { code: 'DECISION_STALE_PROFILE' });
  }
}

router.post('/preview', authenticate, asyncHandler(async (req, res) => {
  validateRequest(req.body);
  const input = req.body;
  const userId = req.user.userId;
  const initial = await resolveProfile({ userId, requireRecommendation: false });
  assertCurrent({ current: initial, input });

  // Never replace absent liquid savings with zero. All financial facts used
  // below come from the canonical owner-scoped profile pointer or from explicitly
  // supplied hypothetical allocations; no LLM or third-party data is involved.
  const profile = initial.profile;
  const baseline = {
    openingLiquidCash: canonicalMoney(profile.liquidSavings, 'liquidSavings'),
    monthlyTakeHome: canonicalMoney(profile.monthlyTakeHome, 'monthlyTakeHome'),
    declaredMonthlySavings: canonicalMoney(profile.monthlySavings, 'monthlySavings'),
    monthlyLivingExpenses: input.monthlyLivingExpenses,
    monthlyDebtPayments: input.monthlyDebtPayments,
    monthlyInvestments: input.monthlyInvestments,
  };
  let evaluation;
  try {
    const argumentsForLedger = {
      baseline, horizonMonths: input.horizonMonths, goalReservations: input.goalReservations,
    };
    evaluation = input.incomeInterruption === undefined || input.incomeInterruption === null
      ? simulateHouseholdLedger(argumentsForLedger)
      : compareIncomeInterruption({
        ...argumentsForLedger, incomeInterruption: input.incomeInterruption,
      });
  } catch (error) {
    if (!(error instanceof DecisionInputError)) throw error;
    return sendError(req, res, 422, error.message, error.code);
  }

  // Re-read the canonical pointer before responding, so results computed
  // against a profile changed during evaluation are not silently called current.
  const final = await resolveProfile({ userId, requireRecommendation: false });
  assertCurrent({ current: final, input });
  if (Number(final.profile.version) !== Number(profile.version)
    || Number(final.profile.financialStateFence ?? 0) !== Number(profile.financialStateFence ?? 0)) {
    throw createError(409, 'Financial inputs changed during the decision preview.',
      'Refresh your financial profile and repeat the preview.',
      { code: 'DECISION_STALE_PROFILE' });
  }

  return res.status(200).json({
    status: 'PARTIAL',
    previewOnly: true,
    authoritativeInvestmentRecommendation: false,
    profileId: input.profileId,
    financialProfileStateRevision: input.expectedProfileStateRevision,
    financialProfileVersion: profile.version,
    sourceClassification: {
      monthlyIncomeAndSavings: 'CANONICAL_PROFILE',
      liquidSavings: 'CANONICAL_PROFILE',
      monthlyLivingExpensesAndDebt: 'USER_DECLARED_UNVERIFIED',
      monthlyInvestmentsAndGoalReservations: 'HYPOTHETICAL_USER_INPUT',
      rateOrReturns: 'NOT_MODELED',
    },
    evaluation,
    missingVerification: [
      'Expenses and debt figures are user-declared; independent verification is unavailable.',
      'Goal reservations are hypothetical labels, not persisted or reconciled against current goal documents.',
    ],
  });
}));

return router;
}

export default createGenieDecisionRouter();
