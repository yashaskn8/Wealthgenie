import {readFileSync} from 'node:fs';
import {buildRecommendationProfile} from './recommendationProfile.js';
import {investmentDatabase} from '../data/investmentDatabase.js';

const universe=JSON.parse(readFileSync(
  new URL('../data/investmentUniverseExtensions2026.json',import.meta.url),'utf8')).entries;
const research=JSON.parse(readFileSync(
  new URL('../data/extensionFrameworkResearch2026.json',import.meta.url),'utf8'));
const idSet=new Set(universe.map(x=>x.id));
const legacyIds=new Set(investmentDatabase.map(x=>x.id));
const nbfcDepositIds=new Set(['catalog_2026_nbfc_fd_cumulative','catalog_2026_nbfc_fd_payout']);
const bankDepositStructures=Object.freeze({"catalog_2026_bank_rd":"RECURRING_INSTALLMENT_DEPOSIT","catalog_2026_bank_tax_saver_fd":"FIVE_YEAR_TAX_SAVER_TERM_DEPOSIT","catalog_2026_bank_sweep_fd":"SWEEP_LINKED_TERM_DEPOSIT","catalog_2026_bank_fd_monthly":"NONCUMULATIVE_MONTHLY_PAYOUT","catalog_2026_bank_fd_quarterly":"NONCUMULATIVE_QUARTERLY_PAYOUT"});
const bankDepositRbiFaqUrl="https://www.rbi.org.in/commonman/Upload/English/FAQs/PDFs/FAQIRD01042025.pdf";
const bankDepositDicgcUrl="https://www.dicgc.org.in/guide-to-deposit-insurance";
const historicalTaxSaverCircularUrl="https://www.incometaxindia.gov.in/w/11/2006-circular-no.-11/2006-dated-16-11-2006";
const retailDirectIds=new Set(['catalog_2026_tbill_91','catalog_2026_tbill_182','catalog_2026_tbill_364','catalog_2026_sdl_dated']);
const postalSavingsIds=new Set(['catalog_2026_po_savings','catalog_2026_po_td_2','catalog_2026_po_td_3','catalog_2026_po_td_5']);
const governmentBondStructureTypes=Object.freeze({"catalog_2026_gsec_coupon_strip":"CENTRAL_GSEC_COUPON_STRIP","catalog_2026_gsec_principal_strip":"CENTRAL_GSEC_PRINCIPAL_STRIP","catalog_2026_sovereign_green":"SOVEREIGN_GREEN_USE_OF_PROCEEDS_BOND","catalog_2026_gsec_floating":"FLOATING_RATE_CENTRAL_GSEC"});
const governmentBondOfficialSources=Object.freeze({"catalog_2026_gsec_coupon_strip":"https://m.rbi.org.in/commonman/english/scripts/FAQs.aspx?Id=711","catalog_2026_gsec_principal_strip":"https://m.rbi.org.in/commonman/english/scripts/FAQs.aspx?Id=711","catalog_2026_sovereign_green":"https://dea.gov.in/framework-sovereign-green-bonds","catalog_2026_gsec_floating":"https://m.rbi.org.in/commonman/english/scripts/FAQs.aspx?Id=711"});
const sebiDebtSchemeKinds=Object.freeze({"catalog_2026_gilt_10y_constant":"GILT_10_YEAR_CONSTANT_DURATION","catalog_2026_medium_long_duration_mf":"MEDIUM_TO_LONG_TERM_DEBT_FUND","catalog_2026_long_duration_mf":"LONG_TERM_DEBT_FUND","catalog_2026_target_maturity_gsec_index":"GSEC_TARGET_MATURITY_INDEX_STRATEGY","catalog_2026_target_maturity_sdl_index":"SDL_TARGET_MATURITY_INDEX_STRATEGY","catalog_2026_target_maturity_psu_index":"PSU_BOND_TARGET_MATURITY_INDEX_STRATEGY","catalog_2026_constant_maturity_debt_index":"CONSTANT_MATURITY_PASSIVE_DEBT_INDEX_STRATEGY","catalog_2026_domestic_debt_fof":"DOMESTIC_DEBT_FUND_OF_FUNDS","catalog_2026_gsec_debt_etf":"GSEC_PASSIVE_DEBT_ETF_STRATEGY"});
const sebiDebtSchemeCircularUrl="https://www.sebi.gov.in/legal/circulars/feb-2026/categorization-and-rationalization-of-mutual-fund-schemes_99983.html";
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
  || research.entries.some(x=> nbfcDepositIds.has(x.id)
    ? (x.referenceReviewedAt!=='2026-10-29'
      || x.nbfcPublicDepositAccessReview?.officialRbiDirectionsUrl!=='https://rbi.org.in/scripts/NotificationUser.aspx?Id=10563'
      || x.nbfcPublicDepositAccessReview?.officialDicgcCoverageUrl!=='https://www.dicgc.org.in/guide-to-deposit-insurance'
      || x.nbfcPublicDepositAccessReview?.reviewedOn!=='2026-10-29'
      || x.nbfcPublicDepositAccessReview?.frameworkMinimumMonths!==12
      || x.nbfcPublicDepositAccessReview?.frameworkMaximumMonths!==60
      || x.nbfcPublicDepositAccessReview?.issuerDepositTakingPermissionVerified!==false
      || x.nbfcPublicDepositAccessReview?.issuerCreditRatingVerified!==false
      || x.nbfcPublicDepositAccessReview?.issuerSpecificTermsVerified!==false
      || x.nbfcPublicDepositAccessReview?.individualRetailEligibilityVerified!==false
      || x.nbfcPublicDepositAccessReview?.commercialDataRightsVerified!==false)
    : x.nbfcPublicDepositAccessReview!==undefined)
  || research.entries.some(x=>Object.hasOwn(bankDepositStructures,x.id)
    ? (x.referenceReviewedAt!=='2026-10-29'
      || x.bankDepositAccessReview?.depositStructure!==bankDepositStructures[x.id]
      || x.bankDepositAccessReview?.officialRbiInterestOnDepositsFaqUrl!==bankDepositRbiFaqUrl
      || x.bankDepositAccessReview?.officialDicgcCoverageUrl!==bankDepositDicgcUrl
      || x.bankDepositAccessReview?.reviewedOn!=='2026-10-29'
      || x.bankDepositAccessReview?.sourceScope!=='GENERAL_BANK_DEPOSIT_RULES_NOT_ISSUER_CONTRACT_CURRENT_RATE_OR_INDIVIDUAL_ELIGIBILITY'
      || x.bankDepositAccessReview?.historicalTaxSaverSchemeSourceUrl!==(x.id==='catalog_2026_bank_tax_saver_fd'?historicalTaxSaverCircularUrl:null)
      || x.bankDepositAccessReview?.fiveYearSchemeReferenceMonths!==(x.id==='catalog_2026_bank_tax_saver_fd'?60:null)
      || x.bankDepositAccessReview?.specificBankDepositIdentityVerified!==false
      || x.bankDepositAccessReview?.bankInsuranceStatusAndAggregateBalanceVerified!==false
      || x.bankDepositAccessReview?.issuerRatePayoutAndEarlyExitTermsVerified!==false
      || x.bankDepositAccessReview?.accountKycAndIndividualEligibilityVerified!==false
      || x.bankDepositAccessReview?.currentTaxRegimeAndDeductionEligibilityVerified!==false
      || x.bankDepositAccessReview?.independentCommercialDataRightsVerified!==false
      || x.bankDepositAccessReview?.personalizedSuitabilityVerified!==false)
    : x.bankDepositAccessReview!==undefined)
  || research.entries.some(x=>postalSavingsIds.has(x.id)
    ? (x.referenceReviewedAt!=='2026-10-29'
      || x.postalSavingsAccessReview?.officialIndiaPostSchemeListingUrl!=='https://www.indiapost.gov.in/banking-services/savings'
      || x.postalSavingsAccessReview?.reviewedOn!=='2026-10-29'
      || x.postalSavingsAccessReview?.schemeType!==(x.id==='catalog_2026_po_savings'?'SAVINGS_ACCOUNT':'NATIONAL_SAVINGS_TIME_DEPOSIT')
      || x.postalSavingsAccessReview?.nominalTenorMonths!==x.nominalMaturityMonths
      || x.postalSavingsAccessReview?.publicSchemeListingObserved!==true
      || x.postalSavingsAccessReview?.schemeListingScope!=='GENERAL_PUBLIC_SCHEME_LISTING_NOT_INDIVIDUAL_ACCOUNT_OR_TENOR_RATE'
      || x.postalSavingsAccessReview?.individualAccountEligibilityAndKycVerified!==false
      || x.postalSavingsAccessReview?.currentAccountTermsAndEarlyExitVerified!==false
      || x.postalSavingsAccessReview?.independentlyAuthorizedCurrentRateVerified!==false
      || x.postalSavingsAccessReview?.commercialDisplayAndRedistributionRightsVerified!==false
      || x.postalSavingsAccessReview?.personalizedSuitabilityVerified!==false)
    : x.postalSavingsAccessReview!==undefined)
  || research.entries.some(x=>Object.hasOwn(governmentBondStructureTypes,x.id)
    ? (x.referenceReviewedAt!=='2026-10-29'
      || x.governmentBondStructureReview?.structureType!==governmentBondStructureTypes[x.id]
      || x.governmentBondStructureReview?.officialStructureSourceUrl!==governmentBondOfficialSources[x.id]
      || x.governmentBondStructureReview?.reviewedOn!=='2026-10-29'
      || x.governmentBondStructureReview?.sourceScope!=='GENERAL_ISSUANCE_OR_STRUCTURE_FRAMEWORK_NOT_A_CURRENT_SECURITY'
      || x.verifiedPublicFrameworkFact?.officialSourceUrl!==governmentBondOfficialSources[x.id]
      || x.governmentBondStructureReview?.specificSecurityIsinVerified!==false
      || x.governmentBondStructureReview?.specificCouponMaturityAndTermsVerified!==false
      || x.governmentBondStructureReview?.retailAccessCustodyAndKycVerified!==false
      || x.governmentBondStructureReview?.currentMarketPriceOrYieldVerified!==false
      || x.governmentBondStructureReview?.independentCommercialDataRightsVerified!==false
      || x.governmentBondStructureReview?.taxAndProductSuitabilityVerified!==false)
    : x.governmentBondStructureReview!==undefined)
  || research.entries.some(x=>retailDirectIds.has(x.id)
    ? (x.referenceReviewedAt!=='2026-10-29'
      || x.rbiRetailDirectAccessReview?.officialRetailDirectFaqUrl!=='https://www.rbi.org.in/Scripts/FAQView.aspx?Id=145'
      || x.rbiRetailDirectAccessReview?.faqPublishedOn!=='2021-11-12'
      || x.rbiRetailDirectAccessReview?.reviewedOn!=='2026-10-29'
      || x.rbiRetailDirectAccessReview?.securityClass!==(x.id.startsWith('catalog_2026_tbill_')?'TREASURY_BILL':'STATE_DEVELOPMENT_LOAN')
      || x.rbiRetailDirectAccessReview?.generalRetailAccessDescribed!==true
      || x.rbiRetailDirectAccessReview?.sourceScope!=='GENERAL_RETAIL_DIRECT_FRAMEWORK_ONLY_NOT_CURRENT_ISSUE_OR_ACCOUNT_APPROVAL'
      || x.rbiRetailDirectAccessReview?.profileSpecificAccountEligibilityVerified!==false
      || x.rbiRetailDirectAccessReview?.currentIssueOrQuoteVerified!==false
      || x.rbiRetailDirectAccessReview?.specificInstrumentTermsVerified!==false
      || x.rbiRetailDirectAccessReview?.independentCommercialDataPermissionVerified!==false
      || x.rbiRetailDirectAccessReview?.instrumentSpecificSuitabilityVerified!==false
      || (x.id.startsWith('catalog_2026_tbill_')
        ? x.rbiRetailDirectAccessReview?.officialTenorAuctionReferenceUrl!=='https://www.rbi.org.in/scripts/BS_PressReleaseDisplay.aspx?prid=60420'
        : x.rbiRetailDirectAccessReview?.officialTenorAuctionReferenceUrl!==undefined))
    : x.rbiRetailDirectAccessReview!==undefined)
  || research.entries.some(x=>Object.hasOwn(sebiDebtSchemeKinds,x.id)
    ? (x.referenceReviewedAt!=='2026-10-29'
      || x.sebiDebtSchemeStructureReview?.schemeArchetype!==sebiDebtSchemeKinds[x.id]
      || x.sebiDebtSchemeStructureReview?.officialSebiCategorizationCircularUrl!==sebiDebtSchemeCircularUrl
      || x.sebiDebtSchemeStructureReview?.circularIssuedOn!=='2026-02-26'
      || x.sebiDebtSchemeStructureReview?.reviewedOn!=='2026-10-29'
      || x.sebiDebtSchemeStructureReview?.sourceScope!=='REGULATORY_SCHEME_CATEGORY_ONLY_NOT_AN_ACTUAL_FUND_OR_CURRENT_RISKOMETER'
      || x.verifiedPublicFrameworkFact?.officialSourceUrl!==sebiDebtSchemeCircularUrl
      || !Array.isArray(x.sebiDebtSchemeStructureReview?.riskConsiderations)
      || x.sebiDebtSchemeStructureReview.riskConsiderations.length<2
      || !Array.isArray(x.sebiDebtSchemeStructureReview?.investorAccessConstraints)
      || x.sebiDebtSchemeStructureReview.investorAccessConstraints.length<1
      || ['specificSchemeAndAmcVerified','currentSchemeRiskometerVerified',
        'currentNavOrExchangeQuoteVerified','currentSidKimAndExitLoadVerified',
        'investorKycAndRetailAccessVerified','independentCommercialDataRightsVerified',
        'taxTreatmentAndAdviceAuthorizationVerified','individualSuitabilityVerified']
        .some(key=>x.sebiDebtSchemeStructureReview[key]!==false))
    : x.sebiDebtSchemeStructureReview!==undefined)
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
 return research.entries.map(row=>JSON.parse(JSON.stringify(row)));
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
   if(row.postalSavingsAccessReview) {
     reasons.push('INDIA_POST_ACCOUNT_KYC_AND_INDIVIDUAL_ELIGIBILITY_UNVERIFIED');
     reasons.push('INDIA_POST_CURRENT_ACCOUNT_TERMS_RATE_AND_SOURCE_RIGHTS_UNVERIFIED');
     if(row.postalSavingsAccessReview.schemeType==='NATIONAL_SAVINGS_TIME_DEPOSIT') {
       reasons.push('POST_OFFICE_TIME_DEPOSIT_EARLY_CLOSURE_TERMS_REQUIRE_CURRENT_REVIEW');
       if(row.nominalMaturityMonths===60)
         reasons.push('POST_OFFICE_FIVE_YEAR_TD_EARLY_EXIT_CONDITIONS_REQUIRE_SPECIAL_REVIEW');
       if(profile.riskTolerance==='Conservative')
         reasons.push('CONSERVATIVE_PROFILE_REQUIRES_POSTAL_TD_EARLY_EXIT_LIQUIDITY_REVIEW');
     } else {
       reasons.push('POST_OFFICE_SAVINGS_ACCOUNT_BALANCE_AND_WITHDRAWAL_TERMS_UNVERIFIED');
     }
   }
   if(row.bankDepositAccessReview) {
     reasons.push('BANK_DEPOSIT_ISSUER_KYC_RATES_TERMS_AND_DATA_RIGHTS_UNVERIFIED');
     reasons.push('DICGC_COVERAGE_REQUIRES_INSURED_BANK_AND_AGGREGATE_DEPOSITOR_CAPACITY_REVIEW');
     if(profile.investmentGoals.includes('Emergency Fund'))
       reasons.push('EMERGENCY_FUND_GOAL_REQUIRES_BANK_DEPOSIT_EARLY_ACCESS_REVIEW');
     switch(row.bankDepositAccessReview.depositStructure) {
       case 'RECURRING_INSTALLMENT_DEPOSIT':
         reasons.push('RECURRING_DEPOSIT_INSTALLMENT_AND_MISSED_PAYMENT_TERMS_UNVERIFIED'); break;
       case 'FIVE_YEAR_TAX_SAVER_TERM_DEPOSIT':
         reasons.push('TAX_SAVER_FIVE_YEAR_SCHEME_AND_CURRENT_TAX_REGIME_REQUIRE_REVIEW');
         if(profile.investmentHorizonYears<5)
           reasons.push('TAX_SAVER_FIVE_YEAR_REFERENCE_EXCEEDS_PROFILE_HORIZON');
         break;
       case 'SWEEP_LINKED_TERM_DEPOSIT':
         reasons.push('SWEEP_TRIGGER_PARTIAL_BREAKAGE_AND_LIQUIDITY_TERMS_UNVERIFIED'); break;
       case 'NONCUMULATIVE_MONTHLY_PAYOUT':
         reasons.push('MONTHLY_DEPOSIT_PAYOUT_AND_EFFECTIVE_RETURN_REQUIRE_ISSUER_TERMS'); break;
       case 'NONCUMULATIVE_QUARTERLY_PAYOUT':
         reasons.push('QUARTERLY_DEPOSIT_PAYOUT_AND_EFFECTIVE_RETURN_REQUIRE_ISSUER_TERMS'); break;
     }
     if(profile.riskTolerance==='Conservative')
       reasons.push('CONSERVATIVE_PROFILE_REQUIRES_BANK_DEPOSIT_EARLY_EXIT_AND_COVERAGE_REVIEW');
   }
   if(row.sebiDebtSchemeStructureReview) {
     reasons.push('DEBT_FUND_SCHEME_RISKOMETER_NAV_ELIGIBILITY_AND_DATA_RIGHTS_UNVERIFIED');
     reasons.push('DEBT_FUND_SID_HOLDINGS_FEES_AND_EXIT_LOAD_REQUIRE_SCHEME_REVIEW');
     switch(row.sebiDebtSchemeStructureReview.schemeArchetype) {
       case 'GILT_10_YEAR_CONSTANT_DURATION':
         reasons.push('GILT_10Y_DURATION_RATE_SENSITIVITY_NOT_RISK_FREE'); break;
       case 'MEDIUM_TO_LONG_TERM_DEBT_FUND':
         reasons.push('MEDIUM_LONG_DEBT_NORMAL_AND_ADVERSE_DURATION_REQUIRE_REVIEW'); break;
       case 'LONG_TERM_DEBT_FUND':
         reasons.push('LONG_DURATION_DEBT_INTEREST_RATE_AND_NAV_RISK_REQUIRE_REVIEW'); break;
       case 'DOMESTIC_DEBT_FUND_OF_FUNDS':
         reasons.push('DEBT_FOF_UNDERLYING_SCHEMES_AND_LAYERED_FEES_UNVERIFIED'); break;
       case 'GSEC_PASSIVE_DEBT_ETF_STRATEGY':
         reasons.push('GSEC_DEBT_ETF_MARKET_PRICE_VS_NAV_AND_LIQUIDITY_UNVERIFIED'); break;
       case 'CONSTANT_MATURITY_PASSIVE_DEBT_INDEX_STRATEGY':
         reasons.push('CONSTANT_MATURITY_DEBT_INDEX_RESET_AND_DURATION_REQUIRE_REVIEW'); break;
       default:
         reasons.push('TARGET_MATURITY_DEBT_INDEX_BENCHMARK_AND_SCHEME_TERMS_UNVERIFIED');
     }
     if(profile.investmentHorizonYears<3)
       reasons.push('SHORT_HORIZON_REQUIRES_DEBT_SCHEME_REDEMPTION_AND_NAV_REVIEW');
     if(profile.investmentGoals.includes('Emergency Fund'))
       reasons.push('EMERGENCY_FUND_REQUIRES_DEBT_SCHEME_SETTLEMENT_AND_LIQUIDITY_REVIEW');
     if(profile.riskTolerance==='Conservative')
       reasons.push('CONSERVATIVE_PROFILE_REQUIRES_DEBT_SCHEME_RATE_AND_CREDIT_RISK_REVIEW');
   }
   if(row.nbfcPublicDepositAccessReview) {
     reasons.push('NBFC_PUBLIC_DEPOSITS_NOT_DICGC_INSURED');
     reasons.push('NBFC_RBI_DEPOSIT_TAKING_PERMISSION_AND_CURRENT_RATING_NOT_VERIFIED');
     reasons.push('NBFC_TENOR_AND_PREMATURE_REPAYMENT_REQUIRE_ISSUER_TERMS');
     if(profile.riskTolerance==='Conservative')
       reasons.push('CONSERVATIVE_PROFILE_REQUIRES_NBFC_CREDIT_AND_LIQUIDITY_REVIEW');
   }
   if(row.governmentBondStructureReview) {
     reasons.push('GOVT_BOND_ISIN_TERMS_RETAIL_ACCESS_AND_SOURCE_RIGHTS_UNVERIFIED');
     if(row.governmentBondStructureReview.structureType.endsWith('_STRIP')) {
       reasons.push('CENTRAL_GSEC_STRIP_CASH_FLOW_AND_CUSTODIAN_ACCESS_REQUIRE_ISIN_REVIEW');
       reasons.push('GSEC_STRIPS_SECONDARY_MARKET_LIQUIDITY_AND_NO_INTERIM_CASH_FLOW_REVIEW');
     } else if(row.id==='catalog_2026_sovereign_green') {
       reasons.push('SOVEREIGN_GREEN_USE_OF_PROCEEDS_NOT_INSTRUMENT_OR_IMPACT_APPROVAL');
     } else if(row.id==='catalog_2026_gsec_floating') {
       reasons.push('FLOATING_RATE_GSEC_RESET_BASIS_SPREAD_AND_DATES_UNVERIFIED');
     }
     if(profile.riskTolerance==='Conservative')
       reasons.push('CONSERVATIVE_PROFILE_REQUIRES_GOVT_BOND_MARKET_PRICE_AND_LIQUIDITY_REVIEW');
   }
   if(row.rbiRetailDirectAccessReview) {
     reasons.push('RBI_RETAIL_DIRECT_ACCOUNT_KYC_AND_PERSONAL_ELIGIBILITY_UNVERIFIED');
     reasons.push('GOVERNMENT_SECURITY_CURRENT_ISSUE_PRICE_AND_SOURCE_RIGHTS_UNVERIFIED');
     if(profile.riskTolerance==='Conservative')
       reasons.push('CONSERVATIVE_PROFILE_REQUIRES_GOVT_SECURITY_EARLY_SALE_PRICE_AND_LIQUIDITY_REVIEW');
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
