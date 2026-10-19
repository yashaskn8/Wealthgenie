import crypto from 'node:crypto';

/**
 * Resolve server-side Upstox credentials without allowing a blank preferred
 * value to mask a configured fallback.
 */
export function resolveUpstoxAccessToken(environment = process.env) {
  for (const name of ['UPSTOX_ANALYTICS_TOKEN', 'UPSTOX_ACCESS_TOKEN']) {
    const token = String(environment?.[name] ?? '').trim();
    if (token) return token;
  }
  return '';
}

export function hasUpstoxAccessToken(environment = process.env) {
  return resolveUpstoxAccessToken(environment).length > 0;
}

/** Partition cached provider observations by credential without exposing it in a key. */
export function upstoxCredentialCacheFingerprint(accessToken) {
  const token = String(accessToken || '').trim();
  if (!token) throw new TypeError('A configured Upstox credential is required for caching.');
  return crypto.createHash('sha256')
    .update('wealthgenie:upstox:credential-cache:v1\0')
    .update(token)
    .digest('hex');
}
