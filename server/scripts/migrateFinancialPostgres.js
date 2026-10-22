import 'dotenv/config';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createFinancialPostgresPoolOptions } from '../postgres/poolConfig.js';

if (!process.env.FINANCIAL_POSTGRES_URL) throw new Error('FINANCIAL_POSTGRES_URL_REQUIRED');
const { Pool } = await import('pg');
const pool = new Pool(createFinancialPostgresPoolOptions(process.env, {
  max: 1, statement_timeout: 30000,
}));
const client = await pool.connect();
const migrationDirectory = new URL('../postgres/migrations/', import.meta.url);
try {
  const names = (await readdir(fileURLToPath(migrationDirectory)))
    .filter(name => /^[0-9]{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
  if (!names.length) throw new Error('FINANCIAL_SCHEMA_MIGRATIONS_MISSING');
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtext('wealthgenie_financial_schema_migrations'))");
  await client.query(`CREATE SCHEMA IF NOT EXISTS finance;
    CREATE TABLE IF NOT EXISTS finance.schema_migrations (
      name text PRIMARY KEY,
      sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
  const applied = [];
  for (const name of names) {
    const ddl = await readFile(fileURLToPath(new URL(name, migrationDirectory)), 'utf8');
    const checksum = createHash('sha256').update(ddl).digest('hex');
    const existing = await client.query(
      'SELECT sha256 FROM finance.schema_migrations WHERE name=$1 FOR UPDATE', [name],
    );
    if (existing.rows.length && existing.rows[0].sha256 !== checksum) {
      throw new Error('FINANCIAL_SCHEMA_MIGRATION_CHECKSUM_MISMATCH:' + name);
    }
    if (!existing.rows.length) {
      await client.query(ddl);
      await client.query(
        'INSERT INTO finance.schema_migrations(name,sha256) VALUES($1,$2)', [name,checksum],
      );
      applied.push(name);
    }
  }
  const probe = await client.query(
    "SELECT to_regclass('finance.market_observations') IS NOT NULL AS observations_ready, " +
    "to_regclass('finance.products') IS NOT NULL AS products_ready",
  );
  if (!probe.rows[0]?.observations_ready || !probe.rows[0]?.products_ready) {
    throw new Error('FINANCIAL_POSTGRES_SCHEMA_NOT_READY');
  }
  await client.query('COMMIT');
  process.stdout.write(JSON.stringify({
    status:'FINANCIAL_POSTGRES_SCHEMA_VERIFIED',migrations:names,applied,
    providerRightsAutoApproved:false,
  })+'\n');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
