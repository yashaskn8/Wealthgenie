import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dockerfile = fs.readFileSync(path.join(root, 'reactapp/Dockerfile'), 'utf8');
const app = fs.readFileSync(path.join(root, 'reactapp/src/App.jsx'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server/app.js'), 'utf8');
const productionDocs = fs.readFileSync(path.join(root, 'deploy/production/README.md'), 'utf8');

test('production frontend compiles private workspaces only with explicit build-time opt-ins', () => {
  for (const name of ['VITE_RUNWAY_ENABLED', 'VITE_COVERAGE_ENABLED']) {
    assert.ok(dockerfile.includes(`ARG ${name}=false`),
      `${name} must default off in the production Docker build`);
    assert.ok(dockerfile.includes('ENV ' + name + '=${' + name + '}'),
      `${name} must be present in Vite's build environment`);
    assert.match(productionDocs, new RegExp(name));
  }
  assert.match(app, /VITE_RUNWAY_ENABLED === 'true'/);
  assert.match(app, /VITE_COVERAGE_ENABLED === 'true'/);
  assert.match(server, /RUNWAY_ENABLED === 'true'/);
  assert.match(server, /COVERAGE_ENABLED === 'true'/);
});

test('production rollout documentation preserves release, secret and scope boundaries', () => {
  for (const phrase of ['RUNWAY_INTEGRITY_SECRET', 'RUNWAY_EVIDENCE_KEY_V1',
    'GENIEVOICE_TASKS_ENABLED', 'GENIEVOICE_RECEIPTS_ENABLED',
    'operator-approved', 'Kind']) assert.ok(productionDocs.includes(phrase), phrase);
});
