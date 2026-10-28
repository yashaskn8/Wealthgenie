import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTopThreeProductEvidenceQueue,REVIEW_QUEUE_STATUS,
  topThreeEvidenceQueueCsv } from '../scripts/generateFinancialTopThreeEvidenceQueue.js';
test('every one of the exact 250 families gets three unapproved evidence slots',()=>{
 const rows=buildTopThreeProductEvidenceQueue();
 const ids=new Set(rows.map(x=>x.familyId));
 assert.equal(ids.size,250);
 assert.equal(rows.length,750);
 for(const id of ids){
  assert.deepEqual(rows.filter(x=>x.familyId===id).map(x=>x.slot),[1,2,3]);
 }
 assert.ok(rows.every(x=>x.status===REVIEW_QUEUE_STATUS));
 assert.ok(rows.every(x=>x.actualProductId===''&&x.providerApprovalReference===''));
 assert.ok(rows.every(x=>!Object.hasOwn(x,'dataUseRightsEvidenceUrl')));
});
test('review queue never passes a category link off as issuer approval',()=>{
 const rows=buildTopThreeProductEvidenceQueue();
 assert.ok(rows.some(x=>x.categoryEvidenceUrl));
 assert.ok(rows.some(x=>!x.categoryEvidenceUrl));
 assert.ok(rows.every(x=>!x.issuerOfficialDocumentUrl));
 const csv=topThreeEvidenceQueueCsv(rows);
 assert.equal(csv.split('\n').length,752);
 assert.match(csv.split('\n')[0],/providerApprovalReference/);
 assert.doesNotMatch(csv.split('\n')[0],/dataUseRightsEvidenceUrl/);
});
test('duplicate or missing family data cannot inflate the queue',()=>{
 const base=buildTopThreeProductEvidenceQueue();
 const families=[...new Map(base.map(x=>[x.familyId,{id:x.familyId,name:x.familyName,category:x.category}])).values()];
 assert.equal(families.length,250);
 const legacy=families.slice(0,155),extensions=families.slice(155).map(x=>({...x,recordKind:'ARCHETYPE'}));
 extensions[0].id=legacy[0].id;
 assert.throws(()=>buildTopThreeProductEvidenceQueue({legacy,extensions}),
  /FINANCIAL_FAMILY_INVENTORY_DUPLICATE_OR_INVALID/);
});
