import axios from 'axios';

const TEST_FIXTURE_RIGHTS_CAPABILITY = Symbol('market-data-test-fixture-rights-capability');

export function createMarketDataTestFixtureRightsCapability({ env = process.env, transport } = {}) {
  const nodeEnv = String(env?.NODE_ENV || '').trim().toLowerCase();
  if (nodeEnv !== 'test' || !transport || transport === axios || typeof transport.get !== 'function') return null;
  return Object.freeze({ [TEST_FIXTURE_RIGHTS_CAPABILITY]: true });
}

export function hasMarketDataTestFixtureRightsCapability(capability, env = process.env) {
  return String(env?.NODE_ENV || '').trim().toLowerCase() === 'test'
    && capability?.[TEST_FIXTURE_RIGHTS_CAPABILITY] === true;
}
