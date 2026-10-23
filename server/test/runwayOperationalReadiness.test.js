import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyRunwayIndexes, verifyRunwayOperationalReadiness } from '../services/runwayOperationalReadiness.js';

const valid = [
  [{ name: 'uniq_runway_ledger_revision', unique: true, key: { userId: 1, revision: 1 } }],
  [{ name: 'runway_snapshots_by_owner', key: { userId: 1, createdAt: -1 } }],
  [{ name: 'runway_deleted_snapshot_ttl', key: { expiresAt: 1 }, expireAfterSeconds: 0 }],
  [{ name: 'runway_statement_owner_newest', key: { userId: 1, importedAt: -1 } }],
  [
    { name: 'runway_signal_owner_cursor', key: { userId: 1, _id: 1 } },
    { name: 'runway_signal_ttl', key: { expiresAt: 1 }, expireAfterSeconds: 0 },
  ],
];
const configured = { RUNWAY_ENABLED: 'true', RUNWAY_INTEGRITY_SECRET: 'a6'.repeat(32) };
test('feature disabled: readiness bypasses optional signing key and indexes', async () => {
  let calls = 0;
  const status = await verifyRunwayOperationalReadiness({
    env: { RUNWAY_ENABLED: 'false' }, loadIndexes: async () => { calls++; throw Error('index offline'); },
  });
  assert.deepEqual(status, { enabled: false, ready: true });
  assert.equal(calls, 0);
});
test('feature enabled: startup and readiness fail closed for missing signing key', async () => {
  let calls = 0;
  await assert.rejects(verifyRunwayOperationalReadiness({
    env: { RUNWAY_ENABLED: 'true' }, loadIndexes: async () => { calls++; return valid; },
  }), error => error.code === 'RUNWAY_SEAL_KEY_UNAVAILABLE');
  assert.equal(calls, 0, 'Do not query Mongo indexes with an invalid signing key');
});
test('feature enabled: all unique, owner-lookup and expiration indexes must match', async () => {
  assert.deepEqual(await verifyRunwayOperationalReadiness({
    env: configured, loadIndexes: async () => valid,
  }), { enabled: true, ready: true });
  for (const [group, field] of [[0, 'unique'], [1, 'name'], [2, 'expireAfterSeconds'],
    [3, 'name'], [4, 'name']]) {
    const mutated = structuredClone(valid);
    mutated[group][0][field] = group === 2 ? 7200 : group === 0 ? false : 'wrong';
    await assert.rejects(verifyRunwayOperationalReadiness({
      env: configured, loadIndexes: async () => mutated,
    }), error => error.code === 'RUNWAY_INDEXES_UNAVAILABLE');
  }
  await assert.rejects(verifyRunwayIndexes({ loadIndexes: async () => {
    throw new Error('Mongo offline');
  } }), error => error.code === 'RUNWAY_INDEXES_UNAVAILABLE');
  await assert.rejects(verifyRunwayIndexes({ loadIndexes: async () => [valid[0], valid[1]] }),
    error => error.code === 'RUNWAY_INDEXES_UNAVAILABLE');
});
