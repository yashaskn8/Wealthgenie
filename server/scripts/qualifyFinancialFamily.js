import 'dotenv/config';
import { readFileSync, statSync } from 'node:fs';
import { Pool } from 'pg';
import { qualifyProductForFamily } from '../postgres/qualifyFamilyProduct.js';
import { createFinancialPostgresPoolOptions } from '../postgres/poolConfig.js';

// Deliberately no rights-granting or unreviewed-product registration automation.
const path = process.argv[2];
if (!path || process.argv[3] !== '--apply'
  || process.env.FINANCE_QUALIFICATION_OPERATOR_CONFIRMED !== 'yes') {
  throw new Error('EXPLICIT_OPERATOR_APPROVAL_REQUIRED: node scripts/qualifyFinancialFamily.js review.json --apply');
}
if (!process.env.FINANCIAL_POSTGRES_URL) throw new Error('FINANCIAL_POSTGRES_URL_REQUIRED');
if (statSync(path).size > 4 * 1024 * 1024) throw new Error('REVIEW_FILE_TOO_LARGE');
const reviews = JSON.parse(readFileSync(path, 'utf8'));
if (!Array.isArray(reviews) || reviews.length === 0 || reviews.length > 750) {
  throw new Error('REVIEW_MANIFEST_INVALID');
}
const pool = new Pool(createFinancialPostgresPoolOptions(process.env, { max: 1 }));
let completed = 0;
try {
  for (const review of reviews) {
    const result = await qualifyProductForFamily(pool, review);
    completed += 1;
    process.stdout.write(JSON.stringify({
      status: result.status, familyId: result.familyId, productId: result.productId,
    }) + '\n');
  }
} finally {
  await pool.end();
}
process.stdout.write(JSON.stringify({ status: 'REVIEW_BATCH_COMPLETED', approved: completed }) + '\n');
