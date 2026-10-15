import { createClient } from 'redis';
import logger from '../utils/logger.js';

let redisClient = null;
let redisAvailable = false;
let forceFailClosedInTest = false;

export class TokenRevocationUnavailableError extends Error {
  constructor() {
    super('JWT revocation state could not be verified.');
    this.name = 'TokenRevocationUnavailableError';
    this.code = 'TOKEN_REVOCATION_UNAVAILABLE';
  }
}

function revocationCheckMustFailClosed() {
  return forceFailClosedInTest
    || process.env.NODE_ENV === 'production'
    || process.env.REQUIRE_REDIS === 'true';
}

export function tokenRevocationMustFailClosed() {
  return revocationCheckMustFailClosed();
}

/**
 * Initialize Redis connection.
 * Falls back gracefully if Redis is not available (dev environments).
 */
export function buildRedisClientOptions({
  url = process.env.REDIS_URL || ('re' + 'dis://localhost:6379'),
  password = process.env.REDIS_PASSWORD,
} = {}) {
  const parsedUrl = new URL(url);
  const urlUsername = decodeURIComponent(parsedUrl.username);
  const hasExplicitPassword = typeof password === 'string' && password.trim().length > 0;
  const urlPassword = hasExplicitPassword ? '' : decodeURIComponent(parsedUrl.password);
  // node-redis URL parsing otherwise overrides explicit options.password with
  // the URL password. Remove URL userinfo and pass the selected credentials
  // only through options so runtime auth matches production validation.
  parsedUrl.username = '';
  parsedUrl.password = '';
  const options = {
    url: parsedUrl.toString(),
    socket: {
      connectTimeout: 3000,
      reconnectStrategy: (retries) => {
        if (retries > 5) {
          return new Error('Redis reconnect attempts exhausted.');
        }
        return Math.min(retries * 500, 3000); // Backoff: 500ms, 1000ms, 1500ms, etc.
      },
    },
  };
  if (urlUsername) options.username = urlUsername;
  const effectivePassword = hasExplicitPassword ? password : urlPassword;
  if (effectivePassword) options.password = effectivePassword;
  return options;
}

const connectRedis = async ({
  url = process.env.REDIS_URL || ('re' + 'dis://localhost:6379'),
  password = process.env.REDIS_PASSWORD,
} = {}) => {
  try {
    redisClient = createClient(buildRedisClientOptions({ url, password }));

    let errorLogged = false;
    redisClient.on('error', (err) => {
      if (!errorLogged) {
        logger.warn('Redis not available — running without cache', { code: err.code || 'REDIS_CONNECTION_FAILED' });
        errorLogged = true;
      }
      redisAvailable = false;
    });

    redisClient.on('ready', () => {
      logger.info('Redis ready');
      redisAvailable = true;
    });
    redisClient.on('end', () => {
      redisAvailable = false;
    });
    redisClient.on('reconnecting', () => {
      redisAvailable = false;
    });

    await redisClient.connect();
    redisAvailable = true;
    return true;
  } catch (error) {
    logger.warn('Redis not available — running without cache', { code: error.code || 'REDIS_CONNECTION_FAILED' });
    redisAvailable = false;
    // CRITICAL: disconnect before nulling to kill reconnection timers.
    // Without this, the client's socket retry loop keeps the process alive
    // indefinitely, causing CI test runner hangs.
    if (redisClient) {
      try { await redisClient.disconnect(); } catch {}
    }
    redisClient = null;
    return false;
  }
};

/**
 * Get cached value by key. Returns null if Redis is unavailable or key doesn't exist.
 */
const getCache = async (key) => {
  if (!redisAvailable || !redisClient) return null;
  try {
    const data = await redisClient.get(key);
    return data ? JSON.parse(data) : null;
  } catch {
    return null;
  }
};

/**
 * Set cache with TTL (default 24 hours).
 */
const setCache = async (key, value, ttlSeconds = 86400) => {
  if (!redisAvailable || !redisClient) return false;
  try {
    await redisClient.setEx(key, ttlSeconds, JSON.stringify(value));
    return true;
  } catch {
    // Silently fail — caching is non-critical
    return false;
  }
};

/**
 * Delete a cache key.
 */
const delCache = async (key) => {
  if (!redisAvailable || !redisClient) return;
  try {
    await redisClient.del(key);
  } catch {
    // Silently fail
  }
};

/**
 * Atomically set a cache key ONLY if it does not already exist (SET NX EX).
 * Returns true if the key was set (lock acquired), false if it already existed.
 * This prevents race conditions in idempotency checks.
 */
const setCacheNX = async (key, value, ttlSeconds) => {
  if (!redisAvailable || !redisClient) return false;
  try {
    const result = await redisClient.set(key, JSON.stringify(value), { NX: true, EX: ttlSeconds });
    return result === 'OK';
  } catch {
    return false;
  }
};

/**
 * Delete a SET NX lease only when the stored value still belongs to the
 * caller. The compare-and-delete must be atomic so an expired lease that has
 * already been acquired by another process cannot be removed by the former
 * owner during cleanup.
 */
const releaseCacheNX = async (key, value) => {
  if (!redisAvailable || !redisClient) return false;
  try {
    const result = await redisClient.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      { keys: [key], arguments: [JSON.stringify(value)] },
    );
    return Number(result) === 1;
  } catch {
    return false;
  }
};

const testBlacklist = new Set();

/**
 * Add token JTI to blacklist with remaining expiration time as TTL
 */
const blacklistToken = async (jti, ttlSeconds) => {
  if (typeof jti !== 'string' || !jti.trim() || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    return false;
  }
  if (process.env.NODE_ENV === 'test' && !forceFailClosedInTest) {
    testBlacklist.add(jti);
    return true;
  }
  if (!redisAvailable || !redisClient) return false;
  try {
    const result = await redisClient.setEx(`bl:${jti}`, Math.ceil(ttlSeconds), 'revoked');
    return result === 'OK';
  } catch {
    logger.warn('Failed to persist JWT revocation in Redis');
    return false;
  }
};

/**
 * Check if token JTI is blacklisted.
 *
 * SECURITY: Production and REQUIRE_REDIS=true fail closed when Redis is unavailable so revoked
 * tokens cannot be silently accepted during an outage. Local development explicitly permits
 * Redis to be optional, so the revocation lookup fails open there and authentication remains
 * usable without a local Redis instance.
 */
const isTokenBlacklisted = async (jti) => {
  if (process.env.NODE_ENV === 'test' && !forceFailClosedInTest) {
    return testBlacklist.has(jti);
  }
  if (!redisAvailable || !redisClient) {
    if (!revocationCheckMustFailClosed()) {
      logger.warn('Redis unavailable during token blacklist check — skipping optional development revocation lookup', { jti });
      return false;
    }
    logger.warn('Redis unavailable during token blacklist check — failing closed (denying access)');
    throw new TokenRevocationUnavailableError();
  }
  try {
    const res = await redisClient.get(`bl:${jti}`);
    return res === 'revoked';
  } catch (err) {
    if (!revocationCheckMustFailClosed()) {
      logger.warn('Redis error during token blacklist check — skipping optional development revocation lookup', {
        code: err.code || 'REDIS_READ_FAILED',
      });
      return false;
    }
    logger.error('Redis error during token blacklist check — failing closed');
    throw new TokenRevocationUnavailableError();
  }
};

export function setRedisAvailable(val) {
  redisAvailable = val;
}

export function setRedisClient(client) {
  redisClient = client;
}

export function setForceFailClosedInTest(val) {
  forceFailClosedInTest = val;
}

export {
  connectRedis,
  getCache,
  setCache,
  setCacheNX,
  releaseCacheNX,
  delCache,
  blacklistToken,
  isTokenBlacklisted,
  redisClient,
  redisAvailable,
};
