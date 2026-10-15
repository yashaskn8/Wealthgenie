import Joi from 'joi';
import { PLAN_REVIEW_BUDGETS } from './planReviewRuntime.js';
import { FINANCIAL_CLAIM_TYPES, FINANCIAL_CLAIM_UNITS } from '../../services/typedFinancialClaims.js';

export const PLAN_REVIEW_VERSION = 'plan-review-1.1.0';
export const SUPPORTED_PLAN_REVIEW_VERSIONS = Object.freeze(['plan-review-1.0.0', PLAN_REVIEW_VERSION]);
export const PLAN_REVIEW_PLANNER_VERSION = 'plan-review-planner-1.0.0';
export const PLAN_REVIEW_POLICY_VERSION = 'plan-review-policy-1.0.0';

export const MAX_AGENT_STEPS = 6;
export const MAX_TOOL_CALLS = 8;
export const MAX_TOOL_CALLS_PER_TOOL = 2;

export const SAFE_PLAN_REVIEW_TOOLS = Object.freeze([
  'get_current_profile_context',
  'get_current_recommendation_summary',
  'check_recommendation_freshness',
  'get_plan_evidence_snapshot',
  'get_goal_status_summary',
]);

const PLAN_REVIEW_TOOL_SCOPES = Object.freeze({
  get_current_profile_context: 'PROFILE',
  get_current_recommendation_summary: 'CURRENT_RECOMMENDATION',
  check_recommendation_freshness: 'CURRENT_RECOMMENDATION',
  get_plan_evidence_snapshot: 'CURRENT_EVIDENCE',
  get_goal_status_summary: 'PROFILE_GOALS',
});

export const PLAN_REVIEW_TOOL_CAPABILITIES = Object.freeze(Object.fromEntries(
  SAFE_PLAN_REVIEW_TOOLS.map(toolName => [toolName, Object.freeze({
    capabilityId: `plan-review.${toolName}.read.v1`,
    capabilityVersion: '1.0.0',
    effect: 'READ',
    resourceScope: PLAN_REVIEW_TOOL_SCOPES[toolName],
    ownerScoped: true,
    writesFinancialAuthority: false,
    networkAccess: 'NONE',
    shadowAllowed: true,
  })]),
));

export function isSafePlanReviewCapability(toolName, capability = PLAN_REVIEW_TOOL_CAPABILITIES[toolName]) {
  const expected = PLAN_REVIEW_TOOL_CAPABILITIES[toolName];
  return Boolean(expected && capability
    && capability.capabilityId === expected.capabilityId
    && capability.capabilityVersion === expected.capabilityVersion
    && capability.effect === 'READ'
    && capability.resourceScope === expected.resourceScope
    && capability.ownerScoped === true
    && capability.writesFinancialAuthority === false
    && capability.networkAccess === 'NONE'
    && capability.shadowAllowed === true);
}

export const PLAN_REVIEW_ACTIONS = Object.freeze([
  'NONE',
  'REVIEW_PROFILE',
  'RECOMPUTE_PLAN',
  'REVIEW_GOALS',
  'INSUFFICIENT_EVIDENCE',
]);

const objectId = Joi.string().pattern(/^[0-9a-fA-F]{24}$/).message('Invalid ID format');

export const planReviewRequestSchema = Joi.object({
  profileId: objectId.required(),
}).unknown(false);

export const planReviewActionSchema = Joi.object({
  action: Joi.string().valid('APPROVE_RECOMPUTE', 'REJECT_RECOMPUTE', 'OPEN_PROFILE', 'OPEN_GOALS').required(),
}).unknown(false);

const plannerCheckSchema = Joi.string().valid(...SAFE_PLAN_REVIEW_TOOLS);
export const plannerPlanSchema = Joi.object({
  checks: Joi.array().items(plannerCheckSchema).min(1).max(SAFE_PLAN_REVIEW_TOOLS.length).unique().required(),
}).unknown(false);

const findingSchema = Joi.object({
  code: Joi.string().pattern(/^[A-Z0-9_]{2,80}$/).required(),
  severity: Joi.string().valid('INFO', 'ATTENTION', 'BLOCKED').required(),
  title: Joi.string().trim().min(1).max(160).required(),
  detail: Joi.string().trim().min(1).max(500).required(),
  evidenceIds: Joi.array().items(Joi.string().pattern(/^E_[A-Z0-9_:-]+$/)).max(20).default([]),
}).unknown(false);

const financialClaimSchema = Joi.object({
  type: Joi.string().valid(...FINANCIAL_CLAIM_TYPES).required(),
  value: Joi.number().required(),
  unit: Joi.string().valid(...FINANCIAL_CLAIM_UNITS).required(),
  timePeriod: Joi.string().trim().min(1).max(80).required(),
  source: Joi.string().trim().min(1).max(120).required(),
  evidenceId: Joi.string().pattern(/^E_[A-Z0-9_:-]+$/).required(),
  jurisdiction: Joi.string().pattern(/^[A-Z]{2,3}$/).allow(null).required(),
  effectivePeriod: Joi.object({
    from: Joi.string().isoDate().required(),
    to: Joi.string().isoDate().allow(null).required(),
  }).unknown(false).allow(null).required(),
  statement: Joi.string().trim().min(1).max(500).required(),
}).unknown(false);

const evidenceEntrySchema = Joi.object({
  id: Joi.string().pattern(/^E_[A-Z0-9_:-]+$/).required(),
  kind: Joi.string().max(80).allow(null),
  dataClass: Joi.string().max(120).allow(null),
  displayValue: Joi.string().max(4096).allow(null),
  authority: Joi.string().max(120).allow(null),
  source: Joi.alternatives().try(Joi.object().unknown(true), Joi.valid(null)),
  observedAt: Joi.alternatives().try(Joi.string().max(80), Joi.date()).allow(null),
}).unknown(true).custom((entry, helpers) => {
  const boundedValue = (value, depth = 0, budget = { nodes: 0 }) => {
    budget.nodes += 1;
    if (budget.nodes > 512 || depth > 8) return false;
    if (value === null || typeof value === 'boolean') return true;
    if (typeof value === 'string') return value.length <= 4096;
    if (typeof value === 'number') return Number.isFinite(value);
    if (value instanceof Date) return Number.isFinite(value.getTime());
    if (Array.isArray(value)) {
      return value.length <= 100 && value.every(item => boundedValue(item, depth + 1, budget));
    }
    if (typeof value !== 'object') return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Object.keys(value);
    return keys.length <= 64 && keys.every(key => key.length <= 128
      && boundedValue(value[key], depth + 1, budget));
  };
  const boundedText = (record, key, length) => !Object.hasOwn(record, key)
    || record[key] === null
    || (typeof record[key] === 'string' && record[key].length <= length);
  const safeSource = !Object.hasOwn(entry, 'source') || entry.source === null
    || (entry.source && typeof entry.source === 'object' && !Array.isArray(entry.source)
      && boundedText(entry.source, 'provider', 200)
      && boundedText(entry.source, 'publicationDate', 80)
      && boundedText(entry.source, 'instrumentId', 128)
      && (!Object.hasOwn(entry.source, 'url') || entry.source.url === null
        || (typeof entry.source.url === 'string'
          && entry.source.url.length <= 2048
          && ['http:', 'https:'].includes((() => {
            try { return new URL(entry.source.url).protocol; } catch { return ''; }
          })())))
      && (typeof entry.source.publicationDate !== 'string'
        || Number.isFinite(Date.parse(entry.source.publicationDate))));
  const safeObservedAt = !Object.hasOwn(entry, 'observedAt') || entry.observedAt === null
    || entry.observedAt instanceof Date
    || (typeof entry.observedAt === 'string' && entry.observedAt.length <= 80
      && Number.isFinite(Date.parse(entry.observedAt)));
  const valid = boundedValue(entry)
    && boundedText(entry, 'kind', 80)
    && boundedText(entry, 'dataClass', 120)
    && boundedText(entry, 'displayValue', 4096)
    && boundedText(entry, 'authority', 120)
    && safeSource
    && safeObservedAt
    && (!String(entry.id).startsWith('E_RESEARCH_')
      || (entry.value === null || (entry.value && typeof entry.value === 'object' && !Array.isArray(entry.value)))
        && (!entry.value || typeof entry.value !== 'object' || (
          boundedText(entry.value, 'supportStatus', 80)
          && boundedText(entry.value, 'claimId', 120)
        )));
  return valid ? entry : helpers.error('any.invalid');
});

const evidenceEntriesSchema = Joi.array()
  .items(evidenceEntrySchema)
  .unique('id')
  .max(40);

export const planReviewResponseSchema = Joi.object({
  version: Joi.string().valid(...SUPPORTED_PLAN_REVIEW_VERSIONS).required(),
  runId: Joi.string().guid({ version: ['uuidv4'] }).required(),
  status: Joi.string().valid('COMPLETED', 'FAILED', 'FEATURE_UNAVAILABLE').required(),
  recommendedAction: Joi.string().valid(...PLAN_REVIEW_ACTIONS).required(),
  summary: Joi.string().trim().min(1).max(2000).required(),
  findings: Joi.array().items(findingSchema).max(12).required(),
  freshness: Joi.object({
    fresh: Joi.boolean().required(),
    reasonCodes: Joi.array().items(Joi.string().pattern(/^[A-Z0-9_]{2,100}$/)).max(20).required(),
  }).unknown(false).required(),
  goals: Joi.object({
    status: Joi.string().valid('AVAILABLE', 'NONE', 'UNAVAILABLE').required(),
    items: Joi.array().max(20).required(),
  }).unknown(false).required(),
  evidence: Joi.object({
    status: Joi.string().valid('AVAILABLE', 'UNAVAILABLE').required(),
    // Version 1.0 historically allowed AVAILABLE with an empty entries array.
    // Keep that persisted shape readable while making the current contract strict.
    entries: evidenceEntriesSchema.required(),
    unavailableFacts: Joi.array().items(Joi.string().max(120)).max(20).required(),
  }).unknown(false).required(),
  financialClaims: Joi.array().items(financialClaimSchema).max(40).default([]),
  provider: Joi.object({
    name: Joi.string().max(80).required(),
    model: Joi.string().max(160).allow(null).required(),
    fallback: Joi.boolean().required(),
  }).unknown(false).required(),
  execution: Joi.object({
    stepCount: Joi.number().integer().min(0).max(MAX_AGENT_STEPS).required(),
    toolCallCount: Joi.number().integer().min(0).max(MAX_TOOL_CALLS).required(),
    modelCallCount: Joi.number().integer().min(0).max(2).optional(),
    tokenUsage: Joi.number().integer().min(0).max(PLAN_REVIEW_BUDGETS.maxTotalTokens).optional(),
  }).unknown(false).required(),
  policyReasonCodes: Joi.array().items(Joi.string().max(120)).max(20).optional(),
}).unknown(false).custom((value, helpers) => {
  if (value.version === PLAN_REVIEW_VERSION
      && value.evidence?.status === 'AVAILABLE'
      && Array.isArray(value.evidence.entries)
      && value.evidence.entries.length === 0) return helpers.error('any.invalid');
  return value;
});

export function validatePlannerPlan(value) {
  return plannerPlanSchema.validate(value, { abortEarly: false, convert: false });
}

export function validatePlanReviewResponse(value) {
  return planReviewResponseSchema.validate(value, { abortEarly: false, convert: false });
}

export function isPlanReviewRecomputeApprovalRun(run) {
  const result = run?.result;
  if (!run || typeof run !== 'object' || Array.isArray(run)
      || run.status !== 'WAITING_FOR_APPROVAL'
      || run.recommendedAction !== 'RECOMPUTE_PLAN'
      || !result || typeof result !== 'object' || Array.isArray(result)
      || result.runId !== run.runId
      || result.status !== 'COMPLETED'
      || result.recommendedAction !== 'RECOMPUTE_PLAN') return false;
  return !validatePlanReviewResponse(result).error;
}
