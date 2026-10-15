import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMarketSnapshot,
  MARKET_SNAPSHOT_CONTENT_REVISION_VERSION,
  MARKET_DISPLAY_STATUS,
  MARKET_SNAPSHOT_SCHEMA_VERSION,
} from '../services/marketContextService.js';

const policy = {
  status: 'MARKET_CONTEXT_AVAILABLE',
  context: 'NORMAL',
  classification: 'DETERMINISTIC_POLICY_HEURISTIC',
  policyVersion: 'market-context-policy-1.0.0',
  reasonCodes: ['NO_CAUTION_OR_RISK_OFF_POLICY_THRESHOLD_MET'],
  observedAt: '2026-09-08T10:00:00.000Z',
  sources: [{ provider: 'NSE', instrumentId: 'NIFTY 50', dataClass: 'LIVE' }],
};

function features(status = 'FEATURES_AVAILABLE', overrides = {}) {
  return {
    status,
    observedFacts: [{ key: 'nifty50Current', value: 25000, semanticClass: 'OBSERVED', dataClass: 'LIVE' }],
    derivedFacts: [{ key: 'return20DayPct', value: 2, semanticClass: 'DERIVED', dataClass: null }],
    freshness: { status: 'FRESH' },
    providerStatus: {
      quotes: { provider: 'NSE', status: 'AVAILABLE' },
      history: { provider: 'NSE', status: 'AVAILABLE' },
    },
    ...overrides,
  };
}

function quoteSnapshot({ session = 'UNKNOWN', freshness = 'FRESH', value = 25000 } = {}) {
  return {
    provider: 'NSE',
    status: 'AVAILABLE',
    qualification: 'TEST_QUALIFIED_SOURCE_CONTRACT',
    marketSession: { status: session, tradingDate: '2026-09-08', checkedAt: '2026-09-08T10:01:00.000Z' },
    facts: [{ value, availabilityStatus: 'AVAILABLE', freshness: { status: freshness } }],
  };
}

const historicalSnapshot = {
  status: 'AVAILABLE',
  candles: [{ close: 1 }],
  freshness: { status: 'FRESH' },
};

test('market snapshot keeps observed, derived, and policy output separate', () => {
  const snapshot = buildMarketSnapshot({
    quoteSnapshot: quoteSnapshot({ session: 'MARKET_OPEN' }),
    historicalSnapshot,
    features: features(),
    policy,
    evaluatedAt: '2026-09-08T10:01:00.000Z',
  });

  assert.equal(snapshot.schemaVersion, MARKET_SNAPSHOT_SCHEMA_VERSION);
  assert.equal(snapshot.status, MARKET_DISPLAY_STATUS.CURRENT);
  assert.equal(snapshot.observedFacts[0].semanticClass, 'OBSERVED');
  assert.equal(snapshot.observedFacts[0].dataClass, 'LIVE');
  assert.equal(snapshot.derivedFacts[0].semanticClass, 'DERIVED');
  assert.equal(snapshot.derivedFacts[0].dataClass, null);
  assert.equal(snapshot.policyOutput.semanticClass, 'POLICY_OUTPUT');
  assert.equal(snapshot.policyOutput.context, 'NORMAL');
  assert.equal(snapshot.providerStatus.quotes.provider, 'NSE');
  assert.equal(snapshot.contentRevision.version, MARKET_SNAPSHOT_CONTENT_REVISION_VERSION);
  assert.match(snapshot.evidenceRevision, /^[a-f0-9]{64}$/);
  assert.match(snapshot.contentRevision.digest, /^[a-f0-9]{64}$/);
});

test('content revision is stable when only the evaluation and fetch timestamps change', () => {
  const first = buildMarketSnapshot({
    quoteSnapshot: quoteSnapshot({ session: 'MARKET_OPEN' }),
    historicalSnapshot: { ...historicalSnapshot, fetchedAt: '2026-09-08T10:00:00.000Z' },
    features: features(),
    policy,
    evaluatedAt: '2026-09-08T10:01:00.000Z',
  });
  const later = buildMarketSnapshot({
    quoteSnapshot: {
      ...quoteSnapshot({ session: 'MARKET_OPEN' }),
      fetchedAt: '2026-09-08T10:04:00.000Z',
      marketSession: { status: 'MARKET_OPEN', tradingDate: '2026-09-08', checkedAt: '2026-09-08T10:04:00.000Z' },
    },
    historicalSnapshot: { ...historicalSnapshot, fetchedAt: '2026-09-08T10:04:00.000Z' },
    features: features(),
    policy: { ...policy, evaluatedAt: '2026-09-08T10:04:00.000Z' },
    evaluatedAt: '2026-09-08T10:04:00.000Z',
  });

  assert.equal(first.evidenceRevision, later.evidenceRevision);
  assert.equal(first.contentRevision.digest, later.contentRevision.digest);
  assert.notEqual(first.evaluatedAt, later.evaluatedAt);
});

test('content revision detects revised normalized quote/history facts even when observation time is unchanged', () => {
  const base = buildMarketSnapshot({
    quoteSnapshot: quoteSnapshot({ session: 'MARKET_OPEN', value: 25000 }),
    historicalSnapshot,
    features: features(),
    policy,
    evaluatedAt: '2026-09-08T10:01:00.000Z',
  });
  const quoteRevision = buildMarketSnapshot({
    quoteSnapshot: quoteSnapshot({ session: 'MARKET_OPEN', value: 25001 }),
    historicalSnapshot,
    features: features(),
    policy,
    evaluatedAt: '2026-09-08T10:01:00.000Z',
  });
  const historyRevision = buildMarketSnapshot({
    quoteSnapshot: quoteSnapshot({ session: 'MARKET_OPEN', value: 25000 }),
    historicalSnapshot: { ...historicalSnapshot, candles: [{ close: 2 }] },
    features: features(),
    policy,
    evaluatedAt: '2026-09-08T10:01:00.000Z',
  });

  assert.equal(base.observedAt, quoteRevision.observedAt);
  assert.notEqual(base.evidenceRevision, quoteRevision.evidenceRevision);
  assert.notEqual(base.evidenceRevision, historyRevision.evidenceRevision);
});

test('content revision binds the visible observed and derived fact arrays', () => {
  const base = buildMarketSnapshot({
    quoteSnapshot: quoteSnapshot({ session: 'MARKET_OPEN', value: 25000 }),
    historicalSnapshot,
    features: features(),
    policy,
    evaluatedAt: '2026-09-08T10:01:00.000Z',
  });
  const changedObserved = buildMarketSnapshot({
    quoteSnapshot: quoteSnapshot({ session: 'MARKET_OPEN', value: 25000 }),
    historicalSnapshot,
    features: features('FEATURES_AVAILABLE', {
      observedFacts: [{ key: 'nifty50Current', value: 24999, semanticClass: 'OBSERVED', dataClass: 'LIVE' }],
    }),
    policy,
    evaluatedAt: '2026-09-08T10:01:00.000Z',
  });
  const changedDerived = buildMarketSnapshot({
    quoteSnapshot: quoteSnapshot({ session: 'MARKET_OPEN', value: 25000 }),
    historicalSnapshot,
    features: features('FEATURES_AVAILABLE', {
      derivedFacts: [{ key: 'return20DayPct', value: 99, semanticClass: 'DERIVED', dataClass: null }],
    }),
    policy,
    evaluatedAt: '2026-09-08T10:01:00.000Z',
  });

  assert.equal(base.evidenceRevision, changedObserved.evidenceRevision);
  assert.equal(base.evidenceRevision, changedDerived.evidenceRevision);
  assert.notEqual(base.contentRevision.digest, changedObserved.contentRevision.digest);
  assert.notEqual(base.contentRevision.digest, changedDerived.contentRevision.digest);
});

test('content revision distinguishes policy version, classification, and market session changes', () => {
  const base = buildMarketSnapshot({
    quoteSnapshot: quoteSnapshot({ session: 'MARKET_OPEN' }),
    historicalSnapshot,
    features: features(),
    policy,
    evaluatedAt: '2026-09-08T10:01:00.000Z',
  });
  const changedPolicy = buildMarketSnapshot({
    quoteSnapshot: quoteSnapshot({ session: 'MARKET_OPEN' }),
    historicalSnapshot,
    features: features(),
    policy: { ...policy, policyVersion: 'market-context-policy-2.0.0', classification: 'UPDATED_POLICY' },
    evaluatedAt: '2026-09-08T10:01:00.000Z',
  });
  const changedSession = buildMarketSnapshot({
    quoteSnapshot: quoteSnapshot({ session: 'MARKET_CLOSED' }),
    historicalSnapshot,
    features: features(),
    policy,
    evaluatedAt: '2026-09-08T10:01:00.000Z',
  });

  assert.equal(base.evidenceRevision, changedPolicy.evidenceRevision);
  assert.notEqual(base.contentRevision.digest, changedPolicy.contentRevision.digest);
  assert.notEqual(base.contentRevision.digest, changedSession.contentRevision.digest);
});

test('market snapshot distinguishes closed, last available, stale, partial, and unavailable states', () => {
  const base = {
    historicalSnapshot,
    features: features(),
    policy,
    evaluatedAt: '2026-09-08T10:01:00.000Z',
  };
  assert.equal(buildMarketSnapshot({ ...base, quoteSnapshot: quoteSnapshot({ session: 'MARKET_CLOSED' }) }).status, MARKET_DISPLAY_STATUS.MARKET_CLOSED);
  assert.equal(buildMarketSnapshot({ ...base, quoteSnapshot: quoteSnapshot({ session: 'UNKNOWN' }) }).status, MARKET_DISPLAY_STATUS.LAST_AVAILABLE);
  assert.equal(buildMarketSnapshot({
    ...base,
    quoteSnapshot: quoteSnapshot({ freshness: 'STALE' }),
    features: features('FEATURES_UNAVAILABLE'),
  }).status, MARKET_DISPLAY_STATUS.STALE);
  assert.equal(buildMarketSnapshot({
    ...base,
    quoteSnapshot: quoteSnapshot(),
    features: features('FEATURES_UNAVAILABLE'),
  }).status, MARKET_DISPLAY_STATUS.PARTIAL_DATA);
  assert.equal(buildMarketSnapshot({
    ...base,
    quoteSnapshot: { status: 'SOURCE_ERROR', facts: [] },
    historicalSnapshot: { status: 'SOURCE_ERROR', candles: [] },
    features: features('FEATURES_UNAVAILABLE'),
  }).status, MARKET_DISPLAY_STATUS.UNAVAILABLE);
});
