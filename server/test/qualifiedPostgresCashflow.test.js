import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateSourceBoundContractCashflow} from '../services/qualifiedPostgresCashflow.js';

const asOf=new Date('2026-10-22T12:00:00Z');
const productId='government:india-post:post-office-td-1y';
const fact={
 id:713,source_id:'india-post-publication',observation_type:'PUBLISHED_RATE',
 data_class:'PUBLISHED_RATE',unit:'PERCENT_PER_ANNUM',value:'6.90000000',
 effective_from:'2026-10-01',effective_to:'2026-12-31',
 observed_at:'2026-10-01T06:30:00Z',
};
const terms=[
 {term_type:'TENURE_MONTHS',value:'12',unit:'MONTHS',
   contract_evidence_url:'https://www.indiapost.gov.in/banking-services/savings',
   contract_reviewed_at:new Date('2026-10-21T09:00:00Z')},
 {term_type:'COMPOUNDING_PERIODS_PER_YEAR',value:'4',unit:'PER_YEAR',
   contract_evidence_url:'https://www.indiapost.gov.in/banking-services/savings',
   contract_reviewed_at:new Date('2026-10-21T09:00:00Z')},
];
function harness({rows=[...terms],identity=true,taxClass='UNVERIFIED'}={}){
 const queries=[];
 const pool={query:async(sql,args)=>{
   queries.push({sql,args});
   if(sql.includes('FROM finance.products p'))return {rows:identity?[{
     id:productId,record_kind:'ACTUAL_PRODUCT',availability:'AVAILABLE',
     qualified_tax_class:taxClass,tax_class_evidence_url:taxClass==='ORDINARY_INTEREST'?'https://example.org/tax':null,
     tax_class_reviewed_at:taxClass==='ORDINARY_INTEREST'?asOf:null,
     endpoint_url:'https://www.indiapost.gov.in/banking-services/savings',
   }]:[]};
   if(sql.includes('FROM finance.product_terms t'))return {rows};
   throw new Error('Unexpected query: '+sql);
  }};
 const store={latestPublishableObservation:async(_id,kind)=>{
   assert.equal(_id,productId);assert.equal(kind,'PUBLISHED_RATE');
   return fact;
 }};
 return {pool,store,queries};
}
test('real-source published rate and exact reviewed contractual terms admit a bounded gross illustration',async()=>{
 const h=harness();
 const result=await calculateSourceBoundContractCashflow({
   ...h,productId,principal:1000,now:asOf,
 });
 assert.equal(result.status,'CALCULATED');
 assert.equal(result.dataClass,'QUALIFIED_PUBLISHED_RATE');
 assert.equal(result.officialObservationId,'713');
 assert.equal(result.postTaxProceeds,null);
 assert.ok(result.grossMaturityProceeds>=1000);
 assert.equal(result.notMarketPrice,true);
 assert.equal(result.sourceTermsReviewedIndependently,true);
 assert.ok(h.queries[1].sql.includes('contract_reviewed_at'));
 assert.equal(h.queries.length,2);
 assert.deepEqual(h.queries[0].args.slice(0,3),
   [productId,'india-post-publication','https://www.indiapost.gov.in/banking-services/savings']);
});
test('no source identity, no complete scheme terms, or unsafe tax class yields UNAVAILABLE',async()=>{
 for(const h of [
   harness({identity:false}),
   harness({rows:terms.slice(0,1)}),
   harness({rows:terms.map((term,i)=>i===0?{...term,contract_reviewed_at:null}:term)}),
   harness({rows:terms.map((term,i)=>i===1?{...term,contract_evidence_url:'https://example.org/unverified'}:term)}),
   harness({rows:terms.map((term,i)=>i===0?{...term,contract_reviewed_at:new Date('2099-01-01')}:term)}),
   harness({rows:[...terms,{...terms[0]}]}),
   harness({rows:[...terms.slice(0,1),{...terms[1],value:'2'}]}),
 ]){
   const result=await calculateSourceBoundContractCashflow({
      ...h,productId,principal:1000,now:asOf,
   });
   assert.equal(result.status,'UNAVAILABLE',result.reasonCode);
   assert.equal(result.postTaxProceeds,null);
 }
 const h=harness();
 const result=await calculateSourceBoundContractCashflow({
   ...h,productId,principal:1000,now:asOf,
   taxEventContext:{eventDates:{},taxContexts:{}},
 });
 assert.equal(result.status,'UNAVAILABLE');
 assert.equal(result.reasonCode,'PRODUCT_TAX_CLASS_NOT_VERIFIED');
});
test('market quotes and unsupported instrument families never masquerade as contractual maturity values',async()=>{
 const h=harness();
 const result=await calculateSourceBoundContractCashflow({
   ...h,productId:'mf:amfi:12345',principal:1000,now:asOf,
 });
 assert.equal(result.status,'UNAVAILABLE');
 assert.equal(result.grossMaturityProceeds,null);
 assert.equal(h.queries.length,0);
});
