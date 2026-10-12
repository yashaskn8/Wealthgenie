import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';

export const ISOLATED_MONGO_DATABASE_PREFIX = 'wealthgenie_genieproof_e2e_';
const ISOLATED_MONGO_DATABASE_SUFFIX_BYTES = 16;
const ISOLATED_MONGO_DATABASE_PATTERN = /^wealthgenie_genieproof_e2e_[a-f0-9]{32}$/;
const SAFE_MONGO_DATABASE_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const ownedDatabases = new WeakSet();

export function isSafeMongoDatabaseName(databaseName) {
  return typeof databaseName === 'string'
    && Buffer.byteLength(databaseName, 'utf8') > 0
    && Buffer.byteLength(databaseName, 'utf8') <= 63
    && SAFE_MONGO_DATABASE_NAME_PATTERN.test(databaseName);
}

export function createIsolatedMongoDatabaseOwnership() {
  const suffix = crypto.randomBytes(ISOLATED_MONGO_DATABASE_SUFFIX_BYTES).toString('hex');
  const databaseName = `${ISOLATED_MONGO_DATABASE_PREFIX}${suffix}`;
  if (!isSafeMongoDatabaseName(databaseName) || !ISOLATED_MONGO_DATABASE_PATTERN.test(databaseName)) {
    throw new Error('Generated Mongo test database name is invalid.');
  }

  const ownership = Object.freeze({ databaseName });
  ownedDatabases.add(ownership);
  return ownership;
}

export function createLoopbackMongoTestUri(baseMongoUri, ownership) {
  if (!ownedDatabases.has(ownership)) {
    throw new Error('A test-owned Mongo database is required to build the isolated URI.');
  }

  let configuredUri;
  try {
    configuredUri = new URL(baseMongoUri);
  } catch {
    throw new Error('The CI MongoDB URI must be a valid loopback replica-set URI.');
  }

  if (configuredUri.protocol !== 'mongodb:'
      || configuredUri.hostname !== '127.0.0.1'
      || configuredUri.port !== '27017'
      || configuredUri.username
      || configuredUri.password
      || configuredUri.searchParams.get('replicaSet') !== 'rs0') {
    throw new Error('The CI MongoDB URI must target the unauthenticated 127.0.0.1:27017 rs0 service.');
  }

  configuredUri.pathname = `/${ownership.databaseName}`;
  return configuredUri.toString();
}

export async function dropOwnedMongoTestDatabase({ connection, ownership }) {
  if (!ownedDatabases.has(ownership)
      || !ISOLATED_MONGO_DATABASE_PATTERN.test(ownership.databaseName)
      || !isSafeMongoDatabaseName(ownership.databaseName)
      || connection?.db?.databaseName !== ownership.databaseName
      || typeof connection?.dropDatabase !== 'function') {
    return false;
  }

  await connection.dropDatabase();
  ownedDatabases.delete(ownership);
  return true;
}
