import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import goalsRoutes from '../routes/goals.js';
import { errorHandler } from '../middleware/errorHandler.js';
import Goal from '../models/Goal.js';
import User from '../models/User.js';
import FinancialProfile from '../models/FinancialProfile.js';
import FinancialProfileState from '../models/FinancialProfileState.js';
import Recommendation from '../models/Recommendation.js';
import RecommendationAllocationRevision from '../models/RecommendationAllocationRevision.js';
import RecommendationState from '../models/RecommendationState.js';
import { buildRecommendationProfile, buildRecommendationProfileHash, toProfilePersistence } from '../services/recommendationProfile.js';
import { assessSuitabilityRisk } from '../services/riskProfiler.js';
import { runPipeline } from '../services/RecommendationPipeline.js';
import { getCurrentRegulatoryRuleVersion } from '../services/taxEngine.js';
import {
  PROJECTION_ASSUMPTION_POLICY_HASH,
  PROJECTION_ASSUMPTION_SOURCE,
  PROJECTION_ASSUMPTION_VERSION,
} from '../services/instrumentConstants.js';
import { buildPortfolioFingerprint, buildRecommendationFingerprint } from '../services/recommendationFingerprint.js';
import { createManualAllocationRevision, requireFreshRecommendationState } from '../services/recommendationState.js';
import { installFinancialStateTestHook } from '../services/financialStateTestHooks.js';
import { setupTestDatabase, teardownTestDatabase } from './helpers/mongoTestHelper.js';
import { canonicalProfilePayload } from './helpers/canonicalProfile.js';

const JWT_SECRET = 'goal-post-commit-response-test-secret';
process.env.JWT_SECRET = JWT_SECRET;
process.env.NODE_ENV = 'test';

let app;
let server;
let baseUrl;
const userId = new mongoose.Types.ObjectId();

function signToken() {
  return jwt.sign({ userId: String(userId), jti: crypto.randomUUID() }, JWT_SECRET, { expiresIn: '1h' });
}

function createBarrier() {
  let markEntered;
  let release;
  const entered = new Promise(resolve => { markEntered = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  return {
    entered,
    async pause() { markEntered(); await released; },
    release() { release(); },
  };
}

async function createFinancialFixture() {
  const profile = buildRecommendationProfile(canonicalProfilePayload());
  const suitability = assessSuitabilityRisk(profile);
  const storedProfile = await FinancialProfile.create({
    userId,
    ...toProfilePersistence(profile, suitability),
    version: 1,
  });
  const modelVersion = 'goal-post-commit-test-model-1';
  const pipeline = runPipeline(profile, { model_version: modelVersion, confidence_scores: {} });
  const recommendationId = new mongoose.Types.ObjectId();
  const profileInputHash = buildRecommendationProfileHash(storedProfile.toObject(), { modelVersion });
  const recommendation = await Recommendation.create({
    _id: recommendationId,
    userId,
    profileId: storedProfile._id,
    instruments: pipeline.instruments,
    advisoryText: null,
    advisoryMetadata: { status: 'PENDING' },
    confidenceScores: {},
    mlFallback: true,
    modelVersion,
    regulatoryRuleVersion: getCurrentRegulatoryRuleVersion(),
    profileVersion: storedProfile.version,
    profileInputHash,
    recommendationGeneration: 1,
    recommendationPolicyVersion: 'suitability-freeze-1.1.0',
    returnAssumptionHash: PROJECTION_ASSUMPTION_POLICY_HASH,
    responseSnapshot: {
      profileId: String(storedProfile._id),
      recommendationId: String(recommendationId),
      instruments: pipeline.instruments,
      model_version: modelVersion,
    },
  });
  const instruments = recommendation.instruments.map(instrument => instrument.toObject());
  const portfolioFingerprint = buildPortfolioFingerprint(instruments);
  const returnAssumptionVersion = instruments[0].returnAssumptionVersion || PROJECTION_ASSUMPTION_VERSION;
  const returnAssumptionHash = instruments[0].returnAssumptionHash || PROJECTION_ASSUMPTION_POLICY_HASH;
  const returnAssumptionSource = instruments[0].returnSource || PROJECTION_ASSUMPTION_SOURCE;
  const recommendationFingerprint = buildRecommendationFingerprint({
    recommendationId,
    profileInputHash,
    modelVersion,
    recommendationPolicyVersion: recommendation.recommendationPolicyVersion,
    regulatoryRuleVersion: recommendation.regulatoryRuleVersion,
    returnAssumptionVersion,
    returnAssumptionHash,
    allocationRevision: 1,
    instruments,
  });
  const revision = await RecommendationAllocationRevision.create({
    recommendationId,
    profileId: storedProfile._id,
    userId,
    revision: 1,
    previousRevision: null,
    source: 'ORIGINAL_RECOMMENDATION',
    instruments,
    profileInputHash,
    profileVersion: storedProfile.version,
    modelVersion,
    recommendationPolicyVersion: recommendation.recommendationPolicyVersion,
    regulatoryRuleVersion: recommendation.regulatoryRuleVersion,
    returnAssumptionVersion,
    returnAssumptionHash,
    returnAssumptionSource,
    portfolioFingerprint,
    recommendationFingerprint,
  });
  await RecommendationState.create({
    userId,
    profileId: storedProfile._id,
    currentRecommendationId: recommendationId,
    currentAllocationRevision: 1,
    currentAllocationRevisionId: revision._id,
    generationRevision: recommendation.recommendationGeneration,
    profileInputHash,
    profileVersion: storedProfile.version,
    portfolioFingerprint,
    returnAssumptionVersion,
    returnAssumptionHash,
    returnAssumptionSource,
  });
  await FinancialProfileState.create({
    userId,
    currentProfileId: storedProfile._id,
    revision: 1,
    promotionFence: 0,
    resolutionStatus: 'CURRENT',
  });
  return storedProfile;
}

async function createGoal(profile) {
  const response = await fetch(`${baseUrl}/api/goals/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${signToken()}`,
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify({
      goal_name: 'Post-commit response freshness race',
      target_amount: 500000,
      target_date: new Date(Date.now() + 4 * 365.25 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      current_savings: 50000,
      profileId: String(profile._id),
      priority: 'High',
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.goal;
}

function patchGoal(goalId, payload) {
  return fetch(`${baseUrl}/api/goals/${goalId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${signToken()}`,
    },
    body: JSON.stringify(payload),
  });
}

function refreshAdvice(goalId) {
  return fetch(`${baseUrl}/api/goals/${goalId}/refresh-advice`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${signToken()}` },
  });
}

async function deleteGoal(goalId, version) {
  const response = await fetch(`${baseUrl}/api/goals/${goalId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${signToken()}`, 'If-Match': String(version) },
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.deleted, true);
}

async function raceCommittedOperationWithUpdate({ operation }) {
  const profile = await createFinancialFixture();
  const created = await createGoal(profile);
  const goalId = String(created._id);
  const committedVersion = Number(created.version) + 1;
  const barrier = createBarrier();
  let paused = false;
  const boundary = operation === 'advice'
    ? 'goal.advisory.afterCommitBeforeResponse'
    : 'goal.update.afterCommitBeforeResponse';
  const uninstall = installFinancialStateTestHook(async (name, context) => {
    if (name === boundary && !paused
        && (operation === 'advice' || Number(context.goalVersion) === committedVersion)) {
      paused = true;
      await barrier.pause();
    }
  });

  const pending = operation === 'advice'
    ? refreshAdvice(goalId)
    : patchGoal(goalId, { expectedVersion: created.version, priority: 'Critical' });
  try {
    await barrier.entered;
    const winner = await patchGoal(goalId, { expectedVersion: committedVersion, priority: 'Low' });
    const winnerBody = await winner.json();
    assert.equal(winner.status, 200, JSON.stringify(winnerBody));
    assert.equal(winnerBody.goal.version, created.version + 2);
    assert.equal(winnerBody.goal.priority, 'Low');
  } finally {
    barrier.release();
    uninstall();
  }

  const response = await pending;
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  const returnedGoal = operation === 'advice' ? body.goal : body.goal;
  assert.equal(String(returnedGoal._id), goalId);
  assert.equal(returnedGoal.version, created.version + 2, 'the response must re-read the winning owner-scoped version');
  assert.equal(returnedGoal.priority, 'Low', 'the response must not use the operation’s captured vN+1 document');
  assert.equal(returnedGoal.calculation_freshness.fresh, true, 'freshness must be evaluated against the current goal and current financial source');
  if (operation === 'advice') {
    assert.equal(body.operation_result.committed, true);
    assert.equal(body.operation_result.goal_version, committedVersion, 'operation metadata identifies A’s committed version, not B’s current resource version');
    assert.equal(body.operation_result.response_state, 'CURRENT');
    assert.equal(body.gemini_advice, null, 'advice bound to vN+1 must not be presented as advice for vN+2');
    assert.equal(returnedGoal.advisory_freshness.fresh, false);
  }
  assert.equal(await Goal.countDocuments({ _id: goalId, userId }), 1, 'reconciliation must not create a duplicate goal');
  const stored = await Goal.findOne({ _id: goalId, userId }).lean();
  assert.equal(stored.version, created.version + 2, 'A and B each commit exactly one version transition');
  assert.equal(stored.priority, 'Low');
}

async function raceCommittedOperationWithDelete({ operation }) {
  const profile = await createFinancialFixture();
  const created = await createGoal(profile);
  const goalId = String(created._id);
  const committedVersion = Number(created.version) + 1;
  const barrier = createBarrier();
  let paused = false;
  const boundary = operation === 'advice'
    ? 'goal.advisory.afterCommitBeforeResponse'
    : 'goal.update.afterCommitBeforeResponse';
  const uninstall = installFinancialStateTestHook(async (name, context) => {
    if (name === boundary && !paused
        && (operation === 'advice' || Number(context.goalVersion) === committedVersion)) {
      paused = true;
      await barrier.pause();
    }
  });

  const pending = operation === 'advice'
    ? refreshAdvice(goalId)
    : patchGoal(goalId, { expectedVersion: created.version, priority: 'Critical' });
  try {
    await barrier.entered;
    await deleteGoal(goalId, committedVersion);
  } finally {
    barrier.release();
    uninstall();
  }

  const response = await pending;
  const body = await response.json();
  assert.equal(response.status, 409, JSON.stringify(body));
  assert.equal(body.code, 'GOAL_DELETED_AFTER_COMMIT');
  assert.equal(body.details.operation_committed, true);
  assert.equal(body.details.committed_goal_version, committedVersion);
  assert.equal(Object.hasOwn(body, 'goal'), false, 'a deleted resource must never be returned as current/fresh');
  assert.equal(await Goal.countDocuments({ _id: goalId, userId }), 0, 'response reconciliation must not resurrect the deleted goal');
}

test.before(async () => {
  await setupTestDatabase({ requireReplicaSet: true });
  await User.create({
    _id: userId,
    name: 'Goal Post-Commit Test User',
    email: `goal-post-commit-${userId}@example.test`,
    passwordHash: 'test-only-hash',
  });
  app = express();
  app.use(express.json());
  app.use('/api/goals', goalsRoutes);
  app.use(errorHandler);
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.beforeEach(async () => {
  await Promise.all([
    Goal.deleteMany({ userId }),
    FinancialProfile.deleteMany({ userId }),
    FinancialProfileState.deleteMany({ userId }),
    Recommendation.deleteMany({ userId }),
    RecommendationState.deleteMany({ userId }),
    RecommendationAllocationRevision.collection.deleteMany({ userId }),
  ]);
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await User.deleteOne({ _id: userId });
  await teardownTestDatabase();
});

test('committed PATCH reconciles to the latest owner-scoped goal after vN+2 wins', async () => {
  await raceCommittedOperationWithUpdate({ operation: 'patch' });
});

test('goal post-commit snapshot retries when its resource version changes after the snapshot read', async () => {
  const profile = await createFinancialFixture();
  const created = await createGoal(profile);
  const goalId = String(created._id);
  const committedVersion = Number(created.version) + 1;
  const barrier = createBarrier();
  let paused = false;
  const uninstall = installFinancialStateTestHook(async (boundary, context) => {
    if (boundary === 'goal.post_commit.after_resource_read'
        && !paused
        && String(context.goalId) === goalId
        && Number(context.goalVersion) === committedVersion) {
      paused = true;
      await barrier.pause();
    }
  });

  const pendingA = patchGoal(goalId, { expectedVersion: created.version, priority: 'Critical' });
  try {
    await barrier.entered;
    const responseB = await patchGoal(goalId, { expectedVersion: committedVersion, priority: 'Low' });
    const bodyB = await responseB.json();
    assert.equal(responseB.status, 200, JSON.stringify(bodyB));
    assert.equal(bodyB.goal.version, created.version + 2);
    assert.equal(bodyB.goal.priority, 'Low');
  } finally {
    barrier.release();
    uninstall();
  }

  const responseA = await pendingA;
  const bodyA = await responseA.json();
  assert.equal(responseA.status, 200, JSON.stringify(bodyA));
  assert.equal(String(bodyA.goal._id), goalId);
  assert.equal(bodyA.goal.version, created.version + 2);
  assert.equal(bodyA.goal.priority, 'Low', 'A must not return the goal snapshot captured before B committed');
  assert.equal(bodyA.goal.calculation_freshness.fresh, true);
  const stored = await Goal.findOne({ _id: goalId, userId }).lean();
  assert.equal(stored.version, created.version + 2);
  assert.equal(stored.priority, 'Low');
  assert.equal(await Goal.countDocuments({ _id: goalId, userId }), 1);
});

test('goal post-commit snapshot retries when canonical allocation changes after its snapshot read', async () => {
  const profile = await createFinancialFixture();
  const created = await createGoal(profile);
  const goalId = String(created._id);
  const barrier = createBarrier();
  let paused = false;
  const uninstall = installFinancialStateTestHook(async (boundary, context) => {
    if (boundary === 'goal.post_commit.after_resource_read'
        && !paused
        && String(context.goalId) === goalId
        && Number(context.goalVersion) === Number(created.version) + 1) {
      paused = true;
      await barrier.pause();
    }
  });

  const pendingA = patchGoal(goalId, { expectedVersion: created.version, priority: 'Critical' });
  try {
    await barrier.entered;
    const state = await requireFreshRecommendationState({ userId, profileId: profile._id });
    const instruments = state.currentAllocation.instruments.map(instrument => (
      typeof instrument.toObject === 'function' ? instrument.toObject() : { ...instrument }
    ));
    const revisionB = await createManualAllocationRevision({
      userId,
      profileId: profile._id,
      recommendationId: state.recommendation._id,
      expectedRecommendationId: state.recommendation._id,
      expectedRevision: state.allocationRevision.revision,
      expectedPortfolioFingerprint: state.portfolioFingerprint,
      instruments,
      correlationId: 'goal-post-commit-source-revision-race',
    });
    assert.equal(revisionB.revision.revision, 2, 'the competing allocation must durably become revision 2');
  } finally {
    barrier.release();
    uninstall();
  }

  const responseA = await pendingA;
  const bodyA = await responseA.json();
  assert.equal(responseA.status, 200, JSON.stringify(bodyA));
  assert.equal(bodyA.goal.version, Number(created.version) + 1);
  assert.equal(bodyA.goal.priority, 'Critical');
  assert.equal(bodyA.goal.calculation_freshness.fresh, false);
  assert.ok(bodyA.goal.calculation_freshness.reasonCodes.includes('STALE_ALLOCATION'));
  assert.equal(bodyA.goal.recommended_sip, null, 'old calculated values must not be returned as current');
  assert.equal(bodyA.goal.source_provenance.allocationRevision, 1, 'historical calculation provenance remains explicit');
  assert.equal((await RecommendationState.findOne({ userId, profileId: profile._id }).lean()).currentAllocationRevision, 2);
  assert.equal(await Goal.countDocuments({ _id: goalId, userId }), 1);
});

test('committed refresh-advice does not return vN+1 as current after vN+2 wins', async () => {
  await raceCommittedOperationWithUpdate({ operation: 'advice' });
});

test('committed PATCH reports the later deletion without resurrecting captured goal data', async () => {
  await raceCommittedOperationWithDelete({ operation: 'patch' });
});

test('committed refresh-advice reports the later deletion without returning stale advice', async () => {
  await raceCommittedOperationWithDelete({ operation: 'advice' });
});
