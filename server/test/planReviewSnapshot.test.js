import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePlanReviewSnapshot } from '../agents/planReview/planReviewSnapshot.js';

const userId = '64b000000000000000000010';
const profileId = '64b000000000000000000001';
const storedProfile = {
  _id: profileId,
  userId,
  version: 3,
  monthlyTakeHome: 100000,
  monthlySavings: 20000,
  age: 35,
  riskTolerance: 'Moderate',
  investmentGoals: ['Wealth Growth'],
  investmentHorizonYears: 10,
};

function goalFixture(overrides = {}) {
  return {
    _id: '64b000000000000000000020',
    userId,
    profileId,
    version: 1,
    goal_name: 'Emergency reserve',
    target_amount: 500000,
    target_date: new Date('2030-01-01T00:00:00.000Z'),
    current_savings: 100000,
    priority: 'High',
    probability_of_success: 0.8,
    recommended_sip: 10000,
    gap_amount: 0,
    monte_carlo_summary: { p50: 600000 },
    status: 'on_track',
    ...overrides,
  };
}

function snapshotHarness() {
  let goals = [goalFixture()];
  let goalReadFails = false;
  const goalQueries = [];
  const goalModel = {
    find(filter) {
      assert.deepEqual(filter, { userId, profileId });
      if (goalReadFails) throw new Error('synthetic goal read failure');
      const query = {
        sort(value) {
          goalQueries.at(-1).sort = value;
          return query;
        },
        limit(value) {
          goalQueries.at(-1).limit = value;
          return query;
        },
        async lean() {
          return goals;
        },
      };
      goalQueries.push({ filter });
      return query;
    },
  };
  const profileModel = {
    findOne(filter) {
      assert.deepEqual(filter, { _id: profileId, userId });
      return { lean: async () => storedProfile };
    },
  };
  const currentState = {
    profile: storedProfile,
    profileVersion: storedProfile.version,
    recommendation: null,
    allocationRevision: null,
    freshness: { fresh: false, reasonCodes: ['RECOMMENDATION_MISSING'] },
    provenance: { status: 'MISSING' },
  };
  const dependencies = {
    resolveCurrentFinancialProfile: async input => {
      assert.equal(input.userId, userId);
      assert.equal(input.requireRecommendation, false);
      return { profile: storedProfile, state: { revision: 7 } };
    },
    resolveCurrentRecommendationState: async input => {
      assert.equal(input.userId, userId);
      assert.equal(input.profileId, profileId);
      return currentState;
    },
  };
  return {
    goalQueries,
    setGoals(value) { goals = value; },
    setGoalReadFailure(value) { goalReadFails = value; },
    resolve: () => resolvePlanReviewSnapshot({
      userId,
      profileId,
      profileModel,
      profileStateModel: {},
      goalModel,
      dependencies,
    }),
  };
}

test('PlanReview snapshot binding fingerprints the scoped visible goal set and goal versions', async () => {
  const harness = snapshotHarness();
  const first = await harness.resolve();

  harness.setGoals([goalFixture({ version: 2, target_amount: 650000 })]);
  const updated = await harness.resolve();

  harness.setGoals([]);
  const deleted = await harness.resolve();

  assert.equal(first.sourceBinding.goalSnapshotCount, 1);
  assert.match(first.sourceBinding.goalSnapshotHash, /^[a-f0-9]{64}$/);
  assert.notEqual(first.sourceBinding.goalSnapshotHash, updated.sourceBinding.goalSnapshotHash);
  assert.notEqual(updated.sourceBinding.goalSnapshotHash, deleted.sourceBinding.goalSnapshotHash);
  assert.equal(first.sourceBinding.schemaVersion, 'plan-review-source-binding-1.1.0');
  assert.equal(harness.goalQueries.length, 3);
  assert.deepEqual(harness.goalQueries[0].sort, { target_date: 1, _id: 1 });
  assert.equal(harness.goalQueries[0].limit, 20);
});

test('PlanReview fails closed when it cannot read the current scoped goal snapshot', async () => {
  const harness = snapshotHarness();
  harness.setGoalReadFailure(true);
  await assert.rejects(harness.resolve(), { code: 'PLAN_REVIEW_GOALS_UNAVAILABLE', status: 503 });
});
