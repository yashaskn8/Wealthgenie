import { spawn, spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(scriptDir, '..');
const testDir = path.join(serverDir, 'test');
const mode = process.argv[2];
const mongoManifestPath = path.join(scriptDir, 'mongo-required-tests.json');
const replicaSetManifestPath = path.join(scriptDir, 'replica-set-required-tests.json');
const mongoManifest = JSON.parse(await readFile(mongoManifestPath, 'utf8'));
const replicaSetManifest = JSON.parse(await readFile(replicaSetManifestPath, 'utf8'));

// These suites need MongoDB but are explicitly qualified to run against a
// standalone server. Keep this allowlist small and review any change alongside
// the replica-set manifest.
const standaloneMongoTests = [
  'test/chatSessionStore.integration.test.js',
  'test/marketRefreshAccess.test.js',
  'test/planReviewIndexMongo.integration.test.js',
  'test/recommendationAuditProvenanceRoutes.test.js',
].sort();

async function collectTestFiles(directory, relativeTo = serverDir) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async entry => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectTestFiles(absolutePath, relativeTo);
    if (!entry.isFile() || !entry.name.endsWith('.test.js')) return [];
    return [path.relative(relativeTo, absolutePath).split(path.sep).join('/')];
  }));
  return nested.flat().sort();
}

const testFiles = await collectTestFiles(testDir);
const mongoDependencyPatterns = [
  /\bsetupTestDatabase\s*\(/,
  /\bmongoTestHelper\b/,
  /\bmongoose\.connect\s*\(/,
  /\bMongoClient\.connect\s*\(/,
  /\b(?:MongoMemoryServer|MongoMemoryReplSet|MongoDBContainer)\b/,
  /\brequireReplicaSet\s*[:=]/,
];
const mongoRequired = [];
for (const file of testFiles) {
  const source = await readFile(path.join(serverDir, file), 'utf8');
  if (mongoDependencyPatterns.some(pattern => pattern.test(source))) {
    mongoRequired.push(file);
  }
}

const expectedMongo = [...mongoManifest].sort();
const expectedReplicaSet = [...replicaSetManifest].sort();
const replicaSetSet = new Set(expectedReplicaSet);
const expectedStandalone = expectedMongo.filter(file => !replicaSetSet.has(file));
const duplicateMongoEntries = expectedMongo.length !== new Set(expectedMongo).size;
const duplicateReplicaSetEntries = expectedReplicaSet.length !== replicaSetSet.size;
const replicaSetContainsNonMongo = expectedReplicaSet.filter(file => !expectedMongo.includes(file));
const mongoManifestMatches = JSON.stringify(mongoRequired) === JSON.stringify(expectedMongo);
// This helper test file intentionally includes default-mode probes as well as a replica-set fallback test.
const mixedReplicaSetHelperTest = 'test/helpers/mongoTestHelper.test.js';
const replicaSetGuardFailures = [];
for (const file of expectedReplicaSet) {
  const testSource = await readFile(path.join(serverDir, file), 'utf8');
  const setupCalls = [...testSource.matchAll(/\bsetupTestDatabase\s*\(([^()]*)\)/g)];
  const guardedCalls = setupCalls.filter(([, args]) => /\brequireReplicaSet\s*:\s*true\b/.test(args));
  const allCallsGuarded = file === mixedReplicaSetHelperTest
    ? guardedCalls.length > 0
    : setupCalls.length > 0 && guardedCalls.length === setupCalls.length;
  if (!allCallsGuarded) replicaSetGuardFailures.push(file);
}
if (!mongoManifestMatches || duplicateMongoEntries) {
  console.error('Mongo test partition manifest is stale.');
  console.error(`Detected: ${JSON.stringify(mongoRequired)}`);
  console.error(`Manifest: ${JSON.stringify(expectedMongo)}`);
  process.exit(1);
}

if (duplicateReplicaSetEntries
  || replicaSetGuardFailures.length > 0
  || replicaSetContainsNonMongo.length > 0
  || JSON.stringify(expectedStandalone) !== JSON.stringify(standaloneMongoTests)
  || expectedReplicaSet.length + expectedStandalone.length !== expectedMongo.length) {
  console.error('Replica-set and standalone Mongo manifests must be a disjoint, exhaustive partition of Mongo-required suites.');
  console.error(`Mongo-required (${expectedMongo.length}): ${JSON.stringify(expectedMongo)}`);
  console.error(`Replica-set-required (${expectedReplicaSet.length}): ${JSON.stringify(expectedReplicaSet)}`);
  console.error(`Standalone-compatible (${expectedStandalone.length}): ${JSON.stringify(expectedStandalone)}`);
  console.error(`Expected standalone-compatible: ${JSON.stringify(standaloneMongoTests)}`);
  if (replicaSetGuardFailures.length > 0) {
    console.error('Replica-set suites missing setupTestDatabase({ requireReplicaSet: true }): ' + JSON.stringify(replicaSetGuardFailures));
  }
  if (replicaSetContainsNonMongo.length > 0) {
    console.error(`Replica-set manifest entries not in Mongo manifest: ${JSON.stringify(replicaSetContainsNonMongo)}`);
  }
  process.exit(1);
}

if (mode === 'verify') {
  const packageJson = JSON.parse(await readFile(path.join(serverDir, 'package.json'), 'utf8'));
  const fullSuiteScripts = ['test', 'test:unit', 'test:coverage', 'test:coverage:unit'];
  const scriptsUseFullPartition = fullSuiteScripts.every(scriptName => {
    const command = packageJson.scripts?.[scriptName] || '';
    return /\bnode\s+scripts\/test-partition\.js\s+full(?:\s|$)/.test(command);
  });
  if (!scriptsUseFullPartition) {
    console.error('All backend test scripts must select the full explicit *.test.js partition.');
    process.exit(1);
  }
  console.log(`Mongo partition verified: ${mongoRequired.length} Mongo-required suites are exhaustive; ${expectedStandalone.length} are standalone-compatible and ${expectedReplicaSet.length} require a replica set.`);
  process.exit(0);
}

if (mode === 'full') {
  console.log(`Running the full backend suite: ${testFiles.length} explicit *.test.js files.`);
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...testFiles], {
    cwd: serverDir,
    env: { ...process.env, NODE_ENV: 'test' },
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}

if (mode === 'standalone-mongo') {
  const databaseName = 'wealthgenie_standalone_partition_test';

  function assertDisposableLoopbackMongoUri(uri) {
    let parsed;
    try {
      parsed = new URL(uri);
    } catch {
      throw new Error('Standalone Mongo partition generated an invalid database URI.');
    }

    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const loopback = hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || hostname === '::1'
      || hostname === '0:0:0:0:0:0:0:1'
      || (isIP(hostname) === 4 && Number(hostname.split('.')[0]) === 127);
    const targetDatabase = decodeURIComponent(parsed.pathname.replace(/^\/+/, '').split('/')[0] || '');

    if (parsed.protocol !== 'mongodb:' || !loopback || targetDatabase !== databaseName || !/_test$/i.test(targetDatabase)) {
      throw new Error('Standalone Mongo partition requires its generated loopback _test database URI.');
    }
  }

  let mongoServer;
  let exitCode = 1;
  try {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    mongoServer = await MongoMemoryServer.create({ binary: { version: '7.0.5' } });
    const uri = mongoServer.getUri(databaseName);
    assertDisposableLoopbackMongoUri(uri);

    const env = { ...process.env };
    env.NODE_ENV = 'test';
    delete env.MONGO_URI;
    delete env.MONGO_TEST_PARTITION;
    env.MONGODB_URI = uri;
    env.USE_TESTCONTAINERS = 'false';
    env.USE_MMS = 'false';

    console.log(`Running ${standaloneMongoTests.length} standalone-compatible Mongo suites against disposable MongoDB 7.0.5 at ${new URL(uri).host}/${databaseName}.`);
    const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...standaloneMongoTests], {
      cwd: serverDir,
      env,
      stdio: 'inherit',
    });
    exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => resolve(code ?? 1));
    });
  } catch (error) {
    console.error(`Standalone Mongo partition failed: ${error.message}`);
    exitCode = 1;
  } finally {
    if (mongoServer) {
      try {
        await mongoServer.stop();
      } catch (error) {
        console.error(`Could not stop disposable MongoDB after standalone partition: ${error.message}`);
        exitCode = 1;
      }
    }
  }
  process.exitCode = exitCode;
} else if (mode !== 'no-mongo') {
  console.error('Usage: node scripts/test-partition.js <verify|full|no-mongo|standalone-mongo>');
  process.exit(2);
} else {
  const selected = testFiles.filter(file => !expectedMongo.includes(file));
  const accidentalMongoTests = selected.filter(file => expectedMongo.includes(file));
  if (selected.length === 0 || accidentalMongoTests.length > 0) {
    console.error('No-Mongo test selection is empty or contains a Mongo-required suite.');
    process.exit(1);
  }

  const env = { ...process.env };
  env.NODE_ENV = 'test';
  delete env.MONGODB_URI;
  delete env.MONGO_URI;
  env.MONGO_TEST_PARTITION = 'NO_MONGO';
  env.USE_MMS = 'false';
  env.USE_TESTCONTAINERS = 'false';
  console.log(`Running ${selected.length} tests without MongoDB; excluding ${expectedMongo.length} Mongo-required suites.`);
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...selected], {
    cwd: serverDir,
    env,
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}
