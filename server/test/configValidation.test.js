import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEnvironmentConfig } from '../config/validateEnv.js';
import { assertValidRuntimeConfig, getRuntimeConfig } from '../config/runtime.js';

test('Config Validation: Missing JWT_SECRET fails validation', () => {
  const result = validateEnvironmentConfig({
    JWT_SECRET: '',
    MONGODB_URI: 'mongodb://localhost:27017/wealthgenie',
    NODE_ENV: 'development',
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('JWT_SECRET is required')));
});

test('Config Validation: Missing MONGODB_URI fails validation', () => {
  const result = validateEnvironmentConfig({
    JWT_SECRET: 'test-secret-at-least-32-chars-long-valid',
    MONGODB_URI: '',
    NODE_ENV: 'development',
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('MONGODB_URI is required')));
});

test('Config Validation: invalid market mode and provider cannot silently select legacy data', () => {
  const base = {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-valid',
    MONGODB_URI: 'mongodb://localhost:27017/wealthgenie',
    NODE_ENV: 'test',
  };
  const invalid = validateEnvironmentConfig({
    ...base,
    MARKET_DATA_MODE: 'UPSTOX_TEJH',
    MARKET_DATA_PRIMARY_PROVIDER: 'TEJHQ',
    TEJHQ_ENABLED: 'yes',
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some(error => error.includes('MARKET_DATA_MODE')));
  assert.ok(invalid.errors.some(error => error.includes('MARKET_DATA_PRIMARY_PROVIDER')));
  assert.ok(invalid.errors.some(error => error.includes('TEJHQ_ENABLED')));
  assert.equal(validateEnvironmentConfig({ ...base, MARKET_DATA_MODE: 'UPSTOX_TEJHQ' }).valid, true);
});

test('Config Validation: production rejects attempts to disable HTTP rate limiting', () => {
  const base = {
    JWT_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef',
    MONGODB_URI: 'mongodb://mongodb:27017/wealthgenie',
    ML_SERVICE_API_KEY: 'production-secret-api-key-value-secure',
    METRICS_TOKEN: 'production-metrics-token-at-least-32-characters',
    REDIS_PASSWORD: 'production-redis-password-at-least-32-chars',
    CORS_ORIGINS: 'https://app.wealthgenie.example',
    NODE_ENV: 'production',
  };
  assert.equal(validateEnvironmentConfig(base).valid, true);
  const disabled = validateEnvironmentConfig({ ...base, DISABLE_RATE_LIMIT: 'true' });
  assert.equal(disabled.valid, false);
  assert.ok(disabled.errors.some(error => error.includes('DISABLE_RATE_LIMIT must not be enabled in production')));
});

test('Config Validation: Production rejects JWT_SECRET shorter than 32 chars', () => {
  const result = validateEnvironmentConfig({
    JWT_SECRET: 'short_secret_20_chars',
    MONGODB_URI: 'mongodb://localhost:27017/wealthgenie',
    ML_SERVICE_API_KEY: 'valid-prod-ml-service-key-32chars',
    NODE_ENV: 'production',
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('at least 32 characters')));
});

test('Config Validation: Production rejects placeholder JWT_SECRET', () => {
  const result = validateEnvironmentConfig({
    JWT_SECRET: 'CHANGE_ME_JWT_SECRET_AT_LEAST_32_CHARACTERS_LONG',
    MONGODB_URI: 'mongodb://localhost:27017/wealthgenie',
    ML_SERVICE_API_KEY: 'valid-prod-ml-service-key-32chars',
    NODE_ENV: 'production',
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('Insecure or placeholder JWT_SECRET')));
});

test('Config Validation: Production rejects missing ML_SERVICE_API_KEY', () => {
  const result = validateEnvironmentConfig({
    JWT_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef',
    MONGODB_URI: 'mongodb://localhost:27017/wealthgenie',
    ML_SERVICE_API_KEY: '',
    NODE_ENV: 'production',
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('ML_SERVICE_API_KEY is required in production')));
});

test('Config Validation: Production rejects placeholder ML_SERVICE_API_KEY', () => {
  const result = validateEnvironmentConfig({
    JWT_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef',
    MONGODB_URI: 'mongodb://localhost:27017/wealthgenie',
    ML_SERVICE_API_KEY: 'CHANGE_ME_ML_SERVICE_API_KEY',
    NODE_ENV: 'production',
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('Insecure placeholder ML_SERVICE_API_KEY')));
});

test('Config Validation: Valid production configuration passes', () => {
  const result = validateEnvironmentConfig({
    JWT_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef',
    MONGODB_URI: 'mongodb://mongodb:27017/wealthgenie',
    ML_SERVICE_API_KEY: 'production-secret-api-key-value-secure',
    METRICS_TOKEN: 'production-metrics-token-at-least-32-characters',
    REDIS_PASSWORD: 'production-redis-password-at-least-32-chars',
    CORS_ORIGINS: 'https://app.wealthgenie.example',
    NODE_ENV: 'production',
  });
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test('Config Validation: production ResearchMesh requires its client credential and pinned card key', () => {
  const result = validateEnvironmentConfig({
    JWT_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef',
    MONGODB_URI: 'mongodb://mongodb:27017/wealthgenie?replicaSet=rs0',
    ML_SERVICE_API_KEY: 'production-secret-api-key-value-secure',
    METRICS_TOKEN: 'production-metrics-token-at-least-32-characters',
    CORS_ORIGINS: 'https://wealthgenie.example',
    NODE_ENV: 'production',
    AGENT_A2A_V1_ENABLED: 'true',
    AGENT_A2A_RESEARCH_URL: 'https://research.wealthgenie.example',
    AGENT_A2A_CARD_SIGNING_ENABLED: 'true',
    AGENT_A2A_CARD_SIGNING_PRIVATE_KEY: 'configured-private-key',
    AGENT_IDENTITY_PROVIDER: 'oidc',
    AGENT_OIDC_ISSUER: 'https://issuer.example',
    AGENT_OIDC_AUDIENCE: 'wealthgenie-agents',
    AGENT_OIDC_JWKS_URL: 'https://issuer.example/.well-known/jwks.json',
    AGENT_OIDC_SUBJECT_MAP: '{"service":"PLAN_REVIEW"}',
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.includes('AGENT_A2A_CLIENT_TOKEN')));
  assert.ok(result.errors.some(error => error.includes('AGENT_A2A_CARD_SIGNING_PUBLIC_JWK')));
});

test('Config Validation: every required production value fails clearly when missing', () => {
  const complete = {
    JWT_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef',
    MONGODB_URI: 'mongodb://mongodb:27017/wealthgenie?replicaSet=rs0',
    ML_SERVICE_API_KEY: 'production-secret-api-key-value-secure',
    METRICS_TOKEN: 'production-metrics-token-at-least-32-characters',
    REDIS_PASSWORD: 'production-redis-password-at-least-32-chars',
    CORS_ORIGINS: 'https://wealthgenie.example',
    NODE_ENV: 'production',
  };
  const expected = {
    JWT_SECRET: 'JWT_SECRET',
    MONGODB_URI: 'MONGODB_URI',
    ML_SERVICE_API_KEY: 'ML_SERVICE_API_KEY',
    METRICS_TOKEN: 'METRICS_TOKEN',
    REDIS_PASSWORD: 'Redis authentication',
    CORS_ORIGINS: 'CORS_ORIGINS',
  };

  for (const [name, message] of Object.entries(expected)) {
    const result = validateEnvironmentConfig({ ...complete, [name]: '' });
    assert.equal(result.valid, false, `${name} must be required in production`);
    assert.ok(result.errors.some(error => error.includes(message)), `${name} error must be explicit`);
  }
});

test('Config Validation: Production requires an explicit HTTPS browser origin', () => {
  const base = {
    JWT_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef',
    MONGODB_URI: 'mongodb://mongodb:27017/wealthgenie',
    ML_SERVICE_API_KEY: 'production-secret-api-key-value-secure',
    METRICS_TOKEN: 'production-metrics-token-at-least-32-characters',
    NODE_ENV: 'production',
  };
  const missing = validateEnvironmentConfig(base);
  const insecure = validateEnvironmentConfig({ ...base, CORS_ORIGINS: 'http://app.example' });
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.some(error => error.includes('CORS_ORIGINS')));
  assert.equal(insecure.valid, false);
  assert.ok(insecure.errors.some(error => error.includes('invalid production origin')));
});

test('Config Validation: Production rejects unsafe browser and metrics settings', () => {
  const result = validateEnvironmentConfig({
    JWT_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef',
    MONGODB_URI: 'mongodb://mongodb:27017/wealthgenie',
    ML_SERVICE_API_KEY: 'production-secret-api-key-value-secure',
    METRICS_TOKEN: 'CHANGE_ME_METRICS_TOKEN_AT_LEAST_32_CHARACTERS',
    CORS_ORIGINS: 'https://app.wealthgenie.example',
    AUTH_COOKIE_SAME_SITE: 'invalid',
    EXPOSE_AUTH_TOKEN: 'true',
    NODE_ENV: 'production',
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.includes('METRICS_TOKEN')));
  assert.ok(result.errors.some(error => error.includes('AUTH_COOKIE_SAME_SITE')));
  assert.ok(result.errors.some(error => error.includes('EXPOSE_AUTH_TOKEN')));
});

test('MCP runtime defaults keep remote access disabled in production and follow the local feature switch', () => {
  const production = getRuntimeConfig({ NODE_ENV: 'production' });
  assert.equal(production.mcp.enabled, false);
  assert.equal(production.mcp.remoteEnabled, false);
  const localDisabled = getRuntimeConfig({ NODE_ENV: 'development', MCP_ENABLED: 'false' });
  assert.equal(localDisabled.mcp.enabled, false);
  assert.equal(localDisabled.mcp.remoteEnabled, false);
  assert.doesNotThrow(() => assertValidRuntimeConfig(localDisabled));
  const validBase = {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-valid',
    MONGODB_URI: 'mongodb://localhost:27017/wealthgenie',
    NODE_ENV: 'development',
    MCP_ENABLED: 'false',
  };
  const localValidation = validateEnvironmentConfig(validBase);
  assert.equal(localValidation.valid, true, localValidation.errors.join('; '));
});

test('enabled Plan Review rejects embedded mode without a worker and preserves external queue mode', () => {
  const noEmbeddedWorker = getRuntimeConfig({
    NODE_ENV: 'development',
    AGENTIC_PLAN_REVIEW_ENABLED: 'true',
    AGENT_WORKER_MODE: 'embedded',
    AGENT_WORKER_ENABLED: 'false',
  });
  assert.throws(
    () => assertValidRuntimeConfig(noEmbeddedWorker),
    /AGENTIC_PLAN_REVIEW_ENABLED=true requires an embedded worker/i,
  );

  const externalQueueApi = getRuntimeConfig({
    NODE_ENV: 'development',
    AGENTIC_PLAN_REVIEW_ENABLED: 'true',
    AGENT_WORKER_MODE: 'external',
    AGENT_WORKER_ENABLED: 'false',
  });
  assert.doesNotThrow(() => assertValidRuntimeConfig(externalQueueApi));
});

test('MCP production remote enablement requires one exact audience and scope plus Redis and trusted origin/host', () => {
  const productionBase = {
    JWT_SECRET: '0123456789abcdef0123456789abcdef0123456789abcdef',
    MONGODB_URI: 'mongodb://mongodb:27017/wealthgenie?replicaSet=rs0',
    ML_SERVICE_API_KEY: 'production-secret-api-key-value-secure',
    METRICS_TOKEN: 'production-metrics-token-at-least-32-characters',
    CORS_ORIGINS: 'https://app.wealthgenie.example',
    NODE_ENV: 'production',
    MCP_ENABLED: 'true',
    MCP_REMOTE_ENABLED: 'true',
    MCP_JWT_SECRET: 'production-mcp-signing-secret-value-at-least-32-chars',
    MCP_JWT_ISSUER: 'wealthgenie-mcp',
    MCP_JWT_AUDIENCE: 'wealthgenie-mcp',
    MCP_REQUIRED_SCOPE: 'mcp:tools',
    MCP_ALLOWED_HOSTS: 'mcp.wealthgenie.example',
    MCP_ALLOWED_ORIGINS: 'https://app.wealthgenie.example',
    REQUIRE_REDIS: 'true',
    REDIS_URL: 'rediss://redis.wealthgenie.example:6379',
    REDIS_PASSWORD: 'production-redis-password-at-least-32-chars',
    TRUSTED_PROXY_CIDRS: '10.0.0.0/8,2001:db8::/32',
  };
  assert.equal(validateEnvironmentConfig(productionBase).valid, true);
  assert.doesNotThrow(() => assertValidRuntimeConfig(getRuntimeConfig(productionBase)));
  const badScope = validateEnvironmentConfig({ ...productionBase, MCP_REQUIRED_SCOPE: 'mcp:tools admin' });
  assert.equal(badScope.valid, false);
  assert.ok(badScope.errors.some(error => error.includes('one bounded scope token')));
  const noRedis = validateEnvironmentConfig({ ...productionBase, REQUIRE_REDIS: 'false' });
  assert.equal(noRedis.valid, false);
  assert.ok(noRedis.errors.some(error => error.includes('requires REQUIRE_REDIS=true')));
  const missingRedisUrl = validateEnvironmentConfig({ ...productionBase, REDIS_URL: '' });
  assert.equal(missingRedisUrl.valid, false);
  assert.ok(missingRedisUrl.errors.some(error => error.includes('REDIS_URL is required')));
  const malformedRedisUrl = validateEnvironmentConfig({ ...productionBase, REDIS_URL: 'https://redis.example' });
  assert.equal(malformedRedisUrl.valid, false);
  assert.ok(malformedRedisUrl.errors.some(error => error.includes('valid redis:// or rediss:// URL')));
  const missingRedisAuthentication = validateEnvironmentConfig({ ...productionBase, REDIS_PASSWORD: '' });
  assert.equal(missingRedisAuthentication.valid, false);
  assert.ok(missingRedisAuthentication.errors.some(error => error.includes('Redis authentication is required')));
  const shortRedisPassword = validateEnvironmentConfig({ ...productionBase, REDIS_PASSWORD: 'too-short' });
  assert.equal(shortRedisPassword.valid, false);
  assert.ok(shortRedisPassword.errors.some(error => error.includes('at least 32 characters')));
  const placeholderRedisPassword = validateEnvironmentConfig({
    ...productionBase,
    REDIS_PASSWORD: 'CHANGE_ME_REDIS_PASSWORD_AT_LEAST_32_CHARACTERS',
  });
  assert.equal(placeholderRedisPassword.valid, false);
  assert.ok(placeholderRedisPassword.errors.some(error => error.includes('placeholder password')));
  const placeholderRedisUrlPassword = validateEnvironmentConfig({
    ...productionBase,
    REDIS_PASSWORD: '',
    REDIS_URL: 'rediss://wealthgenie:CHANGE_ME_REDIS_PASSWORD_AT_LEAST_32_CHARACTERS@redis.wealthgenie.example:6379',
  });
  assert.equal(placeholderRedisUrlPassword.valid, false);
  assert.ok(placeholderRedisUrlPassword.errors.some(error => error.includes('placeholder password')));
  const encodedShortRedisUrlPassword = validateEnvironmentConfig({
    ...productionBase,
    REDIS_PASSWORD: '',
    REDIS_URL: `rediss://wealthgenie:${encodeURIComponent('@'.repeat(11))}@redis.wealthgenie.example:6379`,
  });
  assert.equal(encodedShortRedisUrlPassword.valid, false);
  assert.ok(encodedShortRedisUrlPassword.errors.some(error => error.includes('at least 32 characters')));
  const explicitRedisPasswordWinsOverUrlCredentials = validateEnvironmentConfig({
    ...productionBase,
    REDIS_PASSWORD: 'explicit-production-redis-password-is-long-enough',
    REDIS_URL: 'rediss://wealthgenie:short@redis.wealthgenie.example:6379',
  });
  assert.equal(explicitRedisPasswordWinsOverUrlCredentials.valid, true, explicitRedisPasswordWinsOverUrlCredentials.errors.join('; '));
  const whitespaceRedisPasswordUsesUrlCredentials = validateEnvironmentConfig({
    ...productionBase,
    REDIS_PASSWORD: '   ',
    REDIS_URL: 'rediss://wealthgenie:0123456789abcdef0123456789abcdef@redis.wealthgenie.example:6379',
  });
  assert.equal(whitespaceRedisPasswordUsesUrlCredentials.valid, true, whitespaceRedisPasswordUsesUrlCredentials.errors.join('; '));
  const exampleRedisSecret = validateEnvironmentConfig({
    ...productionBase,
    REDIS_PASSWORD: 'CHANGE_ME_REDIS_PASSWORD_AT_LEAST_32_CHARACTERS',
  });
  assert.equal(exampleRedisSecret.valid, false, 'The checked-in example Secret must never satisfy production validation');
  const authenticatedRedisUrl = validateEnvironmentConfig({
    ...productionBase,
    REDIS_PASSWORD: '',
    REDIS_URL: 'rediss://wealthgenie:0123456789abcdef0123456789abcdef@redis.wealthgenie.example:6379',
  });
  assert.equal(authenticatedRedisUrl.valid, true, authenticatedRedisUrl.errors.join('; '));
  const malformedTrustedProxy = validateEnvironmentConfig({ ...productionBase, TRUSTED_PROXY_CIDRS: '10.0.0.0/not-a-mask' });
  assert.equal(malformedTrustedProxy.valid, false);
  assert.ok(malformedTrustedProxy.errors.some(error => error.includes('valid proxy CIDR/range')));
  const missingTransportBoundary = validateEnvironmentConfig({ ...productionBase, TRUSTED_PROXY_CIDRS: '' });
  assert.equal(missingTransportBoundary.valid, false);
  assert.ok(missingTransportBoundary.errors.some(error => error.includes('TRUSTED_PROXY_CIDRS')));
  const directTls = validateEnvironmentConfig({ ...productionBase, TRUSTED_PROXY_CIDRS: '', MCP_DIRECT_TLS: 'true' });
  assert.equal(directTls.valid, true, directTls.errors.join('; '));
  const malformedDirectTls = validateEnvironmentConfig({ ...productionBase, MCP_DIRECT_TLS: 'yes' });
  assert.equal(malformedDirectTls.valid, false);
  assert.ok(malformedDirectTls.errors.some(error => error.includes('MCP_DIRECT_TLS must be true or false')));
});
