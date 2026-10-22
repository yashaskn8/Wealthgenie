import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { investmentDatabase } from '../data/investmentDatabase.js';
import { createFinancialStore } from '../postgres/financialStore.js';
import { qualifyProductForFamily, suspendProductForFamily } from '../postgres/qualifyFamilyProduct.js';
import { compareQualifiedFamilyProducts } from '../services/familyTopThree.js';
import { canonicalProfile } from '../test/helpers/canonicalProfile.js';
import { createFinancialPostgresPoolOptions } from '../postgres/poolConfig.js';

const dbUrl = new URL(process.env.FINANCIAL_POSTGRES_URL || '');
if (process.env.FINANCIAL_POSTGRES_TEST_MODE !== 'true'
  || !dbUrl.pathname.endsWith('_test')) {
  throw new Error('Refusing destructive financial SQL integration test outside an explicit *_test database');
}
const pool = new Pool(createFinancialPostgresPoolOptions({
  ...process.env,
  FINANCIAL_POSTGRES_URL: dbUrl.toString(),
}, { max: 3 }));
const store = createFinancialStore(pool);
const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
const productId = 'ci:finance:' + suffix;
const sourceId = 'ci-source-' + suffix;
try {
  const catalog = await pool.query(`SELECT count(*)::integer AS n FROM finance.products
    WHERE record_kind='ARCHETYPE'`);
  assert.ok(catalog.rows[0].n >= 250, 'Original 155 and 95 sourced extensions must be staged');
  const added=await pool.query(`SELECT count(*)::integer AS n FROM finance.products
    WHERE record_kind='ARCHETYPE' AND verification_scope='REGULATORY_CATEGORY_OR_INDEX_ONLY'
      AND discovery_reference_url LIKE 'https://%' AND recommendation_eligible=false
      AND availability='UNVERIFIED'`);
  assert.equal(added.rows[0].n,95,'Exactly 95 non-recommendable sourced discovery archetypes must be staged');
  const detail=await pool.query(`SELECT count(*)::integer AS n FROM finance.products
    WHERE record_kind='ARCHETYPE' AND discovery_metadata IS NOT NULL
      AND discovery_metadata->'researchEvidence'->>'actualIssuerOrSchemeVerified'='false'
      AND discovery_metadata->'dataRights'->>'commercialDerivation'='false'
      AND discovery_metadata->'taxAndCalculations'->>'taxModelStatus'='NOT_IMPLEMENTED_FOR_THIS_ARCHETYPE'`);
  assert.equal(detail.rows[0].n,95,'All new entries must preserve blocked rights, unverified products and tax gaps');
  const promoted = await pool.query(`SELECT count(*)::integer AS n FROM finance.products
    WHERE record_kind='ARCHETYPE' AND recommendation_eligible=true`);
  assert.equal(promoted.rows[0].n, 0, 'Seeded archetypes must never become newly recommended without review');
  const unauthorized = await store.latestPublishableObservation(productId, 'PRICE');
  assert.equal(unauthorized, null);
  const categories = await pool.query('SELECT id FROM finance.categories ORDER BY id LIMIT 1');
  const family = await pool.query("SELECT id FROM finance.products WHERE record_kind='ARCHETYPE' AND category_id=$1 ORDER BY id LIMIT 1", [categories.rows[0]?.id]);
  assert.ok(family.rows.length, 'Need a reference family for the isolated product fixture');
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
  await assert.rejects(store.appendObservation({...input,
    sourceInstrumentId:'CI:WRONG:'+suffix}),/PRODUCT_PROVIDER_IDENTITY_MISMATCH/);
  // No operator can silently assign listed-equity tax treatment to an
  // imported product without an exact source and review timestamp.
  await assert.rejects(
    pool.query(`UPDATE finance.products SET qualified_tax_class=
      'LISTED_EQUITY_STT_QUALIFIED' WHERE id=$1`,[productId]),
    /financial_products_tax_class_evidence/,
    'Actual product tax classification must carry evidence and a review time',
  );
  assert.deepEqual(await store.qualifiedHistoricalPrices(productId,'PRICE',sourceId),[],
    'Unqualified or absent EOD histories must not be used to estimate equity risk');
  const stored = await store.appendObservation(input);
  assert.equal(stored.stored,true);
  const found = await store.latestPublishableObservation(productId,'PRICE');
  assert.equal(found?.value,'100.25000000');
  assert.equal(found?.source_id,sourceId);
  // Synthetic _test database ONLY: prove the SQL review gate, product identity,
  // actual observation publication and right-revocation behavior end-to-end.
  await pool.query(`UPDATE finance.products SET
    verification_scope='VERIFIED_ACTUAL_PRODUCT',
    discovery_reference_url='https://example.invalid/synthetic-issuer',
    qualified_tax_class='ORDINARY_INTEREST',
    tax_class_evidence_url='https://example.invalid/synthetic-tax',
    tax_class_reviewed_at=now() WHERE id=$1`,[productId]);
  const familyId=family.rows[0].id;
  const probe=await pool.query(`
    SELECT f.category_id=p.category_id AS matching_category,
      f.record_kind='ARCHETYPE' AS valid_family,
      p.record_kind='ACTUAL_PRODUCT' AS actual_product,
      p.availability='AVAILABLE' AS available_product,
      p.verification_scope='VERIFIED_ACTUAL_PRODUCT' AS identity_verified,
      p.qualified_tax_class NOT IN ('UNVERIFIED','OTHER_UNSUPPORTED') AS tax_class_supported,
      p.tax_class_evidence_url LIKE 'https://%' AS tax_evidence,
      p.tax_class_reviewed_at<=now() AS tax_reviewed,
      (SELECT count(*)::integer FROM finance.product_external_ids ext
        WHERE ext.product_id=p.id AND ext.source_id=r.source_id) AS instrument_identity_count,
      r.access_allowed AS access_right, r.extraction_allowed AS extraction_right,
      r.storage_allowed AS storage_right, r.derivation_allowed AS derivation_right,
      r.public_display_allowed AS display_right,r.commercial_use_allowed AS commercial_right,
      r.redistribution_allowed AS redistribution_right,
      r.retention_seconds>0 AS retention_right,
      r.reviewed_at IS NOT NULL AS source_reviewed,
      r.revoked_at IS NULL AS source_unrevoked
    FROM finance.products f CROSS JOIN finance.products p CROSS JOIN finance.provider_rights r
    WHERE f.id=$1 AND p.id=$2 AND r.source_id=$3`,[familyId,productId,sourceId]);
  assert.equal(probe.rows.length,1,'Synthetic qualifying fact graph must exist');
  const disallowed=Object.entries(probe.rows[0]).filter(([k,v])=>
    k==='instrument_identity_count'?v!==1:v!==true);
  assert.deepEqual(disallowed,[],
    'Synthetic current approval facts must all be satisfied before the operator gate');
  const reviewed=await qualifyProductForFamily(pool,{
    familyId,productId,sourceId,observationType:'PRICE',
    evidenceUrl:'https://example.invalid/synthetic-issuer',
    termsEvidenceUrl:'https://example.invalid/synthetic-terms',
    riskEvidenceUrl:'https://example.invalid/synthetic-risk',
    reviewedBy:'ci-isolated-synthetic-review',
    reviewedAt:new Date(Date.now()-120000).toISOString(),
    validUntil:new Date(Date.now()+3600000).toISOString(),
    riskLevel:1,minInvestmentInr:1000,minHorizonYears:1,
    lockInMonths:0,annualFeeBps:0,retailAccess:true,
    reviewNote:'Synthetic isolated test only; not an approved real product or licensed commercial source.',
  });
  assert.equal(reviewed.status,'ACTIVE');
  const compare=()=>compareQualifiedFamilyProducts({
    pool,familyId,profileInput:canonicalProfile(),adviceAuthorized:true,
  });
  const available=await compare();
  assert.equal(available.status,'AVAILABLE');
  assert.deepEqual(available.products.map(p=>p.id),[productId]);
  assert.equal(available.products[0].marketFact.sourceId,sourceId);
  await pool.query('UPDATE finance.provider_rights SET revoked_at=now() WHERE source_id=$1',[sourceId]);
  const revoked=await compare();
  assert.equal(revoked.status,'NO_QUALIFIED_PRODUCTS');
  assert.deepEqual(revoked.products,[]);
  assert.equal(revoked.exclusionCounts.DATA_RIGHTS_REVOKED_OR_EXPIRED,1);
  const suspended=await suspendProductForFamily(pool,{
    familyId,productId,reviewedBy:'ci-isolated-synthetic-review',
    reviewNote:'Synthetic source rights revoked in isolated test database.',
  });
  assert.equal(suspended.status,'SUSPENDED');
  assert.equal(await store.latestPublishableObservation(productId,'PRICE'),null,
    'Revoked rights must prevent source publication immediately');
  execFileSync(process.execPath,
    [fileURLToPath(new URL('./pruneFinancialPostgres.js',import.meta.url))],
    {env:process.env,stdio:'pipe',timeout:30000});
  const purged=await pool.query(
    'SELECT count(*)::integer AS n FROM finance.market_observations WHERE source_id=$1',
    [sourceId],
  );
  assert.equal(purged.rows[0].n,0,'Revoked market facts must be physically removed');
  const audited=await pool.query(
    'SELECT count(*)::integer AS n FROM finance.provider_rights_audit WHERE source_id=$1',
    [sourceId],
  );
  assert.ok(audited.rows[0].n>=3,
    'Rights creation, explicit approval and revocation must all be auditable');
  await assert.rejects(
    pool.query('DELETE FROM finance.provider_rights_audit WHERE source_id=$1',[sourceId]),
    /PROVIDER_RIGHTS_AUDIT_IMMUTABLE/,
    'Provider-rights audit history must be append-only at the database layer',
  );
  process.stdout.write(JSON.stringify({status:'PASS',archetypes:catalog.rows[0].n,
    sourcedExtensions:added.rows[0].n,reviewMetadataRecords:detail.rows[0].n,
    licenseAbsentDenied:true,revocationDenied:true,
    wrongProviderInstrumentDenied:true,revocationDataPurged:true,
    rightsAuditTrailVerified:true,threeProductActivationFixturePassed:true,
    revocationRemovesQualifiedProducts:true,sandboxFixture:true})+'\n');
} finally {
  // This script is restricted to *_test databases. Never modify a live source registry.
  await pool.query('DELETE FROM finance.market_observations WHERE source_id=$1',[sourceId]);
  await pool.query('DELETE FROM finance.family_product_qualifications WHERE product_id=$1',[productId]);
  await pool.query('DELETE FROM finance.product_external_ids WHERE source_id=$1',[sourceId]);
  await pool.query('DELETE FROM finance.products WHERE id=$1',[productId]);
  await pool.query('DELETE FROM finance.provider_rights WHERE source_id=$1',[sourceId]);
  await pool.end();
}
