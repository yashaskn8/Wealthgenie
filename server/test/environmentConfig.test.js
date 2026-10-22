import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildMongoConnectionUri, loadServerEnvironment } from '../config/environment.js';

function withEnvironmentFile(source, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wealthgenie-env-'));
  const envFilePath = path.join(directory, '.env');
  fs.writeFileSync(envFilePath, source, 'utf8');
  try {
    callback(envFilePath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('local backend uses server .env MongoDB identity over inherited process values', () => {
  withEnvironmentFile([
    'MONGODB_URI=mongodb://127.0.0.1:27017/wealthgenie?replicaSet=rs0',
    'MONGODB_EXPECTED_DATABASE=wealthgenie',
    'DATABASE_PASSWORD=file-password',
    'OTHER_SETTING=file-value',
  ].join('\n'), envFilePath => {
    const env = {
      NODE_ENV: 'development',
      MONGODB_URI: 'mongodb://stale.example.test:27017/old-db',
      MONGODB_EXPECTED_DATABASE: 'old-db',
      DATABASE_PASSWORD: 'stale-password',
      OTHER_SETTING: 'process-value',
    };

    const result = loadServerEnvironment({ env, envFilePath });

    assert.equal(result.loaded, true);
    assert.deepEqual(result.overriddenKeys, ['MONGODB_URI', 'MONGODB_EXPECTED_DATABASE', 'DATABASE_PASSWORD']);
    assert.equal(env.MONGODB_URI, 'mongodb://127.0.0.1:27017/wealthgenie?replicaSet=rs0');
    assert.equal(env.MONGODB_EXPECTED_DATABASE, 'wealthgenie');
    assert.equal(env.DATABASE_PASSWORD, 'file-password');
    assert.equal(env.OTHER_SETTING, 'process-value');
  });
});

test('database password is safely encoded into a password-free MongoDB URI', async () => {
  const { MongoClient } = await import('mongodb');
  const password = "safe@:/?#%!'()*";
  const uri = buildMongoConnectionUri({
    uri: 'mongodb+srv://wealthgenie_user@cluster.example/?retryWrites=true&w=majority',
    databasePassword: password,
  });
  const client = new MongoClient(uri);
  assert.equal(client.options.credentials.username, 'wealthgenie_user');
  assert.equal(client.options.credentials.password, password);
  assert.equal(uri.includes(password), false);
  await client.close();
});

test('separate database password rejects an already password-bearing URI', () => {
  assert.throws(
    () => buildMongoConnectionUri({
      uri: 'mongodb+srv://wealthgenie_user:embedded@cluster.example/',
      databasePassword: 'separate',
    }),
    error => error.code === 'DATABASE_PASSWORD_URI_CONFLICT'
      && !error.message.includes('embedded')
      && !error.message.includes('separate'),
  );
});

test('invalid MongoDB URI is rejected without exposing its contents', () => {
  const secretLikeValue = 'not-a-uri-private-value';
  assert.throws(
    () => buildMongoConnectionUri({ uri: secretLikeValue, databasePassword: 'private-password' }),
    error => error.code === 'MONGODB_URI_INVALID'
      && !error.message.includes(secretLikeValue)
      && !error.message.includes('private-password'),
  );
});

test('server environment loading follows dotenv duplicate-key selection', () => {
  withEnvironmentFile([
    'MONGODB_URI=mongodb://127.0.0.1:27017/obsolete?replicaSet=rs0',
    'MONGODB_URI=mongodb://127.0.0.1:27017/wealthgenie?replicaSet=rs0',
    'MONGODB_EXPECTED_DATABASE=wealthgenie',
  ].join('\n'), envFilePath => {
    const env = { NODE_ENV: 'development', MONGODB_URI: 'mongodb://inherited.example.test/test' };
    loadServerEnvironment({ env, envFilePath });
    assert.equal(env.MONGODB_URI, 'mongodb://127.0.0.1:27017/wealthgenie?replicaSet=rs0');
  });
});

test('production process values remain authoritative while missing values load from server .env', () => {
  withEnvironmentFile([
    'NODE_ENV=production',
    'MONGODB_URI=mongodb://127.0.0.1:27017/wealthgenie?replicaSet=rs0',
    'MONGODB_EXPECTED_DATABASE=wealthgenie',
    'OTHER_SETTING=file-value',
  ].join('\n'), envFilePath => {
    const env = {
      NODE_ENV: 'production',
      MONGODB_URI: 'mongodb://deployment.example.test:27017/wealthgenie',
      OTHER_SETTING: 'process-value',
    };

    const result = loadServerEnvironment({ env, envFilePath });

    assert.deepEqual(result.overriddenKeys, []);
    assert.equal(env.MONGODB_URI, 'mongodb://deployment.example.test:27017/wealthgenie');
    assert.equal(env.MONGODB_EXPECTED_DATABASE, 'wealthgenie');
    assert.equal(env.OTHER_SETTING, 'process-value');
  });
});
