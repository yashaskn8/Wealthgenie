import { Router } from 'express';
import { verifyJWT, requireRole } from '../middleware/authMiddleware.js';
import { asyncHandler, sendError } from '../middleware/errorHandler.js';
import { createEndpointRateLimiter, ipKeyGenerator } from '../middleware/rateLimiter.js';
import { validate, validateQuery, marketEquityHistoryQuerySchema, marketEquityIdentityQuerySchema } from '../validation/schemas.js';
import {
  persistQualifiedHistory, readQualifiedHistory,
} from '../services/marketData/QualifiedEquityHistoryStore.js';
import {
  fetchQualifiedEquityHistory,
  fetchTejHqCorporateActionEvidence,
  fetchTejHqProviderPublicationStatus,
} from '../services/marketDataService.js';

function createAdminRateLimiter() {
  return createEndpointRateLimiter({
    windowMs: 60 * 1000,
    max: 8,
    message: 'Administrative market-data reads are limited to protect provider quotas.',
    prefix: 'rl:admin-tejhq-market-data:',
    keyGenerator: req => `user:${req.user?.userId || ipKeyGenerator(req.ip || req.socket?.remoteAddress || 'unknown')}`,
  });
}

function handleInvalidRequest(req, res, error) {
  if (error instanceof TypeError || error instanceof RangeError) {
    return sendError(req, res, 400, 'Equity market-history request is invalid.', 'INVALID_EQUITY_HISTORY_REQUEST');
  }
  throw error;
}

export function createMarketDataAdminRouter({
  fetchHistory = fetchQualifiedEquityHistory,
  fetchActions = fetchTejHqCorporateActionEvidence,
  fetchStatus = fetchTejHqProviderPublicationStatus,
  persistHistory = persistQualifiedHistory,
  readStoredHistory = readQualifiedHistory,
  authenticate = verifyJWT,
  authorizeAdmin = requireRole('admin'),
  limiter = createAdminRateLimiter(),
} = {}) {
  const router = Router();

  router.get('/admin/equity-history', authenticate, authorizeAdmin, limiter, validateQuery(marketEquityHistoryQuerySchema), asyncHandler(async (req, res) => {
    try {
      const result = await fetchHistory(req.query);
      return res.json(result);
    } catch (error) {
      return handleInvalidRequest(req, res, error);
    }
  }));

  // A qualified provider fetch and an authorized durable write are two
  // separate decisions. Neither a successful GET nor an operator Boolean
  // silently inserts market history into the database.
  router.post('/admin/equity-history/ingest', authenticate, authorizeAdmin, limiter,
    validate(marketEquityHistoryQuerySchema), asyncHandler(async (req, res) => {
      let snapshot;
      try {
        snapshot = await fetchHistory(req.body);
      } catch (error) { return handleInvalidRequest(req, res, error); }
      const persistence = await persistHistory(snapshot, req.body);
      if (persistence.status !== 'PERSISTED') {
        return sendError(req, res, 503, 'Qualified market history could not be stored.',
          persistence.code || 'MARKET_HISTORY_NOT_PERSISTED');
      }
      res.set('Cache-Control', 'no-store');
      return res.status(201).json(persistence);
    }));

  // Normal authenticated users can read only already-retained, authorized
  // observations; rights are re-evaluated for each provider source on read.
  router.get('/equity-history/persisted', authenticate, limiter,
    validateQuery(marketEquityHistoryQuerySchema), asyncHandler(async (req, res) => {
      res.set('Cache-Control', 'private, no-store');
      const result = await readStoredHistory(req.query);
      return res.json(result);
    }));

  router.get('/admin/tejhq/corporate-actions', authenticate, authorizeAdmin, limiter, validateQuery(marketEquityIdentityQuerySchema), asyncHandler(async (req, res) => {
    try {
      return res.json(await fetchActions(req.query));
    } catch (error) {
      return handleInvalidRequest(req, res, error);
    }
  }));

  router.get('/admin/tejhq/status', authenticate, authorizeAdmin, limiter, asyncHandler(async (_req, res) => (
    res.json(await fetchStatus())
  )));

  return router;
}

export default createMarketDataAdminRouter();
