import { redisAvailable, redisClient } from '../../config/redis.js';

const DEFAULT_DAILY_BUDGET = 200;
const PROVIDER_DAILY_LIMIT = 1000;

const RESERVE_BUDGET_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local limit = tonumber(ARGV[1])
if current >= limit then return -current end
local nextValue = redis.call('INCR', KEYS[1])
if nextValue == 1 then redis.call('EXPIRE', KEYS[1], 259200) end
return nextValue
`;

function configuredLimit(env) {
  const raw = env.TEJHQ_INTERNAL_DAILY_REQUEST_BUDGET;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_DAILY_BUDGET;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > PROVIDER_DAILY_LIMIT) return null;
  return parsed;
}

function isDistributedStateRequired(env) {
  return env.NODE_ENV === 'production' || env.REQUIRE_REDIS === 'true';
}

export function createTejHqRequestBudget({
  env = process.env,
  clock = () => new Date(),
  redis = () => redisClient,
  redisIsAvailable = () => redisAvailable,
  localUsage = new Map(),
} = {}) {
  return async function reserveTejHqKeyedRequest() {
    const limit = configuredLimit(env);
    if (limit === null) return { allowed: false, code: 'TEJHQ_BUDGET_CONFIG_INVALID', used: null, limit: null };

    const now = clock();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      return { allowed: false, code: 'TEJHQ_BUDGET_CLOCK_INVALID', used: null, limit };
    }
    const day = now.toISOString().slice(0, 10);
    const key = `market:tejhq:keyed-budget:${day}`;

    const redisClientForRequest = typeof redis === 'function' ? redis() : redis;
    if (redisIsAvailable() && redisClientForRequest) {
      try {
        const reservation = Number(await redisClientForRequest.eval(RESERVE_BUDGET_SCRIPT, {
          keys: [key],
          arguments: [String(limit)],
        }));
        if (!Number.isSafeInteger(reservation)) {
          return { allowed: false, code: 'TEJHQ_BUDGET_STORE_INVALID', used: null, limit };
        }
        const used = Math.abs(reservation);
        const allowed = reservation > 0 && used <= limit;
        return { allowed, code: allowed ? null : 'TEJHQ_INTERNAL_DAILY_BUDGET_EXHAUSTED', used, limit };
      } catch {
        if (isDistributedStateRequired(env)) {
          return { allowed: false, code: 'TEJHQ_BUDGET_STORE_UNAVAILABLE', used: null, limit };
        }
      }
    } else if (isDistributedStateRequired(env)) {
      return { allowed: false, code: 'TEJHQ_BUDGET_STORE_UNAVAILABLE', used: null, limit };
    }

    for (const existingDay of localUsage.keys()) {
      if (existingDay !== day) localUsage.delete(existingDay);
    }
    const used = localUsage.get(day) || 0;
    if (used >= limit) {
      return { allowed: false, code: 'TEJHQ_INTERNAL_DAILY_BUDGET_EXHAUSTED', used, limit };
    }
    localUsage.set(day, used + 1);
    return { allowed: true, code: null, used: used + 1, limit };
  };
}

export const consumeTejHqKeyedRequest = createTejHqRequestBudget();
