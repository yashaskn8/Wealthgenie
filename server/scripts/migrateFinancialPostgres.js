import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

if (!process.env.FINANCIAL_POSTGRES_URL) throw new Error('FINANCIAL_POSTGRES_URL_REQUIRED');
const { Pool } = await import('pg');
const pool = new Pool({
  connectionString: process.env.FINANCIAL_POSTGRES_URL,
  max: 1, connectionTimeoutMillis: 5000, statement_timeout: 30000,
});
const client = await pool.connect();
try {
  const migrationName = '001_financial_universe.sql';
  const ddl = await readFile(fileURLToPath(new URL('../postgres/migrations/' + migrationName, import.meta.url)), 'utf8');
  const checksum = createHash('sha256').update(ddl).digest('hex');

  await client.query('BEGIN');
  // Transaction-scoped lock: never run concurrent schema upgrades on different instances.
  await client.query("SELECT pg_advisory_xact_lock(hashtext('wealthgenie_financial_schema_migrations'))");
  await client.query(`CREATE SCHEMA IF NOT EXISTS finance;
    CREATE TABLE IF NOT EXISTS finance.schema_migrations (
      name text PRIMARY KEY,
      sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
  const existing = await client.query(
    'SELECT sha256 FROM finance.schema_migrations WHERE name=$1 FOR UPDATE', [migrationName],
  );
  if (existing.rows.length && existing.rows[0].sha256 !== checksum) {
    throw new Error('FINANCIAL_SCHEMA_MIGRATION_CHECKSUM_MISMATCH');
  }
  if (!existing.rows.length) {
    await client.query(ddl);
    await client.query(
      'INSERT INTO finance.schema_migrations(name,sha256) VALUES($1,$2)', [migrationName,checksum],
    );
  }
  const probe = await client.query(
    "SELECT to_regclass('finance.market_observations') IS NOT NULL AS ready",
  );
  if (probe.rows[0]?.ready !== true) throw new Error('FINANCIAL_POSTGRES_SCHEMA_NOT_READY');
  await client.query('COMMIT');
  process.stdout.write(JSON.stringify({
    status:'FINANCIAL_POSTGRES_SCHEMA_VERIFIED',
    migration:migrationName,sha256:checksum,
    applied:existing.rows.length===0,
    providerRightsAutoApproved:false,
  })+'\n');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
