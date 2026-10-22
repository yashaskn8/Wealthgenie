import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { createFinancialPostgresPoolOptions } from '../postgres/poolConfig.js';

const url = 'postgresql://tester:private@db.example.test/wealthgenie?sslmode=require';

test('an explicit CA enforces certificate verification over weaker URL SSL mode', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wealthgenie-pg-ca-'));
  const caFile = path.join(directory, 'root.crt');
  const ca = '-----BEGIN CERTIFICATE-----\nTEST ROOT\n-----END CERTIFICATE-----\n';
  fs.writeFileSync(caFile, ca, 'utf8');
  try {
    const options = createFinancialPostgresPoolOptions({
      FINANCIAL_POSTGRES_URL: url,
      FINANCIAL_POSTGRES_CA_FILE: caFile,
    }, { ssl: { rejectUnauthorized: false } });
    const client = new Client(options);
    assert.equal(client.connectionParameters.ssl.rejectUnauthorized, true);
    assert.equal(client.connectionParameters.ssl.ca, ca);
    assert.equal(client.connectionParameters.host, 'db.example.test');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('configured CA file errors are sanitized and fail before a connection attempt', () => {
  const missingPath = path.join(os.tmpdir(), 'wealthgenie-private-missing-ca.crt');
  assert.throws(
    () => createFinancialPostgresPoolOptions({
      FINANCIAL_POSTGRES_URL: url,
      FINANCIAL_POSTGRES_CA_FILE: missingPath,
    }),
    error => error.code === 'FINANCIAL_POSTGRES_CA_FILE_UNREADABLE'
      && !error.message.includes(missingPath)
      && !error.message.includes('private'),
  );
});

test('PostgreSQL URLs are validated without echoing malformed input', () => {
  const secretLikeUrl = 'not-a-postgres-url-private-value';
  assert.throws(
    () => createFinancialPostgresPoolOptions({ FINANCIAL_POSTGRES_URL: secretLikeUrl }),
    error => error.code === 'FINANCIAL_POSTGRES_URL_INVALID'
      && !error.message.includes(secretLikeUrl),
  );
});
