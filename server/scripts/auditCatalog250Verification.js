import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { investmentDatabase } from '../data/investmentDatabase.js';
import { buildTopThreeProductEvidenceQueue, REVIEW_QUEUE_STATUS } from './generateFinancialTopThreeEvidenceQueue.js';

const manifest = JSON.parse(readFileSync(
  new URL('../data/investmentUniverseExtensions2026.json', import.meta.url), 'utf8',
));
const normalizedName = name => name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const validId = id => typeof id === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(id);
const reject = (code, id) => { throw new Error(code + (id ? ':' + id : '')); };
const csv = value => '"' + String(value ?? '').replaceAll('"', '""') + '"';
const evidenceFields = [
  'actualProductId', 'issuerName', 'issuerOfficialDocumentUrl',
  'officialProductTermsUrl', 'riskEvidenceUrl', 'taxEvidenceUrl',
  'providerSourceId', 'providerInstrumentId', 'providerApprovalReference',
  'independentReviewer', 'approvedAt', 'expiresAt',
];
const slotFields = ['familyId', 'familyName', 'category', 'slot',
  'categoryEvidenceUrl', ...evidenceFields, 'status'];

export function buildCatalog250Verification({
  legacy = investmentDatabase,
  extensions = manifest.entries,
  slots = null,
} = {}) {
  if (!Array.isArray(legacy) || legacy.length !== 155
    || !Array.isArray(extensions) || extensions.length !== 95) {
    reject('EXPECTED_155_LEGACY_PLUS_95_EXTENSION_FAMILIES');
  }
  const slotRows = slots ?? buildTopThreeProductEvidenceQueue({legacy, extensions});
  if (!Array.isArray(slotRows) || slotRows.length !== 750) reject('EXPECTED_750_REVIEW_SLOTS');
  const slotMap = new Map();
  for (const slot of slotRows) {
    if (!slot || !validId(slot.familyId) || ![1, 2, 3].includes(slot.slot)
      || Object.keys(slot).length !== slotFields.length
      || slotFields.some(field => !Object.hasOwn(slot, field))
      || evidenceFields.some(field => slot[field] !== '')
      || slot.status !== REVIEW_QUEUE_STATUS) {
      reject('UNAPPROVED_PRODUCT_EVIDENCE_IN_REVIEW_QUEUE', slot?.familyId);
    }
    const arr = slotMap.get(slot.familyId) || [];
    if (arr.some(row => row.slot === slot.slot)) reject('DUPLICATE_REVIEW_SLOT', slot.familyId);
    arr.push(slot);
    slotMap.set(slot.familyId, arr);
  }
  const idSet = new Set(), nameSet = new Set(), families = [];
  for (const [origin, entries] of [['LEGACY_155', legacy], ['EXTENDED_95', extensions]]) {
    for (const e of entries) {
      if (!e || !validId(e.id) || idSet.has(e.id)) reject('INVALID_OR_DUPLICATE_FAMILY_ID', e?.id);
      if (typeof e.name !== 'string' || !normalizedName(e.name)
        || nameSet.has(normalizedName(e.name))) reject('INVALID_OR_DUPLICATE_FAMILY_NAME', e.id);
      if (typeof e.category !== 'string' || !e.category.trim()) reject('MISSING_FAMILY_CATEGORY', e.id);
      const reviewSlots = slotMap.get(e.id);
      if (!reviewSlots || reviewSlots.length !== 3
        || reviewSlots.some(row => row.familyName !== e.name
          || row.category !== e.category
          || row.categoryEvidenceUrl !== (origin === 'EXTENDED_95' ? e.sourceUrl : ''))) {
        reject('FAMILY_REVIEW_SLOTS_NOT_COMPLETE', e.id);
      }
      idSet.add(e.id); nameSet.add(normalizedName(e.name));
      if (origin === 'EXTENDED_95') {
        if (e.recordKind !== 'ARCHETYPE' || e.isActualPurchasableProduct !== false
          || e.recommendationEligible !== false || e.availability !== 'UNVERIFIED'
          || e.verificationScope !== 'REGULATORY_CATEGORY_OR_INDEX_ONLY'
          || e.marketDataStatus !== 'UNAVAILABLE' || e.postTaxStatus !== 'UNAVAILABLE'
          || typeof e.sourceUrl !== 'string' || !/^https:\/\/[^/?#]+/.test(e.sourceUrl)
          || !e.researchEvidence || e.researchEvidence.actualIssuerOrSchemeVerified !== false
          || e.researchEvidence.currentlyOpenForInvestmentVerified !== false
          || e.researchEvidence.investmentTermsVerified !== false
          || e.researchEvidence.legalTaxTreatmentVerified !== false
          || e.researchEvidence.liveMarketDataRightsVerified !== false
          || !e.productIdentity || Object.values(e.productIdentity).some(value => value !== null)
          || !e.dataRights || Object.values(e.dataRights).some(value => value !== false)
          || e.riskAndSuitability?.suitabilityAllowed !== false) {
          reject('EXTENSION_EVIDENCE_CLAIM_INCONSISTENT', e.id);
        }
      }
      // A family reference (including a legacy return assumption) is never
      // an individually approved, priced, licensed security or deposit.
      families.push({
        familyId: e.id,
        name: e.name,
        category: e.category,
        subCategory: e.subCategory || null,
        inventory: origin,
        catalogIdentity: 'VALID_ARCHETYPE_ID',
        identityLevel: origin === 'EXTENDED_95'
          ? 'REGULATORY_CATEGORY_OR_INDEX_ONLY' : 'LEGACY_DISCOVERY_REFERENCE',
        catalogSourceReference: origin === 'EXTENDED_95' ? e.sourceUrl : null,
        actualProductIdentitiesApprovedByThisSource: 0,
        minimumActualQualifiedProductsNeeded: 2,
        topThreeMaximum: 3,
        currentProductionQualifiedProducts: null,
        sourceRightsVerification: 'NOT_ESTABLISHED_BY_SOURCE_INVENTORY',
        productionStatus: 'NOT_VERIFIED_AS_TWO_CURRENT_SUITABLE_ACTUAL_PRODUCTS',
        remainingRequirements: [
          'TWO_DISTINCT_ACTUAL_PRODUCT_IDENTITIES',
          'ISSUER_TERMS_RISK_AND_TAX_EVIDENCE',
          'CURRENT_PROVIDER_AUTHENTICATED_DATA_RIGHTS',
          'FRESH_PUBLISHABLE_MARKET_FACTS',
          'INVESTOR_ELIGIBILITY_AND_ADVICE_AUTHORIZATION',
          'READ_ONLY_LIVE_POSTGRES_AND_PROVIDER_RECHECK',
        ],
      });
    }
  }
  if (families.length !== 250 || slotMap.size !== 250) reject('FAMILY_INVENTORY_NOT_250');
  return {
    status: 'SOURCE_INVENTORY_VERIFIED__PRODUCT_APPROVAL_NOT_ESTABLISHED',
    basis: 'MAIN_BRANCH_SOURCE_FILES_ONLY_NOT_LIVE_PROVIDER_OR_PRODUCTION_DB',
    legacyFamilies: 155,
    extensionFamilies: 95,
    totalFamilies: 250,
    duplicateIds: 0,
    duplicateNames: 0,
    reviewSlotsChecked: 750,
    reviewedProductIdentitySlotsPopulated: 0,
    sourceEstablishedActualProducts: 0,
    productionQualifiedFamilies: 'NOT_MEASURED',
    verifiedForAnySpecificInvestor: false,
    semantics: '250 discovery families are not 250 verified investments; 2 suitable real products per family required.',
    families,
  };
}

export function catalog250VerificationCsv(report = buildCatalog250Verification()) {
  const fields = ['familyId','name','category','subCategory','inventory','catalogIdentity',
    'identityLevel','catalogSourceReference','actualProductIdentitiesApprovedByThisSource',
    'minimumActualQualifiedProductsNeeded','currentProductionQualifiedProducts',
    'sourceRightsVerification','productionStatus','remainingRequirements'];
  return fields.join(',') + '\n' + report.families.map(row =>
    fields.map(k => csv(Array.isArray(row[k]) ? row[k].join(';') : row[k])).join(',')
  ).join('\n') + '\n';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const report = buildCatalog250Verification();
  if (process.argv.length === 3 && process.argv[2] === '--csv') {
    process.stdout.write(catalog250VerificationCsv(report));
  } else if (process.argv.length === 2) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    reject('USE_DEFAULT_OR_CSV_ONLY');
  }
}
