import test from 'node:test';
import assert from 'node:assert/strict';
import {registerQualifiedActualProduct} from '../postgres/registerActualProduct.js';

const input={
 productId:'equity:isin:IN1234567890',productName:'Verified Example Issuer',
 categoryId:'equity-catalog',subcategoryId:null,sourceId:'registered-provider',
 sourceInstrumentId:'NSE_EQ|EXAMPLE',evidenceUrl:'https://example.com/issuer',
 reviewedAt:new Date('2026-10-20T12:00:00Z'),
};
function fixture({allowed=true,category=true,previous=[]}={}){
 const calls=[];
 const client={
  query:async(sql,args=[])=>{
   calls.push({sql,args});
   if(sql.includes('FROM finance.provider_rights'))return {rows:allowed?[{source_id:input.sourceId}]:[]};
   if(sql.includes('FROM finance.categories'))return {rows:category?[{id:input.categoryId}]:[]};
   if(sql.includes('FROM finance.products WHERE id='))return {rows:previous};
   return {rows:[],rowCount:1};
  },
  release:()=>{calls.push({sql:'RELEASE'})},
 };
 return {pool:{connect:async()=>client},calls};
}
test('qualified product registry inserts real source IDs but never auto-approves advice or tax class',async()=>{
 const h=fixture();
 const result=await registerQualifiedActualProduct(h.pool,input);
 assert.deepEqual(result,{
  status:'REGISTERED',productId:input.productId,
  recommendationEligible:false,taxClass:'UNVERIFIED',
 });
 const rightsSql=h.calls.find(c=>c.sql.includes('FROM finance.provider_rights'))?.sql;
 assert.match(rightsSql,/verification_state='VERIFIED'/);
 assert.match(rightsSql,/verification_expires_at>now\(\)/);
 assert.ok(h.calls.some(c=>c.sql.includes('INSERT INTO finance.products')));
 assert.ok(h.calls.some(c=>c.sql.includes('INSERT INTO finance.product_external_ids')));
 assert.ok(h.calls.some(c=>c.sql==='COMMIT'));
 assert.equal(h.calls.at(-1).sql,'RELEASE');
});
test('registration refuses source without independently qualified storage/derivation/display rights',async()=>{
 const h=fixture({allowed:false});
 await assert.rejects(registerQualifiedActualProduct(h.pool,input),
   /ACTUAL_PRODUCT_SOURCE_RIGHTS_UNQUALIFIED/);
 assert.ok(h.calls.some(c=>c.sql==='ROLLBACK'));
 assert.ok(!h.calls.some(c=>c.sql.includes('INSERT INTO finance.products')));
});
test('registration rejects category mismatch and existing ID hijack',async()=>{
 const h1=fixture({category:false});
 await assert.rejects(registerQualifiedActualProduct(h1.pool,input),
   /ACTUAL_PRODUCT_CATEGORY_NOT_VERIFIED/);
 const h2=fixture({previous:[{
  id:input.productId,record_kind:'ACTUAL_PRODUCT',name:'Different issuer',
  category_id:input.categoryId,subcategory_id:null,
  source_identity:'unrelated',verification_scope:'UNVERIFIED',
 } ]});
 await assert.rejects(registerQualifiedActualProduct(h2.pool,input),
   /ACTUAL_PRODUCT_IDENTITY_CONFLICT/);
 assert.ok(h2.calls.some(c=>c.sql==='ROLLBACK'));
});
test('invalid source identity, issuer evidence or future review cannot enter the SQL transaction',async()=>{
 const h=fixture();
 for(const bad of [
  {...input,productId:'id; DROP TABLE'},
  {...input,evidenceUrl:'http://example.com'},
  {...input,evidenceUrl:'https://user:password@example.com'},
  {...input,reviewedAt:new Date('2099-01-01')},
  {...input,sourceInstrumentId:''},
 ]){
  await assert.rejects(registerQualifiedActualProduct(h.pool,bad));
 }
 assert.equal(h.calls.length,0);
});
