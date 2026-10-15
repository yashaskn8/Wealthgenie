import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import Recommendation from '../models/Recommendation.js';
import FinancialProfile from '../models/FinancialProfile.js';
import AuditRecord from '../models/AuditRecord.js';
import AuditChainHead from '../models/AuditChainHead.js';
import IdempotencyKey from '../models/IdempotencyKey.js';
import RecommendationAllocationRevision from '../models/RecommendationAllocationRevision.js';
import RecommendationState from '../models/RecommendationState.js';
import FinancialProfileState from '../models/FinancialProfileState.js';
import AuthorizedExecutionAttempt from '../models/AuthorizedExecutionAttempt.js';
import {
  claimAdvisoryIdempotency,
  releaseAdvisoryIdempotency,
} from '../middleware/idempotency.js';
import { persistAdvisoryAtomically } from '../services/advisoryPersistence.js';
import { buildCanonicalAdvisoryResponse } from '../services/advisoryResponse.js';
import { verifyAuditChain } from '../services/auditChain.js';
import { createManualAllocationRevision } from '../services/recommendationState.js';
import { getCurrentRegulatoryRuleVersion } from '../services/taxEngine.js';
import { buildRecommendationProfileHash, RECOMMENDATION_POLICY_VERSION } from '../services/recommendationProfile.js';
import { buildSnapshotFingerprint } from '../agents/authorization/mandateService.js';
import { setupTestDatabase, teardownTestDatabase } from './helpers/mongoTestHelper.js';
import { canonicalProfile } from './helpers/canonicalProfile.js';
import { canonicalSha256 } from '../utils/canonicalJson.js';
import {
  PROJECTION_ASSUMPTION_POLICY_HASH,
  PROJECTION_ASSUMPTION_SOURCE,
  PROJECTION_ASSUMPTION_VERSION,
} from '../services/instrumentConstants.js';

const userId = new mongoose.Types.ObjectId();
const profileId = new mongoose.Types.ObjectId();
const testProfile = canonicalProfile({ monthlyTakeHome: 100000, monthlySavings: 25000, age: 30 });

function makeOperation(claim, suffix = '', { profileInput = testProfile, profileVersion = 1 } = {}) {
  const recommendationId = new mongoose.Types.ObjectId();
  const auditId = new mongoose.Types.ObjectId();
  const profileInputHash = buildRecommendationProfileHash(profileInput, { modelVersion: 'rule_fallback' });
  const response = {
    recommendationId,
    audit_id: auditId,
    advisory_text: `Atomic advisory ${suffix}`,
    model_version: 'rule_fallback',
  };
  return {
    recommendation: {
      _id: recommendationId,
      userId,
      profileId,
      instruments: [{
        id: `fixture-${suffix}`, name: 'Fixture Fund', type: 'Equity_MF', assetClass: 'Equity',
        nominalReturn: 12, effectiveYield: 12, postTaxReturn: null,
        returnBasis: 'PRE_TAX_NOMINAL', expenseRatio: 0.005,
        returnAssumptionVersion: PROJECTION_ASSUMPTION_VERSION,
        returnAssumptionHash: PROJECTION_ASSUMPTION_POLICY_HASH,
        returnSource: PROJECTION_ASSUMPTION_SOURCE,
        riskLevel: 'Medium', riskScore: 3, lockIn: 0, tags: ['Wealth Growth'],
        score: 80, scoreFactors: {
          expectedReturn: 60, riskFit: 100, liquidity: 80, goalFit: 100,
          horizonFit: 100, cost: 90, mlConfidence: 0,
        },
        allocation_pct: 100, allocationWeight: 1,
      }],
      advisoryText: response.advisory_text,
      confidenceScores: {},
      mlFallback: true,
      modelVersion: 'rule_fallback',
      regulatoryRuleVersion: getCurrentRegulatoryRuleVersion(),
      profileVersion,
      recommendationPolicyVersion: RECOMMENDATION_POLICY_VERSION,
      profileInputHash,
    },
    auditRecord: {
      _id: auditId,
      userId,
      profileId,
      recommendationId,
      correlationId: `atomic-test-${suffix}`,
      traceId: '',
      version_id: 'rule_fallback',
      regulatory_rule_version: getCurrentRegulatoryRuleVersion(),
      input_hash: `input-hash-${suffix}`,
      inputs: {
        financial_profile_schema_version: 'financial-profile-1.0.0',
        recommendation_policy_version: RECOMMENDATION_POLICY_VERSION,
        age: 30, monthly_take_home: 100000, monthly_savings: 25000,
      },
      recommendations: { instruments: [{ id: `fixture-${suffix}`, allocationWeight: 1 }] },
      cited_rag_chunk_ids: [],
      engine: 'rule_fallback',
      timestamp: new Date(),
    },
    response,
    idempotencyClaim: claim,
    profileStateBinding: { revision: 1, currentProfileId: String(profileId) },
  };
}

async function claim(key, payload = { profileId: profileId.toString() }) {
  return claimAdvisoryIdempotency({ key, userId, profileId, payload, waitMs: 10000 });
}

function createBarrier() {
  let markEntered;
  let open;
  const entered = new Promise(resolve => { markEntered = resolve; });
  const released = new Promise(resolve => { open = resolve; });
  return { entered, async pause() { markEntered(); await released; }, release() { open(); } };
}

test.before(async () => {
  await setupTestDatabase({ requireReplicaSet: true });
  await Promise.all([Recommendation.init(), AuditRecord.init(), IdempotencyKey.init()]);
});

test.beforeEach(async () => {
  await Promise.all([
    FinancialProfile.deleteMany({ userId }),
    Recommendation.deleteMany({ userId }),
    // Production blocks deletion to preserve append-only history. The test
    // harness clears its fixture rows through the raw collection instead.
    RecommendationAllocationRevision.collection.deleteMany({ userId }),
    RecommendationState.deleteMany({ userId }),
    FinancialProfileState.deleteMany({ userId }),
    AuthorizedExecutionAttempt.deleteMany({ userId }),
    AuditRecord.collection.deleteMany({ userId }),
    AuditChainHead.deleteMany({ _id: userId }),
    IdempotencyKey.deleteMany({ userId }),
  ]);
  await FinancialProfile.create({
    _id: profileId,
    userId,
    ...testProfile,
    recommendationProfileVersion: 'financial-profile-1.1.0',
  });
  await FinancialProfileState.create({
    userId, currentProfileId: profileId, revision: 1, promotionFence: 0, resolutionStatus: 'CURRENT',
  });
});

test.after(async () => {
  await Promise.all([
    FinancialProfile.deleteMany({ userId }),
    Recommendation.deleteMany({ userId }),
    RecommendationAllocationRevision.collection.deleteMany({ userId }),
    RecommendationState.deleteMany({ userId }),
    FinancialProfileState.deleteMany({ userId }),
    AuthorizedExecutionAttempt.deleteMany({ userId }),
    AuditRecord.collection.deleteMany({ userId }),
    AuditChainHead.deleteMany({ _id: userId }),
    IdempotencyKey.deleteMany({ userId }),
  ]).catch(() => {});
  await teardownTestDatabase();
});

test('advisory idempotency binds the HTTP method to the durable request identity', async () => {
  const request = {
    key: 'profile-method-binding-001',
    userId,
    profileId,
    operation: 'profile.update_and_recommendation',
    payload: { version: 1, monthly_savings: 25000 },
  };
  const claim = await claimAdvisoryIdempotency({ ...request, method: 'put' });
  try {
    const persisted = await IdempotencyKey.findById(claim.operationId).lean();
    assert.equal(persisted.method, 'PUT');
    await assert.rejects(
      claimAdvisoryIdempotency({ ...request, method: 'POST' }),
      error => error.status === 409 && error.code === 'IDEMPOTENCY_PAYLOAD_CONFLICT',
    );
  } finally {
    await releaseAdvisoryIdempotency(claim);
  }
});

test('profile PUT can reclaim a legacy POST-bound advisory lock without changing its durable hash', async () => {
  const request = {
    key: 'profile-method-binding-legacy-001',
    userId,
    profileId,
    operation: 'profile.update_and_recommendation',
    payload: { version: 2, monthly_savings: 30000 },
  };
  const legacyClaim = await claimAdvisoryIdempotency({ ...request, method: 'POST' });
  clearInterval(legacyClaim.heartbeat);
  await IdempotencyKey.updateOne({ _id: legacyClaim.operationId, status: 'LOCK' }, {
    $set: { leaseExpiresAt: new Date(Date.now() - 1000) },
  });

  let claim;
  try {
    claim = await claimAdvisoryIdempotency({ ...request, method: 'PUT', waitMs: 100 });
    assert.equal(claim.state, 'CLAIMED');
    assert.equal(claim.requestHash, legacyClaim.requestHash);
    const persisted = await IdempotencyKey.findById(claim.operationId).lean();
    assert.equal(persisted.method, 'POST');
    assert.equal(persisted.requestHash, legacyClaim.requestHash);
  } finally {
    if (claim) await releaseAdvisoryIdempotency(claim);
    else await IdempotencyKey.deleteOne({ _id: legacyClaim.operationId, status: 'LOCK' });
  }
});

test('completed legacy profile PUT operation replays without creating duplicate effects', async () => {
  const request = {
    key: 'profile-method-binding-legacy-complete-001',
    userId,
    profileId,
    operation: 'profile.update_and_recommendation',
    payload: { version: 3, monthly_savings: 35000 },
  };
  const legacyClaim = await claimAdvisoryIdempotency({ ...request, method: 'POST' });
  const operation = makeOperation(legacyClaim, 'legacy-profile-put-replay');
  await persistAdvisoryAtomically(operation);

  const replay = await claimAdvisoryIdempotency({ ...request, method: 'PUT' });
  assert.equal(replay.state, 'REPLAY');
  assert.equal(replay.response.status, 200);
  assert.ok(replay.response.body);
  assert.equal(await Recommendation.countDocuments({ userId }), 1);
  assert.equal(await AuditRecord.countDocuments({ userId }), 1);
  const persistedKey = await IdempotencyKey.findById(legacyClaim.operationId).lean();
  assert.equal(persistedKey.method, 'POST');
  assert.equal(persistedKey.status, 'DONE');
});

test('failure after recommendation creation rolls back recommendation and audit', async () => {
  const operationClaim = await claim('atomic-after-rec-001');
  await assert.rejects(
    persistAdvisoryAtomically({
      ...makeOperation(operationClaim, 'after-rec'),
      testHooks: { afterRecommendationCreate: () => { throw new Error('injected after recommendation'); } },
    }),
    /injected after recommendation/,
  );
  await releaseAdvisoryIdempotency(operationClaim);

  assert.equal(await Recommendation.countDocuments({ userId }), 0);
  assert.equal(await AuditRecord.countDocuments({ userId }), 0);
});

test('barrier-controlled recommendation generation loses to a concurrently committed profile edit', async () => {
  const operationClaim = await claim('atomic-profile-race-001');
  const barrier = createBarrier();
  let paused = false;
  const pending = persistAdvisoryAtomically({
    ...makeOperation(operationClaim, 'profile-race'),
    testHooks: {
      afterSourceProfileRead: async () => {
        if (paused) return;
        paused = true;
        await barrier.pause();
      },
    },
  });
  await barrier.entered;
  await FinancialProfile.updateOne({ _id: profileId, userId }, {
    $set: { monthlySavings: 30000 },
    $inc: { version: 1, financialStateFence: 1 },
  });
  barrier.release();
  await assert.rejects(pending, error => error.code === 'PROFILE_STATE_CHANGED' || /write conflict/i.test(error.message));
  await releaseAdvisoryIdempotency(operationClaim);
  const changedProfile = await FinancialProfile.findOne({ _id: profileId, userId }).lean();
  assert.equal(changedProfile.version, 2);
  assert.equal(changedProfile.financialStateFence, 1);
  assert.equal(await Recommendation.countDocuments({ userId }), 0);
  assert.equal(await RecommendationAllocationRevision.countDocuments({ userId }), 0);
  assert.equal(await RecommendationState.countDocuments({ userId }), 0);
  assert.equal(await AuditRecord.countDocuments({ userId }), 0);
  assert.equal(await AuditChainHead.countDocuments({ _id: userId }), 0);
});

test('audit write validation failure rolls back recommendation and audit', async () => {
  const operationClaim = await claim('atomic-audit-fail-001');
  const operation = makeOperation(operationClaim, 'audit-fail');
  delete operation.auditRecord.recommendations;

  await assert.rejects(persistAdvisoryAtomically(operation), /recommendations.*required/i);
  await releaseAdvisoryIdempotency(operationClaim);

  assert.equal(await Recommendation.countDocuments({ userId }), 0);
  assert.equal(await AuditRecord.countDocuments({ userId }), 0);
});

test('successful advisory transaction persists exactly one recommendation and audit', async () => {
  const operationClaim = await claim('atomic-success-001');
  const operation = makeOperation(operationClaim, 'success');
  const result = await persistAdvisoryAtomically(operation);

  assert.equal(await Recommendation.countDocuments({ userId }), 1);
  assert.equal(await AuditRecord.countDocuments({ userId }), 1);
  assert.equal(String(result.recommendationId), String(operation.recommendation._id));
  assert.equal(String(result.audit_id), String(operation.auditRecord._id));
  assert.equal(result.response_state, 'CURRENT');
  assert.equal(result.allocation_revision, 1);
  assert.match(String(result.allocation_revision_id), /^[a-f\d]{24}$/i);
  assert.match(result.portfolio_fingerprint, /^[a-f\d]{64}$/i);
  assert.equal(result.calculation_freshness.fresh, true);
  assert.deepEqual(result.calculation_freshness.reasonCodes, []);
  assert.equal(result.state_provenance.status, 'PERSISTED_REVISION');
  const persistedRevision = await RecommendationAllocationRevision.findById(result.allocation_revision_id).lean();
  assert.equal(String(persistedRevision.recommendationId), String(operation.recommendation._id));
  assert.equal(persistedRevision.revision, result.allocation_revision);
  assert.equal(persistedRevision.portfolioFingerprint, result.portfolio_fingerprint);
});

test('authorized advisory and COMMITTED receipt reference become durable in the same transaction', async () => {
  const operationClaim = await claim('atomic-authorized-commit-001');
  const operation = makeOperation(operationClaim, 'authorized-commit');
  const execution = {
    executionId: crypto.randomUUID(),
    mandateId: crypto.randomUUID(),
    userId,
    action: 'APPROVE_RECOMPUTE',
    status: 'EXECUTING',
    executionGeneration: 2,
    workerId: 'worker-authorized-commit',
    leaseUntil: new Date(Date.now() + 60000),
    heartbeatAt: new Date(),
    startedAt: new Date(),
    idempotencyKey: `mandate:${crypto.randomUUID()}`,
    financialSnapshotHash: 'a'.repeat(64),
  };
  await AuthorizedExecutionAttempt.create(execution);
  const profile = await FinancialProfile.findOne({ _id: profileId, userId }).lean();
  const expectedSnapshot = buildSnapshotFingerprint({ profile, recommendation: operation.recommendation });

  const result = await persistAdvisoryAtomically({
    ...operation,
    executionCommit: {
      executionId: execution.executionId,
      mandateId: execution.mandateId,
      userId,
      executionGeneration: execution.executionGeneration,
      workerId: execution.workerId,
      afterSnapshotHash: expectedSnapshot.financialSnapshotHash,
      policyDecisionId: 'policy:atomic-authorized-commit',
    },
  });

  const committed = await AuthorizedExecutionAttempt.findOne({ executionId: execution.executionId }).lean();
  assert.equal(committed.status, 'COMMITTED');
  assert.equal(committed.resultReference.recommendationId, String(operation.recommendation._id));
  assert.equal(committed.resultReference.auditHash, result.audit_hash);
  assert.equal(committed.resultReference.afterSnapshotHash, expectedSnapshot.financialSnapshotHash);
  assert.match(committed.resultReference.responseHash, /^[a-f0-9]{64}$/);
  const persistedRecommendation = await Recommendation.findById(operation.recommendation._id).lean();
  assert.equal(committed.resultReference.responseHash, canonicalSha256(persistedRecommendation.responseSnapshot));
  assert.equal(committed.resultReference.policyDecisionId, 'policy:atomic-authorized-commit');
  assert.equal(await Recommendation.countDocuments({ userId }), 1);
  assert.equal(await AuditRecord.countDocuments({ userId }), 1);
  assert.equal((await IdempotencyKey.findById(operationClaim.operationId).lean()).status, 'DONE');
});

test('failure after authorized commit marker rolls back the recommendation, audit, idempotency, and receipt reference', async () => {
  const operationClaim = await claim('atomic-authorized-rollback-001');
  const operation = makeOperation(operationClaim, 'authorized-rollback');
  const execution = {
    executionId: crypto.randomUUID(),
    mandateId: crypto.randomUUID(),
    userId,
    action: 'APPROVE_RECOMPUTE',
    status: 'EXECUTING',
    executionGeneration: 1,
    workerId: 'worker-authorized-rollback',
    leaseUntil: new Date(Date.now() + 60000),
    heartbeatAt: new Date(),
    startedAt: new Date(),
    idempotencyKey: `mandate:${crypto.randomUUID()}`,
    financialSnapshotHash: 'b'.repeat(64),
  };
  await AuthorizedExecutionAttempt.create(execution);
  const profile = await FinancialProfile.findOne({ _id: profileId, userId }).lean();
  const expectedSnapshot = buildSnapshotFingerprint({ profile, recommendation: operation.recommendation });

  await assert.rejects(persistAdvisoryAtomically({
    ...operation,
    executionCommit: {
      executionId: execution.executionId,
      mandateId: execution.mandateId,
      userId,
      executionGeneration: execution.executionGeneration,
      workerId: execution.workerId,
      afterSnapshotHash: expectedSnapshot.financialSnapshotHash,
      policyDecisionId: 'policy:atomic-authorized-rollback',
    },
    testHooks: { afterExecutionCommitMark: () => { throw new Error('injected after authorized commit mark'); } },
  }), /injected after authorized commit mark/);
  await releaseAdvisoryIdempotency(operationClaim);

  const rolledBackAttempt = await AuthorizedExecutionAttempt.findOne({ executionId: execution.executionId }).lean();
  assert.equal(rolledBackAttempt.status, 'EXECUTING');
  assert.equal(rolledBackAttempt.resultReference, null);
  assert.equal(await Recommendation.countDocuments({ userId }), 0);
  assert.equal(await RecommendationAllocationRevision.countDocuments({ userId }), 0);
  assert.equal(await RecommendationState.countDocuments({ userId }), 0);
  assert.equal(await AuditRecord.countDocuments({ userId }), 0);
  assert.equal(await AuditChainHead.countDocuments({ _id: userId }), 0);
  assert.notEqual((await IdempotencyKey.findById(operationClaim.operationId).lean())?.status, 'DONE');
  const unchangedProfile = await FinancialProfile.findOne({ _id: profileId, userId }).lean();
  assert.equal(unchangedProfile.financialStateFence || 0, 0);
});

test('post-commit supersession returns newer canonical state and idempotent replay creates no duplicate effects', async () => {
  const keyA = 'atomic-post-commit-race-a';
  const keyB = 'atomic-post-commit-race-b';
  const payloadA = { profileId: profileId.toString(), request: 'race-a' };
  const payloadB = { profileId: profileId.toString(), request: 'race-b' };
  const claimA = await claim(keyA, payloadA);
  const claimB = await claim(keyB, payloadB);
  const operationA = makeOperation(claimA, 'race-A');
  operationA.response = {
    profile: { profileId: String(profileId), generation: 'from-A' },
    recommendation: { recommendationId: String(operationA.recommendation._id) },
    completion: {
      status: 'COMMITTED',
      profileId: String(profileId),
      recommendationId: String(operationA.recommendation._id),
    },
  };
  const operationB = makeOperation(claimB, 'race-B');
  const barrier = createBarrier();
  const pendingA = persistAdvisoryAtomically({
    ...operationA,
    testHooks: { afterCommitBeforeReconcile: barrier.pause },
  });

  await barrier.entered;
  const idA = String(operationA.recommendation._id);
  assert.equal(await Recommendation.countDocuments({ _id: idA, userId, idempotencyOperationId: claimA.operationId }), 1);
  assert.equal(String((await RecommendationState.findOne({ userId, profileId }).lean()).currentRecommendationId), idA);

  const resultB = await persistAdvisoryAtomically(operationB);
  const idB = String(operationB.recommendation._id);
  assert.equal(String(resultB.recommendationId), idB);
  barrier.release();
  const resultA = await pendingA;

  const currentState = await RecommendationState.findOne({ userId, profileId }).lean();
  const currentRevision = await RecommendationAllocationRevision.findOne({
    _id: currentState.currentAllocationRevisionId,
    recommendationId: operationB.recommendation._id,
  }).lean();
  assert.equal(String(currentState.currentRecommendationId), idB);
  assert.equal(String(resultA.recommendation.recommendationId), idB);
  assert.equal(resultA.recommendation.response_state, 'CURRENT');
  assert.equal(resultA.recommendation.calculation_freshness.fresh, true);
  assert.equal(resultA.recommendation.profile_input_hash, operationB.recommendation.profileInputHash);
  assert.equal(resultA.recommendation.allocation_revision_id, String(currentRevision._id));
  assert.equal(resultA.recommendation.portfolio_fingerprint, currentRevision.portfolioFingerprint);
  assert.equal(resultA.recommendation.recommendation_fingerprint, currentRevision.recommendationFingerprint);
  assert.deepEqual(resultA.recommendation.instruments.map(item => item.id), ['fixture-race-B']);
  assert.equal(resultA.completion.recommendationId, idB);
  assert.deepEqual(resultA.operation_result, {
    committed: true,
    generated_recommendation_id: idA,
    superseded_before_response: true,
  });

  await assert.rejects(
    buildCanonicalAdvisoryResponse({ userId, profileId, expectedRecommendationId: idA }),
    error => error.code === 'RECOMMENDATION_SUPERSEDED',
  );

  const replayA = await claim(keyA, payloadA);
  const replayB = await claim(keyB, payloadB);
  assert.equal(replayA.state, 'REPLAY');
  assert.equal(replayB.state, 'REPLAY');
  assert.equal(String(replayA.response.body.recommendation.recommendationId), idB);
  assert.equal(replayA.response.body.recommendation.response_state, 'CURRENT');
  assert.deepEqual(replayA.response.body.operation_result, resultA.operation_result);
  assert.equal(String(replayB.response.body.recommendationId), idB);
  assert.equal(replayB.response.body.response_state, 'CURRENT');

  assert.equal(await Recommendation.countDocuments({ userId }), 2);
  assert.equal(await Recommendation.countDocuments({ _id: { $in: [operationA.recommendation._id, operationB.recommendation._id] }, userId }), 2);
  assert.equal(await RecommendationAllocationRevision.countDocuments({ userId }), 2);
  assert.equal(await AuditRecord.countDocuments({ userId }), 2);
  assert.equal((await IdempotencyKey.find({ userId }).lean()).filter(item => item.status === 'DONE').length, 2);
  const auditVerification = await verifyAuditChain(userId);
  assert.equal(auditVerification.valid, true, JSON.stringify(auditVerification.errors));
  assert.equal(auditVerification.checkedRecords, 2);
});

test('post-commit canonical pointer corruption is explicit and retry cannot duplicate the committed operation', async () => {
  const key = 'atomic-post-commit-corrupt-pointer';
  const payload = { profileId: profileId.toString(), request: 'corrupt-pointer' };
  const operationClaim = await claim(key, payload);
  const operation = makeOperation(operationClaim, 'corrupt-pointer');
  await assert.rejects(
    persistAdvisoryAtomically({
      ...operation,
      testHooks: {
        afterCommitBeforeReconcile: async () => {
          await RecommendationState.deleteOne({ userId, profileId });
        },
      },
    }),
    error => error.code === 'COMMITTED_BUT_RESPONSE_RECONCILIATION_FAILED'
      && error.committed === true
      && error.cause?.code === 'FINANCIAL_STATE_MISSING',
  );

  assert.equal(await Recommendation.countDocuments({ _id: operation.recommendation._id, userId }), 1);
  assert.equal(await RecommendationAllocationRevision.countDocuments({ recommendationId: operation.recommendation._id, userId }), 1);
  assert.equal(await AuditRecord.countDocuments({ recommendationId: operation.recommendation._id, userId }), 1);
  assert.equal((await IdempotencyKey.findById(operationClaim.operationId).lean()).status, 'DONE');
  await assert.rejects(claim(key, payload), error => error.code === 'COMMITTED_BUT_RESPONSE_RECONCILIATION_FAILED');
  assert.equal(await Recommendation.countDocuments({ userId }), 1);
  assert.equal(await RecommendationAllocationRevision.countDocuments({ userId }), 1);
  assert.equal(await AuditRecord.countDocuments({ userId }), 1);
});

test('profile version change after commit never returns the stale generation as current', async () => {
  const key = 'atomic-post-commit-profile-change';
  const payload = { profileId: profileId.toString(), request: 'profile-change' };
  const operationClaim = await claim(key, payload);
  const operation = makeOperation(operationClaim, 'profile-change');
  const barrier = createBarrier();
  const pending = persistAdvisoryAtomically({
    ...operation,
    testHooks: { afterCommitBeforeReconcile: barrier.pause },
  });
  await barrier.entered;
  await FinancialProfile.updateOne({ _id: profileId, userId }, {
    $set: { monthlySavings: 30000 },
    $inc: { version: 1, financialStateFence: 1 },
  });
  barrier.release();

  await assert.rejects(pending, error => error.code === 'COMMITTED_BUT_RESPONSE_RECONCILIATION_FAILED'
    && error.committed === true);
  assert.equal(await Recommendation.countDocuments({ _id: operation.recommendation._id, userId }), 1);
  assert.equal(String((await RecommendationState.findOne({ userId, profileId }).lean()).currentRecommendationId), String(operation.recommendation._id));
  await assert.rejects(claim(key, payload), error => error.code === 'COMMITTED_BUT_RESPONSE_RECONCILIATION_FAILED');
  assert.equal(await Recommendation.countDocuments({ userId }), 1);
  assert.equal(await RecommendationAllocationRevision.countDocuments({ userId }), 1);
  assert.equal(await AuditRecord.countDocuments({ userId }), 1);
});

test('profile completion reconciles to a fresh successor after a profile version change', async () => {
  const keyA = 'atomic-completion-profile-race-a';
  const keyB = 'atomic-completion-profile-race-b';
  const payloadA = { profileId: profileId.toString(), request: 'completion-a' };
  const payloadB = { profileId: profileId.toString(), request: 'completion-b' };
  const claimA = await claim(keyA, payloadA);
  const claimB = await claim(keyB, payloadB);
  const operationA = makeOperation(claimA, 'completion-A');
  operationA.response = {
    profile: { profileId: String(profileId), staleGeneration: true },
    recommendation: { recommendationId: String(operationA.recommendation._id) },
    completion: { status: 'COMMITTED', profileId: String(profileId), recommendationId: String(operationA.recommendation._id) },
  };
  const barrier = createBarrier();
  const pendingA = persistAdvisoryAtomically({
    ...operationA,
    testHooks: { afterCommitBeforeReconcile: barrier.pause },
  });
  await barrier.entered;
  await FinancialProfile.updateOne({ _id: profileId, userId }, {
    $set: { monthlySavings: 30000 },
    $inc: { version: 1, financialStateFence: 1 },
  });

  const currentProfile = canonicalProfile({ monthlyTakeHome: 100000, monthlySavings: 30000, age: 30 });
  const operationB = makeOperation(claimB, 'completion-B', { profileInput: currentProfile, profileVersion: 2 });
  const resultB = await persistAdvisoryAtomically(operationB);
  barrier.release();
  const resultA = await pendingA;

  assert.equal(resultA.recommendation.response_state, 'CURRENT');
  assert.equal(resultA.recommendation.calculation_freshness.fresh, true);
  assert.equal(String(resultA.recommendation.recommendationId), String(operationB.recommendation._id));
  assert.equal(resultA.completion.profileId, String(profileId));
  assert.equal(resultA.completion.recommendationId, String(operationB.recommendation._id));
  assert.deepEqual(resultA.operation_result, {
    committed: true,
    generated_recommendation_id: String(operationA.recommendation._id),
    superseded_before_response: true,
  });
  assert.equal(await Recommendation.countDocuments({ userId }), 2);
  assert.equal(await RecommendationAllocationRevision.countDocuments({ userId }), 2);
  assert.equal(await AuditRecord.countDocuments({ userId }), 2);
  assert.equal(String(resultB.recommendationId), String(operationB.recommendation._id));
});

test('idempotency replay reconstructs the canonical allocation after rebalance and newer generation', async () => {
  const key = 'atomic-current-replay-001';
  const payload = { profileId: profileId.toString(), mode: 'replay-current' };
  const originalClaim = await claim(key, payload);
  const originalOperation = makeOperation(originalClaim, 'replay-original');
  originalOperation.recommendation.marketAdjustment = {
    applied: true,
    status: 'APPLIED',
    sourceProvider: 'NSE',
    currentAllocationSource: 'MARKET_CONTEXT_ADJUSTED',
  };
  originalOperation.response.market_adjustment = {
    applied: true,
    status: 'APPLIED',
    sourceProvider: 'UPSTOX',
    currentAllocationSource: 'MARKET_CONTEXT_ADJUSTED',
  };
  const original = await persistAdvisoryAtomically(originalOperation);
  const originalId = String(original.recommendationId);
  assert.equal((await Recommendation.findById(originalId).lean()).marketAdjustment.sourceProvider, 'NSE');
  assert.equal(JSON.stringify(original).includes('sourceProvider'), false);
  const initialRevision = await RecommendationAllocationRevision.findById(original.allocation_revision_id).lean();

  await createManualAllocationRevision({
    userId,
    profileId,
    recommendationId: originalId,
    expectedRevision: 1,
    expectedRecommendationId: originalId,
    expectedPortfolioFingerprint: initialRevision.portfolioFingerprint,
    instruments: initialRevision.instruments,
    correlationId: 'idempotency-replay-rebalance',
  });

  const afterRebalance = await claim(key, payload);
  assert.equal(afterRebalance.state, 'REPLAY');
  assert.equal(afterRebalance.response.body.response_state, 'CURRENT');
  assert.equal(String(afterRebalance.response.body.recommendationId), originalId);
  assert.equal(afterRebalance.response.body.allocation_revision, 2);
  assert.equal(afterRebalance.response.body.market_adjustment, null);
  assert.equal(afterRebalance.response.body.generation_market_adjustment.applied, true);
  assert.equal(JSON.stringify(afterRebalance.response.body).includes('sourceProvider'), false);
  assert.notEqual(afterRebalance.response.body.allocation_revision_id, original.allocation_revision_id);

  const newerClaim = await claim('atomic-current-replay-newer-001', { profileId: profileId.toString(), mode: 'new-generation' });
  const newer = await persistAdvisoryAtomically(makeOperation(newerClaim, 'replay-newer'));
  assert.notEqual(String(newer.recommendationId), originalId);

  const afterRefresh = await claim(key, payload);
  assert.equal(afterRefresh.state, 'REPLAY');
  assert.equal(String(afterRefresh.response.body.recommendationId), String(newer.recommendationId));
  assert.equal(afterRefresh.response.body.allocation_revision, 1);
  assert.equal(afterRefresh.response.body.portfolio_fingerprint, newer.portfolio_fingerprint);
  assert.equal(await Recommendation.countDocuments({ userId }), 2);

  await FinancialProfile.updateOne({ _id: profileId, userId }, { $inc: { version: 1, financialStateFence: 1 } });
  await assert.rejects(claim(key, payload), error => error.status === 409 || error.status === 503);
  assert.equal(await Recommendation.countDocuments({ userId }), 2);
});

test('concurrent duplicate advisory requests execute once and replay identical IDs', async () => {
  const key = 'atomic-concurrent-001';
  const payload = { profileId: profileId.toString() };

  async function execute() {
    const operationClaim = await claim(key, payload);
    if (operationClaim.state === 'REPLAY') return operationClaim.response.body;

    const operation = makeOperation(operationClaim, 'concurrent');
    await new Promise(resolve => setTimeout(resolve, 100));
    return persistAdvisoryAtomically(operation);
  }

  const results = await Promise.all(Array.from({ length: 20 }, execute));
  const recommendationIds = new Set(results.map(result => String(result.recommendationId)));
  const auditIds = new Set(results.map(result => String(result.audit_id)));

  assert.equal(recommendationIds.size, 1);
  assert.equal(auditIds.size, 1);
  assert.equal(await Recommendation.countDocuments({ userId }), 1);
  assert.equal(await AuditRecord.countDocuments({ userId }), 1);
});

test('same user and key with a different payload is rejected', async () => {
  const key = 'atomic-conflict-001';
  const firstClaim = await claim(key, { profileId: profileId.toString(), mode: 'one' });
  await persistAdvisoryAtomically(makeOperation(firstClaim, 'conflict'));

  await assert.rejects(
    claim(key, { profileId: profileId.toString(), mode: 'two' }),
    error => error.status === 409 && error.code === 'IDEMPOTENCY_PAYLOAD_CONFLICT',
  );
  assert.equal(await Recommendation.countDocuments({ userId }), 1);
  assert.equal(await AuditRecord.countDocuments({ userId }), 1);
});
