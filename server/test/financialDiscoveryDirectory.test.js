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
 assert.equal(rd.productData.currentInterestRate,null);
 assert.equal(rd.dataRights,'NOT_VERIFIED');
 assert.ok(response.items.filter(x=>x.id!==rd.id).every(x=>x.publicIssuerReferences.length===0));
 rd.publicIssuerReferences[0].issuerName='tampered';
 assert.equal(listFinancialDiscoveryDirectory().items.find(x=>x.id===rd.id)
   .publicIssuerReferences[0].issuerName,'State Bank of India');
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
