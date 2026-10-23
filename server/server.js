import './config/bootstrapEnvironment.js';
import tracingSdk from './config/tracing.js';
import { createServer as createHttpServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { closeFinancialPostgresPool, getFinancialPostgresPool } from './postgres/connection.js';
import { verifyFinancialPrivateIndexes } from './services/financialPrivateIndexReadiness.js';
import { createApp } from './app.js';
import connectDB from './config/db.js';
import { connectRedis, redisAvailable, redisClient } from './config/redis.js';
import { getRuntimeConfig, assertValidRuntimeConfig } from './config/runtime.js';
import { validateEnvironmentConfig } from './config/validateEnv.js';
import { startMarketDataRefreshJobs, stopMarketDataRefreshJobs } from './jobs/marketDataRefresh.js';
import { startCoverageRiskWorker, stopCoverageRiskWorker } from './jobs/coverageRiskAlerts.js';
import { startPlanReviewWorker, stopPlanReviewWorker } from './agents/planReview/planReviewWorker.js';
import logger from './utils/logger.js';
import { createRuntimeState } from './services/runtimeState.js';
import { warmAdvisoryPersistence } from './services/advisoryPersistence.js';
import { verifyGenieProofPersistenceIndexes, verifyMarketDataPersistenceIndexes } from './services/persistenceIndexReadiness.js';
import { verifyPlanReviewPersistenceIndexes } from './services/planReviewPersistence.js';
import { verifyAgentRuntimePersistence } from './services/planHealthPersistence.js';
import AgentRunEvent from './models/AgentRunEvent.js';
import ProductionAgentEvaluation from './models/ProductionAgentEvaluation.js';
import {
  startProductionEvaluationReconciliation,
  stopProductionEvaluationReconciliation,
} from './agents/evals/productionEvaluationQueue.js';
import { warmAuthorizationPersistence } from './services/authorizationPersistence.js';
import { reconcileAuthorizedExecutions } from './agents/authorization/executionRecovery.js';
import { createMcpRuntime } from './mcp/mcpRuntime.js';
import { createGenieProofRuntime } from './agents/genieProof/genieProofPassportSignature.js';

let server = null;
let shuttingDown = false;
let processHandlersInstalled = false;
const runtimeState = createRuntimeState();
let activeConfig = null;
let authorizedRecoveryTimer = null;
let activeMcpRuntime = null;

export async function verifyEnabledApiAgentPersistence(config, verifier = verifyAgentRuntimePersistence) {
  if (!config.agenticPlanReviewEnabled) return { ready: true, skipped: true };
  return verifier({ force: true });
}

function configureHttpServer(httpServer, config) {
  httpServer.requestTimeout = config.http.requestTimeoutMs;
  httpServer.headersTimeout = config.http.headersTimeoutMs;
  httpServer.keepAliveTimeout = config.http.keepAliveTimeoutMs;
  httpServer.maxRequestsPerSocket = 1000;
}

function closeHttpServer(httpServer) {
  if (!httpServer?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    httpServer.close(error => error ? reject(error) : resolve());
    httpServer.closeIdleConnections?.();
  });
}

async function closeInfrastructure({ stopAgentWorker = false } = {}) {
  stopMarketDataRefreshJobs();
  await stopCoverageRiskWorker();
  if (stopAgentWorker) await stopPlanReviewWorker();
  await stopProductionEvaluationReconciliation();
  if (authorizedRecoveryTimer) clearInterval(authorizedRecoveryTimer);
  authorizedRecoveryTimer = null;
  const closers = [];
  if (mongoose.connection.readyState !== 0) closers.push(mongoose.connection.close());
  if (redisClient?.isOpen) closers.push(redisClient.quit());
  closers.push(closeFinancialPostgresPool());
  closers.push(tracingSdk.shutdown());
  await Promise.allSettled(closers);
}

export async function startServer({ env = process.env } = {}) {
  if (server) return server;
  const validation = validateEnvironmentConfig(env);
  if (!validation.valid) {
    throw new Error(`Invalid environment configuration: ${validation.errors.join('; ')}`);
  }

  const config = getRuntimeConfig(env);
  assertValidRuntimeConfig(config);
  const genieProofRuntime = createGenieProofRuntime({ env });
  activeConfig = config;
  runtimeState.markStarting();
  const mcpRuntime = createMcpRuntime({
    toolTimeoutMs: config.mcp.toolTimeoutMs,
    shutdownGraceMs: config.mcp.shutdownGraceMs,
  });
  activeMcpRuntime = mcpRuntime;

  try {
    await connectDB({
      uri: env.MONGODB_URI,
      env,
      options: {
        autoIndex: config.mongo.autoIndex,
        maxPoolSize: config.mongo.maxPoolSize,
        minPoolSize: config.mongo.minPoolSize,
        serverSelectionTimeoutMS: config.mongo.serverSelectionTimeoutMs,
        socketTimeoutMS: config.mongo.socketTimeoutMs,
        maxIdleTimeMS: config.mongo.maxIdleTimeMs,
      },
      // Profile completion persists the profile, recommendation, audit record,
      // and idempotency result atomically. Fail startup early if the local or
      // deployed MongoDB is not transaction-capable instead of returning a
      // 503 only after a user submits the profile.
      requireTransactions: true,
    });
    // Fail startup rather than serving false-ready financial-universe routes.
    if (env.FINANCIAL_POSTGRES_ENABLED === 'true') await getFinancialPostgresPool(env);
    if (env.FINANCIAL_ARCHITECTURE_ENABLED === 'true') {
      // Create indexes only through the separate migration script. Never silently
      // enable private tax/valuation routes if required unique or expiry indexes are absent.
      await verifyFinancialPrivateIndexes();
    }
    await warmAdvisoryPersistence();
    await verifyMarketDataPersistenceIndexes({ force: true });
    if (genieProofRuntime.enabled) await verifyGenieProofPersistenceIndexes({ force: true });
    if (config.agenticPlanReviewEnabled) {
      await verifyPlanReviewPersistenceIndexes();
      await verifyEnabledApiAgentPersistence(config);
    }
    if (config.authorization.verifiableActionsEnabled) await warmAuthorizationPersistence();
    await connectRedis({ url: env.REDIS_URL, password: env.REDIS_PASSWORD });
    if (config.requireRedis && !redisAvailable) {
      throw new Error('Redis is required in this environment but is unavailable');
    }

    const app = createApp({ env, runtimeState, mcpRuntime, genieProofRuntime });
    if (config.isProduction && config.mcp.enabled && config.mcp.remoteEnabled
        && !(await app.locals.mcpCapacity.probe())) {
      throw new Error('MCP distributed capacity and revocation dependencies failed their readiness contract probe.');
    }
    server = createHttpServer(app);
    configureHttpServer(server, config);
    await new Promise((resolve, reject) => {
      const onError = error => {
        server?.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server?.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(config.port);
    });
    startMarketDataRefreshJobs();
    startCoverageRiskWorker({ env });
    if (config.agentWorkerEnabled && config.agentWorkerMode === 'embedded') {
      startPlanReviewWorker({ runtimeConfig: config, eventModel: AgentRunEvent, productionEvaluationModel: ProductionAgentEvaluation });
      if (config.agenticPlanReviewEnabled) {
        startProductionEvaluationReconciliation({
          eventModel: AgentRunEvent,
          evaluationModel: ProductionAgentEvaluation,
        });
      }
    }
    if (config.authorization.verifiableActionsEnabled) {
      authorizedRecoveryTimer = setInterval(() => {
        void reconcileAuthorizedExecutions({ runtimeConfig: config }).catch(error => logger.warn('Authorized execution recovery sweep failed', { code: error.code || 'RECOVERY_SWEEP_FAILED' }));
      }, 30000);
      authorizedRecoveryTimer.unref?.();
    }
    runtimeState.markReady();
    mcpRuntime.markReady();
    logger.info('WealthGenie API started', { port: config.port, env: config.nodeEnv });
    return server;
  } catch (error) {
    await mcpRuntime.drain({ graceMs: 0 }).catch(() => {});
    runtimeState.markStopped();
    await closeHttpServer(server).catch(() => {});
    server = null;
    activeMcpRuntime = null;
    await closeInfrastructure({ stopAgentWorker: config.agentWorkerMode === 'embedded' });
    throw error;
  }
}

export async function stopServer({ signal = 'manual', timeoutMs } = {}) {
  if (shuttingDown) return;
  shuttingDown = true;
  runtimeState.markDraining();
  const mcpRuntime = activeMcpRuntime;
  const config = activeConfig || getRuntimeConfig(process.env);
  const deadlineMs = timeoutMs || config.http.shutdownTimeoutMs;
  logger.info('Graceful shutdown initiated', { signal, deadlineMs });

  let deadlineTimer;
  const deadline = new Promise((_, reject) => {
    deadlineTimer = setTimeout(() => {
      server?.closeAllConnections?.();
      reject(new Error('Graceful shutdown timed out'));
    }, deadlineMs);
    deadlineTimer.unref?.();
  });

  try {
    await Promise.race([
      (async () => {
        await mcpRuntime?.drain({ graceMs: config.mcp.shutdownGraceMs });
        await closeHttpServer(server);
        await closeInfrastructure({ stopAgentWorker: config.agentWorkerMode === 'embedded' });
      })(),
      deadline,
    ]);
    logger.info('Graceful shutdown completed', { signal });
  } finally {
    clearTimeout(deadlineTimer);
    runtimeState.markStopped();
    server = null;
    activeConfig = null;
    activeMcpRuntime = null;
    shuttingDown = false;
  }
}

async function terminate(signal, error = null) {
  if (error) logger.error('Fatal process error', { signal, message: error.message, stack: error.stack });
  try {
    await stopServer({ signal });
    process.exit(error ? 1 : 0);
  } catch (shutdownError) {
    logger.error('Forced shutdown', { signal, message: shutdownError.message });
    process.exit(1);
  }
}

export function installProcessHandlers() {
  if (processHandlersInstalled) return;
  processHandlersInstalled = true;
  process.once('SIGTERM', () => terminate('SIGTERM'));
  process.once('SIGINT', () => terminate('SIGINT'));
  process.once('uncaughtException', error => terminate('uncaughtException', error));
  process.once('unhandledRejection', reason => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    terminate('unhandledRejection', error);
  });
}

const isMainModule = process.argv[1]
  && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMainModule && process.env.NODE_ENV !== 'test') {
  installProcessHandlers();
  startServer().catch(error => terminate('startup', error));
}

export { runtimeState };
export { default } from './app.js';
