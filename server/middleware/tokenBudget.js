/**
 * Per-user chat token quota. Provider attempts reserve their conservative
 * input/output upper bound before the network call, then settle to validated
 * usage or retain the full reservation when usage is unknown.
 */
import crypto from 'node:crypto';
import { createError, sendError } from './errorHandler.js';
import { redisClient, redisAvailable } from '../config/redis.js';

const DEFAULT_WINDOW_MS = 60 * 1000;
const DEFAULT_MAX_TOKENS = 50_000;
// Provider deadlines are capped at 60 seconds; retain in-flight reservations
// beyond a window rollover so a late settlement cannot disappear at expiry.
const RESERVATION_GRACE_MS = 120 * 1000;

const RESERVE_SCRIPT = `
local time = redis.call('TIME')
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
local windowMs = tonumber(ARGV[1])
local maxTokens = tonumber(ARGV[2])
local amount = tonumber(ARGV[3])
local reservationId = ARGV[4]
local resetAt = tonumber(redis.call('HGET', KEYS[1], 'resetAt') or '0')
if resetAt <= now then
  local values = redis.call('HGETALL', KEYS[1])
  local pending = 0
  for index = 1, #values, 2 do
    if string.sub(values[index], 1, 2) == 'r:' then pending = pending + tonumber(values[index + 1]) end
  end
  resetAt = now + windowMs
  redis.call('HSET', KEYS[1], 'tokens', 0, 'reserved', pending, 'resetAt', resetAt)
end
local field = 'r:' .. reservationId
local existing = tonumber(redis.call('HGET', KEYS[1], field) or '-1')
local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens') or '0')
local reserved = tonumber(redis.call('HGET', KEYS[1], 'reserved') or '0')
if existing >= 0 then
  if existing ~= amount then return {-1, tokens, reserved, resetAt - now} end
  return {1, tokens, reserved, resetAt - now}
end
if tokens + reserved + amount > maxTokens then
  return {0, tokens, reserved, resetAt - now}
end
redis.call('HSET', KEYS[1], field, amount)
redis.call('HINCRBY', KEYS[1], 'reserved', amount)
redis.call('PEXPIRE', KEYS[1], math.max(1, resetAt - now + tonumber(ARGV[5])))
return {1, tokens, reserved + amount, resetAt - now}
`;

const SETTLE_SCRIPT = `
local time = redis.call('TIME')
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
local windowMs = tonumber(ARGV[3])
local graceMs = tonumber(ARGV[4])
local resetAt = tonumber(redis.call('HGET', KEYS[1], 'resetAt') or '0')
if resetAt <= now then
  local values = redis.call('HGETALL', KEYS[1])
  local pending = 0
  for index = 1, #values, 2 do
    if string.sub(values[index], 1, 2) == 'r:' then pending = pending + tonumber(values[index + 1]) end
  end
  resetAt = now + windowMs
  redis.call('HSET', KEYS[1], 'tokens', 0, 'reserved', pending, 'resetAt', resetAt)
end
local field = 'r:' .. ARGV[1]
local amount = tonumber(redis.call('HGET', KEYS[1], field) or '-1')
if amount < 0 then
  return {0, tonumber(redis.call('HGET', KEYS[1], 'tokens') or '0'), tonumber(redis.call('HGET', KEYS[1], 'reserved') or '0')}
end
local actual = tonumber(ARGV[2])
if actual < 0 then actual = amount end
local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens') or '0')
local reserved = tonumber(redis.call('HGET', KEYS[1], 'reserved') or '0')
redis.call('HDEL', KEYS[1], field)
redis.call('HSET', KEYS[1], 'reserved', math.max(0, reserved - amount))
redis.call('HSET', KEYS[1], 'tokens', tokens + actual)
redis.call('PEXPIRE', KEYS[1], math.max(1, resetAt - now + graceMs))
return {1, tokens + actual, math.max(0, reserved - amount)}
`;

const INSPECT_SCRIPT = `
local time = redis.call('TIME')
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
local windowMs = tonumber(ARGV[1])
local graceMs = tonumber(ARGV[2])
local resetAt = tonumber(redis.call('HGET', KEYS[1], 'resetAt') or '0')
if resetAt <= now then
  local values = redis.call('HGETALL', KEYS[1])
  local pending = 0
  for index = 1, #values, 2 do
    if string.sub(values[index], 1, 2) == 'r:' then pending = pending + tonumber(values[index + 1]) end
  end
  resetAt = now + windowMs
  redis.call('HSET', KEYS[1], 'tokens', 0, 'reserved', pending, 'resetAt', resetAt)
  redis.call('PEXPIRE', KEYS[1], math.max(1, resetAt - now + graceMs))
end
return {
  tonumber(redis.call('HGET', KEYS[1], 'tokens') or '0'),
  tonumber(redis.call('HGET', KEYS[1], 'reserved') or '0'),
  resetAt - now
}
`;

const RECORD_SCRIPT = `
local time = redis.call('TIME')
local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
local windowMs = tonumber(ARGV[1])
local graceMs = tonumber(ARGV[3])
local amount = tonumber(ARGV[2])
local resetAt = tonumber(redis.call('HGET', KEYS[1], 'resetAt') or '0')
if resetAt <= now then
  local values = redis.call('HGETALL', KEYS[1])
  local pending = 0
  for index = 1, #values, 2 do
    if string.sub(values[index], 1, 2) == 'r:' then pending = pending + tonumber(values[index + 1]) end
  end
  resetAt = now + windowMs
  redis.call('HSET', KEYS[1], 'tokens', 0, 'reserved', pending, 'resetAt', resetAt)
end
local tokens = redis.call('HINCRBY', KEYS[1], 'tokens', amount)
local reserved = tonumber(redis.call('HGET', KEYS[1], 'reserved') or '0')
redis.call('PEXPIRE', KEYS[1], math.max(1, resetAt - now + graceMs))
return {tokens, reserved, resetAt - now}
`;

function unavailableError() {
  return createError(503, 'Chat token capacity could not be verified.', 'Chat is temporarily unavailable. Please retry shortly.', {
    code: 'TOKEN_BUDGET_STORE_UNAVAILABLE',
  });
}

function budgetExceededError(totalTokens, maxTokens, retryAfterSeconds) {
  return createError(429,
    `You have used ${totalTokens} tokens in the current window (limit: ${maxTokens}).`,
    'The chat token budget has been reached. Retry after the current window resets.',
    { code: 'TOKEN_BUDGET_EXCEEDED', details: { retryAfterSeconds } });
}

function validTokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export class TokenBudgetStore {
  constructor({ now = () => Date.now(), createId = () => crypto.randomUUID() } = {}) {
    this.buckets = new Map();
    this.now = now;
    this.createId = createId;
  }

  #currentBucket(key, windowMs) {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: 0, reservedTokens: 0, resetTime: now + windowMs, windowMs, reservations: new Map() };
      this.buckets.set(key, bucket);
    } else if (now >= bucket.resetTime) {
      const reservations = bucket.reservations;
      const reservedTokens = [...reservations.values()].reduce((total, amount) => total + amount, 0);
      bucket = { tokens: 0, reservedTokens, resetTime: now + windowMs, windowMs, reservations };
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  record(key, tokens, windowMs = DEFAULT_WINDOW_MS) {
    if (!validTokenCount(tokens)) return { totalTokens: this.peek(key, windowMs).totalTokens };
    const bucket = this.#currentBucket(key, windowMs);
    bucket.tokens += tokens;
    return { totalTokens: bucket.tokens + bucket.reservedTokens, resetTime: bucket.resetTime };
  }

  peek(key, windowMs = DEFAULT_WINDOW_MS) {
    const existing = this.buckets.get(key);
    const bucket = existing
      ? this.#currentBucket(key, existing.windowMs || windowMs)
      : null;
    if (!bucket) return { totalTokens: 0, reservedTokens: 0 };
    return {
      totalTokens: bucket.tokens + bucket.reservedTokens,
      reservedTokens: bucket.reservedTokens,
      resetTime: bucket.resetTime,
    };
  }

  reserve(key, tokens, { windowMs = DEFAULT_WINDOW_MS, maxTokens = DEFAULT_MAX_TOKENS, reservationId = this.createId() } = {}) {
    const bucket = this.#currentBucket(key, windowMs);
    const existing = bucket.reservations.get(reservationId);
    if (existing !== undefined) {
      if (existing !== tokens) throw createError(409, 'Token reservation identity was reused.', 'Chat is temporarily unavailable.', { code: 'TOKEN_BUDGET_RESERVATION_CONFLICT' });
      return { allowed: true, reservationId, key, backend: 'local', tokens, windowMs, resetTime: bucket.resetTime };
    }
    const used = bucket.tokens + bucket.reservedTokens;
    if (used + tokens > maxTokens) {
      return {
        allowed: false,
        totalTokens: used,
        retryAfterSeconds: Math.ceil(Math.max(1000, bucket.resetTime - this.now()) / 1000),
      };
    }
    bucket.reservedTokens += tokens;
    bucket.reservations.set(reservationId, tokens);
    return { allowed: true, reservationId, key, backend: 'local', tokens, windowMs, resetTime: bucket.resetTime };
  }

  settle(reservation, actualTokens = null) {
    const existingBucket = this.buckets.get(reservation.key);
    if (!existingBucket) return { settled: false };
    const bucket = this.#currentBucket(reservation.key, reservation.windowMs || DEFAULT_WINDOW_MS);
    const amount = bucket.reservations.get(reservation.reservationId);
    if (amount === undefined) return { settled: false };
    const charge = validTokenCount(actualTokens) ? actualTokens : amount;
    bucket.reservations.delete(reservation.reservationId);
    bucket.reservedTokens = Math.max(0, bucket.reservedTokens - amount);
    bucket.tokens += charge;
    return { settled: true, totalTokens: bucket.tokens + bucket.reservedTokens };
  }

  reset(key) {
    this.buckets.delete(key);
  }

  resetAll() {
    this.buckets.clear();
  }
}

const store = new TokenBudgetStore();

function hashBucketKey(key) {
  return `tb:chat:{${crypto.createHash('sha256').update(String(key)).digest('hex')}}`;
}

function redisRequired(env) {
  return env.NODE_ENV === 'production' || env.REQUIRE_REDIS === 'true';
}

/** Injectable backend keeps concurrency and failure behavior testable. */
export function createTokenBudgetService({
  getRedisState = () => ({ available: redisAvailable, client: redisClient }),
  env = process.env,
  localStore = store,
} = {}) {
  const requireRedis = () => { if (redisRequired(env)) throw unavailableError(); };

  return {
    async inspect(key, { windowMs = DEFAULT_WINDOW_MS, maxTokens = DEFAULT_MAX_TOKENS } = {}) {
      const redis = getRedisState();
      if (redis?.available && redis.client) {
        try {
          const result = await redis.client.eval(INSPECT_SCRIPT, {
            keys: [hashBucketKey(key)],
            arguments: [String(windowMs), String(RESERVATION_GRACE_MS)],
          });
          const totalTokens = Number(result?.[0]) + Number(result?.[1]);
          const ttlMs = Number(result?.[2]);
          if (![totalTokens, ttlMs].every(Number.isFinite) || totalTokens < 0) throw new Error('Invalid token-budget Redis response.');
          return {
            totalTokens,
            allowed: totalTokens < maxTokens,
            maxTokens,
            retryAfterSeconds: Math.ceil(Math.max(1000, ttlMs || windowMs) / 1000),
          };
        } catch {
          requireRedis();
        }
      } else {
        requireRedis();
      }
      const status = localStore.peek(key, windowMs);
      return {
        ...status,
        allowed: status.totalTokens < maxTokens,
        maxTokens,
        retryAfterSeconds: Math.ceil(Math.max(1000, (status.resetTime || Date.now() + windowMs) - Date.now()) / 1000),
      };
    },

    async reserve(key, tokens, { windowMs = DEFAULT_WINDOW_MS, maxTokens = DEFAULT_MAX_TOKENS, reservationId = crypto.randomUUID() } = {}) {
      if (!validTokenCount(tokens) || tokens === 0 || typeof reservationId !== 'string' || !reservationId) {
        throw createError(400, 'Invalid token-budget reservation.', 'Chat is temporarily unavailable.', { code: 'TOKEN_BUDGET_RESERVATION_INVALID' });
      }
      const redis = getRedisState();
      if (redis?.available && redis.client) {
        try {
          const result = await redis.client.eval(RESERVE_SCRIPT, {
            keys: [hashBucketKey(key)],
            arguments: [String(windowMs), String(maxTokens), String(tokens), reservationId, String(RESERVATION_GRACE_MS)],
          });
          const admitted = Number(result?.[0]);
          const totalTokens = Number(result?.[1]) + Number(result?.[2]);
          const ttlMs = Number(result?.[3]);
          if (![admitted, totalTokens, ttlMs].every(Number.isFinite)) throw new Error('Invalid token-budget Redis response.');
          if (admitted < 0) throw createError(409, 'Token reservation identity was reused.', 'Chat is temporarily unavailable.', { code: 'TOKEN_BUDGET_RESERVATION_CONFLICT' });
          return admitted === 1
            ? { allowed: true, reservationId, key: hashBucketKey(key), backend: 'redis', tokens, windowMs }
            : { allowed: false, totalTokens, retryAfterSeconds: Math.ceil(Math.max(1000, ttlMs) / 1000) };
        } catch (error) {
          if (error?.code === 'TOKEN_BUDGET_RESERVATION_CONFLICT') throw error;
          requireRedis();
        }
      } else {
        requireRedis();
      }
      return localStore.reserve(key, tokens, { windowMs, maxTokens, reservationId });
    },

    async settle(reservation, actualTokens = null) {
      if (!reservation?.reservationId || !reservation?.key) return { settled: false };
      const charge = validTokenCount(actualTokens) ? actualTokens : -1;
      if (reservation.backend === 'redis') {
        const redis = getRedisState();
        if (!redis?.available || !redis.client) throw unavailableError();
        try {
          const result = await redis.client.eval(SETTLE_SCRIPT, {
            keys: [reservation.key],
            arguments: [reservation.reservationId, String(charge), String(reservation.windowMs || DEFAULT_WINDOW_MS), String(RESERVATION_GRACE_MS)],
          });
          const settled = Number(result?.[0]) === 1;
          if (![0, 1].includes(Number(result?.[0]))
              || !Number.isFinite(Number(result?.[1]))
              || !Number.isFinite(Number(result?.[2]))) throw new Error('Invalid token-budget Redis settlement response.');
          return { settled, totalTokens: Number(result[1]) + Number(result[2]) };
        } catch {
          throw unavailableError();
        }
      }
      return localStore.settle(reservation, validTokenCount(actualTokens) ? actualTokens : null);
    },

    async record(key, tokens, { windowMs = DEFAULT_WINDOW_MS } = {}) {
      if (!validTokenCount(tokens)) return localStore.peek(key);
      const redis = getRedisState();
      if (redis?.available && redis.client) {
        try {
          const result = await redis.client.eval(RECORD_SCRIPT, {
            keys: [hashBucketKey(key)],
            arguments: [String(windowMs), String(tokens), String(RESERVATION_GRACE_MS)],
          });
          const totalTokens = Number(result?.[0]) + Number(result?.[1]);
          const ttlMs = Number(result?.[2]);
          if (![totalTokens, ttlMs].every(Number.isFinite)) throw new Error('Invalid token-budget Redis response.');
          return { totalTokens, resetTime: Date.now() + ttlMs };
        } catch {
          requireRedis();
        }
      } else {
        requireRedis();
      }
      return localStore.record(key, tokens, windowMs);
    },
  };
}

const tokenBudgetService = createTokenBudgetService();

function budgetKeyForRequest(req, options = {}) {
  const keyGenerator = options.keyGenerator || (request => request.user?.userId || request.ip);
  return String(keyGenerator(req));
}

export function checkTokenBudget(options = {}) {
  return async (req, res, next) => {
    try {
      const status = await inspectTokenBudget(req, options);
      if (!status.allowed) {
        res.setHeader('Retry-After', String(status.retryAfterSeconds));
        return sendError(
          req,
          res,
          429,
          `You have used ${status.totalTokens} tokens in the current window (limit: ${status.maxTokens}). Try again in ${status.retryAfterSeconds}s.`,
          'TOKEN_BUDGET_EXCEEDED',
          { retryAfterSeconds: status.retryAfterSeconds },
        );
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

export async function inspectTokenBudget(req, options = {}) {
  const { windowMs = DEFAULT_WINDOW_MS, maxTokens = DEFAULT_MAX_TOKENS } = options;
  const key = budgetKeyForRequest(req, options);
  const status = await tokenBudgetService.inspect(key, { windowMs, maxTokens });
  req.tokenBudgetKey = key;
  req.tokenBudgetWindowMs = windowMs;
  req.tokenBudgetMaxTokens = maxTokens;
  return status;
}

export async function reserveTokenBudget(req, tokens, options = {}) {
  const windowMs = req.tokenBudgetWindowMs || options.windowMs || DEFAULT_WINDOW_MS;
  const maxTokens = req.tokenBudgetMaxTokens || options.maxTokens || DEFAULT_MAX_TOKENS;
  const key = req.tokenBudgetKey || budgetKeyForRequest(req, options);
  req.tokenBudgetKey = key;
  req.tokenBudgetWindowMs = windowMs;
  req.tokenBudgetMaxTokens = maxTokens;
  const reservation = await tokenBudgetService.reserve(key, tokens, { windowMs, maxTokens });
  if (!reservation.allowed) {
    throw budgetExceededError(reservation.totalTokens, maxTokens, reservation.retryAfterSeconds);
  }
  req.tokenBudgetProviderAttempts = (req.tokenBudgetProviderAttempts || 0) + 1;
  return reservation;
}

export async function settleTokenBudget(reservation, actualTokens = null) {
  return tokenBudgetService.settle(reservation, actualTokens);
}

export async function recordTokenUsage(req, tokens) {
  const key = req.tokenBudgetKey || budgetKeyForRequest(req);
  req.tokenBudgetKey = key;
  return tokenBudgetService.record(key, tokens, { windowMs: req.tokenBudgetWindowMs || DEFAULT_WINDOW_MS });
}

export { store as _testStore };
