import mongoose from 'mongoose';
import { pathToFileURL } from 'node:url';
import { getMongoConnectionOptions } from '../config/mongoCompatibility.js';
import { isSupportedBcryptHash } from '../services/loginPassword.js';

// Local operator-only, read-only account diagnosis. NEVER send a password.
// Output excludes email, Mongo URI, account ID and password hash.
export function normalizeAuditEmail(value) {
  if (typeof value !== 'string') throw new TypeError('An audit email is required.');
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new TypeError('A valid audit email is required.');
  }
  return email;
}

export function summarizeAccountPersistence({ databaseName, expectedDatabase, usersCollectionExists, user }) {
  return {
    databaseName: typeof databaseName === 'string' ? databaseName : null,
    expectedDatabaseMatches: expectedDatabase ? databaseName === expectedDatabase : null,
    usersCollectionExists: usersCollectionExists === true,
    accountPresent: Boolean(user),
    passwordHashFormatValid: user ? isSupportedBcryptHash(user.passwordHash) : null,
    // Account creation time is intentionally omitted from operator output.
  };
}

export async function diagnoseAccountPersistence({ env = process.env, connect = (uri, options) => mongoose.createConnection(uri, options).asPromise() } = {}) {
  const email = normalizeAuditEmail(env.WG_ACCOUNT_DIAGNOSTIC_EMAIL);
  if (env.NODE_ENV === 'production') {
    throw new Error('Production account diagnostics require a separately authorized, audited administrative workflow.');
  }
  if (!env.MONGODB_URI) throw new Error('MONGODB_URI must be explicitly supplied from the running backend configuration.');
  const connection = await connect(env.MONGODB_URI, {
    ...getMongoConnectionOptions(env), autoIndex: false, autoCreate: false,
    serverSelectionTimeoutMS: 5000,
  });
  try {
    const databaseName = connection.db?.databaseName;
    const collections = await connection.db.listCollections({ name: 'users' }, { nameOnly: true }).toArray();
    const exists = collections.some(collection => collection.name === 'users');
    const user = exists ? await connection.db.collection('users').findOne(
      { email }, { projection: { passwordHash: 1, _id: 0 } }) : null;
    return summarizeAccountPersistence({
      databaseName, expectedDatabase: env.MONGODB_EXPECTED_DATABASE, usersCollectionExists: exists, user,
    });
  } finally {
    await connection.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  diagnoseAccountPersistence().then(result => {
    process.stdout.write(JSON.stringify(result) + '\n');
    if (result.expectedDatabaseMatches === false) process.exitCode = 2;
  }).catch(error => {
    // Do not log URI, user identifiers, passwords, or driver error payloads.
    process.stderr.write('Account read-only diagnostic unavailable: ' + (error?.code || 'CONFIG_OR_CONNECTIVITY_ERROR') + '\n');
    process.exitCode = 1;
  });
}
