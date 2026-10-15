import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCurrentGoalResponse, buildGoalAdvisoryMetadata } from '../services/goalResponse.js';
import {
  buildGoalCalculationInputFingerprint,
  getGoalProjectionYearsRemaining,
  GOAL_CALCULATION_POLICY_VERSION,
} from '../services/goalCalculationProvenance.js';
import { buildProjectionHorizon } from '../services/monteCarloEngine.js';
import { customGoalUpdateSchema } from '../validation/financialSchemas.js';

const source = {
  recommendation: {
    _id: 'recommendation-1',
    profileId: 'profile-1',
    profileInputHash: 'a'.repeat(64),
    modelVersion: 'model-1',
    recommendationPolicyVersion: 'policy-1',
    regulatoryRuleVersion: 'tax-policy-1',
  },
  allocationRevision: {
    _id: 'allocation-2',
    revision: 2,
    returnAssumptionVersion: 'assumptions-1',
    returnAssumptionHash: 'b'.repeat(64),
    returnAssumptionSource: 'WEALTHGENIE_MODEL_POLICY',
  },
  profileVersion: 4,
  financialProfileState: { stateId: 'profile-state-1', currentProfileId: 'profile-1', revision: 3, promotionFence: 1 },
  recommendationFingerprint: 'c'.repeat(64),
  portfolioFingerprint: 'd'.repeat(64),
  freshness: { fresh: true, reasonCodes: [] },
};

function goal() {
  const targetDate = new Date();
  targetDate.setUTCFullYear(targetDate.getUTCFullYear() + 9);
  return {
    _id: 'goal-1',
    profileId: 'profile-1',
    target_amount: 1000000,
    target_date: targetDate,
    current_savings: 100000,
    inflation_assumption: 0.05,
    years_remaining: getGoalProjectionYearsRemaining(targetDate),
    sourceRecommendationId: 'recommendation-1',
    sourceAllocationRevision: 2,
    sourceAllocationRevisionId: 'allocation-2',
    sourceProfileInputHash: source.recommendation.profileInputHash,
    sourceProfileVersion: source.profileVersion,
    sourceFinancialProfileStateRevision: source.financialProfileState.revision,
    sourceModelVersion: source.recommendation.modelVersion,
    sourceRecommendationPolicyVersion: source.recommendation.recommendationPolicyVersion,
    sourceRegulatoryRuleVersion: source.recommendation.regulatoryRuleVersion,
    sourceReturnAssumptionVersion: source.allocationRevision.returnAssumptionVersion,
    sourceReturnAssumptionHash: source.allocationRevision.returnAssumptionHash,
    return_assumption_source: source.allocationRevision.returnAssumptionSource,
    sourceRecommendationFingerprint: source.recommendationFingerprint,
    sourcePortfolioFingerprint: source.portfolioFingerprint,
    sourceGoalCalculationInputFingerprint: null,
    sourceGoalCalculationPolicyVersion: GOAL_CALCULATION_POLICY_VERSION,
    recommended_sip: 5000,
    probability_of_success: 0.72,
    status: 'on_track',
    chart_data: [{ year: 1, p50: 100 }],
    gemini_advice: 'Keep the current contribution.',
  };
}

test('goal response suppresses derived values and advice when source freshness is missing', () => {
  const response = buildCurrentGoalResponse(goal());
  assert.equal(response.calculation_freshness.fresh, false);
  assert.equal(response.recommended_sip, null);
  assert.equal(response.probability_of_success, null);
  assert.deepEqual(response.chartData, []);
  assert.equal(response.gemini_advice, null);
  assert.equal(response.advisory_freshness.fresh, false);
});

test('goal response reports a typed safe state-resolution failure without exposing its cause', () => {
  const response = buildCurrentGoalResponse(goal(), { resolutionFailure: true });
  assert.deepEqual(response.calculation_freshness, {
    fresh: false,
    reasonCodes: ['STATE_RESOLUTION_FAILED'],
    resolution: { status: 'FAILED', code: 'GOAL_STATE_RESOLUTION_FAILED' },
  });
  assert.equal(response.recommended_sip, null);
  assert.equal(response.probability_of_success, null);
  assert.deepEqual(response.chartData, []);
  assert.equal(response.gemini_advice, null);
  assert.equal(JSON.stringify(response).includes('error'), false);
});

test('public goal DTO excludes owner and durable idempotency persistence fields', () => {
  const response = buildCurrentGoalResponse({
    ...goal(),
    userId: 'private-user-id',
    idempotencyOperationId: 'private-operation-id',
    idempotencyRequestHash: 'e'.repeat(64),
    internalReviewNotes: 'not part of the public contract',
  });
  assert.equal(response.userId, undefined);
  assert.equal(response.idempotencyOperationId, undefined);
  assert.equal(response.idempotencyRequestHash, undefined);
  assert.equal(response.internalReviewNotes, undefined);
  assert.equal(response.goalId, 'goal-1');
});

test('goal advisory metadata is accepted only for the exact current source state', () => {
  const currentGoal = goal();
  currentGoal.sourceGoalCalculationInputFingerprint = buildGoalCalculationInputFingerprint(currentGoal);
  currentGoal.advisoryMetadata = buildGoalAdvisoryMetadata({ goal: currentGoal, state: source });
  const response = buildCurrentGoalResponse(currentGoal, { state: source });
  assert.equal(response.calculation_freshness.fresh, true);
  assert.equal(response.advisory_freshness.fresh, true);
  assert.equal(response.gemini_advice, currentGoal.gemini_advice);

  const stale = buildCurrentGoalResponse(currentGoal, {
    state: { ...source, allocationRevision: { ...source.allocationRevision, revision: 3 } },
  });
  assert.equal(stale.calculation_freshness.fresh, false);
  assert.equal(stale.recommended_sip, null);
  assert.equal(stale.gemini_advice, null);
});

test('goal calculation and advisory become stale when the canonical profile pointer advances', () => {
  const currentGoal = goal();
  currentGoal.sourceGoalCalculationInputFingerprint = buildGoalCalculationInputFingerprint(currentGoal);
  currentGoal.advisoryMetadata = buildGoalAdvisoryMetadata({ goal: currentGoal, state: source });
  const response = buildCurrentGoalResponse(currentGoal, {
    state: { ...source, financialProfileState: { ...source.financialProfileState, revision: 4, currentProfileId: 'profile-2' } },
  });
  assert.equal(response.calculation_freshness.fresh, false);
  assert.ok(response.calculation_freshness.reasonCodes.includes('STALE_PROFILE'));
  assert.equal(response.recommended_sip, null);
  assert.equal(response.gemini_advice, null);
});

test('historical goal output reports stale profile when canonical pointer targets another profile', () => {
  const response = buildCurrentGoalResponse(goal(), {
    state: {
      recommendation: null,
      financialProfileState: { currentProfileId: 'profile-2', revision: 4 },
    },
  });
  assert.deepEqual(response.calculation_freshness, { fresh: false, reasonCodes: ['STALE_PROFILE'] });
  assert.equal(response.probability_of_success, null);
});

test('goal advisory is stale when a displayed goal input changes without a matching recalculation', () => {
  const currentGoal = goal();
  currentGoal.sourceGoalCalculationInputFingerprint = buildGoalCalculationInputFingerprint(currentGoal);
  currentGoal.advisoryMetadata = buildGoalAdvisoryMetadata({ goal: currentGoal, state: source });
  const changed = buildCurrentGoalResponse({ ...currentGoal, target_amount: currentGoal.target_amount + 1 }, { state: source });
  assert.equal(changed.calculation_freshness.fresh, false);
  assert.ok(changed.calculation_freshness.reasonCodes.includes('STALE_GOAL_INPUTS'));
  assert.equal(changed.advisory_freshness.fresh, false);
  assert.equal(changed.gemini_advice, null);
});

test('goal calculation and advice become stale when calendar time changes the modeled horizon', () => {
  const calculationTime = new Date('2026-01-01T00:00:00.000Z');
  const laterTime = new Date('2026-05-01T00:00:00.000Z');
  const currentGoal = goal();
  currentGoal.target_date = new Date('2030-01-01T00:00:00.000Z');
  currentGoal.years_remaining = getGoalProjectionYearsRemaining(currentGoal.target_date, calculationTime);
  currentGoal.sourceGoalCalculationInputFingerprint = buildGoalCalculationInputFingerprint(currentGoal);
  currentGoal.advisoryMetadata = buildGoalAdvisoryMetadata({ goal: currentGoal, state: source });

  const atCalculationTime = buildCurrentGoalResponse(currentGoal, { state: source, now: calculationTime });
  assert.equal(atCalculationTime.calculation_freshness.fresh, true);
  assert.equal(atCalculationTime.advisory_freshness.fresh, true);

  const persistedSnapshot = JSON.stringify(currentGoal);
  const afterHorizonChange = buildCurrentGoalResponse(currentGoal, { state: source, now: laterTime });
  assert.equal(afterHorizonChange.calculation_freshness.fresh, false);
  assert.ok(afterHorizonChange.calculation_freshness.reasonCodes.includes('STALE_GOAL_HORIZON'));
  assert.equal(afterHorizonChange.years_remaining, null);
  assert.equal(afterHorizonChange.recommended_sip, null);
  assert.equal(afterHorizonChange.gemini_advice, null);
  assert.equal(JSON.stringify(currentGoal), persistedSnapshot, 'a read-only response must not mutate the saved calculation');
});

test('near-target freshness uses the same rounded monthly horizon as the projection engine', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const twoMonthsAway = new Date('2026-03-01T00:00:00.000Z');
  const yearsRemaining = getGoalProjectionYearsRemaining(twoMonthsAway, now);
  assert.equal(yearsRemaining, 2 / 12);
  assert.equal(buildProjectionHorizon(yearsRemaining).totalMonths, 2);
  const belowMinimum = new Date(now.getTime() + (14 * 24 * 60 * 60 * 1000));
  assert.equal(Math.round(((belowMinimum - now) / (365.25 * 24 * 60 * 60 * 1000)) * 12), 0);
  assert.equal(getGoalProjectionYearsRemaining(belowMinimum, now), null);
  const fifteenDaysAway = new Date(now.getTime() + (15 * 24 * 60 * 60 * 1000));
  assert.equal(getGoalProjectionYearsRemaining(fifteenDaysAway, now), null);
  const atMinimum = new Date(now.getTime() + (16 * 24 * 60 * 60 * 1000));
  const minimumHorizon = getGoalProjectionYearsRemaining(atMinimum, now);
  assert.equal(minimumHorizon, 1 / 12);
  assert.equal(buildProjectionHorizon(minimumHorizon).totalMonths, 1);
  assert.equal(getGoalProjectionYearsRemaining(new Date('2025-12-31T23:59:59.999Z'), now), null);
});

test('a leap-day 30-year boundary follows setFullYear rollover and remains 360 modeled months', () => {
  const now = new Date(2024, 1, 29, 12, 0, 0, 0);
  const maximumCalendarHorizon = new Date(now);
  maximumCalendarHorizon.setFullYear(maximumCalendarHorizon.getFullYear() + 30);

  // JavaScript setFullYear rolls February 29 to March 1 in a non-leap target year.
  assert.equal(maximumCalendarHorizon.getFullYear(), 2054);
  assert.equal(maximumCalendarHorizon.getMonth(), 2);
  assert.equal(maximumCalendarHorizon.getDate(), 1);
  const modeledYears = getGoalProjectionYearsRemaining(maximumCalendarHorizon, now);
  assert.equal(modeledYears, 30);
  assert.equal(buildProjectionHorizon(modeledYears).totalMonths, 360);
});

test('explicit zero current savings is valid, fingerprinted, and accepted by the update contract', () => {
  const zeroSavingsGoal = { ...goal(), current_savings: 0 };
  zeroSavingsGoal.sourceGoalCalculationInputFingerprint = buildGoalCalculationInputFingerprint(zeroSavingsGoal);
  zeroSavingsGoal.advisoryMetadata = buildGoalAdvisoryMetadata({ goal: zeroSavingsGoal, state: source });

  const response = buildCurrentGoalResponse(zeroSavingsGoal, { state: source });
  assert.equal(response.calculation_freshness.fresh, true);
  assert.equal(response.current_savings, 0);
  assert.ok(zeroSavingsGoal.sourceGoalCalculationInputFingerprint);
  assert.equal(buildGoalCalculationInputFingerprint({ ...zeroSavingsGoal, current_savings: undefined }), null);
  assert.equal(buildGoalCalculationInputFingerprint({ ...zeroSavingsGoal, target_amount: undefined }), null);
  assert.equal(customGoalUpdateSchema.validate({ expectedVersion: 1, current_savings: 0 }, { convert: false }).error, undefined);
});
