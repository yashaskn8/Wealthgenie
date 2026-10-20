import { Router } from 'express';
import { verifyJWT } from '../middleware/authMiddleware.js';
import { asyncHandler, createError } from '../middleware/errorHandler.js';
import { planReviewLimiter } from '../middleware/rateLimiter.js';
import { planReviewRequestSchema } from '../agents/planReview/planReviewSchemas.js';
import { planReviewActionSchema } from '../agents/planReview/planReviewSchemas.js';
import { isPlanReviewRecomputeApprovalRun } from '../agents/planReview/planReviewSchemas.js';
import { enqueuePlanReviewRun, getCurrentPlanReviewRun, getPlanReviewRun } from '../agents/planReview/planReviewService.js';
import { persistPlanReviewAction } from '../agents/planReview/planReviewApproval.js';
import { completePlanReviewMandateAction } from '../agents/planReview/planReviewApproval.js';
import { terminalizePlanReviewRun } from '../agents/planReview/planReviewTerminal.js';
import AgentRunModel from '../models/AgentRun.js';
import { buildApprovalAction } from '../agents/planReview/planReviewRuntime.js';
import { acknowledgePlanHealthEvent, inspectPlanHealth, listPlanHealthEvents } from '../services/planHealthMonitor.js';
import AgentRunEvent from '../models/AgentRunEvent.js';
import { streamPlanReviewEvents } from '../agents/planReview/planReviewEventStream.js';
import { buildPlanReviewA2UI } from '../agents/a2ui/a2uiSchemas.js';
import { A2A_PROTOCOL_VERSION, getAgentCard, listAgentCards } from '../agents/a2a/agentCards.js';
import { validateStrict } from '../validation/financialSchemas.js';
import { validateQuery, agentProfileQuerySchema, mandateListQuerySchema, planHealthEventsQuerySchema } from '../validation/schemas.js';
import { mandateApprovalAssertionSchema, mandateRevokeSchema, passkeyRegistrationResponseSchema } from '../agents/authorization/authorizationSchemas.js';
import {
  createMandateForPlanReview,
  getMandateForUser,
  listMandatesForUser,
  createApprovalOptions,
  verifyMandateApproval,
  revokeMandate,
} from '../agents/authorization/mandateService.js';
import { createAuthorizedActionExecutor } from '../agents/authorization/authorizedActionExecutor.js';
import { createPasskeyRegistrationOptions, verifyPasskeyRegistration } from '../agents/authorization/passkeyService.js';
import { hasRecentSessionAuthentication } from '../agents/authorization/recentAuthentication.js';
import ExecutionReceipt from '../models/ExecutionReceipt.js';
import { appendAuthorizationEvent } from '../agents/authorization/authorizationEvents.js';
import { PrometheusMetrics } from '../services/metricsCollector.js';
import { verifyExecutionReceiptForUser } from '../agents/authorization/receiptVerification.js';
import { getProductionAgentEvaluationForUser } from '../agents/evals/productionEvaluator.js';
import logger from '../utils/logger.js';

const router = Router();

function isEnabled(req) {
  return req.app.locals.runtimeConfig?.agenticPlanReviewEnabled === true;
}

function featureUnavailable() {
  throw createError(404, 'Plan review feature is unavailable.', 'Plan review is not available.', { code: 'FEATURE_UNAVAILABLE' });
}

function authorizationEnabled(req) {
  return req.app.locals.runtimeConfig?.authorization?.verifiableActionsEnabled === true;
}

function requireRecentAuthentication(req) {
  if (!hasRecentSessionAuthentication(req.user)) {
    throw createError(403, 'Recent sign-in required.', 'Please sign in again before enrolling a passkey.', { code: 'AUTH_REAUTH_REQUIRED' });
  }
}

function authorizationConfig(req) {
  const config = req.app.locals.runtimeConfig;
  return {
    ...config,
    env: {
      ...process.env,
      NODE_ENV: config.nodeEnv,
      AGENT_APPROVAL_PROVIDER: config.authorization.approvalProvider,
      WEBAUTHN_ORIGIN: config.authorization.webauthnOrigin || process.env.WEBAUTHN_ORIGIN,
      WEBAUTHN_RP_ID: config.authorization.webauthnRpId || process.env.WEBAUTHN_RP_ID,
    },
  };
}

router.post('/plan-review', verifyJWT, planReviewLimiter, validateStrict(planReviewRequestSchema), asyncHandler(async (req, res) => {
  if (!isEnabled(req)) return featureUnavailable();
  const result = await enqueuePlanReviewRun({
    userId: req.user.userId,
    profileId: req.body.profileId,
    correlationId: req.correlationId,
    traceId: req.traceId || req.correlationId,
    runtimeConfig: req.app.locals.runtimeConfig,
  });
  return res.status(result.created ? 202 : 200).json(result.run);
}));

router.get('/plan-review/current', verifyJWT, validateQuery(agentProfileQuerySchema), asyncHandler(async (req, res) => {
  if (!isEnabled(req)) return featureUnavailable();
  const run = await getCurrentPlanReviewRun({ userId: req.user.userId, profileId: req.query.profileId });
  if (!run) throw createError(404, 'No plan review run found.', 'No plan review run found.', { code: 'PLAN_REVIEW_RUN_NOT_FOUND' });
  return res.json(run);
}));

router.get('/production-evaluations/:evaluationId', verifyJWT, asyncHandler(async (req, res) => {
  if (!isEnabled(req)) return featureUnavailable();
  if (!/^[0-9a-f]{64}$/i.test(req.params.evaluationId)) {
    throw createError(400, 'Invalid production evaluation ID.', 'Invalid production evaluation ID.');
  }
  let evaluation;
  try {
    evaluation = await getProductionAgentEvaluationForUser({
      evaluationId: req.params.evaluationId,
      userId: req.user.userId,
    });
  } catch (error) {
    if (error?.code !== 'PRODUCTION_EVALUATION_INTEGRITY_FAILURE') throw error;
    throw createError(503, 'Production evaluation integrity verification failed.', 'Evaluation evidence is temporarily unavailable.', {
      code: 'PRODUCTION_EVALUATION_INTEGRITY_FAILURE',
    });
  }
  if (!evaluation) throw createError(404, 'Production evaluation not found or access denied.', 'Production evaluation not found.');
  return res.json(evaluation);
}));

router.get('/cards', verifyJWT, asyncHandler(async (req, res) => {
  if (!isEnabled(req)) return featureUnavailable();
  return res.json({ protocolVersion: A2A_PROTOCOL_VERSION, agents: listAgentCards() });
}));

router.get('/cards/:agentType', verifyJWT, asyncHandler(async (req, res) => {
  if (!isEnabled(req)) return featureUnavailable();
  const card = getAgentCard(req.params.agentType);
  if (!card) throw createError(404, 'Agent card not found.', 'Agent card not found.');
  return res.json(card);
}));

router.get('/plan-review/:runId/events', verifyJWT, asyncHandler(async (req, res) => {
  if (!isEnabled(req) || req.app.locals.runtimeConfig?.agentStreamEnabled !== true) return featureUnavailable();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.runId)) {
    throw createError(400, 'Invalid plan review run ID.', 'Invalid plan review run ID.');
  }
  const ownedRun = await AgentRunModel.findOne({ userId: req.user.userId, runId: req.params.runId }).lean();
  if (!ownedRun) throw createError(404, 'Plan review run not found or access denied.', 'Plan review run not found.');
  const cursorHeader = req.get('Last-Event-ID');
  const sequence = cursorHeader === undefined ? 0 : Number(cursorHeader);
  if (!Number.isSafeInteger(sequence) || sequence < 0 || (cursorHeader !== undefined && !/^(0|[1-9][0-9]*)$/.test(cursorHeader))) {
    throw createError(400, 'Invalid plan review event cursor.', 'Invalid event cursor.');
  }
  res.status(200);
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  await streamPlanReviewEvents({
    response: res,
    initialSequence: sequence,
    loadEvents: since => AgentRunEvent.find({
      userId: req.user.userId, runId: req.params.runId, sequence: { $gt: since },
    }).sort({ sequence: 1 }).limit(100).lean(),
    loadRun: () => AgentRunModel.findOne({ userId: req.user.userId, runId: req.params.runId }).lean(),
  });
}));

router.get('/plan-review/:runId', verifyJWT, asyncHandler(async (req, res) => {
  if (!isEnabled(req)) return featureUnavailable();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.runId)) {
    throw createError(400, 'Invalid plan review run ID.', 'Invalid plan review run ID.');
  }
  const run = await getPlanReviewRun({ userId: req.user.userId, runId: req.params.runId });
  if (!run) throw createError(404, 'Plan review run not found or access denied.', 'Plan review run not found.');
  return res.json(run);
}));

router.get('/plan-review/:runId/ui', verifyJWT, asyncHandler(async (req, res) => {
  if (!isEnabled(req)) return featureUnavailable();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.runId)) {
    throw createError(400, 'Invalid plan review run ID.', 'Invalid plan review run ID.');
  }
  const run = await AgentRunModel.findOne({ userId: req.user.userId, runId: req.params.runId }).lean();
  if (!run) throw createError(404, 'Plan review run not found or access denied.', 'Plan review run not found.');
  return res.json(buildPlanReviewA2UI(run));
}));

router.post('/plan-review/:runId/cancel', verifyJWT, asyncHandler(async (req, res) => {
  if (!isEnabled(req)) return featureUnavailable();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.runId)) {
    throw createError(400, 'Invalid plan review run ID.', 'Invalid plan review run ID.');
  }
  const run = await terminalizePlanReviewRun({
    model: AgentRunModel,
    userId: req.user.userId,
    runId: req.params.runId,
    expectedStatuses: ['QUEUED', 'RUNNING', 'WAITING_FOR_APPROVAL'],
    status: 'CANCELLED',
    reasonCode: 'USER_REQUESTED_CANCELLATION',
  });
  if (!run) throw createError(404, 'Plan review run not found or cannot be cancelled.', 'Plan review run not found.');
  return res.json({ runId: run.runId, status: run.status, mutationPerformed: false });
}));

router.post('/plan-review/:runId/action', verifyJWT, validateStrict(planReviewActionSchema), asyncHandler(async (req, res) => {
  if (!isEnabled(req)) return featureUnavailable();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(req.params.runId)) {
    throw createError(400, 'Invalid plan review run ID.', 'Invalid plan review run ID.');
  }
  const run = await getPlanReviewRun({ userId: req.user.userId, runId: req.params.runId });
  if (!run) throw createError(404, 'Plan review run not found or access denied.', 'Plan review run not found.');
  if (run.currentStateMatch !== true || run.status === 'SUPERSEDED') {
    throw createError(409, 'This review is bound to an outdated financial state.', 'Refresh the plan review before taking action.', { code: 'PLAN_REVIEW_SOURCE_SUPERSEDED' });
  }
  if (['APPROVE_RECOMPUTE', 'REJECT_RECOMPUTE'].includes(req.body.action)
      && !isPlanReviewRecomputeApprovalRun(run)) {
    throw createError(409, 'This plan review is not valid for recompute approval.', 'Plan review approval is not available.', {
      code: 'PLAN_REVIEW_APPROVAL_UNAVAILABLE',
    });
  }
  const descriptor = buildApprovalAction(req.body.action, run);
  if (req.body.action === 'APPROVE_RECOMPUTE' && authorizationEnabled(req)) {
    await appendAuthorizationEvent({ runId: req.params.runId, userId: req.user.userId, eventType: 'ACTION_PROPOSED', data: { action: req.body.action } });
    const mandate = await createMandateForPlanReview({
      runId: req.params.runId,
      userId: req.user.userId,
      correlationId: req.correlationId,
      ttlSeconds: req.app.locals.runtimeConfig.authorization.mandateTtlSeconds,
      runtimeConfig: authorizationConfig(req),
    });
    const updatedRun = await persistPlanReviewAction({
      userId: req.user.userId,
      runId: req.params.runId,
      planReviewSnapshotHash: run.planReviewSnapshotHash,
      action: req.body.action,
      mandate,
    });
    if (!updatedRun) {
      await revokeMandate({ mandateId: mandate.mandateId, userId: req.user.userId, reason: 'PlanReview state changed before mandate binding.' });
      throw createError(409, 'The review changed before approval could be bound.', 'Refresh the plan review before requesting approval.', { code: 'PLAN_REVIEW_SOURCE_SUPERSEDED' });
    }
    await appendAuthorizationEvent({ runId: req.params.runId, userId: req.user.userId, eventType: 'MANDATE_CREATED', data: { mandateId: mandate.mandateId, action: mandate.action } });
    return res.status(201).json({ ...descriptor, authorization: { enabled: true, status: mandate.status }, mandate });
  }
  const updatedRun = await persistPlanReviewAction({
    userId: req.user.userId,
    runId: req.params.runId,
    planReviewSnapshotHash: run.planReviewSnapshotHash,
    action: req.body.action,
  });
  if (!updatedRun) throw createError(409, 'The review changed before the action could be recorded.', 'Refresh the plan review before taking action.', { code: 'PLAN_REVIEW_SOURCE_SUPERSEDED' });
  return res.json(descriptor);
}));

router.get('/mandates', verifyJWT, validateQuery(mandateListQuerySchema), asyncHandler(async (req, res) => {
  if (!authorizationEnabled(req)) return featureUnavailable();
  return res.json({ mandates: await listMandatesForUser({ userId: req.user.userId, limit: req.query.limit }) });
}));

router.post('/passkeys/registration/options', verifyJWT, asyncHandler(async (req, res) => {
  if (!authorizationEnabled(req)) return featureUnavailable();
  requireRecentAuthentication(req);
  return res.json(await createPasskeyRegistrationOptions({ userId: req.user.userId, runtimeConfig: authorizationConfig(req) }));
}));

router.post('/passkeys/registration/verify', verifyJWT, validateStrict(passkeyRegistrationResponseSchema), asyncHandler(async (req, res) => {
  if (!authorizationEnabled(req)) return featureUnavailable();
  requireRecentAuthentication(req);
  return res.status(201).json(await verifyPasskeyRegistration({ userId: req.user.userId, response: req.body, runtimeConfig: authorizationConfig(req) }));
}));

router.get('/mandates/:mandateId', verifyJWT, asyncHandler(async (req, res) => {
  if (!authorizationEnabled(req)) return featureUnavailable();
  const mandate = await getMandateForUser({ mandateId: req.params.mandateId, userId: req.user.userId });
  if (!mandate) throw createError(404, 'Mandate not found or access denied.', 'Mandate not found.');
  return res.json(mandate);
}));

router.post('/mandates/:mandateId/approval/options', verifyJWT, asyncHandler(async (req, res) => {
  if (!authorizationEnabled(req)) return featureUnavailable();
  const result = await createApprovalOptions({ mandateId: req.params.mandateId, userId: req.user.userId, runtimeConfig: authorizationConfig(req) });
  await appendAuthorizationEvent({ runId: result.mandate.runId, userId: req.user.userId, eventType: 'USER_VERIFICATION_REQUIRED', data: { mandateId: req.params.mandateId, action: result.mandate.action } });
  return res.json(result);
}));

router.post('/mandates/:mandateId/approval/verify', verifyJWT, validateStrict(mandateApprovalAssertionSchema), asyncHandler(async (req, res) => {
  if (!authorizationEnabled(req)) return featureUnavailable();
  if (req.body.mandateId !== req.params.mandateId) throw createError(400, 'Mandate ID mismatch.', 'Mandate ID mismatch.');
  const mandate = await verifyMandateApproval({ mandateId: req.params.mandateId, userId: req.user.userId, assertion: req.body, runtimeConfig: authorizationConfig(req) });
  await appendAuthorizationEvent({ runId: mandate.runId, userId: req.user.userId, eventType: 'MANDATE_AUTHORIZED', data: { mandateId: mandate.mandateId, action: mandate.action } });
  return res.json(mandate);
}));

router.post('/mandates/:mandateId/revoke', verifyJWT, validateStrict(mandateRevokeSchema), asyncHandler(async (req, res) => {
  if (!authorizationEnabled(req)) return featureUnavailable();
  const mandate = await revokeMandate({ mandateId: req.params.mandateId, userId: req.user.userId, reason: req.body.reason });
  await completePlanReviewMandateAction({ userId: req.user.userId, runId: mandate.runId, mandateId: mandate.mandateId, outcome: 'REVOKED' });
  await appendAuthorizationEvent({ runId: mandate.runId, userId: req.user.userId, eventType: 'MANDATE_REVOKED', data: { mandateId: mandate.mandateId, action: mandate.action } });
  return res.json(mandate);
}));

router.post('/mandates/:mandateId/execute', verifyJWT, asyncHandler(async (req, res) => {
  if (!authorizationEnabled(req)) return featureUnavailable();
  if (Object.keys(req.body || {}).length !== 0) throw createError(400, 'Execution accepts no model-controlled parameters.', 'Execution payload must be empty.');
  const startedAt = Date.now();
  try {
    const result = await createAuthorizedActionExecutor({ runtimeConfig: authorizationConfig(req) }).execute({ mandateId: req.params.mandateId, userId: req.user.userId, correlationId: req.correlationId });
    const runId = result.receipt?.runId;
    if (runId) {
      await completePlanReviewMandateAction({ userId: req.user.userId, runId, mandateId: req.params.mandateId, outcome: 'EXECUTED' })
        .catch(error => logger.error('PlanReview action lifecycle reconciliation failed after committed authorized execution.', { code: error.code || 'LIFECYCLE_UPDATE_FAILED' }));
    }
    return res.json({ receipt: result.receipt, response: result.response });
  } finally {
    PrometheusMetrics.recordAuthorizationLatency(Date.now() - startedAt);
  }
}));

router.get('/receipts/:receiptId', verifyJWT, asyncHandler(async (req, res) => {
  if (!authorizationEnabled(req)) return featureUnavailable();
  const receipt = await ExecutionReceipt.findOne({ receiptId: req.params.receiptId, userId: req.user.userId }).lean();
  if (!receipt) throw createError(404, 'Execution receipt not found or access denied.', 'Execution receipt not found.');
  return res.json(receipt);
}));

router.get('/receipts/:receiptId/verify', verifyJWT, asyncHandler(async (req, res) => {
  if (!authorizationEnabled(req)) return featureUnavailable();
  const result = await verifyExecutionReceiptForUser({
    receiptId: req.params.receiptId,
    userId: req.user.userId,
    runtimeConfig: authorizationConfig(req),
  });
  if (result.reason === 'RECEIPT_NOT_FOUND') throw createError(404, 'Execution receipt not found or access denied.', 'Execution receipt not found.');
  return res.json(result);
}));

router.get('/plan-health', verifyJWT, validateQuery(agentProfileQuerySchema), asyncHandler(async (req, res) => {
  if (!isEnabled(req)) return featureUnavailable();
  const result = await inspectPlanHealth({ userId: req.user.userId, profileId: req.query.profileId });
  return res.json(result);
}));

router.get('/plan-health/events', verifyJWT, validateQuery(planHealthEventsQuerySchema), asyncHandler(async (req, res) => {
  if (!isEnabled(req)) return featureUnavailable();
  const events = await listPlanHealthEvents({ userId: req.user.userId, limit: req.query.limit });
  return res.json({ events });
}));

router.patch('/plan-health/events/:eventId/acknowledge', verifyJWT, asyncHandler(async (req, res) => {
  if (!isEnabled(req)) return featureUnavailable();
  if (!/^[0-9a-f]{24}$/i.test(req.params.eventId)) throw createError(400, 'Invalid health event ID.', 'Invalid health event ID.');
  const event = await acknowledgePlanHealthEvent({ userId: req.user.userId, eventId: req.params.eventId });
  if (!event) throw createError(404, 'Plan health event not found.', 'Plan health event not found.');
  return res.json(event);
}));

export default router;
