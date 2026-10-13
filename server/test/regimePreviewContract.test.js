import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import { createRegimeRouter } from '../routes/regime.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { withServer, jsonRequest } from '../test-utils/httpTestUtils.js';

const USER_ID = '64b000000000000000000001';
const PROFILE_ID = '64b000000000000000000002';
const RECOMMENDATION_ID = '64b000000000000000000003';
const REVISION_ID = '64b000000000000000000004';
const PORTFOLIO_FINGERPRINT = 'a'.repeat(64);
const RECOMMENDATION_FINGERPRINT = 'b'.repeat(64);

const marketContext = {
  status: 'MARKET_CONTEXT_AVAILABLE',
  context: 'CAUTIOUS',
  policyVersion: 'market-context-policy-1.0.0',
  recommendationUsability: { status: 'USABLE', reasonCodes: [], maxAgeSeconds: 900 },
  marketSnapshot: {
    schemaVersion: 'market-snapshot-1.0.0',
    status: 'CURRENT',
    observedAt: '2026-10-12T10:00:00.000Z',
    evaluatedAt: '2026-10-12T10:01:00.000Z',
    evidenceRevision: 'c'.repeat(64),
    contentRevision: { version: 'market-snapshot-content-1.0.0', digest: 'd'.repeat(64) },
    policyOutput: { status: 'MARKET_CONTEXT_AVAILABLE', context: 'CAUTIOUS', policyVersion: 'market-context-policy-1.0.0' },
  },
};

function buildTestApp() {
  const profile = Object.freeze({ _id: PROFILE_ID, userId: USER_ID, version: 3, riskTolerance: 'Moderate' });
  const instruments = Object.freeze([
    Object.freeze({ id: 'low-risk-option', name: 'Lower-risk option', riskScore: 1, allocationWeight: 0.6 }),
    Object.freeze({ id: 'higher-risk-option', name: 'Higher-risk option', riskScore: 4, allocationWeight: 0.4 }),
  ]);
  const state = Object.freeze({
    profileVersion: 3,
    recommendation: Object.freeze({ _id: RECOMMENDATION_ID }),
    currentAllocation: Object.freeze({ instruments }),
    allocationRevision: Object.freeze({ _id: REVISION_ID, revision: 2 }),
    portfolioFingerprint: PORTFOLIO_FINGERPRINT,
    recommendationFingerprint: RECOMMENDATION_FINGERPRINT,
  });
  const calls = { profile: 0, state: 0, calculation: 0 };
  const router = createRegimeRouter({
    getLiveMarketContext: async () => marketContext,
    requireCurrentFinancialProfile: async ({ userId, profileId }) => {
      calls.profile += 1;
      assert.equal(userId, USER_ID);
      assert.equal(profileId, PROFILE_ID);
      return { profile };
    },
    buildRecommendationProfile: value => value,
    requireFreshRecommendationState: async ({ userId, profileId, profile: resolvedProfile }) => {
      calls.state += 1;
      assert.equal(userId, USER_ID);
      assert.equal(profileId, PROFILE_ID);
      assert.equal(resolvedProfile, profile);
      return state;
    },
    applyProfileSafeMarketContextAdjustment: ({ profile: resolvedProfile, instruments: resolvedInstruments, marketContext: resolvedContext }) => {
      calls.calculation += 1;
      assert.equal(resolvedProfile, profile);
      assert.equal(resolvedInstruments, instruments);
      assert.equal(resolvedContext, marketContext);
      return {
        applied: true,
        maxTotalTiltPct: 2,
        actualTotalTiltPct: 2,
        baseWeights: { 'low-risk-option': 0.6, 'higher-risk-option': 0.4 },
        adjustedWeights: { 'low-risk-option': 0.62, 'higher-risk-option': 0.38 },
        adjustedInstruments: [
          { ...instruments[0], allocationWeight: 0.62, allocation_pct: 62 },
          { ...instruments[1], allocationWeight: 0.38, allocation_pct: 38 },
        ],
        reasonCodes: ['SERVER_AUTHORITATIVE_RECOMMENDATION_ONLY'],
        explanations: [],
        suitabilityRevalidated: true,
        concentrationCapsRevalidated: true,
      };
    },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/regime', router);
  app.use(errorHandler);
  return { app, calls, state };
}

test('authenticated preview returns the exact server market snapshot and current financial-state binding without mutating allocation state', async () => {
  const oldSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'regime_preview_test_secret_at_least_32_chars';
  const token = jwt.sign({ userId: USER_ID, role: 'user' }, process.env.JWT_SECRET, { algorithm: 'HS256' });
  const { app, calls, state } = buildTestApp();
  const originalState = structuredClone({
    profileVersion: state.profileVersion,
    recommendation: state.recommendation,
    currentAllocation: state.currentAllocation,
    allocationRevision: state.allocationRevision,
    portfolioFingerprint: state.portfolioFingerprint,
    recommendationFingerprint: state.recommendationFingerprint,
  });

  try {
    await withServer(app, async baseUrl => {
      const { response, body } = await jsonRequest(`${baseUrl}/api/regime/adjust`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ profileId: PROFILE_ID }),
      });
      assert.equal(response.status, 200);
      assert.equal(body.marketContext.marketSnapshot.contentRevision.digest, 'd'.repeat(64));
      assert.equal(body.profileId, PROFILE_ID);
      assert.equal(body.profile_version, 3);
      assert.equal(body.recommendationId, RECOMMENDATION_ID);
      assert.equal(body.allocation_revision, 2);
      assert.equal(body.allocation_revision_id, REVISION_ID);
      assert.equal(body.portfolio_fingerprint, PORTFOLIO_FINGERPRINT);
      assert.equal(body.recommendation_fingerprint, RECOMMENDATION_FINGERPRINT);
      assert.equal(body.persisted, false);
      assert.deepEqual(body.adjustedWeights, { 'low-risk-option': 0.62, 'higher-risk-option': 0.38 });
    });
    assert.deepEqual(calls, { profile: 1, state: 1, calculation: 1 });
    assert.deepEqual({
      profileVersion: state.profileVersion,
      recommendation: state.recommendation,
      currentAllocation: state.currentAllocation,
      allocationRevision: state.allocationRevision,
      portfolioFingerprint: state.portfolioFingerprint,
      recommendationFingerprint: state.recommendationFingerprint,
    }, originalState);
  } finally {
    if (oldSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldSecret;
  }
});

test('preview route rejects client-supplied weights and does not run the adjustment', async () => {
  const oldSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'regime_preview_test_secret_at_least_32_chars';
  const token = jwt.sign({ userId: USER_ID, role: 'user' }, process.env.JWT_SECRET, { algorithm: 'HS256' });
  const { app, calls } = buildTestApp();
  try {
    await withServer(app, async baseUrl => {
      const { response } = await jsonRequest(`${baseUrl}/api/regime/adjust`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ profileId: PROFILE_ID, baseWeights: { attacker: 1 } }),
      });
      assert.equal(response.status, 400);
    });
    assert.deepEqual(calls, { profile: 0, state: 0, calculation: 0 });
  } finally {
    if (oldSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldSecret;
  }
});
