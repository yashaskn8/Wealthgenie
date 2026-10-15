/**
 * Comprehensive Cross-User Authorization Audit Suite (Task 1)
 * Verifies that User B cannot read, update, or delete User A's resources.
 *
 * Uses rawRequest from httpTestUtils which returns { status, text(), json() }.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';

import profileRoutes from '../routes/profile.js';
import goalRoutes from '../routes/goals.js';
import recommendRoutes from '../routes/recommend.js';
import projectionRoutes from '../routes/projection.js';
import montecarloRoutes from '../routes/montecarlo.js';
import portfolioRoutes from '../routes/portfolio.js';

import { enforceJsonContentType } from '../middleware/contentType.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { withServer, rawRequest } from '../test-utils/httpTestUtils.js';

import FinancialProfile from '../models/FinancialProfile.js';
import FinancialProfileState from '../models/FinancialProfileState.js';
import User from '../models/User.js';
import Goal from '../models/Goal.js';
import Recommendation from '../models/Recommendation.js';
import RecommendationAllocationRevision from '../models/RecommendationAllocationRevision.js';
import RecommendationState from '../models/RecommendationState.js';
import { setupTestDatabase, teardownTestDatabase } from './helpers/mongoTestHelper.js';
import { canonicalProfile, canonicalProfilePayload } from './helpers/canonicalProfile.js';
import { buildRecommendationProfileHash } from '../services/recommendationProfile.js';
import { getCurrentRegulatoryRuleVersion } from '../services/taxEngine.js';
import { buildPortfolioFingerprint, buildRecommendationFingerprint } from '../services/recommendationFingerprint.js';
import {
  PROJECTION_ASSUMPTION_POLICY_HASH,
  PROJECTION_ASSUMPTION_SOURCE,
  PROJECTION_ASSUMPTION_VERSION,
} from '../services/instrumentConstants.js';

const testSecret = ['test', 'auth', 'jwt', 'key'].join('-');
process.env.JWT_SECRET = process.env.JWT_SECRET || testSecret;
const JWT_SECRET = process.env.JWT_SECRET;

let tokenA, tokenB, userAId, userBId;
let profileA, goalA, recommendationA;

function buildTestApp() {
  const app = express();
  app.use(enforceJsonContentType);
  app.use(express.json());
  app.use('/api/profile', profileRoutes);
  app.use('/api/goals', goalRoutes);
  app.use('/api/recommend', recommendRoutes);
  app.use('/api/projection', projectionRoutes);
  app.use('/api/montecarlo', montecarloRoutes);
  app.use('/api/portfolio', portfolioRoutes);
  app.use(errorHandler);
  return app;
}

test.before(async () => {
  await setupTestDatabase({ requireReplicaSet: true });

  userAId = new mongoose.Types.ObjectId().toString();
  userBId = new mongoose.Types.ObjectId().toString();

  await User.create([
    { _id: userAId, name: 'Authorization Test User A', email: `usera-${userAId}@authtest.com`, passwordHash: 'test-only-hash' },
    { _id: userBId, name: 'Authorization Test User B', email: `userb-${userBId}@authtest.com`, passwordHash: 'test-only-hash' },
  ]);

  tokenA = jwt.sign({ userId: userAId, email: 'usera@authtest.com' }, JWT_SECRET, { expiresIn: '1h' });
  tokenB = jwt.sign({ userId: userBId, email: 'userb@authtest.com' }, JWT_SECRET, { expiresIn: '1h' });

  profileA = await FinancialProfile.create({
    userId: userAId,
    ...canonicalProfile({ monthlyTakeHome: 50000, monthlySavings: 15000, age: 30 }),
    recommendationProfileVersion: 'financial-profile-1.0.0',
  });
  await FinancialProfileState.create({
    userId: userAId,
    currentProfileId: profileA._id,
    revision: 1,
    promotionFence: 1,
    resolutionStatus: 'CURRENT',
  });

  goalA = await Goal.create({
    userId: userAId,
    profileId: profileA._id,
    goal_name: 'User A Retirement Goal',
    target_amount: 1000000,
    target_date: new Date('2035-01-01'),
    priority: 'High',
    current_savings: 50000,
  });

  recommendationA = await Recommendation.create({
    userId: userAId,
    profileId: profileA._id,
    instruments: [{
      id: 'index_mf', type: 'Equity_MF', name: 'Nifty 50 Index', assetClass: 'Equity',
      nominalReturn: 12, effectiveYield: 12, postTaxReturn: null, returnBasis: 'PRE_TAX_NOMINAL',
      returnAssumptionVersion: PROJECTION_ASSUMPTION_VERSION,
      returnAssumptionHash: PROJECTION_ASSUMPTION_POLICY_HASH,
      returnSource: PROJECTION_ASSUMPTION_SOURCE,
      expenseRatio: 0.003, riskLevel: 'Medium', riskScore: 3, lockIn: 0,
      tags: ['Wealth Growth'], score: 80, scoreFactors: {
        expectedReturn: 60, riskFit: 100, liquidity: 80, goalFit: 100,
        horizonFit: 100, cost: 100, mlConfidence: 0,
      },
      allocation_pct: 100, allocationWeight: 1,
    }],
    advisoryText: 'User A Advisory',
    mlFallback: true,
    modelVersion: 'test-rule-fallback-4.0.0',
    regulatoryRuleVersion: getCurrentRegulatoryRuleVersion(),
    profileVersion: profileA.version ?? 1,
    profileInputHash: buildRecommendationProfileHash(profileA.toObject(), { modelVersion: 'test-rule-fallback-4.0.0' }),
    recommendationGeneration: 1,
    recommendationPolicyVersion: 'suitability-freeze-1.1.0',
    returnAssumptionHash: PROJECTION_ASSUMPTION_POLICY_HASH,
  });
  const allocationInstruments = recommendationA.instruments.map(instrument => instrument.toObject());
  const portfolioFingerprint = buildPortfolioFingerprint(allocationInstruments);
  const recommendationFingerprint = buildRecommendationFingerprint({
    recommendationId: recommendationA._id,
    profileInputHash: recommendationA.profileInputHash,
    modelVersion: recommendationA.modelVersion,
    recommendationPolicyVersion: recommendationA.recommendationPolicyVersion,
    regulatoryRuleVersion: recommendationA.regulatoryRuleVersion,
    returnAssumptionVersion: PROJECTION_ASSUMPTION_VERSION,
    returnAssumptionHash: PROJECTION_ASSUMPTION_POLICY_HASH,
    allocationRevision: 1,
    instruments: allocationInstruments,
  });
  const revision = await RecommendationAllocationRevision.create({
    recommendationId: recommendationA._id,
    profileId: profileA._id,
    userId: userAId,
    revision: 1,
    source: 'ORIGINAL_RECOMMENDATION',
    instruments: allocationInstruments,
    profileInputHash: recommendationA.profileInputHash,
    profileVersion: recommendationA.profileVersion,
    modelVersion: recommendationA.modelVersion,
    recommendationPolicyVersion: recommendationA.recommendationPolicyVersion,
    regulatoryRuleVersion: recommendationA.regulatoryRuleVersion,
    returnAssumptionVersion: PROJECTION_ASSUMPTION_VERSION,
    returnAssumptionHash: PROJECTION_ASSUMPTION_POLICY_HASH,
    returnAssumptionSource: PROJECTION_ASSUMPTION_SOURCE,
    portfolioFingerprint,
    recommendationFingerprint,
  });
  await RecommendationState.create({
    userId: userAId,
    profileId: profileA._id,
    currentRecommendationId: recommendationA._id,
    currentAllocationRevision: 1,
    currentAllocationRevisionId: revision._id,
    generationRevision: 1,
    profileInputHash: recommendationA.profileInputHash,
    profileVersion: recommendationA.profileVersion,
    portfolioFingerprint,
    returnAssumptionVersion: PROJECTION_ASSUMPTION_VERSION,
    returnAssumptionHash: PROJECTION_ASSUMPTION_POLICY_HASH,
    returnAssumptionSource: PROJECTION_ASSUMPTION_SOURCE,
  });
});

test.after(async () => {
  try {
    await User.deleteMany({ _id: { $in: [userAId, userBId] } });
  } catch (_) {}
  try {
    await FinancialProfile.deleteMany({ userId: { $in: [userAId, userBId] } });
    await Goal.deleteMany({ userId: { $in: [userAId, userBId] } });
    await RecommendationState.deleteMany({ userId: { $in: [userAId, userBId] } });
    await Recommendation.deleteMany({ userId: { $in: [userAId, userBId] } });
    await FinancialProfileState.deleteMany({ userId: { $in: [userAId, userBId] } });
  } catch (_) {}
  await teardownTestDatabase();
});

// ═════════════════════════════════════════════════════════════════════
// Cross-User Authorization Matrix Tests
// ═════════════════════════════════════════════════════════════════════

test('Authorization: User B cannot UPDATE User A profile (PUT /api/profile/:id)', async () => {
  const app = buildTestApp();
  await withServer(app, async (baseUrl) => {
    const res = await rawRequest(`${baseUrl}/api/profile/${profileA._id}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${tokenB}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...canonicalProfilePayload({
        monthlyTakeHome: 999999, monthlySavings: 15000, age: 30,
      }), version: 1 }),
    });
    assert.ok(
      res.status === 403 || res.status === 404,
      `Expected 403 or 404, got ${res.status}`
    );
  });
});

test('Authorization: User B cannot READ User A goals (GET /api/goals)', async () => {
  const app = buildTestApp();
  await withServer(app, async (baseUrl) => {
    const res = await rawRequest(`${baseUrl}/api/goals`, {
      method: 'GET',
      headers: { authorization: `Bearer ${tokenB}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.goals.length, 0, 'User B should see 0 goals');
  });
});

test('Authorization: User B cannot REFRESH ADVICE on User A goal (PATCH)', async () => {
  const app = buildTestApp();
  await withServer(app, async (baseUrl) => {
    const res = await rawRequest(`${baseUrl}/api/goals/${goalA._id}/refresh-advice`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${tokenB}`,
        'content-type': 'application/json',
      },
    });
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
  });
});

test('Authorization: User B cannot UPDATE User A goal (PATCH /api/goals/:id)', async () => {
  const app = buildTestApp();
  await withServer(app, async (baseUrl) => {
    const res = await rawRequest(`${baseUrl}/api/goals/${goalA._id}`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${tokenB}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ expectedVersion: goalA.version || 1, priority: 'High' }),
    });
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
  });
});

test('Authorization: User B cannot DELETE User A goal (DELETE /api/goals/:id)', async () => {
  const app = buildTestApp();
  await withServer(app, async (baseUrl) => {
    const res = await rawRequest(`${baseUrl}/api/goals/${goalA._id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${tokenB}`, 'If-Match': String(goalA.version || 1) },
    });
    assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
  });
});

test('Authorization: User B cannot UPDATE User A recommendation weights', async () => {
  const app = buildTestApp();
  await withServer(app, async (baseUrl) => {
    const res = await rawRequest(`${baseUrl}/api/recommend/weights`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenB}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        profileId: profileA._id.toString(),
        recommendationId: recommendationA._id.toString(),
        expectedAllocationRevision: 1,
        expectedPortfolioFingerprint: 'a'.repeat(64),
        weights: { Equity_MF: 1.0 },
      }),
    });
    assert.ok(
      res.status === 403 || res.status === 404,
      `Expected 403 or 404, got ${res.status}`
    );
  });
});

test('Suitability: manual weights cannot add an unapproved instrument', async () => {
  const app = buildTestApp();
  await withServer(app, async (baseUrl) => {
    const res = await rawRequest(`${baseUrl}/api/recommend/weights`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        profileId: profileA._id.toString(),
        weights: { index_mf: 0.8, smallcap_mf: 0.2 },
      }),
    });
    assert.equal(res.status, 400);
  });
});

test('Suitability: manual weights reject a recommendation bound to an older profile state', async () => {
  const validAge = profileA.age;
  profileA.age = validAge + 1;
  await profileA.save();
  try {
    const app = buildTestApp();
    await withServer(app, async (baseUrl) => {
      const res = await rawRequest(`${baseUrl}/api/recommend/weights`, {
        method: 'POST',
        headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          profileId: profileA._id.toString(),
          recommendationId: recommendationA._id.toString(),
          expectedAllocationRevision: 1,
          expectedPortfolioFingerprint: 'a'.repeat(64),
          weights: { index_mf: 1 },
        }),
      });
      assert.equal(res.status, 409);
    });
  } finally {
    profileA.age = validAge;
    await profileA.save();
  }
});

test('Authorization: User B cannot RUN PROJECTION on User A profile (POST /api/projection)', async () => {
  const app = buildTestApp();
  await withServer(app, async (baseUrl) => {
    const res = await rawRequest(`${baseUrl}/api/projection`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenB}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        profileId: profileA._id.toString(),
        instruments: ['FD'], monthly_investment: 5000, years: [5, 10],
      }),
    });
    assert.ok(res.status === 403 || res.status === 404, `Expected 403 or 404, got ${res.status}`);
  });
});

test('Authorization: User B cannot RUN MONTE CARLO on User A profile (POST /api/montecarlo)', async () => {
  const app = buildTestApp();
  await withServer(app, async (baseUrl) => {
    const res = await rawRequest(`${baseUrl}/api/montecarlo/montecarlo`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenB}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        profileId: profileA._id.toString(),
        instrument: 'FD', monthly_investment: 5000, years: 5,
      }),
    });
    assert.ok(res.status === 403 || res.status === 404, `Expected 403 or 404, got ${res.status}`);
  });
});

test('Authorization: User B cannot OPTIMIZE PORTFOLIO for User A profile (POST /api/portfolio/optimise)', async () => {
  const app = buildTestApp();
  await withServer(app, async (baseUrl) => {
    const res = await rawRequest(`${baseUrl}/api/portfolio/optimise`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenB}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        profileId: profileA._id.toString(),
        assets: ['Equity_MF', 'Debt_MF'],
        strategy: 'max_sharpe',
      }),
    });
    assert.ok(res.status === 403 || res.status === 404, `Expected 403 or 404, got ${res.status}`);
  });
});

test('Authorization: User B cannot GENERATE RECOMMENDATIONS for User A profile (POST /api/recommend)', async () => {
  const app = buildTestApp();
  await withServer(app, async (baseUrl) => {
    const res = await rawRequest(`${baseUrl}/api/recommend`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenB}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        profileId: profileA._id.toString(),
      }),
    });
    assert.ok(res.status === 403 || res.status === 404, `Expected 403 or 404, got ${res.status}`);
  });
});

test('Authorization: User A CAN read, update, and delete own goal', async () => {
  const app = buildTestApp();
  await withServer(app, async (baseUrl) => {
    // Read
    const getRes = await rawRequest(`${baseUrl}/api/goals`, {
      method: 'GET',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(getRes.status, 200);
    const body = await getRes.json();
    assert.equal(body.goals.length, 1);
    assert.equal(body.goals[0]._id, goalA._id.toString());

    // Priority-only PATCH is a versioned resource mutation too.
    const updateRes = await rawRequest(`${baseUrl}/api/goals/${goalA._id}`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${tokenA}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ expectedVersion: goalA.version || 1, priority: 'High' }),
    });
    assert.equal(updateRes.status, 200);
    const updated = await updateRes.json();
    assert.equal(updated.goal.version, (goalA.version || 1) + 1);

    // Delete must name the version just returned by PATCH.
    const delRes = await rawRequest(`${baseUrl}/api/goals/${goalA._id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${tokenA}`, 'If-Match': String(updated.goal.version) },
    });
    assert.equal(delRes.status, 200);
  });
});
