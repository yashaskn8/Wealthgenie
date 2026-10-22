import 'dotenv/config';
import { createFinancialPostgresPoolOptions } from '../postgres/poolConfig.js';
if (!process.env.FINANCIAL_POSTGRES_URL) throw new Error('FINANCIAL_POSTGRES_URL_REQUIRED');
const { Pool } = await import('pg');
const pool = new Pool(createFinancialPostgresPoolOptions(process.env, {
  max: 1, statement_timeout: 30000,
}));
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtext('wealthgenie_financial_rights_retention'))");
  // Retention may end BEFORE the approved duration when source rights are
  // withdrawn, expire or stop permitting licensed storage and derived use.
  const observations = await client.query(`
    DELETE FROM finance.market_observations o
    USING finance.provider_rights r
    WHERE o.source_id=r.source_id
      AND (
        o.retain_until IS NULL OR o.retain_until<=now()
        OR r.revoked_at IS NOT NULL
        OR r.expires_at IS NOT NULL AND r.expires_at<=now()
        OR r.reviewed_at IS NULL OR NOT r.access_allowed
        OR NOT r.extraction_allowed OR NOT r.storage_allowed
        OR NOT r.derivation_allowed OR NOT r.commercial_use_allowed
      )`);
  const terms = await client.query(`
    DELETE FROM finance.product_terms p
    USING finance.provider_rights r
    WHERE p.source_id=r.source_id
      AND (
        r.revoked_at IS NOT NULL
        OR r.expires_at IS NOT NULL AND r.expires_at<=now()
        OR r.reviewed_at IS NULL OR NOT r.access_allowed
        OR NOT r.extraction_allowed OR NOT r.storage_allowed
        OR NOT r.derivation_allowed OR NOT r.commercial_use_allowed
      )`);
  await client.query('COMMIT');
  process.stdout.write(JSON.stringify({
    status:'PRUNED',
    removedExpiredOrUnqualifiedObservations:observations.rowCount,
    removedUnqualifiedSourceTerms:terms.rowCount,
    sourceRightsAutoApproved:false,
  })+'\n');
} catch(error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
