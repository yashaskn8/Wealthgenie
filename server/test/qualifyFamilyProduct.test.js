import test from 'node:test';
import assert from 'node:assert/strict';
import { qualifyProductForFamily, suspendProductForFamily } from '../postgres/qualifyFamilyProduct.js';

const verified={
 familyId:'family_deposit',productId:'bank:deposit:one',sourceId:'bank-source',
 observationType:'PUBLISHED_RATE',evidenceUrl:'https://bank.example/offer',
 termsEvidenceUrl:'https://bank.example/terms',riskEvidenceUrl:'https://bank.example/risk',
 reviewedBy:'auditor-001',reviewedAt:'2026-10-20T09:00:00Z',
 validUntil:'2026-11-20T09:00:00Z',riskLevel:1,minInvestmentInr:1000,
 minHorizonYears:1,lockInMonths:12,annualFeeBps:0,retailAccess:true,
 reviewNote:'Independently reviewed current bank deposit offer terms.',
};
const now=new Date('2026-10-22T12:00:00Z');
function fake({verifiedSource=true,existing=[]}={}){
 const calls=[];
 const client={
  query:async (sql,args=[])=>{
   calls.push({sql,args});
   if(sql.includes('JOIN finance.product_external_ids'))return {rows:verifiedSource?[{category:'Bank Deposits'}]:[]};
   if(sql.includes('SELECT status FROM finance.family_product_qualifications'))return {rows:existing};
   if(sql.includes('RETURNING product_id'))return {rows:[{product_id:verified.productId}]};
   return {rows:[],rowCount:1};
  },release:()=>calls.push({sql:'RELEASE'}),
 };
 return {pool:{connect:async()=>client},calls};
}
test('only an evidence-complete source-qualified actual product may activate',async()=>{
 const h=fake();
 const output=await qualifyProductForFamily(h.pool,verified,{now});
 assert.equal(output.status,'ACTIVE');
 assert.ok(h.calls.some(x=>x.sql.includes('INSERT INTO finance.family_product_qualifications')));
 assert.ok(h.calls.some(x=>x.sql.includes('UPDATE finance.products SET recommendation_eligible=true')));
 assert.ok(h.calls.some(x=>x.sql==='COMMIT'));
});
test('missing or invented financial evidence rejects before SQL transaction',async()=>{
 const h=fake();
 for(const v of [
  {...verified,evidenceUrl:'http://not-https.example'},
  {...verified,riskLevel:8},
  {...verified,reviewedAt:'2099-01-01T00:00:00Z'},
  {...verified,validUntil:'2026-10-21T00:00:00Z'},
  {...verified,reviewNote:'too short'},
  {...verified,annualFeeBps:10001},
  {...verified,productId:verified.familyId},
 ]){
  await assert.rejects(qualifyProductForFamily(h.pool,v,{now}),/FAMILY_REVIEW_INVALID/);
 }
 assert.equal(h.calls.length,0);
});
test('no real source licence or wrong identity causes rollback',async()=>{
 const h=fake({verifiedSource:false});
 await assert.rejects(qualifyProductForFamily(h.pool,verified,{now}),/ACTUAL_PRODUCT_OR_RIGHTS_NOT_QUALIFIED/);
 assert.ok(h.calls.some(x=>x.sql==='ROLLBACK'));
 assert.ok(!h.calls.some(x=>x.sql.includes('SET recommendation_eligible=true')));
});
test('active review cannot be overwritten without explicit audited suspension',async()=>{
 const h=fake({existing:[{status:'ACTIVE'}]});
 await assert.rejects(qualifyProductForFamily(h.pool,verified,{now}),
  /ACTIVE_FAMILY_REVIEW_REQUIRES_EXPLICIT_SUSPENSION/);
 assert.ok(h.calls.some(x=>x.sql==='ROLLBACK'));
});
test('suspension is an explicit audited state transition',async()=>{
 const h=fake();
 const result=await suspendProductForFamily(h.pool,{
  familyId:verified.familyId,productId:verified.productId,
  reviewedBy:'auditor-001',reviewNote:'Provider document expired and price rights revoked.',
 });
 assert.equal(result.status,'SUSPENDED');
 assert.ok(h.calls.some(x=>x.sql.includes("status='SUSPENDED'")));
 assert.ok(h.calls.some(x=>x.sql==='COMMIT'));
});
