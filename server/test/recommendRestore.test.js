import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import recommendRoutes, { persistAdvisoryIfCurrent } from '../routes/recommend.js';
import projectionRoutes from '../routes/projection.js';
import { errorHandler } from '../middleware/errorHandler.js';
import FinancialProfile from '../models/FinancialProfile.js';
import FinancialProfileState from '../models/FinancialProfileState.js';
import Recommendation from '../models/Recommendation.js';
import RecommendationAllocationRevision from '../models/RecommendationAllocationRevision.js';
import RecommendationState from '../models/RecommendationState.js';
import AuditRecord from '../models/AuditRecord.js';
import AuditChainHead from '../models/AuditChainHead.js';
import IdempotencyKey from '../models/IdempotencyKey.js';
import User from '../models/User.js';
import { claimAdvisoryIdempotency } from '../middleware/idempotency.js';
import { persistAdvisoryAtomically } from '../services/advisoryPersistence.js';
import { createManualAllocationRevision, requireFreshRecommendationState } from '../services/recommendationState.js';
import { verifyAuditChain } from '../services/auditChain.js';
import { installFinancialStateTestHook } from '../services/financialStateTestHooks.js';
import {
  buildRecommendationProfile,
  buildRecommendationProfileHash,
  toProfilePersistence,
  RECOMMENDATION_POLICY_VERSION,
} from '../services/recommendationProfile.js';
import { assessSuitabilityRisk } from '../services/riskProfiler.js';
import { getCurrentRegulatoryRuleVersion } from '../services/taxEngine.js';
import { runPipeline } from '../services/RecommendationPipeline.js';
import Goal from '../models/Goal.js';
import goalsRoutes, { _getBlendedPortfolioMetrics } from '../routes/goals.js';
import { setupTestDatabase, teardownTestDatabase } from './helpers/mongoTestHelper.js';
import { canonicalProfilePayload } from './helpers/canonicalProfile.js';
import { ProviderManager } from '../services/providerAbstraction.js';
import { buildPortfolioFingerprint, buildRecommendationFingerprint } from '../services/recommendationFingerprint.js';
import { assertFetchResponseMatchesOpenApi } from './helpers/openapiRuntimeContract.js';
import {
  PROJECTION_ASSUMPTION_POLICY_HASH,
  PROJECTION_ASSUMPTION_SOURCE,
  PROJECTION_ASSUMPTION_VERSION,
} from '../services/instrumentConstants.js';

const JWT_SECRET = 'recommendation-restore-test-secret';
process.env.JWT_SECRET = JWT_SECRET;
process.env.NODE_ENV = 'test';

let app;
let server;
let baseUrl;
const userA = new mongoose.Types.ObjectId();
const userB = new mongoose.Types.ObjectId();

function signToken(userId) {
  return jwt.sign({ userId: String(userId), jti: crypto.randomUUID() }, JWT_SECRET, { expiresIn: '1h' });
}

function authenticatedUserFixture(userId, label) {
  return {
    _id: userId,
    name: `Recommendation restore test user ${label}`,
    email: `${userId}@recommend-restore.example.test`,
    passwordHash: 'test-only-not-a-real-password-hash',
    role: 'user',
  };
}

async function createFixture({ userId = userA, stale = false, regulatoryRuleVersion = getCurrentRegulatoryRuleVersion() } = {}) {
  const profile = buildRecommendationProfile(canonicalProfilePayload());
  const suitability = assessSuitabilityRisk(profile);
  const storedProfile = await FinancialProfile.create({
    userId,
    ...toProfilePersistence(profile, suitability),
    version: 1,
  });
  const modelVersion = 'restore-test-model-1';
  const pipeline = runPipeline(profile, { model_version: modelVersion, confidence_scores: {} });
  const recommendationId = new mongoose.Types.ObjectId();
  const auditId = new mongoose.Types.ObjectId();
  const profileInputHash = buildRecommendationProfileHash(storedProfile.toObject(), { modelVersion });
  const responseSnapshot = {
    profileId: String(storedProfile._id),
    recommendationId: String(recommendationId),
    audit_id: String(auditId),
    audit_hash: 'a'.repeat(64),
    instruments: pipeline.instruments,
    model_version: modelVersion,
    recommendation_policy_version: 'suitability-freeze-1.0.0',
    financial_profile_schema_version: 'financial-profile-1.0.0',
    return_basis: 'PRE_TAX_NOMINAL',
    final_risk_tier: suitability.finalRisk,
    advisory_text: null,
    advisory_explanation: { status: 'PENDING' },
  };
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
    regulatoryRuleVersion,
    profileVersion: storedProfile.version ?? 1,
    profileInputHash: stale ? 'b'.repeat(64) : profileInputHash,
    recommendationGeneration: 1,
    recommendationPolicyVersion: 'suitability-freeze-1.2.0',
    returnAssumptionHash: PROJECTION_ASSUMPTION_POLICY_HASH,
    responseSnapshot,
  });
  await createCanonicalState(recommendation);
  await FinancialProfileState.create({
    userId, currentProfileId: storedProfile._id, revision: 1, promotionFence: 0, resolutionStatus: 'CURRENT',
  });
  return storedProfile;
}

async function createCanonicalState(recommendation) {
  const instruments = recommendation.instruments.map(instrument => instrument.toObject());
  const portfolioFingerprint = buildPortfolioFingerprint(instruments);
  const returnAssumptionVersion = instruments[0].returnAssumptionVersion || PROJECTION_ASSUMPTION_VERSION;
  const returnAssumptionHash = instruments[0].returnAssumptionHash || PROJECTION_ASSUMPTION_POLICY_HASH;
  const recommendationFingerprint = buildRecommendationFingerprint({
    recommendationId: recommendation._id,
    profileInputHash: recommendation.profileInputHash,
    modelVersion: recommendation.modelVersion,
    recommendationPolicyVersion: recommendation.recommendationPolicyVersion,
    regulatoryRuleVersion: recommendation.regulatoryRuleVersion,
    returnAssumptionVersion,
    returnAssumptionHash,
    allocationRevision: 1,
    instruments,
  });
  const revision = await RecommendationAllocationRevision.create({
    recommendationId: recommendation._id,
    profileId: recommendation.profileId,
    userId: recommendation.userId,
    revision: 1,
    previousRevision: null,
    source: 'ORIGINAL_RECOMMENDATION',
    instruments,
    profileInputHash: recommendation.profileInputHash,
    profileVersion: recommendation.profileVersion,
    modelVersion: recommendation.modelVersion,
    recommendationPolicyVersion: recommendation.recommendationPolicyVersion,
    regulatoryRuleVersion: recommendation.regulatoryRuleVersion,
    returnAssumptionVersion,
    returnAssumptionHash,
    returnAssumptionSource: instruments[0].returnSource || PROJECTION_ASSUMPTION_SOURCE,
    portfolioFingerprint,
    recommendationFingerprint,
  });
  await RecommendationState.create({
    userId: recommendation.userId,
    profileId: recommendation.profileId,
    currentRecommendationId: recommendation._id,
    currentAllocationRevision: 1,
    currentAllocationRevisionId: revision._id,
    generationRevision: recommendation.recommendationGeneration,
    profileInputHash: recommendation.profileInputHash,
    profileVersion: recommendation.profileVersion,
    portfolioFingerprint,
    returnAssumptionVersion: revision.returnAssumptionVersion,
    returnAssumptionHash: revision.returnAssumptionHash,
    returnAssumptionSource: revision.returnAssumptionSource,
  });
  return { revision, portfolioFingerprint };
}

async function createAdvisoryLifecycleFixture() {
  const profile = buildRecommendationProfile(canonicalProfilePayload());
  const suitability = assessSuitabilityRisk(profile);
  const storedProfile = await FinancialProfile.create({
    userId: userA,
    ...toProfilePersistence(profile, suitability),
    version: 1,
  });
  const modelVersion = 'restore-advisory-test-model-1';
  const pipeline = runPipeline(profile, { model_version: modelVersion, confidence_scores: {} });
  const recommendationId = new mongoose.Types.ObjectId();
  const auditId = new mongoose.Types.ObjectId();
  const profileInputHash = buildRecommendationProfileHash(storedProfile.toObject(), { modelVersion });
  const responseSnapshot = {
    profileId: String(storedProfile._id),
    recommendationId: String(recommendationId),
    audit_id: String(auditId),
    audit_hash: 'b'.repeat(64),
    instruments: pipeline.instruments,
    model_version: modelVersion,
    financial_profile_schema_version: 'financial-profile-1.0.0',
    return_basis: 'PRE_TAX_NOMINAL',
    final_risk_tier: suitability.finalRisk,
    advisory_text: 'snapshot explanation',
    advisory_explanation: {
      status: 'PENDING',
      provider: 'snapshot-provider',
    },
  };
  const recommendation = await Recommendation.create({
    _id: recommendationId,
    userId: userA,
    profileId: storedProfile._id,
    instruments: pipeline.instruments,
    advisoryText: 'generated explanation',
    advisoryMetadata: {
      status: 'READY',
      provider: 'current-provider',
      model: 'current-model',
      prompt_version: 'prompt-2',
      grounding_version: 'grounding-2',
      evidence_ids_used: ['E_CURRENT'],
      unavailable_facts: ['CURRENT_FACT_UNAVAILABLE'],
      citations: [{ id: 'E_CURRENT', title: 'Current evidence' }],
      validation_status: 'VALID',
      generated_at: '2026-09-21T00:00:00.000Z',
    },
    confidenceScores: {},
    mlFallback: true,
    modelVersion,
    regulatoryRuleVersion: getCurrentRegulatoryRuleVersion(),
    profileVersion: storedProfile.version ?? 1,
    profileInputHash,
    recommendationGeneration: 1,
    recommendationPolicyVersion: 'suitability-freeze-1.2.0',
    returnAssumptionHash: PROJECTION_ASSUMPTION_POLICY_HASH,
    responseSnapshot,
  });
  const state = await createCanonicalState(recommendation);
  await FinancialProfileState.create({
    userId: userA, currentProfileId: storedProfile._id, revision: 1, promotionFence: 0, resolutionStatus: 'CURRENT',
  });
  await Recommendation.updateOne({ _id: recommendationId }, { $set: {
    advisoryMetadata: {
      status: 'READY',
      provider: 'current-provider',
      model: 'current-model',
      prompt_version: 'prompt-2',
      grounding_version: 'grounding-2',
      evidence_ids_used: ['E_CURRENT'],
      unavailable_facts: ['CURRENT_FACT_UNAVAILABLE'],
      citations: [{ id: 'E_CURRENT', title: 'Current evidence' }],
      validation_status: 'VALID',
      generated_at: '2026-09-21T00:00:00.000Z',
      recommendationId: String(recommendation._id),
      profileId: String(recommendation.profileId),
      allocationRevision: 1,
      allocationRevisionId: String(state.revision._id),
      portfolioFingerprint: state.portfolioFingerprint,
      profileInputHash,
      recommendationPolicyVersion: recommendation.recommendationPolicyVersion,
      regulatoryRuleVersion: recommendation.regulatoryRuleVersion,
      returnAssumptionHash: recommendation.returnAssumptionHash,
      recommendationFingerprint: state.revision.recommendationFingerprint,
      profileVersion: storedProfile.version,
      generatedAt: new Date('2026-09-21T00:00:00.000Z'),
    },
  } });
  return { storedProfile, recommendationId, responseSnapshot };
}

async function request(profileId, userId = userA) {
  const response = await fetch(`${baseUrl}/api/recommend/current?profileId=${profileId}`, {
    headers: { Authorization: `Bearer ${signToken(userId)}` },
  });
  await assertFetchResponseMatchesOpenApi(response, 'GET', '/api/recommend/current');
  return response;
}

async function submitGoal(profile, name, {
  key = crypto.randomUUID(),
  targetDate = new Date(Date.now() + 4 * 365.25 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
} = {}) {
  const response = await fetch(`${baseUrl}/api/goals/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${signToken(userA)}`,
      'Idempotency-Key': key,
    },
    body: JSON.stringify({
      goal_name: name,
      target_amount: 500000,
      target_date: targetDate,
      current_savings: 50000,
      profileId: String(profile._id),
      priority: 'High',
    }),
  });
  await assertFetchResponseMatchesOpenApi(response, 'POST', '/api/goals/create');
  return response;
}

async function patchGoal(goalId, payload) {
  const response = await fetch(`${baseUrl}/api/goals/${goalId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${signToken(userA)}`,
    },
    body: JSON.stringify(payload),
  });
  await assertFetchResponseMatchesOpenApi(response, 'PATCH', '/api/goals/{goalId}');
  return response;
}

async function submitWeights(payload, userId = userA) {
  const response = await fetch(`${baseUrl}/api/recommend/weights`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${signToken(userId)}`,
    },
    body: JSON.stringify(payload),
  });
  await assertFetchResponseMatchesOpenApi(response, 'POST', '/api/recommend/weights');
  return response;
}

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

async function rebalanceInput(profile, correlationId) {
  const state = await requireFreshRecommendationState({ userId: userA, profileId: profile._id });
  const instruments = state.currentAllocation.instruments.map(item => ({ ...item }));
  if (instruments.length > 1) {
    let assigned = 0;
    instruments.forEach((instrument, index) => {
      instrument.allocationWeight = index === instruments.length - 1
        ? 1 - assigned
        : Number((1 / instruments.length).toFixed(8));
      instrument.allocation_pct = instrument.allocationWeight * 100;
      assigned += instrument.allocationWeight;
    });
  }
  return {
    userId: userA,
    profileId: profile._id,
    recommendationId: state.recommendation._id,
    expectedRecommendationId: state.recommendation._id,
    expectedRevision: state.allocationRevision.revision,
    expectedPortfolioFingerprint: state.portfolioFingerprint,
    instruments,
    correlationId,
  };
}

async function persistNextRecommendation(profile, suffix) {
  const canonical = buildRecommendationProfile(profile);
  const modelVersion = `race-refresh-${suffix}`;
  const pipeline = runPipeline(canonical, { model_version: modelVersion, confidence_scores: {} });
  const recommendationId = new mongoose.Types.ObjectId();
  const auditId = new mongoose.Types.ObjectId();
  const inputHash = buildRecommendationProfileHash(canonical, { modelVersion });
  const claim = await claimAdvisoryIdempotency({
    key: `race-refresh-${suffix}-${crypto.randomUUID()}`,
    userId: userA,
    profileId: profile._id,
    payload: { profileId: String(profile._id), modelVersion },
    waitMs: 10000,
  });
  const advisoryText = `fixture advisory ${suffix}`;
  return persistAdvisoryAtomically({
    recommendation: {
      _id: recommendationId,
      userId: userA,
      profileId: profile._id,
      instruments: pipeline.instruments,
      advisoryText,
      confidenceScores: {},
      mlFallback: true,
      modelVersion,
      regulatoryRuleVersion: getCurrentRegulatoryRuleVersion(),
      profileVersion: profile.version ?? 1,
      recommendationPolicyVersion: RECOMMENDATION_POLICY_VERSION,
      profileInputHash: inputHash,
    },
    auditRecord: {
      _id: auditId,
      userId: userA,
      profileId: profile._id,
      recommendationId,
      correlationId: `race-refresh-${suffix}`,
      traceId: '',
      version_id: modelVersion,
      regulatory_rule_version: getCurrentRegulatoryRuleVersion(),
      input_hash: inputHash,
      inputs: { recommendationPolicyVersion: RECOMMENDATION_POLICY_VERSION },
      recommendations: { instruments: pipeline.instruments.map(({ id, allocationWeight }) => ({ id, allocationWeight })) },
      cited_rag_chunk_ids: [],
      engine: 'rule_based',
      timestamp: new Date(),
    },
    response: { recommendationId, audit_id: auditId, advisory_text: advisoryText, model_version: modelVersion },
    idempotencyClaim: claim,
    profileStateBinding: { revision: 1, currentProfileId: String(profile._id) },
  });
}

async function recommendationAdvisoryPersistenceInput(state) {
  const claimToken = crypto.randomUUID();
  const current = await Recommendation.findById(state.recommendation._id);
  current.advisoryText = null;
  current.advisoryMetadata = {
    status: 'GENERATING',
    claimToken,
    recommendationId: String(state.recommendation._id),
    profileId: String(state.recommendation.profileId),
    allocationRevision: state.allocationRevision.revision,
    allocationRevisionId: String(state.allocationRevision._id),
    portfolioFingerprint: state.portfolioFingerprint,
    profileInputHash: state.recommendation.profileInputHash,
    recommendationPolicyVersion: state.recommendation.recommendationPolicyVersion,
    regulatoryRuleVersion: state.recommendation.regulatoryRuleVersion,
    returnAssumptionHash: state.allocationRevision.returnAssumptionHash,
    profileVersion: state.profileVersion,
  };
  await current.save();
  return {
    recommendationId: state.recommendation._id,
    userId: userA,
    state,
    claimToken,
    advisoryText: 'Advice for the captured allocation revision',
    advisoryMetadata: {
      ...current.advisoryMetadata,
      status: 'READY',
      generatedAt: new Date(),
    },
  };
}

test.before(async () => {
  await setupTestDatabase({ requireReplicaSet: true });
  await User.init();
  app = express();
  app.use(express.json());
  app.use('/api/recommend', recommendRoutes);
  app.use('/api/goals', goalsRoutes);
  app.use('/api/projection', projectionRoutes);
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
    User.deleteMany({ _id: { $in: [userA, userB] } }),
    FinancialProfile.deleteMany({ userId: { $in: [userA, userB] } }),
    Recommendation.deleteMany({ userId: { $in: [userA, userB] } }),
    RecommendationState.deleteMany({ userId: { $in: [userA, userB] } }),
    FinancialProfileState.deleteMany({ userId: { $in: [userA, userB] } }),
    Goal.deleteMany({ userId: { $in: [userA, userB] } }),
    AuditRecord.collection.deleteMany({ userId: { $in: [userA, userB] } }),
    AuditChainHead.deleteMany({ _id: { $in: [userA, userB] } }),
    IdempotencyKey.deleteMany({ userId: { $in: [userA, userB] } }),
  ]);
  await User.create([
    authenticatedUserFixture(userA, 'A'),
    authenticatedUserFixture(userB, 'B'),
  ]);
});

test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  await User.deleteMany({ _id: { $in: [userA, userB] } });
  await teardownTestDatabase();
});

test('recommendation and canonical-state owner/profile identities cannot be rewritten', async () => {
  const profile = await createFixture();
  const recommendation = await Recommendation.findOne({ userId: userA, profileId: profile._id });
  const state = await RecommendationState.findOne({ userId: userA, profileId: profile._id });

  for (const [field, value] of [
    ['userId', userB],
    ['profileId', new mongoose.Types.ObjectId()],
    ['idempotencyOperationId', 'rewritten-operation'],
    ['idempotencyRequestHash', 'c'.repeat(64)],
    ['profileCompletionCandidateId', 'rewritten-candidate'],
  ]) {
    await assert.rejects(
      Recommendation.updateOne({ _id: recommendation._id }, { $set: { [field]: value } }),
      error => error.code === 'RECOMMENDATION_GENERATION_IMMUTABLE',
      `recommendation query update must protect ${field}`,
    );
  }
  const changedRecommendation = await Recommendation.findById(recommendation._id);
  await assert.rejects((async () => {
    changedRecommendation.profileId = new mongoose.Types.ObjectId();
    await changedRecommendation.save();
  })(), /immutable/i);

  await assert.rejects(
    RecommendationState.updateOne({ _id: state._id }, { $set: { profileId: new mongoose.Types.ObjectId() } }),
    error => error.code === 'RECOMMENDATION_STATE_IDENTITY_IMMUTABLE',
  );
  const changedState = await RecommendationState.findById(state._id);
  await assert.rejects((async () => {
    changedState.userId = userB;
    await changedState.save();
  })(), /immutable/i);

  const storedRecommendation = await Recommendation.findById(recommendation._id).lean();
  const storedState = await RecommendationState.findById(state._id).lean();
  assert.equal(String(storedRecommendation.userId), String(userA));
  assert.equal(String(storedState.profileId), String(profile._id));
});

test('returns the latest matching recommendation without creating records', async () => {
  const profile = await createFixture();
  const countsBefore = await Promise.all([
    Recommendation.countDocuments({ userId: userA }),
    AuditRecord.countDocuments({ userId: userA }),
  ]);

  const response = await request(profile._id);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.profileId, String(profile._id));
  assert.equal(body.instruments.length > 0, true);
  assert.equal(body.recommendationId.length, 24);
  assert.deepEqual(await Promise.all([
    Recommendation.countDocuments({ userId: userA }),
    AuditRecord.countDocuments({ userId: userA }),
  ]), countsBefore);
});

test('stress test response contract is bound to a fresh canonical allocation', async () => {
  const profile = await createFixture({ userId: userA });
  const recommendation = await Recommendation.findOne({ userId: userA, profileId: profile._id }).lean();
  const instrumentId = recommendation.instruments[0].id;
  const response = await fetch(`${baseUrl}/api/projection/stress-test`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${signToken(userA)}`,
    },
    body: JSON.stringify({ profileId: String(profile._id), instrumentId, principal: 100000 }),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  await assertFetchResponseMatchesOpenApi(response, 'POST', '/api/projection/stress-test', { body });
  assert.equal(body.profile_id, String(profile._id));
  assert.equal(body.allocation_revision, 1);
  assert.ok(body.portfolio_fingerprint);
});

test('restores current advisory metadata and text over the original snapshot', async () => {
  const { storedProfile, responseSnapshot } = await createAdvisoryLifecycleFixture();
  const countsBefore = await Promise.all([
    Recommendation.countDocuments({ userId: userA }),
    AuditRecord.countDocuments({ userId: userA }),
  ]);

  const response = await request(storedProfile._id);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.instruments, responseSnapshot.instruments);
  assert.equal(body.advisory_text, 'generated explanation');
  assert.equal(body.advisory_explanation.status, 'READY');
  assert.equal(body.advisory_explanation.provider, 'current-provider');
  assert.equal(body.advisory_explanation.model, 'current-model');
  assert.equal(body.advisory_explanation.prompt_version, 'prompt-2');
  assert.equal(body.advisory_explanation.grounding_version, 'grounding-2');
  assert.deepEqual(body.advisory_explanation.evidence_ids_used, ['E_CURRENT']);
  assert.deepEqual(body.advisory_explanation.unavailable_facts, ['CURRENT_FACT_UNAVAILABLE']);
  assert.deepEqual(body.advisory_explanation.citations, [{ id: 'E_CURRENT', title: 'Current evidence' }]);
  assert.equal(body.advisory_explanation.validation_status, 'VALID');
  assert.equal(body.advisory_explanation.generated_at, '2026-09-21T00:00:00.000Z');
  assert.deepEqual(await Promise.all([
    Recommendation.countDocuments({ userId: userA }),
    AuditRecord.countDocuments({ userId: userA }),
  ]), countsBefore);
});

test('rejects a recommendation generated under an older regulatory policy without mutation', async () => {
  const profile = await createFixture({ regulatoryRuleVersion: 'tax-policy-FY2025-26-v1' });
  const countsBefore = await Promise.all([
    Recommendation.countDocuments({ userId: userA }),
    AuditRecord.countDocuments({ userId: userA }),
  ]);

  const response = await request(profile._id);
  const body = await response.json();

  assert.equal(response.status, 409);
  assert.equal(body.code, 'STALE_RECOMMENDATION');
  assert.deepEqual(await Promise.all([
    Recommendation.countDocuments({ userId: userA }),
    AuditRecord.countDocuments({ userId: userA }),
  ]), countsBefore);
});

test('falls back to snapshot advisory state when current metadata is absent', async () => {
  const profile = await createFixture();
  await Recommendation.updateOne(
    { profileId: profile._id, userId: userA },
    { $set: { advisoryText: null, advisoryMetadata: null } },
  );

  const response = await request(profile._id);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.advisory_text, null);
  assert.equal(body.advisory_explanation.status, 'STALE');
});

test('fails closed when the canonical pointer references a deleted recommendation', async () => {
  const profile = await createFixture();
  await Recommendation.deleteMany({ profileId: profile._id });

  const missing = await request(profile._id);
  assert.equal(missing.status, 503);
  const missingBody = await missing.json();
  assert.equal(missingBody.code, 'FINANCIAL_STATE_POINTER_INVALID');

  const crossUser = await request(profile._id, userB);
  assert.equal(crossUser.status, 404);
});

test('rejects a recommendation whose profile hash is stale', async () => {
  const profile = await createFixture({ stale: true });
  const response = await request(profile._id);
  const body = await response.json();

  assert.equal(response.status, 409);
  assert.equal(body.code, 'STALE_RECOMMENDATION');
});

test('profile version alone invalidates current restore and rebalance even when canonical facts are unchanged', async () => {
  const profile = await createFixture();
  const before = await request(profile._id);
  assert.equal(before.status, 200);
  const current = await before.json();
  const revisionCount = await RecommendationAllocationRevision.countDocuments({
    userId: userA,
    profileId: profile._id,
  });

  // Model an edit that increments the authoritative profile version but leaves
  // every canonical recommendation input byte-for-byte unchanged.
  await FinancialProfile.updateOne({ _id: profile._id, userId: userA }, { $inc: { version: 1 } });

  const restored = await request(profile._id);
  const restoredBody = await restored.json();
  assert.equal(restored.status, 409);
  assert.equal(restoredBody.code, 'STALE_RECOMMENDATION');
  assert.ok(restoredBody.details.reasonCodes.includes('PROFILE_VERSION_CHANGED'));

  const weights = Object.fromEntries(current.instruments.map(instrument => [instrument.id, instrument.allocationWeight]));
  const rebalance = await submitWeights({
    profileId: String(profile._id),
    recommendationId: current.recommendationId,
    expectedAllocationRevision: current.allocation_revision,
    expectedPortfolioFingerprint: current.portfolio_fingerprint,
    weights,
  });
  assert.equal(rebalance.status, 409);
  assert.equal(await RecommendationAllocationRevision.countDocuments({ userId: userA, profileId: profile._id }), revisionCount);
});

test('concurrent manual rebalances create exactly one immutable next allocation revision', async () => {
  const profile = await createFixture();
  const currentResponse = await request(profile._id);
  assert.equal(currentResponse.status, 200);
  const current = await currentResponse.json();
  const weights = Object.fromEntries(current.instruments.map(instrument => [instrument.id, instrument.allocationWeight]));
  const payload = {
    profileId: String(profile._id),
    recommendationId: current.recommendationId,
    expectedAllocationRevision: current.allocation_revision,
    expectedPortfolioFingerprint: current.portfolio_fingerprint,
    weights,
  };

  const responses = await Promise.all([submitWeights(payload), submitWeights(payload)]);
  const results = await Promise.all(responses.map(async response => ({ status: response.status, body: await response.json() })));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const rejected = results.find(result => result.status === 409);
  assert.ok(['ALLOCATION_REVISION_CONFLICT', 'ALLOCATION_STATE_CHANGED'].includes(rejected.body.code));

  const latest = await request(profile._id);
  assert.equal(latest.status, 200);
  const latestBody = await latest.json();
  assert.equal(latestBody.allocation_revision, 2);
  assert.equal(latestBody.generation_instruments[0].allocationWeight, current.generation_instruments[0].allocationWeight);
  assert.equal(await RecommendationAllocationRevision.countDocuments({ recommendationId: current.recommendationId }), 2);
  assert.equal(await AuditRecord.countDocuments({ userId: userA, recommendationId: current.recommendationId }), 1);
  const chainHead = await AuditChainHead.findById(userA).lean();
  assert.equal(chainHead.sequence, 1);
  const newRevision = await RecommendationAllocationRevision.findOne({ recommendationId: current.recommendationId, revision: 2 }).lean();
  const oldRevision = await RecommendationAllocationRevision.findById(newRevision.previousAllocationRevisionId).lean();
  const allocationAudit = await AuditRecord.findById(newRevision.auditRecordId).lean();
  assert.equal(String(allocationAudit.allocation_transition.previousAllocationRevisionId), String(oldRevision._id));
  assert.equal(String(allocationAudit.allocation_transition.newAllocationRevisionId), String(newRevision._id));
  assert.equal(allocationAudit.allocation_transition.oldPortfolioFingerprint, oldRevision.portfolioFingerprint);
  assert.equal(allocationAudit.allocation_transition.newPortfolioFingerprint, newRevision.portfolioFingerprint);
  assert.equal(allocationAudit.allocation_transition.recommendationFingerprint, newRevision.recommendationFingerprint);
  assert.equal(allocationAudit.allocation_transition.profileInputHash, newRevision.profileInputHash);
  assert.equal(allocationAudit.allocation_transition.profileVersion, newRevision.profileVersion);
  assert.equal(allocationAudit.allocation_transition.modelVersion, newRevision.modelVersion);
  assert.equal(allocationAudit.allocation_transition.recommendationPolicyVersion, newRevision.recommendationPolicyVersion);
  assert.equal(allocationAudit.allocation_transition.regulatoryRuleVersion, newRevision.regulatoryRuleVersion);
  assert.equal(allocationAudit.allocation_transition.returnAssumptionHash, newRevision.returnAssumptionHash);
  assert.equal(await verifyAuditChain(userA).then(result => result.valid), true);
});

test('zero-weight rebalance restores zero projection and goal metrics select an allocated instrument', async () => {
  const profile = await createFixture();
  const initialResponse = await request(profile._id);
  assert.equal(initialResponse.status, 200);
  const initial = await initialResponse.json();
  const zeroedId = initial.instruments[0].id;
  const originalZeroedWeight = initial.instruments[0].allocationWeight;
  const activeInstruments = initial.instruments.slice(1);
  const weights = { [zeroedId]: 0 };
  for (const instrument of activeInstruments) {
    weights[instrument.id] = Number((instrument.allocationWeight / (1 - originalZeroedWeight)).toFixed(4));
  }
  const roundedTotal = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
  const lastActiveId = activeInstruments.at(-1).id;
  weights[lastActiveId] = Number((weights[lastActiveId] + 1 - roundedTotal).toFixed(4));

  const rebalanceResponse = await submitWeights({
    profileId: String(profile._id),
    recommendationId: initial.recommendationId,
    expectedAllocationRevision: initial.allocation_revision,
    expectedPortfolioFingerprint: initial.portfolio_fingerprint,
    weights,
  });
  const currentResponse = await rebalanceResponse.json();
  assert.equal(rebalanceResponse.status, 200, JSON.stringify(currentResponse));
  assert.equal(currentResponse.instruments.find(item => item.id === zeroedId).allocationWeight, 0);
  assert.equal(currentResponse.dashboard_projection.instrument_monthly_allocations[zeroedId], 0);
  assert.equal(currentResponse.dashboard_projection.instrument_projected_values[zeroedId], 0);

  const metrics = await _getBlendedPortfolioMetrics(userA, profile._id);
  const activeInstrument = currentResponse.instruments.find(instrument => instrument.allocationWeight > 0);
  assert.equal(metrics.primaryInstrument, activeInstrument.type);
  assert.notEqual(metrics.primaryInstrument, currentResponse.instruments[0].type);
  assert.ok(Number.isFinite(metrics.expectedReturn));
  assert.ok(Number.isFinite(metrics.volatility));
});

test('committed rebalance reconciles to a later canonical revision instead of reporting failure', async () => {
  const profile = await createFixture();
  const initial = await request(profile._id);
  const initialBody = await initial.json();
  const payload = {
    profileId: String(profile._id),
    recommendationId: initialBody.recommendationId,
    expectedAllocationRevision: initialBody.allocation_revision,
    expectedPortfolioFingerprint: initialBody.portfolio_fingerprint,
    weights: Object.fromEntries(initialBody.instruments.map(item => [item.id, item.allocationWeight])),
  };
  const barrier = createBarrier();
  let paused = false;
  const uninstall = installFinancialStateTestHook(async boundary => {
    if (boundary === 'allocation.afterCommitBeforeReconcile' && !paused) {
      paused = true;
      await barrier.pause();
    }
  });

  const pendingA = submitWeights(payload);
  try {
    await barrier.entered;
    const inputB = await rebalanceInput(profile, 'post-commit-supersession-B');
    assert.equal(inputB.expectedRevision, 2, 'A committed N+1 before reaching its response barrier');
    const committedB = await createManualAllocationRevision(inputB);
    assert.equal(committedB.revision.revision, 3);
  } finally {
    barrier.release();
    uninstall();
  }

  const responseA = await pendingA;
  const bodyA = await responseA.json();
  assert.equal(responseA.status, 200, JSON.stringify(bodyA));
  assert.equal(bodyA.response_state, 'CURRENT');
  assert.equal(bodyA.calculation_freshness.fresh, true);
  assert.equal(bodyA.allocation_revision, 3);
  assert.equal(bodyA.operation_result.committed, true);
  assert.equal(bodyA.operation_result.generated_allocation_revision, 2);
  assert.equal(bodyA.operation_result.superseded_before_response, true);

  const [pointer, revisions, audits, current] = await Promise.all([
    RecommendationState.findOne({ userId: userA, profileId: profile._id }).lean(),
    RecommendationAllocationRevision.find({ recommendationId: initialBody.recommendationId }).sort({ revision: 1 }).lean(),
    AuditRecord.find({ userId: userA, recommendationId: initialBody.recommendationId }).sort({ chain_sequence: 1 }).lean(),
    request(profile._id),
  ]);
  const currentBody = await current.json();
  assert.equal(pointer.currentAllocationRevision, 3);
  assert.equal(String(pointer.currentAllocationRevisionId), String(revisions[2]._id));
  assert.deepEqual(revisions.map(item => item.revision), [1, 2, 3]);
  assert.equal(new Set(revisions.map(item => String(item._id))).size, 3);
  assert.equal(audits.length, 2);
  assert.equal(await verifyAuditChain(userA).then(result => result.valid), true);
  assert.equal(currentBody.allocation_revision, bodyA.allocation_revision);
  assert.equal(currentBody.allocation_revision_id, bodyA.allocation_revision_id);
  assert.equal(currentBody.portfolio_fingerprint, bodyA.portfolio_fingerprint);
  assert.equal(bodyA.allocation_revision_id, String(revisions[2]._id));
  assert.notEqual(bodyA.allocation_revision_id, bodyA.operation_result.generated_allocation_revision_id);
});

test('committed rebalance retries reconciliation when allocation advances after the current-profile read', async () => {
  const profile = await createFixture();
  const initial = await request(profile._id);
  const initialBody = await initial.json();
  const payload = {
    profileId: String(profile._id),
    recommendationId: initialBody.recommendationId,
    expectedAllocationRevision: initialBody.allocation_revision,
    expectedPortfolioFingerprint: initialBody.portfolio_fingerprint,
    weights: Object.fromEntries(initialBody.instruments.map(item => [item.id, item.allocationWeight])),
  };
  const barrier = createBarrier();
  let paused = false;
  const uninstall = installFinancialStateTestHook(async boundary => {
    if (boundary === 'post_commit.after_current_profile_read' && !paused) {
      paused = true;
      await barrier.pause();
    }
  });

  const pendingA = submitWeights(payload);
  try {
    await barrier.entered;
    const inputB = await rebalanceInput(profile, 'post-commit-pointer-read-supersession-B');
    assert.equal(inputB.expectedRevision, 2, 'A has committed allocation revision N+1 before the reconciliation pointer read');
    const committedB = await createManualAllocationRevision(inputB);
    assert.equal(committedB.revision.revision, 3);
  } finally {
    barrier.release();
    uninstall();
  }

  const responseA = await pendingA;
  const bodyA = await responseA.json();
  assert.equal(responseA.status, 200, JSON.stringify(bodyA));
  assert.equal(bodyA.response_state, 'CURRENT');
  assert.equal(bodyA.calculation_freshness.fresh, true);
  assert.equal(bodyA.allocation_revision, 3);
  assert.equal(bodyA.operation_result.generated_allocation_revision, 2);
  assert.equal(bodyA.operation_result.superseded_before_response, true);

  const [pointer, revisions, audits, currentResponse] = await Promise.all([
    RecommendationState.findOne({ userId: userA, profileId: profile._id }).lean(),
    RecommendationAllocationRevision.find({ recommendationId: initialBody.recommendationId }).sort({ revision: 1 }).lean(),
    AuditRecord.find({ userId: userA, recommendationId: initialBody.recommendationId }).sort({ chain_sequence: 1 }).lean(),
    request(profile._id),
  ]);
  const currentBody = await currentResponse.json();
  assert.equal(pointer.currentAllocationRevision, 3);
  assert.equal(String(bodyA.allocation_revision_id), String(pointer.currentAllocationRevisionId));
  assert.equal(bodyA.portfolio_fingerprint, pointer.portfolioFingerprint);
  assert.equal(currentBody.allocation_revision_id, bodyA.allocation_revision_id);
  assert.deepEqual(revisions.map(revision => revision.revision), [1, 2, 3]);
  assert.equal(new Set(revisions.map(revision => String(revision._id))).size, 3);
  assert.equal(audits.length, 2);
  assert.equal((await verifyAuditChain(userA)).valid, true);
});

test('committed rebalance fails closed when canonical state is corrupted before reconciliation', async () => {
  const profile = await createFixture();
  const initial = await request(profile._id);
  const initialBody = await initial.json();
  const payload = {
    profileId: String(profile._id),
    recommendationId: initialBody.recommendationId,
    expectedAllocationRevision: initialBody.allocation_revision,
    expectedPortfolioFingerprint: initialBody.portfolio_fingerprint,
    weights: Object.fromEntries(initialBody.instruments.map(item => [item.id, item.allocationWeight])),
  };
  const uninstall = installFinancialStateTestHook(async boundary => {
    if (boundary === 'allocation.afterCommitBeforeReconcile') {
      await RecommendationState.collection.updateOne(
        { userId: userA, profileId: profile._id },
        { $set: { currentAllocationRevisionId: new mongoose.Types.ObjectId() } },
      );
    }
  });
  let response;
  try {
    response = await submitWeights(payload);
  } finally {
    uninstall();
  }
  const body = await response.json();
  assert.equal(response.status, 503, JSON.stringify(body));
  assert.equal(body.code, 'COMMITTED_BUT_RESPONSE_RECONCILIATION_FAILED');
  assert.equal(body.details.committed, true);
  assert.equal(body.response_state, undefined, 'historical revision is not returned as current');
  assert.equal(await RecommendationAllocationRevision.countDocuments({ recommendationId: initialBody.recommendationId }), 2);
  assert.equal(await AuditRecord.countDocuments({ userId: userA, recommendationId: initialBody.recommendationId }), 1);
});

test('committed rebalance reconciles to a later canonical revision instead of reporting failure', async () => {
  const profile = await createFixture();
  const initial = await request(profile._id);
  const initialBody = await initial.json();
  const payload = {
    profileId: String(profile._id),
    recommendationId: initialBody.recommendationId,
    expectedAllocationRevision: initialBody.allocation_revision,
    expectedPortfolioFingerprint: initialBody.portfolio_fingerprint,
    weights: Object.fromEntries(initialBody.instruments.map(item => [item.id, item.allocationWeight])),
  };
  const barrier = createBarrier();
  let paused = false;
  const uninstall = installFinancialStateTestHook(async boundary => {
    if (boundary === 'allocation.afterCommitBeforeReconcile' && !paused) {
      paused = true;
      await barrier.pause();
    }
  });

  const pendingA = submitWeights(payload);
  try {
    await barrier.entered;
    const nextInput = await rebalanceInput(profile, 'post-commit-supersession-B');
    assert.equal(nextInput.expectedRevision, 2, 'request A has durably committed revision N+1');
    const committedB = await createManualAllocationRevision(nextInput);
    assert.equal(committedB.revision.revision, 3);
  } finally {
    barrier.release();
    uninstall();
  }

  const responseA = await pendingA;
  const bodyA = await responseA.json();
  assert.equal(responseA.status, 200, JSON.stringify(bodyA));
  assert.equal(bodyA.response_state, 'CURRENT');
  assert.equal(bodyA.calculation_freshness.fresh, true);
  assert.equal(bodyA.allocation_revision, 3);
  assert.equal(bodyA.operation_result.committed, true);
  assert.equal(bodyA.operation_result.generated_allocation_revision, 2);
  assert.equal(bodyA.operation_result.superseded_before_response, true);

  const [pointer, revisions, audits, current] = await Promise.all([
    RecommendationState.findOne({ userId: userA, profileId: profile._id }).lean(),
    RecommendationAllocationRevision.find({ recommendationId: initialBody.recommendationId }).sort({ revision: 1 }).lean(),
    AuditRecord.find({ userId: userA, recommendationId: initialBody.recommendationId }).sort({ chain_sequence: 1 }).lean(),
    request(profile._id),
  ]);
  const currentBody = await current.json();
  assert.equal(pointer.currentAllocationRevision, 3);
  assert.equal(String(pointer.currentAllocationRevisionId), String(revisions[2]._id));
  assert.deepEqual(revisions.map(item => item.revision), [1, 2, 3]);
  assert.equal(new Set(revisions.map(item => String(item._id))).size, 3);
  assert.equal(audits.length, 2);
  assert.equal(await verifyAuditChain(userA).then(result => result.valid), true);
  assert.equal(currentBody.allocation_revision, bodyA.allocation_revision);
  assert.equal(currentBody.allocation_revision_id, bodyA.allocation_revision_id);
  assert.equal(currentBody.portfolio_fingerprint, bodyA.portfolio_fingerprint);
  assert.equal(bodyA.allocation_revision_id, String(revisions[2]._id));
  assert.notEqual(bodyA.allocation_revision_id, bodyA.operation_result.generated_allocation_revision_id);
});

test('committed rebalance fails closed when canonical state is corrupted before reconciliation', async () => {
  const profile = await createFixture();
  const initial = await request(profile._id);
  const initialBody = await initial.json();
  const payload = {
    profileId: String(profile._id),
    recommendationId: initialBody.recommendationId,
    expectedAllocationRevision: initialBody.allocation_revision,
    expectedPortfolioFingerprint: initialBody.portfolio_fingerprint,
    weights: Object.fromEntries(initialBody.instruments.map(item => [item.id, item.allocationWeight])),
  };
  const uninstall = installFinancialStateTestHook(async boundary => {
    if (boundary === 'allocation.afterCommitBeforeReconcile') {
      await RecommendationState.collection.updateOne(
        { userId: userA, profileId: profile._id },
        { $set: { currentAllocationRevisionId: new mongoose.Types.ObjectId() } },
      );
    }
  });
  let response;
  try {
    response = await submitWeights(payload);
  } finally {
    uninstall();
  }
  const body = await response.json();
  assert.equal(response.status, 503, JSON.stringify(body));
  assert.equal(body.code, 'COMMITTED_BUT_RESPONSE_RECONCILIATION_FAILED');
  assert.equal(body.details.committed, true);
  assert.equal(body.response_state, undefined, 'historical revision is not returned as current');
  assert.equal(await RecommendationAllocationRevision.countDocuments({ recommendationId: initialBody.recommendationId }), 2);
  assert.equal(await AuditRecord.countDocuments({ userId: userA, recommendationId: initialBody.recommendationId }), 1);
});

test('transaction aborts at every rebalance write boundary leave no partial financial or audit state', async () => {
  const profile = await createFixture();
  const args = await rebalanceInput(profile, 'fault-injected-rebalance-abort');
  const initialProfile = await FinancialProfile.findById(profile._id).lean();
  const initialProfileState = await FinancialProfileState.findOne({ userId: userA }).lean();
  const initialState = await RecommendationState.findOne({ userId: userA, profileId: profile._id }).lean();
  const failureBoundaries = [
    'afterProfileFence',
    'afterAuditCreate',
    'afterRevisionCreate',
    'afterStatePointerUpdate',
  ];

  for (const boundary of failureBoundaries) {
    await assert.rejects(
      createManualAllocationRevision({
        ...args,
        testHooks: {
          [boundary]: async () => { throw Object.assign(new Error(`injected ${boundary}`), { code: 'INJECTED_ABORT' }); },
        },
      }),
      error => error.code === 'INJECTED_ABORT',
    );

    const [afterProfile, afterUserProfileState, afterState, revisions, audits, auditHead] = await Promise.all([
      FinancialProfile.findById(profile._id).lean(),
      FinancialProfileState.findOne({ userId: userA }).lean(),
      RecommendationState.findOne({ userId: userA, profileId: profile._id }).lean(),
      RecommendationAllocationRevision.find({ recommendationId: args.recommendationId }).sort({ revision: 1 }).lean(),
      AuditRecord.find({ userId: userA, recommendationId: args.recommendationId }).lean(),
      AuditChainHead.findById(userA).lean(),
    ]);

    assert.equal(afterProfile.version, initialProfile.version, `${boundary}: profile version`);
    assert.equal(afterProfile.financialStateFence || 0, initialProfile.financialStateFence || 0, `${boundary}: profile fence`);
    assert.equal(afterUserProfileState.promotionFence, initialProfileState.promotionFence, `${boundary}: user profile promotion fence`);
    assert.equal(String(afterState.currentRecommendationId), String(initialState.currentRecommendationId), `${boundary}: recommendation pointer`);
    assert.equal(afterState.currentAllocationRevision, initialState.currentAllocationRevision, `${boundary}: allocation revision`);
    assert.equal(String(afterState.currentAllocationRevisionId), String(initialState.currentAllocationRevisionId), `${boundary}: allocation pointer`);
    assert.deepEqual(revisions.map(revision => revision.revision), [1], `${boundary}: revisions`);
    assert.equal(audits.length, 0, `${boundary}: audit rows`);
    assert.equal(auditHead, null, `${boundary}: audit chain head`);
  }
});

test('barrier-controlled rebalance race commits one revision and leaves no loser artifacts', async () => {
  const profile = await createFixture();
  const args = await rebalanceInput(profile, 'barrier-rebalance-winner');
  const barrier = createBarrier();
  let paused = false;
  const first = createManualAllocationRevision({
    ...args,
    correlationId: 'barrier-rebalance-loser',
    testHooks: { afterStateRead: async () => { if (!paused) { paused = true; await barrier.pause(); } } },
  });
  await barrier.entered;
  const winner = await createManualAllocationRevision(args);
  barrier.release();
  const loser = await Promise.allSettled([first]);

  assert.equal(loser[0].status, 'rejected');
  assert.ok(['ALLOCATION_REVISION_CONFLICT', 'ALLOCATION_STATE_CHANGED'].includes(loser[0].reason.code));
  const state = await RecommendationState.findOne({ userId: userA, profileId: profile._id }).lean();
  const revisions = await RecommendationAllocationRevision.find({ recommendationId: args.recommendationId }).sort({ revision: 1 }).lean();
  const audits = await AuditRecord.find({ recommendationId: args.recommendationId }).lean();
  assert.equal(state.currentAllocationRevision, 2);
  assert.equal(String(state.currentAllocationRevisionId), String(winner.revision._id));
  assert.deepEqual(revisions.map(item => item.revision), [1, 2]);
  assert.equal(revisions.filter(item => item.revision === 2).length, 1);
  assert.equal(audits.length, 1);
  assert.equal(String(revisions[1].auditRecordId), String(audits[0]._id));
  assert.ok(Math.abs(revisions[1].instruments.reduce((sum, item) => sum + item.allocationWeight, 0) - 1) < 1e-8);
});

test('barrier-controlled profile edit defeats an in-flight rebalance without financial side effects', async () => {
  const profile = await createFixture();
  const args = await rebalanceInput(profile, 'barrier-profile-race');
  const barrier = createBarrier();
  let paused = false;
  const pending = createManualAllocationRevision({
    ...args,
    testHooks: { afterStateRead: async () => { if (!paused) { paused = true; await barrier.pause(); } } },
  });
  await barrier.entered;
  const beforeState = await RecommendationState.findOne({ userId: userA, profileId: profile._id }).lean();
  await FinancialProfile.updateOne({ _id: profile._id, userId: userA }, {
    $set: { monthlySavings: 27000 },
    $inc: { version: 1, financialStateFence: 1 },
  });
  barrier.release();
  const result = await Promise.allSettled([pending]);

  assert.equal(result[0].status, 'rejected');
  const currentProfile = await FinancialProfile.findById(profile._id).lean();
  const afterState = await RecommendationState.findOne({ userId: userA, profileId: profile._id }).lean();
  assert.equal(currentProfile.version, 2);
  assert.equal(currentProfile.financialStateFence, (profile.financialStateFence || 0) + 1);
  assert.equal(await RecommendationAllocationRevision.countDocuments({ recommendationId: args.recommendationId }), 1);
  assert.equal(await AuditRecord.countDocuments({ recommendationId: args.recommendationId }), 0);
  assert.equal(String(afterState._id), String(beforeState._id));
  assert.equal(afterState.currentAllocationRevision, beforeState.currentAllocationRevision);
  assert.equal(String(afterState.currentAllocationRevisionId), String(beforeState.currentAllocationRevisionId));
  await assert.rejects(requireFreshRecommendationState({ userId: userA, profileId: profile._id }));
});

test('manual rebalance refuses a profile that is no longer the user canonical profile', async () => {
  const profile = await createFixture();
  const args = await rebalanceInput(profile, 'historical-profile-rebalance-rejected');
  await FinancialProfileState.updateOne({ userId: userA }, {
    $set: { currentProfileId: new mongoose.Types.ObjectId() },
    $inc: { revision: 1, promotionFence: 1 },
  });

  await assert.rejects(createManualAllocationRevision(args), error => error.code === 'PROFILE_STATE_VERSION_CONFLICT');
  assert.equal(await RecommendationAllocationRevision.countDocuments({ recommendationId: args.recommendationId }), 1);
  assert.equal(await AuditRecord.countDocuments({ recommendationId: args.recommendationId }), 0);
});

test('rebalance transaction is fenced when the canonical profile pointer advances after its read', async () => {
  const profile = await createFixture();
  const args = await rebalanceInput(profile, 'profile-pointer-race-rebalance');
  const barrier = createBarrier();
  let paused = false;
  const pending = createManualAllocationRevision({
    ...args,
    testHooks: {
      afterFinancialProfileStateRead: async () => {
        if (!paused) {
          paused = true;
          await barrier.pause();
        }
      },
    },
  });
  await barrier.entered;
  await FinancialProfileState.updateOne({ userId: userA }, {
    $set: { currentProfileId: new mongoose.Types.ObjectId() },
    $inc: { revision: 1, promotionFence: 1 },
  });
  barrier.release();
  const result = await Promise.allSettled([pending]);
  assert.equal(result[0].status, 'rejected');
  assert.ok(['PROFILE_STATE_VERSION_CONFLICT', 'ALLOCATION_REVISION_CONFLICT'].includes(result[0].reason.code));
  assert.equal(await RecommendationAllocationRevision.countDocuments({ recommendationId: args.recommendationId }), 1);
  assert.equal(await AuditRecord.countDocuments({ recommendationId: args.recommendationId }), 0);
});

test('barrier-controlled recommendation refresh supersedes a paused old-state rebalance', async () => {
  const profile = await createFixture();
  const args = await rebalanceInput(profile, 'barrier-refresh-race');
  const barrier = createBarrier();
  let paused = false;
  const pending = createManualAllocationRevision({
    ...args,
    testHooks: { afterStateRead: async () => { if (!paused) { paused = true; await barrier.pause(); } } },
  });
  await barrier.entered;
  const refreshed = await persistNextRecommendation(profile, 'during-rebalance');
  barrier.release();
  const result = await Promise.allSettled([pending]);

  assert.equal(result[0].status, 'rejected');
  const pointer = await RecommendationState.findOne({ userId: userA, profileId: profile._id }).lean();
  assert.equal(String(pointer.currentRecommendationId), String(refreshed.recommendationId));
  assert.equal(pointer.currentAllocationRevision, 1);
  assert.equal(await RecommendationAllocationRevision.countDocuments({ recommendationId: args.recommendationId }), 1);
  assert.equal(await AuditRecord.countDocuments({ recommendationId: args.recommendationId }), 0);
  assert.equal(await RecommendationAllocationRevision.countDocuments({ recommendationId: refreshed.recommendationId }), 1);
  assert.equal(await AuditRecord.countDocuments({ recommendationId: refreshed.recommendationId }), 1);
});

test('barrier-controlled recommendation advisory loses to a rebalance and is never served as current', async () => {
  const profile = await createFixture();
  const state = await requireFreshRecommendationState({ userId: userA, profileId: profile._id });
  const persistenceInput = await recommendationAdvisoryPersistenceInput(state);
  const barrier = createBarrier();
  let paused = false;
  const uninstall = installFinancialStateTestHook(async boundary => {
    if (boundary === 'recommendation.advisory.beforePersistence' && !paused) {
      paused = true;
      await barrier.pause();
    }
  });
  const pending = persistAdvisoryIfCurrent(persistenceInput);
  try {
    await barrier.entered;
    await createManualAllocationRevision(await rebalanceInput(profile, 'advisory-versus-rebalance'));
  } finally {
    barrier.release();
    uninstall();
  }
  const result = await Promise.allSettled([pending]);

  assert.equal(result[0].status, 'rejected');
  assert.equal(result[0].reason.code, 'ADVISORY_SOURCE_STATE_CHANGED');
  const stored = await Recommendation.findById(state.recommendation._id).lean();
  assert.equal(stored.advisoryText, null);
  assert.equal(stored.advisoryMetadata.status, 'GENERATING');
  const currentResponse = await request(profile._id);
  const currentBody = await currentResponse.json();
  assert.equal(currentResponse.status, 200);
  assert.equal(currentBody.advisory_text, null);
  assert.equal(currentBody.advisory_explanation.status, 'STALE');
});

test('persisted deferred advisory is reconciled against a rebalance before its response and stale READY advice can be refreshed', async () => {
  const profile = await createFixture();
  const current = await request(profile._id);
  const currentBody = await current.json();
  const recommendationId = String(currentBody.recommendationId);
  const barrier = createBarrier();
  const originalPrimaryProvider = process.env.LLM_PRIMARY_PROVIDER;
  const originalNvidiaApiKey = process.env.NVIDIA_API_KEY;
  const originalGenerate = ProviderManager.nvidia.generate;
  let providerCalls = 0;
  process.env.LLM_PRIMARY_PROVIDER = 'NVIDIA_NIM';
  // Provider configuration is checked before the adapter's generate method;
  // this local stub needs a non-secret sentinel so the test reaches the stub.
  process.env.NVIDIA_API_KEY = 'test-key-not-a-real-secret';
  ProviderManager.nvidia.generate = async ({ recentHistory }) => {
    providerCalls += 1;
    const prompt = recentHistory?.[0]?.parts?.[0]?.text;
    const evidencePacket = JSON.parse(prompt).EVIDENCE_PACKET;
    const profileRiskEvidence = evidencePacket.entries.find(entry => entry.id === 'E_PROFILE_RISK');
    assert.ok(profileRiskEvidence, 'the grounded explanation packet includes profile-risk evidence');
    const evidenceId = profileRiskEvidence.id;
    const text = `The current profile records ${profileRiskEvidence.displayValue} [${evidenceId}].`;
    return {
      text: JSON.stringify({
        text,
        evidenceIdsUsed: [evidenceId],
        claims: [{ text, evidenceIds: [evidenceId] }],
        financialClaims: [],
        unavailableFacts: [],
      }),
      provider: 'nvidia_nim',
      model: 'post-commit-race-test',
      tokensUsed: 0,
    };
  };

  let paused = false;
  const uninstall = installFinancialStateTestHook(async boundary => {
    if (boundary === 'recommendation.advisory.afterPersistenceBeforeResponse' && !paused) {
      paused = true;
      await barrier.pause();
    }
  });
  let pending;
  try {
    pending = fetch(`${baseUrl}/api/recommend/${recommendationId}/advisory`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signToken(userA)}` },
    });
    await barrier.entered;
    const rebalance = await createManualAllocationRevision(await rebalanceInput(profile, 'advisory-post-persist-race'));
    assert.equal(rebalance.revision.revision, 2);
  } finally {
    barrier.release();
    uninstall();
  }

  try {
    const response = await pending;
    const body = await response.json();
    await assertFetchResponseMatchesOpenApi(response, 'POST', '/api/recommend/{recommendationId}/advisory', { body });
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.allocation_revision, 2);
    assert.equal(body.advisory_text, null, 'text generated for revision 1 must not be presented as revision 2 advice');
    assert.equal(body.advisory_explanation.status, 'STALE');
    const [stored, pointer] = await Promise.all([
      Recommendation.findById(recommendationId).lean(),
      RecommendationState.findOne({ userId: userA, profileId: profile._id }).lean(),
    ]);
    assert.equal(stored.advisoryMetadata.allocationRevision, 1, 'historical advisory provenance remains the state actually explained');
    assert.ok(stored.advisoryText, 'the successfully generated historical advisory remains persisted');
    assert.equal(pointer.currentAllocationRevision, 2);
    assert.equal(body.allocation_revision_id, String(pointer.currentAllocationRevisionId));
    assert.equal(body.portfolio_fingerprint, pointer.portfolioFingerprint);

    const refreshedResponse = await fetch(`${baseUrl}/api/recommend/${recommendationId}/advisory`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signToken(userA)}` },
    });
    const refreshed = await refreshedResponse.json();
    await assertFetchResponseMatchesOpenApi(refreshedResponse, 'POST', '/api/recommend/{recommendationId}/advisory', { body: refreshed });
    assert.equal(refreshedResponse.status, 200, JSON.stringify(refreshed));
    assert.equal(refreshed.allocation_revision, 2);
    assert.equal(refreshed.allocation_revision_id, String(pointer.currentAllocationRevisionId));
    assert.equal(refreshed.advisory_explanation.status, 'GROUNDED_EXPLANATION_AVAILABLE');
    assert.ok(refreshed.advisory_text);
    assert.equal(providerCalls, 2, 'stale READY advisory must be claimable for a fresh current-state generation');
    const refreshedRecord = await Recommendation.findById(recommendationId).lean();
    assert.equal(refreshedRecord.advisoryMetadata.allocationRevision, 2);
    assert.equal(refreshedRecord.advisoryMetadata.allocationRevisionId, String(pointer.currentAllocationRevisionId));
  } finally {
    ProviderManager.nvidia.generate = originalGenerate;
    if (originalPrimaryProvider === undefined) delete process.env.LLM_PRIMARY_PROVIDER;
    else process.env.LLM_PRIMARY_PROVIDER = originalPrimaryProvider;
    if (originalNvidiaApiKey === undefined) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = originalNvidiaApiKey;
  }
});

test('barrier-controlled recommendation advisory loses to a profile edit with no advisory side effect', async () => {
  const profile = await createFixture();
  const state = await requireFreshRecommendationState({ userId: userA, profileId: profile._id });
  const persistenceInput = await recommendationAdvisoryPersistenceInput(state);
  const barrier = createBarrier();
  let paused = false;
  const uninstall = installFinancialStateTestHook(async boundary => {
    if (boundary === 'recommendation.advisory.beforePersistence' && !paused) {
      paused = true;
      await barrier.pause();
    }
  });
  const pending = persistAdvisoryIfCurrent(persistenceInput);
  try {
    await barrier.entered;
    await FinancialProfile.updateOne({ _id: profile._id, userId: userA }, {
      $set: { monthlySavings: 26000 },
      $inc: { version: 1, financialStateFence: 1 },
    });
  } finally {
    barrier.release();
    uninstall();
  }
  const result = await Promise.allSettled([pending]);

  assert.equal(result[0].status, 'rejected');
  assert.equal(result[0].reason.code, 'ADVISORY_SOURCE_STATE_CHANGED');
  const stored = await Recommendation.findById(state.recommendation._id).lean();
  assert.equal(stored.advisoryText, null);
  assert.equal(stored.advisoryMetadata.status, 'GENERATING');
  await assert.rejects(requireFreshRecommendationState({ userId: userA, profileId: profile._id }));
});

async function assertGoalCreateRace({ profile, boundary, name, concurrentChange }) {
  const barrier = createBarrier();
  let paused = false;
  const uninstall = installFinancialStateTestHook(async reached => {
    if (reached === boundary && !paused) {
      paused = true;
      await barrier.pause();
    }
  });
  const pendingResponse = submitGoal(profile, name);
  try {
    await barrier.entered;
    await concurrentChange();
  } finally {
    barrier.release();
    uninstall();
  }
  const response = await pendingResponse;
  const body = await response.json();
  assert.equal(response.status, 409, JSON.stringify(body));
  assert.equal(await Goal.countDocuments({ userId: userA, profileId: profile._id }), 0);
  return body;
}

test('barrier-controlled goal calculation loses to an allocation revision change', async () => {
  const profile = await createFixture();
  await assertGoalCreateRace({
    profile,
    boundary: 'goal.calculation.beforeStateRecheck',
    name: 'Goal Plan Rebalance Race',
    concurrentChange: async () => createManualAllocationRevision(await rebalanceInput(profile, 'goal-plan-rebalance-race')),
  });
  const state = await RecommendationState.findOne({ userId: userA, profileId: profile._id }).lean();
  assert.equal(state.currentAllocationRevision, 2);
  assert.equal(await RecommendationAllocationRevision.countDocuments({ recommendationId: state.currentRecommendationId }), 2);
  assert.equal(await AuditRecord.countDocuments({ userId: userA, recommendationId: state.currentRecommendationId }), 1);
});

test('goal create transaction rollback test enters transaction and aborts an inserted goal after persistence', async () => {
  const profile = await createFixture();
  const profileBefore = await FinancialProfile.findById(profile._id).lean();
  const stateBefore = await RecommendationState.findOne({ userId: userA, profileId: profile._id }).lean();
  const goalName = 'Verified transaction rollback boundary';
  let reached = false;
  const uninstall = installFinancialStateTestHook(async (boundary, context) => {
    if (boundary !== 'goal.create.afterInsertBeforeCommit') return;
    reached = true;
    assert.equal(context.transactionActive, true);
    const insideTransaction = await Goal.findById(context.goalId).session(context.session).lean();
    assert.equal(insideTransaction.goal_name, goalName, 'the inserted goal must be visible inside the active transaction');
    throw Object.assign(new Error('injected failure after goal insert'), { code: 'INJECTED_AFTER_GOAL_INSERT' });
  });
  let response;
  try {
    response = await submitGoal(profile, goalName);
  } finally {
    uninstall();
  }
  const body = await response.json();
  assert.equal(reached, true, 'the test must prove it reached the transaction insert boundary');
  assert.equal(response.status, 500, JSON.stringify(body));
  assert.equal(typeof body.request_id, 'string');
  assert.equal(await Goal.countDocuments({ userId: userA, profileId: profile._id, goal_name: goalName }), 0);
  const [profileAfter, stateAfter] = await Promise.all([
    FinancialProfile.findById(profile._id).lean(),
    RecommendationState.findOne({ userId: userA, profileId: profile._id }).lean(),
  ]);
  assert.equal(profileAfter.financialStateFence || 0, profileBefore.financialStateFence || 0, 'profile source fence rolls back');
  assert.equal(stateAfter.financialStateFence || 0, stateBefore.financialStateFence || 0, 'recommendation state fence rolls back');
  assert.equal(await RecommendationAllocationRevision.countDocuments({ profileId: profile._id }), 1);
  assert.equal(await AuditRecord.countDocuments({ userId: userA, profileId: profile._id }), 0);
});

test('barrier-controlled goal calculation loses to a profile edit with no persisted goal', async () => {
  const profile = await createFixture();
  await assertGoalCreateRace({
    profile,
    boundary: 'goal.calculation.beforeStateRecheck',
    name: 'Goal Plan Profile Race',
    concurrentChange: async () => FinancialProfile.updateOne({ _id: profile._id, userId: userA }, {
      $set: { monthlySavings: 25000 },
      $inc: { version: 1, financialStateFence: 1 },
    }),
  });
  const changed = await FinancialProfile.findById(profile._id).lean();
  assert.equal(changed.version, 2);
  assert.equal(changed.financialStateFence, 1);
  assert.equal(await RecommendationAllocationRevision.countDocuments({ profileId: profile._id }), 1);
  assert.equal(await AuditRecord.countDocuments({ profileId: profile._id }), 0);
});

test('barrier-controlled goal advisory loses to a rebalance and leaves no goal document', async () => {
  const profile = await createFixture();
  await assertGoalCreateRace({
    profile,
    boundary: 'goal.advisory.beforePersistence',
    name: 'Goal Advice Rebalance Race',
    concurrentChange: async () => createManualAllocationRevision(await rebalanceInput(profile, 'goal-advice-rebalance-race')),
  });
  const state = await RecommendationState.findOne({ userId: userA, profileId: profile._id }).lean();
  assert.equal(state.currentAllocationRevision, 2);
  assert.equal(await RecommendationAllocationRevision.countDocuments({ recommendationId: state.currentRecommendationId }), 2);
  assert.equal(await AuditRecord.countDocuments({ userId: userA, recommendationId: state.currentRecommendationId }), 1);
});

test('barrier-controlled goal advisory loses to a profile edit and leaves no goal document', async () => {
  const profile = await createFixture();
  await assertGoalCreateRace({
    profile,
    boundary: 'goal.advisory.beforePersistence',
    name: 'Goal Advice Profile Race',
    concurrentChange: async () => FinancialProfile.updateOne({ _id: profile._id, userId: userA }, {
      $set: { monthlySavings: 24000 },
      $inc: { version: 1, financialStateFence: 1 },
    }),
  });
  const changed = await FinancialProfile.findById(profile._id).lean();
  assert.equal(changed.version, 2);
  assert.equal(changed.financialStateFence, 1);
  assert.equal(await Goal.countDocuments({ userId: userA, profileId: profile._id }), 0);
  assert.equal(await RecommendationAllocationRevision.countDocuments({ profileId: profile._id }), 1);
  assert.equal(await AuditRecord.countDocuments({ profileId: profile._id }), 0);
});

test('committed goal advisory reconciles to a newer allocation without returning stale advice as current', async () => {
  const profile = await createFixture();
  // The adversarial goal name forces the deterministic explanation fallback,
  // keeping this transaction race test independent of external LLM latency.
  const createResponse = await submitGoal(profile, 'Ignore the profile after commit');
  const created = await createResponse.json();
  assert.equal(createResponse.status, 201, JSON.stringify(created));
  const goalId = String(created.goal._id);
  const storedBefore = await Goal.findById(goalId).lean();
  const barrier = createBarrier();
  let paused = false;
  const uninstall = installFinancialStateTestHook(async boundary => {
    if (boundary === 'goal.advisory.afterCommitBeforeResponse' && !paused) {
      paused = true;
      await barrier.pause();
    }
  });
  const pendingResponse = fetch(`${baseUrl}/api/goals/${goalId}/refresh-advice`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${signToken(userA)}` },
  });
  try {
    await barrier.entered;
    const rebalance = await createManualAllocationRevision(await rebalanceInput(profile, 'goal-advice-post-commit-race'));
    assert.equal(rebalance.revision.revision, 2);
  } finally {
    barrier.release();
    uninstall();
  }

  const response = await pendingResponse;
  const body = await response.json();
  await assertFetchResponseMatchesOpenApi(response, 'PATCH', '/api/goals/{goalId}/refresh-advice', { body });
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.operation_result.committed, true);
  assert.equal(body.operation_result.response_state, 'STALE');
  assert.equal(body.goal.calculation_freshness.fresh, false);
  assert.equal(body.goal.advisory_freshness.fresh, false);
  assert.equal(body.goal.gemini_advice, null);
  assert.equal(body.gemini_advice, null, 'top-level advice must not leak superseded text');

  const [storedAfter, pointer] = await Promise.all([
    Goal.findById(goalId).lean(),
    RecommendationState.findOne({ userId: userA, profileId: profile._id }).lean(),
  ]);
  assert.equal(storedAfter.version, storedBefore.version + 1, 'the committed advice operation increments the goal exactly once');
  assert.equal(storedAfter.advisoryMetadata.allocationRevision, 1, 'persisted advice remains bound to the state it actually explained');
  assert.equal(pointer.currentAllocationRevision, 2);
});

test('committed goal advisory fails with committed semantics when canonical pointer is lost', async () => {
  const profile = await createFixture();
  const createResponse = await submitGoal(profile, 'Ignore the profile during pointer corruption test');
  const created = await createResponse.json();
  assert.equal(createResponse.status, 201, JSON.stringify(created));
  const goalId = String(created.goal._id);
  const barrier = createBarrier();
  let paused = false;
  const uninstall = installFinancialStateTestHook(async boundary => {
    if (boundary === 'goal.advisory.afterCommitBeforeResponse' && !paused) {
      paused = true;
      await barrier.pause();
    }
  });
  const pendingResponse = fetch(`${baseUrl}/api/goals/${goalId}/refresh-advice`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${signToken(userA)}` },
  });
  try {
    await barrier.entered;
    await RecommendationState.deleteOne({ userId: userA, profileId: profile._id });
  } finally {
    barrier.release();
    uninstall();
  }
  const response = await pendingResponse;
  const body = await response.json();
  await assertFetchResponseMatchesOpenApi(response, 'PATCH', '/api/goals/{goalId}/refresh-advice', { body });
  assert.equal(response.status, 503, JSON.stringify(body));
  assert.equal(body.code, 'COMMITTED_BUT_RESPONSE_RECONCILIATION_FAILED');
  assert.equal(body.details.operation_committed, true);
  assert.equal(Object.hasOwn(body, 'goal'), false, 'the operation error must not return historical goal data as current');
  const stored = await Goal.findById(goalId).lean();
  assert.equal(stored.version, created.goal.version + 1, 'the already committed advisory operation remains recorded');
});

test('committed goal creation reconciles to a newer allocation and withholds stale calculations', async () => {
  const profile = await createFixture();
  const barrier = createBarrier();
  let paused = false;
  const uninstall = installFinancialStateTestHook(async boundary => {
    if (boundary === 'goal.create.afterCommitBeforeResponse' && !paused) {
      paused = true;
      await barrier.pause();
    }
  });
  const pendingResponse = submitGoal(profile, 'Ignore the profile during goal-create reconciliation');
  try {
    await barrier.entered;
    const rebalance = await createManualAllocationRevision(await rebalanceInput(profile, 'goal-create-post-commit-race'));
    assert.equal(rebalance.revision.revision, 2);
  } finally {
    barrier.release();
    uninstall();
  }

  const response = await pendingResponse;
  const body = await response.json();
  await assertFetchResponseMatchesOpenApi(response, 'POST', '/api/goals/create', { body });
  assert.equal(response.status, 201, JSON.stringify(body));
  assert.equal(body.goal.calculation_freshness.fresh, false);
  assert.ok(body.goal.calculation_freshness.reasonCodes.includes('STALE_ALLOCATION'));
  assert.equal(body.goal.probability_of_success, null, 'the original calculation must not appear current after allocation advanced');
  assert.equal(body.goal.chart_data.length, 0);
  assert.equal(await Goal.countDocuments({ userId: userA, profileId: profile._id }), 1);
  assert.equal((await RecommendationState.findOne({ userId: userA, profileId: profile._id }).lean()).currentAllocationRevision, 2);
});

test('goal create retry after committed response loss replays its owned resource without a second mutation', async () => {
  const profile = await createFixture();
  const key = 'goal-create-crash-recovery-key-2026';
  const targetDate = '2030-09-24';
  let injected = false;
  const uninstall = installFinancialStateTestHook(async boundary => {
    if (boundary === 'goal.create.afterCommitBeforeResponse' && !injected) {
      injected = true;
      throw new Error('SIMULATED_PROCESS_CRASH_AFTER_GOAL_COMMIT');
    }
  });
  let first;
  try {
    first = await submitGoal(profile, 'Ignore the profile during goal idempotency recovery', { key, targetDate });
  } finally {
    uninstall();
  }
  const firstBody = await first.json();
  assert.equal(first.status, 500, JSON.stringify(firstBody));
  assert.equal(await Goal.countDocuments({ userId: userA, profileId: profile._id }), 1);

  const replay = await submitGoal(profile, 'Ignore the profile during goal idempotency recovery', { key, targetDate });
  const replayBody = await replay.json();
  assert.equal(replay.status, 201, JSON.stringify(replayBody));
  assert.equal(replay.headers.get('x-cache-lookup'), 'HIT - Idempotent');
  assert.equal(await Goal.countDocuments({ userId: userA, profileId: profile._id }), 1);
  assert.equal(String(replayBody.goal._id), String((await Goal.findOne({ userId: userA, profileId: profile._id }).lean())._id));
  assert.equal(await IdempotencyKey.countDocuments({ userId: userA, operation: 'goals.create', status: 'DONE' }), 1);
});

test('committed goal update reconciles newer allocation without returning historical calculations as current', async () => {
  const profile = await createFixture();
  const createResponse = await submitGoal(profile, 'Ignore the profile during goal-update reconciliation');
  const created = await createResponse.json();
  assert.equal(createResponse.status, 201, JSON.stringify(created));
  const goalId = String(created.goal._id);
  const barrier = createBarrier();
  let paused = false;
  const uninstall = installFinancialStateTestHook(async boundary => {
    if (boundary === 'goal.update.afterCommitBeforeResponse' && !paused) {
      paused = true;
      await barrier.pause();
    }
  });
  const pendingResponse = patchGoal(goalId, {
    expectedVersion: created.goal.version,
    priority: 'Critical',
  });
  try {
    await barrier.entered;
    const rebalance = await createManualAllocationRevision(await rebalanceInput(profile, 'goal-update-post-commit-race'));
    assert.equal(rebalance.revision.revision, 2);
  } finally {
    barrier.release();
    uninstall();
  }

  const response = await pendingResponse;
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.goal.version, created.goal.version + 1);
  assert.equal(body.goal.priority, 'Critical');
  assert.equal(body.goal.calculation_freshness.fresh, false);
  assert.equal(body.goal.recommended_sip, null);
  assert.equal(body.goal.probability_of_success, null);
});

test('committed goal update reports unreconciled integrity failure instead of ordinary mutation failure', async () => {
  const profile = await createFixture();
  const createResponse = await submitGoal(profile, 'Ignore the profile during goal-update corruption');
  const created = await createResponse.json();
  assert.equal(createResponse.status, 201, JSON.stringify(created));
  const goalId = String(created.goal._id);
  const uninstall = installFinancialStateTestHook(async boundary => {
    if (boundary === 'goal.update.afterCommitBeforeResponse') {
      await RecommendationState.deleteOne({ userId: userA, profileId: profile._id });
    }
  });
  let response;
  try {
    response = await patchGoal(goalId, {
      expectedVersion: created.goal.version,
      priority: 'Critical',
    });
  } finally {
    uninstall();
  }
  const body = await response.json();
  assert.equal(response.status, 503, JSON.stringify(body));
  assert.equal(body.code, 'COMMITTED_BUT_RESPONSE_RECONCILIATION_FAILED');
  assert.equal(body.details.operation_committed, true);
  assert.equal(Object.hasOwn(body, 'goal'), false);
  const stored = await Goal.findById(goalId).lean();
  assert.equal(stored.version, created.goal.version + 1);
  assert.equal(stored.priority, 'Critical');
});

test('goal recalculation cannot overwrite an intervening goal version update', async () => {
  const profile = await createFixture();
  const createResponse = await submitGoal(profile, 'Ignore the profile during goal CAS test');
  const created = await createResponse.json();
  assert.equal(createResponse.status, 201, JSON.stringify(created));
  const goalId = String(created.goal._id);
  const barrier = createBarrier();
  let paused = false;
  const uninstall = installFinancialStateTestHook(async boundary => {
    if (boundary === 'goal.calculation.beforeStateRecheck' && !paused) {
      paused = true;
      await barrier.pause();
    }
  });
  const staleRecalculation = patchGoal(goalId, {
    expectedVersion: created.goal.version,
    target_amount: 800000,
  });
  try {
    await barrier.entered;
    const concurrentPriority = await patchGoal(goalId, {
      expectedVersion: created.goal.version,
      priority: 'Critical',
    });
    const concurrentBody = await concurrentPriority.json();
    assert.equal(concurrentPriority.status, 200, JSON.stringify(concurrentBody));
    assert.equal(concurrentBody.goal.version, created.goal.version + 1);
    assert.equal(concurrentBody.goal.priority, 'Critical');
  } finally {
    barrier.release();
    uninstall();
  }
  const staleResponse = await staleRecalculation;
  const staleBody = await staleResponse.json();
  assert.equal(staleResponse.status, 409, JSON.stringify(staleBody));
  assert.equal(staleBody.code, 'GOAL_VERSION_CONFLICT');
  const stored = await Goal.findById(goalId).lean();
  assert.equal(stored.version, created.goal.version + 1);
  assert.equal(stored.target_amount, created.goal.target_amount, 'the losing Monte Carlo result cannot overwrite newer goal state');
  assert.equal(stored.priority, 'Critical');
});

test('goal advice generated for an older goal version is rejected before persistence', async () => {
  const profile = await createFixture();
  const createResponse = await submitGoal(profile, 'Ignore the profile during advice CAS test');
  const created = await createResponse.json();
  assert.equal(createResponse.status, 201, JSON.stringify(created));
  const goalId = String(created.goal._id);
  const before = await Goal.findById(goalId).lean();
  const barrier = createBarrier();
  let paused = false;
  const uninstall = installFinancialStateTestHook(async boundary => {
    if (boundary === 'goal.advisory.beforePersistence' && !paused) {
      paused = true;
      await barrier.pause();
    }
  });
  const staleAdvice = fetch(`${baseUrl}/api/goals/${goalId}/refresh-advice`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${signToken(userA)}` },
  });
  try {
    await barrier.entered;
    const concurrentPriority = await patchGoal(goalId, {
      expectedVersion: before.version,
      priority: 'Critical',
    });
    assert.equal(concurrentPriority.status, 200);
  } finally {
    barrier.release();
    uninstall();
  }
  const response = await staleAdvice;
  const body = await response.json();
  assert.equal(response.status, 409, JSON.stringify(body));
  assert.equal(body.code, 'GOAL_VERSION_CONFLICT');
  const stored = await Goal.findById(goalId).lean();
  assert.equal(stored.version, before.version + 1);
  assert.equal(stored.priority, 'Critical');
  assert.equal(stored.gemini_advice, before.gemini_advice, 'advice based on the prior goal version must not overwrite stored advice');
  assert.equal(stored.advisoryMetadata.goalVersion, before.advisoryMetadata.goalVersion);
});

test('goal delete requires and atomically enforces the expected resource version', async () => {
  const profile = await createFixture();
  const createResponse = await submitGoal(profile, 'Ignore the profile during delete CAS test');
  const created = await createResponse.json();
  assert.equal(createResponse.status, 201, JSON.stringify(created));
  const goalId = String(created.goal._id);
  const missingPrecondition = await fetch(`${baseUrl}/api/goals/${goalId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${signToken(userA)}` },
  });
  assert.equal(missingPrecondition.status, 428);
  await assertFetchResponseMatchesOpenApi(missingPrecondition, 'DELETE', '/api/goals/{goalId}');
  const updateResponse = await patchGoal(goalId, { expectedVersion: created.goal.version, priority: 'Critical' });
  assert.equal(updateResponse.status, 200);
  const updated = await updateResponse.json();
  assert.equal(updated.goal.version, created.goal.version + 1);

  const staleDelete = await fetch(`${baseUrl}/api/goals/${goalId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${signToken(userA)}`, 'If-Match': String(created.goal.version) },
  });
  const staleBody = await staleDelete.json();
  assert.equal(staleDelete.status, 409, JSON.stringify(staleBody));
  await assertFetchResponseMatchesOpenApi(staleDelete, 'DELETE', '/api/goals/{goalId}', { body: staleBody });
  assert.equal(staleBody.code, 'GOAL_VERSION_CONFLICT');
  assert.ok(await Goal.exists({ _id: goalId, userId: userA }), 'stale delete must preserve the goal');

  const currentDelete = await fetch(`${baseUrl}/api/goals/${goalId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${signToken(userA)}`, 'If-Match': String(updated.goal.version) },
  });
  const currentBody = await currentDelete.json();
  assert.equal(currentDelete.status, 200, JSON.stringify(currentBody));
  await assertFetchResponseMatchesOpenApi(currentDelete, 'DELETE', '/api/goals/{goalId}', { body: currentBody });
  assert.equal(currentBody.deleted, true);
  assert.equal(await Goal.exists({ _id: goalId, userId: userA }), null, 'current-version delete must remove the goal');
});

test('tampering with any hashed allocation-transition fact invalidates audit and current-state resolution', async () => {
  const profile = await createFixture();
  const args = await rebalanceInput(profile, 'transition-tamper');
  await createManualAllocationRevision(args);
  const revision = await RecommendationAllocationRevision.findOne({ recommendationId: args.recommendationId, revision: 2 }).lean();
  const audit = await AuditRecord.findById(revision.auditRecordId).lean();
  const followupArgs = await rebalanceInput(profile, 'tampered-audit-write-block');
  const mutations = [
    ['previousAllocationRevisionId', { 'allocation_transition.previousAllocationRevisionId': new mongoose.Types.ObjectId() }],
    ['newAllocationRevisionId', { 'allocation_transition.newAllocationRevisionId': new mongoose.Types.ObjectId() }],
    ['oldPortfolioFingerprint', { 'allocation_transition.oldPortfolioFingerprint': '1'.repeat(64) }],
    ['newPortfolioFingerprint', { 'allocation_transition.newPortfolioFingerprint': '2'.repeat(64) }],
    ['recommendationFingerprint', { 'allocation_transition.recommendationFingerprint': '3'.repeat(64) }],
    ['returnAssumptionHash', { 'allocation_transition.returnAssumptionHash': '4'.repeat(64) }],
    ['profileVersion', { 'allocation_transition.profileVersion': 99 }],
  ];

  for (const [field, update] of mutations) {
    await AuditRecord.collection.updateOne({ _id: audit._id }, { $set: update });
    assert.equal((await verifyAuditChain(userA)).valid, false, `${field} must change the hash-chain result`);
    await assert.rejects(requireFreshRecommendationState({ userId: userA, profileId: profile._id }), undefined, `${field} must fail current-state resolution`);
    await assert.rejects(
      createManualAllocationRevision(followupArgs),
      error => ['ALLOCATION_AUDIT_HASH_MISMATCH', 'ALLOCATION_AUDIT_BINDING_MISMATCH'].includes(error.code),
      `${field} must also block a write based on the tampered revision`,
    );
    await AuditRecord.collection.replaceOne({ _id: audit._id }, audit);
    assert.equal((await verifyAuditChain(userA)).valid, true, `${field} restore must revalidate the chain`);
  }
});

test('a stale canonical allocation pointer cannot hide a newer persisted revision', async () => {
  const profile = await createFixture();
  const args = await rebalanceInput(profile, 'stale-allocation-pointer');
  const created = await createManualAllocationRevision(args);
  const prior = await RecommendationAllocationRevision.findById(created.revision.previousAllocationRevisionId).lean();

  await RecommendationState.collection.updateOne(
    { userId: userA, profileId: profile._id },
    { $set: {
      currentAllocationRevision: prior.revision,
      currentAllocationRevisionId: prior._id,
      portfolioFingerprint: prior.portfolioFingerprint,
    } },
  );

  await assert.rejects(
    requireFreshRecommendationState({ userId: userA, profileId: profile._id }),
    error => error.code === 'ALLOCATION_REVISION_POINTER_STALE',
  );
  await assert.rejects(
    createManualAllocationRevision(args),
    error => error.code === 'ALLOCATION_REVISION_POINTER_STALE',
    'rebalance must not branch from a stale canonical pointer',
  );
  assert.equal(await RecommendationAllocationRevision.countDocuments({ recommendationId: args.recommendationId }), 2);
});

test('tampering with the previous revision contents fails current-state resolution', async () => {
  const profile = await createFixture();
  const args = await rebalanceInput(profile, 'previous-revision-content-tamper');
  const created = await createManualAllocationRevision(args);
  const priorRevisionId = created.revision.previousAllocationRevisionId;
  const prior = await RecommendationAllocationRevision.findById(priorRevisionId).lean();
  assert.ok(prior.instruments.length > 0);

  await RecommendationAllocationRevision.collection.updateOne(
    { _id: priorRevisionId },
    { $set: { 'instruments.0.allocationWeight': prior.instruments[0].allocationWeight / 2 } },
  );

  await assert.rejects(
    requireFreshRecommendationState({ userId: userA, profileId: profile._id }),
    error => error.code === 'ALLOCATION_PREVIOUS_REVISION_FINGERPRINT_MISMATCH',
  );
});
