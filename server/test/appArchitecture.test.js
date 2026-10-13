import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer, jsonRequest } from '../test-utils/httpTestUtils.js';
import { getRuntimeConfig, assertValidHttpTimeouts, assertValidRuntimeConfig } from '../config/runtime.js';
import { createRuntimeState } from '../services/runtimeState.js';

process.env.NODE_ENV = 'test';
process.env.DISABLE_RATE_LIMIT = 'true';
const { createApp } = await import('../app.js');

test('app factory creates isolated Express instances with production security defaults', async () => {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    CORS_ORIGINS: 'https://wealth.example',
    TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
  };
  const first = createApp({ env });
  const second = createApp({ env });
  assert.notEqual(first, second);
  assert.deepEqual(first.get('trust proxy'), ['127.0.0.1/32']);

  await withServer(first, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/healthz`, {
      headers: { Origin: 'https://wealth.example' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://wealth.example');
    assert.equal(response.headers.get('x-powered-by'), null);
  });
});

test('app factory rejects unapproved browser origins and returns traceable 404s', async () => {
  const app = createApp({
    env: { ...process.env, NODE_ENV: 'production', CORS_ORIGINS: 'https://wealth.example' },
  });

  await withServer(app, async (baseUrl) => {
    const forbidden = await jsonRequest(`${baseUrl}/healthz`, {
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(forbidden.response.status, 403);
    assert.equal(forbidden.body.error, 'Origin is not allowed to access this API.');
    assert.ok(forbidden.body.request_id);

    const missing = await jsonRequest(`${baseUrl}/api/does-not-exist`);
    assert.equal(missing.response.status, 404);
    assert.equal(missing.body.error, 'Route not found.');
    assert.equal(missing.body.request_id, missing.response.headers.get('x-correlation-id'));
  });
});

test('production blocks every public Upstox-derived quote or market-context route without distribution clearance', async () => {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    MARKET_DATA_PRIMARY_PROVIDER: 'UPSTOX',
    UPSTOX_PUBLIC_MARKET_DATA_LICENSE_CONFIRMED: 'false',
    CORS_ORIGINS: 'https://wealth.example',
  };
  const app = createApp({ env });

  await withServer(app, async baseUrl => {
    for (const path of [
      '/api/market/rates',
      '/api/market/benchmarks',
      '/api/regime/current',
      '/api/market-data/quotes?ids=market:index:nifty-50',
    ]) {
      const response = await jsonRequest(`${baseUrl}${path}`);
      assert.equal(response.response.status, 503, path);
      assert.equal(response.body.code, 'UPSTOX_PUBLIC_DISTRIBUTION_DISABLED', path);
    }
  });
});

test('admin-only TejHQ market-history endpoints reject unauthenticated requests', async () => {
  const app = createApp({ env: { ...process.env, NODE_ENV: 'test' } });
  await withServer(app, async baseUrl => {
    const response = await jsonRequest(`${baseUrl}/api/market-data/admin/tejhq/status`);
    assert.equal(response.response.status, 401);
    assert.equal(response.body.code, 'AUTH_REQUIRED');
  });
});

test('development CORS defaults allow the Vite IPv4 loopback origin', async () => {
  const app = createApp({
    env: { ...process.env, NODE_ENV: 'development', CORS_ORIGINS: '' },
  });

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/healthz`, {
      headers: { Origin: 'http://127.0.0.1:5173' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5173');
  });
});

test('runtime configuration bounds ports, proxy trust, and HTTP lifecycle timeouts', () => {
  const config = getRuntimeConfig({
    NODE_ENV: 'production',
    PORT: '70000',
    TRUSTED_PROXY_CIDRS: '10.0.0.0/8,192.168.0.0/16',
    HTTP_REQUEST_TIMEOUT_MS: '90000',
    HTTP_HEADERS_TIMEOUT_MS: '65000',
    HTTP_KEEP_ALIVE_TIMEOUT_MS: '60000',
  });
  assert.equal(config.port, 5000);
  assert.deepEqual(config.trustProxy, ['10.0.0.0/8', '192.168.0.0/16']);
  assert.deepEqual(config.allowedOrigins, []);
  assert.doesNotThrow(() => assertValidHttpTimeouts(config));

  const invalid = getRuntimeConfig({
    HTTP_REQUEST_TIMEOUT_MS: '10000',
    HTTP_HEADERS_TIMEOUT_MS: '9000',
    HTTP_KEEP_ALIVE_TIMEOUT_MS: '9000',
  });
  assert.throws(() => assertValidHttpTimeouts(invalid), /headers.*greater/i);

  const invalidPool = getRuntimeConfig({
    MONGODB_MIN_POOL_SIZE: '20',
    MONGODB_MAX_POOL_SIZE: '10',
  });
  assert.throws(() => assertValidRuntimeConfig(invalidPool), /MIN_POOL_SIZE/);
});

test('runtime lifecycle makes draining instances reject application traffic', async () => {
  const runtimeState = createRuntimeState();
  runtimeState.markReady();
  const app = createApp({
    env: { ...process.env, NODE_ENV: 'test', MAX_IN_FLIGHT_REQUESTS: '5' },
    runtimeState,
  });

  await withServer(app, async (baseUrl) => {
    runtimeState.markDraining();
    const response = await jsonRequest(`${baseUrl}/api/does-not-exist`);
    assert.equal(response.response.status, 503);
    assert.equal(response.body.code, 'SERVICE_DRAINING');
    assert.equal(response.response.headers.get('connection'), 'close');

    const live = await jsonRequest(`${baseUrl}/health/live`);
    assert.equal(live.response.status, 200);
  });
});

test('API readiness fails closed when PlanReview is enabled but Phase 5 queue persistence is unavailable', async () => {
  const app = createApp({
    env: { ...process.env, NODE_ENV: 'test', AGENTIC_PLAN_REVIEW_ENABLED: 'true' },
  });

  await withServer(app, async baseUrl => {
    const response = await jsonRequest(`${baseUrl}/health/ready`);
    assert.equal(response.response.status, 503);
    assert.equal(response.body.status, 'NOT_READY');
    assert.ok(response.body.reasons.includes('Required agent queue-admission persistence is not ready'));
  });
});
