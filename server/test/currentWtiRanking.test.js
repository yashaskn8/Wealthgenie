import test from 'node:test';
import assert from 'node:assert/strict';
import { currentWtiBinding, rankWtiAgainstCurrentState } from '../services/currentWtiRanking.js';
import { calculateProductPostTaxOutcome } from '../services/productPostTaxCalculator.js';
import { SBI_RATE_DATA_CLASS, SBI_TERM_DEPOSIT_URL } from '../services/marketData/SbiTermDepositProvider.js';
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

function taxContextModelFor(rows = [null]) {
  let index = 0;
  return {
    findOne(query) {
      assert.equal(query.userId, 'user-1');
      assert.equal(query.profileId, '64b000000000000000000001');
      return {
        sort(order) {
          assert.deepEqual(order, { version: -1 });
          return this;
        },
        async lean() {
          const row = rows[Math.min(index, rows.length - 1)];
          index += 1;
          return row;
        },
      };
    },
  };
}

function savedTaxContext(overrides = {}) {
  return {
    _id: '64b000000000000000000010',
    userId: 'user-1',
    profileId: '64b000000000000000000001',
    profileVersion: 4,
    version: 1,
    fiscalYear: 'FY2025-26',
    userAge: 35,
    annualGrossIncome: 1500000,
    incomeSource: 'salary',
    regime: 'new',
    deductions: {},
    section112AExemptionUsed: null,
    inputFingerprint: 'c'.repeat(64),
    userDeclared: true,
    ...overrides,
  };
}

function qualifiedSbiRateProduct() {
  return {
    id: 'deposit:sbi:retail-domestic:1y-lt2y:public',
    canonicalProductId: 'deposit:sbi:retail-domestic:1y-lt2y:public',
    name: 'SBI Retail Domestic Term Deposit',
    productType: 'BANK_TERM_DEPOSIT',
    parentInstrumentId: 'sbi_fd',
    source: {
      provider: 'SBI',
      instrumentId: 'retail-domestic:1y-lt2y:public',
      url: SBI_TERM_DEPOSIT_URL,
    },
    availabilityStatus: 'AVAILABLE',
    freshness: { status: 'FRESH', ageSeconds: 60, maxAgeSeconds: 180 * 24 * 60 * 60 },
    officialRate: {
      value: 7,
      unit: 'PERCENT_PER_ANNUM',
      basis: 'OFFICIAL_NOMINAL_CARD_RATE_PER_ANNUM',
      dataClass: SBI_RATE_DATA_CLASS,
      observedAt: '2026-10-14T14:58:00.000Z',
      fetchedAt: '2026-10-14T14:59:00.000Z',
    },
  };
}

test('WTI ranking rejects stale state bindings before calling the ranking service, even with a different fiscal-year age', async () => {
  let rankingCalls = 0;
  await assert.rejects(() => rankWtiAgainstCurrentState({
    userId: 'user-1',
    profileId: '64b000000000000000000001',
    parentInstrumentId: 'index_mf',
    expectedBinding: { ...currentWtiBinding(state()), profileVersion: 3 },
    taxCalculationContext: { fiscalYear: 'FY2025-26', userAge: 34 },
    dependencies: {
      taxContextModel: taxContextModelFor(),
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
      taxContextModel: taxContextModelFor(),
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
      taxContextModel: taxContextModelFor(),
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
      taxContextModel: taxContextModelFor(),
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
        taxContextModel: taxContextModelFor(),
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
      taxContextModel: taxContextModelFor(),
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
      taxContextModel: taxContextModelFor(),
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
      taxContextModel: taxContextModelFor(),
      requireFreshRecommendationState: async () => current,
      rankWhereToInvestBackend: async (...args) => { rankArguments = args; rankingCalls += 1; return []; },
    },
  });

  assert.equal(rankArguments[0].age, profileAge, 'the canonical Financial Profile age remains the suitability input');
  assert.equal(rankArguments[1].taxCalculationContext.userAge, taxYearAge, 'the selected fiscal-year age remains the tax input');
  assert.equal(result.financialStateBinding.profileId, current.profile._id, 'the WTI result stays bound to the saved profile');
  assert.equal(rankingCalls, 1);
});

test('WTI uses a current profile-bound tax context to calculate a supported SBI deposit result', async () => {
  const current = state({ parentId: 'sbi_fd' });
  const contextRow = savedTaxContext();
  const result = await rankWtiAgainstCurrentState({
    userId: 'user-1',
    profileId: current.profile._id,
    parentInstrumentId: 'sbi_fd',
    expectedBinding: currentWtiBinding(current),
    taxCalculationContext: { illustrativePrincipal: 10000 },
    dependencies: {
      taxContextModel: taxContextModelFor([contextRow, contextRow]),
      requireFreshRecommendationState: async () => current,
      rankWhereToInvestBackend: async (_profile, request) => [{
        postTaxAnalysis: calculateProductPostTaxOutcome({
          product: qualifiedSbiRateProduct(),
          taxCalculationContext: request.taxCalculationContext,
          now: new Date('2026-10-14T15:00:00.000Z'),
        }),
      }],
    },
  });

  const outcome = result.ranked[0].postTaxAnalysis;
  assert.equal(outcome.status, 'CALCULATED');
  assert.equal(outcome.fiscalYear, 'FY2025-26');
  assert.equal(outcome.illustrativePrincipal, 10000);
  assert.ok(Number.isFinite(outcome.incrementalTax));
  assert.ok(Number.isFinite(outcome.postTaxRatePct));
});

test('WTI does not borrow a saved tax context from another profile version or fiscal year', async () => {
  const current = state();
  let rankArguments;
  await rankWtiAgainstCurrentState({
    userId: 'user-1',
    profileId: current.profile._id,
    parentInstrumentId: 'index_mf',
    expectedBinding: currentWtiBinding(current),
    taxCalculationContext: { fiscalYear: 'FY2026-27', illustrativePrincipal: 10000 },
    dependencies: {
      taxContextModel: taxContextModelFor([
        savedTaxContext({ profileVersion: 3 }),
        savedTaxContext({ profileVersion: 3 }),
      ]),
      requireFreshRecommendationState: async () => current,
      rankWhereToInvestBackend: async (...args) => { rankArguments = args; return []; },
    },
  });

  assert.deepEqual(rankArguments[1].taxCalculationContext, {
    fiscalYear: 'FY2026-27',
    illustrativePrincipal: 10000,
  });
});

test('WTI discards results when the saved tax context changes during ranking', async () => {
  const current = state({ parentId: 'sbi_fd' });
  const first = savedTaxContext();
  const second = savedTaxContext({
    _id: '64b000000000000000000011',
    version: 2,
    annualGrossIncome: 1600000,
    inputFingerprint: 'd'.repeat(64),
  });
  await assert.rejects(() => rankWtiAgainstCurrentState({
    userId: 'user-1',
    profileId: current.profile._id,
    parentInstrumentId: 'sbi_fd',
    expectedBinding: currentWtiBinding(current),
    taxCalculationContext: { illustrativePrincipal: 10000 },
    dependencies: {
      taxContextModel: taxContextModelFor([first, second]),
      requireFreshRecommendationState: async () => current,
      rankWhereToInvestBackend: async () => [],
    },
  }), { code: 'TAX_CONTEXT_CHANGED', status: 409 });
});
