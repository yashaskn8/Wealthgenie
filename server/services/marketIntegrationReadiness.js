import { evaluateMarketDataProductionRights } from './marketData/marketDataRights.js';
import { hasUpstoxAccessToken } from './marketData/upstoxCredentials.js';

import {
  UPSTOX_QUOTE_RIGHTS_URL,
  UPSTOX_HISTORICAL_CANDLE_V3_RIGHTS_URL,
  UPSTOX_TRADING_HOLIDAYS_URL,
  UPSTOX_NSE_MARKET_STATUS_URL,
  UPSTOX_MARKET_TIMINGS_RIGHTS_URL,
  TEJHQ_RAW_EOD_RIGHTS_URL,
  TEJHQ_ADJUSTED_RIGHTS_URL,
  TEJHQ_SYMBOL_HISTORY_RIGHTS_URL,
  TEJHQ_CORPORATE_ACTIONS_RIGHTS_URL,
  TEJHQ_PUBLICATION_STATUS_RIGHTS_URL,
} from './marketData/marketDataSourceUrls.js';

const UPSTOX_SOURCES = Object.freeze([
  ['quotes', UPSTOX_QUOTE_RIGHTS_URL],
  ['dailyHistory', UPSTOX_HISTORICAL_CANDLE_V3_RIGHTS_URL],
  ['holidays', UPSTOX_TRADING_HOLIDAYS_URL],
  ['exchangeStatus', UPSTOX_NSE_MARKET_STATUS_URL],
  ['sessionTimings', UPSTOX_MARKET_TIMINGS_RIGHTS_URL],
]);
const TEJHQ_SOURCES = Object.freeze([
  ['rawDailyHistory', TEJHQ_RAW_EOD_RIGHTS_URL],
  ['adjustedHistory', TEJHQ_ADJUSTED_RIGHTS_URL],
  ['symbolHistory', TEJHQ_SYMBOL_HISTORY_RIGHTS_URL],
  ['corporateActions', TEJHQ_CORPORATE_ACTIONS_RIGHTS_URL],
  ['publicationStatus', TEJHQ_PUBLICATION_STATUS_RIGHTS_URL],
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
  const selected = mode === 'UPSTOX_TEJHQ';
  const upstoxRights = rightsFor('UPSTOX', UPSTOX_SOURCES);
  const tejHqRights = rightsFor('TEJHQ', TEJHQ_SOURCES);
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
  const tejHqEnabled = String(env.TEJHQ_ENABLED).toLowerCase() === 'true';
  const tejHqLicenseFlag = String(env.TEJHQ_LICENSE_CONFIRMED).toLowerCase() === 'true';
  const tejHqKeyConfigured = Boolean(String(env.TEJHQ_API_KEY || '').trim());
  const tejHqFallbackEnabled = env.TEJHQ_HISTORICAL_FALLBACK_ENABLED === 'true';
  // Only capabilities required by the raw EOD fallback are hard prerequisites.
  // Adjusted history and corporate actions are separately licensed features.
  const tejHqRightsQualified = [
    'rawDailyHistory', 'symbolHistory', 'publicationStatus',
  ].every(capability => tejHqRights[capability].productionUseAllowed);
  const tejHqBlockers = [
    ...(!tejHqEnabled ? ['TEJHQ_DISABLED'] : []),
    ...(!tejHqLicenseFlag ? ['TEJHQ_LICENSE_FLAG_DISABLED'] : []),
    ...(!tejHqFallbackEnabled ? ['TEJHQ_HISTORICAL_FALLBACK_DISABLED'] : []),
    ...(!tejHqKeyConfigured ? ['TEJHQ_KEY_NOT_CONFIGURED'] : []),
    ...(!tejHqRightsQualified ? ['MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED'] : []),
  ];
  const blockers = [
    ...(!selected ? ['UPSTOX_TEJHQ_MODE_NOT_SELECTED'] : []),
    ...upstoxBlockers,
  ];
  return {
    schemaVersion: 'market-integration-readiness-1.0.0',
    mode,
    primaryProvider: selected ? 'UPSTOX' : primary,
    status: blockers.length ? 'BLOCKED' : 'PREREQUISITES_CONFIGURED_NOT_LIVE_VERIFIED',
    liveProviderAccess: 'NOT_VERIFIED',
    providerEntitlements: 'NOT_VERIFIED',
    publicDistributionRights: 'NOT_VERIFIED_BY_LIVE_REQUEST',
    marketContext: {
      selectedProvider: selected ? 'UPSTOX' : primary,
      prerequisitesSatisfied: selected && upstoxBlockers.length === 0,
      blockers: [...new Set(blockers)],
      tokenConfigured,
      publicDistributionFlagEnabled: publicDistributionEnabled,
      exactSourceRights: upstoxRights,
    },
    equityHistoryFallback: {
      provider: 'TEJHQ',
      enabled: tejHqEnabled,
      licenseFlagEnabled: tejHqLicenseFlag,
      historicalFallbackFlagEnabled: tejHqFallbackEnabled,
      keyConfigured: tejHqKeyConfigured,
      prerequisitesSatisfied: tejHqBlockers.length === 0,
      blockers: [...new Set(tejHqBlockers)],
      exactSourceRights: tejHqRights,
    },
    diagnosticOnly: true,
  };
}
