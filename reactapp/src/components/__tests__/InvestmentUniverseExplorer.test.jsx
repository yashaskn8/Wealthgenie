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
    {issuerName:'State Bank of India',officialProductUrl:'https://sbi.bank.in/example',reviewedOn:'2026-10-28',evidenceStatus:'PUBLIC_ISSUER_LINK_ONLY_NOT_LICENSED_PRODUCT_DATA'},
    {issuerName:'HDFC Bank Limited',officialProductUrl:'https://www.hdfc.bank.in/example',reviewedOn:'2026-10-28',evidenceStatus:'PUBLIC_ISSUER_LINK_ONLY_NOT_LICENSED_PRODUCT_DATA'},
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
 it('rejects mismatched profiles, duplicated facts and missing or stale evidence',async()=>{
   const changes=[
     x=>{x.source.profileId='fedcba9876543210fedcba98';},
     x=>{x.familyId='family_002';},
     x=>{x.products[1].familyId='family_002';},
     x=>{x.products[1].marketFact.observationId=x.products[0].marketFact.observationId;},
     x=>{delete x.products[0].marketFact.asOf;},
     x=>{x.products[0].marketFact.asOf='not-a-date';},
     x=>{x.products[0].marketFact.asOf=new Date(Date.now()+30*86400000).toISOString();},
     x=>{x.products[0].marketFact.asOf=new Date(Date.now()-30*86400000).toISOString();},
     x=>{x.products[0].marketFact.value=0;},
     x=>{x.products[0].marketFact.dataClass='PUBLISHED_RATE';},
     x=>{delete x.products[0].evidence.terms;},
     x=>{delete x.products[0].evidence.reviewedAt;},
     x=>{x.products[0].evidence.expiresAt=new Date(Date.now()-86400000).toISOString();},
     x=>{x.products[0].verifiedTaxClass='UNVERIFIED';},
     x=>{x.products[1].id=x.products[0].id;},
   ];
   for (const change of changes) {
     const response=qualifiedResponse();
     change(response);
     api.getQualifiedFamilyTopProducts.mockResolvedValueOnce(response);
     const view=render(<Explorer/>);
     await waitFor(()=>expect(screen.getByText('Investment family 1')).toBeTruthy());
     fireEvent.click(screen.getByRole('button',{name:'Check tailored top 3 for Investment family 1'}));
     await waitFor(()=>expect(screen.getByText(/CURRENT_PROFILE_OR_QUALIFIED_COMPARISON_UNAVAILABLE/)).toBeTruthy());
     expect(screen.queryByText('Verified bond 1')).toBeNull();
     view.unmount();
   }
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
   expect(within(matches).getByText(/not a ranking of all 250 categories/i)).toBeTruthy();
   expect(within(matches).getByRole('button',{name:'Explore profile-shortlisted category Investment family 3'})).toBeTruthy();
   expect(within(matches).queryByRole('button',{name:'Explore profile-shortlisted category Investment family 4'})).toBeNull();
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
