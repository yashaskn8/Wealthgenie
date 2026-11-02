import mongoose from 'mongoose';
import logger from '../utils/logger.js';
import { getMongoConnectionOptions } from './mongoCompatibility.js';

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 2000;

export function classifyMongoConnectionFailure(error) {
  const configurationFailures = {
    MONGODB_DATABASE_IDENTITY_MISMATCH: 'Connected MongoDB database does not match MONGODB_EXPECTED_DATABASE.',
    MONGODB_EXPECTED_DATABASE_INVALID: 'MONGODB_EXPECTED_DATABASE is invalid.',
    MONGODB_EXPECTED_DATABASE_PLACEHOLDER: 'MONGODB_EXPECTED_DATABASE is a placeholder, not a database identity.',
    MONGODB_TRANSACTIONS_REQUIRED: 'MongoDB replica-set transactions are required for application writes.',
  };
  if (Object.hasOwn(configurationFailures, error?.code)) {
    return { code: error.code, message: configurationFailures[error.code], retryable: false };
  }
  const serverErrors = error?.reason?.servers instanceof Map
    ? [...error.reason.servers.values()].map(server => server?.error).filter(Boolean)
    : [];
  const nestedCodes = [...new Set(serverErrors.map(server => server?.code || server?.cause?.code).filter(Boolean))];
  const code = String(error?.code || error?.cause?.code || (nestedCodes.length === 1 ? nestedCodes[0] : ''));
  const name = String(error?.codeName || '');
  const detail = String(error?.message || '');
  if (code === '18' || name === 'AuthenticationFailed' || /authentication failed|bad auth/i.test(detail)) {
    return { code: 'MONGODB_AUTHENTICATION_FAILED', message: 'MongoDB rejected the configured database credentials.', retryable: false };
  }
  if (['CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(code)
      || /certificate verify failed|certificate has expired|tlsv1 alert|ssl alert/i.test(detail)) {
    return { code: 'MONGODB_TLS_FAILED', message: 'MongoDB TLS negotiation or certificate verification failed.', retryable: false };
  }
  if (['ENOTFOUND', 'EAI_AGAIN', 'ESERVFAIL'].includes(code)
      || /querySrv ENOTFOUND|querySrv EAI_AGAIN|getaddrinfo ENOTFOUND/i.test(detail)) {
    return { code: 'MONGODB_DNS_UNAVAILABLE', message: 'MongoDB DNS lookup failed; check DNS and the configured cluster hostname.', retryable: true };
  }
  if (['ECONNREFUSED', 'ENETUNREACH', 'ETIMEDOUT'].includes(code)) {
    return { code: 'MONGODB_NETWORK_UNAVAILABLE', message: 'MongoDB network connection failed; check the listener, firewall and network route.', retryable: true };
  }
  if (error?.name === 'MongooseServerSelectionError' || error?.name === 'MongoServerSelectionError') {
    return { code: 'MONGODB_SERVER_SELECTION_FAILED', message: 'MongoDB server selection failed; check cluster health, network access, DNS and TLS separately.', retryable: true };
  }
  return { code: 'MONGODB_CONNECTION_FAILED', message: 'MongoDB connection failed; inspect the configured endpoint and service health.', retryable: true };
}

function safeMongoError(failure) {
  const error = new Error(failure.message);
  error.code = failure.code;
  return error;
}

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
  if (/^(?:EXISTING_DATABASE|YOUR_DATABASE|YOUR_DB_NAME|CHANGE_ME|REPLACE_ME)$/i.test(expectedDatabase)) {
    const error = new Error('MONGODB_EXPECTED_DATABASE is a placeholder, not a database identity.');
    error.code = 'MONGODB_EXPECTED_DATABASE_PLACEHOLDER';
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
      const failure = classifyMongoConnectionFailure(error);
      if (!failure.retryable) {
        await mongoose.disconnect();
        throw safeMongoError(failure);
      }
      if (attempt === retries) {
        logger.error('MongoDB connection failed after all retries', {
          attempts: retries,
          code: failure.code,
        });
        throw safeMongoError(failure);
      }
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      logger.warn('MongoDB connection attempt failed, retrying', {
        attempt,
        maxRetries: retries,
        nextRetryMs: delay,
        code: failure.code,
      });
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};

export default connectDB;
