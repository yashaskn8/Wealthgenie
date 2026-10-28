/**
 * Source-backed educational directory: all 250 WealthGenie investment families
 * independent of PostgreSQL, profile, brokerage login or licensed market feeds.
 * This is NOT a product/market-rate/recommendation API.
 */
import { readFileSync } from 'node:fs';
import { investmentDatabase } from '../data/investmentDatabase.js';
import { listExtensionResearch } from './extensionFrameworkAssessment.js';
import { validateFirstFamilyResearchPilot } from '../scripts/validateFirstFamilyResearchPilot.js';

const extensions = JSON.parse(readFileSync(
  new URL('../data/investmentUniverseExtensions2026.json', import.meta.url), 'utf8',
)).entries;

const rdResearch = JSON.parse(readFileSync(
  new URL('../data/qualificationPilots/bankRecurringDeposit2026-10-28.json', import.meta.url), 'utf8',
));
const extensionResearchById = new Map(listExtensionResearch().map(x => [x.id,x]));
const RD_FAMILY_ID = 'catalog_2026_bank_rd';
const RD_HOSTS = Object.freeze({
  'State Bank of India': 'sbi.bank.in',
  'HDFC Bank Limited': 'www.hdfc.bank.in',
});
function readOfficialIssuerReferences() {
  validateFirstFamilyResearchPilot(rdResearch);
  if (rdResearch.familyId !== RD_FAMILY_ID
    || rdResearch.actualProductsApprovedForRecommendations !== 0
    || rdResearch.commercialDataEntitlementVerified !== false
    || rdResearch.investorSuitabilityAuthorized !== false
    || !Array.isArray(rdResearch.candidates) || rdResearch.candidates.length !== 2) {
    throw new Error('FINANCIAL_RD_ISSUER_RESEARCH_MUST_REMAIN_UNAPPROVED');
  }
  const seen = new Set();
  return rdResearch.candidates.map(candidate => {
    const host = RD_HOSTS[candidate.issuer];
    const url = new URL(candidate.officialProductUrl);
    if (!host || seen.has(candidate.issuer) || url.protocol !== 'https:'
      || url.hostname !== host || url.username || url.password || url.hash
      || candidate.productionRecommendationEligible !== false
      || candidate.issuerEntitlementVerified !== false
      || candidate.commercialDisplayAndRedistributionRightsVerified !== false
      || candidate.publicWebsiteLicenseReview?.independentlyAuthorizedCommercialDataFeed !== false
      || candidate.publicWebsiteLicenseReview?.separateProviderGrantRequired !== true) {
      throw new Error('FINANCIAL_RD_RESEARCH_SOURCE_INVALID');
    }
    seen.add(candidate.issuer);
    return Object.freeze({
      issuerName: candidate.issuer,
      officialProductUrl: url.href,
      reviewedOn: rdResearch.researchReviewedOn,
      evidenceStatus: 'PUBLIC_ISSUER_LINK_ONLY_NOT_LICENSED_PRODUCT_DATA',
      providerRightsReview: candidate.publicWebsiteLicenseReview.result,
      providerTermsUrl: candidate.publicWebsiteLicenseReview.officialTermsUrl,
      independentCommercialPermissionVerified: false,
    });
  });
}
const RD_OFFICIAL_ISSUER_REFERENCES = Object.freeze(readOfficialIssuerReferences());

const normalize = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const asText = s => typeof s === 'string' && s.trim() ? s.trim() : null;
const sourceLearningPoints = values => Array.isArray(values)
  ? values.filter(value => typeof value === 'string' && value.trim())
    .map(value => value.trim()).slice(0, 4)
  : [];
function legacyStudyNotes(item) {
  // Unreviewed educational descriptions: NOT actual product facts or advice.
  return {
    provenance: 'UNVERIFIED_LEGACY_EDUCATIONAL_CATALOG',
    possibleBenefits: sourceLearningPoints(item.pros),
    keyTradeoffs: sourceLearningPoints(item.cons),
    goalThemes: sourceLearningPoints(item.goalTags),
  };
}
const httpsUrl = value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash
      ? url.href : null;
  } catch { return null; }
};
const missingFacts = Object.freeze({
  currentPrice: null,
  latestNav: null,
  currentInterestRate: null,
  verifiedMinimumInvestment: null,
  verifiedFees: null,
  personalizedAfterTaxReturn: null,
  marketFactAsOf: null,
});
function buildDirectory() {
  if (investmentDatabase.length !== 155 || extensions.length !== 95) {
    throw new Error('FINANCIAL_EDUCATIONAL_DIRECTORY_COUNT_CHANGED');
  }
  const legacy = investmentDatabase.map(item => ({
    id: item.id, name: item.name, category: item.category,
    subcategory: item.subCategory || null,
    record_kind: 'ARCHETYPE', origin: 'LEGACY_155',
    publicIssuerReferences: [],
    instrumentForm: null,
    description: asText(item.description),
    // The source catalog may contain assumptions, which are NOT market quotes.
    educationalRiskLabel: asText(item.riskLabel),
    educationalRiskBasis: 'UNVERIFIED_LEGACY_CATALOG_REFERENCE',
    studyNotes: legacyStudyNotes(item),
    referenceUrl: null, referenceCheckedAsOf: null,
    productData: { ...missingFacts },
    productAvailability: 'NOT_VERIFIED',
    dataRights: 'NOT_VERIFIED',
    recommendationEligible: false,
  }));
  const expanded = extensions.map(item => ({
    id: item.id, name: item.name, category: item.category,
    subcategory: item.subCategory || null,
    record_kind: 'ARCHETYPE', origin: 'EXTENDED_95',
    publicIssuerReferences: item.id === RD_FAMILY_ID ? RD_OFFICIAL_ISSUER_REFERENCES : [],
    instrumentForm: asText(item.instrumentForm),
    frameworkResearch: (() => {
      const research = extensionResearchById.get(item.id);
      if (!research || research.referenceUrl !== item.sourceUrl
        || research.productRiskScore !== null || research.actualRetailProductEligible !== false
        || research.sourcePermissionVerified !== false) {
        throw new Error('FINANCIAL_95_FRAMEWORK_ITEM_UNQUALIFIED:' + item.id);
      }
      return {
        structuralExposureClass: research.exposureClass,
        specificResearchConcern: research.scenarioDescription,
        standardCapitalReferenceInr: research.standardCapitalReferenceInr,
        standardMinimumHasExceptions: research.thresholdHasAccreditedInvestorExceptions,
        nominalMaturityMonths: research.nominalMaturityMonths,
        nominalMaturityDays: research.nominalMaturityDays,
        evidenceScope: research.verifiedPublicFrameworkFact?.scope ?? 'NOT_VERIFIED',
        actualRiskScore: null,
        issuerTermsVerified: false,
        sourceRightsVerified: false,
        reviewedOfficialFrameworkFact: research.verifiedPublicFrameworkFact
          ? { ...research.verifiedPublicFrameworkFact } : null,
        officialFrameworkVerification: research.publicFrameworkVerification,
      };
    })(),
    description: null, educationalRiskLabel: null,
    educationalRiskBasis: 'NOT_ESTABLISHED',
    studyNotes: {
      provenance: 'REGULATORY_CATEGORY_REFERENCE_ONLY',
      possibleBenefits: [], keyTradeoffs: [], goalThemes: [],
    },
    referenceUrl: httpsUrl(item.sourceUrl),
    referenceCheckedAsOf: item.researchEvidence?.referenceCheckedAsOf ?? null,
    productData: { ...missingFacts },
    productAvailability: 'NOT_VERIFIED',
    dataRights: 'NOT_VERIFIED',
    recommendationEligible: false,
  }));
  const rows = [...legacy, ...expanded];
  const ids = new Set(), names = new Set();
  for (const item of rows) {
    if (typeof item.id !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(item.id)
      || !asText(item.name) || !asText(item.category)
      || ids.has(item.id) || names.has(normalize(item.name))
      || (item.origin === 'EXTENDED_95' && !item.referenceUrl)) {
      throw new Error('FINANCIAL_EDUCATIONAL_DIRECTORY_INVALID_ENTRY:' + item.id);
    }
    ids.add(item.id); names.add(normalize(item.name));
  }
  if (rows.length !== 250) throw new Error('FINANCIAL_EDUCATIONAL_DIRECTORY_MISSING_ENTRIES');
  return rows;
}
const DIRECTORY = Object.freeze(buildDirectory().map(row => Object.freeze(row)));
export function listFinancialDiscoveryDirectory() {
  return {
    status: 'DISCOVERY_ONLY',
    source: 'WEALTHGENIE_CATALOG_155_PLUS_95',
    totalCount: DIRECTORY.length,
    actualProductCount: 0,
    actualProductCountBasis: 'CATALOG_SOURCE_ONLY_NOT_LIVE_DATABASE',
    marketFactsAvailable: false,
    disclaimer: '250 educational investment categories, not 250 verified purchasable products. No current prices, rates, tax outcomes or personalized investment recommendations are established by this catalog.',
    items: DIRECTORY.map(item => ({
      ...item, productData: { ...item.productData },
      frameworkResearch: item.frameworkResearch ? {
        ...item.frameworkResearch,
        reviewedOfficialFrameworkFact: item.frameworkResearch.reviewedOfficialFrameworkFact
          ? { ...item.frameworkResearch.reviewedOfficialFrameworkFact } : null,
      } : null,
      studyNotes: {
        ...item.studyNotes,
        possibleBenefits: [...item.studyNotes.possibleBenefits],
        keyTradeoffs: [...item.studyNotes.keyTradeoffs],
        goalThemes: [...item.studyNotes.goalThemes],
      },
      publicIssuerReferences: item.publicIssuerReferences.map(reference => ({ ...reference })),
    })),
  };
}
