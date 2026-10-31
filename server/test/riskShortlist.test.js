import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRiskShortlist, RISK_SHORTLIST_POLICY_VERSION } from '../services/riskShortlist.js';
import { runPipeline } from '../services/RecommendationPipeline.js';
import { investmentDatabase } from '../data/investmentDatabase.js';
import { canonicalProfile } from './helpers/canonicalProfile.js';
import {screenExtensionResearchForProfile,listExtensionResearch,isOfficialFrameworkReferenceUrl,hasCompleteCategoryRiskAccessResearch,getFrameworkSourcePublisherType} from '../services/extensionFrameworkAssessment.js';

test('Top 5 risk categories use the same eligibility and ranking policy as current recommendations',()=>{
  const profile=canonicalProfile();
  const recommendation=runPipeline(profile);
  const a=buildRiskShortlist({profile,instruments:recommendation.instruments});
  const b=buildRiskShortlist({profile,instruments:recommendation.instruments});
  assert.deepEqual(a,b,'Scores and order must be deterministic for the same profile');
  assert.equal(a.shortlistPolicyVersion,RISK_SHORTLIST_POLICY_VERSION);
  assert.ok(a.selectedCount>0 && a.selectedCount<=15);
  assert.equal(a.maxPerGroup,5);
  assert.equal(a.catalogCoverage.totalCategories,250);
  assert.equal(a.catalogCoverage.modelEvaluatedLegacyCategories,155);
  assert.equal(a.catalogCoverage.extensionCategoriesMissingSuitabilityEvidence,95);
  assert.equal(a.catalogCoverage.legacyProfileEligibleCount+a.catalogCoverage.legacyProfileExcludedCount,155);
  assert.equal(a.catalogCoverage.productApprovedByCatalog,0);
  assert.equal(a.catalogCoverage.assessmentScope,'CATEGORY_SCREENING_NOT_PRODUCT_RECOMMENDATION');
  assert.equal(a.catalogAssessments.length,250);
  assert.equal(new Set(a.catalogAssessments.map(x=>x.id)).size,250);
  assert.equal(a.catalogAssessments.filter(x=>x.source==='EXISTING_155_MODEL').length,155);
  const extra=a.catalogAssessments.filter(x=>x.source==='EXTENDED_95_DISCOVERY');
  assert.equal(extra.length,95);
  assert.ok(extra.every(x=>x.profileAssessment==='MISSING_SUITABILITY_EVIDENCE'
    && x.scoreAvailable===false && x.productQualified===false
    && x.productRiskLevel===null && x.screeningReasonCodes.length>0
    && x.screeningReasonCodes.includes('INDIVIDUAL_PRODUCT_RISK_ELIGIBILITY_NOT_ESTABLISHED')));
  assert.ok(a.catalogAssessments.filter(x=>x.profileAssessment==='PROFILE_EXCLUDED_CATEGORY')
    .every(x=>typeof x.reasonCode==='string' && !x.scoreAvailable));
  assert.ok(a.catalogAssessments.filter(x=>x.profileAssessment==='PROFILE_ELIGIBLE_CATEGORY')
    .every(x=>x.reasonCode===null && x.scoreAvailable));
  assert.equal(a.notFilledWithUnsuitableInstruments,true);
  const parentIds=new Set(investmentDatabase.map(e=>e.id));
  const ids=new Set();
  for(const [group,picks] of Object.entries(a.groups)){
    assert.ok(picks.length<=5,group);
    for(const item of picks){
      assert.ok(parentIds.has(item.canonicalParentId),item.canonicalParentId);
      assert.ok(!item.canonicalParentId.startsWith('catalog_2026_'));
      assert.ok(!ids.has(item.canonicalParentId));
      ids.add(item.canonicalParentId);
      assert.equal(item.productSpecificSuitability,'NOT_ESTABLISHED');
      assert.equal(item.suitabilityScope,'PROFILE_ELIGIBLE_PARENT_CATEGORY');
      assert.ok(item.rankScore>=0 && item.rankScore<=100);
      assert.ok(['CURRENT_SAVED_ALLOCATION','ADDITIONAL_PROFILE_ELIGIBLE_CANDIDATE']
        .includes(item.shortlistSource));
      assert.equal(item.riskGroup,group);
      assert.ok(item.riskScore<=a.suitabilityLevel);
    }
  }
});
test('conservative profile cannot be served moderate/high products solely to fill quotas',()=>{
  const profile=canonicalProfile({riskTolerance:'Conservative'});
  const recommended=runPipeline(profile);
  const shortlist=buildRiskShortlist({profile,instruments:recommended.instruments});
  assert.equal(shortlist.groups.AGGRESSIVE.length,0);
  assert.ok(shortlist.groups.LOW.length<=5);
});
test('mismatched, duplicate, or forged saved allocation fails closed',()=>{
  const profile=canonicalProfile();
  const recommended=runPipeline(profile).instruments;
  assert.throws(()=>buildRiskShortlist({profile,instruments:[{id:'catalog_2026_nps_lc75'}]}),
    /unsupported catalog identity/);
  assert.throws(()=>buildRiskShortlist({profile,instruments:[recommended[0],recommended[0]]}),
    /Duplicate instrument/);
  assert.throws(()=>buildRiskShortlist({profile,instruments:[]}),/empty/);
});

test('research-led 95 individually mapped categories react conservatively to real profile constraints',()=>{
 const rows=listExtensionResearch();
 assert.equal(rows.length,95);
 assert.equal(new Set(rows.map(x=>x.id)).size,95);
 assert.ok(new Set(rows.map(x=>x.exposureClass)).size>=25);
 assert.ok(rows.every(x=>x.productRiskScore===null && x.suitabilityRankingPermitted===false
  && x.marketFactsVerified===false && x.sourcePermissionVerified===false));
 const short=screenExtensionResearchForProfile(canonicalProfile({
   investmentHorizonYears:1,hasLumpSum:true,lumpSumAmount:50000,riskTolerance:'Conservative'
 }));
 const long=screenExtensionResearchForProfile(canonicalProfile({
   investmentHorizonYears:10,hasLumpSum:true,lumpSumAmount:10000000,riskTolerance:'Aggressive'
 }));
 assert.deepEqual(short.map(x=>x.id),long.map(x=>x.id));
 assert.equal(short.length,95);
 const get=(all,id)=>all.find(x=>x.id==='catalog_2026_'+id);
 assert.ok(get(short,'po_td_5').screeningReasonCodes
  .includes('NOMINAL_TENOR_EXCEEDS_PROFILE_HORIZON_REVIEW_WITHDRAWAL_TERMS'));
 assert.ok(!get(long,'po_td_5').screeningReasonCodes
  .includes('NOMINAL_TENOR_EXCEEDS_PROFILE_HORIZON_REVIEW_WITHDRAWAL_TERMS'));
 assert.ok(get(short,'aif1_vc').screeningReasonCodes
  .includes('REPORTED_LUMP_SUM_BELOW_STANDARD_REFERENCE_NOT_PROOF_OF_INELIGIBILITY'));
 assert.ok(!get(long,'aif1_vc').screeningReasonCodes
  .includes('REPORTED_LUMP_SUM_BELOW_STANDARD_REFERENCE_NOT_PROOF_OF_INELIGIBILITY'));
 assert.ok(get(short,'nps_vatsalya').screeningReasonCodes
  .includes('MINOR_BENEFICIARY_AND_GUARDIAN_ELIGIBILITY_UNKNOWN'));
 assert.ok(get(long,'nps_vatsalya').screeningReasonCodes
  .includes('MINOR_BENEFICIARY_AND_GUARDIAN_ELIGIBILITY_UNKNOWN'));
 assert.ok(get(short,'index_nifty100').screeningReasonCodes
  .includes('CONSERVATIVE_PROFILE_REQUIRES_ACTUAL_SCHEME_RISK_REVIEW'));
 assert.ok(!get(long,'index_nifty100').screeningReasonCodes
  .includes('CONSERVATIVE_PROFILE_REQUIRES_ACTUAL_SCHEME_RISK_REVIEW'));
 assert.ok(short.every(x=>x.profileAssessment==='MISSING_SUITABILITY_EVIDENCE'
  && !x.scoreAvailable && !x.productQualified));
});

test('October 2026 framework refresh distinguishes current rules, future PMS rules and non-convertible debt risks',()=>{
 const rows=listExtensionResearch();
 const byId=id=>rows.find(x=>x.id==='catalog_2026_'+id);
 assert.equal(rows.length,95);
 assert.ok(rows.every(x=>x.suitabilityRankingPermitted===false && x.productRiskScore===null
   && x.actualRetailProductEligible===false && x.sourcePermissionVerified===false
   && x.marketFactsVerified===false && x.fiscalYearTaxVerified===false));
 for(const row of rows.filter(x=>x.id.startsWith('catalog_2026_aif'))){
  assert.match(row.referenceUrl,/oct-2026.*alternative-investment-funds/);
  assert.equal(row.referenceReviewedAt,'2026-10-29');
 }
 assert.match(byId('sm_reit_scheme').referenceUrl,/oct-2026.*real-estate-investment-trusts/);
 for(const id of ['pms_discretionary','pms_nondiscretionary']){
  assert.match(byId(id).referenceUrl,/sep-2025.*portfolio-managers/);
  assert.match(byId(id).futureRegulatoryReferenceUrl,/oct-2026.*april-1-2027/);
  assert.equal(byId(id).futureRegulatoryEffectiveFrom,'2027-04-01');
 }
 assert.equal(byId('aif1_social').standardCapitalReferenceInr,null);
 assert.equal(byId('aif1_social').socialImpactNpoSseSpecialThresholdRequiresVerification,true);
 assert.match(byId('ncd_secured').exposureClass,/^SECURED_NCD_/);
 assert.match(byId('ncd_unsecured').exposureClass,/^UNSECURED_NCD_/);
 assert.ok(!byId('ncd_secured').exposureClass.includes('EQUITY_CONVERSION'));
 const profile=canonicalProfile({riskTolerance:'Conservative'});
 const screened=screenExtensionResearchForProfile(profile);
 const get=id=>screened.find(x=>x.id==='catalog_2026_'+id);
 assert.ok(get('aif1_social').screeningReasonCodes.includes('SOCIAL_IMPACT_NPO_SSE_SPECIAL_INVESTOR_MINIMUM_REQUIRES_SCHEME_REVIEW'));
 assert.ok(!get('aif1_social').screeningReasonCodes.includes('REPORTED_LUMP_SUM_BELOW_STANDARD_REFERENCE_NOT_PROOF_OF_INELIGIBILITY'));
 assert.ok(get('ncd_secured').screeningReasonCodes.includes('DEBT_CREDIT_SECURITY_AND_DISCLOSURES_REQUIRE_INSTRUMENT_REVIEW'));
 assert.ok(get('nps_lc25').screeningReasonCodes.includes('NPS_ALLOCATION_EXIT_AND_AGE_RULES_REQUIRE_SCHEME_REVIEW'));
 assert.ok(get('nps_asset_e').screeningReasonCodes.includes('CONSERVATIVE_PROFILE_REQUIRES_PRODUCT_SPECIFIC_RISK_REVIEW'));
 assert.ok(get('index_smallcap250').screeningReasonCodes.includes('CONSERVATIVE_PROFILE_REQUIRES_PRODUCT_SPECIFIC_RISK_REVIEW'));
 assert.ok(screened.every(x=>x.profileAssessment==='MISSING_SUITABILITY_EVIDENCE'
   && x.productQualified===false && x.scoreAvailable===false));
});

test('RBI SGS STRIPS use separate source-backed rules and remain blocked for both profile types',()=>{
 const rows=listExtensionResearch();
 const ids=['sdl_coupon_strip','sdl_principal_strip'];
 const official='https://www.rbi.org.in/Scripts/NotificationUser.aspx?Id=12867&Mode=0';
 for(const id of ids){
  const row=rows.find(x=>x.id==='catalog_2026_'+id);
  assert.ok(row,id);
  assert.equal(row.referenceUrl,official);
  assert.equal(row.referenceReviewedAt,'2026-10-29');
  assert.equal(row.verifiedPublicFrameworkFact.officialSourceUrl,official);
  assert.match(row.verifiedPublicFrameworkFact.factCode,/RBI_SGS_.*_STRIPS_ELIGIBILITY/);
  assert.match(row.verifiedPublicFrameworkFact.value,/14 years/);
  assert.match(row.verifiedPublicFrameworkFact.value,/1,000 crore/);
  assert.match(row.verifiedPublicFrameworkFact.value,/SLR-eligible/);
  assert.match(row.verifiedPublicFrameworkFact.value,/transferability/);
  assert.equal(row.standardCapitalReferenceInr,null,
   'Underlying security outstanding amount is not a retail investor minimum');
  assert.equal(row.actualRetailProductEligible,false);
  assert.equal(row.sourcePermissionVerified,false);
  assert.equal(row.suitabilityRankingPermitted,false);
 }
 const conservative=screenExtensionResearchForProfile(canonicalProfile({riskTolerance:'Conservative'}));
 const aggressive=screenExtensionResearchForProfile(canonicalProfile({riskTolerance:'Aggressive'}));
 for(const id of ids){
  const pick=rows=>rows.find(x=>x.id==='catalog_2026_'+id);
  for(const all of [conservative,aggressive]){
   const item=pick(all);
   assert.ok(item.screeningReasonCodes.includes(
    'SGS_STRIP_SECURITY_ELIGIBILITY_AND_CUSTODIAN_ACCESS_NOT_VERIFIED'));
   assert.equal(item.productQualified,false);
   assert.equal(item.scoreAvailable,false);
   assert.equal(item.productRiskLevel,null);
  }
  assert.ok(pick(conservative).screeningReasonCodes.includes(
   'CONSERVATIVE_PROFILE_REQUIRES_STRIP_MARKET_PRICE_AND_LIQUIDITY_REVIEW'));
  assert.ok(!pick(aggressive).screeningReasonCodes.includes(
   'CONSERVATIVE_PROFILE_REQUIRES_STRIP_MARKET_PRICE_AND_LIQUIDITY_REVIEW'));
 }
});

test('2026 PFRDA NPS exit and Vatsalya source reviews remain non-ranking',()=>{
 const rows=listExtensionResearch();
 const vatsalya=rows.find(x=>x.id==='catalog_2026_nps_vatsalya');
 assert.equal(vatsalya.referenceUrl,'https://pfrda.org.in/en/schemes/national-pension-system/nps-vatsalya');
 assert.equal(vatsalya.referenceReviewedAt,'2026-10-29');
 assert.equal(vatsalya.verifiedPublicFrameworkFact.officialSourceUrl,vatsalya.referenceUrl);
 const screened=screenExtensionResearchForProfile(canonicalProfile({riskTolerance:'Conservative'}));
 const nps=screened.filter(x=>x.id.startsWith('catalog_2026_nps_'));
 assert.equal(nps.length,9);
 for(const x of nps){
   assert.equal(x.productQualified,false);
   assert.equal(x.scoreAvailable,false);
   assert.equal(x.productRiskLevel,null);
   assert.equal(x.profileAssessment,'MISSING_SUITABILITY_EVIDENCE');
 }
 const adult=nps.filter(x=>x.id!=='catalog_2026_nps_vatsalya');
 assert.equal(adult.length,8);
 assert.ok(adult.every(x=>x.screeningReasonCodes.includes(
   'NPS_FIVE_YEAR_MINIMUM_REMOVED_BUT_VESTING_AND_EXIT_RULES_APPLY')));
 const child=nps.find(x=>x.id==='catalog_2026_nps_vatsalya');
 assert.ok(child.screeningReasonCodes.includes(
   'NPS_VATSALYA_MINOR_GUARDIAN_KYC_AND_AGE_18_TRANSITION_REQUIRE_REVIEW'));
 assert.ok(child.screeningReasonCodes.includes(
   'MINOR_BENEFICIARY_AND_GUARDIAN_ELIGIBILITY_UNKNOWN'));
 assert.ok(!child.screeningReasonCodes.includes(
   'NPS_FIVE_YEAR_MINIMUM_REMOVED_BUT_VESTING_AND_EXIT_RULES_APPLY'));
});

test('RBI and DICGC evidence distinguishes both NBFC deposit structures and profile notices without eligibility promotion',()=>{
 const ids=['nbfc_fd_cumulative','nbfc_fd_payout'];
 const research=listExtensionResearch();
 const conservative=screenExtensionResearchForProfile(canonicalProfile({riskTolerance:'Conservative'}));
 const aggressive=screenExtensionResearchForProfile(canonicalProfile({riskTolerance:'Aggressive'}));
 for(const id of ids){
  const key='catalog_2026_'+id;
  const row=research.find(x=>x.id===key);
  assert.equal(row.referenceReviewedAt,'2026-10-29');
  assert.equal(row.referenceUrl,'https://rbi.org.in/scripts/NotificationUser.aspx?Id=10563');
  assert.equal(row.verifiedPublicFrameworkFact.officialSourceUrl,'https://www.dicgc.org.in/guide-to-deposit-insurance');
  assert.match(row.scenarioDescription,/No issuer-specific terms, rates or investor eligibility verified/);
  assert.deepEqual([row.nbfcPublicDepositAccessReview.frameworkMinimumMonths,
    row.nbfcPublicDepositAccessReview.frameworkMaximumMonths],[12,60]);
  for(const field of ['issuerDepositTakingPermissionVerified','issuerCreditRatingVerified',
   'issuerSpecificTermsVerified','individualRetailEligibilityVerified','commercialDataRightsVerified']){
   assert.equal(row.nbfcPublicDepositAccessReview[field],false);
  }
  for(const [screened,isConservative] of [[conservative,true],[aggressive,false]]){
   const item=screened.find(x=>x.id===key);
   for(const code of ['NBFC_PUBLIC_DEPOSITS_NOT_DICGC_INSURED',
    'NBFC_RBI_DEPOSIT_TAKING_PERMISSION_AND_CURRENT_RATING_NOT_VERIFIED',
    'NBFC_TENOR_AND_PREMATURE_REPAYMENT_REQUIRE_ISSUER_TERMS'])
    assert.ok(item.screeningReasonCodes.includes(code),key+':'+code);
   assert.equal(item.screeningReasonCodes.includes(
    'CONSERVATIVE_PROFILE_REQUIRES_NBFC_CREDIT_AND_LIQUIDITY_REVIEW'),isConservative);
   assert.equal(item.profileAssessment,'MISSING_SUITABILITY_EVIDENCE');
   assert.equal(item.productQualified,false);
   assert.equal(item.scoreAvailable,false);
   assert.equal(item.productRiskLevel,null);
  }
 }
 assert.equal(research.filter(x=>x.nbfcPublicDepositAccessReview).length,2);
 assert.equal(research.filter(x=>x.suitabilityRankingPermitted===true).length,0);
});

test('RBI Retail Direct access research stays separate from product eligibility for four categories',()=>{
 const ids=['tbill_91','tbill_182','tbill_364','sdl_dated'];
 const rows=listExtensionResearch();
 const conservative=screenExtensionResearchForProfile(canonicalProfile({riskTolerance:'Conservative'}));
 const aggressive=screenExtensionResearchForProfile(canonicalProfile({riskTolerance:'Aggressive'}));
 for(const id of ids){
  const row=rows.find(x=>x.id==='catalog_2026_'+id),access=row.rbiRetailDirectAccessReview;
  assert.equal(row.referenceReviewedAt,'2026-10-29');
  assert.equal(access.officialRetailDirectFaqUrl,'https://www.rbi.org.in/Scripts/FAQView.aspx?Id=145');
  assert.equal(access.faqPublishedOn,'2021-11-12');
  assert.equal(access.reviewedOn,'2026-10-29');
  assert.equal(access.generalRetailAccessDescribed,true);
  for(const key of ['profileSpecificAccountEligibilityVerified','currentIssueOrQuoteVerified','specificInstrumentTermsVerified','independentCommercialDataPermissionVerified','instrumentSpecificSuitabilityVerified'])assert.equal(access[key],false);
  assert.equal(row.actualRetailProductEligible,false);
  assert.equal(row.sourcePermissionVerified,false);
  assert.equal(row.productRiskScore,null);
  for(const screened of [conservative,aggressive]){
   const item=screened.find(x=>x.id===row.id);
   assert.equal(item.profileAssessment,'MISSING_SUITABILITY_EVIDENCE');
   assert.equal(item.productQualified,false);
   assert.equal(item.scoreAvailable,false);
   assert.ok(item.screeningReasonCodes.includes('RBI_RETAIL_DIRECT_ACCOUNT_KYC_AND_PERSONAL_ELIGIBILITY_UNVERIFIED'));
   assert.ok(item.screeningReasonCodes.includes('GOVERNMENT_SECURITY_CURRENT_ISSUE_PRICE_AND_SOURCE_RIGHTS_UNVERIFIED'));
  }
  assert.ok(conservative.find(x=>x.id===row.id).screeningReasonCodes.includes('CONSERVATIVE_PROFILE_REQUIRES_GOVT_SECURITY_EARLY_SALE_PRICE_AND_LIQUIDITY_REVIEW'));
  assert.ok(!aggressive.find(x=>x.id===row.id).screeningReasonCodes.includes('CONSERVATIVE_PROFILE_REQUIRES_GOVT_SECURITY_EARLY_SALE_PRICE_AND_LIQUIDITY_REVIEW'));
 }
 assert.equal(rows.filter(x=>x.rbiRetailDirectAccessReview).length,4);
 rows.find(x=>x.id==='catalog_2026_tbill_91').rbiRetailDirectAccessReview.currentIssueOrQuoteVerified=true;
 assert.equal(listExtensionResearch().find(x=>x.id==='catalog_2026_tbill_91').rbiRetailDirectAccessReview.currentIssueOrQuoteVerified,false);
});


test('four India Post schemes retain individual eligibility and licensed-rate blockers across profiles',()=>{
 const ids=['po_savings','po_td_2','po_td_3','po_td_5'];
 const research=listExtensionResearch();
 const short=screenExtensionResearchForProfile(canonicalProfile({
   riskTolerance:'Conservative',investmentHorizonYears:1,
 }));
 const long=screenExtensionResearchForProfile(canonicalProfile({
   riskTolerance:'Aggressive',investmentHorizonYears:10,
 }));
 for(const suffix of ids){
  const id='catalog_2026_'+suffix;
  const row=research.find(x=>x.id===id);
  assert.equal(row.referenceReviewedAt,'2026-10-29');
  assert.equal(row.postalSavingsAccessReview.reviewedOn,'2026-10-29');
  assert.equal(row.postalSavingsAccessReview.publicSchemeListingObserved,true);
  assert.equal(row.postalSavingsAccessReview.individualAccountEligibilityAndKycVerified,false);
  assert.equal(row.postalSavingsAccessReview.independentlyAuthorizedCurrentRateVerified,false);
  assert.equal(row.postalSavingsAccessReview.commercialDisplayAndRedistributionRightsVerified,false);
  for(const screened of [short,long]){
   const item=screened.find(x=>x.id===id);
   assert.ok(item.screeningReasonCodes.includes(
    'INDIA_POST_ACCOUNT_KYC_AND_INDIVIDUAL_ELIGIBILITY_UNVERIFIED'));
   assert.ok(item.screeningReasonCodes.includes(
    'INDIA_POST_CURRENT_ACCOUNT_TERMS_RATE_AND_SOURCE_RIGHTS_UNVERIFIED'));
   assert.equal(item.productQualified,false);
   assert.equal(item.scoreAvailable,false);
   assert.equal(item.productRiskLevel,null);
  }
  if(suffix==='po_savings'){
   assert.ok(short.find(x=>x.id===id).screeningReasonCodes.includes(
    'POST_OFFICE_SAVINGS_ACCOUNT_BALANCE_AND_WITHDRAWAL_TERMS_UNVERIFIED'));
  } else {
   assert.ok(short.find(x=>x.id===id).screeningReasonCodes.includes(
    'CONSERVATIVE_PROFILE_REQUIRES_POSTAL_TD_EARLY_EXIT_LIQUIDITY_REVIEW'));
   assert.ok(!long.find(x=>x.id===id).screeningReasonCodes.includes(
    'CONSERVATIVE_PROFILE_REQUIRES_POSTAL_TD_EARLY_EXIT_LIQUIDITY_REVIEW'));
  }
 }
 assert.ok(short.find(x=>x.id==='catalog_2026_po_td_5').screeningReasonCodes.includes(
  'POST_OFFICE_FIVE_YEAR_TD_EARLY_EXIT_CONDITIONS_REQUIRE_SPECIAL_REVIEW'));
 assert.ok(!short.find(x=>x.id==='catalog_2026_po_td_3').screeningReasonCodes.includes(
  'POST_OFFICE_FIVE_YEAR_TD_EARLY_EXIT_CONDITIONS_REQUIRE_SPECIAL_REVIEW'));
 assert.equal(research.filter(x=>x.postalSavingsAccessReview).length,4);
});

test('India Post 2023 amended TD exit rules are tenor-specific and never become account approval',()=>{
 const rows=listExtensionResearch();
 const short=screenExtensionResearchForProfile(canonicalProfile({investmentHorizonYears:3}));
 const long=screenExtensionResearchForProfile(canonicalProfile({investmentHorizonYears:5}));
 const amendmentUrl='https://www.indiapost.gov.in/VAS/DOP_PDFFiles/SB_Orders_2023.pdf';
 for(const [suffix,months,basis] of [
  ['po_td_2',6,'TWO_YEAR_SAVINGS_RATE_BEFORE_ONE_YEAR_THEN_ONE_YEAR_REFERENCE_LESS_TWO_PERCENTAGE_POINTS'],
  ['po_td_3',6,'THREE_YEAR_SAVINGS_RATE_BEFORE_ONE_YEAR_THEN_TWO_YEAR_REFERENCE_LESS_TWO_PERCENTAGE_POINTS'],
  ['po_td_5',48,'FIVE_YEAR_SAVINGS_ACCOUNT_RATE_AFTER_FOUR_YEARS'],
 ]){
  const id='catalog_2026_'+suffix;
  const row=rows.find(x=>x.id===id);
  const review=row.postalSavingsAccessReview.prematureClosure2023AmendmentReview;
  assert.equal(review.officialIndiaPostSbOrders2023Url,amendmentUrl);
  assert.equal(review.officialGazetteNotification,'G.S.R. 830(E)');
  assert.equal(review.gazettePublicationDate,'2023-11-09');
  assert.equal(review.earliestOrdinaryPrematureClosureMonthsUnderAmendedText,months);
  assert.equal(review.earlyClosureInterestRuleUnderAmendedText,basis);
  assert.equal(review.accountOpeningDateAndApplicableRuleVersionVerified,false);
  assert.equal(review.subsequentClarificationsAndCurrentAccountTermsReconciled,false);
  assert.equal(review.individualPrematureClosurePermissionVerified,false);
  assert.equal(review.currentInterestRatesVerified,false);
  assert.ok(row.postalSavingsAccessReview.riskConsiderations.length>=3);
  for(const screened of [short,long]){
   const item=screened.find(x=>x.id===id);
   assert.ok(item.screeningReasonCodes.includes('POSTAL_TD_2023_AMENDMENT_NOT_ACCOUNT_COHORT_OR_CURRENT_EXIT_APPROVAL'));
   assert.equal(item.profileAssessment,'MISSING_SUITABILITY_EVIDENCE');
   assert.equal(item.scoreAvailable,false);
   assert.equal(item.productQualified,false);
   assert.equal(item.productRiskLevel,null);
  }
 }
 const fiveShort=short.find(x=>x.id==='catalog_2026_po_td_5').screeningReasonCodes;
 const fiveLong=long.find(x=>x.id==='catalog_2026_po_td_5').screeningReasonCodes;
 assert.ok(fiveShort.includes('POSTAL_FIVE_YEAR_TD_AMENDED_FOUR_YEAR_EXIT_NOT_GENERAL_SIX_MONTH_ACCESS'));
 assert.ok(fiveShort.includes('RECORDED_HORIZON_BELOW_AMENDED_FIVE_YEAR_TD_FOUR_YEAR_EXIT_WINDOW'));
 assert.ok(!fiveLong.includes('RECORDED_HORIZON_BELOW_AMENDED_FIVE_YEAR_TD_FOUR_YEAR_EXIT_WINDOW'));
 for(const suffix of ['po_td_2','po_td_3']){
  const notices=short.find(x=>x.id==='catalog_2026_'+suffix).screeningReasonCodes;
  assert.ok(notices.includes('POSTAL_TWO_THREE_YEAR_TD_AMENDED_INTEREST_RECALCULATION_REQUIRES_COHORT_CHECK'));
  assert.ok(!notices.includes('POSTAL_FIVE_YEAR_TD_AMENDED_FOUR_YEAR_EXIT_NOT_GENERAL_SIX_MONTH_ACCESS'));
 }
 assert.equal(rows.find(x=>x.id==='catalog_2026_po_savings').postalSavingsAccessReview.prematureClosure2023AmendmentReview,undefined);
});

test('postal time-deposit emergency-fund warning uses only a recorded goal and never qualifies a product',()=>{
 const emergency=screenExtensionResearchForProfile(canonicalProfile({investmentGoals:['Emergency Fund']}));
 const other=screenExtensionResearchForProfile(canonicalProfile({investmentGoals:['Wealth Growth']}));
 const notice='EMERGENCY_FUND_REQUIRES_POSTAL_TD_PREMATURE_CLOSURE_AND_ACCESS_REVIEW';
 for(const suffix of ['po_td_2','po_td_3','po_td_5']) {
  const id='catalog_2026_'+suffix;
  const yes=emergency.find(x=>x.id===id),no=other.find(x=>x.id===id);
  assert.ok(yes.screeningReasonCodes.includes(notice));
  assert.ok(!no.screeningReasonCodes.includes(notice));
  assert.equal(yes.productQualified,false);
  assert.equal(yes.scoreAvailable,false);
  assert.equal(yes.productRiskLevel,null);
 }
 assert.ok(!emergency.find(x=>x.id==='catalog_2026_po_savings').screeningReasonCodes.includes(notice));
});

test('four central-government bond structures keep instrument and profile gates closed',()=>{
 const ids=['gsec_coupon_strip','gsec_principal_strip','sovereign_green','gsec_floating'];
 const types=["CENTRAL_GSEC_COUPON_STRIP","CENTRAL_GSEC_PRINCIPAL_STRIP","SOVEREIGN_GREEN_USE_OF_PROCEEDS_BOND","FLOATING_RATE_CENTRAL_GSEC"];
 const rows=listExtensionResearch();
 const conservative=screenExtensionResearchForProfile(canonicalProfile({riskTolerance:'Conservative'}));
 const aggressive=screenExtensionResearchForProfile(canonicalProfile({riskTolerance:'Aggressive'}));
 for(const [i,suffix] of ids.entries()){
  const id='catalog_2026_'+suffix,row=rows.find(x=>x.id===id),review=row.governmentBondStructureReview;
  assert.equal(row.referenceReviewedAt,'2026-10-29');
  assert.equal(review.structureType,types[i]);
  assert.equal(review.reviewedOn,'2026-10-29');
  assert.equal(row.verifiedPublicFrameworkFact.officialSourceUrl,review.officialStructureSourceUrl);
  assert.equal(review.officialStructureSourceUrl,i===2?'https://dea.gov.in/framework-sovereign-green-bonds':'https://m.rbi.org.in/commonman/english/scripts/FAQs.aspx?Id=711');
  for(const key of ['specificSecurityIsinVerified','specificCouponMaturityAndTermsVerified','retailAccessCustodyAndKycVerified','currentMarketPriceOrYieldVerified','independentCommercialDataRightsVerified','taxAndProductSuitabilityVerified'])assert.equal(review[key],false);
  assert.equal(row.actualRetailProductEligible,false);
  assert.equal(row.sourcePermissionVerified,false);
  assert.equal(row.productRiskScore,null);
  for(const screened of [conservative,aggressive]){
   const item=screened.find(x=>x.id===id);
   assert.ok(item.screeningReasonCodes.includes('GOVT_BOND_ISIN_TERMS_RETAIL_ACCESS_AND_SOURCE_RIGHTS_UNVERIFIED'));
   assert.equal(item.profileAssessment,'MISSING_SUITABILITY_EVIDENCE');
   assert.equal(item.scoreAvailable,false);
   assert.equal(item.productQualified,false);
   assert.equal(item.productRiskLevel,null);
  }
  assert.ok(conservative.find(x=>x.id===id).screeningReasonCodes.includes('CONSERVATIVE_PROFILE_REQUIRES_GOVT_BOND_MARKET_PRICE_AND_LIQUIDITY_REVIEW'));
  assert.ok(!aggressive.find(x=>x.id===id).screeningReasonCodes.includes('CONSERVATIVE_PROFILE_REQUIRES_GOVT_BOND_MARKET_PRICE_AND_LIQUIDITY_REVIEW'));
 }
 for(const suffix of ids.slice(0,2))assert.ok(conservative.find(x=>x.id==='catalog_2026_'+suffix).screeningReasonCodes.includes('GSEC_STRIPS_SECONDARY_MARKET_LIQUIDITY_AND_NO_INTERIM_CASH_FLOW_REVIEW'));
 assert.ok(conservative.find(x=>x.id==='catalog_2026_sovereign_green').screeningReasonCodes.includes('SOVEREIGN_GREEN_USE_OF_PROCEEDS_NOT_INSTRUMENT_OR_IMPACT_APPROVAL'));
 assert.ok(conservative.find(x=>x.id==='catalog_2026_gsec_floating').screeningReasonCodes.includes('FLOATING_RATE_GSEC_RESET_BASIS_SPREAD_AND_DATES_UNVERIFIED'));
 assert.equal(rows.filter(x=>x.governmentBondStructureReview).length,4);
});

test('five bank deposit reviews produce distinct profile-bound non-ranking blockers',()=>{
 const ids=['bank_rd','bank_tax_saver_fd','bank_sweep_fd','bank_fd_monthly','bank_fd_quarterly'];
 const codes=['RECURRING_DEPOSIT_INSTALLMENT_AND_MISSED_PAYMENT_TERMS_UNVERIFIED',
  'TAX_SAVER_FIVE_YEAR_SCHEME_AND_CURRENT_TAX_REGIME_REQUIRE_REVIEW',
  'SWEEP_TRIGGER_PARTIAL_BREAKAGE_AND_LIQUIDITY_TERMS_UNVERIFIED',
  'MONTHLY_DEPOSIT_PAYOUT_AND_EFFECTIVE_RETURN_REQUIRE_ISSUER_TERMS',
  'QUARTERLY_DEPOSIT_PAYOUT_AND_EFFECTIVE_RETURN_REQUIRE_ISSUER_TERMS'];
 const rows=listExtensionResearch();
 const short=screenExtensionResearchForProfile(canonicalProfile({riskTolerance:'Conservative',
  investmentHorizonYears:1,investmentGoals:['Emergency Fund']}));
 const long=screenExtensionResearchForProfile(canonicalProfile({riskTolerance:'Aggressive',
  investmentHorizonYears:10,investmentGoals:['Wealth Growth']}));
 for(const [i,suffix] of ids.entries()){
  const id='catalog_2026_'+suffix,review=rows.find(x=>x.id===id).bankDepositAccessReview;
  assert.equal(review.reviewedOn,'2026-10-29');
  assert.equal(review.officialRbiInterestOnDepositsFaqUrl,'https://www.rbi.org.in/commonman/Upload/English/FAQs/PDFs/FAQIRD01042025.pdf');
  assert.equal(review.officialDicgcCoverageUrl,'https://www.dicgc.org.in/guide-to-deposit-insurance');
  for(const key of ['specificBankDepositIdentityVerified','bankInsuranceStatusAndAggregateBalanceVerified',
   'issuerRatePayoutAndEarlyExitTermsVerified','accountKycAndIndividualEligibilityVerified',
   'currentTaxRegimeAndDeductionEligibilityVerified','independentCommercialDataRightsVerified',
   'personalizedSuitabilityVerified'])assert.equal(review[key],false);
  for(const screened of [short,long]){
   const x=screened.find(x=>x.id===id);
   assert.ok(x.screeningReasonCodes.includes(codes[i]));
   assert.equal(x.productQualified,false);assert.equal(x.scoreAvailable,false);
   assert.equal(x.productRiskLevel,null);
  }
  assert.ok(short.find(x=>x.id===id).screeningReasonCodes.includes(
   'EMERGENCY_FUND_GOAL_REQUIRES_BANK_DEPOSIT_EARLY_ACCESS_REVIEW'));
  assert.ok(!long.find(x=>x.id===id).screeningReasonCodes.includes(
   'EMERGENCY_FUND_GOAL_REQUIRES_BANK_DEPOSIT_EARLY_ACCESS_REVIEW'));
 }
 assert.ok(short.find(x=>x.id==='catalog_2026_bank_tax_saver_fd').screeningReasonCodes.includes(
  'TAX_SAVER_FIVE_YEAR_REFERENCE_EXCEEDS_PROFILE_HORIZON'));
 assert.ok(!long.find(x=>x.id==='catalog_2026_bank_tax_saver_fd').screeningReasonCodes.includes(
  'TAX_SAVER_FIVE_YEAR_REFERENCE_EXCEEDS_PROFILE_HORIZON'));
 assert.equal(rows.filter(x=>x.bankDepositAccessReview).length,5);
});

test('nine SEBI debt-scheme archetypes expose individually researched rules and profile-bound blockers without recommendations',()=>{
 const ids=["gilt_10y_constant","medium_long_duration_mf","long_duration_mf","target_maturity_gsec_index","target_maturity_sdl_index","target_maturity_psu_index","constant_maturity_debt_index","domestic_debt_fof","gsec_debt_etf"];
 const rows=listExtensionResearch();
 const short=screenExtensionResearchForProfile(canonicalProfile({riskTolerance:'Conservative',investmentHorizonYears:1,investmentGoals:['Emergency Fund']}));
 const long=screenExtensionResearchForProfile(canonicalProfile({riskTolerance:'Aggressive',investmentHorizonYears:10,investmentGoals:['Wealth Growth']}));
 const kinds=["GILT_10_YEAR_CONSTANT_DURATION","MEDIUM_TO_LONG_TERM_DEBT_FUND","LONG_TERM_DEBT_FUND","GSEC_TARGET_MATURITY_INDEX_STRATEGY","SDL_TARGET_MATURITY_INDEX_STRATEGY","PSU_BOND_TARGET_MATURITY_INDEX_STRATEGY","CONSTANT_MATURITY_PASSIVE_DEBT_INDEX_STRATEGY","DOMESTIC_DEBT_FUND_OF_FUNDS","GSEC_PASSIVE_DEBT_ETF_STRATEGY"];
 for(const [i,suffix] of ids.entries()){
  const id='catalog_2026_'+suffix,row=rows.find(x=>x.id===id),review=row.sebiDebtSchemeStructureReview;
  assert.equal(row.referenceReviewedAt,'2026-10-29');
  assert.equal(review.schemeArchetype,kinds[i]);
  assert.equal(review.officialSebiCategorizationCircularUrl,'https://www.sebi.gov.in/legal/circulars/feb-2026/categorization-and-rationalization-of-mutual-fund-schemes_99983.html');
  assert.equal(row.verifiedPublicFrameworkFact.officialSourceUrl,review.officialSebiCategorizationCircularUrl);
  assert.ok(review.riskConsiderations.length>=2);
  assert.ok(review.investorAccessConstraints.length>=1);
  for(const key of ['specificSchemeAndAmcVerified','currentSchemeRiskometerVerified','currentNavOrExchangeQuoteVerified',
   'currentSidKimAndExitLoadVerified','investorKycAndRetailAccessVerified','independentCommercialDataRightsVerified',
   'taxTreatmentAndAdviceAuthorizationVerified','individualSuitabilityVerified'])assert.equal(review[key],false);
  for(const group of [short,long]){
   const result=group.find(x=>x.id===id);
   assert.equal(result.profileAssessment,'MISSING_SUITABILITY_EVIDENCE');
   assert.equal(result.productQualified,false);
   assert.equal(result.scoreAvailable,false);
   assert.equal(result.productRiskLevel,null);
   assert.ok(result.screeningReasonCodes.includes('DEBT_FUND_SCHEME_RISKOMETER_NAV_ELIGIBILITY_AND_DATA_RIGHTS_UNVERIFIED'));
  }
  const shorter=short.find(x=>x.id===id).screeningReasonCodes;
  const longer=long.find(x=>x.id===id).screeningReasonCodes;
  assert.ok(shorter.includes('SHORT_HORIZON_REQUIRES_DEBT_SCHEME_REDEMPTION_AND_NAV_REVIEW'));
  assert.ok(shorter.includes('EMERGENCY_FUND_REQUIRES_DEBT_SCHEME_SETTLEMENT_AND_LIQUIDITY_REVIEW'));
  assert.ok(shorter.includes('CONSERVATIVE_PROFILE_REQUIRES_DEBT_SCHEME_RATE_AND_CREDIT_RISK_REVIEW'));
  assert.ok(!longer.includes('SHORT_HORIZON_REQUIRES_DEBT_SCHEME_REDEMPTION_AND_NAV_REVIEW'));
  assert.ok(!longer.includes('EMERGENCY_FUND_REQUIRES_DEBT_SCHEME_SETTLEMENT_AND_LIQUIDITY_REVIEW'));
  assert.ok(!longer.includes('CONSERVATIVE_PROFILE_REQUIRES_DEBT_SCHEME_RATE_AND_CREDIT_RISK_REVIEW'));
 }
 assert.equal(rows.filter(x=>x.sebiDebtSchemeStructureReview).length,9);
 assert.equal(rows.filter(x=>x.suitabilityRankingPermitted).length,0);
 assert.equal(rows.filter(x=>x.productRiskScore!==null).length,0);
 rows.find(x=>x.id==='catalog_2026_gilt_10y_constant').sebiDebtSchemeStructureReview.riskConsiderations.push('tampered');
 assert.equal(listExtensionResearch().find(x=>x.id==='catalog_2026_gilt_10y_constant').sebiDebtSchemeStructureReview.riskConsiderations.length,2);
});

test('five independently sourced broad-market equity indices remain non-ranking under different profile facts',()=>{
 const suffixes=['index_nifty_next50','index_nifty100','index_nifty500','index_midcap150','index_smallcap250'];
 const rows=listExtensionResearch();
 const short=screenExtensionResearchForProfile(canonicalProfile({
  investmentHorizonYears:1,riskTolerance:'Conservative',investmentGoals:['Emergency Fund']
 }));
 const long=screenExtensionResearchForProfile(canonicalProfile({
  investmentHorizonYears:10,riskTolerance:'Aggressive',investmentGoals:['Retirement']
 }));
 for(const suffix of suffixes){
  const id='catalog_2026_'+suffix,row=rows.find(x=>x.id===id);
  assert.equal(row.referenceReviewedAt,'2026-10-29',id);
  assert.match(row.indexBenchmarkReview.officialNseIndexUrl,/^https:\/\/www\.niftyindices\.com\//);
  assert.equal(row.verifiedPublicFrameworkFact.officialSourceUrl,row.indexBenchmarkReview.officialNseIndexUrl);
  assert.equal(row.indexBenchmarkReview.sebiMutualFundRegulationsLastAmendedOn,'2026-10-10');
  assert.ok(row.indexBenchmarkReview.riskConsiderations.length>=2);
  assert.ok(row.indexBenchmarkReview.investorAccessConstraints.length>=2);
  for(const key of ['specificSchemeAndAmcVerified','currentSchemeRiskometerVerified',
   'currentNavOrExchangeQuoteVerified','currentSidKimFeesAndTrackingErrorVerified',
   'investorKycAndRetailAccessVerified','independentCommercialDataRightsVerified',
   'taxTreatmentAndAdviceAuthorizationVerified','individualSuitabilityVerified'])
   assert.equal(row.indexBenchmarkReview[key],false,id+':'+key);
  for(const screened of [short,long]){
   const result=screened.find(x=>x.id===id);
   assert.equal(result.productQualified,false);
   assert.equal(result.scoreAvailable,false);
   assert.equal(result.productRiskLevel,null);
   assert.equal(result.profileAssessment,'MISSING_SUITABILITY_EVIDENCE');
   assert.ok(result.screeningReasonCodes.includes('EQUITY_INDEX_BENCHMARK_NOT_AN_APPROVED_FUND_OR_ETF'));
   assert.ok(result.screeningReasonCodes.includes('INDEX_FUND_SCHEME_RISKOMETER_NAV_TRACKING_COSTS_KYC_AND_SOURCE_RIGHTS_UNVERIFIED'));
  }
  const get=all=>all.find(x=>x.id===id).screeningReasonCodes;
  assert.ok(get(short).includes('SHORT_HORIZON_REQUIRES_EQUITY_INDEX_DRAWDOWN_AND_REDEMPTION_REVIEW'));
  assert.ok(!get(long).includes('SHORT_HORIZON_REQUIRES_EQUITY_INDEX_DRAWDOWN_AND_REDEMPTION_REVIEW'));
  assert.ok(get(short).includes('EMERGENCY_FUND_REQUIRES_EQUITY_INDEX_LIQUIDITY_AND_SETTLEMENT_REVIEW'));
  assert.ok(!get(long).includes('EMERGENCY_FUND_REQUIRES_EQUITY_INDEX_LIQUIDITY_AND_SETTLEMENT_REVIEW'));
  assert.ok(get(short).includes('CONSERVATIVE_PROFILE_REQUIRES_EQUITY_INDEX_LOSS_CAPACITY_REVIEW'));
  assert.ok(!get(long).includes('CONSERVATIVE_PROFILE_REQUIRES_EQUITY_INDEX_LOSS_CAPACITY_REVIEW'));
 }
 assert.equal(rows.filter(x=>x.indexBenchmarkReview).length,11);
});


test('eight PFRDA common NPS choices have source-specific risks and age/horizon notices without approval',()=>{
 const ids=['nps_lc25','nps_lc50','nps_lc75','nps_lc_aggressive',
  'nps_asset_e','nps_asset_c','nps_asset_g','nps_asset_a'];
 const rows=listExtensionResearch();
 const young=screenExtensionResearchForProfile(canonicalProfile({
  age:30,investmentHorizonYears:3,riskTolerance:'Conservative',investmentGoals:['Emergency Fund'],
 }));
 const older=screenExtensionResearchForProfile(canonicalProfile({
  age:65,investmentHorizonYears:3,riskTolerance:'Aggressive',investmentGoals:['Retirement'],
 }));
 const get=(list,s)=>list.find(x=>x.id==='catalog_2026_'+s);
 for(const suffix of ids){
  const row=get(rows,suffix),review=row.npsCommonSchemeReview;
  assert.equal(row.referenceReviewedAt,'2026-10-29');
  assert.equal(review.reviewedOn,'2026-10-29');
  assert.equal(review.individualSuitabilityVerified,false);
  assert.equal(row.actualRetailProductEligible,false);
  assert.equal(row.sourcePermissionVerified,false);
  assert.equal(row.suitabilityRankingPermitted,false);
  assert.equal(row.productRiskScore,null);
  for(const screened of [young,older]){
   const item=get(screened,suffix);
   assert.equal(item.profileAssessment,'MISSING_SUITABILITY_EVIDENCE');
   assert.equal(item.productQualified,false);
   assert.equal(item.scoreAvailable,false);
   assert.equal(item.productRiskLevel,null);
   assert.ok(item.screeningReasonCodes.includes('NPS_COMMON_SCHEME_PENSION_FUND_NAV_KYC_AND_ENTITLEMENTS_UNVERIFIED'));
  }
  assert.ok(get(young,suffix).screeningReasonCodes.includes(
   'NPS_RECORDED_HORIZON_BEFORE_COMMON_SCHEME_NORMAL_EXIT_REVIEW'));
  assert.ok(!get(older,suffix).screeningReasonCodes.includes(
   'NPS_RECORDED_HORIZON_BEFORE_COMMON_SCHEME_NORMAL_EXIT_REVIEW'));
  assert.ok(get(young,suffix).screeningReasonCodes.includes(
   'EMERGENCY_FUND_GOAL_REQUIRES_NPS_TIER_I_WITHDRAWAL_ACCESS_REVIEW'));
  assert.ok(!get(older,suffix).screeningReasonCodes.includes(
   'EMERGENCY_FUND_GOAL_REQUIRES_NPS_TIER_I_WITHDRAWAL_ACCESS_REVIEW'));
 }
 assert.ok(get(young,'nps_lc_aggressive').screeningReasonCodes.includes(
  'NPS_AGGRESSIVE_LIFECYCLE_TAPERS_AFTER_45_NOT_LC75_HIGH'));
 assert.ok(!get(young,'nps_lc75').screeningReasonCodes.includes(
  'NPS_AGGRESSIVE_LIFECYCLE_TAPERS_AFTER_45_NOT_LC75_HIGH'));
 const expected={nps_asset_e:'NPS_CLASS_E_EQUITY_MARKET_LOSS_AND_ALLOCATION_CAP_REVIEW',
  nps_asset_c:'NPS_CLASS_C_CORPORATE_ISSUER_CREDIT_AND_RATE_RISK_REVIEW',
  nps_asset_g:'NPS_CLASS_G_GOVT_BOND_DURATION_AND_NAV_RISK_REVIEW',
  nps_asset_a:'NPS_CLASS_A_ALTERNATIVES_FIVE_PERCENT_CAP_LIQUIDITY_AND_VALUATION_REVIEW'};
 for(const [suffix,reason] of Object.entries(expected))
  assert.ok(get(young,suffix).screeningReasonCodes.includes(reason));
 assert.equal(rows.filter(x=>x.npsCommonSchemeReview).length,8);
 rows.find(x=>x.id==='catalog_2026_nps_asset_a').npsCommonSchemeReview.riskConsiderations.push('tampered');
 assert.ok(!listExtensionResearch().find(x=>x.id==='catalog_2026_nps_asset_a')
  .npsCommonSchemeReview.riskConsiderations.includes('tampered'));
});


test('six sourced NSE factor index archetypes remain non-ranking with profile-dependent review notices',()=>{
 const specs={"catalog_2026_index_nifty50_equal":{"url":"https://www.niftyindices.com/indices/equity/strategy-indices/nifty50-equal-weight","code":"EQUAL_WEIGHT_NIFTY50"},"catalog_2026_index_nifty100_equal":{"url":"https://www.niftyindices.com/indices/equity/strategy-indices/nifty-100-equal-weight","code":"EQUAL_WEIGHT_NIFTY100"},"catalog_2026_index_nifty200_quality":{"url":"https://www.niftyindices.com/indices/equity/strategy-indices/nifty200-quality-30","code":"QUALITY_SCORE_NIFTY200"},"catalog_2026_index_nifty_lowvol":{"url":"https://www.niftyindices.com/indices/equity/strategy-indices/nifty-100-low-volatility","code":"LOW_VOLATILITY_NIFTY100"},"catalog_2026_index_nifty500_momentum":{"url":"https://niftyindices.com/indices/equity/strategy-indices/nifty500-momentum-50","code":"MOMENTUM_NIFTY500"},"catalog_2026_index_nifty500_equal":{"url":"https://www.niftyindices.com/indices/equity/strategy-indices/nifty500-equal-weight","code":"EQUAL_WEIGHT_NIFTY500"}};
 const rows=listExtensionResearch();
 const short=screenExtensionResearchForProfile(canonicalProfile({riskTolerance:'Conservative',investmentHorizonYears:1,investmentGoals:['Emergency Fund']}));
 const long=screenExtensionResearchForProfile(canonicalProfile({riskTolerance:'Aggressive',investmentHorizonYears:10,investmentGoals:['Retirement']}));
 for(const [id,spec] of Object.entries(specs)){
  const row=rows.find(x=>x.id===id),r=row.indexBenchmarkReview;
  assert.equal(row.referenceReviewedAt,'2026-10-29');
  assert.equal(r.officialNseIndexUrl,spec.url);
  assert.equal(row.verifiedPublicFrameworkFact.officialSourceUrl,spec.url);
  assert.equal(r.factorStrategyCode,spec.code);
  assert.ok(r.riskConsiderations.length>=2&&r.investorAccessConstraints.length>=2);
  for(const key of ['specificSchemeAndAmcVerified','currentSchemeRiskometerVerified','currentNavOrExchangeQuoteVerified','currentSidKimFeesAndTrackingErrorVerified','investorKycAndRetailAccessVerified','independentCommercialDataRightsVerified','taxTreatmentAndAdviceAuthorizationVerified','individualSuitabilityVerified'])assert.equal(r[key],false,id+key);
  const s=short.find(x=>x.id===id),l=long.find(x=>x.id===id);
  for(const x of [s,l]){
   assert.equal(x.productQualified,false);
   assert.equal(x.scoreAvailable,false);
   assert.equal(x.productRiskLevel,null);
   assert.ok(x.screeningReasonCodes.includes('FACTOR_INDEX_METHODOLOGY_NOT_SCHEME_RISK_OR_LOSS_PROTECTION'));
   assert.ok(x.screeningReasonCodes.includes('INDEX_FUND_SCHEME_RISKOMETER_NAV_TRACKING_COSTS_KYC_AND_SOURCE_RIGHTS_UNVERIFIED'));
  }
  assert.ok(s.screeningReasonCodes.includes('CONSERVATIVE_PROFILE_REQUIRES_FACTOR_STRATEGY_LOSS_CAPACITY_REVIEW'));
  assert.ok(!l.screeningReasonCodes.includes('CONSERVATIVE_PROFILE_REQUIRES_FACTOR_STRATEGY_LOSS_CAPACITY_REVIEW'));
  assert.ok(s.screeningReasonCodes.includes('SHORT_HORIZON_REQUIRES_EQUITY_INDEX_DRAWDOWN_AND_REDEMPTION_REVIEW'));
  assert.ok(!l.screeningReasonCodes.includes('SHORT_HORIZON_REQUIRES_EQUITY_INDEX_DRAWDOWN_AND_REDEMPTION_REVIEW'));
  const factor=spec.code.startsWith('EQUAL_WEIGHT_')?'EQUAL_WEIGHT_REBALANCING_AND_RELATIVE_SIZE_EXPOSURE_REVIEW':spec.code==='QUALITY_SCORE_NIFTY200'?'QUALITY_FACTOR_ACCOUNTING_METRICS_AND_CONCENTRATION_REVIEW':spec.code==='LOW_VOLATILITY_NIFTY100'?'LOW_VOLATILITY_HISTORICAL_MEASURE_NOT_CAPITAL_PROTECTION':'MOMENTUM_REVERSAL_AND_RECONSTITUTION_TURNOVER_REVIEW';
  assert.ok(s.screeningReasonCodes.includes(factor));
 }
 assert.equal(rows.filter(x=>x.indexBenchmarkReview).length,11);
});


test('five individually reviewed ETF benchmarks remain unqualified with fact-based profile screening',()=>{
 const urls={"catalog_2026_etf_nifty100":"https://www.niftyindices.com/indices/equity/broad-based-indices/nifty-100","catalog_2026_etf_nifty500":"https://www.niftyindices.com/indices/equity/broad-based-indices/nifty-500","catalog_2026_etf_smallcap250":"https://www.niftyindices.com/indices/equity/broad-based-indices/niftysmallcap250","catalog_2026_etf_nifty50_equal":"https://www.niftyindices.com/indices/equity/strategy-indices/nifty50-equal-weight","catalog_2026_etf_nifty100_equal":"https://www.niftyindices.com/indices/equity/strategy-indices/nifty-100-equal-weight"};
 const rows=listExtensionResearch();
 const conservative=screenExtensionResearchForProfile(canonicalProfile({riskTolerance:'Conservative',investmentHorizonYears:1,investmentGoals:['Emergency Fund']}));
 const aggressive=screenExtensionResearchForProfile(canonicalProfile({riskTolerance:'Aggressive',investmentHorizonYears:10,investmentGoals:['Retirement']}));
 assert.equal(rows.filter(x=>x.etfBenchmarkReview).length,10);
 for(const [id,url] of Object.entries(urls)){
  const row=rows.find(x=>x.id===id),review=row.etfBenchmarkReview;
  assert.equal(row.referenceReviewedAt,'2026-10-29');
  assert.equal(review.officialNseIndexUrl,url);
  assert.equal(row.verifiedPublicFrameworkFact.officialSourceUrl,url);
  assert.equal(review.officialSebiEtfInvestorEducationUrl,'https://investor.sebi.gov.in/exchange_traded_fund.html');
  assert.ok(review.riskConsiderations.length>=2&&review.investorAccessConstraints.length>=2);
  for(const key of ['specificListedEtfAndAmcVerified','exchangeTickerAndIsinVerified',
   'currentSchemeRiskometerVerified','currentNavInavAndExchangeQuoteVerified',
   'currentSidKimFeesTrackingAndLiquidityVerified','brokerDematKycAndRetailAccessVerified',
   'independentCommercialDataRightsVerified','taxTreatmentAndAdviceAuthorizationVerified',
   'individualSuitabilityVerified'])assert.equal(review[key],false,id+':'+key);
  const short=conservative.find(x=>x.id===id),long=aggressive.find(x=>x.id===id);
  for(const result of [short,long]){
   assert.equal(result.productQualified,false);
   assert.equal(result.scoreAvailable,false);
   assert.equal(result.productRiskLevel,null);
   assert.equal(result.profileAssessment,'MISSING_SUITABILITY_EVIDENCE');
   assert.ok(result.screeningReasonCodes.includes('ETF_INDEX_BENCHMARK_NOT_VERIFIED_AS_A_LISTED_PRODUCT'));
   assert.ok(result.screeningReasonCodes.includes('ETF_EXCHANGE_SPREAD_PREMIUM_DISCOUNT_TRACKING_AND_SETTLEMENT_REVIEW'));
  }
  for(const code of ['SHORT_HORIZON_REQUIRES_ETF_EQUITY_DRAWDOWN_AND_EXIT_PRICE_REVIEW',
   'EMERGENCY_FUND_REQUIRES_ETF_TRADING_AND_SETTLEMENT_LIQUIDITY_REVIEW',
   'CONSERVATIVE_PROFILE_REQUIRES_ETF_EQUITY_LOSS_AND_SPREAD_CAPACITY_REVIEW']){
   assert.ok(short.screeningReasonCodes.includes(code));
   assert.ok(!long.screeningReasonCodes.includes(code));
  }
 }
 assert.ok(conservative.find(x=>x.id==='catalog_2026_etf_smallcap250').screeningReasonCodes
  .includes('SMALLCAP_ETF_UNDERLYING_LIQUIDITY_AND_MARKET_DEPTH_REVIEW'));
 assert.ok(conservative.find(x=>x.id==='catalog_2026_etf_nifty100_equal').screeningReasonCodes
  .includes('EQUAL_WEIGHT_ETF_REBALANCING_AND_RELATIVE_SIZE_EXPOSURE_REVIEW'));
 rows.find(x=>x.id==='catalog_2026_etf_nifty100').etfBenchmarkReview.riskConsiderations.push('forged');
 assert.ok(!listExtensionResearch().find(x=>x.id==='catalog_2026_etf_nifty100').etfBenchmarkReview.riskConsiderations.includes('forged'));
});


test('five additional ETF factor and thematic categories remain unqualified with profile-dependent notices',()=>{
 const specs={"catalog_2026_etf_nifty200_quality":{"url":"https://www.niftyindices.com/indices/equity/strategy-indices/nifty200-quality-30","code":"QUALITY_FACTOR_NIFTY200"},"catalog_2026_etf_nifty500_lowvol":{"url":"https://www.niftyindices.com/indices/equity/strategy-indices/nifty500-low-volatility-50","code":"LOW_VOLATILITY_FACTOR_NIFTY500"},"catalog_2026_etf_nifty500_momentum":{"url":"https://niftyindices.com/indices/equity/strategy-indices/nifty500-momentum-50","code":"MOMENTUM_FACTOR_NIFTY500"},"catalog_2026_etf_india_defence":{"url":"https://www.niftyindices.com/indices/equity/thematic-indices/nifty-india-defence","code":"DEFENCE_THEME"},"catalog_2026_etf_india_consumption":{"url":"https://www.niftyindices.com/indices/equity/thematic-indices/nifty-india-consumption","code":"DOMESTIC_CONSUMPTION_THEME"}};
 const reasonCodes={QUALITY_FACTOR_NIFTY200:'ETF_QUALITY_ACCOUNTING_FACTOR_AND_30_STOCK_CONCENTRATION_REVIEW',LOW_VOLATILITY_FACTOR_NIFTY500:'ETF_HISTORICAL_LOW_VOLATILITY_IS_NOT_DOWNSIDE_PROTECTION',MOMENTUM_FACTOR_NIFTY500:'ETF_MOMENTUM_REVERSAL_AND_RECONSTITUTION_TURNOVER_REVIEW',DEFENCE_THEME:'ETF_DEFENCE_THEME_CONTRACT_POLICY_AND_SECTOR_CONCENTRATION_REVIEW',DOMESTIC_CONSUMPTION_THEME:'ETF_CONSUMPTION_THEME_DOMESTIC_DEMAND_AND_SECTOR_EXPOSURE_REVIEW'};
 const rows=listExtensionResearch();
 const short=screenExtensionResearchForProfile(canonicalProfile({riskTolerance:'Conservative',investmentHorizonYears:1,investmentGoals:['Emergency Fund']}));
 const long=screenExtensionResearchForProfile(canonicalProfile({riskTolerance:'Aggressive',investmentHorizonYears:10,investmentGoals:['Retirement']}));
 assert.equal(rows.filter(x=>x.etfBenchmarkReview).length,10);
 for(const [id,spec] of Object.entries(specs)){
  const r=rows.find(x=>x.id===id).etfBenchmarkReview;
  assert.equal(r.officialNseIndexUrl,spec.url);assert.equal(r.factorOrThemeCode,spec.code);
  assert.equal(r.reviewedOn,'2026-10-29');
  assert.ok(r.riskConsiderations.length>=2&&r.investorAccessConstraints.length>=2);
  for(const k of ['specificListedEtfAndAmcVerified','exchangeTickerAndIsinVerified','currentSchemeRiskometerVerified','currentNavInavAndExchangeQuoteVerified','currentSidKimFeesTrackingAndLiquidityVerified','brokerDematKycAndRetailAccessVerified','independentCommercialDataRightsVerified','taxTreatmentAndAdviceAuthorizationVerified','individualSuitabilityVerified'])assert.equal(r[k],false,id+':'+k);
  const a=short.find(x=>x.id===id),b=long.find(x=>x.id===id);
  for(const item of [a,b]){
   assert.equal(item.productQualified,false);assert.equal(item.scoreAvailable,false);assert.equal(item.productRiskLevel,null);
   assert.equal(item.profileAssessment,'MISSING_SUITABILITY_EVIDENCE');
   assert.ok(item.screeningReasonCodes.includes(reasonCodes[spec.code]));
   assert.ok(item.screeningReasonCodes.includes('ETF_TICKER_ISIN_RISKOMETER_NAV_INAV_KYC_AND_DATA_RIGHTS_UNVERIFIED'));
  }
  for(const flag of ['SHORT_HORIZON_REQUIRES_ETF_EQUITY_DRAWDOWN_AND_EXIT_PRICE_REVIEW','EMERGENCY_FUND_REQUIRES_ETF_TRADING_AND_SETTLEMENT_LIQUIDITY_REVIEW','CONSERVATIVE_PROFILE_REQUIRES_FACTOR_OR_THEME_ETF_LOSS_CAPACITY_REVIEW']){
   assert.ok(a.screeningReasonCodes.includes(flag));assert.ok(!b.screeningReasonCodes.includes(flag));
  }
 }
});

test('all 28 reviewed fund, thematic, debt, metal and individual categories stay unqualified with profile-bound flags',()=>{
 const keys=['fundOfFundsCategoryReview','thematicIndexReview','debtInstrumentReview',
   'individualCategoryReview','preciousMetalsCategoryReview'];
 const rows=listExtensionResearch().filter(row=>keys.some(key=>row[key]));
 assert.equal(rows.length,28);
 const short=screenExtensionResearchForProfile(canonicalProfile({
   riskTolerance:'Conservative',investmentHorizonYears:1,investmentGoals:['Emergency Fund'],
 }));
 const long=screenExtensionResearchForProfile(canonicalProfile({
   riskTolerance:'Aggressive',investmentHorizonYears:10,investmentGoals:['Retirement'],
 }));
 for(const row of rows){
   assert.match(row.referenceReviewedAt,/^\d{4}-\d{2}-\d{2}$/,row.id);
   assert.ok(row.referenceReviewedAt >= (row.id==='catalog_2026_silver_fof'?'2026-10-30':'2026-10-29')
     && row.referenceReviewedAt<=new Date().toISOString().slice(0,10),row.id);
   assert.equal(row.productRiskScore,null,row.id);
   assert.equal(row.actualRetailProductEligible,false,row.id);
   assert.equal(row.sourcePermissionVerified,false,row.id);
   assert.equal(row.marketFactsVerified,false,row.id);
   assert.equal(row.suitabilityRankingPermitted,false,row.id);
   const categoryReview=keys.map(key=>row[key]).find(Boolean);
   assert.ok(categoryReview.officialSourceUrl.startsWith('https://'),row.id);
   assert.ok(categoryReview.categoryRisks,row.id);
   assert.ok(categoryReview.investorAccessAndEligibility,row.id);
   for(const item of [short.find(item=>item.id===row.id),long.find(item=>item.id===row.id)]){
     assert.ok(item,row.id);
     assert.equal(item.productQualified,false,row.id);
     assert.equal(item.scoreAvailable,false,row.id);
     assert.equal(item.productRiskLevel,null,row.id);
     assert.equal(item.profileAssessment,'MISSING_SUITABILITY_EVIDENCE',row.id);
     assert.ok(item.screeningReasonCodes.includes('REVIEWED_CATEGORY_STRUCTURE_NOT_VERIFIED_INVESTABLE_PRODUCT'),row.id);
     assert.ok(item.screeningReasonCodes.includes('ACTUAL_ISSUER_TERMS_ACCESS_AND_LIQUIDITY_UNVERIFIED'),row.id);
   }
   const a=short.find(item=>item.id===row.id);
   const b=long.find(item=>item.id===row.id);
   for(const code of [
     'EMERGENCY_FUND_GOAL_REQUIRES_REVIEWED_CATEGORY_REDEMPTION_AND_LOSS_CHECK',
     'CONSERVATIVE_PROFILE_REQUIRES_REVIEWED_CATEGORY_LOSS_AND_LIQUIDITY_CHECK',
     'SHORT_HORIZON_REQUIRES_REVIEWED_CATEGORY_EXIT_AND_LOSS_CHECK',
   ]){
     assert.ok(a.screeningReasonCodes.includes(code),row.id+':'+code);
     assert.ok(!b.screeningReasonCodes.includes(code),row.id+':'+code);
   }
 }
});


test('October 2026 SEBI debt credit meters are future issue disclosures, not category risk scores',()=>{
 const ids=["catalog_2026_ncd_secured","catalog_2026_ncd_unsecured","catalog_2026_ncd_unlisted","catalog_2026_bond_subordinated","catalog_2026_bond_perpetual","catalog_2026_bond_corporate_floating","catalog_2026_bond_corporate_zero","catalog_2026_bond_convertible","catalog_2026_psu_bond_taxable","catalog_2026_infra_corporate_bond","catalog_2026_commercial_paper"];
 const rows=listExtensionResearch();
 const conservative=screenExtensionResearchForProfile(canonicalProfile({
   riskTolerance:'Conservative',investmentHorizonYears:1,investmentGoals:['Emergency Fund'],
 }));
 const aggressive=screenExtensionResearchForProfile(canonicalProfile({
   riskTolerance:'Aggressive',investmentHorizonYears:10,investmentGoals:['Retirement'],
 }));
 assert.equal(rows.filter(row=>row.debtInstrumentReview?.creditRiskometerOct2026Review).length,11);
 for(const id of ids){
   const row=rows.find(row=>row.id===id);
   const review=row.debtInstrumentReview.creditRiskometerOct2026Review;
   assert.equal(review.officialSebiCircularUrl,'https://www.sebi.gov.in/legal/circulars/oct-2026/introduction-of-credit-risk-o-meter-as-an-additional-disclosure-mechanism-for-debt-securities_105081.html',id);
   assert.match(row.referenceReviewedAt,/^\d{4}-\d{2}-\d{2}$/,id);
   assert.ok(row.referenceReviewedAt>='2026-10-29'
     &&row.referenceReviewedAt<=new Date().toISOString().slice(0,10),id);
  assert.equal(row.debtInstrumentReview.reviewedOn,'2026-10-29',id);
  assert.equal(review.reviewedOn,'2026-10-29',id);
  assert.equal(review.circularIssuedOn,'2026-10-07',id);
   assert.equal(review.effectiveFrom,'2026-11-21',id);
   assert.equal(review.effectiveAtReviewDate,false,id);
   assert.equal(review.multipleCraRatingsUseLowestRating,true,id);
   assert.equal(review.creditMeterIsMutualFundSchemeRiskometer,false,id);
   assert.equal(review.creditMeterCoversMarketLiquidityAndStructuralRisks,false,id);
   for(const key of ['issuerAndIsinVerified','specificListingStatusVerified',
     'currentSebiRegisteredCraRatingVerified','actualIssueCreditRiskometerVerified',
     'commercialRatingAndMeterReuseRightsVerified','individualRetailAccessVerified',
     'adviceAuthorizationVerified'])assert.equal(review[key],false,id+':'+key);
   assert.ok(review.riskConsiderations.length>=2&&review.investorAccessConstraints.length>=2,id);
   const conditional=!['catalog_2026_ncd_unlisted','catalog_2026_bond_convertible'].includes(id);
   assert.equal(review.categoryApplicability,conditional?'ONLY_IF_LISTED_OR_PROPOSED_TO_BE_LISTED'
     :id==='catalog_2026_ncd_unlisted'?'UNLISTED_CATEGORY_NOT_AUTOMATICALLY_COVERED'
     :'CONVERTIBLE_SECURITY_OUTSIDE_ASSUMED_NCS_SCOPE',id);
   const a=conservative.find(row=>row.id===id),b=aggressive.find(row=>row.id===id);
   for(const item of [a,b]){
     assert.equal(item.productQualified,false,id);
     assert.equal(item.scoreAvailable,false,id);
     assert.equal(item.productRiskLevel,null,id);
     assert.equal(item.profileAssessment,'MISSING_SUITABILITY_EVIDENCE',id);
     for(const code of ['SEBI_DEBT_CREDIT_METER_EFFECTIVE_DATE_AND_ISSUE_EVIDENCE_REVIEW',
       'DEBT_CREDIT_METER_NOT_SCHEME_RISKOMETER_OR_MARKET_LIQUIDITY_ASSESSMENT',
       conditional?'LISTED_DEBT_ISSUER_ISIN_CRA_RATING_AND_METER_UNVERIFIED'
         :'DEBT_CREDIT_METER_INSTRUMENT_AND_LISTING_SCOPE_NOT_PRESUMED'])
       assert.ok(item.screeningReasonCodes.includes(code),id+':'+code);
   }
   assert.ok(a.screeningReasonCodes.includes('CONSERVATIVE_PROFILE_REQUIRES_DEBT_DEFAULT_AND_NONCREDIT_LOSS_REVIEW'),id);
   assert.ok(!b.screeningReasonCodes.includes('CONSERVATIVE_PROFILE_REQUIRES_DEBT_DEFAULT_AND_NONCREDIT_LOSS_REVIEW'),id);
   if(id==='catalog_2026_bond_perpetual')
     assert.ok(a.screeningReasonCodes.includes('PERPETUAL_BOND_CREDIT_METER_DOES_NOT_CAPTURE_AT1_STRUCTURAL_LOSS'));
 }
});

test('NPS Vatsalya 2026 PFRDA facts produce only profile-supported, non-ranking cautions',()=>{
 const row=listExtensionResearch().find(x=>x.id==='catalog_2026_nps_vatsalya');
 const review=row.npsVatsalyaAccessReview;
 assert.equal(review.reviewedOn,'2026-10-29');
 assert.equal(review.minimumInitialContributionInr,250);
 assert.equal(review.partialWithdrawalLockInYears,3);
 assert.equal(review.partialWithdrawalMaximumPctOfOwnContributions,25);
 assert.equal(review.marketLinkedReturnsNotGuaranteed,true);
 const short=screenExtensionResearchForProfile(canonicalProfile({
   riskTolerance:'Conservative',investmentHorizonYears:1,investmentGoals:['Emergency Fund'],
 })).find(x=>x.id===row.id);
 const long=screenExtensionResearchForProfile(canonicalProfile({
   riskTolerance:'Aggressive',investmentHorizonYears:10,investmentGoals:['Retirement'],
 })).find(x=>x.id===row.id);
 for(const item of [short,long]){
   assert.equal(item.productQualified,false);
   assert.equal(item.scoreAvailable,false);
   assert.equal(item.productRiskLevel,null);
   assert.equal(item.profileAssessment,'MISSING_SUITABILITY_EVIDENCE');
   for(const code of ['NPS_VATSALYA_MINOR_GUARDIAN_KYC_AND_AGE_18_TRANSITION_REQUIRE_REVIEW',
     'NPS_VATSALYA_PFRDA_2026_THREE_YEAR_RESTRICTED_WITHDRAWAL_AND_FRESH_KYC_REVIEW',
     'NPS_VATSALYA_SPECIFIC_PENSION_FUND_NAV_FEES_AND_MARKET_RISK_UNVERIFIED'])
     assert.ok(item.screeningReasonCodes.includes(code),code);
 }
 for(const code of ['EMERGENCY_FUND_REQUIRES_NPS_VATSALYA_RESTRICTED_WITHDRAWAL_REVIEW',
   'SHORT_HORIZON_BELOW_NPS_VATSALYA_PARTIAL_WITHDRAWAL_LOCK_IN',
   'CONSERVATIVE_PROFILE_REQUIRES_NPS_VATSALYA_MARKET_LOSS_CAPACITY_REVIEW']){
   assert.ok(short.screeningReasonCodes.includes(code),code);
   assert.ok(!long.screeningReasonCodes.includes(code),code);
 }
});

test('PFRDA April 2026 multiple-NAV fee variants remain unverified for all nine NPS categories',()=>{
 const rows=listExtensionResearch().filter(x=>x.id.startsWith('catalog_2026_nps_'));
 assert.equal(rows.length,9);
 for(const row of rows){
  const review=row.npsCommonSchemeReview||row.npsVatsalyaAccessReview;
  const nav=review.multipleNavFrameworkReview;
  assert.equal(nav.officialPfrdaNoticeUrl,'https://www.pfrda.org.in/w/implementation-of-multiple-navs-framework-w.e.f.-01st-april-2026');
  assert.equal(nav.noticeIssuedOn,'2026-03-24');
  assert.equal(nav.effectiveFrom,'2026-04-01');
  assert.equal(nav.subscriberSectorAndChannelVerified,false);
  assert.equal(nav.specificPensionFundNavVariantVerified,false);
  assert.equal(nav.applicableFeesAndUnitsVerified,false);
  assert.equal(nav.commercialNavReuseRightsVerified,false);
  assert.equal(row.productRiskScore,null);
  assert.equal(row.actualRetailProductEligible,false);
 }
 const short=screenExtensionResearchForProfile(canonicalProfile({
  investmentHorizonYears:2,investmentGoals:['Tax Saving'],
 }));
 const long=screenExtensionResearchForProfile(canonicalProfile({
  investmentHorizonYears:10,investmentGoals:['Wealth Growth'],
 }));
 for(const row of rows){
  const a=short.find(x=>x.id===row.id),b=long.find(x=>x.id===row.id);
  for(const result of [a,b]){
   assert.ok(result.screeningReasonCodes.includes(
    'NPS_MULTIPLE_NAV_FEE_SECTOR_AND_CHANNEL_NOT_INDIVIDUALLY_VERIFIED'));
   assert.equal(result.profileAssessment,'MISSING_SUITABILITY_EVIDENCE');
   assert.equal(result.productQualified,false);
   assert.equal(result.scoreAvailable,false);
  }
  assert.ok(a.screeningReasonCodes.includes(
   'SHORT_HORIZON_REQUIRES_NPS_APPLICABLE_NAV_FEES_AND_EXIT_VALUE_REVIEW'));
  assert.ok(!b.screeningReasonCodes.includes(
   'SHORT_HORIZON_REQUIRES_NPS_APPLICABLE_NAV_FEES_AND_EXIT_VALUE_REVIEW'));
  const taxCode=row.id==='catalog_2026_nps_vatsalya'
   ? 'TAX_SAVING_GOAL_REQUIRES_NPS_VATSALYA_FY_AND_GUARDIAN_TAX_RULE_REVIEW'
   : 'TAX_SAVING_GOAL_REQUIRES_NPS_TIER_AND_CURRENT_FY_TAX_REGIME_REVIEW';
  assert.ok(a.screeningReasonCodes.includes(taxCode));
  assert.ok(!b.screeningReasonCodes.includes(taxCode));
 }
});

test('RBI Retail Direct emergency-fund screening flags secondary-sale uncertainty without ranking',()=>{
 const emergency=screenExtensionResearchForProfile(canonicalProfile({
  investmentGoals:['Emergency Fund'],investmentHorizonYears:1,
 }));
 const long=screenExtensionResearchForProfile(canonicalProfile({
  investmentGoals:['Wealth Growth'],investmentHorizonYears:10,
 }));
 for(const id of ['tbill_91','tbill_182','tbill_364','sdl_dated']){
  const key='catalog_2026_'+id;
  const a=emergency.find(x=>x.id===key),b=long.find(x=>x.id===key);
  assert.ok(a.screeningReasonCodes.includes(
   'EMERGENCY_FUND_REQUIRES_RETAIL_DIRECT_EARLY_SALE_PRICE_AND_LIQUIDITY_REVIEW'));
  assert.ok(!b.screeningReasonCodes.includes(
   'EMERGENCY_FUND_REQUIRES_RETAIL_DIRECT_EARLY_SALE_PRICE_AND_LIQUIDITY_REVIEW'));
  assert.equal(a.productQualified,false);
  assert.equal(a.productRiskLevel,null);
  assert.equal(a.scoreAvailable,false);
 }
});

test('seven AIF access reviews use October 2026 accreditation rules without approval',()=>{
 const rows=listExtensionResearch().filter(x=>x.aifCategoryAccessReview);
 assert.equal(rows.length,7);
 const short=screenExtensionResearchForProfile(canonicalProfile({
   investmentHorizonYears:1,investmentGoals:['Emergency Fund'],
   riskTolerance:'Conservative',hasLumpSum:true,lumpSumAmount:50000
 }));
 const long=screenExtensionResearchForProfile(canonicalProfile({
   investmentHorizonYears:10,investmentGoals:['Wealth Growth'],riskTolerance:'Aggressive'
 }));
 for(const row of rows){
  const a=row.aifCategoryAccessReview;
  assert.equal(a.regulationsAmendedThrough,'2026-10-15');
  assert.ok(a.riskConsiderations.length>=2&&a.investorAccessConstraints.length>=2);
  assert.equal(a.privatePlacementRequired,true);
  for(const k of ['actualFundRegistrationAndPpmVerified','individualAccreditationVerified',
    'individualKycAndSubscriptionEligibilityVerified','schemeFeesTenureAndRedemptionVerified',
    'currentValuationAndCommercialDataRightsVerified','personalizedAdviceAuthorizationVerified'])
    assert.equal(a[k],false,row.id);
  const s=short.find(x=>x.id===row.id),l=long.find(x=>x.id===row.id);
  assert.ok(s.screeningReasonCodes.includes('AIF_OCT_2026_ACCREDITATION_CHANGE_NOT_PERSONAL_ACCREDITATION'));
  assert.ok(s.screeningReasonCodes.includes('EMERGENCY_FUND_REQUIRES_AIF_ILLIQUIDITY_AND_LOSS_REVIEW'));
  assert.ok(s.screeningReasonCodes.includes('SHORT_HORIZON_REQUIRES_AIF_CAPITAL_CALL_AND_EXIT_REVIEW'));
  assert.ok(!l.screeningReasonCodes.includes('EMERGENCY_FUND_REQUIRES_AIF_ILLIQUIDITY_AND_LOSS_REVIEW'));
  assert.ok(!l.screeningReasonCodes.includes('SHORT_HORIZON_REQUIRES_AIF_CAPITAL_CALL_AND_EXIT_REVIEW'));
  assert.equal(s.profileAssessment,'MISSING_SUITABILITY_EVIDENCE');
  assert.equal(s.productQualified,false);
  assert.equal(s.scoreAvailable,false);
  assert.equal(s.productRiskLevel,null);
 }
 const social=rows.find(x=>x.id==='catalog_2026_aif1_social');
 assert.equal(social.standardCapitalReferenceInr,null);
 assert.equal(social.aifCategoryAccessReview.socialImpactNpoOnlyIndividualMinimumInr,1000);
 assert.equal(social.aifCategoryAccessReview.socialUnitsCanCarryNoFinancialReturn,true);
 assert.ok(!short.find(x=>x.id===social.id).screeningReasonCodes.includes(
   'REPORTED_LUMP_SUM_BELOW_STANDARD_REFERENCE_NOT_PROOF_OF_INELIGIBILITY'));
});
test('nine NPS archetypes record PFRDA October 26 postponement to December 1 without a NAV claim',()=>{
 const rows=listExtensionResearch().filter(x=>x.id.startsWith('catalog_2026_nps_'));
 assert.equal(rows.length,9);
 const screened=screenExtensionResearchForProfile(canonicalProfile());
 for(const row of rows){
  const p=(row.npsCommonSchemeReview||row.npsVatsalyaAccessReview).popChargeDateReview;
  assert.equal(p.issuedOn,'2026-10-26');
  assert.equal(p.priorImplementationDate,'2026-10-01');
  assert.equal(p.revisedImplementationDate,'2026-12-01');
  assert.equal(p.separateFromApril2026MultipleNavFramework,true);
  assert.equal(p.individualPopChannelAndApplicableChargesVerified,false);
  assert.equal(p.individualNavFeeImpactVerified,false);
  assert.equal(p.commercialNavRightsVerified,false);
  assert.ok(screened.find(x=>x.id===row.id).screeningReasonCodes.includes(
    'NPS_OCT_2026_POP_CHARGE_DATE_MOVED_TO_DEC_VERIFY_APPLICABLE_FEES'));
 }
});
test('PFRDA signed October PoP postponement and observed zero emergency buffer remain non-ranking',()=>{
 const rows=listExtensionResearch().filter(x=>x.id.startsWith('catalog_2026_nps_'));
 const zero=screenExtensionResearchForProfile(canonicalProfile({
  emergencyFundMonths:0,investmentGoals:['Wealth Growth'],investmentHorizonYears:10,
 }));
 const unknown=screenExtensionResearchForProfile(canonicalProfile({
  emergencyFundMonths:null,investmentGoals:['Wealth Growth'],investmentHorizonYears:10,
 }));
 const positive=screenExtensionResearchForProfile(canonicalProfile({
  emergencyFundMonths:6,investmentGoals:['Wealth Growth'],investmentHorizonYears:10,
 }));
 assert.equal(rows.length,9);
 for(const row of rows){
  const p=(row.npsCommonSchemeReview||row.npsVatsalyaAccessReview).popChargeDateReview;
  assert.equal(p.officialPfrdaCircularPdfUrl,'https://www.pfrda.org.in/documents/33652/154928/2026-53-REG-POP-09%2BE%2BSigned.pdf');
  assert.equal(p.previousCircularNumber,'PFRDA/2026/46/REG-PoP/08');
  assert.equal(p.otherAugust2026ProvisionsRemainUnchanged,true);
  assert.equal(p.craRevisedChargeDeductionsBeginOn,'2026-12-01');
  assert.equal(p.revisedChargesNotVerifiedForIndividual,true);
  assert.equal(p.reviewedOn,'2026-10-31');
  const review=row.npsCommonSchemeReview||row.npsVatsalyaAccessReview;
  assert.ok(review.investorAccessConstraints.some(x=>x.includes('1 December 2026')));
  const code=row.id==='catalog_2026_nps_vatsalya'
   ? 'RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_NPS_VATSALYA_GUARDIAN_WITHDRAWAL_REVIEW'
   : 'RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_NPS_TIER_I_WITHDRAWAL_AND_NAV_FEE_REVIEW';
  const get=all=>all.find(x=>x.id===row.id);
  assert.ok(get(zero).screeningReasonCodes.includes(code),row.id);
  assert.ok(!get(unknown).screeningReasonCodes.includes(code),row.id);
  assert.ok(!get(positive).screeningReasonCodes.includes(code),row.id);
  for(const result of [get(zero),get(unknown),get(positive)]){
   assert.equal(result.profileAssessment,'MISSING_SUITABILITY_EVIDENCE');
   assert.equal(result.productQualified,false);
   assert.equal(result.productRiskLevel,null);
   assert.equal(result.scoreAvailable,false);
  }
 }
});

test('RBI SGS STRIPS evidence separates underlying outstanding threshold from retail access',()=>{
 const rows=listExtensionResearch().filter(x=>x.sgsStripsAccessReview);
 assert.equal(rows.length,2);
 const short=screenExtensionResearchForProfile(canonicalProfile({
   investmentHorizonYears:1,investmentGoals:['Emergency Fund']
 }));
 const long=screenExtensionResearchForProfile(canonicalProfile({
   investmentHorizonYears:10,investmentGoals:['Wealth Growth']
 }));
 for(const row of rows){
  const s=row.sgsStripsAccessReview;
  assert.equal(s.eligibleUnderlyingMinimumOutstandingInr,10000000000);
  assert.equal(s.underlyingOutstandingIsNotRetailInvestorMinimum,true);
  assert.equal(s.actualEligibleUnderlyingAndIsinVerified,false);
  assert.ok(s.riskConsiderations.length>=2&&s.investorAccessConstraints.length>=2);
  assert.ok(short.find(x=>x.id===row.id).screeningReasonCodes.includes(
    'EMERGENCY_FUND_REQUIRES_SGS_STRIP_EXIT_LIQUIDITY_REVIEW'));
  assert.ok(!long.find(x=>x.id===row.id).screeningReasonCodes.includes(
    'EMERGENCY_FUND_REQUIRES_SGS_STRIP_EXIT_LIQUIDITY_REVIEW'));
 }
});
test('nine debt schemes retain two scheme-specific access cautions, not product approvals',()=>{
 const rows=listExtensionResearch().filter(x=>x.sebiDebtSchemeStructureReview);
 assert.equal(rows.length,9);
 assert.ok(rows.every(x=>x.sebiDebtSchemeStructureReview.investorAccessConstraints.length>=2));
 assert.ok(rows.every(x=>x.productRiskScore===null&&x.actualRetailProductEligible===false));
});

test('nine individually sourced bank and sovereign risk/access profiles remain unqualified',()=>{
 const ids=["catalog_2026_gsec_coupon_strip","catalog_2026_gsec_principal_strip","catalog_2026_sovereign_green","catalog_2026_gsec_floating","catalog_2026_bank_rd","catalog_2026_bank_tax_saver_fd","catalog_2026_bank_sweep_fd","catalog_2026_bank_fd_monthly","catalog_2026_bank_fd_quarterly"];
 const rows=listExtensionResearch();
 for(const id of ids){
  const row=rows.find(x=>x.id===id);
  const review=row.governmentBondStructureReview||row.bankDepositAccessReview;
  assert.ok(review,id);
  assert.ok(review.riskConsiderations.length>=2&&review.investorAccessConstraints.length>=2,id);
  assert.equal(row.verifiedPublicFrameworkFact.officialSourceUrl,
   review.officialStructureSourceUrl||review.officialDicgcCoverageUrl);
  assert.equal(row.productRiskScore,null);
  assert.equal(row.actualRetailProductEligible,false);
  assert.equal(row.suitabilityRankingPermitted,false);
  assert.equal(row.sourcePermissionVerified,false);
 }
 const get=(rows,id)=>rows.find(x=>x.id==='catalog_2026_'+id).screeningReasonCodes;
 const short=screenExtensionResearchForProfile(canonicalProfile({
  investmentHorizonYears:1,investmentGoals:['Emergency Fund','Tax Saving'],riskTolerance:'Conservative'
 }));
 const long=screenExtensionResearchForProfile(canonicalProfile({
  investmentHorizonYears:10,investmentGoals:['Wealth Growth'],riskTolerance:'Aggressive'
 }));
 for(const id of ['gsec_coupon_strip','gsec_principal_strip','sovereign_green','gsec_floating']){
  assert.ok(get(short,id).includes('EMERGENCY_FUND_REQUIRES_GOVT_BOND_SECONDARY_EXIT_PRICE_AND_LIQUIDITY_REVIEW'));
  assert.ok(get(short,id).includes('SHORT_HORIZON_REQUIRES_GOVT_BOND_MATURITY_AND_SALE_PRICE_REVIEW'));
  assert.ok(!get(long,id).includes('SHORT_HORIZON_REQUIRES_GOVT_BOND_MATURITY_AND_SALE_PRICE_REVIEW'));
 }
 assert.ok(get(short,'bank_rd').includes('SHORT_HORIZON_REQUIRES_RD_INSTALLMENT_AND_EARLY_CLOSURE_REVIEW'));
 assert.ok(!get(long,'bank_rd').includes('SHORT_HORIZON_REQUIRES_RD_INSTALLMENT_AND_EARLY_CLOSURE_REVIEW'));
 assert.ok(get(short,'bank_tax_saver_fd').includes('TAX_SAVING_GOAL_REQUIRES_CURRENT_FY_DEPOSIT_DEDUCTION_ELIGIBILITY_REVIEW'));
 assert.ok(!get(long,'bank_tax_saver_fd').includes('TAX_SAVING_GOAL_REQUIRES_CURRENT_FY_DEPOSIT_DEDUCTION_ELIGIBILITY_REVIEW'));
 assert.ok(get(short,'bank_sweep_fd').includes('EMERGENCY_FUND_REQUIRES_SWEEP_REVERSE_TRANSFER_ACCESS_REVIEW'));
 assert.ok(!get(long,'bank_sweep_fd').includes('EMERGENCY_FUND_REQUIRES_SWEEP_REVERSE_TRANSFER_ACCESS_REVIEW'));
 assert.ok(short.every(x=>!x.productQualified&&!x.scoreAvailable&&x.productRiskLevel===null));
});

test('15 individually sourced category risk/access profiles remain discovery-only and profile-bound',()=>{
 const ids=["catalog_2026_nbfc_fd_cumulative","catalog_2026_nbfc_fd_payout","catalog_2026_index_india_defence","catalog_2026_index_india_digital","catalog_2026_index_india_consumption","catalog_2026_pms_discretionary","catalog_2026_pms_nondiscretionary","catalog_2026_physical_gold_bullion","catalog_2026_physical_silver_bullion","catalog_2026_equity_diversified_fof","catalog_2026_equity_sector_fof","catalog_2026_fof_aggressive_hybrid","catalog_2026_fof_conservative_hybrid","catalog_2026_fof_income_arbitrage","catalog_2026_fof_dynamic_allocation"];
 const rows=listExtensionResearch();
 const short=screenExtensionResearchForProfile(canonicalProfile({
  investmentHorizonYears:1,investmentGoals:['Emergency Fund'],riskTolerance:'Conservative'
 }));
 const long=screenExtensionResearchForProfile(canonicalProfile({
  investmentHorizonYears:10,investmentGoals:['Wealth Growth'],riskTolerance:'Aggressive'
 }));
 for(const id of ids){
  const row=rows.find(x=>x.id===id);
  const review=row.nbfcPublicDepositAccessReview||row.thematicIndexReview
   ||row.individualCategoryReview||row.preciousMetalsCategoryReview||row.fundOfFundsCategoryReview;
  assert.ok(review,id);
  assert.equal(review.reviewedOn,'2026-10-29',id);
  assert.ok(review.officialRiskAccessEvidenceUrl.startsWith('https://'),id);
  assert.ok(review.riskConsiderations.length>=2&&review.investorAccessConstraints.length>=2,id);
  for(const k of ['specificInstrumentOrSchemeVerified','currentPriceOrNavVerified',
   'individualInvestorAccessVerified','commercialDataRightsVerified',
   'personalizedAdviceAuthorizationVerified'])assert.equal(review[k],false,id+':'+k);
  assert.equal(row.productRiskScore,null,id);
  assert.equal(row.actualRetailProductEligible,false,id);
  assert.equal(row.suitabilityRankingPermitted,false,id);
  for(const screened of [short,long]){
   const result=screened.find(x=>x.id===id);
   assert.equal(result.productQualified,false,id);
   assert.equal(result.scoreAvailable,false,id);
   assert.equal(result.productRiskLevel,null,id);
  }
 }
 const reasons=(list,id)=>list.find(x=>x.id==='catalog_2026_'+id).screeningReasonCodes;
 for(const id of ['nbfc_fd_cumulative','nbfc_fd_payout']){
  assert.ok(reasons(short,id).includes('EMERGENCY_FUND_REQUIRES_UNINSURED_NBFC_DEPOSIT_REPAYMENT_AND_LIQUIDITY_REVIEW'));
  assert.ok(!reasons(long,id).includes('EMERGENCY_FUND_REQUIRES_UNINSURED_NBFC_DEPOSIT_REPAYMENT_AND_LIQUIDITY_REVIEW'));
  assert.ok(reasons(short,id).includes('SHORT_HORIZON_REQUIRES_NBFC_DEPOSIT_TENOR_AND_PREMATURE_REPAYMENT_REVIEW'));
  assert.ok(!reasons(long,id).includes('SHORT_HORIZON_REQUIRES_NBFC_DEPOSIT_TENOR_AND_PREMATURE_REPAYMENT_REVIEW'));
 }
 for(const id of ['pms_discretionary','pms_nondiscretionary']){
  assert.ok(reasons(short,id).includes('PMS_2026_REGULATIONS_NOT_EFFECTIVE_UNTIL_APRIL_2027'));
  assert.ok(reasons(short,id).includes('EMERGENCY_FUND_GOAL_REQUIRES_REVIEWED_CATEGORY_REDEMPTION_AND_LOSS_CHECK'));
  assert.ok(!reasons(long,id).includes('EMERGENCY_FUND_GOAL_REQUIRES_REVIEWED_CATEGORY_REDEMPTION_AND_LOSS_CHECK'));
 }
 assert.ok(reasons(short,'fof_conservative_hybrid').includes('CONSERVATIVE_HYBRID_FOF_LABEL_NOT_PRINCIPAL_PROTECTION'));
 assert.ok(reasons(short,'physical_silver_bullion').includes('SILVER_JEWELLERY_HALLMARK_NOT_BULLION_CERTIFICATION'));
});

test('all 95 extended categories have separate sourced risk/access reviews without product qualification',()=>{
 const rows=listExtensionResearch();
 assert.equal(rows.length,95);
 assert.equal(new Set(rows.map(x=>x.id)).size,95);
 for(const row of rows){
  const reviews=Object.values(row).filter(v=>v&&typeof v==='object'
   &&Array.isArray(v.riskConsiderations)&&v.riskConsiderations.length>=2
   &&Array.isArray(v.investorAccessConstraints)&&v.investorAccessConstraints.length>=2);
  assert.ok(reviews.length>=1,row.id);
  assert.ok(reviews.some(v=>v.riskConsiderations.every(s=>typeof s==='string'&&s.trim())
   &&v.investorAccessConstraints.every(s=>typeof s==='string'&&s.trim())),row.id);
  assert.ok(row.verifiedPublicFrameworkFact?.officialSourceUrl.startsWith('https://'),row.id);
  assert.equal(row.productRiskScore,null,row.id);
  assert.equal(row.actualRetailProductEligible,false,row.id);
  assert.equal(row.sourcePermissionVerified,false,row.id);
  assert.equal(row.marketFactsVerified,false,row.id);
  assert.equal(row.fiscalYearTaxVerified,false,row.id);
  assert.equal(row.suitabilityRankingPermitted,false,row.id);
 }
 const screened=screenExtensionResearchForProfile(canonicalProfile());
 assert.equal(screened.length,95);
 assert.ok(screened.every(x=>x.profileAssessment==='MISSING_SUITABILITY_EVIDENCE'
  &&x.productQualified===false&&x.scoreAvailable===false&&x.productRiskLevel===null));
});
test('RBI CP, convertible ICDR, municipal July and REIT October evidence stays scoped',()=>{
 const rows=listExtensionResearch(),get=id=>rows.find(x=>x.id==='catalog_2026_'+id);
 const cp=get('commercial_paper').debtInstrumentReview;
 assert.equal(cp.officialRiskAccessEvidenceUrl,'https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=12592');
 assert.equal(cp.rbiCpMinimumDenominationInr,500000);
 assert.equal(cp.rbiCpPrimaryIndividualSubscriptionAggregateCapPct,25);
 assert.equal(cp.currentInvestorSpecificAccessVerified,false);
 assert.equal(get('bond_convertible').debtInstrumentReview.officialSourceUrl,
  'https://www.sebi.gov.in/legal/regulations/mar-2026/securities-and-exchange-board-of-india-issue-of-capital-and-disclosure-requirements-regulations-2018-last-amended-on-march-21-2026-_100581.html');
 assert.equal(get('municipal_green').individualCategoryReview.frameworkAmendedOn,'2026-07-08');
 assert.equal(get('sm_reit_scheme').individualCategoryReview.currentSchemeRegistrationAndListingVerified,false);
 const short=screenExtensionResearchForProfile(canonicalProfile({
  investmentHorizonYears:1,investmentGoals:['Emergency Fund'],riskTolerance:'Conservative'
 }));
 const long=screenExtensionResearchForProfile(canonicalProfile({
  investmentHorizonYears:10,investmentGoals:['Wealth Growth'],riskTolerance:'Aggressive'
 }));
 const reasons=(list,id)=>list.find(x=>x.id==='catalog_2026_'+id).screeningReasonCodes;
 assert.ok(reasons(short,'sif_hybrid_longshort').includes('SIF_SHORT_HORIZON_OR_EMERGENCY_LIQUIDITY_REQUIRES_INTERVAL_EXIT_REVIEW'));
 assert.ok(!reasons(long,'sif_hybrid_longshort').includes('SIF_SHORT_HORIZON_OR_EMERGENCY_LIQUIDITY_REQUIRES_INTERVAL_EXIT_REVIEW'));
 assert.ok(reasons(short,'bond_perpetual').includes('PERPETUAL_BOND_CALL_COUPON_DEFERRAL_AND_NO_FIXED_MATURITY_REVIEW'));
 assert.ok(reasons(short,'commercial_paper').includes('CP_RBI_2024_DEMAT_MINIMUM_DENOMINATION_AND_RELATED_PARTY_REVIEW'));
 assert.ok(short.every(x=>!x.productQualified&&!x.scoreAvailable&&x.productRiskLevel===null));
});

test('zero recorded emergency-fund months trigger restricted-exit review without inferring eligibility',()=>{
 const flag='RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_RESTRICTED_EXIT_ACCESS_REVIEW';
 const zero=screenExtensionResearchForProfile(canonicalProfile({
   emergencyFundMonths:0,investmentGoals:['Wealth Growth'],investmentHorizonYears:10,
   riskTolerance:'Aggressive',
 }));
 const unknown=screenExtensionResearchForProfile(canonicalProfile({emergencyFundMonths:null}));
 const positive=screenExtensionResearchForProfile(canonicalProfile({emergencyFundMonths:6}));
 const find=(rows,id)=>rows.find(x=>x.id==='catalog_2026_'+id);
 for(const id of ['aif1_vc','aif2_debt','nps_lc25','nps_vatsalya',
   'bank_tax_saver_fd','sif_hybrid_longshort']){
   assert.ok(find(zero,id).screeningReasonCodes.includes(flag),id);
   assert.ok(!find(unknown,id).screeningReasonCodes.includes(flag),id+' unknown');
   assert.ok(!find(positive,id).screeningReasonCodes.includes(flag),id+' positive');
 }
 for(const id of ['po_savings','bank_rd','index_nifty100']){
   assert.ok(!find(zero,id).screeningReasonCodes.includes(flag),id);
 }
 assert.equal(zero.length,95);
 assert.ok(zero.every(x=>x.profileAssessment==='MISSING_SUITABILITY_EVIDENCE'
   && x.scoreAvailable===false && x.productQualified===false
   && x.productRiskLevel===null));
});


test('official framework references reject spoofed HTTPS origins and credentials',()=>{
 const rows=listExtensionResearch();
 for(const row of rows){
  assert.equal(isOfficialFrameworkReferenceUrl(row.referenceUrl),true,row.id);
  assert.equal(isOfficialFrameworkReferenceUrl(row.verifiedPublicFrameworkFact.officialSourceUrl),true,row.id);
 }
 for(const invalid of [
  'http://www.sebi.gov.in/legal/regulations',
  'https://www.sebi.gov.in.attacker.example/legal/regulations',
  'https://www.rbi.org.in.evil.example/Scripts/FAQView.aspx?Id=145',
  'https://attacker.example@www.sebi.gov.in/legal/regulations',
  'https://www.sebi.gov.in:444/legal/regulations',
  'https://www.sebi.gov.in/legal/regulations#unreviewed',
  'https://www.sebi.gov.in/',null,{},
 ])assert.equal(isOfficialFrameworkReferenceUrl(invalid),false,String(invalid));
});

test('zero emergency buffer flags unverified issuer and secondary exit access, not blanket ineligibility',()=>{
 const flag='RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_UNVERIFIED_EXIT_LIQUIDITY_REVIEW';
 const zero=screenExtensionResearchForProfile(canonicalProfile({
  emergencyFundMonths:0,investmentGoals:['Wealth Growth'],investmentHorizonYears:10,
 }));
 const missing=screenExtensionResearchForProfile(canonicalProfile({emergencyFundMonths:null}));
 const positive=screenExtensionResearchForProfile(canonicalProfile({emergencyFundMonths:6}));
 const get=(rows,id)=>rows.find(row=>row.id==='catalog_2026_'+id);
 for(const id of ['nbfc_fd_cumulative','nbfc_fd_payout','sdl_coupon_strip',
  'sdl_principal_strip','gsec_coupon_strip','gsec_principal_strip',
  'pms_discretionary','pms_nondiscretionary','ncd_unlisted']){
  assert.ok(get(zero,id).screeningReasonCodes.includes(flag),id);
  assert.ok(!get(missing,id).screeningReasonCodes.includes(flag),id+' unknown');
  assert.ok(!get(positive,id).screeningReasonCodes.includes(flag),id+' positive');
 }
 for(const id of ['po_savings','bank_rd','index_nifty100','nps_lc25']){
  assert.ok(!get(zero,id).screeningReasonCodes.includes(flag),id);
 }
 assert.equal(zero.length,95);
 assert.ok(zero.every(row=>row.productQualified===false && row.scoreAvailable===false
  && row.productRiskLevel===null && row.profileAssessment==='MISSING_SUITABILITY_EVIDENCE'));
});

test('October 7 SEBI merchant-banker exception is conditional issuer process, never retail eligibility',()=>{
 const rows=listExtensionResearch();
 const scopes={"catalog_2026_ncd_secured":"SECURED_LISTED_NCD_ONLY_IF_SENIOR_AND_ALL_ISSUER_CONDITIONS","catalog_2026_ncd_unsecured":"UNSECURED_LISTED_NCD_ONLY_IF_CPSE_PSU_STATUTORY_AND_ALL_ISSUER_CONDITIONS","catalog_2026_psu_bond_taxable":"PSU_BOND_ONLY_IF_ACTUAL_PSU_STATUS_SENIORITY_AND_ALL_CONDITIONS"};
 const ids=Object.keys(scopes);
 assert.equal(rows.filter(x=>x.debtInstrumentReview?.merchantBankerExemptionOct2026Review).length,3);
 const conservative=screenExtensionResearchForProfile(canonicalProfile({
  riskTolerance:'Conservative',investmentGoals:['Emergency Fund'],investmentHorizonYears:1,
 }));
 const other=screenExtensionResearchForProfile(canonicalProfile({
  riskTolerance:'Aggressive',investmentGoals:['Wealth Growth'],investmentHorizonYears:10,
 }));
 for(const id of ids){
  const row=rows.find(x=>x.id===id),review=row.debtInstrumentReview.merchantBankerExemptionOct2026Review;
  assert.equal(review.categoryApplicability,scopes[id]);
  assert.equal(review.circularIssuedOn,'2026-10-07');
  assert.equal(review.effectiveFrom,'2026-10-07');
  assert.equal(review.generalConditions.minimumIssueRating,'AA-');
  assert.equal(review.generalConditions.lowestOfMultipleRatingsControls,true);
  assert.equal(review.generalConditions.issuerListedMinimumYears,1);
  assert.equal(review.generalConditions.cpsePsuStatutoryBodyUnsecuredExceptionOnly,true);
  for(const field of [
   'issuerFinancialRegulatorStatusVerified','issuerOneYearListingAndLodrClearanceVerified',
   'issuerDefaultFreeAuditorCertificateVerified','issueSeniorityAndSecurityVerified',
   'issueMinimumAaMinusRatingVerified','issuerPrivatePlacementRouteAndDenominationVerified',
   'investorEligibilityAndKycVerified','issuerOfferIsinPriceAndDataRightsVerified',
   'merchantBankerExemptionApprovedForIssuer','personalizedAdviceAuthorizationVerified'
  ])assert.equal(review[field],false,id+' '+field);
  const c=conservative.find(x=>x.id===id),o=other.find(x=>x.id===id);
  assert.ok(c.screeningReasonCodes.includes('SEBI_OCT_2026_MERCHANT_BANKER_EXCEPTION_IS_ISSUER_PROCESS_NOT_RETAIL_APPROVAL'));
  assert.ok(c.screeningReasonCodes.includes('EMERGENCY_FUND_REQUIRES_PRIVATE_DEBT_ISSUE_EXIT_LIQUIDITY_REVIEW'));
  assert.ok(c.screeningReasonCodes.includes('CONSERVATIVE_PROFILE_REQUIRES_DEBT_ISSUER_DEFAULT_SECURITY_AND_RATING_REVIEW'));
  assert.ok(!o.screeningReasonCodes.includes('EMERGENCY_FUND_REQUIRES_PRIVATE_DEBT_ISSUE_EXIT_LIQUIDITY_REVIEW'));
  assert.ok(!o.screeningReasonCodes.includes('CONSERVATIVE_PROFILE_REQUIRES_DEBT_ISSUER_DEFAULT_SECURITY_AND_RATING_REVIEW'));
  assert.equal(c.productQualified,false);assert.equal(c.scoreAvailable,false);
  assert.equal(c.productRiskLevel,null);assert.equal(o.productQualified,false);
 }
 assert.ok(!rows.find(x=>x.id==='catalog_2026_ncd_unlisted')
  .debtInstrumentReview.merchantBankerExemptionOct2026Review);
});

test('NPS Vatsalya effective 2026 guidance and stale FAQ remain distinct from applicant eligibility',()=>{
 const r=listExtensionResearch().find(x=>x.id==='catalog_2026_nps_vatsalya').npsVatsalyaAccessReview;
 const e=r.guidelines2026EvidenceReview;
 assert.equal(r.eligibleSubscriber,'INDIAN_CITIZEN_OR_NRI_OR_OCI_UNDER_18_WITH_PARENT_OR_LEGAL_GUARDIAN');
 assert.equal(r.minimumInitialContributionInr,250);
 assert.equal(r.minimumAnnualContributionInr,250);
 assert.equal(r.minimumSubsequentContributionInr,null);
 assert.equal(e.effectiveFrom,'2026-02-23');
 assert.equal(e.updatedFaqAsOf,'2026-06-16');
 assert.equal(e.olderFaqStatesInitialAndAnnualMinimumInr,1000);
 assert.equal(e.currentGuidelinesInitialAndAnnualMinimumInr,250);
 assert.equal(e.olderFaqStatesFullExitCorpusLimitInr,250000);
 assert.equal(e.currentGuidelinesFullExitWording,'LESS_THAN_800000_INR');
 assert.equal(e.pressReleaseFullExitWording,'800000_INR_OR_LESS');
 assert.equal(e.fullExitBoundaryWordingRequiresConfirmation,true);
 assert.equal(e.minimumPerSubsequentContributionNotEstablished,true);
 assert.equal(e.pensionFundMayDesignUpToFullEquityAllocation,true);
 assert.equal(e.automaticHighEquityMsfShiftAt21IfNoChoice,true);
 for(const key of ['currentSelectedPensionFundAllocationVerified','individualGuardianMinorNriOciKycVerified',
  'individualContributionAndExitTermsVerified','schemeNavRiskometerAndMarketDataRightsVerified',
  'personalizedAdviceAuthorizationVerified'])assert.equal(e[key],false,key);
 const conservative=screenExtensionResearchForProfile(canonicalProfile({riskTolerance:'Conservative'}))
  .find(x=>x.id==='catalog_2026_nps_vatsalya');
 const aggressive=screenExtensionResearchForProfile(canonicalProfile({riskTolerance:'Aggressive'}))
  .find(x=>x.id==='catalog_2026_nps_vatsalya');
 for(const item of [conservative,aggressive]){
  for(const code of ['NPS_VATSALYA_2026_GUIDELINES_SUPERSEDE_STALE_FAQ_CONTRIBUTION_AND_EXIT_FIGURES',
   'NPS_VATSALYA_PENSION_FUND_MAY_USE_FULL_EQUITY_AND_AGE_21_HIGH_EQUITY_SHIFT_REVIEW',
   'NPS_VATSALYA_EXACT_FULL_EXIT_CORPUS_BOUNDARY_AND_KYC_NOT_VERIFIED'])
   assert.ok(item.screeningReasonCodes.includes(code),code);
  assert.equal(item.productQualified,false);
  assert.equal(item.scoreAvailable,false);
  assert.equal(item.productRiskLevel,null);
 }
 assert.ok(conservative.screeningReasonCodes.includes(
  'CONSERVATIVE_PROFILE_REQUIRES_NPS_VATSALYA_PENSION_FUND_FULL_EQUITY_REVIEW'));
 assert.ok(!aggressive.screeningReasonCodes.includes(
  'CONSERVATIVE_PROFILE_REQUIRES_NPS_VATSALYA_PENSION_FUND_FULL_EQUITY_REVIEW'));
});

test('all 95 distinct category reviews require two real risk and investor-access considerations',()=>{
 const rows=listExtensionResearch();
 assert.equal(rows.length,95);
 assert.ok(rows.every(hasCompleteCategoryRiskAccessResearch));
 const original=rows.find(row=>row.id==='catalog_2026_po_td_5');
 const withoutRisk=structuredClone(original);
 withoutRisk.postalSavingsAccessReview.riskConsiderations=[];
 assert.equal(hasCompleteCategoryRiskAccessResearch(withoutRisk),false);
 const withoutAccess=structuredClone(original);
 withoutAccess.postalSavingsAccessReview.investorAccessConstraints=['Unverified'];
 assert.equal(hasCompleteCategoryRiskAccessResearch(withoutAccess),false);
 const duplicate=structuredClone(original);
 duplicate.postalSavingsAccessReview.riskConsiderations[1]=duplicate.postalSavingsAccessReview.riskConsiderations[0];
 assert.equal(hasCompleteCategoryRiskAccessResearch(duplicate),false);
 const ambiguous=structuredClone(original);
 ambiguous.bankDepositAccessReview={riskConsiderations:['Long first risk statement','Long second risk statement'],
  investorAccessConstraints:['Long first access constraint','Long second access constraint']};
 assert.equal(hasCompleteCategoryRiskAccessResearch(ambiguous),false);
 assert.equal(hasCompleteCategoryRiskAccessResearch(null),false);
});

test('recorded zero emergency buffer adds deposit-specific exit review without ranking or blanket exclusion',()=>{
 const flag='RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_DEPOSIT_ACCESS_AND_EARLY_EXIT_REVIEW';
 const zero=screenExtensionResearchForProfile(canonicalProfile({
  emergencyFundMonths:0,investmentGoals:['Wealth Growth'],investmentHorizonYears:10,
 }));
 const missing=screenExtensionResearchForProfile(canonicalProfile({emergencyFundMonths:null}));
 const positive=screenExtensionResearchForProfile(canonicalProfile({emergencyFundMonths:6}));
 const find=(rows,id)=>rows.find(row=>row.id==='catalog_2026_'+id);
 for(const id of ['po_td_2','po_td_3','po_td_5','bank_rd','bank_tax_saver_fd',
  'bank_sweep_fd','bank_fd_monthly','bank_fd_quarterly']){
  assert.ok(find(zero,id).screeningReasonCodes.includes(flag),id);
  assert.ok(!find(missing,id).screeningReasonCodes.includes(flag),id+' missing');
  assert.ok(!find(positive,id).screeningReasonCodes.includes(flag),id+' positive');
 }
 for(const id of ['po_savings','index_nifty100','aif1_vc']){
  assert.ok(!find(zero,id).screeningReasonCodes.includes(flag),id);
 }
 assert.equal(zero.length,95);
 assert.ok(zero.every(row=>row.profileAssessment==='MISSING_SUITABILITY_EVIDENCE'
  &&row.productQualified===false&&row.scoreAvailable===false&&row.productRiskLevel===null));
});

test('recorded zero emergency buffer flags six government security categories for early-sale risk without approving them',()=>{
 const notice='RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_GSEC_EARLY_SALE_PRICE_AND_SETTLEMENT_REVIEW';
 const make=months=>screenExtensionResearchForProfile(canonicalProfile({
  emergencyFundMonths:months,investmentGoals:['Wealth Growth'],investmentHorizonYears:10,
 }));
 const zero=make(0),missing=make(null),positive=make(6);
 const find=(rows,id)=>rows.find(row=>row.id==='catalog_2026_'+id);
 for(const id of ['tbill_91','tbill_182','tbill_364','sdl_dated',
  'sovereign_green','gsec_floating']){
  const row=find(zero,id);
  assert.ok(row.screeningReasonCodes.includes(notice),id);
  assert.ok(!find(missing,id).screeningReasonCodes.includes(notice),id+' missing');
  assert.ok(!find(positive,id).screeningReasonCodes.includes(notice),id+' positive');
  assert.equal(row.productQualified,false,id);
  assert.equal(row.scoreAvailable,false,id);
  assert.equal(row.productRiskLevel,null,id);
  assert.equal(row.profileAssessment,'MISSING_SUITABILITY_EVIDENCE',id);
 }
 for(const id of ['gsec_coupon_strip','gsec_principal_strip','po_savings',
  'index_nifty100','bank_rd']){
  assert.ok(!find(zero,id).screeningReasonCodes.includes(notice),id);
 }
 assert.equal(zero.length,95);
 assert.equal(new Set(zero.map(row=>row.id)).size,95);
});

test('six FoF categories retain source-scoped SEBI scheme risk-o-meter evidence, never scheme approval',()=>{
 const rows=listExtensionResearch().filter(row=>row.fundOfFundsCategoryReview);
 assert.equal(rows.length,6);
 const interpretations=new Set();
 for(const row of rows){
  const e=row.fundOfFundsCategoryReview.schemeRiskometerDisclosureReview;
  assert.equal(e.officialSebiCircularUrl,
   'https://www.sebi.gov.in/legal/circulars/nov-2024/disclosure-of-expenses-half-yearly-returns-yield-and-risk-o-meter-of-schemes-of-mutual-funds_88230.html');
  assert.equal(e.circularIssuedOn,'2024-11-05');
  assert.equal(e.reviewedOn,'2026-10-30');
  assert.equal(e.scope,'SCHEME_SPECIFIC_DISCLOSURE_REQUIREMENT_NOT_CATEGORY_RISK_OR_INVESTMENT_APPROVAL');
  assert.ok(isOfficialFrameworkReferenceUrl(e.officialSebiCircularUrl));
  assert.ok(e.categoryInterpretation.length>40);
  interpretations.add(e.categoryInterpretation);
  for(const key of ['actualFoFSchemeRiskometerVerified','underlyingSchemeRiskometersVerified',
   'currentSchemeNavAndLicensedDataVerified','investorAccessAndAdviceRightsVerified'])
   assert.equal(e[key],false,row.id+' '+key);
  assert.equal(row.productRiskScore,null);
  assert.equal(row.actualRetailProductEligible,false);
  assert.equal(row.suitabilityRankingPermitted,false);
 }
 assert.equal(interpretations.size,6,'Each FoF has an individual risk interpretation');
});


test('six Annexure C FoF categories distinguish multiple underlying funds from actual schemes',()=>{
 const ids=["catalog_2026_equity_diversified_fof","catalog_2026_equity_sector_fof","catalog_2026_fof_aggressive_hybrid","catalog_2026_fof_conservative_hybrid","catalog_2026_fof_income_arbitrage","catalog_2026_fof_dynamic_allocation"];
 const rows=listExtensionResearch();
 const byId=id=>rows.find(row=>row.id===id);
 const boundaries=new Set();
 for(const id of ids){
  const row=byId(id),e=row.fundOfFundsCategoryReview.sebiMultiUnderlyingFoFAnnexureC2026Review;
  assert.equal(e.officialSebiCircularUrl,'https://www.sebi.gov.in/sebi_data/attachdocs/feb-2026/1772079826878.pdf');
  assert.ok(isOfficialFrameworkReferenceUrl(e.officialSebiCircularUrl));
  assert.equal(e.circularIssuedOn,'2026-02-26');
  assert.equal(e.reviewedOn,'2026-10-30');
  assert.equal(e.applicability,'MULTIPLE_UNDERLYING_FUNDS_ONLY');
  assert.equal(e.sourceScope,'ANNEXURE_C_CATEGORY_REQUIREMENTS_NOT_SINGLE_UNDERLYING_OR_NAMED_SCHEME_APPROVAL');
  boundaries.add(e.categorySpecificBoundary);
  assert.ok(e.riskConsiderations.length>=2&&e.investorAccessConstraints.length>=2,id);
  for(const key of ['actualSchemeUnderlyingFundCountVerified','actualSchemeAllocationAndHoldingsVerified',
    'specificAmcAndSchemeVerified','currentSchemeRiskometerVerified',
    'currentNavAndLicensedDataRightsVerified','investorKycAndRetailEligibilityVerified',
    'taxAndPersonalizedAdviceAuthorizationVerified'])assert.equal(e[key],false,id+' '+key);
  assert.equal(row.productRiskScore,null);
  assert.equal(row.suitabilityRankingPermitted,false);
  assert.equal(row.actualRetailProductEligible,false);
 }
 assert.equal(boundaries.size,6);
 assert.equal(rows.length,95);
 const short=screenExtensionResearchForProfile(canonicalProfile({
  investmentHorizonYears:1,investmentGoals:['Emergency Fund'],riskTolerance:'Conservative'
 }));
 const long=screenExtensionResearchForProfile(canonicalProfile({
  investmentHorizonYears:10,investmentGoals:['Wealth Growth'],riskTolerance:'Aggressive'
 }));
 const reasons=(all,id)=>all.find(row=>row.id===id).screeningReasonCodes;
 for(const id of ids){
  assert.ok(reasons(short,id).includes('SEBI_FOF_ANNEXURE_C_APPLIES_TO_MULTIPLE_UNDERLYING_FUNDS_ONLY'));
  assert.ok(reasons(short,id).includes('ACTUAL_FOF_UNDERLYING_COUNT_ALLOCATIONS_AND_RETAIL_ACCESS_UNVERIFIED'));
  assert.ok(reasons(long,id).includes('SEBI_FOF_ANNEXURE_C_APPLIES_TO_MULTIPLE_UNDERLYING_FUNDS_ONLY'));
  const result=short.find(row=>row.id===id);
  assert.equal(result.productQualified,false);
  assert.equal(result.scoreAvailable,false);
  assert.equal(result.profileAssessment,'MISSING_SUITABILITY_EVIDENCE');
 }
 for(const id of ids.slice(0,3)){
  const code='RECORDED_SHORT_HORIZON_REQUIRES_EQUITY_FOF_DRAWDOWN_AND_SETTLEMENT_REVIEW';
  assert.ok(reasons(short,id).includes(code),id);
  assert.ok(!reasons(long,id).includes(code),id);
 }
 assert.ok(reasons(short,'catalog_2026_fof_income_arbitrage')
  .includes('EMERGENCY_FUND_GOAL_REQUIRES_ARBITRAGE_FOF_SPREAD_AND_SETTLEMENT_REVIEW'));
 assert.ok(!reasons(long,'catalog_2026_fof_income_arbitrage')
  .includes('EMERGENCY_FUND_GOAL_REQUIRES_ARBITRAGE_FOF_SPREAD_AND_SETTLEMENT_REVIEW'));
 assert.ok(reasons(short,'catalog_2026_fof_dynamic_allocation')
  .includes('CONSERVATIVE_PROFILE_REQUIRES_DYNAMIC_FOF_REALLOCATION_LOSS_REVIEW'));
 assert.ok(!reasons(long,'catalog_2026_fof_dynamic_allocation')
  .includes('CONSERVATIVE_PROFILE_REQUIRES_DYNAMIC_FOF_REALLOCATION_LOSS_REVIEW'));
});

test('zero emergency buffer adds source-specific non-ranking MF and ETF liquidity notices',()=>{
 const categories=[
  ['indexBenchmarkReview','RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_EQUITY_SCHEME_DRAWDOWN_AND_EXIT_REVIEW',11],
  ['etfBenchmarkReview','RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_EQUITY_SCHEME_DRAWDOWN_AND_EXIT_REVIEW',10],
  ['thematicIndexReview','RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_EQUITY_SCHEME_DRAWDOWN_AND_EXIT_REVIEW',3],
  ['sebiDebtSchemeStructureReview','RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_DEBT_FUND_NAV_AND_REDEMPTION_REVIEW',9],
  ['fundOfFundsCategoryReview','RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_FOF_UNDERLYING_RISK_AND_REDEMPTION_REVIEW',6],
 ];
 const make=months=>screenExtensionResearchForProfile(canonicalProfile({
  emergencyFundMonths:months,investmentGoals:['Wealth Growth'],
  investmentHorizonYears:10,riskTolerance:'Aggressive',
 }));
 const zero=make(0),missing=make(null),positive=make(6);
 const source=listExtensionResearch(),byId=rows=>new Map(rows.map(row=>[row.id,row]));
 const z=byId(zero),m=byId(missing),p=byId(positive);
 for(const [key,code,expected] of categories){
  const rows=source.filter(row=>row[key]);
  assert.equal(rows.length,expected,key);
  for(const row of rows){
   assert.ok(z.get(row.id).screeningReasonCodes.includes(code),row.id+' zero');
   assert.ok(!m.get(row.id).screeningReasonCodes.includes(code),row.id+' missing');
   assert.ok(!p.get(row.id).screeningReasonCodes.includes(code),row.id+' positive');
  }
 }
 const notices=categories.map(x=>x[1]);
 for(const id of ['catalog_2026_bank_rd','catalog_2026_po_td_2','catalog_2026_gsec_floating']){
  assert.ok(notices.every(code=>!z.get(id).screeningReasonCodes.includes(code)),id);
 }
 assert.equal(zero.length,95);
 assert.ok(zero.every(row=>row.productQualified===false&&row.scoreAvailable===false
  &&row.productRiskLevel===null&&row.profileAssessment==='MISSING_SUITABILITY_EVIDENCE'));
});

test('zero emergency buffer flags debt, bullion, SM REIT and silver FoF exit risks without product approval',()=>{
 const groups=[
  [['ncd_secured','ncd_unsecured','ncd_unlisted','bond_subordinated','bond_perpetual',
    'bond_corporate_floating','bond_corporate_zero','bond_convertible','psu_bond_taxable',
    'infra_corporate_bond','commercial_paper'],
   'RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_DEBT_ISSUER_REPAYMENT_AND_RESALE_REVIEW'],
  [['physical_gold_bullion','physical_silver_bullion'],
   'RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_PHYSICAL_BULLION_RESALE_SPREAD_AND_CUSTODY_REVIEW'],
  [['sm_reit_scheme'],
   'RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_SM_REIT_UNIT_LIQUIDITY_AND_EXIT_REVIEW'],
  [['silver_fof'],
   'RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_SILVER_FOF_NAV_AND_REDEMPTION_REVIEW'],
 ];
 const make=months=>screenExtensionResearchForProfile(canonicalProfile({
  emergencyFundMonths:months,investmentGoals:['Wealth Growth'],
  investmentHorizonYears:10,riskTolerance:'Aggressive',
 }));
 const zero=make(0),missing=make(null),positive=make(6);
 const byId=rows=>new Map(rows.map(row=>[row.id,row]));
 const z=byId(zero),m=byId(missing),p=byId(positive);
 const seen=new Set();
 for(const [ids,notice] of groups){
  for(const suffix of ids){
   const id='catalog_2026_'+suffix;
   assert.ok(!seen.has(id),id+' duplicate');
   seen.add(id);
   assert.ok(z.get(id).screeningReasonCodes.includes(notice),id+' zero');
   assert.ok(!m.get(id).screeningReasonCodes.includes(notice),id+' missing');
   assert.ok(!p.get(id).screeningReasonCodes.includes(notice),id+' positive');
   assert.equal(z.get(id).profileAssessment,'MISSING_SUITABILITY_EVIDENCE',id);
   assert.equal(z.get(id).scoreAvailable,false,id);
   assert.equal(z.get(id).productQualified,false,id);
   assert.equal(z.get(id).productRiskLevel,null,id);
  }
 }
 assert.equal(seen.size,15);
 const notices=groups.map(group=>group[1]);
 for(const id of ['catalog_2026_po_savings','catalog_2026_bank_rd',
  'catalog_2026_nps_vatsalya','catalog_2026_index_nifty100']){
  assert.ok(notices.every(code=>!z.get(id).screeningReasonCodes.includes(code)),id);
 }
 assert.equal(zero.length,95);
 assert.equal(new Set(zero.map(row=>row.id)).size,95);
});

test('SIF active-breach threshold and 2026 distributor certification are not investor approvals',()=>{
 const row=listExtensionResearch().find(item=>item.id==='catalog_2026_sif_hybrid_longshort');
 const review=row.individualCategoryReview;
 const threshold=review.minimumThresholdMonitoringReview;
 const distributor=review.distributionCertificationReview;
 assert.equal(threshold.officialSebiCircularUrl,
  'https://www.sebi.gov.in/legal/circulars/jul-2025/monitoring-of-minimum-investment-threshold-under-specialized-investment-funds-sif-_95676.html');
 assert.equal(threshold.aggregateThresholdInr,1000000);
 assert.equal(threshold.thresholdScope,'ACROSS_STRATEGIES_OF_THE_CONCERNED_SIF_NOT_A_SINGLE_PURCHASE');
 assert.equal(threshold.activeBreachNoticeCalendarDays,30);
 assert.equal(threshold.activeBreachRequiresInvestorInitiatedTransaction,true);
 assert.equal(threshold.activeBreachIncludesExchangeAndOffMarketTransfers,true);
 assert.equal(threshold.activeBreachFreezesAllUnitsForDebitAcrossConcernedSif,true);
 assert.equal(threshold.unresolvedBreachAutoRedeemedAtNextBusinessDayNav,true);
 assert.equal(threshold.marketNavDeclineAloneCountsAsActiveBreach,false);
 assert.equal(threshold.applicantPanHoldingsAndAccreditationVerified,false);
 assert.equal(threshold.individualEligibilityOrApprovalVerified,false);
 assert.equal(distributor.officialSebiCircularUrl,
  'https://www.sebi.gov.in/legal/circulars/jul-2026/certification-requirements-for-distribution-of-specialized-investment-funds-sifs-_102986.html');
 assert.equal(distributor.standardRequiredCertificate,'NISM_SERIES_V_D');
 assert.equal(distributor.legacySeriesXiiiCutoff,'2026-09-21');
 assert.equal(distributor.legacyTransitionRequiresValidSeriesVA,true);
 assert.equal(distributor.legacyTransitionEndsAtExistingSeriesXiiiExpiry,true);
 assert.equal(distributor.actualDistributorCertificationVerified,false);
 assert.equal(distributor.signedProviderDistributionEntitlementVerified,false);
 assert.equal(distributor.personalizedAdviceAuthorizationVerified,false);
 const find=profile=>screenExtensionResearchForProfile(canonicalProfile(profile))
  .find(item=>item.id===row.id);
 const below=find({hasLumpSum:true,lumpSumAmount:500000});
 const above=find({hasLumpSum:true,lumpSumAmount:1500000});
 const unknown=find({hasLumpSum:null,lumpSumAmount:null});
 const notice='SIF_REPORTED_LUMP_SUM_NOT_VERIFIED_PAN_AGGREGATE_OR_ACCREDITATION';
 assert.ok(below.screeningReasonCodes.includes(notice));
 assert.ok(!above.screeningReasonCodes.includes(notice));
 assert.ok(!unknown.screeningReasonCodes.includes(notice));
 for(const result of [below,above,unknown]){
  assert.ok(result.screeningReasonCodes.includes('SIF_PAN_AGGREGATE_THRESHOLD_ACTIVE_BREACH_AND_REDEMPTION_REVIEW'));
  assert.ok(result.screeningReasonCodes.includes('SIF_DISTRIBUTOR_CERTIFICATION_AND_SIGNED_ENTITLEMENT_UNVERIFIED'));
  assert.equal(result.profileAssessment,'MISSING_SUITABILITY_EVIDENCE');
  assert.equal(result.scoreAvailable,false);
  assert.equal(result.productQualified,false);
  assert.equal(result.productRiskLevel,null);
 }
 assert.equal(row.actualRetailProductEligible,false);
 assert.equal(row.sourcePermissionVerified,false);
 assert.equal(row.suitabilityRankingPermitted,false);
});


test('SEBI October 2026 private-placement ISIN limits remain issuer-side, not investor approvals',()=>{
 const ids=['catalog_2026_ncd_secured','catalog_2026_ncd_unsecured',
  'catalog_2026_bond_corporate_floating','catalog_2026_bond_corporate_zero'];
 const expectedBuckets=[
  'PLAIN_VANILLA_ONLY_IF_ISSUE_AND_ISSUER_SCOPE_CONFIRMED',
  'PLAIN_VANILLA_ONLY_IF_ISSUE_AND_ISSUER_SCOPE_CONFIRMED',
  'FLOATING_RATE_ONLY_IF_ISSUE_AND_ISSUER_SCOPE_CONFIRMED',
  'ZERO_COUPON_ONLY_IF_ISSUE_AND_ISSUER_SCOPE_CONFIRMED'];
 const rows=new Map(listExtensionResearch().map(row=>[row.id,row]));
 const notices=new Map(screenExtensionResearchForProfile(canonicalProfile())
  .map(row=>[row.id,row]));
 assert.equal(rows.size,95);
 for(const [index,id] of ids.entries()){
  const row=rows.get(id),review=row.debtInstrumentReview.privatePlacementIsinOct2026Review;
  assert.equal(review.circularIssuedOn,'2026-10-07',id);
  assert.equal(review.effectiveFrom,'2026-10-07',id);
  assert.match(review.officialSebiCircularUrl,/^https:\/\/www\.sebi\.gov\.in\/legal\/circulars\/oct-2026\//);
  assert.equal(review.categoryApplicability,expectedBuckets[index],id);
  assert.equal(review.generalIssuerIsinCapPerMaturityFinancialYear,17,id);
  assert.equal(review.plainVanillaIsinCapPerMaturityFinancialYear,12,id);
  assert.equal(review.structuredFrbZcbTier2IsinCapPerMaturityFinancialYear,5,id);
  assert.equal(review.structuredOnlyIssuerIsinCapPerMaturityFinancialYear,12,id);
  assert.equal(review.additionalSection54ecIsinsForAuthorizedIssuers,6,id);
  assert.equal(review.plainVanillaOutstandingThresholdCrore,15000,id);
  assert.equal(review.incrementalIssuanceForExtraIsinCrore,3000,id);
  assert.equal(review.legacyFrbZcbTier2GrandfatheringIsConditional,true,id);
  assert.equal(review.goiServicedEbrAndEsgIsinsExcludedFromCount,true,id);
  for(const field of ['issuerIsinMaturityAndListingVerified','actualPrivatePlacementTermsVerified',
   'individualRetailEligibilityVerified','currentPriceAndCommercialDataRightsVerified',
   'personalizedAdviceAuthorizationVerified','issuerCapIsPersonalInvestmentMinimum',
   'actualSecurityApprovedByCircular'])assert.equal(review[field],false,id+':'+field);
  assert.ok(notices.get(id).screeningReasonCodes.includes(
   'SEBI_OCT_2026_PRIVATE_PLACEMENT_ISIN_CAP_NOT_RETAIL_ELIGIBILITY'),id);
  assert.equal(notices.get(id).productQualified,false,id);
  assert.equal(notices.get(id).scoreAvailable,false,id);
  assert.equal(notices.get(id).productRiskLevel,null,id);
  assert.equal(row.actualRetailProductEligible,false,id);
 }
 for(const id of ['catalog_2026_ncd_unlisted','catalog_2026_bond_convertible',
  'catalog_2026_commercial_paper','catalog_2026_psu_bond_taxable']){
  assert.equal(rows.get(id).debtInstrumentReview.privatePlacementIsinOct2026Review,undefined,id);
  assert.ok(!notices.get(id).screeningReasonCodes.includes(
   'SEBI_OCT_2026_PRIVATE_PLACEMENT_ISIN_CAP_NOT_RETAIL_ELIGIBILITY'),id);
 }
});

test('seven AIF GARUDA filing routes remain distinct from SEBI approval and investor access',()=>{
 const rows=listExtensionResearch().filter(x=>x.aifCategoryAccessReview);
 const screened=screenExtensionResearchForProfile(canonicalProfile({
   riskTolerance:'Conservative',investmentHorizonYears:1,investmentGoals:['Emergency Fund'],
 }));
 assert.equal(rows.length,7);
 assert.equal(new Set(rows.map(x=>x.aifCategoryAccessReview.garudaPpmFilingReview.categoryInterpretation)).size,7);
 for(const row of rows){
   const g=row.aifCategoryAccessReview.garudaPpmFilingReview;
   assert.equal(g.officialSebiCircularUrl,'https://www.sebi.gov.in/legal/circulars/jul-2026/-green-channel-aif-rollout-upon-document-acknowledgement-garuda-mechanism-for-processing-of-placement-memorandum-of-alternative-investment-funds-aifs-filed-with-sebi_103241.html',row.id);
   assert.equal(g.circularIssuedOn,'2026-07-30',row.id);
   assert.equal(g.appliesToPpmsFiledFrom,'2026-07-14',row.id);
   assert.equal(g.regularSchemeLaunchWaitingWorkingDays,10,row.id);
   assert.equal(g.firstSchemeRegistrationRequired,true,row.id);
   assert.equal(g.regularSchemeMerchantBankerDueDiligenceRequired,true,row.id);
   assert.equal(g.aiOnlyAndLvfsCanLaunchUponPpmFiling,true,row.id);
   assert.equal(g.angelFundsCanSolicitFromRegistration,true,row.id);
   assert.equal(g.ppmFilingConstitutesSebiApproval,false,row.id);
   assert.equal(g.categoryStructure,row.aifCategoryAccessReview.categoryStructure,row.id);
   assert.ok(g.riskConsiderations.length>=2&&g.investorAccessConstraints.length>=2,row.id);
   for(const key of ['actualAifSchemeAndPpmVerified','schemeCategoryAndFirstRegistrationVerified',
     'merchantBankerOrManagerUndertakingVerified','individualAccreditationAndKycVerified',
     'currentSchemeTermsAndValuationVerified','commercialDataRightsVerified',
     'personalizedAdviceAuthorizationVerified'])assert.equal(g[key],false,row.id+':'+key);
   const item=screened.find(x=>x.id===row.id);
   assert.ok(item.screeningReasonCodes.includes('AIF_GARUDA_PPM_FILING_AND_LAUNCH_NOT_SEBI_SCHEME_APPROVAL'),row.id);
   assert.ok(item.screeningReasonCodes.includes('AIF_GARUDA_ACTUAL_SCHEME_ROUTE_REGISTRATION_AND_DILIGENCE_UNVERIFIED'),row.id);
   assert.equal(item.productQualified,false,row.id);
   assert.equal(item.scoreAvailable,false,row.id);
   assert.equal(item.productRiskLevel,null,row.id);
 }
 assert.equal(screened.filter(x=>x.productQualified).length,0);
});

test('PMS 2026 future regulations preserve current-framework boundaries and fact-based screening',()=>{
 const rows=new Map(listExtensionResearch().map(row=>[row.id,row]));
 const ids=['catalog_2026_pms_discretionary','catalog_2026_pms_nondiscretionary'];
 const types=['DISCRETIONARY_PMS','NON_DISCRETIONARY_PMS'];
 const screen=months=>new Map(screenExtensionResearchForProfile(canonicalProfile({
   emergencyFundMonths:months,investmentGoals:['Wealth Growth'],
   investmentHorizonYears:10,riskTolerance:'Aggressive',
 })).map(row=>[row.id,row]));
 const zero=screen(0),unknown=screen(null),positive=screen(6);
 for(const [index,id] of ids.entries()){
   const row=rows.get(id),p=row.individualCategoryReview.pmsRegulatoryTransitionReview;
   assert.equal(p.mandateType,types[index],id);
   assert.equal(p.regulationsPublishedOn,'2026-10-12',id);
   assert.equal(p.effectiveFrom,'2027-04-01',id);
   assert.equal(p.reviewedOn,'2026-10-30',id);
   assert.match(p.officialSebiFutureRegulationsUrl,/^https:\/\/www\.sebi\.gov\.in\/legal\/regulations\/oct-2026\//);
   assert.match(p.currentApplicableRegulationsUrl,/portfolio-managers-regulations-2020/);
   assert.ok(p.riskConsiderations.length>=2&&p.investorAccessConstraints.length>=2,id);
   for(const key of ['currentRegisteredManagerAndMandateVerified',
     'individualInvestorMinimumAndExemptionsVerified','currentHoldingsValuationAndExitTermsVerified',
     'commercialMarketDataRightsVerified','personalizedAdviceAuthorizationVerified',
     'futureRegulationsAlreadyInForce'])assert.equal(p[key],false,id+':'+key);
   for(const screened of [zero,unknown,positive]){
     const item=screened.get(id);
     assert.ok(item.screeningReasonCodes.includes('PMS_FUTURE_2026_FRAMEWORK_NOT_CURRENT_MANAGER_OR_CLIENT_APPROVAL'),id);
     assert.equal(item.productQualified,false,id);
     assert.equal(item.scoreAvailable,false,id);
     assert.equal(item.productRiskLevel,null,id);
   }
   const code='RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_PMS_PORTFOLIO_LIQUIDATION_AND_CUSTODY_REVIEW';
   assert.ok(zero.get(id).screeningReasonCodes.includes(code),id);
   assert.ok(!unknown.get(id).screeningReasonCodes.includes(code),id);
   assert.ok(!positive.get(id).screeningReasonCodes.includes(code),id);
 }
 const municipal='catalog_2026_municipal_green';
 const notice='RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_MUNICIPAL_BOND_CREDIT_AND_RESALE_REVIEW';
 assert.ok(zero.get(municipal).screeningReasonCodes.includes(notice));
 assert.ok(!unknown.get(municipal).screeningReasonCodes.includes(notice));
 assert.ok(!positive.get(municipal).screeningReasonCodes.includes(notice));
 assert.equal(zero.size,95);
 assert.equal([...zero.values()].filter(row=>row.productQualified).length,0);
});

test('nine debt-fund archetypes distinguish October 2026 SEBI mutual-fund rules from actual schemes',()=>{
 const rows=listExtensionResearch().filter(row=>row.sebiDebtSchemeStructureReview);
 assert.equal(rows.length,9);
 const screened=new Map(screenExtensionResearchForProfile(canonicalProfile())
  .map(row=>[row.id,row]));
 for(const row of rows){
  const r=row.sebiDebtSchemeStructureReview,e=r.mutualFundRegulationsOct2026Review;
  assert.equal(e.officialSebiRegulationsUrl,'https://www.sebi.gov.in/legal/regulations/oct-2026/securities-and-exchange-board-of-india-mutual-funds-regulations-2026-last-amended-on-october-10-2026-_105356.html',row.id);
  assert.equal(e.regulationsInForceFrom,'2026-04-01',row.id);
  assert.equal(e.regulationsAmendedThrough,'2026-10-10',row.id);
  assert.equal(e.reviewedOn,'2026-10-30',row.id);
  assert.equal(e.schemeArchetype,r.schemeArchetype,row.id);
  assert.equal(e.categoryRiskBoundary,r.riskConsiderations[0],row.id);
  assert.equal(e.categoryAccessBoundary,r.investorAccessConstraints[0],row.id);
  assert.ok(e.riskConsiderations.length>=2&&e.investorAccessConstraints.length>=2,row.id);
  for(const key of ['specificSchemeRegisteredAndAvailableVerified',
   'currentSchemeRiskometerAndPortfolioVerified','investorKycAndTransactionEligibilityVerified',
   'currentNavOrExchangeQuoteAndReuseRightsVerified','personalizedAdviceAuthorizationVerified'])
   assert.equal(e[key],false,row.id+':'+key);
  const result=screened.get(row.id);
  assert.ok(result.screeningReasonCodes.includes(
   'SEBI_OCT_2026_MUTUAL_FUND_REGULATIONS_NOT_SCHEME_RISKOMETER_OR_APPROVAL'),row.id);
  assert.equal(result.productQualified,false,row.id);
  assert.equal(result.scoreAvailable,false,row.id);
  assert.equal(result.productRiskLevel,null,row.id);
  assert.equal(row.actualRetailProductEligible,false,row.id);
 }
 assert.equal(screened.size,95);
 assert.equal([...screened.values()].filter(x=>x.productQualified).length,0);
});

test('RBI 2024 CP aggregate primary limit is not a personal cap or verified retail access',()=>{
 const cp=listExtensionResearch().find(row=>row.id==='catalog_2026_commercial_paper');
 const r=cp.debtInstrumentReview.rbiCpDirectionSpecificReview;
 assert.equal(r.officialRbiDirectionUrl,'https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=12592');
 assert.equal(r.reviewedOn,'2026-10-30');
 assert.equal(r.minimumDenominationInr,500000);
 assert.equal(r.minimumTenorDays,7);
 assert.equal(r.maximumTenorDays,365);
 assert.equal(r.primaryAllIndividualsIncludingHufsAggregateSubscriptionCapPct,25);
 assert.equal(r.aggregateCapIsPerIndividual,false);
 assert.equal(r.cpIssueMinimumRating,'A3');
 assert.equal(r.relatedPartyPrimaryAndSecondaryInvestmentProhibited,true);
 assert.equal(r.issueIsinAndIssuerVerified,false);
 assert.equal(r.investorResidencyRelatedPartyKycAndChannelVerified,false);
 assert.equal(r.currentPriceAndCommercialDataRightsVerified,false);
 assert.equal(r.personalizedAdviceAuthorizationVerified,false);
 assert.ok(r.investorAccessConstraints.some(x=>x.includes('all individuals including HUFs')));
 const make=(hasLumpSum,lumpSumAmount)=>screenExtensionResearchForProfile(canonicalProfile({
  hasLumpSum,lumpSumAmount,investmentGoals:['Wealth Growth'],investmentHorizonYears:10,
  riskTolerance:'Aggressive',emergencyFundMonths:6,
 })).find(row=>row.id==='catalog_2026_commercial_paper');
 const flag='REPORTED_CP_LUMP_SUM_BELOW_5_LAKH_DENOMINATION_REQUIRES_ACCESS_REVIEW_NOT_REJECTION';
 const small=make(true,400000),exact=make(true,500000),missing=make(false,0);
 assert.ok(small.screeningReasonCodes.includes(flag));
 assert.ok(!exact.screeningReasonCodes.includes(flag));
 assert.ok(!missing.screeningReasonCodes.includes(flag));
 for(const row of [small,exact,missing]){
  assert.ok(row.screeningReasonCodes.includes('CP_RBI_2024_25_PERCENT_PRIMARY_LIMIT_IS_ALL_INDIVIDUALS_AND_HUFS_COMBINED'));
  assert.equal(row.profileAssessment,'MISSING_SUITABILITY_EVIDENCE');
  assert.equal(row.productQualified,false);
  assert.equal(row.scoreAvailable,false);
  assert.equal(row.productRiskLevel,null);
 }
});


test('seven AIF categories distinguish October 2026 Regulation 25 from product approval',()=>{
 const rows=listExtensionResearch().filter(row=>row.aifCategoryAccessReview);
 assert.equal(rows.length,7);
 const interpretations=new Set();
 const screen=new Map(screenExtensionResearchForProfile(canonicalProfile({
  investmentGoals:['Wealth Growth'],riskTolerance:'Aggressive',emergencyFundMonths:6,
 })).map(row=>[row.id,row]));
 for(const row of rows){
  const d=row.aifCategoryAccessReview.october2026DisputeResolutionReview;
  assert.equal(d.officialSebiAmendmentUrl,'https://www.sebi.gov.in/legal/regulations/oct-2026/securities-and-exchange-board-of-india-alternative-investment-funds-third-amendment-regulations-2026_105331.html',row.id);
  assert.equal(d.publishedOn,'2026-10-15',row.id);
  assert.equal(d.reviewedOn,'2026-10-30',row.id);
  assert.equal(d.regulationNumber,25,row.id);
  assert.equal(d.categoryStructure,row.aifCategoryAccessReview.categoryStructure,row.id);
  assert.equal(d.includesMediationConciliationOrArbitration,true,row.id);
  for(const field of ['managerOfficerLossDamageAndExpensesChargedToAifProperty',
   'automaticInvestorCompensationGuaranteed','specificFundAndManagerDisputeTermsVerified',
   'actualFundRegistrationAndInvestorEligibilityVerified','currentValuationAndFeesVerified',
   'commercialDataAndAdviceRightsVerified'])assert.equal(d[field],false,row.id+':'+field);
  assert.ok(d.riskConsiderations.length>=2&&d.investorAccessConstraints.length>=2,row.id);
  assert.ok(d.categoryInterpretation.length>=100,row.id);
  interpretations.add(d.categoryInterpretation);
  const result=screen.get(row.id);
  assert.ok(result.screeningReasonCodes.includes('AIF_OCT_2026_REGULATION_25_DISPUTE_PROCEDURE_NOT_GUARANTEED_REMEDY_OR_ELIGIBILITY'),row.id);
  assert.equal(result.profileAssessment,'MISSING_SUITABILITY_EVIDENCE',row.id);
  assert.equal(result.productQualified,false,row.id);
  assert.equal(result.scoreAvailable,false,row.id);
  assert.equal(result.productRiskLevel,null,row.id);
 }
 assert.equal(interpretations.size,7);
 assert.equal(screen.size,95);
 assert.equal([...screen.values()].filter(row=>row.productQualified).length,0);
});


test('nine NPS categories distinguish August 2026 PFRDA scheme presentation from actual access',()=>{
 const rows=listExtensionResearch().filter(row=>row.id.startsWith('catalog_2026_nps_'));
 assert.equal(rows.length,9);
 const screened=new Map(screenExtensionResearchForProfile(canonicalProfile())
  .map(row=>[row.id,row]));
 const interpretations=new Set();
 for(const row of rows){
  const r=(row.npsCommonSchemeReview||row.npsVatsalyaAccessReview).schemePresentation2026Review;
  assert.equal(r.circularNumberPrintedInPdf,'PFRDA/2026/47/REG-PF/10',row.id);
  assert.equal(r.websiteListingShowsNumber,'PFRDA/2026/48/REG-PF/10',row.id);
  assert.equal(r.reviewedOn,'2026-10-30',row.id);
  assert.equal(r.governmentSectorAccountsExcludedFromCircular,true,row.id);
  assert.equal(r.currentSchemeSpecificRiskometerAndNavVerified,false,row.id);
  assert.equal(r.actualPensionFundAndSchemeVerified,false,row.id);
  assert.equal(r.individualPranSectorAndEligibilityVerified,false,row.id);
  assert.equal(r.licensedMarketDataAndAdviceRightsVerified,false,row.id);
  assert.ok(r.riskConsiderations.length>=2&&r.investorAccessConstraints.length>=2,row.id);
  interpretations.add(r.categoryInterpretation);
  const screen=screened.get(row.id);
  assert.ok(screen.screeningReasonCodes.includes('PFRDA_AUG_2026_SCHEME_PRESENTATION_NOT_ACTUAL_RISKOMETER_NAV_OR_ELIGIBILITY'),row.id);
  assert.equal(screen.productQualified,false,row.id);
  assert.equal(screen.scoreAvailable,false,row.id);
  assert.equal(screen.productRiskLevel,null,row.id);
 }
 assert.equal(interpretations.size,9);
 assert.ok(screened.get('catalog_2026_nps_asset_a').screeningReasonCodes.includes(
  'NPS_CLASS_A_NOT_IN_AUG_2026_ACTIVE_CHOICE_TABLE_VERIFY_CURRENT_AVAILABILITY'));
 assert.ok(screened.get('catalog_2026_nps_vatsalya').screeningReasonCodes.includes(
  'NPS_VATSALYA_FOUR_A_SPECIFIC_GUARDIAN_AND_SCHEME_TERMS_REQUIRED'));
 assert.equal([...screened.values()].filter(row=>row.productQualified).length,0);
});

test('RBI 2025 NBFC emergency exception is conditional for both payout and cumulative deposits',()=>{
 const ids=['catalog_2026_nbfc_fd_cumulative','catalog_2026_nbfc_fd_payout'];
 const rows=listExtensionResearch().filter(row=>ids.includes(row.id));
 assert.equal(rows.length,2);
 assert.equal(new Set(rows.map(row=>row.nbfcPublicDepositAccessReview.emergencyPrematurity2025Review.categoryInterpretation)).size,2);
 for(const row of rows){
  const r=row.nbfcPublicDepositAccessReview.emergencyPrematurity2025Review;
  assert.equal(r.officialRbiAmendmentUrl,'https://www.rbi.org.in/Scripts/NotificationUser.aspx?Id=12719&Mode=0');
  assert.equal(r.officialRbiConsolidatedDirectionUrl,'https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=10563');
  assert.equal(r.effectiveFrom,'2025-01-01');
  assert.equal(r.consolidatedDirectionUpdatedThrough,'2025-02-27');
  assert.equal(r.reviewedOn,'2026-10-30');
  assert.equal(r.tinyDepositAggregateCeilingInr,10000);
  assert.equal(r.ordinaryDepositEarlyPrincipalLimitPct,50);
  assert.equal(r.ordinaryDepositEarlyPrincipalAbsoluteCapInr,500000);
  assert.equal(r.nonProblemNbfcAndIssuerSatisfactionRequired,true);
  assert.equal(r.criticalIllnessMayPermitFullPrincipalBeforeThreeMonths,true);
  assert.equal(r.beforeThreeMonthsEmergencyRepaymentWithoutInterest,true);
  for(const key of ['routineOnDemandWithdrawalEstablished','specificIssuerNonProblemStatusVerified',
   'depositorEmergencyAndContractEligibilityVerified','actualIssuerDepositRatingAndTermsVerified',
   'currentRateAndCommercialDataRightsVerified','personalizedAdviceAuthorizationVerified'])
   assert.equal(r[key],false,row.id+':'+key);
  assert.ok(r.riskConsiderations.length>=2&&r.investorAccessConstraints.length>=2);
 }
 const make=emergencyFundMonths=>new Map(screenExtensionResearchForProfile(canonicalProfile({
  investmentGoals:['Wealth Growth'],investmentHorizonYears:10,riskTolerance:'Moderate',emergencyFundMonths,
 })).map(row=>[row.id,row]));
 const zero=make(0),positive=make(6),missing=make(undefined);
 const notice='RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_NBFC_UNINSURED_CREDIT_AND_PREMATURITY_REVIEW';
 for(const id of ids){
  assert.ok(zero.get(id).screeningReasonCodes.includes(notice));
  assert.ok(!positive.get(id).screeningReasonCodes.includes(notice));
  assert.ok(!missing.get(id).screeningReasonCodes.includes(notice));
  for(const screened of [zero.get(id),positive.get(id),missing.get(id)]){
   assert.ok(screened.screeningReasonCodes.includes('RBI_2025_NBFC_EMERGENCY_PREMATURITY_IS_CONDITIONAL_NOT_ON_DEMAND_LIQUIDITY'));
   assert.equal(screened.productQualified,false);
   assert.equal(screened.scoreAvailable,false);
   assert.equal(screened.productRiskLevel,null);
  }
 }
 assert.equal(zero.size,95);
 assert.equal([...zero.values()].filter(row=>row.productQualified).length,0);
});

test('four RBI Retail Direct categories retain distinct historical auction evidence without approving instruments',()=>{
 const ids=["catalog_2026_tbill_91","catalog_2026_tbill_182","catalog_2026_tbill_364","catalog_2026_sdl_dated"];
 const rows=listExtensionResearch().filter(row=>ids.includes(row.id));
 assert.equal(rows.length,4);
 const interpretations=new Set();
 const screened=new Map(screenExtensionResearchForProfile(canonicalProfile()).map(row=>[row.id,row]));
 for(const row of rows){
  const e=row.rbiRetailDirectAccessReview.retailDirectAuctionMechanics2021Review;
  assert.equal(e.officialRbiRetailDirectFaqUrl,'https://www.rbi.org.in/Scripts/FAQView.aspx?Id=145');
  assert.equal(e.reviewedOn,'2026-10-30');
  assert.equal(e.minimumFigureAsOf,'2021-11-12');
  assert.equal(e.historicalFaqMinimumInvestmentInr,10000);
  assert.equal(e.historicalMinimumIsVerifiedCurrentIssueMinimum,false);
  assert.equal(e.primaryAuctionBiddingIsNoncompetitiveOnly,true);
  assert.equal(e.primaryAuctionAllotmentPriceUnknownAtBid,true);
  assert.equal(e.bidsRequireFundingBeforeRbiSubmission,true);
  assert.equal(e.partialAuctionAllotmentPossible,true);
  assert.equal(e.zeroCouponDiscountCashFlow,row.id.startsWith('catalog_2026_tbill_'));
  for(const field of ['actualAuctionAndIssueIsinVerified','applicantRdgKycAndChannelVerified',
   'currentMinimumAndBidTermsVerified','currentExecutablePriceAndResaleLiquidityVerified',
   'commercialMarketDataAndAdviceRightsVerified'])assert.equal(e[field],false,row.id+':'+field);
  assert.ok(e.riskConsiderations.length>=2&&e.investorAccessConstraints.length>=2);
  interpretations.add(e.categoryInterpretation);
  const item=screened.get(row.id);
  assert.ok(item.screeningReasonCodes.includes('RBI_2021_RETAIL_DIRECT_MINIMUM_HISTORICAL_NOT_CURRENT_OFFER_APPROVAL'));
  assert.ok(item.screeningReasonCodes.includes('RBI_RETAIL_DIRECT_NONCOMPETITIVE_AUCTION_PRICE_FUNDING_AND_ALLOTMENT_REVIEW'));
  assert.equal(item.productQualified,false);
  assert.equal(item.scoreAvailable,false);
  assert.equal(item.productRiskLevel,null);
 }
 assert.equal(interpretations.size,4);
 assert.equal(screened.size,95);
});
test('historical Retail Direct minimum triggers only a non-ranking notice for recorded smaller lump sums',()=>{
 const ids=["catalog_2026_tbill_91","catalog_2026_tbill_182","catalog_2026_tbill_364","catalog_2026_sdl_dated"];
 const make=(hasLumpSum,lumpSumAmount)=>new Map(screenExtensionResearchForProfile(canonicalProfile({
  hasLumpSum,lumpSumAmount,investmentGoals:['Wealth Growth'],investmentHorizonYears:10,
  riskTolerance:'Moderate',emergencyFundMonths:6,
 })).map(row=>[row.id,row]));
 const small=make(true,9000),atReference=make(true,10000),missing=make(false,0);
 const flag='REPORTED_LUMP_SUM_BELOW_HISTORICAL_RETAIL_DIRECT_MINIMUM_REQUIRES_CURRENT_ACCESS_REVIEW_NOT_REJECTION';
 for(const id of ids){
  assert.ok(small.get(id).screeningReasonCodes.includes(flag),id);
  assert.ok(!atReference.get(id).screeningReasonCodes.includes(flag),id);
  assert.ok(!missing.get(id).screeningReasonCodes.includes(flag),id);
  for(const rows of [small,atReference,missing]){
   assert.equal(rows.get(id).productQualified,false);
   assert.equal(rows.get(id).scoreAvailable,false);
   assert.equal(rows.get(id).productRiskLevel,null);
  }
 }
 assert.equal([...small.values()].filter(row=>row.productQualified).length,0);
});

test('October 2026 SM REIT trust registration and draft scheme filings remain distinct, unqualified evidence',()=>{
 const id='catalog_2026_sm_reit_scheme';
 const get=()=>listExtensionResearch().find(row=>row.id===id);
 const row=get(),review=row.individualCategoryReview.smReitTrustAndDraft2026Review;
 assert.equal(review.registryHeaderAsOf,'2025-04-01');
 assert.equal(review.registryIncludesTrustRegistrationDatedOn,'2026-10-12');
 assert.equal(review.draftSchemeFilingDateObserved,'2026-10-23');
 assert.equal(review.registryHeaderConflictsWithLaterDisplayedEntries,true);
 assert.match(review.officialSebiRegisteredTrustsUrl,/sebi\.gov\.in\/sebiweb\/other/);
 assert.match(review.officialSebiSmReitDraftFilingsUrl,/sebi\.gov\.in\/sebiweb\/home/);
 assert.ok(review.riskConsiderations.length>=2);
 assert.ok(review.investorAccessConstraints.length>=2);
 for(const key of ['currentTrustStatusIndependentlyReconciled','finalSchemeOfferAndListingVerified',
  'actualSchemeIsinAndUnitPriceVerified','individualDematKycAndLotEligibilityVerified',
  'propertyValuationDistributionsAndSchemeRiskVerified','commercialMarketDataRightsVerified',
  'investmentAdviceAuthorizationVerified'])assert.equal(review[key],false,key);
 const screen=goals=>new Map(screenExtensionResearchForProfile(canonicalProfile({
  investmentGoals:goals,investmentHorizonYears:10,riskTolerance:'Moderate',emergencyFundMonths:6,
 })).map(item=>[item.id,item]));
 const ordinary=screen(['Wealth Growth']),emergency=screen(['Emergency Fund']);
 for(const group of [ordinary,emergency]){
  const item=group.get(id);
  assert.ok(item.screeningReasonCodes.includes('SM_REIT_OCT_2026_TRUST_REGISTRATION_NOT_A_VERIFIED_LISTED_SCHEME'));
  assert.ok(item.screeningReasonCodes.includes('SM_REIT_OCT_2026_DRAFT_FILINGS_NOT_FINAL_OFFER_OR_RETAIL_ACCESS'));
  assert.equal(item.productQualified,false);
  assert.equal(item.scoreAvailable,false);
  assert.equal(item.productRiskLevel,null);
 }
 const goalNotice='EMERGENCY_FUND_GOAL_REQUIRES_SM_REIT_SCHEME_UNIT_EXIT_AND_SETTLEMENT_REVIEW';
 assert.ok(!ordinary.get(id).screeningReasonCodes.includes(goalNotice));
 assert.ok(emergency.get(id).screeningReasonCodes.includes(goalNotice));
 assert.equal(ordinary.size,95);
 assert.equal([...ordinary.values()].filter(item=>item.productQualified).length,0);
 review.finalSchemeOfferAndListingVerified=true;
 review.riskConsiderations.push('FABRICATED LIQUIDITY');
 const clean=get().individualCategoryReview.smReitTrustAndDraft2026Review;
 assert.equal(clean.finalSchemeOfferAndListingVerified,false);
 assert.ok(!clean.riskConsiderations.includes('FABRICATED LIQUIDITY'));
});

test('11 ETF archetypes separate September 2026 trading-band rules from quotes and eligibility',()=>{
 const ids=["catalog_2026_etf_nifty100","catalog_2026_etf_nifty500","catalog_2026_etf_smallcap250","catalog_2026_etf_nifty50_equal","catalog_2026_etf_nifty100_equal","catalog_2026_etf_nifty200_quality","catalog_2026_etf_nifty500_lowvol","catalog_2026_etf_nifty500_momentum","catalog_2026_etf_india_defence","catalog_2026_etf_india_consumption","catalog_2026_gsec_debt_etf"];
 const rows=listExtensionResearch();
 const reviews=rows.filter(row=>row.etfBenchmarkReview?.sebiEtfSecondaryMarket2026Review
  ||row.sebiDebtSchemeStructureReview?.sebiEtfSecondaryMarket2026Review);
 assert.equal(reviews.length,11);
 assert.deepEqual(reviews.map(row=>row.id).sort(),[...ids].sort());
 const get=(months,goals)=>new Map(screenExtensionResearchForProfile(canonicalProfile({
  emergencyFundMonths:months,investmentGoals:goals,investmentHorizonYears:10,riskTolerance:'Aggressive',
 })).map(row=>[row.id,row]));
 const zero=get(0,['Wealth Growth']),missing=get(null,['Wealth Growth']);
 const positive=get(6,['Wealth Growth']),goal=get(6,['Emergency Fund']);
 const interpretations=new Set();
 for(const row of reviews){
  const e=row.etfBenchmarkReview?.sebiEtfSecondaryMarket2026Review
   ||row.sebiDebtSchemeStructureReview?.sebiEtfSecondaryMarket2026Review;
  assert.equal(e.originalCircularIssuedOn,'2026-06-15',row.id);
  assert.equal(e.timelineExtensionIssuedOn,'2026-08-28',row.id);
  assert.equal(e.originalImplementationDate,'2026-09-01',row.id);
  assert.equal(e.revisedFrameworkEffectiveFrom,'2026-09-07',row.id);
  assert.equal(e.reviewedOn,'2026-10-30',row.id);
  assert.equal(e.categoryClass,row.id==='catalog_2026_gsec_debt_etf'?'DEBT_ETF':'EQUITY_ETF',row.id);
  assert.equal(e.initialDynamicBandPercent,10,row.id);
  assert.equal(e.maximumFlexedBandPercent,20,row.id);
  assert.equal(e.proposedTMinusOneNavBaseFrom,'2027-04-01',row.id);
  assert.match(e.officialSebiTradingNormsCircularUrl,/sebi\.gov\.in\/legal\/circulars\/jun-2026/);
  assert.match(e.officialSebiTimelineExtensionUrl,/sebi\.gov\.in\/legal\/circulars\/aug-2026/);
  assert.ok(e.riskConsiderations.length>=2&&e.investorAccessConstraints.length>=2,row.id);
  interpretations.add(e.categoryInterpretation);
  for(const field of ['actualListedEtfAndIsinVerified','actualExchangeImplementationAndOrderbookVerified',
   'liveExecutableBidAskAndNavVerified','individualBrokerDematKycAndRetailAccessVerified',
   'commercialQuoteRedistributionRightsVerified','schemeRiskometerAndSuitabilityVerified',
   'investmentAdviceAuthorizationVerified','priceBandsGuaranteeExecutionOrLimitInvestmentLoss',
   'futureNavBaseOperationallyVerified'])assert.equal(e[field],false,row.id+' '+field);
  for(const group of [zero,missing,positive,goal]){
   const item=group.get(row.id);
   assert.ok(item.screeningReasonCodes.includes('SEBI_SEPT_2026_ETF_DYNAMIC_PRICE_BANDS_NOT_SCHEME_RISKOMETER_OR_EXECUTABLE_QUOTE'),row.id);
   assert.ok(item.screeningReasonCodes.includes('ETF_T_MINUS_ONE_PRICE_BAND_BASE_NOT_LIVE_BID_ASK_OR_NAV'),row.id);
   assert.equal(item.productQualified,false,row.id);
   assert.equal(item.scoreAvailable,false,row.id);
   assert.equal(item.productRiskLevel,null,row.id);
  }
  const zeroFlag='RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_ETF_PRICE_BAND_EXIT_AND_SETTLEMENT_REVIEW';
  const goalFlag='EMERGENCY_FUND_GOAL_REQUIRES_ETF_EXCHANGE_EXECUTION_AND_ORDERBOOK_REVIEW';
  assert.ok(zero.get(row.id).screeningReasonCodes.includes(zeroFlag),row.id);
  assert.ok(!missing.get(row.id).screeningReasonCodes.includes(zeroFlag),row.id);
  assert.ok(!positive.get(row.id).screeningReasonCodes.includes(zeroFlag),row.id);
  assert.ok(goal.get(row.id).screeningReasonCodes.includes(goalFlag),row.id);
  assert.ok(!positive.get(row.id).screeningReasonCodes.includes(goalFlag),row.id);
 }
 assert.equal(interpretations.size,11);
 assert.equal(zero.size,95);
 assert.equal([...zero.values()].filter(row=>row.productQualified).length,0);
});

test('silver ETF FoF has separate current scheme-risk and October 2026 regulatory boundaries',()=>{
 const id='catalog_2026_silver_fof';
 const get=()=>listExtensionResearch().find(row=>row.id===id);
 const evidence=get().preciousMetalsCategoryReview.october2026MutualFundRiskDisclosureReview;
 assert.ok(get().scenarioDescription.includes('Silver ETF Fund of Funds Strategy'));
 assert.equal(evidence.regulationsInForceFrom,'2026-04-01');
 assert.equal(evidence.regulationsLastAmendedOn,'2026-10-10');
 assert.equal(evidence.riskometerCircularIssuedOn,'2024-11-05');
 assert.equal(evidence.riskometerCircularEffectiveFrom,'2024-12-05');
 assert.equal(evidence.reviewedOn,'2026-10-30');
 assert.match(evidence.officialSebiRegulationsUrl,/sebi\.gov\.in\/legal\/regulations\/oct-2026/);
 assert.match(evidence.officialSebiRiskometerDisclosureCircularUrl,/sebi\.gov\.in\/legal\/circulars\/nov-2024/);
 assert.equal(evidence.schemeAndUnderlyingRiskometersMustNotBeConflated,true);
 assert.equal(evidence.directAndRegularPlanExpenseDisclosuresAreSeparate,true);
 assert.equal(evidence.schemeRiskometerChangesRequireSchemeHolderNotice,true);
 for(const field of ['actualFoFSchemeAndPlanVerified','actualUnderlyingSilverEtfAndHoldingsVerified',
  'currentFoFSchemeRiskometerVerified','currentUnderlyingEtfRiskometerVerified',
  'currentFoFNavFeesAndExitTermsVerified','investorKycAndRetailAccessVerified',
  'commercialNavAndQuoteReuseRightsVerified','personalizedAdviceAuthorizationVerified'])
  assert.equal(evidence[field],false,field);
 const make=options=>new Map(screenExtensionResearchForProfile(canonicalProfile({
  investmentGoals:['Wealth Growth'],investmentHorizonYears:10,
  riskTolerance:'Moderate',emergencyFundMonths:null,...options,
 })).map(row=>[row.id,row]));
 const ordinary=make({}),short=make({investmentHorizonYears:2}),
  emergency=make({investmentGoals:['Emergency Fund']}),
  conservative=make({riskTolerance:'Conservative'});
 const common=[
  'SEBI_OCT_2026_MF_REGULATIONS_NOT_SILVER_FOF_SCHEME_APPROVAL',
  'SILVER_FOF_AND_UNDERLYING_ETF_REQUIRE_SEPARATE_CURRENT_RISKOMETERS_AND_FEE_REVIEW',
 ];
 for(const group of [ordinary,short,emergency,conservative]){
  const row=group.get(id);
  for(const flag of common)assert.ok(row.screeningReasonCodes.includes(flag),flag);
  assert.equal(row.productQualified,false);
  assert.equal(row.scoreAvailable,false);
  assert.equal(row.productRiskLevel,null);
  assert.equal(group.size,95);
 }
 // A silver FoF has scheme/underlying ETF risks, not direct bullion assay/custody.
 const silverResearch=get().preciousMetalsCategoryReview;
 assert.match(silverResearch.financialProfileScreening,/underlying ETF tracking/);
 // The explicit negation is correct: physical-custody warnings must not be applied to FoF units.
 assert.match(silverResearch.financialProfileScreening,/custody warnings do not describe FoF units\./);
 assert.doesNotMatch(silverResearch.financialProfileScreening,/show[^.]*custody warnings/i);
 const schemeBoundary='SILVER_FOF_SCHEME_UNDERLYING_ETF_NAV_AND_RIGHTS_UNVERIFIED';
 const physicalBoundary='PHYSICAL_PRECIOUS_METALS_ASSAY_CUSTODY_AND_RESALE_TERMS_UNVERIFIED';
 const physical='PHYSICAL_BULLION_ASSAY_DEALER_SPREAD_CUSTODY_AND_RESALE_UNVERIFIED';
 for(const group of [ordinary,short,emergency,conservative]){
  assert.ok(group.get(id).screeningReasonCodes.includes(schemeBoundary));
  assert.ok(!group.get(id).screeningReasonCodes.includes(physicalBoundary));
  assert.ok(!group.get(id).screeningReasonCodes.includes(physical));
  for(const physicalId of ['catalog_2026_physical_gold_bullion',
   'catalog_2026_physical_silver_bullion']){
   assert.ok(group.get(physicalId).screeningReasonCodes.includes(physicalBoundary));
   assert.ok(group.get(physicalId).screeningReasonCodes.includes(physical));
   assert.ok(!group.get(physicalId).screeningReasonCodes.includes(schemeBoundary));
  }
 }
 const horizon='SHORT_HORIZON_REQUIRES_SILVER_FOF_VOLATILITY_AND_REDEMPTION_SETTLEMENT_REVIEW';
 const goal='EMERGENCY_FUND_GOAL_REQUIRES_SILVER_FOF_SCHEME_EXIT_AND_NAV_REVIEW';
 const risk='CONSERVATIVE_PROFILE_REQUIRES_SILVER_FOF_COMMODITY_LOSS_CAPACITY_REVIEW';
 assert.ok(!ordinary.get(id).screeningReasonCodes.includes(horizon));
 assert.ok(!ordinary.get(id).screeningReasonCodes.includes(goal));
 assert.ok(!ordinary.get(id).screeningReasonCodes.includes(risk));
 assert.ok(short.get(id).screeningReasonCodes.includes(horizon));
 assert.ok(emergency.get(id).screeningReasonCodes.includes(goal));
 assert.ok(conservative.get(id).screeningReasonCodes.includes(risk));
 const profile=canonicalProfile({investmentGoals:['Wealth Growth']});
 const result=buildRiskShortlist({profile,instruments:runPipeline(profile).instruments});
 const item=result.catalogAssessments.find(row=>row.id===id);
 assert.equal(item.productQualified,false);
 assert.equal(item.scoreAvailable,false);
 assert.ok(Object.values(result.groups).flat().every(row=>row.canonicalParentId!==id));
 evidence.currentFoFSchemeRiskometerVerified=true;
 evidence.riskConsiderations.push('FORGED');
 const fresh=get().preciousMetalsCategoryReview.october2026MutualFundRiskDisclosureReview;
 assert.equal(fresh.currentFoFSchemeRiskometerVerified,false);
 assert.ok(!fresh.riskConsiderations.includes('FORGED'));
});

// Official publisher identity is distinct from regulatory rule evidence and
// cannot turn any of the 95 research archetypes into a qualified product.
test('all 95 source publishers and exact evidence scopes remain explicit and fail closed',()=>{
 const rows=listExtensionResearch();
 const screened=new Map(screenExtensionResearchForProfile(canonicalProfile()).map(row=>[row.id,row]));
 const counts={};
 const notices={
  GOVERNMENT_SCHEME_OPERATOR:'OFFICIAL_SCHEME_LISTING_NOT_INDIVIDUAL_ACCOUNT_OR_CURRENT_TERMS',
  GOVERNMENT_POLICY_PUBLISHER:'GOVERNMENT_GREEN_BOND_FRAMEWORK_NOT_A_SPECIFIC_ISSUE_OR_IMPACT_APPROVAL',
  DEPOSIT_INSURANCE_AUTHORITY:'DICGC_GENERAL_COVERAGE_NOT_A_VERIFIED_BANK_OR_ACCOUNT',
  REGULATOR_INVESTOR_EDUCATION:'SEBI_INVESTOR_EDUCATION_NOT_AN_ISSUER_OFFER_OR_APPROVAL',
  INDEX_PROVIDER_METHODOLOGY:'INDEX_PROVIDER_METHODOLOGY_NOT_A_SEBI_SCHEME_APPROVAL_OR_RISKOMETER',
  NATIONAL_STANDARDS_BODY:'BIS_GENERAL_STANDARDS_NOT_A_SPECIFIC_BULLION_CERTIFICATION',
 };
 assert.equal(rows.length,95);
 assert.equal(screened.size,95);
 for(const row of rows){
  const kind=getFrameworkSourcePublisherType(row.verifiedPublicFrameworkFact.officialSourceUrl);
  assert.ok(kind,row.id);
  counts[kind]=(counts[kind]||0)+1;
  const item=screened.get(row.id);
  assert.equal(item.frameworkPublisherType,kind,row.id);
  assert.equal(item.evidenceScope,row.verifiedPublicFrameworkFact.scope,row.id);
  if(notices[kind])assert.ok(item.screeningReasonCodes.includes(notices[kind]),row.id);
  assert.equal(item.productQualified,false,row.id);
  assert.equal(item.scoreAvailable,false,row.id);
  assert.equal(item.productRiskLevel,null,row.id);
 }
 assert.deepEqual(counts,{
  GOVERNMENT_SCHEME_OPERATOR:4,
  FINANCIAL_REGULATOR:45,
  GOVERNMENT_POLICY_PUBLISHER:1,
  DEPOSIT_INSURANCE_AUTHORITY:7,
  INDEX_PROVIDER_METHODOLOGY:24,
  REGULATOR_INVESTOR_EDUCATION:12,
  NATIONAL_STANDARDS_BODY:2,
 });
 assert.equal(getFrameworkSourcePublisherType('https://www.niftyindices.com.attacker.test/index'),null);
 assert.equal(getFrameworkSourcePublisherType('https://investor.sebi.gov.in@attacker.test/bonds'),null);
 assert.equal(getFrameworkSourcePublisherType('http://www.sebi.gov.in/legal/circulars'),null);
});

// The updated BIS silver jewellery hallmarking standard cannot be used to
// certify a bullion bar, and does not change product recommendation gates.
test('BIS 2025 silver jewellery HUID scope does not certify physical silver bullion',()=>{
 const silver=listExtensionResearch().find(row=>row.id==='catalog_2026_physical_silver_bullion');
 const review=silver.preciousMetalsCategoryReview.silverHallmarking2025ScopeReview;
 assert.equal(review.updatedSilverJewelleryStandard,'IS 2112:2025');
 assert.equal(review.supersededSilverJewelleryStandard,'IS 2112:2014');
 assert.equal(review.voluntarySilverJewelleryHuidEffectiveFrom,'2025-09-01');
 assert.equal(review.appliesToSilverJewelleryAndArticlesOnly,true);
 assert.equal(review.establishesSilverBullionBarHallmarkCertification,false);
 assert.equal(review.actualSilverBullionAssayVerified,false);
 assert.equal(review.commercialDataRightsVerified,false);
 assert.ok(review.riskConsiderations.length>=2 && review.investorAccessConstraints.length>=2);
 const screened=new Map(screenExtensionResearchForProfile(canonicalProfile()).map(row=>[row.id,row]));
 const warning='BIS_2025_SILVER_JEWELLERY_HUID_NOT_BULLION_BAR_ASSAY_OR_APPROVAL';
 assert.ok(screened.get('catalog_2026_physical_silver_bullion').screeningReasonCodes.includes(warning));
 assert.ok(!screened.get('catalog_2026_physical_gold_bullion').screeningReasonCodes.includes(warning));
 assert.ok(!screened.get('catalog_2026_silver_fof').screeningReasonCodes.includes(warning));
 assert.equal(screened.get('catalog_2026_physical_silver_bullion').productQualified,false);
 assert.equal(screened.get('catalog_2026_physical_silver_bullion').scoreAvailable,false);
 assert.equal(screened.get('catalog_2026_physical_silver_bullion').productRiskLevel,null);
});

test('RBI May 2025 Gazette distinguishes coupon/principal central STRIPS from state-only outstanding tests',()=>{
 const ids=['catalog_2026_gsec_coupon_strip','catalog_2026_gsec_principal_strip'];
 const rows=new Map(listExtensionResearch().map(row=>[row.id,row]));
 const official='https://egazette.gov.in/WriteReadData/2025/263478.pdf';
 const make=options=>new Map(screenExtensionResearchForProfile(canonicalProfile({
  investmentHorizonYears:10,investmentGoals:['Wealth Growth'],
  emergencyFundMonths:null,riskTolerance:'Moderate',...options,
 })).map(row=>[row.id,row]));
 const ordinary=make({}),short=make({investmentHorizonYears:2});
 const goal=make({investmentGoals:['Emergency Fund']});
 const zero=make({emergencyFundMonths:0});
 const positive=make({emergencyFundMonths:6});
 for(const [i,id] of ids.entries()){
  const row=rows.get(id),e=row.governmentBondStructureReview.centralGsecStrips2025GazetteReview;
  assert.equal(e.officialGazetteUrl,official,id);
  assert.equal(e.gazetteNotificationDated,'2025-05-29',id);
  assert.equal(e.gazettePublishedOn,'2025-05-30',id);
  assert.equal(e.reviewedOn,'2026-10-31',id);
  assert.equal(e.separatedCashFlowType,i===0?'COUPON_PAYMENT':'PRINCIPAL_REPAYMENT',id);
  assert.equal(e.centralGovernmentFixedCouponSlrEligibleAndTransferableRequired,true,id);
  assert.equal(e.stateOnlyFourteenYearAndThousandCroreThresholdNotCentralInvestorMinimum,true,id);
  assert.equal(e.eKuberReplacesPdoNdsInAmendedText,true,id);
  assert.equal(row.standardCapitalReferenceInr,null,id);
  assert.ok(e.riskConsiderations.length>=2&&e.investorAccessConstraints.length>=2,id);
  for(const key of ['actualUnderlyingIsinAndStripIsinVerified','actualCashFlowMaturityAndPriceVerified',
   'specificCustodianTradingChannelAndKycVerified','investorEligibilityAndPermissionsVerified',
   'currentMarketQuoteAndCommercialRightsVerified','taxAndPersonalizedAdviceVerified'])
   assert.equal(e[key],false,id+key);
  for(const all of [ordinary,short,goal,zero,positive]){
   const item=all.get(id);
   assert.ok(item.screeningReasonCodes.includes(
    'RBI_2025_CENTRAL_STRIP_GAZETTE_NOT_SPECIFIC_ISIN_OR_RETAIL_ACCESS'),id);
   assert.ok(item.screeningReasonCodes.includes(
    'SGS_1000_CRORE_OUTSTANDING_TEST_NOT_CENTRAL_STRIP_INVESTOR_MINIMUM'),id);
   assert.equal(item.profileAssessment,'MISSING_SUITABILITY_EVIDENCE',id);
   assert.equal(item.productQualified,false,id);
   assert.equal(item.scoreAvailable,false,id);
   assert.equal(item.productRiskLevel,null,id);
  }
  const horizon='SHORT_HORIZON_REQUIRES_CENTRAL_STRIP_MATURITY_AND_DISCOUNT_PRICE_REVIEW';
  const emergency='EMERGENCY_FUND_GOAL_REQUIRES_CENTRAL_STRIP_SINGLE_CASH_FLOW_AND_EXIT_REVIEW';
  const buffer='RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_CENTRAL_STRIP_CUSTODY_AND_EXIT_REVIEW';
  assert.ok(short.get(id).screeningReasonCodes.includes(horizon),id);
  assert.ok(!ordinary.get(id).screeningReasonCodes.includes(horizon),id);
  assert.ok(goal.get(id).screeningReasonCodes.includes(emergency),id);
  assert.ok(!ordinary.get(id).screeningReasonCodes.includes(emergency),id);
  assert.ok(zero.get(id).screeningReasonCodes.includes(buffer),id);
  assert.ok(!positive.get(id).screeningReasonCodes.includes(buffer),id);
  assert.ok(!ordinary.get(id).screeningReasonCodes.includes(buffer),id);
 }
 for(const id of ['catalog_2026_sdl_coupon_strip','catalog_2026_sdl_principal_strip',
  'catalog_2026_gsec_floating']){
  assert.equal(rows.get(id).governmentBondStructureReview?.centralGsecStrips2025GazetteReview,undefined,id);
  assert.ok(!ordinary.get(id).screeningReasonCodes.includes(
   'SGS_1000_CRORE_OUTSTANDING_TEST_NOT_CENTRAL_STRIP_INVESTOR_MINIMUM'),id);
 }
 assert.equal(ordinary.size,95);
 assert.equal([...ordinary.values()].filter(x=>x.productQualified).length,0);
});

test('municipal green bonds separate SEBI 2022/2026 green issuance and reviewer frameworks from actual retail issue evidence',()=>{
 const rows=listExtensionResearch();
 const id='catalog_2026_municipal_green';
 const municipal=rows.find(row=>row.id===id);
 const review=municipal.individualCategoryReview.municipalGreenDisclosure2026Review;
 assert.equal(review.officialSebiMunicipalGreenCircularUrl,'https://www.sebi.gov.in/legal/circulars/nov-2022/issue-of-green-debt-securities-by-an-issuer-under-securities-and-exchange-board-of-india-issue-and-listing-of-municipal-debt-securities-regulations-2015_65404.html');
 assert.equal(review.circularIssuedOn,'2022-11-24');
 assert.equal(review.officialSebiGreenReviewerCircularUrl,'https://www.sebi.gov.in/legal/circulars/feb-2026/revised-norms-for-appointment-of-an-independent-third-party-reviewer-certifier-for-green-debt-security_100043.html');
 assert.equal(review.greenReviewerCircularIssuedOn,'2026-02-27');
 assert.equal(review.officialSebiMunicipalDebtRegulationsUrl,'https://www.sebi.gov.in/legal/regulations/jul-2026/securities-and-exchange-board-of-india-issue-and-listing-of-municipal-debt-securities-regulations-2015-last-amendment-on-july-08-2026-_102918.html');
 assert.equal(review.regulationsAmendedThrough,'2026-07-08');
 assert.equal(review.reviewedOn,'2026-10-31');
 assert.equal(review.greenLabelDoesNotEstablishSovereignGuaranteeOrTaxExemption,true);
 for(const key of ['actualMunicipalIssuerAndIsinVerified',
  'actualIssueGreenProceedsAndIndependentReviewVerified',
  'issuerCreditRatingRepaymentAndOfferTermsVerified',
  'currentListingAndIndividualRetailAccessVerified',
  'currentPriceLiquidityAndCommercialDataRightsVerified',
  'fiscalYearTaxAndPersonalizedAdviceAuthorizationVerified'])assert.equal(review[key],false,key);
 assert.ok(review.riskConsiderations.length>=2);
 assert.ok(review.investorAccessConstraints.length>=2);
 assert.equal(rows.filter(row=>row.individualCategoryReview?.municipalGreenDisclosure2026Review).length,1);
 const screen=overrides=>screenExtensionResearchForProfile(canonicalProfile(overrides))
  .find(row=>row.id===id);
 const baseline=screen({});
 const short=screen({investmentHorizonYears:2});
 const emergency=screen({investmentGoals:['Emergency Fund']});
 const tax=screen({investmentGoals:['Tax Saving']});
 const conservative=screen({riskTolerance:'Conservative'});
 const common='SEBI_2022_MUNICIPAL_GREEN_AND_2026_REVIEWER_CIRCULARS_NOT_ISSUE_CERTIFICATION';
 assert.ok(baseline.screeningReasonCodes.includes(common));
 const checks=[
  ['SHORT_HORIZON_REQUIRES_MUNICIPAL_GREEN_MATURITY_AND_RESALE_LIQUIDITY_REVIEW',short],
  ['EMERGENCY_FUND_GOAL_REQUIRES_MUNICIPAL_GREEN_BOND_EXIT_AND_SETTLEMENT_REVIEW',emergency],
  ['TAX_SAVING_GOAL_REQUIRES_MUNICIPAL_GREEN_ISSUE_AND_FY_TAX_RULE_REVIEW',tax],
  ['CONSERVATIVE_PROFILE_REQUIRES_MUNICIPAL_GREEN_ISSUER_DEFAULT_AND_PRICE_LOSS_REVIEW',conservative],
 ];
 for(const [notice,matched] of checks){
  assert.ok(matched.screeningReasonCodes.includes(notice),notice);
  assert.ok(!baseline.screeningReasonCodes.includes(notice),notice);
 }
 for(const item of [baseline,short,emergency,tax,conservative]){
  assert.equal(item.profileAssessment,'MISSING_SUITABILITY_EVIDENCE');
  assert.equal(item.productQualified,false);
  assert.equal(item.scoreAvailable,false);
  assert.equal(item.productRiskLevel,null);
 }
});

test('SEBI historical PMS FAQ distinguishes manager authority without qualifying clients or products',()=>{
 const ids=['catalog_2026_pms_discretionary','catalog_2026_pms_nondiscretionary'];
 const rows=new Map(listExtensionResearch().map(row=>[row.id,row]));
 const pick=overrides=>new Map(screenExtensionResearchForProfile(canonicalProfile({
   investmentGoals:['Wealth Growth'],riskTolerance:'Aggressive',
   investmentHorizonYears:10,emergencyFundMonths:null,...overrides,
 })).map(row=>[row.id,row]));
 const baseline=pick({});
 const short=pick({investmentHorizonYears:2});
 const emergency=pick({investmentGoals:['Emergency Fund']});
 const conservative=pick({riskTolerance:'Conservative'});
 const unknown=pick({emergencyFundMonths:null});
 for(const [index,id] of ids.entries()){
   const review=rows.get(id).individualCategoryReview.pmsMandate2020FaqReview;
   assert.equal(review.officialSebiFaqUrl,
     'https://www.sebi.gov.in/sebi_data/attachdocs/aug-2020/1598359862760.pdf');
   assert.equal(review.officialSebiInvestorEducationUrl,'https://investor.sebi.gov.in/pms_final.html');
   assert.equal(review.faqPublishedOn,'2020-08-25');
   assert.equal(review.reviewedOn,'2026-10-31');
   assert.equal(review.managerExercisesTradingDiscretionWithinMandate,index===0);
   assert.equal(review.clientInstructionsDetermineTrades,index===1);
   assert.equal(review.faqIsHistoricalNotCurrentProviderApproval,true);
   assert.equal(review.standardFiftyLakhReferenceDoesNotVerifyPersonalEligibility,true);
   assert.ok(review.riskConsiderations.length>=2);
   assert.ok(review.investorAccessConstraints.length>=2);
   for(const key of ['currentRegisteredManagerAndMandateVerified',
     'individualClientKycAndMinimumExceptionsVerified',
     'actualHoldingsFeesCustodyAndExitTermsVerified',
     'livePricesAndCommercialRightsVerified','adviceAuthorizationVerified'])
     assert.equal(review[key],false,id+':'+key);
   const common='SEBI_2020_PMS_FAQ_MANDATE_CONTROL_NOT_CURRENT_MANAGER_OR_CLIENT_APPROVAL';
   const notices=[
     ['SHORT_HORIZON_REQUIRES_PMS_HOLDINGS_EXIT_FEES_AND_SETTLEMENT_REVIEW',short],
     ['EMERGENCY_FUND_GOAL_REQUIRES_PMS_SECURITY_LIQUIDITY_AND_TERMINATION_REVIEW',emergency],
     ['CONSERVATIVE_PROFILE_REQUIRES_PMS_CONCENTRATION_AND_MARKET_LOSS_REVIEW',conservative],
   ];
   assert.ok(baseline.get(id).screeningReasonCodes.includes(common),id);
   for(const [code,matched] of notices){
     assert.ok(matched.get(id).screeningReasonCodes.includes(code),id+':'+code);
     assert.ok(!baseline.get(id).screeningReasonCodes.includes(code),id+':'+code);
   }
   assert.ok(!unknown.get(id).screeningReasonCodes.includes(
     'RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_PMS_PORTFOLIO_LIQUIDATION_AND_CUSTODY_REVIEW'));
   for(const screened of [baseline,short,emergency,conservative]){
     const item=screened.get(id);
     assert.equal(item.profileAssessment,'MISSING_SUITABILITY_EVIDENCE');
     assert.equal(item.productQualified,false);
     assert.equal(item.scoreAvailable,false);
     assert.equal(item.productRiskLevel,null);
   }
 }
 assert.equal(rows.size,95);
});

test('SEBI August 2026 municipal debt private-placement lots and pooled escrow do not establish green-bond retail access',()=>{
 const id='catalog_2026_municipal_green';
 const rows=listExtensionResearch();
 const research=rows.find(row=>row.id===id);
 const review=research.individualCategoryReview.municipalGreenDisclosure2026Review
   .municipalDebtAug2026OperationalReview;
 assert.equal(review.officialSebiCircularUrl,
   'https://www.sebi.gov.in/sebi_data/attachdocs/aug-2026/1786447511614.pdf');
 assert.equal(review.circularIssuedOn,'2026-08-11');
 assert.equal(review.reviewedOn,'2026-10-31');
 assert.deepEqual(review.privatePlacementFaceValueOptionsInr,[10000,100000]);
 assert.equal(review.tenThousandFaceValueRequiresFixedMaturityWithoutStructuredObligations,true);
 assert.equal(review.privatePlacementListedTradingLotEqualsFaceValue,true);
 assert.equal(review.faceValueRulesApplyToPublicIssues,false);
 assert.equal(review.pooledFinanceSpvEscrowAppliesOnlyToQualifyingPooledVehicles,true);
 assert.equal(review.pooledSpvOneYearInterestObligationAccountRequired,true);
 assert.equal(review.optionalCreditEnhancementsAreNotAutomaticGuarantees,true);
 assert.equal(review.halfYearUnauditedResultsDeadlineDays,60);
 assert.equal(review.annualAuditedResultsDeadlineDays,90);
 for(const key of ['actualIssuerIssueRouteAndFaceValueVerified','actualPooledFinanceStructureAndEscrowVerified',
   'specificCreditEnhancementOrGuaranteeVerified','issuerDisclosureAndCurrentFinancialResultsVerified',
   'actualListedIsinBidAskAndRetailAccessVerified','currentMarketDataReuseAndAdviceRightsVerified'])
   assert.equal(review[key],false,key);
 assert.ok(review.riskConsiderations.length>=2&&review.investorAccessConstraints.length>=2);
 const screen=overrides=>screenExtensionResearchForProfile(canonicalProfile({
   investmentHorizonYears:10,investmentGoals:['Wealth Growth'],riskTolerance:'Moderate',
   emergencyFundMonths:null,...overrides,
 })).find(row=>row.id===id);
 const baseline=screen({});
 const short=screen({investmentHorizonYears:2});
 const emergency=screen({investmentGoals:['Emergency Fund']});
 const unknown=screen({emergencyFundMonths:null});
 const zero=screen({emergencyFundMonths:0});
 const common=['SEBI_AUG_2026_MUNICIPAL_PRIVATE_PLACEMENT_FACE_VALUE_NOT_PERSONAL_MINIMUM',
   'MUNICIPAL_POOLED_ESCROW_AND_CREDIT_ENHANCEMENT_NOT_SOVEREIGN_GUARANTEE'];
 for(const code of common)assert.ok(baseline.screeningReasonCodes.includes(code),code);
 const shortCode='SHORT_HORIZON_REQUIRES_MUNICIPAL_PRIVATE_PLACEMENT_MATURITY_AND_LOT_REVIEW';
 const emergencyCode='EMERGENCY_FUND_GOAL_REQUIRES_MUNICIPAL_ISSUE_ROUTE_AND_POOLED_ESCROW_APPLICABILITY_REVIEW';
 assert.ok(short.screeningReasonCodes.includes(shortCode));
 assert.ok(!baseline.screeningReasonCodes.includes(shortCode));
 assert.ok(emergency.screeningReasonCodes.includes(emergencyCode));
 assert.ok(!baseline.screeningReasonCodes.includes(emergencyCode));
 assert.ok(!unknown.screeningReasonCodes.includes('RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_MUNICIPAL_BOND_CREDIT_AND_RESALE_REVIEW'));
 assert.ok(zero.screeningReasonCodes.includes('RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_MUNICIPAL_BOND_CREDIT_AND_RESALE_REVIEW'));
 for(const item of [baseline,short,emergency,unknown,zero]){
   assert.equal(item.profileAssessment,'MISSING_SUITABILITY_EVIDENCE');
   assert.equal(item.productQualified,false);
   assert.equal(item.scoreAvailable,false);
   assert.equal(item.productRiskLevel,null);
 }
 assert.equal(rows.length,95);
});


test('BIS bullion quality evidence and SM REIT profile screening remain non-ranking and fact-dependent',()=>{
 const research=listExtensionResearch();
 const get=id=>research.find(x=>x.id==='catalog_2026_'+id);
 const gold=get('physical_gold_bullion').preciousMetalsCategoryReview.bullionHallmarkScope2026Review;
 const silver=get('physical_silver_bullion').preciousMetalsCategoryReview.bullionHallmarkScope2026Review;
 assert.equal(gold.officialBisRefineriesFaqUrl,'https://www.bis.gov.in/refineries/?lang=en');
 assert.equal(silver.officialBisRefineriesFaqUrl,'https://www.bis.gov.in/refineries/?lang=en');
 assert.equal(gold.reviewedOn,'2026-10-31');
 assert.equal(silver.reviewedOn,'2026-10-31');
 assert.equal(gold.actualBarAssayWeightAndRefineryLicenseVerified,false);
 assert.equal(silver.bisRefineryMintBullionHallmarkSchemeDescribedForGoldOnly,true);
 assert.equal(silver.silverJewelleryHuid2025IsNotSilverBullionBarAssay,true);
 assert.equal(silver.actualSilverBarPurityAndAssayVerified,false);
 for(const evidence of [gold,silver]){
  assert.equal(evidence.individuallyAuthorizedPriceVerified,false);
  assert.equal(evidence.commercialDataRightsVerified,false);
  assert.equal(evidence.personalizedSuitabilityVerified,false);
  assert.ok(evidence.riskConsiderations.length>=2);
  assert.ok(evidence.investorAccessConstraints.length>=2);
 }
 const zero=screenExtensionResearchForProfile(canonicalProfile({
  emergencyFundMonths:0,investmentHorizonYears:2,
  investmentGoals:['Emergency Fund'],riskTolerance:'Conservative'
 }));
 const unknown=screenExtensionResearchForProfile(canonicalProfile({
  emergencyFundMonths:null,investmentHorizonYears:10,
  investmentGoals:['Wealth Growth'],riskTolerance:'Aggressive'
 }));
 const positive=screenExtensionResearchForProfile(canonicalProfile({
  emergencyFundMonths:6,investmentHorizonYears:10,
  investmentGoals:['Wealth Growth'],riskTolerance:'Aggressive'
 }));
 const reasons=(rows,id)=>rows.find(x=>x.id==='catalog_2026_'+id).screeningReasonCodes;
 for(const id of ['physical_gold_bullion','physical_silver_bullion']){
  const notices=[
   'RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_PHYSICAL_BULLION_RESALE_AND_CUSTODY_REVIEW',
   'SHORT_HORIZON_REQUIRES_PHYSICAL_BULLION_SPREAD_AND_PRICE_LOSS_REVIEW',
   'EMERGENCY_FUND_GOAL_REQUIRES_PHYSICAL_BULLION_BUYBACK_AND_SETTLEMENT_REVIEW',
   'CONSERVATIVE_PROFILE_REQUIRES_PHYSICAL_BULLION_VOLATILITY_AND_ASSAY_REVIEW'
  ];
  for(const notice of notices){
   assert.ok(reasons(zero,id).includes(notice),id+' '+notice);
   assert.ok(!reasons(unknown,id).includes(notice),id+' unknown '+notice);
   assert.ok(!reasons(positive,id).includes(notice),id+' positive '+notice);
  }
 }
 for(const notice of [
  'RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_SM_REIT_SECONDARY_LIQUIDITY_REVIEW',
  'SHORT_HORIZON_REQUIRES_SM_REIT_LISTING_DEPTH_AND_SETTLEMENT_REVIEW',
  'CONSERVATIVE_PROFILE_REQUIRES_SM_REIT_PROPERTY_CONCENTRATION_AND_PRICE_LOSS_REVIEW'
 ]){
  assert.ok(reasons(zero,'sm_reit_scheme').includes(notice));
  assert.ok(!reasons(unknown,'sm_reit_scheme').includes(notice));
  assert.ok(!reasons(positive,'sm_reit_scheme').includes(notice));
 }
 assert.equal(zero.length,95);
 for(const result of [...zero,...unknown,...positive]){
  assert.equal(result.profileAssessment,'MISSING_SUITABILITY_EVIDENCE');
  assert.equal(result.productQualified,false);
  assert.equal(result.scoreAvailable,false);
  assert.equal(result.productRiskLevel,null);
 }
});

test('India Post 2021 Basic Savings exception is not blanket zero-balance retail eligibility',()=>{
 const id='catalog_2026_po_savings';
 const rows=listExtensionResearch();
 assert.equal(rows.length,95);
 const research=rows.find(row=>row.id===id);
 assert.equal(research.postalSavingsAccessReview.originalRulesMayHaveSubsequentAmendments,true);
 const review=research.postalSavingsAccessReview.basicSavings2021AmendmentReview;
 assert.equal(review.officialIndiaPostSbOrderCollectionUrl,
   'https://www.indiapost.gov.in/VAS/DOP_PDFFiles/SB_Order_2021.pdf');
 assert.equal(review.indiaPostSbOrder,'SB Order 08/2021');
 assert.equal(review.gazetteNotification,'G.S.R. 257(E)');
 assert.equal(review.gazetteNotificationDated,'2021-04-09');
 assert.equal(review.basicSavingsOpeningDepositNilUnder2021Amendment,true);
 assert.equal(review.basicSavingsMinimumBalanceNilUnder2021Amendment,true);
 assert.equal(review.registeredGovernmentWelfareAdultOrMinorGuardianRequiredUnder2021Amendment,true);
 assert.equal(review.ordinaryPostalSavingsAccountZeroBalanceInferred,false);
 for(const key of ['currentRuleVersionAndMaintenanceFeesVerified',
  'specificApplicantWelfareStatusAndKycVerified',
  'currentBasicSavingsServiceChannelAndWithdrawalRightsVerified',
  'currentRateAndCommercialDisplayRightsVerified',
  'personalizedAdviceAuthorizationVerified'])assert.equal(review[key],false,key);
 assert.ok(review.riskConsiderations.length>=2);
 assert.ok(review.investorAccessConstraints.length>=2);
 assert.equal(hasCompleteCategoryRiskAccessResearch(research),true);
 const screen=overrides=>screenExtensionResearchForProfile(canonicalProfile({
   investmentGoals:['Wealth Growth'],emergencyFundMonths:null,...overrides,
 })).find(row=>row.id===id);
 const baseline=screen({});
 const emergency=screen({investmentGoals:['Emergency Fund']});
 const zero=screen({emergencyFundMonths:0});
 const positive=screen({emergencyFundMonths:6});
 const common='INDIA_POST_2021_BASIC_SAVINGS_WELFARE_EXCEPTION_NOT_GENERAL_ZERO_BALANCE';
 const emergencyCode='EMERGENCY_FUND_GOAL_REQUIRES_CURRENT_POSTAL_SAVINGS_WITHDRAWAL_CHANNEL_REVIEW';
 const zeroCode='RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_POSTAL_SAVINGS_ACCOUNT_ACCESS_VERIFICATION';
 for(const result of [baseline,emergency,zero,positive]){
   assert.ok(result.screeningReasonCodes.includes(common));
   assert.equal(result.profileAssessment,'MISSING_SUITABILITY_EVIDENCE');
   assert.equal(result.productQualified,false);
   assert.equal(result.scoreAvailable,false);
   assert.equal(result.productRiskLevel,null);
 }
 assert.ok(emergency.screeningReasonCodes.includes(emergencyCode));
 assert.ok(!baseline.screeningReasonCodes.includes(emergencyCode));
 assert.ok(zero.screeningReasonCodes.includes(zeroCode));
 assert.ok(!baseline.screeningReasonCodes.includes(zeroCode));
 assert.ok(!positive.screeningReasonCodes.includes(zeroCode));
 assert.equal(rows.filter(x=>x.postalSavingsAccessReview?.basicSavings2021AmendmentReview).length,1);
});

test('RBI 2024 CP issuer buyback and listed NCD subset rules cannot imply retail approval',()=>{
 const research=listExtensionResearch(),find=id=>research.find(x=>x.id==='catalog_2026_'+id);
 const cp=find('commercial_paper').debtInstrumentReview.rbiCpDirectionSpecificReview;
 assert.equal(cp.buybackPermittedOnlyAfterIssueDays,7);
 assert.equal(cp.issuerBuybackOfferMustBeMadeToAllHoldersOnIdenticalTerms,true);
 assert.equal(cp.investorMayDeclineBuybackOffer,true);
 assert.equal(cp.buybackAtPrevailingMarketPrice,true);
 assert.equal(cp.issuerBuybackIsNotInvestorPutRight,true);
 assert.equal(cp.actualIssuerBuybackOfferAndPriceVerified,false);
 for(const [id,kind] of [['ncd_secured','SECURED'],['ncd_unsecured','UNSECURED']]){
  const r=find(id).debtInstrumentReview.rbiShortTermNcd2024ScopeReview;
  assert.equal(r.officialRbiDirectionUrl,'https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=12592');
  assert.equal(r.listedCategoryType,kind);
  assert.equal(r.rbiDefinitionRequiresSecuredInstrument,true);
  assert.equal(r.rbiShortTermNcdMinimumTenorDays,90);
  assert.equal(r.rbiDefinitionOriginalMaturityMaximum,'ONE_YEAR');
  assert.equal(r.rbiShortTermNcdIssuerBuybackEarliestDays,90);
  assert.equal(r.issuerBuybackIsNotInvestorPutRight,true);
  assert.equal(r.actualShortTermNcdIssuerBuybackOfferAndPriceVerified,false);
  assert.equal(r.rbiShortTermNcdMinimumIssueDenominationInr,500000);
  assert.equal(r.rbiMinimumIsUniversalListedNcdRetailMinimum,false);
  assert.equal(r.actualListedNcdFallsWithinRbiShortTermDefinitionVerified,false);
  assert.equal(r.individualAdviceAuthorizationVerified,false);
 }
 const make=overrides=>new Map(screenExtensionResearchForProfile(canonicalProfile({
  investmentGoals:['Wealth Growth'],emergencyFundMonths:null,investmentHorizonYears:10,...overrides,
 })).map(x=>[x.id,x]));
 const unknown=make({}),zero=make({emergencyFundMonths:0}),positive=make({emergencyFundMonths:6});
 const emergency=make({investmentGoals:['Emergency Fund']});
 for(const id of ['commercial_paper','ncd_secured','ncd_unsecured']){
  const key='catalog_2026_'+id;
  const flag=id==='commercial_paper'?'RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_CP_CREDIT_AND_EXIT_REVIEW':
   'RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_LISTED_NCD_CREDIT_AND_EXIT_REVIEW';
  assert.ok(zero.get(key).screeningReasonCodes.includes(flag));
  assert.ok(!unknown.get(key).screeningReasonCodes.includes(flag));
  assert.ok(!positive.get(key).screeningReasonCodes.includes(flag));
  if(id!=='commercial_paper'){
   if(id==='ncd_secured')assert.ok(unknown.get(key).screeningReasonCodes.includes(
    'RBI_2024_SECURED_SHORT_NCD_90_DAY_ISSUER_BUYBACK_NOT_HOLDER_PUT'));
   if(id==='ncd_unsecured')assert.ok(!unknown.get(key).screeningReasonCodes.includes(
    'RBI_2024_SECURED_SHORT_NCD_90_DAY_ISSUER_BUYBACK_NOT_HOLDER_PUT'));
   assert.ok(emergency.get(key).screeningReasonCodes.includes('EMERGENCY_FUND_REQUIRES_LISTED_NCD_CREDIT_AND_SECONDARY_EXIT_REVIEW'));
   assert.ok(!unknown.get(key).screeningReasonCodes.includes('EMERGENCY_FUND_REQUIRES_LISTED_NCD_CREDIT_AND_SECONDARY_EXIT_REVIEW'));
  }else assert.ok(unknown.get(key).screeningReasonCodes.includes('RBI_CP_ISSUER_BUYBACK_NOT_INVESTOR_PUT_OR_GUARANTEED_EXIT'));
  for(const views of [unknown,zero,positive,emergency]){
   const row=views.get(key);
   assert.equal(row.profileAssessment,'MISSING_SUITABILITY_EVIDENCE');
   assert.equal(row.productQualified,false);
   assert.equal(row.scoreAvailable,false);
   assert.equal(row.productRiskLevel,null);
  }
 }
});

test('SEBI March 2026 FoF riskometer method is source-scoped and profile notices are fact-dependent',()=>{
 const suffixes=['equity_diversified_fof','equity_sector_fof','fof_aggressive_hybrid',
  'fof_conservative_hybrid','fof_income_arbitrage','fof_dynamic_allocation'];
 const research=listExtensionResearch();
 const make=overrides=>new Map(screenExtensionResearchForProfile(canonicalProfile({
  investmentGoals:['Wealth Growth'],riskTolerance:'Moderate',
  emergencyFundMonths:null,investmentHorizonYears:10,...overrides,
 })).map(row=>[row.id,row]));
 const unknown=make({}),zero=make({emergencyFundMonths:0});
 const emergency=make({investmentGoals:['Emergency Fund']});
 const conservative=make({riskTolerance:'Conservative'});
 for(const suffix of suffixes){
  const id='catalog_2026_'+suffix;
  const row=research.find(x=>x.id===id);
  const review=row.fundOfFundsCategoryReview.sebiMarch2026UnderlyingRiskometerReview;
  assert.equal(review.masterCircularAsOf,'2026-03-20');
  assert.equal(review.riskometerMonthlyDisclosureWithinCalendarDays,10);
  assert.equal(review.underlyingMutualFundUnitRiskUsesUnderlyingSchemeRiskometer,true);
  assert.equal(review.weightedUnderlyingRiskValuesUseHoldingWeights,true);
  assert.equal(review.actualFoFSchemeRiskometerVerified,false);
  assert.equal(review.underlyingSchemeRiskometersVerified,false);
  assert.equal(review.currentSchemePortfolioWeightsVerified,false);
  assert.equal(review.commercialNavAndRiskometerRightsVerified,false);
  assert.equal(row.productRiskScore,null);
  for(const item of [unknown,zero,emergency,conservative].map(view=>view.get(id))){
   assert.ok(item.screeningReasonCodes.includes('SEBI_MARCH_2026_FOF_UNDERLYING_RISKOMETER_METHOD_NOT_ACTUAL_SCHEME_RATING'));
   assert.equal(item.productQualified,false);
   assert.equal(item.scoreAvailable,false);
   assert.equal(item.productRiskLevel,null);
  }
  const check=(view,code)=>view.get(id).screeningReasonCodes.includes(code);
  const zeroCode='RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_FOF_MONTHLY_RISK_AND_EXIT_REVIEW';
  const goalCode='EMERGENCY_FUND_GOAL_REQUIRES_FOF_CURRENT_RISKOMETER_AND_REDEMPTION_REVIEW';
  const riskCode='CONSERVATIVE_PROFILE_REQUIRES_FOF_UNDERLYING_RISK_AND_LOSS_REVIEW';
  assert.ok(check(zero,zeroCode));
  assert.ok(!check(unknown,zeroCode));
  assert.ok(check(emergency,goalCode));
  assert.ok(!check(unknown,goalCode));
  assert.ok(check(conservative,riskCode));
  assert.ok(!check(unknown,riskCode));
 }
 assert.equal(research.filter(x=>x.fundOfFundsCategoryReview?.sebiMarch2026UnderlyingRiskometerReview).length,6);
});

test('SEBI historical unlisted NCD placement caution never becomes current retail approval',()=>{
 const id='catalog_2026_ncd_unlisted';
 const rows=listExtensionResearch();
 const row=rows.find(x=>x.id===id);
 const review=row.debtInstrumentReview.privatePlacementInvestorCautionReview;
 assert.equal(rows.filter(x=>x.debtInstrumentReview?.privatePlacementInvestorCautionReview).length,1);
 assert.equal(review.officialSebiHistoricalInvestorWarningUrl,
  'https://www.sebi.gov.in/media/press-releases/jan-2017/caution-to-the-investors_34109.html');
 assert.equal(review.historicalWarningIssuedOn,'2017-01-30');
 assert.equal(review.currentNcsRegulationsLastAmendedOn,'2026-01-21');
 assert.equal(review.historicalOfferCountNumbersNotAppliedAsCurrentRetailEligibility,true);
 assert.equal(review.listingRegulationsDoNotEstablishUnlistedRetailAccess,true);
 for(const key of ['specificIssuerAndIsinVerified','actualOfferDocumentAndPlacementRouteVerified',
   'currentCompanyLawPlacementComplianceVerified','namedInvestorInvitationAndTransferRightsVerified',
   'currentRatingPriceCustodyAndExitCounterpartyVerified','commercialDataAndAdviceRightsVerified'])
  assert.equal(review[key],false,key);
 const make=overrides=>screenExtensionResearchForProfile(canonicalProfile({
   investmentHorizonYears:10,investmentGoals:['Wealth Growth'],
   emergencyFundMonths:null,riskTolerance:'Moderate',...overrides,
 })).find(x=>x.id===id);
 const unknown=make({}),short=make({investmentHorizonYears:2});
 const emergency=make({investmentGoals:['Emergency Fund']});
 const zero=make({emergencyFundMonths:0});
 const historical='SEBI_HISTORICAL_UNLISTED_PRIVATE_PLACEMENT_CAUTION_REQUIRES_CURRENT_OFFER_VERIFICATION';
 for(const x of [unknown,short,emergency,zero]){
  assert.ok(x.screeningReasonCodes.includes(historical));
  assert.equal(x.profileAssessment,'MISSING_SUITABILITY_EVIDENCE');
  assert.equal(x.scoreAvailable,false);
  assert.equal(x.productQualified,false);
  assert.equal(x.productRiskLevel,null);
 }
 const horizon='SHORT_HORIZON_REQUIRES_UNLISTED_NCD_MATURITY_AND_RESALE_REVIEW';
 const goal='EMERGENCY_FUND_GOAL_REQUIRES_UNLISTED_NCD_LAWFUL_TRANSFER_AND_EXIT_REVIEW';
 assert.ok(short.screeningReasonCodes.includes(horizon));
 assert.ok(!unknown.screeningReasonCodes.includes(horizon));
 assert.ok(emergency.screeningReasonCodes.includes(goal));
 assert.ok(!unknown.screeningReasonCodes.includes(goal));
 assert.ok(!zero.screeningReasonCodes.includes(goal));
});


test('RBI UCB capital-instrument examples do not become generic corporate bond terms or retail approvals',()=>{
 const ids=['catalog_2026_bond_subordinated','catalog_2026_bond_perpetual'];
 const research=listExtensionResearch();
 const short=screenExtensionResearchForProfile(canonicalProfile({
   riskTolerance:'Conservative',investmentHorizonYears:1,investmentGoals:['Emergency Fund'],
 }));
 const long=screenExtensionResearchForProfile(canonicalProfile({
   riskTolerance:'Aggressive',investmentHorizonYears:10,investmentGoals:['Retirement'],
 }));
 assert.equal(research.filter(r=>r.debtInstrumentReview?.bankCapitalInstrumentScopeReview).length,2);
 for(const id of ids){
   const row=research.find(r=>r.id===id);
   const review=row.debtInstrumentReview.bankCapitalInstrumentScopeReview;
   assert.equal(review.officialRbiMasterCircularUrl,'https://www.rbi.org.in/Scripts/BS_ViewMasCirculardetails.aspx?id=12490');
   assert.equal(review.circularIssuedOn,'2023-04-20');
   assert.equal(review.reviewedOn,'2026-10-31');
   assert.equal(review.issuerScope,'PRIMARY_URBAN_COOPERATIVE_BANK_ONLY');
   assert.equal(review.sourceScope,'HISTORICAL_2023_UCB_CAPITAL_INSTRUMENT_EXAMPLE_NOT_GENERAL_CORPORATE_BOND_RULE_OR_CURRENT_RETAIL_APPROVAL');
   assert.equal(review.historicalHolderPutAllowed,false);
   assert.equal(review.depositInsuranceAppliesUnderCitedFramework,false);
   assert.equal(review.historicalTenorFloorYears,id==='catalog_2026_bond_subordinated'?10:null);
   for(const key of ['currentAmendmentsAndIssuerApplicabilityVerified','specificIssuerAndIsinVerified',
     'specificOfferDocumentAndHolderEligibilityVerified','currentMarketPriceOrYieldVerified',
     'commercialDataRightsVerified','personalizedAdviceAuthorizationVerified'])assert.equal(review[key],false,id+':'+key);
   assert.ok(review.riskConsiderations.length>=2&&review.investorAccessConstraints.length>=2,id);
   for(const item of [short.find(x=>x.id===id),long.find(x=>x.id===id)]){
     assert.equal(item.productQualified,false,id);
     assert.equal(item.scoreAvailable,false,id);
     assert.equal(item.productRiskLevel,null,id);
     assert.equal(item.profileAssessment,'MISSING_SUITABILITY_EVIDENCE',id);
     assert.ok(item.screeningReasonCodes.includes('RBI_2023_UCB_CAPITAL_BOND_EXAMPLE_NOT_GENERIC_CORPORATE_BOND_RULE'),id);
     assert.ok(item.screeningReasonCodes.includes('UCB_CAPITAL_INSTRUMENT_NOT_INSURED_BANK_DEPOSIT_OR_VERIFIED_RETAIL_OFFER'),id);
   }
   for(const code of ['EMERGENCY_FUND_REQUIRES_UCB_CAPITAL_BOND_EXIT_AND_LOSS_REVIEW',
     'SHORT_HORIZON_REQUIRES_UCB_CAPITAL_BOND_CALL_MATURITY_AND_EXIT_REVIEW']){
     assert.ok(short.find(x=>x.id===id).screeningReasonCodes.includes(code),id+':'+code);
     assert.ok(!long.find(x=>x.id===id).screeningReasonCodes.includes(code),id+':'+code);
   }
 }
 const first=research.find(r=>r.id===ids[0]);
 first.debtInstrumentReview.bankCapitalInstrumentScopeReview.riskConsiderations.push('forged');
 assert.ok(!listExtensionResearch().find(r=>r.id===ids[0])
   .debtInstrumentReview.bankCapitalInstrumentScopeReview.riskConsiderations.includes('forged'));
});

test('RBI commercial-bank investment restrictions do not establish zero-coupon or convertible retail eligibility',()=>{
 const ids=['catalog_2026_bond_corporate_zero','catalog_2026_bond_convertible'];
 const rows=listExtensionResearch();
 const short=screenExtensionResearchForProfile(canonicalProfile({
  investmentHorizonYears:2,investmentGoals:['Emergency Fund'],
  emergencyFundMonths:0,riskTolerance:'Conservative',
 }));
 const long=screenExtensionResearchForProfile(canonicalProfile({
  investmentHorizonYears:10,investmentGoals:['Retirement'],
  emergencyFundMonths:null,riskTolerance:'Aggressive',
 }));
 const expected={
  catalog_2026_bond_corporate_zero:['30(d)',true,
   'EMERGENCY_FUND_GOAL_REQUIRES_ZERO_COUPON_CASH_FLOW_AND_EXIT_REVIEW',
   'RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_ZERO_COUPON_MATURITY_AND_EXIT_REVIEW',
   'SHORT_HORIZON_REQUIRES_ZERO_COUPON_MATURITY_AND_MARKET_PRICE_REVIEW'],
  catalog_2026_bond_convertible:['30(b)(vi)(11)',false,
   'EMERGENCY_FUND_GOAL_REQUIRES_CONVERTIBLE_EXIT_AND_CONVERSION_REVIEW',
   'CONSERVATIVE_PROFILE_REQUIRES_CONVERTIBLE_EQUITY_AND_CREDIT_LOSS_REVIEW',
   'SHORT_HORIZON_REQUIRES_CONVERTIBLE_CONVERSION_AND_RESALE_REVIEW'],
 };
 for(const id of ids){
  const row=rows.find(r=>r.id===id);
  const r=row.debtInstrumentReview.bankPortfolioRuleScopeReview;
  const [clause,exception,...profileCodes]=expected[id];
  assert.equal(r.officialRbiDirectionsUrl,'https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=12534');
  assert.equal(r.rbiDirectionsUpdatedAsOf,'2025-04-01');
  assert.equal(r.officialSebiHistoricalFaqUrl,'https://www.sebi.gov.in/sebi_data/faqfiles/jan-2017/1485843476566.pdf');
  assert.equal(r.sebiFaqInformationUpdatedThrough,'2009-02-28');
  assert.equal(r.clause,clause);
  assert.equal(r.bankInvestmentRestrictionHasConditionalException,exception);
  assert.equal(r.institutionalUnlistedExposureExclusionNotRetailApproval,!exception);
  assert.equal(r.institutionalBankRuleNotIndividualRetailProhibition,true);
  assert.equal(r.actualIssuerIsinAndOfferDocumentVerified,false);
  assert.equal(r.applicableRetailEligibilityAndKycVerified,false);
  assert.equal(r.individualRiskMeterOrAdviceAuthorizationVerified,false);
  assert.equal(row.actualRetailProductEligible,false);
  assert.equal(row.productRiskScore,null);
  assert.equal(row.suitabilityRankingPermitted,false);
  const a=short.find(x=>x.id===id),b=long.find(x=>x.id===id);
  assert.ok(a.screeningReasonCodes.includes('RBI_COMMERCIAL_BANK_PORTFOLIO_RULE_NOT_RETAIL_ELIGIBILITY_OR_ISSUE_APPROVAL'));
  assert.ok(b.screeningReasonCodes.includes('RBI_COMMERCIAL_BANK_PORTFOLIO_RULE_NOT_RETAIL_ELIGIBILITY_OR_ISSUE_APPROVAL'));
  for(const code of profileCodes){
   assert.ok(a.screeningReasonCodes.includes(code),id+':'+code);
   assert.ok(!b.screeningReasonCodes.includes(code),id+':'+code);
  }
  assert.equal(a.productQualified,false);
  assert.equal(b.productQualified,false);
  assert.equal(a.scoreAvailable,false);
  assert.equal(b.scoreAvailable,false);
 }
 const zero=rows.find(x=>x.id===ids[0]);
 zero.debtInstrumentReview.bankPortfolioRuleScopeReview.investorAccessConstraints.push('fabricated approval');
 assert.ok(!listExtensionResearch().find(x=>x.id===ids[0])
  .debtInstrumentReview.bankPortfolioRuleScopeReview.investorAccessConstraints.includes('fabricated approval'));
});


test('SEBI September 2026 debenture-trustee security-cover duties remain issue-scoped for three distinct debt archetypes',()=>{
 const ids=['catalog_2026_ncd_secured','catalog_2026_ncd_unsecured','catalog_2026_bond_subordinated'];
 const rows=listExtensionResearch();
 assert.equal(rows.filter(x=>x.debtInstrumentReview?.sebiDebentureTrusteeSep2026Review).length,3);
 const make=overrides=>screenExtensionResearchForProfile(canonicalProfile({
   investmentGoals:['Wealth Growth'],investmentHorizonYears:10,
   emergencyFundMonths:null,riskTolerance:'Moderate',...overrides,
 }));
 const unknown=make({}),short=make({investmentHorizonYears:2}),
   emergency=make({investmentGoals:['Emergency Fund']}),
   zero=make({emergencyFundMonths:0});
 for(const [i,id] of ids.entries()){
   const row=rows.find(x=>x.id===id),r=row.debtInstrumentReview.sebiDebentureTrusteeSep2026Review;
   assert.equal(r.officialSebiMasterCircularUrl,
     'https://www.sebi.gov.in/sebi_data/attachdocs/sep-2026/1790593347737.pdf');
   assert.equal(r.circularIssuedOn,'2026-09-28');
   assert.equal(r.supersedesDebentureTrusteeMasterCircularOf,'2025-08-13');
   assert.equal(r.sourceClause,i===0?'CHAPTER_II_2_1_AND_CHAPTER_V_1_1_2_1':'CHAPTER_V_1_9');
   assert.equal(r.chapterIIAssetChargeDueDiligence,i===0);
   assert.equal(r.chapterVUnsecuredDebtColumn,i!==0);
   assert.equal(r.securityCoverIsActualRecoveryGuarantee,false);
   for(const key of ['actualIssuerIsinAndListingVerified','namedRegisteredDebentureTrusteeVerified',
    'issueTrustDeedSecurityPriorityAndCovenantsVerified',
    'currentIssueSecurityCoverAndDefaultDisclosuresVerified',
    'personalRetailAccessKycAndMinimumVerified',
    'currentPriceRatingAndCommercialDataRightsVerified','personalizedAdviceAuthorizationVerified'])
     assert.equal(r[key],false,id+':'+key);
   assert.ok(r.riskConsiderations.length>=2&&r.investorAccessConstraints.length>=2);
   for(const arr of [unknown,short,emergency,zero]){
     const a=arr.find(x=>x.id===id);
     assert.equal(a.profileAssessment,'MISSING_SUITABILITY_EVIDENCE',id);
     assert.equal(a.productQualified,false,id);
     assert.equal(a.scoreAvailable,false,id);
     assert.equal(a.productRiskLevel,null,id);
     assert.ok(a.screeningReasonCodes.includes('SEBI_SEPT_2026_DEBENTURE_TRUSTEE_CIRCULAR_NOT_ISSUE_OR_RETAIL_APPROVAL'));
   }
   for(const [arr,code] of [
     [short,'SHORT_HORIZON_REQUIRES_DEBENTURE_TRUST_DEED_AND_RESALE_REVIEW'],
     [emergency,'EMERGENCY_FUND_GOAL_REQUIRES_DEBENTURE_DEFAULT_RECOVERY_AND_EXIT_REVIEW'],
     [zero,'RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_DEBENTURE_CREDIT_AND_EXIT_REVIEW']]){
     assert.ok(arr.find(x=>x.id===id).screeningReasonCodes.includes(code),id+':'+code);
     assert.ok(!unknown.find(x=>x.id===id).screeningReasonCodes.includes(code),id+':unknown:'+code);
   }
 }
 const copy=rows.find(x=>x.id===ids[0]);
 copy.debtInstrumentReview.sebiDebentureTrusteeSep2026Review.riskConsiderations.push('fabricated');
 assert.ok(!listExtensionResearch().find(x=>x.id===ids[0])
  .debtInstrumentReview.sebiDebentureTrusteeSep2026Review.riskConsiderations.includes('fabricated'));
});


test('DEA sovereign green bond allocation evidence stays historical and profile screening remains non-ranking',()=>{
 const id='catalog_2026_sovereign_green';
 const row=listExtensionResearch().find(x=>x.id===id);
 const review=row.governmentBondStructureReview.sovereignGreenAllocationAndImpactReportingReview;
 assert.equal(review.officialDeaAllocationReportPdfUrl,'https://dea.gov.in/files/other_reports_documents/SovereignGreenBondsAllocationReport_2022_23_0.pdf');
 assert.equal(review.officialDeaReportsIndexUrl,'https://www.dea.gov.in/reports-additional-reports');
 assert.equal(review.allocationReportFinancialYear,'2022-23');
 assert.equal(review.impactReportIndexPublishedOn,'2026-02-19');
 assert.equal(review.historicalProceedsAllocatedInrCrore,16000);
 assert.equal(review.historicalProceedsAreCurrentIssueMarketData,false);
 assert.equal(review.impactReportFullTextIndependentlyReviewed,false);
 assert.equal(review.aggregateAllocationEstablishesSpecificEnvironmentalImpact,false);
 for(const key of ['specificIssueIsinMaturityAndOfferingVerified','investorKycAndRetailAccessVerified',
  'currentPriceYieldAndSecondaryLiquidityVerified','specificIssueEnvironmentalImpactVerified',
  'commercialMarketDataRightsVerified','personalizedAdviceAuthorizationVerified'])
  assert.equal(review[key],false,key);
 assert.ok(review.riskConsiderations.length>=2&&review.investorAccessConstraints.length>=2);
 const get=options=>screenExtensionResearchForProfile(canonicalProfile({
  investmentHorizonYears:10,investmentGoals:['Wealth Growth'],
  emergencyFundMonths:null,riskTolerance:'Moderate',...options,
 })).find(x=>x.id===id);
 const ordinary=get({}),goal=get({investmentGoals:['Emergency Fund']});
 const zero=get({emergencyFundMonths:0}),positive=get({emergencyFundMonths:6});
 const sourceCode='DEA_HISTORICAL_GREEN_PROCEEDS_ALLOCATION_NOT_CURRENT_ISIN_OR_VERIFIED_IMPACT';
 const goalCode='EMERGENCY_FUND_GOAL_REQUIRES_SOVEREIGN_GREEN_EXIT_SPREAD_AND_SETTLEMENT_REVIEW';
 const zeroCode='RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_SOVEREIGN_GREEN_EXIT_LIQUIDITY_REVIEW';
 for(const screened of [ordinary,goal,zero,positive]){
  assert.ok(screened.screeningReasonCodes.includes(sourceCode));
  assert.equal(screened.productQualified,false);
  assert.equal(screened.scoreAvailable,false);
 }
 assert.ok(goal.screeningReasonCodes.includes(goalCode));
 assert.ok(!ordinary.screeningReasonCodes.includes(goalCode));
 assert.ok(zero.screeningReasonCodes.includes(zeroCode));
 assert.ok(!ordinary.screeningReasonCodes.includes(zeroCode));
 assert.ok(!positive.screeningReasonCodes.includes(zeroCode));
 assert.equal(row.productRiskScore,null);
 assert.equal(row.actualRetailProductEligible,false);
 assert.equal(row.suitabilityRankingPermitted,false);
});

test('RBI floating G-Sec primer and October 2026 issue notice cannot become a category quote or personal approval',()=>{
 const id='catalog_2026_gsec_floating';
 const research=listExtensionResearch().find(x=>x.id===id);
 const r=research.governmentBondStructureReview.floatingRateOct2026SourceBoundaryReview;
 assert.equal(r.officialRbiGovernmentSecuritiesPrimerUrl,
  'https://m.rbi.org.in/commonman/english/scripts/FAQs.aspx?Id=711');
 assert.equal(r.officialRbiFrb2034OctoberReleaseUrl,
  'https://www.rbi.org.in/scripts/BS_PressReleaseDisplay.aspx?prid=63883');
 assert.equal(r.releaseDated,'2026-10-29');
 assert.equal(r.octoberReleaseFullTextIndependentlyReviewed,false);
 assert.equal(r.primerDescribesIssueSpecificBaseRatePlusFixedSpread,true);
 assert.equal(r.releaseSpecificCouponImportedAsCurrentCategoryMarketFact,false);
 assert.equal(r.releaseEstablishesAllFloatingGsecCoupons,false);
 assert.equal(r.releaseEstablishesPersonalRetailEligibility,false);
 for(const key of ['actualSecurityIsinAndCouponTermsVerified','applicantRdgKycAndCustodyVerified',
  'currentExecutablePriceAndResaleLiquidityVerified','commercialMarketDataRightsVerified',
  'taxAndPersonalizedAdviceAuthorizationVerified'])assert.equal(r[key],false,key);
 assert.ok(r.riskConsiderations.length>=2&&r.investorAccessConstraints.length>=2);
 const screen=changes=>screenExtensionResearchForProfile(canonicalProfile({
  investmentHorizonYears:10,investmentGoals:['Wealth Growth'],
  emergencyFundMonths:null,riskTolerance:'Moderate',...changes,
 })).find(x=>x.id===id);
 const ordinary=screen({}),goal=screen({investmentGoals:['Emergency Fund']});
 const zero=screen({emergencyFundMonths:0}),positive=screen({emergencyFundMonths:6});
 const source='RBI_OCT_2026_FRB_2034_RELEASE_NOT_GENERAL_COUPON_OR_RETAIL_APPROVAL';
 const goalCode='EMERGENCY_FUND_GOAL_REQUIRES_FLOATING_GSEC_COUPON_RESET_AND_RESALE_REVIEW';
 const zeroCode='RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_FLOATING_GSEC_MARKET_EXIT_REVIEW';
 for(const item of [ordinary,goal,zero,positive]){
  assert.ok(item.screeningReasonCodes.includes(source));
  assert.equal(item.productQualified,false);
  assert.equal(item.scoreAvailable,false);
  assert.equal(item.productRiskLevel,null);
 }
 assert.ok(goal.screeningReasonCodes.includes(goalCode));
 assert.ok(!ordinary.screeningReasonCodes.includes(goalCode));
 assert.ok(zero.screeningReasonCodes.includes(zeroCode));
 assert.ok(!ordinary.screeningReasonCodes.includes(zeroCode));
 assert.ok(!positive.screeningReasonCodes.includes(zeroCode));
 assert.equal(research.productRiskScore,null);
 assert.equal(research.actualRetailProductEligible,false);
 assert.equal(research.suitabilityRankingPermitted,false);
 r.riskConsiderations.push('fabricated coupon');
 assert.ok(!listExtensionResearch().find(x=>x.id===id)
  .governmentBondStructureReview.floatingRateOct2026SourceBoundaryReview.riskConsiderations
  .includes('fabricated coupon'));
});
