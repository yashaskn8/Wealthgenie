import { canonicalSha256 } from '../../utils/canonicalJson.js';

export const PLAN_REVIEW_AGENT_VERSION = 'plan-review-agent-2.0.0';
export const PLAN_REVIEW_GRAPH_VERSION = 'plan-review-graph-1.1.0';
export const PLAN_REVIEW_GROUNDING_VERSION = 'grounded-financial-evidence-1.0.0';
export const PLAN_REVIEW_TOOL_CATALOG_VERSION = 'plan-review-tools-1.1.0';

// PlanHealth runs in its own bounded scheduler, not in the AgentRun queue.
// The numeric values are explicit persisted scheduling policy, not lexical enum ordering.
export const PLAN_REVIEW_PRIORITY_RANK = Object.freeze({
  INTERACTIVE_PLAN_REVIEW: 0,
  PLAN_HEALTH_BACKGROUND: 100,
});

export const PLAN_REVIEW_RUN_STATES = Object.freeze([
  'QUEUED',
  'RUNNING',
  'WAITING_FOR_APPROVAL',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'SUPERSEDED',
  'BUDGET_EXCEEDED',
  'FEATURE_UNAVAILABLE',
]);

export const ACTIVE_PLAN_REVIEW_STATES = Object.freeze([
  'QUEUED',
  'RUNNING',
  'WAITING_FOR_APPROVAL',
]);

// Any run retaining active dedupe/workflow ownership consumes per-user
// capacity. Keep queue admission, dedupe, and UI lifecycle aligned.
export const CAPACITY_CONSUMING_PLAN_REVIEW_STATES = ACTIVE_PLAN_REVIEW_STATES;

export const TERMINAL_PLAN_REVIEW_STATES = Object.freeze([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'BUDGET_EXCEEDED',
  'FEATURE_UNAVAILABLE',
  'SUPERSEDED',
]);

export const PLAN_REVIEW_TRANSITIONS = Object.freeze({
  QUEUED: ['RUNNING', 'CANCELLED', 'SUPERSEDED'],
  RUNNING: ['QUEUED', 'WAITING_FOR_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED', 'BUDGET_EXCEEDED', 'SUPERSEDED'],
  WAITING_FOR_APPROVAL: ['RUNNING', 'COMPLETED', 'CANCELLED', 'SUPERSEDED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  BUDGET_EXCEEDED: [],
  FEATURE_UNAVAILABLE: [],
  SUPERSEDED: [],
});

export const PLAN_REVIEW_TRAJECTORY_EVENTS = Object.freeze([
  'PLAN_CREATED',
  'NODE_ENTERED',
  'TOOL_SELECTED',
  'TOOL_AUTHORIZED',
  'TOOL_SUCCEEDED',
  'TOOL_FAILED',
  'EVIDENCE_VALIDATED',
  'RESEARCH_REQUIRED',
  'RESEARCH_TASK_STARTED',
  'RESEARCH_SEARCH_ROUND',
  'RESEARCH_SOURCES_FOUND',
  'RESEARCH_VERIFYING',
  'RESEARCH_COMPLETED',
  'RESEARCH_FAILED',
  'SCENARIO_ANALYSIS_STARTED',
  'SCENARIO_ANALYSIS_COMPLETED',
  'POLICY_REJECTED',
  'FALLBACK_USED',
  'APPROVAL_REQUESTED',
  'RESULT_READY',
  'RUN_COMPLETED',
  'RUN_WAITING_FOR_APPROVAL',
]);

export const PLAN_REVIEW_BUDGETS = Object.freeze({
  maxSteps: 6,
  maxToolCalls: 8,
  maxToolCallsPerTool: 2,
  maxModelCalls: 2,
  maxInputTokens: 4000,
  maxOutputTokens: 1200,
  maxTotalTokens: 5200,
  maxDurationMs: 30000,
  maxAttempts: 2,
});
export const PLAN_REVIEW_CHECKPOINT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function buildPlanReviewSnapshotBinding({ userId, profileId, currentState = null, freshness = null, financialProfileStateRevision = null, goalSnapshot = null }) {
  const recommendation = currentState?.recommendation || null;
  const allocation = currentState?.allocationRevision || currentState?.currentAllocation || null;
  const provenance = currentState?.provenance || {};
  const profile = currentState?.profile || null;
  const profileVersion = currentState?.profileVersion ?? profile?.version ?? null;
  return Object.freeze({
    schemaVersion: 'plan-review-source-binding-1.1.0',
    userId: String(userId),
    profileId: String(profileId),
    financialProfileStateRevision: financialProfileStateRevision !== null
      && financialProfileStateRevision !== undefined
      && Number.isSafeInteger(Number(financialProfileStateRevision))
      ? Number(financialProfileStateRevision)
      : null,
    goalSnapshotCount: Number.isSafeInteger(Number(goalSnapshot?.count)) && Number(goalSnapshot.count) >= 0
      ? Number(goalSnapshot.count)
      : null,
    goalSnapshotHash: typeof goalSnapshot?.hash === 'string' && /^[a-f0-9]{64}$/.test(goalSnapshot.hash)
      ? goalSnapshot.hash
      : null,
    profileVersion: Number.isInteger(Number(profileVersion)) ? Number(profileVersion) : null,
    profileInputHash: recommendation?.profileInputHash || provenance.profileInputHash || null,
    recommendationId: recommendation?._id ? String(recommendation._id) : null,
    recommendationGeneration: recommendation?.recommendationGeneration ?? currentState?.statePointer?.generationRevision ?? null,
    allocationRevision: allocation?.revision ?? null,
    allocationRevisionId: allocation?._id ? String(allocation._id) : null,
    portfolioFingerprint: currentState?.portfolioFingerprint || allocation?.portfolioFingerprint || null,
    recommendationFingerprint: currentState?.recommendationFingerprint || allocation?.recommendationFingerprint || null,
    recommendationPolicyVersion: recommendation?.recommendationPolicyVersion || provenance.recommendationPolicyVersion || null,
    regulatoryRuleVersion: recommendation?.regulatoryRuleVersion || provenance.regulatoryRuleVersion || null,
    returnAssumptionVersion: allocation?.returnAssumptionVersion || provenance.returnAssumptionVersion || null,
    returnAssumptionHash: allocation?.returnAssumptionHash || provenance.returnAssumptionHash || null,
    returnAssumptionSource: allocation?.returnAssumptionSource || provenance.returnAssumptionSource || null,
    provenanceStatus: provenance.status || 'MISSING',
    freshnessReasonCodes: [...new Set(freshness?.reasonCodes || currentState?.freshness?.reasonCodes || [])].sort(),
  });
}

export function hashPlanReviewSnapshot(binding) {
  return canonicalSha256(binding);
}

export function planReviewGraphThreadId(runId, executionGeneration) {
  const generation = Number(executionGeneration);
  if (!runId || !Number.isInteger(generation) || generation < 1) {
    throw new TypeError('A run ID and positive execution generation are required for checkpoint isolation.');
  }
  return `${String(runId)}:${generation}`;
}

export function hashPlanReviewRequest({ userId, profileId, planReviewSnapshotHash, agentVersion = PLAN_REVIEW_AGENT_VERSION }) {
  return canonicalSha256({
    userId: String(userId),
    profileId: String(profileId),
    planReviewSnapshotHash: String(planReviewSnapshotHash || ''),
    agentVersion,
  });
}

export function isActivePlanReviewState(status) {
  return ACTIVE_PLAN_REVIEW_STATES.includes(status);
}

export function isTerminalPlanReviewState(status) {
  return TERMINAL_PLAN_REVIEW_STATES.includes(status);
}

export function canTransitionPlanReviewState(from, to) {
  return PLAN_REVIEW_TRANSITIONS[from]?.includes(to) === true;
}

export function assertPlanReviewTransition(from, to) {
  if (!canTransitionPlanReviewState(from, to)) {
    const error = new Error(`Invalid plan review state transition: ${from} -> ${to}`);
    error.code = 'INVALID_AGENT_STATE_TRANSITION';
    throw error;
  }
}

export function buildApprovalAction(action, run) {
  const allowed = new Set(['APPROVE_RECOMPUTE', 'REJECT_RECOMPUTE', 'OPEN_PROFILE', 'OPEN_GOALS']);
  if (!allowed.has(action)) {
    const error = new Error('Unsupported plan review approval action.');
    error.code = 'UNSUPPORTED_AGENT_ACTION';
    throw error;
  }
  return {
    action,
    runId: String(run.runId),
    profileId: run.profileId ? String(run.profileId) : null,
    recommendationId: run.recommendationId ? String(run.recommendationId) : null,
    requiresAuthoritativeWorkflow: action === 'APPROVE_RECOMPUTE',
    mutationPerformed: false,
  };
}
