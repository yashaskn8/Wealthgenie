import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runwayProjectionId, calculateRunwayProjection,
} from '../services/runwayProjectionOutbox.js';
import { createRunwayLedgerSeal, RUNWAY_SEAL_VERSION } from '../services/runwaySeal.js';
import { canonicalSha256 } from '../utils/canonicalJson.js';

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
  assert.equal(result.engineVersion, 'runway-cashflow-1.2.0');
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
