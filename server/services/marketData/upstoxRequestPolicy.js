const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'EAI_AGAIN',
]);
const MAX_RETRY_DELAY_MS = 2000;

function retryAfterMs(value, now) {
  if (value === null || value === undefined || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? Math.max(0, parsed - now) : null;
}

/** Bounded read-only GET retries. Authentication and entitlement failures never retry. */
export async function getUpstoxWithRetry(httpClient, url, options, {
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  random = Math.random,
  now = () => Date.now(),
  maxAttempts = 3,
} = {}) {
  if (!httpClient?.get || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
    throw new TypeError('A GET client and 1–3 attempts are required.');
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await httpClient.get(url, options);
    } catch (error) {
      const status = Number(error?.response?.status);
      const retryable = status === 429 || (status >= 500 && status <= 599)
        || RETRYABLE_NETWORK_CODES.has(error?.code);
      if (!retryable || attempt === maxAttempts) throw error;
      const directedDelay = status === 429
        ? retryAfterMs(error?.response?.headers?.['retry-after'], now()) : null;
      if (directedDelay !== null && directedDelay > MAX_RETRY_DELAY_MS) throw error;
      const jitter = 0.8 + Math.min(1, Math.max(0, Number(random()) || 0)) * 0.4;
      const delay = directedDelay ?? Math.min(MAX_RETRY_DELAY_MS,
        Math.ceil(200 * 2 ** (attempt - 1) * jitter));
      await sleep(delay);
    }
  }
  throw new Error('UPSTOX_RETRY_EXHAUSTED');
}
