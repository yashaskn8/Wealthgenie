import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import profileRoutes from '../routes/profile.js';
import { errorHandler } from '../middleware/errorHandler.js';
import User from '../models/User.js';
import FinancialProfile from '../models/FinancialProfile.js';
import Recommendation from '../models/Recommendation.js';
import RecommendationAllocationRevision from '../models/RecommendationAllocationRevision.js';
import RecommendationState from '../models/RecommendationState.js';
import FinancialProfileState from '../models/FinancialProfileState.js';
import AuditRecord from '../models/AuditRecord.js';
import IdempotencyKey from '../models/IdempotencyKey.js';
import { setupTestDatabase, teardownTestDatabase } from './helpers/mongoTestHelper.js';
import { canonicalProfilePayload } from './helpers/canonicalProfile.js';
import { getCurrentRegulatoryRuleVersion } from '../services/taxEngine.js';
import { installFinancialStateTestHook } from '../services/financialStateTestHooks.js';
import { verifyAuditChain } from '../services/auditChain.js';
import { requireFreshRecommendationState } from '../services/recommendationState.js';
import { assertFetchResponseMatchesOpenApi } from './helpers/openapiRuntimeContract.js';

const JWT_SECRET = 'profile-completion-integration-secret';
process.env.JWT_SECRET = JWT_SECRET;
process.env.NODE_ENV = 'test';

function signToken(userId) {
  return jwt.sign({ userId: String(userId), jti: crypto.randomUUID() }, JWT_SECRET, { expiresIn: '1h' });
}

test('profile completion persists one profile, recommendation, and audit and replays safely', async () => {
  let server;
  let baseUrl;
  let removeTestHook;
  let unblockProfileUpdateResponse = () => {};
  const userId = new mongoose.Types.ObjectId();
  const token = signToken(userId);
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  const payload = canonicalProfilePayload();
  const idempotencyKey = crypto.randomUUID();

  try {
    await setupTestDatabase({ requireReplicaSet: true });
    await User.create({
      _id: userId,
      name: 'Profile Completion Test User',
      email: `profile-completion-${userId}@example.test`,
      passwordHash: 'test-only-hash',
    });

    const app = express();
    app.use(express.json());
    app.use('/api/profile', profileRoutes);
    app.use(errorHandler);
    await new Promise(resolve => {
      server = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });

    const before = await Promise.all([
      FinancialProfile.countDocuments({ userId }),
      Recommendation.countDocuments({ userId }),
      AuditRecord.countDocuments({ userId }),
    ]);
    assert.deepEqual(before, [0, 0, 0]);

    const completeHeaders = { ...headers, 'Idempotency-Key': idempotencyKey };
    const completeResponse = await fetch(`${baseUrl}/api/profile/complete`, {
      method: 'POST',
      headers: completeHeaders,
      body: JSON.stringify(payload),
    });
    await assertFetchResponseMatchesOpenApi(completeResponse, 'POST', '/api/profile/complete');
    assert.equal(completeResponse.status, 200);
    const completed = await completeResponse.json();
    assert.equal(completed.completion.candidateHit, false);
    assert.equal(completed.completion.recomputed, true);
    assert.equal(completed.recommendation.response_state, 'CURRENT');
    assert.equal(completed.recommendation.profileId, completed.profile.profileId);
    assert.equal(completed.recommendation.profile_version, completed.profile.version);
    assert.match(completed.recommendation.profile_input_hash, /^[a-f0-9]{64}$/i);
    assert.match(completed.recommendation.recommendation_fingerprint, /^[a-f0-9]{64}$/i);
    assert.equal(completed.recommendation.calculation_freshness.fresh, true);
    assert.deepEqual(completed.recommendation.calculation_freshness.reasonCodes, []);
    assert.equal(completed.recommendation.state_provenance.status, 'PERSISTED_REVISION');
    assert.equal(completed.recommendation.state_provenance.profileVersion, completed.profile.version);
    assert.equal(completed.recommendation.state_provenance.recommendationId, completed.recommendation.recommendationId);
    assert.equal(completed.recommendation.state_provenance.allocationRevisionId, completed.recommendation.allocation_revision_id);
    assert.match(completed.recommendation.allocation_revision_id, /^[a-f\d]{24}$/i);
    const revisionOne = await RecommendationAllocationRevision.findById(completed.recommendation.allocation_revision_id).lean();
    const currentState = await RecommendationState.findOne({
      userId,
      profileId: completed.profile.profileId,
    }).lean();
    assert.equal(String(revisionOne.recommendationId), completed.recommendation.recommendationId);
    assert.equal(revisionOne.revision, 1);
    assert.equal(revisionOne.portfolioFingerprint, completed.recommendation.portfolio_fingerprint);
    assert.equal(String(currentState.currentRecommendationId), completed.recommendation.recommendationId);
    assert.equal(String(currentState.currentAllocationRevisionId), completed.recommendation.allocation_revision_id);
    assert.deepEqual(await Promise.all([
      FinancialProfile.countDocuments({ userId }),
      Recommendation.countDocuments({ userId }),
      AuditRecord.countDocuments({ userId }),
    ]), [1, 1, 1]);
    const persistedRecommendation = await Recommendation.findOne({ userId }).lean();
    assert.equal(persistedRecommendation.regulatoryRuleVersion, getCurrentRegulatoryRuleVersion());
    assert.equal(persistedRecommendation.profileCompletionCandidateId ?? null, null);

    const replayResponse = await fetch(`${baseUrl}/api/profile/complete`, {
      method: 'POST',
      headers: completeHeaders,
      body: JSON.stringify(payload),
    });
    await assertFetchResponseMatchesOpenApi(replayResponse, 'POST', '/api/profile/complete');
    assert.equal(replayResponse.status, 200);
    const replay = await replayResponse.json();
    assert.equal(replay.profile.profileId, completed.profile.profileId);
    assert.equal(replay.recommendation.recommendationId, completed.recommendation.recommendationId);
    assert.equal(replay.recommendation.response_state, 'CURRENT');
    assert.equal(replay.recommendation.profile_version, completed.profile.version);
    assert.equal(replay.recommendation.allocation_revision, completed.recommendation.allocation_revision);
    assert.equal(replay.recommendation.recommendation_fingerprint, completed.recommendation.recommendation_fingerprint);
    assert.deepEqual(await Promise.all([
      FinancialProfile.countDocuments({ userId }),
      Recommendation.countDocuments({ userId }),
      AuditRecord.countDocuments({ userId }),
    ]), [1, 1, 1]);

    const conflictResponse = await fetch(`${baseUrl}/api/profile/complete`, {
      method: 'POST',
      headers: completeHeaders,
      body: JSON.stringify({ ...payload, monthly_savings: payload.monthly_savings + 1 }),
    });
    await assertFetchResponseMatchesOpenApi(conflictResponse, 'POST', '/api/profile/complete');
    assert.equal(conflictResponse.status, 409);
    const conflict = await conflictResponse.json();
    assert.equal(conflict.code, 'IDEMPOTENCY_PAYLOAD_CONFLICT');

    const missResponse = await fetch(`${baseUrl}/api/profile/complete`, {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ ...payload, monthly_savings: payload.monthly_savings + 2 }),
    });
    await assertFetchResponseMatchesOpenApi(missResponse, 'POST', '/api/profile/complete');
    assert.equal(missResponse.status, 200);
    const miss = await missResponse.json();
    assert.equal(miss.completion.candidateHit, false);
    assert.equal(miss.completion.recomputed, true);
    assert.deepEqual(await Promise.all([
      FinancialProfile.countDocuments({ userId }),
      Recommendation.countDocuments({ userId }),
      AuditRecord.countDocuments({ userId }),
    ]), [2, 2, 2]);

    const completionReplayAfterPromotion = await fetch(`${baseUrl}/api/profile/complete`, {
      method: 'POST',
      headers: completeHeaders,
      body: JSON.stringify(payload),
    });
    const replayAfterPromotion = await completionReplayAfterPromotion.json();
    assert.equal(completionReplayAfterPromotion.status, 200, JSON.stringify(replayAfterPromotion));
    assert.equal(replayAfterPromotion.profile.profileId, miss.profile.profileId);
    assert.equal(replayAfterPromotion.recommendation.profileId, miss.profile.profileId);
    assert.equal(replayAfterPromotion.recommendation.response_state, 'CURRENT');
    assert.equal(replayAfterPromotion.operation_result?.committed, true, JSON.stringify(replayAfterPromotion));
    assert.equal(replayAfterPromotion.operation_result.generated_profile_id, completed.profile.profileId);
    assert.equal(replayAfterPromotion.operation_result.superseded_before_response, true);
    const profileState = await FinancialProfileState.findOne({ userId }).lean();
    assert.equal(String(profileState.currentProfileId), miss.profile.profileId);
    assert.equal(profileState.revision, 2);

    const profileId = miss.profile.profileId;
    const profileScope = { userId, profileId };
    const profileDocumentScope = { userId, _id: profileId };
    const originalState = await RecommendationState.findOne(profileScope).lean();
    const originalRecommendation = await Recommendation.findById(originalState.currentRecommendationId).lean();
    const originalAllocation = await RecommendationAllocationRevision.findById(originalState.currentAllocationRevisionId).lean();
    const originalFinancialCounts = await Promise.all([
      Recommendation.countDocuments(profileScope),
      RecommendationAllocationRevision.countDocuments(profileScope),
      AuditRecord.countDocuments(profileScope),
    ]);
    const updatePayloadAtVersionOne = {
      ...payload,
      monthly_take_home: payload.monthly_take_home + 5000,
      version: miss.profile.version,
    };

    const failureCases = [
      ['profile.update.beforeRecommendationCompute', 'precomputation failure'],
      ['profile.update.afterProfileWriteBeforeRecommendation', 'failure after profile CAS'],
      ['profile.update.afterRecommendationCreate', 'failure after recommendation insertion'],
    ];
    for (const [failureBoundary, failureLabel] of failureCases) {
      let transactionSourceReadCount = 0;
      const failAtBoundary = installFinancialStateTestHook(async boundary => {
        if (boundary === 'profile.update.afterSourceProfileRead') transactionSourceReadCount += 1;
        if (boundary === failureBoundary) throw new Error(`injected ${failureLabel}`);
      });
      let failedResponse;
      let failedBody;
      try {
        failedResponse = await fetch(`${baseUrl}/api/profile/${profileId}`, {
          method: 'PUT',
          headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() },
          body: JSON.stringify(updatePayloadAtVersionOne),
        });
        failedBody = await failedResponse.json();
      } finally {
        failAtBoundary();
      }
      assert.equal(failedResponse.status, 500, JSON.stringify(failedBody));
      assert.equal((await FinancialProfile.findOne(profileDocumentScope).lean()).version, 1, `${failureLabel} must leave profile version unchanged`);
      assert.equal(String((await RecommendationState.findOne(profileScope).lean()).currentRecommendationId), String(originalState.currentRecommendationId));
      assert.deepEqual(await Promise.all([
        Recommendation.countDocuments(profileScope),
        RecommendationAllocationRevision.countDocuments(profileScope),
        AuditRecord.countDocuments(profileScope),
      ]), originalFinancialCounts, `${failureLabel} must roll back every financial write`);
      if (failureBoundary === 'profile.update.beforeRecommendationCompute') {
        assert.equal(transactionSourceReadCount, 0, 'precomputation fails before the Mongo transaction is entered');
      }
    }

    let releaseFirstResponse;
    let signalFirstCommit;
    const firstCommitReached = new Promise(resolve => { signalFirstCommit = resolve; });
    const firstResponseGate = new Promise(resolve => {
      releaseFirstResponse = resolve;
      unblockProfileUpdateResponse = resolve;
    });
    let pausedFirstResponse = false;
    const profileUpdateBoundaries = [];
    removeTestHook = installFinancialStateTestHook(async (boundary, context) => {
      if (context.nextVersion === 2 && [
        'profile.update.beforeRecommendationCompute',
        'profile.update.afterRecommendationCompute',
        'profile.update.afterSourceProfileRead',
        'profile.update.afterProfileWriteBeforeRecommendation',
      ].includes(boundary)) profileUpdateBoundaries.push(boundary);
      if (boundary === 'profile.update.afterCommitBeforeResponse'
          && Number(context.recommendationGeneration) === 2
          && !pausedFirstResponse) {
        pausedFirstResponse = true;
        signalFirstCommit(context);
        await firstResponseGate;
      }
    });

    const firstUpdatePayload = updatePayloadAtVersionOne;
    const firstUpdateKey = crypto.randomUUID();
    const firstUpdatePending = fetch(`${baseUrl}/api/profile/${profileId}`, {
      method: 'PUT',
      headers: { ...headers, 'Idempotency-Key': firstUpdateKey },
      body: JSON.stringify(firstUpdatePayload),
    });
    const firstCommit = await firstCommitReached;
    assert.equal(Number(firstCommit.recommendationGeneration), 2);
    const firstGeneratedId = String(firstCommit.recommendationId);
    const firstDurableProfile = await FinancialProfile.findOne(profileDocumentScope).lean();
    assert.equal(firstDurableProfile.version, 2, 'profile edit is committed before its response barrier');
    assert.equal(String((await RecommendationState.findOne(profileScope).lean()).currentRecommendationId), firstGeneratedId);
    assert.deepEqual(profileUpdateBoundaries, [
      'profile.update.beforeRecommendationCompute',
      'profile.update.afterRecommendationCompute',
      'profile.update.afterSourceProfileRead',
      'profile.update.afterProfileWriteBeforeRecommendation',
    ], 'core recommendation computation completes before entering the transaction');

    const secondUpdatePayload = {
      ...firstUpdatePayload,
      monthly_savings: payload.monthly_savings + 1000,
      version: firstDurableProfile.version,
    };
    const secondUpdateKey = crypto.randomUUID();
    const secondUpdateResponse = await fetch(`${baseUrl}/api/profile/${profileId}`, {
      method: 'PUT',
      headers: { ...headers, 'Idempotency-Key': secondUpdateKey },
      body: JSON.stringify(secondUpdatePayload),
    });
    const secondUpdate = await secondUpdateResponse.json();
    assert.equal(secondUpdateResponse.status, 200, JSON.stringify(secondUpdate));
    assert.equal(secondUpdate.profile.version, 3);
    assert.equal(secondUpdate.recommendation.profile_version, 3);
    assert.equal(secondUpdate.recommendation.response_state, 'CURRENT');

    releaseFirstResponse();
    const firstUpdateResponse = await firstUpdatePending;
    const firstUpdate = await firstUpdateResponse.json();
    assert.equal(firstUpdateResponse.status, 200, JSON.stringify(firstUpdate));
    assert.equal(firstUpdate.profile.version, 3, 'late response must carry the current profile state');
    assert.equal(firstUpdate.recommendation.response_state, 'CURRENT');
    assert.equal(firstUpdate.recommendation.profile_version, firstUpdate.profile.version);
    assert.equal(firstUpdate.recommendation.recommendationId, secondUpdate.recommendation.recommendationId);
    assert.equal(firstUpdate.operation_result.committed, true);
    assert.equal(firstUpdate.operation_result.generated_recommendation_id, firstGeneratedId);
    assert.equal(firstUpdate.operation_result.superseded_before_response, true);
    assert.ok(await Recommendation.findById(firstGeneratedId).lean(), 'superseded generation remains immutable history');
    const originalRecommendationAfterEdit = await Recommendation.findById(originalRecommendation._id).lean();
    const originalAllocationAfterEdit = await RecommendationAllocationRevision.findById(originalAllocation._id).lean();
    assert.equal(originalRecommendationAfterEdit.profileInputHash, originalRecommendation.profileInputHash);
    assert.deepEqual(originalRecommendationAfterEdit.instruments, originalRecommendation.instruments);
    assert.equal(originalAllocationAfterEdit.portfolioFingerprint, originalAllocation.portfolioFingerprint);
    assert.deepEqual(originalAllocationAfterEdit.instruments, originalAllocation.instruments);

    const currentStateAfterEdit = await RecommendationState.findOne(profileScope).lean();
    const currentGenerationAfterEdit = await Recommendation.findById(currentStateAfterEdit.currentRecommendationId).lean();
    const currentAllocationAfterEdit = await RecommendationAllocationRevision.findById(currentStateAfterEdit.currentAllocationRevisionId).lean();
    assert.equal(currentStateAfterEdit.profileVersion, 3);
    assert.equal(currentGenerationAfterEdit.profileVersion, 3);
    assert.equal(currentAllocationAfterEdit.profileVersion, 3);
    assert.equal(currentStateAfterEdit.profileInputHash, currentGenerationAfterEdit.profileInputHash);
    assert.equal(currentAllocationAfterEdit.profileInputHash, currentGenerationAfterEdit.profileInputHash);
    assert.equal(String(currentStateAfterEdit.currentRecommendationId), String(secondUpdate.recommendation.recommendationId));
    await requireFreshRecommendationState({ userId, profileId });

    const countsBeforeReplay = await Promise.all([
      Recommendation.countDocuments(profileScope),
      RecommendationAllocationRevision.countDocuments(profileScope),
      AuditRecord.countDocuments(profileScope),
    ]);
    const replayFirstResponse = await fetch(`${baseUrl}/api/profile/${profileId}`, {
      method: 'PUT',
      headers: { ...headers, 'Idempotency-Key': firstUpdateKey },
      body: JSON.stringify(firstUpdatePayload),
    });
    const replayFirst = await replayFirstResponse.json();
    assert.equal(replayFirstResponse.status, 200, JSON.stringify(replayFirst));
    assert.equal(replayFirst.profile?.version, 3, JSON.stringify(replayFirst));
    assert.equal(replayFirst.recommendation.recommendationId, secondUpdate.recommendation.recommendationId);
    assert.equal(replayFirst.recommendation.response_state, 'CURRENT');

    const changedPayloadReplay = await fetch(`${baseUrl}/api/profile/${profileId}`, {
      method: 'PUT',
      headers: { ...headers, 'Idempotency-Key': firstUpdateKey },
      body: JSON.stringify({ ...firstUpdatePayload, monthly_savings: firstUpdatePayload.monthly_savings + 2000 }),
    });
    const changedPayloadBody = await changedPayloadReplay.json();
    assert.equal(changedPayloadReplay.status, 409);
    assert.equal(changedPayloadBody.code, 'IDEMPOTENCY_PAYLOAD_CONFLICT');
    assert.deepEqual(await Promise.all([
      Recommendation.countDocuments(profileScope),
      RecommendationAllocationRevision.countDocuments(profileScope),
      AuditRecord.countDocuments(profileScope),
    ]), countsBeforeReplay, 'idempotent replay cannot create new recommendation, allocation, or audit records');
    assert.equal((await verifyAuditChain(userId)).valid, true);

    const failAuditWrite = installFinancialStateTestHook(async boundary => {
      if (boundary === 'profile.update.afterAuditWriteBeforeCommit') throw new Error('injected profile audit persistence failure');
    });
    const failedProfileEditPayload = { ...secondUpdatePayload, monthly_take_home: secondUpdatePayload.monthly_take_home + 10000, version: 3 };
    const failedProfileEditKey = crypto.randomUUID();
    let failedProfileEdit;
    let failedProfileEditBody;
    try {
      failedProfileEdit = await fetch(`${baseUrl}/api/profile/${profileId}`, {
        method: 'PUT',
        headers: { ...headers, 'Idempotency-Key': failedProfileEditKey },
        body: JSON.stringify(failedProfileEditPayload),
      });
      failedProfileEditBody = await failedProfileEdit.json();
    } finally {
      failAuditWrite();
    }
    assert.equal(failedProfileEdit.status, 500);
    assert.equal(typeof failedProfileEditBody.code, 'string');
    assert.ok(failedProfileEditBody.request_id);
    const stateAfterAuditFailure = await RecommendationState.findOne(profileScope).lean();
    assert.equal((await FinancialProfile.findOne(profileDocumentScope).lean()).version, 3);
    assert.equal(String(stateAfterAuditFailure.currentRecommendationId), secondUpdate.recommendation.recommendationId);
    assert.deepEqual(await Promise.all([
      Recommendation.countDocuments(profileScope),
      RecommendationAllocationRevision.countDocuments(profileScope),
      AuditRecord.countDocuments(profileScope),
    ]), countsBeforeReplay, 'audit failure rolls back profile, recommendation, allocation, pointer, and audit writes');

    const retriedAfterRollback = await fetch(`${baseUrl}/api/profile/${profileId}`, {
      method: 'PUT',
      headers: { ...headers, 'Idempotency-Key': failedProfileEditKey },
      body: JSON.stringify(failedProfileEditPayload),
    });
    const retriedAfterRollbackBody = await retriedAfterRollback.json();
    assert.equal(retriedAfterRollback.status, 200, JSON.stringify(retriedAfterRollbackBody));
    assert.equal(retriedAfterRollbackBody.profile.version, 4);
    assert.equal(retriedAfterRollbackBody.recommendation.profile_version, 4);
    assert.equal((await verifyAuditChain(userId)).valid, true);

    let releaseConcurrentTransactions;
    let signalBothTransactionsRead;
    const bothTransactionsRead = new Promise(resolve => { signalBothTransactionsRead = resolve; });
    const concurrentTransactionGate = new Promise(resolve => { releaseConcurrentTransactions = resolve; });
    let transactionReaders = 0;
    const concurrentHook = installFinancialStateTestHook(async (boundary, context) => {
      if (boundary !== 'profile.update.afterSourceProfileRead' || Number(context.expectedVersion) !== 4) return;
      transactionReaders += 1;
      if (transactionReaders === 2) signalBothTransactionsRead();
      await concurrentTransactionGate;
    });
    const concurrentPayloadA = {
      ...payload,
      monthly_take_home: payload.monthly_take_home + 25000,
      monthly_savings: payload.monthly_savings + 3000,
      version: 4,
    };
    const concurrentPayloadB = {
      ...payload,
      monthly_take_home: payload.monthly_take_home + 30000,
      monthly_savings: payload.monthly_savings + 4000,
      version: 4,
    };
    const concurrentCountsBefore = await Promise.all([
      Recommendation.countDocuments(profileScope),
      RecommendationAllocationRevision.countDocuments(profileScope),
      AuditRecord.countDocuments(profileScope),
    ]);
    const concurrentRequestA = fetch(`${baseUrl}/api/profile/${profileId}`, {
      method: 'PUT',
      headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify(concurrentPayloadA),
    });
    const concurrentRequestB = fetch(`${baseUrl}/api/profile/${profileId}`, {
      method: 'PUT',
      headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify(concurrentPayloadB),
    });
    try {
      await bothTransactionsRead;
    } finally {
      releaseConcurrentTransactions();
    }
    const concurrentResponses = await Promise.all([concurrentRequestA, concurrentRequestB]);
    const concurrentBodies = await Promise.all(concurrentResponses.map(response => response.json()));
    concurrentHook();
    assert.deepEqual(concurrentResponses.map(response => response.status).sort(), [200, 409]);
    assert.equal(concurrentBodies[concurrentResponses.findIndex(response => response.status === 409)].code, 'PROFILE_VERSION_CONFLICT');
    const profileAfterConcurrentEdit = await FinancialProfile.findOne(profileDocumentScope).lean();
    assert.equal(profileAfterConcurrentEdit.version, 5, 'two edits expecting v4 can commit only one v5 state');
    assert.deepEqual(await Promise.all([
      Recommendation.countDocuments(profileScope),
      RecommendationAllocationRevision.countDocuments(profileScope),
      AuditRecord.countDocuments(profileScope),
    ]), concurrentCountsBefore.map(count => count + 1));
    const stateAfterConcurrentEdit = await RecommendationState.findOne(profileScope).lean();
    const currentAfterConcurrentEdit = await Recommendation.findById(stateAfterConcurrentEdit.currentRecommendationId).lean();
    const allocationAfterConcurrentEdit = await RecommendationAllocationRevision.findById(stateAfterConcurrentEdit.currentAllocationRevisionId).lean();
    assert.equal(currentAfterConcurrentEdit.profileVersion, 5);
    assert.equal(allocationAfterConcurrentEdit.profileVersion, 5);
    assert.equal(stateAfterConcurrentEdit.profileVersion, 5);
    await requireFreshRecommendationState({ userId, profileId });

    const responseLossPayload = { ...payload, version: 5 };
    const responseLossKey = crypto.randomUUID();
    const beforeResponseLossCounts = await Promise.all([
      Recommendation.countDocuments(profileScope),
      RecommendationAllocationRevision.countDocuments(profileScope),
      AuditRecord.countDocuments(profileScope),
    ]);
    const failResponseDelivery = installFinancialStateTestHook(async boundary => {
      if (boundary === 'profile.update.afterCommitBeforeResponse') {
        throw new Error('injected response loss after committed profile update');
      }
    });
    let lostResponse;
    let lostResponseBody;
    try {
      lostResponse = await fetch(`${baseUrl}/api/profile/${profileId}`, {
        method: 'PUT',
        headers: { ...headers, 'Idempotency-Key': responseLossKey },
        body: JSON.stringify(responseLossPayload),
      });
      lostResponseBody = await lostResponse.json();
    } finally {
      failResponseDelivery();
    }
    assert.equal(lostResponse.status, 503);
    assert.equal(lostResponseBody.code, 'COMMITTED_BUT_RESPONSE_RECONCILIATION_FAILED');
    assert.equal(lostResponseBody.details.committed, true);
    assert.equal(lostResponseBody.details.retryWithSameIdempotencyKey, true);
    assert.equal((await FinancialProfile.findOne(profileDocumentScope).lean()).version, 6);

    const replayAfterResponseLoss = await fetch(`${baseUrl}/api/profile/${profileId}`, {
      method: 'PUT',
      headers: { ...headers, 'Idempotency-Key': responseLossKey },
      body: JSON.stringify(responseLossPayload),
    });
    const replayAfterResponseLossBody = await replayAfterResponseLoss.json();
    assert.equal(replayAfterResponseLoss.status, 200, JSON.stringify(replayAfterResponseLossBody));
    assert.equal(replayAfterResponseLossBody.profile.version, 6);
    assert.equal(replayAfterResponseLossBody.recommendation.profile_version, 6);
    assert.equal(replayAfterResponseLossBody.recommendation.response_state, 'CURRENT');
    assert.deepEqual(await Promise.all([
      Recommendation.countDocuments(profileScope),
      RecommendationAllocationRevision.countDocuments(profileScope),
      AuditRecord.countDocuments(profileScope),
    ]), beforeResponseLossCounts.map(count => count + 1), 'same-key retry reconciles committed operation without duplicating writes');
    assert.equal((await verifyAuditChain(userId)).valid, true);
  } finally {
    unblockProfileUpdateResponse();
    removeTestHook?.();
    if (server) await new Promise(resolve => server.close(resolve));
    await FinancialProfile.deleteMany({ userId }).catch(() => {});
    await Recommendation.deleteMany({ userId }).catch(() => {});
    await AuditRecord.collection.deleteMany({ userId }).catch(() => {});
    await User.deleteOne({ _id: userId }).catch(() => {});
    await teardownTestDatabase();
  }
});

test('same-profile post-commit reconciliation retries v2 snapshot after v3 wins and replays the original operation', async () => {
  let server;
  let baseUrl;
  let removeTestHook;
  let releaseA = () => {};
  const userId = new mongoose.Types.ObjectId();
  const profilePayload = canonicalProfilePayload();
  const headers = {
    Authorization: `Bearer ${signToken(userId)}`,
    'Content-Type': 'application/json',
  };
  let signalAAtProfileRead;
  const aAtProfileRead = new Promise(resolve => { signalAAtProfileRead = resolve; });
  const gateA = new Promise(resolve => { releaseA = resolve; });
  let pausedA = false;

  try {
    await setupTestDatabase({ requireReplicaSet: true });
    await User.create({
      _id: userId,
      name: 'Profile Completion Race Test User',
      email: `profile-completion-race-${userId}@example.test`,
      passwordHash: 'test-only-hash',
    });
    const app = express();
    app.use(express.json());
    app.use('/api/profile', profileRoutes);
    app.use(errorHandler);
    await new Promise(resolve => {
      server = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });

    const createdResponse = await fetch(`${baseUrl}/api/profile/complete`, {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify(profilePayload),
    });
    const created = await createdResponse.json();
    assert.equal(createdResponse.status, 200, JSON.stringify(created));
    const profileId = created.profile.profileId;
    const profileScope = { userId, profileId };
    const profileDocumentScope = { userId, _id: profileId };

    removeTestHook = installFinancialStateTestHook(async (boundary, context) => {
      if (boundary === 'post_commit.after_current_profile_read'
          && context.profileId === String(profileId)
          && !pausedA) {
        pausedA = true;
        signalAAtProfileRead(context);
        await gateA;
      }
    });

    const firstPayload = {
      ...profilePayload,
      monthly_take_home: profilePayload.monthly_take_home + 5000,
      version: 1,
    };
    const firstKey = crypto.randomUUID();
    const firstPending = fetch(`${baseUrl}/api/profile/${profileId}`, {
      method: 'PUT',
      headers: { ...headers, 'Idempotency-Key': firstKey },
      body: JSON.stringify(firstPayload),
    });

    const firstRead = await aAtProfileRead;
    const profileAtBarrier = await FinancialProfile.findOne(profileDocumentScope).lean();
    const stateAtBarrier = await RecommendationState.findOne(profileScope).lean();
    const recommendationAtBarrier = await Recommendation.findOne({ ...profileScope, profileVersion: 2 }).lean();
    assert.equal(profileAtBarrier.version, 2, 'A committed v2 before its outer resolver read paused');
    assert.equal(firstRead.profileId, String(profileId));
    assert.ok(recommendationAtBarrier, 'the v2 recommendation is durably persisted before A is paused');
    assert.equal(String(stateAtBarrier.currentRecommendationId), String(recommendationAtBarrier._id));
    const firstGeneratedRecommendationId = String(recommendationAtBarrier._id);

    const secondPayload = {
      ...firstPayload,
      monthly_savings: profilePayload.monthly_savings + 1000,
      version: 2,
    };
    const secondResponse = await fetch(`${baseUrl}/api/profile/${profileId}`, {
      method: 'PUT',
      headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify(secondPayload),
    });
    const second = await secondResponse.json();
    assert.equal(secondResponse.status, 200, JSON.stringify(second));
    assert.equal(second.profile.version, 3);
    assert.equal(second.recommendation.profile_version, 3);

    releaseA();
    const firstResponse = await firstPending;
    const first = await firstResponse.json();
    assert.equal(firstResponse.status, 200, JSON.stringify(first));

    const state = await RecommendationState.findOne(profileScope).lean();
    const profile = await FinancialProfile.findOne(profileDocumentScope).lean();
    const recommendation = await Recommendation.findById(state.currentRecommendationId).lean();
    const allocation = await RecommendationAllocationRevision.findById(state.currentAllocationRevisionId).lean();
    const assertCanonicalV3Bindings = body => {
      assert.equal(body.profile.profileId, String(profileId));
      assert.equal(body.profile.version, 3);
      assert.equal(body.recommendation.profileId, String(profileId));
      assert.equal(body.recommendation.recommendationId, String(state.currentRecommendationId));
      assert.equal(body.recommendation.profile_version, profile.version);
      assert.equal(body.recommendation.profile_input_hash, recommendation.profileInputHash);
      assert.equal(body.recommendation.allocation_revision_id, String(state.currentAllocationRevisionId));
      assert.equal(body.recommendation.allocation_revision_id, String(allocation._id));
      assert.equal(body.recommendation.portfolio_fingerprint, state.portfolioFingerprint);
      assert.equal(body.recommendation.portfolio_fingerprint, allocation.portfolioFingerprint);
      assert.equal(body.recommendation.state_provenance.profileVersion, profile.version);
      assert.equal(body.recommendation.state_provenance.recommendationId, String(recommendation._id));
      assert.equal(body.recommendation.state_provenance.allocationRevisionId, String(allocation._id));
      assert.equal(body.recommendation.calculation_freshness.fresh, true);
      assert.equal(body.recommendation.response_state, 'CURRENT');
    };
    assertCanonicalV3Bindings(first);
    assert.equal(first.operation_result.committed, true);
    assert.equal(first.operation_result.generated_recommendation_id, firstGeneratedRecommendationId);
    assert.equal(first.operation_result.superseded_before_response, true);

    const countsBeforeReplay = await Promise.all([
      FinancialProfile.countDocuments({ userId }),
      Recommendation.countDocuments({ userId }),
      RecommendationAllocationRevision.countDocuments({ userId }),
      AuditRecord.countDocuments({ userId }),
    ]);
    assert.deepEqual(countsBeforeReplay, [1, 3, 3, 3]);
    const replayResponse = await fetch(`${baseUrl}/api/profile/${profileId}`, {
      method: 'PUT',
      headers: { ...headers, 'Idempotency-Key': firstKey },
      body: JSON.stringify(firstPayload),
    });
    const replay = await replayResponse.json();
    assert.equal(replayResponse.status, 200, JSON.stringify(replay));
    assertCanonicalV3Bindings(replay);
    assert.equal(replay.operation_result.generated_recommendation_id, firstGeneratedRecommendationId);
    assert.deepEqual(await Promise.all([
      FinancialProfile.countDocuments({ userId }),
      Recommendation.countDocuments({ userId }),
      RecommendationAllocationRevision.countDocuments({ userId }),
      AuditRecord.countDocuments({ userId }),
    ]), countsBeforeReplay, 'same-key replay must not repeat the v2 mutation or its audit/allocation writes');
    assert.equal((await verifyAuditChain(userId)).valid, true);
  } finally {
    releaseA();
    removeTestHook?.();
    if (server) await new Promise(resolve => server.close(resolve));
    await Promise.all([
      FinancialProfile.deleteMany({ userId }).catch(() => {}),
      FinancialProfileState.deleteMany({ userId }).catch(() => {}),
      Recommendation.deleteMany({ userId }).catch(() => {}),
      RecommendationAllocationRevision.collection.deleteMany({ userId }).catch(() => {}),
      RecommendationState.deleteMany({ userId }).catch(() => {}),
      IdempotencyKey.deleteMany({ userId }).catch(() => {}),
      AuditRecord.collection.deleteMany({ userId }).catch(() => {}),
      User.deleteOne({ _id: userId }).catch(() => {}),
    ]);
    await teardownTestDatabase();
  }
});

test('50 concurrent profile completions from one captured state revision produce exactly one canonical promotion', { timeout: 120_000 }, async () => {
  let server;
  let baseUrl;
  let removeTestHook;
  const userId = new mongoose.Types.ObjectId();
  const headers = {
    Authorization: `Bearer ${signToken(userId)}`,
    'Content-Type': 'application/json',
  };
  const requestCount = 50;
  let capturedCount = 0;
  let signalAllCaptured;
  const allCaptured = new Promise(resolve => { signalAllCaptured = resolve; });
  let releaseRequests;
  const capturedGate = new Promise(resolve => { releaseRequests = resolve; });

  try {
    await setupTestDatabase({ requireReplicaSet: true });
    // Persist account state before issuing contenders so every request passes
    // authentication and can reach the captured-state synchronization hook.
    await User.create({
      _id: userId,
      name: 'Profile Completion Contention Test User',
      email: `profile-completion-contention-${userId}@example.test`,
      passwordHash: 'test-only-hash',
    });
    const app = express();
    app.use(express.json());
    app.use('/api/profile', profileRoutes);
    app.use(errorHandler);
    await new Promise(resolve => {
      server = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });

    removeTestHook = installFinancialStateTestHook(async (boundary, context) => {
      if (boundary !== 'profile.complete.afterStateCapture') return;
      assert.equal(context.profileStateBinding.revision, 0);
      assert.equal(context.profileStateBinding.currentProfileId, null);
      capturedCount += 1;
      if (capturedCount === requestCount) signalAllCaptured();
      await capturedGate;
    });

    const requests = Array.from({ length: requestCount }, (_, index) => {
      const payload = canonicalProfilePayload();
      payload.monthly_savings += index;
      // This test proves persistence CAS under contention, not ML availability.
      // Omit optional capacity facts so profile completion uses its documented
      // non-imputing fallback and the race remains independent of an ML service.
      delete payload.has_lump_sum;
      delete payload.lump_sum_amount;
      delete payload.liquid_savings;
      delete payload.emi_burden_pct;
      delete payload.financial_dependents;
      delete payload.emergency_fund_months;
      return fetch(`${baseUrl}/api/profile/complete`, {
        method: 'POST',
        headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify(payload),
      });
    });
    await allCaptured;
    assert.equal(capturedCount, requestCount, 'all contenders must bind the same pre-computation profile-state revision');
    releaseRequests();

    const responses = await Promise.all(requests);
    const bodies = await Promise.all(responses.map(response => response.json()));
    const winners = responses.map((response, index) => ({ response, body: bodies[index] }))
      .filter(item => item.response.status === 200);
    const conflicts = responses.map((response, index) => ({ response, body: bodies[index] }))
      .filter(item => item.response.status === 409);
    assert.equal(winners.length, 1, JSON.stringify(bodies.filter((_, index) => responses[index].status !== 200 && responses[index].status !== 409)));
    assert.equal(conflicts.length, requestCount - 1);
    assert.ok(conflicts.every(item => item.body.code === 'PROFILE_STATE_VERSION_CONFLICT'), JSON.stringify(conflicts.map(item => item.body)));
    assert.equal(winners[0].body.recommendation.response_state, 'CURRENT');
    assert.equal(winners[0].body.profile.profileId, winners[0].body.recommendation.profileId);

    const [profiles, recommendations, revisions, audits, currentState] = await Promise.all([
      FinancialProfile.countDocuments({ userId }),
      Recommendation.countDocuments({ userId }),
      RecommendationAllocationRevision.countDocuments({ userId }),
      AuditRecord.countDocuments({ userId }),
      FinancialProfileState.findOne({ userId }).lean(),
    ]);
    assert.deepEqual([profiles, recommendations, revisions, audits], [1, 1, 1, 1]);
    assert.equal(currentState.resolutionStatus, 'CURRENT');
    assert.equal(currentState.revision, 1);
    assert.equal(String(currentState.currentProfileId), winners[0].body.profile.profileId);
    const auditVerification = await verifyAuditChain(userId);
    assert.equal(auditVerification.valid, true, JSON.stringify(auditVerification));
  } finally {
    releaseRequests();
    removeTestHook?.();
    if (server) await new Promise(resolve => server.close(resolve));
    await Promise.all([
      FinancialProfile.deleteMany({ userId }).catch(() => {}),
      FinancialProfileState.deleteMany({ userId }).catch(() => {}),
      Recommendation.deleteMany({ userId }).catch(() => {}),
      RecommendationAllocationRevision.collection.deleteMany({ userId }).catch(() => {}),
      RecommendationState.deleteMany({ userId }).catch(() => {}),
      IdempotencyKey.deleteMany({ userId }).catch(() => {}),
      AuditRecord.collection.deleteMany({ userId }).catch(() => {}),
      User.deleteOne({ _id: userId }).catch(() => {}),
    ]);
    await teardownTestDatabase();
  }
});
