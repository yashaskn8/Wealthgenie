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
