/**
 * WealthGenie Environment & Security Configuration Validation
 *
 * Provides fail-closed validation for runtime configuration across
 * development, test, and production environments.
 */

import { validateMongoCompatibilityConfig } from './mongoCompatibility.js';
import proxyaddr from 'proxy-addr';

export function validateEnvironmentConfig(env = process.env) {
  const isProduction = env.NODE_ENV === 'production';
  const errors = [];
  errors.push(...validateMongoCompatibilityConfig(env).errors);
  if (env.DISABLE_RATE_LIMIT !== undefined && !['true', 'false'].includes(env.DISABLE_RATE_LIMIT)) {
    errors.push('DISABLE_RATE_LIMIT must be true or false');
  }
  if (isProduction && env.DISABLE_RATE_LIMIT === 'true') {
    errors.push('DISABLE_RATE_LIMIT must not be enabled in production');
  }

  for (const name of ['MCP_ENABLED', 'MCP_REMOTE_ENABLED', 'MCP_LEGACY_SSE_ENABLED', 'MCP_DIRECT_TLS']) {
    if (env[name] !== undefined && !['true', 'false'].includes(env[name])) {
      errors.push(`${name} must be true or false`);
    }
  }
  const mcpEnabled = env.MCP_ENABLED === undefined ? !isProduction : env.MCP_ENABLED === 'true';
  const mcpRemoteEnabled = env.MCP_REMOTE_ENABLED === undefined
    ? (mcpEnabled && !isProduction)
    : env.MCP_REMOTE_ENABLED === 'true';
  if (mcpRemoteEnabled && !mcpEnabled) errors.push('MCP_REMOTE_ENABLED requires MCP_ENABLED=true');
  if (env.MCP_LEGACY_SSE_ENABLED === 'true') errors.push('Legacy MCP SSE has been removed; MCP_LEGACY_SSE_ENABLED must remain false');
  if (isProduction && mcpRemoteEnabled) {
    if (!env.MCP_JWT_SECRET?.trim() || env.MCP_JWT_SECRET.trim().length < 32) errors.push('MCP_JWT_SECRET must contain at least 32 characters when production remote MCP is enabled');
    if (env.MCP_JWT_SECRET && env.MCP_JWT_SECRET === env.JWT_SECRET) errors.push('MCP_JWT_SECRET must differ from JWT_SECRET');
    if (!env.MCP_JWT_ISSUER?.trim()) errors.push('MCP_JWT_ISSUER is required when production remote MCP is enabled');
    if (!env.MCP_JWT_AUDIENCE?.trim()) errors.push('MCP_JWT_AUDIENCE is required when production remote MCP is enabled');
    if (!env.MCP_REQUIRED_SCOPE?.trim()) errors.push('MCP_REQUIRED_SCOPE is required when production remote MCP is enabled');
    if (env.MCP_JWT_AUDIENCE && (env.MCP_JWT_AUDIENCE.length > 255 || /\s/.test(env.MCP_JWT_AUDIENCE))) {
      errors.push('MCP_JWT_AUDIENCE must be a single value of at most 255 characters');
    }
    if (env.MCP_REQUIRED_SCOPE && !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(env.MCP_REQUIRED_SCOPE)) {
      errors.push('MCP_REQUIRED_SCOPE must be one bounded scope token');
    }
    const hosts = String(env.MCP_ALLOWED_HOSTS || '').split(',').map(value => value.trim()).filter(Boolean);
    if (hosts.length === 0) errors.push('MCP_ALLOWED_HOSTS is required when production remote MCP is enabled');
    for (const host of hosts) {
      if (host.includes('://') || /[\s/@?#]/.test(host)) errors.push(`MCP_ALLOWED_HOSTS contains an invalid host: ${host}`);
    }
    if (env.REQUIRE_REDIS === 'false') errors.push('Production remote MCP requires REQUIRE_REDIS=true');
    const trustedProxyCidrs = String(env.TRUSTED_PROXY_CIDRS || '').split(',').map(value => value.trim()).filter(Boolean);
    if (!trustedProxyCidrs.length && env.MCP_DIRECT_TLS !== 'true') {
      errors.push('Production remote MCP requires explicit TRUSTED_PROXY_CIDRS');
    } else if (trustedProxyCidrs.length) {
      try {
        // Validate with the same parser used by the HTTP trust boundary so
        // invalid proxy ranges cannot pass startup validation and fail later.
        proxyaddr.compile(trustedProxyCidrs);
      } catch {
        errors.push('TRUSTED_PROXY_CIDRS must contain valid proxy CIDR/range entries');
      }
    }
    if (!env.REDIS_URL?.trim()) {
      errors.push('REDIS_URL is required when production remote MCP is enabled');
    } else {
      let redisUrl;
      try { redisUrl = new URL(env.REDIS_URL); } catch { redisUrl = null; }
      if (!redisUrl || !['redis:', 'rediss:'].includes(redisUrl.protocol) || !redisUrl.hostname) {
        errors.push('REDIS_URL must be a valid redis:// or rediss:// URL when production remote MCP is enabled');
      }
    }
  }
  const boundedIntegers = [
    ['MCP_MAX_REQUEST_BYTES', 1024, 131072], ['MCP_RATE_WINDOW_MS', 1000, 3600000],
    ['MCP_MAX_REQUESTS_PER_WINDOW', 1, 10000], ['MCP_MAX_LOW_COST_CALLS_PER_WINDOW', 1, 10000],
    ['MCP_MAX_MEDIUM_COST_CALLS_PER_WINDOW', 1, 10000], ['MCP_MAX_HIGH_COST_CALLS_PER_WINDOW', 1, 10000],
    ['MCP_MAX_CONCURRENT_PER_USER', 1, 100], ['MCP_MAX_CONCURRENT_GLOBAL', 1, 10000],
    ['MCP_PERMIT_TTL_MS', 1000, 300000], ['MCP_TOOL_TIMEOUT_MS', 100, 120000],
    ['MCP_SHUTDOWN_GRACE_MS', 0, 60000], ['MCP_XIRR_MAX_CASHFLOWS', 2, 600],
    ['MCP_XIRR_MAX_ABS_AMOUNT', 1, 1000000000000],
    ['RESEARCH_AGENT_MAX_ACTIVE_TASKS', 1, 100],
  ];
  for (const [name, min, max] of boundedIntegers) {
    if (env[name] === undefined || env[name] === '') continue;
    const parsed = Number(env[name]);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
      errors.push(`${name} must be an integer from ${min} to ${max}`);
    }
  }
  const permitTtl = Number(env.MCP_PERMIT_TTL_MS || 90000);
  const toolTimeout = Number(env.MCP_TOOL_TIMEOUT_MS || 30000);
  if (Number.isSafeInteger(permitTtl) && Number.isSafeInteger(toolTimeout) && permitTtl <= toolTimeout + 5000) {
    errors.push('MCP_PERMIT_TTL_MS must exceed MCP_TOOL_TIMEOUT_MS by at least 5 seconds');
  }
  const mcpOrigins = String(env.MCP_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  const appOrigins = env.CORS_ORIGINS
    ? String(env.CORS_ORIGINS).split(',').map(value => value.trim().replace(/\/+$/, '')).filter(Boolean)
    : (isProduction ? [] : ['http://localhost:5173', 'http://localhost:3000']);
  for (const origin of mcpOrigins) {
    let parsed;
    try { parsed = new URL(origin); } catch { parsed = null; }
    if (!parsed || parsed.origin !== origin || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      errors.push(`MCP_ALLOWED_ORIGINS contains an invalid origin: ${origin}`);
    } else if (isProduction && parsed.protocol !== 'https:') {
      errors.push(`Production MCP origin must use HTTPS: ${origin}`);
    }
    if (!appOrigins.includes(origin)) {
      errors.push(`MCP origin must also be included in CORS_ORIGINS: ${origin}`);
    }
  }

  const workerMode = String(env.AGENT_WORKER_MODE || (isProduction ? 'external' : 'embedded')).toLowerCase();
  if (!['embedded', 'external'].includes(workerMode)) {
    errors.push('AGENT_WORKER_MODE must be embedded or external');
  }
  if (isProduction && workerMode !== 'external') {
    errors.push('AGENT_WORKER_MODE must be external in production');
  }

  if (!env.JWT_SECRET || !env.JWT_SECRET.trim()) {
    errors.push('JWT_SECRET is required');
  }
  if (!env.MONGODB_URI || !env.MONGODB_URI.trim()) {
    errors.push('MONGODB_URI is required');
  }

  const researchA2AEnabled = env.AGENT_A2A_V1_ENABLED === 'true';
  const researchFeatureEnabled = researchA2AEnabled
    || env.AGENT_DEEP_RESEARCH_ENABLED === 'true'
    || env.AGENT_ADAPTIVE_RESEARCH_ENABLED === 'true'
    || env.AGENT_RESEARCH_LIVE_SEARCH_ENABLED === 'true';
  if (researchFeatureEnabled && !researchA2AEnabled) errors.push('ResearchMesh feature flags require AGENT_A2A_V1_ENABLED=true');
  if (researchA2AEnabled) {
    if (!env.AGENT_A2A_RESEARCH_URL) errors.push('AGENT_A2A_RESEARCH_URL is required when A2A ResearchMesh is enabled');
    let researchUrl;
    try { researchUrl = new URL(String(env.AGENT_A2A_RESEARCH_URL || '')); } catch { researchUrl = null; }
    if (!researchUrl) errors.push('AGENT_A2A_RESEARCH_URL must be a valid URL');
    if (researchUrl && (researchUrl.username || researchUrl.password || researchUrl.search || researchUrl.hash
        || (isProduction && researchUrl.protocol !== 'https:'))) {
      errors.push('AGENT_A2A_RESEARCH_URL must be a credential-free URL and use HTTPS in production');
    }
    const identityProvider = String(env.AGENT_IDENTITY_PROVIDER || 'development').toLowerCase();
    if (isProduction && identityProvider !== 'oidc') errors.push('Production ResearchMesh requires OIDC; unimplemented bearer/SPIFFE verification is not accepted');
    if (!isProduction && identityProvider === 'development' && !env.AGENT_A2A_DEV_TOKEN) errors.push('AGENT_A2A_DEV_TOKEN is required for development A2A ResearchMesh');
    if (isProduction && env.AGENT_A2A_CARD_SIGNING_ENABLED !== 'true') errors.push('Production ResearchMesh requires signed Agent Cards');
    if (isProduction && env.AGENT_A2A_CARD_SIGNING_ENABLED === 'true' && !env.AGENT_A2A_CARD_SIGNING_PRIVATE_KEY) errors.push('Production signed Agent Cards require AGENT_A2A_CARD_SIGNING_PRIVATE_KEY');
    if (isProduction) {
      if (!env.AGENT_A2A_CLIENT_TOKEN?.trim()) errors.push('AGENT_A2A_CLIENT_TOKEN is required for production ResearchMesh calls');
      if (!env.AGENT_A2A_CARD_SIGNING_PUBLIC_JWK?.trim()) errors.push('AGENT_A2A_CARD_SIGNING_PUBLIC_JWK is required to pin the production ResearchAgent card key');
      if (!env.AGENT_OIDC_ISSUER?.trim() || !env.AGENT_OIDC_AUDIENCE?.trim()) errors.push('OIDC issuer and audience are required for production ResearchMesh');
      if (!env.AGENT_OIDC_PUBLIC_KEY?.trim() && !env.AGENT_OIDC_JWKS_URL?.trim()) errors.push('OIDC public key or JWKS URL is required for production ResearchMesh');
      if (!env.AGENT_OIDC_SUBJECT_MAP?.trim()) errors.push('AGENT_OIDC_SUBJECT_MAP is required for production ResearchMesh');
      if (env.AGENT_OIDC_JWKS_URL) {
        try {
          const jwks = new URL(env.AGENT_OIDC_JWKS_URL);
          if (jwks.protocol !== 'https:' || jwks.username || jwks.password || jwks.hash) errors.push('AGENT_OIDC_JWKS_URL must use credential-free HTTPS');
        } catch { errors.push('AGENT_OIDC_JWKS_URL must be a valid credential-free HTTPS URL'); }
      }
    }
  }
  if (env.AGENT_RESEARCH_LIVE_SEARCH_ENABLED === 'true'
    && (String(env.RESEARCH_SEARCH_PROVIDER || '').toLowerCase() !== 'configured' || !env.RESEARCH_SEARCH_PROVIDER_URL)) {
    errors.push('Live ResearchMesh search requires the configured approved search provider and endpoint');
  }

  const jwtSecret = (env.JWT_SECRET || '').trim();
  const INSECURE_JWT_PLACEHOLDERS = [
    'CHANGE_ME',
    'default_jwt_secret',
    'super_secret_jwt',
    'your_64_char_hex',
    'ci-dev-jwt-secret',
    'secret',
  ];
  const isPlaceholderJwt = INSECURE_JWT_PLACEHOLDERS.some(p => jwtSecret.toLowerCase().includes(p.toLowerCase()));

  if (isProduction) {
    if (jwtSecret.length < 32) {
      errors.push('JWT_SECRET must be at least 32 characters in production');
    }
    if (isPlaceholderJwt) {
      errors.push('Insecure or placeholder JWT_SECRET detected in production environment');
    }
    if (!env.ML_SERVICE_API_KEY || !env.ML_SERVICE_API_KEY.trim()) {
      errors.push('ML_SERVICE_API_KEY is required in production');
    } else if (env.ML_SERVICE_API_KEY.startsWith('CHANGE_ME')) {
      errors.push('Insecure placeholder ML_SERVICE_API_KEY detected in production');
    }
    if (!env.METRICS_TOKEN || env.METRICS_TOKEN.trim().length < 32
      || env.METRICS_TOKEN.includes('CHANGE_ME')) {
      errors.push('METRICS_TOKEN must be at least 32 characters in production');
    }
    const origins = (env.CORS_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
    if (origins.length === 0) {
      errors.push('CORS_ORIGINS must contain at least one trusted HTTPS origin in production');
    }
    for (const origin of origins) {
      let parsed;
      try { parsed = new URL(origin); } catch { parsed = null; }
      if (!parsed || parsed.origin !== origin.replace(/\/+$/, '') || parsed.protocol !== 'https:') {
        errors.push(`CORS_ORIGINS contains an invalid production origin: ${origin}`);
      }
    }
    const sameSite = (env.AUTH_COOKIE_SAME_SITE || 'strict').toLowerCase();
    if (!['strict', 'lax', 'none'].includes(sameSite)) {
      errors.push('AUTH_COOKIE_SAME_SITE must be strict, lax, or none');
    }
    if (sameSite === 'none' && env.AUTH_COOKIE_SECURE === 'false') {
      errors.push('SameSite=None cookies must be Secure in production');
    }
    if (env.EXPOSE_AUTH_TOKEN === 'true') {
      errors.push('EXPOSE_AUTH_TOKEN cannot be enabled in production');
    }
    if (env.AGENT_VERIFIABLE_ACTIONS_ENABLED === 'true') {
      if (env.AGENT_WEBAUTHN_APPROVAL_ENABLED !== 'true') errors.push('AGENT_WEBAUTHN_APPROVAL_ENABLED must be true when verifiable actions are enabled in production');
      if (String(env.AGENT_APPROVAL_PROVIDER || 'webauthn').toLowerCase() !== 'webauthn') errors.push('AGENT_APPROVAL_PROVIDER must be webauthn when verifiable actions are enabled in production');
      if (!env.WEBAUTHN_ORIGIN || !env.WEBAUTHN_RP_ID) errors.push('WEBAUTHN_ORIGIN and WEBAUTHN_RP_ID are required for production verifiable actions');
      if (!env.AUTHORIZATION_SIGNING_PRIVATE_KEY || !env.AUTHORIZATION_SIGNING_PUBLIC_KEY) errors.push('Authorization signing keys are required for production verifiable actions');
      const identityProvider = String(env.AGENT_IDENTITY_PROVIDER || 'development').toLowerCase();
      if (identityProvider === 'development') errors.push('AGENT_IDENTITY_PROVIDER cannot be development for production verifiable actions');
      if (!['oidc', 'spiffe'].includes(identityProvider)) errors.push('AGENT_IDENTITY_PROVIDER must be oidc or spiffe for production verifiable actions');
      if (identityProvider === 'oidc') {
        if (!env.AGENT_OIDC_ISSUER || !env.AGENT_OIDC_AUDIENCE) errors.push('OIDC issuer and audience are required for production agent identity');
        if (!env.AGENT_OIDC_PUBLIC_KEY && !env.AGENT_OIDC_JWKS_URL) errors.push('OIDC public key or JWKS URL is required for production agent identity');
        if (!env.AGENT_OIDC_SUBJECT_MAP) errors.push('AGENT_OIDC_SUBJECT_MAP is required for production agent identity');
      }
      if (identityProvider === 'spiffe' && !env.SPIFFE_TRUST_DOMAIN) errors.push('SPIFFE_TRUST_DOMAIN is required for production agent identity');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
