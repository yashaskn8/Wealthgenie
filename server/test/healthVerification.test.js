import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHealthRouter } from '../routes/health.js';
import { createBuildProvenance, loadBuildProvenance, serializeBuildProvenance } from '../services/buildProvenance.js';
import { assertFetchResponseMatchesOpenApi } from './helpers/openapiRuntimeContract.js';

const DEMO_ENVIRONMENT_ID = '11111111-1111-4111-8111-111111111111';

async function withVerificationServer(options, callback) {
  const app = express();
  app.use('/health', createHealthRouter(options));
  const server = createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function invokeHealthRoute(router, path) {
  const layer = router.stack.find(item => item.route?.path === path);
  assert.ok(layer, `health route ${path} exists`);
  const handler = layer.route.stack[0].handle;
  return new Promise((resolve, reject) => {
    const response = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ statusCode: this.statusCode, body }); return this; },
    };
    handler({ headers: {} }, response, reject);
  });
}

test('runtime verification reports only the running process build and connected dependency capabilities', async () => {
  await withVerificationServer({
    requireRedis: true,
    timeoutMs: 100,
    verificationTimeoutMs: 100,
    buildSha: 'A'.repeat(40),
    verifyMongoTransaction: async () => true,
    verifyRedisConnection: async () => true,
    isMongoConnected: () => true,
  }, async baseUrl => {
    const response = await fetch(`${baseUrl}/health/verification`);
    const body = await assertFetchResponseMatchesOpenApi(response, 'GET', '/health/verification');
    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      status: 'RUNTIME_VERIFIED',
      buildSha: 'a'.repeat(40),
      buildProvenance: { status: 'UNAVAILABLE', provenanceSha256: null },
      mongo: { connected: true, transactionCapable: true, databaseIdentityVerified: false, environmentSentinelVerified: false },
      redis: { required: true, connected: true },
      marketProvider: 'NSE',
      marketProviderTokenPresent: true,
    });
    assert.doesNotMatch(JSON.stringify(body), /mongodb|redis:\/\/|password|credential|secret/i);
  });
});

test('liveness exposes verified non-secret artifact provenance and rejects a tampered manifest', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wealthgenie-health-provenance-'));
  const artifacts = path.join(directory, 'artifacts');
  const manifestPath = path.join(directory, 'provenance.json');
  try {
    await mkdir(artifacts);
    await writeFile(path.join(artifacts, 'index.html'), '<html>verified</html>');
    const manifest = await createBuildProvenance({
      repositoryRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
      frontendArtifactDirectory: artifacts,
      gitCommitSha: 'a'.repeat(40),
      gitTreeSha: 'b'.repeat(40),
      serverImageIdentity: `sha256:${'1'.repeat(64)}`,
      frontendImageIdentity: `sha256:${'2'.repeat(64)}`,
      mlImageIdentity: `sha256:${'3'.repeat(64)}`,
      workflowRunId: '12345',
      workflowRunAttempt: '1',
      buildTimestamp: '2026-10-05T00:00:00.000Z',
    });
    await writeFile(manifestPath, serializeBuildProvenance(manifest));

    await withVerificationServer({ buildProvenance: loadBuildProvenance(manifestPath) }, async baseUrl => {
      const response = await fetch(`${baseUrl}/health/live`);
      const body = await response.json();
      assert.equal(body.buildProvenance.status, 'VERIFIED');
      assert.equal(body.buildProvenance.provenanceSha256, manifest.provenanceSha256);
      assert.equal(body.buildProvenance.gitTreeSha, 'b'.repeat(40));
      assert.equal(body.buildProvenance.frontendArtifactSetSha256, manifest.frontendArtifactSetSha256);
      assert.equal(body.buildProvenance.serverImageIdentity, `sha256:${'1'.repeat(64)}`);
      assert.doesNotMatch(JSON.stringify(body.buildProvenance), /password|secret|token|credential/i);
    });

    const tampered = { ...manifest, gitTreeSha: 'c'.repeat(40) };
    await writeFile(manifestPath, serializeBuildProvenance(tampered));
    await withVerificationServer({ buildProvenance: loadBuildProvenance(manifestPath) }, async baseUrl => {
      const body = await (await fetch(`${baseUrl}/health/live`)).json();
      assert.deepEqual(body.buildProvenance, { status: 'INVALID', provenanceSha256: null });
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runtime verification fails closed when the connected Mongo or required Redis probe fails', async () => {
  await withVerificationServer({
    requireRedis: true,
    timeoutMs: 100,
    verificationTimeoutMs: 100,
    buildSha: 'b'.repeat(40),
    verifyMongoTransaction: async () => false,
    verifyRedisConnection: async () => false,
    isMongoConnected: () => true,
  }, async baseUrl => {
    const response = await fetch(`${baseUrl}/health/verification`);
    const body = await assertFetchResponseMatchesOpenApi(response, 'GET', '/health/verification');
    assert.equal(response.status, 503);
    assert.equal(body.status, 'NOT_VERIFIED');
    assert.deepEqual(body.mongo, { connected: true, transactionCapable: false, databaseIdentityVerified: false, environmentSentinelVerified: false });
    assert.deepEqual(body.redis, { required: true, connected: false });
  });
});

test('runtime verification puts a deterministic deadline around an unresponsive Redis probe', async () => {
  await withVerificationServer({
    requireRedis: true,
    timeoutMs: 30,
    verificationTimeoutMs: 30,
    buildSha: 'c'.repeat(40),
    verifyMongoTransaction: async () => true,
    verifyRedisConnection: async () => new Promise(() => {}),
    isMongoConnected: () => true,
  }, async baseUrl => {
    const response = await fetch(`${baseUrl}/health/verification`, { signal: AbortSignal.timeout(1000) });
    const body = await assertFetchResponseMatchesOpenApi(response, 'GET', '/health/verification');
    assert.equal(response.status, 503);
    assert.equal(body.redis.connected, false);
  });
});

test('optional Redis is reported truthfully without making runtime verification fail', async () => {
  let redisCalled = false;
  await withVerificationServer({
    requireRedis: false,
    timeoutMs: 100,
    verificationTimeoutMs: 100,
    buildSha: 'd'.repeat(40),
    verifyMongoTransaction: async () => true,
    verifyRedisConnection: async () => { redisCalled = true; return false; },
    isMongoConnected: () => true,
  }, async baseUrl => {
    const response = await fetch(`${baseUrl}/health/verification`);
    const body = await assertFetchResponseMatchesOpenApi(response, 'GET', '/health/verification');
    assert.equal(response.status, 200);
    assert.equal(body.redis.required, false);
    assert.equal(body.redis.connected, false);
  });
  assert.equal(redisCalled, true);
});

test('demo database verification is exact, rejects reserved/mismatched identities before transaction probing, and does not expose the name', async t => {
  const scenarios = [
    { label: 'exact isolated database, host, and sentinel', configured: 'wealthgenie_demo', actual: 'wealthgenie_demo', requested: 'wealthgenie_demo', configuredHost: 'cluster.demo.example', actualHost: 'cluster.demo.example', requestedHost: 'cluster.demo.example', configuredEnvironmentId: DEMO_ENVIRONMENT_ID, requestedEnvironmentId: DEMO_ENVIRONMENT_ID, sentinel: true, expectedStatus: 200, expectedIdentity: true, expectedSentinel: true, expectedTransactionCalls: 1 },
    { label: 'actual database differs', configured: 'wealthgenie_demo', actual: 'test', requested: 'wealthgenie_demo', configuredHost: 'cluster.demo.example', actualHost: 'cluster.demo.example', requestedHost: 'cluster.demo.example', configuredEnvironmentId: DEMO_ENVIRONMENT_ID, requestedEnvironmentId: DEMO_ENVIRONMENT_ID, sentinel: true, expectedStatus: 503, expectedIdentity: false, expectedSentinel: false, expectedTransactionCalls: 0 },
    { label: 'backend and preflight expectations differ', configured: 'wealthgenie_demo', actual: 'wealthgenie_demo', requested: 'other_demo', configuredHost: 'cluster.demo.example', actualHost: 'cluster.demo.example', requestedHost: 'cluster.demo.example', configuredEnvironmentId: DEMO_ENVIRONMENT_ID, requestedEnvironmentId: DEMO_ENVIRONMENT_ID, sentinel: true, expectedStatus: 503, expectedIdentity: false, expectedSentinel: false, expectedTransactionCalls: 0 },
    { label: 'same demo database name on a different Mongo deployment', configured: 'wealthgenie_demo', actual: 'wealthgenie_demo', requested: 'wealthgenie_demo', configuredHost: 'prod.cluster.example', actualHost: 'prod.cluster.example', requestedHost: 'cluster.demo.example', configuredEnvironmentId: DEMO_ENVIRONMENT_ID, requestedEnvironmentId: DEMO_ENVIRONMENT_ID, sentinel: true, expectedStatus: 503, expectedIdentity: false, expectedSentinel: false, expectedTransactionCalls: 0 },
    { label: 'actual host differs from configured demo host', configured: 'wealthgenie_demo', actual: 'wealthgenie_demo', requested: 'wealthgenie_demo', configuredHost: 'cluster.demo.example', actualHost: 'prod.cluster.example', requestedHost: 'cluster.demo.example', configuredEnvironmentId: DEMO_ENVIRONMENT_ID, requestedEnvironmentId: DEMO_ENVIRONMENT_ID, sentinel: true, expectedStatus: 503, expectedIdentity: false, expectedSentinel: false, expectedTransactionCalls: 0 },
    { label: 'backend and preflight host expectations differ', configured: 'wealthgenie_demo', actual: 'wealthgenie_demo', requested: 'wealthgenie_demo', configuredHost: 'cluster.demo.example', actualHost: 'cluster.demo.example', requestedHost: 'other.demo.example', configuredEnvironmentId: DEMO_ENVIRONMENT_ID, requestedEnvironmentId: DEMO_ENVIRONMENT_ID, sentinel: true, expectedStatus: 503, expectedIdentity: false, expectedSentinel: false, expectedTransactionCalls: 0 },
    { label: 'same host and database on a different Mongo port', configured: 'wealthgenie_demo', actual: 'wealthgenie_demo', requested: 'wealthgenie_demo', configuredHost: 'cluster.demo.example', actualHost: 'cluster.demo.example', requestedHost: 'cluster.demo.example', configuredPort: '27017', actualPort: 27018, requestedPort: '27017', configuredEnvironmentId: DEMO_ENVIRONMENT_ID, requestedEnvironmentId: DEMO_ENVIRONMENT_ID, sentinel: true, expectedStatus: 503, expectedIdentity: false, expectedSentinel: false, expectedTransactionCalls: 0 },
    { label: 'backend and preflight port expectations differ', configured: 'wealthgenie_demo', actual: 'wealthgenie_demo', requested: 'wealthgenie_demo', configuredHost: 'cluster.demo.example', actualHost: 'cluster.demo.example', requestedHost: 'cluster.demo.example', configuredPort: '27017', actualPort: 27017, requestedPort: '27018', configuredEnvironmentId: DEMO_ENVIRONMENT_ID, requestedEnvironmentId: DEMO_ENVIRONMENT_ID, sentinel: true, expectedStatus: 503, expectedIdentity: false, expectedSentinel: false, expectedTransactionCalls: 0 },
    { label: 'missing actual Mongo port', configured: 'wealthgenie_demo', actual: 'wealthgenie_demo', requested: 'wealthgenie_demo', configuredHost: 'cluster.demo.example', actualHost: 'cluster.demo.example', requestedHost: 'cluster.demo.example', configuredPort: '27017', actualPort: null, requestedPort: '27017', configuredEnvironmentId: DEMO_ENVIRONMENT_ID, requestedEnvironmentId: DEMO_ENVIRONMENT_ID, sentinel: true, expectedStatus: 503, expectedIdentity: false, expectedSentinel: false, expectedTransactionCalls: 0 },
    { label: 'production database cannot be certified as demo isolation', configured: 'wealthgenie', actual: 'wealthgenie', requested: 'wealthgenie', configuredHost: 'cluster.demo.example', actualHost: 'cluster.demo.example', requestedHost: 'cluster.demo.example', configuredEnvironmentId: DEMO_ENVIRONMENT_ID, requestedEnvironmentId: DEMO_ENVIRONMENT_ID, sentinel: true, expectedStatus: 503, expectedIdentity: false, expectedSentinel: false, expectedTransactionCalls: 0 },
    { label: 'reserved default database', configured: 'test', actual: 'test', requested: 'test', configuredHost: 'cluster.demo.example', actualHost: 'cluster.demo.example', requestedHost: 'cluster.demo.example', configuredEnvironmentId: DEMO_ENVIRONMENT_ID, requestedEnvironmentId: DEMO_ENVIRONMENT_ID, sentinel: true, expectedStatus: 503, expectedIdentity: false, expectedSentinel: false, expectedTransactionCalls: 0 },
    { label: 'missing expected database signaled with empty header', configured: undefined, actual: 'test', requested: '', configuredHost: undefined, actualHost: 'cluster.demo.example', requestedHost: '', configuredEnvironmentId: undefined, requestedEnvironmentId: '', sentinel: false, expectedStatus: 503, expectedIdentity: false, expectedSentinel: false, expectedTransactionCalls: 0 },
    { label: 'missing expected environment ID', configured: 'wealthgenie_demo', actual: 'wealthgenie_demo', requested: 'wealthgenie_demo', configuredHost: 'cluster.demo.example', actualHost: 'cluster.demo.example', requestedHost: 'cluster.demo.example', configuredEnvironmentId: undefined, requestedEnvironmentId: '', sentinel: false, expectedStatus: 503, expectedIdentity: true, expectedSentinel: false, expectedTransactionCalls: 0 },
    { label: 'missing actual database identity', configured: 'wealthgenie_demo', actual: null, requested: 'wealthgenie_demo', configuredHost: 'cluster.demo.example', actualHost: null, requestedHost: 'cluster.demo.example', configuredEnvironmentId: DEMO_ENVIRONMENT_ID, requestedEnvironmentId: DEMO_ENVIRONMENT_ID, sentinel: true, expectedStatus: 503, expectedIdentity: false, expectedSentinel: false, expectedTransactionCalls: 0 },
    { label: 'sentinel absent despite matching name and host', configured: 'wealthgenie_demo', actual: 'wealthgenie_demo', requested: 'wealthgenie_demo', configuredHost: 'cluster.demo.example', actualHost: 'cluster.demo.example', requestedHost: 'cluster.demo.example', configuredEnvironmentId: DEMO_ENVIRONMENT_ID, requestedEnvironmentId: DEMO_ENVIRONMENT_ID, sentinel: false, expectedStatus: 503, expectedIdentity: true, expectedSentinel: false, expectedTransactionCalls: 0 },
  ].map(scenario => ({
    configuredPort: '27017',
    actualPort: 27017,
    requestedPort: '27017',
    ...scenario,
  }));
  for (const scenario of scenarios) {
    await t.test(scenario.label, async () => {
      let transactionCalls = 0;
      await withVerificationServer({
        requireRedis: false,
        timeoutMs: 100,
        verificationTimeoutMs: 100,
        expectedDemoDatabase: scenario.configured,
        expectedDemoDatabaseHost: scenario.configuredHost,
        expectedDemoDatabasePort: scenario.configuredPort,
        expectedDemoEnvironmentId: scenario.configuredEnvironmentId,
        verifyMongoTransaction: async () => { transactionCalls += 1; return true; },
        verifyDemoEnvironmentSentinel: async () => scenario.sentinel,
        verifyRedisConnection: async () => false,
        isMongoConnected: () => true,
        getMongoDatabaseName: () => scenario.actual,
        getMongoHost: () => scenario.actualHost,
        getMongoPort: () => scenario.actualPort,
      }, async baseUrl => {
        const response = await fetch(`${baseUrl}/health/verification`, {
          headers: {
            'X-Demo-Expected-Mongodb-Database': scenario.requested,
            'X-Demo-Expected-Mongodb-Host': scenario.requestedHost,
            'X-Demo-Expected-Mongodb-Port': scenario.requestedPort,
            'X-Demo-Expected-Mongodb-Environment-Id': scenario.requestedEnvironmentId,
          },
        });
        const body = await assertFetchResponseMatchesOpenApi(response, 'GET', '/health/verification');
        assert.equal(response.status, scenario.expectedStatus);
        assert.equal(body.mongo.databaseIdentityVerified, scenario.expectedIdentity);
        assert.equal(body.mongo.environmentSentinelVerified, scenario.expectedSentinel);
        assert.equal(body.status, scenario.expectedStatus === 200 ? 'DEMO_DATABASE_VERIFIED' : 'NOT_VERIFIED');
        assert.doesNotMatch(JSON.stringify(body), /wealthgenie_demo|other_demo|mongodb|password|credential|secret/i);
      });
      assert.equal(transactionCalls, scenario.expectedTransactionCalls);
    });
  }
});

test('readiness fails when configured isolated Mongo identity is not the connected host and database', async () => {
  let transactionCalls = 0;
  await withVerificationServer({
    expectedDemoDatabase: 'wealthgenie_demo',
    expectedDemoDatabaseHost: 'cluster.demo.example',
    expectedDemoDatabasePort: '27017',
    expectedDemoEnvironmentId: DEMO_ENVIRONMENT_ID,
    getMongoDatabaseName: () => 'wealthgenie_demo',
    getMongoHost: () => 'production.cluster.example',
    getMongoPort: () => 27017,
    isMongoConnected: () => true,
    verifyFinancialIndexes: async () => {},
    verifyMarketDataIndexes: async () => {},
    verifyMongoTransaction: async () => { transactionCalls += 1; return true; },
    verifyDemoEnvironmentSentinel: async () => false,
  }, async baseUrl => {
    const response = await fetch(`${baseUrl}/health/ready`);
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.status, 'NOT_READY');
    assert.ok(body.reasons.some(reason => reason.includes('isolated database identity')));
    assert.doesNotMatch(JSON.stringify(body), /cluster\.demo|production\.cluster|wealthgenie_demo/);

    const verification = await fetch(`${baseUrl}/health/verification`);
    const verificationBody = await verification.json();
    assert.equal(verification.status, 503);
    assert.equal(verificationBody.mongo.databaseIdentityVerified, false);
  });
  assert.equal(transactionCalls, 0);
});

test('readiness fails closed when Mongo transaction capability is unavailable', async () => {
  let transactionCalls = 0;
  const router = createHealthRouter({
    isMongoConnected: () => true,
    verifyMongoTransaction: async () => { transactionCalls += 1; return false; },
    verifyFinancialIndexes: async () => {},
    verifyMarketDataIndexes: async () => {},
  });
  const { statusCode, body } = await invokeHealthRoute(router, '/ready');
  assert.equal(statusCode, 503);
  assert.equal(body.status, 'NOT_READY');
  assert.ok(body.reasons.includes('MongoDB transaction capability is not ready'));
  assert.equal(transactionCalls, 1);
});

test('readiness fails closed when the Mongo transaction probe exceeds its timeout', async () => {
  let transactionCalls = 0;
  const router = createHealthRouter({
    timeoutMs: 25,
    isMongoConnected: () => true,
    verifyMongoTransaction: () => {
      transactionCalls += 1;
      // Keep a referenced timer so the route's unref'd timeout can fire in
      // this socket-free test; do not assert elapsed wall time.
      return new Promise(resolve => setTimeout(() => resolve(true), 100));
    },
    verifyFinancialIndexes: async () => {},
    verifyMarketDataIndexes: async () => {},
  });
  const { statusCode, body } = await invokeHealthRoute(router, '/ready');
  assert.equal(statusCode, 503);
  assert.equal(body.status, 'NOT_READY');
  assert.ok(body.reasons.includes('MongoDB transaction capability is not ready'));
  assert.equal(transactionCalls, 1);
});

test('readiness accepts a transaction-capable Mongo deployment', async () => {
  let transactionCalls = 0;
  const router = createHealthRouter({
    isMongoConnected: () => true,
    verifyMongoTransaction: async () => { transactionCalls += 1; return true; },
    verifyFinancialIndexes: async () => {},
    verifyMarketDataIndexes: async () => {},
  });
  const { statusCode, body } = await invokeHealthRoute(router, '/ready');
  assert.equal(statusCode, 200);
  assert.equal(body.status, 'READY');
  assert.deepEqual(body.buildProvenance, { status: 'UNAVAILABLE', provenanceSha256: null });
  assert.equal(body.lifecycle, null);
  assert.ok(Number.isFinite(Date.parse(body.timestamp)));
  assert.equal(transactionCalls, 1);
});

test('readiness fails closed when the exact demo database sentinel is absent', async () => {
  let sentinelCalls = 0;
  await withVerificationServer({
    expectedDemoDatabase: 'wealthgenie_demo',
    expectedDemoDatabaseHost: 'cluster.demo.example',
    expectedDemoDatabasePort: '27017',
    expectedDemoEnvironmentId: DEMO_ENVIRONMENT_ID,
    getMongoDatabaseName: () => 'wealthgenie_demo',
    getMongoHost: () => 'cluster.demo.example',
    getMongoPort: () => 27017,
    verifyDemoEnvironmentSentinel: async ({ expectedEnvironmentId }) => {
      sentinelCalls += 1;
      assert.equal(expectedEnvironmentId, DEMO_ENVIRONMENT_ID);
      return false;
    },
  }, async baseUrl => {
    const response = await fetch(`${baseUrl}/health/ready`);
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.status, 'NOT_READY');
    assert.ok(body.reasons.some(reason => reason.includes('demo environment sentinel')));
    assert.doesNotMatch(JSON.stringify(body), /cluster\.demo|wealthgenie_demo|11111111/);
  });
  assert.equal(sentinelCalls, 1);
});

test('readiness fails closed when financial or market-data persistence indexes are missing', async t => {
  for (const missing of ['financial', 'market-data']) {
    await t.test(`${missing} index verification failure`, async () => {
      let financialCalls = 0;
      let marketDataCalls = 0;
      await withVerificationServer({
        isMongoConnected: () => true,
        verifyFinancialIndexes: async () => {
          financialCalls += 1;
          if (missing === 'financial') throw new Error('missing');
        },
        verifyMarketDataIndexes: async ({ force } = {}) => {
          marketDataCalls += 1;
          assert.equal(force, true);
          if (missing === 'market-data') throw new Error('missing');
        },
      }, async baseUrl => {
        const response = await fetch(`${baseUrl}/health/ready`);
        const body = await response.json();
        assert.equal(response.status, 503);
        assert.equal(body.status, 'NOT_READY');
        assert.ok(body.reasons.includes(missing === 'financial'
          ? 'Required persistence indexes are not ready'
          : 'Required market-data persistence indexes are not ready'));
      });
      assert.equal(financialCalls, 1);
      assert.equal(marketDataCalls, 1);
    });
  }
});
