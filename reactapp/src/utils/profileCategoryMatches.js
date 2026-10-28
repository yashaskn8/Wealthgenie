/**
 * Select category-level educational matches from the authenticated,
 * policy-ranked risk shortlist for the CURRENT financial profile.
 * Does not qualify individual securities, forecast returns or bypass advice gates.
 */
export function selectProfileCategoryMatches(shortlist, profileId, profileVersion) {
  if (!shortlist || shortlist.status !== 'PROFILE_ELIGIBLE_PARENT_CATEGORIES'
    || shortlist.qualificationScope !== 'PARENT_CATEGORY_ONLY'
    || !shortlist.source || typeof profileId !== 'string'
    || !/^[a-fA-F0-9]{24}$/.test(profileId)
    || String(shortlist.source.profileId) !== profileId
    || !Number.isSafeInteger(profileVersion) || profileVersion < 0
    || shortlist.source.profileVersion !== profileVersion
    || !shortlist.groups || typeof shortlist.groups !== 'object'
    || !Number.isSafeInteger(shortlist.selectedCount)
    || shortlist.selectedCount < 0 || shortlist.selectedCount > 15) return [];

  const ranks = [];
  const seen = new Set();
  const groups = ['LOW','MODERATE','AGGRESSIVE'];
  for (const group of groups) {
    const list = shortlist.groups[group];
    if (!Array.isArray(list) || list.length > 5) return [];
    for (const row of list) {
      if (typeof row?.canonicalParentId !== 'string'
        || !/^[a-zA-Z0-9:_-]{1,160}$/.test(row.canonicalParentId)
        || seen.has(row.canonicalParentId)
        || typeof row.name !== 'string' || !row.name.trim()
        || row.riskGroup !== group
        || !Number.isFinite(row.rankScore)
        || !Number.isInteger(row.riskScore)
        || row.riskScore < 1 || row.riskScore > 5
        || row.suitabilityScope !== 'PROFILE_ELIGIBLE_PARENT_CATEGORY'
        || row.productSpecificSuitability !== 'NOT_ESTABLISHED'
        || !['CURRENT_SAVED_ALLOCATION','ADDITIONAL_PROFILE_ELIGIBLE_CANDIDATE']
          .includes(row.shortlistSource)) return [];
      seen.add(row.canonicalParentId);
      ranks.push({
        id:row.canonicalParentId,
        name:row.name,
        rankScore:row.rankScore,
        riskGroup:group,
        source:row.shortlistSource,
      });
    }
  }
  if (ranks.length !== shortlist.selectedCount
    || shortlist.discoveryArchetypesRecommendationEligible !== false) return [];

  // Scores are produced by ONE backend ranking policy, so compare only
  // within that same policy result. Never synthesize local investment scores.
  ranks.sort((a,b)=>b.rankScore-a.rankScore || a.id.localeCompare(b.id));
  return ranks.slice(0,3);
}
