import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import {
  createIsolatedMongoDatabaseOwnership,
  createLoopbackMongoTestUri,
  dropOwnedMongoTestDatabase,
  isSafeMongoDatabaseName,
  ISOLATED_MONGO_DATABASE_PREFIX,
} from './isolatedMongoDatabase.js';

test('Mongo database-name validation accepts 63 bytes and rejects longer or unsafe names', () => {
  assert.equal(isSafeMongoDatabaseName(`a${'b'.repeat(62)}`), true);
  assert.equal(isSafeMongoDatabaseName('a'.repeat(64)), false);
  assert.equal(isSafeMongoDatabaseName('has.dot'), false);
  assert.equal(isSafeMongoDatabaseName('has/slash'), false);
  assert.equal(isSafeMongoDatabaseName('has\\backslash'), false);
  assert.equal(isSafeMongoDatabaseName('has space'), false);
  assert.equal(isSafeMongoDatabaseName('has$symbol'), false);
  assert.equal(isSafeMongoDatabaseName('contains\0null'), false);
  assert.equal(isSafeMongoDatabaseName(''), false);
});

test('generated test database names stay bounded and use Mongo-safe ASCII characters', () => {
  const ownership = createIsolatedMongoDatabaseOwnership();

  assert.ok(ownership.databaseName.startsWith(ISOLATED_MONGO_DATABASE_PREFIX));
  assert.ok(Buffer.byteLength(ownership.databaseName, 'utf8') <= 63);
  assert.match(ownership.databaseName, /^[a-z0-9_]+$/);
  assert.equal(ownership.databaseName.length, 59);
});

test('concurrent test runs receive unique cryptographically generated database names', async () => {
  const batches = await Promise.all(Array.from({ length: 16 }, async () => {
    await yieldEventLoop();
    return Array.from({ length: 256 }, () => createIsolatedMongoDatabaseOwnership());
  }));
  const names = batches.flat().map(ownership => ownership.databaseName);

  assert.equal(names.length, 4096);
  assert.equal(new Set(names).size, names.length);
});

test('CI URI uses the owned name and preserves the loopback replica-set options', () => {
  const ownership = createIsolatedMongoDatabaseOwnership();
  const uri = createLoopbackMongoTestUri(
    'mongodb://127.0.0.1:27017/wealthgenie_e2e?replicaSet=rs0&readPreference=primary',
    ownership,
  );
  const parsed = new URL(uri);

  assert.equal(parsed.protocol, 'mongodb:');
  assert.equal(parsed.hostname, '127.0.0.1');
  assert.equal(parsed.port, '27017');
  assert.equal(parsed.pathname, `/${ownership.databaseName}`);
  assert.equal(parsed.searchParams.get('replicaSet'), 'rs0');
  assert.equal(parsed.searchParams.get('readPreference'), 'primary');
});

test('CI URI refuses remote, credentialed, wrong-port, or non-replica-set Mongo endpoints', () => {
  const ownership = createIsolatedMongoDatabaseOwnership();
  const invalidUris = [
    'mongodb://mongo.example:27017/wealthgenie_e2e?replicaSet=rs0',
    'mongodb://user:password@127.0.0.1:27017/wealthgenie_e2e?replicaSet=rs0',
    'mongodb://127.0.0.1:27018/wealthgenie_e2e?replicaSet=rs0',
    'mongodb://127.0.0.1:27017/wealthgenie_e2e',
    'mongodb://127.0.0.1:27017/wealthgenie_e2e?replicaSet=other',
  ];

  for (const uri of invalidUris) {
    assert.throws(() => createLoopbackMongoTestUri(uri, ownership));
  }
});

test('cleanup drops only the exact database issued to the test that owns the connection', async () => {
  const ownership = createIsolatedMongoDatabaseOwnership();
  let dropCount = 0;
  const connection = {
    db: { databaseName: ownership.databaseName },
    async dropDatabase() { dropCount += 1; },
  };

  assert.equal(await dropOwnedMongoTestDatabase({ connection, ownership }), true);
  assert.equal(dropCount, 1);
  assert.equal(await dropOwnedMongoTestDatabase({ connection, ownership }), false, 'ownership is consumed after drop');
  assert.equal(dropCount, 1);
});

test('cleanup refuses shared, mismatched, missing, and unissued database ownership', async () => {
  const ownership = createIsolatedMongoDatabaseOwnership();
  let dropCount = 0;
  const sharedConnection = {
    db: { databaseName: 'wealthgenie_e2e' },
    async dropDatabase() { dropCount += 1; },
  };
  const wrongConnection = {
    db: { databaseName: createIsolatedMongoDatabaseOwnership().databaseName },
    async dropDatabase() { dropCount += 1; },
  };
  const missingDatabaseConnection = { async dropDatabase() { dropCount += 1; } };
  const forgedOwnership = Object.freeze({ databaseName: ownership.databaseName });

  assert.equal(await dropOwnedMongoTestDatabase({ connection: sharedConnection, ownership }), false);
  assert.equal(await dropOwnedMongoTestDatabase({ connection: wrongConnection, ownership }), false);
  assert.equal(await dropOwnedMongoTestDatabase({ connection: missingDatabaseConnection, ownership }), false);
  assert.equal(await dropOwnedMongoTestDatabase({ connection: wrongConnection, ownership: forgedOwnership }), false);
  assert.equal(dropCount, 0);
});

test('a failed database drop is surfaced without consuming the issued ownership token', async () => {
  const ownership = createIsolatedMongoDatabaseOwnership();
  const connection = {
    db: { databaseName: ownership.databaseName },
    async dropDatabase() { throw new Error('Mongo connection dropped before cleanup.'); },
  };

  await assert.rejects(
    dropOwnedMongoTestDatabase({ connection, ownership }),
    /Mongo connection dropped before cleanup\./,
  );

  connection.dropDatabase = async () => {};
  assert.equal(await dropOwnedMongoTestDatabase({ connection, ownership }), true);
});
