import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflowPath = path.join(projectRoot, '.github/workflows/ci.yml');
const workflow = parse(readFileSync(workflowPath, 'utf8'));
const cdWorkflow = parse(readFileSync(path.join(projectRoot, '.github/workflows/cd.yml'), 'utf8'));
const mongoRequiredTests = JSON.parse(readFileSync(path.join(projectRoot, 'server/scripts/mongo-required-tests.json'), 'utf8'));
const replicaSetRequiredTests = JSON.parse(readFileSync(path.join(projectRoot, 'server/scripts/replica-set-required-tests.json'), 'utf8'));
const testPartitionSource = readFileSync(path.join(projectRoot, 'server/scripts/test-partition.js'), 'utf8');
const expectedStandaloneMongoTests = [
  'test/chatSessionStore.integration.test.js',
  'test/marketRefreshAccess.test.js',
  'test/planReviewIndexMongo.integration.test.js',
  'test/recommendationAuditProvenanceRoutes.test.js',
].sort();

function findStep(job, name) {
  const step = workflow.jobs[job]?.steps?.find(candidate => candidate.name === name);
  assert.ok(step, `Expected workflow step ${job}/${name}`);
  return step;
}

test('CI uses an ephemeral backend JWT and exposes no repository secret to pull-request tests', () => {
  const step = findStep('backend-financial-integrity', 'Run Backend Tests & Coverage');
  assert.match(step.run, /export JWT_SECRET="\$\(openssl rand -hex 32\)"/);
  assert.doesNotMatch(step.run, /\$\{\{\s*secrets\./);
  assert.ok(!Object.hasOwn(step.env, 'CI_JWT_SECRET'));
});

test('Mongo-required suites are partitioned exhaustively between standalone and replica-set requirements', () => {
  const mongoSet = new Set(mongoRequiredTests);
  const replicaSetSet = new Set(replicaSetRequiredTests);
  const standalone = mongoRequiredTests.filter(file => !replicaSetSet.has(file)).sort();

  assert.equal(mongoRequiredTests.length, 33);
  assert.equal(replicaSetRequiredTests.length, 29);
  assert.ok(replicaSetSet.has('test/genieDecisionPersistenceMongo.integration.test.js'),
    'GenieDecision integration must use Mongo replica-set tests');
  assert.ok(replicaSetSet.has('test/qualifiedEquityHistoryMongo.integration.test.js'));
  assert.ok(replicaSetSet.has('test/goalFinanceRoutes.test.js'), 'Goals integration must run under MongoDB replica set');
  assert.equal(mongoSet.size, mongoRequiredTests.length, 'Mongo manifest must not contain duplicates');
  assert.equal(replicaSetSet.size, replicaSetRequiredTests.length, 'Replica-set manifest must not contain duplicates');
  assert.ok(replicaSetRequiredTests.every(file => mongoSet.has(file)), 'Replica-set manifest entries must be Mongo-required');
  assert.ok(replicaSetRequiredTests.includes('test/helpers/' + 'mongo' + 'TestHelper.test.js'), 'Mongo helper fallback test requires its replica-set lane');
  assert.deepEqual(standalone, expectedStandaloneMongoTests);
  assert.deepEqual([...new Set([...replicaSetRequiredTests, ...standalone])].sort(), [...mongoRequiredTests].sort());
});

test('five Linux CI jobs retain Mongo-backed integrity and isolated financial PostgreSQL coverage', () => {
  assert.deepEqual(Object.keys(workflow.jobs), [
    'backend-financial-integrity', 'finance-postgres-integration',
    'frontend-quality', 'ai-ml-rag-safety', 'integration-security',
  ]);
  const financialSql = workflow.jobs['finance-postgres-integration'];
  assert.match(financialSql.services?.postgres?.image || '', /^postgres:16@sha256:[a-f0-9]{64}$/);
  assert.equal(financialSql.services.postgres.env.POSTGRES_DB, 'wealthgenie_financial_test');
  assert.equal(financialSql.env.FINANCIAL_POSTGRES_TEST_MODE, 'true');
  assert.match(financialSql.env.FINANCIAL_POSTGRES_URL, /\/wealthgenie_financial_test$/);
  assert.ok(financialSql.steps.some(step => step.run === 'npm ci --prefix server'));
  assert.ok(financialSql.steps.some(step => step.run === 'npm run finance:pg:migrate --prefix server'));
  assert.ok(financialSql.steps.some(step => step.run === 'npm run finance:pg:seed --prefix server'));
  assert.ok(financialSql.steps.some(step => step.run === 'node server/scripts/verifyFinancialPostgresIntegration.js'));
  assert.ok(!financialSql.steps.some(step => (step.run || '').includes('secrets.')),
    'SQL integration lane must not use live production provider secrets');
  assert.ok(Object.values(workflow.jobs).every(job => job['runs-on'] === 'ubuntu-latest' && !job.strategy));
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.deepEqual(workflow.on.pull_request.branches, ['main']);
  assert.ok(Object.hasOwn(workflow.on, 'workflow_dispatch'));

  const backend = workflow.jobs['backend-financial-integrity'];
  assert.equal(backend.steps.find(step => step.name === 'Start MongoDB 7 replica set')?.with?.['mongodb-version'], '7.0');
  const backendRun = findStep('backend-financial-integrity', 'Run Backend Tests & Coverage');
  assert.equal(backendRun.env.MONGODB_URI, 'mongodb://127.0.0.1:27017/wealthgenie_test?replicaSet=rs0');
  assert.match(backendRun.run, /node server\/scripts\/test-partition\.js verify/);
  assert.match(backendRun.run, /npm run test:coverage --prefix server/);

  const integration = workflow.jobs['integration-security'];
  assert.equal(integration.env.MARKET_DATA_MODE, 'UPSTOX_ONLY');
  assert.equal(integration.env.UPSTOX_PUBLIC_MARKET_DATA_LICENSE_CONFIRMED, 'false');
  assert.equal(integration.steps.find(step => step.name === 'Start transaction-capable MongoDB')?.with?.['mongodb-version'], '7.0');
  assert.match(findStep('integration-security', 'Start Redis for browser and MCP integration').run, /docker compose up -d redis/);
  assert.match(findStep('integration-security', 'Verify Redis-backed MCP rate and lease fencing').run, /testMcpRedisCapacity\.js/);
  assert.ok(integration.steps.some(step => step.name === 'Run real-dependency Playwright lifecycle'));
  assert.ok(integration.steps.some(step => step.name === 'Run production-edge Playwright test through Nginx'));
  assert.equal(findStep('integration-security', 'Audit Python dependencies').if, '${{ !cancelled() }}');
  assert.ok(integration.steps.some(step => step.name === 'Audit frontend npm dependencies'));
  assert.ok(integration.steps.some(step => step.name === 'Audit backend npm dependencies'));
});

test('Kind deployment runs only on successful main CI or explicit manual dispatch, with strict live preflight opt-in', () => {
  assert.deepEqual(Object.keys(cdWorkflow.on), ['workflow_run', 'workflow_dispatch']);
  assert.deepEqual(cdWorkflow.on.workflow_run, {
    workflows: ['CI'],
    types: ['completed'],
    branches: ['main'],
  });
  assert.equal(cdWorkflow.on.workflow_dispatch.inputs.run_live_market_preflight.default, false);
  assert.deepEqual(Object.keys(cdWorkflow.jobs), ['deploy-and-verify-kind']);

  const gate = cdWorkflow.jobs['deploy-and-verify-kind'].if;
  for (const required of [
    "github.event_name == 'workflow_dispatch'",
    "github.event_name == 'workflow_run'",
    "github.event.workflow_run.event == 'push'",
    "github.event.workflow_run.conclusion == 'success'",
    "github.event.workflow_run.head_branch == 'main'",
    'github.event.workflow_run.head_repository.full_name == github.repository',
    'github.event.workflow_run.head_sha == github.sha',
  ]) {
    assert.ok(gate.includes(required), 'Missing CD gate condition: ' + required);
  }
});

test('standalone Mongo partition owns and stops a disposable 7.0.5 loopback _test server', () => {
  const memoryServerStartPattern = new RegExp(['Mongo', 'Memory', 'Server', '\\.create\\(\\{\\s*binary:\\s*\\{\\s*version:\\s*\'7\\.0\\.5\''].join(''));
  assert.match(testPartitionSource, memoryServerStartPattern);
  assert.match(testPartitionSource, /mongoServer\.getUri\(databaseName\)/);
  assert.match(testPartitionSource, /assertDisposableLoopbackMongoUri\(uri\)/);
  assert.match(testPartitionSource, /targetDatabase !== databaseName/);
  assert.match(testPartitionSource, /hostname === 'localhost'/);
  assert.match(testPartitionSource, /isIP\(hostname\) === 4/);
  assert.match(testPartitionSource, /finally\s*\{[\s\S]*?await mongoServer\.stop\(\)/);
  assert.match(testPartitionSource, /...standaloneMongoTests/);
  assert.match(testPartitionSource, /expectedStandalone\) !== JSON\.stringify\(standaloneMongoTests\)/);
});

test('deployment smoke checks the verified new-only tax calculator using POST', () => {
  const taxSmoke = cdWorkflow.jobs['deploy-and-verify-kind'].steps.find(step =>
    step.run?.includes('Testing Verified New-Regime Endpoint /api/tax/new-regime-verified'));
  assert.ok(taxSmoke, 'Expected the deployment tax API smoke check');
  assert.match(taxSmoke.run, /--request POST/);
  assert.match(taxSmoke.run, /--header 'Content-Type: application\/json'/);
  assert.match(taxSmoke.run, /--data "\$TAX_BODY"/);
  assert.doesNotMatch(taxSmoke.run, /\/api\/tax\/new-regime-verified\?income=/);
});

test('deployment load probe runs lockfile-installed autocannon from the server workspace', () => {
  const steps = cdWorkflow.jobs['deploy-and-verify-kind'].steps;
  const installIndex = steps.findIndex(step => step.run === 'npm ci --prefix server');
  const loadIndex = steps.findIndex(step => step.run?.includes('Generating 15s synthetic compute load'));
  assert.ok(installIndex >= 0, 'Expected npm ci to install the locked server dependencies');
  assert.ok(loadIndex > installIndex, 'Expected autocannon to run after the server dependency install');

  const loadProbe = steps[loadIndex].run;
  assert.match(loadProbe, /npm exec --prefix server -- autocannon\s+-c 40 -d 15/);
  assert.ok(loadProbe.includes('-m POST'), 'Expected the synthetic load probe to exercise the POST tax contract');
  assert.ok(loadProbe.includes("-H 'content-type=application/json'"), 'Expected JSON content type for the tax request');
  assert.ok(loadProbe.includes('-b "$TAX_BODY"'), 'Expected the synthetic tax request body');
  assert.doesNotMatch(loadProbe, /\bnpx\s+autocannon\b/, 'Do not fetch an unpinned autocannon via root-level npx');

  const serverPackage = JSON.parse(readFileSync(path.join(projectRoot, 'server/package.json'), 'utf8'));
  const serverLock = JSON.parse(readFileSync(path.join(projectRoot, 'server/package-lock.json'), 'utf8'));
  assert.ok(serverPackage.devDependencies.autocannon, 'Expected autocannon as a server workspace dependency');
  assert.equal(serverLock.packages['node_modules/autocannon']?.version, '8.0.0');
});
