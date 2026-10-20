import bcrypt from 'bcryptjs';

// Generated from a discarded high-entropy secret; it is not an account password.
// Keep a valid cost-12 bcrypt hash so unknown-account attempts take the bcrypt path.
export const DUMMY_LOGIN_HASH = '$2a$12$PUGFo.PizinU427pLEOy5eZh9TFKCJ7r4J5H7iuq/9GhbnfXt9UAm';

export function isSupportedBcryptHash(value) {
  return typeof value === 'string'
    && /^\$2[aby]\$(?:0[4-9]|[12]\d|3[01])\$[./A-Za-z0-9]{53}$/.test(value);
}

export function getLoginComparisonHash(user) {
  const storedHash = user?.passwordHash;
  return isSupportedBcryptHash(storedHash) ? storedHash : DUMMY_LOGIN_HASH;
}

export async function compareLoginPassword(password, user, compare = bcrypt.compare) {
  return compare(password, getLoginComparisonHash(user));
}
