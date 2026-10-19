import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { parse } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const yaml = path => parse(readFileSync(resolve(root, path), 'utf8'));
const variables = ['UPSTOX_ANALYTICS_TOKEN', 'UPSTOX_ACCESS_TOKEN', 'TEJHQ_API_KEY'];
const flags = {
  MARKET_DATA_MODE: 'LEGACY',
  MARKET_DATA_PRIMARY_PROVIDER: 'NSE',
  UPSTOX_PUBLIC_MARKET_DATA_LICENSE_CONFIRMED: 'false',
  TEJHQ_ENABLED: 'false',
  TEJHQ_LICENSE_CONFIRMED: 'false',
  TEJHQ_HISTORICAL_FALLBACK_ENABLED: 'false',
  TEJHQ_ADJUSTED_HISTORY_ENABLED: 'false',
  TEJHQ_CORPORATE_ACTIONS_ENABLED: 'false',
  TEJHQ_INTERNAL_DAILY_REQUEST_BUDGET: '200',
};

test('Compose forwards market credentials and opt-in-only flags to API, never to worker or browser', () => {
  const compose = yaml('docker-compose.yml').services;
  const server = compose.server.environment;
  for (const key of variables) {
    assert.ok(server.includes(key + '=${' + key + ':-}'), 'missing API credential forwarding: ' + key);
    for (const service of ['agent-worker', 'reactapp', 'ml-service']) {
      const entries = compose[service].environment || [];
      assert.ok(!entries.some(item => item.startsWith(key + '=')), 'credential leaked to ' + service);
    }
  }
  for (const [name, fallback] of Object.entries(flags)) {
    assert.ok(server.includes(name + '=${' + name + ':-' + fallback + '}'),
      'market config must be explicit, disabled unless opted in: ' + name);
  }
});

test('Kind market config is fail-closed and provider secrets are optional server-only references', () => {
  const config = yaml('k8s/configmap.yaml').data;
  const server = yaml('k8s/server/deployment.yaml').spec.template.spec.containers
    .find(container => container.name === 'server');
  const worker = yaml('k8s/agent-worker/deployment.yaml').spec.template.spec.containers
    .find(container => container.name === 'agent-worker');
  for (const [name, value] of Object.entries(flags)) {
    assert.equal(config[name], value, 'unsafe market deployment default: ' + name);
  }
  assert.equal(config.LLM_DEFAULT_PROVIDER, 'mock', 'offline Kind demo must not select an external model implicitly');
  for (const key of variables) {
    assert.deepEqual(server.env.find(item => item.name === key)?.valueFrom?.secretKeyRef, {
      name: 'wealthgenie-secrets', key, optional: true,
    });
    assert.ok(!worker.env.some(item => item.name === key), 'market key must not reach AI worker');
  }
});
