import {
  POST_TAX_SOURCE_RIGHTS_STATES,
  resolveSourceRights,
} from '../postTaxSourceRights.js';
import { AVAILABILITY, MARKET_DATA_SCHEMA_VERSION } from './contracts.js';
import { hasMarketDataTestFixtureRightsCapability } from './marketDataTestFixtures.js';

const PRODUCTION_MARKET_DATA_RIGHTS = Object.freeze([
  'access',
  'extraction',
  'derivedCalculation',
  'storage',
  'publicDisplay',
  'commercialUse',
  'redistribution',
]);

const APPROVED_RIGHTS = new Set([
  POST_TAX_SOURCE_RIGHTS_STATES.APPROVED_FOR_INTENDED_USE,
  POST_TAX_SOURCE_RIGHTS_STATES.APPROVED_LIMITED_USE,
]);

export const MARKET_DATA_QUALIFICATION_LIVE_ENV = 'MARKET_DATA_QUALIFICATION_LIVE_ENABLED';

/**
 * Evaluate the source register for production market-data display. The
 * source-rights registry's post-tax flag is deliberately not reused:
 * market-data publication requires an explicit market-data-specific scope.
 */
export function evaluateMarketDataProductionRights(provider, url) {
  const decision = resolveSourceRights({ provider, url });
  const rightsAreApproved = PRODUCTION_MARKET_DATA_RIGHTS.every(key => (
    APPROVED_RIGHTS.has(decision.rights?.[key])
  ));
  const scopeIsApproved = decision.approvedScopes?.includes(
    'PRODUCTION_MARKET_DATA_DISPLAY_AND_DERIVED_CALCULATION',
  ) === true;

  return {
    provider,
    url,
    status: decision.status,
    sourceId: decision.sourceId,
    termsUrl: decision.termsUrl,
    productionUseAllowed: rightsAreApproved && scopeIsApproved,
  };
}

export function isMarketDataRightsEnforcementRequired(env = process.env) {
  void env;
  return true;
}

export function isMarketDataProductionUseAllowed(provider, url, env = process.env, fixtureCapability = null) {
  if (hasMarketDataTestFixtureRightsCapability(fixtureCapability, env)) return true;
  return evaluateMarketDataProductionRights(provider, url).productionUseAllowed;
}

/**
 * Qualification scripts perform live provider reads. An exact production-use
 * rights record and a separate live-run opt-in are required before any source
 * request is made.
 */
export function assertMarketDataQualificationRights(endpoints, env = process.env) {
  if (env?.[MARKET_DATA_QUALIFICATION_LIVE_ENV] !== 'true') {
    const error = new Error(
      `Live provider qualification is disabled. Set ${MARKET_DATA_QUALIFICATION_LIVE_ENV}=true only after reviewing the exact source rights.`,
    );
    error.code = 'MARKET_DATA_QUALIFICATION_LIVE_DISABLED';
    throw error;
  }

  const decisions = (Array.isArray(endpoints) ? endpoints : []).map(({ provider, url }) => (
    evaluateMarketDataProductionRights(provider, url)
  ));
  if (decisions.length === 0 || decisions.some(decision => !decision.productionUseAllowed)) {
    const error = new Error(
      'Live provider qualification is blocked because exact production source rights are not qualified for every endpoint.',
    );
    error.code = 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED';
    throw error;
  }
  return decisions;
}

export function buildMarketDataRightsUnavailableSnapshot(provider, url, {
  now = new Date(),
  includeCandles = false,
  includeProducts = false,
} = {}) {
  const decision = evaluateMarketDataProductionRights(provider, url);
  const code = 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED';
  return {
    schemaVersion: MARKET_DATA_SCHEMA_VERSION,
    provider,
    status: AVAILABILITY.UNAVAILABLE,
    facts: [],
    ...(includeCandles ? { candles: [] } : {}),
    ...(includeProducts ? { products: [], productCount: null, availableFactCount: null } : {}),
    fetchedAt: now.toISOString(),
    cache: { hit: false, status: 'NOT_READ_SOURCE_RIGHTS_BLOCKED' },
    error: {
      code,
      message: 'Market data is unavailable because production source use is not qualified.',
    },
    reasonCodes: [code],
    sourceRights: {
      status: decision.status,
      sourceId: decision.sourceId,
      productionUseAllowed: false,
    },
  };
}
