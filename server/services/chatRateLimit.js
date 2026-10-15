export const CHAT_RATE_LIMIT = 30;
export const CHAT_RATE_LIMIT_WINDOW_SECONDS = 60 * 60;

const MAX_LOCAL_RATE_LIMIT_USERS = 10_000;
const localChatRateLimits = new Map();
const INCREMENT_CHAT_QUOTA_SCRIPT = `
local count = tonumber(redis.call('INCR', KEYS[1]))
local ttlMs = tonumber(redis.call('PTTL', KEYS[1]))
if count == 1 or ttlMs < 0 then
  if redis.call('PEXPIRE', KEYS[1], ARGV[1]) ~= 1 then return { 0, -2 } end
  ttlMs = tonumber(redis.call('PTTL', KEYS[1]))
end
return { count, ttlMs }
`;

function resetAtFromTtlMs(currentTime, ttlMs) {
  const resetAt = Number(currentTime) + Number(ttlMs);
  if (!Number.isFinite(resetAt) || Number.isNaN(new Date(resetAt).getTime())) {
    throw quotaUnavailableError();
  }
  return resetAt;
}

function quotaUnavailableError() {
  const error = new Error('Chat rate-limit capacity could not be verified.');
  error.status = 503;
  error.code = 'CHAT_RATE_LIMIT_UNAVAILABLE';
  error.clientMessage = 'Chat is temporarily unavailable because request capacity could not be verified.';
  return error;
}

function enforceLocalCapacity(localHits, key, currentTime) {
  if (localHits.has(key) || localHits.size < MAX_LOCAL_RATE_LIMIT_USERS) return;
  for (const [candidate, entry] of localHits) {
    if (entry.resetAt <= currentTime) localHits.delete(candidate);
    if (localHits.size < MAX_LOCAL_RATE_LIMIT_USERS) return;
  }
  throw quotaUnavailableError();
}

export async function checkChatRateLimit(userId, {
  env = process.env,
  redisState = { client: null, available: false },
  localHits = localChatRateLimits,
  now = () => Date.now(),
} = {}) {
  const key = `chat:ratelimit:${String(userId)}`;
  const requiresSharedQuota = env.NODE_ENV === 'production' || env.REQUIRE_REDIS === 'true';

  if (redisState?.client && redisState.available) {
    try {
      const quota = await redisState.client.eval(INCREMENT_CHAT_QUOTA_SCRIPT, {
        keys: [key],
        arguments: [String(CHAT_RATE_LIMIT_WINDOW_SECONDS * 1000)],
      });
      const count = Array.isArray(quota) ? Number(quota[0]) : NaN;
      const ttlMs = Array.isArray(quota) ? Number(quota[1]) : NaN;
      if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(ttlMs) || ttlMs < 0) {
        throw new Error('Invalid chat quota counter response.');
      }
      if (count > CHAT_RATE_LIMIT) {
        const retryAfterSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
        return {
          allowed: false,
          count,
          ttl: retryAfterSeconds,
          resetAt: resetAtFromTtlMs(now(), ttlMs),
        };
      }
      return { allowed: true, count, resetAt: resetAtFromTtlMs(now(), ttlMs) };
    } catch {
      if (requiresSharedQuota) throw quotaUnavailableError();
    }
  }

  if (requiresSharedQuota) throw quotaUnavailableError();

  const currentTime = Number(now());
  let entry = localHits.get(key);
  if (!entry || entry.resetAt <= currentTime) {
    enforceLocalCapacity(localHits, key, currentTime);
    entry = { count: 0, resetAt: currentTime + CHAT_RATE_LIMIT_WINDOW_SECONDS * 1000 };
  }
  entry.count += 1;
  localHits.set(key, entry);
  if (entry.count > CHAT_RATE_LIMIT) {
    const ttl = Math.max(1, Math.ceil((entry.resetAt - currentTime) / 1000));
    return {
      allowed: false,
      count: CHAT_RATE_LIMIT,
      ttl,
      resetAt: entry.resetAt,
    };
  }
  return { allowed: true, count: entry.count, resetAt: entry.resetAt };
}
