import { Router } from 'express';
import { verifyJWT } from '../middleware/authMiddleware.js';
import { asyncHandler, sendError } from '../middleware/errorHandler.js';
import { createEndpointRateLimiter, ipKeyGenerator } from '../middleware/rateLimiter.js';
import {
  isPrivateMarketDemoConfigured,
  isPrivateMarketDemoLoopback,
  readPrivateMarketDemo,
} from '../services/marketData/privateMarketDemoService.js';

export function createPrivateMarketDemoRouter({
  env = process.env,
  readSnapshot = options => readPrivateMarketDemo(options),
  authenticate = verifyJWT,
  limiter = createEndpointRateLimiter({
    windowMs: 60_000, max: 6,
    prefix: 'rl:private-market-demo:',
    keyGenerator: req => 'private:' + ipKeyGenerator(req.ip || req.socket?.remoteAddress || 'unknown'),
  }),
} = {}) {
  const router = Router();

  // The socket check is intentionally based on the physical TCP peer, never
  // on X-Forwarded-For, because development proxy trust can be overridden.
  router.get('/private-demo', (req, res, next) => {
    if (!isPrivateMarketDemoConfigured(env) || !isPrivateMarketDemoLoopback(req)) {
      return sendError(req, res, 404, 'Route not found.', 'ROUTE_NOT_FOUND');
    }
    return next();
  }, authenticate, limiter, asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.set('Pragma', 'no-cache');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    const response = await readSnapshot({ env });
    return res.json(response);
  }));

  return router;
}

export default createPrivateMarketDemoRouter();
