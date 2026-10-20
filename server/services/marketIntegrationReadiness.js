import { evaluateMarketDataProductionRights } from './marketData/marketDataRights.js';
import { hasUpstoxAccessToken } from './marketData/upstoxCredentials.js';

import {
  UPSTOX_QUOTE_RIGHTS_URL,
  UPSTOX_HISTORICAL_CANDLE_V3_RIGHTS_URL,
  UPSTOX_TRADING_HOLIDAYS_URL,
  UPSTOX_NSE_MARKET_STATUS_URL,
  UPSTOX_MARKET_TIMINGS_RIGHTS_URL,
} from './marketData/marketDataSourceUrls.js';

const UPSTOX_SOURCES = Object.freeze([
  ['quotes', UPSTOX_QUOTE_RIGHTS_URL],
  ['dailyHistory', UPSTOX_HISTORICAL_CANDLE_V3_RIGHTS_URL],
  ['holidays', UPSTOX_TRADING_HOLIDAYS_URL],
  ['exchangeStatus', UPSTOX_NSE_MARKET_STATUS_URL],
  ['sessionTimings', UPSTOX_MARKET_TIMINGS_RIGHTS_URL],
]);
function rightsFor(provider, sources) {
  return Object.fromEntries(sources.map(([capability, url]) => {
    const rights = evaluateMarketDataProductionRights(provider, url);
    // Never echo runtime credentials, full request URLs, or a provider response.
    return [capability, {
      sourceId: rights.sourceId,
      status: rights.status,
      productionUseAllowed: rights.productionUseAllowed,
    }];
  }));
}

/**
 * An admin-only, zero-network diagnostic of *preconditions*, not a claim of
 * working live market integration. A configured token cannot grant data rights.
 */
export function getMarketIntegrationReadiness(env = process.env) {
  const mode = String(env.MARKET_DATA_MODE || 'LEGACY').trim().toUpperCase();
  const primary = String(env.MARKET_DATA_PRIMARY_PROVIDER || 'NSE').trim().toUpperCase();
  const selected = mode === 'UPSTOX_ONLY';
  const upstoxRights = rightsFor('UPSTOX', UPSTOX_SOURCES);
  const tokenConfigured = hasUpstoxAccessToken(env);
  // This report audits *production* prerequisites, even when invoked from a
  // local developer process. Development's in-process distribution exception
  // is not proof of a production/public display license.
  const publicDistributionEnabled = env.UPSTOX_PUBLIC_MARKET_DATA_LICENSE_CONFIRMED === 'true';
  const upstoxRightsQualified = Object.values(upstoxRights).every(source => source.productionUseAllowed);
  const upstoxBlockers = [
    ...(!tokenConfigured ? ['UPSTOX_TOKEN_NOT_CONFIGURED'] : []),
    ...(!publicDistributionEnabled ? ['UPSTOX_PUBLIC_DISTRIBUTION_DISABLED'] : []),
    ...(!upstoxRightsQualified ? ['MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED'] : []),
  ];
  const marketContextBlockers = [
    ...(!selected ? ['UPSTOX_ONLY_MODE_NOT_SELECTED'] : []),
    ...upstoxBlockers,
  ];
  const blockers = [
    ...marketContextBlockers,
  ];
  return {
    schemaVersion: 'market-integration-readiness-1.0.0',
    mode,
    primaryProvider: selected ? 'UPSTOX' : primary,
    status: blockers.length ? 'BLOCKED' : 'PREREQUISITES_CONFIGURED_NOT_LIVE_VERIFIED',
    blockers: [...new Set(blockers)],
    liveProviderAccess: 'NOT_VERIFIED',
    providerEntitlements: 'NOT_VERIFIED',
    publicDistributionRights: 'NOT_VERIFIED_BY_LIVE_REQUEST',
    marketContext: {
      selectedProvider: selected ? 'UPSTOX' : primary,
      prerequisitesSatisfied: marketContextBlockers.length === 0,
      blockers: [...new Set(marketContextBlockers)],
      tokenConfigured,
      publicDistributionFlagEnabled: publicDistributionEnabled,
      exactSourceRights: upstoxRights,
    },
    diagnosticOnly: true,
  };
}
