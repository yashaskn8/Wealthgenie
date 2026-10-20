import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseAccountPersistence, normalizeAuditEmail, summarizeAccountPersistence } from '../scripts/diagnoseAccountPersistence.js';

test('account inspector normalizes email without disclosing it in output', async () => {
  assert.equal(normalizeAuditEmail('  Person@Example.COM '), 'person@example.com');
  for (const s of ['', 'invalid', 'a@b', '  ', null]) assert.throws(() => normalizeAuditEmail(s));
  const operations = [];
  const connection = {
    db: {
      databaseName: 'wealthgenie-demo',
      listCollections(filter) { operations.push(['listCollections', filter]); return { toArray: async () => [{ name: 'users' }] }; },
      collection(name) { assert.equal(name, 'users'); return {
        findOne: async (query, options) => { operations.push(['findOne', query, options]); return { passwordHash: '$2a$12$' + '.'.repeat(53), _id: 'never-printed' }; },
      }; },
    },
    async close() { operations.push(['close']); },
  };
  const env = { NODE_ENV: 'development', MONGODB_URI: 'mongodb://127.0.0.1:27030/wealthgenie-demo',
    WG_ACCOUNT_DIAGNOSTIC_EMAIL: 'Person@Example.COM', MONGODB_EXPECTED_DATABASE: 'wealthgenie-demo' };
  const result = await diagnoseAccountPersistence({ env, connect: async (_uri, options) => {
    assert.equal(options.autoIndex, false); assert.equal(options.autoCreate, false); return connection;
  } });
  assert.equal(result.accountPresent, true);
  assert.equal(result.passwordHashFormatValid, true);
  assert.equal(result.expectedDatabaseMatches, true);
  assert.deepEqual(operations[1][1], { email: 'person@example.com' });
  assert.deepEqual(operations[1][2], { projection: { passwordHash: 1, _id: 0 } });
  assert.equal(operations.at(-1)[0], 'close');
  assert.doesNotMatch(JSON.stringify(result), /person|never-printed|passwordHash.*\$2a\$/i);
});

test('mismatched or empty databases do not fabricate an account', () => {
  const r = summarizeAccountPersistence({ databaseName: 'test', expectedDatabase: 'wealthgenie', usersCollectionExists: false, user: null });
  assert.equal(r.accountPresent, false);
  assert.equal(r.usersCollectionExists, false);
  assert.equal(r.expectedDatabaseMatches, false);
  assert.equal(r.passwordHashFormatValid, null);
});

test('production or absent credentials cannot trigger a database scan', async () => {
  let calls = 0;
  const connect = async () => { calls += 1; throw new Error('must not connect'); };
  await assert.rejects(() => diagnoseAccountPersistence({ env: { NODE_ENV: 'production', WG_ACCOUNT_DIAGNOSTIC_EMAIL: 'a@b.com', MONGODB_URI: 'mongodb://x/test' }, connect }), /Production/);
  await assert.rejects(() => diagnoseAccountPersistence({ env: { NODE_ENV: 'development', WG_ACCOUNT_DIAGNOSTIC_EMAIL: 'a@b.com' }, connect }), /MONGODB_URI/);
  assert.equal(calls, 0);
});

test('diagnostic recognizes authentic bcrypt cost variants consistently with login', () => {
  for (const cost of ['10', '11', '12', '13']) {
    const output = summarizeAccountPersistence({
      databaseName: 'wealthgenie-demo', expectedDatabase: 'wealthgenie-demo',
      usersCollectionExists: true,
      user: { passwordHash: '$2b$' + cost + '$' + '.'.repeat(53) },
    });
    assert.equal(output.passwordHashFormatValid, true);
  }
  assert.equal(summarizeAccountPersistence({
    databaseName: 'wealthgenie-demo',
    usersCollectionExists: true,
    user: { passwordHash: 'not-bcrypt' },
  }).passwordHashFormatValid, false);
});
