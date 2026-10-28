import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PILOT_FAMILY_ID = 'catalog_2026_bank_rd';
const pilotFile = new URL('../data/qualificationPilots/bankRecurringDeposit2026-10-28.json', import.meta.url);
const noApprovalFields = [
  'actualRetailBookingConfirmed', 'commercialDisplayAndRedistributionRightsVerified',
  'issuerEntitlementVerified', 'currentLivePublishedRateFeedAvailable',
  'taxClassificationReviewComplete', 'independentSuitabilityReviewComplete',
  'productionRecommendationEligible',
];
const fail = code => { throw new Error('RD_PILOT_' + code); };
const isDate = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + 'T00:00:00Z'))
  && new Date(value + 'T00:00:00Z').toISOString().startsWith(value);
const sourceUrl = (value, allowedHost) => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.hostname === allowedHost && !u.username
      && !u.password && !u.hash && !u.search;
  } catch { return false; }
};
const issuerSpecs = new Map([
  ['State Bank of India', {domain:'sbi.bank.in',min:100}],
  ['HDFC Bank Limited', {domain:'www.hdfc.bank.in',min:500}],
]);
export function validateFirstFamilyResearchPilot(
  raw = JSON.parse(readFileSync(pilotFile, 'utf8')),
  { now = new Date() } = {},
) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || raw.schemaVersion !== 1 || raw.familyId !== PILOT_FAMILY_ID
    || raw.familyName !== 'Bank Recurring Deposit'
    || !isDate(raw.researchReviewedOn) || !Number.isFinite(+now)
    || Date.parse(raw.researchReviewedOn + 'T00:00:00Z') > +now
    || raw.evidenceScope !== 'FIRST_PARTY_PUBLIC_ISSUER_OFFERING_RESEARCH_ONLY'
    || raw.issuerOfferingsIndependentlyIdentified !== 2
    || raw.actualProductsApprovedForRecommendations !== 0
    || raw.actualProductRegistrationPerformed !== false
    || raw.independentProductReviewer !== null
    || raw.investorSuitabilityAuthorized !== false
    || raw.commercialDataEntitlementVerified !== false
    || raw.regulatedAdviceAuthorizationVerified !== false
    || raw.confidentiality !== 'NO_CONFIDENTIAL_APPROVAL_DOCUMENTS_OR_DERIVED_HASHES'
    || raw.insuranceReferenceUrl !== 'https://www.dicgc.org.in/guide-to-deposit-insurance'
    || typeof raw.note !== 'string'
    || !Array.isArray(raw.candidates) || raw.candidates.length !== 2) {
    fail('UNVERIFIED_FAMILY_OR_APPROVAL_CLAIM');
  }
  const issuers = new Set(), researchIds = new Set();
  for (const offer of raw.candidates) {
    const spec = issuerSpecs.get(offer?.issuer);
    if (!spec || issuers.has(offer.issuer) || researchIds.has(offer.researchId)
      || typeof offer.researchId !== 'string'
      || !/^research_[a-z0-9_]{8,80}$/.test(offer.researchId)
      || offer.issuerDomain !== spec.domain
      || typeof offer.offerLabel !== 'string' || !offer.offerLabel.trim()
      || offer.tenorMonths !== 12 || offer.monthlyInstallmentMinimumInr !== spec.min
      || offer.publishedRatePercentPerAnnum !== 6.25
      || !isDate(offer.publishedRateEffectiveFrom)
      || offer.publishedRateEffectiveFrom > raw.researchReviewedOn
      || !sourceUrl(offer.officialProductUrl, spec.domain)
      || !sourceUrl(offer.officialRateUrl, spec.domain)
      || !sourceUrl(offer.officialTermsUrl, spec.domain)
      || typeof offer.rateInterpretation !== 'string'
      || offer.rateInterpretation.length < 30
      || noApprovalFields.some(k => offer[k] !== false)) {
      fail('CANDIDATE_IDENTITY_SOURCE_OR_RIGHTS_UNQUALIFIED');
    }
    issuers.add(offer.issuer);
    researchIds.add(offer.researchId);
  }
  // Booking minimums are distinct from user eligibility or a licensed rate feed.
  // Do not silently reuse a branch/web minimum in another booking channel.
  const expectedChannels = {
    'State Bank of India': [['STANDARD_RD',100]],
    'HDFC Bank Limited': [['STANDARD_RD',500],['SMS_RD',1000]],
  };
  for (const offer of raw.candidates) {
    const expected = expectedChannels[offer.issuer];
    if (!Array.isArray(offer.publishedChannelMinimums)
      || offer.publishedChannelMinimums.length !== expected.length
      || offer.publishedChannelMinimums.some((fact,index) =>
        fact?.channel !== expected[index][0]
        || fact?.monthlyMinimumInr !== expected[index][1]
        || !sourceUrl(fact?.officialUrl,offer.issuerDomain)
        || typeof fact.caveat !== 'string' || fact.caveat.length < 25)
      || offer.publishedChannelMinimums[0].monthlyMinimumInr !== offer.monthlyInstallmentMinimumInr) {
      fail('PUBLIC_BOOKING_CHANNEL_MINIMUM_MISMATCH');
    }
  }

  // The banks' 12-month rates happen to match. Their official 18-month
  // ordinary rates differ; record that difference without granting data
  // distribution, investor-specific availability, or quote status.
  const expectedTenors = {
    'State Bank of India': {rate:6.25,effective:'2025-12-15',basis:'TERM_DEPOSIT_RATE_USED_BY_RD'},
    'HDFC Bank Limited': {rate:6.45,effective:'2025-12-17',basis:'SPECIFIC_RD_RATE_ROW'},
  };
  for (const offer of raw.candidates) {
    const expected = expectedTenors[offer.issuer];
    const extra = offer.additionalOfficialTenorResearch;
    if (!expected || !extra || extra.tenorMonths !== 18
      || extra.ordinaryPublishedRatePercentPerAnnum !== expected.rate
      || extra.issuerRateEffectiveFrom !== expected.effective
      || extra.sourceValueType !== expected.basis
      || extra.officialSourceUrl !== offer.officialRateUrl
      || !sourceUrl(extra.officialSourceUrl,offer.issuerDomain)
      || extra.sourceReviewDate !== raw.researchReviewedOn
      || extra.status !== 'PUBLIC_ISSUER_RESEARCH_ONLY_NOT_LICENSED_MARKET_OBSERVATION'
      || extra.licensedCommercialDisplay !== false
      || extra.bookedCustomerRateConfirmed !== false
      || extra.recommendationEligible !== false) {
      fail('EIGHTEEN_MONTH_RATE_SOURCE_OR_PERMISSION_UNVERIFIED');
    }
  }
  if (raw.commercialSourceAuthorizationSummary !==
    'HDFC_BANK_PUBLIC_WEBSITE_REUSE_RESTRICTED__NO_INDEPENDENT_SIGNED_DATA_GRANT') {
    fail('PUBLIC_WEBSITE_LICENCE_REVIEW_MISSING');
  }
  const websiteTerms = {
    'State Bank of India': {
      url: null,
      result: 'BANK_PUBLIC_RATE_PAGE_HAS_NO_INDEPENDENTLY_VERIFIED_COMMERCIAL_ENTITLEMENT',
    },
    'HDFC Bank Limited': {
      url: 'https://www.hdfc.bank.in/useful-links/website-usage-terms',
      result: 'PUBLIC_TERMS_RESTRICT_COMMERCIAL_REPRODUCTION_STORAGE_AND_REDISTRIBUTION',
    },
  };
  for (const offer of raw.candidates) {
    const expected = websiteTerms[offer.issuer];
    const usage = offer.publicWebsiteLicenseReview;
    if (!expected || !usage || usage.officialTermsUrl !== expected.url
      || usage.result !== expected.result || usage.reviewedOn !== raw.researchReviewedOn
      || usage.independentlyAuthorizedCommercialDataFeed !== false
      || usage.apiAccessIsCommercialDataLicense !== false
      || usage.separateProviderGrantRequired !== true
      || typeof usage.note !== 'string' || usage.note.length < 40) {
      fail('PUBLIC_WEBSITE_LICENCE_REVIEW_MISSING');
    }
  }
  if (issuers.size !== 2) fail('TWO_INDEPENDENT_ISSUERS_REQUIRED');
  const ageDays = (+now - Date.parse(raw.researchReviewedOn + 'T00:00:00Z')) / 86400000;
  return {
    familyId: raw.familyId,
    researchReviewedOn: raw.researchReviewedOn,
    independentlyDocumentedIssuerOfferings: 2,
    approvedActualInvestmentProducts: 0,
    productionEligible: false,
    rightsState: 'NOT_INDEPENDENTLY_VERIFIED',
    researchEvidenceFreshness: ageDays <= 7 ? 'RECENT_SOURCE_REVIEW' : 'RECHECK_REQUIRED',
    status: 'ISSUER_OFFERINGS_RESEARCHED__PRODUCTION_APPROVAL_BLOCKED',
  };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = validateFirstFamilyResearchPilot();
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
