import mongoose from 'mongoose';
import MarketEquityDailyBar from '../../models/MarketEquityDailyBar.js';
import { evaluateMarketDataProductionRights } from './marketDataRights.js';

const MAX_BARS = 366;
const MAX_RETENTION_DAYS = 365;
const COVERAGE = new Set([
  'COMPLETE_FOR_UPSTOX_NSE_CALENDAR',
  'COMPLETE_FOR_NSE_WEEKDAY_HOLIDAY_CALENDAR',
]);
const BASES = Object.freeze({
  UPSTOX: 'UPSTOX_PROVIDER_NATIVE',
  TEJHQ_RAW: 'RAW_UNADJUSTED',
  TEJHQ_ADJUSTED: 'BACK_ADJUSTED',
});
const SOURCE_URLS = Object.freeze({
  TEJHQ_RAW: 'https://api.tejhq.dev/v1/ohlcv',
  TEJHQ_ADJUSTED: 'https://api.tejhq.dev/v1/adjusted',
});
const validPrice = value => typeof value === 'number' && Number.isFinite(value)
  && value > 0 && value <= Number.MAX_SAFE_INTEGER;
const validVolume = value => value === null || value === undefined
  || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
const isoDate = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ''))) return null;
  const date = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
};
const istDate = timestamp => {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date).replaceAll('/', '-');
};

export function qualifiedHistoryStorageConfig(env = process.env) {
  const retention = Number(env.MARKET_EQUITY_HISTORY_RETENTION_DAYS);
  return {
    enabled: env.MARKET_EQUITY_HISTORY_STORE_ENABLED === 'true'
      && Number.isSafeInteger(retention) && retention >= 1 && retention <= MAX_RETENTION_DAYS,
    retentionDays: retention,
  };
}
export function qualifiedHistoryRightsAllowed(provider, sourceUrl) {
  if (!['UPSTOX', 'TEJHQ'].includes(provider) || typeof sourceUrl !== 'string') return false;
  return evaluateMarketDataProductionRights(provider, sourceUrl).productionUseAllowed === true;
}
function unavailable(code) {
  return { status: 'UNAVAILABLE', code, bars: [], barCount: 0 };
}
function normalizeQualifiedHistory(snapshot, request, now) {
  const { exchange, isin, fromDate, toDate, basis } = request;
  if (snapshot?.status !== 'AVAILABLE' || !['UPSTOX', 'TEJHQ'].includes(snapshot?.provider)
      || snapshot?.canonicalProductId !== 'market:equity:' + exchange.toLowerCase() + ':' + isin
      || snapshot?.instrumentIdentity?.exchange !== exchange
      || snapshot?.instrumentIdentity?.isin !== isin
      || !COVERAGE.has(snapshot?.coverage?.status)
      || !Array.isArray(snapshot.candles) || snapshot.candles.length === 0
      || snapshot.candles.length > MAX_BARS
      || snapshot.candleCount !== snapshot.candles.length
      || snapshot.coverage?.observedSessionCount !== snapshot.candles.length
      || snapshot.coverage?.expectedSessionCount !== snapshot.candles.length
      || !snapshot.source?.url || !snapshot.source?.instrumentId) return null;
  if (snapshot.provider === 'UPSTOX' && (basis !== 'RAW'
      || snapshot.priceBasis !== BASES.UPSTOX
      || snapshot.source.instrumentId !== exchange + '_EQ|' + isin)) return null;
  if (snapshot.provider === 'TEJHQ' && (snapshot.priceBasis !== (
    basis === 'ADJUSTED' ? BASES.TEJHQ_ADJUSTED : BASES.TEJHQ_RAW)
      || snapshot.source.instrumentId !== exchange + ':' + isin
      || snapshot.instrumentIdentity?.symbol !== request.symbol
      || !snapshot.source.url.startsWith(basis === 'ADJUSTED'
        ? SOURCE_URLS.TEJHQ_ADJUSTED : SOURCE_URLS.TEJHQ_RAW))) return null;
  const fetchedAt = new Date(snapshot.fetchedAt);
  if (!Number.isFinite(fetchedAt.getTime()) || fetchedAt.getTime() > now.getTime()) return null;

  let lastDate = null;
  const bars = [];
  for (const row of snapshot.candles) {
    const date = snapshot.provider === 'UPSTOX' ? istDate(row?.timestamp) : isoDate(row?.date);
    if (!date || date < fromDate || date > toDate || (lastDate !== null && date <= lastDate)
        || !['open', 'high', 'low', 'close'].every(k => validPrice(row?.[k]))
        || row.high < Math.max(row.open, row.close, row.low)
        || row.low > Math.min(row.open, row.close)
        || !validVolume(row.volume)) return null;
    if (snapshot.provider === 'TEJHQ' && row.timestamp !== null) return null;
    let adjustedClose = null;
    let adjustmentFactor = null;
    if (basis === 'ADJUSTED') {
      if (!validPrice(row.adjustedClose) || !validPrice(row.adjustmentFactor)
          || row.isin !== isin
          || Math.abs(row.close * row.adjustmentFactor - row.adjustedClose)
            > Math.max(0.01, row.adjustedClose * 1e-6)) return null;
      adjustedClose = row.adjustedClose;
      adjustmentFactor = row.adjustmentFactor;
    }
    bars.push({
      tradingDate: date, open: row.open, high: row.high, low: row.low,
      close: row.close, volume: row.volume ?? null,
      adjustedClose, adjustmentFactor,
      providerObservedAt: snapshot.provider === 'UPSTOX' ? new Date(row.timestamp) : null,
    });
    lastDate = date;
  }
  return { bars, fetchedAt };
}

export function buildQualifiedHistoryWriteOperations(snapshot, request, {
  env = process.env, now = new Date(),
} = {}) {
  const settings = qualifiedHistoryStorageConfig(env);
  if (!settings.enabled) return { status: 'DISABLED', code: 'MARKET_HISTORY_STORAGE_NOT_CONFIGURED', operations: [] };
  const normalized = normalizeQualifiedHistory(snapshot, request, now);
  if (!normalized) return { status: 'UNAVAILABLE', code: 'UNQUALIFIED_MARKET_HISTORY', operations: [] };
  if (!qualifiedHistoryRightsAllowed(snapshot.provider, snapshot.source.url)) {
    return { status: 'UNAVAILABLE', code: 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED', operations: [] };
  }
  const basis = snapshot.priceBasis;
  const retainedUntil = new Date(now.getTime() + settings.retentionDays * 86_400_000);
  const operations = normalized.bars.map(bar => ({
    updateOne: {
      filter: { provider: snapshot.provider, exchange: request.exchange, isin: request.isin,
        priceBasis: basis, tradingDate: bar.tradingDate },
      update: {
        $set: {
          schemaVersion: snapshot.schemaVersion, provider: snapshot.provider,
          exchange: request.exchange, isin: request.isin,
          // Upstox source only proves ISIN, not the caller's trading symbol.
          symbol: snapshot.provider === 'TEJHQ' ? request.symbol : null,
          tradingDate: bar.tradingDate, priceBasis: basis,
          open: bar.open, high: bar.high, low: bar.low, close: bar.close,
          volume: bar.volume, adjustedClose: bar.adjustedClose, adjustmentFactor: bar.adjustmentFactor,
          source: { url: snapshot.source.url, instrumentId: snapshot.source.instrumentId,
            datasetRevision: snapshot.sourceDatasetRevision || null },
          qualifiedCoverage: snapshot.coverage.status, fetchedAt: normalized.fetchedAt,
          providerObservedAt: bar.providerObservedAt,
          retainedUntil,
        },
      },
      upsert: true,
    },
  }));
  return { status: 'READY', provider: snapshot.provider, priceBasis: basis, operations };
}

/** Explicit, rights-gated administrative ingest. Never triggered by public GETs. */
export async function persistQualifiedHistory(snapshot, request, {
  env = process.env, now = new Date(), Model = MarketEquityDailyBar,
} = {}) {
  const plan = buildQualifiedHistoryWriteOperations(snapshot, request, { env, now });
  if (plan.status !== 'READY') return { status: plan.status, code: plan.code, written: 0 };
  if (Model === MarketEquityDailyBar && mongoose.connection.readyState !== 1) {
    return { status: 'UNAVAILABLE', code: 'MARKET_HISTORY_DATABASE_UNAVAILABLE', written: 0 };
  }
  await Model.bulkWrite(plan.operations, { ordered: true });
  return { status: 'PERSISTED', provider: plan.provider, priceBasis: plan.priceBasis,
    written: plan.operations.length };
}

/** Rights checked again at read time; expired records remain invisible even before TTL cleanup. */
export async function readQualifiedHistory(request, {
  env = process.env, now = new Date(), Model = MarketEquityDailyBar,
} = {}) {
  if (!qualifiedHistoryStorageConfig(env).enabled) return unavailable('MARKET_HISTORY_STORAGE_NOT_CONFIGURED');
  if (Model === MarketEquityDailyBar && mongoose.connection.readyState !== 1) {
    return unavailable('MARKET_HISTORY_DATABASE_UNAVAILABLE');
  }
  const basis = request.basis === 'ADJUSTED' ? BASES.TEJHQ_ADJUSTED : null;
  const query = {
    exchange: request.exchange, isin: request.isin,
    tradingDate: { $gte: request.fromDate, $lte: request.toDate },
    retainedUntil: { $gt: now },
    ...(basis ? { priceBasis: basis } : {
      priceBasis: { $in: [BASES.UPSTOX, BASES.TEJHQ_RAW] },
    }),
  };
  const records = await Model.find(query).sort({ tradingDate: 1 }).limit(MAX_BARS).lean();
  // A raw read may contain observations from two sources. Never mix them
  // into one row or silently choose a preferred feed.
  const visible = records.filter(row => qualifiedHistoryRightsAllowed(row.provider, row.source?.url));
  return {
    status: visible.length ? 'AVAILABLE' : 'UNAVAILABLE',
    code: visible.length ? null : 'NO_AUTHORIZED_PERSISTED_HISTORY',
    barCount: visible.length,
    // Each bar is independently attributed; no mixed-source derived series.
    bars: visible.map(row => ({
      tradingDate: row.tradingDate, provider: row.provider,
      exchange: row.exchange, isin: row.isin, priceBasis: row.priceBasis,
      open: row.open, high: row.high, low: row.low, close: row.close,
      volume: row.volume, adjustedClose: row.adjustedClose,
      providerObservedAt: row.providerObservedAt ?? null,
      fetchedAt: row.fetchedAt, source: row.source,
    })),
  };
}
