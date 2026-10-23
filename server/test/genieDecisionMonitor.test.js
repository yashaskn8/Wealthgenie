import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import mongoose from 'mongoose';
import {
  createDecisionMonitorWorker, signMonitorConsent, verifyMonitorConsent,
  verifyDecisionAssessment, assessmentContext,
} from '../services/genieDecision/monitor.js';
import { signDecisionReceipt } from '../services/genieDecision/integrity.js';
import {
  hasActiveDecisionWorker, createDecisionWorkerHeartbeat,
  signDecisionWorkerHeartbeat, verifyDecisionWorkerHeartbeat,
} from '../services/genieDecision/workerHeartbeat.js';
import {
  makeDecisionSourceSnapshot, hashDecisionSourceSnapshot, fingerprintDecisionSnapshotFacts,
} from '../services/genieDecision/sourceSnapshot.js';

test('signed monitoring opt-in cannot be forged or replayed for other users or generations', () => {
  const restore = {
    secret: process.env.JWT_SECRET, node: process.env.NODE_ENV,
    keys: process.env.GENIEDECISION_INTEGRITY_KEYS,
  };
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'geniedecision-monitor-tests-secret-only-2026';
  delete process.env.GENIEDECISION_INTEGRITY_KEYS;
  try {
    const details = {
      userId: new mongoose.Types.ObjectId(),
      scenarioId: new mongoose.Types.ObjectId(), enabled: true, generation: 1,
    };
    const receipt = signMonitorConsent(details);
    verifyMonitorConsent({ ...details, ...receipt });
    for (const tampering of [
      { enabled: false }, { generation: 2 }, { userId: new mongoose.Types.ObjectId() },
      { scenarioId: new mongoose.Types.ObjectId() },
    ]) {
      assert.throws(() => verifyMonitorConsent({ ...details, ...receipt, ...tampering }),
        error => error.code === 'DECISION_MONITOR_CONSENT_INTEGRITY_FAILURE');
    }
  } finally {
    for (const [key, value] of [
      ['JWT_SECRET', restore.secret], ['NODE_ENV', restore.node],
      ['GENIEDECISION_INTEGRITY_KEYS', restore.keys],
    ]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('automatically reassessed financial results are authenticated to source and status', () => {
  const restore = { secret: process.env.JWT_SECRET, node: process.env.NODE_ENV };
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'geniedecision-monitor-tests-secret-only-2026';
  try {
    const item = {
      userId: new mongoose.Types.ObjectId(),
      scenarioId: new mongoose.Types.ObjectId(),
      scenarioRevision: 3, monitorGeneration: 2,
      profileId: new mongoose.Types.ObjectId(),
      profileStateRevision: 5, profileVersion: 2, profileFinancialFence: 4,
      profileFactsHash: 'a'.repeat(64), inputHash: 'b'.repeat(64),
      modelVersion: 'ledger-1', issuedAt: '2026-10-23T12:00:00.000Z',
      result: null, resultHash: requireHashNull(),
      status: 'NEEDS_REVIEW', reasonCode: 'ASSUMPTIONS_REQUIRE_REVIEW',
    };
    item.sourceSnapshot = makeDecisionSourceSnapshot({
      profile: {
        _id: item.profileId, version: item.profileVersion,
        financialStateFence: item.profileFinancialFence,
        liquidSavings: 120000, monthlyTakeHome: 100000, monthlySavings: 30000,
      }, state: { resolutionStatus: 'CURRENT', revision: item.profileStateRevision },
    }, item.issuedAt);
    item.sourceSnapshotHash = hashDecisionSourceSnapshot(item.sourceSnapshot);
    item.profileFactsHash = fingerprintDecisionSnapshotFacts(item.sourceSnapshot);
    const receipt = signDecisionReceipt('decision_reassessment', assessmentContext(item), {
      status: item.status, reasonCode: item.reasonCode, resultHash: item.resultHash,
    });
    verifyDecisionAssessment({ ...item, ...receipt });
    // Simulate a buggy signer producing *valid HMACs* for mismatched numbers.
    // Financial evidence and computed report must agree independently.
    const amountFacts = Object.fromEntries(item.sourceSnapshot.facts.map(fact => [fact.field, fact.value]));
    const validResult = { modelVersion: item.modelVersion, profileFacts: amountFacts };
    const matchingHash = crypto.createHash('sha256').update(JSON.stringify(validResult)).digest('hex');
    const matching = {
      ...item, status: 'RECALCULATED', reasonCode: 'FINANCIAL_FACTS_CHANGED',
      result: validResult, resultHash: matchingHash,
    };
    const signedMatching = {
      ...matching,
      ...signDecisionReceipt('decision_reassessment', assessmentContext(matching), {
        status: matching.status, reasonCode: matching.reasonCode, resultHash: matching.resultHash,
      }),
    };
    verifyDecisionAssessment(signedMatching);
    const invalidResult = {
      ...validResult, profileFacts: { ...amountFacts, monthlyTakeHome: '999999.00' },
    };
    const invalid = { ...matching, result: invalidResult,
      resultHash: crypto.createHash('sha256').update(JSON.stringify(invalidResult)).digest('hex') };
    const signedInvalid = {
      ...invalid,
      ...signDecisionReceipt('decision_reassessment', assessmentContext(invalid), {
        status: invalid.status, reasonCode: invalid.reasonCode, resultHash: invalid.resultHash,
      }),
    };
    assert.throws(() => verifyDecisionAssessment(signedInvalid),
      error => error.code === 'DECISION_ASSESSMENT_INTEGRITY_FAILURE');
    const wrongPolicy = { ...matching, result: {
      ...validResult, modelVersion: 'incorrect-calculation-version',
    } };
    wrongPolicy.resultHash = crypto.createHash('sha256').update(JSON.stringify(wrongPolicy.result)).digest('hex');
    const signedWrongPolicy = {
      ...wrongPolicy,
      ...signDecisionReceipt('decision_reassessment', assessmentContext(wrongPolicy), {
        status: wrongPolicy.status, reasonCode: wrongPolicy.reasonCode, resultHash: wrongPolicy.resultHash,
      }),
    };
    assert.throws(() => verifyDecisionAssessment(signedWrongPolicy),
      error => error.code === 'DECISION_ASSESSMENT_INTEGRITY_FAILURE');
    for (const tampering of [
      { status: 'RECALCULATED' }, { monitorGeneration: 3 },
      { reasonCode: 'FINANCIAL_FACTS_CHANGED' },
      { profileFactsHash: '0'.repeat(64) }, { profileId: new mongoose.Types.ObjectId() },
      { sourceSnapshotHash: '0'.repeat(64) }, { sourceSnapshot: {
        ...item.sourceSnapshot, facts: [{ ...item.sourceSnapshot.facts[0], value: '999999.00' },
          ...item.sourceSnapshot.facts.slice(1)],
      } },
    ]) {
      assert.throws(() => verifyDecisionAssessment({ ...item, ...receipt, ...tampering }),
        error => error.code === 'DECISION_ASSESSMENT_INTEGRITY_FAILURE');
    }
  } finally {
    if (restore.secret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = restore.secret;
    if (restore.node === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = restore.node;
  }
});

function requireHashNull() {
  // Mirrors the persisted JSON SHA used for the candidate's exact result.
  return crypto.createHash('sha256').update('null').digest('hex');
}

test('monitor worker prevents concurrent ticks and drains before stopping', async () => {
  let calls = 0;
  let release;
  const scan = () => new Promise(resolve => {
    calls += 1;
    release = () => resolve({ inspected: 1, created: 1 });
  });
  const worker = createDecisionMonitorWorker({ pollMs: 10000, scan,
    heartbeat: { beat: async () => {}, stop: async () => {} },
  });
  const a = worker.runOnce();
  const b = worker.runOnce();
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(worker.state().activeJobs, 1);
  release();
  assert.deepEqual(await a, { inspected: 1, created: 1 });
  assert.deepEqual(await b, { inspected: 1, created: 1 });
  assert.equal(worker.state().activeJobs, 0);
  assert.deepEqual(await worker.stop(), { drained: true });
  assert.throws(() => createDecisionMonitorWorker({ pollMs: 200 }), RangeError);
});

test('worker shutdown drains an in-flight signed heartbeat before deleting readiness', async () => {
  const actions = [];
  let finishBeat;
  let started;
  const beatStarted = new Promise(resolve => { started = resolve; });
  const heartbeat = {
    beat: () => new Promise(resolve => {
      actions.push('heartbeat-started');
      finishBeat = () => { actions.push('heartbeat-saved'); resolve(); };
      started();
    }),
    stop: async () => { actions.push('heartbeat-deleted'); },
  };
  const worker = createDecisionMonitorWorker({
    pollMs: 10000, heartbeat, scan: async () => ({ inspected: 0 }),
  });
  worker.start();
  await beatStarted;
  const stopping = worker.stop();
  await Promise.resolve();
  assert.equal(actions.includes('heartbeat-deleted'), false);
  finishBeat();
  assert.deepEqual(await stopping, { drained: true });
  assert.deepEqual(actions, [
    'heartbeat-started', 'heartbeat-saved', 'heartbeat-deleted',
  ]);
  assert.equal(worker.state().heartbeatHealthy, false);
});

test('operator flag alone never authorizes monitoring without live worker heartbeat', async () => {
  const before = process.env.GENIEDECISION_MONITOR_ENABLED;
  process.env.GENIEDECISION_MONITOR_ENABLED = 'true';
  try {
    const model = { findOne: () => ({
      sort: () => ({ lean: async () => null }),
    }) };
    assert.equal(await hasActiveDecisionWorker({ model }), false);
  } finally {
    if (before === undefined) delete process.env.GENIEDECISION_MONITOR_ENABLED;
    else process.env.GENIEDECISION_MONITOR_ENABLED = before;
  }
});

test('monitor worker health requires an authenticated identity, timestamp and expiry', async () => {
  const previous = {
    node: process.env.NODE_ENV, jwt: process.env.JWT_SECRET,
    enabled: process.env.GENIEDECISION_MONITOR_ENABLED,
    keys: process.env.GENIEDECISION_INTEGRITY_KEYS,
  };
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'geniedecision-worker-heartbeat-test-secret-2026';
  process.env.GENIEDECISION_MONITOR_ENABLED = 'true';
  delete process.env.GENIEDECISION_INTEGRITY_KEYS;
  try {
    const now = new Date('2026-10-23T12:00:00.000Z');
    let stored = null;
    const model = {
      updateOne: async (where, operation) => {
        stored = { _id: where._id, ...operation.$set };
      },
      findOne: () => ({ sort: () => ({ lean: async () => stored }) }),
      deleteOne: async () => { stored = null; },
    };
    const heartbeat = createDecisionWorkerHeartbeat({ model, now: () => now });
    await heartbeat.beat();
    assert.equal(verifyDecisionWorkerHeartbeat(stored, { now }), true);
    assert.equal(await hasActiveDecisionWorker({ model, now }), true);
    assert.equal(verifyDecisionWorkerHeartbeat({ ...stored, _id: crypto.randomUUID() }, { now }), false);
    assert.equal(verifyDecisionWorkerHeartbeat({
      ...stored, heartbeatAt: new Date('2026-10-23T12:00:01.000Z'),
    }, { now: new Date('2026-10-23T12:00:01.000Z') }), false);
    assert.equal(verifyDecisionWorkerHeartbeat({
      ...stored, expiresAt: new Date('2026-10-23T12:02:00.000Z'),
    }, { now }), false);
    assert.equal(verifyDecisionWorkerHeartbeat({
      ...stored, integrityTag: '0'.repeat(64),
    }, { now }), false);
    assert.equal(await hasActiveDecisionWorker({
      model, now: new Date('2026-10-23T12:01:00.000Z'),
    }), false);
    assert.deepEqual(signDecisionWorkerHeartbeat({
      workerId: stored._id, heartbeatAt: stored.heartbeatAt, expiresAt: stored.expiresAt,
    }), { integrityKeyId: stored.integrityKeyId, integrityTag: stored.integrityTag });
    await heartbeat.stop();
    assert.equal(await hasActiveDecisionWorker({ model, now }), false);
  } finally {
    for (const [key, value] of [
      ['NODE_ENV', previous.node], ['JWT_SECRET', previous.jwt],
      ['GENIEDECISION_MONITOR_ENABLED', previous.enabled],
      ['GENIEDECISION_INTEGRITY_KEYS', previous.keys],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
