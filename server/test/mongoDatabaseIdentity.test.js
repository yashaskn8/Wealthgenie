import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import connectDB, { assertMongoDatabaseIdentity } from '../config/db.js';

test('explicit MongoDB identity guard refuses a different account database', () => {
  const connected = { connection: { db: { databaseName: 'wealthgenie' } } };
  assert.equal(assertMongoDatabaseIdentity(connected, 'wealthgenie'), 'wealthgenie');
  assert.equal(assertMongoDatabaseIdentity(connected), null);
  assert.throws(
    () => assertMongoDatabaseIdentity(connected, 'wealthgenie-demo'),
    error => error.code === 'MONGODB_DATABASE_IDENTITY_MISMATCH'
      && !error.message.includes('mongodb://'),
  );
  assert.throws(
    () => assertMongoDatabaseIdentity({ connection: { db: { databaseName: 'test' } } }, 'wealthgenie'),
    error => error.code === 'MONGODB_DATABASE_IDENTITY_MISMATCH',
  );
});

test('invalid database pin is rejected with no connection details leaked', () => {
  for (const candidate of [' ', '../admin', 'wealthgenie.test', '/admin', 'a'.repeat(64), 1234]) {
    assert.throws(
      () => assertMongoDatabaseIdentity(null, candidate),
      error => error.code === 'MONGODB_EXPECTED_DATABASE_INVALID'
        && !error.message.includes('mongodb://'),
    );
  }
});


test('connection explicitly selects the pinned database instead of the driver default', async () => {
  const originalConnect = mongoose.connect;
  let observedOptions;
  mongoose.connect = async (_uri, options) => {
    observedOptions = options;
    return {
      connection: {
        host: 'unit-test',
        db: {
          databaseName: options.dbName,
          admin: () => ({ command: async () => ({ setName: 'rs0' }) }),
        },
      },
    };
  };

  try {
    await connectDB({
      uri: 'mongodb+srv://unit.test.invalid',
      retries: 1,
      env: { MONGODB_FLAVOR: 'mongodb', MONGODB_EXPECTED_DATABASE: 'wealthgenie_expo' },
      options: { dbName: 'wrong-database' },
    });
    assert.equal(observedOptions.dbName, 'wealthgenie_expo');
  } finally {
    mongoose.connect = originalConnect;
  }
});
