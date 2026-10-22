import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadServerEnvironment } from '../config/bootstrapEnvironment.js';

test('development server env overrides stale inherited MongoDB identity only', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wealthgenie-env-'));
  const projectEnvFilePath = path.join(directory, '.env');
  const serverDirectory = path.join(directory, 'server');
  const serverEnvFilePath = path.join(serverDirectory, '.env');
  await fs.mkdir(serverDirectory);

  try {
    await fs.writeFile(projectEnvFilePath, [
      'NODE_ENV=development',
      'MONGODB_URI=mongodb://root-file.invalid/rootdb',
      'PROJECT_ONLY=project-value',
      '',
    ].join('\n'));
    await fs.writeFile(serverEnvFilePath, [
      'NODE_ENV=development',
      'MONGODB_URI=mongodb+srv://server-file.invalid/wealthgenie_expo',
      'MONGODB_EXPECTED_DATABASE=wealthgenie_expo',
      'SERVER_ONLY=server-value',
      '',
    ].join('\n'));

    const env = {
      MONGODB_URI: 'mongodb://inherited-stale.invalid/stale',
      MONGODB_EXPECTED_DATABASE: 'stale',
      JWT_SECRET: 'process-value',
    };

    const result = loadServerEnvironment({ env, projectEnvFilePath, serverEnvFilePath });

    assert.equal(env.MONGODB_URI, 'mongodb+srv://server-file.invalid/wealthgenie_expo');
    assert.equal(env.MONGODB_EXPECTED_DATABASE, 'wealthgenie_expo');
    assert.equal(env.JWT_SECRET, 'process-value');
    assert.equal(env.PROJECT_ONLY, 'project-value');
    assert.equal(env.SERVER_ONLY, 'server-value');
    assert.deepEqual(result.overriddenKeys, ['MONGODB_URI', 'MONGODB_EXPECTED_DATABASE']);
    assert.equal(result.production, false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('production process MongoDB settings stay authoritative over local env files', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wealthgenie-env-'));
  const projectEnvFilePath = path.join(directory, '.env');
  const serverDirectory = path.join(directory, 'server');
  const serverEnvFilePath = path.join(serverDirectory, '.env');
  await fs.mkdir(serverDirectory);

  try {
    await fs.writeFile(projectEnvFilePath, 'MONGODB_URI=mongodb://root-file.invalid/rootdb\n');
    await fs.writeFile(serverEnvFilePath, [
      'MONGODB_URI=mongodb+srv://server-file.invalid/wealthgenie_expo',
      'MONGODB_EXPECTED_DATABASE=wealthgenie_expo',
      '',
    ].join('\n'));

    const env = {
      NODE_ENV: 'production',
      MONGODB_URI: 'mongodb://deployment.invalid/wealthgenie',
      MONGODB_EXPECTED_DATABASE: 'wealthgenie',
    };

    const result = loadServerEnvironment({ env, projectEnvFilePath, serverEnvFilePath });

    assert.equal(env.MONGODB_URI, 'mongodb://deployment.invalid/wealthgenie');
    assert.equal(env.MONGODB_EXPECTED_DATABASE, 'wealthgenie');
    assert.deepEqual(result.overriddenKeys, []);
    assert.equal(result.production, true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
test('project production mode prevents local MongoDB overrides when process mode is unset', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wealthgenie-env-'));
  const projectEnvFilePath = path.join(directory, '.env');
  const serverDirectory = path.join(directory, 'server');
  const serverEnvFilePath = path.join(serverDirectory, '.env');
  await fs.mkdir(serverDirectory);

  try {
    await fs.writeFile(projectEnvFilePath, 'NODE_ENV=production\n');
    await fs.writeFile(serverEnvFilePath, [
      'NODE_ENV=development',
      'MONGODB_URI=mongodb+srv://server-file.invalid/wealthgenie_expo',
      'MONGODB_EXPECTED_DATABASE=wealthgenie_expo',
      '',
    ].join('\n'));

    const env = {
      MONGODB_URI: 'mongodb://inherited-stale.invalid/stale',
      MONGODB_EXPECTED_DATABASE: 'stale',
    };

    const result = loadServerEnvironment({ env, projectEnvFilePath, serverEnvFilePath });

    assert.equal(env.NODE_ENV, 'production');
    assert.equal(env.MONGODB_URI, 'mongodb://inherited-stale.invalid/stale');
    assert.equal(env.MONGODB_EXPECTED_DATABASE, 'stale');
    assert.deepEqual(result.overriddenKeys, []);
    assert.equal(result.production, true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});