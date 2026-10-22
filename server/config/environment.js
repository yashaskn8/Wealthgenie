import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ENV_FILE = path.join(SERVER_DIRECTORY, '.env');
const LOCAL_AUTHORITATIVE_KEYS = ['MONGODB_URI', 'MONGODB_EXPECTED_DATABASE', 'DATABASE_PASSWORD'];

function mongoUriError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Keep the database password outside the URI so reserved characters cannot
 * corrupt MongoDB connection-string parsing. DATABASE_PASSWORD is raw text;
 * this function percent-encodes it before inserting it into URI userinfo.
 */
export function buildMongoConnectionUri({ uri, databasePassword } = {}) {
  if (!databasePassword) return uri;

  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    throw mongoUriError('MONGODB_URI must be a valid MongoDB connection string.', 'MONGODB_URI_INVALID');
  }

  if (!['mongodb:', 'mongodb+srv:'].includes(parsed.protocol) || !parsed.username) {
    throw mongoUriError('MONGODB_URI must include a MongoDB scheme and database username.', 'MONGODB_URI_INVALID');
  }
  if (parsed.password) {
    throw mongoUriError(
      'Remove the password from MONGODB_URI when DATABASE_PASSWORD is configured.',
      'DATABASE_PASSWORD_URI_CONFLICT',
    );
  }

  const encodedPassword = encodeURIComponent(String(databasePassword))
    .replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  parsed.password = encodedPassword;
  return parsed.toString();
}

/**
 * Load the server-owned environment file independently of the shell's cwd.
 * Process environment remains authoritative in production. During local
 * development, only MongoDB identity settings are allowed to override an
 * inherited Windows User/Machine value, preventing accidental use of a stale
 * cluster or MongoDB's implicit `test` database.
 */
export function loadServerEnvironment({ env = process.env, envFilePath = DEFAULT_ENV_FILE, production } = {}) {
  let source;
  try {
    source = fs.readFileSync(envFilePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { loaded: false, envFilePath, overriddenKeys: [] };
    throw error;
  }

  const values = dotenv.parse(source);
  const isProduction = production ?? String(env.NODE_ENV ?? values.NODE_ENV ?? '').toLowerCase() === 'production';

  for (const [key, value] of Object.entries(values)) {
    if (env[key] === undefined) env[key] = value;
  }

  const overriddenKeys = [];
  if (!isProduction) {
    for (const key of LOCAL_AUTHORITATIVE_KEYS) {
      if (!Object.hasOwn(values, key)) continue;
      env[key] = values[key];
      overriddenKeys.push(key);
    }
  }

  return { loaded: true, envFilePath, overriddenKeys, production: isProduction };
}

export { DEFAULT_ENV_FILE };
