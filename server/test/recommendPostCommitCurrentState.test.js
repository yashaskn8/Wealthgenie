import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import recommendRoutes from '../routes/recommend.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { claimAdvisoryIdempotency } from '../middleware/idempotency.js';
import FinancialProfile from '../models/FinancialProfile.js';
import FinancialProfileState from '../models/FinancialProfileState.js';
import Recommendation from '../models/Recommendation.js';
import RecommendationAllocationRevision from '../models/RecommendationAllocationRevision.js';
import RecommendationState from '../models/RecommendationState.js';
import AuditRecord from '../models/AuditRecord.js';
import AuditChainHead from '../models/AuditChainHead.js';
import IdempotencyKey from '../models/IdempotencyKey.js';
import User from '../models/User.js';
import { persistAdvisoryAtomically } from '../services/advisoryPersistence.js';
import { installFinancialStateTestHook } from '../services/financialStateTestHooks.js';
import { verifyAuditChain } from '../services/auditChain.js';
import { buildRecommendationProfileHash, RECOMMENDATION_POLICY_VERSION } from '../services/recommendationProfile.js';
import { getCurrentRegulatoryRuleVersion } from '../services/taxEngine.js';
import {
  PROJECTION_ASSUMPTION_POLICY_HASH,
  PROJECTION_ASSUMPTION_SOURCE,
  PROJECTION_ASSUMPTION_VERSION,
} from '../services/instrumentConstants.js';
import { canonicalProfile } from './helpers/canonicalProfile.js';
import { setupTestDatabase, teardownTestDatabase } from './helpers/mongoTestHelper.js';

const JWT_SECRET = 'recommend-post-commit-current-state-test-secret';
process.env.JWT_SECRET = JWT_SECRET;
process.env.NODE_ENV = 'test';
const authenticatedUserIds = new Set();

function createBarrier() {
  let markEntered;
  let open;
  const entered = new Promise(resolve => { markEntered = resolve; });
  const released = new Promise(resolve => { open = resolve; });
  return {
    entered,
    async pause() { markEntered(); await released; },
    release() { open(); },
  };
}

function profileDocument(userId, profileId, overrides = {}) {
  return {
    _id: profileId,
    userId,
    ...canonicalProfile(overrides),
    recommendationProfileVersion: 'financial-profile-1.1.0',
    version: 1,
    financialStateFence: 0,
  };
}

function makeOperation({ userId, profileId, profileInput, claim, label }) {
  const recommendationId = new mongoose.Types.ObjectId();
  const auditId = new mongoose.Types.ObjectId();
  const profileInputHash = buildRecommendationProfileHash(profileInput, { modelVersion: 'rule_fallback' });
  const instruments = [{
    id: `post-commit-${label}`,
    name: `Post-commit fixture ${label}`,
    type: 'Equity_MF',
    assetClass: 'Equity',
    nominalReturn: 12,
    effectiveYield: 12,
    postTaxReturn: null,
    returnBasis: 'PRE_TAX_NOMINAL',
    returnDataClass: 'MODEL_ASSUMPTION',
    returnAssumptionVersion: PROJECTION_ASSUMPTION_VERSION,
    returnAssumptionHash: PROJECTION_ASSUMPTION_POLICY_HASH,
    returnSource: PROJECTION_ASSUMPTION_SOURCE,
    observedMarketFact: false,
    providerForecast: false,
    expenseRatio: 0.005,
    riskLevel: 'Medium',
    riskScore: 3,
    lockIn: 0,
    tags: ['Wealth Growth'],
    score: 80,
    scoreFactors: {
      expectedReturn: 60,
      riskFit: 100,
      liquidity: 80,
      goalFit: 100,
      horizonFit: 100,
      cost: 90,
    },
    allocation_pct: 100,
    allocationWeight: 1,
  }];
  const response = {
    recommendationId,
    profileId,
    audit_id: auditId,
    model_version: 'rule_fallback',
    instruments,
  };
  return {
    recommendation: {
      _id: recommendationId,
      userId,
      profileId,
      instruments,
      advisoryText: null,
      confidenceScores: {},
      mlFallback: true,
      modelVersion: 'rule_fallback',
      regulatoryRuleVersion: getCurrentRegulatoryRuleVersion(),
      profileInputHash,
      profileVersion: 1,
      recommendationPolicyVersion: RECOMMENDATION_POLICY_VERSION,
      returnAssumptionHash: PROJECTION_ASSUMPTION_POLICY_HASH,
    },
    auditRecord: {
      _id: auditId,
      userId,
      profileId,
      recommendationId,
      correlationId: `post-commit-${label}`,
      traceId: '',
      version_id: 'rule_fallback',
      regulatory_rule_version: getCurrentRegulatoryRuleVersion(),
      input_hash: `input-${label}`,
      inputs: {
        financial_profile_schema_version: 'financial-profile-1.1.0',
        recommendation_policy_version: RECOMMENDATION_POLICY_VERSION,
        age: profileInput.age,
        monthly_take_home: profileInput.monthlyTakeHome,
        monthly_savings: profileInput.monthlySavings,
      },
      recommendations: { instruments: [{ id: instruments[0].id, allocationWeight: 1 }] },
      cited_rag_chunk_ids: [],
      engine: 'rule_fallback',
      timestamp: new Date(),
    },
    response,
    idempotencyClaim: claim,
  };
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/recommend', recommendRoutes);
  app.use(errorHandler);
  return app;
}

function authToken(userId) {
  return jwt.sign({ userId: String(userId), email: 'post-commit@example.test' }, JWT_SECRET, { expiresIn: '5m' });
}

async function clearUser(userId) {
  await Promise.all([
    User.deleteOne({ _id: userId }),
    FinancialProfile.deleteMany({ userId }),
    FinancialProfileState.deleteMany({ userId }),
    Recommendation.deleteMany({ userId }),
    RecommendationAllocationRevision.collection.deleteMany({ userId }),
    RecommendationState.deleteMany({ userId }),
    AuditRecord.collection.deleteMany({ userId }),
    AuditChainHead.deleteMany({ _id: userId }),
    IdempotencyKey.deleteMany({ userId }),
  ]);
}

test.before(async () => {
  await setupTestDatabase({ requireReplicaSet: true });
  await Promise.all([
    User.init(),
    FinancialProfile.init(),
    FinancialProfileState.init(),
    Recommendation.init(),
    RecommendationAllocationRevision.init(),
    RecommendationState.init(),
    AuditRecord.init(),
    IdempotencyKey.init(),
  ]);
});

test.after(async () => {
  await Promise.all([...authenticatedUserIds].map(clearUser));
  await teardownTestDatabase();
});

test('committed recommendation reconciles and replays as the user current profile after cross-profile promotion', async () => {
  const userId = new mongoose.Types.ObjectId();
  const profileAId = new mongoose.Types.ObjectId();
  const profileBId = new mongoose.Types.ObjectId();
  const profileA = canonicalProfile({ monthlySavings: 20000 });
  const profileB = canonicalProfile({ monthlySavings: 30000 });
  await FinancialProfile.create(profileDocument(userId, profileAId, profileA));
  await FinancialProfileState.create({
    userId,
    currentProfileId: profileAId,
    revision: 1,
    promotionFence: 0,
    resolutionStatus: 'CURRENT',
  });

  const keyA = 'cross-profile-commit-A';
  const claimA = await claimAdvisoryIdempotency({
    key: keyA,
    userId,
    profileId: profileAId,
    payload: { profileId: String(profileAId) },
    operation: 'recommendation.generate',
  });
  const operationA = makeOperation({ userId, profileId: profileAId, profileInput: profileA, claim: claimA, label: 'A' });
  const barrier = createBarrier();
  const pendingA = persistAdvisoryAtomically({
    ...operationA,
    profileStateBinding: { revision: 1, currentProfileId: String(profileAId) },
    testHooks: { afterCommitBeforeReconcile: barrier.pause },
  });

  await barrier.entered;
  const idA = String(operationA.recommendation._id);
  assert.equal(await Recommendation.countDocuments({ _id: idA, userId }), 1, 'A is durable before its response is released');
  assert.equal(String((await FinancialProfileState.findOne({ userId }).lean()).currentProfileId), String(profileAId));

  const claimB = await claimAdvisoryIdempotency({
    key: 'cross-profile-promotion-B',
    userId,
    profileId: profileBId,
    payload: { profileId: String(profileBId) },
    operation: 'recommendation.generate',
  });
  const operationB = makeOperation({ userId, profileId: profileBId, profileInput: profileB, claim: claimB, label: 'B' });
  const profileBRecord = profileDocument(userId, profileBId, profileB);
  await persistAdvisoryAtomically({
    ...operationB,
    profile: profileBRecord,
    profileStateBinding: { revision: 1, currentProfileId: String(profileAId) },
  });

  barrier.release();
  const responseA = await pendingA;
  const idB = String(operationB.recommendation._id);
  assert.equal(responseA.response_state, 'CURRENT');
  assert.equal(responseA.calculation_freshness.fresh, true);
  assert.equal(responseA.profileId, String(profileBId));
  assert.equal(responseA.current_profile_id, String(profileBId));
  assert.equal(String(responseA.recommendationId), idB);
  assert.deepEqual(responseA.instruments.map(item => item.id), ['post-commit-B']);
  assert.deepEqual(responseA.operation_result, {
    committed: true,
    generated_profile_id: String(profileAId),
    generated_recommendation_id: idA,
    superseded_before_response: true,
  });

  // Exercise the real route: this same-key request names now-stale profile A,
  // but the durable completed operation is recovered before stale rejection.
  const app = createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    authenticatedUserIds.add(userId);
    await User.create({
      _id: userId,
      name: 'Post-commit test user',
      email: `${userId}@post-commit.example.test`,
      passwordHash: 'test-only-not-a-real-password-hash',
      role: 'user',
    });
    const result = await fetch(`http://127.0.0.1:${server.address().port}/api/recommend`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${authToken(userId)}`,
        'idempotency-key': keyA,
      },
      body: JSON.stringify({ profileId: String(profileAId) }),
    });
    const body = await result.json();
    assert.equal(result.status, 200, JSON.stringify(body));
    assert.match(result.headers.get('x-cache-lookup') || '', /Idempotent/);
    assert.equal(body.response_state, 'CURRENT');
    assert.equal(body.calculation_freshness.fresh, true);
    assert.equal(body.profileId, String(profileBId));
    assert.equal(body.current_profile_id, String(profileBId));
    assert.equal(String(body.recommendationId), idB);
    assert.deepEqual(body.instruments.map(item => item.id), ['post-commit-B']);

    const staleKeyResult = await fetch(`http://127.0.0.1:${server.address().port}/api/recommend`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${authToken(userId)}`,
        'idempotency-key': 'stale-fresh-key-01',
      },
      body: JSON.stringify({ profileId: String(profileAId) }),
    });
    assert.equal(staleKeyResult.status, 409);
    assert.equal(await IdempotencyKey.countDocuments({ userId, status: 'LOCK' }), 0, 'stale new request releases its claim');
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }

  assert.equal(await Recommendation.countDocuments({ userId }), 2);
  assert.equal(await RecommendationAllocationRevision.countDocuments({ userId }), 2);
  assert.equal(await AuditRecord.countDocuments({ userId }), 2);
  assert.equal((await IdempotencyKey.find({ userId }).lean()).filter(row => row.status === 'DONE').length, 2);
  const auditVerification = await verifyAuditChain(userId);
  assert.equal(auditVerification.valid, true, JSON.stringify(auditVerification.errors));
  assert.equal(auditVerification.checkedRecords, 2);
  await clearUser(userId);
});

test('post-commit reconciliation retries when the current profile advances after its first pointer read', async () => {
  const userId = new mongoose.Types.ObjectId();
  const profileAId = new mongoose.Types.ObjectId();
  const profileBId = new mongoose.Types.ObjectId();
  const profileA = canonicalProfile({ monthlySavings: 21000 });
  const profileB = canonicalProfile({ monthlySavings: 31000 });
  await FinancialProfile.create(profileDocument(userId, profileAId, profileA));
  await FinancialProfileState.create({
    userId,
    currentProfileId: profileAId,
    revision: 1,
    promotionFence: 0,
    resolutionStatus: 'CURRENT',
  });

  const claimA = await claimAdvisoryIdempotency({
    key: 'pointer-read-race-A',
    userId,
    profileId: profileAId,
    payload: { profileId: String(profileAId) },
    operation: 'recommendation.generate',
  });
  const operationA = makeOperation({ userId, profileId: profileAId, profileInput: profileA, claim: claimA, label: 'A' });
  const barrier = createBarrier();
  let pausedA = false;
  const uninstallHook = installFinancialStateTestHook(async (boundary, context) => {
    if (!pausedA && boundary === 'post_commit.after_current_profile_read'
        && context.profileId === String(profileAId)) {
      pausedA = true;
      await barrier.pause();
    }
  });

  let responseA;
  try {
    const pendingA = persistAdvisoryAtomically({
      ...operationA,
      profileStateBinding: { revision: 1, currentProfileId: String(profileAId) },
    });
    await barrier.entered;
    assert.equal(await Recommendation.countDocuments({ _id: operationA.recommendation._id, userId }), 1);

    const claimB = await claimAdvisoryIdempotency({
      key: 'pointer-read-race-B',
      userId,
      profileId: profileBId,
      payload: { profileId: String(profileBId) },
      operation: 'recommendation.generate',
    });
    const operationB = makeOperation({ userId, profileId: profileBId, profileInput: profileB, claim: claimB, label: 'B' });
    await persistAdvisoryAtomically({
      ...operationB,
      profile: profileDocument(userId, profileBId, profileB),
      profileStateBinding: { revision: 1, currentProfileId: String(profileAId) },
    });

    barrier.release();
    responseA = await pendingA;

    const canonicalProfileState = await FinancialProfileState.findOne({ userId }).lean();
    const canonicalRecommendationState = await RecommendationState.findOne({ userId, profileId: profileBId }).lean();
    assert.equal(String(canonicalProfileState.currentProfileId), String(profileBId));
    assert.equal(responseA.response_state, 'CURRENT');
    assert.equal(responseA.calculation_freshness.fresh, true);
    assert.equal(responseA.profileId, String(profileBId));
    assert.equal(responseA.current_profile_id, String(profileBId));
    assert.equal(String(responseA.recommendationId), String(canonicalRecommendationState.currentRecommendationId));
    assert.equal(String(responseA.allocation_revision_id), String(canonicalRecommendationState.currentAllocationRevisionId));
    assert.equal(responseA.portfolio_fingerprint, canonicalRecommendationState.portfolioFingerprint);
    assert.deepEqual(responseA.instruments.map(item => item.id), ['post-commit-B']);
    assert.equal(responseA.operation_result.generated_recommendation_id, String(operationA.recommendation._id));
    assert.equal(responseA.operation_result.superseded_before_response, true);
    assert.equal(await Recommendation.countDocuments({ userId }), 2);
    assert.equal(await RecommendationAllocationRevision.countDocuments({ userId }), 2);
    assert.equal(await AuditRecord.countDocuments({ userId }), 2);
    const auditVerification = await verifyAuditChain(userId);
    assert.equal(auditVerification.valid, true, JSON.stringify(auditVerification.errors));
  } finally {
    barrier.release();
    uninstallHook();
  }
  await clearUser(userId);
});

test('post-commit current-profile pointer corruption fails closed without undoing the committed operation', async () => {
  const userId = new mongoose.Types.ObjectId();
  const profileId = new mongoose.Types.ObjectId();
  const profile = canonicalProfile();
  await FinancialProfile.create(profileDocument(userId, profileId, profile));
  await FinancialProfileState.create({
    userId,
    currentProfileId: profileId,
    revision: 1,
    promotionFence: 0,
    resolutionStatus: 'CURRENT',
  });
  const claim = await claimAdvisoryIdempotency({
    key: 'corrupt-current-profile-key',
    userId,
    profileId,
    payload: { profileId: String(profileId) },
    operation: 'recommendation.generate',
  });
  const operation = makeOperation({ userId, profileId, profileInput: profile, claim, label: 'corrupt' });

  await assert.rejects(persistAdvisoryAtomically({
    ...operation,
    profileStateBinding: { revision: 1, currentProfileId: String(profileId) },
    testHooks: { afterCommitBeforeReconcile: () => FinancialProfileState.deleteOne({ userId }) },
  }), error => error.code === 'COMMITTED_BUT_RESPONSE_RECONCILIATION_FAILED' && error.committed === true);
  assert.equal(await Recommendation.countDocuments({ _id: operation.recommendation._id, userId }), 1);
  assert.equal(await RecommendationAllocationRevision.countDocuments({ recommendationId: operation.recommendation._id, userId }), 1);
  assert.equal(await AuditRecord.countDocuments({ recommendationId: operation.recommendation._id, userId }), 1);
  assert.equal((await IdempotencyKey.findById(claim.operationId).lean()).status, 'DONE');
  await assert.rejects(
    claimAdvisoryIdempotency({
      key: 'corrupt-current-profile-key',
      userId,
      profileId,
      payload: { profileId: String(profileId) },
      operation: 'recommendation.generate',
    }),
    error => error.code === 'COMMITTED_BUT_RESPONSE_RECONCILIATION_FAILED',
  );
  assert.equal(await Recommendation.countDocuments({ userId }), 1, 'recovery never duplicates the committed recommendation');
  await clearUser(userId);
});
