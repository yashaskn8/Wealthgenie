import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPortfolioFingerprint, buildRecommendationFingerprint } from '../services/recommendationFingerprint.js';
import { assessRecommendationFreshness } from '../services/recommendationFreshness.js';
import { assessGoalCalculationFreshness } from '../services/recommendationState.js';
import { buildRecommendationProfileHash } from '../services/recommendationProfile.js';
import {
  PROJECTION_ASSUMPTION_POLICY_HASH,
  PROJECTION_ASSUMPTION_VERSION,
} from '../services/instrumentConstants.js';
import {
  buildGoalCalculationInputFingerprint,
  getGoalProjectionYearsRemaining,
  GOAL_CALCULATION_POLICY_VERSION,
} from '../services/goalCalculationProvenance.js';

const profile = {
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

const instruments = [
  {
    id: 'FD', allocationWeight: 0.6, nominalReturn: 7.5, riskScore: 1,
    returnAssumptionVersion: PROJECTION_ASSUMPTION_VERSION,
    returnAssumptionHash: PROJECTION_ASSUMPTION_POLICY_HASH, returnSource: 'WEALTHGENIE_MODEL_POLICY',
  },
  {
    id: 'ETF', allocationWeight: 0.4, nominalReturn: 14.5, riskScore: 3,
    returnAssumptionVersion: PROJECTION_ASSUMPTION_VERSION,
    returnAssumptionHash: PROJECTION_ASSUMPTION_POLICY_HASH, returnSource: 'WEALTHGENIE_MODEL_POLICY',
  },
];

function state() {
  const recommendation = {
    _id: '64b000000000000000000002', userId: '64b000000000000000000003', profileId: '64b000000000000000000004',
    modelVersion: 'model-1.0.0', regulatoryRuleVersion: 'tax-policy-FY2026-27-v2',
    profileVersion: 1,
    recommendationPolicyVersion: 'suitability-freeze-1.2.0',
    profileInputHash: buildRecommendationProfileHash(profile, { modelVersion: 'model-1.0.0' }),
  };
  const allocationRevision = {
    _id: '64b000000000000000000005', recommendationId: recommendation._id,
    profileId: recommendation.profileId, userId: recommendation.userId, revision: 2,
    source: 'USER_REBALANCED', instruments, profileInputHash: recommendation.profileInputHash,
    profileVersion: 1,
    returnAssumptionVersion: PROJECTION_ASSUMPTION_VERSION,
    returnAssumptionHash: PROJECTION_ASSUMPTION_POLICY_HASH,
    returnAssumptionSource: 'WEALTHGENIE_MODEL_POLICY',
  };
  const portfolioFingerprint = buildPortfolioFingerprint(instruments);
  const recommendationFingerprint = buildRecommendationFingerprint({
    recommendationId: recommendation._id,
    profileInputHash: recommendation.profileInputHash,
    modelVersion: recommendation.modelVersion,
    recommendationPolicyVersion: recommendation.recommendationPolicyVersion,
    regulatoryRuleVersion: recommendation.regulatoryRuleVersion,
    returnAssumptionVersion: allocationRevision.returnAssumptionVersion,
    returnAssumptionHash: allocationRevision.returnAssumptionHash,
    allocationRevision: allocationRevision.revision,
    instruments,
  });
  return {
    recommendation, allocationRevision, portfolioFingerprint, recommendationFingerprint,
    financialProfileState: { stateId: '64b000000000000000000007', currentProfileId: recommendation.profileId, revision: 3, promotionFence: 0 },
    freshness: { fresh: true, reasonCodes: [] },
  };
}

test('portfolio fingerprints are deterministic and independent of instrument order', () => {
  assert.equal(buildPortfolioFingerprint(instruments), buildPortfolioFingerprint([...instruments].reverse()));
  assert.notEqual(buildPortfolioFingerprint(instruments), buildPortfolioFingerprint([{ ...instruments[0], allocationWeight: 0.5 }, instruments[1]]));
});

test('recommendation fingerprint includes allocation revision identity', () => {
  const current = state();
  const base = {
    recommendationId: current.recommendation._id,
    profileInputHash: current.recommendation.profileInputHash,
    modelVersion: current.recommendation.modelVersion,
    recommendationPolicyVersion: current.recommendation.recommendationPolicyVersion,
    regulatoryRuleVersion: current.recommendation.regulatoryRuleVersion,
    returnAssumptionVersion: current.allocationRevision.returnAssumptionVersion,
    instruments,
  };
  assert.notEqual(buildRecommendationFingerprint({ ...base, allocationRevision: 1 }), buildRecommendationFingerprint({ ...base, allocationRevision: 2 }));
});

test('strict freshness rejects a missing or mismatched allocation provenance', () => {
  const current = state();
  const fresh = assessRecommendationFreshness({
    profile, recommendation: current.recommendation,
    currentRegulatoryRuleVersion: current.recommendation.regulatoryRuleVersion,
    allocationRevision: current.allocationRevision,
    requirePolicyVersion: true, requireAllocationState: true, requireAssumptionProvenance: true,
  });
  assert.equal(fresh.fresh, true);
  const stale = assessRecommendationFreshness({
    profile, recommendation: current.recommendation,
    currentRegulatoryRuleVersion: current.recommendation.regulatoryRuleVersion,
    allocationRevision: { ...current.allocationRevision, revision: 0 },
    requirePolicyVersion: true, requireAllocationState: true, requireAssumptionProvenance: true,
  });
  assert.ok(stale.reasonCodes.includes('ALLOCATION_REVISION_MISSING'));
});

test('goal freshness identifies allocation and source-state changes', () => {
  const current = state();
  const goal = {
    _id: '64b000000000000000000006',
    profileId: current.recommendation.profileId,
    target_amount: 1000000,
    target_date: new Date('2035-01-01T00:00:00.000Z'),
    current_savings: 100000,
    inflation_assumption: 0.05,
    years_remaining: getGoalProjectionYearsRemaining(new Date('2035-01-01T00:00:00.000Z')),
    sourceRecommendationId: current.recommendation._id,
    sourceAllocationRevision: 2,
    sourceAllocationRevisionId: current.allocationRevision._id,
    sourceProfileInputHash: current.recommendation.profileInputHash,
    sourceFinancialProfileStateRevision: current.financialProfileState.revision,
    sourceModelVersion: current.recommendation.modelVersion,
    sourceRecommendationPolicyVersion: current.recommendation.recommendationPolicyVersion,
    sourceRegulatoryRuleVersion: current.recommendation.regulatoryRuleVersion,
    sourceReturnAssumptionVersion: current.allocationRevision.returnAssumptionVersion,
    sourceReturnAssumptionHash: current.allocationRevision.returnAssumptionHash,
    return_assumption_source: current.allocationRevision.returnAssumptionSource,
    sourceRecommendationFingerprint: current.recommendationFingerprint,
    sourcePortfolioFingerprint: current.portfolioFingerprint,
    sourceGoalCalculationPolicyVersion: GOAL_CALCULATION_POLICY_VERSION,
  };
  goal.sourceGoalCalculationInputFingerprint = buildGoalCalculationInputFingerprint(goal);
  assert.equal(assessGoalCalculationFreshness(goal, current).fresh, true);
  const stale = assessGoalCalculationFreshness({ ...goal, sourceAllocationRevision: 1 }, current);
  assert.ok(stale.reasonCodes.includes('STALE_ALLOCATION'));
});
