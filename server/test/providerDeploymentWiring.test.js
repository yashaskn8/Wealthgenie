import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const read = relative => parse(readFileSync(new URL('../../' + relative, import.meta.url), 'utf8'));
const MARKET_KEYS = ['UPSTOX_ANALYTICS_TOKEN', 'UPSTOX_ACCESS_TOKEN', 'TEJHQ_API_KEY'];
const LLM_KEYS = ['GROQ_API_KEY', 'NVIDIA_API_KEY'];
const DISABLED = [
  'UPSTOX_PUBLIC_MARKET_DATA_LICENSE_CONFIRMED',
  'TEJHQ_ENABLED', 'TEJHQ_LICENSE_CONFIRMED',
  'TEJHQ_HISTORICAL_FALLBACK_ENABLED',
  'TEJHQ_ADJUSTED_HISTORY_ENABLED', 'TEJHQ_CORPORATE_ACTIONS_ENABLED',
];
const composeVariable = (key, fallback = '') => key + '=$' + '{' + key + ':-' + fallback + '}';

test('Compose forwards provider settings without granting default market permissions', () => {
  const compose = read('docker-compose.yml');
  const server = compose.services.server.environment;
  const worker = compose.services['agent-worker'].environment;
  for (const key of [...MARKET_KEYS, ...LLM_KEYS]) {
    assert.ok(server.includes(composeVariable(key)), 'server missing ' + key);
  }
  for (const key of [...LLM_KEYS, 'GEMINI_API_KEY']) {
    assert.ok(worker.includes(composeVariable(key)), 'worker missing ' + key);
  }
  assert.ok(server.includes(composeVariable('MARKET_DATA_MODE', 'LEGACY')));
  assert.ok(server.includes(composeVariable('MARKET_DATA_PRIMARY_PROVIDER', 'NSE')));
  for (const key of DISABLED) assert.ok(server.includes(composeVariable(key, 'false')));
  assert.ok(server.includes(composeVariable('TEJHQ_INTERNAL_DAILY_REQUEST_BUDGET', '200')));
});

test('Kubernetes injects optional provider secrets only into backend and worker', () => {
  const config = read('k8s/configmap.yaml').data;
  assert.equal(config.MARKET_DATA_MODE, 'LEGACY');
  assert.equal(config.MARKET_DATA_PRIMARY_PROVIDER, 'NSE');
  for (const key of DISABLED) assert.equal(config[key], 'false', key);
  for (const key of [...MARKET_KEYS, ...LLM_KEYS, 'GEMINI_API_KEY']) {
    assert.equal(Object.hasOwn(config, key), false, 'sensitive key in ConfigMap: ' + key);
  }
  const server = read('k8s/server/deployment.yaml').spec.template.spec.containers[0].env;
  const worker = read('k8s/agent-worker/deployment.yaml').spec.template.spec.containers[0].env;
  for (const [env, keys] of [[server, [...MARKET_KEYS, ...LLM_KEYS]], [worker, [...LLM_KEYS, 'GEMINI_API_KEY']]]) {
    for (const key of keys) {
      const found = env.filter(entry => entry.name === key);
      assert.equal(found.length, 1, 'secret ref not unique: ' + key);
      assert.deepEqual(found[0].valueFrom.secretKeyRef, { name: 'wealthgenie-secrets', key, optional: true });
    }
  }
  const example = read('k8s/secrets.example.yaml');
  for (const key of [...MARKET_KEYS, ...LLM_KEYS]) {
    assert.match(example.stringData[key], /^CHANGE_ME_/, key);
  }
});
