import { Router } from 'express';
import { verifyJWT, requireRole } from '../middleware/authMiddleware.js';
import { asyncHandler, sendError } from '../middleware/errorHandler.js';
import { createEndpointRateLimiter, ipKeyGenerator } from '../middleware/rateLimiter.js';
import {
  AMFI_REFRESH_LOCK_TTL_SECONDS,
  collectAmfiPersistenceFailures,
  withMarketRefreshLease,
} from '../jobs/marketDataRefresh.js';
import { validateQuery, marketNavQuerySchema } from '../validation/schemas.js';
import {
  fetchAmfiProductSnapshot,
  fetchAmfiHistoricalNavSnapshot,
  fetchBenchmarkQuotes,
  fetchGovernmentSavingsSnapshot,
  fetchSbiTermDepositSnapshot,
  getInstrumentModelAssumptions,
  getMarketDataSummary,
  getMutualFundNavsBySchemeCodes,
  PRIMARY_MARKET_PROVIDER,
  isUpstoxOnlyMarketDataMode,
} from '../services/marketDataService.js';
import { getLiveMarketContext } from '../services/marketContextService.js';

const router = Router();

const marketRefreshLimiter = createEndpointRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 2,
  message: 'Market refresh is limited to a small number of administrative operations.',
  prefix: 'rl:market-refresh:',
  keyGenerator: req => `user:${req.user?.userId || ipKeyGenerator(req.ip)}`,
});

export function respondToManualMarketRefresh(req, res, refreshResult) {
  const amfiPersistenceFailures = collectAmfiPersistenceFailures(
    refreshResult[0]?.status === 'fulfilled' ? refreshResult[0].value : null,
    refreshResult[1]?.status === 'fulfilled' ? refreshResult[1].value : null,
  );
  if (amfiPersistenceFailures.length > 0) {
    return sendError(
      req,
      res,
      503,
      'AMFI data was fetched but could not be durably persisted.',
      'MARKET_PERSISTENCE_FAILED',
      { persistenceFailures: amfiPersistenceFailures },
    );
  }

  const sourceRightsBlocked = refreshResult.some(result => {
    if (result.status !== 'fulfilled') return false;
    const value = result.value;
    return value?.error?.code === 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED'
      || value?.reasonCodes?.includes('MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED')
      || value?.marketSnapshot?.policyOutput?.reasonCodes?.includes('MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED');
  });
  if (sourceRightsBlocked) {
    return sendError(
      req,
      res,
      503,
      'Market refresh is unavailable because production source-use permission is not qualified.',
      'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED',
    );
  }

  return res.status(202).json({
    status: 'REFRESH_COMPLETED',
    sources: ['AMFI_CURRENT_NAV', 'AMFI_HISTORICAL_NAV', 'GOVERNMENT_SMALL_SAVINGS', 'SBI_TERM_DEPOSITS',
      `${isUpstoxOnlyMarketDataMode() ? 'UPSTOX' : PRIMARY_MARKET_PROVIDER}_MARKET_CONTEXT`],
    results: refreshResult.map(result => result.status),
    message: 'A bounded administrative refresh completed. Provider failures remain explicitly unavailable.',
  });
}

/** Public source-health and provenance summary. No assumption is labelled live. */
router.get('/rates', asyncHandler(async (_req, res) => {
  res.json(await getMarketDataSummary());
}));

/** Bounded benchmark snapshot: NIFTY 50 and India VIX only. */
router.get('/benchmarks', asyncHandler(async (_req, res) => {
  res.json(await fetchBenchmarkQuotes());
}));

/**
 * Bounded AMFI lookup. The full official report is fetched at most once per
 * cache window, while the response includes only explicitly requested schemes.
 */
router.get('/mutual-funds/nav', validateQuery(marketNavQuerySchema), asyncHandler(async (req, res) => {
  const schemeCodes = req.query.schemeCodes.split(',');
  res.json(await getMutualFundNavsBySchemeCodes(schemeCodes));
}));

/** Official quarterly India Post small-savings facts. */
router.get('/government-schemes', asyncHandler(async (_req, res) => {
  res.json(await fetchGovernmentSavingsSnapshot());
}));

/** Qualified SBI retail domestic term-deposit card rates only. */
router.get('/fixed-deposits/sbi', asyncHandler(async (_req, res) => {
  res.json(await fetchSbiTermDepositSnapshot());
}));

/**
 * Legacy simulation assumptions endpoint. Values are explicitly classified as
 * model assumptions, not live market observations.
 */
router.get('/params', asyncHandler(async (_req, res) => {
  res.json(await getInstrumentModelAssumptions());
}));

/** Refreshes the bounded official source snapshots without widening scope. */
router.post('/refresh', verifyJWT, requireRole('admin'), marketRefreshLimiter, asyncHandler(async (req, res) => {
  const refreshResult = await withMarketRefreshLease('Manual Market Refresh', async () => Promise.allSettled([
    fetchAmfiProductSnapshot({ forceRefresh: true }),
    fetchAmfiHistoricalNavSnapshot({ forceRefresh: true }),
    fetchGovernmentSavingsSnapshot({ forceRefresh: true }),
    fetchSbiTermDepositSnapshot({ forceRefresh: true }),
    getLiveMarketContext({ forceQuoteRefresh: true, forceHistoryRefresh: true }),
  ]), { ttlSeconds: AMFI_REFRESH_LOCK_TTL_SECONDS });

  if (refreshResult === null) {
    const status = process.env.NODE_ENV === 'production' ? 503 : 409;
    return sendError(req, res, status, 'Another refresh is active or distributed refresh coordination is unavailable.', 'MARKET_REFRESH_LEASE_UNAVAILABLE', {
      status: 'REFRESH_UNAVAILABLE',
    });
  }

  return respondToManualMarketRefresh(req, res, refreshResult);
}));

export default router;
