import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import mongoose from 'mongoose';
import {
  createDecisionMonitorWorker, signMonitorConsent, verifyMonitorConsent,
  verifyDecisionAssessment, assessmentContext,
} from '../services/genieDecision/monitor.js';
import { signDecisionReceipt } from '../services/genieDecision/integrity.js';
import { makeDecisionSourceSnapshot, hashDecisionSourceSnapshot } from '../services/genieDecision/sourceSnapshot.js';

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
    const receipt = signDecisionReceipt('decision_reassessment', assessmentContext(item), {
      status: item.status, reasonCode: item.reasonCode, resultHash: item.resultHash,
    });
    verifyDecisionAssessment({ ...item, ...receipt });
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
  const worker = createDecisionMonitorWorker({ pollMs: 10000, scan });
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
