export function classifyUpstoxError(error) {
  if (error?.code === 'UPSTOX_RESPONSE_SCHEMA_INVALID'
      || error?.code === 'ERR_BAD_RESPONSE'
      || error instanceof SyntaxError
      || String(error?.message || '').startsWith('UPSTOX_HISTORY_')
      || String(error?.message || '').startsWith('UPSTOX_CALENDAR_')
      || String(error?.message || '').startsWith('UPSTOX_SESSION_')) return 'UPSTOX_RESPONSE_INVALID';
  const status = Number(error?.response?.status);
  if (status === 401) return 'UPSTOX_AUTHENTICATION_FAILED';
  if (status === 403) return 'UPSTOX_PERMISSION_DENIED';
  if (status === 404) return 'UPSTOX_INSTRUMENT_UNAVAILABLE';
  if (status === 429) return 'UPSTOX_RATE_LIMITED';
  if (status >= 500) return 'UPSTOX_PROVIDER_UNAVAILABLE';
  if (['ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(error?.code)) return 'UPSTOX_TIMEOUT';
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET'].includes(error?.code)) return 'UPSTOX_NETWORK_ERROR';
  return 'UPSTOX_FETCH_FAILED';
}

export function safeUpstoxError(code) {
  const messages = {
    UPSTOX_AUTHENTICATION_FAILED: 'Upstox did not accept the configured read-only credential.',
    UPSTOX_PERMISSION_DENIED: 'The configured Upstox credential is not permitted to read this data.',
    UPSTOX_INSTRUMENT_UNAVAILABLE: 'Upstox did not provide data for the requested instrument.',
    UPSTOX_RATE_LIMITED: 'Upstox request capacity is temporarily limited.',
    UPSTOX_PROVIDER_UNAVAILABLE: 'Upstox market data is temporarily unavailable.',
    UPSTOX_TIMEOUT: 'The Upstox market-data request timed out.',
    UPSTOX_NETWORK_ERROR: 'The Upstox market-data network request failed.',
    UPSTOX_RESPONSE_INVALID: 'Upstox returned a response that did not match its documented market-data contract.',
    UPSTOX_FETCH_FAILED: 'The Upstox market-data request failed.',
  };
  return { code, message: messages[code] || messages.UPSTOX_FETCH_FAILED };
}
