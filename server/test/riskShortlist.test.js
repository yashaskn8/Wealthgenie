import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRiskShortlist, RISK_SHORTLIST_POLICY_VERSION } from '../services/riskShortlist.js';
import { runPipeline } from '../services/RecommendationPipeline.js';
import { investmentDatabase } from '../data/investmentDatabase.js';
import { canonicalProfile } from './helpers/canonicalProfile.js';
import {screenExtensionResearchForProfile,listExtensionResearch} from '../services/extensionFrameworkAssessment.js';

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
  assert.equal(row.referenceReviewedAt,'2026-10-28');
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
  assert.equal(row.referenceReviewedAt,'2026-10-28');
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
 assert.equal(rows.filter(x=>x.indexBenchmarkReview).length,5);
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
