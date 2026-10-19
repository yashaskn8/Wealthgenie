import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const script = fs.readFileSync(path.resolve(testDir, '../../scripts/start_local_demo.ps1'), 'utf8');

test('local demo launcher pins the active repository and never accepts archived origins', () => {
  assert.match(script, /github\.com\/yashaskn8\/Wealthgenie\.git/i);
  assert.match(script, /git@github\.com:yashaskn8\/Wealthgenie\.git/i);
  assert.doesNotMatch(script, /WealthGenie-AI-Powered-Financial-AdvisoryPlatform\.git/);
  assert.match(script, /\$remote -notin \$expectedOrigins -or \$branch -ne 'main'/);
});

test('local Plan Review is explicit opt-in with both worker and feature, and disabled by default', () => {
  assert.match(script, /\[switch\]\$EnablePlanReview/);
  assert.match(script, /AGENTIC_PLAN_REVIEW_ENABLED = \$\(if \(\$EnablePlanReview\) \{ 'true' \} else \{ 'false' \}\s*\)/);
  assert.match(script, /AGENT_WORKER_ENABLED = \$\(if \(\$EnablePlanReview\) \{ 'true' \} else \{ 'false' \}\s*\)/);
  assert.match(script, /AGENT_WORKER_MODE = 'embedded'/);
  assert.doesNotMatch(script, /AGENTIC_PLAN_REVIEW_ENABLED = 'true'/);
  assert.doesNotMatch(script, /AGENT_WORKER_ENABLED = 'true'/);
});

test('demo launcher keeps verified MongoDB and no-write protections', () => {
  assert.match(script, /Invoke-MongoIdentityCheck/);
  assert.match(script, /expectedDatabase = 'wealthgenie-demo'/);
  assert.match(script, /expectedReplicaSet = 'rs0'/);
  assert.match(script, /existing verified demo database identity/);
  assert.doesNotMatch(script, /migratePlanReviewIndexes/);
});
