import { describe, expect, it } from 'vitest';
import {
  hasCompleteFinancialStateBinding,
  getCurrentRecommendedInstrument,
  isExactAllocationSuccessor,
  matchesProfileState,
  sameFinancialState,
} from './financialStateBinding';

const id = n => `64b0000000000000000000${String(n).padStart(2, '0')}`;
const hash = char => char.repeat(64);

function current(overrides = {}) {
  const value = {
    response_state: 'CURRENT',
    profileId: id(1),
    profile_version: 4,
    recommendationId: id(2),
    recommendation_id: id(2),
    allocation_revision: 3,
    allocation_revision_id: id(3),
    previous_allocation_revision: 2,
    previous_allocation_revision_id: id(4),
    profile_input_hash: hash('a'),
    portfolio_fingerprint: hash('b'),
    recommendation_fingerprint: hash('c'),
    recommendation_policy_version: 'policy-1',
    regulatory_rule_version: 'tax-policy-1',
    return_assumption_version: 'assumption-1',
    return_assumption_hash: hash('d'),
    return_assumption_source: 'MODEL_POLICY',
    current_allocation_source: 'USER_REBALANCED',
    calculation_freshness: {
      fresh: true,
      reasonCodes: [],
      expectedProfileHash: hash('a'),
      observedProfileHash: hash('a'),
      expectedProfileVersion: 4,
      observedProfileVersion: 4,
      allocationRevision: 3,
      currentAllocationSource: 'USER_REBALANCED',
      observedRegulatoryVersion: 'tax-policy-1',
      currentRegulatoryVersion: 'tax-policy-1',
      policyVersion: 'policy-1',
      observedRecommendationPolicyVersion: 'policy-1',
      assumptionVersion: 'assumption-1',
      assumptionHash: hash('d'),
      assumptionSource: 'MODEL_POLICY',
    },
    state_provenance: {
      status: 'PERSISTED_REVISION',
      stateId: id(5),
      recommendationId: id(2),
      allocationSource: 'USER_REBALANCED',
      allocationRevision: 3,
      allocationRevisionId: id(3),
      profileVersion: 4,
      profileInputHash: hash('a'),
      portfolioFingerprint: hash('b'),
      recommendationFingerprint: hash('c'),
      recommendationPolicyVersion: 'policy-1',
      regulatoryRuleVersion: 'tax-policy-1',
      returnAssumptionVersion: 'assumption-1',
      returnAssumptionHash: hash('d'),
      returnAssumptionSource: 'MODEL_POLICY',
      previousAllocationRevision: 2,
      previousAllocationRevisionId: id(4),
    },
  };
  return { ...value, ...overrides };
}

describe('canonical financial response binding', () => {
  it('requires every current-state token and matching freshness proof', () => {
    expect(hasCompleteFinancialStateBinding(current())).toBe(true);
    expect(hasCompleteFinancialStateBinding({ ...current(), allocation_revision_id: null })).toBe(false);
    expect(hasCompleteFinancialStateBinding({
      ...current(),
      calculation_freshness: { ...current().calculation_freshness, fresh: false },
    })).toBe(false);
  });

  it('binds state to the active profile version', () => {
    expect(matchesProfileState(current(), { profileId: id(1), version: 4 })).toBe(true);
    expect(matchesProfileState(current(), { profileId: id(1), version: 5 })).toBe(false);
  });

  it('resolves recommendation display data only from the current profile-bound instrument list', () => {
    const instrument = { id: 'index_mf', name: 'Index funds', allocation_pct: 0 };
    const state = current({ instruments: [instrument] });

    expect(getCurrentRecommendedInstrument(state, instrument.id, { profileId: id(1), version: 4 })).toBe(instrument);
    expect(getCurrentRecommendedInstrument(state, 'catalog_alternative', { profileId: id(1), version: 4 })).toBeNull();
    expect(getCurrentRecommendedInstrument(state, instrument.id, { profileId: id(1), version: 5 })).toBeNull();
    expect(getCurrentRecommendedInstrument({ ...state, response_state: 'HISTORICAL_GENERATION' }, instrument.id, { profileId: id(1), version: 4 })).toBeNull();
  });

  it('recognizes only an exact next allocation revision from the captured predecessor', () => {
    const predecessor = current();
    const next = current({
      allocation_revision: 4,
      allocation_revision_id: id(6),
      previous_allocation_revision: 3,
      previous_allocation_revision_id: id(3),
      portfolio_fingerprint: hash('e'),
      recommendation_fingerprint: hash('f'),
      state_provenance: {
        ...predecessor.state_provenance,
        allocationRevision: 4,
        allocationRevisionId: id(6),
        previousAllocationRevision: 3,
        previousAllocationRevisionId: id(3),
        portfolioFingerprint: hash('e'),
        recommendationFingerprint: hash('f'),
      },
      calculation_freshness: {
        ...predecessor.calculation_freshness,
        allocationRevision: 4,
      },
    });
    expect(isExactAllocationSuccessor(predecessor, next)).toBe(true);
    expect(isExactAllocationSuccessor(predecessor, current({ allocation_revision: 5 }))).toBe(false);
  });

  it('does not treat incomplete responses as the same state', () => {
    expect(sameFinancialState(current(), current())).toBe(true);
    expect(sameFinancialState(current(), { ...current(), response_state: 'HISTORICAL_GENERATION' })).toBe(false);
  });

  it('rejects responses whose freshness proof omits policy, assumption, or revision identity', () => {
    const value = current();
    expect(hasCompleteFinancialStateBinding({ ...value, calculation_freshness: undefined })).toBe(false);
    for (const field of ['policyVersion', 'assumptionHash', 'allocationRevision', 'currentRegulatoryVersion']) {
      const calculation_freshness = { ...value.calculation_freshness };
      delete calculation_freshness[field];
      expect(hasCompleteFinancialStateBinding({ ...value, calculation_freshness })).toBe(false);
    }
  });
});
