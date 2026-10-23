import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyEnabledApiAgentPersistence, verifyEnabledCoveragePersistence } from '../server.js';

test('API startup verifies Phase 5 queue persistence only when PlanReview is enabled', async () => {
  const calls = [];
  const result = await verifyEnabledApiAgentPersistence({ agenticPlanReviewEnabled: true, planHealth: { enabled: false } }, async options => {
    calls.push(options);
    return { ready: true };
  });

  assert.deepEqual(calls, [{ force: true }]);
  assert.deepEqual(result, { ready: true });
});

test('API startup fails before listening when queue admission persistence is missing', async () => {
  await assert.rejects(
    verifyEnabledApiAgentPersistence({ agenticPlanReviewEnabled: true }, async () => {
      throw Object.assign(new Error('queue admission missing'), { code: 'AGENT_QUEUE_ADMISSION_UNAVAILABLE' });
    }),
    error => error.code === 'AGENT_QUEUE_ADMISSION_UNAVAILABLE',
  );
});

test('API startup does not require Phase 5 queue persistence when PlanReview is disabled', async () => {
  let called = false;
  const result = await verifyEnabledApiAgentPersistence({ agenticPlanReviewEnabled: false, planHealth: { enabled: false } }, async () => {
    called = true;
    throw new Error('must not run');
  });

  assert.equal(called, false);
  assert.deepEqual(result, { ready: true, skipped: true });
});


test('coverage startup skips optional index checks while feature is off', async () => {
  let called = false;
  const outcome = await verifyEnabledCoveragePersistence(
    { COVERAGE_ENABLED: 'false' },
    async () => { called = true; throw new Error('must not check disabled feature'); },
  );
  assert.equal(called, false);
  assert.deepEqual(outcome, { ready: true, skipped: true });
});

test('coverage startup verifies all unique owner/idempotency indexes when enabled', async () => {
  const invocations = [];
  const result = await verifyEnabledCoveragePersistence(
    { COVERAGE_ENABLED: 'true' },
    async options => {
      invocations.push(options);
      return { ready: true };
    },
    undefined,
    async () => [{ name: 'idx_idempotency_owner_operation',
      key: { userId: 1, operation: 1 } }],
  );
  assert.deepEqual(result, { ready: true });
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].scope, 'persistence');
  assert.equal(invocations[0].force, true);
  assert.deepEqual(invocations[0].models.map(x => x.modelName).sort(), [
    'CoverageDeletionReceipt', 'CoverageLedger', 'CoverageResult',
    'CoverageRiskAlert', 'CoverageSettlement', 'IdempotencyKey',
  ]);
});

test('coverage startup fails closed when a financial index or worker scan is missing', async () => {
  await assert.rejects(
    verifyEnabledCoveragePersistence({ COVERAGE_ENABLED: 'true' }, async () => {
      throw new Error('missing durable cash unique index');
    }),
    /missing durable cash unique index/,
  );
  await assert.rejects(
    verifyEnabledCoveragePersistence(
      { COVERAGE_ENABLED: 'true', COVERAGE_ALERT_WORKER_ENABLED: 'true' },
      async () => ({ ready: true }),
      async () => [{ name: '_id_', key: { _id: 1 } }],
      async () => [{ name: 'idx_idempotency_owner_operation',
      key: { userId: 1, operation: 1 } }],
    ),
    /staleness-scan index is missing/,
  );
  await assert.rejects(
    verifyEnabledCoveragePersistence(
      { COVERAGE_ENABLED: 'false', COVERAGE_ALERT_WORKER_ENABLED: 'true' },
    ),
    /requires COVERAGE_ENABLED=true/,
  );
  await assert.rejects(
    verifyEnabledCoveragePersistence(
      { COVERAGE_ENABLED: 'true' },
      async () => ({ ready: true }),
      undefined,
      async () => [{ name: '_id_', key: { _id: 1 } }],
    ),
    /Cash mutation cleanup index missing/,
  );
  const ready = await verifyEnabledCoveragePersistence(
    { COVERAGE_ENABLED: 'true', COVERAGE_ALERT_WORKER_ENABLED: 'true' },
    async () => ({ ready: true }),
    async () => [{ name: 'cash_staleness_batch_scan',
      key: { 'input.asOfDate': 1, _id: 1 } }],
    async () => [{ name: 'idx_idempotency_owner_operation',
      key: { userId: 1, operation: 1 } }],
  );
  assert.deepEqual(ready, { ready: true });
});
