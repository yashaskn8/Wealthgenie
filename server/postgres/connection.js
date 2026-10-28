import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createFinancialPostgresPoolOptions } from './poolConfig.js';

let instance = null;
let pending = null;
const REQUIRED_FINANCIAL_MIGRATIONS = Object.freeze([
  '001_financial_universe.sql',
  '002_catalog_discovery_evidence.sql',
  '003_catalog_discovery_metadata.sql',
  '004_market_observation_semantics.sql',
  '005_provider_rights_audit.sql',
  '006_permission_assertions.sql',
  '007_actual_product_tax_class.sql',
  '008_contract_terms_provenance.sql',
  '009_family_product_qualification.sql',
  '010_family_qualification_integrity.sql',
  '011_private_provider_rights_evidence.sql',
  '012_provider_permission_verification.sql',
]);

/**
 * Enabling a finance database is a release gate, not merely a connectivity
 * check. Verify the shipped migrations against what the DB applied and
 * ensure no partial catalog has been silently promoted.
 */
export async function verifyFinancialPostgresReadiness(pool) {
  const { rows: migrated } = await pool.query(
    'SELECT name, sha256 FROM finance.schema_migrations',
  );
  const actual = new Map(migrated.map(row => [row.name, row.sha256]));
  for (const name of REQUIRED_FINANCIAL_MIGRATIONS) {
    const contents = readFileSync(new URL('./migrations/' + name, import.meta.url));
    const expected = createHash('sha256').update(contents).digest('hex');
    if (actual.get(name) !== expected) {
      const error = new Error('FINANCIAL_POSTGRES_MIGRATION_INCOMPLETE_OR_MODIFIED:' + name);
      error.code = 'FINANCIAL_POSTGRES_MIGRATION_UNVERIFIED';
      throw error;
    }
  }
  const { rows } = await pool.query(`
    SELECT count(*) FILTER(WHERE record_kind='ARCHETYPE')::integer AS archetypes,
           count(*) FILTER(WHERE record_kind='ARCHETYPE' AND recommendation_eligible)::integer
             AS unsafe_promoted
      FROM finance.products`);
  if (!rows[0] || rows[0].archetypes < 250 || rows[0].unsafe_promoted !== 0) {
    const error = new Error('FINANCIAL_POSTGRES_CATALOG_NOT_RECONCILED');
    error.code = 'FINANCIAL_POSTGRES_CATALOG_NOT_RECONCILED';
    throw error;
  }
  return { ready: true, archetypes: rows[0].archetypes, migrations: REQUIRED_FINANCIAL_MIGRATIONS.length };
}
/** Opt-in PostgreSQL source authority. Existing MongoDB flows remain usable without this flag. */
export async function getFinancialPostgresPool(env = process.env) {
  if (env.FINANCIAL_POSTGRES_ENABLED !== 'true') return null;
  if (!env.FINANCIAL_POSTGRES_URL) {
    const error = new Error('FINANCIAL_POSTGRES_URL_REQUIRED');
    error.code = 'FINANCIAL_POSTGRES_URL_REQUIRED';
    throw error;
  }
  if (instance) return instance;
  if (pending) return pending;
  pending = (async () => {
    let Pool;
    try {
      ({ Pool } = await import('pg'));
    } catch {
      const error = new Error('PostgreSQL runtime driver is unavailable; install the node-postgres pg package before enabling');
      error.code = 'FINANCIAL_POSTGRES_DRIVER_MISSING';
      throw error;
    }
    const pool = new Pool(createFinancialPostgresPoolOptions(env));
    try {
      await verifyFinancialPostgresReadiness(pool);
      instance = pool;
      return pool;
    } catch (error) {
      await pool.end();
      throw error;
    }
  })();
  try { return await pending; } finally { pending = null; }
}
export async function closeFinancialPostgresPool() {
  const old = instance;
  instance = null;
  if (old) await old.end();
}
