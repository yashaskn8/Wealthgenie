import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
if (!process.env.FINANCIAL_POSTGRES_URL) throw new Error('FINANCIAL_POSTGRES_URL_REQUIRED');
const { Pool } = await import('pg');
const pool = new Pool({
  connectionString: process.env.FINANCIAL_POSTGRES_URL,
  max: 1,
  connectionTimeoutMillis: 5000,
  statement_timeout: 30000,
});
try {
  const ddl = await readFile(fileURLToPath(new URL('../postgres/migrations/001_financial_universe.sql', import.meta.url)), 'utf8');
  await pool.query(ddl);
  const { rows } = await pool.query("SELECT to_regclass('finance.market_observations') IS NOT NULL AS ready");
  if (rows[0]?.ready !== true) throw new Error('FINANCIAL_POSTGRES_SCHEMA_NOT_READY');
  process.stdout.write('Financial PostgreSQL schema verified. No provider rights were automatically approved.\n');
} finally {
  await pool.end();
}
