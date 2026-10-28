import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.readFileSync(path.join(projectRoot, '.github/workflows/cd.yml'), 'utf8');
const parsed = parseDocument(source, { uniqueKeys: true, strict: true });

test('CD workflow requires same-commit main CI and feature safety completion', () => {
  assert.deepEqual(parsed.errors.map(error => error.message), []);
  const workflow = parsed.toJS();
  assert.deepEqual(workflow.on.workflow_run.workflows, ['CI']);
  assert.deepEqual(workflow.on.workflow_run.types, ['completed']);
  assert.deepEqual(workflow.on.workflow_run.branches, ['main']);
  assert.ok(workflow.on.workflow_dispatch, 'explicit isolated Kind run remains available');
  assert.equal(workflow.permissions.contents, 'read');
  assert.equal(workflow.permissions.actions, 'read');
  assert.deepEqual(Object.keys(workflow.jobs), ['release-quality-gate', 'deploy-and-verify-kind']);
});

test('automatic Kind verification refuses failed, foreign, PR and superseded CI builds', () => {
  const workflow = parsed.toJS();
  const job = workflow.jobs['deploy-and-verify-kind'];
  const gate = job.if;
  assert.equal(job.needs, 'release-quality-gate');
  assert.ok(gate.includes("needs.release-quality-gate.outputs.ready == 'true'"));
  const releaseGate = workflow.jobs['release-quality-gate'];
  const check = releaseGate.steps.find(step => step.id === 'check');
  assert.ok(check?.run.includes("workflow in ci.yml genievoice-quality.yml coverage-firewall-ci.yml"));
  assert.equal(releaseGate['timeout-minutes'], 25);
  assert.match(check.run, /for attempt in \$\(seq 1 90\); do/);
  assert.match(check.run, /case "\$conclusion" in/);
  assert.match(check.run, /pending\)/);
  assert.match(check.run, /timed out waiting for all same-commit main checks/);
  assert.match(check.run, /sleep 10/);
  assert.match(check.run, /exit 1/);
  // A superseded or failed CI run must never make CD appear green with a skipped Kind job.
  assert.equal(check.env.SOURCE_CI_SUCCESS,
    "${{ github.event_name == 'workflow_dispatch' || (github.event_name == 'workflow_run' && github.event.workflow_run.conclusion == 'success') }}");
  assert.match(check.run, /\$SOURCE_CI_SUCCESS\" != 'true'/);
  assert.match(check.run, /::error::Release gate: this commit was superseded on main/);
  assert.doesNotMatch(check.run, /superseded on main[^\n]*\n\s*exit 0/);
  assert.ok(check.run.includes("-f head_sha=\"$VERIFIED_SHA\""));
  assert.ok(check.run.includes("-f event=push"));
  assert.ok(check.run.includes("latest_sha=\"$(gh api"));
  assert.ok(check.run.includes("echo 'ready=true' >> \"$GITHUB_OUTPUT\""));
  for (const required of [
    "github.event_name == 'workflow_dispatch'",
    "github.event_name == 'workflow_run'",
    "github.event.workflow_run.event == 'push'",
    "github.event.workflow_run.conclusion == 'success'",
    "github.event.workflow_run.head_branch == 'main'",
    'github.event.workflow_run.head_repository.full_name == github.repository',
  ]) {
    assert.ok(gate.includes(required), 'missing deployment restriction: ' + required);
  }
  const checkout = job.steps.find(step => step.name === 'Checkout Source Code');
  assert.ok(checkout, 'must checkout the CI-verified source');
  assert.match(checkout.with.ref, /github\.event\.workflow_run\.head_sha/);
  assert.match(checkout.with.ref, /github\.sha/);
  assert.equal(checkout.with['persist-credentials'], false);
  // workflow_run github.sha is the latest default-branch SHA, which can differ
  // from the successful CI run. Every deployment identity uses that CI SHA.
  assert.equal(job.env.RELEASE_SHA,
    "${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_sha || github.sha }}");
  assert.ok(!gate.includes('github.event.workflow_run.head_sha == github.sha'));
  assert.ok(job.steps.some(step => step.name === 'Verify the release commit is still current main'));
  const verifyHead = job.steps.find(step => step.name === 'Verify the release commit is still current main');
  assert.match(verifyHead.run, /\$RELEASE_SHA/);
  assert.match(verifyHead.run, /\$CURRENT_MAIN/);
  assert.equal(source.includes('$GITHUB_SHA'), false);
  assert.equal(job.steps.find(step => step.name.startsWith('Execute complete Phase 15'))
    .env.DEMO_EXPECTED_BUILD_SHA, "${{ env.RELEASE_SHA }}");
  assert.ok(job.steps.some(step => step.name === 'Validate Terraform IaC'));
});
