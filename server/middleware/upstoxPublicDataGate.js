import { sendError } from './errorHandler.js';
import { isUpstoxPublicDistributionAllowed } from '../services/marketData/upstoxDistributionPolicy.js';
import { isMarketDataProductionUseAllowed } from '../services/marketData/marketDataRights.js';
import { UPSTOX_QUOTE_URL } from '../services/marketData/UpstoxMarketDataProvider.js';

/**
 * Public Upstox-derived output requires both the operator's enablement flag
 * and exact source-rights approval. The flag cannot grant the source rights.
 */
export function createUpstoxPublicDataGate({ env = process.env, requiresUpstox = false } = {}) {
  return function upstoxPublicDataGate(req, res, next) {
    const primaryProvider = String(env.MARKET_DATA_PRIMARY_PROVIDER || 'NSE').trim().toUpperCase();
    const usesUpstox = requiresUpstox || primaryProvider === 'UPSTOX';
    if (usesUpstox && !isUpstoxPublicDistributionAllowed(env)) {
      return sendError(
        req,
        res,
        503,
        'Upstox market-data output is disabled until public distribution permission is verified.',
        'UPSTOX_PUBLIC_DISTRIBUTION_DISABLED',
      );
    }
    if (usesUpstox && !isMarketDataProductionUseAllowed('UPSTOX', UPSTOX_QUOTE_URL, env)) {
      return sendError(
        req,
        res,
        503,
        'Upstox market data is unavailable because exact production source rights are not qualified.',
        'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED',
      );
    }
    return next();
  };
}
