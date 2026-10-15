import test from 'node:test';
import assert from 'node:assert/strict';
import { currentWtiBinding, rankWtiAgainstCurrentState } from '../services/currentWtiRanking.js';
import { canonicalProfile } from './helpers/canonicalProfile.js';

const state = ({ revision = 1, profileVersion = 4, fingerprint = 'a', parentId = 'index_mf', recommendationId = '64b000000000000000000002' } = {}) => ({
  profile: { _id: '64b000000000000000000001', version: profileVersion, ...canonicalProfile() },
  profileVersion,
  recommendation: { _id: recommendationId },
  allocationRevision: { _id: `64b00000000000000000000${revision + 2}`, revision },
  portfolioFingerprint: fingerprint.repeat(64),
  recommendationFingerprint: 'b'.repeat(64),
  currentAllocation: { instruments: [{ id: parentId, allocationWeight: 1 }] },
});

test('WTI ranking rejects stale state bindings before calling the ranking service, even with a different fiscal-year age', async () => {
  let rankingCalls = 0;
  await assert.rejects(() => rankWtiAgainstCurrentState({
    userId: 'user-1',
    profileId: '64b000000000000000000001',
    parentInstrumentId: 'index_mf',
    expectedBinding: { ...currentWtiBinding(state()), profileVersion: 3 },
    taxCalculationContext: { fiscalYear: 'FY2025-26', userAge: 34 },
    dependencies: {
      requireFreshRecommendationState: async () => state(),
      rankWhereToInvestBackend: async () => { rankingCalls += 1; return []; },
    },
  }), { code: 'FINANCIAL_STATE_CHANGED', status: 409 });
  assert.equal(rankingCalls, 0);
});

test('WTI ranking rejects a forged parent that is absent from canonical current allocation', async () => {
  let rankingCalls = 0;
  await assert.rejects(() => rankWtiAgainstCurrentState({
    userId: 'user-1',
    profileId: '64b000000000000000000001',
    parentInstrumentId: 'ppf',
    expectedBinding: currentWtiBinding(state()),
    dependencies: {
      requireFreshRecommendationState: async () => state(),
      rankWhereToInvestBackend: async () => { rankingCalls += 1; return []; },
    },
  }), { code: 'RECOMMENDATION_PARENT_MISMATCH', status: 409 });
  assert.equal(rankingCalls, 0);
});

test('WTI reads do not request AMFI persistence from the ranking pipeline', async () => {
  const current = state();
  let rankingArguments;
  const result = await rankWtiAgainstCurrentState({
    userId: 'user-1',
    profileId: '64b000000000000000000001',
    parentInstrumentId: 'index_mf',
    expectedBinding: currentWtiBinding(current),
    dependencies: {
      requireFreshRecommendationState: async () => current,
      rankWhereToInvestBackend: async (...args) => {
        rankingArguments = args;
        return [{ id: 'verified-read-only-result' }];
      },
    },
  });

  assert.equal(result.ranked[0].id, 'verified-read-only-result');
  assert.equal(rankingArguments[2].persistAmfiSnapshots, false);
  assert.equal(result.financialStateBinding.recommendationId, current.recommendation._id);
});

test('WTI ranking discards results if canonical allocation changes while ranking is in flight', async () => {
  let reads = 0;
  let releaseRanking;
  let signalRankingStarted;
  const rankingBlocked = new Promise(resolve => { releaseRanking = resolve; });
  const rankingStarted = new Promise(resolve => { signalRankingStarted = resolve; });
  const initial = state({ revision: 1, fingerprint: 'a' });
  const successor = state({ revision: 2, fingerprint: 'c' });
  const operation = rankWtiAgainstCurrentState({
    userId: 'user-1',
    profileId: '64b000000000000000000001',
    parentInstrumentId: 'index_mf',
    expectedBinding: currentWtiBinding(initial),
    dependencies: {
      requireFreshRecommendationState: async () => (++reads === 1 ? initial : successor),
      rankWhereToInvestBackend: async () => {
        signalRankingStarted();
        await rankingBlocked;
        return [{ id: 'product-ranked-against-old-state' }];
      },
    },
  });

  await rankingStarted;
  releaseRanking();
  await assert.rejects(operation, { code: 'FINANCIAL_STATE_CHANGED', status: 409 });
  assert.equal(reads, 2, 'canonical state is re-read after provider/ranking work');
});

test('WTI ranking also discards results after profile or recommendation generation advances in flight', async () => {
  const cases = [
    ['profile version', { profileVersion: 5 }],
    ['recommendation generation', { recommendationId: '64b000000000000000000003' }],
  ];
  for (const [changedState, update] of cases) {
    let reads = 0;
    let releaseRanking;
    let signalRankingStarted;
    const rankingBlocked = new Promise(resolve => { releaseRanking = resolve; });
    const rankingStarted = new Promise(resolve => { signalRankingStarted = resolve; });
    const initial = state();
    const successor = state(update);
    const operation = rankWtiAgainstCurrentState({
      userId: 'user-1',
      profileId: '64b000000000000000000001',
      parentInstrumentId: 'index_mf',
      expectedBinding: currentWtiBinding(initial),
      dependencies: {
        requireFreshRecommendationState: async () => (++reads === 1 ? initial : successor),
        rankWhereToInvestBackend: async () => {
          signalRankingStarted();
          await rankingBlocked;
          return [{ id: 'product-ranked-against-old-state' }];
        },
      },
    });
    await rankingStarted;
    releaseRanking();
    await assert.rejects(operation, { code: 'FINANCIAL_STATE_CHANGED', status: 409 }, changedState);
    assert.equal(reads, 2, `${changedState} is rechecked after ranking`);
  }
});

test('WTI rejects an invalid selected-year tax age before product ranking', async () => {
  const current = state();
  let rankingCalls = 0;
  await assert.rejects(() => rankWtiAgainstCurrentState({
    userId: 'user-1',
    profileId: current.profile._id,
    parentInstrumentId: 'index_mf',
    expectedBinding: currentWtiBinding(current),
    taxCalculationContext: { fiscalYear: 'FY2025-26', userAge: '34' },
    dependencies: {
      requireFreshRecommendationState: async () => current,
      rankWhereToInvestBackend: async () => { rankingCalls += 1; return []; },
    },
  }), { code: 'TAX_YEAR_AGE_INVALID', status: 400 });
  assert.equal(rankingCalls, 0);
});

test('WTI rejects conflicting selected-year age aliases before product ranking', async () => {
  const current = state();
  let rankingCalls = 0;
  await assert.rejects(() => rankWtiAgainstCurrentState({
    userId: 'user-1',
    profileId: current.profile._id,
    parentInstrumentId: 'index_mf',
    expectedBinding: currentWtiBinding(current),
    taxCalculationContext: {
      fiscalYear: 'FY2025-26',
      userAge: 34,
      deductions: { age: 35 },
    },
    dependencies: {
      requireFreshRecommendationState: async () => current,
      rankWhereToInvestBackend: async () => { rankingCalls += 1; return []; },
    },
  }), { code: 'TAX_YEAR_AGE_INVALID', status: 400 });
  assert.equal(rankingCalls, 0);
});

test('WTI accepts a valid tax-year age that differs from the saved profile while preserving profile age for suitability', async () => {
  const current = state();
  let rankingCalls = 0;
  const profileAge = Number(current.profile.age);
  const taxYearAge = profileAge - 1;
  let rankArguments;
  const result = await rankWtiAgainstCurrentState({
    userId: 'user-1',
    profileId: current.profile._id,
    parentInstrumentId: 'index_mf',
    expectedBinding: currentWtiBinding(current),
    taxCalculationContext: {
      annualGrossIncome: 500000,
      incomeSource: 'salary',
      regime: 'old',
      fiscalYear: 'FY2025-26',
      userAge: taxYearAge,
    },
    dependencies: {
      requireFreshRecommendationState: async () => current,
      rankWhereToInvestBackend: async (...args) => { rankArguments = args; rankingCalls += 1; return []; },
    },
  });

  assert.equal(rankArguments[0].age, profileAge, 'the canonical Financial Profile age remains the suitability input');
  assert.equal(rankArguments[1].taxCalculationContext.userAge, taxYearAge, 'the selected fiscal-year age remains the tax input');
  assert.equal(result.financialStateBinding.profileId, current.profile._id, 'the WTI result stays bound to the saved profile');
  assert.equal(rankingCalls, 1);
});
