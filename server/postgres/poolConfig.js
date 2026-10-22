import { readFileSync } from 'node:fs';

function configurationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Build node-postgres options while keeping an optional operator-supplied CA
 * strict. An explicit SSL object overrides weaker sslmode URL parsing and
 * retains Node's default hostname verification.
 */
export function createFinancialPostgresPoolOptions(env = process.env, overrides = {}) {
  const connectionString = env.FINANCIAL_POSTGRES_URL;
  if (typeof connectionString !== 'string' || connectionString.trim() === '') {
    throw configurationError('FINANCIAL_POSTGRES_URL_REQUIRED', 'FINANCIAL_POSTGRES_URL_REQUIRED');
  }

  let endpoint;
  try {
    endpoint = new URL(connectionString);
  } catch {
    throw configurationError('FINANCIAL_POSTGRES_URL_INVALID', 'FINANCIAL_POSTGRES_URL_INVALID');
  }
  if (!['postgres:', 'postgresql:'].includes(endpoint.protocol)) {
    throw configurationError('FINANCIAL_POSTGRES_URL_INVALID', 'FINANCIAL_POSTGRES_URL_INVALID');
  }

  const caFile = String(env.FINANCIAL_POSTGRES_CA_FILE || '').trim();
  const options = {
    connectionString,
    max: 5,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
    statement_timeout: 10000,
    ...overrides,
  };
  if (caFile) {
    let ca;
    try {
      ca = readFileSync(caFile);
    } catch {
      throw configurationError(
        'FINANCIAL_POSTGRES_CA_FILE_UNREADABLE',
        'Configured PostgreSQL CA certificate file is unavailable.',
      );
    }
    const pem = ca.toString('utf8');
    if (!pem.includes('-----BEGIN CERTIFICATE-----') || !pem.includes('-----END CERTIFICATE-----')) {
      throw configurationError(
        'FINANCIAL_POSTGRES_CA_FILE_INVALID',
        'Configured PostgreSQL CA certificate file is not valid PEM.',
      );
    }
    // node-postgres parses connectionString after merging explicit options,
    // which would overwrite an explicit SSL object when the URL includes
    // sslmode/sslrootcert parameters. Remove those URL controls when a CA file
    // is supplied and pass one strict, hostname-verifying TLS configuration.
    for (const key of [
      'sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'sslpassword', 'sslcrl',
      'sslcrldir', 'sslcompression', 'sslnegotiation', 'uselibpqcompat',
    ]) endpoint.searchParams.delete(key);
    options.connectionString = endpoint.toString();
    // Keep this assignment last so URL and caller pool options cannot disable
    // certificate validation or hostname verification.
    options.ssl = { ca: pem, rejectUnauthorized: true };
  }
  return options;
}
