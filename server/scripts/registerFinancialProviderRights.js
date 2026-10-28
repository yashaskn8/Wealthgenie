import 'dotenv/config';
import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { createFinancialPostgresPoolOptions } from '../postgres/poolConfig.js';
import { digestPrivateApprovalFile } from '../postgres/privateRightsEvidence.js';
import { registerProviderRightsMetadata } from '../postgres/registerProviderRightsMetadata.js';

// Human operator reviews the actual agreement. The document stays outside the
// repository and PostgreSQL; this process stores its hash and approved scopes.
const manifestPath = process.argv[2];
if (!manifestPath || !isAbsolute(manifestPath) || process.argv[3] !== '--apply'
  || process.env.FINANCE_RIGHTS_OPERATOR_CONFIRMED !== 'yes') {
  throw new Error('EXPLICIT_RIGHTS_OPERATOR_CONFIRMATION_REQUIRED');
}
if (!process.env.FINANCIAL_POSTGRES_URL) throw new Error('FINANCIAL_POSTGRES_URL_REQUIRED');
const info = await stat(manifestPath).catch(() => { throw new Error('RIGHTS_MANIFEST_UNREADABLE'); });
if (!info.isFile() || info.size < 1 || info.size > 32 * 1024) {
  throw new Error('RIGHTS_MANIFEST_INVALID');
}
let manifest;
try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); }
catch { throw new Error('RIGHTS_MANIFEST_INVALID'); }
if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
  || typeof manifest.approvalDocumentPath !== 'string') {
  throw new Error('RIGHTS_MANIFEST_INVALID');
}
const { approvalDocumentPath, ...metadata } = manifest;
const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const evidenceSha256 = await digestPrivateApprovalFile(approvalDocumentPath, repositoryRoot);
const pool = new Pool(createFinancialPostgresPoolOptions(process.env, { max: 1 }));
try {
  const result = await registerProviderRightsMetadata(pool, { ...metadata, evidenceSha256 });
  process.stdout.write(JSON.stringify(result) + '\n');
} finally { await pool.end(); }
