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
  || research.entries.some((e,i)=> e.id!==universe[i].id
    || !idSet.has(e.id) || legacyIds.has(e.id)
    || e.referenceUrl!==universe[i].sourceUrl
    || !e.exposureClass || !e.scenarioDescription?.includes(e.name)
    || e.productRiskScore!==null || e.actualRetailProductEligible!==false
    || e.marketFactsVerified!==false || e.sourcePermissionVerified!==false
    || e.overallEvidence!=='STRUCTURAL_CLASSIFICATION_ONLY_NOT_READY_FOR_RECOMMENDATION'
    || e.fiscalYearTaxVerified!==false
    || !['https:'].includes(new URL(e.referenceUrl).protocol))) {
  throw new Error('FINANCIAL_95_FRAMEWORK_RESEARCH_COVERAGE_INVALID');
}
const studyById=new Map(research.entries.map(e=>[e.id,e]));
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
   if(nonnegative(row.standardCapitalReferenceInr)) {
     reasons.push('STANDARD_REGULATORY_CAPITAL_MINIMUM_HAS_EXCEPTIONS');
     if(profile.hasLumpSum===true && nonnegative(profile.lumpSumAmount)
       && profile.lumpSumAmount<row.standardCapitalReferenceInr)
       reasons.push('REPORTED_LUMP_SUM_BELOW_STANDARD_REFERENCE_NOT_PROOF_OF_INELIGIBILITY');
   }
   if(profile.riskTolerance==='Conservative' && /EQUITY_|AIF_|SPECIALIZED_|PERPETUAL_/.test(row.exposureClass))
     reasons.push('CONSERVATIVE_PROFILE_REQUIRES_ACTUAL_SCHEME_RISK_REVIEW');
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
