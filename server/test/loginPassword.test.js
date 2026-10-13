import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { compareLoginPassword, DUMMY_LOGIN_HASH, getLoginComparisonHash } from '../services/loginPassword.js';

test('unknown-account login selects a valid cost-12 bcrypt hash and executes comparison', async () => {
  assert.equal(DUMMY_LOGIN_HASH.length, 60);
  assert.match(DUMMY_LOGIN_HASH, /^\$2[aby]\$12\$[./A-Za-z0-9]{53}$/);
  assert.equal(getLoginComparisonHash(null), DUMMY_LOGIN_HASH);
  let calledWith;
  const valid = await compareLoginPassword('submitted-password', null, async (_password, hash) => {
    calledWith = hash;
    return false;
  });
  assert.equal(calledWith, DUMMY_LOGIN_HASH);
  assert.equal(valid, false);
  assert.equal(await bcrypt.compare('not-the-discarded-secret', DUMMY_LOGIN_HASH), false);
});

test('malformed stored password hashes use the same valid bcrypt fallback and cannot authenticate', async () => {
  assert.equal(getLoginComparisonHash({ passwordHash: 'malformed' }), DUMMY_LOGIN_HASH);
  assert.equal(await compareLoginPassword('submitted-password', { passwordHash: 'malformed' }), false);
});
