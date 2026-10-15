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

test('CI passes the JWT secret through the environment, not shell source', () => {
  for (const [job, name] of [
    ['backend-integration-linux', 'Run Backend Tests & Coverage'],
    ['backend-unit-windows', 'Run Backend Unit Tests (No MongoDB Required)'],
  ]) {
    const step = findStep(job, name);
    assert.equal(step.env?.CI_JWT_SECRET, '${{ secrets.CI_JWT_SECRET }}');
    assert.doesNotMatch(step.run, /\$\{\{\s*secrets\.CI_JWT_SECRET\s*\}\}/);
  }
});

test('Mongo-required suites are partitioned exhaustively between standalone and replica-set requirements', () => {
  const mongoSet = new Set(mongoRequiredTests);
  const replicaSetSet = new Set(replicaSetRequiredTests);
  const standalone = mongoRequiredTests.filter(file => !replicaSetSet.has(file)).sort();

  assert.equal(mongoRequiredTests.length, 30);
  assert.equal(replicaSetRequiredTests.length, 26);
  assert.equal(mongoSet.size, mongoRequiredTests.length, 'Mongo manifest must not contain duplicates');
  assert.equal(replicaSetSet.size, replicaSetRequiredTests.length, 'Replica-set manifest must not contain duplicates');
  assert.ok(replicaSetRequiredTests.every(file => mongoSet.has(file)), 'Replica-set manifest entries must be Mongo-required');
  assert.ok(replicaSetRequiredTests.includes('test/helpers/' + 'mongo' + 'TestHelper.test.js'), 'Mongo helper fallback test requires its replica-set lane');
  assert.deepEqual(standalone, expectedStandaloneMongoTests);
  assert.deepEqual([...new Set([...replicaSetRequiredTests, ...standalone])].sort(), [...mongoRequiredTests].sort());
});

test('Windows separates no-Mongo and standalone-Mongo suites while Linux retains Mongo integration coverage', () => {
  const windowsJob = workflow.jobs['backend-unit-windows'];
  assert.equal(windowsJob['runs-on'], 'windows-latest');
  const windowsRun = findStep('backend-unit-windows', 'Run Backend Unit Tests (No MongoDB Required)');
  assert.match(windowsRun.run, /node scripts\/test-partition\.js no-mongo/);

  const standaloneJob = workflow.jobs['backend-standalone-mongo-windows'];
  assert.equal(standaloneJob['runs-on'], 'windows-latest');
  const standaloneRun = standaloneJob.steps.find(step => step.name === 'Run Backend Standalone Mongo Tests (No Transactions)');
  assert.ok(standaloneRun, 'Expected the Windows standalone Mongo partition');
  assert.match(standaloneRun.run, /node scripts\/test-partition\.js standalone-mongo/);
  assert.equal(standaloneRun.env?.CI_JWT_SECRET, '${{ secrets.CI_JWT_SECRET }}');
  assert.doesNotMatch(standaloneRun.run, /\$\{\{\s*secrets\.CI_JWT_SECRET\s*\}\}/);

  const linuxJob = workflow.jobs['backend-integration-linux'];
  assert.equal(linuxJob['runs-on'], 'ubuntu-latest');
  assert.deepEqual(linuxJob.strategy.matrix['mongodb-version'], ['6.0', '7.0']);
  const phase5Gate = findStep('backend-integration-linux', 'Run explicit Phase 5 Mongo durable-runtime gates');
  assert.equal(phase5Gate.env.MONGODB_URI, 'mongodb://127.0.0.1:27017/wealthgenie_phase5_test?replicaSet=rs0');
  const linuxRun = findStep('backend-integration-linux', 'Run Backend Tests & Coverage');
  assert.equal(linuxRun.env.MONGODB_URI, 'mongodb://127.0.0.1:27017/wealthgenie_test?replicaSet=rs0');
  assert.match(linuxRun.run, /npm run test:coverage/);
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

test('deployment smoke checks the tax comparison using the privacy-safe POST contract', () => {
  const taxSmoke = cdWorkflow.jobs['deploy-and-verify-kind'].steps.find(step =>
    step.run?.includes('Testing Business Endpoint /api/tax/compare'));
  assert.ok(taxSmoke, 'Expected the deployment tax API smoke check');
  assert.match(taxSmoke.run, /--request POST/);
  assert.match(taxSmoke.run, /--header 'Content-Type: application\/json'/);
  assert.match(taxSmoke.run, /--data "\$TAX_BODY"/);
  assert.doesNotMatch(taxSmoke.run, /\/api\/tax\/compare\?income=/);
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
