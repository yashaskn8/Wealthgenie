import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const launcher = readFileSync(new URL('../../scripts/start_local_demo.ps1', import.meta.url), 'utf8');

test('Windows local demo accepts only canonical owned origin and exact opt-in audit branch', () => {
  assert.match(launcher, /'https:\/\/github\.com\/yashaskn8\/Wealthgenie\.git'/);
  assert.match(launcher, /'git@github\.com:yashaskn8\/Wealthgenie\.git'/);
  assert.match(launcher, /\[switch\]\$AllowAuditBranch/);
  assert.match(launcher, /\$expectedBranch = if \(\$AllowAuditBranch\) \{ 'audit\/market-data-fail-closed-diagnostics-20261018' \} else \{ 'main' \}/);
  assert.match(launcher, /\$remote -cnotin \$expectedOrigins/);
  assert.match(launcher, /\$branch -cne \$expectedBranch/);
  assert.equal((launcher.match(/\$priorProcessState\.branch -ceq \$expectedBranch/g) || []).length, 2,
    'both server and frontend process reuse must be fenced by the exact selected branch');
  assert.doesNotMatch(launcher, /\$expectedOrigin = 'https:\/\/github\.com\/yashaskn8\/WealthGenie-AI-Powered-Financial-AdvisoryPlatform\.git'/);
});

test('local presentation startup retains previously verified and isolated MongoDB invariants', () => {
  assert.match(launcher, /previously verified demo MongoDB data directory is missing/);
  assert.match(launcher, /expectedDatabase = 'wealthgenie-demo'/);
  assert.match(launcher, /expectedPort = 27030/);
  assert.match(launcher, /expectedReplicaSet = 'rs0'/);
  assert.match(launcher, /read-only transaction PASS/);
  assert.match(launcher, /-ne 'DEMO_DATABASE_VERIFIED'/);
  assert.match(launcher, /Browser rendering, protected screens, and account journeys require a separate Playwright run/);
});
