import mongoose from 'mongoose';
import MarketObservation from '../../models/MarketObservation.js';
import { MARKET_BENCHMARKS } from './marketBenchmarks.js';
import { evaluateMarketDataProductionRights } from './marketDataRights.js';
import { isUpstoxPublicDistributionAllowed } from './upstoxDistributionPolicy.js';

const BENCHMARKS = [MARKET_BENCHMARKS.NIFTY_50, MARKET_BENCHMARKS.INDIA_VIX];
const MAX_RETENTION_SECONDS = 86_400;
const MAX_RECORDS_PER_BENCHMARK = 24;

export function benchmarkQuoteStorageConfig(env = process.env) {
  const retentionSeconds = Number(env.MARKET_BENCHMARK_QUOTE_RETENTION_SECONDS);
  return {
    enabled: env.MARKET_BENCHMARK_QUOTE_STORE_ENABLED === 'true'
      && Number.isSafeInteger(retentionSeconds)
      && retentionSeconds >= 1 && retentionSeconds <= MAX_RETENTION_SECONDS,
    retentionSeconds,
  };
}

export function benchmarkQuoteIdentityAllowed(value) {
  const benchmark = BENCHMARKS.find(row => row.canonicalProductId === value?.canonicalProductId);
  if (!benchmark || value?.kind !== 'MARKET_QUOTE' || value?.unit !== 'INDEX_POINTS') return false;
  const provider = value?.source?.provider;
  const expected = provider === 'UPSTOX' ? benchmark.upstoxInstrumentKey
    : provider === 'NSE' ? benchmark.nseIndexName : null;
  return Boolean(expected && value.source.instrumentId === expected);
}

export function benchmarkQuoteSourceAllowed(value, {
  env = process.env,
  rightsCheck = (provider, url) => evaluateMarketDataProductionRights(provider, url).productionUseAllowed,
} = {}) {
  if (!benchmarkQuoteIdentityAllowed(value)
      || typeof value.source?.url !== 'string'
      || !value.source.url.startsWith('https://')
      || (value.source.provider === 'UPSTOX' && !isUpstoxPublicDistributionAllowed(env))) return false;
  return rightsCheck(value.source.provider, value.source.url) === true;
}

export async function benchmarkQuoteIndexesReady(Model = MarketObservation) {
  if (Model === MarketObservation && mongoose.connection.readyState !== 1) return false;
  let indexes;
  try { indexes = await Model.collection.indexes(); } catch { return false; }
  return indexes.some(index => index.name === 'expire_retained_market_observation'
      && index.key?.retainedUntil === 1 && index.expireAfterSeconds === 0)
    && indexes.some(index => index.name === 'latest_retained_benchmark_quote'
      && JSON.stringify(index.key) === JSON.stringify({
        kind: 1, canonicalProductId: 1, 'source.provider': 1, observedAt: -1,
      }));
}

function unavailable(code) {
  return { status: 'UNAVAILABLE', provider: null, facts: [], fetchedAt: null,
    reasonCodes: [code], persistence: 'STORED_READ_ONLY' };
}

/** Read-only; no cache or provider requests. Stale values remain last-observed facts. */
export async function readStoredBenchmarkQuotes({
  env = process.env, now = new Date(), Model = MarketObservation,
  rightsCheck,
} = {}) {
  const config = benchmarkQuoteStorageConfig(env);
  if (!config.enabled) return unavailable('MARKET_BENCHMARK_QUOTE_STORAGE_NOT_CONFIGURED');
  if (Model === MarketObservation && !(await benchmarkQuoteIndexesReady(Model))) {
    return unavailable('MARKET_BENCHMARK_QUOTE_STORAGE_UNAVAILABLE');
  }
  const facts = [];
  for (const benchmark of BENCHMARKS) {
    const recordsByProvider = await Promise.all(['NSE', 'UPSTOX'].map(provider => Model.find({
      kind: 'MARKET_QUOTE', canonicalProductId: benchmark.canonicalProductId,
      'source.provider': provider,
      retainedUntil: { $gt: now }, availabilityStatus: 'AVAILABLE',
    }).sort({ observedAt: -1 }).limit(MAX_RECORDS_PER_BENCHMARK).lean()));
    const row = recordsByProvider.flat().filter(record => {
      if (!benchmarkQuoteSourceAllowed(record, { env, rightsCheck })
          || !Number.isFinite(record.value) || record.value <= 0
          || record.dataClass !== 'LIVE') return false;
      const observedAt = new Date(record.observedAt);
      const fetchedAt = new Date(record.lastFetchedAt);
      const retainedUntil = new Date(record.retainedUntil);
      return Number.isFinite(observedAt.getTime()) && observedAt <= now
        && Number.isFinite(fetchedAt.getTime()) && fetchedAt <= now
        && fetchedAt >= observedAt
        && Number.isFinite(retainedUntil.getTime()) && retainedUntil > now
        && retainedUntil.getTime() <= observedAt.getTime() + config.retentionSeconds * 1000;
    }).sort((left, right) => new Date(right.observedAt) - new Date(left.observedAt))[0];
    if (!row) continue;
    const observedAt = new Date(row.observedAt);
    const ageSeconds = Math.max(0, Math.floor((now.getTime() - observedAt.getTime()) / 1000));
    const maxAgeSeconds = Number.isFinite(row.freshness?.maxAgeSeconds)
      ? Math.max(0, Math.min(row.freshness.maxAgeSeconds, config.retentionSeconds)) : 0;
    facts.push({
      schemaVersion: row.schemaVersion, kind: 'MARKET_QUOTE',
      canonicalProductId: benchmark.canonicalProductId, value: row.value,
      unit: row.unit, currency: row.currency ?? null,
      availabilityStatus: 'AVAILABLE', dataClass: row.dataClass,
      observedAt: observedAt.toISOString(),
      providerTimestamp: row.providerTimestamp?.toISOString?.() ?? null,
      effectiveTradingDate: row.effectiveTradingDate ?? null,
      fetchedAt: new Date(row.lastFetchedAt).toISOString(),
      freshness: { status: ageSeconds <= maxAgeSeconds ? 'FRESH' : 'STALE',
        ageSeconds, maxAgeSeconds },
      source: { provider: row.source.provider, instrumentId: row.source.instrumentId,
        url: row.source.url },
      metrics: row.metrics ?? {},
    });
  }
  if (!facts.length) return unavailable('NO_AUTHORIZED_RETAINED_BENCHMARK_QUOTES');
  const provider = facts.every(fact => fact.source.provider === facts[0].source.provider)
    ? facts[0].source.provider : null;
  return { status: facts.length === BENCHMARKS.length ? 'AVAILABLE' : 'PARTIAL',
    provider, facts, fetchedAt: null, persistence: 'STORED_READ_ONLY' };
}
