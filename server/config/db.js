import mongoose from 'mongoose';
import logger from '../utils/logger.js';
import { getMongoConnectionOptions } from './mongoCompatibility.js';

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 2000;

// Explicit opt-in pin for persistent accounts. Never silently accept the
// wrong default database after a restart or a deployment credential change.
export function assertMongoDatabaseIdentity(connection, expectedDatabase) {
  if (expectedDatabase === undefined || expectedDatabase === null || expectedDatabase === '') return null;
  if (typeof expectedDatabase !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(expectedDatabase)) {
    const error = new Error('MONGODB_EXPECTED_DATABASE must name a single valid MongoDB database.');
    error.code = 'MONGODB_EXPECTED_DATABASE_INVALID';
    throw error;
  }
  const actualDatabase = connection?.connection?.db?.databaseName;
  if (actualDatabase !== expectedDatabase) {
    const error = new Error('Connected MongoDB database does not match MONGODB_EXPECTED_DATABASE. Startup refused to protect account records.');
    error.code = 'MONGODB_DATABASE_IDENTITY_MISMATCH';
    throw error;
  }
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
  // Reject invalid expected-name configuration before any network I/O.
  const expectedDatabase = env.MONGODB_EXPECTED_DATABASE;
  if (expectedDatabase !== undefined && expectedDatabase !== '') {
    assertMongoDatabaseIdentity({ connection: { db: { databaseName: expectedDatabase } } }, expectedDatabase);
  }
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const connectionOptions = getMongoConnectionOptions(env, {
        ...options,
        ...(expectedDatabase ? { dbName: expectedDatabase } : {}),
      });
      const conn = await mongoose.connect(uri, connectionOptions);
      // Fail closed on a database switch before authentication routes can
      // claim that an existing account is missing.
      assertMongoDatabaseIdentity(conn, expectedDatabase);
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
