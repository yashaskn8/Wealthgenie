import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { compareLoginPassword, DUMMY_LOGIN_HASH, getLoginComparisonHash, isSupportedBcryptHash } from '../services/loginPassword.js';

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

test('previously issued valid bcrypt hashes remain login-compatible across cost upgrades', async () => {
  const password = 'StrongPass1!';
  for (const rounds of [10, 11, 12]) {
    const storedHash = await bcrypt.hash(password, rounds);
    assert.equal(getLoginComparisonHash({ passwordHash: storedHash }), storedHash);
    assert.equal(await compareLoginPassword(password, { passwordHash: storedHash }), true);
    assert.equal(await compareLoginPassword('WrongPassword1!', { passwordHash: storedHash }), false);
  }
});

test('invalid bcrypt cost and malformed hashes never authenticate', () => {
  for (const malformed of [
    '$2b$00$' + 'A'.repeat(53), '$2b$03$' + 'A'.repeat(53),
    '$2b$32$' + 'A'.repeat(53), '$2b$99$' + 'A'.repeat(53),
    '$2b$10$' + 'A'.repeat(52), '$2b$10$' + 'A'.repeat(54),
  ]) assert.equal(getLoginComparisonHash({ passwordHash: malformed }), DUMMY_LOGIN_HASH);
});

test('login and diagnostic use one consistent stored-hash format rule', () => {
  for (const cost of ['04', '10', '12', '13', '31']) {
    const hash = '$2a$' + cost + '$' + '.'.repeat(53);
    assert.equal(isSupportedBcryptHash(hash), true);
    assert.equal(getLoginComparisonHash({ passwordHash: hash }), hash);
  }
  assert.equal(isSupportedBcryptHash('not-bcrypt'), false);
});
