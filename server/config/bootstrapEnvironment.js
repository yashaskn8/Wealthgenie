import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIRECTORY = path.resolve(CONFIG_DIRECTORY, '..');
const PROJECT_ENV_FILE = path.resolve(SERVER_DIRECTORY, '..', '.env');
const SERVER_ENV_FILE = path.join(SERVER_DIRECTORY, '.env');
const LOCAL_AUTHORITATIVE_KEYS = ['MONGODB_URI', 'MONGODB_EXPECTED_DATABASE'];

function readEnvironmentFile(filePath) {
  try {
    return dotenv.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

/**
 * Load project defaults, then server defaults. Local development gives the
 * server-owned MongoDB URI/database pin precedence over inherited Windows
 * environment values. Production keeps process environment authoritative.
 */
export function loadServerEnvironment({
  env = process.env,
  projectEnvFilePath = PROJECT_ENV_FILE,
  serverEnvFilePath = SERVER_ENV_FILE,
  production,
} = {}) {
  const projectValues = readEnvironmentFile(projectEnvFilePath);
  const serverValues = readEnvironmentFile(serverEnvFilePath);
  const inheritedNodeEnv = env.NODE_ENV;

  for (const values of [projectValues, serverValues]) {
    for (const [key, value] of Object.entries(values)) {
      if (env[key] === undefined) env[key] = value;
    }
  }

  const configuredNodeEnv = inheritedNodeEnv ?? env.NODE_ENV;
  const isProduction = production
    ?? String(configuredNodeEnv ?? '').toLowerCase() === 'production';
  const overriddenKeys = [];

  if (!isProduction) {
    for (const key of LOCAL_AUTHORITATIVE_KEYS) {
      if (!Object.hasOwn(serverValues, key)) continue;
      env[key] = serverValues[key];
      overriddenKeys.push(key);
    }
  }

  return {
    loaded: Object.keys(projectValues).length > 0 || Object.keys(serverValues).length > 0,
    overriddenKeys,
    production: isProduction,
  };
}

loadServerEnvironment();