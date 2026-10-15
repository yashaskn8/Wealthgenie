import axios from 'axios';
import { createMarketDataTestFixtureRightsCapability } from './marketDataTestFixtures.js';

export default class MarketDataProvider {
  constructor(options = {}) {
    const {
      providerName,
      httpClient = axios,
      clock = () => new Date(),
      env = process.env,
    } = options;
    if (!providerName) throw new TypeError('providerName is required.');
    this.providerName = providerName;
    this.httpClient = httpClient;
    this.clock = clock;
    this.env = env;
    const injectedTransport = Object.hasOwn(options, 'httpClient') ? options.httpClient : null;
    this.marketDataTestFixtureRightsCapability = injectedTransport
      ? createMarketDataTestFixtureRightsCapability({ env, transport: this.httpClient })
      : null;
  }

  nowIso() {
    return this.clock().toISOString();
  }
}
