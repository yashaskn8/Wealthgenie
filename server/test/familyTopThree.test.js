import test from 'node:test';
import assert from 'node:assert/strict';
import { compareQualifiedFamilyProducts } from '../services/familyTopThree.js';
import { canonicalProfile } from './helpers/canonicalProfile.js';

const familyId='catalog_2026_bank_rd';
const now=new Date('2026-10-22T12:00:00Z');
const product=(id='fd:bank:one',overrides={})=>({
 family_id:familyId,product_id:id,source_id:'verified-bank',observation_type:'PUBLISHED_RATE',
 status:'ACTIVE',reviewed_at:'2026-10-01T00:00:00Z',valid_until:'2026-11-20T00:00:00Z',
 risk_level:1,min_investment_inr:'1000.00',min_horizon_years:1,lock_in_months:0,
 annual_fee_bps:0,min_age:18,max_age:120,retail_access:true,
 requires_demat:false,requires_accreditation:false,requires_nps_account:false,
 requires_child_eligibility:false,evidence_url:'https://issuer.example/offer',
 terms_evidence_url:'https://issuer.example/terms',
 risk_evidence_url:'https://issuer.example/risk',
 review_version:1,product_name:id,availability:'AVAILABLE',record_kind:'ACTUAL_PRODUCT',
 recommendation_eligible:true,qualified_tax_class:'ORDINARY_INTEREST',
 tax_class_reviewed_at:'2026-10-01T00:00:00Z',right_source_id:'verified-bank',
 ...overrides,
});
function harness(rows=[],facts={}){
 const calls=[];
 const pool={query:async (sql,args)=>{
  calls.push({sql,args});
  if(sql.includes("p.record_kind='ARCHETYPE'"))return {rows:[{id:familyId,name:'Bank Recurring Deposit',category:'Bank Deposits'}]};
  if(sql.includes('family_product_qualifications'))return {rows};
  throw Error('UNKNOWN_SQL');
 }};
 const store={latestPublishableObservation:async (productId,kind)=>{
  calls.push({observationFor:productId,kind});
  return Object.hasOwn(facts,productId)?facts[productId]:{
   id:productId,source_id:'verified-bank',value:'6.500',unit:'PCT_PER_ANNUM',
   data_class:'PUBLISHED_RATE',observed_at:'2026-10-22T09:30:00Z'};
 }};
 return {pool,store,calls};
}
const compare=(h,options={})=>compareQualifiedFamilyProducts({
 pool:h.pool,store:h.store,profileInput:canonicalProfile(),familyId,now,
 adviceAuthorized:true,...options,
});
test('no verified advice authority means no query of financial products',async()=>{
 const h=harness([product()]);
 const r=await compare(h,{adviceAuthorized:false});
 assert.equal(r.reasonCode,'PERSONALIZED_ADVICE_AUTHORIZATION_REQUIRED');
 assert.deepEqual(r.products,[]);
 assert.equal(h.calls.length,1);
});
test('top three returns at most three distinct suitable, publishable products',async()=>{
 const h=harness([
  product('p1',{annual_fee_bps:100}),
  product('p2',{annual_fee_bps:50}),
  product('p3',{annual_fee_bps:75}),
  product('p4',{annual_fee_bps:0}),
 ]);
 const r=await compare(h);
 assert.equal(r.status,'AVAILABLE');
 assert.equal(r.qualifyingCount,4);
 assert.deepEqual(r.products.map(p=>p.id),['p4','p2','p3']);
 assert.ok(r.products.every(p=>p.verifiedTaxClass==='ORDINARY_INTEREST'));
 assert.equal(h.calls.filter(c=>c.observationFor).length,4);
});
test('missing fact, revoked rights, invalid tax, restricted eligibility and stale review fail closed',async()=>{
 const h=harness([
  product('bad-rights',{right_source_id:null}),
  product('bad-tax',{qualified_tax_class:'UNVERIFIED'}),
  product('bad-accreditation',{requires_accreditation:true}),
  product('bad-terms',{valid_until:'2026-10-01T00:00:00Z'}),
  product('bad-risk',{risk_level:5}),
  product('bad-ticket',{min_investment_inr:'9999999'}),
  product('bad-demat',{requires_demat:true}),
  product('bad-fact'),
 ],{'bad-fact':null});
 const r=await compare(h);
 assert.equal(r.status,'NO_QUALIFIED_PRODUCTS');
 assert.equal(r.products.length,0);
 assert.ok(r.exclusionCounts.DATA_RIGHTS_REVOKED_OR_EXPIRED>0);
 assert.ok(r.exclusionCounts.VERIFIED_MARKET_FACT_UNAVAILABLE>0);
 assert.equal(h.calls.filter(c=>c.observationFor).length,1);
});
test('source mismatch and non-positive market price cannot enter top three',async()=>{
 const h=harness([
  product('wrong-provider',{observation_type:'NAV'}),
  product('zero-price',{observation_type:'PRICE'}),
 ],{
  'wrong-provider':{id:1,source_id:'unapproved-source',value:'40',unit:'INR',data_class:'END_OF_DAY',observed_at:now},
  'zero-price':{id:2,source_id:'verified-bank',value:'0',unit:'INR',data_class:'LIVE',observed_at:now},
 });
 const r=await compare(h);
 assert.deepEqual(r.products,[]);
 assert.equal(r.exclusionCounts.VERIFIED_MARKET_FACT_UNAVAILABLE,1);
 assert.equal(r.exclusionCounts.VERIFIED_MARKET_FACT_INVALID,1);
});
test('profile capacity, horizon and age are firm investment boundaries',async()=>{
 const h=harness([
  product('locked',{lock_in_months:240,min_horizon_years:20}),
  product('child',{min_age:50,max_age:60}),
  product('expensive',{min_investment_inr:'90000'}),
 ]);
 const r=await compare(h);
 assert.equal(r.qualifyingCount,0);
 assert.equal(r.exclusionCounts.INVESTMENT_HORIZON_TOO_SHORT,1);
 assert.equal(r.exclusionCounts.INVESTOR_AGE_OUTSIDE_PRODUCT,1);
 assert.equal(r.exclusionCounts.MINIMUM_INVESTMENT_NOT_MET,1);
});
test('invalid family IDs and invalid profiles are rejected before serving products',async()=>{
 const h=harness();
 await assert.rejects(compare(h,{familyId:'family;DROP'}),/FAMILY_ID_INVALID/);
 await assert.rejects(compare(h,{profileInput:{}}),/RECOMMENDATION_PROFILE_INVALID/);
 assert.equal(h.calls.length,0);
});
test('a large qualification set is never truncated into a misleading top three',async()=>{
 const h=harness(Array.from({length:501},(_,i)=>product('product'+i)));
 const r=await compare(h);
 assert.equal(r.reasonCode,'FAMILY_QUALIFICATION_SET_TOO_LARGE');
 assert.deepEqual(r.products,[]);
});
