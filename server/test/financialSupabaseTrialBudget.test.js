import test from 'node:test';
import assert from 'node:assert/strict';
import {createFinancialStore} from '../postgres/financialStore.js';

const observation=()=>({
  productId:'ci:trial:123',
  sourceId:'demo-rights',
  sourceInstrumentId:'ci:security123',
  kind:'PRICE',
  dataClass:'LIVE',
  value:'101.22000000',
  currency:'INR',
  unit:'INR_PER_UNIT',
  observedAt:new Date(Date.now()-20000).toISOString(),
  fetchedAt:new Date(Date.now()-10000).toISOString(),
});
function poolFixture(usedBytes=400000000) {
  const commands=[];
  const client={
    query:async(sql)=>{
      commands.push(sql);
      if(sql.includes('FROM finance.products'))return {rows:[{record_kind:'ACTUAL_PRODUCT',availability:'AVAILABLE'}]};
      if(sql.includes('FROM finance.product_external_ids'))return {rows:[{product_id:'ci:trial:123'}]};
      if(sql.includes('FROM finance.provider_rights'))return {rows:[{source_id:'demo-rights',retention_seconds:3600}]};
      if(sql.includes('pg_database_size'))return {rows:[{bytes:String(usedBytes)}]};
      if(sql.includes('INSERT INTO finance.market_observations'))return {rowCount:1,rows:[{id:20}]};
      return {rows:[]};
    },
    release:()=>{commands.push('RELEASE');},
  };
  return {pool:{query:client.query,connect:async()=>client},commands};
}

test('Supabase free-trial financial ingestion fails closed above the configured database budget',async()=>{
  const {pool,commands}=poolFixture(400000000);
  const store=createFinancialStore(pool,{env:{FINANCIAL_POSTGRES_TRIAL_MODE:'true'}});
  await assert.rejects(store.appendObservation(observation()),/FINANCIAL_TRIAL_DATABASE_BUDGET_EXCEEDED/);
  assert.ok(commands.includes('ROLLBACK'));
  assert.ok(!commands.some(x=>x.includes('INSERT INTO finance.market_observations')));
});
test('bounded permitted trial write succeeds below budget without bypassing source rights',async()=>{
  const {pool,commands}=poolFixture(140000000);
  const store=createFinancialStore(pool,{env:{FINANCIAL_POSTGRES_TRIAL_MODE:'true',
    FINANCIAL_POSTGRES_MAX_BYTES:'350000000'}});
  const result=await store.appendObservation(observation());
  assert.equal(result.stored,true);
  assert.ok(commands.includes('COMMIT'));
});
test('Supabase free-trial ingestion rejects invalid budget configuration',async()=>{
  const {pool}=poolFixture(140000000);
  const store=createFinancialStore(pool,{env:{FINANCIAL_POSTGRES_TRIAL_MODE:'true',
    FINANCIAL_POSTGRES_MAX_BYTES:'600000000'}});
  await assert.rejects(store.appendObservation(observation()),/FINANCIAL_POSTGRES_MAX_BYTES/);
});
