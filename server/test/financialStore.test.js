import test from 'node:test';
import assert from 'node:assert/strict';
import {createFinancialStore} from '../postgres/financialStore.js';
test('SQL financial store constrains catalog pagination and never interpolates untrusted filters',async()=>{
 const calls=[];
 const pool={query:async(sql,args)=>{calls.push({sql,args});return{rows:[
  {id:'alpha',name:'Alpha'},{id:'beta',name:'Beta'},{id:'gamma',name:'Gamma'},
 ]};},connect:async()=>({query:async()=>({rows:[]}),release(){}})};
 const store=createFinancialStore(pool);
 const result=await store.browse({category:'safe-cat',subcategory:'sub-cat',cursor:'start',limit:2});
 assert.deepEqual(result.items.map(p=>p.id),['alpha','beta']);
 assert.equal(result.nextCursor,'beta');
 assert.deepEqual(calls[0].args,['safe-cat','sub-cat','start',3]);
 assert.ok(calls[0].sql.includes('ORDER BY p.id'));
 assert.ok(calls[0].sql.includes("p.record_kind='ARCHETYPE'"), 'actual products are not discovery families');
 await assert.rejects(store.browse({category:'bad\nvalue'}),/Invalid catalog filter/);
 await assert.rejects(store.browse({limit:101}),/Invalid page size/);
});
test('unqualified public quote is never returned as a market observation',async()=>{
 let sql=null;
 const pool={query:async(query)=>{sql=query;return{rows:[]};},connect:async()=>({release(){}})};
 const fact=await createFinancialStore(pool).latestPublishableObservation('stock:abc123','PRICE');
 assert.equal(fact,null);
 for(const condition of ['storage_allowed','derivation_allowed','public_display_allowed','commercial_use_allowed','redistribution_allowed','revoked_at IS NULL','retain_until','r.retention_seconds>0','r.reviewed_at<=$3','ext.source_instrument_id=o.source_instrument_id']){
  assert.ok(sql.includes(condition),condition);
 }
});
test('market writes refuse invalid values before contacting the database',async()=>{
 const pool={query:async()=>{throw new Error('QUERY_SHOULD_NOT_RUN');},connect:async()=>{throw new Error('CONNECTION_SHOULD_NOT_OPEN');}};
 const store=createFinancialStore(pool);
 await assert.rejects(store.appendObservation({productId:'stock:abc123',kind:'PRICE',dataClass:'LIVE',
  sourceId:'provider',value:'NaN',observedAt:'2026-01-01',fetchedAt:'2026-01-02'}),/exact non-negative decimal/);
});


test('zero NAV and falsely live mutual-fund NAV cannot reach SQL',async()=>{
 const pool={query:async()=>{throw new Error('SQL_SHOULD_NOT_RUN');},
  connect:async()=>{throw new Error('CONNECTION_SHOULD_NOT_OPEN');}};
 const store=createFinancialStore(pool);
 const base={productId:'amfi:real100',kind:'NAV',value:'101.25',
  currency:'INR',unit:'INR_PER_UNIT',dataClass:'END_OF_DAY',
  sourceId:'amfi-provider',sourceInstrumentId:'100',
  observedAt:'2026-10-21T15:00:00Z',fetchedAt:'2026-10-21T16:00:00Z'};
 await assert.rejects(store.appendObservation({...base,value:'0'}),/strictly positive/);
 await assert.rejects(store.appendObservation({...base,dataClass:'LIVE'}),/end-of-day/);
 await assert.rejects(store.appendObservation({...base,kind:'PRICE',value:'0'}),/strictly positive/);
 await assert.rejects(store.appendObservation({...base,kind:'PUBLISHED_RATE',
   value:'6.50',unit:'PERCENT_PER_ANNUM'}),/rate metric and observation class/);
});

test('financial catalog summary uses PostgreSQL counts, not a hardcoded universe size', async () => {
 const queries=[];
 const dbCount={totalCount:250,allRecords:251,discoveryFamilies:250,actualProducts:1,
  availableRecords:1,unverifiedRecords:250,qualificationFlagged:1};
 const pool={query:async sql=>{queries.push(sql);return{rows:[dbCount]};},
  connect:async()=>({release(){}})};
 const summary=await createFinancialStore(pool).summary();
 assert.deepEqual(summary,dbCount);
 assert.match(queries[0],/FROM finance.products/);
 assert.match(queries[0],/recommendation_eligible IS TRUE/);
 assert.match(queries[0],/count\(\*\) FILTER \(WHERE record_kind='ARCHETYPE'\)::integer AS "totalCount"/);
});
