import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const read = relative => parse(readFileSync(new URL('../../' + relative, import.meta.url), 'utf8'));
const MARKET_KEYS = ['UPSTOX_ANALYTICS_TOKEN', 'UPSTOX_ACCESS_TOKEN', 'TEJHQ_API_KEY'];
const LLM_KEYS = ['GEMINI_API_KEY', 'GROQ_API_KEY', 'NVIDIA_API_KEY'];
const PRIVATE_KEYS = [...MARKET_KEYS, ...LLM_KEYS];
const OPTIONAL_SERVER_KEYS = [...MARKET_KEYS, 'GROQ_API_KEY', 'NVIDIA_API_KEY'];
const DISABLED = [
  'UPSTOX_PUBLIC_MARKET_DATA_LICENSE_CONFIRMED',
  'TEJHQ_ENABLED', 'TEJHQ_LICENSE_CONFIRMED',
  'TEJHQ_HISTORICAL_FALLBACK_ENABLED',
  'TEJHQ_ADJUSTED_HISTORY_ENABLED', 'TEJHQ_CORPORATE_ACTIONS_ENABLED',
];
const composeVariable = (key, fallback = '') => key + '=$' + '{' + key + ':-' + fallback + '}';

test('Compose forwards authorized provider settings only to the API server with rights disabled by default', () => {
  const compose = read('docker-compose.yml');
  const server = compose.services.server.environment;
  for (const key of PRIVATE_KEYS) {
    assert.ok(server.includes(composeVariable(key)), 'API server missing ' + key);
    assert.equal(
      compose.services['agent-worker'].environment.some(value => value.startsWith(key + '=')),
      false,
      'credential leaked to worker: ' + key,
    );
  }
  for (const key of MARKET_KEYS) {
    for (const service of ['reactapp', 'ml-service']) {
      const environment = compose.services[service].environment || [];
      assert.equal(
        environment.some(value => value.startsWith(key + '=')),
        false,
        'market credential leaked to ' + service + ': ' + key,
      );
    }
  }
  assert.ok(server.includes(composeVariable('MARKET_DATA_MODE', 'LEGACY')));
  assert.ok(server.includes(composeVariable('MARKET_DATA_PRIMARY_PROVIDER', 'NSE')));
  for (const key of DISABLED) assert.ok(server.includes(composeVariable(key, 'false')));
  assert.ok(server.includes(composeVariable('TEJHQ_INTERNAL_DAILY_REQUEST_BUDGET', '200')));
});

test('Kubernetes scopes provider and LLM secrets to the API server and preserves fail-closed defaults', () => {
  const config = read('k8s/configmap.yaml').data;
  assert.equal(config.MARKET_DATA_MODE, 'LEGACY');
  assert.equal(config.MARKET_DATA_PRIMARY_PROVIDER, 'NSE');
  for (const key of DISABLED) assert.equal(config[key], 'false', key);
  for (const key of PRIVATE_KEYS) {
    assert.equal(Object.hasOwn(config, key), false, 'sensitive key in ConfigMap: ' + key);
  }
  const server = read('k8s/server/deployment.yaml').spec.template.spec.containers[0].env;
  const worker = read('k8s/agent-worker/deployment.yaml').spec.template.spec.containers[0].env;
  for (const key of PRIVATE_KEYS) {
    const found = server.filter(entry => entry.name === key);
    assert.equal(found.length, 1, 'API server secret ref not unique: ' + key);
    assert.equal(found[0].valueFrom.secretKeyRef.name, 'wealthgenie-secrets');
    assert.equal(found[0].valueFrom.secretKeyRef.key, key);
    if (OPTIONAL_SERVER_KEYS.includes(key)) assert.equal(found[0].valueFrom.secretKeyRef.optional, true);
    assert.equal(worker.some(entry => entry.name === key), false, 'credential leaked to worker: ' + key);
  }
  const example = read('k8s/secrets.example.yaml');
  for (const key of PRIVATE_KEYS) assert.match(example.stringData[key], /^CHANGE_ME_/, key);
});
