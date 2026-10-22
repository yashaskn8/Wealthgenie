import { investmentDatabase } from '../data/investmentDatabase.js';
import {
  filterEligible, getInstrumentRisk, parseProfile, deriveWeights,
  reconcileRisk, rankInstruments,
} from './RecommendationPipeline.js';

// Never mutate the persisted allocation or silently promote discovery-only
// extensions into the deterministic recommendation policy.
export const RISK_SHORTLIST_POLICY_VERSION = 'profile-eligible-risk-shortlist-2.0.0';
const GROUPS = Object.freeze(['LOW', 'MODERATE', 'AGGRESSIVE']);
const MAX_PER_GROUP = 5;
const supportedIds = new Set(investmentDatabase.map(entry => entry.id));

export function buildRiskShortlist({ profile, instruments }) {
  if (!profile || !Array.isArray(instruments)) {
    throw new TypeError('A current investor profile and saved allocation are required');
  }
  const savedIds = new Set();
  for (const item of instruments) {
    if (typeof item?.id !== 'string' || !supportedIds.has(item.id)) {
      throw new TypeError('The current allocation contains an unsupported catalog identity');
    }
    if (savedIds.has(item.id)) throw new TypeError('Duplicate instrument in saved allocation');
    savedIds.add(item.id);
  }
  if (savedIds.size === 0) throw new TypeError('Current allocation is empty');

  // Reuse the SAME authoritative eligibility, risk capacity, and scoring
  // functions as the existing deterministic RecommendationPipeline.
  const parsed = parseProfile(profile);
  const reconciled = reconcileRisk(profile);
  const weights = deriveWeights(parsed);
  const { eligible, excluded } = filterEligible(
    investmentDatabase, profile, reconciled.final_score,
  );
  const eligibleIds = new Set(eligible.map(entry => entry.id));

  // A stale or otherwise inconsistent recommendation must not generate a
  // plausible-looking Top 5 UI even if individual catalogue items are valid.
  for (const id of savedIds) {
    if (!eligibleIds.has(id)) {
      throw new TypeError('Saved allocation failed current profile suitability');
    }
  }
  const ranked = rankInstruments(eligible, parsed, weights);
  const output = { LOW: [], MODERATE: [], AGGRESSIVE: [] };
  for (const row of ranked) {
    const item = row.instrument;
    const riskScore = getInstrumentRisk(item);
    if (!Number.isFinite(riskScore) || riskScore < 1 || riskScore > 5) continue;
    const group = riskScore <= 2 ? 'LOW' : riskScore === 3 ? 'MODERATE' : 'AGGRESSIVE';
    if (output[group].length >= MAX_PER_GROUP) continue;
    const savedAllocationMember = savedIds.has(item.id);
    output[group].push({
      canonicalParentId: item.id,
      name: item.name,
      riskGroup: group,
      riskScore,
      suitabilityScope: 'PROFILE_ELIGIBLE_PARENT_CATEGORY',
      productSpecificSuitability: 'NOT_ESTABLISHED',
      shortlistSource: savedAllocationMember
        ? 'CURRENT_SAVED_ALLOCATION' : 'ADDITIONAL_PROFILE_ELIGIBLE_CANDIDATE',
      rankScore: row.score,
      scoreFactors: row.factors,
    });
  }
  return {
    groups: output,
    selectedCount: GROUPS.reduce((n, key) => n + output[key].length, 0),
    maxPerGroup: MAX_PER_GROUP,
    notFilledWithUnsuitableInstruments: true,
    qualificationScope: 'PARENT_CATEGORY_ONLY',
    shortlistPolicyVersion: RISK_SHORTLIST_POLICY_VERSION,
    suitabilityLevel: reconciled.final_score,
    savedAllocationCount: savedIds.size,
    eligibleParentCount: eligible.length,
    excludedParentCount: excluded.length,
    discoveryArchetypesRecommendationEligible: false,
    selectionNote: 'Additional candidates share the current deterministic suitability policy but are not members of the saved allocation. Neither kind establishes product-level suitability or post-tax returns.',
  };
}
