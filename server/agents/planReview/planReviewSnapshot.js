import FinancialProfile from '../../models/FinancialProfile.js';
import FinancialProfileState from '../../models/FinancialProfileState.js';
import Goal from '../../models/Goal.js';
import { buildRecommendationProfile } from '../../services/recommendationProfile.js';
import { resolveCurrentRecommendationState } from '../../services/recommendationState.js';
import { resolveCurrentFinancialProfile } from '../../services/currentFinancialProfile.js';
import { assessGoalCalculationFreshness } from '../../services/recommendationState.js';
import { canonicalSha256 } from '../../utils/canonicalJson.js';
import { buildPlanReviewSnapshotBinding, hashPlanReviewSnapshot } from './planReviewRuntime.js';

function goalSourceProjection(goal, currentState) {
  return {
    id: goal?._id ? String(goal._id) : null,
    version: goal?.version ?? null,
    profileId: goal?.profileId ? String(goal.profileId) : null,
    goalName: goal?.goal_name ?? null,
    targetAmount: goal?.target_amount ?? null,
    targetDate: goal?.target_date ?? null,
    currentSavings: goal?.current_savings ?? null,
    priority: goal?.priority ?? null,
    probabilityOfSuccess: goal?.probability_of_success ?? null,
    recommendedSip: goal?.recommended_sip ?? null,
    gapAmount: goal?.gap_amount ?? null,
    projectedValue: goal?.monte_carlo_summary?.p50 ?? null,
    status: goal?.status ?? null,
    yearsRemaining: goal?.years_remaining ?? null,
    inflationAssumption: goal?.inflation_assumption ?? null,
    sourceRecommendationId: goal?.sourceRecommendationId ? String(goal.sourceRecommendationId) : null,
    sourceAllocationRevision: goal?.sourceAllocationRevision ?? null,
    sourceAllocationRevisionId: goal?.sourceAllocationRevisionId ? String(goal.sourceAllocationRevisionId) : null,
    sourceProfileInputHash: goal?.sourceProfileInputHash ?? null,
    sourceProfileVersion: goal?.sourceProfileVersion ?? null,
    sourceFinancialProfileStateRevision: goal?.sourceFinancialProfileStateRevision ?? null,
    sourceModelVersion: goal?.sourceModelVersion ?? null,
    sourceRecommendationPolicyVersion: goal?.sourceRecommendationPolicyVersion ?? null,
    sourceRegulatoryRuleVersion: goal?.sourceRegulatoryRuleVersion ?? null,
    sourceReturnAssumptionVersion: goal?.sourceReturnAssumptionVersion ?? null,
    sourceReturnAssumptionHash: goal?.sourceReturnAssumptionHash ?? null,
    sourceReturnAssumptionSource: goal?.return_assumption_source ?? null,
    sourceRecommendationFingerprint: goal?.sourceRecommendationFingerprint ?? null,
    sourcePortfolioFingerprint: goal?.sourcePortfolioFingerprint ?? null,
    sourceGoalCalculationInputFingerprint: goal?.sourceGoalCalculationInputFingerprint ?? null,
    sourceGoalCalculationPolicyVersion: goal?.sourceGoalCalculationPolicyVersion ?? null,
    calculationFreshness: assessGoalCalculationFreshness(goal, currentState),
  };
}

export function buildPlanReviewGoalSnapshot(goals, currentState) {
  if (!Array.isArray(goals)) throw new TypeError('Plan Review goal snapshot must be an array.');
  const projectedGoals = goals.map(goal => goalSourceProjection(goal, currentState));
  return Object.freeze({ count: projectedGoals.length, hash: canonicalSha256(projectedGoals) });
}

function goalSnapshotUnavailableError() {
  const error = new Error('Plan Review cannot verify current goal evidence.');
  error.status = 503;
  error.code = 'PLAN_REVIEW_GOALS_UNAVAILABLE';
  return error;
}

function notFoundError() {
  const error = new Error('Financial profile not found or access denied.');
  error.status = 404;
  error.code = 'PROFILE_NOT_FOUND';
  return error;
}

export async function resolvePlanReviewSnapshot({
  userId,
  profileId,
  profileModel = FinancialProfile,
  profileStateModel = FinancialProfileState,
  goalModel = Goal,
  session = null,
  dependencies = {},
} = {}) {
  if (!userId || !profileId) throw notFoundError();
  const resolveCanonicalProfile = dependencies.resolveCurrentFinancialProfile || resolveCurrentFinancialProfile;
  const canonical = await resolveCanonicalProfile({
    userId,
    stateModel: profileStateModel,
    profileModel,
    session,
    requireRecommendation: false,
  });
  if (!canonical.profile || String(canonical.profile._id) !== String(profileId)) {
    const error = new Error('PlanReview source profile is no longer the canonical current profile.');
    error.status = 409;
    error.code = 'PLAN_REVIEW_SOURCE_SUPERSEDED';
    throw error;
  }
  let profileQuery = profileModel.findOne({ _id: profileId, userId });
  if (session && typeof profileQuery?.session === 'function') profileQuery = profileQuery.session(session);
  const storedProfile = await profileQuery.lean();
  if (!storedProfile) throw notFoundError();

  const canonicalProfile = buildRecommendationProfile(storedProfile);
  const resolveState = dependencies.resolveCurrentRecommendationState || resolveCurrentRecommendationState;
  const currentState = await resolveState({
    userId,
    profileId,
    profile: session ? null : storedProfile,
    session,
    requireFresh: false,
    dependencies: {
      ...dependencies,
      profileModel,
    },
  });
  const stateWithCanonicalProfile = {
    ...currentState,
    profile: currentState?.profile || storedProfile || canonicalProfile,
  };
  let goalSnapshot;
  try {
    let goalQuery = goalModel.find({ userId, profileId }).sort({ target_date: 1, _id: 1 }).limit(20);
    if (session && typeof goalQuery?.session === 'function') goalQuery = goalQuery.session(session);
    const goals = await goalQuery.lean();
    goalSnapshot = buildPlanReviewGoalSnapshot(goals, stateWithCanonicalProfile);
  } catch {
    throw goalSnapshotUnavailableError();
  }
  const sourceBinding = buildPlanReviewSnapshotBinding({
    userId,
    profileId,
    financialProfileStateRevision: canonical.state.revision,
    currentState: stateWithCanonicalProfile,
    freshness: currentState?.freshness,
    goalSnapshot,
  });
  return {
    profile: storedProfile,
    canonicalProfile,
    currentState: stateWithCanonicalProfile,
    sourceBinding,
    planReviewSnapshotHash: hashPlanReviewSnapshot(sourceBinding),
  };
}

export { notFoundError as planReviewProfileNotFoundError };
