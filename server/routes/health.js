import { Router } from 'express';
import mongoose from 'mongoose';
import { redisClient, redisAvailable } from '../config/redis.js';
import { checkMLHealth } from '../services/mlClient.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import logger from '../utils/logger.js';
import {
  verifyMarketDataPersistenceIndexes,
  verifyPersistenceIndexes,
} from '../services/persistenceIndexReadiness.js';
import { verifyAgentRuntimePersistence } from '../services/planHealthPersistence.js';
import { normalizeBuildSha } from '../../shared/buildIdentity.js';
import { REDIS_PROBE_TIMEOUT_MS } from '../../shared/demoPreflightContracts.js';
import { loadBuildProvenance } from '../services/buildProvenance.js';
import { verifyRunwayOperationalReadiness } from '../services/runwayOperationalReadiness.js';
import { hasUpstoxAccessToken } from '../services/marketData/upstoxCredentials.js';
import { isUpstoxOnlyMarketDataMode } from '../services/marketDataService.js';
import {
  isSafeDemoEnvironmentId,
  verifyDemoDatabaseIdentity,
  verifyDemoEnvironmentSentinel as verifyConnectedDemoEnvironmentSentinel,
} from '../services/demoDatabaseIdentity.js';

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

export function createHealthRouter({
  runtimeState = null,
  requireRedis = false,
  requireAgentRuntimePersistence = false,
  requireMcp = false,
  requireRunway = false,
  runwayEnv = process.env,
  verifyRunway = verifyRunwayOperationalReadiness,
  mcpRuntime = null,
  mcpCapacity = null,
  timeoutMs = 3000,
  verificationTimeoutMs = REDIS_PROBE_TIMEOUT_MS,
  verifyAgentRuntime = verifyAgentRuntimePersistence,
  buildSha = process.env.APP_BUILD_SHA,
  buildProvenance = loadBuildProvenance(),
  expectedDemoDatabase = process.env.DEMO_EXPECTED_MONGODB_DATABASE,
  expectedDemoDatabaseHost = process.env.DEMO_EXPECTED_MONGODB_HOST,
  expectedDemoDatabasePort = process.env.DEMO_EXPECTED_MONGODB_PORT,
  expectedDemoEnvironmentId = process.env.DEMO_EXPECTED_MONGODB_ENVIRONMENT_ID,
  marketProvider = isUpstoxOnlyMarketDataMode() ? 'UPSTOX' : String(process.env.MARKET_DATA_PRIMARY_PROVIDER || 'NSE').trim().toUpperCase(),
  marketProviderTokenPresent = (!isUpstoxOnlyMarketDataMode()
    && String(process.env.MARKET_DATA_PRIMARY_PROVIDER || 'NSE').trim().toUpperCase() === 'NSE')
    || hasUpstoxAccessToken(),
  verifyMongoTransaction = verifyConnectedMongoTransaction,
  verifyDemoEnvironmentSentinel = verifyConnectedDemoEnvironmentSentinel,
  verifyRedisConnection = verifyConnectedRedis,
  verifyFinancialIndexes = verifyPersistenceIndexes,
  verifyMarketDataIndexes = verifyMarketDataPersistenceIndexes,
  isMongoConnected = () => mongoose.connection.readyState === 1,
  getMongoDatabaseName = () => mongoose.connection.db?.databaseName || null,
  getMongoHost = () => mongoose.connection.host || null,
  getMongoPort = () => mongoose.connection.port || null,
} = {}) {
  const router = Router();

/**
 * GET /health/deep
 * Performs a deep health check of Database, Redis, and ML microservice.
 *
 * Semantics:
 * Database and lifecycle readiness are always critical. Redis is also critical
 * when REQUIRE_REDIS is enabled (the production default). ML remains optional
 * because advisory routes have a deterministic rule-based fallback.
 */
  router.get('/deep', asyncHandler(async (req, res) => {
  // Internal tracking with criticality flag
  const checks = {
    database: { status: 'DOWN', critical: true },
    redis:    { status: 'DOWN', critical: false },
    ml:       { status: 'DOWN', critical: false },
    mcp:      { status: requireMcp ? 'DOWN' : 'DISABLED', critical: requireMcp },
  };

  // 1. Check MongoDB (critical)
  try {
    const isDbConnected = mongoose.connection.readyState === 1;
    if (isDbConnected) {
      await withTimeout(mongoose.connection.db.admin().ping(), timeoutMs, 'Mongo ping');
      checks.database.status = 'UP';
    }
  } catch (err) {
    logger.warn('Database health check failed', { message: err.message });
  }

  // 2. Check Redis (non-critical)
  try {
    if (redisAvailable && redisClient) {
      const pingRes = await withTimeout(redisClient.ping(), timeoutMs, 'Redis ping');
      if (pingRes === 'PONG') {
        checks.redis.status = 'UP';
      }
    }
  } catch (err) {
    logger.warn('Redis health check failed', { message: err.message });
  }

  // 3. Check ML Microservice (non-critical)
  //    Any successful HTTP response means the service is running.
  //    Possible status values from ML: "ok", "model_not_loaded", "healthy",
  //    "ready", "UP".  All indicate the process is alive.
  try {
    const mlHealth = await checkMLHealth(req.correlationId);
    if (mlHealth) {
      // ML service responded over HTTP — it is reachable and alive
      checks.ml.status = 'UP';
    }
  } catch (err) {
    logger.warn('ML service health check failed', { message: err.message });
  }

  if (requireMcp) {
    let capacityReady = false;
    try { capacityReady = await withTimeout(mcpCapacity?.probe?.() || Promise.resolve(false), timeoutMs, 'MCP capacity probe'); } catch { capacityReady = false; }
    checks.mcp.status = mcpRuntime?.isReady() && capacityReady && mcpCapacity?.isReady() ? 'UP' : 'DOWN';
  }

  // Determine overall status
  checks.redis.critical = requireRedis;
  const criticalDown = Object.values(checks).some(svc => svc.critical && svc.status === 'DOWN');
  const lifecycleReady = runtimeState ? runtimeState.isReady() : true;

  const allUp = Object.values(checks).every(svc => svc.status === 'UP' || svc.status === 'DISABLED');

  // Build backward-compatible response (flat strings for services)
  const health = {
    status: criticalDown || !lifecycleReady ? 'DOWN' : (allUp ? 'UP' : 'DEGRADED'),
    timestamp: new Date().toISOString(),
    correlationId: req.correlationId || null,
    lifecycle: runtimeState?.snapshot() || null,
    services: {
      database: checks.database.status,
      redis: checks.redis.status,
      ml: checks.ml.status,
      mcp: checks.mcp.status,
    }
  };

  // Critical dependency or lifecycle failure triggers 503.
  res.status(criticalDown || !lifecycleReady ? 503 : 200).json(health);
  }));

/**
 * GET /health
 * Simple liveness probe for load balancer.
 */
  router.get('/', (_req, res) => {
  res.status(200).json({ status: 'UP', timestamp: new Date().toISOString() });
  });

/**
 * GET /health/ready
 * Readiness probe - returns 200 only when the database is connected and responsive.
 * Container orchestrators use this to decide when to route traffic.
 */
  router.get('/ready', asyncHandler(async (_req, res) => {
    const reasons = [];
    const mongoConnected = isMongoConnected();
    if (runtimeState && !runtimeState.isReady()) reasons.push(`Application lifecycle is ${runtimeState.snapshot().phase}`);
    if (!mongoConnected) reasons.push('Database not connected');
    const demoIdentityConfigured = expectedDemoDatabase !== undefined
      || expectedDemoDatabaseHost !== undefined
      || expectedDemoDatabasePort !== undefined
      || expectedDemoEnvironmentId !== undefined;
    let demoIdentityVerified = false;
    let demoSentinelVerified = false;
    if (demoIdentityConfigured) {
      demoIdentityVerified = verifyDemoDatabaseIdentity({
        actual: getMongoDatabaseName(),
        configuredExpected: expectedDemoDatabase,
        requestedExpected: expectedDemoDatabase,
        actualHost: getMongoHost(),
        configuredExpectedHost: expectedDemoDatabaseHost,
        requestedExpectedHost: expectedDemoDatabaseHost,
        actualPort: getMongoPort(),
        configuredExpectedPort: expectedDemoDatabasePort,
        requestedExpectedPort: expectedDemoDatabasePort,
      });
      const environmentIdValid = isSafeDemoEnvironmentId(expectedDemoEnvironmentId);
      if (!demoIdentityVerified || !environmentIdValid) {
        reasons.push('Configured isolated database identity is not verified');
      } else {
        demoSentinelVerified = await withTimeout(verifyDemoEnvironmentSentinel({
          database: mongoose.connection.db,
          expectedEnvironmentId: expectedDemoEnvironmentId,
        }), timeoutMs, 'Demo database sentinel verification').catch(() => false);
        if (!demoSentinelVerified) reasons.push('Configured demo environment sentinel is not verified');
      }
    }
    if (requireRedis && (!redisAvailable || !redisClient?.isReady)) reasons.push('Redis not connected');
    if (requireRunway) {
      // Health is not allowed to report READY when Runway is enabled but its
      // independently managed HMAC secret or Mongo indexes have regressed.
      const ready = mongoConnected
        ? await withTimeout(Promise.resolve().then(() => verifyRunway({ env: runwayEnv })),
          timeoutMs, 'Runway financial readiness').catch(() => null)
        : null;
      if (ready?.ready !== true || ready?.enabled !== true) {
        reasons.push('Enabled Household Runway signing key or persistence indexes are not ready');
      }
    }
    if (requireMcp) {
      let capacityReady = false;
      try { capacityReady = await withTimeout(mcpCapacity?.probe?.() || Promise.resolve(false), timeoutMs, 'MCP capacity probe'); } catch { capacityReady = false; }
      if (!mcpRuntime?.isReady() || !capacityReady || !mcpCapacity?.isReady()) {
        reasons.push('Required MCP runtime or distributed capacity/auth controls are not ready');
      }
    }
    if (mongoConnected && (!demoIdentityConfigured || (demoIdentityVerified && demoSentinelVerified))) {
      const transactionCapable = await withTimeout(
        Promise.resolve().then(() => verifyMongoTransaction({ timeoutMs, connection: mongoose.connection })),
        timeoutMs,
        'Mongo transaction readiness probe',
      ).catch(() => false);
      if (!transactionCapable) reasons.push('MongoDB transaction capability is not ready');
      try {
        await verifyFinancialIndexes();
      } catch {
        reasons.push('Required persistence indexes are not ready');
      }
      try {
        await verifyMarketDataIndexes({ force: true });
      } catch {
        reasons.push('Required market-data persistence indexes are not ready');
      }
      if (requireAgentRuntimePersistence) {
        try {
          await verifyAgentRuntime({ force: true });
        } catch {
          reasons.push('Required agent queue-admission persistence is not ready');
        }
      }
    } else if (requireAgentRuntimePersistence) {
      reasons.push('Required agent queue-admission persistence is not ready');
    }
    if (reasons.length > 0) {
      return res.status(503).json({
        status: 'NOT_READY',
        buildProvenance: publicBuildProvenance(buildProvenance),
        reasons,
        lifecycle: runtimeState?.snapshot() || null,
        timestamp: new Date().toISOString(),
      });
    }
    return res.status(200).json({
      status: 'READY',
      buildProvenance: publicBuildProvenance(buildProvenance),
      lifecycle: runtimeState?.snapshot() || null,
      timestamp: new Date().toISOString(),
    });
  }));

/**
 * GET /health/live
 * Liveness probe - returns 200 if the process is alive.
 * Container orchestrators use this to decide whether to restart the container.
 */
  router.get('/live', (_req, res) => {
  res.status(200).json({
    status: 'ALIVE',
    buildSha: normalizeBuildSha(buildSha),
    buildProvenance: publicBuildProvenance(buildProvenance),
    uptime_seconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
  });

  router.get('/verification', asyncHandler(async (req, res) => {
    const mongoConnected = isMongoConnected();
    const requestedDatabase = req.get('x-demo-expected-mongodb-database');
    const requestedHost = req.get('x-demo-expected-mongodb-host');
    const requestedPort = req.get('x-demo-expected-mongodb-port');
    const requestedEnvironmentId = req.get('x-demo-expected-mongodb-environment-id');
    const identityRequested = typeof requestedDatabase === 'string'
      || typeof requestedHost === 'string'
      || typeof requestedPort === 'string'
      || typeof requestedEnvironmentId === 'string';
    const identityRequired = identityRequested
      || expectedDemoDatabase !== undefined
      || expectedDemoDatabaseHost !== undefined
      || expectedDemoDatabasePort !== undefined
      || expectedDemoEnvironmentId !== undefined;
    const databaseIdentityVerified = identityRequired && mongoConnected && verifyDemoDatabaseIdentity({
      actual: getMongoDatabaseName(),
      configuredExpected: expectedDemoDatabase,
      requestedExpected: identityRequested ? requestedDatabase : expectedDemoDatabase,
      actualHost: getMongoHost(),
      configuredExpectedHost: expectedDemoDatabaseHost,
      requestedExpectedHost: identityRequested ? requestedHost : expectedDemoDatabaseHost,
      actualPort: getMongoPort(),
      configuredExpectedPort: expectedDemoDatabasePort,
      requestedExpectedPort: identityRequested ? requestedPort : expectedDemoDatabasePort,
    });
    const environmentIdMatches = identityRequired
      && isSafeDemoEnvironmentId(expectedDemoEnvironmentId)
      && normalizeExpectedEnvironmentId(requestedEnvironmentId, expectedDemoEnvironmentId);
    const environmentSentinelVerified = databaseIdentityVerified && environmentIdMatches && mongoConnected
      ? await withTimeout(verifyDemoEnvironmentSentinel({
        database: mongoose.connection.db,
        expectedEnvironmentId: expectedDemoEnvironmentId,
      }), timeoutMs, 'Demo database sentinel verification').catch(() => false)
      : false;
    const [transactionCapable, redisConnected] = await Promise.all([
      identityRequired && (!databaseIdentityVerified || !environmentSentinelVerified)
        ? Promise.resolve(false)
        : withTimeout(verifyMongoTransaction({ timeoutMs, connection: mongoose.connection }), timeoutMs, 'Mongo verification probe').catch(() => false),
      withTimeout(verifyRedisConnection({ timeoutMs: verificationTimeoutMs, client: redisClient, available: redisAvailable }), verificationTimeoutMs, 'Redis verification probe').catch(() => false),
    ]);
    const verified = mongoConnected && transactionCapable
      && (!identityRequired || (databaseIdentityVerified && environmentSentinelVerified))
      && (!requireRedis || redisConnected);
    const body = {
      status: verified ? (identityRequired ? 'DEMO_DATABASE_VERIFIED' : 'RUNTIME_VERIFIED') : 'NOT_VERIFIED',
      buildSha: normalizeBuildSha(buildSha),
      buildProvenance: publicBuildProvenance(buildProvenance),
      mongo: {
        connected: mongoConnected,
        transactionCapable: Boolean(mongoConnected && transactionCapable),
        databaseIdentityVerified: Boolean(databaseIdentityVerified),
        environmentSentinelVerified: Boolean(environmentSentinelVerified),
      },
      redis: { required: requireRedis, connected: Boolean(redisConnected) },
      marketProvider: ['NSE', 'UPSTOX'].includes(marketProvider) ? marketProvider : 'INVALID',
      marketProviderTokenPresent: Boolean(marketProviderTokenPresent),
    };
    return res.status(verified ? 200 : 503).json(body);
  }));

  return router;
}

function publicBuildProvenance(value) {
  if (value?.status !== 'VERIFIED' || !value.manifest) {
    return { status: value?.status === 'INVALID' ? 'INVALID' : 'UNAVAILABLE', provenanceSha256: null };
  }
  const {
    schemaVersion,
    gitCommitSha,
    gitTreeSha,
    serverLockSha256,
    frontendLockSha256,
    mlRequirementsSha256,
    frontendArtifactSetSha256,
    serverImageIdentity,
    frontendImageIdentity,
    mlImageIdentity,
    workflowRunId,
    workflowRunAttempt,
    buildTimestamp,
    provenanceSha256,
  } = value.manifest;
  return {
    status: 'VERIFIED',
    schemaVersion,
    gitCommitSha,
    gitTreeSha,
    serverLockSha256,
    frontendLockSha256,
    mlRequirementsSha256,
    frontendArtifactSetSha256,
    serverImageIdentity,
    frontendImageIdentity,
    mlImageIdentity,
    workflowRunId,
    workflowRunAttempt,
    buildTimestamp,
    provenanceSha256,
  };
}

function normalizeExpectedEnvironmentId(requested, configured) {
  return isSafeDemoEnvironmentId(requested)
    && requested.toLowerCase() === configured.toLowerCase();
}

async function verifyConnectedMongoTransaction({ timeoutMs, connection }) {
  if (!connection || connection.readyState !== 1 || !connection.db) return false;
  let session;
  try {
    const hello = await withTimeout(connection.db.admin().command({ hello: 1 }), timeoutMs, 'Mongo verification hello');
    if (!hello.setName) return false;
    session = await withTimeout(mongoose.startSession(), timeoutMs, 'Mongo verification session');
    session.startTransaction();
    await withTimeout(connection.db.collection('financialprofiles').findOne({}, { session }), timeoutMs, 'Mongo verification read');
    await withTimeout(session.commitTransaction(), timeoutMs, 'Mongo verification commit');
    return true;
  } catch {
    if (session?.inTransaction()) await session.abortTransaction().catch(() => {});
    return false;
  } finally {
    await session?.endSession().catch(() => {});
  }
}

async function verifyConnectedRedis({ timeoutMs, client, available }) {
  if (!available || !client?.isReady) return false;
  try {
    return await withTimeout(client.ping(), timeoutMs, 'Redis verification ping') === 'PONG';
  } catch {
    return false;
  }
}

const router = createHealthRouter();
export default router;
