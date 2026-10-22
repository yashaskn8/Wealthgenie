import { Router } from 'express';
import { isIP } from 'node:net';
import { asyncHandler, createError } from '../middleware/errorHandler.js';
import { verifyJWT } from '../middleware/authMiddleware.js';
import { validateStrict } from '../validation/financialSchemas.js';
import { createEndpointRateLimiter, ipKeyGenerator } from '../middleware/rateLimiter.js';
import { extractGenieProofClaims } from '../agents/genieProof/genieProofCore.js';
import { checkGenieProofClaims } from '../agents/genieProof/genieProofCheckService.js';
import {
  genieProofConsentWithdrawalSchema,
  genieProofCreateCaseSchema,
  genieProofExtractSchema,
  genieProofReassessSchema,
  proofBreakAcknowledgeSchema,
  proofBreakTimelineQuerySchema,
  proofWatchActionSchema,
  proofWatchCreateSchema,
} from '../agents/genieProof/genieProofSchemas.js';
import {
  getGenieProofCurrentEvidenceStatus,
  resolveGenieProofEvidenceForClaims,
} from '../agents/genieProof/genieProofEvidenceRegistryService.js';
import {
  createGenieProofCase,
  deleteGenieProofCase,
  getGenieProofCase,
  listGenieProofCases,
  listGenieProofRevisions,
  reassessGenieProofCase,
  verifyGenieProofCase,
  withdrawGenieProofConsent,
} from '../agents/genieProof/genieProofService.js';
import {
  acknowledgeProofBreakEvent,
  createProofWatch,
  deleteProofWatch,
  getProofWatchAvailability,
  listProofBreakEvents,
  listProofWatches,
  updateProofWatchStatus,
} from '../agents/genieProof/proofBreakService.js';

const router = Router();
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
const genieProofLimiter = createEndpointRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 8,
  message: 'GenieProof request limit reached. Try again later.',
  prefix: 'rl:ep:genieproof:',
  keyGenerator: req => req.user?.userId
    ? String(req.user.userId)
    : ipKeyGenerator(req.ip || req.socket?.remoteAddress || 'unknown'),
});
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// An authenticated capability report is the only source of truth for the UI.
// Never expose key material or infer that local signing qualifies financial evidence.
function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false;
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
  return normalized === '::1' || (isIP(normalized) === 4 && normalized.split('.')[0] === '127');
}

// Research signing must not be reachable through a LAN address or a proxy.
// Check the socket peer rather than trusting Express's proxy-aware req.ip.
export function isGenieProofLocalResearchRequest(req) {
  if (!isLoopbackAddress(req?.socket?.remoteAddress)) return false;
  if (['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip']
    .some(name => req?.headers?.[name] !== undefined)) return false;
  if (typeof req?.headers?.host !== 'string') return false;
  try {
    const hostname = new URL(`http://${req.headers.host}`).hostname.toLowerCase();
    return hostname === 'localhost' || isLoopbackAddress(hostname);
  } catch {
    return false;
  }
}

export function getGenieProofCapabilityStatus(runtime, { localResearchRequest = false } = {}) {
  const enabled = localResearchRequest && runtime?.enabled === true && runtime?.productionActivationAllowed === false;
  const safeUnavailableCodes = new Set([
    'GENIEPROOF_LOCAL_RESEARCH_ONLY',
    'GENIEPROOF_FLAG_DISABLED',
    'GENIEPROOF_SIGNING_KEYS_MISSING',
    'GENIEPROOF_SIGNING_CONFIGURATION_INVALID',
    'GENIEPROOF_LOCAL_REQUEST_REQUIRED',
  ]);
  return {
    interactiveEnabled: enabled,
    extractionPreviewEnabled: true,
    mode: enabled ? 'LOCAL_RESEARCH' : 'UNAVAILABLE',
    reasonCode: runtime?.enabled === true && !localResearchRequest
      ? 'GENIEPROOF_LOCAL_REQUEST_REQUIRED'
      : enabled
        ? 'RESEARCH_ONLY_SOURCE_RIGHTS_NOT_QUALIFIED'
        : (safeUnavailableCodes.has(runtime?.reasonCode) ? runtime.reasonCode : 'FEATURE_UNAVAILABLE'),
    productionVerified: false,
  };
}

function requireEnabled(req) {
  if (!getGenieProofCapabilityStatus(req.app.locals.genieProofRuntime, {
    localResearchRequest: isGenieProofLocalResearchRequest(req),
  }).interactiveEnabled) {
    throw createError(404, 'GenieProof is unavailable.', 'GenieProof is not available.', { code: 'FEATURE_UNAVAILABLE' });
  }
}

function caseIdParam(req) {
  if (!UUID_V4.test(req.params.caseId || '')) {
    throw createError(400, 'Invalid GenieProof case ID.', 'Invalid case ID.', { code: 'GENIEPROOF_CASE_ID_INVALID' });
  }
}

function uuidParam(value, label) {
  if (!UUID_V4.test(value || '')) {
    throw createError(400, `Invalid GenieProof ${label}.`, `Invalid ${label}.`, { code: `GENIEPROOF_${label.toUpperCase()}_INVALID` });
  }
}

function rejectQueryParameters(req, _res, next) {
  if (Object.keys(req.query || {}).length > 0) {
    return next(createError(400, 'GenieProof does not accept query parameters on this route.', 'Invalid query parameters.', { code: 'VALIDATION_ERROR' }));
  }
  return next();
}

router.get('/capabilities', verifyJWT, rejectQueryParameters, (req, res) => {
  return res.json(getGenieProofCapabilityStatus(req.app.locals.genieProofRuntime, {
    localResearchRequest: isGenieProofLocalResearchRequest(req),
  }));
});

// This route only parses user-submitted text. It NEVER uses external financial
// evidence, persists offers, checks a claim, or signs a passport. It can run
// in production even while the evidence-bound workflow remains restricted.
export function buildGenieProofClaimPreview(offerText) {
  const extraction = extractGenieProofClaims(offerText);
  if (!extraction.ok) return extraction;
  return {
    ...extraction,
    previewOnly: true,
    status: 'CANDIDATES_ONLY',
    sourceEvidenceChecked: false,
    signedPassportCreated: false,
  };
}

// Read-only by design: no case, passport, signature creation, or user-text persistence.
// Financial verdicts require independently qualified, applicable, signed evidence.
router.post('/check', verifyJWT, genieProofLimiter, validateStrict(genieProofExtractSchema), asyncHandler(async (req, res) => {
  const result = await checkGenieProofClaims({
    offerText: req.body.offerText,
    verifier: req.app.locals.genieProofClaimVerifier || null,
  });
  if (!result.ok) {
    throw createError(400, result.code, 'The statement could not be checked. Please shorten or correct it.', { code: result.code });
  }
  return res.json(result);
}));

router.post('/extract-preview', verifyJWT, genieProofLimiter, validateStrict(genieProofExtractSchema), asyncHandler(async (req, res) => {
  const result = buildGenieProofClaimPreview(req.body.offerText);
  if (!result.ok) throw createError(400, result.code, 'The offer text could not be processed.', { code: result.code });
  return res.json(result);
}));

router.post('/extract', verifyJWT, genieProofLimiter, validateStrict(genieProofExtractSchema), asyncHandler(async (req, res) => {
  requireEnabled(req);
  const result = extractGenieProofClaims(req.body.offerText);
  if (!result.ok) throw createError(400, result.code, 'The offer text could not be processed.', { code: result.code });
  return res.json(result);
}));

router.post('/cases', verifyJWT, genieProofLimiter, validateStrict(genieProofCreateCaseSchema), asyncHandler(async (req, res) => {
  requireEnabled(req);
  const idempotencyKey = req.get('Idempotency-Key');
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
    throw createError(400, 'Idempotency-Key is required for GenieProof case creation.', 'A valid request key is required.', { code: 'GENIEPROOF_IDEMPOTENCY_KEY_REQUIRED' });
  }
  const result = await createGenieProofCase({
    userId: req.user.userId,
    offerText: req.body.offerText,
    submissionHash: req.body.submissionHash,
    savingConsent: req.body.savingConsent,
    confirmedClaims: req.body.confirmedClaims,
    idempotencyKey,
    signer: req.app.locals.genieProofRuntime.signer,
    evidenceResolver: resolveGenieProofEvidenceForClaims,
  });
  return res.status(result.created ? 201 : 200).json(result);
}));

router.post('/cases/:caseId/reassess', verifyJWT, genieProofLimiter, validateStrict(genieProofReassessSchema), asyncHandler(async (req, res) => {
  requireEnabled(req);
  caseIdParam(req);
  const idempotencyKey = req.get('Idempotency-Key');
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
    throw createError(400, 'Idempotency-Key is required for GenieProof reassessment.', 'A valid request key is required.', { code: 'GENIEPROOF_IDEMPOTENCY_KEY_REQUIRED' });
  }
  const result = await reassessGenieProofCase({
    userId: req.user.userId,
    caseId: req.params.caseId,
    expectedRevision: req.body.expectedRevision,
    expectedManifestHash: req.body.expectedManifestHash,
    reassessmentConsent: req.body.reassessmentConsent,
    idempotencyKey,
    signer: req.app.locals.genieProofRuntime.signer,
    evidenceResolver: resolveGenieProofEvidenceForClaims,
  });
  return res.status(result.created ? 201 : 200).json(result);
}));

router.post('/cases/:caseId/consent/withdraw', verifyJWT, genieProofLimiter, validateStrict(genieProofConsentWithdrawalSchema), asyncHandler(async (req, res) => {
  requireEnabled(req);
  caseIdParam(req);
  const withdrawn = await withdrawGenieProofConsent({ userId: req.user.userId, caseId: req.params.caseId });
  if (!withdrawn) throw createError(404, 'GenieProof case not found.', 'Case not found.', { code: 'GENIEPROOF_CASE_NOT_FOUND' });
  return res.status(204).end();
}));

router.post('/cases/:caseId/watch', verifyJWT, genieProofLimiter, validateStrict(proofWatchCreateSchema), asyncHandler(async (req, res) => {
  requireEnabled(req);
  caseIdParam(req);
  const idempotencyKey = req.get('Idempotency-Key');
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
    throw createError(400, 'Idempotency-Key is required for ProofBreak watch creation.', 'A valid request key is required.', { code: 'GENIEPROOF_IDEMPOTENCY_KEY_REQUIRED' });
  }
  const result = await createProofWatch({
    userId: req.user.userId,
    caseId: req.params.caseId,
    watchConsent: req.body.watchConsent,
    idempotencyKey,
  });
  return res.status(result.created ? 201 : 200).json(result);
}));

router.get('/cases/:caseId/watch/availability', verifyJWT, genieProofLimiter, asyncHandler(async (req, res) => {
  requireEnabled(req);
  caseIdParam(req);
  if (Object.keys(req.query || {}).length) throw createError(400, 'ProofBreak availability does not accept query parameters.', 'Invalid query parameters.', { code: 'VALIDATION_ERROR' });
  return res.json(await getProofWatchAvailability({ userId: req.user.userId, caseId: req.params.caseId }));
}));

router.get('/watches', verifyJWT, genieProofLimiter, asyncHandler(async (req, res) => {
  requireEnabled(req);
  const { error, value } = proofBreakTimelineQuerySchema.validate({ limit: req.query.limit ?? 25, cursor: req.query.cursor }, { convert: true, abortEarly: false, allowUnknown: false });
  if (error || value.cursor) throw createError(400, 'ProofBreak watch listing accepts no cursor and a bounded limit.', 'Invalid query parameters.', { code: 'VALIDATION_ERROR' });
  const caseId = req.query.caseId;
  if (caseId !== undefined && !UUID_V4.test(caseId)) throw createError(400, 'Invalid GenieProof case ID.', 'Invalid case ID.', { code: 'GENIEPROOF_CASE_ID_INVALID' });
  const extra = Object.keys(req.query).filter(key => !['caseId', 'limit'].includes(key));
  if (extra.length) throw createError(400, 'ProofBreak watch listing received unsupported query parameters.', 'Invalid query parameters.', { code: 'VALIDATION_ERROR' });
  return res.json({ watches: await listProofWatches({ userId: req.user.userId, caseId, limit: value.limit }) });
}));

router.patch('/watches/:watchId', verifyJWT, genieProofLimiter, validateStrict(proofWatchActionSchema), asyncHandler(async (req, res) => {
  requireEnabled(req);
  uuidParam(req.params.watchId, 'watch');
  const watch = await updateProofWatchStatus({ userId: req.user.userId, watchId: req.params.watchId, action: req.body.action });
  if (!watch) throw createError(404, 'ProofBreak watch not found.', 'Watch not found.', { code: 'PROOFBREAK_WATCH_NOT_FOUND' });
  return res.json({ watch });
}));

router.delete('/watches/:watchId', verifyJWT, genieProofLimiter, asyncHandler(async (req, res) => {
  requireEnabled(req);
  uuidParam(req.params.watchId, 'watch');
  const deleted = await deleteProofWatch({ userId: req.user.userId, watchId: req.params.watchId });
  if (!deleted) throw createError(404, 'ProofBreak watch not found.', 'Watch not found.', { code: 'PROOFBREAK_WATCH_NOT_FOUND' });
  return res.status(204).end();
}));

router.get('/cases/:caseId/events', verifyJWT, genieProofLimiter, asyncHandler(async (req, res) => {
  requireEnabled(req);
  caseIdParam(req);
  const { error, value } = proofBreakTimelineQuerySchema.validate(req.query, { convert: true, abortEarly: false, allowUnknown: false });
  if (error) throw createError(400, 'Invalid ProofBreak timeline query.', 'Invalid query parameters.', { code: 'VALIDATION_ERROR' });
  return res.json(await listProofBreakEvents({ userId: req.user.userId, caseId: req.params.caseId, limit: value.limit, cursor: value.cursor || null }));
}));

router.post('/events/:eventId/acknowledge', verifyJWT, genieProofLimiter, validateStrict(proofBreakAcknowledgeSchema), asyncHandler(async (req, res) => {
  requireEnabled(req);
  uuidParam(req.params.eventId, 'event');
  const acknowledged = await acknowledgeProofBreakEvent({ userId: req.user.userId, eventId: req.params.eventId });
  if (!acknowledged) throw createError(404, 'ProofBreak event not found.', 'Event not found.', { code: 'PROOFBREAK_EVENT_NOT_FOUND' });
  return res.status(204).end();
}));

router.get('/cases', verifyJWT, genieProofLimiter, rejectQueryParameters, asyncHandler(async (req, res) => {
  requireEnabled(req);
  return res.json({ cases: await listGenieProofCases({ userId: req.user.userId }) });
}));

router.get('/cases/:caseId/verify', verifyJWT, genieProofLimiter, asyncHandler(async (req, res) => {
  requireEnabled(req);
  caseIdParam(req);
  const result = await verifyGenieProofCase({
    userId: req.user.userId,
    caseId: req.params.caseId,
    signer: req.app.locals.genieProofRuntime.signer,
    currentEvidenceStatusResolver: getGenieProofCurrentEvidenceStatus,
  });
  if (!result) throw createError(404, 'GenieProof case not found.', 'Case not found.', { code: 'GENIEPROOF_CASE_NOT_FOUND' });
  return res.json(result);
}));

router.get('/cases/:caseId/revisions', verifyJWT, genieProofLimiter, rejectQueryParameters, asyncHandler(async (req, res) => {
  requireEnabled(req);
  caseIdParam(req);
  const result = await listGenieProofRevisions({
    userId: req.user.userId,
    caseId: req.params.caseId,
    signer: req.app.locals.genieProofRuntime.signer,
    currentEvidenceStatusResolver: getGenieProofCurrentEvidenceStatus,
  });
  if (!result) throw createError(404, 'GenieProof case not found.', 'Case not found.', { code: 'GENIEPROOF_CASE_NOT_FOUND' });
  return res.json(result);
}));

router.get('/cases/:caseId', verifyJWT, genieProofLimiter, asyncHandler(async (req, res) => {
  requireEnabled(req);
  caseIdParam(req);
  const result = await getGenieProofCase({
    userId: req.user.userId,
    caseId: req.params.caseId,
    currentEvidenceStatusResolver: getGenieProofCurrentEvidenceStatus,
  });
  if (!result) throw createError(404, 'GenieProof case not found.', 'Case not found.', { code: 'GENIEPROOF_CASE_NOT_FOUND' });
  return res.json(result);
}));

router.delete('/cases/:caseId', verifyJWT, genieProofLimiter, asyncHandler(async (req, res) => {
  requireEnabled(req);
  caseIdParam(req);
  const deleted = await deleteGenieProofCase({ userId: req.user.userId, caseId: req.params.caseId });
  if (!deleted) throw createError(404, 'GenieProof case not found.', 'Case not found.', { code: 'GENIEPROOF_CASE_NOT_FOUND' });
  return res.status(204).end();
}));

export default router;
