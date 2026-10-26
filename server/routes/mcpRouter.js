import express from 'express';
import { getRuntimeConfig } from '../config/runtime.js';
import { asyncHandler, sendError } from '../middleware/errorHandler.js';
import { verifyMcpBearer } from '../middleware/mcpAuth.js';
import { mcpHttpBoundary } from '../mcp/mcpHttpBoundary.js';
import { createMcpCapacityController, McpCapacityError } from '../mcp/mcpCapacity.js';
import { createMcpRuntime } from '../mcp/mcpRuntime.js';
import { handleStatelessMcpRequest, validateMcpPayload } from '../mcp/wealthgenieMcpServer.js';
import { PrometheusMetrics } from '../services/metricsCollector.js';

function createReadyRuntime(config) {
  const runtime = createMcpRuntime({
    toolTimeoutMs: config.mcp.toolTimeoutMs,
    shutdownGraceMs: config.mcp.shutdownGraceMs,
  });
  runtime.markReady();
  return runtime;
}

export function createMcpRouter({
  config = getRuntimeConfig(),
  runtime = createReadyRuntime(config),
  capacity = createMcpCapacityController({ config: config.mcp, env: { NODE_ENV: config.nodeEnv } }),
  env = process.env,
  authenticate = verifyMcpBearer({ config: config.mcp, env }),
  toolRegistry,
} = {}) {
  const router = express.Router();
  const boundaryConfig = {
    isProduction: config.isProduction,
    allowedHosts: config.mcp.allowedHosts,
    allowedOrigins: config.mcp.allowedOrigins,
    trustedProxyCidrs: config.trustedProxyCidrs || [],
    directTls: config.mcp.directTls === true,
  };

  router.use((req, res, next) => {
    PrometheusMetrics.inc('mcp_requests_total');
    let failureRecorded = false;
    const recordFailure = () => {
      if (failureRecorded) return;
      failureRecorded = true;
      PrometheusMetrics.inc('mcp_request_failures_total');
    };
    res.once('finish', () => {
      if (res.statusCode >= 400) recordFailure();
    });
    res.once('close', () => { if (!res.writableEnded) recordFailure(); });
    req.once('aborted', recordFailure);
    next();
  });

  router.all('*', (req, res, next) => {
    if (!config.mcp.enabled || !config.mcp.remoteEnabled) {
      return sendError(req, res, 503, 'MCP remote access is disabled.', 'MCP_DISABLED');
    }
    if (req.path !== '/') {
      return sendError(req, res, 404, 'The requested MCP route does not exist.', 'MCP_ROUTE_NOT_FOUND');
    }
    if (req.method !== 'POST') {
      res.set('Allow', 'POST');
      return sendError(req, res, 405, 'Only POST is supported by the MCP endpoint.', 'MCP_METHOD_NOT_ALLOWED');
    }
    if (Object.keys(req.query || {}).length > 0) {
      return sendError(req, res, 400, 'Query parameters are not supported by the MCP endpoint.', 'MCP_QUERY_NOT_SUPPORTED');
    }
    if (Number(req.headers['content-length'] || 0) > config.mcp.maxRequestBytes) {
      return sendError(req, res, 413, 'The MCP request exceeds the configured size limit.', 'MCP_REQUEST_TOO_LARGE');
    }
    return next();
  });

  router.use(mcpHttpBoundary({ config: boundaryConfig }));
  router.use(authenticate);
  router.use(express.json({
    limit: config.mcp.maxRequestBytes,
    strict: true,
    type: 'application/json',
    // Fail closed for compressed JSON rather than entering vulnerable
    // body-parser decompression (GHSA-27r3-jxmh-p828).
    inflate: false,
  }));
  router.post('/', asyncHandler(async (req, res) => {
    if (!req.is('application/json')) {
      return sendError(req, res, 415, 'MCP requests must use application/json.', 'MCP_CONTENT_TYPE_REQUIRED');
    }
    try {
      validateMcpPayload(req.body);
      await capacity.checkRequest(req.mcpPrincipal.userId);
      const profileId = req.headers['x-wealthgenie-profile-id'];
      if (profileId !== undefined && (typeof profileId !== 'string' || profileId.length > 64)) {
        return sendError(req, res, 400, 'The profile selector is invalid.', 'MCP_PROFILE_SELECTOR_INVALID');
      }
      await handleStatelessMcpRequest(req, res, {
        principal: req.mcpPrincipal,
        profileId: profileId || null,
        capacity,
        runtime,
        config: config.mcp,
        ...(toolRegistry ? { toolRegistry } : {}),
      });
      return undefined;
    } catch (error) {
      if (res.headersSent || res.writableEnded) return undefined;
      if (error instanceof McpCapacityError) {
        PrometheusMetrics.inc('mcp_capacity_rejections_total');
        return sendError(req, res, error.status, error.message, error.code);
      }
      if (error?.code === 'MCP_DRAINING') {
        return sendError(req, res, 503, 'MCP is not accepting new work.', 'MCP_DRAINING');
      }
      if (error?.type === 'entity.too.large') {
        return sendError(req, res, 413, 'The MCP request exceeds the configured size limit.', 'MCP_REQUEST_TOO_LARGE');
      }
      if (error instanceof SyntaxError || error?.type === 'entity.parse.failed') {
        return sendError(req, res, 400, 'The MCP request body is not valid JSON.', 'MCP_INVALID_JSON');
      }
      const code = typeof error?.code === 'string' && /^MCP_[A-Z0-9_]+$/.test(error.code)
        ? error.code : 'MCP_REQUEST_FAILED';
      const clientInputError = new Set([
        'MCP_UNSAFE_PROPERTY', 'MCP_PAYLOAD_COMPLEXITY_LIMIT', 'MCP_NON_FINITE_NUMBER',
        'MCP_STRING_LIMIT', 'MCP_INVALID_ARGUMENTS', 'MCP_RESULT_TOO_LARGE',
      ]).has(code);
      return sendError(req, res, error?.status === 503 ? 503 : clientInputError ? 400 : 500,
        'The MCP request could not be completed.', code);
    }
  }));

  router.use((error, req, res, next) => {
    if (error?.type === 'entity.too.large') {
      return sendError(req, res, 413, 'The MCP request exceeds the configured size limit.', 'MCP_REQUEST_TOO_LARGE');
    }
    if (error?.type === 'entity.parse.failed' || error instanceof SyntaxError) {
      return sendError(req, res, 400, 'The MCP request body is not valid JSON.', 'MCP_INVALID_JSON');
    }
    return next(error);
  });

  return router;
}

const defaultConfig = getRuntimeConfig();
const defaultRouter = createMcpRouter({ config: defaultConfig });
export default defaultRouter;
