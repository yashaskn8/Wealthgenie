import FinancialProfile from '../../models/FinancialProfile.js';
import Recommendation from '../../models/Recommendation.js';
import Goal from '../../models/Goal.js';
import AuditRecord from '../../models/AuditRecord.js';
import { buildRecommendationProfile } from '../../services/recommendationProfile.js';
import { getCurrentRegulatoryRuleVersion } from '../../services/taxEngine.js';
import { assessRecommendationFreshness } from '../../services/recommendationFreshness.js';
import { assessGoalCalculationFreshness } from '../../services/recommendationState.js';
import { buildGroundedEvidencePacket, makeEvidenceEntry } from '../../services/groundedEvidence.js';
import { isSafePlanReviewCapability, PLAN_REVIEW_TOOL_CAPABILITIES, SAFE_PLAN_REVIEW_TOOLS } from './planReviewSchemas.js';
import { buildPlanReviewSnapshotBinding, hashPlanReviewSnapshot } from './planReviewRuntime.js';
import { resolvePlanReviewSnapshot } from './planReviewSnapshot.js';

function idOf(value) {
  return value?._id ? String(value._id) : value ? String(value) : null;
}

export function buildProfileContext(storedProfile, canonicalProfile = null) {
  if (!storedProfile || !canonicalProfile) return null;
  return {
    profileId: idOf(storedProfile),
    version: Number(storedProfile.version) || 1,
    age: canonicalProfile.age,
    riskTolerance: canonicalProfile.riskTolerance,
    monthlySavings: canonicalProfile.monthlySavings,
    investmentHorizonYears: canonicalProfile.investmentHorizonYears,
    investmentGoals: [...canonicalProfile.investmentGoals],
    suitabilityRisk: storedProfile.finalSuitabilityRisk || null,
    suitabilityReasonCodes: Array.isArray(storedProfile.suitabilityReasonCodes)
      ? [...storedProfile.suitabilityReasonCodes]
      : [],
  };
}

export function buildRecommendationSummary(recommendation, freshness = null) {
  if (!recommendation) return { status: 'MISSING', recommendationId: null, profileId: null, instruments: [] };
  if (freshness?.fresh !== true) {
    return {
      status: 'UNAVAILABLE',
      recommendationId: idOf(recommendation),
      profileId: idOf(recommendation.profileId),
      reasonCodes: [...new Set(freshness?.reasonCodes || ['RECOMMENDATION_STALE'])],
      instruments: [],
      unavailableFacts: [...new Set(freshness?.reasonCodes || ['RECOMMENDATION_STALE'])],
    };
  }
  return {
    status: 'AVAILABLE',
    recommendationId: idOf(recommendation),
    profileId: idOf(recommendation.profileId),
    generatedAt: recommendation.generatedAt ?? null,
    modelVersion: recommendation.modelVersion ?? null,
    regulatoryRuleVersion: recommendation.regulatoryRuleVersion ?? null,
    profileInputHash: recommendation.profileInputHash ?? null,
    responseSnapshotAvailable: recommendation.responseSnapshotAvailable === undefined
      ? Boolean(recommendation.responseSnapshot)
      : recommendation.responseSnapshotAvailable === true,
    currentAllocationSource: recommendation.currentAllocationSource ?? null,
    instruments: Array.isArray(recommendation.instruments)
      ? recommendation.instruments.slice(0, 8).map(instrument => ({
        id: instrument.id,
        name: instrument.name,
        type: instrument.type,
        assetClass: instrument.assetClass,
        allocationPct: Number.isFinite(Number(instrument.allocation_pct))
          ? Number(instrument.allocation_pct)
          : null,
        riskLevel: instrument.riskLevel ?? null,
        returnDataClass: instrument.returnDataClass ?? null,
        returnAssumptionVersion: instrument.returnAssumptionVersion ?? null,
      }))
      : [],
  };
}

function planReviewEvidenceProfile(profileContext) {
  if (!profileContext) return null;
  return {
    age: profileContext.age ?? null,
    monthlySavings: profileContext.monthlySavings ?? null,
    riskTolerance: profileContext.riskTolerance ?? null,
    suitabilityRisk: profileContext.suitabilityRisk ?? null,
    investmentHorizonYears: profileContext.investmentHorizonYears ?? null,
    investmentGoals: Array.isArray(profileContext.investmentGoals) ? [...profileContext.investmentGoals] : [],
    suitabilityReasonCodes: Array.isArray(profileContext.suitabilityReasonCodes)
      ? [...profileContext.suitabilityReasonCodes]
      : [],
  };
}

function planReviewRecommendationView(recommendation) {
  if (!recommendation) return null;
  return {
    _id: recommendation._id,
    profileId: recommendation.profileId,
    generatedAt: recommendation.generatedAt ?? null,
    modelVersion: recommendation.modelVersion ?? null,
    profileInputHash: recommendation.profileInputHash ?? null,
    recommendationPolicyVersion: recommendation.recommendationPolicyVersion ?? null,
    regulatoryRuleVersion: recommendation.regulatoryRuleVersion ?? null,
    currentAllocationSource: recommendation.currentAllocationSource ?? null,
    responseSnapshotAvailable: recommendation.responseSnapshotAvailable === undefined
      ? Boolean(recommendation.responseSnapshot)
      : recommendation.responseSnapshotAvailable === true,
    instruments: Array.isArray(recommendation.instruments)
      ? recommendation.instruments.slice(0, 8).map(instrument => ({
        id: instrument.id,
        name: instrument.name,
        type: instrument.type,
        assetClass: instrument.assetClass,
        allocation_pct: instrument.allocation_pct ?? null,
        allocationWeight: instrument.allocationWeight ?? null,
        nominalReturn: instrument.nominalReturn ?? null,
        riskLevel: instrument.riskLevel ?? null,
        returnDataClass: instrument.returnDataClass ?? null,
        returnAssumptionVersion: instrument.returnAssumptionVersion ?? null,
      }))
      : [],
  };
}

function planReviewGoalFreshnessState(currentState) {
  if (!currentState) return null;
  const recommendation = planReviewRecommendationView(
    currentState.currentRecommendationView || currentState.recommendation,
  );
  const allocation = currentState.allocationRevision || currentState.currentAllocation || null;
  const financialProfileState = currentState.financialProfileState || null;
  return {
    recommendation,
    allocationRevision: allocation ? {
      _id: allocation._id,
      revision: allocation.revision,
      returnAssumptionVersion: allocation.returnAssumptionVersion ?? null,
      returnAssumptionHash: allocation.returnAssumptionHash ?? null,
      returnAssumptionSource: allocation.returnAssumptionSource ?? null,
    } : null,
    financialProfileState: financialProfileState ? {
      revision: financialProfileState.revision,
      currentProfileId: financialProfileState.currentProfileId,
    } : null,
    profileVersion: currentState.profileVersion ?? null,
    recommendationFingerprint: currentState.recommendationFingerprint ?? null,
    portfolioFingerprint: currentState.portfolioFingerprint ?? null,
    freshness: currentState.freshness ? {
      fresh: currentState.freshness.fresh === true,
      reasonCodes: [...new Set(currentState.freshness.reasonCodes || [])],
    } : null,
  };
}

async function getCurrentProfileContext(context) {
  return context.profileContext;
}

async function getCurrentRecommendationSummary(context) {
  return context.recommendationSummary;
}

async function checkRecommendationFreshness(context) {
  return context.freshness;
}

async function getPlanEvidenceSnapshot(context) {
  const current = context.freshness?.fresh === true;
  if (!context.profile || !context.recommendation || !current) {
    return {
      status: 'UNAVAILABLE',
      entries: [],
      unavailableFacts: [...new Set([
        'CURRENT_PLAN_EVIDENCE_UNAVAILABLE',
        ...(context.freshness?.reasonCodes || []),
      ])],
    };
  }
  const profileForEvidence = {
    ...context.profile,
    suitabilityRisk: context.profileContext?.suitabilityRisk || null,
    suitabilityReasonCodes: context.profileContext?.suitabilityReasonCodes || [],
  };
  const freshnessEntry = makeEvidenceEntry(
    'E_RECOMMENDATION_FRESHNESS',
    'RECOMMENDATION_STATUS',
    {
      fresh: context.freshness.fresh === true,
      reasonCodes: Array.isArray(context.freshness.reasonCodes)
        ? context.freshness.reasonCodes.filter(code => typeof code === 'string' && /^[A-Z0-9_]{2,100}$/.test(code)).slice(0, 32)
        : [],
    },
    {
      dataClass: 'DERIVED_VALUE',
      displayValue: context.freshness.fresh
        ? 'The current recommendation matches the current profile and regulatory policy.'
        : `The recommendation requires attention: ${context.freshness.reasonCodes.join(', ') || 'evidence unavailable'}.`,
    },
  );
  const packet = buildGroundedEvidencePacket({
    question: 'Review the current financial plan and its evidence status.',
    profile: profileForEvidence,
    recommendation: current ? context.recommendation : null,
    additionalEntries: [freshnessEntry],
    unavailableFacts: current ? [] : context.freshness.reasonCodes,
    purpose: 'PLAN_REVIEW',
  });
  return {
    ...packet,
    status: 'AVAILABLE',
  };
}

async function getGoalStatusSummary(context) {
  const goalModel = context.dependencies.goalModel || Goal;
  if (!context.profile) return { status: 'UNAVAILABLE', items: [], unavailableFacts: ['PROFILE_REQUIRED'] };
  try {
    const goals = await goalModel.find({ userId: context.userId, profileId: context.profileId })
      .sort({ target_date: 1, _id: 1 })
      .limit(20)
      .lean();
    return {
      status: goals.length ? 'AVAILABLE' : 'NONE',
      items: goals.map(goal => {
        const calculationFreshness = context.currentState
          ? assessGoalCalculationFreshness(goal, context.currentState)
          : { fresh: false, reasonCodes: ['SOURCE_MISSING'] };
        const calculationIsFresh = calculationFreshness.fresh === true;
        return {
          calculationFreshness,
          probabilityOfSuccess: calculationIsFresh ? (goal.probability_of_success ?? null) : null,
          recommendedSip: calculationIsFresh ? (goal.recommended_sip ?? null) : null,
          gapAmount: calculationIsFresh ? (goal.gap_amount ?? null) : null,
          projectedValue: calculationIsFresh ? (goal.monte_carlo_summary?.p50 ?? null) : null,
          // A stale status is a derived financial conclusion, not a user fact.
          status: calculationIsFresh ? (goal.status ?? null) : null,
          goalId: idOf(goal),
          name: goal.goal_name,
          targetDate: goal.target_date ?? null,
          priority: goal.priority ?? null,
          currentSavings: goal.current_savings ?? null,
          targetAmount: goal.target_amount ?? null,
        };
      }),
    };
  } catch {
    return { status: 'UNAVAILABLE', items: [], unavailableFacts: ['GOALS_UNAVAILABLE'] };
  }
}

export const PLAN_REVIEW_TOOL_CATALOG = Object.freeze({
  get_current_profile_context: {
    description: 'Read the authenticated user current profile context.',
    execute: getCurrentProfileContext,
  },
  get_current_recommendation_summary: {
    description: 'Read a bounded summary of the authenticated user current recommendation.',
    execute: getCurrentRecommendationSummary,
  },
  check_recommendation_freshness: {
    description: 'Check profile hash, model, and regulatory freshness without changing the plan.',
    execute: checkRecommendationFreshness,
  },
  get_plan_evidence_snapshot: {
    description: 'Return the immutable evidence snapshot used to ground a plan review.',
    execute: getPlanEvidenceSnapshot,
  },
  get_goal_status_summary: {
    description: 'Read persisted goal status for the authenticated profile.',
    execute: getGoalStatusSummary,
  },
});

export function getPlanReviewToolDefinitions() {
  return SAFE_PLAN_REVIEW_TOOLS.map(name => ({
    name,
    description: PLAN_REVIEW_TOOL_CATALOG[name].description,
    capability: PLAN_REVIEW_TOOL_CAPABILITIES[name],
  }));
}

export async function executePlanReviewTool(toolName, context) {
  const tool = PLAN_REVIEW_TOOL_CATALOG[toolName];
  const capability = PLAN_REVIEW_TOOL_CAPABILITIES[toolName];
  if (!tool || !SAFE_PLAN_REVIEW_TOOLS.includes(toolName)) {
    const error = new Error(`Unknown plan review tool: ${toolName}`);
    error.code = 'UNKNOWN_TOOL';
    throw error;
  }
  if (!isSafePlanReviewCapability(toolName, capability)) {
    const error = new Error('PlanReview tool capability violates the read-only policy.');
    error.code = 'TOOL_CAPABILITY_POLICY_INVALID';
    throw error;
  }
  const override = context?.dependencies?.shadowExecution === true
    ? null
    : context?.dependencies?.toolOverrides?.[toolName];
  if (typeof override === 'function') return override(context);
  return tool.execute(context);
}

async function latestOwnedRecommendationQuery(profileId, userId, recommendationModel) {
  // Only the isolated dependency-adapter path uses this legacy lookup. The
  // production path above resolves through RecommendationState and therefore
  // cannot treat timestamp order as current financial authority.
  return recommendationModel.findOne({ profileId, userId })
    .sort({ recommendationGeneration: -1, generatedAt: -1, _id: -1 })
    .lean();
}

export async function loadPlanReviewContext({ userId, profileId, dependencies = {} }) {
  const profileModel = dependencies.profileModel || FinancialProfile;
  const recommendationModel = dependencies.recommendationModel || Recommendation;
  const auditModel = dependencies.auditModel || AuditRecord;
  if (!dependencies.profileModel && !dependencies.recommendationModel && !dependencies.auditModel) {
    // Queue admission, graph execution, and publication must hash the exact
    // same canonical source binding. In particular, the profile-state revision
    // is part of the binding and cannot be omitted by the worker context loader.
    const resolveSnapshot = dependencies.resolvePlanReviewSnapshot || resolvePlanReviewSnapshot;
    const snapshot = await resolveSnapshot({
      userId,
      profileId,
      profileStateModel: dependencies.profileStateModel,
      dependencies,
    });
    const currentState = snapshot.currentState;
    const recommendation = planReviewRecommendationView(
      currentState?.currentRecommendationView || currentState?.recommendation || null,
    );
    const freshness = currentState?.freshness || null;
    const profileContext = buildProfileContext(snapshot.profile, snapshot.canonicalProfile);
    return {
      profile: planReviewEvidenceProfile(profileContext),
      profileContext,
      recommendation,
      currentState: planReviewGoalFreshnessState(currentState),
      sourceBinding: snapshot.sourceBinding,
      planReviewSnapshotHash: snapshot.planReviewSnapshotHash,
      recommendationSummary: buildRecommendationSummary(recommendation, freshness),
      freshness,
    };
  }

  const storedProfile = await profileModel.findOne({ _id: profileId, userId }).lean();
  if (!storedProfile) {
    const freshness = assessRecommendationFreshness({ profile: null, recommendation: null });
    const currentState = { profile: null, recommendation: null, freshness, provenance: { status: 'MISSING' } };
    const sourceBinding = buildPlanReviewSnapshotBinding({ userId, profileId, currentState, freshness });
    return {
      profile: null,
      profileContext: null,
      recommendation: null,
      currentState,
      sourceBinding,
      planReviewSnapshotHash: hashPlanReviewSnapshot(sourceBinding),
      recommendationSummary: buildRecommendationSummary(null),
      freshness,
    };
  }

  const profile = buildRecommendationProfile(storedProfile);
  // Test/adapter callers may provide isolated model doubles. Their path is
  // still read-only; production returns above through the canonical snapshot
  // resolver used at enqueue and commit time.
  const recommendation = await latestOwnedRecommendationQuery(profileId, userId, recommendationModel);
  let recommendationRegulatoryRuleVersion = recommendation?.regulatoryRuleVersion ?? null;
  if (recommendation && !recommendationRegulatoryRuleVersion && auditModel) {
    const audit = await auditModel.findOne({ recommendationId: recommendation._id, userId })
      .select('regulatory_rule_version')
      .lean();
    recommendationRegulatoryRuleVersion = audit?.regulatory_rule_version || null;
  }
  const currentRegulatoryRuleVersion = (dependencies.getCurrentRegulatoryRuleVersion || getCurrentRegulatoryRuleVersion)();
  const freshness = assessRecommendationFreshness({
    profile,
    recommendation,
    currentRegulatoryRuleVersion,
    recommendationRegulatoryRuleVersion,
  });
  const currentState = {
    profile: storedProfile,
    profileVersion: Number(storedProfile.version) || null,
    recommendation,
    freshness,
    provenance: { status: recommendation ? 'ADAPTER_UNVERIFIED' : 'MISSING' },
  };
  const sourceBinding = buildPlanReviewSnapshotBinding({ userId, profileId, currentState, freshness });
  return {
    profile,
    profileContext: buildProfileContext(storedProfile, profile),
    recommendation,
    currentState,
    sourceBinding,
    planReviewSnapshotHash: hashPlanReviewSnapshot(sourceBinding),
    recommendationSummary: buildRecommendationSummary(recommendation, freshness),
    freshness,
  };
}
