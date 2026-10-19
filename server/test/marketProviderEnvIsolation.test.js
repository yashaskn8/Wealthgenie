import test from 'node:test';
import assert from 'node:assert/strict';
import UpstoxMarketDataProvider from '../services/marketData/UpstoxMarketDataProvider.js';
import UpstoxHistoricalCandleProvider from '../services/marketData/UpstoxHistoricalCandleProvider.js';
import UpstoxTradingCalendarProvider from '../services/marketData/UpstoxTradingCalendarProvider.js';
import TejHqHistoricalDataProvider from '../services/marketData/TejHqHistoricalDataProvider.js';

const upstoxProviders = [
  ['quote', UpstoxMarketDataProvider],
  ['historical-candle', UpstoxHistoricalCandleProvider],
  ['trading-calendar', UpstoxTradingCalendarProvider],
];

for (const [label, Provider] of upstoxProviders) {
  test(label + ': injected env selects its own token rather than the global process token', () => {
    const own = new Provider({ env: { UPSTOX_ANALYTICS_TOKEN: 'injected-private-token' } });
    assert.equal(own.accessToken, 'injected-private-token');
    const fallback = new Provider({ env: { UPSTOX_ACCESS_TOKEN: 'injected-fallback-token' } });
    assert.equal(fallback.accessToken, 'injected-fallback-token');
    const empty = new Provider({ env: {} });
    assert.equal(empty.accessToken, '');
    const explicitBlank = new Provider({
      env: { UPSTOX_ANALYTICS_TOKEN: 'should-not-be-used' },
      accessToken: '',
    });
    assert.equal(explicitBlank.accessToken, '');
  });
}

test('TejHQ injected env determines credential and explicit blank disables it', () => {
  const config = { TEJHQ_ENABLED: 'true', TEJHQ_LICENSE_CONFIRMED: 'false', TEJHQ_API_KEY: 'injected-tejhq-key' };
  assert.equal(new TejHqHistoricalDataProvider({ env: config }).apiKey, 'injected-tejhq-key');
  assert.equal(new TejHqHistoricalDataProvider({ env: {} }).apiKey, '');
  assert.equal(new TejHqHistoricalDataProvider({ env: config, apiKey: '' }).apiKey, '');
});
