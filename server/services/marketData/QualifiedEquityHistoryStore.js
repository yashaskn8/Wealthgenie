import mongoose from 'mongoose';
import crypto from 'node:crypto';
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
});
const validPrice = value => typeof value === 'number' && Number.isFinite(value)
  && value > 0 && value <= Number.MAX_SAFE_INTEGER;
const validVolume = value => value === null || value === undefined
  || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
const istDate = timestamp => {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const field = name => parts.find(part => part.type === name)?.value;
  const y = field('year'), m = field('month'), d = field('day');
  return y && m && d ? `${y}-${m}-${d}` : null;
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
  if (provider !== 'UPSTOX' || typeof sourceUrl !== 'string') return false;
  return evaluateMarketDataProductionRights(provider, sourceUrl).productionUseAllowed === true;
}
function unavailable(code) {
  return { status: 'UNAVAILABLE', code, bars: [], barCount: 0 };
}
function qualifiedSourceChain(snapshot, dataUrls) {
  const chain = snapshot?.qualificationSourceUrls;
  if (!Array.isArray(chain) || chain.length < 2 || chain.length > 16) return null;
  const seen = new Set();
  for (const entry of chain) {
    if (!['NSE', 'UPSTOX'].includes(entry?.provider)
        || typeof entry.url !== 'string' || seen.has(`${entry.provider}:${entry.url}`)) return null;
    let parsed;
    try { parsed = new URL(entry.url); } catch { return null; }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    seen.add(`${entry.provider}:${entry.url}`);
  }
  if (!dataUrls.every(url => seen.has(`${snapshot.provider}:${url}`))) return null;
  const calendarProvider = snapshot.coverage?.calendarProvider;
  if (!['NSE', 'UPSTOX'].includes(calendarProvider)
      || !chain.some(entry => entry.provider === calendarProvider
        && !dataUrls.includes(entry.url))) return null;
  return chain;
}
function normalizeQualifiedHistory(snapshot, request, now) {
  const { exchange, isin, fromDate, toDate, basis } = request;
  if (snapshot?.status !== 'AVAILABLE' || snapshot?.provider !== 'UPSTOX'
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
  if (basis !== 'RAW'
      || snapshot.priceBasis !== BASES.UPSTOX
      || snapshot.source.instrumentId !== exchange + '_EQ|' + isin) return null;
  const sourceUrls = [snapshot.source.url];
  if (!Array.isArray(sourceUrls) || sourceUrls.length < 1 || sourceUrls.length > 12
      || sourceUrls.some(url => typeof url !== 'string' || !url.startsWith('https://')))
    return null;
  const qualificationSourceUrls = qualifiedSourceChain(snapshot, sourceUrls);
  if (!qualificationSourceUrls) return null;
  const fetchedAt = new Date(snapshot.fetchedAt);
  if (!Number.isFinite(fetchedAt.getTime()) || fetchedAt.getTime() > now.getTime()) return null;

  let lastDate = null;
  const bars = [];
  for (const row of snapshot.candles) {
    const date = istDate(row?.timestamp);
    if (!date || date < fromDate || date > toDate || (lastDate !== null && date <= lastDate)
        || !['open', 'high', 'low', 'close'].every(k => validPrice(row?.[k]))
        || row.high < Math.max(row.open, row.close, row.low)
        || row.low > Math.min(row.open, row.close)
        || !validVolume(row.volume)) return null;
    bars.push({
      tradingDate: date, open: row.open, high: row.high, low: row.low,
      close: row.close, volume: row.volume ?? null,
      adjustedClose: null, adjustmentFactor: null,
      providerObservedAt: new Date(row.timestamp),
    });
    lastDate = date;
  }
  return { bars, fetchedAt, sourceUrls, qualificationSourceUrls };
}

export function buildQualifiedHistoryWriteOperations(snapshot, request, {
  env = process.env, now = new Date(), rightsCheck = qualifiedHistoryRightsAllowed,
} = {}) {
  const settings = qualifiedHistoryStorageConfig(env);
  if (!settings.enabled) return { status: 'DISABLED', code: 'MARKET_HISTORY_STORAGE_NOT_CONFIGURED', operations: [] };
  const normalized = normalizeQualifiedHistory(snapshot, request, now);
  if (!normalized) return { status: 'UNAVAILABLE', code: 'UNQUALIFIED_MARKET_HISTORY', operations: [] };
  if (!normalized.qualificationSourceUrls.every(({ provider, url }) => rightsCheck(provider, url))) {
    return { status: 'UNAVAILABLE', code: 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED', operations: [] };
  }
  const basis = snapshot.priceBasis;
  // Replaying the same provider fetch cannot renew its licensed retention.
  const retainedUntil = new Date(normalized.fetchedAt.getTime() + settings.retentionDays * 86_400_000);
  if (retainedUntil <= now) {
    return { status: 'UNAVAILABLE', code: 'MARKET_HISTORY_RETENTION_EXPIRED', operations: [] };
  }
  const qualificationBatchId = crypto.createHash('sha256').update(JSON.stringify({
    provider: snapshot.provider, exchange: request.exchange, isin: request.isin,
    basis, fromDate: request.fromDate, toDate: request.toDate,
    fetchedAt: normalized.fetchedAt.toISOString(),
    sourceUrls: normalized.qualificationSourceUrls,
    bars: normalized.bars,
  })).digest('hex');
  const operations = normalized.bars.map(bar => ({
    updateOne: {
      filter: { provider: snapshot.provider, exchange: request.exchange, isin: request.isin,
        priceBasis: basis, tradingDate: bar.tradingDate,
        open: bar.open, high: bar.high, low: bar.low, close: bar.close,
        volume: bar.volume, adjustedClose: bar.adjustedClose,
        adjustmentFactor: bar.adjustmentFactor,
        $or: [
          { fetchedAt: { $lt: normalized.fetchedAt } },
          { fetchedAt: normalized.fetchedAt, qualificationBatchId },
        ] },
      update: {
        $set: {
          schemaVersion: snapshot.schemaVersion, provider: snapshot.provider,
          exchange: request.exchange, isin: request.isin,
          // Upstox source only proves ISIN, not the caller's trading symbol.
          symbol: null,
          tradingDate: bar.tradingDate, priceBasis: basis,
          open: bar.open, high: bar.high, low: bar.low, close: bar.close,
          volume: bar.volume, adjustedClose: bar.adjustedClose, adjustmentFactor: bar.adjustmentFactor,
          source: { url: normalized.sourceUrls[0], requestUrls: normalized.sourceUrls,
            qualificationSourceUrls: normalized.qualificationSourceUrls,
            instrumentId: snapshot.source.instrumentId,
            datasetRevision: snapshot.sourceDatasetRevision || null },
          qualifiedCoverage: snapshot.coverage.status, fetchedAt: normalized.fetchedAt,
          qualificationBatchId,
          coverageFromDate: request.fromDate,
          coverageToDate: request.toDate,
          coverageSessionCount: normalized.bars.length,
          providerObservedAt: bar.providerObservedAt,
          retainedUntil,
        },
      },
      upsert: true,
    },
  }));
  return { status: 'READY', provider: snapshot.provider, priceBasis: basis,
    qualificationBatchId, operations };
}

/** Explicit, rights-gated administrative ingest. Never triggered by public GETs. */
export async function persistQualifiedHistory(snapshot, request, {
  env = process.env, now = new Date(), Model = MarketEquityDailyBar,
  rightsCheck = qualifiedHistoryRightsAllowed,
  startSession = () => Model.db.startSession(),
} = {}) {
  const plan = buildQualifiedHistoryWriteOperations(snapshot, request, { env, now, rightsCheck });
  if (plan.status !== 'READY') return { status: plan.status, code: plan.code, written: 0 };
  if (Model === MarketEquityDailyBar && mongoose.connection.readyState !== 1) {
    return { status: 'UNAVAILABLE', code: 'MARKET_HISTORY_DATABASE_UNAVAILABLE', written: 0 };
  }
  // Prevent silently writing unprotected data if the additive migration was
  // not executed. The unique identity and TTL must both be present.
  if (Model === MarketEquityDailyBar) {
    let indexes;
    try { indexes = await Model.collection.indexes(); } catch {
      return { status: 'UNAVAILABLE', code: 'MARKET_HISTORY_INDEXES_UNVERIFIED', written: 0 };
    }
    const identity = indexes.find(index => index.name === 'unique_qualified_equity_daily_bar'
      && index.unique === true
      && JSON.stringify(index.key) === JSON.stringify({
        provider: 1, exchange: 1, isin: 1, priceBasis: 1, tradingDate: 1,
      }));
    const ttl = indexes.find(index => index.name === 'expire_qualified_equity_daily_bar'
      && index.expireAfterSeconds === 0 && index.key?.retainedUntil === 1);
    const batchRead = indexes.find(index => index.name === 'qualified_equity_history_batch_read'
      && JSON.stringify(index.key) === JSON.stringify({
        qualificationBatchId: 1, provider: 1, exchange: 1, isin: 1,
        priceBasis: 1, tradingDate: 1,
      }));
    if (!identity || !ttl || !batchRead) {
      return { status: 'UNAVAILABLE', code: 'MARKET_HISTORY_INDEXES_UNVERIFIED', written: 0 };
    }
  }
  let session;
  try {
    session = await startSession();
    await session.withTransaction(async () => {
      await Model.bulkWrite(plan.operations, { ordered: true, session });
    });
  } catch (error) {
    return { status: 'UNAVAILABLE',
      code: error?.code === 11000 ? 'MARKET_HISTORY_REVISION_CONFLICT' : 'MARKET_HISTORY_PERSISTENCE_FAILED',
      written: 0 };
  } finally {
    await session?.endSession();
  }
  return { status: 'PERSISTED', provider: plan.provider, priceBasis: plan.priceBasis,
    written: plan.operations.length };
}

/** Rights checked again at read time; expired records remain invisible even before TTL cleanup. */
export async function readQualifiedHistory(request, {
  env = process.env, now = new Date(), Model = MarketEquityDailyBar,
  rightsCheck = qualifiedHistoryRightsAllowed,
} = {}) {
  if (!qualifiedHistoryStorageConfig(env).enabled) return unavailable('MARKET_HISTORY_STORAGE_NOT_CONFIGURED');
  if (Model === MarketEquityDailyBar && mongoose.connection.readyState !== 1) {
    return unavailable('MARKET_HISTORY_DATABASE_UNAVAILABLE');
  }
  const spanDays = (Date.parse(`${request.toDate}T00:00:00.000Z`)
    - Date.parse(`${request.fromDate}T00:00:00.000Z`)) / 86_400_000 + 1;
  if (!Number.isInteger(spanDays) || spanDays < 1 || spanDays > MAX_BARS) {
    return unavailable('INVALID_MARKET_HISTORY_RANGE');
  }
  if (request.basis !== 'RAW') return unavailable('UNSUPPORTED_MARKET_HISTORY_BASIS');
  const query = {
    provider: 'UPSTOX', exchange: request.exchange, isin: request.isin,
    tradingDate: { $gte: request.fromDate, $lte: request.toDate },
    retainedUntil: { $gt: now },
    priceBasis: BASES.UPSTOX,
  };
  const records = await Model.find(query).sort({ tradingDate: 1 }).limit(MAX_BARS).lean();
  const authorizedRow = row => Array.isArray(row.source?.requestUrls)
    && qualifiedSourceChain({
      provider: row.provider,
      coverage: { calendarProvider: row.qualifiedCoverage === 'COMPLETE_FOR_UPSTOX_NSE_CALENDAR'
        ? 'UPSTOX' : 'NSE' },
      qualificationSourceUrls: row.source?.qualificationSourceUrls,
    }, row.source.requestUrls)
    && row.source.qualificationSourceUrls.every(({ provider, url }) => rightsCheck(provider, url));
  // A complete covering batch is required. The unique daily key means the
  // first candidate for each provider/basis is enough: any newer full batch
  // would have replaced its first row as well.
  const candidates = new Map();
  for (const row of records) {
    if (!authorizedRow(row) || !row.qualificationBatchId
        || row.coverageFromDate > request.fromDate || row.coverageToDate < request.toDate
        || !Number.isInteger(row.coverageSessionCount)
        || row.coverageSessionCount < 1 || row.coverageSessionCount > MAX_BARS) continue;
    const key = `${row.provider}:${row.priceBasis}`;
    if (!candidates.has(key)) candidates.set(key, row);
  }
  const visible = [];
  for (const candidate of candidates.values()) {
    const complete = await Model.find({
      qualificationBatchId: candidate.qualificationBatchId,
      provider: candidate.provider, exchange: request.exchange, isin: request.isin,
      priceBasis: candidate.priceBasis, retainedUntil: { $gt: now },
    }).sort({ tradingDate: 1 }).limit(MAX_BARS).lean();
    if (complete.length !== candidate.coverageSessionCount
        || !complete.every((row, index) => row.qualificationBatchId === candidate.qualificationBatchId
          && row.coverageFromDate === candidate.coverageFromDate
          && row.coverageToDate === candidate.coverageToDate
          && row.coverageSessionCount === candidate.coverageSessionCount
          && row.tradingDate >= candidate.coverageFromDate
          && row.tradingDate <= candidate.coverageToDate
          && (index === 0 || row.tradingDate > complete[index - 1].tradingDate)
          && authorizedRow(row))) continue;
    visible.push(...complete.filter(row => row.tradingDate >= request.fromDate
      && row.tradingDate <= request.toDate));
  }
  visible.sort((a, b) => a.tradingDate.localeCompare(b.tradingDate)
    || a.provider.localeCompare(b.provider));
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
