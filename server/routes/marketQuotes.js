import { Router } from 'express';
import { asyncHandler, sendError } from '../middleware/errorHandler.js';
import { createEndpointRateLimiter, ipKeyGenerator } from '../middleware/rateLimiter.js';
import { createUpstoxPublicDataGate } from '../middleware/upstoxPublicDataGate.js';
import { fetchUpstoxCanonicalQuotes } from '../services/marketDataService.js';
import { resolveUpstoxQuoteIdentities } from '../services/marketData/upstoxInstrumentRegistry.js';
import { validateQuery, marketQuoteQuerySchema } from '../validation/schemas.js';

export function createMarketQuotesRouter({
  fetchQuotes = fetchUpstoxCanonicalQuotes,
  env = process.env,
  limiter = createEndpointRateLimiter({
    windowMs: 60 * 1000,
    max: 20,
    message: 'Market quote requests are limited to protect the shared provider budget.',
    prefix: 'rl:market-quotes:',
    keyGenerator: req => ipKeyGenerator(req.ip || req.socket?.remoteAddress || 'unknown'),
  }),
} = {}) {
  const router = Router();
  router.get(
    '/quotes',
    createUpstoxPublicDataGate({ env, requiresUpstox: true }),
    limiter,
    validateQuery(marketQuoteQuerySchema),
    asyncHandler(async (req, res) => {
      try {
        const canonicalProductIds = req.query.ids.split(',');
        resolveUpstoxQuoteIdentities(canonicalProductIds);
        return res.json(await fetchQuotes(canonicalProductIds));
      } catch (error) {
        if (error?.code === 'UNSUPPORTED_MARKET_INSTRUMENT') {
          return sendError(req, res, 400, error.message, error.code);
        }
        if (error instanceof RangeError || error instanceof TypeError) {
          return sendError(req, res, 400, 'Market quote request is invalid.', 'INVALID_MARKET_QUOTE_REQUEST');
        }
        throw error;
      }
    }),
  );
  return router;
}

export default createMarketQuotesRouter();
