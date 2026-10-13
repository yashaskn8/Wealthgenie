import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import { redisClient, redisAvailable } from '../config/redis.js';
import { sendError } from './errorHandler.js';

function rateLimitHandler(message, code) {
  return (req, res) => sendError(req, res, 429, message, code);
}

export function shouldSkipRateLimit(env = process.env) {
  return env.NODE_ENV !== 'production' && env.DISABLE_RATE_LIMIT === 'true';
}

class HybridStore {
  constructor(options = {}) {
    this.options = options;
    this.redisStore = null;
    this.hits = new Map();
    this.windowMs = options.windowMs || 60000;
  }

  init(options) {
    if (options && options.windowMs) {
      this.windowMs = options.windowMs;
      this.options.windowMs = options.windowMs;
    }
    if (this.redisStore && this.redisStore.init) {
      this.redisStore.init(options);
    }
  }

  getStore() {
    if (redisAvailable && redisClient) {
      if (!this.redisStore) {
        this.redisStore = new RedisStore({
          sendCommand: (...args) => {
            const flatArgs = args.flat(Infinity).filter(a => a !== undefined && a !== null).map(a => String(a));
            return redisClient.sendCommand(flatArgs);
          },
          prefix: this.options.prefix || 'rl:',
        });
        if (this.redisStore.init) {
          this.redisStore.init({ windowMs: this.windowMs });
        }
      }
      return this.redisStore;
    }
    return null;
  }

  async increment(key) {
    const store = this.getStore();
    if (store) return store.increment(key);
    const explicitlyRequired = typeof this.options.requireSharedStore === 'function'
      ? this.options.requireSharedStore()
      : this.options.requireSharedStore === true;
    const distributedRequired = this.options.requireDistributed
      && (process.env.NODE_ENV === 'production' || process.env.REQUIRE_REDIS === 'true');
    if (explicitlyRequired || distributedRequired) {
      const error = new Error(explicitlyRequired
        ? 'Shared rate-limit store is unavailable.'
        : 'Distributed rate-limit store is unavailable.');
      error.status = 503;
      error.code = this.options.unavailableCode || 'RATE_LIMIT_STORE_UNAVAILABLE';
      error.clientMessage = 'Request capacity could not be verified. Please retry shortly.';
      throw error;
    }

    const now = Date.now();
    const windowMs = this.options.windowMs || this.windowMs || 60000;
    const entry = this.hits.get(key) || { count: 0, resetTime: new Date(now + windowMs) };

    if (now > entry.resetTime.getTime()) {
      entry.count = 1;
      entry.resetTime = new Date(now + windowMs);
    } else {
      entry.count += 1;
    }

    this.hits.set(key, entry);
    return { totalHits: entry.count, resetTime: entry.resetTime };
  }

  async decrement(key) {
    const store = this.getStore();
    if (store) return store.decrement(key);
    const entry = this.hits.get(key);
    if (entry && entry.count > 0) entry.count -= 1;
  }

  async resetKey(key) {
    const store = this.getStore();
    if (store) return store.resetKey(key);
    this.hits.delete(key);
  }

  async resetAll() {
    const store = this.getStore();
    if (store && store.resetAll) {
      await store.resetAll();
    }
    this.hits.clear();
  }
}

// Auth cannot safely degrade to a process-local quota in production: separate
// app replicas would each accept their own independent brute-force allowance.
export function createAuthLimiter({
  env = process.env,
  getRedisState = () => ({ available: redisAvailable, client: redisClient }),
} = {}) {
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Authentication rate limit exceeded. Try again in 15 minutes.' },
    handler: rateLimitHandler(
      'Authentication rate limit exceeded. Try again in 15 minutes.',
      'AUTH_RATE_LIMIT_EXCEEDED',
    ),
    standardHeaders: true,
    legacyHeaders: false,
    store: new HybridStore({
      prefix: 'rl:auth:',
      windowMs: 15 * 60 * 1000,
      requireSharedStore: () => env.NODE_ENV === 'production' || env.REQUIRE_REDIS === 'true',
      unavailableCode: 'AUTH_RATE_LIMIT_UNAVAILABLE',
    }),
    passOnStoreError: false,
    validate: { singleCount: false },
    skip: () => shouldSkipRateLimit(env),
  });

  return (req, res, next) => {
    if (env.NODE_ENV === 'production') {
      const redis = getRedisState();
      if (!redis?.available || !redis?.client) {
        return sendError(
          req,
          res,
          503,
          'Authentication is temporarily unavailable because rate-limit capacity could not be verified.',
          'AUTH_RATE_LIMIT_UNAVAILABLE',
        );
      }
    }
    return limiter(req, res, error => {
      if (error && env.NODE_ENV === 'production') {
        return sendError(
          req,
          res,
          503,
          'Authentication is temporarily unavailable because rate-limit capacity could not be verified.',
          'AUTH_RATE_LIMIT_UNAVAILABLE',
        );
      }
      return next(error);
    });
  };
}

export const authLimiter = createAuthLimiter();

// Standard API rate limiter (protects database/CPU resource consumption)
// AVAILABILITY: passOnStoreError is TRUE - non-auth API endpoints degrade gracefully
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 1000, // High threshold for cluster load tests
  message: { error: 'Rate limit exceeded.' },
  handler: rateLimitHandler('Rate limit exceeded.', 'RATE_LIMIT_EXCEEDED'),
  store: new HybridStore({ prefix: 'rl:api:', windowMs: 60 * 1000 }),
  passOnStoreError: true, // Degrade gracefully for general read endpoints
  validate: { singleCount: false },
  skip: () => shouldSkipRateLimit(),
});

// Factory function for dedicated endpoint rate limiters (Chat, Monte Carlo, Portfolio Optimisation)
export function createEndpointRateLimiter(options = {}) {
  const {
    windowMs = 60 * 1000,
    max = 10,
    message = 'Endpoint rate limit exceeded.',
    prefix = 'rl:ep:',
    keyGenerator,
  } = options;
  return rateLimit({
    windowMs,
    max,
    message: { error: 'Rate Limit Exceeded', message },
    handler: rateLimitHandler(message, 'ENDPOINT_RATE_LIMIT_EXCEEDED'),
    standardHeaders: true,
    legacyHeaders: false,
    ...(keyGenerator ? { keyGenerator } : {}),
    store: new HybridStore({ prefix, windowMs, requireDistributed: true, unavailableCode: 'ENDPOINT_RATE_LIMIT_UNAVAILABLE' }),
    passOnStoreError: !(process.env.NODE_ENV === 'production' || process.env.REQUIRE_REDIS === 'true'),
    skip: () => shouldSkipRateLimit(),
  });
}

const PLAN_REVIEW_WINDOW_MS = 15 * 60 * 1000;
const PLAN_REVIEW_MAX = 12;
const PLAN_REVIEW_REDIS_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return { hits, redis.call('PTTL', KEYS[1]) }
`;

/**
 * PlanReview is costly work, so production quota enforcement must be shared
 * across replicas. Only local/test environments may use the explicit bounded
 * in-memory fallback. This policy is intentionally separate from apiLimiter.
 */
export function createPlanReviewRateLimiter({
  getRedisState = () => ({ available: redisAvailable, client: redisClient }),
  env = process.env,
  windowMs = PLAN_REVIEW_WINDOW_MS,
  max = PLAN_REVIEW_MAX,
  localHits = new Map(),
  now = () => Date.now(),
} = {}) {
  return async function planReviewRateLimiter(req, res, next) {
    const production = env.NODE_ENV === 'production';
    if (!production && env.DISABLE_RATE_LIMIT === 'true') return next();
    const principal = req.user?.userId || ipKeyGenerator(req.ip || req.socket?.remoteAddress || 'unknown');
    const key = `rl:ep:plan-review:${principal}`;
    const redis = getRedisState();
    let totalHits;
    let resetTime;
    if (redis?.available && redis.client) {
      try {
        const result = await redis.client.eval(PLAN_REVIEW_REDIS_SCRIPT, {
          keys: [key],
          arguments: [String(windowMs)],
        });
        totalHits = Number(result?.[0]);
        const ttl = Number(result?.[1]);
        if (!Number.isInteger(totalHits) || totalHits < 1 || !Number.isFinite(ttl) || ttl < 0) throw new Error('Invalid PlanReview Redis limiter response.');
        resetTime = new Date(now() + ttl);
      } catch {
        if (production || env.REQUIRE_REDIS === 'true') {
          return sendError(req, res, 503, 'Plan review is temporarily unavailable because distributed capacity could not be verified.', 'PLAN_REVIEW_RATE_LIMIT_UNAVAILABLE');
        }
      }
    } else if (production || env.REQUIRE_REDIS === 'true') {
      return sendError(req, res, 503, 'Plan review is temporarily unavailable because distributed capacity could not be verified.', 'PLAN_REVIEW_RATE_LIMIT_UNAVAILABLE');
    }

    // Development/test fallback is explicit and never used in production.
    if (totalHits === undefined) {
      const at = now();
      const current = localHits.get(key);
      if (!current || at >= current.resetAt) localHits.set(key, { hits: 1, resetAt: at + windowMs });
      else current.hits += 1;
      const local = localHits.get(key);
      totalHits = local.hits;
      resetTime = new Date(local.resetAt);
    }
    res.set?.('RateLimit-Limit', String(max));
    res.set?.('RateLimit-Remaining', String(Math.max(0, max - totalHits)));
    res.set?.('RateLimit-Reset', String(Math.ceil(resetTime.getTime() / 1000)));
    if (totalHits > max) {
      const retryAfter = Math.max(1, Math.ceil((resetTime.getTime() - now()) / 1000));
      res.set?.('Retry-After', String(retryAfter));
      return sendError(req, res, 429, 'Plan review limit reached. Try again later.', 'PLAN_REVIEW_RATE_LIMIT_EXCEEDED', { retryAfterSeconds: retryAfter });
    }
    return next();
  };
}

export const planReviewLimiter = createPlanReviewRateLimiter();

export { HybridStore, ipKeyGenerator };
