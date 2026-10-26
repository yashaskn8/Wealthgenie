import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runwayProjectionId, calculateRunwayProjection, MAX_ATTEMPTS,
  quarantineExhaustedRunwayProjectionJobs,
} from '../services/runwayProjectionOutbox.js';
import { createRunwayLedgerSeal, RUNWAY_SEAL_VERSION } from '../services/runwaySeal.js';
import { canonicalSha256 } from '../utils/canonicalJson.js';
import { runRunwayWorkerLoop } from '../services/runwayWorkerLoop.js';

const original = process.env.RUNWAY_INTEGRITY_SECRET;
const envKey = 'a7'.repeat(32);
process.env.RUNWAY_INTEGRITY_SECRET = envKey;
const today = '2026-10-23';
const ledger = {
  asOfDate: today, confirmationDate: today, openingCashPaise: '3500000',
  entries: [
    { id: 'rent', label: 'Rent', kind: 'OBLIGATION', date: today,
      amountPaise: '1500000', recurrence: 'NONE' },
  ],
};
function signedLedger() {
  const x = { userId: 'a'.repeat(24), revision: 1, ledger,
    inputHash: canonicalSha256(ledger), confirmedAt: new Date('2026-10-23T00:00:00Z'),
    sealVersion: RUNWAY_SEAL_VERSION };
  x.sealHmac = createRunwayLedgerSeal(x, { RUNWAY_INTEGRITY_SECRET: envKey });
  return x;
}
test('projection jobs have deterministic owner-scoped identity', () => {
  assert.equal(runwayProjectionId('a'.repeat(24), 1), runwayProjectionId('a'.repeat(24), 1));
  assert.notEqual(runwayProjectionId('b'.repeat(24), 1), runwayProjectionId('a'.repeat(24), 1));
  assert.notEqual(runwayProjectionId('a'.repeat(24), 2), runwayProjectionId('a'.repeat(24), 1));
});
test('worker projection uses only the sealed deterministic financial ledger', () => {
  const source = signedLedger();
  const result = calculateRunwayProjection(source);
  assert.equal(result.engineVersion, 'runway-cashflow-1.2.1');
  assert.equal(result.scenarios[0].cashAlreadyAvailable.endBalancePaise, '2000000');
  assert.deepEqual(result, calculateRunwayProjection(source));
});
test('worker blocks financial source hash or HMAC tampering', () => {
  const source = signedLedger();
  assert.throws(() => calculateRunwayProjection({
    ...source, ledger: { ...ledger, openingCashPaise: '9000000' },
  }), e => e.code === 'RUNWAY_PROJECTION_SOURCE_INTEGRITY');
  assert.throws(() => calculateRunwayProjection({
    ...source, sealHmac: 'f'.repeat(64),
  }), e => e.code === 'RUNWAY_PROJECTION_SOURCE_INTEGRITY');
});
test('restores test-only signing state', () => {
  if (original === undefined) delete process.env.RUNWAY_INTEGRITY_SECRET;
  else process.env.RUNWAY_INTEGRITY_SECRET = original;
  assert.ok(true);
});

test('worker cannot report IDLE while an exhausted financial job was newly quarantined', async () => {
  const { processOneRunwayProjection } = await import('../services/runwayProjectionOutbox.js');
  let claims = 0;
  const state = await processOneRunwayProjection({
    jobModel: {
      updateMany: async () => ({ modifiedCount: 1 }),
      findOneAndUpdate: async () => { claims++; return null; },
    },
  });
  assert.equal(state.status, 'BLOCKED');
  assert.equal(state.code, 'RUNWAY_PROJECTION_LEASE_EXHAUSTED');
  assert.equal(claims, 0, 'Must fail closed before processing any more financial jobs');
});

test('database-only forged projection job owner/revision cannot publish financial results', async () => {
  const { processOneRunwayProjection } = await import('../services/runwayProjectionOutbox.js');
  let changed;
  let ledgerReads = 0;
  const state = await processOneRunwayProjection({
    jobModel: {
      updateMany: async () => ({ modifiedCount: 0 }),
      findOneAndUpdate: async () => ({
        _id: 'f'.repeat(64), userId: 'a'.repeat(24), revision: 1,
        inputHash: 'c'.repeat(64), status: 'LEASED', attempts: 1,
      }),
      updateOne: async (where, update) => {
        changed = { where, update };
        return { matchedCount: 1 };
      },
    },
    revisionModel: {
      findOne: () => { ledgerReads++; throw new Error('Must not read forged source'); },
    },
  });
  assert.equal(state.status, 'BLOCKED');
  assert.equal(state.code, 'RUNWAY_PROJECTION_JOB_IDENTITY_INVALID');
  assert.equal(ledgerReads, 0);
  assert.equal(changed.update.$set.status, 'BLOCKED');
});

test('terminally blocked job does not starve subsequent healthy owner projections', async () => {
  const outcomes = [
    { status: 'BLOCKED', code: 'RUNWAY_PROJECTION_LEASE_EXHAUSTED' },
    { status: 'DONE', revision: 3 },
    { status: 'IDLE' },
  ];
  let calls = 0;
  const delays = [];
  const blocked = [];
  await runRunwayWorkerLoop({
    processOne: async () => outcomes[calls++],
    shouldStop: () => calls === outcomes.length,
    sleep: async ms => { delays.push(ms); },
    reportBlocked: code => { blocked.push(code); },
  });
  assert.equal(calls, 3, 'Healthy queued work must run after a terminal poison job.');
  assert.deepEqual(blocked, ['RUNWAY_PROJECTION_LEASE_EXHAUSTED']);
  assert.deepEqual(delays, [2000, 2000]);
});

test('worker rejects invalid outcomes and redacts attacker-controlled error detail', async () => {
  const logged = [];
  let calls = 0;
  await runRunwayWorkerLoop({
    processOne: async () => {
      calls++;
      return { status: 'BLOCKED', code: 'private account balance: 900000' };
    },
    shouldStop: () => calls >= 1,
    sleep: async () => {},
    reportBlocked: code => logged.push(code),
  });
  assert.deepEqual(logged, ['RUNWAY_PROJECTION_PROCESSING_FAILED']);
  await assert.rejects(runRunwayWorkerLoop({
    processOne: async () => ({ status: 'SUCCESS_NOT_VERIFIED' }),
    shouldStop: () => false,
    sleep: async () => {},
    reportBlocked: () => {},
  }), /RUNWAY_WORKER_UNEXPECTED_OUTCOME/);
});
