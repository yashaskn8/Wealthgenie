import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestPrivateApprovalFile } from '../postgres/privateRightsEvidence.js';
import { registerProviderRightsMetadata } from '../postgres/registerProviderRightsMetadata.js';

const now = new Date('2026-10-28T12:00:00Z');
const input = {
  sourceId: 'nse-debt-approved',
  endpointUrl: 'https://www.nseindia.com/market-data/debt-market-trade-repository',
  approvalReference: 'NSE-APPROVAL-2026',
  evidenceSha256: 'a'.repeat(64),
  attestedBy: 'Authorized operator',
  reviewedAt: '2026-10-27T12:00:00Z',
  expiresAt: null,
  retentionSeconds: 30 * 24 * 60 * 60,
  permissions: {
    access: true, extraction: true, storage: true, derivation: true,
    publicDisplay: true, commercialUse: true, redistribution: true,
  },
};
function fixture(existing = []) {
  const calls = [];
  const client = {
    query: async (sql, args = []) => {
      calls.push({ sql, args });
      if (sql.includes('SELECT source_id FROM finance.provider_rights')) return { rows: existing };
      return { rows: [], rowCount: 1 };
    },
    release: () => calls.push({ sql: 'RELEASE' }),
  };
  return { pool: { connect: async () => client }, calls };
}

test('private approval metadata registers reviewed scopes without document or path', async () => {
  const { pool, calls } = fixture();
  const result = await registerProviderRightsMetadata(pool, input, { now });
  assert.equal(result.status, 'REGISTERED');
  assert.equal(result.documentStored, false);
  const insert = calls.find(call => call.sql.includes('INSERT INTO finance.provider_rights'));
  assert.ok(insert);
  assert.ok(insert.sql.includes('evidence_sha256'));
  assert.ok(insert.args.includes(input.evidenceSha256));
  assert.ok(!insert.args.includes('confidential agreement text'));
  assert.ok(calls.some(call => call.sql === 'COMMIT'));
});

test('rights registration rejects missing scope, insecure endpoint, bad digest and expired grant', async () => {
  const { pool, calls } = fixture();
  for (const bad of [
    { ...input, permissions: { ...input.permissions, commercialUse: undefined } },
    { ...input, endpointUrl: 'http://www.nseindia.com/debt' },
    { ...input, endpointUrl: 'https://127.0.0.1/debt' },
    { ...input, endpointUrl: 'https://www.nseindia.com/debt?api_key=secret' },
    { ...input, evidenceSha256: 'not-a-document-hash' },
    { ...input, expiresAt: '2026-10-27T12:00:00Z' },
    { ...input, retentionSeconds: 0 },
    { ...input, approvalDocumentPath: '/private/document.pdf' },
  ]) await assert.rejects(registerProviderRightsMetadata(pool, bad, { now }),
    /RIGHTS_METADATA_INVALID/);
  assert.equal(calls.length, 0);
});

test('existing source rights cannot be overwritten by a new assertion', async () => {
  const { pool, calls } = fixture([{ source_id: input.sourceId }]);
  await assert.rejects(registerProviderRightsMetadata(pool, input, { now }),
    /RIGHTS_RECORD_ALREADY_EXISTS_REVIEW_REQUIRED/);
  assert.ok(calls.some(call => call.sql === 'ROLLBACK'));
  assert.ok(!calls.some(call => call.sql.includes('INSERT INTO finance.provider_rights')));
});

test('approval file is hashed outside the repository and never returned as text', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'wealthgenie-approval-test-'));
  const file = join(folder, 'private-approval.txt');
  await writeFile(file, 'private test approval');
  try {
    const digest = await digestPrivateApprovalFile(file, process.cwd());
    assert.equal(digest, createHash('sha256').update('private test approval').digest('hex'));
    await assert.rejects(digestPrivateApprovalFile(file, folder),
      /PRIVATE_APPROVAL_MUST_STAY_OUTSIDE_REPOSITORY/);
  } finally {
    await unlink(file);
    await rmdir(folder);
  }
});
