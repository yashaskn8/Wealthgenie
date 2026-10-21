import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { investmentDatabase } from '../data/investmentDatabase.js';
import { createFinancialStore } from '../postgres/financialStore.js';

const dbUrl = new URL(process.env.FINANCIAL_POSTGRES_URL || '');
if (process.env.FINANCIAL_POSTGRES_TEST_MODE !== 'true'
  || !dbUrl.pathname.endsWith('_test')) {
  throw new Error('Refusing destructive financial SQL integration test outside an explicit *_test database');
}
const pool = new Pool({ connectionString: dbUrl.toString(), max: 3 });
const store = createFinancialStore(pool);
const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
const productId = 'ci:finance:' + suffix;
const sourceId = 'ci-source-' + suffix;
try {
  const catalog = await pool.query(`SELECT count(*)::integer AS n FROM finance.products
    WHERE record_kind='ARCHETYPE'`);
  assert.ok(catalog.rows[0].n >= investmentDatabase.length, 'All existing archetypes must be staged');
  const promoted = await pool.query(`SELECT count(*)::integer AS n FROM finance.products
    WHERE record_kind='ARCHETYPE' AND recommendation_eligible=true`);
  assert.equal(promoted.rows[0].n, 0, 'Seeded archetypes must never become newly recommended without review');
  const unauthorized = await store.latestPublishableObservation(productId, 'PRICE');
  assert.equal(unauthorized, null);
  const categories = await pool.query('SELECT id FROM finance.categories ORDER BY id LIMIT 1');
  assert.ok(categories.rows.length, 'At least one catalog category must be staged');
  await pool.query(`INSERT INTO finance.products
    (id,name,record_kind,category_id,source_identity,availability)
    VALUES($1,$2,'ACTUAL_PRODUCT',$3,$4,'AVAILABLE')`,
  [productId,'CI Synthetic Product',categories.rows[0].id,'CI:' + suffix]);
  await pool.query(`INSERT INTO finance.provider_rights
    (source_id,endpoint_url,evidence_url,retention_seconds)
    VALUES($1,$2,$3,3600)`,
    [sourceId,'https://example.invalid/fixture','https://example.invalid/rights']);
  await pool.query(`INSERT INTO finance.product_external_ids
    (product_id,source_id,source_instrument_id) VALUES($1,$2,$3)`,
    [productId,sourceId,'CI:INSTRUMENT:'+suffix]);
  const input = {
    productId, sourceId, sourceInstrumentId:'CI:INSTRUMENT:'+suffix,
    kind:'PRICE', value:'100.25000000',
    currency:'INR',unit:'INR_PER_UNIT',dataClass:'LIVE',
    observedAt:new Date(Date.now()-20000).toISOString(),
    fetchedAt:new Date(Date.now()-15000).toISOString(),
  };
  await assert.rejects(store.appendObservation(input), /MARKET_DATA_SOURCE_RIGHTS_UNQUALIFIED/);
  await pool.query(`UPDATE finance.provider_rights SET
    access_allowed=true,extraction_allowed=true,storage_allowed=true,
    derivation_allowed=true,public_display_allowed=true,commercial_use_allowed=true,
    redistribution_allowed=true,reviewed_at=now()
    WHERE source_id=$1`,[sourceId]);
  const stored = await store.appendObservation(input);
  assert.equal(stored.stored,true);
  const found = await store.latestPublishableObservation(productId,'PRICE');
  assert.equal(found?.value,'100.25000000');
  assert.equal(found?.source_id,sourceId);
  await pool.query('UPDATE finance.provider_rights SET revoked_at=now() WHERE source_id=$1',[sourceId]);
  assert.equal(await store.latestPublishableObservation(productId,'PRICE'),null,
    'Revoked rights must prevent source publication immediately');
  process.stdout.write(JSON.stringify({status:'PASS',archetypes:catalog.rows[0].n,
    licenseAbsentDenied:true,revocationDenied:true,sandboxFixture:true})+'\n');
} finally {
  // This script is restricted to *_test databases. Never modify a live source registry.
  await pool.query('DELETE FROM finance.market_observations WHERE source_id=$1',[sourceId]);
  await pool.query('DELETE FROM finance.product_external_ids WHERE source_id=$1',[sourceId]);
  await pool.query('DELETE FROM finance.products WHERE id=$1',[productId]);
  await pool.query('DELETE FROM finance.provider_rights WHERE source_id=$1',[sourceId]);
  await pool.end();
}
