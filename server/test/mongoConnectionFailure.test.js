import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import connectDB, { classifyMongoConnectionFailure } from '../config/db.js';

const secretUri = 'mongodb+srv://user:secret-password@example.invalid/wealthgenie';

test('Mongo connection diagnostics distinguish failure classes without leaking credentials', () => {
  const cases = [
    [{ code: 18, message: `Authentication failed for ${secretUri}` }, 'MONGODB_AUTHENTICATION_FAILED', false],
    [{ code: 'ENOTFOUND', message: `getaddrinfo ENOTFOUND ${secretUri}` }, 'MONGODB_DNS_UNAVAILABLE', true],
    [{ code: 'CERT_HAS_EXPIRED', message: `Certificate expired for ${secretUri}` }, 'MONGODB_TLS_FAILED', false],
    [{ code: 'ECONNREFUSED', message: `Connection refused at ${secretUri}` }, 'MONGODB_NETWORK_UNAVAILABLE', true],
    [{ name: 'MongooseServerSelectionError', message: `Timed out at ${secretUri}` }, 'MONGODB_SERVER_SELECTION_FAILED', true],
    [{ name: 'MongooseServerSelectionError', reason: { servers: new Map([['local', {
      error: { cause: { code: 'ECONNREFUSED' } },
    }]]) } }, 'MONGODB_NETWORK_UNAVAILABLE', true],
    [{ code: 'MONGODB_DATABASE_IDENTITY_MISMATCH', message: secretUri }, 'MONGODB_DATABASE_IDENTITY_MISMATCH', false],
    [{ code: 'MONGODB_EXPECTED_DATABASE_INVALID', message: secretUri }, 'MONGODB_EXPECTED_DATABASE_INVALID', false],
    [{ code: 'MONGODB_TRANSACTIONS_REQUIRED', message: secretUri }, 'MONGODB_TRANSACTIONS_REQUIRED', false],
  ];
  for (const [error, code, retryable] of cases) {
    const result = classifyMongoConnectionFailure(error);
    assert.equal(result.code, code);
    assert.equal(result.retryable, retryable);
    assert.doesNotMatch(result.message, /secret-password|mongodb\+srv:\/\//);
  }
});

test('authentication failure stops retrying and never rethrows the driver URI', async () => {
  const originalConnect = mongoose.connect;
  const originalDisconnect = mongoose.disconnect;
  let attempts = 0;
  mongoose.connect = async () => {
    attempts += 1;
    throw Object.assign(new Error(`bad auth: ${secretUri}`), { code: 18 });
  };
  mongoose.disconnect = async () => {};
  try {
    await assert.rejects(connectDB({
      uri: secretUri, retries: 5, env: { MONGODB_FLAVOR: 'mongodb' },
    }), error => error.code === 'MONGODB_AUTHENTICATION_FAILED'
      && !error.message.includes('secret-password'));
    assert.equal(attempts, 1);
  } finally {
    mongoose.connect = originalConnect;
    mongoose.disconnect = originalDisconnect;
  }
});
