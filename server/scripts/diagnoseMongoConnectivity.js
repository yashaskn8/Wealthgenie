import mongoose from 'mongoose';
import { fileURLToPath } from 'node:url';
import '../config/bootstrapEnvironment.js';
import { getMongoConnectionOptions } from '../config/mongoCompatibility.js';
import {
  assertMongoDatabaseIdentity,
  assertMongoTransactionCapability,
  classifyMongoConnectionFailure,
} from '../config/db.js';

function endpointType(uri) {
  try {
    const parsed = new URL(uri);
    if (!['mongodb:', 'mongodb+srv:'].includes(parsed.protocol)) return 'INVALID';
    if (['127.0.0.1', 'localhost'].includes(parsed.hostname)) return 'LOOPBACK';
    return parsed.protocol === 'mongodb+srv:' ? 'REMOTE_SRV' : 'REMOTE';
  } catch { return 'INVALID'; }
}

/** Ping and inspect identity only; never create collections or change network access. */
export async function diagnoseMongoConnectivity({ env = process.env, createConnection = mongoose.createConnection } = {}) {
  const uri = env.MONGODB_URI;
  const expectedDatabase = env.MONGODB_EXPECTED_DATABASE;
  const target = endpointType(uri);
  if (target === 'INVALID') {
    return { status: 'UNAVAILABLE', code: 'MONGODB_URI_INVALID', endpointType: target };
  }
  if (!expectedDatabase) {
    return { status: 'UNAVAILABLE', code: 'MONGODB_EXPECTED_DATABASE_REQUIRED', endpointType: target };
  }
  let connection;
  try {
    // Use the same compatibility options and database pin as the backend.
    connection = createConnection(uri, getMongoConnectionOptions(env, {
      dbName: expectedDatabase, autoIndex: false, serverSelectionTimeoutMS: 5000,
    }));
    await connection.asPromise();
    assertMongoDatabaseIdentity({ connection }, expectedDatabase);
    const replicaSet = await assertMongoTransactionCapability({ connection });
    await connection.db.admin().ping();
    return {
      status: 'READY', code: null, endpointType: target,
      database: expectedDatabase, replicaSet, readOnly: true,
    };
  } catch (error) {
    const failure = classifyMongoConnectionFailure(error);
    return { status: 'UNAVAILABLE', code: failure.code, endpointType: target, message: failure.message };
  } finally {
    if (connection) await connection.close().catch(() => {});
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = await diagnoseMongoConnectivity();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== 'READY') process.exitCode = 1;
}
