import test from 'node:test';
import assert from 'node:assert/strict';
import { assessCurrentMarketContext } from '../scripts/demoPreflight.js';
import { isoDateInIndia } from '../services/marketData/indiaMarketTime.js';
import { previousNseTradingDate } from '../services/marketData/nseTradingCalendar.js';
import { buildNseHistoricalIndexRequestUrl } from '../services/marketData/marketDataSourceUrls.js';

const NSE_QUALIFICATION = 'OFFICIAL_NSE_WEBSITE_ENDPOINT_UNDOCUMENTED_SCHEMA_VALIDATED';
const NSE_QUOTES_URL = 'https://www.nseindia.com/api/allIndices';
const NSE_HISTORY_URL = 'https://www.nseindia.com/api/historicalOR/indicesHistory';
const NSE_CALENDAR_URL = 'https://www.nseindia.com/api/holiday-master?type=trading';

function marketTimestamp(isoDate, hour, minute) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - (330 * 60 * 1000)).toISOString();
}

function weekendMarketContext({ now, effectiveTradingDate }) {
  const today = isoDateInIndia(now);
  const quoteTimestamp = marketTimestamp(effectiveTradingDate, 15, 30);
  const checkedAt = new Date(now.getTime() - 30_000).toISOString();
  const calendar = {
    status: 'AVAILABLE',
    source: { provider: 'NSE', url: NSE_CALENDAR_URL },
    fetchedAt: new Date(now.getTime() - 60_000).toISOString(),
  };
  const quoteFreshness = {
    status: 'FRESH',
    marketSession: 'MARKET_CLOSED',
    tradingDate: today,
  };
  const sources = [
    {
      provider: 'NSE', instrumentId: 'NIFTY 50', url: NSE_QUOTES_URL,
      observedAt: quoteTimestamp, providerTimestamp: quoteTimestamp, fetchedAt: checkedAt,
      freshness: quoteFreshness, effectiveTradingDate, dataClass: 'LIVE',
    },
    {
      provider: 'NSE', instrumentId: 'INDIA VIX', url: NSE_QUOTES_URL,
      observedAt: quoteTimestamp, providerTimestamp: quoteTimestamp, fetchedAt: checkedAt,
      freshness: quoteFreshness, effectiveTradingDate, dataClass: 'LIVE',
    },
    {
      provider: 'NSE', instrumentId: 'NIFTY 50', url: NSE_HISTORY_URL,
      requestUrls: [buildNseHistoricalIndexRequestUrl({
        indexType: 'NIFTY 50',
        from: '01-09-2026',
        to: effectiveTradingDate.split('-').reverse().join('-'),
      })],
      observedAt: quoteTimestamp, providerTimestamp: quoteTimestamp, fetchedAt: checkedAt,
      freshness: { status: 'FRESH' }, effectiveTradingDate, dataClass: 'DAILY',
    },
  ];
  const snapshot = {
    status: 'MARKET_CLOSED',
    availability: 'AVAILABLE',
    policyAvailability: 'AVAILABLE',
    policyOutput: { status: 'MARKET_CONTEXT_AVAILABLE' },
    recommendationUsability: { status: 'USABLE' },
    observedAt: quoteTimestamp,
    evaluatedAt: now.toISOString(),
    marketSession: { status: 'MARKET_CLOSED', tradingDate: today, checkedAt },
    providerSelection: { selectedProvider: 'NSE' },
    providerStatus: {
      quotes: { provider: 'NSE', status: 'AVAILABLE', qualification: NSE_QUALIFICATION, calendar },
      history: { provider: 'NSE', status: 'AVAILABLE', qualification: NSE_QUALIFICATION, calendar },
    },
    provenance: { qualification: NSE_QUALIFICATION, sources },
    observedFacts: [
      {
        key: 'nifty50Current', value: 24000, dataClass: 'LIVE', availabilityStatus: 'AVAILABLE',
        observedAt: quoteTimestamp, freshness: quoteFreshness,
        source: { provider: 'NSE', instrumentId: 'NIFTY 50', url: NSE_QUOTES_URL },
      },
      {
        key: 'indiaVixCurrent', value: 14, dataClass: 'LIVE', availabilityStatus: 'AVAILABLE',
        observedAt: quoteTimestamp, freshness: quoteFreshness,
        source: { provider: 'NSE', instrumentId: 'INDIA VIX', url: NSE_QUOTES_URL },
      },
    ],
    derivedFacts: [{ value: 0.25, availabilityStatus: 'AVAILABLE', freshness: { status: 'FRESH' } }],
  };
  return {
    response: { ok: true, status: 200 },
    body: {
      status: 'MARKET_CONTEXT_AVAILABLE',
      recommendationUsability: { status: 'USABLE' },
      marketSnapshot: snapshot,
    },
  };
}

const cases = [
  {
    label: 'Saturday after ordinary Friday',
    now: new Date('2026-10-10T10:30:00.000Z'),
    holidays: [],
    expectedTradingDate: '2026-10-09',
  },
  {
    label: 'Sunday after ordinary Friday',
    now: new Date('2026-10-11T10:30:00.000Z'),
    holidays: [],
    expectedTradingDate: '2026-10-09',
  },
  {
    label: 'Saturday after Friday holiday',
    now: new Date('2026-10-03T10:30:00.000Z'),
    holidays: ['2026-10-02'],
    expectedTradingDate: '2026-10-01',
  },
  {
    label: 'Sunday after Friday holiday',
    now: new Date('2026-10-04T10:30:00.000Z'),
    holidays: ['2026-10-02'],
    expectedTradingDate: '2026-10-01',
  },
  {
    label: 'consecutive holidays followed by weekend',
    now: new Date('2026-10-03T10:30:00.000Z'),
    holidays: ['2026-10-01', '2026-10-02'],
    expectedTradingDate: '2026-09-30',
  },
];

test('direct weekend qualification resolves only the latest completed NSE trading session', () => {
  for (const scenario of cases) {
    const today = isoDateInIndia(scenario.now);
    const effectiveTradingDate = previousNseTradingDate(today, scenario.holidays);
    assert.equal(effectiveTradingDate, scenario.expectedTradingDate, scenario.label);

    const result = weekendMarketContext({ now: scenario.now, effectiveTradingDate });
    const before = structuredClone(result.body.marketSnapshot);
    const assessment = assessCurrentMarketContext(result, { now: scenario.now });

    assert.equal(assessment.marketContextAvailable, true, scenario.label);
    assert.equal(assessment.sessionStatus, 'MARKET_CLOSED', scenario.label);
    assert.match(assessment.sessionDetail, /MARKET_WEEKEND/, scenario.label);
    assert.match(assessment.sessionDetail, /latest-completed-session/, scenario.label);
    assert.match(assessment.sessionDetail, /no intraday quote is asserted/, scenario.label);
    assert.deepEqual(result.body.marketSnapshot, before, `${scenario.label}: qualification must not rewrite evidence`);
  }
});
