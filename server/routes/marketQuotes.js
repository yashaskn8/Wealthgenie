import { Router } from 'express';
import { verifyJWT } from '../middleware/authMiddleware.js';
import { asyncHandler, sendError } from '../middleware/errorHandler.js';
import { createEndpointRateLimiter, ipKeyGenerator } from '../middleware/rateLimiter.js';
import { createUpstoxPublicDataGate } from '../middleware/upstoxPublicDataGate.js';
import { fetchPrivateMarketDemoData, fetchUpstoxCanonicalQuotes } from '../services/marketDataService.js';
import { createPrivateMarketDataDemoCapability } from '../services/marketData/marketDataRights.js';
import { readStoredBenchmarkQuotes } from '../services/marketData/StoredBenchmarkQuoteStore.js';
import {
  resolveUpstoxProductQuoteIdentities,
  resolveUpstoxQuoteIdentities,
} from '../services/marketData/upstoxInstrumentRegistry.js';
import { validateQuery, marketQuoteQuerySchema } from '../validation/schemas.js';

export function createMarketQuotesRouter({
  fetchQuotes = fetchUpstoxCanonicalQuotes,
  fetchPrivateDemo = fetchPrivateMarketDemoData,
  readStoredQuotes = readStoredBenchmarkQuotes,
  verifySession = verifyJWT,
  createDemoCapability = createPrivateMarketDataDemoCapability,
  privateDemoLimiter: injectedPrivateDemoLimiter = null,
  env = process.env,
  marketDataTestFixtureRightsCapability = null,
  limiter = createEndpointRateLimiter({
    windowMs: 60 * 1000,
    max: 20,
    message: 'Market quote requests are limited to protect the shared provider budget.',
    prefix: 'rl:market-quotes:',
    keyGenerator: req => ipKeyGenerator(req.ip || req.socket?.remoteAddress || 'unknown'),
  }),
} = {}) {
  const router = Router();
  const privateDemoLimiter = injectedPrivateDemoLimiter || createEndpointRateLimiter({
    windowMs: 60 * 1000,
    max: 3,
    message: 'Private demo refreshes are limited to protect provider request budgets.',
    prefix: 'rl:market-data-private-demo:',
    keyGenerator: req => `user:${req.user?.userId || ipKeyGenerator(req.ip || req.socket?.remoteAddress || 'unknown')}`,
  });

  router.get('/private-demo', verifySession, privateDemoLimiter, validateQuery(marketQuoteQuerySchema), asyncHandler(async (req, res) => {
    const privateDemoCapability = createDemoCapability(req, env);
    if (!privateDemoCapability) {
      return sendError(req, res, 404, 'The authenticated private market demo is not enabled on this local development server.', 'PRIVATE_MARKET_DEMO_UNAVAILABLE');
    }
    const canonicalProductIds = req.query.ids.split(',');
    try {
      resolveUpstoxProductQuoteIdentities(canonicalProductIds);
    } catch (error) {
      if (error?.code === 'UNSUPPORTED_MARKET_INSTRUMENT') {
        return sendError(req, res, 400, error.message, error.code);
      }
      if (error instanceof RangeError || error instanceof TypeError) {
        return sendError(req, res, 400, 'Market quote request is invalid.', 'INVALID_MARKET_QUOTE_REQUEST');
      }
      throw error;
    }
    res.set('Cache-Control', 'no-store, private, max-age=0');
    res.set('Pragma', 'no-cache');
    const data = await fetchPrivateDemo({ env, privateDemoCapability, canonicalProductIds });
    return res.json(data);
  }));

  router.get('/quotes/persisted', verifySession, limiter, asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    if (Object.keys(req.query).length) {
      return sendError(req, res, 400, 'Stored benchmark quotes do not accept query parameters.',
        'INVALID_STORED_MARKET_QUOTE_REQUEST');
    }
    try {
      return res.json(await readStoredQuotes({ env }));
    } catch {
      return sendError(req, res, 503, 'Stored benchmark quotes are temporarily unavailable.',
        'STORED_MARKET_QUOTES_UNAVAILABLE');
    }
  }));

  router.get(
    '/quotes',
    createUpstoxPublicDataGate({
      env,
      requiresUpstox: true,
      marketDataTestFixtureRightsCapability,
    }),
    limiter,
    validateQuery(marketQuoteQuerySchema),
    asyncHandler(async (req, res) => {
      try {
        const canonicalProductIds = req.query.ids.split(',');
        resolveUpstoxQuoteIdentities(canonicalProductIds);
        return res.json(await fetchQuotes(canonicalProductIds, {
          env,
          marketDataTestFixtureRightsCapability,
        }));
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
