import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { verifyFinancialPostgresReadiness } from '../postgres/connection.js';

const names = [
  '001_financial_universe.sql',
  '002_catalog_discovery_evidence.sql',
  '003_catalog_discovery_metadata.sql',
  '004_market_observation_semantics.sql',
  '005_provider_rights_audit.sql',
];
const applied=names.map(name=>({
  name,
  sha256:createHash('sha256')
    .update(readFileSync(new URL('../postgres/migrations/'+name,import.meta.url)))
    .digest('hex'),
}));
function fakePool({migrations=applied,archetypes=250,unsafePromoted=0}={}) {
  return {query:async sql=>sql.includes('schema_migrations') ?
    {rows:migrations} : {rows:[{archetypes,unsafe_promoted:unsafePromoted}]}};
}

test('finance SQL start only after five matching migrations and all 250 discovery entries',async()=>{
 assert.deepEqual(await verifyFinancialPostgresReadiness(fakePool()),
   {ready:true,archetypes:250,migrations:5});
});
test('missing or modified migration is blocked before financial service becomes available',async()=>{
 await assert.rejects(verifyFinancialPostgresReadiness(fakePool({migrations:applied.slice(0,4)})),
   /FINANCIAL_POSTGRES_MIGRATION_INCOMPLETE_OR_MODIFIED/);
 await assert.rejects(verifyFinancialPostgresReadiness(fakePool({migrations:applied.map(
   row=>row.name===names[0]?{...row,sha256:'0'.repeat(64)}:row,
 )})),/FINANCIAL_POSTGRES_MIGRATION_INCOMPLETE_OR_MODIFIED/);
});
test('partially seeded or improperly promoted financial discovery products fail closed',async()=>{
 await assert.rejects(verifyFinancialPostgresReadiness(fakePool({archetypes:249})),
   /FINANCIAL_POSTGRES_CATALOG_NOT_RECONCILED/);
 await assert.rejects(verifyFinancialPostgresReadiness(fakePool({unsafePromoted:1})),
   /FINANCIAL_POSTGRES_CATALOG_NOT_RECONCILED/);
});
