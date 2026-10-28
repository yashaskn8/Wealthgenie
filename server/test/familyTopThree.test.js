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
 category_id:'bank_deposits',verification_scope:'VERIFIED_ACTUAL_PRODUCT',
 source_identity:'issuer:'+id,recommendation_eligible:true,qualified_tax_class:'ORDINARY_INTEREST',
 tax_class_evidence_url:'https://issuer.example/tax',
 tax_class_reviewed_at:'2026-10-01T00:00:00Z',right_source_id:'verified-bank',
 ...overrides,
});
function harness(rows=[],facts={},reviewOverrides={}){
 const calls=[];
 const pool={query:async (sql,args)=>{
  calls.push({sql,args});
  if(sql.includes("p.record_kind='ARCHETYPE'"))return {rows:[{id:familyId,name:'Bank Recurring Deposit',category_id:'bank_deposits',category:'Bank Deposits'}]};
  if(sql.startsWith('SELECT q.review_version,')){
   const reviewed=rows.find(row=>row.product_id===args[1]
     && row.source_id===args[2] && row.observation_type===args[3]
     && row.review_version===args[4]);
   const override=reviewOverrides[args[1]];
   return {rows:reviewed && reviewOverrides[args[1]]!==false
     ? [{...reviewed,...(override && typeof override==='object'?override:{})}]:[]};
  }
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
 assert.equal(h.calls.filter(c=>c.observationFor).length,7);
});

test('ranking is deterministic and uses risk, fees, lock-in and ID without a pseudo match score',async()=>{
 const h=harness([
  product('risk-two',{risk_level:2,annual_fee_bps:0}),
  product('higher-fee',{risk_level:1,annual_fee_bps:80}),
  product('longer-lock',{risk_level:1,annual_fee_bps:20,lock_in_months:6}),
  product('a-tie',{risk_level:1,annual_fee_bps:20,lock_in_months:0}),
  product('b-tie',{risk_level:1,annual_fee_bps:20,lock_in_months:0}),
 ]);
 const result=await compare(h);
 assert.equal(result.status,'AVAILABLE');
 assert.equal(result.rankingPolicy,'LOWER_VERIFIED_RISK_THEN_FEES_THEN_LOCK_IN_THEN_ID');
 assert.deepEqual(result.products.map(item=>item.id),['a-tie','b-tie','longer-lock']);
 assert.ok(result.products.every(item=>!Object.hasOwn(item,'matchScore')));
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
 assert.equal(r.status,'INSUFFICIENT_VERIFIED_PRODUCTS');
 assert.equal(r.products.length,0);
 assert.ok(r.exclusionCounts.DATA_RIGHTS_REVOKED_OR_EXPIRED>0);
 assert.ok(r.exclusionCounts.VERIFIED_MARKET_FACT_UNAVAILABLE>0);
 assert.equal(h.calls.filter(c=>c.observationFor).length,1);
});

test('changed product category, verification scope or tax evidence cannot reuse an old qualification',async()=>{
 const h=harness([
  product('wrong-category',{category_id:'mutual_funds'}),
  product('unverified-product',{verification_scope:'DISCOVERY_ONLY'}),
  product('missing-tax-source',{tax_class_evidence_url:null}),
  product('insecure-tax-source',{tax_class_evidence_url:'http://issuer.example/tax'}),
 ]);
 const result=await compare(h);
 assert.equal(result.status,'INSUFFICIENT_VERIFIED_PRODUCTS');
 assert.deepEqual(result.products,[]);
 assert.equal(result.exclusionCounts.PRODUCT_NOT_FINANCIALLY_QUALIFIED,4);
 assert.equal(h.calls.filter(call=>call.observationFor).length,0);
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
 await assert.rejects(compare(h,{profileInput:{}}),{code:'RECOMMENDATION_PROFILE_INVALID'});
 assert.equal(h.calls.length,0);
});
test('a large qualification set is never truncated into a misleading top three',async()=>{
 const h=harness(Array.from({length:501},(_,i)=>product('product'+i)));
 const r=await compare(h);
 assert.equal(r.reasonCode,'FAMILY_QUALIFICATION_SET_TOO_LARGE');
 assert.deepEqual(r.products,[]);
});

test('revocation between preliminary screening and final publication drops the winner',async()=>{
 const rows=[product('p1'),product('p2')];
 const h=harness(rows);
 let attempts=0;
 h.store.latestPublishableObservation=async (id,type)=>{
  attempts+=1;
  if(attempts===3)return null;
  return {id,source_id:'verified-bank',value:'6.5',unit:'PCT_PER_ANNUM',
   data_class:'PUBLISHED_RATE',observed_at:now};
 };
 const r=await compare(h);
 assert.equal(r.status,'INSUFFICIENT_VERIFIED_PRODUCTS');
 assert.equal(r.verifiedProductCount,1);
 assert.deepEqual(r.products,[]);
 assert.equal(r.exclusionCounts.MARKET_SOURCE_CHANGED_DURING_COMPARISON,1);
});

test('suspending a reviewed product during comparison publishes only two still-approved products',async()=>{
 const h=harness([product('p1'),product('p2'),product('p3')],{}, {p1:false});
 const result=await compare(h);
 assert.equal(result.status,'AVAILABLE');
 assert.deepEqual(result.products.map(p=>p.id),['p2','p3']);
 assert.equal(result.verifiedProductCount,2);
 assert.equal(result.exclusionCounts.PRODUCT_REVIEW_CHANGED_DURING_COMPARISON,1);
});

test('a product restricted after initial screening cannot retain an approved comparison card',async()=>{
 const h=harness([product('p1'),product('p2'),product('p3')],{},
   {p1:{availability:'RESTRICTED'}});
 const result=await compare(h);
 assert.equal(result.status,'AVAILABLE');
 assert.deepEqual(result.products.map(p=>p.id),['p2','p3']);
 assert.equal(result.verifiedProductCount,2);
 assert.equal(result.exclusionCounts.PRODUCT_REVIEW_CHANGED_DURING_COMPARISON,1);
});

test('changed risk, fee or reviewed terms cannot reuse an earlier top-three qualification',async()=>{
 for(const change of [
  {risk_level:5},
  {annual_fee_bps:90},
  {terms_evidence_url:'https://issuer.example/new-terms'},
  {valid_until:'2026-12-01T00:00:00Z'},
 ]){
  const h=harness([product('p1'),product('p2'),product('p3')],{}, {p1:change});
  const result=await compare(h);
  assert.equal(result.status,'AVAILABLE');
  assert.deepEqual(result.products.map(p=>p.id),['p2','p3']);
  assert.equal(result.exclusionCounts.PRODUCT_REVIEW_CHANGED_DURING_COMPARISON,1);
 }
});

test('a changed observation unit or classification cannot reuse the earlier market fact',async()=>{
 const h=harness([product('p1'),product('p2'),product('p3')]);
 let reads=0;
 h.store.latestPublishableObservation=async id=>{
  reads+=1;
  return {id,source_id:'verified-bank',value:'6.5',
    unit:reads===4?'UNVERIFIED_UNIT':'PCT_PER_ANNUM',
    data_class:'PUBLISHED_RATE',observed_at:now};
 };
 const result=await compare(h);
 assert.equal(result.status,'AVAILABLE');
 assert.deepEqual(result.products.map(p=>p.id),['p2','p3']);
 assert.equal(result.exclusionCounts.MARKET_SOURCE_CHANGED_DURING_COMPARISON,1);
});

test('the comparison fetches only the reviewed provider identity, not a newer unrelated quote',async()=>{
 const h=harness([product('one',{source_id:'verified-bank'})]);
 const invoked=[];
 h.store.latestPublishableObservation=async (id,kind,at,sourceId)=>{
  invoked.push({id,kind,sourceId});
  assert.equal(sourceId,'verified-bank');
  return {id:71,source_id:sourceId,value:'7.10',unit:'PCT_PER_ANNUM',
    observed_at:at,data_class:'PUBLISHED_RATE'};
 };
 const r=await compare(h);
 assert.equal(r.status,'INSUFFICIENT_VERIFIED_PRODUCTS');
 assert.deepEqual(r.products,[]);
 assert.equal(invoked.length,2);
 assert.deepEqual(invoked.map(x=>x.sourceId),['verified-bank','verified-bank']);
});

test('zero or one qualified product never produces a comparison',async()=>{
 for(const count of [0,1]){
  const h=harness(Array.from({length:count},(_,i)=>product('qualified-'+i)));
  const result=await compare(h);
  assert.equal(result.status,'INSUFFICIENT_VERIFIED_PRODUCTS');
  assert.equal(result.reasonCode,'FEWER_THAN_TWO_SUITABLE_VERIFIED_PRODUCTS');
  assert.equal(result.requiredProductCount,2);
  assert.equal(result.verifiedProductCount,count);
  assert.deepEqual(result.products,[]);
 }
});

test('two distinct verified identities can be compared without padding a duplicate third',async()=>{
 const h=harness([
  product('p1',{source_identity:'ISIN:ONE'}),
  product('p2',{source_identity:'ISIN:ONE'}),
  product('p3',{source_identity:'ISIN:TWO'}),
 ]);
 const result=await compare(h);
 assert.equal(result.status,'AVAILABLE');
 assert.equal(result.verifiedProductCount,2);
 assert.deepEqual(result.products.map(p=>p.id),['p1','p3']);
 assert.equal(result.exclusionCounts.PRODUCT_IDENTITY_MISSING_OR_DUPLICATE,1);
});
