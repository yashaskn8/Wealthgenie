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
const npsCommonChoiceSpecs=Object.freeze({"catalog_2026_nps_lc25":{"choiceCode":"LIFE_CYCLE_25_LOW","choiceType":"AUTO_CHOICE","age35":25,"age55":5,"taperAfter":35,"cap":null},"catalog_2026_nps_lc50":{"choiceCode":"LIFE_CYCLE_50_MODERATE","choiceType":"AUTO_CHOICE","age35":50,"age55":10,"taperAfter":35,"cap":null},"catalog_2026_nps_lc75":{"choiceCode":"LIFE_CYCLE_75_HIGH","choiceType":"AUTO_CHOICE","age35":75,"age55":15,"taperAfter":35,"cap":null},"catalog_2026_nps_lc_aggressive":{"choiceCode":"LIFE_CYCLE_AGGRESSIVE_FORMER_BALANCED","choiceType":"AUTO_CHOICE","age35":50,"age55":35,"taperAfter":45,"cap":null},"catalog_2026_nps_asset_e":{"choiceCode":"ACTIVE_CLASS_E_EQUITY","choiceType":"ACTIVE_CHOICE","age35":null,"age55":null,"taperAfter":null,"cap":75},"catalog_2026_nps_asset_c":{"choiceCode":"ACTIVE_CLASS_C_CORPORATE_BONDS","choiceType":"ACTIVE_CHOICE","age35":null,"age55":null,"taperAfter":null,"cap":100},"catalog_2026_nps_asset_g":{"choiceCode":"ACTIVE_CLASS_G_GOVERNMENT_SECURITIES","choiceType":"ACTIVE_CHOICE","age35":null,"age55":null,"taperAfter":null,"cap":100},"catalog_2026_nps_asset_a":{"choiceCode":"ACTIVE_CLASS_A_ALTERNATIVES","choiceType":"ACTIVE_CHOICE","age35":null,"age55":null,"taperAfter":null,"cap":5}});
const npsAllCitizenUrl="https://pfrda.org.in/en/schemes/national-pension-system/nps-for-all-citizen-models";
const npsPensionFundsUrl="https://pfrda.org.in/en/intermediaries/registered-intermediaries/pension-funds";
const npsLifecycleCircularUrl="https://pfrda.org.in/documents/33652/154008/Circular%2Bon%2BRationalization%2Bof%2BNomenclature%2Bof%2BAuto%2BChoice%2BLife%2BCycle%2BFunds%2Bunder%2Bthe%2BNPS%2BMultiple%2BChoices%2Bof%2BInvestment%2Bunder%2BCommon%2BSchemes.pdf";
const npsMultipleNavNoticeUrl="https://www.pfrda.org.in/w/implementation-of-multiple-navs-framework-w.e.f.-01st-april-2026";
const validNpsMultipleNavReview=review=>{
 const nav=review?.multipleNavFrameworkReview;
 return nav?.officialPfrdaNoticeUrl===npsMultipleNavNoticeUrl
  && nav.noticeIssuedOn==='2026-03-24' && nav.effectiveFrom==='2026-04-01'
  && nav.reviewedOn==='2026-10-29'
  && nav.sourceScope==='PFRDA_MULTIPLE_NAV_FEE_FRAMEWORK_NOT_AN_INDIVIDUAL_SUBSCRIBER_NAV'
  && nav.governmentAndNonGovernmentInvestmentManagementFeeDifferentiationNoted===true
  && nav.popAndEnpsChannelChargesAdjustedThroughNavNoted===true
  && ['subscriberSectorAndChannelVerified','specificPensionFundNavVariantVerified',
    'applicableFeesAndUnitsVerified','commercialNavReuseRightsVerified',
    'individualSuitabilityVerified'].every(key=>nav[key]===false);
};
const aifCategoryStructures=Object.freeze({"catalog_2026_aif1_vc":"CATEGORY_I_VENTURE_CAPITAL","catalog_2026_aif1_sme":"CATEGORY_I_SME","catalog_2026_aif1_social":"CATEGORY_I_SOCIAL_IMPACT","catalog_2026_aif1_infra":"CATEGORY_I_INFRASTRUCTURE","catalog_2026_aif2_pe":"CATEGORY_II_PRIVATE_EQUITY","catalog_2026_aif2_debt":"CATEGORY_II_PRIVATE_DEBT","catalog_2026_aif3_hedge":"CATEGORY_III_HEDGE_STRATEGY"});
const aifOctoberRegulationsUrl="https://www.sebi.gov.in/legal/regulations/oct-2026/securities-and-exchange-board-of-india-alternative-investment-funds-regulations-2012-last-amended-on-october-15-2026-_105374.html";
const pfrdaPopOctoberUrl="https://www.pfrda.org.in/w/charge-structure-applicable-to-pops-for-all-schemes-under-nps-and-nps-lite-1";
const rbiSgsStripsUrl="https://www.rbi.org.in/Scripts/NotificationUser.aspx?Id=12867&Mode=0";
const npsExitFaqUrl="https://www.pfrda.org.in/documents/33652/676426/Exits%2Band%2BWithdrawals%2Bunder%2BNPS%2Bfor%2BAll%2BCitizen%2BModel%2B%281%29.pdf";
const nseBroadIndexPages=Object.freeze({"catalog_2026_index_nifty_next50":"https://www.niftyindices.com/indices/equity/broad-based-indices/nifty-next-50","catalog_2026_index_nifty100":"https://www.niftyindices.com/indices/equity/broad-based-indices/nifty-100","catalog_2026_index_nifty500":"https://www.niftyindices.com/indices/equity/broad-based-indices/nifty-500","catalog_2026_index_midcap150":"https://www.niftyindices.com/indices/equity/broad-based-indices/nifty-midcap-150","catalog_2026_index_smallcap250":"https://www.niftyindices.com/indices/equity/broad-based-indices/niftysmallcap250"});
const sebiDebtSchemeCircularUrl="https://www.sebi.gov.in/legal/circulars/feb-2026/categorization-and-rationalization-of-mutual-fund-schemes_99983.html";
const nseFactorIndexSpecs=Object.freeze({"catalog_2026_index_nifty50_equal":{"url":"https://www.niftyindices.com/indices/equity/strategy-indices/nifty50-equal-weight","code":"EQUAL_WEIGHT_NIFTY50"},"catalog_2026_index_nifty100_equal":{"url":"https://www.niftyindices.com/indices/equity/strategy-indices/nifty-100-equal-weight","code":"EQUAL_WEIGHT_NIFTY100"},"catalog_2026_index_nifty200_quality":{"url":"https://www.niftyindices.com/indices/equity/strategy-indices/nifty200-quality-30","code":"QUALITY_SCORE_NIFTY200"},"catalog_2026_index_nifty_lowvol":{"url":"https://www.niftyindices.com/indices/equity/strategy-indices/nifty-100-low-volatility","code":"LOW_VOLATILITY_NIFTY100"},"catalog_2026_index_nifty500_momentum":{"url":"https://niftyindices.com/indices/equity/strategy-indices/nifty500-momentum-50","code":"MOMENTUM_NIFTY500"},"catalog_2026_index_nifty500_equal":{"url":"https://www.niftyindices.com/indices/equity/strategy-indices/nifty500-equal-weight","code":"EQUAL_WEIGHT_NIFTY500"}});
const nseIndexPages=Object.freeze({...nseBroadIndexPages,...Object.fromEntries(Object.entries(nseFactorIndexSpecs).map(([id,x])=>[id,x.url]))});
const nseEquityEtfBenchmarks=Object.freeze({"catalog_2026_etf_nifty100":"https://www.niftyindices.com/indices/equity/broad-based-indices/nifty-100","catalog_2026_etf_nifty500":"https://www.niftyindices.com/indices/equity/broad-based-indices/nifty-500","catalog_2026_etf_smallcap250":"https://www.niftyindices.com/indices/equity/broad-based-indices/niftysmallcap250","catalog_2026_etf_nifty50_equal":"https://www.niftyindices.com/indices/equity/strategy-indices/nifty50-equal-weight","catalog_2026_etf_nifty100_equal":"https://www.niftyindices.com/indices/equity/strategy-indices/nifty-100-equal-weight","catalog_2026_etf_nifty200_quality":"https://www.niftyindices.com/indices/equity/strategy-indices/nifty200-quality-30","catalog_2026_etf_nifty500_lowvol":"https://www.niftyindices.com/indices/equity/strategy-indices/nifty500-low-volatility-50","catalog_2026_etf_nifty500_momentum":"https://niftyindices.com/indices/equity/strategy-indices/nifty500-momentum-50","catalog_2026_etf_india_defence":"https://www.niftyindices.com/indices/equity/thematic-indices/nifty-india-defence","catalog_2026_etf_india_consumption":"https://www.niftyindices.com/indices/equity/thematic-indices/nifty-india-consumption"});
const nseAdditionalEtfBenchmarks=Object.freeze({"catalog_2026_etf_nifty200_quality":{"url":"https://www.niftyindices.com/indices/equity/strategy-indices/nifty200-quality-30","code":"QUALITY_FACTOR_NIFTY200"},"catalog_2026_etf_nifty500_lowvol":{"url":"https://www.niftyindices.com/indices/equity/strategy-indices/nifty500-low-volatility-50","code":"LOW_VOLATILITY_FACTOR_NIFTY500"},"catalog_2026_etf_nifty500_momentum":{"url":"https://niftyindices.com/indices/equity/strategy-indices/nifty500-momentum-50","code":"MOMENTUM_FACTOR_NIFTY500"},"catalog_2026_etf_india_defence":{"url":"https://www.niftyindices.com/indices/equity/thematic-indices/nifty-india-defence","code":"DEFENCE_THEME"},"catalog_2026_etf_india_consumption":{"url":"https://www.niftyindices.com/indices/equity/thematic-indices/nifty-india-consumption","code":"DOMESTIC_CONSUMPTION_THEME"}});
const sebiEtfInvestorEducationUrl="https://investor.sebi.gov.in/exchange_traded_fund.html";
// HTTPS alone is not evidence of an official framework source. Exact hosts
// prevent lookalike domains and credential-bearing URLs from passing validation.
const officialFrameworkHosts=new Set([
  'www.indiapost.gov.in','www.rbi.org.in','m.rbi.org.in','rbi.org.in',
  'dea.gov.in','www.dicgc.org.in','www.sebi.gov.in',
  'investor.sebi.gov.in','www.niftyindices.com','niftyindices.com',
  'pfrda.org.in','www.bis.gov.in',
]);
export function isOfficialFrameworkReferenceUrl(value) {
  if(typeof value!=='string')return false;
  try {
    const url=new URL(value);
    return url.protocol==='https:' && officialFrameworkHosts.has(url.hostname)
      && !url.username && !url.password && !url.port && !url.hash
      && url.pathname.length>1;
  } catch { return false; }
}
// A framework citation without separate, nonempty category risk and access
// research is incomplete. Exactly one category review must back each archetype.
const categoryRiskAccessReviewKeys=Object.freeze([
 'postalSavingsAccessReview','rbiRetailDirectAccessReview','sgsStripsAccessReview',
 'governmentBondStructureReview','bankDepositAccessReview','nbfcPublicDepositAccessReview',
 'sebiDebtSchemeStructureReview','indexBenchmarkReview','thematicIndexReview',
 'etfBenchmarkReview','npsCommonSchemeReview','npsVatsalyaAccessReview',
 'debtInstrumentReview','individualCategoryReview','aifCategoryAccessReview',
 'preciousMetalsCategoryReview','fundOfFundsCategoryReview',
]);
export function hasCompleteCategoryRiskAccessResearch(row) {
 if(!row||typeof row!=='object'||Array.isArray(row))return false;
 const keys=categoryRiskAccessReviewKeys.filter(key=>Object.hasOwn(row,key));
 if(keys.length!==1)return false;
 const review=row[keys[0]];
 const distinctConsiderations=values=>Array.isArray(values)&&values.length>=2
  &&values.every(value=>typeof value==='string'&&value.trim().length>=12)
  &&new Set(values).size===values.length;
 return review!==null&&typeof review==='object'&&!Array.isArray(review)
  &&distinctConsiderations(review.riskConsiderations)
  &&distinctConsiderations(review.investorAccessConstraints);
}
if(research.schemaVersion!==1 || research.categoryCount!==95 || research.entries?.length!==95
  || universe.length!==95 || legacyIds.size!==155
  || research.entries.some(row=>!hasCompleteCategoryRiskAccessResearch(row))
  || research.entries.some(x=>!isOfficialFrameworkReferenceUrl(x.referenceUrl)
    || !isOfficialFrameworkReferenceUrl(x.verifiedPublicFrameworkFact?.officialSourceUrl))
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
  || research.entries.some(x=>x.id.startsWith('catalog_2026_nps_')
    ? !validNpsMultipleNavReview(x.npsCommonSchemeReview||x.npsVatsalyaAccessReview)
    : x.npsCommonSchemeReview?.multipleNavFrameworkReview!==undefined
      || x.npsVatsalyaAccessReview?.multipleNavFrameworkReview!==undefined)
  || research.entries.some(x=>x.id.startsWith('catalog_2026_nps_')
    ? (x.npsCommonSchemeReview||x.npsVatsalyaAccessReview)?.popChargeDateReview?.officialPfrdaCircularUrl!==pfrdaPopOctoberUrl
      || (x.npsCommonSchemeReview||x.npsVatsalyaAccessReview)?.popChargeDateReview?.issuedOn!=='2026-10-26'
      || (x.npsCommonSchemeReview||x.npsVatsalyaAccessReview)?.popChargeDateReview?.priorImplementationDate!=='2026-10-01'
      || (x.npsCommonSchemeReview||x.npsVatsalyaAccessReview)?.popChargeDateReview?.revisedImplementationDate!=='2026-12-01'
      || (x.npsCommonSchemeReview||x.npsVatsalyaAccessReview)?.popChargeDateReview?.individualPopChannelAndApplicableChargesVerified!==false
      || (x.npsCommonSchemeReview||x.npsVatsalyaAccessReview)?.popChargeDateReview?.individualNavFeeImpactVerified!==false
      || (x.npsCommonSchemeReview||x.npsVatsalyaAccessReview)?.popChargeDateReview?.commercialNavRightsVerified!==false
      || (x.npsCommonSchemeReview||x.npsVatsalyaAccessReview)?.popChargeDateReview?.individualSuitabilityVerified!==false
    : x.npsCommonSchemeReview?.popChargeDateReview!==undefined || x.npsVatsalyaAccessReview?.popChargeDateReview!==undefined)
  || research.entries.some(x=>Object.hasOwn(aifCategoryStructures,x.id)
    ? (x.aifCategoryAccessReview?.officialSebiRegulationsUrl!==aifOctoberRegulationsUrl
      || x.aifCategoryAccessReview?.regulationsAmendedThrough!=='2026-10-15'
      || x.referenceReviewedAt!=='2026-10-29'
      || x.aifCategoryAccessReview?.reviewedOn!=='2026-10-29'
      || x.aifCategoryAccessReview?.categoryStructure!==aifCategoryStructures[x.id]
      || x.aifCategoryAccessReview?.privatePlacementRequired!==true
      || x.aifCategoryAccessReview?.generalMinimumInr!==(x.id==='catalog_2026_aif1_social'?null:10000000)
      || x.aifCategoryAccessReview?.socialImpactNpoOnlyIndividualMinimumInr!==(x.id==='catalog_2026_aif1_social'?1000:null)
      || x.aifCategoryAccessReview?.socialUnitsCanCarryNoFinancialReturn!==(x.id==='catalog_2026_aif1_social')
      || !Array.isArray(x.aifCategoryAccessReview?.riskConsiderations)
      || x.aifCategoryAccessReview.riskConsiderations.length<2
      || !Array.isArray(x.aifCategoryAccessReview?.investorAccessConstraints)
      || x.aifCategoryAccessReview.investorAccessConstraints.length<2
      || ['actualFundRegistrationAndPpmVerified','individualAccreditationVerified',
        'individualKycAndSubscriptionEligibilityVerified','schemeFeesTenureAndRedemptionVerified',
        'currentValuationAndCommercialDataRightsVerified','personalizedAdviceAuthorizationVerified']
        .some(k=>x.aifCategoryAccessReview[k]!==false))
    : x.aifCategoryAccessReview!==undefined)
  || research.entries.some(x=>['catalog_2026_sdl_coupon_strip','catalog_2026_sdl_principal_strip'].includes(x.id)
    ? (x.sgsStripsAccessReview?.officialRbiCircularUrl!==rbiSgsStripsUrl
      || x.referenceReviewedAt!=='2026-10-29'
      || x.sgsStripsAccessReview?.reviewedOn!=='2026-10-29'
      || x.sgsStripsAccessReview?.eligibleUnderlyingResidualMaturityMaximumYears!==14
      || x.sgsStripsAccessReview?.eligibleUnderlyingMinimumOutstandingInr!==10000000000
      || x.sgsStripsAccessReview?.underlyingOutstandingIsNotRetailInvestorMinimum!==true
      || x.sgsStripsAccessReview?.actualEligibleUnderlyingAndIsinVerified!==false
      || x.sgsStripsAccessReview?.individualCustodianAccountEligibilityVerified!==false
      || x.sgsStripsAccessReview?.currentPriceYieldAndSecondaryLiquidityVerified!==false
      || x.sgsStripsAccessReview?.commercialDataRightsVerified!==false
      || !Array.isArray(x.sgsStripsAccessReview?.riskConsiderations)
      || x.sgsStripsAccessReview.riskConsiderations.length<2
      || !Array.isArray(x.sgsStripsAccessReview?.investorAccessConstraints)
      || x.sgsStripsAccessReview.investorAccessConstraints.length<2)
    : x.sgsStripsAccessReview!==undefined)
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
      || x.postalSavingsAccessReview?.personalizedSuitabilityVerified!==false
      || !Array.isArray(x.postalSavingsAccessReview?.riskConsiderations)
      || x.postalSavingsAccessReview.riskConsiderations.length<2
      || !Array.isArray(x.postalSavingsAccessReview?.investorAccessConstraints)
      || x.postalSavingsAccessReview.investorAccessConstraints.length<2
      || x.postalSavingsAccessReview?.officialOriginalSchemeRulesUrl!==(x.id==='catalog_2026_po_savings'?null:'https://www.indiapost.gov.in/VAS/DOP_PDFFiles/Savings%20Bank/National%20Savings%20Time%20Deposit%20Scheme%202019%20English.pdf')
      || x.postalSavingsAccessReview?.originalRulesMayHaveSubsequentAmendments!==(x.id!=='catalog_2026_po_savings'))
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
      || !Array.isArray(x.rbiRetailDirectAccessReview?.riskConsiderations)
      || x.rbiRetailDirectAccessReview.riskConsiderations.length<2
      || !Array.isArray(x.rbiRetailDirectAccessReview?.investorAccessConstraints)
      || x.rbiRetailDirectAccessReview.investorAccessConstraints.length<2
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
  || research.entries.some(x=>Object.hasOwn(nseIndexPages,x.id)
    ? (x.referenceReviewedAt!=='2026-10-29'
      || x.indexBenchmarkReview?.officialNseIndexUrl!==nseIndexPages[x.id]
      || x.indexBenchmarkReview?.officialSebiCategorizationCircularUrl!==sebiDebtSchemeCircularUrl
      || x.indexBenchmarkReview?.officialSebiMutualFundRegulationsListingUrl!=='https://www.sebi.gov.in/sebiweb/home/HomeAction.do?doListingLegal=yes&sid=1&ssid=3'
      || x.indexBenchmarkReview?.sebiMutualFundRegulationsLastAmendedOn!=='2026-10-10'
      || x.indexBenchmarkReview?.reviewedOn!=='2026-10-29'
      || x.indexBenchmarkReview?.sourceScope!=='OFFICIAL_INDEX_METHODOLOGY_AND_GENERAL_MUTUAL_FUND_RULES_NOT_AN_APPROVED_SCHEME'
      || x.verifiedPublicFrameworkFact?.officialSourceUrl!==nseIndexPages[x.id]
      || !Array.isArray(x.indexBenchmarkReview?.riskConsiderations)
      || x.indexBenchmarkReview.riskConsiderations.length<2
      || !Array.isArray(x.indexBenchmarkReview?.investorAccessConstraints)
      || x.indexBenchmarkReview.investorAccessConstraints.length<2
      || ['specificSchemeAndAmcVerified','currentSchemeRiskometerVerified',
        'currentNavOrExchangeQuoteVerified','currentSidKimFeesAndTrackingErrorVerified',
        'investorKycAndRetailAccessVerified','independentCommercialDataRightsVerified',
        'taxTreatmentAndAdviceAuthorizationVerified','individualSuitabilityVerified']
        .some(key=>x.indexBenchmarkReview[key]!==false))
    : x.indexBenchmarkReview!==undefined)
  || research.entries.some(x=>Object.hasOwn(nseFactorIndexSpecs,x.id)
    ? (x.indexBenchmarkReview?.factorStrategyCode!==nseFactorIndexSpecs[x.id].code
      || typeof x.indexBenchmarkReview?.factorMethodology!=='string'
      || x.indexBenchmarkReview.factorMethodology.length<35)
    : x.indexBenchmarkReview?.factorStrategyCode!==undefined)
  || research.entries.some(x=>Object.hasOwn(nseEquityEtfBenchmarks,x.id)
    ? (x.referenceReviewedAt!=='2026-10-29'
      || x.etfBenchmarkReview?.officialNseIndexUrl!==nseEquityEtfBenchmarks[x.id]
      || x.etfBenchmarkReview?.officialSebiEtfInvestorEducationUrl!==sebiEtfInvestorEducationUrl
      || x.etfBenchmarkReview?.officialSebiCategorizationCircularUrl!==sebiDebtSchemeCircularUrl
      || x.etfBenchmarkReview?.sebiMutualFundRegulationsLastAmendedOn!=='2026-10-10'
      || x.etfBenchmarkReview?.reviewedOn!=='2026-10-29'
      || x.etfBenchmarkReview?.sourceScope!=='OFFICIAL_BENCHMARK_AND_GENERAL_ETF_RULES_NOT_LISTED_PRODUCT_OR_PERSONAL_ELIGIBILITY'
      || x.verifiedPublicFrameworkFact?.officialSourceUrl!==nseEquityEtfBenchmarks[x.id]
      || x.verifiedPublicFrameworkFact?.factCode!=='OFFICIAL_NSE_ETF_UNDERLYING_INDEX_METHODOLOGY'
      || !Array.isArray(x.etfBenchmarkReview?.riskConsiderations)
      || x.etfBenchmarkReview.riskConsiderations.length<2
      || !Array.isArray(x.etfBenchmarkReview?.investorAccessConstraints)
      || x.etfBenchmarkReview.investorAccessConstraints.length<2
      || ['specificListedEtfAndAmcVerified','exchangeTickerAndIsinVerified',
        'currentSchemeRiskometerVerified','currentNavInavAndExchangeQuoteVerified',
        'currentSidKimFeesTrackingAndLiquidityVerified','brokerDematKycAndRetailAccessVerified',
        'independentCommercialDataRightsVerified','taxTreatmentAndAdviceAuthorizationVerified',
        'individualSuitabilityVerified'].some(k=>x.etfBenchmarkReview[k]!==false))
    : x.etfBenchmarkReview!==undefined)
  || research.entries.some(x=>Object.hasOwn(nseAdditionalEtfBenchmarks,x.id)
    ? (x.etfBenchmarkReview?.factorOrThemeCode!==nseAdditionalEtfBenchmarks[x.id].code
      || x.etfBenchmarkReview?.officialNseIndexUrl!==nseAdditionalEtfBenchmarks[x.id].url)
    : x.etfBenchmarkReview?.factorOrThemeCode!==undefined)
  || research.entries.some(x=>Object.hasOwn(npsCommonChoiceSpecs,x.id)
    ? (x.referenceReviewedAt!=='2026-10-29'
      || x.npsCommonSchemeReview?.choiceCode!==npsCommonChoiceSpecs[x.id].choiceCode
      || x.npsCommonSchemeReview?.choiceType!==npsCommonChoiceSpecs[x.id].choiceType
      || x.npsCommonSchemeReview?.publishedEquityAllocationAtAge35Pct!==npsCommonChoiceSpecs[x.id].age35
      || x.npsCommonSchemeReview?.publishedEquityAllocationAtAge55Pct!==npsCommonChoiceSpecs[x.id].age55
      || x.npsCommonSchemeReview?.equityTaperStartsAfterAge!==npsCommonChoiceSpecs[x.id].taperAfter
      || x.npsCommonSchemeReview?.publishedActiveChoiceMaximumAllocationPct!==npsCommonChoiceSpecs[x.id].cap
      || x.npsCommonSchemeReview?.officialAllCitizenSchemeUrl!==npsAllCitizenUrl
      || x.npsCommonSchemeReview?.officialPensionFundsGuidanceUrl!==npsPensionFundsUrl
      || x.npsCommonSchemeReview?.officialLifecycleNomenclatureCircularUrl!==npsLifecycleCircularUrl
      || x.npsCommonSchemeReview?.officialExitWithdrawalFaqUrl!==npsExitFaqUrl
      || x.npsCommonSchemeReview?.lifecycleNomenclatureCircularIssuedOn!=='2025-10-17'
      || x.npsCommonSchemeReview?.exitFaqUpdatedMonth!=='2026-03'
      || x.npsCommonSchemeReview?.reviewedOn!=='2026-10-29'
      || x.npsCommonSchemeReview?.sourceScope!=='PFRDA_COMMON_SCHEME_ALLOCATION_FRAMEWORK_NOT_ACTUAL_FUND_NAV_OR_INDIVIDUAL_ELIGIBILITY'
      || x.verifiedPublicFrameworkFact?.officialSourceUrl!==(x.id==='catalog_2026_nps_asset_a'?npsPensionFundsUrl:npsAllCitizenUrl)
      || x.verifiedPublicFrameworkFact?.value!==(npsCommonChoiceSpecs[x.id].choiceType==='AUTO_CHOICE'?npsCommonChoiceSpecs[x.id].age35:npsCommonChoiceSpecs[x.id].cap)
      || !Array.isArray(x.npsCommonSchemeReview?.riskConsiderations)
      || x.npsCommonSchemeReview.riskConsiderations.length<2
      || !Array.isArray(x.npsCommonSchemeReview?.investorAccessConstraints)
      || x.npsCommonSchemeReview.investorAccessConstraints.length<2
      || ["specificPensionFundAndSchemeVerified","currentSchemeNavAndRiskLevelVerified","currentSubscriptionTermsAndFeesVerified","subscriberAgeResidencyKycAndSectorVerified","individualExitAndWithdrawalEligibilityVerified","commercialDataAndRedistributionRightsVerified","taxAndAdviceAuthorizationVerified","individualSuitabilityVerified"].some(k=>x.npsCommonSchemeReview[k]!==false))
    : x.npsCommonSchemeReview!==undefined)
  || research.entries.some(x=>x.id==='catalog_2026_nps_vatsalya'
    ? (x.referenceReviewedAt!=='2026-10-29'
      || x.npsVatsalyaAccessReview?.officialPfrdaSchemeUrl!=='https://pfrda.org.in/en/schemes/national-pension-system/nps-vatsalya'
      || x.npsVatsalyaAccessReview?.reviewedOn!=='2026-10-29'
      || x.npsVatsalyaAccessReview?.minimumInitialContributionInr!==250
      || x.npsVatsalyaAccessReview?.minimumAnnualContributionInr!==250
      || x.npsVatsalyaAccessReview?.partialWithdrawalLockInYears!==3
      || x.npsVatsalyaAccessReview?.partialWithdrawalMaximumPctOfOwnContributions!==25
      || x.npsVatsalyaAccessReview?.freshSubscriberKycRequiredAtAge!==18
      || !Array.isArray(x.npsVatsalyaAccessReview?.riskConsiderations)
      || x.npsVatsalyaAccessReview.riskConsiderations.length<2
      || !Array.isArray(x.npsVatsalyaAccessReview?.investorAccessConstraints)
      || x.npsVatsalyaAccessReview.investorAccessConstraints.length<2
      || ['specificPensionFundAndAllocationVerified','minorCitizenshipAgeGuardianKycVerified',
        'currentNavFeesAndMarketRiskVerified','individualWithdrawalAndExitEligibilityVerified',
        'commercialDataRightsVerified','investorTaxAndAdviceAuthorizationVerified',
        'individualSuitabilityVerified'].some(k=>x.npsVatsalyaAccessReview[k]!==false))
    : x.npsVatsalyaAccessReview!==undefined)
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
const sourceScopedRiskAccessIds=new Set(["catalog_2026_gsec_coupon_strip","catalog_2026_gsec_principal_strip","catalog_2026_sovereign_green","catalog_2026_gsec_floating","catalog_2026_bank_rd","catalog_2026_bank_tax_saver_fd","catalog_2026_bank_sweep_fd","catalog_2026_bank_fd_monthly","catalog_2026_bank_fd_quarterly"]);
if(research.entries.some(row=>{
 if(!sourceScopedRiskAccessIds.has(row.id))return false;
 const review=row.governmentBondStructureReview||row.bankDepositAccessReview;
 return !review||!Array.isArray(review.riskConsiderations)
  ||review.riskConsiderations.length<2
  ||review.riskConsiderations.some(x=>typeof x!=='string'||!x.trim())
  ||!Array.isArray(review.investorAccessConstraints)
  ||review.investorAccessConstraints.length<2
  ||review.investorAccessConstraints.some(x=>typeof x!=='string'||!x.trim())
  ||(row.governmentBondStructureReview
   ?review.officialStructureSourceUrl!==row.verifiedPublicFrameworkFact.officialSourceUrl
   :review.officialDicgcCoverageUrl!==row.verifiedPublicFrameworkFact.officialSourceUrl)
  ||row.productRiskScore!==null||row.actualRetailProductEligible!==false
  ||row.sourcePermissionVerified!==false||row.suitabilityRankingPermitted!==false;
}))throw new Error('FINANCIAL_GOVT_BANK_SOURCE_SCOPED_RISK_ACCESS_INVALID');

// Explicit, source-scoped review of 15 further distinct archetypes. Narrative
// category risk is not a scheme riskometer, investor approval or market feed.
const individualRiskAccessReviewFields=Object.freeze({"catalog_2026_nbfc_fd_cumulative":["nbfcPublicDepositAccessReview","https://www.dicgc.org.in/guide-to-deposit-insurance"],"catalog_2026_nbfc_fd_payout":["nbfcPublicDepositAccessReview","https://www.dicgc.org.in/guide-to-deposit-insurance"],"catalog_2026_index_india_defence":["thematicIndexReview","https://www.niftyindices.com/indices/equity/thematic-indices/nifty-india-defence"],"catalog_2026_index_india_digital":["thematicIndexReview","https://www.niftyindices.com/indices/equity/thematic-indices/nifty-india-digital"],"catalog_2026_index_india_consumption":["thematicIndexReview","https://www.niftyindices.com/indices/equity/thematic-indices/nifty-india-consumption"],"catalog_2026_pms_discretionary":["individualCategoryReview","https://www.sebi.gov.in/legal/regulations/sep-2025/securities-and-exchange-board-of-india-portfolio-managers-regulations-2020-last-amended-on-september-03-2025-_96560.html"],"catalog_2026_pms_nondiscretionary":["individualCategoryReview","https://www.sebi.gov.in/legal/regulations/sep-2025/securities-and-exchange-board-of-india-portfolio-managers-regulations-2020-last-amended-on-september-03-2025-_96560.html"],"catalog_2026_physical_gold_bullion":["preciousMetalsCategoryReview","https://www.bis.gov.in/refineries/?lang=en"],"catalog_2026_physical_silver_bullion":["preciousMetalsCategoryReview","https://www.bis.gov.in/hallmarking-overview/hallmarking-faqs/hallmarking-faq/?lang=en"],"catalog_2026_equity_diversified_fof":["fundOfFundsCategoryReview","https://www.sebi.gov.in/sebi_data/attachdocs/feb-2026/1772079826878.pdf"],"catalog_2026_equity_sector_fof":["fundOfFundsCategoryReview","https://www.sebi.gov.in/sebi_data/attachdocs/feb-2026/1772079826878.pdf"],"catalog_2026_fof_aggressive_hybrid":["fundOfFundsCategoryReview","https://www.sebi.gov.in/sebi_data/attachdocs/feb-2026/1772079826878.pdf"],"catalog_2026_fof_conservative_hybrid":["fundOfFundsCategoryReview","https://www.sebi.gov.in/sebi_data/attachdocs/feb-2026/1772079826878.pdf"],"catalog_2026_fof_income_arbitrage":["fundOfFundsCategoryReview","https://www.sebi.gov.in/sebi_data/attachdocs/feb-2026/1772079826878.pdf"],"catalog_2026_fof_dynamic_allocation":["fundOfFundsCategoryReview","https://www.sebi.gov.in/sebi_data/attachdocs/feb-2026/1772079826878.pdf"]});
if(research.entries.some(row=>{
 const spec=individualRiskAccessReviewFields[row.id];
 if(!spec)return false;
 const review=row[spec[0]];
 return !review||review.reviewedOn!=='2026-10-29'
  ||review.officialRiskAccessEvidenceUrl!==spec[1]
  ||!Array.isArray(review.riskConsiderations)||review.riskConsiderations.length<2
  ||review.riskConsiderations.some(s=>typeof s!=='string'||!s.trim())
  ||!Array.isArray(review.investorAccessConstraints)||review.investorAccessConstraints.length<2
  ||review.investorAccessConstraints.some(s=>typeof s!=='string'||!s.trim())
  ||['specificInstrumentOrSchemeVerified','currentPriceOrNavVerified',
    'individualInvestorAccessVerified','commercialDataRightsVerified',
    'personalizedAdviceAuthorizationVerified'].some(k=>review[k]!==false)
  ||((row.thematicIndexReview||row.fundOfFundsCategoryReview)
    &&review.currentSchemeRiskometerVerified!==false)
  ||row.productRiskScore!==null||row.actualRetailProductEligible!==false
  ||row.sourcePermissionVerified!==false||row.suitabilityRankingPermitted!==false;
}))throw new Error('FINANCIAL_INDIVIDUAL_RISK_ACCESS_EVIDENCE_INVALID');

// The final 15 source-scoped profiles include corporate debt, money-market,
// SIF, SM REIT and silver FoF structures; no verified instrument is inferred.
const finalRiskAccessReviewFields=Object.freeze({"catalog_2026_ncd_secured":["debtInstrumentReview","https://www.sebi.gov.in/legal/regulations/jan-2026/securities-and-exchange-board-of-india-issue-and-listing-of-non-convertible-securities-regulations-2021-last-amended-as-on-january-21-2026-_99288.html"],"catalog_2026_ncd_unsecured":["debtInstrumentReview","https://www.sebi.gov.in/legal/regulations/jan-2026/securities-and-exchange-board-of-india-issue-and-listing-of-non-convertible-securities-regulations-2021-last-amended-as-on-january-21-2026-_99288.html"],"catalog_2026_ncd_unlisted":["debtInstrumentReview","https://www.sebi.gov.in/legal/master-circulars/oct-2025/master-circular-for-issue-and-listing-of-non-convertible-securities-securitised-debt-instruments-security-receipts-municipal-debt-securities-and-commercial-paper_97343.html"],"catalog_2026_bond_subordinated":["debtInstrumentReview","https://www.sebi.gov.in/legal/master-circulars/oct-2025/master-circular-for-issue-and-listing-of-non-convertible-securities-securitised-debt-instruments-security-receipts-municipal-debt-securities-and-commercial-paper_97343.html"],"catalog_2026_bond_perpetual":["debtInstrumentReview","https://www.sebi.gov.in/legal/master-circulars/oct-2025/master-circular-for-issue-and-listing-of-non-convertible-securities-securitised-debt-instruments-security-receipts-municipal-debt-securities-and-commercial-paper_97343.html"],"catalog_2026_bond_corporate_floating":["debtInstrumentReview","https://www.sebi.gov.in/legal/master-circulars/oct-2025/master-circular-for-issue-and-listing-of-non-convertible-securities-securitised-debt-instruments-security-receipts-municipal-debt-securities-and-commercial-paper_97343.html"],"catalog_2026_bond_corporate_zero":["debtInstrumentReview","https://www.sebi.gov.in/legal/master-circulars/oct-2025/master-circular-for-issue-and-listing-of-non-convertible-securities-securitised-debt-instruments-security-receipts-municipal-debt-securities-and-commercial-paper_97343.html"],"catalog_2026_bond_convertible":["debtInstrumentReview","https://www.sebi.gov.in/legal/regulations/mar-2026/securities-and-exchange-board-of-india-issue-of-capital-and-disclosure-requirements-regulations-2018-last-amended-on-march-21-2026-_100581.html"],"catalog_2026_psu_bond_taxable":["debtInstrumentReview","https://www.sebi.gov.in/legal/master-circulars/oct-2025/master-circular-for-issue-and-listing-of-non-convertible-securities-securitised-debt-instruments-security-receipts-municipal-debt-securities-and-commercial-paper_97343.html"],"catalog_2026_infra_corporate_bond":["debtInstrumentReview","https://www.sebi.gov.in/legal/master-circulars/oct-2025/master-circular-for-issue-and-listing-of-non-convertible-securities-securitised-debt-instruments-security-receipts-municipal-debt-securities-and-commercial-paper_97343.html"],"catalog_2026_municipal_green":["individualCategoryReview","https://www.sebi.gov.in/legal/regulations/jul-2026/securities-and-exchange-board-of-india-issue-and-listing-of-municipal-debt-securities-regulations-2015-last-amendment-on-july-08-2026-_102918.html"],"catalog_2026_commercial_paper":["debtInstrumentReview","https://www.rbi.org.in/Scripts/BS_ViewMasDirections.aspx?id=12592"],"catalog_2026_sif_hybrid_longshort":["individualCategoryReview","https://www.sebi.gov.in/legal/circulars/feb-2025/regulatory-framework-for-specialized-investment-funds-sif-_92299.html"],"catalog_2026_sm_reit_scheme":["individualCategoryReview","https://www.sebi.gov.in/legal/regulations/oct-2026/securities-and-exchange-board-of-india-real-estate-investment-trusts-regulations-2014-last-amended-on-october-15-2026-_105376.html"],"catalog_2026_silver_fof":["preciousMetalsCategoryReview","https://www.sebi.gov.in/legal/master-circulars/mar-2026/master-circular-for-mutual-funds_100491.html"]});
if(research.entries.some(row=>{
 const spec=finalRiskAccessReviewFields[row.id];
 if(!spec)return false;
 const review=row[spec[0]];
 return !review||review.reviewedOn!=='2026-10-29'
  ||review.officialRiskAccessEvidenceUrl!==spec[1]
  ||!Array.isArray(review.riskConsiderations)||review.riskConsiderations.length<2
  ||review.riskConsiderations.some(s=>typeof s!=='string'||!s.trim())
  ||!Array.isArray(review.investorAccessConstraints)||review.investorAccessConstraints.length<2
  ||review.investorAccessConstraints.some(s=>typeof s!=='string'||!s.trim())
  ||['specificInstrumentOrSchemeVerified','currentPriceOrNavVerified',
    'individualInvestorAccessVerified','commercialDataRightsVerified',
    'personalizedAdviceAuthorizationVerified'].some(k=>review[k]!==false)
  ||row.productRiskScore!==null||row.actualRetailProductEligible!==false
  ||row.sourcePermissionVerified!==false||row.suitabilityRankingPermitted!==false;
}))throw new Error('FINANCIAL_FINAL_15_SOURCE_SCOPED_RESEARCH_INVALID');
// All 95 rows must now have distinct, nonempty structured risk and investor
// access cautions; this does NOT qualify 95 products or grant advice rights.
if(research.entries.some(row=>!Object.values(row).some(v=>v&&typeof v==='object'
 &&Array.isArray(v.riskConsiderations)&&v.riskConsiderations.length>=2
 &&v.riskConsiderations.every(s=>typeof s==='string'&&s.trim())
 &&Array.isArray(v.investorAccessConstraints)&&v.investorAccessConstraints.length>=2
 &&v.investorAccessConstraints.every(s=>typeof s==='string'&&s.trim()))))
 throw new Error('FINANCIAL_95_CATEGORY_RISK_ACCESS_COVERAGE_INCOMPLETE');
// SEBI's 7 October 2026 debt-security Credit Risk-o-Meter is a future
// issue-specific disclosure, NOT a mutual-fund scheme riskometer or an
// independently verified credit rating for any discovery archetype.
const octoberDebtIds=new Set(["catalog_2026_ncd_secured","catalog_2026_ncd_unsecured","catalog_2026_ncd_unlisted","catalog_2026_bond_subordinated","catalog_2026_bond_perpetual","catalog_2026_bond_corporate_floating","catalog_2026_bond_corporate_zero","catalog_2026_bond_convertible","catalog_2026_psu_bond_taxable","catalog_2026_infra_corporate_bond","catalog_2026_commercial_paper"]);
if(octoberDebtIds.size!==11||research.entries.filter(row=>row.debtInstrumentReview).length!==11
 ||research.entries.some(row=>octoberDebtIds.has(row.id)!==Boolean(row.debtInstrumentReview?.creditRiskometerOct2026Review))
 ||research.entries.filter(row=>octoberDebtIds.has(row.id)).some(row=>{
   const r=row.debtInstrumentReview.creditRiskometerOct2026Review;
   const expectedScope=row.id==='catalog_2026_ncd_unlisted'?'UNLISTED_CATEGORY_NOT_AUTOMATICALLY_COVERED'
     :row.id==='catalog_2026_bond_convertible'?'CONVERTIBLE_SECURITY_OUTSIDE_ASSUMED_NCS_SCOPE'
     :'ONLY_IF_LISTED_OR_PROPOSED_TO_BE_LISTED';
   return r.officialSebiCircularUrl!=='https://www.sebi.gov.in/legal/circulars/oct-2026/introduction-of-credit-risk-o-meter-as-an-additional-disclosure-mechanism-for-debt-securities_105081.html'
     ||r.circularIssuedOn!=='2026-10-07'||r.effectiveFrom!=='2026-11-21'
     ||r.reviewedOn!=='2026-10-29'||r.effectiveAtReviewDate!==false
     ||r.instrumentScope!=='LISTED_OR_PROPOSED_LISTED_NCS_CP_SDI_SR_MLD'
     ||r.categoryApplicability!==expectedScope
     ||r.multipleCraRatingsUseLowestRating!==true
     ||['issuerAndIsinVerified','specificListingStatusVerified',
       'currentSebiRegisteredCraRatingVerified','actualIssueCreditRiskometerVerified',
       'commercialRatingAndMeterReuseRightsVerified','individualRetailAccessVerified',
       'adviceAuthorizationVerified','creditMeterIsMutualFundSchemeRiskometer',
       'creditMeterCoversMarketLiquidityAndStructuralRisks'].some(k=>r[k]!==false)
     ||!Array.isArray(r.riskConsiderations)||r.riskConsiderations.length<2
     ||!Array.isArray(r.investorAccessConstraints)||r.investorAccessConstraints.length<2;
 }))throw new Error('FINANCIAL_OCTOBER_DEBT_CREDIT_METER_SCOPE_INVALID');
// The Oct 7 issuer-process exception is not a retail access, rating or advice approval.
const merchantBankerExemptionScope=Object.freeze({"catalog_2026_ncd_secured":"SECURED_LISTED_NCD_ONLY_IF_SENIOR_AND_ALL_ISSUER_CONDITIONS","catalog_2026_ncd_unsecured":"UNSECURED_LISTED_NCD_ONLY_IF_CPSE_PSU_STATUTORY_AND_ALL_ISSUER_CONDITIONS","catalog_2026_psu_bond_taxable":"PSU_BOND_ONLY_IF_ACTUAL_PSU_STATUS_SENIORITY_AND_ALL_CONDITIONS"});
const merchantBankerExemptionUrl="https://www.sebi.gov.in/legal/circulars/oct-2026/exemption-from-the-requirement-of-mandatory-merchant-banker-appointment-for-debt-issued-through-private-placement-by-certain-listed-issuers_105080.html";
const merchantBankerExemptionFalseFields=[
 'issuerFinancialRegulatorStatusVerified','issuerOneYearListingAndLodrClearanceVerified',
 'issuerDefaultFreeAuditorCertificateVerified','issueSeniorityAndSecurityVerified',
 'issueMinimumAaMinusRatingVerified','issuerPrivatePlacementRouteAndDenominationVerified',
 'investorEligibilityAndKycVerified','issuerOfferIsinPriceAndDataRightsVerified',
 'merchantBankerExemptionApprovedForIssuer','personalizedAdviceAuthorizationVerified',
];
if(research.entries.filter(row=>row.debtInstrumentReview?.merchantBankerExemptionOct2026Review).length!==3
 ||research.entries.some(row=>{
   const r=row.debtInstrumentReview?.merchantBankerExemptionOct2026Review;
   if(!Object.hasOwn(merchantBankerExemptionScope,row.id))return r!==undefined;
   const c=r?.generalConditions;
   return r?.officialSebiCircularUrl!==merchantBankerExemptionUrl
     ||r.circularIssuedOn!=='2026-10-07'||r.effectiveFrom!=='2026-10-07'
     ||r.reviewedOn!=='2026-10-29'
     ||r.sourceScope!=='PRIVATE_PLACEMENT_10000_FACE_VALUE_ISSUER_PROCESS_EXCEPTION_NOT_RETAIL_INVESTOR_MINIMUM'
     ||r.categoryApplicability!==merchantBankerExemptionScope[row.id]
     ||c?.financialSectorRegulatorRequired!=='SEBI_RBI_IRDAI_OR_PFRDA'
     ||c.issuerListedMinimumYears!==1
     ||c.noPendingLodrNoncomplianceFinesOrPenalties!==true
     ||c.noDebtDepositLoanDefaultForPreviousFinancialYears!==3
     ||c.currentFinancialYearDefaultCheckAlsoRequired!==true
     ||c.statutoryAuditorCertificateRequired!==true
     ||c.debtMustBeSeniorAndUnsubordinated!==true
     ||c.generallyRequiresFirstOrPariPassuChargeOnIdentifiableAssets!==true
     ||c.cpsePsuStatutoryBodyUnsecuredExceptionOnly!==true
     ||c.minimumIssueRating!=='AA-'||c.lowestOfMultipleRatingsControls!==true
     ||merchantBankerExemptionFalseFields.some(key=>r[key]!==false)
     ||!Array.isArray(r.riskConsiderations)||r.riskConsiderations.length<2
     ||!Array.isArray(r.investorAccessConstraints)||r.investorAccessConstraints.length<3;
 }))throw new Error('FINANCIAL_OCTOBER_DEBT_ISSUER_PROCESS_EXCEPTION_SCOPE_INVALID');
// Vatsalya 2026 effective scheme rules outrank an older still-live FAQ.
const vatsalyaResearch=research.entries.find(x=>x.id==='catalog_2026_nps_vatsalya');
const v=vatsalyaResearch?.npsVatsalyaAccessReview, e=v?.guidelines2026EvidenceReview;
if(research.entries.filter(x=>x.npsVatsalyaAccessReview?.guidelines2026EvidenceReview).length!==1
 ||v.eligibleSubscriber!=='INDIAN_CITIZEN_OR_NRI_OR_OCI_UNDER_18_WITH_PARENT_OR_LEGAL_GUARDIAN'
 ||v.minimumSubsequentContributionInr!==null
 ||e?.officialGuidelinesUrl!=='https://pfrda.org.in/documents/33652/153574/NPS%2BVatsalya%2BScheme%2BGuidelines%2B2025.pdf'
 ||e.officialEffectiveDateNoticeUrl!=='https://pfrda.org.in/documents/33652/153574/Circular%2BNPS%2BVatsalya%2BScheme%2BGuidelines%2B2025%2Beffective%2Bfrom%2B23rd%2BFeb%2B2026.pdf'
 ||e.officialUpdatedFaqUrl!=='https://www.pfrda.org.in/d/faqs-nps-vatsalya-updated-as-on-16-06-2026-'
 ||e.olderStillAccessibleFaqUrl!=='https://pfrda.org.in/hi/w/faqs/nps-vatsalya'
 ||e.guidelinesIssuedOn!=='2026-01-07'||e.effectiveDateNotifiedOn!=='2026-02-27'
 ||e.effectiveFrom!=='2026-02-23'||e.updatedFaqAsOf!=='2026-06-16'||e.reviewedOn!=='2026-10-29'
 ||e.olderFaqStatesInitialAndAnnualMinimumInr!==1000||e.currentGuidelinesInitialAndAnnualMinimumInr!==250
 ||e.olderFaqStatesFullExitCorpusLimitInr!==250000
 ||e.currentGuidelinesFullExitWording!=='LESS_THAN_800000_INR'
 ||e.pressReleaseFullExitWording!=='800000_INR_OR_LESS'
 ||e.sourceScope!=='EFFECTIVE_PFRDA_2026_SCHEME_RULES_AND_STALE_FAQ_CONFLICT_NOT_ACCOUNT_APPROVAL'
 ||['minimumPerSubsequentContributionNotEstablished','fullExitBoundaryWordingRequiresConfirmation',
 'pensionFundMayDesignUpToFullEquityAllocation','automaticHighEquityMsfShiftAt21IfNoChoice'].some(k=>e[k]!==true)
 ||['currentSelectedPensionFundAllocationVerified','individualGuardianMinorNriOciKycVerified',
 'individualContributionAndExitTermsVerified','schemeNavRiskometerAndMarketDataRightsVerified',
 'personalizedAdviceAuthorizationVerified'].some(k=>e[k]!==false)
 ||v.riskConsiderations.length<5||v.investorAccessConstraints.length<6)
 throw new Error('FINANCIAL_NPS_VATSALYA_2026_EFFECTIVE_GUIDELINES_EVIDENCE_INVALID');
// A published FoF category or its underlying-fund allocation does not supply
// the actual scheme risk-o-meter. SEBI's 5 Nov 2024 disclosure circular applies
// at scheme level; these six archetypes have no verified scheme observation.
const fofRiskometerCircularUrl='https://www.sebi.gov.in/legal/circulars/nov-2024/disclosure-of-expenses-half-yearly-returns-yield-and-risk-o-meter-of-schemes-of-mutual-funds_88230.html';
const fofIds=new Set(["catalog_2026_equity_diversified_fof","catalog_2026_equity_sector_fof","catalog_2026_fof_aggressive_hybrid","catalog_2026_fof_conservative_hybrid","catalog_2026_fof_income_arbitrage","catalog_2026_fof_dynamic_allocation"]);
if(research.entries.some(row=>{
 const evidence=row.fundOfFundsCategoryReview?.schemeRiskometerDisclosureReview;
 if(!fofIds.has(row.id))return evidence!==undefined;
 return !evidence||evidence.officialSebiCircularUrl!==fofRiskometerCircularUrl
  ||!isOfficialFrameworkReferenceUrl(evidence.officialSebiCircularUrl)
  ||evidence.circularIssuedOn!=='2024-11-05'||evidence.reviewedOn!=='2026-10-30'
  ||evidence.scope!=='SCHEME_SPECIFIC_DISCLOSURE_REQUIREMENT_NOT_CATEGORY_RISK_OR_INVESTMENT_APPROVAL'
  ||typeof evidence.categoryInterpretation!=='string'||evidence.categoryInterpretation.length<40
  ||['actualFoFSchemeRiskometerVerified','underlyingSchemeRiskometersVerified',
   'currentSchemeNavAndLicensedDataVerified','investorAccessAndAdviceRightsVerified']
   .some(field=>evidence[field]!==false);
}))throw new Error('FINANCIAL_FOF_SCHEME_RISKOMETER_DISCLOSURE_EVIDENCE_INVALID');
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
     reasons.push('NPS_MULTIPLE_NAV_FEE_SECTOR_AND_CHANNEL_NOT_INDIVIDUALLY_VERIFIED');
      reasons.push('NPS_OCT_2026_POP_CHARGE_DATE_MOVED_TO_DEC_VERIFY_APPLICABLE_FEES');
     if(profile.investmentHorizonYears<=3)
       reasons.push('SHORT_HORIZON_REQUIRES_NPS_APPLICABLE_NAV_FEES_AND_EXIT_VALUE_REVIEW');
     if(profile.investmentGoals.includes('Tax Saving'))
       reasons.push(row.id==='catalog_2026_nps_vatsalya'
         ? 'TAX_SAVING_GOAL_REQUIRES_NPS_VATSALYA_FY_AND_GUARDIAN_TAX_RULE_REVIEW'
         : 'TAX_SAVING_GOAL_REQUIRES_NPS_TIER_AND_CURRENT_FY_TAX_REGIME_REVIEW');
     if(row.id === 'catalog_2026_nps_vatsalya') {
       reasons.push('NPS_VATSALYA_MINOR_GUARDIAN_KYC_AND_AGE_18_TRANSITION_REQUIRE_REVIEW');
       reasons.push('NPS_VATSALYA_PFRDA_2026_THREE_YEAR_RESTRICTED_WITHDRAWAL_AND_FRESH_KYC_REVIEW');
       reasons.push('NPS_VATSALYA_SPECIFIC_PENSION_FUND_NAV_FEES_AND_MARKET_RISK_UNVERIFIED');
       reasons.push('NPS_VATSALYA_2026_GUIDELINES_SUPERSEDE_STALE_FAQ_CONTRIBUTION_AND_EXIT_FIGURES');
       reasons.push('NPS_VATSALYA_PENSION_FUND_MAY_USE_FULL_EQUITY_AND_AGE_21_HIGH_EQUITY_SHIFT_REVIEW');
       reasons.push('NPS_VATSALYA_EXACT_FULL_EXIT_CORPUS_BOUNDARY_AND_KYC_NOT_VERIFIED');
       if(profile.investmentGoals.includes('Emergency Fund'))
         reasons.push('EMERGENCY_FUND_REQUIRES_NPS_VATSALYA_RESTRICTED_WITHDRAWAL_REVIEW');
       if(profile.investmentHorizonYears<3)
         reasons.push('SHORT_HORIZON_BELOW_NPS_VATSALYA_PARTIAL_WITHDRAWAL_LOCK_IN');
       if(profile.riskTolerance==='Conservative')
         {reasons.push('CONSERVATIVE_PROFILE_REQUIRES_NPS_VATSALYA_MARKET_LOSS_CAPACITY_REVIEW');
         reasons.push('CONSERVATIVE_PROFILE_REQUIRES_NPS_VATSALYA_PENSION_FUND_FULL_EQUITY_REVIEW');}
     }
     else
       // PFRDA All Citizen Model: removal of the five-year minimum does not
       // remove vesting, scheme-specific lock-in or premature-exit conditions.
       reasons.push('NPS_FIVE_YEAR_MINIMUM_REMOVED_BUT_VESTING_AND_EXIT_RULES_APPLY');
   }
   if(row.id==='catalog_2026_sdl_coupon_strip' || row.id==='catalog_2026_sdl_principal_strip') {
     reasons.push('SGS_STRIP_SECURITY_ELIGIBILITY_AND_CUSTODIAN_ACCESS_NOT_VERIFIED');
      reasons.push('SGS_STRIP_UNDERLYING_OUTSTANDING_IS_NOT_INVESTOR_MINIMUM');
      if(profile.investmentGoals.includes('Emergency Fund'))
        reasons.push('EMERGENCY_FUND_REQUIRES_SGS_STRIP_EXIT_LIQUIDITY_REVIEW');
      if(profile.investmentHorizonYears<=3)
        reasons.push('SHORT_HORIZON_REQUIRES_SGS_STRIP_CASH_FLOW_AND_EXIT_REVIEW');
     if(profile.riskTolerance==='Conservative')
       reasons.push('CONSERVATIVE_PROFILE_REQUIRES_STRIP_MARKET_PRICE_AND_LIQUIDITY_REVIEW');
   }
   if(row.aifCategoryAccessReview) {
      reasons.push('AIF_PRIVATE_PLACEMENT_PPM_REGISTRATION_AND_KYC_UNVERIFIED');
      reasons.push('AIF_OCT_2026_ACCREDITATION_CHANGE_NOT_PERSONAL_ACCREDITATION');
      reasons.push('AIF_FEES_REDEMPTION_VALUATION_AND_DATA_RIGHTS_UNVERIFIED');
      if(row.id==='catalog_2026_aif1_social')
        reasons.push('SOCIAL_IMPACT_NPO_ONLY_MINIMUM_AND_NO_RETURN_UNIT_TYPE_REQUIRE_VERIFICATION');
      if(profile.investmentGoals.includes('Emergency Fund'))
        reasons.push('EMERGENCY_FUND_REQUIRES_AIF_ILLIQUIDITY_AND_LOSS_REVIEW');
      if(profile.investmentHorizonYears<=3)
        reasons.push('SHORT_HORIZON_REQUIRES_AIF_CAPITAL_CALL_AND_EXIT_REVIEW');
      if(profile.riskTolerance==='Conservative')
        reasons.push('CONSERVATIVE_PROFILE_REQUIRES_AIF_ILLIQUIDITY_LOSS_REVIEW');
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
         reasons.push('RECURRING_DEPOSIT_INSTALLMENT_AND_MISSED_PAYMENT_TERMS_UNVERIFIED');
         if(profile.investmentHorizonYears<=1)
           reasons.push('SHORT_HORIZON_REQUIRES_RD_INSTALLMENT_AND_EARLY_CLOSURE_REVIEW');
         break;
       case 'FIVE_YEAR_TAX_SAVER_TERM_DEPOSIT':
         reasons.push('TAX_SAVER_FIVE_YEAR_SCHEME_AND_CURRENT_TAX_REGIME_REQUIRE_REVIEW');
         if(profile.investmentGoals.includes('Tax Saving'))
           reasons.push('TAX_SAVING_GOAL_REQUIRES_CURRENT_FY_DEPOSIT_DEDUCTION_ELIGIBILITY_REVIEW');
         if(profile.investmentHorizonYears<5)
           reasons.push('TAX_SAVER_FIVE_YEAR_REFERENCE_EXCEEDS_PROFILE_HORIZON');
         break;
       case 'SWEEP_LINKED_TERM_DEPOSIT':
         reasons.push('SWEEP_TRIGGER_PARTIAL_BREAKAGE_AND_LIQUIDITY_TERMS_UNVERIFIED');
         if(profile.investmentGoals.includes('Emergency Fund'))
           reasons.push('EMERGENCY_FUND_REQUIRES_SWEEP_REVERSE_TRANSFER_ACCESS_REVIEW');
         break;
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
   if(row.indexBenchmarkReview) {
     reasons.push('EQUITY_INDEX_BENCHMARK_NOT_AN_APPROVED_FUND_OR_ETF');
     reasons.push('INDEX_FUND_SCHEME_RISKOMETER_NAV_TRACKING_COSTS_KYC_AND_SOURCE_RIGHTS_UNVERIFIED');
     if(profile.investmentHorizonYears<3)
       reasons.push('SHORT_HORIZON_REQUIRES_EQUITY_INDEX_DRAWDOWN_AND_REDEMPTION_REVIEW');
     if(profile.investmentGoals.includes('Emergency Fund'))
       reasons.push('EMERGENCY_FUND_REQUIRES_EQUITY_INDEX_LIQUIDITY_AND_SETTLEMENT_REVIEW');
     if(profile.riskTolerance==='Conservative')
       reasons.push('CONSERVATIVE_PROFILE_REQUIRES_EQUITY_INDEX_LOSS_CAPACITY_REVIEW');
     if(row.id==='catalog_2026_index_midcap150' || row.id==='catalog_2026_index_smallcap250')
       reasons.push('MID_SMALL_CAP_INDEX_VOLATILITY_AND_CONSTITUENT_LIQUIDITY_REVIEW');
     if(row.id==='catalog_2026_index_smallcap250')
       reasons.push('SMALLCAP_INDEX_UNDERLYING_LIQUIDITY_AND_REPLICATION_REVIEW');
     if(row.indexBenchmarkReview.factorStrategyCode) {
       reasons.push('FACTOR_INDEX_METHODOLOGY_NOT_SCHEME_RISK_OR_LOSS_PROTECTION');
       const factor=row.indexBenchmarkReview.factorStrategyCode;
       if(factor.startsWith('EQUAL_WEIGHT_'))
         reasons.push('EQUAL_WEIGHT_REBALANCING_AND_RELATIVE_SIZE_EXPOSURE_REVIEW');
       if(factor==='QUALITY_SCORE_NIFTY200')
         reasons.push('QUALITY_FACTOR_ACCOUNTING_METRICS_AND_CONCENTRATION_REVIEW');
       if(factor==='LOW_VOLATILITY_NIFTY100')
         reasons.push('LOW_VOLATILITY_HISTORICAL_MEASURE_NOT_CAPITAL_PROTECTION');
       if(factor==='MOMENTUM_NIFTY500')
         reasons.push('MOMENTUM_REVERSAL_AND_RECONSTITUTION_TURNOVER_REVIEW');
       if(profile.riskTolerance==='Conservative')
         reasons.push('CONSERVATIVE_PROFILE_REQUIRES_FACTOR_STRATEGY_LOSS_CAPACITY_REVIEW');
     }
   }
   if(row.etfBenchmarkReview) {
     reasons.push('ETF_INDEX_BENCHMARK_NOT_VERIFIED_AS_A_LISTED_PRODUCT');
     reasons.push('ETF_TICKER_ISIN_RISKOMETER_NAV_INAV_KYC_AND_DATA_RIGHTS_UNVERIFIED');
     reasons.push('ETF_EXCHANGE_SPREAD_PREMIUM_DISCOUNT_TRACKING_AND_SETTLEMENT_REVIEW');
     if(row.id==='catalog_2026_etf_smallcap250')
       reasons.push('SMALLCAP_ETF_UNDERLYING_LIQUIDITY_AND_MARKET_DEPTH_REVIEW');
     if(row.id.endsWith('_equal'))
       reasons.push('EQUAL_WEIGHT_ETF_REBALANCING_AND_RELATIVE_SIZE_EXPOSURE_REVIEW');
     switch(row.etfBenchmarkReview.factorOrThemeCode) {
       case 'QUALITY_FACTOR_NIFTY200': reasons.push('ETF_QUALITY_ACCOUNTING_FACTOR_AND_30_STOCK_CONCENTRATION_REVIEW'); break;
       case 'LOW_VOLATILITY_FACTOR_NIFTY500': reasons.push('ETF_HISTORICAL_LOW_VOLATILITY_IS_NOT_DOWNSIDE_PROTECTION'); break;
       case 'MOMENTUM_FACTOR_NIFTY500': reasons.push('ETF_MOMENTUM_REVERSAL_AND_RECONSTITUTION_TURNOVER_REVIEW'); break;
       case 'DEFENCE_THEME': reasons.push('ETF_DEFENCE_THEME_CONTRACT_POLICY_AND_SECTOR_CONCENTRATION_REVIEW'); break;
       case 'DOMESTIC_CONSUMPTION_THEME': reasons.push('ETF_CONSUMPTION_THEME_DOMESTIC_DEMAND_AND_SECTOR_EXPOSURE_REVIEW'); break;
     }
     if(row.etfBenchmarkReview.factorOrThemeCode && profile.riskTolerance==='Conservative')
       reasons.push('CONSERVATIVE_PROFILE_REQUIRES_FACTOR_OR_THEME_ETF_LOSS_CAPACITY_REVIEW');
     if(profile.investmentHorizonYears<3)
       reasons.push('SHORT_HORIZON_REQUIRES_ETF_EQUITY_DRAWDOWN_AND_EXIT_PRICE_REVIEW');
     if(profile.investmentGoals.includes('Emergency Fund'))
       reasons.push('EMERGENCY_FUND_REQUIRES_ETF_TRADING_AND_SETTLEMENT_LIQUIDITY_REVIEW');
     if(profile.riskTolerance==='Conservative')
       reasons.push('CONSERVATIVE_PROFILE_REQUIRES_ETF_EQUITY_LOSS_AND_SPREAD_CAPACITY_REVIEW');
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
     if(profile.investmentGoals.includes('Emergency Fund'))
       reasons.push('EMERGENCY_FUND_REQUIRES_GOVT_BOND_SECONDARY_EXIT_PRICE_AND_LIQUIDITY_REVIEW');
     if(profile.investmentHorizonYears<=3)
       reasons.push('SHORT_HORIZON_REQUIRES_GOVT_BOND_MATURITY_AND_SALE_PRICE_REVIEW');
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
     if(profile.investmentGoals.includes('Emergency Fund'))
       reasons.push('EMERGENCY_FUND_REQUIRES_RETAIL_DIRECT_EARLY_SALE_PRICE_AND_LIQUIDITY_REVIEW');
     if(profile.riskTolerance==='Conservative')
       reasons.push('CONSERVATIVE_PROFILE_REQUIRES_GOVT_SECURITY_EARLY_SALE_PRICE_AND_LIQUIDITY_REVIEW');
   }
   if(row.npsCommonSchemeReview) {
     reasons.push('NPS_COMMON_SCHEME_PENSION_FUND_NAV_KYC_AND_ENTITLEMENTS_UNVERIFIED');
     reasons.push('NPS_TIER_I_VESTING_PREMATURE_EXIT_AND_ANNUITY_TERMS_REQUIRE_REVIEW');
     // This is a normal-exit horizon notice, NOT a hard lock-in or eligibility decision.
     const yearsUntilSixty=Math.max(0,60-profile.age);
     if(profile.investmentHorizonYears<Math.min(15,yearsUntilSixty))
       reasons.push('NPS_RECORDED_HORIZON_BEFORE_COMMON_SCHEME_NORMAL_EXIT_REVIEW');
     if(profile.investmentGoals.includes('Emergency Fund'))
       reasons.push('EMERGENCY_FUND_GOAL_REQUIRES_NPS_TIER_I_WITHDRAWAL_ACCESS_REVIEW');
     if(row.npsCommonSchemeReview.choiceType==='AUTO_CHOICE') {
       reasons.push('NPS_LIFECYCLE_AGE_DEPENDENT_EQUITY_TAPER_NOT_SCHEME_RISKOMETER');
       if(row.id==='catalog_2026_nps_lc_aggressive')
         reasons.push('NPS_AGGRESSIVE_LIFECYCLE_TAPERS_AFTER_45_NOT_LC75_HIGH');
     } else {
       const activeRisks={
         catalog_2026_nps_asset_e:'NPS_CLASS_E_EQUITY_MARKET_LOSS_AND_ALLOCATION_CAP_REVIEW',
         catalog_2026_nps_asset_c:'NPS_CLASS_C_CORPORATE_ISSUER_CREDIT_AND_RATE_RISK_REVIEW',
         catalog_2026_nps_asset_g:'NPS_CLASS_G_GOVT_BOND_DURATION_AND_NAV_RISK_REVIEW',
         catalog_2026_nps_asset_a:'NPS_CLASS_A_ALTERNATIVES_FIVE_PERCENT_CAP_LIQUIDITY_AND_VALUATION_REVIEW',
       };
       reasons.push(activeRisks[row.id]);
     }
     if(profile.riskTolerance==='Conservative'
       && ['catalog_2026_nps_lc50','catalog_2026_nps_lc75',
         'catalog_2026_nps_lc_aggressive','catalog_2026_nps_asset_e'].includes(row.id))
       reasons.push('CONSERVATIVE_PROFILE_REQUIRES_NPS_EQUITY_DRAWDOWN_CAPACITY_REVIEW');
   }
   // These are research-only cautions; never infer product qualification from a reviewed category.
   const categoryReview=row.fundOfFundsCategoryReview||row.thematicIndexReview
     ||row.debtInstrumentReview||row.individualCategoryReview||row.preciousMetalsCategoryReview;
   if(categoryReview) {
     reasons.push('REVIEWED_CATEGORY_STRUCTURE_NOT_VERIFIED_INVESTABLE_PRODUCT');
     reasons.push('ACTUAL_ISSUER_TERMS_ACCESS_AND_LIQUIDITY_UNVERIFIED');
     if(row.thematicIndexReview||row.fundOfFundsCategoryReview)
       reasons.push('SCHEME_SPECIFIC_RISKOMETER_NAV_AND_HOLDINGS_UNVERIFIED');
     if(row.debtInstrumentReview||row.individualCategoryReview)
       reasons.push('ISSUER_CREDIT_SECURITY_TERMS_AND_SECONDARY_LIQUIDITY_UNVERIFIED');
     if(row.preciousMetalsCategoryReview)
       reasons.push('PRECIOUS_METALS_AUTHENTICITY_CUSTODY_OR_UNDERLYING_SCHEME_UNVERIFIED');
     if(profile.investmentGoals.includes('Emergency Fund'))
       reasons.push('EMERGENCY_FUND_GOAL_REQUIRES_REVIEWED_CATEGORY_REDEMPTION_AND_LOSS_CHECK');
     if(profile.riskTolerance==='Conservative')
       reasons.push('CONSERVATIVE_PROFILE_REQUIRES_REVIEWED_CATEGORY_LOSS_AND_LIQUIDITY_CHECK');
     if(Number.isFinite(profile.investmentHorizonYears)
       && profile.investmentHorizonYears<=3)
       reasons.push('SHORT_HORIZON_REQUIRES_REVIEWED_CATEGORY_EXIT_AND_LOSS_CHECK');
   }

   if(row.nbfcPublicDepositAccessReview){
     if(profile.investmentGoals.includes('Emergency Fund'))
       reasons.push('EMERGENCY_FUND_REQUIRES_UNINSURED_NBFC_DEPOSIT_REPAYMENT_AND_LIQUIDITY_REVIEW');
     if(profile.investmentHorizonYears<=3)
       reasons.push('SHORT_HORIZON_REQUIRES_NBFC_DEPOSIT_TENOR_AND_PREMATURE_REPAYMENT_REVIEW');
     reasons.push(row.id==='catalog_2026_nbfc_fd_cumulative'
       ? 'NBFC_CUMULATIVE_INTEREST_AND_MATURITY_CASH_FLOW_TERMS_UNVERIFIED'
       : 'NBFC_PAYOUT_FREQUENCY_EFFECTIVE_YIELD_AND_PRINCIPAL_REPAYMENT_UNVERIFIED');
   }
   if(row.id==='catalog_2026_pms_discretionary'||row.id==='catalog_2026_pms_nondiscretionary'){
     reasons.push('PMS_MANAGER_REGISTRATION_MANDATE_CLIENT_MINIMUM_AND_FEES_UNVERIFIED');
     reasons.push('PMS_2026_REGULATIONS_NOT_EFFECTIVE_UNTIL_APRIL_2027');
     reasons.push(row.id==='catalog_2026_pms_discretionary'
       ? 'DISCRETIONARY_PMS_MANAGER_TRADING_AUTHORITY_AND_CUSTODY_UNVERIFIED'
       : 'NONDISCRETIONARY_PMS_CLIENT_INSTRUCTION_AND_EXECUTION_TERMS_UNVERIFIED');
     if(profile.hasLumpSum===true&&Number.isFinite(profile.lumpSumAmount)
       &&profile.lumpSumAmount<row.standardCapitalReferenceInr)
       reasons.push('REPORTED_PMS_CAPITAL_BELOW_STANDARD_REFERENCE_NOT_PERSONAL_REJECTION');
   }
   if(row.thematicIndexReview){
     reasons.push('THEMATIC_NSE_INDEX_IS_NOT_SCHEME_RISKOMETER_OR_PUBLISHED_NAV');
     const themeNotices={
       catalog_2026_index_india_defence:'DEFENCE_INDEX_POLICY_PROCUREMENT_AND_CONCENTRATION_REVIEW',
       catalog_2026_index_india_digital:'DIGITAL_INDEX_DISRUPTION_VALUATION_AND_CONCENTRATION_REVIEW',
       catalog_2026_index_india_consumption:'CONSUMPTION_INDEX_DOMESTIC_DEMAND_AND_CORRELATION_REVIEW',
     };
     if(themeNotices[row.id])reasons.push(themeNotices[row.id]);
   }
   if(row.fundOfFundsCategoryReview){
     reasons.push('FOF_UNDERLYING_SCHEMES_LAYERED_FEES_RISKOMETER_AND_NAV_UNVERIFIED');
     if(row.id==='catalog_2026_fof_conservative_hybrid')
       reasons.push('CONSERVATIVE_HYBRID_FOF_LABEL_NOT_PRINCIPAL_PROTECTION');
     if(row.id==='catalog_2026_fof_income_arbitrage')
       reasons.push('INCOME_ARBITRAGE_FOF_NOT_AN_INSURED_CASH_DEPOSIT');
     if(row.id==='catalog_2026_fof_dynamic_allocation')
       reasons.push('DYNAMIC_FOF_ALLOCATION_NOT_FIXED_OR_VERIFIED');
   }
   if(row.preciousMetalsCategoryReview){
     reasons.push('PHYSICAL_BULLION_ASSAY_DEALER_SPREAD_CUSTODY_AND_RESALE_UNVERIFIED');
     if(row.id==='catalog_2026_physical_silver_bullion')
       reasons.push('SILVER_JEWELLERY_HALLMARK_NOT_BULLION_CERTIFICATION');
   }

   if(row.debtInstrumentReview){
     reasons.push('DEBT_ISSUER_ISIN_RATING_COVENANTS_MARKET_PRICE_AND_RETAIL_ACCESS_UNVERIFIED');
     const creditMeter=row.debtInstrumentReview.creditRiskometerOct2026Review;
     if(creditMeter){
       reasons.push('SEBI_DEBT_CREDIT_METER_EFFECTIVE_DATE_AND_ISSUE_EVIDENCE_REVIEW');
       reasons.push('DEBT_CREDIT_METER_NOT_SCHEME_RISKOMETER_OR_MARKET_LIQUIDITY_ASSESSMENT');
       reasons.push(creditMeter.categoryApplicability==='ONLY_IF_LISTED_OR_PROPOSED_TO_BE_LISTED'
         ? 'LISTED_DEBT_ISSUER_ISIN_CRA_RATING_AND_METER_UNVERIFIED'
         : 'DEBT_CREDIT_METER_INSTRUMENT_AND_LISTING_SCOPE_NOT_PRESUMED');
       if(row.id==='catalog_2026_bond_perpetual')
         reasons.push('PERPETUAL_BOND_CREDIT_METER_DOES_NOT_CAPTURE_AT1_STRUCTURAL_LOSS');
       if(profile.riskTolerance==='Conservative')
         reasons.push('CONSERVATIVE_PROFILE_REQUIRES_DEBT_DEFAULT_AND_NONCREDIT_LOSS_REVIEW');
     }
     if(row.id==='catalog_2026_ncd_unlisted')
       reasons.push('UNLISTED_NCD_TRANSFER_RESTRICTIONS_AND_EXIT_COUNTERPARTY_UNVERIFIED');
     if(row.id==='catalog_2026_bond_perpetual')
       reasons.push('PERPETUAL_BOND_CALL_COUPON_DEFERRAL_AND_NO_FIXED_MATURITY_REVIEW');
     if(row.id==='catalog_2026_bond_subordinated')
       reasons.push('SUBORDINATED_BOND_RECOVERY_PRIORITY_AND_LOSS_ABSORPTION_REVIEW');
     if(row.id==='catalog_2026_bond_corporate_floating')
       reasons.push('FLOATING_CORPORATE_BOND_RESET_BENCHMARK_SPREAD_AND_CAP_REVIEW');
     if(row.id==='catalog_2026_bond_corporate_zero')
       reasons.push('ZERO_COUPON_BOND_NO_INTERIM_CASH_FLOW_AND_DURATION_REVIEW');
     if(row.id==='catalog_2026_bond_convertible')
       reasons.push('CONVERTIBLE_DEBENTURE_ICDR_CONVERSION_PRICE_AND_EQUITY_RISK_REVIEW');
     if(row.id==='catalog_2026_psu_bond_taxable')
       reasons.push('PSU_BOND_OWNERSHIP_NOT_SOVEREIGN_GUARANTEE_OR_TAX_EXEMPTION');
     if(row.id==='catalog_2026_infra_corporate_bond')
       reasons.push('INFRA_CORPORATE_BOND_PROJECT_REVENUE_REFINANCING_AND_COVENANT_REVIEW');
     if(row.id==='catalog_2026_commercial_paper'){
       reasons.push('CP_RBI_2024_DEMAT_MINIMUM_DENOMINATION_AND_RELATED_PARTY_REVIEW');
       reasons.push('CP_RBI_2024_INDIVIDUAL_PRIMARY_SUBSCRIPTION_CAP_NOT_PERSONAL_APPROVAL');
     }
   }
   if(row.debtInstrumentReview?.merchantBankerExemptionOct2026Review) {
     reasons.push('SEBI_OCT_2026_MERCHANT_BANKER_EXCEPTION_IS_ISSUER_PROCESS_NOT_RETAIL_APPROVAL');
     reasons.push('DEBT_PRIVATE_PLACEMENT_10000_FACE_VALUE_NOT_PERSONAL_INVESTMENT_MINIMUM');
     if(row.id==='catalog_2026_ncd_unsecured')
       reasons.push('UNSECURED_ISSUER_MERCHANT_BANKER_EXCEPTION_REQUIRES_CPSE_PSU_OR_STATUTORY_STATUS');
     if(profile.investmentGoals.includes('Emergency Fund'))
       reasons.push('EMERGENCY_FUND_REQUIRES_PRIVATE_DEBT_ISSUE_EXIT_LIQUIDITY_REVIEW');
     if(profile.riskTolerance==='Conservative')
       reasons.push('CONSERVATIVE_PROFILE_REQUIRES_DEBT_ISSUER_DEFAULT_SECURITY_AND_RATING_REVIEW');
   }
   if(row.id==='catalog_2026_municipal_green')
     reasons.push('MUNICIPAL_GREEN_BOND_JULY_2026_ISSUE_DISCLOSURES_AND_GREEN_CLAIMS_REVIEW');
   if(row.id==='catalog_2026_sm_reit_scheme')
     reasons.push('SM_REIT_OCTOBER_2026_REGULATIONS_NOT_A_REGISTERED_SCHEME_OR_UNIT_QUOTE');
   if(row.id==='catalog_2026_sif_hybrid_longshort'){
     reasons.push('SIF_DERIVATIVE_SHORT_AND_INTERVAL_REDEMPTION_TERMS_UNVERIFIED');
     if(profile.investmentHorizonYears<=3||profile.investmentGoals.includes('Emergency Fund'))
       reasons.push('SIF_SHORT_HORIZON_OR_EMERGENCY_LIQUIDITY_REQUIRES_INTERVAL_EXIT_REVIEW');
   }
   if(row.id==='catalog_2026_silver_fof')
     reasons.push('SILVER_FOF_UNDERLYING_ETF_RISKOMETER_NAV_TRACKING_AND_FEES_UNVERIFIED');
   if(row.id.startsWith('catalog_2026_ncd_'))
     reasons.push('DEBT_CREDIT_SECURITY_AND_DISCLOSURES_REQUIRE_INSTRUMENT_REVIEW');
   if(profile.riskTolerance==='Conservative'
     && /NPS_EQUITY|NPS_ALTERNATIVES|SMALL_MID_CAP|SECTOR_CONCENTRATION|SIF_LONG_SHORT|PMS_MANAGER/.test(row.exposureClass))
     reasons.push('CONSERVATIVE_PROFILE_REQUIRES_PRODUCT_SPECIFIC_RISK_REVIEW');
   // A documented absence of an emergency buffer warrants a deposit-access
   // caution; it is not a finding of investor ineligibility or a rate/exit quote.
   if(profile.emergencyFundMonths===0 && (
     row.bankDepositAccessReview
     ||row.postalSavingsAccessReview?.schemeType==='NATIONAL_SAVINGS_TIME_DEPOSIT'
   ))reasons.push('RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_DEPOSIT_ACCESS_AND_EARLY_EXIT_REVIEW');
   // Only a recorded zero-month emergency buffer justifies this additional
   // non-ranking notice. Missing optional facts must not be treated as zero,
   // and a broad category review never establishes product ineligibility.
   if(profile.emergencyFundMonths===0 && (
     row.aifCategoryAccessReview
     ||row.id.startsWith('catalog_2026_nps_')
     ||row.id==='catalog_2026_bank_tax_saver_fd'
     ||row.id==='catalog_2026_sif_hybrid_longshort'
   ))reasons.push('RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_RESTRICTED_EXIT_ACCESS_REVIEW');
   // Not a statutory lock-in: these archetypes have unverified secondary exit,
   // issuer repayment or managed-account liquidity terms. This is only a notice.
   if(profile.emergencyFundMonths===0 && (
     row.nbfcPublicDepositAccessReview || row.sgsStripsAccessReview
     || row.governmentBondStructureReview?.structureType?.endsWith('_STRIP')
     || row.id==='catalog_2026_pms_discretionary'
     || row.id==='catalog_2026_pms_nondiscretionary'
     || row.id==='catalog_2026_ncd_unlisted'
   ))reasons.push('RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_UNVERIFIED_EXIT_LIQUIDITY_REVIEW');
   // RBI Retail Direct permits secondary sales but does not guarantee the
   // executable price, depth or settlement timing for a particular security.
   // A recorded zero-month emergency buffer warrants a separate liquidity
   // notice even without an explicit Emergency Fund investment goal.
   if(profile.emergencyFundMonths===0 && (
     row.rbiRetailDirectAccessReview
     ||(row.governmentBondStructureReview
       && !row.governmentBondStructureReview.structureType.endsWith('_STRIP'))
   ))reasons.push('RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_GSEC_EARLY_SALE_PRICE_AND_SETTLEMENT_REVIEW');
   // SEBI's scheme-level risk-o-meter and redemption disclosures do not
   // turn an index, ETF, debt-fund or FoF category into a cash equivalent.
   // Only an explicitly recorded zero-month emergency buffer adds these
   // non-ranking notices; missing profile data cannot imply zero coverage.
   if(profile.emergencyFundMonths===0){
     if(row.indexBenchmarkReview||row.etfBenchmarkReview||row.thematicIndexReview)
       reasons.push('RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_EQUITY_SCHEME_DRAWDOWN_AND_EXIT_REVIEW');
     if(row.sebiDebtSchemeStructureReview)
       reasons.push('RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_DEBT_FUND_NAV_AND_REDEMPTION_REVIEW');
     if(row.fundOfFundsCategoryReview)
       reasons.push('RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_FOF_UNDERLYING_RISK_AND_REDEMPTION_REVIEW');
   }
   // These are profile-fact notices, not an assessment of personal eligibility.
   // A recorded zero-month emergency buffer makes issuer credit, resale spreads,
   // property-unit liquidity and underlying silver-fund NAV/exit risks relevant.
   // Do not infer missing emergency-fund data means zero coverage.
   if(profile.emergencyFundMonths===0){
     if(row.debtInstrumentReview)
       reasons.push('RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_DEBT_ISSUER_REPAYMENT_AND_RESALE_REVIEW');
     if(row.id==='catalog_2026_physical_gold_bullion'
       ||row.id==='catalog_2026_physical_silver_bullion')
       reasons.push('RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_PHYSICAL_BULLION_RESALE_SPREAD_AND_CUSTODY_REVIEW');
     if(row.id==='catalog_2026_sm_reit_scheme')
       reasons.push('RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_SM_REIT_UNIT_LIQUIDITY_AND_EXIT_REVIEW');
     if(row.id==='catalog_2026_silver_fof')
       reasons.push('RECORDED_ZERO_EMERGENCY_BUFFER_REQUIRES_SILVER_FOF_NAV_AND_REDEMPTION_REVIEW');
   }
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
