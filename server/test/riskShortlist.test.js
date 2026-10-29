import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRiskShortlist, RISK_SHORTLIST_POLICY_VERSION } from '../services/riskShortlist.js';
import { runPipeline } from '../services/RecommendationPipeline.js';
import { investmentDatabase } from '../data/investmentDatabase.js';
import { canonicalProfile } from './helpers/canonicalProfile.js';
import {screenExtensionResearchForProfile,listExtensionResearch,isOfficialFrameworkReferenceUrl,hasCompleteCategoryRiskAccessResearch} from '../services/extensionFrameworkAssessment.js';

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
   assert.equal(row.referenceReviewedAt,'2026-10-29',row.id);
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
