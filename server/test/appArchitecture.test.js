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

test('legacy Upstox mode blocks public market publication but keeps core financial routes accessible', async () => {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    MARKET_DATA_MODE: 'LEGACY',
    MARKET_DATA_PRIMARY_PROVIDER: 'UPSTOX',
    UPSTOX_PUBLIC_MARKET_DATA_LICENSE_CONFIRMED: 'false',
    CORS_ORIGINS: 'https://wealth.example',
  };
  const app = createApp({ env });

  await withServer(app, async baseUrl => {
    // Source-authorized market facades return unavailability instead of
    // opaque transport failures. Their unavailable DTOs have no live numbers.
    const benchmarks = await jsonRequest(`${baseUrl}/api/market/benchmarks`);
    assert.equal(benchmarks.response.status, 200);
    assert.equal(benchmarks.body.status, 'UNAVAILABLE');
    assert.deepEqual(benchmarks.body.facts, []);

    const summary = await jsonRequest(`${baseUrl}/api/market/rates`);
    assert.equal(summary.response.status, 200);
    assert.equal(summary.body.status, 'UNAVAILABLE');
    assert.deepEqual(summary.body.benchmarks, []);

    const marketContext = await jsonRequest(`${baseUrl}/api/regime/current`);
    assert.equal(marketContext.response.status, 200);
    assert.equal(marketContext.body.status, 'MARKET_CONTEXT_UNAVAILABLE');
    assert.equal(marketContext.body.context, null);
    assert.equal(marketContext.body.marketSnapshot.recommendationUsability.status, 'NOT_USABLE');

    // Direct Upstox publication is still denied before any provider request.
    const quotes = await jsonRequest(`${baseUrl}/api/market-data/quotes?ids=market:index:nifty-50`);
    assert.equal(quotes.response.status, 503);
    assert.equal(quotes.body.code, 'UPSTOX_PUBLIC_DISTRIBUTION_DISABLED');
    const storedQuotes = await jsonRequest(`${baseUrl}/api/market-data/quotes/persisted`);
    assert.equal(storedQuotes.response.status, 401);
    assert.equal(storedQuotes.body.code, 'AUTH_REQUIRED');

    // The admin history route enforces identity before provider-rights checks.
    const adminHistory = await jsonRequest(
      `${baseUrl}/api/market-data/admin/equity-history?exchange=NSE&symbol=RELIANCE&isin=INE002A01018&fromDate=2026-10-08&toDate=2026-10-09`,
    );
    assert.equal(adminHistory.response.status, 401);
    assert.equal(adminHistory.body.code, 'AUTH_REQUIRED');

    // Core routes still enforce identity, even if no market provider is
    // approved. Previously these were blocked with 503 before authentication.
    for (const request of [
      { path: '/api/profile/precompute', method: 'POST', body: {} },
      { path: '/api/profile/complete', method: 'POST', body: {} },
      { path: '/api/profile/64a000000000000000000001', method: 'PUT', body: {} },
      { path: '/api/recommend', method: 'POST', body: {} },
      { path: '/api/recommend/current?profileId=64a000000000000000000001' },
      { path: '/api/recommend/64a000000000000000000001/advisory', method: 'POST', body: {} },
    ]) {
      const response = await jsonRequest(`${baseUrl}${request.path}`, {
        ...request,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
      });
      assert.equal(response.response.status, 401, request.path);
      assert.equal(response.body.code, 'AUTH_REQUIRED', request.path);
    }

    for (const path of ['/api/profile/current', '/api/profile/build']) {
      const response = await jsonRequest(`${baseUrl}${path}`, path.endsWith('/build')
        ? { method: 'POST', body: JSON.stringify({}) }
        : {});
      assert.equal(response.response.status, 401, path);
      assert.equal(response.body.code, 'AUTH_REQUIRED', path);
    }
  });
});

test('selected two-provider mode keeps core routes reachable and reports unqualified market facts as unavailable', async () => {
  const previousMode = process.env.MARKET_DATA_MODE;
  process.env.MARKET_DATA_MODE = 'UPSTOX_ONLY';
  try {
    const env = {
      ...process.env,
      NODE_ENV: 'production',
      MARKET_DATA_MODE: 'UPSTOX_ONLY',
      UPSTOX_PUBLIC_MARKET_DATA_LICENSE_CONFIRMED: 'false',
      CORS_ORIGINS: 'https://wealth.example',
    };
    const app = createApp({ env });
    await withServer(app, async baseUrl => {
      const market = await jsonRequest(`${baseUrl}/api/regime/current`);
      assert.equal(market.response.status, 200);
      assert.equal(market.body.status, 'MARKET_CONTEXT_UNAVAILABLE');
      assert.equal(market.body.context, null);
      assert.ok(market.body.reasonCodes.includes('MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED'));
      assert.ok(market.body.marketSnapshot.observedFacts.every(fact =>
        fact.value === null && fact.source === null && fact.availabilityStatus === 'UNAVAILABLE'));
      assert.deepEqual(market.body.marketSnapshot.provenance.sources, []);

      const benchmarks = await jsonRequest(`${baseUrl}/api/market/benchmarks`);
      assert.equal(benchmarks.response.status, 200);
      assert.equal(benchmarks.body.status, 'UNAVAILABLE');
      assert.deepEqual(benchmarks.body.facts, []);
      assert.equal(benchmarks.body.error.code, 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED');

      for (const request of [
        { path: '/api/profile/precompute', method: 'POST', body: {} },
        { path: '/api/profile/complete', method: 'POST', body: {} },
        { path: '/api/profile/64a000000000000000000001', method: 'PUT', body: {} },
          { path: '/api/recommend', method: 'POST', body: {} },
        { path: '/api/recommend/current?profileId=64a000000000000000000001' },
        { path: '/api/regime/adjust', method: 'POST', body: {} },
        { path: '/api/market-data/admin/equity-history?exchange=NSE&symbol=RELIANCE&isin=INE002A01018&fromDate=2026-10-08&toDate=2026-10-09' },
      ]) {
        const response = await jsonRequest(`${baseUrl}${request.path}`, {
          ...request,
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
        });
        assert.equal(response.response.status, 401, request.path);
        assert.equal(response.body.code, 'AUTH_REQUIRED', request.path);
      }

      const quotes = await jsonRequest(`${baseUrl}/api/market-data/quotes?ids=market:index:nifty-50`);
      assert.equal(quotes.response.status, 503);
      assert.equal(quotes.body.code, 'UPSTOX_PUBLIC_DISTRIBUTION_DISABLED');
    });
  } finally {
    if (previousMode === undefined) delete process.env.MARKET_DATA_MODE;
    else process.env.MARKET_DATA_MODE = previousMode;
  }
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

test('GenieProof unsaved extraction preview requires authentication; gated signing remains inaccessible', async () => {
  const app = createApp({ env: {
    ...process.env,
    NODE_ENV: 'production',
    GENIEPROOF_ENABLED: 'false',
    CORS_ORIGINS: 'https://wealth.example',
  } });
  await withServer(app, async baseUrl => {
    const cap = await jsonRequest(`${baseUrl}/api/genieproof/capabilities`);
    assert.equal(cap.response.status, 401);
    assert.equal(cap.body.code, 'AUTH_REQUIRED');
    const extraction = await jsonRequest(`${baseUrl}/api/genieproof/extract-preview`, {
      method: 'POST', body: JSON.stringify({ offerText: 'PPF guarantees 7.1% p.a.' }),
    });
    assert.equal(extraction.response.status, 401);
    assert.equal(extraction.body.code, 'AUTH_REQUIRED');
    const protectedSigning = await jsonRequest(`${baseUrl}/api/genieproof/cases`, {
      method: 'POST', body: JSON.stringify({}),
    });
    assert.equal(protectedSigning.response.status, 401);
    assert.equal(protectedSigning.body.code, 'AUTH_REQUIRED');
  });
});
