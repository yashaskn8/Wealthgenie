import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import mongoSanitize from 'express-mongo-sanitize';
import logger, { formatHttpAccessLog, morganStream } from './utils/logger.js';
import { getRuntimeConfig } from './config/runtime.js';
import { errorHandler, sendError } from './middleware/errorHandler.js';
import { enforceJsonContentType } from './middleware/contentType.js';
import { correlationIdMiddleware } from './middleware/correlation.js';
import { createCsrfProtection } from './middleware/csrf.js';
import { createOperationalMiddleware } from './middleware/operations.js';
import { authLimiter, apiLimiter } from './middleware/rateLimiter.js';
import authRoutes from './routes/auth.js';
import profileRoutes from './routes/profile.js';
import recommendRoutes from './routes/recommend.js';
import instrumentRoutes from './routes/instruments.js';
import projectionRoutes from './routes/projection.js';
import montecarloRoutes from './routes/montecarlo.js';
import goalRoutes from './routes/goals.js';
import marketRoutes from './routes/market.js';
import taxRoutes from './routes/tax.js';
import chatRoutes from './routes/chatRoutes.js';
import portfolioRoutes from './routes/portfolio.js';
import regimeRoutes from './routes/regime.js';
import metricsRoutes from './routes/metricsRoutes.js';
import { createMcpRouter } from './routes/mcpRouter.js';
import { createMcpCapacityController } from './mcp/mcpCapacity.js';
import { createMcpRuntime } from './mcp/mcpRuntime.js';
import agentRoutes from './routes/agentRoutes.js';
import genieProofRoutes from './routes/genieProofRoutes.js';
import { createGenieProofRuntime } from './agents/genieProof/genieProofPassportSignature.js';
import { createHealthRouter } from './routes/health.js';
import { createRuntimeState } from './services/runtimeState.js';
import { getCurrentFiscalYear, getCurrentRegulatoryRuleVersion } from './services/taxEngine.js';
import { PROJECTION_ASSUMPTION_VERSION } from './services/instrumentConstants.js';

function corsPolicy(config) {
  const allowlist = new Set(config.allowedOrigins);
  return {
    credentials: true,
    maxAge: 86400,
    origin(origin, callback) {
      if (!origin || allowlist.has(origin.replace(/\/+$/, ''))) return callback(null, true);
      const error = new Error(`CORS origin rejected: ${origin}`);
      error.status = 403;
      error.clientMessage = 'Origin is not allowed to access this API.';
      return callback(error);
    },
  };
}

export function buildHealthEngineMetadata(now = new Date()) {
  const fiscalYear = getCurrentFiscalYear(now);
  return {
    tax: fiscalYear,
    tax_policy_version: getCurrentRegulatoryRuleVersion(now),
    monte_carlo: 'Halton QMC + variance reduction',
    risk_profiler: '7-Factor Model',
    projections: 'Real + Nominal',
    projection_assumption_version: PROJECTION_ASSUMPTION_VERSION,
    post_tax: `${fiscalYear} compliance`,
  };
}

function detailedHealth(_req, res) {
  const memory = process.memoryUsage();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'WealthGenie API v3.0',
    uptime_seconds: Math.round(process.uptime()),
    memory: {
      rss_mb: Math.round(memory.rss / 1048576),
      heap_used_mb: Math.round(memory.heapUsed / 1048576),
      heap_total_mb: Math.round(memory.heapTotal / 1048576),
    },
    engines: buildHealthEngineMetadata(),
  });
}

export function createApp({ env = process.env, runtimeState = null, mcpRuntime = null, genieProofRuntime = null } = {}) {
  const config = getRuntimeConfig(env);
  const lifecycle = runtimeState || createRuntimeState();
  const mcpLifecycle = mcpRuntime || createMcpRuntime({
    toolTimeoutMs: config.mcp.toolTimeoutMs,
    shutdownGraceMs: config.mcp.shutdownGraceMs,
  });
  if (!mcpRuntime) mcpLifecycle.markReady();
  const mcpCapacity = createMcpCapacityController({ config: config.mcp, env });
  // Standalone app instances are considered ready; the process bootstrap passes
  // an explicit lifecycle and owns its transitions around dependency startup.
  if (!runtimeState) lifecycle.markReady();
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.locals.runtimeConfig = config;
  app.locals.runtimeState = lifecycle;
  app.locals.mcpRuntime = mcpLifecycle;
  app.locals.mcpCapacity = mcpCapacity;
  app.locals.genieProofRuntime = genieProofRuntime || createGenieProofRuntime({ env });
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    contentSecurityPolicy: config.isProduction ? {
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    } : false,
  }));
  app.use(correlationIdMiddleware);
  app.use(cors(corsPolicy(config)));
  app.use(createOperationalMiddleware({
    runtimeState: lifecycle,
    maxInFlightRequests: config.maxInFlightRequests,
  }));
  // MCP owns a smaller JSON limit and rejects dangerous keys before the global
  // sanitizer can remove evidence of an attack. It also uses Bearer auth and
  // its own distributed quotas, not cookie CSRF or the general API limiter.
  app.use('/api/mcp', createMcpRouter({ config, runtime: mcpLifecycle, capacity: mcpCapacity, env }));
  app.use(enforceJsonContentType);
  app.use(express.json({ limit: config.bodyLimit, strict: true }));
  app.use(mongoSanitize());
  app.use('/api', createCsrfProtection(config));

  if (config.nodeEnv !== 'test' && env.DISABLE_HTTP_LOGGING !== 'true') {
    app.use(morgan((tokens, req, res) => {
      const routePath = typeof req.route?.path === 'string'
        ? `${req.baseUrl || ''}${req.route.path}`
        : (req.baseUrl || '/api');
      return formatHttpAccessLog({
        method: tokens.method(req, res),
        path: routePath,
        status: tokens.status(req, res),
        contentLength: tokens.res(req, res, 'content-length'),
        responseTime: tokens['response-time'](req, res),
        requestId: req.correlationId,
      });
    }, { stream: morganStream }));
  }

  app.use((req, res, next) => {
    req._startTime = Date.now();
    res.on('finish', () => {
      const durationMs = Date.now() - req._startTime;
      if (durationMs > config.slowRequestMs) {
        logger.warn('Slow request detected', {
          correlationId: req.correlationId,
          method: req.method,
          path: typeof req.route?.path === 'string'
            ? `${req.baseUrl || ''}${req.route.path}`
            : (req.baseUrl || '/api'),
          durationMs,
        });
      }
    });
    next();
  });

  app.use('/api/auth', authLimiter);
  app.use('/api', apiLimiter);
  const healthRoutes = createHealthRouter({
    runtimeState: lifecycle,
    requireRedis: config.requireRedis,
    requireAgentRuntimePersistence: config.agenticPlanReviewEnabled,
    requireMcp: config.isProduction && config.mcp.enabled && config.mcp.remoteEnabled,
    mcpRuntime: mcpLifecycle,
    mcpCapacity,
    timeoutMs: config.deepHealthTimeoutMs,
    buildSha: env.APP_BUILD_SHA,
    expectedDemoDatabase: env.DEMO_EXPECTED_MONGODB_DATABASE,
    expectedDemoDatabaseHost: env.DEMO_EXPECTED_MONGODB_HOST,
    expectedDemoDatabasePort: env.DEMO_EXPECTED_MONGODB_PORT,
    expectedDemoEnvironmentId: env.DEMO_EXPECTED_MONGODB_ENVIRONMENT_ID,
    marketProvider: String(env.MARKET_DATA_PRIMARY_PROVIDER || 'NSE').trim().toUpperCase(),
    marketProviderTokenPresent: String(env.MARKET_DATA_PRIMARY_PROVIDER || 'NSE').trim().toUpperCase() === 'NSE'
      || Boolean(env.UPSTOX_ANALYTICS_TOKEN || env.UPSTOX_ACCESS_TOKEN),
  });
  app.use('/health', healthRoutes);
  app.get('/ready', (_req, res) => res.redirect(307, '/health/ready'));
  app.get('/live', (_req, res) => res.redirect(307, '/health/live'));
  app.get('/healthz', (_req, res) => res.status(200).json({
    status: 'ALIVE', uptime_seconds: Math.round(process.uptime()), timestamp: new Date().toISOString(),
  }));
  app.get('/readyz', (_req, res) => res.redirect(307, '/health/ready'));

  app.use('/api/auth', authRoutes);
  app.use('/api/profile', profileRoutes);
  app.use('/api/recommend', recommendRoutes);
  app.use('/api/instruments', instrumentRoutes);
  app.use('/api/projection', projectionRoutes);
  app.use('/api/montecarlo', montecarloRoutes);
  app.use('/api/goals', goalRoutes);
  app.use('/api/market', marketRoutes);
  app.use('/api/tax', taxRoutes);
  app.use('/api/chat', chatRoutes);
  app.use('/api/portfolio', portfolioRoutes);
  app.use('/api/regime', regimeRoutes);
  app.use('/api/metrics', metricsRoutes);
  app.use('/api/agent', agentRoutes);
  app.use('/api/genieproof', genieProofRoutes);
  app.get('/api/health', detailedHealth);

  app.use((req, res) => sendError(req, res, 404, 'Route not found.', 'ROUTE_NOT_FOUND'));
  app.use(errorHandler);
  return app;
}

const app = createApp();
export default app;
