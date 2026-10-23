import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createGenieDecisionRouter } from '../routes/genieDecision.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { withServer, jsonRequest } from '../test-utils/httpTestUtils.js';

const profileId = '64a000000000000000000001';
const userId = '64a000000000000000000002';
const input = {
  profileId,
  expectedProfileStateRevision: 3,
  horizonMonths: 6,
  monthlyLivingExpenses: '50000.00',
  monthlyDebtPayments: '20000.00',
  monthlyInvestments: '20000.00',
  goalReservations: [
    { goalId: 'home', monthlyAllocation: '12000.00' },
    { goalId: 'retirement', monthlyAllocation: '8000.00' },
  ],
  incomeInterruption: { startMonth: 2, durationMonths: 3, incomeLossPerMonth: '100000.00' },
};

function current({ revision = 3, liquidSavings = 100000, version = 4, financialStateFence = 9 } = {}) {
  return {
    state: { resolutionStatus: 'CURRENT', revision, currentProfileId: profileId },
    profile: {
      _id: profileId, userId, version, financialStateFence,
      liquidSavings, monthlyTakeHome: 100000, monthlySavings: 30000,
    },
  };
}

function appWithFakeFinancialState({ resolve = async () => current() } = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/decisions', createGenieDecisionRouter({
    authenticate: (req, _res, next) => { req.user = { userId }; next(); },
    resolveProfile: resolve,
  }));
  app.use(errorHandler);
  return app;
}

async function preview(app, request = input) {
  return withServer(app, baseUrl => jsonRequest(`${baseUrl}/api/decisions/preview`, {
    method: 'POST',
    body: JSON.stringify(request),
  }));
}

test('GenieDecision preview binds to owned canonical profile without publishing recommendations', async () => {
  let reads = 0;
  const result = await preview(appWithFakeFinancialState({
    resolve: async ({ userId: requested, requireRecommendation }) => {
      reads += 1;
      assert.equal(requested, userId);
      assert.equal(requireRecommendation, false);
      return current();
    },
  }));
  assert.equal(result.response.status, 200);
  assert.equal(reads, 2);
  assert.equal(result.body.status, 'PARTIAL');
  assert.equal(result.body.previewOnly, true);
  assert.equal(result.body.authoritativeInvestmentRecommendation, false);
  assert.equal(result.body.financialProfileStateRevision, 3);
  assert.equal(result.body.evaluation.withInterruption.endingProjectedLiquidCash, '-140000.00');
  assert.equal(result.body.evaluation.withInterruption.firstCashShortfallMonth, 3);
  assert.equal(result.body.sourceClassification.monthlyIncomeAndSavings, 'CANONICAL_PROFILE');
});

test('GenieDecision preview rejects stale profile pointer or incorrect profile id', async () => {
  for (const request of [
    { ...input, expectedProfileStateRevision: 2 },
    { ...input, profileId: '64a000000000000000000003' },
  ]) {
    const { response, body } = await preview(appWithFakeFinancialState(), request);
    assert.equal(response.status, 409);
    assert.equal(body.code, 'DECISION_STALE_PROFILE');
  }
});

test('GenieDecision preview detects financial profile changes across evaluation', async () => {
  let reads = 0;
  const { response, body } = await preview(appWithFakeFinancialState({
    resolve: async () => (++reads === 1 ? current() : current({ financialStateFence: 10 })),
  }));
  assert.equal(response.status, 409);
  assert.equal(body.code, 'DECISION_STALE_PROFILE');
});

test('GenieDecision preview refuses unavailable cash rather than converting it to zero', async () => {
  const { response, body } = await preview(appWithFakeFinancialState({
    resolve: async () => current({ liquidSavings: null }),
  }));
  assert.equal(response.status, 422);
  assert.equal(body.code, 'REQUIRES_INPUTS');
});

test('GenieDecision preview rejects shared-budget double allocation and savings mismatch', async () => {
  const broken = [
    { ...input, goalReservations: [...input.goalReservations, { goalId: 'third', monthlyAllocation: '1.00' }] },
    { ...input, monthlyLivingExpenses: '55000.00' },
  ];
  for (const request of broken) {
    const { response, body } = await preview(appWithFakeFinancialState(), request);
    assert.equal(response.status, 422);
    assert.ok(['DOUBLE_ALLOCATED_GOAL_FUNDS', 'SAVINGS_RECONCILIATION_REQUIRED'].includes(body.code));
  }
});

test('GenieDecision preview rejects extra and missing fields', async () => {
  const { response, body } = await preview(appWithFakeFinancialState(), { ...input, surprise: 'not accepted' });
  assert.equal(response.status, 400);
  assert.equal(body.code, 'INVALID_DECISION_INPUT');
});
