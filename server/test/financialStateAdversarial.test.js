import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { recommendationWeightsSchema } from '../validation/financialSchemas.js';
import { buildCurrentRecommendationResponse } from '../services/recommendationResponse.js';
import { resolveCurrentRecommendationState } from '../services/recommendationState.js';
import { buildRecommendationProfileHash } from '../services/recommendationProfile.js';
import { buildPortfolioFingerprint, buildRecommendationFingerprint } from '../services/recommendationFingerprint.js';
import {
  PROJECTION_ASSUMPTION_POLICY_HASH,
  PROJECTION_ASSUMPTION_SOURCE,
  PROJECTION_ASSUMPTION_VERSION,
} from '../services/instrumentConstants.js';

const ids = {
  user: '64b000000000000000000001',
  profile: '64b000000000000000000002',
  recommendation: '64b000000000000000000003',
  revision: '64b000000000000000000004',
};

const profile = {
  _id: ids.profile,
  userId: ids.user,
  version: 1,
  monthlyTakeHome: 100000,
  monthlySavings: 30000,
  age: 32,
  riskTolerance: 'Moderate',
  soldPropertyProceeds: null,
  hasLumpSum: false,
  lumpSumAmount: 0,
  liquidSavings: 100000,
  emiBurdenPct: null,
  financialDependents: 1,
  emergencyFundMonths: 6,
  investmentGoals: ['Wealth Growth'],
  investmentHorizonYears: 10,
};

function query(value) {
  return {
    lean: async () => value,
    sort() { return this; },
    session() { return this; },
  };
}

function fixture() {
  const instruments = [{
    id: 'fd', type: 'FD', name: 'Bank Fixed Deposit', assetClass: 'Fixed Income',
    allocationWeight: 1, allocation_pct: 100, nominalReturn: 7.5, effectiveYield: 7.5,
    postTaxReturn: null, returnBasis: 'PRE_TAX_NOMINAL', returnDataClass: 'MODEL_ASSUMPTION',
    returnAssumptionVersion: PROJECTION_ASSUMPTION_VERSION,
    returnAssumptionHash: PROJECTION_ASSUMPTION_POLICY_HASH,
    returnSource: PROJECTION_ASSUMPTION_SOURCE,
    expenseRatio: 0, riskLevel: 'Low', riskScore: 1, lockIn: 0, tags: ['Wealth Growth'],
    score: 80,
  }];
  const generationInstruments = [{ ...instruments[0], allocationWeight: 0.5, allocation_pct: 50 }];
  const recommendation = {
    _id: ids.recommendation,
    userId: ids.user,
    profileId: ids.profile,
    instruments: generationInstruments,
    modelVersion: 'test-model-1',
    recommendationGeneration: 1,
    recommendationPolicyVersion: 'suitability-freeze-1.2.0',
    regulatoryRuleVersion: 'tax-policy-FY2026-27-v2',
    profileVersion: 1,
    profileInputHash: buildRecommendationProfileHash(profile, { modelVersion: 'test-model-1' }),
    returnAssumptionHash: PROJECTION_ASSUMPTION_POLICY_HASH,
    marketAdjustment: { applied: true, status: 'APPLIED', sourceProvider: 'NSE' },
    responseSnapshot: {
      audit_id: '64b000000000000000000008',
      audit_hash: 'a'.repeat(64),
      instruments: generationInstruments,
      market_adjustment: { applied: true, currentAllocationSource: 'MARKET_CONTEXT_ADJUSTED' },
    },
  };
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
  const revision = {
    _id: ids.revision,
    recommendationId: ids.recommendation,
    profileId: ids.profile,
    userId: ids.user,
    revision: 1,
    source: 'ORIGINAL_RECOMMENDATION',
    instruments,
    profileInputHash: recommendation.profileInputHash,
    profileVersion: 1,
    modelVersion: recommendation.modelVersion,
    recommendationPolicyVersion: recommendation.recommendationPolicyVersion,
    regulatoryRuleVersion: recommendation.regulatoryRuleVersion,
    returnAssumptionVersion: PROJECTION_ASSUMPTION_VERSION,
    returnAssumptionHash: PROJECTION_ASSUMPTION_POLICY_HASH,
    returnAssumptionSource: PROJECTION_ASSUMPTION_SOURCE,
    portfolioFingerprint,
    recommendationFingerprint,
  };
  const state = {
    _id: '64b000000000000000000005',
    userId: ids.user,
    profileId: ids.profile,
    currentRecommendationId: ids.recommendation,
    currentAllocationRevision: 1,
    currentAllocationRevisionId: ids.revision,
    generationRevision: 1,
    profileInputHash: recommendation.profileInputHash,
    profileVersion: 1,
    portfolioFingerprint,
    returnAssumptionVersion: PROJECTION_ASSUMPTION_VERSION,
    returnAssumptionHash: PROJECTION_ASSUMPTION_POLICY_HASH,
    returnAssumptionSource: PROJECTION_ASSUMPTION_SOURCE,
  };
  const dependencies = {
    profileModel: { findOne: () => query(profile) },
    recommendationModel: { findOne: () => query(recommendation) },
    stateModel: { findOne: () => query(state) },
    revisionModel: { findOne: () => query(revision) },
    getCurrentRegulatoryRuleVersion: () => recommendation.regulatoryRuleVersion,
  };
  return { recommendation, revision, state, dependencies };
}

test('current response cannot resurrect generation-snapshot allocation fields', () => {
  const { recommendation, revision, state } = fixture();
  const binding = responseBinding(recommendation, revision, state);
  const response = buildCurrentRecommendationResponse({
    profile,
    recommendation,
    allocationRevision: revision,
    ...binding,
    portfolioFingerprint: revision.portfolioFingerprint,
  });
  assert.equal(response.instruments[0].allocationWeight, 1);
  assert.equal(response.generation_instruments[0].allocationWeight, 0.5);
  assert.equal(response.allocation_revision, state.currentAllocationRevision);
  assert.equal(response.portfolio_fingerprint, revision.portfolioFingerprint);
  assert.equal(response.recommendation_id, ids.recommendation);
});

test('a rebalance never presents the generation-time explanation as current', () => {
  const { recommendation, revision } = fixture();
  recommendation.responseSnapshot.explanation = { summary: 'Explains original portfolio' };
  recommendation.marketAdjustment.sourceProvider = 'UPSTOX';
  recommendation.responseSnapshot.generation_market_adjustment = {
    applied: true,
    sourceProvider: 'UPSTOX',
    changedInstruments: [{ instrumentId: 'fd' }],
  };
  const currentRevision = {
    ...revision,
    _id: '64b000000000000000000006',
    revision: 2,
    previousRevision: 1,
    previousAllocationRevisionId: revision._id,
    source: 'USER_REBALANCED',
  };
  const currentState = { ...fixture().state, currentAllocationRevision: 2, currentAllocationRevisionId: currentRevision._id };
  const binding = responseBinding(recommendation, currentRevision, currentState);
  const response = buildCurrentRecommendationResponse({
    profile,
    recommendation,
    allocationRevision: currentRevision,
    ...binding,
    portfolioFingerprint: currentRevision.portfolioFingerprint,
  });
  assert.equal(response.explanation, null);
  assert.deepEqual(response.generation_explanation, { summary: 'Explains original portfolio' });
  assert.equal(response.market_adjustment, null);
  assert.deepEqual(response.generation_market_adjustment, {
    applied: true,
    changedInstruments: [{ instrumentId: 'fd' }],
  });
  assert.equal(JSON.stringify(response).includes('sourceProvider'), false);
});

function responseBinding(recommendation, revision, state) {
  const recommendationFingerprint = buildRecommendationFingerprint({
    recommendationId: recommendation._id,
    profileInputHash: recommendation.profileInputHash,
    modelVersion: recommendation.modelVersion,
    recommendationPolicyVersion: recommendation.recommendationPolicyVersion,
    regulatoryRuleVersion: recommendation.regulatoryRuleVersion,
    returnAssumptionVersion: revision.returnAssumptionVersion,
    returnAssumptionHash: revision.returnAssumptionHash,
    allocationRevision: revision.revision,
    instruments: revision.instruments,
  });
  return {
    freshness: {
      fresh: true,
      reasonCodes: [],
      profilePresent: true,
      recommendationPresent: true,
      modelVersion: recommendation.modelVersion,
      expectedProfileHash: recommendation.profileInputHash,
      observedProfileHash: recommendation.profileInputHash,
      expectedProfileVersion: 1,
      observedProfileVersion: 1,
      observedRegulatoryVersion: recommendation.regulatoryRuleVersion,
      currentRegulatoryVersion: recommendation.regulatoryRuleVersion,
      policyVersion: recommendation.recommendationPolicyVersion,
      observedRecommendationPolicyVersion: recommendation.recommendationPolicyVersion,
      allocationRevision: revision.revision,
      currentAllocationSource: revision.source,
      assumptionVersion: revision.returnAssumptionVersion,
      assumptionHash: revision.returnAssumptionHash,
      assumptionSource: revision.returnAssumptionSource,
    },
    provenance: {
      status: 'PERSISTED_REVISION',
      stateId: state._id,
      recommendationId: recommendation._id,
      allocationSource: revision.source,
      allocationRevision: revision.revision,
      allocationRevisionId: revision._id,
      profileVersion: 1,
      profileInputHash: recommendation.profileInputHash,
      portfolioFingerprint: revision.portfolioFingerprint,
      recommendationFingerprint,
      recommendationPolicyVersion: recommendation.recommendationPolicyVersion,
      regulatoryRuleVersion: recommendation.regulatoryRuleVersion,
      returnAssumptionVersion: revision.returnAssumptionVersion,
      returnAssumptionHash: revision.returnAssumptionHash,
      returnAssumptionSource: revision.returnAssumptionSource,
      previousAllocationRevision: revision.previousRevision ?? null,
      previousAllocationRevisionId: revision.previousAllocationRevisionId ?? null,
    },
    portfolioFingerprint: revision.portfolioFingerprint,
    recommendationFingerprint,
  };
}

test('valid canonical pointer resolves only the pointed revision', async () => {
  const { dependencies } = fixture();
  const state = await resolveCurrentRecommendationState({
    userId: ids.user,
    profileId: ids.profile,
    profile,
    requireFresh: true,
    dependencies,
  });
  assert.equal(state.currentAllocation.revision, 1);
  assert.equal(state.provenance.status, 'PERSISTED_REVISION');
});

test('current state rejects applied legacy market adjustments with missing or unknown provenance', async () => {
  for (const sourceProvider of [undefined, null, 'UNRECOGNIZED']) {
    const { dependencies, recommendation } = fixture();
    recommendation.marketAdjustment = { applied: true, sourceProvider };
    await assert.rejects(
      resolveCurrentRecommendationState({
        userId: ids.user,
        profileId: ids.profile,
        profile,
        requireFresh: true,
        dependencies,
      }),
      error => error.status === 503 && error.code === 'MARKET_ADJUSTMENT_PROVIDER_PROVENANCE_MISSING',
    );
  }
});

test('current state leaves demonstrably unadjusted legacy recommendations available for ordinary inspection', async () => {
  const { dependencies, recommendation } = fixture();
  recommendation.marketAdjustment = { applied: false, status: 'NOT_APPLIED', sourceProvider: null };
  recommendation.currentAllocationSource = 'ORIGINAL_RECOMMENDATION';
  recommendation.responseSnapshot.market_adjustment = { applied: false, status: 'NOT_APPLIED' };
  dependencies.stateModel = { findOne: () => query(null) };
  dependencies.revisionModel = { findOne: () => query(null) };

  const state = await resolveCurrentRecommendationState({
    userId: ids.user,
    profileId: ids.profile,
    profile,
    dependencies,
  });
  assert.equal(state.provenance.status, 'LEGACY_GENERATION_STATE');
  assert.equal(state.freshness.fresh, false);
});

test('confirmed production Upstox provenance resolves through the current-state boundary', async () => {
  const { dependencies, recommendation } = fixture();
  recommendation.marketAdjustment.sourceProvider = 'UPSTOX';
  dependencies.environment = { NODE_ENV: 'production', UPSTOX_PUBLIC_MARKET_DATA_LICENSE_CONFIRMED: 'true' };

  const state = await resolveCurrentRecommendationState({
    userId: ids.user,
    profileId: ids.profile,
    profile,
    requireFresh: true,
    dependencies,
  });
  assert.equal(state.provenance.status, 'PERSISTED_REVISION');
});

test('tampered allocation contents fail closed through fingerprint verification', async () => {
  const { dependencies, revision } = fixture();
  dependencies.revisionModel = {
    findOne: () => query({ ...revision, instruments: [{ ...revision.instruments[0], allocationWeight: 0.9 }] }),
  };
  await assert.rejects(
    resolveCurrentRecommendationState({ userId: ids.user, profileId: ids.profile, profile, requireFresh: true, dependencies }),
    error => error.code === 'ALLOCATION_FINGERPRINT_MISMATCH' || error.reasonCodes?.includes('ALLOCATION_FINGERPRINT_MISMATCH'),
  );
});

test('tampered recommendation provenance fingerprint fails closed', async () => {
  const { dependencies, revision } = fixture();
  dependencies.revisionModel = {
    findOne: () => query({ ...revision, recommendationFingerprint: 'f'.repeat(64) }),
  };
  await assert.rejects(
    resolveCurrentRecommendationState({ userId: ids.user, profileId: ids.profile, profile, requireFresh: true, dependencies }),
    error => error.code === 'RECOMMENDATION_FINGERPRINT_MISMATCH'
      || error.reasonCodes?.includes('RECOMMENDATION_FINGERPRINT_MISMATCH'),
  );
});

test('missing canonical pointer cannot fall back to a persisted revision', async () => {
  const { dependencies, revision } = fixture();
  dependencies.stateModel = { findOne: () => query(null) };
  dependencies.revisionModel = { findOne: () => query(revision) };
  await assert.rejects(
    resolveCurrentRecommendationState({ userId: ids.user, profileId: ids.profile, profile, requireFresh: true, dependencies }),
    error => error.code === 'FINANCIAL_STATE_MISSING' || error.reasonCodes?.includes('FINANCIAL_STATE_MISSING'),
  );
});

test('legacy generation without a canonical pointer is never reported fresh', async () => {
  const { dependencies } = fixture();
  dependencies.stateModel = { findOne: () => query(null) };
  dependencies.revisionModel = { findOne: () => query(null) };
  const state = await resolveCurrentRecommendationState({
    userId: ids.user,
    profileId: ids.profile,
    profile,
    dependencies,
  });
  assert.equal(state.provenance.status, 'LEGACY_GENERATION_STATE');
  assert.equal(state.freshness.fresh, false);
  assert.ok(state.freshness.reasonCodes.includes('FINANCIAL_STATE_MISSING'));
});

test('explicit superseded recommendation cannot be used as current state', async () => {
  const { dependencies, recommendation } = fixture();
  const older = { ...recommendation, _id: '64b000000000000000000099' };
  dependencies.recommendationModel = { findOne: () => query(older) };
  await assert.rejects(
    resolveCurrentRecommendationState({
      userId: ids.user,
      profileId: ids.profile,
      recommendationId: older._id,
      profile,
      requireFresh: true,
      dependencies,
    }),
    error => error.code === 'RECOMMENDATION_SUPERSEDED',
  );
});

test('rebalance tokens are mandatory optimistic-concurrency inputs', () => {
  const result = recommendationWeightsSchema.validate({
    profileId: ids.profile,
    weights: { fd: 1 },
  });
  assert.ok(result.error);
  assert.match(result.error.message, /recommendationId|expectedAllocationRevision|expectedPortfolioFingerprint/);
});

test('allocation revision model exposes no query mutation path', () => {
  const source = readFileSync(resolve(process.cwd(), 'models/RecommendationAllocationRevision.js'), 'utf8');
  assert.match(source, /Allocation revisions are immutable/);
  assert.match(source, /Allocation revisions are append-only/);
  assert.doesNotMatch(readFileSync(resolve(process.cwd(), 'services/advisoryPersistence.js'), 'utf8'), /RecommendationAllocationRevision\.(create|updateOne|findOneAndUpdate|deleteMany)/);
});
