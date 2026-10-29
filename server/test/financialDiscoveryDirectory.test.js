import test from 'node:test';
import assert from 'node:assert/strict';
import { listFinancialDiscoveryDirectory } from '../services/financialDiscoveryDirectory.js';

test('all 250 educational entries are visible without PostgreSQL or provider entitlements',()=>{
 const response=listFinancialDiscoveryDirectory();
 assert.equal(response.status,'DISCOVERY_ONLY');
 assert.equal(response.totalCount,250);
 assert.equal(response.items.length,250);
 assert.equal(response.items.filter(e=>e.origin==='LEGACY_155').length,155);
 assert.equal(response.items.filter(e=>e.origin==='EXTENDED_95').length,95);
 assert.equal(new Set(response.items.map(e=>e.id)).size,250);
 assert.equal(new Set(response.items.map(e=>e.name.toLowerCase())).size,250);
 assert.equal(response.items.find(x=>x.id==='catalog_2026_bank_rd')?.name,'Bank Recurring Deposit');
});
test('the first category exposes official bank links without market rates or product approval',()=>{
 const response=listFinancialDiscoveryDirectory();
 const rd=response.items.find(x=>x.id==='catalog_2026_bank_rd');
 assert.equal(rd.publicIssuerReferences.length,2);
 assert.deepEqual(rd.publicIssuerReferences.map(x=>x.issuerName),
   ['State Bank of India','HDFC Bank Limited']);
 assert.ok(rd.publicIssuerReferences.every(x=>x.evidenceStatus==='PUBLIC_ISSUER_LINK_ONLY_NOT_LICENSED_PRODUCT_DATA'
   && x.officialProductUrl.startsWith('https://')
   && !('publishedRatePercentPerAnnum' in x)));
 const hdfc = rd.publicIssuerReferences.find(x => x.issuerName === 'HDFC Bank Limited');
 assert.equal(hdfc.providerRightsReview,
   'PUBLIC_TERMS_RESTRICT_COMMERCIAL_REPRODUCTION_STORAGE_AND_REDISTRIBUTION');
 assert.equal(hdfc.providerTermsUrl,
   'https://www.hdfc.bank.in/useful-links/website-usage-terms');
 assert.ok(rd.publicIssuerReferences.every(x => x.independentCommercialPermissionVerified === false));
 assert.ok(rd.publicIssuerReferences.every(x => !('publishedRatePercentPerAnnum' in x)));
 assert.equal(rd.productData.currentInterestRate,null);
 assert.equal(rd.dataRights,'NOT_VERIFIED');
 assert.ok(response.items.filter(x=>x.id!==rd.id).every(x=>x.publicIssuerReferences.length===0));
 rd.publicIssuerReferences[0].issuerName='tampered';
 assert.equal(listFinancialDiscoveryDirectory().items.find(x=>x.id===rd.id)
   .publicIssuerReferences[0].issuerName,'State Bank of India');
});
test('each source inventory entry exposes provenance-labelled, safely copied educational metadata',()=>{
 const entries=listFinancialDiscoveryDirectory().items;
 assert.equal(entries.length,250);
 assert.equal(entries.filter(x=>x.studyNotes.provenance==='UNVERIFIED_LEGACY_EDUCATIONAL_CATALOG').length,155);
 assert.equal(entries.filter(x=>x.studyNotes.provenance==='REGULATORY_CATEGORY_REFERENCE_ONLY').length,95);
 for (const entry of entries) {
   for (const key of ['possibleBenefits','keyTradeoffs','goalThemes']) {
     assert.ok(Array.isArray(entry.studyNotes[key]));
     assert.ok(entry.studyNotes[key].length<=4);
     assert.ok(entry.studyNotes[key].every(x=>typeof x==='string'));
   }
   assert.ok(Object.values(entry.productData).every(x=>x===null));
   assert.equal(entry.recommendationEligible,false);
 }
 entries[0].studyNotes.possibleBenefits.push('unauthorized mutation');
 assert.ok(!listFinancialDiscoveryDirectory().items[0].studyNotes.possibleBenefits
   .includes('unauthorized mutation'));
});
test('all 95 newer categories expose different structure research without investment approvals',()=>{
 const rows=listFinancialDiscoveryDirectory().items;
 const ext=rows.filter(x=>x.origin==='EXTENDED_95');
 assert.equal(ext.length,95);
 assert.ok(new Set(ext.map(x=>x.frameworkResearch.structuralExposureClass)).size>=25);
 assert.ok(ext.every(x=>x.frameworkResearch.specificResearchConcern.includes(x.name)
   && x.frameworkResearch.actualRiskScore===null
   && x.frameworkResearch.issuerTermsVerified===false
   && x.frameworkResearch.sourceRightsVerified===false));
 const year5=ext.find(x=>x.id==='catalog_2026_po_td_5');
 assert.equal(year5.frameworkResearch.nominalMaturityMonths,60);
 const aif=ext.find(x=>x.id==='catalog_2026_aif1_vc');
 assert.equal(aif.frameworkResearch.standardCapitalReferenceInr,10000000);
 assert.equal(aif.frameworkResearch.standardMinimumHasExceptions,true);
 const child=ext.find(x=>x.id==='catalog_2026_nps_vatsalya');
 assert.match(child.frameworkResearch.structuralExposureClass,/MINOR/);
 const without=ext.find(x=>x.id==='catalog_2026_index_nifty500');
 assert.equal(without.frameworkResearch.standardCapitalReferenceInr,null);
 const edited=listFinancialDiscoveryDirectory();
 edited.items.find(x=>x.id===aif.id).frameworkResearch.standardCapitalReferenceInr=0;
 assert.equal(listFinancialDiscoveryDirectory().items.find(x=>x.id===aif.id)
   .frameworkResearch.standardCapitalReferenceInr,10000000);
});
test('95 public regulatory framework facts do not qualify actual investments',()=>{
 const rows=listFinancialDiscoveryDirectory().items.filter(x=>x.origin==='EXTENDED_95');
 const reviewed=rows.filter(x=>x.frameworkResearch.reviewedOfficialFrameworkFact !== null);
 assert.equal(rows.length,95);
 assert.equal(reviewed.length,95);
 assert.ok(reviewed.every(x=>x.frameworkResearch.officialFrameworkVerification
    ==='DIRECT_OFFICIAL_FRAMEWORK_FACT_REVIEWED'));
 assert.ok(rows.every(x=>!x.recommendationEligible && x.productAvailability==='NOT_VERIFIED'
   && x.dataRights==='NOT_VERIFIED' && x.frameworkResearch.actualRiskScore===null));
 const find=id=>rows.find(x=>x.id==='catalog_2026_'+id);
 assert.equal(find('nps_lc25').frameworkResearch.reviewedOfficialFrameworkFact.value,25);
 assert.equal(find('nps_lc50').frameworkResearch.reviewedOfficialFrameworkFact.value,50);
 assert.equal(find('nps_lc75').frameworkResearch.reviewedOfficialFrameworkFact.value,75);
 assert.equal(find('nps_lc_aggressive').frameworkResearch.reviewedOfficialFrameworkFact.value,50);
 assert.equal(find('nps_asset_a').frameworkResearch.reviewedOfficialFrameworkFact.value,5);
 assert.equal(find('po_td_5').frameworkResearch.reviewedOfficialFrameworkFact.value,60);
 assert.equal(find('tbill_91').frameworkResearch.reviewedOfficialFrameworkFact.value,91);
 assert.equal(find('aif1_vc').frameworkResearch.reviewedOfficialFrameworkFact.value,10000000);
 assert.equal(find('sif_hybrid_longshort').frameworkResearch.reviewedOfficialFrameworkFact.value,1000000);
 assert.equal(find('nbfc_fd_payout').frameworkResearch.reviewedOfficialFrameworkFact.officialSourceUrl,
  'https://www.dicgc.org.in/guide-to-deposit-insurance');
  assert.equal(find('index_nifty100').frameworkResearch.reviewedOfficialFrameworkFact.value,'Nifty 100');
 assert.match(find('ncd_unsecured').frameworkResearch.reviewedOfficialFrameworkFact.factCode,/BOND_ISSUER_RATE/);
 assert.match(find('gilt_10y_constant').frameworkResearch.reviewedOfficialFrameworkFact.factCode,/RISKOMETER/);
 assert.match(find('sm_reit_scheme').frameworkResearch.reviewedOfficialFrameworkFact.factCode,/REIT_FRAMEWORK/);
 assert.match(find('physical_silver_bullion').frameworkResearch.reviewedOfficialFrameworkFact.factCode,/SILVER_BAR/);
 assert.match(find('sdl_coupon_strip').frameworkResearch.reviewedOfficialFrameworkFact.factCode,/STRIPS/);
 assert.match(find('bank_tax_saver_fd').frameworkResearch.reviewedOfficialFrameworkFact.factCode,/DICGC/);
 assert.equal(find('etf_nifty500_lowvol').frameworkResearch.reviewedOfficialFrameworkFact.value,
 'Nifty500 Low Volatility 50');
 assert.equal(find('index_india_digital').frameworkResearch.reviewedOfficialFrameworkFact.value,'Nifty India Digital');
 assert.ok(find('etf_nifty500_lowvol').frameworkResearch.reviewedOfficialFrameworkFact.scope
 .includes('NOT_AN_EXISTING_FUND_OR_ETF'));
 const mutated=rows.find(x=>x.id==='catalog_2026_nps_lc25');
 mutated.frameworkResearch.reviewedOfficialFrameworkFact.value=99;
 assert.equal(listFinancialDiscoveryDirectory().items.find(x=>x.id===mutated.id)
    .frameworkResearch.reviewedOfficialFrameworkFact.value,25);
});
test('every catalog item reports missing REAL product facts, not fabricated rates',()=>{
 const items=listFinancialDiscoveryDirectory().items;
 for (const x of items){
  assert.equal(x.record_kind,'ARCHETYPE');
  assert.equal(x.recommendationEligible,false);
  assert.equal(x.productAvailability,'NOT_VERIFIED');
  assert.equal(x.dataRights,'NOT_VERIFIED');
  assert.ok(x.name?.trim());
  assert.ok(x.category?.trim());
  for(const value of Object.values(x.productData))assert.equal(value,null,x.id);
  if(x.origin==='EXTENDED_95'){
   assert.match(x.referenceUrl,/^https:\/\//);
   assert.equal(x.educationalRiskLabel,null);
  }
 }
 const mutated=listFinancialDiscoveryDirectory();
 mutated.items[0].name='not the source';
 mutated.items[0].productData.currentPrice=1234;
 const refreshed=listFinancialDiscoveryDirectory();
 assert.notEqual(refreshed.items[0].name,'not the source');
 assert.equal(refreshed.items[0].productData.currentPrice,null);
});

test('all 95 framework evidence scopes are explicit and SGS STRIPS are not licensed products',()=>{
 const extended=listFinancialDiscoveryDirectory().items.filter(x=>x.origin==='EXTENDED_95');
 assert.equal(extended.length,95);
 for(const item of extended){
  assert.equal(item.frameworkResearch.evidenceScope,
   item.frameworkResearch.reviewedOfficialFrameworkFact.scope);
  assert.equal(item.recommendationEligible,false);
  assert.equal(item.productAvailability,'NOT_VERIFIED');
 }
 for(const id of ['catalog_2026_sdl_coupon_strip','catalog_2026_sdl_principal_strip']){
  const item=extended.find(x=>x.id===id);
  assert.equal(item.frameworkResearch.reviewedOfficialFrameworkFact.officialSourceUrl,
   'https://www.rbi.org.in/Scripts/NotificationUser.aspx?Id=12867&Mode=0');
  assert.equal(item.frameworkResearch.actualRiskScore,null);
  assert.equal(item.frameworkResearch.issuerTermsVerified,false);
  assert.equal(item.frameworkResearch.sourceRightsVerified,false);
  assert.equal(item.productData.currentPrice,null);
 }
});

test('NPS Vatsalya points to the dedicated PFRDA minor scheme without product approval',()=>{
 const child=listFinancialDiscoveryDirectory().items.find(x=>x.id==='catalog_2026_nps_vatsalya');
 assert.equal(child.referenceUrl,'https://pfrda.org.in/en/schemes/national-pension-system/nps-vatsalya');
 assert.equal(child.frameworkResearch.reviewedOfficialFrameworkFact.officialSourceUrl,child.referenceUrl);
 assert.equal(child.frameworkResearch.reviewedOfficialFrameworkFact.reviewedOn,'2026-10-29');
 assert.equal(child.recommendationEligible,false);
 assert.equal(child.productData.currentPrice,null);
 assert.equal(child.dataRights,'NOT_VERIFIED');
});

test('NBFC educational entries show separate RBI deposit-access and DICGC coverage blockers without product approval',()=>{
 const entries=listFinancialDiscoveryDirectory().items;
 const ids=['catalog_2026_nbfc_fd_cumulative','catalog_2026_nbfc_fd_payout'];
 for(const id of ids){
  const item=entries.find(x=>x.id===id);
  const review=item.frameworkResearch.publicDepositAccessReview;
  assert.equal(review.officialRbiDirectionsUrl,'https://rbi.org.in/scripts/NotificationUser.aspx?Id=10563');
  assert.equal(review.officialDicgcCoverageUrl,'https://www.dicgc.org.in/guide-to-deposit-insurance');
  assert.equal(review.reviewedOn,'2026-10-29');
  assert.equal(review.issuerDepositTakingPermissionVerified,false);
  assert.equal(review.issuerCreditRatingVerified,false);
  assert.equal(review.issuerSpecificTermsVerified,false);
  assert.equal(review.individualRetailEligibilityVerified,false);
  assert.equal(review.commercialDataRightsVerified,false);
  assert.equal(item.recommendationEligible,false);
  assert.equal(item.productAvailability,'NOT_VERIFIED');
  assert.equal(item.productData.currentInterestRate,null);
 }
 assert.equal(entries.filter(x=>x.frameworkResearch?.publicDepositAccessReview).length,2);
 const edited=entries.find(x=>x.id===ids[0]);
 edited.frameworkResearch.publicDepositAccessReview.issuerDepositTakingPermissionVerified=true;
 assert.equal(listFinancialDiscoveryDirectory().items.find(x=>x.id===ids[0])
  .frameworkResearch.publicDepositAccessReview.issuerDepositTakingPermissionVerified,false);
});

test('four government-security categories expose dated RBI evidence but no investable product facts',()=>{
 const all=listFinancialDiscoveryDirectory().items;
 const ids=['tbill_91','tbill_182','tbill_364','sdl_dated'];
 for(const id of ids){
  const row=all.find(x=>x.id==='catalog_2026_'+id),access=row.frameworkResearch.retailDirectAccessReview;
  assert.equal(access.reviewedOn,'2026-10-29');
  assert.equal(access.generalRetailAccessDescribed,true);
  assert.equal(access.profileSpecificAccountEligibilityVerified,false);
  assert.equal(access.currentIssueOrQuoteVerified,false);
  assert.equal(access.independentCommercialDataPermissionVerified,false);
  assert.equal(row.recommendationEligible,false);
  assert.equal(row.productAvailability,'NOT_VERIFIED');
  assert.equal(row.productData.currentPrice,null);
  assert.equal(row.productData.marketFactAsOf,null);
 }
 assert.equal(all.filter(x=>x.frameworkResearch?.retailDirectAccessReview).length,4);
 all.find(x=>x.id==='catalog_2026_tbill_91').frameworkResearch.retailDirectAccessReview.currentIssueOrQuoteVerified=true;
 assert.equal(listFinancialDiscoveryDirectory().items.find(x=>x.id==='catalog_2026_tbill_91').frameworkResearch.retailDirectAccessReview.currentIssueOrQuoteVerified,false);
});


test('India Post research exposes dated scheme listings but no authorized account terms or rates',()=>{
 const all=listFinancialDiscoveryDirectory().items;
 const ids=['po_savings','po_td_2','po_td_3','po_td_5'];
 for(const suffix of ids){
  const row=all.find(x=>x.id==='catalog_2026_'+suffix);
  const review=row.frameworkResearch.postalSavingsAccessReview;
  assert.equal(review.officialIndiaPostSchemeListingUrl,
   'https://www.indiapost.gov.in/banking-services/savings');
  assert.equal(review.reviewedOn,'2026-10-29');
  assert.equal(review.individualAccountEligibilityAndKycVerified,false);
  assert.equal(review.independentlyAuthorizedCurrentRateVerified,false);
  assert.equal(review.commercialDisplayAndRedistributionRightsVerified,false);
  assert.equal(row.productAvailability,'NOT_VERIFIED');
  assert.equal(row.dataRights,'NOT_VERIFIED');
  assert.equal(row.productData.currentInterestRate,null);
  assert.equal(row.recommendationEligible,false);
 }
 assert.equal(all.filter(x=>x.frameworkResearch?.postalSavingsAccessReview).length,4);
 all.find(x=>x.id==='catalog_2026_po_td_5').frameworkResearch.postalSavingsAccessReview
  .independentlyAuthorizedCurrentRateVerified=true;
 assert.equal(listFinancialDiscoveryDirectory().items.find(x=>x.id==='catalog_2026_po_td_5')
  .frameworkResearch.postalSavingsAccessReview.independentlyAuthorizedCurrentRateVerified,false);
});

test('four central-government bond directory entries expose read-only structure evidence only',()=>{
 const ids=['gsec_coupon_strip','gsec_principal_strip','sovereign_green','gsec_floating'];
 const all=listFinancialDiscoveryDirectory().items;
 for(const suffix of ids){
  const item=all.find(x=>x.id==='catalog_2026_'+suffix),review=item.frameworkResearch.governmentBondStructureReview;
  assert.ok(review);
  assert.equal(review.reviewedOn,'2026-10-29');
  assert.equal(review.currentMarketPriceOrYieldVerified,false);
  assert.equal(review.specificSecurityIsinVerified,false);
  assert.equal(review.independentCommercialDataRightsVerified,false);
  assert.equal(item.frameworkResearch.reviewedOfficialFrameworkFact.officialSourceUrl,review.officialStructureSourceUrl);
  assert.equal(item.recommendationEligible,false);
  assert.equal(item.dataRights,'NOT_VERIFIED');
  assert.equal(item.productAvailability,'NOT_VERIFIED');
  assert.ok(Object.values(item.productData).every(v=>v===null));
 }
 assert.equal(all.filter(x=>x.frameworkResearch?.governmentBondStructureReview).length,4);
 all.find(x=>x.id==='catalog_2026_gsec_coupon_strip').frameworkResearch.governmentBondStructureReview.specificSecurityIsinVerified=true;
 assert.equal(listFinancialDiscoveryDirectory().items.find(x=>x.id==='catalog_2026_gsec_coupon_strip').frameworkResearch.governmentBondStructureReview.specificSecurityIsinVerified,false);
});

test('five bank deposit directory records copy dated evidence without product qualification',()=>{
 const ids=['bank_rd','bank_tax_saver_fd','bank_sweep_fd','bank_fd_monthly','bank_fd_quarterly'];
 const items=listFinancialDiscoveryDirectory().items;
 for(const suffix of ids){
  const row=items.find(x=>x.id==='catalog_2026_'+suffix);
  assert.equal(row.frameworkResearch.bankDepositAccessReview.reviewedOn,'2026-10-29');
  assert.equal(row.frameworkResearch.bankDepositAccessReview.independentCommercialDataRightsVerified,false);
  assert.equal(row.frameworkResearch.bankDepositAccessReview.personalizedSuitabilityVerified,false);
  assert.equal(row.recommendationEligible,false);
  assert.equal(row.productAvailability,'NOT_VERIFIED');
  assert.equal(row.dataRights,'NOT_VERIFIED');
  assert.ok(Object.values(row.productData).every(x=>x===null));
 }
 assert.equal(items.filter(x=>x.frameworkResearch?.bankDepositAccessReview).length,5);
 const tax=items.find(x=>x.id==='catalog_2026_bank_tax_saver_fd');
 assert.equal(tax.frameworkResearch.bankDepositAccessReview.fiveYearSchemeReferenceMonths,60);
 items.find(x=>x.id==='catalog_2026_bank_rd').frameworkResearch.bankDepositAccessReview.independentCommercialDataRightsVerified=true;
 assert.equal(listFinancialDiscoveryDirectory().items.find(x=>x.id==='catalog_2026_bank_rd')
  .frameworkResearch.bankDepositAccessReview.independentCommercialDataRightsVerified,false);
});

test('nine SEBI debt-fund strategy directory rows expose distinct sourced structure and copy nested evidence',()=>{
 const ids=["gilt_10y_constant","medium_long_duration_mf","long_duration_mf","target_maturity_gsec_index","target_maturity_sdl_index","target_maturity_psu_index","constant_maturity_debt_index","domestic_debt_fof","gsec_debt_etf"];
 const all=listFinancialDiscoveryDirectory().items;
 const kinds=["GILT_10_YEAR_CONSTANT_DURATION","MEDIUM_TO_LONG_TERM_DEBT_FUND","LONG_TERM_DEBT_FUND","GSEC_TARGET_MATURITY_INDEX_STRATEGY","SDL_TARGET_MATURITY_INDEX_STRATEGY","PSU_BOND_TARGET_MATURITY_INDEX_STRATEGY","CONSTANT_MATURITY_PASSIVE_DEBT_INDEX_STRATEGY","DOMESTIC_DEBT_FUND_OF_FUNDS","GSEC_PASSIVE_DEBT_ETF_STRATEGY"];
 for(const [i,suffix] of ids.entries()){
  const row=all.find(x=>x.id==='catalog_2026_'+suffix);
  const review=row.frameworkResearch.sebiDebtSchemeStructureReview;
  assert.equal(review.schemeArchetype,kinds[i]);
  assert.equal(review.reviewedOn,'2026-10-29');
  assert.equal(review.officialSebiCategorizationCircularUrl,'https://www.sebi.gov.in/legal/circulars/feb-2026/categorization-and-rationalization-of-mutual-fund-schemes_99983.html');
  assert.equal(review.currentSchemeRiskometerVerified,false);
  assert.equal(review.independentCommercialDataRightsVerified,false);
  assert.equal(review.individualSuitabilityVerified,false);
  assert.equal(row.productAvailability,'NOT_VERIFIED');
  assert.equal(row.dataRights,'NOT_VERIFIED');
  assert.equal(row.recommendationEligible,false);
  assert.ok(Object.values(row.productData).every(value=>value===null));
 }
 assert.equal(all.filter(x=>x.frameworkResearch?.sebiDebtSchemeStructureReview).length,9);
 const mutated=all.find(x=>x.id==='catalog_2026_medium_long_duration_mf');
 mutated.frameworkResearch.sebiDebtSchemeStructureReview.riskConsiderations[0]='tampered';
 mutated.frameworkResearch.sebiDebtSchemeStructureReview.currentSchemeRiskometerVerified=true;
 const fresh=listFinancialDiscoveryDirectory().items.find(x=>x.id===mutated.id);
 assert.notEqual(fresh.frameworkResearch.sebiDebtSchemeStructureReview.riskConsiderations[0],'tampered');
 assert.equal(fresh.frameworkResearch.sebiDebtSchemeStructureReview.currentSchemeRiskometerVerified,false);
});

test('five equity index archetypes expose independent official benchmark evidence without product promotion or mutable references',()=>{
 const suffixes=['index_nifty_next50','index_nifty100','index_nifty500','index_midcap150','index_smallcap250'];
 const items=listFinancialDiscoveryDirectory().items;
 for(const suffix of suffixes){
  const item=items.find(x=>x.id==='catalog_2026_'+suffix);
  const review=item.frameworkResearch.indexBenchmarkReview;
  assert.equal(review.reviewedOn,'2026-10-29');
  assert.equal(review.officialNseIndexUrl,item.frameworkResearch.reviewedOfficialFrameworkFact.officialSourceUrl);
  assert.ok(review.riskConsiderations.length>=2);
  assert.ok(review.investorAccessConstraints.length>=2);
  assert.equal(review.currentSchemeRiskometerVerified,false);
  assert.equal(review.independentCommercialDataRightsVerified,false);
  assert.equal(item.recommendationEligible,false);
  assert.equal(item.productAvailability,'NOT_VERIFIED');
  assert.equal(item.dataRights,'NOT_VERIFIED');
  assert.ok(Object.values(item.productData).every(v=>v===null));
 }
 assert.equal(items.filter(x=>x.frameworkResearch?.indexBenchmarkReview).length,5);
 const first=items.find(x=>x.id==='catalog_2026_index_nifty100');
 first.frameworkResearch.indexBenchmarkReview.riskConsiderations.push('forged');
 first.frameworkResearch.indexBenchmarkReview.individualSuitabilityVerified=true;
 const refreshed=listFinancialDiscoveryDirectory().items.find(x=>x.id===first.id);
 assert.equal(refreshed.frameworkResearch.indexBenchmarkReview.individualSuitabilityVerified,false);
 assert.ok(!refreshed.frameworkResearch.indexBenchmarkReview.riskConsiderations.includes('forged'));
});


test('eight PFRDA NPS common choices expose independently copied dated framework evidence only',()=>{
 const items=listFinancialDiscoveryDirectory().items;
 const ids=['nps_lc25','nps_lc50','nps_lc75','nps_lc_aggressive',
  'nps_asset_e','nps_asset_c','nps_asset_g','nps_asset_a'];
 const rows=ids.map(s=>items.find(x=>x.id==='catalog_2026_'+s));
 assert.equal(rows.length,8);
 for(const row of rows){
  const review=row.frameworkResearch.npsCommonSchemeReview;
  assert.ok(review,row.id);
  assert.equal(review.reviewedOn,'2026-10-29');
  assert.equal(review.lifecycleNomenclatureCircularIssuedOn,'2025-10-17');
  assert.equal(review.exitFaqUpdatedMonth,'2026-03');
  assert.ok(review.riskConsiderations.length>=2);
  assert.ok(review.investorAccessConstraints.length>=2);
  assert.equal(review.specificPensionFundAndSchemeVerified,false);
  assert.equal(review.currentSchemeNavAndRiskLevelVerified,false);
  assert.equal(review.subscriberAgeResidencyKycAndSectorVerified,false);
  assert.equal(review.commercialDataAndRedistributionRightsVerified,false);
  assert.equal(review.individualSuitabilityVerified,false);
  assert.equal(row.recommendationEligible,false);
  assert.equal(row.productAvailability,'NOT_VERIFIED');
  assert.ok(Object.values(row.productData).every(v=>v===null));
 }
 assert.equal(items.filter(x=>x.frameworkResearch?.npsCommonSchemeReview).length,8);
 const aggressive=rows[3].frameworkResearch.npsCommonSchemeReview;
 assert.deepEqual([aggressive.publishedEquityAllocationAtAge35Pct,
  aggressive.publishedEquityAllocationAtAge55Pct,aggressive.equityTaperStartsAfterAge],[50,35,45]);
 assert.equal(rows[2].frameworkResearch.npsCommonSchemeReview.choiceCode,'LIFE_CYCLE_75_HIGH');
 assert.equal(rows[7].referenceUrl,
  'https://pfrda.org.in/en/intermediaries/registered-intermediaries/pension-funds');
 assert.equal(rows[7].frameworkResearch.reviewedOfficialFrameworkFact.officialSourceUrl,rows[7].referenceUrl);
 rows[7].frameworkResearch.npsCommonSchemeReview.riskConsiderations.push('tampered');
 rows[7].frameworkResearch.npsCommonSchemeReview.investorAccessConstraints[0]='tampered';
 const again=listFinancialDiscoveryDirectory().items.find(x=>x.id===rows[7].id);
 assert.ok(!again.frameworkResearch.npsCommonSchemeReview.riskConsiderations.includes('tampered'));
 assert.notEqual(again.frameworkResearch.npsCommonSchemeReview.investorAccessConstraints[0],'tampered');
});
