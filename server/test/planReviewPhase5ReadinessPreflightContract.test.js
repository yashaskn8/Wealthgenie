import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const preflight = fs.readFileSync(path.join(root, 'server/scripts/verifyPlanReviewDemoReadiness.js'), 'utf8');
const launcher = fs.readFileSync(path.join(root, 'scripts/start_local_demo.ps1'), 'utf8');
const runbook = fs.readFileSync(path.join(root, 'docs/operations/plan-review-recovery.md'), 'utf8');

test('Plan Review demo preflight verifies both Phase 4 and Phase 5 without schema mutations', () => {
  assert.match(preflight, /verifyPlanReviewPersistenceIndexes\(\{ force: true \}\)/);
  assert.match(preflight, /verifyAgentRuntimePersistence\(\{ force: true \}\)/);
  assert.match(preflight, /autoIndex: false, autoCreate: false/);
  assert.match(preflight, /url\.hostname !== '127\.0\.0\.1'/);
  assert.match(preflight, /url\.pathname !== '\/wealthgenie-demo'/);
  assert.doesNotMatch(preflight, /migratePlanReviewPersistenceIndexes|migratePlanHealthPersistence/);
  assert.doesNotMatch(preflight, /createIndexes\(|syncIndexes\(|dropIndex\(|updateOne\(/);
});

test('the isolated launcher refuses opt-in Plan Review when the queue preflight fails', () => {
  assert.match(launcher, /if \(\$EnablePlanReview\) \{/);
  assert.match(launcher, /Start-HiddenProcess \$nodeExe 'scripts\/verifyPlanReviewDemoReadiness\.js'/);
  assert.match(launcher, /WaitForExit\(20000\)/);
  assert.match(launcher, /Phase 4\/5 persistence preflight failed/);
  assert.ok(launcher.indexOf('verifyPlanReviewDemoReadiness.js') < launcher.indexOf('if (Test-ListeningPort $backendPort)'));
  assert.doesNotMatch(launcher, /migratePlanReviewIndexes\.js|migratePhase5AgentRuntimeIndexes\.js/);
});

test('runbook requires explicit backed-up Phase 4 and Phase 5 migrations', () => {
  assert.match(runbook, /migratePlanReviewIndexes\.js/);
  assert.match(runbook, /migratePhase5AgentRuntimeIndexes\.js/);
  assert.match(runbook, /Back up and inspect/);
  assert.match(runbook, /AGENT_QUEUE_ADMISSION_UNAVAILABLE/);
});
