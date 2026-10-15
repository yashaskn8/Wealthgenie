import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runDemoDoctor } from '../scripts/demoDoctor.js';

const BUILD_SHA = 'a'.repeat(40);

async function makeFixtureEnvironment() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wealthgenie-demo-doctor-test-'));
  const profilePath = path.join(directory, 'profile.json');
  const taxPath = path.join(directory, 'tax.json');
  await writeFile(profilePath, JSON.stringify({
    monthly_take_home: 100000,
    monthly_savings: 25000,
    age: 30,
    risk_tolerance: 'Moderate',
    investment_goals: ['Wealth Growth'],
    investment_horizon_years: 10,
  }));
  await writeFile(taxPath, JSON.stringify({
    annualGrossIncome: 500000,
    incomeSource: 'salary',
    regime: 'new',
    fiscalYear: 'FY2026-27',
    userAge: 35,
    holdingPeriodMonths: 18,
    section112AExemptionUsed: 0,
    sttConditionAssumedSatisfied: true,
    illustrativePrincipal: 1000000,
  }));
  return {
    directory,
    environment: {
      DEMO_LIVE_PREFLIGHT: '1',
      DEMO_API_BASE_URL: 'http://127.0.0.1:5000/api',
      DEMO_FRONTEND_URL: 'http://127.0.0.1:5173',
      DEMO_PROFILE_COMPLETION_FILE: profilePath,
      DEMO_TAX_CONTEXT_FILE: taxPath,
      DEMO_EXPECTED_BUILD_SHA: BUILD_SHA,
      DEMO_EXPECTED_MONGODB_DATABASE: 'wealthgenie_demo',
      DEMO_EXPECTED_MONGODB_HOST: '127.0.0.1',
      DEMO_EXPECTED_MONGODB_PORT: '27017',
      DEMO_EXPECTED_MONGODB_ENVIRONMENT_ID: '11111111-1111-4111-8111-111111111111',
      DEMO_COMPLETION_IDEMPOTENCY_KEY: 'doctor-test-idempotency-key',
      DEMO_NIFTY_ETF_PARENT_ID: 'nifty_etf',
      DEMO_EMAIL: 'demo@example.invalid',
      DEMO_PASSWORD: 'never-print-this-secret',
      MARKET_DATA_PRIMARY_PROVIDER: 'NSE',
      NODE_ENV: 'test',
    },
  };
}

function response(status, body) {
  return { response: { ok: status >= 200 && status < 300, status }, body };
}

function verifiedResponses({ databaseIdentityVerified = true, marketProvider = 'NSE', marketProviderTokenPresent = true } = {}) {
  return async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/health/live') return response(200, { status: 'ALIVE', buildSha: BUILD_SHA });
    if (parsed.pathname === '/health/ready') return response(200, { status: 'READY' });
    if (parsed.pathname === '/health/verification') {
      assert.equal(options.headers?.['X-Demo-Expected-Mongodb-Database'], 'wealthgenie_demo');
      assert.equal(options.headers?.['X-Demo-Expected-Mongodb-Host'], '127.0.0.1');
      assert.equal(options.headers?.['X-Demo-Expected-Mongodb-Port'], '27017');
      assert.equal(options.headers?.['X-Demo-Expected-Mongodb-Environment-Id'], '11111111-1111-4111-8111-111111111111');
      return response(200, {
        status: 'DEMO_DATABASE_VERIFIED',
        buildSha: BUILD_SHA,
        mongo: { connected: true, transactionCapable: true, databaseIdentityVerified, environmentSentinelVerified: true },
        redis: { required: false, connected: false },
        marketProvider,
        marketProviderTokenPresent,
      });
    }
    if (parsed.pathname === '/health/deep') return response(200, { services: { database: 'UP', redis: 'DOWN' } });
    if (parsed.pathname === '/login') return response(200, {});
    throw new Error(`Unexpected doctor request: ${parsed.pathname}`);
  };
}

test('read-only doctor validates runtime prerequisites without invoking mutation endpoints', async () => {
  const fixture = await makeFixtureEnvironment();
  const output = [];
  const paths = [];
  try {
    const result = await runDemoDoctor({
      environment: fixture.environment,
      write: line => output.push(line),
      dependencies: {
        async readHttp(url, options) {
          paths.push(new URL(url).pathname);
          return verifiedResponses()(url, options);
        },
        async launchBrowser() { return { async close() {} }; },
      },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.failed, 0);
    assert.ok(output.join('\n').includes('READ-ONLY DEMO PREREQUISITES VERIFIED — LIVE PREFLIGHT NOT YET EXECUTED'), output.join('\n'));
    assert.ok(paths.includes('/health/live'));
    assert.ok(paths.includes('/health/ready'));
    assert.ok(paths.includes('/health/verification'));
    assert.ok(paths.includes('/health/deep'));
    assert.ok(paths.includes('/login'));
    assert.ok(paths.every(value => !/^\/api\/(auth|profile|recommend|instruments|tax)\b/.test(value)));
    assert.doesNotMatch(output.join('\n'), /never-print-this-secret/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('read-only doctor resolves a whitespace Analytics token through the access-token fallback', async () => {
  const fixture = await makeFixtureEnvironment();
  fixture.environment.MARKET_DATA_PRIMARY_PROVIDER = 'UPSTOX';
  fixture.environment.UPSTOX_ANALYTICS_TOKEN = '   ';
  fixture.environment.UPSTOX_ACCESS_TOKEN = ' doctor-fixture-token ';
  const output = [];
  try {
    const result = await runDemoDoctor({
      environment: fixture.environment,
      write: line => output.push(line),
      dependencies: {
        readHttp: verifiedResponses({ marketProvider: 'UPSTOX', marketProviderTokenPresent: true }),
        async launchBrowser() { return { async close() {} }; },
      },
    });
    assert.equal(result.checks.find(check => check.name === 'Provider token presence').state, 'PASS');
    assert.equal(result.checks.find(check => check.name === 'Backend market provider configuration').state, 'PASS');
    assert.doesNotMatch(output.join('\n'), /doctor-fixture-token/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('read-only doctor treats whitespace-only Upstox credentials as absent', async () => {
  const fixture = await makeFixtureEnvironment();
  fixture.environment.MARKET_DATA_PRIMARY_PROVIDER = 'UPSTOX';
  fixture.environment.UPSTOX_ANALYTICS_TOKEN = '   ';
  fixture.environment.UPSTOX_ACCESS_TOKEN = ' \t ';
  const output = [];
  try {
    const result = await runDemoDoctor({
      environment: fixture.environment,
      write: line => output.push(line),
      dependencies: {
        readHttp: verifiedResponses({ marketProvider: 'UPSTOX', marketProviderTokenPresent: false }),
        async launchBrowser() { return { async close() {} }; },
      },
    });
    assert.equal(result.checks.find(check => check.name === 'Provider token presence').state, 'FAIL');
    assert.equal(result.checks.find(check => check.name === 'Backend market provider configuration').state, 'FAIL');
    assert.doesNotMatch(output.join('\n'), /UPSTOX_(ANALYTICS|ACCESS)_TOKEN/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('read-only doctor separates backend health from the frontend same-origin API proxy', async () => {
  const fixture = await makeFixtureEnvironment();
  fixture.environment.DEMO_API_BASE_URL = 'http://127.0.0.1:8080/api';
  fixture.environment.DEMO_FRONTEND_URL = 'http://127.0.0.1:8080';
  fixture.environment.DEMO_BACKEND_HEALTH_URL = 'http://127.0.0.1:5000';
  const requested = [];
  try {
    const result = await runDemoDoctor({
      environment: fixture.environment,
      write: () => {},
      dependencies: {
        async readHttp(url, options) {
          requested.push(new URL(url));
          return verifiedResponses()(url, options);
        },
        async launchBrowser() { return { async close() {} }; },
      },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(requested.filter(url => url.pathname.startsWith('/health/')).every(url => url.origin === 'http://127.0.0.1:5000'), true);
    assert.equal(requested.find(url => url.pathname === '/login')?.origin, 'http://127.0.0.1:8080');
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('read-only doctor fails closed when the connected database is not the configured isolated DB', async () => {
  const fixture = await makeFixtureEnvironment();
  const output = [];
  try {
    const result = await runDemoDoctor({
      environment: fixture.environment,
      write: line => output.push(line),
      dependencies: {
        readHttp: verifiedResponses({ databaseIdentityVerified: false }),
        async launchBrowser() { return { async close() {} }; },
      },
    });
    assert.equal(result.exitCode, 1);
    assert.ok(result.checks.find(check => check.name === 'Connected database identity and transaction').state === 'FAIL');
    assert.ok(!output.join('\n').includes('READ-ONLY DEMO PREREQUISITES VERIFIED — LIVE PREFLIGHT NOT YET EXECUTED'));
    assert.doesNotMatch(output.join('\n'), /never-print-this-secret/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('read-only doctor marks an absent Mongo port as an unverified demo identity', async () => {
  const fixture = await makeFixtureEnvironment();
  delete fixture.environment.DEMO_EXPECTED_MONGODB_PORT;
  try {
    const result = await runDemoDoctor({
      environment: fixture.environment,
      write: () => {},
      dependencies: {
        readHttp: verifiedResponses(),
        async launchBrowser() { return { async close() {} }; },
      },
    });
    assert.equal(result.checks.find(check => check.name === 'Expected demo database port').state, 'FAIL');
    assert.equal(result.checks.find(check => check.name === 'Connected database identity and transaction').state, 'FAIL');
    assert.equal(result.exitCode, 1);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('read-only doctor signals missing DB identity explicitly so health skips its transaction probe', async () => {
  const fixture = await makeFixtureEnvironment();
  delete fixture.environment.DEMO_EXPECTED_MONGODB_DATABASE;
  let verificationCalls = 0;
  try {
    const result = await runDemoDoctor({
      environment: fixture.environment,
      write: () => {},
      dependencies: {
        async readHttp(url, options = {}) {
          if (new URL(url).pathname === '/health/verification') {
            verificationCalls += 1;
            assert.equal(Object.hasOwn(options.headers || {}, 'X-Demo-Expected-Mongodb-Database'), true);
            assert.equal(options.headers['X-Demo-Expected-Mongodb-Database'], '');
            assert.equal(options.headers['X-Demo-Expected-Mongodb-Host'], '127.0.0.1');
            assert.equal(options.headers['X-Demo-Expected-Mongodb-Port'], '27017');
            assert.equal(options.headers['X-Demo-Expected-Mongodb-Environment-Id'], '11111111-1111-4111-8111-111111111111');
            return response(503, {
              status: 'NOT_VERIFIED',
              buildSha: BUILD_SHA,
              mongo: { connected: true, transactionCapable: false, databaseIdentityVerified: false, environmentSentinelVerified: false },
              redis: { required: false, connected: false },
              marketProvider: 'NSE',
              marketProviderTokenPresent: true,
            });
          }
          return await verifiedResponses()(url, options);
        },
        async launchBrowser() { return { async close() {} }; },
      },
    });
    assert.equal(result.exitCode, 1);
    assert.equal(verificationCalls, 1);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('read-only doctor rejects unallowlisted remote endpoints before probing or browser launch', async () => {
  const fixture = await makeFixtureEnvironment();
  fixture.environment.DEMO_API_BASE_URL = 'https://attacker.example/api';
  const requestedPaths = [];
  try {
    const result = await runDemoDoctor({
      environment: fixture.environment,
      write: () => {},
      dependencies: {
        async readHttp(url) { requestedPaths.push(new URL(url).pathname); return response(200, {}); },
        async launchBrowser() { throw new Error('must not launch'); },
      },
    });
    assert.equal(result.exitCode, 1);
    assert.equal(requestedPaths.some(value => value.startsWith('/health/')), false);
    assert.equal(result.checks.find(check => check.name === 'API URL syntax').state, 'FAIL');
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
test('read-only doctor rejects invalid profile and tax fixtures without echoing fixture content', async () => {
  const fixture = await makeFixtureEnvironment();
  try {
    await writeFile(fixture.environment.DEMO_PROFILE_COMPLETION_FILE, JSON.stringify({ monthly_take_home: 999 }));
    const output = [];
    const result = await runDemoDoctor({
      environment: fixture.environment,
      write: line => output.push(line),
      dependencies: {
        readHttp: verifiedResponses(),
        async launchBrowser() { return { async close() {} }; },
      },
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.checks.find(check => check.name === 'Profile completion fixture').state, 'FAIL');
    assert.doesNotMatch(output.join('\n'), /monthly_take_home|999|never-print-this-secret/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
