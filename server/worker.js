import 'dotenv/config';
import tracingSdk from './config/tracing.js';
import mongoose from 'mongoose';
import connectDB from './config/db.js';
import { connectRedis, redisAvailable, redisClient } from './config/redis.js';
import { getRuntimeConfig, assertValidRuntimeConfig } from './config/runtime.js';
import { validateEnvironmentConfig } from './config/validateEnv.js';
import { createPlanReviewWorker } from './agents/planReview/planReviewWorker.js';
import { createProofBreakWorker } from './agents/genieProof/proofBreakWorker.js';
import { createGenieProofRuntime } from './agents/genieProof/genieProofPassportSignature.js';
import { resolveGenieProofEvidenceForClaims } from './agents/genieProof/genieProofEvidenceRegistryService.js';
import AgentRunEvent from './models/AgentRunEvent.js';
import ProductionAgentEvaluation from './models/ProductionAgentEvaluation.js';
import {
  startProductionEvaluationReconciliation,
  stopProductionEvaluationReconciliation,
} from './agents/evals/productionEvaluationQueue.js';
import { createWorkerHealthServer } from './services/workerHealthServer.js';
import { verifyPlanReviewPersistenceIndexes } from './services/planReviewPersistence.js';
import { getPlanHealthSchedulerState, startPlanHealthScheduler, stopPlanHealthScheduler } from './services/planHealthScheduler.js';
import { verifyAgentRuntimePersistence, verifyPlanHealthPersistence } from './services/planHealthPersistence.js';
import { verifyGenieProofPersistenceIndexes } from './services/persistenceIndexReadiness.js';
import logger from './utils/logger.js';
import { createDecisionMonitorWorker } from './services/genieDecision/monitor.js';
import { decisionIntegrityReady } from './services/genieDecision/integrity.js';
import { verifyPersistenceIndexes } from './services/persistenceIndexReadiness.js';
import DecisionMonitor from './models/DecisionMonitor.js';
import DecisionAssessment from './models/DecisionAssessment.js';
import DecisionEvent from './models/DecisionEvent.js';
import DecisionEventState from './models/DecisionEventState.js';

let healthServer = null;
let worker = null;
let proofBreakWorker = null;
let decisionMonitorWorker = null;
let shutdownPromise = null;

function shutdownDeadlineError(label) {
  const error = new Error(`Agent worker shutdown deadline expired during ${label}.`);
  error.code = 'AGENT_WORKER_SHUTDOWN_DEADLINE';
  return error;
}

export async function awaitWithinShutdownDeadline(operation, deadlineAt, label, {
  clock = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const remainingMs = Math.floor(deadlineAt - clock());
  if (remainingMs <= 0) throw shutdownDeadlineError(label);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise((_, reject) => { timer = setTimer(() => reject(shutdownDeadlineError(label)), remainingMs); }),
    ]);
  } finally {
    if (timer) clearTimer(timer);
  }
}

export async function closeWorkerInfrastructure(config, overrides = {}) {
  const clock = overrides.clock || Date.now;
  const deadlineAt = clock() + config.agentPlanReview.shutdownGraceMs;
  const activeWorker = Object.hasOwn(overrides, 'worker') ? overrides.worker : worker;
  const activeProofBreakWorker = Object.hasOwn(overrides, 'proofBreakWorker') ? overrides.proofBreakWorker : proofBreakWorker;
  const activeDecisionMonitor = Object.hasOwn(overrides, 'decisionMonitorWorker')
    ? overrides.decisionMonitorWorker : decisionMonitorWorker;
  const activeHealthServer = Object.hasOwn(overrides, 'healthServer') ? overrides.healthServer : healthServer;
  const stopPlanHealth = overrides.stopPlanHealthScheduler || stopPlanHealthScheduler;
  const stopWorkerRuntime = overrides.stopWorker || (activeWorker ? activeWorker.stop.bind(activeWorker) : () => Promise.resolve({ drained: true }));
  const stopProofBreakRuntime = overrides.stopProofBreakWorker || (activeProofBreakWorker ? activeProofBreakWorker.stop.bind(activeProofBreakWorker) : () => Promise.resolve({ drained: true }));
  const awaitDeadline = (operation, label) => awaitWithinShutdownDeadline(operation, deadlineAt, label, {
    clock,
    setTimer: overrides.setTimer || setTimeout,
    clearTimer: overrides.clearTimer || clearTimeout,
  });
  const [planHealthStop, workerStop, proofBreakStop, decisionMonitorStop] = await awaitDeadline(Promise.all([
    stopPlanHealth({ graceMs: Math.max(0, deadlineAt - clock()) }),
    stopWorkerRuntime({ graceMs: Math.max(0, deadlineAt - clock()) }),
    stopProofBreakRuntime({ graceMs: Math.max(0, deadlineAt - clock()) }),
    activeDecisionMonitor?.stop() || Promise.resolve({ drained: true }),
  ]), 'agent drain');
  if (!planHealthStop.drained || workerStop?.drained === false || proofBreakStop?.drained === false
      || decisionMonitorStop?.drained === false) {
    const error = new Error('Agent worker shutdown deadline expired before durable work drained.');
    error.code = 'AGENT_WORKER_DRAIN_TIMEOUT';
    throw error;
  }
  if (activeWorker === worker) worker = null;
  if (activeProofBreakWorker === proofBreakWorker) proofBreakWorker = null;
  if (activeDecisionMonitor === decisionMonitorWorker) decisionMonitorWorker = null;
  await awaitDeadline(stopProductionEvaluationReconciliation(), 'evaluation reconciliation drain');
  await awaitDeadline(activeHealthServer?.close().catch(error => {
    logger.warn('Agent worker health server close failed', { code: error?.code || 'HEALTH_SERVER_CLOSE_FAILED' });
  }), 'health server close');
  if (activeHealthServer === healthServer) healthServer = null;
  const mongoConnection = overrides.mongoConnection || mongoose.connection;
  const activeRedisClient = Object.hasOwn(overrides, 'redisClient') ? overrides.redisClient : redisClient;
  const activeTracingSdk = overrides.tracingSdk || tracingSdk;
  const closers = [];
  if (mongoConnection.readyState !== 0) closers.push(() => mongoConnection.close());
  if (activeRedisClient?.isOpen) closers.push(() => activeRedisClient.quit());
  closers.push(() => activeTracingSdk.shutdown());
  const results = await awaitDeadline(Promise.allSettled(closers.map(close => Promise.resolve().then(close))), 'dependency flush and close');
  for (const result of results) {
    if (result.status === 'rejected') {
      logger.warn('Agent worker dependency close failed', { code: result.reason?.code || 'DEPENDENCY_CLOSE_FAILED' });
    }
  }
}

export async function startWorker({ env = process.env } = {}) {
  const validation = validateEnvironmentConfig(env);
  if (!validation.valid) throw new Error(`Invalid environment configuration: ${validation.errors.join('; ')}`);
  const config = getRuntimeConfig(env);
  assertValidRuntimeConfig(config);
  if (config.agentWorkerMode !== 'external') throw new Error('The standalone worker requires AGENT_WORKER_MODE=external');

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
    requireTransactions: true,
  });
  if (config.agenticPlanReviewEnabled) await verifyPlanReviewPersistenceIndexes();
  if (config.agenticPlanReviewEnabled) await verifyAgentRuntimePersistence({ force: true });
  if (config.planHealth.enabled) await verifyPlanHealthPersistence({ force: true });
  const genieProofRuntime = createGenieProofRuntime({ env });
  const proofBreakEnabled = genieProofRuntime.enabled && env.GENIEPROOF_PROOFBREAK_WORKER_ENABLED === 'true';
  if (proofBreakEnabled) await verifyGenieProofPersistenceIndexes({ force: true });
  await connectRedis({ url: env.REDIS_URL, password: env.REDIS_PASSWORD });
  if (config.requireRedis && !redisAvailable) throw new Error('Redis is required in this environment but is unavailable');

  worker = createPlanReviewWorker({ runtimeConfig: config, eventModel: AgentRunEvent, productionEvaluationModel: ProductionAgentEvaluation });
  worker.start({ intervalMs: Number(env.AGENT_WORKER_POLL_MS) || 500 });
  if (config.agenticPlanReviewEnabled) {
    startProductionEvaluationReconciliation({
      eventModel: AgentRunEvent,
      evaluationModel: ProductionAgentEvaluation,
    });
  }
  if (config.planHealth.enabled) startPlanHealthScheduler({ config: config.planHealth });
  if (env.GENIEDECISION_MONITOR_ENABLED === 'true') {
    if (!decisionIntegrityReady()) {
      throw new Error('GenieDecision monitoring cannot start without a valid authenticated receipt keyring.');
    }
    await verifyPersistenceIndexes({
      models: [DecisionMonitor, DecisionAssessment, DecisionEvent, DecisionEventState],
      scope: 'persistence',
    });
    decisionMonitorWorker = createDecisionMonitorWorker({
      pollMs: Number(env.GENIEDECISION_MONITOR_POLL_MS) || 60000,
    });
    decisionMonitorWorker.start();
  }
  if (proofBreakEnabled) {
    proofBreakWorker = createProofBreakWorker({
      signer: genieProofRuntime.signer,
      evidenceResolver: resolveGenieProofEvidenceForClaims,
    });
    proofBreakWorker.start({ intervalMs: Number(env.GENIEPROOF_PROOFBREAK_POLL_MS) || 2_000 });
  }
  healthServer = createWorkerHealthServer({
    port: config.agentPlanReview.healthPort,
    stateProvider: () => ({ ...worker?.state(), planHealth: getPlanHealthSchedulerState(), proofBreak: proofBreakWorker?.state() || { running: false, ready: false, activeJobs: 0 },
      decisionMonitor: decisionMonitorWorker?.state() || { enabled: false, activeJobs: 0 } }),
    requireRedis: config.requireRedis,
    requirePlanReviewIndexes: config.agenticPlanReviewEnabled,
    requirePlanHealthPersistence: config.planHealth.enabled,
    requireAgentRuntimePersistence: config.agenticPlanReviewEnabled,
  });
  await healthServer.listen();
  logger.info('WealthGenie agent worker started', { healthPort: config.agentPlanReview.healthPort });
  return { worker, healthServer };
}

export async function stopWorker({ config = getRuntimeConfig(process.env), signal = 'manual' } = {}) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    logger.info('Agent worker shutdown initiated', { signal });
    try {
      await closeWorkerInfrastructure(config);
      logger.info('Agent worker shutdown completed', { signal });
    } finally {
      shutdownPromise = null;
    }
  })();
  return shutdownPromise;
}

const isMainModule = process.argv[1] && process.argv[1].endsWith('worker.js');
if (isMainModule && process.env.NODE_ENV !== 'test') {
  let config = null;
  let terminationPromise = null;
  let terminationExitCode = 0;
  const terminate = async (signal, error = null) => {
    if (error) terminationExitCode = 1;
    if (terminationPromise) {
      logger.warn('Additional worker termination signal received during bounded shutdown', { signal });
      return terminationPromise;
    }
    terminationPromise = (async () => {
    if (error) logger.error('Agent worker fatal error', { signal, message: error.message });
    try {
      await stopWorker({ config: config || getRuntimeConfig(process.env), signal });
      logger.info('Agent worker shutdown completed', { signal });
    } catch (shutdownError) {
      logger.error('Agent worker forced shutdown', { signal, message: shutdownError.message });
      terminationExitCode = 1;
    }
    process.exit(terminationExitCode);
    })();
    return terminationPromise;
  };
  process.on('SIGTERM', () => void terminate('SIGTERM'));
  process.on('SIGINT', () => void terminate('SIGINT'));
  process.on('uncaughtException', error => void terminate('uncaughtException', error));
  process.on('unhandledRejection', reason => void terminate('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason))));
  startWorker().then(() => { config = getRuntimeConfig(process.env); }).catch(error => void terminate('startup', error));
}
