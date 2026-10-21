import { test, expect } from '@playwright/test';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { once } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import {
  createIsolatedMongoDatabaseOwnership,
  createLoopbackMongoTestUri,
  dropOwnedMongoTestDatabase,
} from './helpers/isolatedMongoDatabase.js';

const SPEC_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SPEC_DIR, '../..');
const SERVER_DIR = path.join(REPO_ROOT, 'server');
const REACTAPP_DIR = path.join(REPO_ROOT, 'reactapp');
const OFFER_TEXT = 'The PPF interest rate is 7.1% p.a.';
const TEST_ONLY_SCOPE = 'Disposable synthetic browser-test fixture; no source is fetched, reused, or qualified for production.';
const ENV_KEYS = [
  'NODE_ENV', 'JWT_SECRET', 'EXPOSE_AUTH_TOKEN', 'DISABLE_RATE_LIMIT', 'GENIEPROOF_ENABLED', 'VITE_GENIEPROOF_ENABLED',
  'MONGODB_URI', 'MONGO_URI', 'MONGO_URL', 'USE_TESTCONTAINERS', 'USE_MMS',
  'MONGOMS_SYSTEM_BINARY', 'MCP_ENABLED', 'MCP_REMOTE_ENABLED', 'AGENT_WORKER_ENABLED',
];

let envSnapshot;
let mongoose;
let mongoReplSet;
let mongoDbPath = null;
let mongoDatabaseOwnership = null;
let mongoDatabaseWasConnected = false;
let modelSet;
let testSigner;
let fixtureSource;
let syntheticRefreshCount = 0;
let latestSyntheticReceiptIds = [];
const workerTrace = [];
let proofBreakWorker;
let apiServer;
let viteProcess;
let apiOrigin;
let viteOrigin;
let viteOutput = '';
let cleanedUp = false;

function setIsolatedTestEnvironment() {
  envSnapshot = new Map(ENV_KEYS.map(key => [key, process.env[key]]));
  const databaseOwnership = createIsolatedMongoDatabaseOwnership();
  let ciMongoUri = null;
  if (process.env.CI === 'true' && process.env.MONGODB_URI) {
    ciMongoUri = createLoopbackMongoTestUri(process.env.MONGODB_URI, databaseOwnership);
  }
  mongoDatabaseOwnership = databaseOwnership;
  mongoDatabaseWasConnected = false;
  for (const key of ['MONGODB_URI', 'MONGO_URI', 'MONGO_URL']) delete process.env[key];
  Object.assign(process.env, {
    NODE_ENV: 'test',
    JWT_SECRET: crypto.randomBytes(48).toString('hex'),
    EXPOSE_AUTH_TOKEN: 'false',
    DISABLE_RATE_LIMIT: 'true',
    GENIEPROOF_ENABLED: 'true',
    USE_TESTCONTAINERS: 'false',
    USE_MMS: 'true',
    MCP_ENABLED: 'false',
    MCP_REMOTE_ENABLED: 'false',
    AGENT_WORKER_ENABLED: 'false',
  });
  process.env.VITE_GENIEPROOF_ENABLED = 'true';
  if (ciMongoUri) process.env.MONGODB_URI = ciMongoUri;
}

function restoreTestEnvironment() {
  if (!envSnapshot) return;
  for (const [key, value] of envSnapshot) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  envSnapshot = null;
}

async function reserveLoopbackPort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForHttp(url, child = null, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(`Vite exited before becoming ready (code ${child.exitCode}).\n${viteOutput}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message || 'no response'}${child ? `\n${viteOutput}` : ''}`);
}

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

function makeSyntheticReceipt({ source, url, contentType, body, responseLineage, now, receiptHash }) {
  const contentSha256 = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
  const receipt = {
    retrievalId: crypto.randomUUID(),
    sourceId: source.sourceId,
    sourceRevision: source.revision,
    requestedUrl: url,
    finalUrl: url,
    redirectCount: 0,
    statusCode: 200,
    contentType,
    contentBytes: Buffer.byteLength(body, 'utf8'),
    contentSha256,
    retrievedAt: now,
    publicationAt: null,
    fetchClassification: 'SUCCESS',
    fetcherVersion: 'genieproof-live-e2e-synthetic-only/1',
    responseLineage,
  };
  return { ...receipt, receiptHash: receiptHash(receipt) };
}

async function persistSyntheticEvidence({ revision, value, supersedes = null }) {
  const now = new Date();
  const rootBody = `SYNTHETIC TEST FIXTURE ONLY: source snapshot revision ${revision}. No external source was retrieved.`;
  const scriptBody = `SYNTHETIC TEST FIXTURE ONLY: opaque evidence bundle revision ${revision}; not a real financial source.`;
  const rootReceipt = makeSyntheticReceipt({
    source: fixtureSource,
    url: fixtureSource.endpoint,
    contentType: 'text/html',
    body: rootBody,
    responseLineage: [],
    now,
    receiptHash: modelSet.computeGenieProofRetrievalReceiptHash,
  });
  const scriptUrl = new URL('/_next/static/chunks/synthetic-fixture.js', fixtureSource.endpoint).toString();
  const scriptReceipt = makeSyntheticReceipt({
    source: fixtureSource,
    url: scriptUrl,
    contentType: 'application/javascript',
    body: scriptBody,
    responseLineage: [rootReceipt.contentSha256],
    now,
    receiptHash: modelSet.computeGenieProofRetrievalReceiptHash,
  });
  await modelSet.GenieProofRetrievalReceipt.create([rootReceipt, scriptReceipt]);

  const fact = {
    claimType: 'CURRENT_NOMINAL_RATE',
    productId: 'government:india-post:ppf',
    value,
    unit: 'PERCENT_PER_ANNUM',
    effectiveFrom: new Date(now.getTime() - 24 * 60 * 60 * 1000),
    effectiveTo: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    conditions: [],
  };
  const evidence = {
    evidenceId: `${fixtureSource.sourceId}:synthetic-ppf-rate`,
    revision,
    sourceId: fixtureSource.sourceId,
    sourceRevision: fixtureSource.revision,
    sourceDefinitionHash: fixtureSource.definitionHash,
    retrievalIds: [rootReceipt.retrievalId, scriptReceipt.retrievalId],
    retrievalReceiptHashes: [rootReceipt.receiptHash, scriptReceipt.receiptHash],
    publicationAt: null,
    retrievedAt: now,
    sourceContentCommitment: scriptReceipt.contentSha256,
    sourceQualificationAtAssessment: fixtureSource.qualificationStatus,
    reusePermissionAtAssessment: fixtureSource.reusePermissionStatus,
    freshnessStatus: 'FRESH',
    revocationStatus: 'ACTIVE',
    fact,
    parserVersion: fixtureSource.parserVersion,
    ruleVersion: fixtureSource.ruleVersion,
    sourceLineage: ['test-fixture://synthetic-only', rootReceipt.contentSha256],
    supersedes,
  };
  evidence.factHash = modelSet.buildGenieProofEvidenceFactHash(fact);
  evidence.attestation = testSigner.signManifest(modelSet.buildGenieProofEvidenceAttestationPayload(evidence));
  await modelSet.GenieProofEvidenceRevision.create(evidence);
  return [rootReceipt.retrievalId, scriptReceipt.retrievalId];
}

async function seedSyntheticDashboardShell(userId) {
  const ownerId = new mongoose.Types.ObjectId(userId);
  const profileId = new mongoose.Types.ObjectId();
  // A disposable, clearly synthetic profile exists only so the existing
  // authenticated DashboardShell can mount. No recommendation is calculated
  // or exposed; browser requests for it are kept unavailable by the test.
  const profile = await modelSet.FinancialProfile.create({
    _id: profileId,
    userId: ownerId,
    monthlyTakeHome: 100_000,
    monthlySavings: 20_000,
    age: 30,
    riskTolerance: 'Moderate',
    hasLumpSum: null,
    lumpSumAmount: null,
    investmentGoals: ['Wealth Growth'],
    investmentHorizonYears: 10,
    recommendationProfileVersion: 'financial-profile-1.1.0',
  });
  await modelSet.FinancialProfileState.updateOne({ userId: ownerId }, {
    $set: { currentProfileId: profile._id, revision: 1, resolutionStatus: 'CURRENT' },
  });
  await modelSet.RecommendationState.create({
    userId: ownerId,
    profileId: profile._id,
    currentRecommendationId: new mongoose.Types.ObjectId(),
    currentAllocationRevision: 1,
    currentAllocationRevisionId: new mongoose.Types.ObjectId(),
    generationRevision: 1,
    profileInputHash: 'a'.repeat(64),
    profileVersion: Number(profile.version || 1),
    portfolioFingerprint: 'b'.repeat(64),
    returnAssumptionVersion: 'TEST_FIXTURE_ONLY',
    returnAssumptionHash: 'c'.repeat(64),
    returnAssumptionSource: 'TEST_FIXTURE_ONLY',
  });
}

async function registerThroughBrowser(page, context, browserUniqueName) {
  const suffix = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  await page.goto(`${viteOrigin}/login`);
  await page.locator('#bg-video').waitFor();
  await page.locator('#bg-video').evaluate(video => video.dispatchEvent(new Event('error')));
  await page.locator('#login-view a', { hasText: 'Register' }).click();
  await page.locator('#reg-name').fill(`Synthetic GenieProof ${browserUniqueName}`);
  await page.locator('#reg-email').fill(`genieproof-${suffix}@example.com`);
  await page.locator('#reg-mobile').fill(`9${String(Date.now()).slice(-9)}`);
  await page.locator('#reg-password').fill('Valid@Pass2026!');
  await page.locator('#reg-confirm-password').fill('Valid@Pass2026!');
  const registrationResponse = page.waitForResponse(response => (
    response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/auth/register'
  ));
  await page.locator('#register-form button[type="submit"]').click();
  const response = await registrationResponse;
  expect(response.status()).toBe(201);
  const registration = await response.json();
  expect(registration.token).toBeUndefined();
  await expect(page.getByRole('heading', { name: 'Registration Successful!' })).toBeVisible();
  const cookies = await context.cookies(viteOrigin);
  const sessionCookie = cookies.find(cookie => cookie.name === 'wg_session');
  const csrfCookie = cookies.find(cookie => cookie.name === 'wg_csrf');
  expect(sessionCookie?.httpOnly).toBe(true);
  expect(csrfCookie?.httpOnly).toBe(false);
  await seedSyntheticDashboardShell(registration.user.id);
  await page.locator('.popup-card button', { hasText: 'OK' }).click();
  await expect(page.getByTestId('nav-genieproof')).toBeVisible({ timeout: 30_000 });
  return registration.user.id;
}

async function stopVite() {
  if (!viteProcess || viteProcess.exitCode !== null) return;
  viteProcess.kill('SIGTERM');
  await Promise.race([
    once(viteProcess, 'exit').catch(() => { /* The server may already have exited. */ }),
    new Promise(resolve => setTimeout(resolve, 5000)),
  ]);
  if (viteProcess.exitCode === null) {
    viteProcess.kill('SIGKILL');
    await Promise.race([
      once(viteProcess, 'exit').catch(() => { /* The server may already have exited. */ }),
      new Promise(resolve => setTimeout(resolve, 2000)),
    ]);
  }
  viteProcess = null;
}

async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  let databaseCleanupError = null;
  try { await proofBreakWorker?.stop({ graceMs: 3000 }); } catch { /* Continue teardown after a worker stop error. */ }
  proofBreakWorker = null;
  await stopVite();
  if (apiServer?.listening) {
    apiServer.closeAllConnections?.();
    await new Promise(resolve => apiServer.close(() => resolve()));
  }
  apiServer = null;
  if (mongoDatabaseOwnership && mongoDatabaseWasConnected) {
    try {
      const dropped = await dropOwnedMongoTestDatabase({
        connection: mongoose.connection,
        ownership: mongoDatabaseOwnership,
      });
      if (!dropped) throw new Error('Refusing to drop a Mongo database that is not owned by this browser test or cannot be reached for cleanup.');
    } catch (error) {
      databaseCleanupError = error;
    }
  }
  try { if (mongoose?.connection?.readyState) await mongoose.disconnect(); } catch { /* Continue teardown after a connection error. */ }
  try { await mongoReplSet?.stop(); } catch { /* Continue teardown after a replica-set stop error. */ }
  mongoReplSet = null;
  mongoDatabaseOwnership = null;
  mongoDatabaseWasConnected = false;
  if (mongoDbPath) {
    const resolvedDbPath = path.resolve(mongoDbPath);
    const resolvedReactappDir = path.resolve(REACTAPP_DIR);
    if (path.dirname(resolvedDbPath) !== resolvedReactappDir
        || !path.basename(resolvedDbPath).startsWith('.genieproof-e2e-mongo-')) {
      throw new Error('Refusing to remove a Mongo test path outside its unique React app workspace directory.');
    }
    fs.rmSync(resolvedDbPath, { recursive: true, force: true });
    mongoDbPath = null;
  }
  restoreTestEnvironment();
  if (databaseCleanupError) throw databaseCleanupError;
}

test.describe('synthetic-only authenticated GenieProof browser-to-worker integration', () => {
  test.describe.configure({ timeout: 300_000 });

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    try {
      setIsolatedTestEnvironment();
      const serverRequire = createRequire(path.join(SERVER_DIR, 'package.json'));
      mongoose = serverRequire('mongoose');
      if (process.env.CI === 'true' && process.env.MONGODB_URI) {
        await mongoose.connect(process.env.MONGODB_URI);
      } else {
        const { MongoMemoryReplSet } = serverRequire('mongodb-memory-server');
        const localMongoCandidates = [
          { version: '8.0.9', path: 'C:\\Program Files\\MongoDB\\Server\\8.0\\bin\\mongod.exe' },
          { version: '7.0.5', path: path.join(process.env.USERPROFILE || '', '.cache', 'mongodb-binaries', 'mongod-x64-win32-7.0.5.exe') },
          { version: '8.2.6', path: path.join(process.env.USERPROFILE || '', '.cache', 'mongodb-binaries', 'mongod-x64-win32-8.2.6.exe') },
        ];
        const localMongo = localMongoCandidates.find(candidate => fs.existsSync(candidate.path));
        if (!localMongo) {
          throw new Error(`A locally installed or cached MongoDB binary is required to keep this integration test offline. Checked: ${localMongoCandidates.map(candidate => candidate.path).join(', ')}`);
        }
        // The managed Windows Temp path can deny WiredTiger's atomic file rename.
        // Keep this unique, disposable database inside the writable React app
        // workspace and remove only this generated directory in cleanup().
        mongoDbPath = path.join(REACTAPP_DIR, `.genieproof-e2e-mongo-${process.pid}-${crypto.randomUUID()}`);
        fs.mkdirSync(mongoDbPath, { recursive: true });
        mongoReplSet = await MongoMemoryReplSet.create({
          binary: { version: localMongo.version, systemBinary: localMongo.path },
          replSet: { count: 1, storageEngine: 'wiredTiger' },
          instanceOpts: [{ dbPath: mongoDbPath }],
        });
        await mongoose.connect(mongoReplSet.getUri(mongoDatabaseOwnership.databaseName));
      }
      mongoDatabaseWasConnected = true;
      if (mongoose.connection.db?.databaseName !== mongoDatabaseOwnership?.databaseName) {
        throw new Error('Mongo connected to a database other than this browser test’s isolated database.');
      }

      const persistence = await import(pathToFileURL(path.join(SERVER_DIR, 'services', 'persistenceIndexReadiness.js')).href);
      await persistence.migratePersistenceIndexes();

      const keyPair = crypto.generateKeyPairSync('ed25519');
      const privateKeyPem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' });
      const publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' });
      const { GenieProofPassportSigner } = await import(pathToFileURL(path.join(SERVER_DIR, 'agents', 'genieProof', 'genieProofPassportSignature.js')).href);
      testSigner = new GenieProofPassportSigner({
        privateKeyPem,
        publicKeyPem,
        keyId: `genieproof-e2e-${crypto.randomUUID()}`,
      });

      const [catalogModule, registryModule, evidenceContract, workerModule] = await Promise.all([
        import(pathToFileURL(path.join(SERVER_DIR, 'agents', 'genieProof', 'genieProofSourceCatalog.js')).href),
        import(pathToFileURL(path.join(SERVER_DIR, 'agents', 'genieProof', 'genieProofEvidenceRegistryService.js')).href),
        import(pathToFileURL(path.join(SERVER_DIR, 'agents', 'genieProof', 'genieProofEvidenceContract.js')).href),
        import(pathToFileURL(path.join(SERVER_DIR, 'agents', 'genieProof', 'proofBreakWorker.js')).href),
      ]);
      const modelImports = await Promise.all([
        'FinancialProfile', 'FinancialProfileState', 'RecommendationState', 'GenieProofSourceDefinition',
        'GenieProofEvidenceRevision', 'GenieProofRetrievalReceipt', 'ProofBreakWorkerHeartbeat',
      ].map(name => import(pathToFileURL(path.join(SERVER_DIR, 'models', `${name}.js`)).href)));
      modelSet = {
        computeGenieProofSourceDefinitionHash: registryModule.computeGenieProofSourceDefinitionHash,
        computeGenieProofRetrievalReceiptHash: registryModule.computeGenieProofRetrievalReceiptHash,
        buildGenieProofEvidenceAttestationPayload: evidenceContract.buildGenieProofEvidenceAttestationPayload,
        buildGenieProofEvidenceFactHash: evidenceContract.buildGenieProofEvidenceFactHash,
        resolveGenieProofEvidenceForClaims: registryModule.resolveGenieProofEvidenceForClaims,
        ProofBreakWorker: workerModule.ProofBreakWorker,
      };
      modelImports.forEach((module, index) => {
        const name = ['FinancialProfile', 'FinancialProfileState', 'RecommendationState', 'GenieProofSourceDefinition', 'GenieProofEvidenceRevision', 'GenieProofRetrievalReceipt', 'ProofBreakWorkerHeartbeat'][index];
        modelSet[name] = module.default;
      });

      // This is a disposable synthetic-only revision with the exact source
      // identity accepted by the availability/fetch gate. It is admitted only
      // to the isolated memory database; the worker refresh adapter below
      // writes synthetic receipts and never performs network IO.
      const catalogShape = catalogModule.GENIEPROOF_SOURCE_CATALOG_CANDIDATES.at(-1);
      fixtureSource = {
        ...catalogShape,
        revision: catalogShape.revision + 1,
        lineage: [`${catalogShape.sourceId}:${catalogShape.revision}`],
        supersedes: { sourceId: catalogShape.sourceId, revision: catalogShape.revision },
        qualificationStatus: 'QUALIFIED_FOR_USER_PRESENTATION',
        reusePermissionStatus: 'APPROVED',
        reviewRecord: {
          reviewedAt: new Date(),
          reference: 'test-fixture://synthetic-only',
          scope: TEST_ONLY_SCOPE,
        },
      };
      fixtureSource.definitionHash = modelSet.computeGenieProofSourceDefinitionHash(fixtureSource);
      await modelSet.GenieProofSourceDefinition.create(fixtureSource);
      latestSyntheticReceiptIds = await persistSyntheticEvidence({ revision: 1, value: 7.1 });

      const { createApp } = await import(pathToFileURL(path.join(SERVER_DIR, 'app.js')).href);
      const vitePort = await reserveLoopbackPort();
      const apiPort = await reserveLoopbackPort();
      viteOrigin = `http://127.0.0.1:${vitePort}`;
      apiOrigin = `http://127.0.0.1:${apiPort}`;
      const appEnv = {
        ...process.env,
        NODE_ENV: 'test',
        CORS_ORIGINS: viteOrigin,
        GENIEPROOF_ENABLED: 'true',
        EXPOSE_AUTH_TOKEN: 'false',
        DISABLE_RATE_LIMIT: 'true',
        MCP_ENABLED: 'false',
        MCP_REMOTE_ENABLED: 'false',
        AGENT_WORKER_ENABLED: 'false',
      };
      const app = createApp({
        env: appEnv,
        genieProofRuntime: { enabled: true, signer: testSigner, productionActivationAllowed: false },
      });
      apiServer = createHttpServer(app);
      await listen(apiServer, apiPort);
      await waitForHttp(`${apiOrigin}/api/health`);

      proofBreakWorker = new modelSet.ProofBreakWorker({
        signer: testSigner,
        workerId: `synthetic-genieproof-e2e-${crypto.randomUUID()}`,
        evidenceResolver: modelSet.resolveGenieProofEvidenceForClaims,
        // Synthetic-only adapter: append changed synthetic evidence/receipts;
        // never fetch the `.invalid` endpoint or any external source.
        refreshEvidence: async () => {
          syntheticRefreshCount += 1;
          const ids = await persistSyntheticEvidence({
            revision: 2,
            value: 7.4,
            supersedes: `${fixtureSource.sourceId}:synthetic-ppf-rate:1`,
          });
          latestSyntheticReceiptIds = ids;
          workerTrace.push({ type: 'synthetic-source-revision', revision: 2, changedFactFields: ['value'], receiptCount: ids.length });
          return { created: true, retrievalIds: ids };
        },
      });
      const processClaimedJob = proofBreakWorker.processClaimedJob.bind(proofBreakWorker);
      proofBreakWorker.processClaimedJob = async (...args) => {
        const claimed = args[0];
        workerTrace.push({ type: 'job-started', jobId: claimed.job.jobId, attempt: claimed.job.attempt, executionGeneration: claimed.executionGeneration });
        try {
          const result = await processClaimedJob(...args);
          workerTrace.push({ type: 'job-finished', jobId: claimed.job.jobId, status: result.status, revision: result.revision ?? null });
          return result;
        } catch (error) {
          workerTrace.push({ type: 'job-failed', jobId: claimed.job.jobId, code: error?.code || 'UNKNOWN' });
          throw error;
        }
      };
      proofBreakWorker.start({ intervalMs: 100 });
      const readinessDeadline = Date.now() + 5_000;
      let workerReady = false;
      while (!workerReady && Date.now() < readinessDeadline) {
        workerReady = Boolean(await modelSet.ProofBreakWorkerHeartbeat.exists({
          workerId: proofBreakWorker.workerId,
          status: 'RUNNING',
          lastSuccessfulPollAt: { $ne: null },
          lastPollErrorCode: null,
        }));
        if (!workerReady) await new Promise(resolve => setTimeout(resolve, 50));
      }
      expect(workerReady, 'the worker must complete a successful scheduler poll before the browser enables monitoring').toBe(true);

      const viteBin = path.join(REACTAPP_DIR, 'node_modules', 'vite', 'bin', 'vite.js');
      viteProcess = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
        cwd: REACTAPP_DIR,
        env: {
          ...process.env,
          NODE_ENV: 'development',
          VITE_GENIEPROOF_ENABLED: 'true',
          VITE_API_URL: '/api',
          VITE_DEV_API_TARGET: apiOrigin,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      viteProcess.stdout?.on('data', chunk => { viteOutput = `${viteOutput}${chunk}`.slice(-8000); });
      viteProcess.stderr?.on('data', chunk => { viteOutput = `${viteOutput}${chunk}`.slice(-8000); });
      viteProcess.once('error', error => { viteOutput = `${viteOutput}\n${error.message}`.slice(-8000); });
      await waitForHttp(viteOrigin, viteProcess);
    } catch (error) {
      await cleanup();
      throw error;
    }
  });

  test.afterAll(async () => cleanup());

  test('saves and watches a synthetic passport through the browser, verifies worker publication and owner isolation, then deletes it', async ({ browser }, testInfo) => {
    const firstContext = await browser.newContext();
    const firstPage = await firstContext.newPage();
    const secondContext = await browser.newContext();
    const secondPage = await secondContext.newPage();
    const externalRequests = [];
    const apiTrace = [];
    for (const page of [firstPage, secondPage]) {
      // Keep dashboard recommendation presentation unavailable in this test;
      // no financial recommendation fixture is calculated or served.
      await page.route('**/api/recommend/current**', route => route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'RECOMMENDATION_REQUIRED', message: 'No recommendation is available in this synthetic navigation test.' }),
      }));
      page.on('request', request => {
        const url = new URL(request.url());
        if (!url.pathname.startsWith('/api/')) return;
        apiTrace.push({ type: 'request', method: request.method(), path: url.pathname });
      });
      page.on('response', response => {
        const url = new URL(response.url());
        if (!url.pathname.startsWith('/api/')) return;
        apiTrace.push({ type: 'response', method: response.request().method(), path: url.pathname, status: response.status() });
      });
      page.on('request', request => {
        const url = request.url();
        if (/genieproof-e2e\.invalid|indiapost\.gov\.in|amfiindia\.com|nseindia\.com/i.test(url)) externalRequests.push(url);
      });
    }

    try {
      await registerThroughBrowser(firstPage, firstContext, 'owner');
      await firstPage.getByTestId('nav-genieproof').click();
      await expect(firstPage.getByTestId('genieproof-panel')).toBeVisible();
      const forwardedCapability = await firstPage.evaluate(async () => {
        const response = await fetch('/api/genieproof/capabilities', {
          headers: { 'x-forwarded-for': '192.0.2.10' },
        });
        return { status: response.status, body: await response.json() };
      });
      expect(forwardedCapability.status).toBe(200);
      expect(forwardedCapability.body).toMatchObject({
        interactiveEnabled: false,
        mode: 'UNAVAILABLE',
        reasonCode: 'GENIEPROOF_LOCAL_REQUEST_REQUIRED',
      });
      const forwardedCases = await firstPage.evaluate(async () => (
        await fetch('/api/genieproof/cases', { headers: { 'x-forwarded-for': '192.0.2.10' } })
      ).status);
      expect(forwardedCases).toBe(404);
      await firstPage.locator('#genieproof-offer').fill(OFFER_TEXT);
      const extractResponse = firstPage.waitForResponse(response => (
        response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/genieproof/extract'
      ));
      await firstPage.getByRole('button', { name: 'Extract claims' }).click();
      expect((await extractResponse).status()).toBe(200);
      await expect(firstPage.getByRole('heading', { name: 'Confirm the exact claims' })).toBeVisible();
      await firstPage.getByLabel('I reviewed the exact wording and interpretation above.').check();
      await firstPage.getByLabel(/I consent to save the confirmed claim wording/).check();
      const saveRequest = firstPage.waitForRequest(request => (
        request.method() === 'POST' && new URL(request.url()).pathname === '/api/genieproof/cases'
      ));
      const saveResponse = firstPage.waitForResponse(response => (
        response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/genieproof/cases'
      ));
      await firstPage.getByRole('button', { name: 'Save private passport' }).click();
      const [authenticatedSaveRequest, savedResponse] = await Promise.all([saveRequest, saveResponse]);
      expect(savedResponse.status()).toBe(201);
      const requestHeaders = await authenticatedSaveRequest.allHeaders();
      expect(requestHeaders.cookie).toContain('wg_session=');
      expect(requestHeaders.cookie).toContain('wg_csrf=');
      expect(requestHeaders['x-csrf-token']).toBeTruthy();
      const saved = await savedResponse.json();
      const caseId = saved.case.caseId;
      expect(saved.passport.manifest.revision).toBe(1);
      expect(saved.passport.manifest.findings[0].finding).toBe('SUPPORTED');
      await expect(firstPage.getByText('Revision 1 · 1 claim')).toBeVisible();

      await firstPage.getByRole('button', { name: 'Open', exact: true }).click();
      const downloadPromise = firstPage.waitForEvent('download');
      await firstPage.getByRole('button', { name: 'Download signed claim record' }).click();
      const downloaded = await downloadPromise;
      const exportedPath = testInfo.outputPath('genieproof-exported-passport.json');
      await downloaded.saveAs(exportedPath);
      const exportedPreview = JSON.parse(fs.readFileSync(exportedPath, 'utf8'));
      const coreModule = await import(pathToFileURL(path.join(SERVER_DIR, 'agents', 'genieProof', 'genieProofCore.js')).href);
      const signatureModule = await import(pathToFileURL(path.join(SERVER_DIR, 'agents', 'genieProof', 'genieProofPassportSignature.js')).href);
      const replayedPreview = coreModule.verifyConfirmedGenieProofClaim(exportedPreview.manifest.confirmedClaims[0], {
        verifierVersion: exportedPreview.manifest.verifierVersion,
        evidenceRevisions: exportedPreview.manifest.findings[0].evidence.revisions,
        signatureVerifier: new signatureModule.GenieProofPassportVerifier({ trustedPublicKeys: {
          [testSigner.keyId]: testSigner.publicKey.export({ type: 'spki', format: 'pem' }),
        } }),
        now: exportedPreview.manifest.assessedAt,
      });
      expect(exportedPreview.manifest.findings[0]).toEqual(replayedPreview);
      const verifierScript = path.join(SERVER_DIR, 'scripts', 'verifyGenieProofPassport.js');
      const verifierEnv = {
        ...process.env,
        GENIEPROOF_VERIFY_PUBLIC_KEYS_JSON: JSON.stringify({
          [testSigner.keyId]: testSigner.publicKey.export({ type: 'spki', format: 'pem' }),
        }),
      };
      const independent = spawnSync(process.execPath, [verifierScript, exportedPath], {
        cwd: SERVER_DIR, env: verifierEnv, encoding: 'utf8', windowsHide: true,
      });
      expect(independent.status, `${independent.stderr}\n${independent.stdout}`).toBe(2);
      const independentResult = JSON.parse(independent.stdout);
      expect(independentResult).toMatchObject({
        status: 'VERIFICATION_INCOMPLETE',
        signature: 'SIGNATURE_INTEGRITY_VALID',
        trustedIssuer: true,
        findings: 'FINDING_REPRODUCIBLE',
        financialCorrectness: 'NOT_ESTABLISHED_BY_SIGNATURE',
      });
      const tamperedPassport = JSON.parse(fs.readFileSync(exportedPath, 'utf8'));
      tamperedPassport.manifest.confirmedClaims[0].value = 9;
      const tamperedPath = testInfo.outputPath('genieproof-tampered-passport.json');
      fs.writeFileSync(tamperedPath, JSON.stringify(tamperedPassport));
      const tamperedVerification = spawnSync(process.execPath, [verifierScript, tamperedPath], {
        cwd: SERVER_DIR, env: verifierEnv, encoding: 'utf8', windowsHide: true,
      });
      expect(tamperedVerification.status, tamperedVerification.stderr).toBe(1);
      expect(JSON.parse(tamperedVerification.stdout).status).toBe('VERIFICATION_FAILED');

      await firstPage.getByRole('button', { name: 'ProofBreak status & timeline' }).click();
      const proofBreakRegion = firstPage.getByRole('region', { name: 'ProofBreak status and timeline for revision 1' });
      await expect(proofBreakRegion.getByText('A source is qualified for the supported claims.')).toBeVisible();
      await expect(proofBreakRegion.getByText('Monitoring worker: recently available.')).toBeVisible();
      await expect(proofBreakRegion.getByText('Supported by an approved monitoring source')).toBeVisible();
      await proofBreakRegion.getByLabel(/I consent to periodic checks of these supported claims/).check();
      const watchResponse = firstPage.waitForResponse(response => (
        response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/genieproof/cases/${caseId}/watch`
      ));
      await proofBreakRegion.getByRole('button', { name: 'Enable ProofBreak checks' }).click();
      expect((await watchResponse).status()).toBe(201);

      // Poll via authenticated browser fetch through Vite's same-origin proxy;
      // the in-process timer above invokes the real ProofBreakWorker class.
      const eventPath = `/api/genieproof/cases/${caseId}/events`;
      await expect.poll(async () => firstPage.evaluate(async path => {
        const response = await fetch(path);
        if (!response.ok) return `HTTP_${response.status}`;
        const result = await response.json();
        return result.events?.[0]?.eventType || 'PENDING';
      }, eventPath), { timeout: 30_000, intervals: [200, 400, 800] }).toBe('FINDING_CHANGED');
      await expect.poll(() => syntheticRefreshCount, { timeout: 10_000 }).toBe(1);

      const revisionsFromBrowser = await firstPage.evaluate(async caseIdentifier => {
        const response = await fetch(`/api/genieproof/cases/${caseIdentifier}/revisions`);
        return { status: response.status, body: await response.json() };
      }, caseId);
      expect(revisionsFromBrowser.status).toBe(200);
      expect(revisionsFromBrowser.body.revisions).toHaveLength(2);
      const latestRevision = revisionsFromBrowser.body.revisions.find(item => item.revision === 2);
      expect(latestRevision.verification).toMatchObject({ integrity: 'VALID', signature: 'VERIFIED', trustedIssuer: true });
      expect(latestRevision.passport.manifest.findings[0].finding).toBe('CONTRADICTED');
      expect(latestRevision.passport.manifest.findings[0].evidence.revisions[0].fact.value).toBe(7.4);
      expect(syntheticRefreshCount).toBe(1);

      // Refresh the visible timeline after the worker has published the event.
      await firstPage.getByRole('button', { name: 'ProofBreak status & timeline' }).click();
      await expect(proofBreakRegion.getByText('The claim finding changed')).toBeVisible();
      const eventSummary = proofBreakRegion.locator('li').filter({ hasText: 'The claim finding changed' });
      await eventSummary.getByText('Source retrieval receipts').click();
      const receiptText = await eventSummary.locator('details span').innerText();
      expect(latestSyntheticReceiptIds).toHaveLength(2);
      for (const receiptId of latestSyntheticReceiptIds) expect(receiptText).toContain(receiptId);
      await eventSummary.getByRole('button', { name: 'Mark reviewed' }).click();
      await expect(eventSummary.getByRole('button', { name: 'Mark reviewed' })).toHaveCount(0);
      const acknowledgedTimeline = await firstPage.evaluate(async path => {
        const response = await fetch(path);
        return response.json();
      }, eventPath);
      expect(acknowledgedTimeline.events[0].acknowledgedAt).toBeTruthy();
      expect(acknowledgedTimeline.events[0].retrievalReceiptIds).toEqual(latestSyntheticReceiptIds);
      expect(acknowledgedTimeline.events[0].previousEvidenceRevision).toMatch(/:1$/);
      expect(acknowledgedTimeline.events[0].newEvidenceRevision).toMatch(/:2$/);
      const desktopScreenshot = testInfo.outputPath('genieproof-desktop-timeline.png');
      await firstPage.screenshot({ path: desktopScreenshot, fullPage: true });
      await testInfo.attach('genieproof-desktop-timeline', { path: desktopScreenshot, contentType: 'image/png' });

      await registerThroughBrowser(secondPage, secondContext, 'other-owner');
      await secondPage.setViewportSize({ width: 390, height: 844 });
      await secondPage.getByRole('button', { name: 'More navigation options' }).click();
      await secondPage.getByRole('dialog', { name: 'More navigation options' })
        .getByRole('button', { name: 'GenieProof Preview' }).click();
      await expect(secondPage.getByTestId('genieproof-panel')).toBeVisible();
      const mobileScreenshot = testInfo.outputPath('genieproof-mobile-navigation.png');
      await secondPage.screenshot({ path: mobileScreenshot, fullPage: true });
      await testInfo.attach('genieproof-mobile-navigation', { path: mobileScreenshot, contentType: 'image/png' });
      await expect(secondPage.getByText('No saved cases yet.')).toBeVisible();
      const otherOwnerRead = await secondPage.evaluate(async caseIdentifier => {
        const response = await fetch(`/api/genieproof/cases/${caseIdentifier}`);
        return { status: response.status, body: await response.json() };
      }, caseId);
      expect(otherOwnerRead.status).toBe(404);

      await proofBreakRegion.getByRole('button', { name: 'Pause checks' }).click();
      await expect(proofBreakRegion.getByText('Watch status: paused.')).toBeVisible();
      await proofBreakRegion.getByRole('button', { name: 'Disable checks' }).click();
      await expect(proofBreakRegion.getByText('Watch status: cancelled.')).toBeVisible();
      await proofBreakRegion.getByRole('button', { name: 'Delete watch and timeline' }).click();
      await expect(proofBreakRegion.getByText('No persisted checks or events are available for this case.')).toBeVisible();

      const deleteButton = firstPage.getByRole('button', { name: /Delete passport revision/ });
      await deleteButton.click();
      const confirmation = firstPage.getByRole('group', { name: 'Confirm passport deletion' });
      const deleteResponse = firstPage.waitForResponse(response => (
        response.request().method() === 'DELETE' && new URL(response.url()).pathname === `/api/genieproof/cases/${caseId}`
      ));
      await confirmation.getByRole('button', { name: 'Delete case and revisions' }).click();
      expect((await deleteResponse).status()).toBe(204);
      await expect(firstPage.getByText('No saved cases yet.')).toBeVisible();
      const deletedCaseRead = await firstPage.evaluate(async caseIdentifier => (
        (await fetch(`/api/genieproof/cases/${caseIdentifier}`)).status
      ), caseId);
      expect(deletedCaseRead).toBe(404);
      expect(externalRequests).toEqual([]);
      expect(workerTrace.some(item => item.type === 'job-finished' && item.status === 'COMPLETED')).toBe(true);
      const tracePath = testInfo.outputPath('genieproof-api-worker-trace.json');
      fs.mkdirSync(path.dirname(tracePath), { recursive: true });
      fs.writeFileSync(tracePath, JSON.stringify({ api: apiTrace, worker: workerTrace }, null, 2));
      await testInfo.attach('genieproof-api-worker-trace', { path: tracePath, contentType: 'application/json' });
    } finally {
      await Promise.all([firstContext.close(), secondContext.close()]);
    }
  });
});
