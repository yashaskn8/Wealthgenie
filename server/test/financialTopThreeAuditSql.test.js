import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../scripts/auditFinancialTopThreeCoverage.js',import.meta.url),'utf8');
test('coverage audit counts unique eligible actual instruments, not duplicate product IDs',()=>{
  assert.match(source,/count\(DISTINCT p\.source_identity\) FILTER/);
  assert.doesNotMatch(source,/count\(DISTINCT q\.product_id\) FILTER/);
  for(const gate of [
    "p.verification_scope='VERIFIED_ACTUAL_PRODUCT'",
    'p.category_id=f.category_id',
    'q.retail_access=true',
    'q.requires_accreditation=false',
    'p.tax_class_reviewed_at<=now()',
    'ext.source_instrument_id=o.source_instrument_id',
    "r.verification_state='VERIFIED'",
    'r.verification_expires_at>now()',
    'buildCatalog250Verification().families',
    'f.id=ANY($1::text[])',
  ]) assert.ok(source.includes(gate),gate);
});
