import crypto from 'node:crypto';
import mongoose from 'mongoose';
import AgentRun from '../../models/AgentRun.js';
import AgentRunEvent from '../../models/AgentRunEvent.js';
import AgentCheckpoint from '../../models/AgentCheckpoint.js';
import AgentGraphCheckpoint from '../../models/AgentGraphCheckpoint.js';
import AgentQueueAdmission from '../../models/AgentQueueAdmission.js';
import FinancialProfile from '../../models/FinancialProfile.js';
import { isUsableProviderCredential } from '../../services/providerAbstraction.js';
import { getRuntimeConfig } from '../../config/runtime.js';
import { invokePlanReviewGraph } from './planReviewGraph.js';
import { PLAN_REVIEW_POLICY_VERSION, PLAN_REVIEW_PLANNER_VERSION } from './planReviewSchemas.js';
import {
  PLAN_REVIEW_AGENT_VERSION,
  PLAN_REVIEW_GRAPH_VERSION,
  PLAN_REVIEW_TOOL_CATALOG_VERSION,
  PLAN_REVIEW_BUDGETS,
  PLAN_REVIEW_PRIORITY_RANK,
  CAPACITY_CONSUMING_PLAN_REVIEW_STATES,
  hashPlanReviewRequest,
  isActivePlanReviewState,
} from './planReviewRuntime.js';
import { resolvePlanReviewSnapshot } from './planReviewSnapshot.js';
import { createModelGateway } from '../modelGateway.js';
import { createResearchMeshClient } from '../research/researchMeshClient.js';
import { terminalizePlanReviewRun } from './planReviewTerminal.js';

const MAX_ADMISSION_TRANSACTION_RETRIES = 12;

function isRetryableAdmissionConflict(error) {
  return Number(error?.code) === 112 || error?.hasErrorLabel?.('TransientTransactionError') === true;
}

function waitForAdmissionRetry(attempt) {
  const backoffMs = Math.min(100, 5 * (2 ** attempt));
  const jitterMs = crypto.randomInt(0, Math.max(2, Math.floor(backoffMs / 2) + 1));
  return new Promise(resolve => setTimeout(resolve, backoffMs + jitterMs));
}

// External planning is opt-in, and only a genuinely configured primary may
// make paid model calls. The existing deterministic planner remains available
// without any model credentials. Never promote a mock or template key.
export function isLivePlanReviewPlannerReady(env = process.env) {
  if (env.AGENT_USE_MODEL_PLANNER !== 'true'
      || String(env.LLM_DEFAULT_PROVIDER || '').trim().toLowerCase() === 'mock') return false;
  const selected = String(env.LLM_PRIMARY_PROVIDER || 'GROQ').trim().toUpperCase();
  const providerKeys = {
    NVIDIA_NIM: 'NVIDIA_API_KEY',
    GEMINI: 'GEMINI_API_KEY',
    GROQ: 'GROQ_API_KEY',
  };
  return Object.hasOwn(providerKeys, selected)
    && isUsableProviderCredential(env[providerKeys[selected]]);
}

function publicReview(review) {
  if (!review) return null;
  const { execution: _execution, policyReasonCodes: _policyReasonCodes, ...safe } = review;
  return safe;
}

export async function persistPlanReviewRun({ review, userId, profileId, recommendationId, planReviewSnapshotHash, sourceBinding, traceId, correlationId, startedAt, completedAt, promptScaffoldHash = null, stepCount, toolCallCount, modelCallCount, tokenUsage, model = AgentRun }) {
  const exactCounter = (name, value, max) => {
    const count = value === undefined || value === null ? 0 : Number(value);
    if (!Number.isInteger(count) || count < 0 || count > max) {
      const error = new Error(`PlanReview ${name} exceeded its hard execution budget.`);
      error.code = 'AGENT_BUDGET_EXCEEDED';
      error.reason = name.toUpperCase();
      throw error;
    }
    return count;
  };
  const document = await model.create({
    runId: review.runId,
    agentType: 'PLAN_REVIEW',
    userId,
    profileId: review.recommendedAction === 'REVIEW_PROFILE' ? null : profileId,
    recommendationId: recommendationId || null,
    planReviewSnapshotHash,
    sourceBinding,
    status: review.status,
    recommendedAction: review.recommendedAction,
    findingCodes: (review.findings || []).map(item => item.code),
    evidenceIds: (review.evidence?.entries || []).map(item => item.id).filter(Boolean),
    provider: review.provider?.name || 'DETERMINISTIC_FALLBACK',
    model: review.provider?.model || null,
    plannerVersion: PLAN_REVIEW_PLANNER_VERSION,
    policyVersion: PLAN_REVIEW_POLICY_VERSION,
    groundingVersion: review.evidence?.entries?.length ? 'grounded-financial-evidence-1.0.0' : null,
    promptScaffoldHash,
    ragManifestHash: null,
    agentVersion: PLAN_REVIEW_AGENT_VERSION,
    graphVersion: PLAN_REVIEW_GRAPH_VERSION,
    toolCatalogVersion: PLAN_REVIEW_TOOL_CATALOG_VERSION,
    traceId: traceId || null,
    correlationId: correlationId || null,
    stepCount: exactCounter('stepCount', stepCount, PLAN_REVIEW_BUDGETS.maxSteps),
    toolCallCount: exactCounter('toolCallCount', toolCallCount, PLAN_REVIEW_BUDGETS.maxToolCalls),
    modelCallCount: exactCounter('modelCallCount', modelCallCount, PLAN_REVIEW_BUDGETS.maxModelCalls),
    tokenUsage: exactCounter('tokenUsage', tokenUsage, PLAN_REVIEW_BUDGETS.maxTotalTokens),
    result: publicReview(review),
    startedAt: new Date(startedAt),
    completedAt,
  });
  return document;
}

export async function runPlanReview({ userId, profileId, runId = null, executionGeneration = 1, expectedPlanReviewSnapshotHash = null, resumeCheckpoint = null, correlationId = null, traceId = null, returnInternalResult = false, runtimeConfig = getRuntimeConfig(), dependencies = {} }) {
  const researchConfig = runtimeConfig.researchMesh || {};
  const researchEnabled = Boolean(researchConfig.a2aV1Enabled && researchConfig.adaptiveResearchEnabled);
  let researchMeshClient = dependencies.researchMeshClient || null;
  let researchClientInitError = null;
  if (researchEnabled && !researchMeshClient) {
    try {
      researchMeshClient = createResearchMeshClient({ env: dependencies.researchEnv || process.env, fetchImpl: dependencies.fetchImpl || globalThis.fetch });
    } catch (error) {
      researchClientInitError = error.code || 'RESEARCH_AGENT_CONFIGURATION_INVALID';
    }
  }
  const result = await invokePlanReviewGraph({
    userId,
    profileId,
    runId,
    executionGeneration,
    expectedPlanReviewSnapshotHash,
    resumeCheckpoint,
    correlationId,
    traceId,
    dependencies: {
      timeoutMs: runtimeConfig.agentPlanReview.timeoutMs,
      maxSteps: runtimeConfig.agentPlanReview.maxSteps,
      maxToolCalls: runtimeConfig.agentPlanReview.maxToolCalls,
      maxToolCallsPerTool: runtimeConfig.agentPlanReview.maxToolCallsPerTool,
      maxModelCalls: runtimeConfig.agentPlanReview.maxModelCalls,
      maxInputTokens: runtimeConfig.agentPlanReview.maxInputTokens,
      maxOutputTokens: runtimeConfig.agentPlanReview.maxOutputTokens,
      maxTotalTokens: runtimeConfig.agentPlanReview.maxTotalTokens,
      toolTimeoutMs: Math.min(5000, runtimeConfig.agentPlanReview.timeoutMs),
      // Route planner and synthesis calls through the same durable, run-wide
      // model budget so approved provider failover cannot bypass accounting.
      plannerProvider: null,
      modelPlannerEnabled: isLivePlanReviewPlannerReady(),
      modelGateway: createModelGateway({ maxOutputTokens: runtimeConfig.agentPlanReview.maxOutputTokens }),
      persistAgentRun: payload => persistPlanReviewRun(payload),
      researchAdaptiveEnabled: researchEnabled,
      researchDeepEnabled: Boolean(researchConfig.deepResearchEnabled),
      researchMeshClient,
      researchClientInitError,
      researchBudget: researchConfig.budgets,
      ...dependencies,
    },
  });
  return returnInternalResult ? result.review : publicReview(result.review);
}

function publicRun(run, { currentStateMatch = null } = {}) {
  if (!run) return null;
  return {
    runId: run.runId,
    status: run.status,
    profileId: run.profileId ? String(run.profileId) : null,
    recommendationId: run.recommendationId ? String(run.recommendationId) : null,
    planReviewSnapshotHash: run.planReviewSnapshotHash || null,
    currentStateMatch,
    recommendedAction: run.recommendedAction,
    result: run.result || null,
    progress: run.progress || { completedNodes: [], percent: 0, label: null },
    currentNode: run.currentNode || null,
    attempt: run.attempt || 0,
    maxAttempts: run.maxAttempts || PLAN_REVIEW_BUDGETS.maxAttempts,
    tokenUsage: run.tokenUsage || 0,
    agentVersion: run.agentVersion || PLAN_REVIEW_AGENT_VERSION,
    graphVersion: run.graphVersion || PLAN_REVIEW_GRAPH_VERSION,
    queuedAt: run.queuedAt || null,
    startedAt: run.startedAt || null,
    completedAt: run.completedAt || null,
    failure: run.failure || null,
    approval: run.approval || null,
  };
}

export async function enqueuePlanReviewRun({
  userId,
  profileId,
  correlationId = null,
  model = AgentRun,
  admissionModel = AgentQueueAdmission,
  mongo = mongoose,
  profileModel = FinancialProfile,
  snapshotResolver = resolvePlanReviewSnapshot,
  snapshotDependencies = {},
  runtimeConfig = getRuntimeConfig(),
}) {
  const snapshot = await snapshotResolver({ userId, profileId, profileModel, dependencies: snapshotDependencies });
  const { sourceBinding, planReviewSnapshotHash } = snapshot;
  const dedupeKey = hashPlanReviewRequest({ userId, profileId, planReviewSnapshotHash });
  const queueError = () => {
    const error = new Error('The plan review queue is currently full. Please retry shortly.');
    error.status = 429;
    error.code = 'AGENT_QUEUE_SATURATED';
    error.retryAfterMs = 5000;
    return error;
  };
  const runAdmissionAttempt = async () => {
    const session = await mongo.startSession();
    let result = null;
    try {
      if (typeof session?.withTransaction !== 'function') {
        const error = new Error('PlanReview queue admission requires transaction-capable MongoDB.');
        error.status = 503;
        error.code = 'AGENT_QUEUE_ADMISSION_UNAVAILABLE';
        throw error;
      }
      await session.withTransaction(async () => {
        // The driver may rerun a transaction callback; never retain a result
        // from an earlier uncommitted callback invocation.
        result = null;
        // This durable row is the cross-replica admission fence. Its write makes
        // concurrent admission transactions conflict and retry against fresh counts.
        const gate = await admissionModel.updateOne(
          { _id: 'plan-review' },
          { $inc: { epoch: 1 } },
          { session },
        );
        if (!Number(gate?.modifiedCount ?? gate?.nModified ?? 0)) {
          const error = new Error('PlanReview queue admission state is missing or unavailable.');
          error.status = 503;
          error.code = 'AGENT_QUEUE_ADMISSION_UNAVAILABLE';
          throw error;
        }

        // Retire stale active work atomically with admission; history and
        // checkpoints remain intact.
        const staleFilter = {
          userId,
          profileId,
          agentType: 'PLAN_REVIEW',
          status: { $in: CAPACITY_CONSUMING_PLAN_REVIEW_STATES },
          planReviewSnapshotHash: { $ne: planReviewSnapshotHash },
        };
        if (typeof model.find === 'function') {
          const staleQuery = model.find(staleFilter);
          staleQuery.session?.(session);
          const staleRuns = await (staleQuery.lean ? staleQuery.lean() : staleQuery);
          for (const stale of staleRuns || []) {
            await terminalizePlanReviewRun({
              model,
              userId,
              runId: stale.runId,
              expectedStatuses: [stale.status],
              expectedPlanReviewSnapshotHash: stale.planReviewSnapshotHash,
              status: 'SUPERSEDED',
              reasonCode: 'PLAN_REVIEW_SOURCE_SUPERSEDED',
              node: stale.currentNode || null,
              now: new Date(),
              session,
            });
          }
        } else {
          await model.updateMany(staleFilter, {
            $set: {
              status: 'SUPERSEDED', completedAt: new Date(), leaseUntil: null,
              failure: { code: 'PLAN_REVIEW_SOURCE_SUPERSEDED', message: 'Financial source state changed before this review completed.' },
            },
            $unset: { activeDedupeKey: 1 },
          }, { session });
        }

        const activeQuery = model.findOne({
          userId,
          profileId,
          agentType: 'PLAN_REVIEW',
          status: { $in: CAPACITY_CONSUMING_PLAN_REVIEW_STATES },
          activeDedupeKey: dedupeKey,
        });
        activeQuery.session?.(session);
        const active = await (activeQuery.lean ? activeQuery.lean() : activeQuery);
        if (active) {
          result = { created: false, run: publicRun(active, { currentStateMatch: true }) };
          return;
        }

        if (typeof model.countDocuments !== 'function') {
          const error = new Error('PlanReview durable queue capacity cannot be verified.');
          error.status = 503;
          error.code = 'AGENT_QUEUE_ADMISSION_UNAVAILABLE';
          throw error;
        }
        const queuedForUser = await model.countDocuments(
          { userId, agentType: 'PLAN_REVIEW', status: 'QUEUED' }, { session },
        );
        const activeForUser = await model.countDocuments(
          { userId, agentType: 'PLAN_REVIEW', status: { $in: CAPACITY_CONSUMING_PLAN_REVIEW_STATES } }, { session },
        );
        const globalQueued = await model.countDocuments(
          { agentType: 'PLAN_REVIEW', status: 'QUEUED' }, { session },
        );
        if (queuedForUser >= runtimeConfig.agentPlanReview.maxQueuedRunsPerUser
          || activeForUser >= runtimeConfig.agentPlanReview.maxActiveRunsPerUser
          || globalQueued >= runtimeConfig.agentPlanReview.maxGlobalQueuedRuns) throw queueError();

        const [created] = await model.create([{
          runId: crypto.randomUUID(),
          agentType: 'PLAN_REVIEW',
          userId,
          profileId,
          status: 'QUEUED',
          priority: 'INTERACTIVE_PLAN_REVIEW',
          priorityRank: PLAN_REVIEW_PRIORITY_RANK.INTERACTIVE_PLAN_REVIEW,
          recommendationId: sourceBinding.recommendationId,
          planReviewSnapshotHash,
          sourceBinding,
          dedupeKey,
          activeDedupeKey: dedupeKey,
          correlationId,
          agentVersion: PLAN_REVIEW_AGENT_VERSION,
          graphVersion: PLAN_REVIEW_GRAPH_VERSION,
          toolCatalogVersion: PLAN_REVIEW_TOOL_CATALOG_VERSION,
          plannerVersion: PLAN_REVIEW_PLANNER_VERSION,
          policyVersion: PLAN_REVIEW_POLICY_VERSION,
          maxAttempts: PLAN_REVIEW_BUDGETS.maxAttempts,
        }], { session });
        result = { created: true, run: publicRun(created, { currentStateMatch: true }) };
      });
      if (!result) {
        const error = new Error('PlanReview queue admission completed without a durable result.');
        error.status = 503;
        error.code = 'AGENT_QUEUE_ADMISSION_UNAVAILABLE';
        throw error;
      }
      return result;
    } finally {
      await session?.endSession();
    }
  };

  const queueIsCurrentlyFull = async () => {
    try {
      const [queuedForUser, activeForUser, globalQueued] = await Promise.all([
        model.countDocuments({ userId, agentType: 'PLAN_REVIEW', status: 'QUEUED' }),
        model.countDocuments({ userId, agentType: 'PLAN_REVIEW', status: { $in: CAPACITY_CONSUMING_PLAN_REVIEW_STATES } }),
        model.countDocuments({ agentType: 'PLAN_REVIEW', status: 'QUEUED' }),
      ]);
      return queuedForUser >= runtimeConfig.agentPlanReview.maxQueuedRunsPerUser
        || activeForUser >= runtimeConfig.agentPlanReview.maxActiveRunsPerUser
        || globalQueued >= runtimeConfig.agentPlanReview.maxGlobalQueuedRuns;
    } catch {
      return false;
    }
  };

  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await runAdmissionAttempt();
      } catch (error) {
        if (!isRetryableAdmissionConflict(error)) throw error;
        if (attempt >= MAX_ADMISSION_TRANSACTION_RETRIES) {
          if (await queueIsCurrentlyFull()) throw queueError();
          const unavailable = new Error('PlanReview queue admission could not serialize its transaction.');
          unavailable.status = 503;
          unavailable.code = 'AGENT_QUEUE_ADMISSION_UNAVAILABLE';
          unavailable.cause = error;
          throw unavailable;
        }
        await waitForAdmissionRetry(attempt);
      }
    }
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const existing = await model.findOne({ activeDedupeKey: dedupeKey, planReviewSnapshotHash }).lean();
    if (!existing) throw error;
    return { created: false, run: publicRun(existing, { currentStateMatch: true }) };
  }
}

async function currentSnapshotHash({ userId, profileId, profileModel, snapshotResolver, snapshotDependencies }) {
  const snapshot = await snapshotResolver({ userId, profileId, profileModel, dependencies: snapshotDependencies });
  return snapshot.planReviewSnapshotHash;
}

export async function getPlanReviewRun({
  userId,
  runId,
  model = AgentRun,
  profileModel = FinancialProfile,
  snapshotResolver = resolvePlanReviewSnapshot,
  snapshotDependencies = {},
  eventModel = AgentRunEvent,
  checkpointModel = AgentCheckpoint,
  graphCheckpointModel = AgentGraphCheckpoint,
}) {
  const run = await model.findOne({ userId, runId }).lean();
  if (!run) return null;
  const activeStatus = isActivePlanReviewState(run.status);
  let match = false;
  if (run.profileId && run.planReviewSnapshotHash) {
    const currentHash = await currentSnapshotHash({ userId, profileId: run.profileId, profileModel, snapshotResolver, snapshotDependencies });
    match = currentHash === run.planReviewSnapshotHash;
  }
  if (!match && activeStatus) {
    const transitioned = await terminalizePlanReviewRun({
      model, eventModel, checkpointModel, graphCheckpointModel, userId, runId,
      expectedStatuses: [run.status],
      expectedPlanReviewSnapshotHash: run.planReviewSnapshotHash,
      status: 'SUPERSEDED', reasonCode: 'PLAN_REVIEW_SOURCE_SUPERSEDED',
    });
    if (transitioned) run.status = transitioned.status;
    else {
      const latest = await model.findOne({ userId, runId }).lean();
      if (latest) Object.assign(run, latest);
    }
  }
  return publicRun(run, { currentStateMatch: match });
}

export async function getCurrentPlanReviewRun({
  userId,
  profileId,
  model = AgentRun,
  profileModel = FinancialProfile,
  snapshotResolver = resolvePlanReviewSnapshot,
  snapshotDependencies = {},
}) {
  const planReviewSnapshotHash = await currentSnapshotHash({ userId, profileId, profileModel, snapshotResolver, snapshotDependencies });
  const run = await model.findOne({ userId, profileId, agentType: 'PLAN_REVIEW', planReviewSnapshotHash })
    .sort({ queuedAt: -1, createdAt: -1 })
    .lean();
  return publicRun(run, { currentStateMatch: Boolean(run) });
}

export { isActivePlanReviewState };
