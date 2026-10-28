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
  assert.match(row.verifiedPublicFrameworkFact.factCode,/RBI_SGS_.*_STRIP_ELIGIBILITY/);
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
