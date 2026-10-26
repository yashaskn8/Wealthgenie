import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const source = fs.readFileSync(path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '../openapi.yaml',
), 'utf8');

test('OpenAPI is a single parseable document with one declared history route per operation', () => {
  const yaml = parseDocument(source, { uniqueKeys: true, strict: true });
  assert.deepEqual(yaml.errors.map(error => error.message), []);
  const doc = yaml.toJS();
  assert.equal(doc.openapi, '3.1.0');
  assert.equal((source.match(/^openapi:/gm) || []).length, 1, 'OpenAPI header duplicated');
  assert.equal((source.match(/^paths:/gm) || []).length, 1, 'OpenAPI paths block duplicated');
  assert.equal((source.match(/^components:/gm) || []).length, 1, 'OpenAPI components block duplicated');
  assert.equal((source.match(/^  \/api\//gm) || []).length,
    Object.keys(doc.paths).filter(route => route.startsWith('/api/')).length,
    'Path declarations are missing or duplicated');
  assert.ok(source.length < 320_000, 'API specification unexpectedly multiplied');
  for (const route of [
    '/api/market-data/admin/equity-history',
    '/api/market-data/admin/equity-history/ingest',
    '/api/market-data/equity-history/persisted',
  ]) {
    assert.equal(source.split('  ' + route + ':').length - 1, 1, route);
    assert.ok(doc.paths[route], route);
  }
  assert.equal(doc.paths['/api/market-data/equity-history/persisted'].get.security.length > 0, true);
  const ingest = doc.paths['/api/market-data/admin/equity-history/ingest'].post;
  assert.deepEqual(ingest['x-required-roles'], ['admin']);
  assert.equal(ingest['x-csrf-protection'], 'cookie-session');
  assert.ok(ingest.requestBody.required);
  assert.ok(ingest.responses['201']);
  assert.equal(doc.paths['/api/market-data/admin/tejhq/status'], undefined);
});
