import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateQualifiedHistoricalVolatility} from '../services/qualifiedHistoricalVolatility.js';
import {createFinancialStore} from '../postgres/financialStore.js';

const now=new Date('2026-10-22T12:00:00Z');
const begin=Date.parse('2026-03-20T12:00:00Z');
const history=Array.from({length:216},(_,i)=>({
 id:i+1,value:(100*Math.exp(i*0.00035+0.01*Math.sin(i))).toFixed(8),
 observed_at:new Date(begin+i*86400000).toISOString(),
 source_id:'licensed-source',source_instrument_id:'ISIN:IN1234567890',
 data_class:'END_OF_DAY',
}));
test('source-qualified EOD history provides bounded observed volatility, never an expected future return',()=>{
 const result=estimateQualifiedHistoricalVolatility(history,{now});
 assert.equal(result.status,'CALCULATED');
 assert.equal(result.sourceId,'licensed-source');
 assert.equal(result.sampleCount,216);
 assert.ok(result.annualVolatility>0&&result.annualVolatility<0.6);
 assert.equal(result.expectedAnnualReturn,null);
 assert.equal(result.isForecast,false);
 assert.equal(result.isTotalReturn,false);
 assert.equal(result.corporateActionAdjusted,false);
 assert.deepEqual(estimateQualifiedHistoricalVolatility([...history].reverse(),{now}),result);
});
test('historical calibration rejects mixed identities, dates, gaps and unadjusted jumps',()=>{
 const mutate=(i,patch)=>history.map((x,n)=>n===i?{...x,...patch}:x);
 for(const rows of [
  history.slice(0,40),
  mutate(20,{source_id:'other-provider'}),
  mutate(20,{source_instrument_id:'ISIN:OTHER'}),
  mutate(20,{data_class:'LIVE'}),
  mutate(20,{observed_at:history[19].observed_at}),
  mutate(20,{value:'0'}),
  mutate(20,{value:'NaN'}),
  mutate(20,{value:'999.00000000'}),
  mutate(20,{observed_at:'2026-01-01T12:00:00Z'}),
  history.map(x=>({...x,observed_at:new Date(Date.parse(x.observed_at)-25*86400000).toISOString()})),
 ]) {
  const result=estimateQualifiedHistoricalVolatility(rows,{now});
  assert.equal(result.status,'UNAVAILABLE',result.reasonCode);
  assert.equal(result.annualVolatility,null);
 }
});
test('Postgres history is exact-source, tax-class and rights gated, parameterized, finite and EOD only',async()=>{
 const calls=[];
 const pool={query:async(sql,args)=>{calls.push({sql,args});return {rows:[]};},
   connect:async()=>({release(){}})};
 const store=createFinancialStore(pool);
 assert.deepEqual(await store.qualifiedHistoricalPrices('eq:verified','NAV','licensed-source',now),[]);
 assert.deepEqual(calls[0].args,['eq:verified','NAV','licensed-source',now]);
 for(const part of ['qualified_tax_class','tax_class_evidence_url','storage_allowed',
  'derivation_allowed','public_display_allowed','commercial_use_allowed',
  'redistribution_allowed','revoked_at IS NULL','retain_until','END_OF_DAY',
  'observation_corrections','LIMIT 1000']){
  assert.ok(calls[0].sql.includes(part),part);
 }
 await assert.rejects(store.qualifiedHistoricalPrices('bad;DROP','PRICE','licensed-source'),
   /Canonical financial product ID/);
 await assert.rejects(store.qualifiedHistoricalPrices('eq:verified','YIELD','licensed-source'),
   /Historical metric/);
 await assert.rejects(store.qualifiedHistoricalPrices('eq:verified','NAV','bad\nsource'),
   /Exact market source ID/);
 assert.equal(calls.length,1);
});
