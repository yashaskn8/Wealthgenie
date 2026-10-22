import mongoose from 'mongoose';
import logger from '../utils/logger.js';
import { getMongoConnectionOptions } from './mongoCompatibility.js';
import { buildMongoConnectionUri } from './environment.js';

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 2000;
const DATABASE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;

function invalidExpectedDatabaseError() {
  const error = new Error('MONGODB_EXPECTED_DATABASE must name a single valid MongoDB database.');
  error.code = 'MONGODB_EXPECTED_DATABASE_INVALID';
  return error;
}

function databaseIdentityMismatchError() {
  const error = new Error('MongoDB database settings disagree. Startup refused to protect account records.');
  error.code = 'MONGODB_DATABASE_IDENTITY_MISMATCH';
  return error;
}

function getDatabaseNameFromUri(uri) {
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    const error = new Error('MONGODB_URI must be a valid MongoDB connection string.');
    error.code = 'MONGODB_URI_INVALID';
    throw error;
  }

  if (!['mongodb:', 'mongodb+srv:'].includes(parsed.protocol)) {
    const error = new Error('MONGODB_URI must use mongodb:// or mongodb+srv://.');
    error.code = 'MONGODB_URI_INVALID';
    throw error;
  }

  const encodedName = parsed.pathname.replace(/^\/+/, '').split('/')[0];
  if (!encodedName) return null;

  try {
    return decodeURIComponent(encodedName);
  } catch {
    const error = new Error('MONGODB_URI contains an invalid database name.');
    error.code = 'MONGODB_URI_INVALID';
    throw error;
  }
}

function validateDatabaseName(databaseName) {
  return typeof databaseName === 'string' && DATABASE_NAME_PATTERN.test(databaseName);
}

export function resolveMongoDatabaseIdentity({ uri, expectedDatabase, optionDatabase } = {}) {
  if (expectedDatabase !== undefined && expectedDatabase !== null && expectedDatabase !== ''
      && !validateDatabaseName(expectedDatabase)) {
    throw invalidExpectedDatabaseError();
  }
  if (optionDatabase !== undefined && optionDatabase !== null && optionDatabase !== ''
      && !validateDatabaseName(optionDatabase)) {
    const error = new Error('Mongoose dbName must name a single valid MongoDB database.');
    error.code = 'MONGODB_DBNAME_INVALID';
    throw error;
  }

  const uriDatabase = getDatabaseNameFromUri(uri);
  if (uriDatabase && !validateDatabaseName(uriDatabase)) {
    const error = new Error('MONGODB_URI contains an invalid database name.');
    error.code = 'MONGODB_URI_INVALID';
    throw error;
  }
  const configuredNames = [uriDatabase, optionDatabase, expectedDatabase]
    .filter(name => name !== undefined && name !== null && name !== '');
  const uniqueNames = new Set(configuredNames);
  if (uniqueNames.size > 1) throw databaseIdentityMismatchError();
  if (uniqueNames.size === 0) {
    const error = new Error('MongoDB database identity is not configured. Add a database name to MONGODB_URI, set MONGODB_EXPECTED_DATABASE, or provide Mongoose dbName. Startup refused to prevent writes to the driver default database.');
    error.code = 'MONGODB_DATABASE_IDENTITY_REQUIRED';
    throw error;
  }
  return configuredNames[0];
}

// Explicit opt-in pin for persistent accounts. Never silently accept the
// wrong default database after a restart or a deployment credential change.
export function assertMongoDatabaseIdentity(connection, expectedDatabase) {
  if (expectedDatabase === undefined || expectedDatabase === null || expectedDatabase === '') return null;
  if (!validateDatabaseName(expectedDatabase)) throw invalidExpectedDatabaseError();
  const actualDatabase = connection?.connection?.db?.databaseName;
  if (actualDatabase !== expectedDatabase) throw databaseIdentityMismatchError();
  return actualDatabase;
}

export async function assertMongoTransactionCapability(conn) {
  const hello = await conn.connection.db.admin().command({ hello: 1 });
  if (!hello.setName) {
    const error = new Error(
      'MongoDB must be a replica set because advisory and goal writes require transactions.',
    );
    error.code = 'MONGODB_TRANSACTIONS_REQUIRED';
    throw error;
  }
  return hello.setName;
}

const connectDB = async ({
  uri = process.env.MONGODB_URI,
  retries = MAX_RETRIES,
  options = {},
  env = process.env,
  // Advisory/profile completion and goal writes are transaction-dependent in
  // every environment. Starting against a standalone MongoDB would make the
  // service look healthy and defer the failure until the first user save.
  requireTransactions = true,
} = {}) => {
  const connectionUri = buildMongoConnectionUri({ uri, databasePassword: env.DATABASE_PASSWORD });
  // Reject invalid expected-name configuration before any network I/O.
  const expectedDatabase = env.MONGODB_EXPECTED_DATABASE;
  if (expectedDatabase !== undefined && expectedDatabase !== '') {
    assertMongoDatabaseIdentity({ connection: { db: { databaseName: expectedDatabase } } }, expectedDatabase);
  }
  const databaseName = resolveMongoDatabaseIdentity({
    uri: connectionUri,
    expectedDatabase,
    optionDatabase: options.dbName,
  });
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const conn = await mongoose.connect(connectionUri, getMongoConnectionOptions(env, {
        ...options,
        dbName: databaseName,
        // Do not let Mongoose create collections/indexes before the connected
        // database identity and transaction capability have been verified.
        // Deployment migrations own index DDL; startup readiness checks are read-only.
        autoCreate: false,
        autoIndex: false,
      }));
      // Fail closed on a database switch before authentication routes can
      // claim that an existing account is missing.
      assertMongoDatabaseIdentity(conn, databaseName);
      if (requireTransactions) await assertMongoTransactionCapability(conn);
      logger.info('MongoDB connected', {
        host: conn.connection.host,
        databaseName: conn.connection.db?.databaseName,
      });
      return conn;
    } catch (error) {
      if (error.code === 'MONGODB_DATABASE_IDENTITY_MISMATCH') {
        await mongoose.disconnect();
        throw error;
      }
      if (attempt === retries) {
        logger.error('MongoDB connection failed after all retries', {
          attempts: retries,
          message: error.message,
        });
        throw error;
      }
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      logger.warn('MongoDB connection attempt failed, retrying', {
        attempt,
        maxRetries: retries,
        nextRetryMs: delay,
        message: error.message,
      });
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};

export default connectDB;
