import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { getCurrentRegulatoryRuleVersion } from '../../services/taxEngine.js';
import { buildRecommendationProfileHash, RECOMMENDATION_POLICY_VERSION } from '../../services/recommendationProfile.js';
import { sanitizeGroundingReasonCodes } from '../../services/groundingValidator.js';
import { GROQ_PLAN_REVIEW_MODELS } from '../../services/providerAbstraction.js';
import { invokePlanReviewGraph } from '../planReview/planReviewGraph.js';
import { withAgentTelemetrySuppressed } from '../observability/agentTelemetry.js';

const EVAL_ROOT = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(EVAL_ROOT, 'fixtures');
const SYNTHETIC_CALLER_ID = '64b000000000000000000010';
const SYNTHETIC_MODEL_VERSION = 'synthetic-evaluation-model-1.0.0';
const MAX_LIVE_PROVIDER_CALLS_PER_CASE = 2;

// These are explicitly synthetic test inputs. They are never loaded from a
// user's profile, persisted, or used to produce a financial recommendation.
const SYNTHETIC_PROFILE_FIELDS = Object.freeze({
  version: 2,
  monthlyTakeHome: 100000,
  monthlySavings: 30000,
  age: 32,
  riskTolerance: 'Moderate',
  soldPropertyProceeds: null,
  hasLumpSum: false,
  lumpSumAmount: 0,
  liquidSavings: 100000,
  emiBurdenPct: null,
  financialDependents: 1,
  emergencyFundMonths: 6,
  investmentGoals: Object.freeze(['Wealth Growth']),
  investmentHorizonYears: 10,
  finalSuitabilityRisk: 'Moderate',
  suitabilityReasonCodes: Object.freeze(['RISK_TOLERANCE_MATCH']),
});

function query(value) {
  let limitCount = Number.POSITIVE_INFINITY;
  const result = {
    sort() { return result; },
    select() { return result; },
    limit(count) {
      if (Number.isSafeInteger(count) && count >= 0) limitCount = Math.min(limitCount, count);
      return result;
    },
    lean: async () => Array.isArray(value) ? value.slice(0, limitCount) : value,
  };
  return result;
}

function fixturePath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new TypeError('Evaluation cases must reference a fixture path.');
  }
  const resolved = path.resolve(EVAL_ROOT, relativePath);
  const relative = path.relative(FIXTURE_ROOT, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Evaluation fixture path must remain inside the fixture directory.');
  }
  return resolved;
}

function observedProvider(provider, usage, planReviewRole = null) {
  if (!provider) return null;
  const groqPlanReviewRole = provider.name === 'groq' && Object.hasOwn(GROQ_PLAN_REVIEW_MODELS, planReviewRole)
    ? planReviewRole
    : null;
  return {
    name: provider.name || 'configured-provider',
    ...(groqPlanReviewRole ? { planReviewRole: groqPlanReviewRole } : {}),
    configuredModel: () => (groqPlanReviewRole
      ? GROQ_PLAN_REVIEW_MODELS[groqPlanReviewRole]
      : provider.configuredModel?.() || provider.model || null),
    isConfigured: () => provider.isConfigured?.() ?? true,
    get lastFailureReason() { return provider.lastFailureReason || null; },
    get lastResponseDiagnostics() { return provider.lastResponseDiagnostics || null; },
    recordOutputValidation: details => provider.recordOutputValidation?.(details),
    async generate(args) {
      usage.providerCallAttempts += 1;
      if (usage.providerCallAttempts > MAX_LIVE_PROVIDER_CALLS_PER_CASE) {
        const error = new Error('The live PlanReview provider call budget was exceeded.');
        error.code = 'LIVE_EVAL_PROVIDER_CALL_BUDGET_EXCEEDED';
        throw error;
      }
      usage.providerCalls += 1;
      const attempt = {
        role: groqPlanReviewRole,
        configuredModel: groqPlanReviewRole
          ? GROQ_PLAN_REVIEW_MODELS[groqPlanReviewRole]
          : provider.configuredModel?.() || provider.model || null,
        outputContract: args.outputContract || (args.jsonMode ? 'JSON_OBJECT' : null),
        diagnostics: null,
        errorClassification: null,
      };
      usage.attempts.push(attempt);
      let response;
      try {
        response = await provider.generate({
          ...args,
          ...(groqPlanReviewRole ? { planReviewRole: groqPlanReviewRole } : {}),
        });
      } catch (error) {
        usage.tokenUsageAvailable = false;
        attempt.diagnostics = provider.lastResponseDiagnostics || null;
        attempt.errorClassification = provider.lastFailureReason || error?.code || 'PROVIDER_INTERNAL_ERROR';
        throw error;
      }
      attempt.diagnostics = provider.lastResponseDiagnostics || response?.diagnostics || null;
      if (response === null || response === undefined) {
        usage.tokenUsageAvailable = false;
        attempt.errorClassification = provider.lastFailureReason || 'PROVIDER_NO_RESPONSE';
        return response;
      }
      const reported = response.tokensUsed ?? response.usage?.totalTokens ?? response.usage?.total_tokens;
      if (!Number.isSafeInteger(Number(reported)) || Number(reported) <= 0) {
        usage.tokenUsageAvailable = false;
      } else {
        usage.tokensUsed += Number(reported);
      }
      return response;
    },
  };
}

function sanitizedProviderUsage(provider, usage, result = null) {
  const attempts = usage.attempts.map(attempt => {
    const diagnostic = attempt.diagnostics || {};
    return {
      role: attempt.role,
      outputContract: attempt.outputContract,
      provider: diagnostic.provider || provider?.name || null,
      model: diagnostic.configuredModel || attempt.configuredModel || provider?.configuredModel?.() || null,
      returnedModel: diagnostic.returnedModel || null,
      endpointHostname: diagnostic.endpointHostname || null,
      responseFormatMode: diagnostic.responseFormatMode || null,
      strictSchema: typeof diagnostic.strictSchema === 'boolean' ? diagnostic.strictSchema : null,
      schemaName: diagnostic.schemaName || null,
      schemaStructuralValidation: typeof diagnostic.schemaStructuralValidation === 'boolean'
        ? diagnostic.schemaStructuralValidation
        : null,
      reasoningEffort: diagnostic.reasoningEffort || null,
      reasoningFormat: diagnostic.reasoningFormat || null,
      reasoningIncluded: typeof diagnostic.reasoningIncluded === 'boolean'
        ? diagnostic.reasoningIncluded
        : null,
      httpStatus: Number.isSafeInteger(diagnostic.httpStatus) ? diagnostic.httpStatus : null,
      latencyMs: Number.isSafeInteger(diagnostic.latencyMs) ? diagnostic.latencyMs : null,
      completionReason: diagnostic.completionReason || null,
      outputBytes: Number.isSafeInteger(diagnostic.outputBytes) ? diagnostic.outputBytes : null,
      providerRequestId: typeof diagnostic.providerRequestId === 'string'
        && /^[A-Za-z0-9._:-]{1,128}$/.test(diagnostic.providerRequestId)
        ? diagnostic.providerRequestId
        : null,
      promptTokens: Number.isSafeInteger(diagnostic.providerPromptTokens) && diagnostic.providerPromptTokens >= 0
        ? diagnostic.providerPromptTokens
        : null,
      completionTokens: Number.isSafeInteger(diagnostic.providerCompletionTokens) && diagnostic.providerCompletionTokens >= 0
        ? diagnostic.providerCompletionTokens
        : null,
      reasoningTokens: Number.isSafeInteger(diagnostic.providerReasoningTokens)
        && diagnostic.providerReasoningTokens >= 0
        && (!Number.isSafeInteger(diagnostic.providerCompletionTokens)
          || diagnostic.providerReasoningTokens <= diagnostic.providerCompletionTokens)
        ? diagnostic.providerReasoningTokens
        : null,
      reportedTokens: Number.isSafeInteger(diagnostic.providerReportedTokens) ? diagnostic.providerReportedTokens : null,
      effectiveOutputTokenCeiling: Number.isSafeInteger(diagnostic.effectiveOutputTokenCeiling) ? diagnostic.effectiveOutputTokenCeiling : null,
      jsonSyntaxValid: typeof diagnostic.jsonSyntaxValid === 'boolean' ? diagnostic.jsonSyntaxValid : null,
      jsonSchemaValid: typeof diagnostic.jsonSchemaValid === 'boolean' ? diagnostic.jsonSchemaValid : null,
      financialGroundingValid: typeof diagnostic.financialGroundingValid === 'boolean' ? diagnostic.financialGroundingValid : null,
      groundingReasonCodes: sanitizeGroundingReasonCodes(diagnostic.groundingReasonCodes),
      semanticCompletenessValid: typeof diagnostic.semanticCompletenessValid === 'boolean' ? diagnostic.semanticCompletenessValid : null,
      semanticReasonCodes: sanitizeGroundingReasonCodes(diagnostic.semanticReasonCodes),
      explanationPolicyValid: typeof diagnostic.explanationPolicyValid === 'boolean' ? diagnostic.explanationPolicyValid : null,
      policyReasonCodes: sanitizeGroundingReasonCodes(diagnostic.policyReasonCodes),
      errorClassification: attempt.errorClassification || diagnostic.errorClassification || null,
      providerErrorCode: diagnostic.providerErrorCode || null,
      providerErrorField: diagnostic.providerErrorField || null,
    };
  });
  return {
    provider: provider?.name || null,
    model: provider?.configuredModel?.() || null,
    providerCalls: usage.providerCalls,
    providerCallAttempts: usage.providerCallAttempts,
    tokensUsed: usage.tokensUsed,
    tokenUsageAvailable: usage.tokenUsageAvailable,
    modelsUsed: [...new Set(attempts
      .map(attempt => attempt.returnedModel || attempt.model)
      .filter(model => typeof model === 'string' && model.length > 0))],
    plannerFallback: Boolean(result?.planner?.fallback),
    explanationFallback: Boolean(result?.explanation?.fallback),
    attempts,
  };
}

/**
 * Execute the production PlanReview graph with memory-only synthetic
 * dependencies. Supplying a provider is explicit and is used only by the
 * opt-in live evaluator. No Mongo, Redis, filesystem output, or research
 * network integration is enabled by this runner.
 */
export async function runIsolatedPlanReviewCase({ caseDefinition, provider = null } = {}) {
  if (!caseDefinition || typeof caseDefinition.id !== 'string' || !caseDefinition.id.trim()) {
    throw new TypeError('A named PlanReview evaluation case is required.');
  }
  const fixture = JSON.parse(await fs.readFile(fixturePath(caseDefinition.profile), 'utf8'));
  if (typeof fixture.description !== 'string' || !/fixture/i.test(fixture.description)
      || !/^[a-f\d]{24}$/i.test(fixture.profileId || '')
      || !/^[a-f\d]{24}$/i.test(fixture.userId || '')) {
    throw new Error(`Evaluation fixture ${caseDefinition.id} is not an explicitly synthetic fixture.`);
  }

  const profile = { ...SYNTHETIC_PROFILE_FIELDS, _id: fixture.profileId, userId: fixture.userId };
  const ownsProfile = String(fixture.userId) === SYNTHETIC_CALLER_ID;
  const callerProfile = ownsProfile ? profile : null;
  const currentRegulatoryRuleVersion = getCurrentRegulatoryRuleVersion();
  const recommendation = fixture.recommendationStatus === 'AVAILABLE' && callerProfile
    ? {
      _id: '64b000000000000000000002',
      profileId: fixture.profileId,
      userId: fixture.userId,
      modelVersion: SYNTHETIC_MODEL_VERSION,
      profileVersion: callerProfile.version,
      profileInputHash: buildRecommendationProfileHash(callerProfile, {
        modelVersion: SYNTHETIC_MODEL_VERSION,
        policyVersion: RECOMMENDATION_POLICY_VERSION,
      }),
      recommendationPolicyVersion: RECOMMENDATION_POLICY_VERSION,
      regulatoryRuleVersion: currentRegulatoryRuleVersion,
      generatedAt: new Date(),
      responseSnapshotAvailable: true,
      responseSnapshot: { recommendation: { instruments: [] } },
      currentAllocationSource: 'ORIGINAL_RECOMMENDATION',
      instruments: [],
    }
    : null;
  const providerUsage = { providerCalls: 0, providerCallAttempts: 0, tokensUsed: 0, tokenUsageAvailable: true, attempts: [] };
  const liveProvider = observedProvider(provider, providerUsage);
  const plannerProvider = observedProvider(provider, providerUsage, 'PLANNER');
  const explanationProvider = observedProvider(provider, providerUsage, 'EXPLAINER');
  const trajectory = [];
  const profileAccessChecks = {
    requestedProfileLookups: 0,
    callerScopedProfileLookups: 0,
    callerScopedMisses: 0,
    profileDataReturned: false,
  };
  const startedAt = performance.now();

  let result;
  try {
    result = await withAgentTelemetrySuppressed(() => invokePlanReviewGraph({
    userId: SYNTHETIC_CALLER_ID,
    profileId: fixture.profileId,
    dependencies: {
      profileModel: {
        findOne: filter => {
          const requestedProfile = String(filter?._id) === String(fixture.profileId);
          const callerScoped = String(filter?.userId) === SYNTHETIC_CALLER_ID;
          const matchedProfile = requestedProfile && callerScoped && ownsProfile ? callerProfile : null;
          if (requestedProfile) {
            profileAccessChecks.requestedProfileLookups += 1;
            if (callerScoped) {
              profileAccessChecks.callerScopedProfileLookups += 1;
              if (!matchedProfile) profileAccessChecks.callerScopedMisses += 1;
            }
            if (matchedProfile) profileAccessChecks.profileDataReturned = true;
          }
          return query(matchedProfile);
        },
      },
      recommendationModel: {
        findOne: filter => query(
          recommendation
            && String(filter?.profileId) === String(recommendation.profileId)
            && String(filter?.userId) === String(recommendation.userId)
            ? recommendation
            : null,
        ),
      },
      auditModel: { findOne: () => query(null) },
      goalModel: { find: () => ({ sort: () => query([]) }) },
      getCurrentRegulatoryRuleVersion: () => currentRegulatoryRuleVersion,
      plannerProvider,
      strictModelPlanner: Boolean(plannerProvider),
      explanationProviders: explanationProvider ? [explanationProvider] : [],
      maxSteps: caseDefinition.maxSteps,
      maxToolCalls: caseDefinition.maxToolCalls,
      maxInputTokens: 5000,
      // The live evaluation has a 2,500-token total budget per case. Keep the
      // per-call ceiling low enough that the grounded explanation prompt can
      // be reserved after the planner call without relaxing that total cap.
      maxOutputTokens: 512,
      maxTotalTokens: 2500,
      maxModelCalls: MAX_LIVE_PROVIDER_CALLS_PER_CASE,
      // Two bounded provider calls can run sequentially (the NVIDIA adapter
      // allows 20 seconds per request); give the isolated graph enough time
      // for both without changing its call or token budgets.
      timeoutMs: liveProvider ? 50000 : 5000,
      toolTimeoutMs: 1000,
      researchAdaptiveEnabled: false,
      researchDeepEnabled: false,
      researchMeshClient: null,
      checkpointer: null,
      // The graph's persistence hook is intentionally a no-op in this
      // isolated run; no test result enters production evaluation storage.
      persistAgentRun: async () => undefined,
      onNodeProgress: async ({ event }) => {
        if (event && typeof event.type === 'string') trajectory.push(event);
      },
    },
    }));
  } catch (error) {
    error.livePlanReviewEvidence = {
      latencyMs: Math.round(performance.now() - startedAt),
      providerUsage: sanitizedProviderUsage(liveProvider, providerUsage),
      trajectory,
    };
    throw error;
  }

  const observedReasonCodes = result?.review?.freshness?.reasonCodes
    || result?.freshness?.reasonCodes
    || [];
  const selectedToolCount = trajectory.filter(event => event?.type === 'TOOL_SELECTED').length;
  const executedToolCount = trajectory.filter(event => event?.type === 'TOOL_SUCCEEDED').length;
  const forbiddenToolRequestCount = trajectory.filter(event => event?.type === 'POLICY_REJECTED'
    && event?.code === 'FORBIDDEN_TOOL_REQUEST').length
    + trajectory.filter(event => event?.type === 'TOOL_SELECTED'
      && caseDefinition.forbiddenTools.includes(event.tool)).length;
  const callerScopedLookupDenied = !ownsProfile
    && profileAccessChecks.requestedProfileLookups > 0
    && profileAccessChecks.callerScopedProfileLookups > 0
    && profileAccessChecks.callerScopedMisses > 0
    && !profileAccessChecks.profileDataReturned;
  const authorizationEvidence = {
    schemaVersion: 'phase16-profile-access-evidence-v1',
    outcome: callerScopedLookupDenied ? 'DENIED' : 'NOT_DENIED',
    fixtureOwnerMismatch: !ownsProfile,
    requestedProfileLookupObserved: profileAccessChecks.requestedProfileLookups > 0,
    callerScopedProfileLookupObserved: profileAccessChecks.callerScopedProfileLookups > 0,
    callerScopedLookupOutcome: profileAccessChecks.callerScopedProfileLookups === 0
      ? 'NOT_OBSERVED'
      : callerScopedLookupDenied ? 'NOT_FOUND' : 'FOUND',
    profileDataExposed: profileAccessChecks.profileDataReturned,
    requiredReasonCodesObserved: [...new Set(observedReasonCodes.filter(code =>
      Array.isArray(caseDefinition.requiredReasonCodes) && caseDefinition.requiredReasonCodes.includes(code)))],
    modelInvocationObserved: providerUsage.providerCallAttempts > 0,
    providerCalls: providerUsage.providerCalls,
    providerCallAttempts: providerUsage.providerCallAttempts,
    selectedToolCount,
    executedToolCount,
    forbiddenToolRequestCount,
    policyAllowed: result?.policy?.allowed === true,
    finalAction: result?.review?.recommendedAction || result?.recommendedAction || null,
  };

  return {
    result,
    trajectory,
    latencyMs: Math.round(performance.now() - startedAt),
    providerUsage: sanitizedProviderUsage(liveProvider, providerUsage, result),
    authorizationEvidence,
  };
}
