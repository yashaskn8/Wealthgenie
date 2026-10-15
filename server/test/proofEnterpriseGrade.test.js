import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { withServer, jsonRequest } from '../test-utils/httpTestUtils.js';
import { correlationIdMiddleware } from '../middleware/correlation.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { validate, taxComputeSchema, chatMessageSchema } from '../validation/schemas.js';
import { personalizedMonteCarloSchema, validateStrict } from '../validation/financialSchemas.js';
import { getRuleBasedFallback } from '../services/mlClient.js';
import { queryRAG } from '../services/ragClient.js';
import { buildMlProfileInput } from '../services/recommendationProfile.js';
import { assessSuitabilityRisk } from '../services/riskProfiler.js';
import { canonicalProfile } from './helpers/canonicalProfile.js';

describe('CLAIM 1 — Enterprise-Grade Verification Suite', () => {
  let app;

  before(() => {
    app = express();
    app.use(correlationIdMiddleware);
    app.use(express.json());

    app.post('/api/tax/compute', validate(taxComputeSchema), (req, res) => {
      res.json({ success: true });
    });

    app.post('/api/chat/message', validate(chatMessageSchema), (req, res) => {
      res.json({ reply: 'ok' });
    });

    app.post('/api/montecarlo/simulate', validateStrict(personalizedMonteCarloSchema), (req, res) => {
      res.json({ simulated: true });
    });

    app.get('/api/test/error', (req, res, next) => {
      const err = new Error('Database connection lost');
      err.name = 'MongoNetworkError';
      next(err);
    });

    app.use(errorHandler);
  });

  it('1. Guarantees X-Correlation-ID propagation on every request and response', async () => {
    await withServer(app, async (baseUrl) => {
      const { response } = await jsonRequest(`${baseUrl}/api/chat/message`, {
        method: 'POST',
        headers: { 'x-correlation-id': 'enterprise-trace-12345' },
        body: JSON.stringify({ message: 'Hello' }),
      });
      assert.equal(response.headers.get('x-correlation-id'), 'enterprise-trace-12345');
    });
  });

  it('2. Enforces schema validation and rejects malformed inputs with 400 Bad Request', async () => {
    await withServer(app, async (baseUrl) => {
      const { response, body } = await jsonRequest(`${baseUrl}/api/chat/message`, {
        method: 'POST',
        body: JSON.stringify({ message: '' }),
      });
      assert.equal(response.status, 400);
      assert.equal(body.error, 'Validation failed');
      assert.ok(body.error, 'Error message must be present');
    });
  });

  it('3. Formats errors safely without exposing internal stack traces in response body', async () => {
    await withServer(app, async (baseUrl) => {
      const { response, body } = await jsonRequest(`${baseUrl}/api/test/error`);
      assert.equal(response.status, 503);
      assert.equal(body.error, 'Database service temporarily unavailable.');
      assert.ok(!body.stack, 'Stack trace must not be exposed in error body');
    });
  });

  it('4. Provides graceful rule-based fallback when ML microservice is offline or incomplete', async () => {
    const profile = canonicalProfile({ age: 28, monthlySavings: 30000 });
    const fallback = getRuleBasedFallback(buildMlProfileInput(profile, assessSuitabilityRisk(profile)));

    assert.ok(fallback.primary);
    assert.ok(fallback.secondary);
    assert.ok(Array.isArray(fallback.decision_path));
  });

  it('5. Handles unreachable RAG microservice gracefully without crashing', async () => {
    process.env.ML_SERVICE_URL = 'http://127.0.0.1:59999';
    const result = await queryRAG({ query: 'Tax benefits under 80C' }, 'test-cid-99');
    assert.equal(result, null);
  });
});
