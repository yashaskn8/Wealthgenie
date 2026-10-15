import crypto from 'node:crypto';
import { createOptimizerEvaluationManifest, evaluateCandidate, AGENT_EVALUATION_VERSION } from '../evals/evaluationV2.js';
import { createScaffoldSpec, assertScaffoldSpecSafe } from './scaffoldSpec.js';
import { invokePlanReviewGraph } from '../planReview/planReviewGraph.js';
import { canonicalSha256 } from '../../utils/canonicalJson.js';

export const EVOLUTION_VERSION = 'scaffold-evolution-1.0.0';

const INVALID_FIXTURE_IDENTITY = Symbol('invalid-fixture-identity');

function fixtureIdentity(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return INVALID_FIXTURE_IDENTITY;
  if (typeof value === 'number' && !Number.isFinite(value)) return INVALID_FIXTURE_IDENTITY;
  const identity = String(value).trim();
  return identity || INVALID_FIXTURE_IDENTITY;
}

function fixtureIdentitiesMatch(values, expected) {
  return values.every(value => {
    const identity = fixtureIdentity(value);
    return identity === null || (identity !== INVALID_FIXTURE_IDENTITY && identity === expected);
  });
}

function bindEvaluationFixtureIdentity(fixture) {
  const fail = () => Object.assign(
    new Error('Evaluation fixture identities do not bind to one user and profile.'),
    { code: 'EVALUATION_FIXTURE_IDENTITY_MISMATCH' },
  );
  const userId = fixtureIdentity(fixture?.userId);
  const profileId = fixtureIdentity(fixture?.profileId);
  const profile = fixture?.context?.profile;
  if (!userId || userId === INVALID_FIXTURE_IDENTITY
      || !profileId || profileId === INVALID_FIXTURE_IDENTITY
      || !fixtureIdentitiesMatch([profile?.profileId, profile?._id, profile?.id], profileId)) throw fail();

  const contextUserIds = [
    fixture?.context?.userId,
    profile?.userId,
    fixture?.context?.recommendation?.userId,
  ];
  const additionalContextProfileIds = [
    fixture?.context?.profileId,
    fixture?.context?.recommendation?.profileId,
  ];
  if (!fixtureIdentitiesMatch(contextUserIds, userId)
      || !fixtureIdentitiesMatch(additionalContextProfileIds, profileId)) throw fail();

  if (Array.isArray(fixture.context.goals)) {
    for (const goal of fixture.context.goals) {
      if (!goal || typeof goal !== 'object' || Array.isArray(goal)) throw fail();
      if (!fixtureIdentitiesMatch([goal.userId], userId)
          || !fixtureIdentitiesMatch([goal.profileId], profileId)) throw fail();
    }
  }
  return { userId, profileId };
}

export function createPlanReviewScaffoldRunner({ dependencies = {} } = {}) {
  return async ({ candidate, caseDefinition, evolutionTokenBudget = null } = {}) => {
    let remainingEvolutionTokens = null;
    if (evolutionTokenBudget) {
      const maximum = Number(evolutionTokenBudget.maxTotalTokens);
      const reserved = Number(evolutionTokenBudget.reservedTokenUpperBound ?? 0);
      if (!Number.isSafeInteger(maximum) || maximum < 0
          || !Number.isSafeInteger(reserved) || reserved < 0 || reserved > maximum) {
        throw Object.assign(new Error('Evolution token budget is invalid.'), { code: 'AGENT_BUDGET_EXCEEDED' });
      }
      remainingEvolutionTokens = maximum - reserved;
    }
    if (remainingEvolutionTokens === 0) {
      throw Object.assign(new Error('Evolution token budget is exhausted.'), { code: 'AGENT_BUDGET_EXCEEDED' });
    }
    if (typeof dependencies.captureFinancialAuthority !== 'function') {
      const error = new Error('Closed-loop evaluation requires an authority snapshot provider.');
      error.code = 'AUTHORITY_MEASUREMENT_REQUIRED';
      throw error;
    }
    const fixture = caseDefinition?.fixture;
    if (!fixture?.context || !fixture.context.profile) {
      const error = new Error('Closed-loop evaluation requires a sanitized profile fixture.');
      error.code = 'EVALUATION_FIXTURE_REQUIRED';
      throw error;
    }
    const fixtureIdentityBinding = bindEvaluationFixtureIdentity(fixture);
    const before = await dependencies.captureFinancialAuthority({ caseDefinition, phase: 'before' });
    const trajectory = [];
    const fixtureGoalsAvailable = Array.isArray(fixture.context.goals);
    const fixtureGoals = fixtureGoalsAvailable ? fixture.context.goals : [];
    let lastRunReservedTokens = 0;
    const onModelBudgetReservation = async reservation => {
      const nextRunUsage = Number(reservation?.tokenUsage);
      if (!Number.isSafeInteger(nextRunUsage) || nextRunUsage < lastRunReservedTokens) {
        throw Object.assign(new Error('Evolution token reservation is invalid.'), { code: 'AGENT_BUDGET_EXCEEDED' });
      }
      const delta = nextRunUsage - lastRunReservedTokens;
      const nextReservedTotal = Number(evolutionTokenBudget.reservedTokenUpperBound || 0) + delta;
      if (nextReservedTotal > Number(evolutionTokenBudget.maxTotalTokens)) {
        throw Object.assign(new Error('Evolution token budget would be exceeded.'), { code: 'AGENT_BUDGET_EXCEEDED' });
      }
      lastRunReservedTokens = nextRunUsage;
      evolutionTokenBudget.reservedTokenUpperBound = nextReservedTotal;
    };
    const shadowDependencies = {
      scaffoldSpec: candidate,
      loadPlanReviewContext: async () => fixture.context,
      goalModel: {
        find: query => {
          let limitCount = Number.POSITIVE_INFINITY;
          const goalQuery = {
            sort: () => goalQuery,
            limit: value => {
              if (Number.isSafeInteger(value) && value >= 0) limitCount = Math.min(limitCount, value);
              return goalQuery;
            },
            lean: async () => {
              if (fixtureIdentity(query?.userId) !== fixtureIdentityBinding.userId
                  || fixtureIdentity(query?.profileId) !== fixtureIdentityBinding.profileId) {
                throw Object.assign(new Error('PlanReview requested goals outside the bound fixture identity.'), {
                  code: 'EVALUATION_FIXTURE_IDENTITY_MISMATCH',
                });
              }
              if (!fixtureGoalsAvailable) throw new Error('Fixture goal evidence is unavailable.');
              return fixtureGoals.slice(0, limitCount);
            },
          };
          return goalQuery;
        },
      },
      persistAgentRun: undefined,
      modelPlannerEnabled: false,
      shadowExecution: true,
      plannerProvider: dependencies.plannerProvider,
      explanationProviders: dependencies.explanationProviders || [],
      signal: typeof AbortSignal !== 'undefined' && dependencies.signal instanceof AbortSignal
        ? dependencies.signal
        : undefined,
      timeoutMs: dependencies.timeoutMs,
      toolTimeoutMs: dependencies.toolTimeoutMs,
      onNodeProgress: async payload => {
        if (payload?.event && typeof payload.event.type === 'string') trajectory.push(payload.event);
      },
      ...(evolutionTokenBudget ? {
        maxTotalTokens: remainingEvolutionTokens,
        onModelBudgetReservation,
      } : {}),
    };
    const review = await invokePlanReviewGraph({
      userId: fixtureIdentityBinding.userId,
      profileId: fixtureIdentityBinding.profileId,
      // PlanReview validates runId as a UUIDv4; prefixes turn an otherwise
      // valid UUID into an invalid run and make every evaluation a fallback.
      runId: crypto.randomUUID(),
      dependencies: shadowDependencies,
    });
    if (dependencies.strictModelPlanner === true
        && (review?.planner?.fallback === true || review?.planner?.provider === 'DETERMINISTIC')) {
      const error = new Error('The live candidate planner fell back to deterministic output.');
      error.code = 'EVOLUTION_PLANNER_REQUIRED';
      throw error;
    }
    const after = await dependencies.captureFinancialAuthority({ caseDefinition, phase: 'after' });
    const beforeFingerprint = canonicalSha256(before);
    const afterFingerprint = canonicalSha256(after);
    const authorityMeasurementState = before?.authorityMeasurementState === 'MEASURED'
      && after?.authorityMeasurementState === 'MEASURED'
      ? 'MEASURED'
      : (before?.authorityMeasurementState === after?.authorityMeasurementState
        ? before?.authorityMeasurementState || 'MISSING'
        : 'INCOMPLETE');
    const financialAuthorityDelta = authorityMeasurementState === 'MEASURED'
      ? (beforeFingerprint === afterFingerprint ? 0 : 1)
      : null;
    return {
      result: review,
      trajectory,
      financialAuthorityDelta,
      authorityMeasurementState,
      authorityBeforeFingerprint: beforeFingerprint,
      authorityAfterFingerprint: afterFingerprint,
    };
  };
}

export function createOfflineEvolutionRun({ baseSpec, cases = [], enabled = false, candidateFactory = null, runner = null } = {}) {
  if (!enabled) return { status: 'DISABLED', reason: 'AGENT_EVOLUTION_ENABLED is false.' };
  assertScaffoldSpecSafe(baseSpec);
  const manifest = createOptimizerEvaluationManifest({ cases, datasetVersion: EVOLUTION_VERSION, source: 'offline-sanitized' });
  const trainValidation = [...manifest.partitions.train, ...manifest.partitions.validation];
  const candidate = typeof candidateFactory === 'function'
    ? candidateFactory(baseSpec)
    : createScaffoldSpec({ ...baseSpec, version: `${baseSpec.version}-candidate-${crypto.randomUUID().slice(0, 8)}`, parentVersion: baseSpec.version });
  assertScaffoldSpecSafe(candidate);
  const hasFixtureResults = trainValidation.every(item => item && item.result);
  if (typeof runner !== 'function' && !hasFixtureResults) {
    const error = new Error('A real closed-loop evolution runner is required; expected outputs cannot be substituted.');
    error.code = 'EVOLUTION_RUNNER_REQUIRED';
    throw error;
  }
  const evaluation = evaluateCandidate({
    candidateId: candidate.contentHash,
    cases: trainValidation,
    evaluator: item => typeof runner === 'function'
      ? runner({ candidate, caseDefinition: item })
      : { result: item.result, trajectory: item.trajectory || [] },
  });
  return {
    status: 'COMPLETED',
    evolutionVersion: EVOLUTION_VERSION,
    evaluationVersion: AGENT_EVALUATION_VERSION,
    baseScaffoldVersion: baseSpec.version,
    candidate,
    evaluation,
    holdoutSealed: false,
    datasetHash: manifest.datasetHash,
  };
}
