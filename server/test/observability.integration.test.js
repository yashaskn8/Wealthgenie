/** MongoDB-backed deep-health scenarios; run in the Linux replica-set matrix. */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import mongoose from 'mongoose';
import healthRoutes from '../routes/health.js';
import { correlationIdMiddleware } from '../middleware/correlation.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { setupTestDatabase, teardownTestDatabase } from './helpers/mongoTestHelper.js';

process.env.NODE_ENV = 'test';

function buildApp() {
  const app = express();
  app.use(correlationIdMiddleware);
  app.use('/health', healthRoutes);
  app.use(errorHandler);
  return app;
}

async function withServer(fn) {
  const server = buildApp().listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function ensureDb() {
  await setupTestDatabase({ requireReplicaSet: true });
}

test.after(async () => {
  await teardownTestDatabase();
});

test('Observability: deep health check returns correct structure with DB UP', async () => {
  await ensureDb();
  await withServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/health/deep`);
    const body = await response.json();
    assert.ok(body.timestamp, 'Response must include timestamp');
    assert.ok(body.services, 'Response must include services object');
    assert.ok(['UP', 'DOWN'].includes(body.services.database));
    assert.ok(['UP', 'DOWN'].includes(body.services.redis));
    assert.ok(['UP', 'DOWN'].includes(body.services.ml));
    assert.equal(body.services.database, 'UP', 'Database must be UP after ensureDb()');

    const allUp = Object.values(body.services).every(status => status === 'UP');
    const dbDown = body.services.database === 'DOWN';
    if (dbDown) {
      assert.equal(response.status, 503);
      assert.equal(body.status, 'DOWN');
    } else if (allUp) {
      assert.equal(response.status, 200);
      assert.equal(body.status, 'UP');
    } else {
      assert.equal(response.status, 200);
      assert.equal(body.status, 'DEGRADED');
    }
  });
});

test('Observability: deep health check returns 503 DOWN when MongoDB is disconnected', async t => {
  await ensureDb();
  Object.defineProperty(mongoose.connection, 'readyState', {
    get: () => 0,
    configurable: true,
  });
  t.after(() => {
    delete mongoose.connection.readyState;
  });

  await withServer(async baseUrl => {
    const response = await fetch(`${baseUrl}/health/deep`);
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.status, 'DOWN');
    assert.equal(body.services.database, 'DOWN');
  });
});
