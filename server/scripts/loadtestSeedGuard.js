const ISOLATED_NAME = /^(?:wealthgenie[-_])?loadtest(?:[-_][a-z0-9]+)?$/i;
const CONFIRMATION = 'I_UNDERSTAND_THIS_WRITES_TEST_DATA';

function databaseFromUri(uri) {
  if (typeof uri !== 'string' || !/^mongodb(?:\+srv)?:\/\//i.test(uri)) return null;
  // This intentionally extracts only the database segment. It does not log
  // connection strings, credentials, hostnames, or authentication material.
  const match = uri.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^/?#]+)/i);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

export function assertIsolatedLoadtestSeedTarget({
  uri, nodeEnv, confirmation, connectedDatabaseName,
} = {}) {
  if (nodeEnv !== 'test' && nodeEnv !== 'development') {
    throw new Error('Loadtest seeding requires an isolated development or test environment.');
  }
  if (confirmation !== CONFIRMATION) {
    throw new Error('Loadtest seeding requires explicit LOADTEST_SEED_CONFIRMED authorization.');
  }
  const database = databaseFromUri(uri);
  if (!database || !ISOLATED_NAME.test(database)) {
    throw new Error('Loadtest seeding requires an explicitly named isolated loadtest database.');
  }
  if (connectedDatabaseName !== undefined
      && (connectedDatabaseName !== database || !ISOLATED_NAME.test(connectedDatabaseName))) {
    throw new Error('Connected MongoDB database does not match the isolated loadtest target.');
  }
  return { databaseName: database };
}
