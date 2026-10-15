import { Router } from 'express';
import mongoose from 'mongoose';
import { verifyJWT, isValidObjectId } from '../middleware/authMiddleware.js';
import { asyncHandler, createError } from '../middleware/errorHandler.js';
import { customGoalSchema, customGoalUpdateSchema, goalSimulationSchema, validateStrict } from '../validation/financialSchemas.js';
import Goal from '../models/Goal.js';
import RecommendationState from '../models/RecommendationState.js';
import FinancialProfile from '../models/FinancialProfile.js';
import FinancialProfileState from '../models/FinancialProfileState.js';
import { requireCurrentFinancialProfile, resolveCurrentFinancialProfile } from '../services/currentFinancialProfile.js';
import { reverseSIP, runMonteCarloWithGoal } from '../services/monteCarloEngine.js';
import { buildCovarianceMatrix, portfolioReturn, portfolioVol } from '../services/portfolioEngine.js';
import { getGoalAdvisory } from '../services/geminiService.js';
import {
  buildRecommendationProfile,
  buildRecommendationProfileHash,
  buildLlmFinancialContext,
} from '../services/recommendationProfile.js';
import { assessSuitabilityRisk } from '../services/riskProfiler.js';
import {
  completeMutationIdempotency,
  idempotency,
  resolveCommittedMutationForClaim,
} from '../middleware/idempotency.js';
import {
  PROJECTION_ASSUMPTION_DATA_CLASS,
  PROJECTION_ASSUMPTION_SOURCE,
  PROJECTION_ASSUMPTION_VERSION,
} from '../services/instrumentConstants.js';
import { triggerPlanHealthCheck } from '../services/planHealthMonitor.js';
import {
  assessGoalCalculationFreshness,
  requireFreshRecommendationState,
  resolveCurrentRecommendationState,
} from '../services/recommendationState.js';
import { buildCurrentGoalResponse, buildGoalAdvisoryMetadata } from '../services/goalResponse.js';
import {
  buildGoalCalculationInputFingerprint,
  getGoalProjectionYearsRemaining,
  GOAL_CALCULATION_POLICY_VERSION,
} from '../services/goalCalculationProvenance.js';
import { reachFinancialStateTestHook } from '../services/financialStateTestHooks.js';

const router = Router();
const GOAL_INFLATION_ASSUMPTION = 0.05;
const MAX_GOAL_PROJECTION_YEARS = 30;

function determineGoalStatus(probability, gap, monthlyCapacity) {
  if (probability >= 0.65 && gap <= 0) return 'on_track';
  if (probability >= 0.35 || gap <= monthlyCapacity * 0.25) return 'at_risk';
  return 'off_track';
}

async function findOwnedProfile(profileId, userId) {
  if (!isValidObjectId(profileId)) return null;
  return FinancialProfile.findOne({ _id: profileId, userId }).lean();
}

function computeYearsRemaining(targetDate, { allowNearTarget = false } = {}) {
  const date = new Date(targetDate);
  const now = new Date();
  const sixMonthsFromNow = new Date(now);
  sixMonthsFromNow.setMonth(sixMonthsFromNow.getMonth() + 6);
  const maximumProjectionDate = new Date(now);
  maximumProjectionDate.setFullYear(maximumProjectionDate.getFullYear() + MAX_GOAL_PROJECTION_YEARS);
  const invalidTargetClientMessage = allowNearTarget
    ? 'Choose a future goal date within the supported projection horizon of 30 years.'
    : 'Choose a goal date at least 6 months from now and within the supported projection horizon of 30 years.';
  if (!Number.isFinite(date.getTime()) || date <= now || date > maximumProjectionDate
      || (!allowNearTarget && date < sixMonthsFromNow)) {
    throw createError(400, 'Goal target date is outside the supported range.', invalidTargetClientMessage);
  }
  // Keep route calculations identical to the projection engine's rounded
  // month count. A positive target date that rounds below one month cannot be
  // projected and must remain unavailable instead of being rounded upward.
  const yearsRemaining = getGoalProjectionYearsRemaining(date, now);
  if (yearsRemaining === null) {
    throw createError(400, 'Goal target date is below the minimum supported monthly projection horizon.', 'Invalid target date.');
  }
  if (yearsRemaining > MAX_GOAL_PROJECTION_YEARS) {
    throw createError(400, 'Goal target date exceeds the projection engine limit.', invalidTargetClientMessage);
  }
  return yearsRemaining;
}

function toDecimalRate(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < -100 || number > 100) {
    throw new TypeError('Recommendation nominal return must be a percentage from -100 to 100');
  }
  return number / 100;
}

/** Uses only the persisted authoritative recommendation for this exact profile. */
export async function _getBlendedPortfolioMetrics(userId, profileId, profile = undefined) {
  const state = await resolveCurrentGoalSourceState({ userId, profileId, profile });
  const recommendation = state.currentRecommendationView;
  const instruments = recommendation?.instruments;
  if (!instruments?.length) {
    const error = new Error('Generate an authoritative recommendation before creating or recalculating goals.');
    error.status = 409;
    error.code = 'RECOMMENDATION_REQUIRED';
    throw error;
  }
  if (profile) {
    const expectedProfileHash = buildRecommendationProfileHash(profile, { modelVersion: recommendation.modelVersion });
    if (recommendation.profileInputHash !== expectedProfileHash) {
      const error = new Error('The authoritative recommendation is stale for the current Financial Profile.');
      error.status = 409;
      error.code = 'RECOMMENDATION_STALE';
      throw error;
    }
  }
  if (instruments.some(instrument => {
    const rawWeight = instrument.allocationWeight;
    const hasExplicitWeight = typeof rawWeight === 'number'
      || (typeof rawWeight === 'string' && rawWeight.trim() !== '');
    return !instrument.type || !hasExplicitWeight || !Number.isFinite(Number(rawWeight))
      || Number(rawWeight) < 0 || !Number.isFinite(Number(instrument.nominalReturn))
      || instrument.returnBasis !== 'PRE_TAX_NOMINAL' || instrument.postTaxReturn !== null;
  })) throw new TypeError('Persisted recommendation contains an invalid instrument');
  const totalWeight = instruments.reduce((sum, instrument) => sum + Number(instrument.allocationWeight), 0);
  if (!Number.isFinite(totalWeight) || Math.abs(totalWeight - 1) > 0.001) {
    throw new TypeError('Persisted recommendation allocation weights must total 1');
  }
  const weights = instruments.map(instrument => Number(instrument.allocationWeight));
  const returns = instruments.map(instrument => toDecimalRate(instrument.nominalReturn));
  const assetKeys = instruments.map(instrument => instrument.type);
  const primaryInstrument = instruments.find(instrument => Number(instrument.allocationWeight) > 0)?.type;
  if (!primaryInstrument) throw new TypeError('Persisted recommendation must allocate weight to at least one instrument');
  const expectedReturn = Number(portfolioReturn(weights, returns).toFixed(4));
  const volatility = Number(portfolioVol(buildCovarianceMatrix(assetKeys).matrix, weights).toFixed(4));
  return {
    expectedReturn,
    volatility,
    primaryInstrument,
    returnBasis: 'PRE_TAX_NOMINAL',
    returnDataClass: PROJECTION_ASSUMPTION_DATA_CLASS,
    returnAssumptionVersion: PROJECTION_ASSUMPTION_VERSION,
    returnAssumptionSource: PROJECTION_ASSUMPTION_SOURCE,
    returnAssumptionHash: state.allocationRevision?.returnAssumptionHash || null,
    recommendationFingerprint: state.recommendationFingerprint || null,
    state,
  };
}

async function resolveCurrentGoalSourceState({ userId, profileId, profile } = {}) {
  const currentProfile = await requireCurrentFinancialProfile({ userId, profileId });
  const state = await requireFreshRecommendationState({ userId, profileId, profile: profile || currentProfile.profile });
  state.financialProfileState = {
    stateId: currentProfile.state._id,
    currentProfileId: String(currentProfile.state.currentProfileId),
    revision: Number(currentProfile.state.revision),
    promotionFence: Number(currentProfile.state.promotionFence),
  };
  return state;
}

export function _validateMonteCarlo(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
      || !Number.isFinite(result.goal_probability) || result.goal_probability < 0 || result.goal_probability > 1) {
    throw new Error('Monte Carlo engine returned an invalid goal probability');
  }
  const percentileKeys = ['p10', 'p25', 'p50', 'p75', 'p90'];
  const years = result.years_array;
  const percentileArrays = percentileKeys.map(key => result[key]);
  const hasAlignedArrays = Array.isArray(years) && years.length > 0
    && percentileArrays.every(values => Array.isArray(values) && values.length === years.length);
  if (!hasAlignedArrays || !Number.isSafeInteger(result.simulations_run) || result.simulations_run < 1) {
    throw new Error('Monte Carlo engine returned invalid percentile bands');
  }

  for (let index = 0; index < years.length; index += 1) {
    if (!Number.isFinite(years[index]) || years[index] <= 0 || years[index] > 30
        || (index > 0 && years[index] <= years[index - 1])) {
      throw new Error('Monte Carlo engine returned an invalid projection horizon');
    }
    const values = percentileArrays.map(series => series[index]);
    if (values.some(value => !Number.isFinite(value) || value < 0)
        || values.some((value, percentileIndex) => percentileIndex > 0 && values[percentileIndex - 1] > value)) {
      throw new Error('Monte Carlo engine returned invalid percentile bands');
    }
  }

  const lastIndex = years.length - 1;
  return lastIndex;
}

function chartData(result) {
  return result.years_array.map((year, index) => ({
    year,
    p10: result.p10[index], p25: result.p25[index], p50: result.p50[index],
    p75: result.p75[index], p90: result.p90[index],
  }));
}

async function generateGoalAdvice(goal, profile) {
  const suitability = assessSuitabilityRisk(profile);
  const context = buildLlmFinancialContext(profile, suitability);
  const prompt = 'Suggest one adjustment to this saved goal using its verified status and whether the required monthly contribution fits within savings capacity. Do not calculate or assume exact amounts or returns.';
  try {
    return await getGoalAdvisory(prompt, context, {
      recommendedSip: Number(goal.recommended_sip),
      monthlySavingsCapacity: profile.monthlySavings,
      status: goal.status,
    });
  } catch {
    return `Review the target date or target amount because the required ₹${Number(goal.recommended_sip).toLocaleString('en-IN')} monthly SIP must stay within your ₹${profile.monthlySavings.toLocaleString('en-IN')} savings capacity.`;
  }
}

export async function persistGoalAtomically(goalData, _profileId, { testHooks = {} } = {}) {
  const goal = await Goal.create(goalData);
  await testHooks.afterGoalCreate?.(null, goal);
  return goal;
}

function goalStateConflict() {
  return createError(
    409,
    'The financial state changed while the goal calculation was running.',
    'Recalculate the goal before saving it.',
    { code: 'GOAL_SOURCE_STATE_CHANGED' },
  );
}

function goalVersionConflict(expectedVersion) {
  return createError(
    409,
    'The goal changed while this request was in progress.',
    'This goal was updated elsewhere. Refresh it and retry your change.',
    { code: 'GOAL_VERSION_CONFLICT', details: { expectedVersion } },
  );
}

function goalVersionCondition(version) {
  return version === 1
    ? { $or: [{ version: 1 }, { version: { $exists: false } }] }
    : { version };
}

async function updateGoalWithCAS(goal, { userId, expectedVersion, session = null } = {}) {
  const update = goal.toObject({ depopulate: true, flattenMaps: true });
  delete update._id;
  delete update.__v;
  delete update.version;
  delete update.createdAt;
  delete update.updatedAt;
  delete update.userId;
  delete update.profileId;
  delete update.idempotencyOperationId;
  delete update.idempotencyRequestHash;
  const filter = { _id: goal._id, userId, ...goalVersionCondition(expectedVersion) };
  let query = Goal.findOneAndUpdate(filter, { $set: { ...update, version: expectedVersion + 1 } }, {
    new: true,
    runValidators: true,
    context: 'query',
  });
  if (session) query = query.session(session);
  const updated = await query;
  if (!updated) throw goalVersionConflict(expectedVersion);
  return updated;
}

function plannedStateMatches(current, planned) {
  return Boolean(
    planned?.recommendation?._id
      && current?.recommendation?._id
      && String(planned.recommendation._id) === String(current.recommendation._id)
      && Number(planned.allocationRevision?.revision) === Number(current.allocationRevision?.revision)
      && String(planned.allocationRevision?._id) === String(current.allocationRevision?._id)
      && planned.portfolioFingerprint === current.portfolioFingerprint
      && planned.recommendationFingerprint === current.recommendationFingerprint,
  );
}

async function assertGoalPlanStateCurrent({ userId, profileId, profile, plannedState }) {
  const current = await resolveCurrentGoalSourceState({ userId, profileId, profile });
  if (!plannedStateMatches(current, plannedState)) throw goalStateConflict();
  if (!plannedState?.financialProfileState
      || current.financialProfileState?.currentProfileId !== String(profileId)
      || Number(current.financialProfileState?.revision) !== Number(plannedState.financialProfileState.revision)) {
    throw createError(409, 'The canonical financial profile changed while the goal calculation was running.', 'Recalculate the goal before saving it.', {
      code: 'PROFILE_STATE_VERSION_CONFLICT',
    });
  }
  return current;
}

function committedGoalReconciliationError(goal, cause) {
  const error = createError(
    503,
    'The goal operation committed, but its current response could not be safely reconciled.',
    'Your goal change was saved, but its current status could not be verified. Refresh before continuing.',
    {
      code: 'COMMITTED_BUT_RESPONSE_RECONCILIATION_FAILED',
      details: { operation_committed: true, resource_type: 'Goal', goalId: String(goal._id) },
    },
  );
  error.cause = cause;
  return error;
}

const POST_COMMIT_GOAL_RECONCILIATION_ATTEMPTS = 3;
const GOAL_FINANCIAL_POINTER_FIELDS = Object.freeze([
  'currentRecommendationId', 'currentAllocationRevision', 'currentAllocationRevisionId',
  'generationRevision', 'profileInputHash', 'profileVersion', 'portfolioFingerprint',
  'returnAssumptionVersion', 'returnAssumptionHash', 'returnAssumptionSource',
]);

function sameGoalSnapshot(left, right) {
  return Boolean(left && right)
    && String(left._id) === String(right._id)
    && String(left.userId) === String(right.userId)
    && String(left.profileId) === String(right.profileId)
    && Number(left.version ?? 1) === Number(right.version ?? 1)
    && buildGoalCalculationInputFingerprint(left) === buildGoalCalculationInputFingerprint(right)
    && String(left.sourceRecommendationId || '') === String(right.sourceRecommendationId || '')
    && String(left.sourceAllocationRevisionId || '') === String(right.sourceAllocationRevisionId || '')
    && String(left.sourcePortfolioFingerprint || '') === String(right.sourcePortfolioFingerprint || '')
    && String(left.advisoryMetadata?.goalCalculationFingerprint || '')
      === String(right.advisoryMetadata?.goalCalculationFingerprint || '');
}

function sameGoalCurrentSource(snapshot, current) {
  const leftFinancial = snapshot?.state?.financialProfileState;
  const rightFinancial = current?.state;
  if (!leftFinancial || !rightFinancial
      || String(leftFinancial.stateId || '') !== String(rightFinancial._id || '')
      || String(leftFinancial.currentProfileId || '') !== String(rightFinancial.currentProfileId || '')
      || Number(leftFinancial.revision) !== Number(rightFinancial.revision)
      || Number(leftFinancial.promotionFence) !== Number(rightFinancial.promotionFence)
      || String(snapshot.currentProfileId || '') !== String(current.profile?._id || '')) return false;

  const leftPointer = snapshot.state?.statePointer;
  const rightPointer = current.recommendationState;
  return !leftPointer || (rightPointer && GOAL_FINANCIAL_POINTER_FIELDS.every(field => (
    String(leftPointer[field] ?? '') === String(rightPointer[field] ?? '')
  )));
}

async function resolveGoalResponseAfterCommit(goal, userId) {
  try {
    for (let attempt = 1; attempt <= POST_COMMIT_GOAL_RECONCILIATION_ATTEMPTS; attempt += 1) {
      const session = await mongoose.startSession();
      let snapshot = null;
      try {
        await session.withTransaction(async () => {
          snapshot = null;
          const currentGoal = await Goal.findOne({ _id: goal._id, userId }).session(session).lean();
          if (!currentGoal) {
            snapshot = { goal: null, state: null, currentProfileId: null, deleted: true };
            return;
          }
          await reachFinancialStateTestHook('goal.post_commit.after_resource_read', {
            userId: String(userId),
            goalId: String(goal._id),
            goalVersion: Number(currentGoal.version ?? 1),
            attempt,
          });

          const currentProfile = await resolveCurrentFinancialProfile({
            userId,
            session,
            requireRecommendation: false,
          });
          const financialProfileState = {
            stateId: currentProfile.state?._id || null,
            currentProfileId: currentProfile.state?.currentProfileId
              ? String(currentProfile.state.currentProfileId)
              : null,
            revision: Number(currentProfile.state?.revision ?? 0),
            promotionFence: Number(currentProfile.state?.promotionFence ?? 0),
          };
          if (!currentProfile.profile || String(currentProfile.profile._id) !== String(currentGoal.profileId)) {
            snapshot = {
              goal: currentGoal,
              state: { recommendation: null, financialProfileState },
              currentProfileId: currentProfile.profile?._id ? String(currentProfile.profile._id) : null,
              deleted: false,
            };
            return;
          }

          const state = await resolveCurrentRecommendationState({
            userId,
            profileId: currentGoal.profileId,
            profile: currentProfile.profile,
            session,
          });
          if (state.provenance?.status !== 'PERSISTED_REVISION') {
            throw Object.assign(new Error('Canonical recommendation state integrity check failed.'), {
              code: state.provenance?.reasonCode || state.provenance?.status || 'FINANCIAL_STATE_UNVERIFIABLE',
            });
          }
          state.financialProfileState = financialProfileState;
          snapshot = {
            goal: currentGoal,
            state,
            currentProfileId: String(currentProfile.profile._id),
            deleted: false,
          };
        }, {
          readPreference: 'primary',
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
        });
      } finally {
        await session.endSession();
      }

      if (snapshot?.deleted) return snapshot;
      if (!snapshot?.goal || !snapshot.state) throw new Error('Goal response snapshot could not be reconstructed.');
      const confirmedGoal = await Goal.findOne({ _id: goal._id, userId }).lean();
      if (!confirmedGoal) return { goal: null, state: null, currentProfileId: null, deleted: true };
      const confirmedProfile = await resolveCurrentFinancialProfile({
        userId,
        requireRecommendation: Boolean(snapshot.state?.statePointer),
      });
      if (sameGoalSnapshot(snapshot.goal, confirmedGoal) && sameGoalCurrentSource(snapshot, confirmedProfile)) return snapshot;
    }
    throw Object.assign(new Error('The goal or its financial source changed during response reconciliation.'), {
      code: 'GOAL_POST_COMMIT_STATE_UNSTABLE',
    });
  } catch (error) {
    throw committedGoalReconciliationError(goal, error);
  }
}

function committedGoalDeletedError(goal) {
  return createError(
    409,
    'The goal operation committed, but the goal was deleted before its response was reconciled.',
    'Your change was saved and the goal was subsequently deleted. Refresh your goals before continuing.',
    {
      code: 'GOAL_DELETED_AFTER_COMMIT',
      details: {
        operation_committed: true,
        resource_type: 'Goal',
        goalId: String(goal._id),
        committed_goal_version: Number(goal.version ?? 1),
      },
    },
  );
}

async function holdGoalSourceState(session, { userId, profileId, state }) {
  const stateId = state?.provenance?.stateId;
  const profileBinding = state?.financialProfileState;
  if (!stateId || !state.recommendation?._id || !state.allocationRevision?._id
      || !profileBinding?.stateId || Number(profileBinding.revision) < 1
      || String(profileBinding.currentProfileId) !== String(profileId)) throw goalStateConflict();
  const profileStateFence = await FinancialProfileState.updateOne({
    _id: profileBinding.stateId,
    userId,
    currentProfileId: profileId,
    resolutionStatus: 'CURRENT',
    revision: profileBinding.revision,
    promotionFence: profileBinding.promotionFence,
  }, { $inc: { promotionFence: 1 } }).session(session);
  if (profileStateFence.matchedCount !== 1) {
    throw createError(409, 'The canonical financial profile changed before the goal write completed.', 'Refresh the current profile and retry.', {
      code: 'PROFILE_STATE_VERSION_CONFLICT',
    });
  }
  if (state.profileVersion !== null && state.profileVersion !== undefined) {
    const profileResult = await FinancialProfile.updateOne({
      _id: profileId,
      userId,
      version: state.profileVersion,
    }, {
      // A real write fence makes overlapping profile edits conflict under
      // Mongo snapshot isolation; a no-op update is not a reliable lock.
      $inc: { financialStateFence: 1 },
    }).session(session);
    if (profileResult.matchedCount !== 1) throw goalStateConflict();
  }
  const result = await RecommendationState.updateOne({
    _id: stateId,
    userId,
    profileId,
    currentRecommendationId: state.recommendation._id,
    currentAllocationRevision: state.allocationRevision.revision,
    currentAllocationRevisionId: state.allocationRevision._id,
    generationRevision: state.recommendation.recommendationGeneration,
    profileInputHash: state.recommendation.profileInputHash,
    profileVersion: state.profileVersion,
    portfolioFingerprint: state.portfolioFingerprint,
    returnAssumptionVersion: state.allocationRevision.returnAssumptionVersion,
    returnAssumptionHash: state.allocationRevision.returnAssumptionHash,
    returnAssumptionSource: state.allocationRevision.returnAssumptionSource,
  }, {
    // A real write fence binds this calculation to the resolved pointer.
    $inc: { financialStateFence: 1 },
  }).session(session);
  if (result.matchedCount !== 1) throw goalStateConflict();
}

async function persistGoalWithSourceState(goalData, { userId, profileId, sourceState, idempotencyClaim = null, testHooks = {} } = {}) {
  const session = await mongoose.startSession();
  let created;
  let transactionCommitted = false;
  try {
    await session.withTransaction(async () => {
      await holdGoalSourceState(session, { userId, profileId, state: sourceState });
      created = new Goal(goalData);
      await created.save({ session });
      await reachFinancialStateTestHook('goal.create.afterInsertBeforeCommit', {
        goalId: String(created._id),
        session,
        transactionActive: session.inTransaction(),
      });
      await testHooks.afterGoalCreate?.(session, created);
      if (idempotencyClaim) {
        await completeMutationIdempotency(session, idempotencyClaim, {
          resourceType: 'Goal', resourceId: created._id, status: 201,
        });
      }
    });
    transactionCommitted = true;
  } finally {
    try {
      await session.endSession();
    } catch (error) {
      if (!transactionCommitted) throw error;
      console.warn('[Goals] Session cleanup failed after committed create.', { error: error.message });
    }
  }
  return created;
}

async function saveGoalWithSourceState(goal, { userId, profileId, sourceState, expectedGoalVersion } = {}) {
  const session = await mongoose.startSession();
  let updatedGoal;
  let transactionCommitted = false;
  try {
    await session.withTransaction(async () => {
      updatedGoal = await updateGoalWithCAS(goal, { userId, expectedVersion: expectedGoalVersion, session });
      await holdGoalSourceState(session, { userId, profileId, state: sourceState });
    });
    transactionCommitted = true;
  } finally {
    try {
      await session.endSession();
    } catch (error) {
      if (!transactionCommitted) throw error;
      console.warn('[Goals] Session cleanup failed after committed update.', { error: error.message });
    }
  }
  return updatedGoal;
}

async function resolveGoalCreateReplay(req, operation) {
  const goal = await Goal.findOne({
    _id: operation.resourceId,
    userId: req.user.userId,
    idempotencyOperationId: operation._id,
    idempotencyRequestHash: operation.requestHash,
  }).lean();
  if (!goal) {
    throw createError(503, 'Committed goal operation has no matching owned goal.', 'Refresh your goals before continuing.', { code: 'IDEMPOTENCY_STATE_CORRUPT' });
  }
  const state = await resolveCurrentRecommendationState({
    userId: req.user.userId,
    profileId: goal.profileId,
    requireFresh: false,
  });
  return { goal: buildCurrentGoalResponse(goal, { state: state.recommendation ? state : null }) };
}

async function calculateGoalPlan({ profile, profileId, userId, targetAmount, targetDate, currentSavings, allowNearTarget = false }) {
  // Establish that this is still the caller's current profile and that its
  // authoritative recommendation is current before relaxing the creation
  // window for an existing goal's explicit recalculation.
  const metrics = await _getBlendedPortfolioMetrics(userId, profileId, profile);
  const yearsRemaining = computeYearsRemaining(targetDate, { allowNearTarget });
  const inflationAdjustedTarget = Math.round(targetAmount * (1 + GOAL_INFLATION_ASSUMPTION) ** yearsRemaining);
  const rawSip = reverseSIP(inflationAdjustedTarget, metrics.expectedReturn, yearsRemaining, currentSavings);
  if (!Number.isFinite(rawSip)) throw new Error('Unable to calculate required SIP');
  const requiredSip = Math.max(0, Math.round(rawSip));
  const simulatedMonthlyContribution = Math.min(requiredSip, profile.monthlySavings);
  const result = runMonteCarloWithGoal({
    monthlyInvestment: simulatedMonthlyContribution,
    annualExpectedReturn: metrics.expectedReturn,
    annualVolatility: metrics.volatility,
    years: yearsRemaining,
    simulations: 5000,
    inflationRate: GOAL_INFLATION_ASSUMPTION,
    targetAmount: inflationAdjustedTarget,
    currentSavings,
  });
  const lastIndex = _validateMonteCarlo(result);
  await reachFinancialStateTestHook('goal.calculation.beforeStateRecheck', { userId, profileId, state: metrics.state });
  await assertGoalPlanStateCurrent({ userId, profileId, profile, plannedState: metrics.state });
  const gap = Math.max(0, requiredSip - profile.monthlySavings);
  return {
    yearsRemaining,
    metrics,
    inflationAdjustedTarget,
    requiredSip,
    simulatedMonthlyContribution,
    result,
    lastIndex,
    gap,
    status: determineGoalStatus(result.goal_probability, gap, profile.monthlySavings),
  };
}

router.post('/create', verifyJWT, validateStrict(customGoalSchema), idempotency({ operation: 'goals.create', resolveReplay: resolveGoalCreateReplay }), asyncHandler(async (req, res) => {
  const { goal_name, target_amount, target_date, current_savings, profileId, priority } = req.body;
  const stored = await findOwnedProfile(profileId, req.user.userId);
  if (!stored) throw createError(404, 'Profile not found or access denied', 'Build a financial profile first.');
  const profile = buildRecommendationProfile(stored);

  const duplicate = await Goal.exists({
    userId: req.user.userId,
    goal_name: { $regex: new RegExp(`^${goal_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
  });
  if (duplicate) throw createError(409, `Duplicate goal name: ${goal_name}`, 'A goal with this name already exists.');

  const plan = await calculateGoalPlan({
    profile, profileId, userId: req.user.userId, targetAmount: target_amount,
    targetDate: target_date, currentSavings: current_savings,
  });
  const data = {
    _id: new mongoose.Types.ObjectId(),
    userId: req.user.userId,
    version: 1,
    idempotencyOperationId: req.idempotencyClaim.operationId,
    idempotencyRequestHash: req.idempotencyClaim.requestHash,
    profileId,
    goal_name,
    target_amount,
    inflation_adjusted_target: plan.inflationAdjustedTarget,
    target_date: new Date(target_date),
    current_savings,
    recommended_sip: plan.requiredSip,
    simulated_monthly_contribution: plan.simulatedMonthlyContribution,
    recommended_instrument: plan.metrics.primaryInstrument,
    probability_of_success: plan.result.goal_probability,
    gap_amount: plan.gap,
    status: plan.status,
    priority,
    monte_carlo_summary: {
      p10: plan.result.p10[plan.lastIndex], p25: plan.result.p25[plan.lastIndex],
      p50: plan.result.p50[plan.lastIndex], p75: plan.result.p75[plan.lastIndex],
      p90: plan.result.p90[plan.lastIndex], simulations_run: plan.result.simulations_run,
    },
    chart_data: chartData(plan.result),
    mc_computed_at: new Date(),
    years_remaining: plan.yearsRemaining,
    simulation_classification: 'PROFILE_GROUNDED_GOAL_PLAN',
    return_basis: plan.metrics.returnBasis,
    return_data_class: plan.metrics.returnDataClass,
    return_assumption_version: plan.metrics.returnAssumptionVersion,
    return_assumption_source: plan.metrics.returnAssumptionSource,
    sourceRecommendationId: plan.metrics.state?.recommendation?._id || null,
    sourceAllocationRevision: plan.metrics.state?.allocationRevision?.revision || null,
    sourceAllocationRevisionId: plan.metrics.state?.allocationRevision?._id || null,
    sourceProfileInputHash: plan.metrics.state?.recommendation?.profileInputHash || null,
    sourceProfileVersion: plan.metrics.state?.profileVersion || null,
    sourceFinancialProfileStateRevision: plan.metrics.state?.financialProfileState?.revision ?? null,
    sourceModelVersion: plan.metrics.state?.recommendation?.modelVersion || null,
    sourceRecommendationPolicyVersion: plan.metrics.state?.recommendation?.recommendationPolicyVersion || null,
    sourceRegulatoryRuleVersion: plan.metrics.state?.recommendation?.regulatoryRuleVersion || null,
    sourceReturnAssumptionVersion: plan.metrics.state?.allocationRevision?.returnAssumptionVersion || plan.metrics.returnAssumptionVersion,
    sourceReturnAssumptionHash: plan.metrics.state?.allocationRevision?.returnAssumptionHash || plan.metrics.returnAssumptionHash,
    sourceReturnAssumptionSource: plan.metrics.state?.allocationRevision?.returnAssumptionSource || plan.metrics.returnAssumptionSource,
    sourceRecommendationFingerprint: plan.metrics.state?.recommendationFingerprint || plan.metrics.recommendationFingerprint,
    sourcePortfolioFingerprint: plan.metrics.state?.portfolioFingerprint || null,
    calculationFreshness: { fresh: true, reasonCodes: [], checkedAt: new Date() },
    observed_market_fact: false,
    provider_forecast: false,
    inflation_assumption: GOAL_INFLATION_ASSUMPTION,
  };
  data.sourceGoalCalculationInputFingerprint = buildGoalCalculationInputFingerprint(data);
  data.sourceGoalCalculationPolicyVersion = GOAL_CALCULATION_POLICY_VERSION;
  if (!data.sourceGoalCalculationInputFingerprint) {
    throw new Error('Could not establish the goal calculation input fingerprint.');
  }
  let goal;
  try {
    const currentState = await assertGoalPlanStateCurrent({
      userId: req.user.userId,
      profileId,
      profile,
      plannedState: plan.metrics.state,
    });
    data.gemini_advice = await generateGoalAdvice(data, profile);
    await reachFinancialStateTestHook('goal.advisory.beforePersistence', {
      userId: req.user.userId, profileId, goalId: data._id, sourceState: currentState,
    });
    data.advisoryMetadata = buildGoalAdvisoryMetadata({ goal: data, state: currentState });
    goal = await persistGoalWithSourceState(data, {
      userId: req.user.userId,
      profileId,
      sourceState: currentState,
      idempotencyClaim: req.idempotencyClaim,
    });
  } catch (error) {
    const committedReplay = await resolveCommittedMutationForClaim(req, req.idempotencyClaim);
    if (committedReplay) {
      req.idempotencyCommitted = true;
      clearInterval(req.idempotencyClaim.heartbeat);
      res.setHeader('X-Cache-Lookup', 'HIT - Idempotent');
      return res.status(committedReplay.status).json(committedReplay.body);
    }
    if (error.code === 11000) throw createError(409, `Duplicate goal name: ${goal_name}`, 'A goal with this name already exists.');
    throw error;
  }
  req.idempotencyCommitted = true;
  clearInterval(req.idempotencyClaim.heartbeat);
  await reachFinancialStateTestHook('goal.create.afterCommitBeforeResponse', {
    userId: String(req.user.userId),
    goalId: String(goal._id),
    operationId: req.idempotencyClaim.operationId,
  });
  void triggerPlanHealthCheck({ userId: req.user.userId, profileId });
  const reconciliation = await resolveGoalResponseAfterCommit(goal, req.user.userId);
  if (reconciliation.deleted) throw committedGoalDeletedError(goal);
  res.status(201).json({
    goal: buildCurrentGoalResponse(reconciliation.goal, {
      state: reconciliation.state?.recommendation ? reconciliation.state : null,
    }),
  });
}));

router.get('/', verifyJWT, asyncHandler(async (req, res) => {
  // GET is deliberately read-only. Advice regeneration is an explicit
  // PATCH so a list request never fans out to LLM providers or writes goals.
  const goals = await Goal.find({ userId: req.user.userId }).sort({ target_date: 1 }).lean();
  const stateByProfile = new Map();
  await Promise.all([...new Set(goals.map(goal => String(goal.profileId)))].map(async profileId => {
    try {
      const profileState = await resolveCurrentFinancialProfile({ userId: req.user.userId, requireRecommendation: false });
      if (!profileState.profile || String(profileState.profile._id) !== profileId) {
        stateByProfile.set(profileId, { recommendation: null, financialProfileState: profileState.state });
        return;
      }
      const state = await resolveCurrentRecommendationState({
        userId: req.user.userId,
        profileId,
        requireFresh: false,
      });
      state.financialProfileState = {
        stateId: profileState.state._id,
        currentProfileId: String(profileState.state.currentProfileId),
        revision: Number(profileState.state.revision),
        promotionFence: Number(profileState.state.promotionFence),
      };
      stateByProfile.set(profileId, state);
    } catch {
      // Resolver/provider/database messages may contain internal details. The
      // response exposes only a stable failure marker, never the raw error.
      stateByProfile.set(profileId, { resolutionFailure: true });
    }
  }));
  res.json({ goals: goals.map(goal => {
    const state = stateByProfile.get(String(goal.profileId));
    return buildCurrentGoalResponse(goal, {
      state: state?.recommendation || state?.financialProfileState ? state : null,
      resolutionFailure: state?.resolutionFailure === true,
    });
  }) });
}));

router.post('/:goalId/simulate', verifyJWT, validateStrict(goalSimulationSchema), asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.goalId)) throw createError(400, 'Invalid goalId', 'Invalid goal ID.');
  const goal = await Goal.findOne({ _id: req.params.goalId, userId: req.user.userId }).lean();
  if (!goal) throw createError(404, 'Goal not found', 'Goal not found.');
  const stored = await findOwnedProfile(goal.profileId, req.user.userId);
  if (!stored) throw createError(409, 'The goal profile is unavailable.', 'Financial profile unavailable.');
  const profile = buildRecommendationProfile(stored);
  const monthlyContribution = req.body.monthly_contribution;
  if (monthlyContribution > profile.monthlySavings) {
    throw createError(400, 'Monthly contribution exceeds the Financial Profile savings capacity.', 'Contribution exceeds monthly savings capacity.');
  }
  const metrics = await _getBlendedPortfolioMetrics(req.user.userId, goal.profileId, profile);
  const yearsRemaining = computeYearsRemaining(goal.target_date, { allowNearTarget: true });
  const goalFreshness = assessGoalCalculationFreshness(goal, metrics.state);
  if (!goalFreshness.fresh) {
    throw createError(
      409,
      'Goal calculation is stale for the current financial state.',
      'Recalculate the goal before running this simulation.',
      { code: 'GOAL_CALCULATION_STALE', calculationFreshness: goalFreshness },
    );
  }
  const simulatedGoalVersion = Number(goal.version ?? 1);
  const simulatedGoalInputFingerprint = buildGoalCalculationInputFingerprint(goal);
  if (!Number.isSafeInteger(simulatedGoalVersion) || simulatedGoalVersion < 1 || !simulatedGoalInputFingerprint) {
    throw createError(409, 'The goal calculation identity is unavailable.', 'Refresh and recalculate this goal before running a what-if simulation.', {
      code: 'GOAL_CALCULATION_STALE',
    });
  }
  const result = runMonteCarloWithGoal({
    monthlyInvestment: monthlyContribution,
    annualExpectedReturn: metrics.expectedReturn,
    annualVolatility: metrics.volatility,
    years: yearsRemaining,
    simulations: 5000,
    inflationRate: GOAL_INFLATION_ASSUMPTION,
    targetAmount: goal.inflation_adjusted_target,
    currentSavings: goal.current_savings,
  });
  const lastIndex = _validateMonteCarlo(result);
  await reachFinancialStateTestHook('goal.simulation.beforeGoalRecheck', {
    userId: String(req.user.userId),
    goalId: String(goal._id),
    goalVersion: simulatedGoalVersion,
    goalCalculationInputFingerprint: simulatedGoalInputFingerprint,
  });
  const currentGoal = await Goal.findOne({ _id: goal._id, userId: req.user.userId }).lean();
  if (!currentGoal
      || Number(currentGoal.version ?? 1) !== simulatedGoalVersion
      || buildGoalCalculationInputFingerprint(currentGoal) !== simulatedGoalInputFingerprint) {
    throw goalVersionConflict(simulatedGoalVersion);
  }
  await assertGoalPlanStateCurrent({
    userId: req.user.userId,
    profileId: goal.profileId,
    profile,
    plannedState: metrics.state,
  });
  const gap = Math.max(0, goal.recommended_sip - monthlyContribution);
  res.json({
    goalId: goal._id,
    goal_version: simulatedGoalVersion,
    goal_calculation_input_fingerprint: simulatedGoalInputFingerprint,
    monthly_contribution: monthlyContribution,
    probability_of_success: result.goal_probability,
    status: determineGoalStatus(result.goal_probability, gap, profile.monthlySavings),
    gap_amount: gap,
    chartData: chartData(result),
    monte_carlo_summary: {
      p10: result.p10[lastIndex], p25: result.p25[lastIndex], p50: result.p50[lastIndex],
      p75: result.p75[lastIndex], p90: result.p90[lastIndex], simulations_run: result.simulations_run,
    },
    simulation_classification: 'NON_RECOMMENDATION_GOAL_WHAT_IF',
    return_basis: metrics.returnBasis,
    return_data_class: metrics.returnDataClass,
    return_assumption_version: metrics.returnAssumptionVersion,
    return_assumption_source: metrics.returnAssumptionSource,
    allocation_revision: metrics.state.allocationRevision.revision,
    allocation_revision_id: metrics.state.allocationRevision._id,
    portfolio_fingerprint: metrics.state.portfolioFingerprint,
    observed_market_fact: false,
    provider_forecast: false,
    inflation_assumption: GOAL_INFLATION_ASSUMPTION,
  });
}));

router.patch('/:goalId/refresh-advice', verifyJWT, asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.goalId)) throw createError(400, 'Invalid goalId', 'Invalid goal ID.');
  let goal = await Goal.findOne({ _id: req.params.goalId, userId: req.user.userId });
  if (!goal) throw createError(404, 'Goal not found', 'Goal not found.');
  const expectedGoalVersion = Number(goal.version ?? 1);
  const stored = await findOwnedProfile(goal.profileId, req.user.userId);
  if (!stored) throw createError(409, 'The goal profile is unavailable.', 'Financial profile unavailable.');
  const profile = buildRecommendationProfile(stored);
  const state = await resolveCurrentGoalSourceState({ userId: req.user.userId, profileId: goal.profileId, profile });
  const existingFreshness = assessGoalCalculationFreshness(goal, state);
  if (!existingFreshness.fresh) {
    throw createError(409, 'Goal calculation is stale for the current financial state.', 'Recalculate the goal before refreshing its advisory.', {
      code: 'GOAL_CALCULATION_STALE', calculationFreshness: existingFreshness,
    });
  }
  goal.gemini_advice = await generateGoalAdvice(goal, profile);
  await reachFinancialStateTestHook('goal.advisory.beforePersistence', {
    userId: req.user.userId, profileId: goal.profileId, goalId: goal._id, sourceState: state,
  });
  goal.version = expectedGoalVersion + 1;
  goal.advisoryMetadata = buildGoalAdvisoryMetadata({ goal, state });
  goal = await saveGoalWithSourceState(goal, {
    userId: req.user.userId,
    profileId: goal.profileId,
    sourceState: state,
    expectedGoalVersion,
  });
  await reachFinancialStateTestHook('goal.advisory.afterCommitBeforeResponse', {
    userId: String(req.user.userId), goalId: String(goal._id), sourceState: state,
  });
  const reconciliation = await resolveGoalResponseAfterCommit(goal, req.user.userId);
  if (reconciliation.deleted) throw committedGoalDeletedError(goal);
  const currentGoal = buildCurrentGoalResponse(reconciliation.goal, {
    state: reconciliation.state?.recommendation ? reconciliation.state : null,
  });
  res.json({
    goal: currentGoal,
    goalId: goal._id,
    gemini_advice: currentGoal.gemini_advice,
    operation_result: {
      committed: true,
      goal_version: Number(goal.version),
      response_state: currentGoal.calculation_freshness?.fresh ? 'CURRENT' : 'STALE',
    },
  });
}));

router.patch('/:goalId', verifyJWT, validateStrict(customGoalUpdateSchema), asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.goalId)) throw createError(400, 'Invalid goalId', 'Invalid goal ID.');
  const goal = await Goal.findOne({ _id: req.params.goalId, userId: req.user.userId });
  if (!goal) throw createError(404, 'Goal not found', 'Goal not found.');
  const expectedGoalVersion = req.body.expectedVersion;
  if (Number(goal.version ?? 1) !== expectedGoalVersion) throw goalVersionConflict(expectedGoalVersion);
  const stored = await findOwnedProfile(goal.profileId, req.user.userId);
  if (!stored) throw createError(409, 'The goal profile is unavailable.', 'Financial profile unavailable.');
  const profile = buildRecommendationProfile(stored);
  if (req.body.priority !== undefined) goal.priority = req.body.priority;
  if (req.body.target_amount !== undefined) goal.target_amount = req.body.target_amount;
  if (req.body.current_savings !== undefined) goal.current_savings = req.body.current_savings;

  let recalculationState = null;
  let persistedGoal = goal;
  if (req.body.target_amount !== undefined || req.body.current_savings !== undefined) {
    const plan = await calculateGoalPlan({
      profile, profileId: goal.profileId, userId: req.user.userId,
      targetAmount: goal.target_amount, targetDate: goal.target_date,
      currentSavings: goal.current_savings,
      allowNearTarget: true,
    });
    recalculationState = plan.metrics.state;
    goal.inflation_adjusted_target = plan.inflationAdjustedTarget;
    goal.recommended_sip = plan.requiredSip;
    goal.simulated_monthly_contribution = plan.simulatedMonthlyContribution;
    goal.recommended_instrument = plan.metrics.primaryInstrument;
    goal.probability_of_success = plan.result.goal_probability;
    goal.gap_amount = plan.gap;
    goal.status = plan.status;
    goal.monte_carlo_summary = {
      p10: plan.result.p10[plan.lastIndex], p25: plan.result.p25[plan.lastIndex],
      p50: plan.result.p50[plan.lastIndex], p75: plan.result.p75[plan.lastIndex],
      p90: plan.result.p90[plan.lastIndex], simulations_run: plan.result.simulations_run,
    };
    goal.chart_data = chartData(plan.result);
    goal.mc_computed_at = new Date();
    goal.years_remaining = plan.yearsRemaining;
    goal.simulation_classification = 'PROFILE_GROUNDED_GOAL_PLAN';
    goal.return_basis = plan.metrics.returnBasis;
    goal.return_data_class = plan.metrics.returnDataClass;
    goal.return_assumption_version = plan.metrics.returnAssumptionVersion;
    goal.return_assumption_source = plan.metrics.returnAssumptionSource;
    goal.sourceRecommendationId = plan.metrics.state?.recommendation?._id || null;
    goal.sourceAllocationRevision = plan.metrics.state?.allocationRevision?.revision || null;
    goal.sourceAllocationRevisionId = plan.metrics.state?.allocationRevision?._id || null;
    goal.sourceProfileInputHash = plan.metrics.state?.recommendation?.profileInputHash || null;
    goal.sourceProfileVersion = plan.metrics.state?.profileVersion || null;
    goal.sourceFinancialProfileStateRevision = plan.metrics.state?.financialProfileState?.revision ?? null;
    goal.sourceModelVersion = plan.metrics.state?.recommendation?.modelVersion || null;
    goal.sourceRecommendationPolicyVersion = plan.metrics.state?.recommendation?.recommendationPolicyVersion || null;
    goal.sourceRegulatoryRuleVersion = plan.metrics.state?.recommendation?.regulatoryRuleVersion || null;
    goal.sourceReturnAssumptionVersion = plan.metrics.state?.allocationRevision?.returnAssumptionVersion || plan.metrics.returnAssumptionVersion;
    goal.sourceReturnAssumptionHash = plan.metrics.state?.allocationRevision?.returnAssumptionHash || plan.metrics.returnAssumptionHash;
    goal.sourceReturnAssumptionSource = plan.metrics.state?.allocationRevision?.returnAssumptionSource || plan.metrics.returnAssumptionSource;
    goal.sourceRecommendationFingerprint = plan.metrics.state?.recommendationFingerprint || plan.metrics.recommendationFingerprint;
    goal.sourcePortfolioFingerprint = plan.metrics.state?.portfolioFingerprint || null;
    goal.calculationFreshness = { fresh: true, reasonCodes: [], checkedAt: new Date() };
    goal.observed_market_fact = false;
    goal.provider_forecast = false;
    goal.inflation_assumption = GOAL_INFLATION_ASSUMPTION;
    goal.sourceGoalCalculationInputFingerprint = buildGoalCalculationInputFingerprint(goal);
    goal.sourceGoalCalculationPolicyVersion = GOAL_CALCULATION_POLICY_VERSION;
    if (!goal.sourceGoalCalculationInputFingerprint) {
      throw new Error('Could not establish the goal calculation input fingerprint.');
    }
  }
  if (recalculationState) {
    const currentState = await assertGoalPlanStateCurrent({
      userId: req.user.userId,
      profileId: goal.profileId,
      profile,
      plannedState: recalculationState,
    });
    goal.gemini_advice = await generateGoalAdvice(goal, profile);
    await reachFinancialStateTestHook('goal.advisory.beforePersistence', {
      userId: req.user.userId, profileId: goal.profileId, goalId: goal._id, sourceState: currentState,
    });
    goal.version = expectedGoalVersion + 1;
    goal.advisoryMetadata = buildGoalAdvisoryMetadata({ goal, state: currentState });
    persistedGoal = await saveGoalWithSourceState(goal, {
      userId: req.user.userId,
      profileId: goal.profileId,
      sourceState: currentState,
      expectedGoalVersion,
    });
  } else {
    goal.version = expectedGoalVersion + 1;
    const sourceState = await resolveCurrentGoalSourceState({
      userId: req.user.userId,
      profileId: goal.profileId,
      profile,
    });
    persistedGoal = await saveGoalWithSourceState(goal, {
      userId: req.user.userId,
      profileId: goal.profileId,
      sourceState,
      expectedGoalVersion,
    });
  }
  await reachFinancialStateTestHook('goal.update.afterCommitBeforeResponse', {
    userId: String(req.user.userId), goalId: String(persistedGoal._id),
    goalVersion: Number(persistedGoal.version),
  });
  const reconciliation = await resolveGoalResponseAfterCommit(persistedGoal, req.user.userId);
  if (reconciliation.deleted) throw committedGoalDeletedError(persistedGoal);
  void triggerPlanHealthCheck({ userId: req.user.userId, profileId: reconciliation.goal.profileId });
  res.json({
    success: true,
    goal: buildCurrentGoalResponse(reconciliation.goal, {
      state: reconciliation.state?.recommendation ? reconciliation.state : null,
    }),
  });
}));

router.delete('/:goalId', verifyJWT, asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.goalId)) throw createError(400, 'Invalid goalId', 'Invalid goal ID.');
  const expectedVersion = parseGoalIfMatch(req.get('If-Match'));
  const current = await Goal.findOne({ _id: req.params.goalId, userId: req.user.userId });
  if (!current) throw createError(404, 'Goal not found', 'Goal not found.');
  if (Number(current.version ?? 1) !== expectedVersion) throw goalVersionConflict(expectedVersion);
  const goal = await Goal.findOneAndDelete({
    _id: req.params.goalId,
    userId: req.user.userId,
    ...goalVersionCondition(expectedVersion),
  });
  if (!goal) {
    const stillOwned = await Goal.exists({ _id: req.params.goalId, userId: req.user.userId });
    if (stillOwned) throw goalVersionConflict(expectedVersion);
    throw createError(404, 'Goal not found', 'Goal not found.');
  }
  void triggerPlanHealthCheck({ userId: req.user.userId, profileId: goal.profileId });
  res.json({ deleted: true, goalId: goal._id });
}));

function parseGoalIfMatch(value) {
  const match = typeof value === 'string' ? value.match(/^(?:W\/)?"?([1-9]\d*)"?$/) : null;
  if (!match || !Number.isSafeInteger(Number(match[1]))) {
    throw createError(428, 'A valid If-Match goal version is required.', 'Refresh the goal before deleting it.', { code: 'GOAL_VERSION_REQUIRED' });
  }
  return Number(match[1]);
}

export default router;
