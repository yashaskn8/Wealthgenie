import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchesBuildSha } from '../../shared/buildIdentity.js';
import { financialProfileCompletionSchema } from '../validation/financialSchemas.js';
import { taxCalculationContextSchema } from '../validation/taxSchemas.js';
import {
  isSafeDemoDatabaseHost,
  isSafeDemoDatabaseName,
  isSafeDemoDatabasePort,
  isSafeDemoEnvironmentId,
} from '../services/demoDatabaseIdentity.js';
import { BACKEND_HTTP_HARD_TIMEOUT_MS, isRedisRequired, isSafeDemoUrl, readJson } from './demoPreflight.js';
import { hasUpstoxAccessToken } from '../services/marketData/upstoxCredentials.js';

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REACTAPP_DIR = path.resolve(SERVER_DIR, '..', 'reactapp');
const requireFromReactapp = createRequire(path.join(REACTAPP_DIR, 'package.json'));
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

function safeUrl(value, { api = false, remoteOrigins } = {}) {
  if (!isSafeDemoUrl(value, { api, remoteOrigins })) return null;
  return new URL(value);
}

async function validateFixture(filePath, schema) {
  if (typeof filePath !== 'string' || !filePath.trim()) return false;
  try {
    const value = JSON.parse(await readFile(path.resolve(filePath), 'utf8'));
    return Boolean(value && !Array.isArray(value) && typeof value === 'object'
      && !schema.validate(value, { abortEarly: false, convert: false, stripUnknown: false }).error);
  } catch {
    return false;
  }
}

function add(checks, write, name, passed, detail) {
  const state = passed === true ? 'PASS' : 'FAIL';
  checks.push({ name, passed: state === 'PASS', state, detail });
  write(`${state} ${name} — ${detail}`);
}

/** Read-only diagnostics. This deliberately has no mutation, auth, or provider-call dependency. */
export async function runDemoDoctor({ environment = process.env, write = line => process.stdout.write(`${line}\n`), dependencies = {} } = {}) {
  const checks = [];
  const readHttp = dependencies.readHttp || readJson;
  const requiredPresence = [
    'DEMO_LIVE_PREFLIGHT', 'DEMO_API_BASE_URL', 'DEMO_FRONTEND_URL',
    'DEMO_PROFILE_COMPLETION_FILE', 'DEMO_TAX_CONTEXT_FILE',
    'DEMO_EXPECTED_BUILD_SHA', 'DEMO_EXPECTED_MONGODB_DATABASE', 'DEMO_EXPECTED_MONGODB_HOST',
    'DEMO_EXPECTED_MONGODB_PORT',
    'DEMO_EXPECTED_MONGODB_ENVIRONMENT_ID',
    'DEMO_COMPLETION_IDEMPOTENCY_KEY', 'DEMO_NIFTY_ETF_PARENT_ID',
    'DEMO_EMAIL', 'DEMO_PASSWORD',
  ];
  for (const name of requiredPresence) {
    add(checks, write, `${name} presence`, typeof environment[name] === 'string' && environment[name].length > 0,
      environment[name] ? 'PRESENT (value hidden)' : 'MISSING');
  }
  add(checks, write, 'Explicit live-demo mode', environment.DEMO_LIVE_PREFLIGHT === '1',
    environment.DEMO_LIVE_PREFLIGHT === '1' ? 'PASS configuration only; this doctor does not execute live preflight' : 'set DEMO_LIVE_PREFLIGHT=1 for a later explicit live run');

  const api = safeUrl(environment.DEMO_API_BASE_URL, { api: true, remoteOrigins: environment.DEMO_TRUSTED_REMOTE_ORIGINS });
  const frontend = safeUrl(environment.DEMO_FRONTEND_URL, { remoteOrigins: environment.DEMO_TRUSTED_REMOTE_ORIGINS });
  const backendHealth = api && safeUrl(environment.DEMO_BACKEND_HEALTH_URL || `${api.origin}/`, {
    remoteOrigins: environment.DEMO_TRUSTED_REMOTE_ORIGINS,
  });
  add(checks, write, 'API URL syntax', Boolean(api), api ? 'valid local URL or explicitly allowlisted HTTPS /api origin' : 'configure a safe local URL or explicitly allowlisted HTTPS API origin ending in /api');
  add(checks, write, 'Frontend URL syntax', Boolean(frontend), frontend ? 'valid local URL or explicitly allowlisted HTTPS origin' : 'configure a safe local or explicitly allowlisted frontend URL');
  add(checks, write, 'Backend health URL syntax', Boolean(backendHealth && backendHealth.pathname === '/'), backendHealth?.pathname === '/'
    ? 'safe backend health origin verified'
    : 'configure a safe backend origin without a path, query, or fragment');
  const expectedSha = matchesBuildSha(environment.DEMO_EXPECTED_BUILD_SHA, environment.DEMO_EXPECTED_BUILD_SHA);
  add(checks, write, 'Expected build SHA syntax', expectedSha, expectedSha ? 'valid full 40-character SHA' : 'configure a full 40-character hexadecimal SHA');
  const expectedDatabaseValid = isSafeDemoDatabaseName(environment.DEMO_EXPECTED_MONGODB_DATABASE);
  add(checks, write, 'Expected demo database', expectedDatabaseValid, expectedDatabaseValid ? 'safe isolated database identifier configured (value hidden)' : 'configure DEMO_EXPECTED_MONGODB_DATABASE to a non-reserved isolated database name');
  const expectedDatabaseHostValid = isSafeDemoDatabaseHost(environment.DEMO_EXPECTED_MONGODB_HOST);
  add(checks, write, 'Expected demo database host', expectedDatabaseHostValid, expectedDatabaseHostValid ? 'exact connected Mongo host configured (value hidden)' : 'configure DEMO_EXPECTED_MONGODB_HOST to the exact Mongo connection host');
  const expectedDatabasePortValid = isSafeDemoDatabasePort(environment.DEMO_EXPECTED_MONGODB_PORT);
  add(checks, write, 'Expected demo database port', expectedDatabasePortValid, expectedDatabasePortValid ? 'exact connected Mongo port configured (value hidden)' : 'configure DEMO_EXPECTED_MONGODB_PORT to the exact Mongo connection port');
  const expectedEnvironmentIdValid = isSafeDemoEnvironmentId(environment.DEMO_EXPECTED_MONGODB_ENVIRONMENT_ID);
  add(checks, write, 'Expected demo environment ID', expectedEnvironmentIdValid, expectedEnvironmentIdValid ? 'UUIDv4 environment identity configured (value hidden)' : 'configure DEMO_EXPECTED_MONGODB_ENVIRONMENT_ID with the UUIDv4 stored in the isolated demo database sentinel');
  const idempotencyValid = IDEMPOTENCY_KEY_PATTERN.test(environment.DEMO_COMPLETION_IDEMPOTENCY_KEY || '');
  add(checks, write, 'Completion idempotency key', idempotencyValid, idempotencyValid ? 'key grammar and length valid (value hidden)' : 'configure an 8–128 character URL-safe idempotency key');
  add(checks, write, 'Nifty ETF parent identity', environment.DEMO_NIFTY_ETF_PARENT_ID === 'nifty_etf',
    environment.DEMO_NIFTY_ETF_PARENT_ID === 'nifty_etf' ? 'exact configured parent identity' : 'configure the exact expected parent identity');

  const [profileFixtureValid, taxFixtureValid] = await Promise.all([
    validateFixture(environment.DEMO_PROFILE_COMPLETION_FILE, financialProfileCompletionSchema),
    validateFixture(environment.DEMO_TAX_CONTEXT_FILE, taxCalculationContextSchema),
  ]);
  add(checks, write, 'Profile completion fixture', profileFixtureValid, profileFixtureValid ? 'file exists and matches strict completion schema; contents hidden' : 'provide a valid profile-completion JSON object; path and contents are not emitted');
  add(checks, write, 'Tax input fixture', taxFixtureValid, taxFixtureValid ? 'file exists and matches strict tax-context schema; contents hidden' : 'provide a valid tax-context JSON object; path and contents are not emitted');

  const provider = String(environment.MARKET_DATA_PRIMARY_PROVIDER || 'NSE').trim().toUpperCase();
  const providerValid = provider === 'NSE' || provider === 'UPSTOX';
  add(checks, write, 'Market provider selection', providerValid, providerValid ? `configured provider ${provider}` : 'configure NSE or UPSTOX');
  const tokenPresent = provider === 'NSE' || hasUpstoxAccessToken(environment);
  add(checks, write, 'Provider token presence', providerValid && tokenPresent,
    !providerValid ? 'provider selection is invalid' : provider === 'NSE' ? 'NSE does not require a provider token' : tokenPresent ? 'Upstox token PRESENT (value hidden)' : 'selected Upstox provider requires a server-side token');

  if (api && backendHealth?.pathname === '/') {
    const [live, readiness, verification, deep] = await Promise.all([
      readHttp(`${backendHealth.origin}/health/live`, { timeoutMs: BACKEND_HTTP_HARD_TIMEOUT_MS }).catch(() => null),
      readHttp(`${backendHealth.origin}/health/ready`, { timeoutMs: BACKEND_HTTP_HARD_TIMEOUT_MS }).catch(() => null),
      readHttp(`${backendHealth.origin}/health/verification`, {
        timeoutMs: BACKEND_HTTP_HARD_TIMEOUT_MS,
        headers: {
          'X-Demo-Expected-Mongodb-Database': expectedDatabaseValid
            ? environment.DEMO_EXPECTED_MONGODB_DATABASE
            : '',
          'X-Demo-Expected-Mongodb-Host': isSafeDemoDatabaseHost(environment.DEMO_EXPECTED_MONGODB_HOST)
            ? environment.DEMO_EXPECTED_MONGODB_HOST
            : '',
          'X-Demo-Expected-Mongodb-Port': isSafeDemoDatabasePort(environment.DEMO_EXPECTED_MONGODB_PORT)
            ? String(environment.DEMO_EXPECTED_MONGODB_PORT)
            : '',
          'X-Demo-Expected-Mongodb-Environment-Id': expectedEnvironmentIdValid
            ? environment.DEMO_EXPECTED_MONGODB_ENVIRONMENT_ID
            : '',
        },
      }).catch(() => null),
      readHttp(`${backendHealth.origin}/health/deep`, { timeoutMs: BACKEND_HTTP_HARD_TIMEOUT_MS }).catch(() => null),
    ]);
    add(checks, write, 'Backend liveness and build identity', Boolean(live?.response.ok && live.body?.status === 'ALIVE'
      && matchesBuildSha(environment.DEMO_EXPECTED_BUILD_SHA, live.body?.buildSha)),
    live?.response.ok ? 'backend responds with the exact expected build identity' : 'backend liveness or build identity not verified');
    add(checks, write, 'Backend readiness and index verification', readiness?.response.ok === true && readiness.body?.status === 'READY',
      readiness?.response.ok === true && readiness.body?.status === 'READY' ? 'backend is READY with required indexes' : 'backend readiness or required indexes not verified');
    const mongo = verification?.body?.mongo;
    const runtimeProvider = verification?.body?.marketProvider;
    const runtimeTokenPresent = verification?.body?.marketProviderTokenPresent === true;
    const mongoVerified = verification?.body?.status === 'DEMO_DATABASE_VERIFIED'
      && expectedDatabaseValid
      && expectedDatabaseHostValid
      && expectedDatabasePortValid
      && expectedEnvironmentIdValid
      && mongo?.connected === true
      && mongo?.transactionCapable === true
      && mongo?.databaseIdentityVerified === true
      && mongo?.environmentSentinelVerified === true;
    add(checks, write, 'Connected database identity and transaction', mongoVerified
      && matchesBuildSha(environment.DEMO_EXPECTED_BUILD_SHA, verification?.body?.buildSha),
    mongoVerified ? 'backend verified the isolated database sentinel and read-only transaction; identity values hidden' : 'database identity, sentinel, connection, transaction, or backend build was not verified');
    const redis = verification?.body?.redis;
    const redisRequired = isRedisRequired(environment);
    add(checks, write, 'Redis policy', redis?.required === redisRequired && (!redisRequired || redis.connected === true),
      redis?.required === redisRequired && (!redisRequired || redis.connected === true)
        ? (redisRequired ? 'required Redis is connected' : 'Redis is optional for this runtime')
        : 'Redis runtime policy/connection does not match preflight configuration');
    const services = deep?.body?.services;
    add(checks, write, 'Backend dependency health', deep?.response.ok === true && services?.database === 'UP'
      && (!redisRequired || services?.redis === 'UP'),
    deep?.response.ok === true ? 'database and required Redis health verified' : 'backend dependency health not verified');
    add(checks, write, 'Backend market provider configuration', providerValid && runtimeProvider === provider
      && (provider === 'NSE' || runtimeTokenPresent),
    runtimeProvider === provider && provider === 'NSE' ? 'backend and doctor agree on NSE; no provider token is required'
      : runtimeProvider === provider && runtimeTokenPresent ? 'backend and doctor agree on Upstox; backend token presence verified (value hidden)'
        : 'backend selected provider or required token does not match the configured provider');
  } else {
    for (const name of ['Backend liveness and build identity', 'Backend readiness and index verification', 'Connected database identity and transaction', 'Redis policy', 'Backend dependency health', 'Backend market provider configuration']) {
      add(checks, write, name, false, 'FAIL because API URL configuration is unavailable');
    }
  }

  if (frontend) {
    const frontendResponse = await readHttp(new URL('/login', frontend).toString(), { timeoutMs: BACKEND_HTTP_HARD_TIMEOUT_MS }).catch(() => null);
    add(checks, write, 'Frontend reachability', frontendResponse?.response.ok === true,
      frontendResponse?.response.ok === true ? 'login page responds; no authentication attempted' : 'frontend is not reachable at the configured URL');
  } else {
    add(checks, write, 'Frontend reachability', false, 'FAIL because frontend URL configuration is unavailable');
  }

  let browserAvailable = false;
  let browser;
  try {
    if (dependencies.launchBrowser) {
      browser = await dependencies.launchBrowser({ headless: true });
    } else {
      const { chromium } = requireFromReactapp('@playwright/test');
      browser = await chromium.launch({ headless: true });
    }
    browserAvailable = true;
  } catch {
    browserAvailable = false;
  } finally {
    await browser?.close().catch(() => {});
  }
  add(checks, write, 'Playwright Chromium availability', browserAvailable,
    browserAvailable ? 'Chromium launched and closed; no page or user flow was run' : 'Playwright Chromium could not be launched');

  const passed = checks.every(check => check.passed);
  if (passed) write('\nREAD-ONLY DEMO PREREQUISITES VERIFIED — LIVE PREFLIGHT NOT YET EXECUTED');
  else write(`\nRead-only demo doctor: ${checks.filter(check => check.passed).length} PASS, ${checks.filter(check => !check.passed).length} FAIL.`);
  return { exitCode: passed ? 0 : 1, checks, passed: checks.filter(check => check.passed).length, failed: checks.filter(check => !check.passed).length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runDemoDoctor();
  process.exitCode = result.exitCode;
}
