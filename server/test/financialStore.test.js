import test from 'node:test';
import assert from 'node:assert/strict';
import {createFinancialStore} from '../postgres/financialStore.js';
test('SQL financial store constrains catalog pagination and never interpolates untrusted filters',async()=>{
 const calls=[];
 const pool={query:async(sql,args)=>{calls.push({sql,args});return{rows:[
  {id:'alpha',name:'Alpha'},{id:'beta',name:'Beta'},{id:'gamma',name:'Gamma'},
 ];}},connect:async()=>({query:async()=>({rows:[]}),release(){}})};
 const store=createFinancialStore(pool);
 const result=await store.browse({category:'safe-cat',subcategory:'sub-cat',cursor:'start',limit:2});
 assert.deepEqual(result.items.map(p=>p.id),['alpha','beta']);
 assert.equal(result.nextCursor,'beta');
 assert.deepEqual(calls[0].args,['safe-cat','sub-cat','start',3]);
 assert.ok(calls[0].sql.includes('ORDER BY p.id'));
 await assert.rejects(store.browse({category:'bad\nvalue'}),/Invalid catalog filter/);
 await assert.rejects(store.browse({limit:101}),/Invalid page size/);
});
test('unqualified public quote is never returned as a market observation',async()=>{
 let sql=null;
 const pool={query:async(query)=>{sql=query;return{rows:[]};},connect:async()=>({release(){}})};
 const fact=await createFinancialStore(pool).latestPublishableObservation('stock:abc123','PRICE');
 assert.equal(fact,null);
 for(const condition of ['storage_allowed','derivation_allowed','public_display_allowed','commercial_use_allowed','redistribution_allowed','revoked_at IS NULL','retain_until']){
  assert.ok(sql.includes(condition),condition);
 }
});
test('market writes refuse invalid values before contacting the database',async()=>{
 const pool={query:async()=>{throw new Error('QUERY_SHOULD_NOT_RUN');},connect:async()=>{throw new Error('CONNECTION_SHOULD_NOT_OPEN');}};
 const store=createFinancialStore(pool);
 await assert.rejects(store.appendObservation({productId:'stock:abc123',kind:'PRICE',dataClass:'LIVE',
  sourceId:'provider',value:'NaN',observedAt:'2026-01-01',fetchedAt:'2026-01-02'}),/exact non-negative decimal/);
});
