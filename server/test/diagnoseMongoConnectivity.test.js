import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseMongoConnectivity } from '../scripts/diagnoseMongoConnectivity.js';

const env = {
  MONGODB_FLAVOR: 'mongodb',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/wealthgenie?replicaSet=rs0',
  MONGODB_EXPECTED_DATABASE: 'wealthgenie',
};

test('Mongo diagnostic verifies the pinned replica set without writing data', async () => {
  let closed = false;
  let commands = [];
  const result = await diagnoseMongoConnectivity({ env, createConnection: (_uri, options) => {
    assert.equal(options.dbName, 'wealthgenie');
    assert.equal(options.autoIndex, false);
    return {
      asPromise: async () => {}, close: async () => { closed = true; },
      db: {
        databaseName: 'wealthgenie',
        admin: () => ({
          command: async command => { commands.push(command); return { setName: 'rs0' }; },
          ping: async () => {},
        }),
      },
    };
  } });
  assert.deepEqual(result, {
    status: 'READY', code: null, endpointType: 'LOOPBACK',
    database: 'wealthgenie', replicaSet: 'rs0', readOnly: true,
  });
  assert.deepEqual(commands, [{ hello: 1 }]);
  assert.equal(closed, true);
});

test('Mongo diagnostic refuses wrong database and redacts driver failures', async () => {
  const wrongDb = await diagnoseMongoConnectivity({ env, createConnection: () => ({
    asPromise: async () => {}, close: async () => {}, db: { databaseName: 'other' },
  }) });
  assert.equal(wrongDb.code, 'MONGODB_DATABASE_IDENTITY_MISMATCH');

  const secret = 'mongodb+srv://user:password@cluster.invalid/wealthgenie';
  const failure = await diagnoseMongoConnectivity({
    env: { ...env, MONGODB_URI: secret },
    createConnection: () => ({
      asPromise: async () => { throw Object.assign(new Error(`bad auth: ${secret}`), { code: 18 }); },
      close: async () => {},
    }),
  });
  assert.equal(failure.code, 'MONGODB_AUTHENTICATION_FAILED');
  assert.equal(failure.endpointType, 'REMOTE_SRV');
  assert.doesNotMatch(JSON.stringify(failure), /user:password|cluster\.invalid/);
  assert.equal((await diagnoseMongoConnectivity({ env: { ...env, MONGODB_EXPECTED_DATABASE: '' } })).code,
    'MONGODB_EXPECTED_DATABASE_REQUIRED');
});
