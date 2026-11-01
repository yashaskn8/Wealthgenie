import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildTopThreeProductEvidenceQueue } from './generateFinancialTopThreeEvidenceQueue.js';

const INDEX_RESEARCH = JSON.parse(readFileSync(
  new URL('../data/qualificationPilots/issuerIndexFunds2026-11-01.json', import.meta.url), 'utf8',
));
const STATUS = 'RESEARCH_ONLY_NOT_RECOMMENDATIONS';
const TRUSTED_ISSUER_HOSTS = Object.freeze({
  'UTI Mutual Fund': 'www.utimf.com',
  'HDFC Mutual Fund': 'www.hdfcfund.com',
  'ICICI Prudential Mutual Fund': 'www.icicipruamc.com',
  'Bandhan Mutual Fund': 'bandhanmutual.com',
  'quant Mutual Fund': 'quantmutual.com',
});
const fail = code => { throw new Error('FINANCIAL_RESEARCH_' + code); };

export function validateIssuerResearchBatch(batch = INDEX_RESEARCH, queue = buildTopThreeProductEvidenceQueue()) {
  if (!batch || batch.schemaVersion !== 'issuer-index-research-v1'
    || batch.status !== STATUS || batch.basis !== 'FIRST_PARTY_ISSUER_PRODUCT_IDENTITY_RESEARCH'
    || batch.actualProductRowsInserted !== 0 || batch.qualificationsGranted !== 0
    || batch.afterTaxProductReturnsVerified !== false
    || batch.dataRightsIndependentApproval !== false
    || typeof batch.note !== 'string' || batch.note.length < 80
    || !/^\d{4}-\d{2}-\d{2}$/.test(batch.researchDate)
    || !Array.isArray(batch.families) || batch.families.length === 0
    || !Array.isArray(queue) || queue.length !== 750) fail('RESEARCH_OR_QUEUE_INVALID');
  const validFamilies = new Map(queue.map(row => [row.familyId, row.familyName]));
  if (validFamilies.size !== 250) fail('CATALOG_250_REQUIRED');
  const seenFamilies = new Set(), names = new Set(), identities = new Set();
  const candidateByFamily = new Map();
  for (const family of batch.families) {
    if (seenFamilies.has(family.familyId)
      || validFamilies.get(family.familyId) !== family.familyName
      || !['Nifty Next 50 TRI', 'Nifty 100 TRI'].includes(family.benchmark)
      || !Array.isArray(family.researchCandidates)
      || family.researchCandidates.length < 1 || family.researchCandidates.length > 3)
      fail('FAMILY_OR_BENCHMARK_MISMATCH');
    // Only match the two specific known index families. Never assume that two
    // index products within the same category track the same benchmark.
    if ((family.familyId === 'catalog_2026_index_nifty_next50'
        && family.benchmark !== 'Nifty Next 50 TRI')
      || (family.familyId === 'catalog_2026_index_nifty100'
        && family.benchmark !== 'Nifty 100 TRI')
      || !['catalog_2026_index_nifty_next50', 'catalog_2026_index_nifty100']
        .includes(family.familyId)) fail('FAMILY_INDEX_MISMATCH');
    seenFamilies.add(family.familyId);
    const slots = new Set(), issuerSet = new Set();
    for (const candidate of family.researchCandidates) {
      if (!Number.isInteger(candidate.researchSlot) || candidate.researchSlot < 1
        || candidate.researchSlot > 3 || slots.has(candidate.researchSlot)
        || typeof candidate.schemeName !== 'string'
        || candidate.schemeName.length < 8 || candidate.schemeName.length > 160
        || typeof candidate.issuer !== 'string'
        || !Object.hasOwn(TRUSTED_ISSUER_HOSTS, candidate.issuer)
        || issuerSet.has(candidate.issuer)
        || typeof candidate.issuerDomain !== 'string'
        || TRUSTED_ISSUER_HOSTS[candidate.issuer] !== candidate.issuerDomain
        || candidate.publicIssuerIdentityObserved !== true
        || Object.keys(candidate).sort().join(',') !== [
          'issuer', 'issuerDomain', 'officialSourceUrl', 'publicIssuerIdentityObserved',
          'researchSlot', 'schemeName'
        ].sort().join(',')) fail('RESEARCH_CANDIDATE_INVALID');
      let url;
      try { url = new URL(candidate.officialSourceUrl); }
      catch { fail('ISSUER_URL_INVALID'); }
      if (url.protocol !== 'https:' || url.hostname !== candidate.issuerDomain
        || url.username || url.password || url.hash) fail('ISSUER_URL_NOT_AUTHENTICATED');
      const identity = candidate.issuer + '\0' + candidate.schemeName.toLowerCase();
      if (identities.has(identity)) fail('DUPLICATE_SCHEME_IDENTITY');
      const normalized = candidate.schemeName.toLowerCase().replace(/[^a-z0-9]+/g, '');
      if (names.has(family.familyId + '\0' + normalized)) fail('DUPLICATE_SCHEME_NAME');
      // Product identity research requires an exact index family, not merely
      // category-level matching that can substitute an unrelated index.
      const expected = family.familyId.endsWith('nifty100') ? /nifty.?100/i : /nifty.?next.?50/i;
      if (!expected.test(candidate.schemeName)) fail('SCHEME_NOT_IN_FAMILY');
      slots.add(candidate.researchSlot);
      issuerSet.add(candidate.issuer);
      identities.add(identity);
      names.add(family.familyId + '\0' + normalized);
    }
    candidateByFamily.set(family.familyId, family.researchCandidates);
  }
  return { candidateByFamily, researchedFamilyCount: candidateByFamily.size,
    issuerIdentitiesResearched: identities.size };
}

export function buildFinancial250ResearchCoverage({
  queue = buildTopThreeProductEvidenceQueue(), batch = INDEX_RESEARCH
} = {}) {
  const { candidateByFamily, researchedFamilyCount, issuerIdentitiesResearched } =
    validateIssuerResearchBatch(batch, queue);
  const rows = new Map();
  for (const slot of queue) {
    if (!rows.has(slot.familyId)) {
      rows.set(slot.familyId, {
        familyId: slot.familyId,
        familyName: slot.familyName,
        category: slot.category,
        categoryReferenceUrl: slot.categoryEvidenceUrl || null,
        researchOnlyCandidates: [],
        qualifiedProductCount: null, // requires current authenticated DB query
        productionComparisonReady: false,
        status: 'ISSUER_PRODUCT_RESEARCH_NOT_A_PRODUCTION_APPROVAL',
      });
    }
  }
  for (const [familyId, candidates] of candidateByFamily) {
    rows.get(familyId).researchOnlyCandidates = candidates.map(candidate => ({
      schemeName: candidate.schemeName,
      issuer: candidate.issuer,
      issuerSourceUrl: candidate.officialSourceUrl,
      sourceReviewedOn: batch.researchDate,
      eligibleForRecommendation: false,
      hasCommercialDisplayPermission: false,
      marketObservationQualified: false,
      taxOutcomeVerified: false,
    }));
  }
  return {
    status: '250_FAMILIES_INVENTORIED__ISSUER_RESEARCH_NOT_LIVE_APPROVAL',
    basis: 'REPOSITORY_RESEARCH_ONLY_NOT_LIVE_POSTGRES',
    familyCount: rows.size,
    researchSlotCapacity: queue.length,
    researchedFamilyCount, issuerIdentitiesResearched,
    productionQualifiedFamilies: 'NOT_MEASURED',
    verifiedMarketObservations: 'NOT_MEASURED',
    personalizedTopThreeComputed: false,
    afterTaxProductReturnsComputed: false,
    families: [...rows.values()],
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(JSON.stringify(buildFinancial250ResearchCoverage(), null, 2) + '\n');
}
