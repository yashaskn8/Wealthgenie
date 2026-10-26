import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
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
      ['POST', 'explanations'], ['GET', 'live/overview'], ['GET', 'live/events'],
      ['GET', 'live/statements'], ['POST', 'live/statements'],
      ['GET', 'live/matches'], ['GET', 'live/settlements'], ['POST', 'live/settlements'],
      ['GET', 'live/statements/' + 'a'.repeat(64)],
      ['DELETE', 'live/statements/' + 'a'.repeat(64)], ['DELETE', 'data'],
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

test('security regression: compressed JSON is rejected before vulnerable body-parser inflation', async () => {
  const app = createApp({ env: { ...process.env, RUNWAY_ENABLED: 'true' } });
  await withServer(app, async base => {
    const response = await fetch(base + '/api/runway/ledger', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      body: gzipSync(Buffer.from('{}')),
    });
    assert.equal(response.status, 415, 'Compressed JSON must not be inflated on public APIs');
    // The API must remain responsive after a rejected encoded body.
    const alive = await fetch(base + '/api/runway/current');
    assert.equal(alive.status, 401);
  });
});
