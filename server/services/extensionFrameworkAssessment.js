import {readFileSync} from 'node:fs';
import {buildRecommendationProfile} from './recommendationProfile.js';
import {investmentDatabase} from '../data/investmentDatabase.js';

const universe=JSON.parse(readFileSync(
  new URL('../data/investmentUniverseExtensions2026.json',import.meta.url),'utf8')).entries;
const research=JSON.parse(readFileSync(
  new URL('../data/extensionFrameworkResearch2026.json',import.meta.url),'utf8'));
const idSet=new Set(universe.map(x=>x.id));
const legacyIds=new Set(investmentDatabase.map(x=>x.id));
if(research.schemaVersion!==1 || research.categoryCount!==95 || research.entries?.length!==95
  || universe.length!==95 || legacyIds.size!==155
  || new Set(research.entries.map(x=>x.id)).size!==95
  || research.publicFrameworkFactsDirectlyReviewed !== 95
  || research.productRiskScoresIndependentlyVerified !== 0
  || research.actualProductEligibilityVerified !== 0
  || research.sourcePermissionGrantsIndependentlyVerified !== 0
  || research.entries.filter(x=>x.verifiedPublicFrameworkFact!==null).length !== 95
  || research.entries.some(x=> x.verifiedPublicFrameworkFact !== null
    && (x.publicFrameworkVerification !== 'DIRECT_OFFICIAL_FRAMEWORK_FACT_REVIEWED'
      || !['PUBLIC_REGULATORY_STRUCTURE_ONLY_NOT_LIVE_PRODUCT_FACT',
        'PUBLIC_INDEX_METHODOLOGY_ONLY_NOT_AN_EXISTING_FUND_OR_ETF',
        'GENERAL_OFFICIAL_FRAMEWORK_REFERENCE_NOT_PRODUCT_RISK_OR_ELIGIBILITY']
        .includes(x.verifiedPublicFrameworkFact.scope)
      || (!/^\d{4}-\d{2}-\d{2}$/.test(x.verifiedPublicFrameworkFact.reviewedOn)
        || Number.isNaN(Date.parse(x.verifiedPublicFrameworkFact.reviewedOn))
        || x.verifiedPublicFrameworkFact.reviewedOn < research.asOf
        || Date.parse(x.verifiedPublicFrameworkFact.reviewedOn) > Date.now() + 86400000)
      || !x.verifiedPublicFrameworkFact.officialSourceUrl.startsWith('https://')))
  || research.entries.some(x=>x.verifiedPublicFrameworkFact === null
    && x.publicFrameworkVerification !== 'INDIVIDUAL_FRAMEWORK_FACT_NOT_YET_VERIFIED')
  || research.entries.some((e,i)=> e.id!==universe[i].id
    || !idSet.has(e.id) || legacyIds.has(e.id)
    || e.referenceUrl!==universe[i].sourceUrl
    || !e.exposureClass || !e.scenarioDescription?.includes(universe[i].name)
    || e.productRiskScore!==null || e.suitabilityRankingPermitted!==false
    || e.actualRetailProductEligible!==false
    || e.marketFactsVerified!==false || e.sourcePermissionVerified!==false
    || e.overallEvidence!=='STRUCTURAL_CLASSIFICATION_ONLY_NOT_READY_FOR_RECOMMENDATION'
    || e.fiscalYearTaxVerified!==false
    || !['https:'].includes(new URL(e.referenceUrl).protocol))) {
  throw new Error('FINANCIAL_95_FRAMEWORK_RESEARCH_COVERAGE_INVALID');
}
const nonnegative=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
export function listExtensionResearch() {
 return research.entries.map(row=>({...row}));
}
/**
 * These are conservative, non-ranking profile screening FLAGS. Never call
 * an extension suitable merely because a broad investment structure is known.
 */
export function screenExtensionResearchForProfile(profileInput) {
 const profile=buildRecommendationProfile(profileInput);
 return research.entries.map(row=>{
   const reasons=['INDIVIDUAL_PRODUCT_RISK_ELIGIBILITY_NOT_ESTABLISHED'];
   if(row.nominalMaturityMonths!==null
     && row.nominalMaturityMonths>profile.investmentHorizonYears*12)
     reasons.push('NOMINAL_TENOR_EXCEEDS_PROFILE_HORIZON_REVIEW_WITHDRAWAL_TERMS');
   if(row.nominalMaturityDays!==null
     && row.nominalMaturityDays>profile.investmentHorizonYears*365)
     reasons.push('T_BILL_TENOR_EXCEEDS_PROFILE_HORIZON');
   if(row.minorBeneficiaryRequired)
     reasons.push('MINOR_BENEFICIARY_AND_GUARDIAN_ELIGIBILITY_UNKNOWN');
   if(row.socialImpactNpoSseSpecialThresholdRequiresVerification===true)
     reasons.push('SOCIAL_IMPACT_NPO_SSE_SPECIAL_INVESTOR_MINIMUM_REQUIRES_SCHEME_REVIEW');
   if(nonnegative(row.standardCapitalReferenceInr)) {
     reasons.push('STANDARD_REGULATORY_CAPITAL_MINIMUM_HAS_EXCEPTIONS');
     if(profile.hasLumpSum===true && nonnegative(profile.lumpSumAmount)
       && profile.lumpSumAmount<row.standardCapitalReferenceInr)
       reasons.push('REPORTED_LUMP_SUM_BELOW_STANDARD_REFERENCE_NOT_PROOF_OF_INELIGIBILITY');
   }
   if(profile.riskTolerance==='Conservative' && /EQUITY_|AIF_|SPECIALIZED_|PERPETUAL_/.test(row.exposureClass))
     reasons.push('CONSERVATIVE_PROFILE_REQUIRES_ACTUAL_SCHEME_RISK_REVIEW');
   if(row.id.startsWith('catalog_2026_nps_')) {
     reasons.push('NPS_ALLOCATION_EXIT_AND_AGE_RULES_REQUIRE_SCHEME_REVIEW');
     if(row.id === 'catalog_2026_nps_vatsalya')
       reasons.push('NPS_VATSALYA_MINOR_GUARDIAN_KYC_AND_AGE_18_TRANSITION_REQUIRE_REVIEW');
     else
       // PFRDA All Citizen Model: removal of the five-year minimum does not
       // remove vesting, scheme-specific lock-in or premature-exit conditions.
       reasons.push('NPS_FIVE_YEAR_MINIMUM_REMOVED_BUT_VESTING_AND_EXIT_RULES_APPLY');
   }
   if(row.id==='catalog_2026_sdl_coupon_strip' || row.id==='catalog_2026_sdl_principal_strip') {
     reasons.push('SGS_STRIP_SECURITY_ELIGIBILITY_AND_CUSTODIAN_ACCESS_NOT_VERIFIED');
     if(profile.riskTolerance==='Conservative')
       reasons.push('CONSERVATIVE_PROFILE_REQUIRES_STRIP_MARKET_PRICE_AND_LIQUIDITY_REVIEW');
   }
   if(row.id.startsWith('catalog_2026_ncd_'))
     reasons.push('DEBT_CREDIT_SECURITY_AND_DISCLOSURES_REQUIRE_INSTRUMENT_REVIEW');
   if(profile.riskTolerance==='Conservative'
     && /NPS_EQUITY|NPS_ALTERNATIVES|SMALL_MID_CAP|SECTOR_CONCENTRATION|SIF_LONG_SHORT|PMS_MANAGER/.test(row.exposureClass))
     reasons.push('CONSERVATIVE_PROFILE_REQUIRES_PRODUCT_SPECIFIC_RISK_REVIEW');
   return {
     id:row.id,
     profileAssessment:'MISSING_SUITABILITY_EVIDENCE',
     reasonCode:reasons[1]||reasons[0],
     screeningReasonCodes:reasons,
     researchedStructuralExposure:row.exposureClass,
     source:'EXTENDED_95_DISCOVERY',
     scoreAvailable:false,productQualified:false,
     productRiskLevel:null,
     evidenceScope:'REGULATORY_STRUCTURE_ONLY',
   };
 });
}
