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
export const MARKET_DATA_PRIVATE_DEMO_ENV = 'MARKET_DATA_PRIVATE_DEMO_ENABLED';
const privateDemoCapabilities = new WeakSet();

function isLoopbackAddress(value) {
  const address = String(value || '').trim().toLowerCase().replace(/^::ffff:/, '');
  return address === '127.0.0.1' || address === '::1' || address === 'localhost';
}

// Browsers may connect from the local Vite origin on a different port.
// A non-local Origin must never receive private, non-redistributable evidence.
function isTrustedPrivateDemoOrigin(origin) {
  if (origin === undefined) return true; // Ordinary same-origin GETs omit Origin.
  if (typeof origin !== 'string') return false;
  try {
    const url = new URL(origin);
    return ['http:', 'https:'].includes(url.protocol)
      && url.origin === origin
      && isLoopbackAddress(url.hostname.replace(/^\[|\]$/g, ''));
  } catch {
    return false;
  }
}

/**
 * Mint a per-request capability only after the authenticated local demo route
 * has confirmed development mode, explicit operator opt-in, and loopback I/O.
 * It is deliberately distinct from the test-fixture capability.
 */
export function createPrivateMarketDataDemoCapability(req, env = process.env) {
  const host = String(req?.get?.('host') || req?.headers?.host || '').trim().toLowerCase();
  const hostName = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0];
  const remoteAddress = req?.socket?.remoteAddress || req?.connection?.remoteAddress;
  if (env?.NODE_ENV !== 'development'
      || env?.CI === 'true'
      || env?.GITHUB_ACTIONS === 'true'
      || env?.[MARKET_DATA_PRIVATE_DEMO_ENV] !== 'true'
      || !req?.user?.userId
      || !isLoopbackAddress(remoteAddress)
      || !isLoopbackAddress(hostName)
      || !isTrustedPrivateDemoOrigin(req?.headers?.origin)) return null;
  const capability = Object.freeze({});
  privateDemoCapabilities.add(capability);
  return capability;
}

export function isMarketDataPrivateDemoUseAllowed(provider, url, env = process.env, capability = null) {
  if (!capability || !privateDemoCapabilities.has(capability)
      || env?.NODE_ENV !== 'development'
      || env?.[MARKET_DATA_PRIVATE_DEMO_ENV] !== 'true') return false;
  const decision = resolveSourceRights({ provider, url });
  if (!decision.sourceId) return false;
  if (provider === 'UPSTOX') {
    return decision.status === POST_TAX_SOURCE_RIGHTS_STATES.DEVELOPMENT_RESEARCH_ONLY
      && decision.approvedScopes?.includes('PRIVATE_LOCAL_EDUCATIONAL_DEMO') === true
      && decision.sourceId === 'UPSTOX_QUOTES_V3';
  }
  // Operator flags cannot establish provider rights. TejHQ remains blocked
  // until its exact source record explicitly grants this private-demo scope.
  return provider === 'TEJHQ'
    && decision.status === POST_TAX_SOURCE_RIGHTS_STATES.DEVELOPMENT_RESEARCH_ONLY
    && decision.approvedScopes?.includes('PRIVATE_LOCAL_EDUCATIONAL_DEMO') === true
    && ['TEJHQ_RAW_EOD', 'TEJHQ_ADJUSTED_HISTORY', 'TEJHQ_SYMBOL_HISTORY',
      'TEJHQ_CORPORATE_ACTIONS', 'TEJHQ_PUBLICATION_STATUS'].includes(decision.sourceId);
}

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
