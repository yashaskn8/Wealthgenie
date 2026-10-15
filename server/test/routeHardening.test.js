import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import regimeRoutes from '../routes/regime.js';
import { withServer, jsonRequest } from '../test-utils/httpTestUtils.js';
import { regimeAdjustSchema } from '../validation/schemas.js';
import { errorHandler } from '../middleware/errorHandler.js';
import FinancialProfile from '../models/FinancialProfile.js';
import FinancialProfileState from '../models/FinancialProfileState.js';
import Recommendation from '../models/Recommendation.js';
import RecommendationState from '../models/RecommendationState.js';
import RecommendationAllocationRevision from '../models/RecommendationAllocationRevision.js';
import { withMockAuthAccountState } from './helpers/mockAuthAccountState.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/regime', regimeRoutes);
  app.use(errorHandler);
  return app;
}

test('market-context route rejects client regime overrides instead of accepting static authority', async () => {
  await withServer(buildApp(), async (baseUrl) => {
    const { response, body } = await jsonRequest(`${baseUrl}/api/regime/current?regime=attacker_value`);
    assert.equal(response.status, 400);
    assert.equal(body.error, 'Validation failed');
  });
});

test('market-context adjustment rejects unauthenticated client weight and regime overrides', async () => {
  await withServer(buildApp(), async (baseUrl) => {
    const { response, body } = await jsonRequest(`${baseUrl}/api/regime/adjust`, {
      method: 'POST',
      body: JSON.stringify({
        baseWeights: { equity: 0.7, debt: 0.3 },
        regimeKey: 'normal',
      }),
    });
    assert.equal(response.status, 401);
    assert.equal(body.code, 'AUTH_REQUIRED');
  });
});

test('market-context adjustment schema accepts only a profile ID', () => {
  const profileId = '64b000000000000000000001';
  assert.equal(regimeAdjustSchema.validate({ profileId }).error, undefined);
  assert.ok(regimeAdjustSchema.validate({
    profileId,
    baseWeights: { equity: 1 },
  }).error);
  assert.ok(regimeAdjustSchema.validate({ profileId, regimeKey: 'NORMAL' }).error);
});

test('market-context adjustment rejects a recommendation from an older profile state', async () => {
  const profileId = '64b000000000000000000001';
  const userId = '64b000000000000000000002';
  const profile = {
    _id: profileId,
    userId,
    monthlyTakeHome: 100000,
    monthlySavings: 30000,
    age: 25,
    riskTolerance: 'Aggressive',
    soldPropertyProceeds: 0,
    hasLumpSum: false,
    lumpSumAmount: 0,
    liquidSavings: 600000,
    emiBurdenPct: 0,
    financialDependents: 0,
    emergencyFundMonths: 12,
    investmentGoals: ['Wealth Growth'],
    investmentHorizonYears: 30,
  };
  const oldProfileFind = FinancialProfile.findOne;
  const oldProfileExists = FinancialProfile.exists;
  const oldFinancialProfileStateFind = FinancialProfileState.findOne;
  const oldRecommendationFind = Recommendation.findOne;
  const oldStateFind = RecommendationState.findOne;
  const oldRevisionFind = RecommendationAllocationRevision.findOne;
  const oldSecret = process.env.JWT_SECRET;
  FinancialProfile.findOne = () => ({ select() { return this; }, lean: async () => profile });
  FinancialProfile.exists = async () => ({ _id: profileId });
  FinancialProfileState.findOne = () => ({ lean: async () => ({
    userId,
    currentProfileId: profileId,
    revision: 1,
    promotionFence: 1,
    resolutionStatus: 'CURRENT',
  }) });
  Recommendation.findOne = () => ({
    sort: () => ({
      lean: async () => ({
        _id: '64b000000000000000000003',
        modelVersion: 'rule-fallback-4.0.0',
        profileInputHash: '0'.repeat(64),
        instruments: [{ id: 'ppf', riskScore: 1, allocationWeight: 1 }],
      }),
    }),
  });
  RecommendationState.findOne = () => ({ lean: async () => null });
  RecommendationAllocationRevision.findOne = () => ({
    sort: () => ({ lean: async () => null }),
    lean: async () => null,
  });
  process.env.JWT_SECRET = 'test_jwt_secret_that_is_at_least_32_chars';
  try {
    const token = jwt.sign({ userId, role: 'user' }, process.env.JWT_SECRET, { algorithm: 'HS256' });
    await withMockAuthAccountState(() => withServer(buildApp(), async (baseUrl) => {
      const { response, body } = await jsonRequest(`${baseUrl}/api/regime/adjust`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ profileId }),
      });
      assert.equal(response.status, 409);
      assert.equal(body.code, 'STALE_RECOMMENDATION_PROFILE');
    }));
  } finally {
    FinancialProfile.findOne = oldProfileFind;
    FinancialProfile.exists = oldProfileExists;
    FinancialProfileState.findOne = oldFinancialProfileStateFind;
    Recommendation.findOne = oldRecommendationFind;
    RecommendationState.findOne = oldStateFind;
    RecommendationAllocationRevision.findOne = oldRevisionFind;
    if (oldSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldSecret;
  }
});
