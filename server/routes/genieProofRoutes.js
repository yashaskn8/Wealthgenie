import { Router } from 'express';
import { asyncHandler, createError } from '../middleware/errorHandler.js';
import { verifyJWT } from '../middleware/authMiddleware.js';
import { validateStrict } from '../validation/financialSchemas.js';
import { createEndpointRateLimiter, ipKeyGenerator } from '../middleware/rateLimiter.js';
import { extractGenieProofClaims } from '../agents/genieProof/genieProofCore.js';
import { genieProofCreateCaseSchema, genieProofExtractSchema } from '../agents/genieProof/genieProofSchemas.js';
import {
  createGenieProofCase,
  deleteGenieProofCase,
  getGenieProofCase,
  listGenieProofCases,
  verifyGenieProofCase,
} from '../agents/genieProof/genieProofService.js';

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

function requireEnabled(req) {
  if (req.app.locals.genieProofRuntime?.enabled !== true) {
    throw createError(404, 'GenieProof is unavailable.', 'GenieProof is not available.', { code: 'FEATURE_UNAVAILABLE' });
  }
}

function caseIdParam(req) {
  if (!UUID_V4.test(req.params.caseId || '')) {
    throw createError(400, 'Invalid GenieProof case ID.', 'Invalid case ID.', { code: 'GENIEPROOF_CASE_ID_INVALID' });
  }
}

function rejectQueryParameters(req, _res, next) {
  if (Object.keys(req.query || {}).length > 0) {
    return next(createError(400, 'GenieProof does not accept query parameters on this route.', 'Invalid query parameters.', { code: 'VALIDATION_ERROR' }));
  }
  return next();
}

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
    confirmedClaims: req.body.confirmedClaims,
    idempotencyKey,
    signer: req.app.locals.genieProofRuntime.signer,
  });
  return res.status(result.created ? 201 : 200).json(result);
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
  });
  if (!result) throw createError(404, 'GenieProof case not found.', 'Case not found.', { code: 'GENIEPROOF_CASE_NOT_FOUND' });
  return res.json(result);
}));

router.get('/cases/:caseId', verifyJWT, genieProofLimiter, asyncHandler(async (req, res) => {
  requireEnabled(req);
  caseIdParam(req);
  const result = await getGenieProofCase({ userId: req.user.userId, caseId: req.params.caseId });
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
