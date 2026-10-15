/**
 * Tier 2 — Exhaustive Input Validation Integration Tests
 *
 * Tests:
 *   1. Content-Type Header Enforcement (rejects non-JSON Content-Type for POST/PUT/PATCH with 415)
 *   2. Payload Size Limit Enforcement (rejects payloads > 100kb with 413)
 *   3. Boundary Validation (rejects negative numbers, out-of-bounds inputs, empty values, invalid enums with 400)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import profileRoutes from '../routes/profile.js';
import goalsRoutes from '../routes/goals.js';
import { enforceJsonContentType } from '../middleware/contentType.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { registerSchema } from '../validation/schemas.js';
import { canonicalProfilePayload } from './helpers/canonicalProfile.js';
import { customGoalSchema } from '../validation/financialSchemas.js';
import { withMockAuthAccountState } from './helpers/mockAuthAccountState.js';

process.env.JWT_SECRET = 'validation-test-secret';
process.env.NODE_ENV = 'test';

const TEST_USER_ID = '65b000000000000000000001';

function signToken() {
  return jwt.sign(
    { userId: TEST_USER_ID, email: 'test@example.com', jti: crypto.randomUUID() },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}

test('registration schema accepts the non-deliverable CI identity domain', () => {
  const unique = '1725140000000-1234';
  const { error, value } = registerSchema.validate({
    name: `E2E User ${unique}`,
    email: `e2e-${unique}@example.com`,
    mobile: '9876543210',
    password: 'Valid@Pass2026!',
  });

  assert.equal(error, undefined);
  assert.equal(value.email, `e2e-${unique}@example.com`);
});

test('goal create accepts strict date-only API dates and rejects impossible calendar dates', () => {
  const base = {
    goal_name: 'Leap year goal',
    target_amount: 100000,
    target_date: '2032-02-29',
    current_savings: 10000,
    profileId: '65b000000000000000000001',
    priority: 'High',
  };
  assert.equal(customGoalSchema.validate(base, { convert: false }).error, undefined);
  assert.ok(customGoalSchema.validate({ ...base, target_date: '2031-02-29' }, { convert: false }).error);
  assert.ok(customGoalSchema.validate({ ...base, target_date: '2032-02-29T00:00:00.000Z' }, { convert: false }).error);
});

function buildApp() {
  const app = express();
  app.use(enforceJsonContentType);
  app.use(express.json({ limit: '100kb' }));
  app.use('/api/profile', profileRoutes);
  app.use('/api/goals', goalsRoutes);
  app.use(errorHandler);
  return app;
}

async function withServer(fn) {
  return withMockAuthAccountState(async () => {
    const server = buildApp().listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    try {
      return await fn(`http://127.0.0.1:${server.address().port}`);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
}

async function rawFetch(url, options = {}) {
  return fetch(url, options);
}

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body && !options.headers?.['content-type'] && !options.headers?.['Content-Type']
        ? { 'content-type': 'application/json' }
        : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

// ── 1. Content-Type Enforcements ─────────────────────────────────────
test('Validation: POST request with missing Content-Type returns 415', async () => {
  const token = signToken();
  await withServer(async (baseUrl) => {
    const response = await rawFetch(`${baseUrl}/api/profile/build`, {
      method: 'POST',
      body: JSON.stringify({}),
      headers: {
        authorization: `Bearer ${token}`,
      }, // Missing Content-Type
    });
    assert.equal(response.status, 415);
    const body = await response.json();
    assert.equal(body.error, 'Unsupported Media Type');
  });
});

test('Validation: POST request with text/plain Content-Type returns 415', async () => {
  const token = signToken();
  await withServer(async (baseUrl) => {
    const response = await rawFetch(`${baseUrl}/api/profile/build`, {
      method: 'POST',
      body: JSON.stringify({}),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'text/plain',
      },
    });
    assert.equal(response.status, 415);
  });
});

// ── 2. Payload Size Limits ───────────────────────────────────────────
test('Validation: POST request exceeding 100kb payload size limit returns 413', async () => {
  const token = signToken();
  await withServer(async (baseUrl) => {
    // Generate a payload larger than 100kb
    const hugeString = 'A'.repeat(110 * 1024); // 110 KB
    const response = await rawFetch(`${baseUrl}/api/profile/build`, {
      method: 'POST',
      body: JSON.stringify({
        ...canonicalProfilePayload(),
        huge_field: hugeString,
      }),
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
    });
    
    // Express returns 413 Payload Too Large on json limit violation
    assert.equal(response.status, 413);
  });
});

// ── 3. Parametrized boundary validation ──────────────────────────────
const boundaryCases = [
  ['Monthly take-home must be positive', { monthly_take_home: 0 }],
  ['Monthly take-home above maximum', { monthly_take_home: 100000001 }],
  ['Monthly savings must be positive', { monthly_savings: 0 }],
  ['Monthly savings equal to take-home', { monthly_savings: 100000 }],
  ['Age below minimum', { age: 17 }],
  ['Age above maximum', { age: 81 }],
  ['Fractional age', { age: 30.5 }],
  ['Invalid risk tolerance', { risk_tolerance: 'SuperAggressive' }],
  ['Negative sold-property proceeds', { sold_property_proceeds: -1 }],
  ['Non-boolean lump-sum declaration', { has_lump_sum: 'not-a-boolean' }],
  ['Missing declared lump sum', { has_lump_sum: true, lump_sum_amount: 0 }],
  ['Nonzero undeclared lump sum', { has_lump_sum: false, lump_sum_amount: 1 }],
  ['Negative liquid savings', { liquid_savings: -1 }],
  ['Negative EMI burden', { emi_burden_pct: -1 }],
  ['EMI burden above 100 percent', { emi_burden_pct: 101 }],
  ['Negative financial dependents', { financial_dependents: -1 }],
  ['Fractional financial dependents', { financial_dependents: 1.5 }],
  ['Too many financial dependents', { financial_dependents: 16 }],
  ['Negative emergency coverage', { emergency_fund_months: -1 }],
  ['Emergency coverage above maximum', { emergency_fund_months: 121 }],
  ['Empty investment goals', { investment_goals: [] }],
  ['Unsupported investment goal', { investment_goals: ['House Purchase'] }],
  ['Duplicate investment goals', { investment_goals: ['Retirement', 'Retirement'] }],
  ['Horizon below minimum', { investment_horizon_years: 0 }],
  ['Horizon above maximum', { investment_horizon_years: 31 }],
  ['Fractional horizon', { investment_horizon_years: 10.5 }],
  ['Retired goal_type field', { goal_type: 'wealth-building' }],
  ['Ambiguous income field', { monthly_take_home: undefined, income: 100000 }],
].map(([name, override]) => ({ name, payload: { ...canonicalProfilePayload(), ...override } }));

for (const tc of boundaryCases) {
  test(`Validation boundary: ${tc.name} should fail with 400 Bad Request`, async () => {
    const token = signToken();
    await withServer(async (baseUrl) => {
      const { response, body } = await jsonFetch(`${baseUrl}/api/profile/build`, {
        method: 'POST',
        body: JSON.stringify(tc.payload),
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      assert.equal(response.status, 400, `Expected 400 Bad Request, got ${response.status} for ${tc.name}`);
      assert.equal(body.error, body.message);
      assert.equal(body.code, 'VALIDATION_ERROR');
      assert.ok(body.request_id);
      assert.ok(body.details?.issues?.length > 0);
    });
  });
}
