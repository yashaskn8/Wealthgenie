import {
  buildAssetClassAllocation,
  buildDashboardProjection,
  buildPortfolioReturnAssumption,
} from './coreRecommendation.js';
import {
  PROJECTION_ASSUMPTION_DATA_CLASS,
  PROJECTION_ASSUMPTION_POLICY_HASH,
  PROJECTION_ASSUMPTION_SOURCE,
  PROJECTION_ASSUMPTION_VERSION,
} from './instrumentConstants.js';
import { buildPortfolioFingerprint, buildRecommendationFingerprint } from './recommendationFingerprint.js';

function snapshotResponse(snapshot) {
  if (snapshot?.recommendation && snapshot?.completion) return snapshot.recommendation;
  return snapshot;
}

function publicMarketAdjustment(adjustment) {
  if (!adjustment || typeof adjustment !== 'object' || Array.isArray(adjustment)) return adjustment;
  const publicMetadata = { ...adjustment };
  delete publicMetadata.sourceProvider;
  return publicMetadata;
}

function buildComputedWeights(instruments) {
  return Object.fromEntries(instruments.map(instrument => [
    instrument.id,
    Number(instrument.allocationWeight),
  ]));
}

function assertCurrentBinding({ profile, recommendation, allocationRevision, freshness, provenance, portfolioFingerprint, recommendationFingerprint }) {
  const objectId = /^[a-f\d]{24}$/i;
  const hash = /^[a-f\d]{64}$/i;
  const profileVersion = Number(profile?.version);
  let recomputedPortfolioFingerprint = null;
  try {
    recomputedPortfolioFingerprint = buildPortfolioFingerprint(allocationRevision?.instruments);
  } catch {
    // The public response is fail-closed below if its persisted allocation
    // cannot be canonicalized and fingerprinted.
  }
  const valid = freshness?.fresh === true
    && Array.isArray(freshness.reasonCodes) && freshness.reasonCodes.length === 0
    && provenance?.status === 'PERSISTED_REVISION'
    && objectId.test(String(provenance.stateId || ''))
    && objectId.test(String(profile?._id || ''))
    && objectId.test(String(recommendation?._id || ''))
    && objectId.test(String(allocationRevision?._id || ''))
    && String(recommendation.profileId || '') === String(profile._id || '')
    && String(allocationRevision.recommendationId || '') === String(recommendation._id || '')
    && String(allocationRevision.profileId || '') === String(profile._id || '')
    && String(allocationRevision.userId || '') === String(recommendation.userId || '')
    && String(profile.userId || '') === String(recommendation.userId || '')
    && Number.isSafeInteger(profileVersion) && profileVersion > 0
    && freshness.profilePresent === true
    && freshness.recommendationPresent === true
    && freshness.modelVersion === recommendation.modelVersion
    && freshness.observedProfileHash === recommendation.profileInputHash
    && freshness.expectedProfileHash === recommendation.profileInputHash
    && Number(freshness.allocationRevision) === Number(allocationRevision.revision)
    && freshness.currentAllocationSource === allocationRevision.source
    && freshness.policyVersion === recommendation.recommendationPolicyVersion
    && freshness.observedRecommendationPolicyVersion === recommendation.recommendationPolicyVersion
    && freshness.observedRegulatoryVersion === recommendation.regulatoryRuleVersion
    && freshness.currentRegulatoryVersion === recommendation.regulatoryRuleVersion
    && freshness.assumptionVersion === PROJECTION_ASSUMPTION_VERSION
    && freshness.assumptionHash === PROJECTION_ASSUMPTION_POLICY_HASH
    && freshness.assumptionSource === PROJECTION_ASSUMPTION_SOURCE
    && Number(recommendation.profileVersion) === profileVersion
    && Number(allocationRevision.profileVersion) === profileVersion
    && Number.isSafeInteger(Number(allocationRevision.revision)) && Number(allocationRevision.revision) > 0
    && allocationRevision.profileInputHash === recommendation.profileInputHash
    && allocationRevision.modelVersion === recommendation.modelVersion
    && allocationRevision.recommendationPolicyVersion === recommendation.recommendationPolicyVersion
    && allocationRevision.regulatoryRuleVersion === recommendation.regulatoryRuleVersion
    && allocationRevision.returnAssumptionVersion
      === (allocationRevision.instruments[0]?.returnAssumptionVersion || PROJECTION_ASSUMPTION_VERSION)
    && hash.test(String(recommendation.profileInputHash || ''))
    && hash.test(String(portfolioFingerprint || ''))
    && allocationRevision.portfolioFingerprint === portfolioFingerprint
    && hash.test(String(recommendationFingerprint || ''))
    && String(provenance.recommendationId || '') === String(recommendation._id)
    && String(provenance.allocationRevisionId || '') === String(allocationRevision._id)
    && Number(provenance.allocationRevision) === Number(allocationRevision.revision)
    && Number(provenance.profileVersion) === profileVersion
    && provenance.profileInputHash === recommendation.profileInputHash
    && freshness.expectedProfileHash === recommendation.profileInputHash
    && freshness.observedProfileHash === recommendation.profileInputHash
    && Number(freshness.expectedProfileVersion) === profileVersion
    && Number(freshness.observedProfileVersion) === profileVersion
    && freshness.observedRegulatoryVersion === recommendation.regulatoryRuleVersion
    && freshness.currentRegulatoryVersion === recommendation.regulatoryRuleVersion
    && freshness.observedRecommendationPolicyVersion === recommendation.recommendationPolicyVersion
    && provenance.portfolioFingerprint === portfolioFingerprint
    && provenance.recommendationFingerprint === recommendationFingerprint
    && provenance.recommendationPolicyVersion === recommendation.recommendationPolicyVersion
    && provenance.regulatoryRuleVersion === recommendation.regulatoryRuleVersion
    && provenance.returnAssumptionVersion === allocationRevision.returnAssumptionVersion
    && provenance.returnAssumptionHash === allocationRevision.returnAssumptionHash
    && provenance.returnAssumptionSource === allocationRevision.returnAssumptionSource
    && Number(provenance.previousAllocationRevision ?? 0) === Number(allocationRevision.previousRevision ?? 0)
    && String(provenance.previousAllocationRevisionId || '') === String(allocationRevision.previousAllocationRevisionId || '')
    && provenance.allocationSource === allocationRevision.source
    && freshness.policyVersion === recommendation.recommendationPolicyVersion
    && allocationRevision.instruments.every(instrument => (
      instrument.returnAssumptionVersion === allocationRevision.returnAssumptionVersion
        && instrument.returnAssumptionHash === allocationRevision.returnAssumptionHash
        && instrument.returnSource === allocationRevision.returnAssumptionSource
    ))
    && recomputedPortfolioFingerprint === portfolioFingerprint;
  let recomputedRecommendationFingerprint = null;
  if (valid) {
    try {
      recomputedRecommendationFingerprint = buildRecommendationFingerprint({
        recommendationId: recommendation._id,
        profileInputHash: recommendation.profileInputHash,
        modelVersion: recommendation.modelVersion,
        recommendationPolicyVersion: recommendation.recommendationPolicyVersion,
        regulatoryRuleVersion: recommendation.regulatoryRuleVersion,
        returnAssumptionVersion: allocationRevision.returnAssumptionVersion,
        returnAssumptionHash: allocationRevision.returnAssumptionHash,
        allocationRevision: allocationRevision.revision,
        instruments: allocationRevision.instruments,
      });
    } catch {
      // Keep malformed persisted state as a binding failure rather than an
      // unstructured server error or a partially trusted response.
    }
  }
  if (!valid || recomputedRecommendationFingerprint !== recommendationFingerprint) {
    const error = new Error('The server could not prove a complete, current financial-state binding.');
    error.code = 'FINANCIAL_RESPONSE_BINDING_INVALID';
    error.status = 503;
    throw error;
  }
}

/**
 * Build the public current recommendation response from one allocation revision.
 * responseSnapshot is generation history only and is never used for derived
 * allocation-dependent values here.
 */
export function buildCurrentRecommendationResponse({
  profile,
  recommendation,
  allocationRevision,
  freshness,
  provenance,
  portfolioFingerprint,
  recommendationFingerprint,
  advisoryExplanation = null,
  advisoryText = null,
} = {}) {
  if (!profile || !recommendation || !Array.isArray(allocationRevision?.instruments) || allocationRevision.instruments.length === 0) {
    const error = new Error('The current financial allocation is unavailable.');
    error.code = 'FINANCIAL_STATE_INTEGRITY_ERROR';
    error.status = 503;
    throw error;
  }

  assertCurrentBinding({
    profile,
    recommendation,
    allocationRevision,
    freshness,
    provenance,
    portfolioFingerprint,
    recommendationFingerprint,
  });

  const instruments = allocationRevision.instruments;
  const historical = snapshotResponse(recommendation.responseSnapshot) || {};
  if (!/^[a-f\d]{24}$/i.test(String(historical.audit_id || ''))
      || !/^[a-f\d]{64}$/i.test(String(historical.audit_hash || ''))) {
    const error = new Error('The recommendation generation is missing its immutable audit binding.');
    error.code = 'FINANCIAL_STATE_AUDIT_BINDING_MISSING';
    error.status = 503;
    throw error;
  }
  const generationInstruments = recommendation.instruments || historical.instruments || [];
  const generationMarketAdjustment = publicMarketAdjustment(
    historical.generation_market_adjustment || historical.market_adjustment || null,
  );
  const currentFingerprint = portfolioFingerprint || allocationRevision.portfolioFingerprint || null;

  return {
    ...historical,
    instruments,
    generation_instruments: generationInstruments,
    generation_explanation: historical.explanation || null,
    generation_market_adjustment: generationMarketAdjustment,
    // Market context explains the generation-time choice only. After a manual
    // allocation revision, do not present that historical adjustment as if it
    // were applied to the current allocation.
    market_adjustment: Number(allocationRevision.revision) === 1
      ? publicMarketAdjustment(historical.market_adjustment || generationMarketAdjustment)
      : null,
    // The model explanation was generated for the original portfolio. Keep it
    // explicitly historical after a user changes allocation weights.
    explanation: Number(allocationRevision.revision) === 1 ? (historical.explanation || null) : null,
    profileId: String(profile._id),
    profile_version: Number(profile.version ?? 1),
    profile_input_hash: recommendation.profileInputHash,
    recommendationId: String(recommendation._id),
    recommendation_id: String(recommendation._id),
    audit_id: historical.audit_id ? String(historical.audit_id) : historical.audit_id,
    audit_hash: historical.audit_hash || null,
    advisory_text: advisoryText,
    advisory_explanation: advisoryExplanation || { status: 'PENDING' },
    computed_weights: buildComputedWeights(instruments),
    portfolio_return_assumption: buildPortfolioReturnAssumption(instruments),
    return_data_class: PROJECTION_ASSUMPTION_DATA_CLASS,
    return_assumption_version: allocationRevision.returnAssumptionVersion || PROJECTION_ASSUMPTION_VERSION,
    return_assumption_source: allocationRevision.returnAssumptionSource || PROJECTION_ASSUMPTION_SOURCE,
    return_assumption_hash: allocationRevision.returnAssumptionHash || null,
    observed_market_fact: false,
    provider_forecast: false,
    asset_class_allocation: buildAssetClassAllocation(instruments),
    dashboard_projection: buildDashboardProjection(profile, instruments),
    current_allocation_source: allocationRevision.source,
    allocation_revision: allocationRevision.revision,
    allocation_revision_id: allocationRevision._id ? String(allocationRevision._id) : null,
    previous_allocation_revision: allocationRevision.previousRevision ?? null,
    previous_allocation_revision_id: allocationRevision.previousAllocationRevisionId
      ? String(allocationRevision.previousAllocationRevisionId)
      : null,
    portfolio_fingerprint: currentFingerprint,
    recommendation_fingerprint: recommendationFingerprint,
    recommendation_policy_version: recommendation.recommendationPolicyVersion,
    regulatory_rule_version: recommendation.regulatoryRuleVersion,
    response_state: 'CURRENT',
    calculation_freshness: freshness,
    state_provenance: provenance,
  };
}
