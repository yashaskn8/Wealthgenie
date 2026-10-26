import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEventCursor, sourceStateFingerprint, LIVE_POLL_MS } from '../services/genieDecision/liveEvents.js';
import { shouldRecheckDecisionStreamAuthorization } from '../routes/decisionEvents.js';

test('live event cursors reject malicious and ambiguous values', () => {
  assert.equal(parseEventCursor(undefined), null);
  assert.equal(parseEventCursor(''), null);
  assert.equal(parseEventCursor('0'), 0);
  assert.equal(parseEventCursor('21'), 21);
  for (const value of ['-1', '01', '1e3', 'NaN', '1&userId=other', ' 1', '1.0',
    12, {}, ['1', '2'], '999999999999999999999999']) {
    assert.throws(() => parseEventCursor(value), error =>
      error.code === 'INVALID_DECISION_EVENT_CURSOR');
  }
  assert.ok(LIVE_POLL_MS >= 1000, 'Do not run a hot Mongo polling loop for SSE');
});

test('currentness fingerprint changes on owner financial-state and out-of-band profile changes', () => {
  const current = {
    state: { resolutionStatus: 'CURRENT', revision: 3 },
    profile: {
      _id: '64a000000000000000000002', version: 2, financialStateFence: 1,
      monthlyTakeHome: 100000, monthlySavings: 20000, liquidSavings: 10000,
    },
  };
  const baseline = sourceStateFingerprint(current);
  assert.match(baseline, /^[a-f0-9]{64}$/);
  assert.equal(baseline, sourceStateFingerprint(structuredClone(current)));
  assert.notEqual(baseline, sourceStateFingerprint({
    ...current, state: { ...current.state, revision: 4 },
  }));
  assert.notEqual(baseline, sourceStateFingerprint({
    ...current, profile: { ...current.profile, liquidSavings: 9999 },
  }));
  assert.notEqual(baseline, sourceStateFingerprint({
    ...current, profile: { ...current.profile, financialStateFence: 2 },
  }));
  assert.notEqual(baseline, sourceStateFingerprint({ state: { resolutionStatus: 'NO_CURRENT', revision: 4 } }));
  // Private profile values never leave the server via this fingerprint helper.
  assert.equal(sourceStateFingerprint(current).includes('100000'), false);
});


test('SSE rechecks owner authorization before queued events or replay resets', () => {
  const idle = { events: [], resetRequired: false };
  assert.equal(shouldRecheckDecisionStreamAuthorization(idle, 100, 10000), false);
  assert.equal(shouldRecheckDecisionStreamAuthorization(idle, 10000, 10000), true);
  assert.equal(shouldRecheckDecisionStreamAuthorization({
    events: [{ type: 'SCENARIO_UPDATED', scenarioId: 'private-scenario' }],
    resetRequired: false,
  }, 100, 10000), true);
  assert.equal(shouldRecheckDecisionStreamAuthorization({
    events: [], resetRequired: true,
  }, 100, 10000), true);
});
