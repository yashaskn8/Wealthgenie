const OBJECT_ID = /^[a-f\d]{24}$/i;
const SHA256 = /^[a-f\d]{64}$/i;

function same(left, right) {
  return String(left ?? '') === String(right ?? '');
}

export function hasCompleteFinancialStateBinding(value, { profileId, profileVersion } = {}) {
  const freshness = value?.calculation_freshness;
  const provenance = value?.state_provenance;
  const revision = Number(value?.allocation_revision);
  const boundProfileVersion = Number(value?.profile_version);
  const identifiersValid = OBJECT_ID.test(String(value?.profileId || ''))
    && OBJECT_ID.test(String(value?.recommendationId || ''))
    && OBJECT_ID.test(String(value?.recommendation_id || ''))
    && OBJECT_ID.test(String(value?.allocation_revision_id || ''))
    && OBJECT_ID.test(String(provenance?.stateId || ''));
  const hashesValid = SHA256.test(String(value?.profile_input_hash || ''))
    && SHA256.test(String(value?.portfolio_fingerprint || ''))
    && SHA256.test(String(value?.recommendation_fingerprint || ''));
  const versionsValid = Number.isSafeInteger(revision) && revision > 0
    && Number.isSafeInteger(boundProfileVersion) && boundProfileVersion > 0
    && Number(provenance?.profileVersion) === boundProfileVersion
    && Number(freshness?.expectedProfileVersion) === boundProfileVersion
    && Number(freshness?.observedProfileVersion) === boundProfileVersion
    && Number(freshness?.allocationRevision) === revision
    && freshness?.currentAllocationSource === value?.current_allocation_source;
  const provenanceMatches = provenance?.status === 'PERSISTED_REVISION'
    && same(value?.recommendationId, value?.recommendation_id)
    && same(value?.recommendationId, provenance?.recommendationId)
    && same(value?.current_allocation_source, provenance?.allocationSource)
    && same(value?.allocation_revision_id, provenance?.allocationRevisionId)
    && Number(provenance?.allocationRevision) === revision
    && value?.profile_input_hash === provenance?.profileInputHash
    && value?.portfolio_fingerprint === provenance?.portfolioFingerprint
    && value?.recommendation_fingerprint === provenance?.recommendationFingerprint
    && value?.recommendation_policy_version === provenance?.recommendationPolicyVersion
    && value?.regulatory_rule_version === provenance?.regulatoryRuleVersion
    && value?.return_assumption_version === provenance?.returnAssumptionVersion
    && value?.return_assumption_hash === provenance?.returnAssumptionHash
    && value?.return_assumption_source === provenance?.returnAssumptionSource
    && Number(value?.previous_allocation_revision ?? 0) === Number(provenance?.previousAllocationRevision ?? 0)
    && same(value?.previous_allocation_revision_id, provenance?.previousAllocationRevisionId)
    && (revision === 1
      ? value?.previous_allocation_revision == null && value?.previous_allocation_revision_id == null
      : Number(value?.previous_allocation_revision) === revision - 1
        && OBJECT_ID.test(String(value?.previous_allocation_revision_id || '')));
  const freshnessMatches = freshness?.fresh === true
    && Array.isArray(freshness.reasonCodes) && freshness.reasonCodes.length === 0
    && freshness.expectedProfileHash === value?.profile_input_hash
    && freshness.observedProfileHash === value?.profile_input_hash
    && freshness.observedRegulatoryVersion === value?.regulatory_rule_version
    && freshness.currentRegulatoryVersion === value?.regulatory_rule_version
    && freshness.policyVersion === value?.recommendation_policy_version
    && freshness.observedRecommendationPolicyVersion === value?.recommendation_policy_version
    && freshness.assumptionVersion === value?.return_assumption_version
    && freshness.assumptionHash === value?.return_assumption_hash
    && freshness.assumptionSource === value?.return_assumption_source;
  return value?.response_state === 'CURRENT'
    && value?.current_allocation_source != null
    && identifiersValid
    && hashesValid
    && versionsValid
    && provenanceMatches
    && freshnessMatches
    && (!profileId || same(profileId, value.profileId))
    && (profileVersion == null || Number(profileVersion) === boundProfileVersion);
}

export function sameFinancialState(left, right) {
  if (!hasCompleteFinancialStateBinding(left) || !hasCompleteFinancialStateBinding(right)) return false;
  return left.profileId === right.profileId
    && left.profile_version === right.profile_version
    && left.recommendationId === right.recommendationId
    && left.allocation_revision === right.allocation_revision
    && left.allocation_revision_id === right.allocation_revision_id
    && left.profile_input_hash === right.profile_input_hash
    && left.portfolio_fingerprint === right.portfolio_fingerprint
    && left.recommendation_fingerprint === right.recommendation_fingerprint
    && left.state_provenance.stateId === right.state_provenance.stateId;
}

export function isExactAllocationSuccessor(predecessor, candidate) {
  return hasCompleteFinancialStateBinding(predecessor)
    && hasCompleteFinancialStateBinding(candidate, {
      profileId: predecessor.profileId,
      profileVersion: predecessor.profile_version,
    })
    && candidate.recommendationId === predecessor.recommendationId
    && candidate.allocation_revision === predecessor.allocation_revision + 1
    && candidate.previous_allocation_revision === predecessor.allocation_revision
    && candidate.previous_allocation_revision_id === predecessor.allocation_revision_id
    && candidate.allocation_revision_id !== predecessor.allocation_revision_id;
}

export function matchesProfileState(value, profile) {
  return hasCompleteFinancialStateBinding(value, {
    profileId: profile?.profileId || profile?._id,
    profileVersion: profile?.version,
  });
}

export function getCurrentRecommendedInstrument(value, instrumentId, profile) {
  const profileId = profile?.profileId || profile?.profile_id || profile?._id;
  const profileVersion = Number(profile?.version ?? profile?.profileVersion);
  if (!instrumentId || !profileId || !Number.isSafeInteger(profileVersion) || profileVersion < 1
      || !hasCompleteFinancialStateBinding(value, { profileId, profileVersion })) {
    return null;
  }

  return Array.isArray(value?.instruments)
    ? value.instruments.find(instrument => instrument?.id === instrumentId) || null
    : null;
}
