import { getMongoFlavor } from './mongoCompatibility.js';

const LOCAL_DEVELOPMENT_ORIGINS = ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173'];
const LOCAL_MCP_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

function positiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function parseTrustProxy(value, isProduction, trustedProxyCidrs = []) {
  if (isProduction) return trustedProxyCidrs.length ? trustedProxyCidrs : false;
  if (value === undefined || value === '') return false;
  if (value === 'false') return false;
  if (value === 'true') return 1;
  const hops = Number(value);
  return Number.isInteger(hops) && hops >= 0 && hops <= 10 ? hops : false;
}

function booleanValue(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return value === 'true';
}

function enumValue(value, fallback, allowed) {
  const normalized = String(value || fallback).trim().toLowerCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

export function getRuntimeConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';
  const configuredOrigins = (env.CORS_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  const agentWorkerMode = enumValue(
    env.AGENT_WORKER_MODE,
    isProduction ? 'external' : 'embedded',
    ['embedded', 'external'],
  );
  const agentIdentityProvider = enumValue(env.AGENT_IDENTITY_PROVIDER, 'development', ['development', 'oidc', 'spiffe']);
  const agentWorkflowBackend = enumValue(env.AGENT_WORKFLOW_BACKEND, 'mongo', ['mongo', 'temporal']);
  const agentApprovalProvider = enumValue(env.AGENT_APPROVAL_PROVIDER, isProduction ? 'webauthn' : 'development', ['development', 'webauthn']);
  const mcpEnabled = booleanValue(env.MCP_ENABLED, !isProduction);
  const trustedProxyCidrs = (env.TRUSTED_PROXY_CIDRS || '').split(',').map(value => value.trim()).filter(Boolean);
  const mcpSecret = env.MCP_JWT_SECRET || null;
  return Object.freeze({
    nodeEnv,
    isProduction,
    port: positiveInteger(env.PORT, 5000, { max: 65535 }),
    trustProxy: parseTrustProxy(env.TRUST_PROXY, isProduction, trustedProxyCidrs),
    trustedProxyCidrs: Object.freeze(trustedProxyCidrs),
    allowedOrigins: configuredOrigins.length > 0
      ? configuredOrigins
      : (isProduction ? [] : LOCAL_DEVELOPMENT_ORIGINS),
    bodyLimit: env.REQUEST_BODY_LIMIT || '100kb',
    slowRequestMs: positiveInteger(env.SLOW_REQUEST_MS, 3000, { min: 100 }),
    maxInFlightRequests: positiveInteger(env.MAX_IN_FLIGHT_REQUESTS, 250, { min: 1, max: 10000 }),
    requireRedis: booleanValue(env.REQUIRE_REDIS, isProduction),
    mcp: Object.freeze({
      enabled: mcpEnabled,
      // Remote execution is opt-in in production, even if MCP's local or
      // stdio tooling is enabled. In development it follows MCP_ENABLED.
      remoteEnabled: booleanValue(env.MCP_REMOTE_ENABLED, mcpEnabled && !isProduction),
      legacySseEnabled: booleanValue(env.MCP_LEGACY_SSE_ENABLED, false),
      jwtAudience: env.MCP_JWT_AUDIENCE?.trim() || null,
      jwtIssuer: env.MCP_JWT_ISSUER?.trim() || null,
      jwtSecret: mcpSecret,
      jwtSecretIsolated: Boolean(mcpSecret && mcpSecret !== env.JWT_SECRET),
      directTls: booleanValue(env.MCP_DIRECT_TLS, false),
      requiredScope: env.MCP_REQUIRED_SCOPE?.trim() || null,
      allowedHosts: (env.MCP_ALLOWED_HOSTS || (isProduction ? '' : LOCAL_MCP_HOSTS.join(',')))
        .split(',').map(value => value.trim().toLowerCase()).filter(Boolean),
      allowedOrigins: (env.MCP_ALLOWED_ORIGINS || (isProduction ? '' : LOCAL_DEVELOPMENT_ORIGINS.join(',')))
        .split(',').map(value => value.trim().replace(/\/+$/, '')).filter(Boolean),
      maxRequestBytes: positiveInteger(env.MCP_MAX_REQUEST_BYTES, 32768, { min: 1024, max: 131072 }),
      rateWindowMs: positiveInteger(env.MCP_RATE_WINDOW_MS, 60000, { min: 1000, max: 3600000 }),
      maxRequestsPerWindow: positiveInteger(env.MCP_MAX_REQUESTS_PER_WINDOW, 120, { min: 1, max: 10000 }),
      maxToolCallsPerWindow: Object.freeze({
        LOW: positiveInteger(env.MCP_MAX_LOW_COST_CALLS_PER_WINDOW, 60, { min: 1, max: 10000 }),
        MEDIUM: positiveInteger(env.MCP_MAX_MEDIUM_COST_CALLS_PER_WINDOW, 30, { min: 1, max: 10000 }),
        HIGH: positiveInteger(env.MCP_MAX_HIGH_COST_CALLS_PER_WINDOW, 10, { min: 1, max: 10000 }),
      }),
      maxConcurrentPerUser: positiveInteger(env.MCP_MAX_CONCURRENT_PER_USER, 3, { min: 1, max: 100 }),
      maxConcurrentGlobal: positiveInteger(env.MCP_MAX_CONCURRENT_GLOBAL, 100, { min: 1, max: 10000 }),
      permitTtlMs: positiveInteger(env.MCP_PERMIT_TTL_MS, 90000, { min: 1000, max: 300000 }),
      toolTimeoutMs: positiveInteger(env.MCP_TOOL_TIMEOUT_MS, 30000, { min: 100, max: 120000 }),
      shutdownGraceMs: positiveInteger(env.MCP_SHUTDOWN_GRACE_MS, 10000, { min: 0, max: 60000 }),
      maxXirrCashflows: positiveInteger(env.MCP_XIRR_MAX_CASHFLOWS, 600, { min: 2, max: 600 }),
      maxXirrAbsAmount: positiveInteger(env.MCP_XIRR_MAX_ABS_AMOUNT, 1000000000000, { min: 1, max: 1000000000000 }),
    }),
    // Plan Review is read-only and opt-in in production. Local development can
    // exercise the feature without requiring an extra .env entry.
    agenticPlanReviewEnabled: booleanValue(env.AGENTIC_PLAN_REVIEW_ENABLED, !isProduction),
    agentWorkerEnabled: booleanValue(env.AGENT_WORKER_ENABLED, true),
    agentWorkerMode,
    agentIdentityProvider,
    agentIdentity: Object.freeze({
      provider: agentIdentityProvider,
      issuer: env.AGENT_OIDC_ISSUER?.trim() || null,
      audience: env.AGENT_OIDC_AUDIENCE?.trim() || null,
      publicKey: env.AGENT_OIDC_PUBLIC_KEY || null,
      jwksUrl: env.AGENT_OIDC_JWKS_URL?.trim() || null,
      subjectMap: env.AGENT_OIDC_SUBJECT_MAP || null,
      trustDomain: env.SPIFFE_TRUST_DOMAIN?.trim() || null,
    }),
    agentWorkflowBackend,
    agentStreamEnabled: booleanValue(env.AGENT_STREAM_ENABLED, !isProduction),
    agentEvolutionEnabled: booleanValue(env.AGENT_EVOLUTION_ENABLED, false),
    selfEvolution: Object.freeze({
      enabled: booleanValue(env.AGENT_SELF_EVOLUTION_ENABLED, false),
      gepaEnabled: booleanValue(env.AGENT_SELF_EVOLUTION_GEPA_ENABLED, false),
      e2bEnabled: booleanValue(env.AGENT_SELF_EVOLUTION_E2B_ENABLED, false),
      liveEnabled: booleanValue(env.AGENT_SELF_EVOLUTION_LIVE_ENABLED, false),
      autoPromotionEnabled: booleanValue(env.AGENT_SELF_EVOLUTION_AUTO_PROMOTION_ENABLED, false),
      budgets: Object.freeze({
        maxGenerations: positiveInteger(env.EVOLUTION_MAX_GENERATIONS, 3, { min: 0, max: 3 }),
        maxCandidates: positiveInteger(env.EVOLUTION_MAX_CANDIDATES, 12, { min: 0, max: 12 }),
        maxReflectionCalls: positiveInteger(env.EVOLUTION_MAX_REFLECTION_CALLS, 12, { min: 0, max: 12 }),
        maxMetricCalls: positiveInteger(env.EVOLUTION_MAX_METRIC_CALLS, 1000, { min: 0, max: 1000 }),
        maxSandboxRuns: positiveInteger(env.EVOLUTION_MAX_SANDBOX_RUNS, 20, { min: 0, max: 20 }),
        maxSandboxMinutes: positiveInteger(env.EVOLUTION_MAX_SANDBOX_MINUTES, 60, { min: 0, max: 60 }),
        maxTotalTokens: positiveInteger(env.EVOLUTION_MAX_TOTAL_TOKENS, 15000, { min: 0, max: 15000 }),
      }),
    }),
    agentResearchEnabled: booleanValue(env.AGENT_RESEARCH_ENABLED, false),
    researchMesh: Object.freeze({
      a2aV1Enabled: booleanValue(env.AGENT_A2A_V1_ENABLED, false),
      deepResearchEnabled: booleanValue(env.AGENT_DEEP_RESEARCH_ENABLED, false),
      adaptiveResearchEnabled: booleanValue(env.AGENT_ADAPTIVE_RESEARCH_ENABLED, false),
      liveSearchEnabled: booleanValue(env.AGENT_RESEARCH_LIVE_SEARCH_ENABLED, false),
      researchUrl: env.AGENT_A2A_RESEARCH_URL?.trim() || null,
      publicUrl: env.AGENT_A2A_PUBLIC_URL?.trim() || null,
      searchProvider: env.RESEARCH_SEARCH_PROVIDER?.trim().toLowerCase() || null,
      searchProviderUrl: env.RESEARCH_SEARCH_PROVIDER_URL?.trim() || null,
      devTokenConfigured: Boolean(env.AGENT_A2A_DEV_TOKEN),
      clientTokenConfigured: Boolean(env.AGENT_A2A_CLIENT_TOKEN?.trim()),
      cardSigningEnabled: booleanValue(env.AGENT_A2A_CARD_SIGNING_ENABLED, false),
      cardSigningPrivateKeyConfigured: Boolean(env.AGENT_A2A_CARD_SIGNING_PRIVATE_KEY),
      cardSigningPublicJwkConfigured: Boolean(env.AGENT_A2A_CARD_SIGNING_PUBLIC_JWK?.trim()),
      budgets: Object.freeze({
        maxResearchRounds: positiveInteger(env.RESEARCH_MAX_ROUNDS, 3, { min: 0, max: 3 }),
        maxSearchQueries: positiveInteger(env.RESEARCH_MAX_SEARCH_QUERIES, 6, { min: 0, max: 6 }),
        maxResultsPerQuery: positiveInteger(env.RESEARCH_MAX_RESULTS_PER_QUERY, 5, { min: 0, max: 5 }),
        maxUniqueDocuments: positiveInteger(env.RESEARCH_MAX_UNIQUE_DOCUMENTS, 12, { min: 0, max: 12 }),
        maxConcurrentFetches: positiveInteger(env.RESEARCH_MAX_CONCURRENT_FETCHES, 4, { min: 0, max: 4 }),
        maxModelCalls: positiveInteger(env.RESEARCH_MAX_MODEL_CALLS, 6, { min: 0, max: 6 }),
        maxOutputTokens: positiveInteger(env.RESEARCH_MAX_OUTPUT_TOKENS, 2500, { min: 0, max: 2500 }),
        maxTotalTokens: positiveInteger(env.RESEARCH_MAX_TOTAL_TOKENS, 15000, { min: 0, max: 15000 }),
        maxDurationMs: positiveInteger(env.RESEARCH_MAX_DURATION_MS, 60000, { min: 0, max: 60000 }),
      }),
    }),
    authorization: Object.freeze({
      verifiableActionsEnabled: booleanValue(env.AGENT_VERIFIABLE_ACTIONS_ENABLED, false),
      webauthnApprovalEnabled: booleanValue(env.AGENT_WEBAUTHN_APPROVAL_ENABLED, false),
      ap2ResearchEnabled: booleanValue(env.AGENT_AP2_RESEARCH_ENABLED, false),
      approvalProvider: agentApprovalProvider,
      webauthnOrigin: env.WEBAUTHN_ORIGIN?.trim() || null,
      webauthnRpId: env.WEBAUTHN_RP_ID?.trim() || null,
      mandateTtlSeconds: positiveInteger(env.AGENT_MANDATE_TTL_SECONDS, 300, { min: 1, max: 900 }),
    }),
    agentPlanReview: Object.freeze({
      maxSteps: positiveInteger(env.AGENT_MAX_STEPS, 6, { min: 1, max: 6 }),
      maxToolCalls: positiveInteger(env.AGENT_MAX_TOOL_CALLS, 8, { min: 1, max: 8 }),
      maxToolCallsPerTool: positiveInteger(env.AGENT_MAX_TOOL_CALLS_PER_TOOL, 2, { min: 1, max: 2 }),
      timeoutMs: positiveInteger(env.AGENT_TIMEOUT_MS, 30000, { min: 1000, max: 60000 }),
      maxAttempts: positiveInteger(env.AGENT_MAX_ATTEMPTS, 2, { min: 1, max: 2 }),
      maxModelCalls: positiveInteger(env.AGENT_MAX_MODEL_CALLS, 2, { min: 0, max: 2 }),
      maxInputTokens: positiveInteger(env.AGENT_MAX_INPUT_TOKENS, 4000, { min: 1, max: 4000 }),
      maxOutputTokens: positiveInteger(env.AGENT_MAX_OUTPUT_TOKENS, 1200, { min: 1, max: 1200 }),
      maxTotalTokens: positiveInteger(env.AGENT_MAX_TOTAL_TOKENS, 5200, { min: 1, max: 5200 }),
      leaseMs: positiveInteger(env.AGENT_LEASE_MS, 60000, { min: 10000, max: 300000 }),
      heartbeatMs: positiveInteger(env.AGENT_HEARTBEAT_MS, 15000, { min: 1000, max: 100000 }),
      shutdownGraceMs: positiveInteger(env.AGENT_SHUTDOWN_GRACE_MS, 10000, { min: 1000, max: 60000 }),
      maxQueuedRunsPerUser: positiveInteger(env.MAX_QUEUED_AGENT_RUNS_PER_USER, 3, { min: 1, max: 100 }),
      maxActiveRunsPerUser: positiveInteger(env.MAX_ACTIVE_AGENT_RUNS_PER_USER, 1, { min: 1, max: 20 }),
      maxGlobalQueuedRuns: positiveInteger(env.MAX_GLOBAL_QUEUED_RUNS, 1000, { min: 1, max: 100000 }),
      queuePriority: 'INTERACTIVE_PLAN_REVIEW',
      healthPort: positiveInteger(env.AGENT_WORKER_HEALTH_PORT, 5050, { min: 1024, max: 65535 }),
    }),
    planHealth: Object.freeze({
      enabled: booleanValue(env.PLAN_HEALTH_SCHEDULER_ENABLED, true),
      batchSize: positiveInteger(env.PLAN_HEALTH_BATCH_SIZE, 100, { min: 1, max: 1000 }),
      intervalMs: positiveInteger(env.PLAN_HEALTH_INTERVAL_MS, 86400000, { min: 3600000, max: 604800000 }),
      leaseMs: positiveInteger(env.PLAN_HEALTH_LEASE_MS, 300000, { min: 30000, max: 3600000 }),
      heartbeatMs: positiveInteger(env.PLAN_HEALTH_HEARTBEAT_MS, 60000, { min: 1000, max: 1800000 }),
      profileTimeoutMs: positiveInteger(env.PLAN_HEALTH_PROFILE_TIMEOUT_MS, 30000, { min: 1000, max: 120000 }),
      jitterMs: positiveInteger(env.PLAN_HEALTH_JITTER_MS, 900000, { min: 0, max: 3600000 }),
      concurrency: positiveInteger(env.PLAN_HEALTH_CONCURRENCY, 4, { min: 1, max: 20 }),
    }),
    deepHealthTimeoutMs: positiveInteger(env.DEEP_HEALTH_TIMEOUT_MS, 3000, { min: 100, max: 30000 }),
    mongo: Object.freeze({
      flavor: getMongoFlavor(env),
      tlsCAFile: env.MONGODB_TLS_CA_FILE?.trim() || null,
      autoIndex: booleanValue(env.MONGODB_AUTO_INDEX, !isProduction),
      maxPoolSize: positiveInteger(env.MONGODB_MAX_POOL_SIZE, 50, { min: 5, max: 500 }),
      minPoolSize: positiveInteger(env.MONGODB_MIN_POOL_SIZE, isProduction ? 2 : 0, { min: 0, max: 100 }),
      serverSelectionTimeoutMs: positiveInteger(env.MONGODB_SERVER_SELECTION_TIMEOUT_MS, 10000, { min: 1000, max: 60000 }),
      socketTimeoutMs: positiveInteger(env.MONGODB_SOCKET_TIMEOUT_MS, 45000, { min: 1000, max: 300000 }),
      maxIdleTimeMs: positiveInteger(env.MONGODB_MAX_IDLE_TIME_MS, 60000, { min: 1000, max: 600000 }),
    }),
    http: Object.freeze({
      requestTimeoutMs: positiveInteger(env.HTTP_REQUEST_TIMEOUT_MS, 120000, { min: 1000 }),
      headersTimeoutMs: positiveInteger(env.HTTP_HEADERS_TIMEOUT_MS, 65000, { min: 1000 }),
      keepAliveTimeoutMs: positiveInteger(env.HTTP_KEEP_ALIVE_TIMEOUT_MS, 60000, { min: 1000 }),
      shutdownTimeoutMs: positiveInteger(env.SHUTDOWN_TIMEOUT_MS, 10000, { min: 1000, max: 60000 }),
    }),
  });
}

export function assertValidHttpTimeouts(config) {
  if (config.http.headersTimeoutMs <= config.http.keepAliveTimeoutMs) {
    throw new Error('HTTP_HEADERS_TIMEOUT_MS must be greater than HTTP_KEEP_ALIVE_TIMEOUT_MS');
  }
  if (config.http.requestTimeoutMs < config.http.headersTimeoutMs) {
    throw new Error('HTTP_REQUEST_TIMEOUT_MS must be greater than or equal to HTTP_HEADERS_TIMEOUT_MS');
  }
}

export function assertValidRuntimeConfig(config) {
  assertValidHttpTimeouts(config);
  if (config.mongo.minPoolSize > config.mongo.maxPoolSize) {
    throw new Error('MONGODB_MIN_POOL_SIZE must be less than or equal to MONGODB_MAX_POOL_SIZE');
  }
  if (config.mcp.remoteEnabled && !config.mcp.enabled) {
    throw new Error('MCP_REMOTE_ENABLED requires MCP_ENABLED=true');
  }
  if (config.mcp.legacySseEnabled) {
    throw new Error('Legacy MCP SSE has been removed; MCP_LEGACY_SSE_ENABLED must remain false');
  }
  if (config.isProduction && config.mcp.remoteEnabled) {
    if (!config.mcp.jwtAudience || !config.mcp.jwtIssuer || !config.mcp.requiredScope) {
      throw new Error('Production remote MCP requires MCP_JWT_ISSUER, MCP_JWT_AUDIENCE and MCP_REQUIRED_SCOPE');
    }
    if (!config.mcp.jwtSecret || config.mcp.jwtSecret.length < 32 || !config.mcp.jwtSecretIsolated) {
      throw new Error('Production remote MCP requires an isolated MCP_JWT_SECRET of at least 32 characters');
    }
    if (!config.trustedProxyCidrs.length && !config.mcp.directTls) {
      throw new Error('Production remote MCP requires explicit TRUSTED_PROXY_CIDRS or MCP_DIRECT_TLS=true');
    }
    if (config.mcp.allowedHosts.length === 0) {
      throw new Error('Production remote MCP requires MCP_ALLOWED_HOSTS');
    }
    if (!config.requireRedis) {
      throw new Error('Production remote MCP requires REQUIRE_REDIS=true for distributed capacity control');
    }
    if (config.mcp.allowedOrigins.some(origin => !config.allowedOrigins.includes(origin))) {
      throw new Error('MCP_ALLOWED_ORIGINS must be a subset of CORS_ORIGINS');
    }
  }
  if (config.mcp.permitTtlMs <= config.mcp.toolTimeoutMs + 5000) {
    throw new Error('MCP_PERMIT_TTL_MS must exceed MCP_TOOL_TIMEOUT_MS by at least 5 seconds');
  }
  if (config.isProduction && config.agentWorkerMode !== 'external') {
    throw new Error('AGENT_WORKER_MODE must be external in production');
  }
  if (config.authorization.verifiableActionsEnabled && config.isProduction) {
    if (!config.authorization.webauthnApprovalEnabled || config.authorization.approvalProvider !== 'webauthn') {
      throw new Error('Production verifiable actions require WebAuthn approval and no development provider.');
    }
    if (!config.authorization.webauthnOrigin || !config.authorization.webauthnRpId) {
      throw new Error('Production WebAuthn approval requires WEBAUTHN_ORIGIN and WEBAUTHN_RP_ID');
    }
    if (config.agentIdentityProvider === 'development') {
      throw new Error('Production verifiable actions require a cryptographically verified OIDC or SPIFFE agent identity.');
    }
    if (config.agentIdentityProvider === 'oidc'
      && (!config.agentIdentity.issuer || !config.agentIdentity.audience
        || (!config.agentIdentity.publicKey && !config.agentIdentity.jwksUrl)
        || !config.agentIdentity.subjectMap)) {
      throw new Error('Production OIDC agent identity requires issuer, audience, key source, and subject mapping.');
    }
    if (config.agentIdentityProvider === 'spiffe' && !config.agentIdentity.trustDomain) {
      throw new Error('Production SPIFFE agent identity requires SPIFFE_TRUST_DOMAIN and a runtime SVID verifier.');
    }
  }
  const selfEvolution = config.selfEvolution;
  if (config.isProduction && (selfEvolution.enabled || selfEvolution.gepaEnabled || selfEvolution.e2bEnabled || selfEvolution.liveEnabled || selfEvolution.autoPromotionEnabled)) {
    throw new Error('Self-evolution is offline/manual-only and cannot be enabled in production runtime.');
  }
  if (selfEvolution.autoPromotionEnabled) {
    throw new Error('Automatic self-evolution promotion is permanently disabled; use the WebAuthn human promotion workflow.');
  }
  const research = config.researchMesh;
  const researchEnabled = research.a2aV1Enabled || research.deepResearchEnabled || research.adaptiveResearchEnabled || research.liveSearchEnabled;
  if (researchEnabled && !research.a2aV1Enabled) {
    throw new Error('ResearchMesh feature flags require AGENT_A2A_V1_ENABLED=true');
  }
  if (research.a2aV1Enabled) {
    if (!research.researchUrl) throw new Error('AGENT_A2A_RESEARCH_URL is required when A2A ResearchMesh is enabled');
    let researchUrl;
    try { researchUrl = new URL(research.researchUrl); } catch { researchUrl = null; }
    if (!researchUrl || researchUrl.username || researchUrl.password || researchUrl.search || researchUrl.hash
        || (config.isProduction && researchUrl.protocol !== 'https:')) throw new Error('AGENT_A2A_RESEARCH_URL must be a credential-free URL and HTTPS in production');
    if (config.isProduction && config.agentIdentityProvider !== 'oidc') throw new Error('Production ResearchMesh requires OIDC; unimplemented bearer/SPIFFE verification is not accepted');
    if (!config.isProduction && config.agentIdentityProvider === 'development' && !research.devTokenConfigured) throw new Error('AGENT_A2A_DEV_TOKEN is required for development A2A ResearchMesh');
    if (config.isProduction && !research.cardSigningEnabled) throw new Error('Production ResearchMesh requires signed Agent Cards');
    if (config.isProduction && research.cardSigningEnabled && !research.cardSigningPrivateKeyConfigured) throw new Error('Production signed Agent Cards require AGENT_A2A_CARD_SIGNING_PRIVATE_KEY');
    if (config.isProduction && (!research.clientTokenConfigured || !research.cardSigningPublicJwkConfigured)) throw new Error('Production ResearchMesh requires a dedicated client token and pinned Agent Card public JWK');
  }
  if (research.liveSearchEnabled && (research.searchProvider !== 'configured' || !research.searchProviderUrl)) {
    throw new Error('Live ResearchMesh search requires the configured approved search provider and endpoint');
  }
  if (config.agentWorkerMode === 'embedded' && config.agentWorkerEnabled === false) {
    if (config.agenticPlanReviewEnabled) {
      throw new Error('AGENTIC_PLAN_REVIEW_ENABLED=true requires an embedded worker when AGENT_WORKER_MODE=embedded; enable AGENT_WORKER_ENABLED or use external worker mode.');
    }
    return;
  }
  if (config.agentPlanReview.heartbeatMs >= config.agentPlanReview.leaseMs) {
    throw new Error('AGENT_HEARTBEAT_MS must be less than AGENT_LEASE_MS');
  }
  if (config.planHealth.heartbeatMs >= config.planHealth.leaseMs) {
    throw new Error('PLAN_HEALTH_HEARTBEAT_MS must be less than PLAN_HEALTH_LEASE_MS');
  }
}
