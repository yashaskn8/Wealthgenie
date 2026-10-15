/**
 * server/test/goalUpdateRecompute.test.js — Numeric Correctness Audit Suite (WG-037)
 * Verifies mathematical recomputation logic for PATCH /api/goals/:goalId
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { setupTestDatabase, teardownTestDatabase } from './helpers/mongoTestHelper.js';

import goalRoutes, { _getBlendedPortfolioMetrics } from '../routes/goals.js';
import profileRoutes from '../routes/profile.js';
import { enforceJsonContentType } from '../middleware/contentType.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { withServer, jsonRequest } from '../test-utils/httpTestUtils.js';
import { assertRuntimeResponseMatchesContract } from './helpers/openapiRuntimeContract.js';
import Goal from '../models/Goal.js';
import AuditRecord from '../models/AuditRecord.js';
import IdempotencyKey from '../models/IdempotencyKey.js';
import User from '../models/User.js';
import FinancialProfile from '../models/FinancialProfile.js';
import Recommendation from '../models/Recommendation.js';
import RecommendationAllocationRevision from '../models/RecommendationAllocationRevision.js';
import RecommendationState from '../models/RecommendationState.js';
import FinancialProfileState from '../models/FinancialProfileState.js';
import { canonicalProfile } from './helpers/canonicalProfile.js';
import { buildRecommendationProfileHash, RECOMMENDATION_POLICY_VERSION } from '../services/recommendationProfile.js';
import { getCurrentRegulatoryRuleVersion } from '../services/taxEngine.js';
import { buildPortfolioFingerprint, buildRecommendationFingerprint } from '../services/recommendationFingerprint.js';
import { createManualAllocationRevision } from '../services/recommendationState.js';
import {
  PROJECTION_ASSUMPTION_POLICY_HASH,
  PROJECTION_ASSUMPTION_SOURCE,
  PROJECTION_ASSUMPTION_VERSION,
} from '../services/instrumentConstants.js';

const testSecret = ['wg037', 'test', 'jwt', 'secret', 'key'].join('-');
process.env.JWT_SECRET = process.env.JWT_SECRET || testSecret;
const JWT_SECRET = process.env.JWT_SECRET;
process.env.NODE_ENV = 'test';

const TEST_USER_ID = new mongoose.Types.ObjectId().toString();
const TEST_USER_EMAIL = `wg037-${TEST_USER_ID}@example.test`;

function signToken(userId = TEST_USER_ID) {
  return jwt.sign(
    { userId, email: TEST_USER_EMAIL, jti: crypto.randomUUID() },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

function buildTestApp() {
  const app = express();
  app.use(enforceJsonContentType);
  app.use(express.json());
  app.use('/api/profile', profileRoutes);
  app.use('/api/goals', goalRoutes);
  app.use(errorHandler);
  return app;
}

async function ensureDb(userId = TEST_USER_ID) {
  await setupTestDatabase({ requireReplicaSet: true });
  if (!await User.exists({ _id: userId })) {
    await User.create({
      _id: userId,
      name: 'WG-037 goal recomputation test user',
      email: `wg037-${userId}@example.test`,
      passwordHash: 'test-only-password-hash',
    });
  }
  let profile = await FinancialProfile.findOne({ userId });
  if (!profile) {
    profile = await FinancialProfile.create({
      userId,
      ...canonicalProfile({ monthlyTakeHome: 100000, monthlySavings: 30000 }),
      recommendationProfileVersion: 'financial-profile-1.0.0',
    });
  }
  let recommendation = await Recommendation.findOne({ userId, profileId: profile._id });
  if (!recommendation) {
    recommendation = await Recommendation.create({
      userId, profileId: profile._id,
      instruments: [{
        id: 'fd', type: 'FD', name: 'Bank Fixed Deposit', assetClass: 'Fixed Income',
        allocationWeight: 1, allocation_pct: 100, nominalReturn: 7.5, effectiveYield: 7.5,
        postTaxReturn: null, returnBasis: 'PRE_TAX_NOMINAL', expenseRatio: 0,
        returnAssumptionVersion: PROJECTION_ASSUMPTION_VERSION,
        returnAssumptionHash: PROJECTION_ASSUMPTION_POLICY_HASH,
        returnSource: PROJECTION_ASSUMPTION_SOURCE,
        riskLevel: 'Low', riskScore: 1, lockIn: 0, tags: ['Wealth Growth'],
        score: 80, scoreFactors: {
          expectedReturn: 60, riskFit: 100, liquidity: 80, goalFit: 100,
          horizonFit: 100, cost: 100, mlConfidence: 0,
        },
      }],
      advisoryText: 'Fixture recommendation', mlFallback: true,
      modelVersion: 'test-rule-fallback-4.0.0', generatedAt: new Date(),
      profileVersion: profile.version ?? 1,
      recommendationPolicyVersion: RECOMMENDATION_POLICY_VERSION,
      regulatoryRuleVersion: getCurrentRegulatoryRuleVersion(),
      profileInputHash: buildRecommendationProfileHash(profile.toObject(), { modelVersion: 'test-rule-fallback-4.0.0' }),
      recommendationGeneration: 1,
      returnAssumptionHash: PROJECTION_ASSUMPTION_POLICY_HASH,
    });
  }
  const instruments = recommendation.instruments.map(instrument => instrument.toObject());
  const portfolioFingerprint = buildPortfolioFingerprint(instruments);
  const recommendationFingerprint = buildRecommendationFingerprint({
    recommendationId: recommendation._id,
    profileInputHash: recommendation.profileInputHash,
    modelVersion: recommendation.modelVersion,
    recommendationPolicyVersion: recommendation.recommendationPolicyVersion,
    regulatoryRuleVersion: recommendation.regulatoryRuleVersion,
    returnAssumptionVersion: PROJECTION_ASSUMPTION_VERSION,
    returnAssumptionHash: PROJECTION_ASSUMPTION_POLICY_HASH,
    allocationRevision: 1,
    instruments,
  });
  let revision = await RecommendationAllocationRevision.findOne({ recommendationId: recommendation._id, revision: 1 });
  if (!revision) revision = await RecommendationAllocationRevision.create({
      recommendationId: recommendation._id,
      profileId: profile._id,
      userId,
      revision: 1,
      previousRevision: null,
      source: 'ORIGINAL_RECOMMENDATION',
      instruments,
      profileInputHash: recommendation.profileInputHash,
      profileVersion: recommendation.profileVersion,
      modelVersion: recommendation.modelVersion,
      recommendationPolicyVersion: recommendation.recommendationPolicyVersion,
      regulatoryRuleVersion: recommendation.regulatoryRuleVersion,
      returnAssumptionVersion: PROJECTION_ASSUMPTION_VERSION,
      returnAssumptionHash: PROJECTION_ASSUMPTION_POLICY_HASH,
      returnAssumptionSource: PROJECTION_ASSUMPTION_SOURCE,
      portfolioFingerprint,
      recommendationFingerprint,
    });
  await RecommendationState.findOneAndUpdate(
    { userId, profileId: profile._id },
    { $set: {
      currentRecommendationId: recommendation._id,
      currentAllocationRevision: 1,
      currentAllocationRevisionId: revision._id,
      generationRevision: recommendation.recommendationGeneration,
      profileInputHash: recommendation.profileInputHash,
      profileVersion: recommendation.profileVersion,
      portfolioFingerprint,
      returnAssumptionVersion: PROJECTION_ASSUMPTION_VERSION,
      returnAssumptionHash: PROJECTION_ASSUMPTION_POLICY_HASH,
      returnAssumptionSource: PROJECTION_ASSUMPTION_SOURCE,
    } },
    { upsert: true, new: true },
  );
  await FinancialProfileState.findOneAndUpdate(
    { userId },
    { $set: { currentProfileId: profile._id, resolutionStatus: 'CURRENT' }, $setOnInsert: { revision: 1, promotionFence: 0 } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return profile;
}

test.after(async () => {
  try {
    await Goal.deleteMany({ userId: TEST_USER_ID });
    await IdempotencyKey.deleteMany({ userId: TEST_USER_ID });
    await RecommendationState.deleteMany({ userId: TEST_USER_ID });
    await FinancialProfileState.deleteMany({ userId: TEST_USER_ID });
    await Recommendation.deleteMany({ userId: TEST_USER_ID });
    await FinancialProfile.deleteMany({ userId: TEST_USER_ID });
    await User.deleteMany({ _id: TEST_USER_ID });
  } catch (_) {}
  await teardownTestDatabase();
});

test('goal ownership and idempotent create identity cannot be rewritten through model updates', async () => {
  const profile = await ensureDb();
  const goal = await Goal.create({
    userId: TEST_USER_ID,
    profileId: profile._id,
    goal_name: 'Identity invariant goal',
    target_amount: 100000,
    target_date: new Date(Date.now() + 3 * 365 * 24 * 60 * 60 * 1000),
    current_savings: 1000,
    priority: 'Medium',
    idempotencyOperationId: 'goal-identity-operation-test',
    idempotencyRequestHash: 'c'.repeat(64),
  });

  await assert.rejects(
    Goal.updateOne({ _id: goal._id }, { $set: { userId: new mongoose.Types.ObjectId() } }),
    error => error.code === 'GOAL_IDENTITY_IMMUTABLE',
  );
  await assert.rejects(
    Goal.findOneAndUpdate({ _id: goal._id }, { $set: { idempotencyRequestHash: 'd'.repeat(64) } }),
    error => error.code === 'GOAL_IDENTITY_IMMUTABLE',
  );
  await assert.rejects(
    Goal.updateOne({ _id: goal._id }, { $set: { profileId: new mongoose.Types.ObjectId() } }),
    error => error.code === 'GOAL_IDENTITY_IMMUTABLE',
  );
  const changedDocument = await Goal.findById(goal._id);
  await assert.rejects((async () => {
    changedDocument.userId = new mongoose.Types.ObjectId();
    await changedDocument.save();
  })(), /immutable/i);
  const stored = await Goal.findById(goal._id).lean();
  assert.equal(String(stored.userId), TEST_USER_ID);
  assert.equal(String(stored.profileId), String(profile._id));
  assert.equal(stored.idempotencyRequestHash, 'c'.repeat(64));
});

test('the same caller key independently commits profile and goal operations with owned resource links', async () => {
  const profile = await ensureDb();
  const token = signToken();
  const key = `cross-operation-${crypto.randomUUID()}`;
  const goalName = `Cross operation ${crypto.randomUUID()}`;
  const app = buildTestApp();
  await withServer(app, async baseUrl => {
    const profileResponse = await jsonRequest(`${baseUrl}/api/profile/build`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': key },
      body: JSON.stringify({
        monthly_take_home: 100000,
        monthly_savings: 30000,
        age: 32,
        risk_tolerance: 'Moderate',
        investment_goals: ['Wealth Growth'],
        investment_horizon_years: 15,
      }),
    });
    assert.equal(profileResponse.response.status, 201, JSON.stringify(profileResponse.body));
    assertRuntimeResponseMatchesContract({
      method: 'POST', path: '/api/profile/build', status: profileResponse.response.status,
      contentType: profileResponse.response.headers.get('content-type'), body: profileResponse.body,
    });

    const goalResponse = await jsonRequest(`${baseUrl}/api/goals/create`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': key },
      body: JSON.stringify({
        goal_name: goalName,
        target_amount: 500000,
        target_date: new Date(Date.now() + 8 * 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
        current_savings: 10000,
        profileId: String(profile._id),
        priority: 'Medium',
      }),
    });
    assert.equal(goalResponse.response.status, 201, JSON.stringify(goalResponse.body));
    assertRuntimeResponseMatchesContract({
      method: 'POST', path: '/api/goals/create', status: goalResponse.response.status,
      contentType: goalResponse.response.headers.get('content-type'), body: goalResponse.body,
    });

    const goalRecord = await Goal.findOne({ userId: TEST_USER_ID, goal_name: goalName }).lean();
    const profileOperation = await IdempotencyKey.findOne({
      userId: TEST_USER_ID,
      operation: 'profile.build',
      resourceId: profileResponse.body.profileId,
    }).lean();
    const goalOperation = await IdempotencyKey.findOne({
      userId: TEST_USER_ID,
      operation: 'goals.create',
      resourceId: goalRecord._id,
    }).lean();
    assert.ok(profileOperation && goalOperation);
    assert.notEqual(profileOperation._id, goalOperation._id);
    assert.notEqual(profileOperation.requestHash, goalOperation.requestHash);
    assert.equal(profileOperation.status, 'DONE');
    assert.equal(goalOperation.status, 'DONE');
    assert.equal(profileOperation.resourceType, 'FinancialProfile');
    assert.equal(goalOperation.resourceType, 'Goal');
    assert.equal(String(profileOperation.resourceId), profileResponse.body.profileId);
    assert.equal(String(goalOperation.resourceId), String(goalRecord._id));
    assert.equal(await FinancialProfile.countDocuments({ _id: profileOperation.resourceId, userId: TEST_USER_ID }), 1);
    assert.equal(await Goal.countDocuments({ _id: goalOperation.resourceId, userId: TEST_USER_ID }), 1);
  });
});

test('WG-037 Scenario (a): POST /create goal with known target_amount and target_date', async () => {
  const profile = await ensureDb();
  const token = signToken();
  const app = buildTestApp();

  // Create a target_date exactly 10 years in the future
  const targetDateObj = new Date();
  targetDateObj.setFullYear(targetDateObj.getFullYear() + 10);
  const targetDateStr = targetDateObj.toISOString().split('T')[0];

  const createPayload = {
    goal_name: 'Retirement Corpus 2036',
    target_amount: 1000000, // ₹10 Lakhs
    target_date: targetDateStr,
    current_savings: 100000, // ₹1 Lakh
    profileId: profile._id.toString(),
    priority: 'High',
  };

  await withServer(app, async (baseUrl) => {
    const { response, body } = await jsonRequest(`${baseUrl}/api/goals/create`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify(createPayload),
    });

    assert.equal(response.status, 201, `POST /create failed with status ${response.status}`);
    assertRuntimeResponseMatchesContract({
      method: 'POST', path: '/api/goals/create', status: response.status,
      contentType: response.headers.get('content-type'), body,
    });
    assert.ok(body.goal, 'Response must include created goal object');
    assert.equal(body.goal.goal_name, 'Retirement Corpus 2036');
    assert.equal(body.goal.target_amount, 1000000);
    assert.ok(body.goal.inflation_adjusted_target > 1000000, 'Inflation target must be greater than initial target_amount');
    assert.ok(body.goal.recommended_sip > 0, 'Recommended SIP must be positive');
    assert.ok(body.goal.simulated_monthly_contribution <= 30000, 'Goal simulation must not exceed profile savings capacity');
  });
});

test('goal create and recalculation enforce the 30-year projection boundary', async () => {
  const profile = await ensureDb();
  const token = signToken();
  const app = buildTestApp();
  const maximumTargetDate = new Date();
  maximumTargetDate.setFullYear(maximumTargetDate.getFullYear() + 30);
  const maximumTargetDateString = maximumTargetDate.toISOString().slice(0, 10);
  const unsupportedTargetDate = new Date();
  unsupportedTargetDate.setFullYear(unsupportedTargetDate.getFullYear() + 31);
  const unsupportedTargetDateString = unsupportedTargetDate.toISOString().slice(0, 10);
  const previousDefaultProvider = process.env.LLM_DEFAULT_PROVIDER;
  process.env.LLM_DEFAULT_PROVIDER = 'mock';

  try {
    await withServer(app, async baseUrl => {
      const beyondLimitCreate = await jsonRequest(`${baseUrl}/api/goals/create`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          goal_name: `Beyond projection limit ${crypto.randomUUID()}`,
          target_amount: 1000000,
          target_date: unsupportedTargetDateString,
          current_savings: 100000,
          profileId: String(profile._id),
          priority: 'High',
        }),
      });
      assert.equal(beyondLimitCreate.response.status, 400, JSON.stringify(beyondLimitCreate.body));
      assert.match(JSON.stringify(beyondLimitCreate.body), /30 years/i);

      const atLimitCreate = await jsonRequest(`${baseUrl}/api/goals/create`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          goal_name: `At projection limit ${crypto.randomUUID()}`,
          target_amount: 1000000,
          target_date: maximumTargetDateString,
          current_savings: 100000,
          profileId: String(profile._id),
          priority: 'High',
        }),
      });
      assert.equal(atLimitCreate.response.status, 201, JSON.stringify(atLimitCreate.body));
      assert.equal(atLimitCreate.body.goal.years_remaining, 30);

      const atLimitRecalculation = await jsonRequest(`${baseUrl}/api/goals/${atLimitCreate.body.goal._id}`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          expectedVersion: atLimitCreate.body.goal.version,
          target_amount: atLimitCreate.body.goal.target_amount,
          current_savings: atLimitCreate.body.goal.current_savings,
        }),
      });
      assert.equal(atLimitRecalculation.response.status, 200, JSON.stringify(atLimitRecalculation.body));
      assert.equal(atLimitRecalculation.body.goal.years_remaining, 30);

      const unsupportedSavedGoal = await Goal.create({
        userId: TEST_USER_ID,
        profileId: profile._id,
        version: 4,
        goal_name: `Saved beyond projection limit ${crypto.randomUUID()}`,
        target_amount: 500000,
        target_date: new Date(unsupportedTargetDateString),
        current_savings: 10000,
        priority: 'High',
        inflation_adjusted_target: 610000,
        recommended_sip: 4500,
        years_remaining: 31,
      });
      const beforeRejectedRecalculation = await Goal.findById(unsupportedSavedGoal._id).lean();
      const unsupportedSimulation = await jsonRequest(`${baseUrl}/api/goals/${unsupportedSavedGoal._id}/simulate`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ monthly_contribution: 1000 }),
      });
      assert.equal(unsupportedSimulation.response.status, 400, JSON.stringify(unsupportedSimulation.body));
      assert.match(JSON.stringify(unsupportedSimulation.body), /30 years/i);
      const afterRejectedSimulation = await Goal.findById(unsupportedSavedGoal._id).lean();
      assert.equal(afterRejectedSimulation.version, beforeRejectedRecalculation.version);
      assert.equal(afterRejectedSimulation.recommended_sip, beforeRejectedRecalculation.recommended_sip);
      assert.equal(afterRejectedSimulation.updatedAt.getTime(), beforeRejectedRecalculation.updatedAt.getTime());

      const beyondLimitRecalculation = await jsonRequest(`${baseUrl}/api/goals/${unsupportedSavedGoal._id}`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          expectedVersion: beforeRejectedRecalculation.version,
          target_amount: beforeRejectedRecalculation.target_amount,
          current_savings: beforeRejectedRecalculation.current_savings,
        }),
      });
      assert.equal(beyondLimitRecalculation.response.status, 400, JSON.stringify(beyondLimitRecalculation.body));
      const afterRejectedRecalculation = await Goal.findById(unsupportedSavedGoal._id).lean();
      assert.equal(afterRejectedRecalculation.version, beforeRejectedRecalculation.version);
      assert.equal(afterRejectedRecalculation.recommended_sip, beforeRejectedRecalculation.recommended_sip);
      assert.equal(afterRejectedRecalculation.updatedAt.getTime(), beforeRejectedRecalculation.updatedAt.getTime());
    });
  } finally {
    if (previousDefaultProvider === undefined) delete process.env.LLM_DEFAULT_PROVIDER;
    else process.env.LLM_DEFAULT_PROVIDER = previousDefaultProvider;
  }
});

test('POST /api/goals/:goalId/simulate returns a schema-valid deterministic what-if response', async () => {
  const profile = await ensureDb();
  const token = signToken();
  const app = buildTestApp();
  const targetDate = new Date();
  targetDate.setFullYear(targetDate.getFullYear() + 8);
  const targetDateString = targetDate.toISOString().slice(0, 10);

  await withServer(app, async baseUrl => {
    const created = await jsonRequest(`${baseUrl}/api/goals/create`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        goal_name: `Simulation contract ${crypto.randomUUID()}`,
        target_amount: 900000,
        target_date: targetDateString,
        current_savings: 50000,
        profileId: String(profile._id),
        priority: 'Medium',
      }),
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    const goalId = String(created.body.goal._id);
    const goalBeforeSimulation = await Goal.findById(goalId).lean();

    for (const monthlyContribution of [0, -1, 10000001, null, '10000']) {
      const invalidSimulation = await jsonRequest(`${baseUrl}/api/goals/${goalId}/simulate`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ monthly_contribution: monthlyContribution }),
      });
      assert.equal(invalidSimulation.response.status, 400, JSON.stringify(invalidSimulation.body));
    }

    const goalAfterInvalidSimulations = await Goal.findById(goalId).lean();
    assert.equal(goalAfterInvalidSimulations.version, goalBeforeSimulation.version);
    assert.equal(goalAfterInvalidSimulations.updatedAt.getTime(), goalBeforeSimulation.updatedAt.getTime());

    const simulated = await jsonRequest(`${baseUrl}/api/goals/${goalId}/simulate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ monthly_contribution: 10000 }),
    });
    assert.equal(simulated.response.status, 200, JSON.stringify(simulated.body));
    assertRuntimeResponseMatchesContract({
      method: 'POST', path: '/api/goals/{goalId}/simulate', status: simulated.response.status,
      contentType: simulated.response.headers.get('content-type'), body: simulated.body,
    });
    assert.equal(simulated.body.simulation_classification, 'NON_RECOMMENDATION_GOAL_WHAT_IF');
    assert.equal(simulated.body.provider_forecast, false);
    assert.equal(simulated.body.goal_version, created.body.goal.version);
    assert.match(simulated.body.goal_calculation_input_fingerprint, /^[a-f0-9]{64}$/);
    const goalAfterValidSimulation = await Goal.findById(goalId).lean();
    assert.equal(goalAfterValidSimulation.version, goalBeforeSimulation.version);
    assert.equal(goalAfterValidSimulation.target_amount, goalBeforeSimulation.target_amount);
    assert.equal(goalAfterValidSimulation.current_savings, goalBeforeSimulation.current_savings);
    assert.equal(goalAfterValidSimulation.recommended_sip, goalBeforeSimulation.recommended_sip);
    assert.equal(goalAfterValidSimulation.mc_computed_at.getTime(), goalBeforeSimulation.mc_computed_at.getTime());
    assert.equal(goalAfterValidSimulation.updatedAt.getTime(), goalBeforeSimulation.updatedAt.getTime());
  });
});

test('GET is read-only; recalculation uses exact supported months and rejects a sub-month horizon', async () => {
  const profile = await ensureDb();
  const token = signToken();
  const app = buildTestApp();
  const targetDate = new Date(Date.now() + (60 * 24 * 60 * 60 * 1000));
  const goal = await Goal.create({
    userId: TEST_USER_ID,
    profileId: profile._id,
    version: 3,
    goal_name: `Near target recalculation ${crypto.randomUUID()}`,
    target_amount: 500000,
    target_date: targetDate,
    current_savings: 10000,
    priority: 'High',
    inflation_adjusted_target: 610000,
    recommended_sip: 4500,
    years_remaining: 1,
    mc_computed_at: new Date('2025-01-01T00:00:00.000Z'),
  });
  const persistedBeforeGet = await Goal.findById(goal._id).lean();
  const previousDefaultProvider = process.env.LLM_DEFAULT_PROVIDER;
  process.env.LLM_DEFAULT_PROVIDER = 'mock';

  try {
    await withServer(app, async baseUrl => {
      const listed = await jsonRequest(`${baseUrl}/api/goals`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(listed.response.status, 200, JSON.stringify(listed.body));
      const listedGoal = listed.body.goals.find(item => item._id === String(goal._id));
      assert.equal(listedGoal.calculation_freshness.fresh, false);
      assert.equal(listedGoal.recommended_sip, null);

      const afterGet = await Goal.findById(goal._id).lean();
      assert.equal(afterGet.version, persistedBeforeGet.version);
      assert.equal(afterGet.years_remaining, persistedBeforeGet.years_remaining);
      assert.equal(afterGet.recommended_sip, persistedBeforeGet.recommended_sip);
      assert.equal(afterGet.inflation_adjusted_target, persistedBeforeGet.inflation_adjusted_target);
      assert.equal(afterGet.mc_computed_at.getTime(), persistedBeforeGet.mc_computed_at.getTime());
      assert.equal(afterGet.updatedAt.getTime(), persistedBeforeGet.updatedAt.getTime());

      const recalculated = await jsonRequest(`${baseUrl}/api/goals/${goal._id}`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          expectedVersion: persistedBeforeGet.version,
          target_amount: persistedBeforeGet.target_amount,
          current_savings: persistedBeforeGet.current_savings,
        }),
      });
      assert.equal(recalculated.response.status, 200, JSON.stringify(recalculated.body));
      assert.equal(recalculated.body.goal.target_amount, persistedBeforeGet.target_amount);
      assert.equal(recalculated.body.goal.current_savings, persistedBeforeGet.current_savings);
      assert.equal(recalculated.body.goal.years_remaining, 2 / 12);
      assert.equal(recalculated.body.goal.chart_data.at(-1).year, 0.17);
      assert.equal(recalculated.body.goal.calculation_freshness.fresh, true);
      assert.equal(recalculated.body.goal.version, persistedBeforeGet.version + 1);

      const subMinimumTarget = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
      const subMinimumGoal = await Goal.create({
        userId: TEST_USER_ID,
        profileId: profile._id,
        version: 1,
        goal_name: `Sub-month recalculation ${crypto.randomUUID()}`,
        target_amount: 500000,
        target_date: subMinimumTarget,
        current_savings: 10000,
        priority: 'High',
        recommended_sip: 4500,
        years_remaining: 1,
      });
      const beforeRejectedRecalculation = await Goal.findById(subMinimumGoal._id).lean();
      const rejected = await jsonRequest(`${baseUrl}/api/goals/${subMinimumGoal._id}`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          expectedVersion: beforeRejectedRecalculation.version,
          target_amount: beforeRejectedRecalculation.target_amount,
          current_savings: beforeRejectedRecalculation.current_savings,
        }),
      });
      assert.equal(rejected.response.status, 400, JSON.stringify(rejected.body));
      const afterRejectedRecalculation = await Goal.findById(subMinimumGoal._id).lean();
      assert.equal(afterRejectedRecalculation.version, beforeRejectedRecalculation.version);
      assert.equal(afterRejectedRecalculation.recommended_sip, beforeRejectedRecalculation.recommended_sip);
      assert.equal(afterRejectedRecalculation.updatedAt.getTime(), beforeRejectedRecalculation.updatedAt.getTime());
    });
  } finally {
    if (previousDefaultProvider === undefined) delete process.env.LLM_DEFAULT_PROVIDER;
    else process.env.LLM_DEFAULT_PROVIDER = previousDefaultProvider;
  }
});

test('WG-037 Scenario (b): PATCH target_amount recomputes inflation_adjusted_target using exact route formula', async () => {
  const profile = await ensureDb();
  const token = signToken();
  const app = buildTestApp();

  const targetDateObj = new Date();
  targetDateObj.setFullYear(targetDateObj.getFullYear() + 10);
  const targetDateStr = targetDateObj.toISOString().split('T')[0];

  await withServer(app, async (baseUrl) => {
    // 1. Create initial goal
    const { response: createRes, body: createBody } = await jsonRequest(`${baseUrl}/api/goals/create`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        goal_name: 'Home Downpayment 2036',
        target_amount: 1000000,
        target_date: targetDateStr,
        current_savings: 100000,
        profileId: profile._id.toString(),
        priority: 'High',
      }),
    });
    assert.equal(createRes.status, 201);
    const createdGoal = createBody.goal;

    // 2. PATCH target_amount to 2,000,000
    const newTargetAmount = 2000000;
    const { response: patchRes, body: patchBody } = await jsonRequest(`${baseUrl}/api/goals/${createdGoal._id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ target_amount: newTargetAmount, expectedVersion: createdGoal.version }),
    });

    assert.equal(patchRes.status, 200, `PATCH failed with status ${patchRes.status}`);
    assertRuntimeResponseMatchesContract({
      method: 'PATCH', path: '/api/goals/{goalId}', status: patchRes.status,
      contentType: patchRes.headers.get('content-type'), body: patchBody,
    });
    assert.ok(patchBody.success, 'PATCH response must indicate success');

    const updatedGoal = patchBody.goal;
    assert.equal(updatedGoal.target_amount, newTargetAmount);

    // Recalculation uses the backend's current month-based horizon and
    // versioned inflation assumption, both returned with the goal result.
    assert.equal(updatedGoal.years_remaining, createdGoal.years_remaining);
    assert.equal(updatedGoal.inflation_assumption, createdGoal.inflation_assumption);
    const expectedInflationTarget = Math.round(
      newTargetAmount * (1 + updatedGoal.inflation_assumption) ** updatedGoal.years_remaining,
    );

    assert.equal(
      updatedGoal.inflation_adjusted_target,
      expectedInflationTarget,
      `PATCH inflation_adjusted_target (${updatedGoal.inflation_adjusted_target}) must match exact formula calculation (${expectedInflationTarget})`
    );
  });
});

test('WG-037 Scenario (c): PATCH current_savings reduces/maintains SIP and leaves inflation_adjusted_target unchanged', async () => {
  const profile = await ensureDb();
  const token = signToken();
  const app = buildTestApp();

  const targetDateObj = new Date();
  targetDateObj.setFullYear(targetDateObj.getFullYear() + 10);
  const targetDateStr = targetDateObj.toISOString().split('T')[0];

  await withServer(app, async (baseUrl) => {
    // 1. Create goal
    const { response: createRes, body: createBody } = await jsonRequest(`${baseUrl}/api/goals/create`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        goal_name: 'Child Education 2036',
        target_amount: 1500000,
        target_date: targetDateStr,
        current_savings: 50000,
        profileId: profile._id.toString(),
        priority: 'High',
      }),
    });
    assert.equal(createRes.status, 201);
    const initialGoal = createBody.goal;

    const initialInflationTarget = initialGoal.inflation_adjusted_target;
    const initialSip = initialGoal.recommended_sip;

    // 2. PATCH current_savings from 50,000 to 400,000 (higher savings)
    const { response: patchRes, body: patchBody } = await jsonRequest(`${baseUrl}/api/goals/${initialGoal._id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ current_savings: 400000, expectedVersion: initialGoal.version }),
    });

    assert.equal(patchRes.status, 200);
    const updatedGoal = patchBody.goal;

    assert.equal(updatedGoal.current_savings, 400000);
    assert.equal(
      updatedGoal.inflation_adjusted_target,
      initialInflationTarget,
      'PATCHing only current_savings must leave inflation_adjusted_target unchanged'
    );
    assert.ok(
      updatedGoal.recommended_sip <= initialSip,
      `Higher current savings (${updatedGoal.current_savings}) must yield a lower or equal recommended SIP (${updatedGoal.recommended_sip} vs ${initialSip})`
    );
  });
});

test('WG-037 Scenario (d): PATCH priority-only leaves inflation_adjusted_target, recommended_sip, and monte_carlo_summary unchanged', async () => {
  const profile = await ensureDb();
  const token = signToken();
  const app = buildTestApp();

  const targetDateObj = new Date();
  targetDateObj.setFullYear(targetDateObj.getFullYear() + 10);
  const targetDateStr = targetDateObj.toISOString().split('T')[0];

  await withServer(app, async (baseUrl) => {
    // 1. Create goal
    const { response: createRes, body: createBody } = await jsonRequest(`${baseUrl}/api/goals/create`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        goal_name: 'Emergency Fund 2036',
        target_amount: 500000,
        target_date: targetDateStr,
        current_savings: 100000,
        profileId: profile._id.toString(),
        priority: 'Medium',
      }),
    });
    assert.equal(createRes.status, 201);
    const initialGoal = createBody.goal;

    // 2. PATCH priority only (priority: 'Low')
    const { response: patchRes, body: patchBody } = await jsonRequest(`${baseUrl}/api/goals/${initialGoal._id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ priority: 'Low', expectedVersion: initialGoal.version }),
    });

    assert.equal(patchRes.status, 200);
    const updatedGoal = patchBody.goal;

    assert.equal(updatedGoal.priority, 'Low');
    assert.equal(
      updatedGoal.inflation_adjusted_target,
      initialGoal.inflation_adjusted_target,
      'Priority-only PATCH must not alter inflation_adjusted_target'
    );
    assert.equal(
      updatedGoal.recommended_sip,
      initialGoal.recommended_sip,
      'Priority-only PATCH must not alter recommended_sip'
    );
    assert.equal(
      updatedGoal.monte_carlo_summary.p50,
      initialGoal.monte_carlo_summary.p50,
      'Priority-only PATCH must not recompute monte_carlo_summary'
    );
  });
});
