import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const source = fs.readFileSync(path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '../openapi.yaml',
), 'utf8');

test('OpenAPI is a single parseable document and market histories are not duplicated', () => {
  const yaml = parseDocument(source, { uniqueKeys: true, strict: true });
  assert.deepEqual(yaml.errors.map(error => error.message), []);
  const doc = yaml.toJS();
  assert.equal(doc.openapi, '3.1.0');
  assert.ok(source.length < 260_000, 'API specification unexpectedly duplicated during generation');
  for (const route of [
    '/api/market-data/admin/equity-history',
    '/api/market-data/admin/equity-history/ingest',
    '/api/market-data/equity-history/persisted',
    '/api/market-data/admin/tejhq/corporate-actions',
  ]) {
    const canonical = '  ' + route + ':';
    assert.equal(source.split(canonical).length - 1, 1, route + ' appears more than once');
    assert.ok(doc.paths[route], 'Missing declared OpenAPI route ' + route);
  }
  assert.equal(doc.paths['/api/market-data/equity-history/persisted'].get.security.length > 0, true);
  const ingest = doc.paths['/api/market-data/admin/equity-history/ingest'].post;
  assert.deepEqual(ingest['x-required-roles'], ['admin']);
  assert.equal(ingest['x-csrf-protection'], 'cookie-session');
  assert.ok(ingest.requestBody.required);
  assert.ok(ingest.responses['201']);
});
