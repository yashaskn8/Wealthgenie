import React from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getCurrentProfile: vi.fn(),
  getFinancialDiscoveryDirectory: vi.fn(),
  getQualifiedFamilyTopProducts: vi.fn(),
  getThreeProductReadyFamilies: vi.fn(),
}));
vi.mock('../../services/api', () => api);

const families = Array.from({length:250},(_,index)=>({
  id:'family_'+String(index+1).padStart(3,'0'),
  name:'Investment family '+(index+1),
  record_kind:'ARCHETYPE',
  origin:index<155?'LEGACY_155':'EXTENDED_95',
  category:index<155?'Legacy category':'Expanded category',
  subcategory:'Reference',
  productAvailability:'NOT_VERIFIED',
  dataRights:'NOT_VERIFIED',
  recommendationEligible:false,
  description:index===0?'Educational description of this family':null,
  educationalRiskLabel:index===0?'Medium':null,
  educationalRiskBasis:'UNVERIFIED_LEGACY_CATALOG_REFERENCE',
  studyNotes:index<155 ? {
    provenance:'UNVERIFIED_LEGACY_EDUCATIONAL_CATALOG',
    possibleBenefits:index===0?['Benefit unique to first category']:[],
    keyTradeoffs:index===0?['Tradeoff unique to first category']:[],
    goalThemes:index===0?['Emergency Fund']:[],
  } : {provenance:'REGULATORY_CATEGORY_REFERENCE_ONLY',
    possibleBenefits:[],keyTradeoffs:[],goalThemes:[]},
  instrumentForm:index>=155?'FUND_STRATEGY':null,
  referenceUrl:index>=155?'https://www.sebi.gov.in/':null,
  referenceCheckedAsOf:index>=155?'2026-10-22':null,
  publicIssuerReferences:index===249?[
    {issuerName:'State Bank of India',officialProductUrl:'https://sbi.bank.in/example',reviewedOn:'2026-10-28',
      evidenceStatus:'PUBLIC_ISSUER_LINK_ONLY_NOT_LICENSED_PRODUCT_DATA',
      providerRightsReview:'BANK_PUBLIC_RATE_PAGE_HAS_NO_INDEPENDENTLY_VERIFIED_COMMERCIAL_ENTITLEMENT',
      providerTermsUrl:null,independentCommercialPermissionVerified:false},
    {issuerName:'HDFC Bank Limited',officialProductUrl:'https://www.hdfc.bank.in/example',reviewedOn:'2026-10-28',
      evidenceStatus:'PUBLIC_ISSUER_LINK_ONLY_NOT_LICENSED_PRODUCT_DATA',
      providerRightsReview:'PUBLIC_TERMS_RESTRICT_COMMERCIAL_REPRODUCTION_STORAGE_AND_REDISTRIBUTION',
      providerTermsUrl:'https://www.hdfc.bank.in/useful-links/website-usage-terms',
      independentCommercialPermissionVerified:false},
  ]:[],
  productData:{currentPrice:null,latestNav:null,currentInterestRate:null,
    verifiedMinimumInvestment:null,verifiedFees:null,personalizedAfterTaxReturn:null,marketFactAsOf:null},
}));
const directory=()=>({
  status:'DISCOVERY_ONLY',source:'WEALTHGENIE_CATALOG_155_PLUS_95',
  totalCount:250,items:families.map(x=>({...x,productData:{...x.productData}})),
});
const qualifiedResponse = () => ({
  status:'AVAILABLE',familyId:'family_001',
  source:{profileId:'0123456789abcdef01234567'},
  products:[1,2].map(index=>({
    id:'bond_'+index,familyId:'family_001',name:'Verified bond '+index,
    riskLevel:2,annualFeeBps:0,lockInMonths:0,verifiedTaxClass:'ORDINARY_INTEREST',
    marketFact:{
      type:'PRICE',value:100+index,unit:'INR_PER_UNIT',dataClass:'END_OF_DAY',
      sourceId:'verified_source',observationId:String(index),
      asOf:new Date(Date.now()-30*60*1000).toISOString(),
    },
    evidence:{
      product:'https://issuer.example/bond/'+index,
      terms:'https://issuer.example/terms/'+index,
      risk:'https://issuer.example/risk/'+index,
      reviewedAt:new Date(Date.now()-86400000).toISOString(),
      expiresAt:new Date(Date.now()+30*86400000).toISOString(),
    },
  })),
});
let Explorer;
beforeAll(async()=>{
  vi.stubEnv('VITE_FINANCIAL_POSTGRES_ENABLED','true');
  ({default:Explorer}=await import('../InvestmentUniverseExplorer.jsx'));
});
afterAll(()=>vi.unstubAllEnvs());
beforeEach(()=>{
  api.getFinancialDiscoveryDirectory.mockResolvedValue(directory());
  api.getThreeProductReadyFamilies.mockResolvedValue({
    status:'TWO_OR_MORE_SOURCE_QUALIFIED_CANDIDATES',familyIds:['family_001'],count:1,
  });
  api.getCurrentProfile.mockResolvedValue({profileId:'0123456789abcdef01234567'});
});
afterEach(()=>{cleanup();vi.clearAllMocks();});

describe('all 250 investment categories are browseable without product approval',()=>{
 it('shows 155 legacy + 95 extended entries, searchable, with all categories visible',async()=>{
   render(<Explorer/>);
   await waitFor(()=>expect(screen.getByText(/250 educational investment categories loaded/)).toBeTruthy());
   expect(api.getFinancialDiscoveryDirectory).toHaveBeenCalledTimes(1);
   expect(screen.getByText('Investment family 250')).toBeTruthy();
   expect(screen.getByText('250 matching options')).toBeTruthy();
   fireEvent.change(screen.getByLabelText('Search all 250 investment options'),{
     target:{value:'Investment family 250'},
   });
   expect(screen.getByText('1 matching options')).toBeTruthy();
   fireEvent.click(screen.getByRole('button',{name:'Check tailored top 3 for Investment family 250'}));
   expect(screen.getByText(/Current market price \/ NAV \/ interest rate/)).toBeTruthy();
   expect(screen.getByText(/Unavailable — no authorized, fresh product observation/)).toBeTruthy();
   expect(screen.getByRole('link',{name:'View public category reference'})).toHaveAttribute('href','https://www.sebi.gov.in/');
   expect(screen.getByRole('link',{name:'State Bank of India — official issuer page'}))
     .toHaveAttribute('href','https://sbi.bank.in/example');
   expect(screen.getByRole('link',{name:'HDFC Bank Limited — official issuer page'}))
     .toHaveAttribute('href','https://www.hdfc.bank.in/example');
   expect(screen.getAllByText(/No live rate, licensed data feed or personal suitability is established/))
     .toHaveLength(2);
   expect(screen.getByRole('link',{name:'Website usage terms'}))
     .toHaveAttribute('href','https://www.hdfc.bank.in/useful-links/website-usage-terms');
   expect(screen.getByText(/Official website terms restrict commercial reuse without separate permission/))
     .toBeTruthy();
   expect(screen.getByText(/Independent commercial reuse permission has not been established/))
     .toBeTruthy();
   expect(api.getQualifiedFamilyTopProducts).not.toHaveBeenCalled();
 });
 it('shows detailed educational metadata without a current price, fake fees or tax',async()=>{
   render(<Explorer/>);
   await waitFor(()=>expect(screen.getByText('Investment family 1')).toBeTruthy());
   fireEvent.click(screen.getByRole('button',{name:'Check tailored top 3 for Investment family 1'}));
   const panel=screen.getByRole('region',{name:'Tailored top three for Investment family 1'});
   expect(within(panel).getByText(/Educational description of this family/)).toBeTruthy();
   expect(within(panel).getByText(/Medium.*unverified catalog assumption/)).toBeTruthy();
   expect(within(panel).getByText(/Not verified for an actual product/)).toBeTruthy();
   expect(within(panel).getByText(/Not calculated; requires verified product/)).toBeTruthy();
   expect(within(panel).getByText(/Personalized product comparison/i)).toBeTruthy();
   expect(within(panel).getByText('Benefit unique to first category')).toBeTruthy();
   expect(within(panel).getByText('Tradeoff unique to first category')).toBeTruthy();
   expect(within(panel).getByText(/unverified historical descriptions/)).toBeTruthy();
 });
 it('does not hide the directory when the qualified-product database fails',async()=>{
   api.getThreeProductReadyFamilies.mockRejectedValueOnce(new Error('Postgres unavailable'));
   render(<Explorer/>);
   await waitFor(()=>expect(screen.getByText('Investment family 250')).toBeTruthy());
   expect(screen.getByText(/Personalized product comparisons are not currently available/)).toBeTruthy();
   fireEvent.click(screen.getByRole('button',{name:'Check tailored top 3 for Investment family 1'}));
   expect(screen.getByText(/CURRENT_PRODUCT_COMPARISON_SOURCE_UNAVAILABLE/)).toBeTruthy();
   expect(api.getCurrentProfile).not.toHaveBeenCalled();
 });
 it('shows two or three properly qualified products only from profile-bound backend',async()=>{
   api.getQualifiedFamilyTopProducts.mockResolvedValue(qualifiedResponse());
   render(<Explorer/>);
   await waitFor(()=>expect(screen.getByText('Investment family 1')).toBeTruthy());
   fireEvent.click(screen.getByRole('button',{name:'Check tailored top 3 for Investment family 1'}));
   await waitFor(()=>expect(screen.getByText('Verified bond 1')).toBeTruthy());
   expect(screen.getAllByRole('link',{name:'Issuer evidence'})).toHaveLength(2);
   expect(screen.getAllByText(/Observation as-of:/)).toHaveLength(2);
   expect(screen.getAllByText(/Review expires:/)).toHaveLength(2);
   expect(screen.getAllByRole('link',{name:'Terms'})).toHaveLength(2);
   expect(screen.getAllByRole('link',{name:'Risk evidence'})).toHaveLength(2);
   expect(screen.getByText(/Observation ID: 1/)).toBeTruthy();
   expect(screen.getByText(/Observation ID: 2/)).toBeTruthy();
   expect(api.getQualifiedFamilyTopProducts).toHaveBeenCalledWith(
     'family_001','0123456789abcdef01234567',expect.any(Object));
 });
 // Isolate every invalid response so slow CI cannot time out the entire attack matrix.
 it.each([
   ['mismatched profile', x=>{x.source.profileId='fedcba9876543210fedcba98';}],
   ['mismatched family', x=>{x.familyId='family_002';}],
   ['mismatched product family', x=>{x.products[1].familyId='family_002';}],
   ['reused observation', x=>{x.products[1].marketFact.observationId=x.products[0].marketFact.observationId;}],
   ['missing as-of', x=>{delete x.products[0].marketFact.asOf;}],
   ['invalid as-of', x=>{x.products[0].marketFact.asOf='not-a-date';}],
   ['future observation', x=>{x.products[0].marketFact.asOf=new Date(Date.now()+30*86400000).toISOString();}],
   ['stale observation', x=>{x.products[0].marketFact.asOf=new Date(Date.now()-30*86400000).toISOString();}],
   ['zero price', x=>{x.products[0].marketFact.value=0;}],
   ['wrong rate data class', x=>{x.products[0].marketFact.dataClass='PUBLISHED_RATE';}],
   ['missing terms', x=>{delete x.products[0].evidence.terms;}],
   ['missing review timestamp', x=>{delete x.products[0].evidence.reviewedAt;}],
   ['expired review', x=>{x.products[0].evidence.expiresAt=new Date(Date.now()-86400000).toISOString();}],
   ['unverified tax class', x=>{x.products[0].verifiedTaxClass='UNVERIFIED';}],
   ['duplicate product identity', x=>{x.products[1].id=x.products[0].id;}],
 ])('rejects invalid comparison evidence: %s',async(_label,change)=>{
   const response=qualifiedResponse();
   change(response);
   api.getQualifiedFamilyTopProducts.mockResolvedValueOnce(response);
   const view=render(<Explorer/>);
   await waitFor(()=>expect(screen.getByText('Investment family 1')).toBeTruthy());
   fireEvent.click(screen.getByRole('button',{name:'Check tailored top 3 for Investment family 1'}));
   await waitFor(()=>expect(screen.getByText(/CURRENT_PROFILE_OR_QUALIFIED_COMPARISON_UNAVAILABLE/)).toBeTruthy());
   expect(screen.queryByText('Verified bond 1')).toBeNull();
   view.unmount();
 });
 it('rejects incomplete, duplicated and falsely approved public catalog input',async()=>{
   for(const makeBad of [
     d=>{d.items.pop();d.totalCount=249;},
     d=>{d.items[1].id=d.items[0].id;},
     d=>{d.items[2].recommendationEligible=true;},
     d=>{d.items[2].productData.currentInterestRate=6.5;},
   ]){
     const malformed=directory();makeBad(malformed);
     api.getFinancialDiscoveryDirectory.mockResolvedValueOnce(malformed);
     const view=render(<Explorer/>);
     await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('source-backed 250-family directory could not be loaded'));
     expect(screen.queryByText('Investment family 1')).toBeNull();
     view.unmount();
   }
 });

 it('keeps existing profile-based category order without inventing a ranking of 250 or products',async()=>{
   render(<Explorer profileShortlist={[
     {id:'family_003'}, {id:'family_001'}, {id:'family_003'},
     {id:'not-in-catalog'}, {id:'family_002'}, {id:'family_004'},
   ]}/>);
   const matches=await screen.findByRole('region',{name:'Existing profile shortlist category matches'});
   const names=within(matches).getAllByRole('button').map(x=>x.textContent);
   expect(names).toHaveLength(3);
   expect(within(matches).getByText(/No new product ranking has been calculated/i)).toBeTruthy();
   expect(within(matches).getByRole('button',{name:'Explore profile-shortlisted category Investment family 3'})).toBeTruthy();
   expect(within(matches).queryByRole('button',{name:'Explore profile-shortlisted category Investment family 4'})).toBeNull();
   expect(api.getQualifiedFamilyTopProducts).not.toHaveBeenCalled();
 });
 it('shows backend policy-ranked Top 3 category matches, not fabricated investable products',async()=>{
   render(<Explorer profileShortlist={[{id:'family_002'}]} profileRankedCategories={[
     {id:'family_003',rankScore:92.4,riskGroup:'MODERATE'},
     {id:'family_001',rankScore:88.1,riskGroup:'LOW'},
     {id:'family_002',rankScore:76.8,riskGroup:'LOW'},
   ]}/>);
   const matches=await screen.findByRole('region',{name:'Existing profile shortlist category matches'});
   expect(within(matches).getByText('Top 3 profile-matched investment categories')).toBeTruthy();
   expect(within(matches).getByText(/All 250 categories are screened/)).toBeTruthy();
   expect(within(matches).getByText(/95 newer entries require suitability evidence before ranking/)).toBeTruthy();
   expect(within(matches).getByText(/backend policy score 92\.4/)).toBeTruthy();
   const list=within(matches).getAllByRole('button');
   expect(list.map(x=>x.getAttribute('aria-label'))).toEqual([
     'Explore profile-shortlisted category Investment family 3',
     'Explore profile-shortlisted category Investment family 1',
     'Explore profile-shortlisted category Investment family 2',
   ]);
   expect(api.getQualifiedFamilyTopProducts).not.toHaveBeenCalled();
 });
 it('includes all 95 newer options in the same 250-category profile screening',async()=>{
   const profileAssessments=families.map((item,index)=>({
     id:item.id,
     profileAssessment:index>=155?'MISSING_SUITABILITY_EVIDENCE':
       index<3?'PROFILE_ELIGIBLE_CATEGORY':'PROFILE_EXCLUDED_CATEGORY',
     reasonCode:index>=155?'UNVERIFIED_CATEGORY_RISK_ELIGIBILITY_AND_TERMS':
       index<3?null:'RISK_EXCEEDS_FINAL_SUITABILITY',
     scoreAvailable:index<3,productQualified:false,
     source:index>=155?'EXTENDED_95_DISCOVERY':'EXISTING_155_MODEL',
   }));
   const profileCoverage={
     totalCategories:250,modelEvaluatedLegacyCategories:155,
     extensionCategoriesMissingSuitabilityEvidence:95,
     legacyProfileEligibleCount:3,legacyProfileExcludedCount:152,
     assessmentScope:'CATEGORY_SCREENING_NOT_PRODUCT_RECOMMENDATION',
   };
   render(<Explorer profileAssessments={profileAssessments} profileCoverage={profileCoverage}/>);
   await waitFor(()=>expect(screen.getByText('Investment family 250')).toBeTruthy());
   expect(screen.getByText(/Profile screening covers all 250 categories/)).toBeTruthy();
   expect(screen.getByText('250 matching options')).toBeTruthy();
   fireEvent.change(screen.getByLabelText('Filter by financial profile screening'),{
     target:{value:'MISSING_SUITABILITY_EVIDENCE'},
   });
   expect(screen.getByText('95 matching options')).toBeTruthy();
   expect(screen.queryByText('Investment family 1')).toBeNull();
   expect(screen.getByText('Investment family 250')).toBeTruthy();
   expect(screen.getAllByText(/risk and eligibility not yet established/)).toHaveLength(95);
   fireEvent.change(screen.getByLabelText('Filter by financial profile screening'),{
     target:{value:'PROFILE_ELIGIBLE_CATEGORY'},
   });
   expect(screen.getByText('3 matching options')).toBeTruthy();
   expect(screen.queryByText('Investment family 250')).toBeNull();
   expect(api.getQualifiedFamilyTopProducts).not.toHaveBeenCalled();
 });
 it('clears personalized comparisons when the directory closes',async()=>{
   api.getQualifiedFamilyTopProducts.mockResolvedValue(qualifiedResponse());
   render(<Explorer/>);
   await waitFor(()=>expect(screen.getByText('Investment family 1')).toBeTruthy());
   fireEvent.click(screen.getByRole('button',{name:'Check tailored top 3 for Investment family 1'}));
   await waitFor(()=>expect(screen.getByText('Verified bond 1')).toBeTruthy());
   fireEvent.click(screen.getByRole('button',{name:'Hide all 250 investment options'}));
   expect(screen.queryByText('Verified bond 1')).toBeNull();
   fireEvent.click(screen.getByRole('button',{name:'Explore all 250 investment options'}));
   await waitFor(()=>expect(screen.getByText('Investment family 250')).toBeTruthy());
   expect(screen.queryByText('Verified bond 1')).toBeNull();
 });
});
