import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.readFileSync(path.join(projectRoot, '.github/workflows/cd.yml'), 'utf8');
const parsed = parseDocument(source, { uniqueKeys: true, strict: true });

test('CD workflow is syntactically valid and only watches main CI completion', () => {
  assert.deepEqual(parsed.errors.map(error => error.message), []);
  const workflow = parsed.toJS();
  assert.deepEqual(workflow.on.workflow_run.workflows, ['CI']);
  assert.deepEqual(workflow.on.workflow_run.types, ['completed']);
  assert.deepEqual(workflow.on.workflow_run.branches, ['main']);
  assert.ok(workflow.on.workflow_dispatch, 'explicit isolated Kind run remains available');
  assert.equal(workflow.permissions.contents, 'read');
});

test('automatic Kind verification refuses failed, foreign, PR and superseded CI builds', () => {
  const workflow = parsed.toJS();
  const job = workflow.jobs['deploy-and-verify-kind'];
  const gate = job.if;
  for (const required of [
    "github.event_name == 'workflow_dispatch'",
    "github.event_name == 'workflow_run'",
    "github.event.workflow_run.event == 'push'",
    "github.event.workflow_run.conclusion == 'success'",
    "github.event.workflow_run.head_branch == 'main'",
    'github.event.workflow_run.head_repository.full_name == github.repository',
    'github.event.workflow_run.head_sha == github.sha',
  ]) {
    assert.ok(gate.includes(required), 'missing deployment restriction: ' + required);
  }
  const checkout = job.steps.find(step => step.name === 'Checkout Source Code');
  assert.ok(checkout, 'must checkout the CI-verified source');
  assert.match(checkout.with.ref, /github\.event\.workflow_run\.head_sha/);
  assert.match(checkout.with.ref, /github\.sha/);
  assert.equal(checkout.with['persist-credentials'], false);
  assert.ok(job.steps.some(step => step.name === 'Validate Terraform IaC'));
});
