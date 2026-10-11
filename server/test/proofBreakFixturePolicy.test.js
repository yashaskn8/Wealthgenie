import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySyntheticProofBreakObservation,
  PROOFBREAK_FIXTURE_SOURCE_CLASS,
} from './helpers/proofBreakFixturePolicy.js';

const digest = character => character.repeat(64);
const observation = (overrides = {}) => ({
  observationId: 'observation-1',
  availability: 'AVAILABLE',
  observedAt: '2026-10-11T00:00:00.000Z',
  rawContentHash: digest('a'),
  parsedFactHash: digest('b'),
  ...overrides,
});
const classify = (value, currentState = null, extra = {}) => classifySyntheticProofBreakObservation({
  sourceClass: PROOFBREAK_FIXTURE_SOURCE_CLASS,
  watchId: 'fixture-watch-1',
  generation: 1,
  currentState,
  observation: value,
  ...extra,
});

test('synthetic ProofBreak fixtures record a baseline without creating a financial verdict or alert', () => {
  const classified = classify(observation());
  assert.equal(classified.eventType, 'BASELINE_RECORDED');
  assert.equal(classified.nextState.parsedFactHash, digest('b'));
  assert.equal(Object.hasOwn(classified, 'finding'), false);
  assert.equal(Object.hasOwn(classified, 'verdict'), false);
  assert.equal(Object.hasOwn(classified, 'alert'), false);
  assert.equal(Object.hasOwn(classified, 'notification'), false);
});

test('a changed document with the same parsed facts does not create a fact-change event', () => {
  const initial = classify(observation());
  const formatted = classify(observation({
    observationId: 'observation-2',
    observedAt: '2026-10-11T00:01:00.000Z',
    rawContentHash: digest('c'),
  }), initial.nextState);
  assert.equal(formatted.eventType, 'FACTS_UNCHANGED');
  assert.equal(formatted.rawContentChanged, true);
  assert.equal(formatted.nextState.parsedFactHash, digest('b'));
});

test('a parsed fact change is only an operational event, not a supported or contradicted finding', () => {
  const initial = classify(observation());
  const changed = classify(observation({
    observationId: 'observation-2',
    observedAt: '2026-10-11T00:01:00.000Z',
    rawContentHash: digest('c'),
    parsedFactHash: digest('d'),
  }), initial.nextState);
  assert.equal(changed.eventType, 'FACTS_CHANGED');
  assert.equal(changed.nextState.parsedFactHash, digest('d'));
  assert.equal(Object.hasOwn(changed, 'finding'), false);
  assert.equal(Object.hasOwn(changed, 'alert'), false);
});

test('duplicate, stale-generation, out-of-order, and unavailable observations cannot advance fact state', () => {
  const initial = classify(observation());
  const duplicate = classify(observation(), initial.nextState);
  assert.equal(duplicate.eventType, 'REPLAY_DUPLICATE');
  assert.equal(duplicate.nextState, initial.nextState);

  const staleState = { ...initial.nextState, generation: 2 };
  const stale = classify(observation({ observationId: 'old-generation' }), staleState);
  assert.equal(stale.eventType, 'SUPERSEDED');
  assert.equal(stale.nextState, staleState);

  const outOfOrder = classify(observation({
    observationId: 'older-observation',
    observedAt: '2026-10-10T23:59:59.000Z',
    parsedFactHash: digest('e'),
  }), initial.nextState);
  assert.equal(outOfOrder.eventType, 'OUT_OF_ORDER');
  assert.equal(outOfOrder.nextState, initial.nextState);

  const unavailable = classify(observation({ observationId: 'unavailable', availability: 'UNAVAILABLE' }), initial.nextState);
  assert.equal(unavailable.eventType, 'SOURCE_UNAVAILABLE');
  assert.equal(unavailable.nextState, initial.nextState);
});

test('live source labels, invalid hashes, and future generations fail closed', () => {
  assert.throws(() => classifySyntheticProofBreakObservation({
    sourceClass: 'OFFICIAL_SOURCE',
    watchId: 'watch-1',
    generation: 1,
    observation: observation(),
  }), { code: 'GENIEPROOF_FIXTURE_SOURCE_REQUIRED' });
  assert.throws(() => classify(observation({ parsedFactHash: 'not-a-hash' })), { code: 'GENIEPROOF_FIXTURE_INVALID' });
  assert.throws(() => classify(observation(), { generation: 1 }, { generation: 2 }), { code: 'GENIEPROOF_FIXTURE_GENERATION_MISMATCH' });
});
