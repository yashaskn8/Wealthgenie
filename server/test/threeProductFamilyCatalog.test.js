import test from 'node:test';
import assert from 'node:assert/strict';
import {listFamiliesWithThreeSourceQualifiedProducts} from '../services/threeProductFamilyCatalog.js';
test('two independently sourced current products allow family visibility',async()=>{
 const at=new Date('2026-10-22T12:00:00Z');
 let sql=null,args=null;
 const out=await listFamiliesWithThreeSourceQualifiedProducts({query:async(q,a)=>{
  sql=q;args=a;return {rows:[{family_id:'low-vol',product_count:2}]};
 }},at);
 assert.equal(out.count,1);
 assert.deepEqual(out.familyIds,['low-vol']);
 assert.deepEqual(args,[at]);
 assert.equal(out.minimumProducts,2);
 assert.equal(out.maxResults,3);
 for(const s of ["HAVING count(DISTINCT p.source_identity)>=2",
  'o.retain_until>$1','r.redistribution_allowed',"p.record_kind='ACTUAL_PRODUCT'",
  'q.requires_accreditation=false','ext.source_instrument_id=o.source_instrument_id']){
  assert.ok(sql.includes(s),s);
 }
});
test('no qualified product families returns empty without fabricating options',async()=>{
 const out=await listFamiliesWithThreeSourceQualifiedProducts({query:async()=>({rows:[]})});
 assert.deepEqual(out.familyIds,[]);
 assert.equal(out.count,0);
});
test('incomplete, malformed and duplicate families fail closed',async()=>{
 for(const rows of [
  [{family_id:'less',product_count:1}],
  [{family_id:'same',product_count:3},{family_id:'same',product_count:3}],
  [{family_id:'bad;',product_count:3}],
  [{family_id:'valid',product_count:'3'}],
 ]){
  await assert.rejects(listFamiliesWithThreeSourceQualifiedProducts({query:async()=>({rows})}),
   /QUALIFIED_FAMILY_RESULT_INVALID/);
 }
});
