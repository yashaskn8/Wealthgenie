import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer, jsonRequest } from '../test-utils/httpTestUtils.js';

process.env.NODE_ENV = 'test';
process.env.DISABLE_RATE_LIMIT = 'true';
const { createApp } = await import('../app.js');

test('Runway is disabled by default and never exposes financial data without authentication', async () => {
  const disabled = createApp({ env: { ...process.env, RUNWAY_ENABLED: 'false' } });
  await withServer(disabled, async base => {
    const r = await jsonRequest(base + '/api/runway/current');
    assert.equal(r.response.status, 401);
  });
});

test('enabled Runway routes require authenticated session before reading or modifying', async () => {
  const app = createApp({ env: { ...process.env, RUNWAY_ENABLED: 'true' } });
  await withServer(app, async base => {
    for (const [method, route] of [
      ['GET', 'current'], ['PUT', 'ledger'], ['POST', 'simulations'],
      ['POST', 'snapshots'], ['GET', 'snapshots/' + 'a'.repeat(64)],
      ['POST', 'explanations'], ['DELETE', 'data'],
    ]) {
      const r = await fetch(base + '/api/runway/' + route, {
        method, headers: { 'Content-Type': 'application/json' },
        ...(method === 'GET' ? {} : { body: JSON.stringify({}) }),
      });
      assert.equal(r.status, 401, method + ' ' + route);
      assert.equal(r.headers.get('cache-control'), 'no-store');
    }
  });
});

test('health readiness is release-blocking only when Runway is enabled', async () => {
  for (const enabled of [false, true]) {
    const app = createApp({ env: {
      ...process.env, RUNWAY_ENABLED: enabled ? 'true' : 'false',
      RUNWAY_INTEGRITY_SECRET: '',
    } });
    await withServer(app, async base => {
      const { response, body } = await jsonRequest(base + '/health/ready');
      assert.equal(response.status, 503);
      assert.equal(body.status, 'NOT_READY');
      const runwayReason = (body.reasons || []).some(reason => reason.includes('Enabled Household Runway'));
      assert.equal(runwayReason, enabled, 'Runway readiness must only apply to enabled builds');
      assert.ok((body.reasons || []).some(reason => reason.includes('Database not connected')));
    });
  }
});
