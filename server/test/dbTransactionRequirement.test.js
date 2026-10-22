import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import connectDB, { assertMongoTransactionCapability } from '../config/db.js';

function connectionReturning(hello, databaseName = 'wealthgenie') {
  return {
    connection: {
      host: '127.0.0.1',
      db: {
        databaseName,
        admin: () => ({ command: async () => hello }),
      },
    },
  };
}

test('production transaction capability accepts a MongoDB replica set', async () => {
  assert.equal(await assertMongoTransactionCapability(connectionReturning({ setName: 'rs0' })), 'rs0');
});

test('production transaction capability rejects standalone MongoDB', async () => {
  await assert.rejects(
    assertMongoTransactionCapability(connectionReturning({ isWritablePrimary: true })),
    error => error.code === 'MONGODB_TRANSACTIONS_REQUIRED'
      && /replica set.*transactions/i.test(error.message),
  );
});

test('database connection rejects standalone MongoDB by default in every environment', async () => {
  const originalConnect = mongoose.connect;
  mongoose.connect = async () => connectionReturning({ isWritablePrimary: true });

  try {
    await assert.rejects(
      connectDB({
        uri: 'mongodb://127.0.0.1:27017/wealthgenie',
        retries: 1,
        env: { MONGODB_FLAVOR: 'mongodb' },
      }),
      error => error.code === 'MONGODB_TRANSACTIONS_REQUIRED',
    );
  } finally {
    mongoose.connect = originalConnect;
  }
});

test('database connection pins the URI database in Mongoose options before writes', async () => {
  const originalConnect = mongoose.connect;
  let capturedOptions;
  mongoose.connect = async (_uri, options) => {
    capturedOptions = options;
    return connectionReturning({ setName: 'rs0' }, 'wealthgenie');
  };

  try {
    await connectDB({
      uri: 'mongodb://127.0.0.1:27017/wealthgenie',
      retries: 1,
      env: { MONGODB_FLAVOR: 'mongodb' },
      options: { autoCreate: true, autoIndex: true },
    });
    assert.equal(capturedOptions.dbName, 'wealthgenie');
    assert.equal(capturedOptions.autoCreate, false);
    assert.equal(capturedOptions.autoIndex, false);
  } finally {
    mongoose.connect = originalConnect;
  }
});

test('database connection uses the explicit expected database when the URI has no path', async () => {
  const originalConnect = mongoose.connect;
  let capturedOptions;
  mongoose.connect = async (_uri, options) => {
    capturedOptions = options;
    return connectionReturning({ setName: 'rs0' }, 'wealthgenie');
  };

  try {
    await connectDB({
      uri: 'mongodb+srv://cluster.example.test/?appName=unit-test',
      retries: 1,
      env: { MONGODB_FLAVOR: 'mongodb', MONGODB_EXPECTED_DATABASE: 'wealthgenie' },
    });
    assert.equal(capturedOptions.dbName, 'wealthgenie');
  } finally {
    mongoose.connect = originalConnect;
  }
});

test('database connection refuses an unnamed URI before opening a connection', async () => {
  const originalConnect = mongoose.connect;
  let connectCalled = false;
  mongoose.connect = async () => {
    connectCalled = true;
    return connectionReturning({ setName: 'rs0' });
  };

  try {
    await assert.rejects(
      connectDB({
        uri: 'mongodb+srv://cluster.example.test/?appName=unit-test',
        retries: 1,
        env: { MONGODB_FLAVOR: 'mongodb' },
      }),
      error => error.code === 'MONGODB_DATABASE_IDENTITY_REQUIRED',
    );
    assert.equal(connectCalled, false);
  } finally {
    mongoose.connect = originalConnect;
  }
});

test('database connection refuses conflicting URI and expected database names before connecting', async () => {
  const originalConnect = mongoose.connect;
  let connectCalled = false;
  mongoose.connect = async () => {
    connectCalled = true;
    return connectionReturning({ setName: 'rs0' });
  };

  try {
    await assert.rejects(
      connectDB({
        uri: 'mongodb://127.0.0.1:27017/wealthgenie',
        retries: 1,
        env: { MONGODB_FLAVOR: 'mongodb', MONGODB_EXPECTED_DATABASE: 'wealthgenie-demo' },
      }),
      error => error.code === 'MONGODB_DATABASE_IDENTITY_MISMATCH',
    );
    assert.equal(connectCalled, false);
  } finally {
    mongoose.connect = originalConnect;
  }
});
