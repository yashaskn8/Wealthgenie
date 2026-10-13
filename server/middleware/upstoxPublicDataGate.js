import { sendError } from './errorHandler.js';

/**
 * Public Upstox-derived output is blocked in production until an operator has
 * separately verified the applicable distribution rights. Local development
 * remains available for fixture and personal testing.
 */
export function createUpstoxPublicDataGate({ env = process.env, requiresUpstox = false } = {}) {
  return function upstoxPublicDataGate(req, res, next) {
    const primaryProvider = String(env.MARKET_DATA_PRIMARY_PROVIDER || 'NSE').trim().toUpperCase();
    const usesUpstox = requiresUpstox || primaryProvider === 'UPSTOX';
    const distributionConfirmed = env.UPSTOX_PUBLIC_MARKET_DATA_LICENSE_CONFIRMED === 'true';
    if (env.NODE_ENV === 'production' && usesUpstox && !distributionConfirmed) {
      return sendError(
        req,
        res,
        503,
        'Upstox market-data output is disabled until public distribution permission is verified.',
        'UPSTOX_PUBLIC_DISTRIBUTION_DISABLED',
      );
    }
    return next();
  };
}
