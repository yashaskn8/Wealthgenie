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

test('rendered browser verification is explicit, loopback-only, and separate from HTTP readiness', () => {
  assert.match(script, /\[switch\]\$RequireBrowser/);
  assert.match(script, /Join-Path \$repoRoot 'scripts\/demoBrowserSmoke\.mjs'/);
  assert.match(script, /\$browserOrigin = "http:\/\/127\.0\.0\.1:\$frontendPort"/);
  assert.match(script, /& \$nodeExe \$browserSmokeScript \$browserOrigin/);
  assert.match(script, /Rendered browser verification failed/);
  assert.match(script, /Frontend HTTP VERIFIED/);
  assert.match(script, /Rendered browser UI NOT VERIFIED/);
  assert.doesNotMatch(script, /AllowAuditBranch/);
});

test('optional ML readiness is loopback-only, secret stays on backend, and never claims inference verification', () => {
  assert.match(script, /\[switch\]\$RequireMlService/);
  assert.match(script, /Get-DotEnvValue \$rootEnvPath 'ML_SERVICE_URL'/);
  assert.match(script, /Get-DotEnvValue \$rootEnvPath 'ML_SERVICE_API_KEY'/);
  assert.match(script, /ML_SERVICE_URL must be a loopback HTTP service origin/);
  assert.match(script, /\$mlUri\.Host -notin @\('127\.0\.0\.1', 'localhost'\)/);
  assert.match(script, /\$mlUri\.UserInfo -or \$mlUri\.Query -or \$mlUri\.Fragment/);
  assert.match(script, /\$mlServiceUrl\/readyz/);
  assert.match(script, /ML service readiness: READY[\s\S]*Model inference and API-key authorization were not exercised/);
  assert.match(script, /Required local Python ML service readiness or ML_SERVICE_API_KEY is unavailable/);
  assert.match(script, /ML_SERVICE_API_KEY = \$mlServiceApiKey/);
  assert.doesNotMatch(script.slice(script.indexOf('$frontendEnv = @{')), /ML_SERVICE_API_KEY/);
  const mongoVerified = script.indexOf('MongoDB VERIFIED:');
  const readinessProbe = script.indexOf('$mlHealth = Invoke-RestMethod');
  assert.ok(readinessProbe > mongoVerified, 'ML readiness is checked only after isolated MongoDB verification');
});

test('launcher persists ownership before browser smoke so a failed smoke can be retried safely', () => {
  const ownershipWrite = script.indexOf('$processState | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8');
  const browserSmoke = script.indexOf('& $nodeExe $browserSmokeScript $browserOrigin 2>&1');
  const successWrite = script.indexOf('$processState.browserVerified = $true');
  assert.ok(ownershipWrite >= 0);
  assert.ok(browserSmoke > ownershipWrite);
  assert.ok(successWrite > browserSmoke);
  assert.match(script, /browserVerified = \$false/);
});

test('local demo explicitly pins MongoDB account database and keeps legacy storage recoverable', () => {
  assert.match(script, /MONGODB_EXPECTED_DATABASE = \$expectedDatabase/);
  assert.match(script, /\[switch\]\$UseDurableMongoStorage/);
  assert.match(script, /Join-Path \$env:LOCALAPPDATA 'WealthGenie\/demo-mongo'/);
  assert.match(script, /No account or data was moved/);
  assert.match(script, /Invoke-MongoIdentityCheck/);
});

test('local expo launcher enables private Upstox only via an explicit guarded switch and server-only token', () => {
  assert.match(script, /\[switch\]\$EnablePrivateUpstoxQuotes/);
  assert.match(script, /Get-DotEnvValue \$rootEnvPath 'UPSTOX_ANALYTICS_TOKEN'/);
  assert.match(script, /Get-DotEnvValue \$rootEnvPath 'UPSTOX_ACCESS_TOKEN'/);
  assert.match(script, /Private Upstox quotes require UPSTOX_ANALYTICS_TOKEN or UPSTOX_ACCESS_TOKEN/);
  assert.match(script, /MARKET_DATA_PRIVATE_DEMO_ENABLED = \$\(if \(\$EnablePrivateUpstoxQuotes\) \{ 'true' \} else \{ 'false' \}\)/);
  assert.match(script, /UPSTOX_PUBLIC_MARKET_DATA_LICENSE_CONFIRMED = 'false'/);
  assert.match(script, /\$priorProcessState\.privateUpstoxEnabled -eq \[bool\]\$EnablePrivateUpstoxQuotes/);
  assert.match(script, /privateUpstoxEnabled = \[bool\]\$EnablePrivateUpstoxQuotes/);
  assert.match(script, /LIVE PROVIDER CONNECTIVITY NOT VERIFIED/);
  const serverEnv = script.slice(script.indexOf('$commonEnv = @{'), script.indexOf('$frontendEnv = @{'));
  const frontendEnv = script.slice(script.indexOf('$frontendEnv = @{'), script.indexOf('if ($sourceSha) { $frontendEnv'));
  assert.match(serverEnv, /\$commonEnv\.UPSTOX_ANALYTICS_TOKEN = \$upstoxAnalyticsToken/);
  assert.doesNotMatch(frontendEnv, /UPSTOX_.*TOKEN|MARKET_DATA_PRIVATE_DEMO_ENABLED/);
});
