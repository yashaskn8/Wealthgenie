import { Router } from 'express';
import { verifyJWT, requireRole } from '../middleware/authMiddleware.js';
import { asyncHandler, sendError } from '../middleware/errorHandler.js';
import { createEndpointRateLimiter, ipKeyGenerator } from '../middleware/rateLimiter.js';
import { validateQuery, marketEquityHistoryQuerySchema, marketEquityIdentityQuerySchema } from '../validation/schemas.js';
import { getMarketIntegrationReadiness } from '../services/marketIntegrationReadiness.js';
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
  getReadiness = getMarketIntegrationReadiness,
  env = process.env,
  authenticate = verifyJWT,
  authorizeAdmin = requireRole('admin'),
  limiter = createAdminRateLimiter(),
} = {}) {
  const router = Router();

  // Requires live user-role lookup through authorizeAdmin; no credentials or
  // network calls are performed by the diagnostic itself.
  router.get('/admin/diagnostics', authenticate, authorizeAdmin, limiter, (_req, res) => {
    res.json(getReadiness(env));
  });

  router.get('/admin/equity-history', authenticate, authorizeAdmin, limiter, validateQuery(marketEquityHistoryQuerySchema), asyncHandler(async (req, res) => {
    try {
      const result = await fetchHistory(req.query);
      return res.json(result);
    } catch (error) {
      return handleInvalidRequest(req, res, error);
    }
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
