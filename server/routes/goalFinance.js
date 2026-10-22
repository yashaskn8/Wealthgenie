import { Router } from 'express';
import Joi from 'joi';
import { verifyJWT } from '../middleware/authMiddleware.js';
import { asyncHandler, sendError } from '../middleware/errorHandler.js';
import { validateStrict } from '../validation/financialSchemas.js';
import GoalBudget from '../models/GoalBudget.js';
import Goal from '../models/Goal.js';
import { resolveCurrentFinancialProfile } from '../services/currentFinancialProfile.js';
import { resolveCurrentRecommendationState } from '../services/recommendationState.js';
import { buildCurrentGoalResponse } from '../services/goalResponse.js';
import {
  GOAL_EXPENSE_CATEGORIES, summarizeGoalBudget, allocateGoalFunding,
  assessVehiclePurchase, projectGoalSavings,
} from '../services/goalFinanceEngine.js';

const router = Router();
router.use(verifyJWT);

const rupee = Joi.number().min(0).max(1_000_000_000).precision(2);
const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
const expenseSchema = Joi.object({
  category: Joi.string().valid(...GOAL_EXPENSE_CATEGORIES).required(),
  frequency: Joi.string().valid('recurring', 'one_off').required(),
  amount: rupee.required(),
}).unknown(false);
const budgetSchema = Joi.object({
  expectedVersion: Joi.number().integer().min(0).required(),
  monthlyIncome: rupee.allow(null).required(),
  expensesComplete: Joi.boolean().required(),
  protectedMonthlyContributions: rupee.required(),
  expenses: Joi.array().items(expenseSchema).max(100).required(),
}).unknown(false);
const vehicleInput = Joi.object({
  price: rupee.required(),
  downPayment: rupee.required(),
  upfrontFees: rupee.required(),
  monthlyOwnershipCost: rupee.required(),
  annualInterestRate: Joi.number().min(0).max(45).required(),
  tenureMonths: Joi.number().integer().min(1).max(360).required(),
  emergencyCash: rupee.allow(null).required(),
  emergencyFloor: rupee.allow(null).required(),
}).unknown(false);
const vehicleSchema = vehicleInput.keys({
  alternatives: Joi.array().max(8).items(Joi.object({
    label: Joi.string().trim().min(1).max(100).required(),
    price: rupee.required(),
    downPayment: rupee.required(),
    upfrontFees: rupee.required(),
    monthlyOwnershipCost: rupee.required(),
  }).unknown(false)).optional(),
});
const projectionSchema = Joi.object({
  currentSavings: rupee.required(),
  monthlyContribution: rupee.required(),
  years: Joi.number().integer().min(1).max(50).required(),
  annualReturnAssumption: Joi.number().greater(-100).max(100).required(),
  annualInflationAssumption: Joi.number().greater(-100).max(100).required(),
}).unknown(false);

function checkMonth(req, res, next) {
  if (!monthPattern.test(String(req.params.month ?? ''))) {
    return sendError(req, res, 400, 'Invalid budget month. Use YYYY-MM.', 'GOAL_BUDGET_MONTH_INVALID');
  }
  next();
}
function conflict(req, res) {
  return sendError(req, res, 409, 'Budget changed in another session. Reload before saving.',
    'GOAL_BUDGET_VERSION_CONFLICT');
}
function visibleBudget(document) {
  if (!document) return null;
  return {
    month: document.month, version: document.version, monthlyIncome: document.monthlyIncome ?? null,
    expensesComplete: document.expensesComplete, protectedMonthlyContributions: document.protectedMonthlyContributions,
    expenses: document.expenses.map(e => ({ category: e.category, frequency: e.frequency, amount: e.amount })),
    updatedAt: document.updatedAt,
  };
}
function emptyBudget(month) {
  return { month, version: 0, monthlyIncome: null, expensesComplete: false,
    protectedMonthlyContributions: 0, expenses: [] };
}
async function getBudget(userId, month) {
  return GoalBudget.findOne({ userId, month }).lean();
}

router.get('/budget/:month', checkMonth, asyncHandler(async (req, res) => {
  const saved = await getBudget(req.user.userId, req.params.month);
  const budget = visibleBudget(saved) || emptyBudget(req.params.month);
  res.json({ budget, summary: summarizeGoalBudget(budget) });
}));

router.put('/budget/:month', checkMonth, validateStrict(budgetSchema), asyncHandler(async (req, res) => {
  // Fail closed until the explicit migration creates the unique index.
  // Without it, simultaneous first-month writes could create duplicate budgets.
  const indexes = await GoalBudget.collection.indexes().catch(error => {
    if (error?.codeName === 'NamespaceNotFound' || error?.code === 26) return [];
    throw error;
  });
  const uniqueOwnerMonth = indexes.some(index => index.name === 'goal_budget_owner_month_unique'
    && index.unique === true && index.key?.userId === 1 && index.key?.month === 1);
  if (!uniqueOwnerMonth) {
    return sendError(req, res, 503, 'Goals budget storage needs its index migration before saving.',
      'GOAL_BUDGET_INDEX_MIGRATION_REQUIRED');
  }
  const { expectedVersion, ...updates } = req.body;
  const userId = req.user.userId;
  const month = req.params.month;
  let saved;
  if (expectedVersion === 0) {
    try {
      saved = await GoalBudget.create({ userId, month, version: 1, ...updates });
    } catch (error) {
      if (error.code === 11000) return conflict(req, res);
      throw error;
    }
  } else {
    saved = await GoalBudget.findOneAndUpdate(
      { userId, month, version: expectedVersion },
      { $set: updates, $inc: { version: 1 } },
      { new: true, runValidators: true },
    );
    if (!saved) return conflict(req, res);
  }
  const budget = visibleBudget(saved);
  res.json({ budget, summary: summarizeGoalBudget(budget) });
}));

/**
 * Do not trust persisted goal calculationFreshness flags alone. Resolve the
 * same authoritative current-state provenance as GET /api/goals first.
 */
async function currentlyPresentableGoals(userId) {
  const goals = await Goal.find({ userId }).sort({ target_date: 1 }).limit(251).lean();
  if (goals.length > 250) {
    const error = new Error('Goal funding planner supports up to 250 goals.');
    error.status = 409;
    error.clientMessage = 'Too many goals for a shared funding assessment.';
    throw error;
  }
  let canonical;
  try {
    canonical = await resolveCurrentFinancialProfile({ userId, requireRecommendation: false });
  } catch {
    // Profiles absent or unavailable must not make stale investment estimates look fresh.
    return goals.map(g => buildCurrentGoalResponse(g, { resolutionFailure: true }));
  }
  const states = new Map();
  for (const profileId of new Set(goals.map(g => String(g.profileId)))) {
    if (!canonical.profile || String(canonical.profile._id) !== profileId) continue;
    try {
      const state = await resolveCurrentRecommendationState({ userId, profileId, requireFresh: false });
      state.financialProfileState = {
        stateId: canonical.state._id,
        currentProfileId: String(canonical.state.currentProfileId),
        revision: Number(canonical.state.revision),
        promotionFence: Number(canonical.state.promotionFence),
      };
      states.set(profileId, state);
    } catch {
      states.set(profileId, { resolutionFailure: true });
    }
  }
  return goals.map(g => {
    const state = states.get(String(g.profileId));
    return buildCurrentGoalResponse(g, {
      state: state?.recommendation ? state : null,
      resolutionFailure: !state || state.resolutionFailure === true,
    });
  });
}

router.get('/funding/:month', checkMonth, asyncHandler(async (req, res) => {
  const saved = await getBudget(req.user.userId, req.params.month);
  const budget = visibleBudget(saved) || emptyBudget(req.params.month);
  const summary = summarizeGoalBudget(budget);
  const goals = await currentlyPresentableGoals(req.user.userId);
  const capacity = summary.budgetStatus === 'SELF_REPORTED' ? Math.max(0, summary.recurringSurplus) : null;
  const plan = allocateGoalFunding(goals, capacity);
  res.json({
    month: req.params.month, budgetVersion: budget.version, budgetSummary: summary, plan,
    warning: 'Only user-declared budgeting information; an allocation plan is not a payment instruction.',
  });
}));

router.post('/vehicle/:month', checkMonth, validateStrict(vehicleSchema), asyncHandler(async (req, res) => {
  const saved = await getBudget(req.user.userId, req.params.month);
  const budget = visibleBudget(saved) || emptyBudget(req.params.month);
  const { alternatives = [], ...scenario } = req.body;
  const primary = assessVehiclePurchase(budget, scenario);
  const compared = alternatives.map(alt => ({
    label: alt.label,
    assessment: assessVehiclePurchase(budget, {
      ...scenario, price: alt.price, downPayment: alt.downPayment,
      upfrontFees: alt.upfrontFees, monthlyOwnershipCost: alt.monthlyOwnershipCost,
    }),
  }));
  res.json({
    month: req.params.month, budgetVersion: budget.version, primary,
    alternatives: compared.sort((a, b) =>
      a.assessment.totalNominalCostDuringLoan - b.assessment.totalNominalCostDuringLoan),
    source: 'USER_ENTERED_QUOTES_ONLY',
    livePriceVerified: false, quoteProvider: null,
  });
}));

router.post('/projection', validateStrict(projectionSchema), asyncHandler(async (req, res) => {
  res.json({
    projection: projectGoalSavings(req.body),
    note: 'User-specified hypothetical nominal pre-tax rates; not product rates, forecasts, or investment recommendations.',
  });
}));

export default router;
