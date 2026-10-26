import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DecisionIntegrityUnavailable, decisionIntegrityReady, signDecisionReceipt, verifyDecisionReceipt,
} from '../services/genieDecision/integrity.js';

function setEnvironment(values) {
  const old = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test('Authenticated receipts bind amount, owner, scenario, and exact revision', () => {
  const restore = setEnvironment({
    NODE_ENV: 'test', JWT_SECRET: 'long-test-only-session-secret-for-geniedecision-integrity',
    GENIEDECISION_INTEGRITY_KEYS: undefined, GENIEDECISION_ACTIVE_KEY_ID: undefined,
  });
  try {
    assert.equal(decisionIntegrityReady(), true);
    const context = {
      userId: 'user-A', scenarioId: 'scenario-A', revision: 7, profileFactsHash: 'hash',
    };
    const report = { amount: '1000000000.01', warnings: ['NO_VERIFIED_DATA'] };
    const receipt = signDecisionReceipt('decision_run', context, report);
    assert.match(receipt.integrityTag, /^[a-f0-9]{64}$/);
    assert.equal(verifyDecisionReceipt(receipt, 'decision_run', context, report), true);
    assert.equal(verifyDecisionReceipt(receipt, 'decision_run', context, {
      ...report, amount: '1000000000.02',
    }), false);
    assert.equal(verifyDecisionReceipt(receipt, 'decision_run', {
      ...context, userId: 'user-B',
    }, report), false);
    assert.equal(verifyDecisionReceipt(receipt, 'decision_run', {
      ...context, revision: 8,
    }, report), false);
    assert.equal(verifyDecisionReceipt(receipt, 'scenario_revision', context, report), false);
    assert.equal(verifyDecisionReceipt({ integrityKeyId: 'dev_v1', integrityTag: 'a'.repeat(64) },
      'decision_run', context, report), false);
  } finally { restore(); }
});

test('Production never falls back to JWT secret, and errors fail closed', () => {
  const restore = setEnvironment({
    NODE_ENV: 'production', JWT_SECRET: 'not-the-decision-report-signing-key-ever',
    GENIEDECISION_INTEGRITY_KEYS: undefined, GENIEDECISION_ACTIVE_KEY_ID: undefined,
  });
  try {
    assert.equal(decisionIntegrityReady(), false);
    assert.throws(() => signDecisionReceipt('decision_run', {}, {}),
      error => error instanceof DecisionIntegrityUnavailable
        && error.code === 'DECISION_INTEGRITY_UNAVAILABLE');
  } finally { restore(); }
});

test('Key rotation keeps older receipts authentic until explicitly retiring the previous key', () => {
  const restore = setEnvironment({
    NODE_ENV: 'production',
    GENIEDECISION_INTEGRITY_KEYS: JSON.stringify({ k1: 'ab'.repeat(32), k2: 'cd'.repeat(32) }),
    GENIEDECISION_ACTIVE_KEY_ID: 'k1',
  });
  try {
    const context = { userId: 'user-A', scenarioId: 's' };
    const payload = { money: '0.01' };
    const older = signDecisionReceipt('decision_run', context, payload);
    assert.equal(older.integrityKeyId, 'k1');
    process.env.GENIEDECISION_ACTIVE_KEY_ID = 'k2';
    const newer = signDecisionReceipt('decision_run', context, payload);
    assert.equal(newer.integrityKeyId, 'k2');
    assert.equal(verifyDecisionReceipt(older, 'decision_run', context, payload), true);
    assert.equal(verifyDecisionReceipt(newer, 'decision_run', context, payload), true);
    process.env.GENIEDECISION_INTEGRITY_KEYS = JSON.stringify({ k2: 'cd'.repeat(32) });
    assert.equal(verifyDecisionReceipt(older, 'decision_run', context, payload), false);
    assert.equal(verifyDecisionReceipt(newer, 'decision_run', context, payload), true);
    process.env.GENIEDECISION_INTEGRITY_KEYS = '{"k2":"not-a-valid-key"}';
    assert.equal(decisionIntegrityReady(), false);
    assert.throws(() => signDecisionReceipt('decision_run', context, payload), DecisionIntegrityUnavailable);
  } finally { restore(); }
});

test('Stable object order yields identical authenticated receipts', () => {
  const restore = setEnvironment({
    NODE_ENV: 'test', JWT_SECRET: 'long-test-only-session-secret-for-geniedecision-integrity',
    GENIEDECISION_INTEGRITY_KEYS: undefined, GENIEDECISION_ACTIVE_KEY_ID: undefined,
  });
  try {
    const context = { id: 'x', revision: 1 };
    const first = signDecisionReceipt('scenario_revision', context, { b: 1, a: { z: 2, x: 1 } });
    const second = signDecisionReceipt('scenario_revision', { revision: 1, id: 'x' },
      { a: { x: 1, z: 2 }, b: 1 });
    assert.deepEqual(first, second);
  } finally { restore(); }
});
