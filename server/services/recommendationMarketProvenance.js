import { isUpstoxPublicDistributionAllowed } from './marketData/upstoxDistributionPolicy.js';
import { isTwoProviderMarketDataMode } from './marketDataService.js';
import { marketContextProviderAllowed } from './marketContextService.js';

const VERIFIED_MARKET_PROVIDERS = new Set(['NSE', 'UPSTOX']);

/**
 * Bind distribution provenance only to the provider-selection evidence that
 * accompanied this exact recommendation computation. A missing or unfamiliar
 * value stays unknown; current configuration is not a substitute.
 */
export function sourceProviderForRecommendation(marketContext) {
  const selectedProvider = marketContext?.marketSnapshot?.providerSelection?.selectedProvider;
  return VERIFIED_MARKET_PROVIDERS.has(selectedProvider) ? selectedProvider : null;
}

export function persistRecommendationMarketAdjustment(marketAdjustment, marketContext) {
  return {
    ...marketAdjustment,
    sourceProvider: sourceProviderForRecommendation(marketContext),
  };
}

function snapshotResponse(snapshot) {
  if (snapshot?.recommendation && snapshot?.completion) return snapshot.recommendation;
  return snapshot;
}

function hasAppliedMarketAdjustment(recommendation) {
  const responses = [
    snapshotResponse(recommendation?.responseSnapshot),
    snapshotResponse(recommendation?.response),
  ].filter(Boolean);
  const auditOutput = recommendation?.recommendations;
  const evidence = [
    recommendation?.marketAdjustment,
    ...responses.flatMap(response => [response.generation_market_adjustment, response.market_adjustment]),
    auditOutput?.marketAdjustment,
  ];
  const hasAdjustmentEvidence = evidence.some(adjustment => adjustment && typeof adjustment === 'object'
    && (adjustment.applied === true
      || adjustment.status === 'APPLIED'
      || adjustment.currentAllocationSource === 'MARKET_CONTEXT_ADJUSTED'));
  return hasAdjustmentEvidence
    || recommendation?.currentAllocationSource === 'MARKET_CONTEXT_ADJUSTED'
    || responses.some(response => response.current_allocation_source === 'MARKET_CONTEXT_ADJUSTED'
      || response.currentAllocationSource === 'MARKET_CONTEXT_ADJUSTED')
    || auditOutput?.currentAllocationSource === 'MARKET_CONTEXT_ADJUSTED'
    || auditOutput?.allocationSource === 'MARKET_CONTEXT_ADJUSTED';
}

/**
 * Refuse to serve a generation-time market tilt when its source is unknown or
 * its Upstox distribution rights have not been confirmed in production.
 */
export function assertRecommendationMarketDistributionAllowed(
  recommendation,
  { environment = process.env, isDistributionAllowed = isUpstoxPublicDistributionAllowed } = {},
) {
  if (!hasAppliedMarketAdjustment(recommendation)) return;

  const sourceProvider = recommendation?.marketAdjustment?.sourceProvider
    ?? recommendation?.recommendations?.marketAdjustment?.sourceProvider;
  if (!VERIFIED_MARKET_PROVIDERS.has(sourceProvider)) {
    const error = new Error('The recommendation market-adjustment source cannot be verified.');
    error.status = 503;
    error.code = 'MARKET_ADJUSTMENT_PROVIDER_PROVENANCE_MISSING';
    error.clientMessage = 'This recommendation is temporarily unavailable while its market-data source is verified.';
    throw error;
  }

  if (sourceProvider === 'UPSTOX' && !isDistributionAllowed(environment)) {
    const error = new Error('Public distribution of this Upstox-adjusted recommendation is not confirmed.');
    error.status = 503;
    error.code = 'UPSTOX_PUBLIC_DISTRIBUTION_NOT_CONFIRMED';
    error.clientMessage = 'This recommendation is temporarily unavailable while market-data distribution rights are verified.';
    throw error;
  }

  // A stored market tilt predates the current mode/rights decision. The
  // selected mode cannot publish a legacy NSE tilt or an Upstox tilt whose
  // exact source-use rights are still unqualified.
  if (isTwoProviderMarketDataMode(environment)
      && !marketContextProviderAllowed(sourceProvider, environment)) {
    const error = new Error('The stored market adjustment is not qualified for the selected market-data mode.');
    error.status = 503;
    error.code = 'MARKET_ADJUSTMENT_SOURCE_RIGHTS_UNVERIFIED';
    error.clientMessage = 'This recommendation is temporarily unavailable while its market-data source is verified.';
    throw error;
  }
}
