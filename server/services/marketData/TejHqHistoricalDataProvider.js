import crypto from 'node:crypto';
import axios from 'axios';
import MarketDataProvider from './MarketDataProvider.js';
import {
  AVAILABILITY,
  FRESHNESS,
  MARKET_DATA_SCHEMA_VERSION,
  PROVIDERS,
  normalizeTimestamp,
  nullableFiniteNumber,
} from './contracts.js';
import { readThroughMarketCache } from './requestCache.js';
import { consumeTejHqKeyedRequest } from './tejHqRequestBudget.js';
import {
  evaluateMarketDataProductionRights,
  isMarketDataProductionUseAllowed,
} from './marketDataRights.js';

export const TEJHQ_API_BASE_URL = 'https://api.tejhq.dev';
export const TEJHQ_API_DOCUMENTATION_URL = 'https://tejhq.dev/docs';
export const TEJHQ_DATASET_CONTRACT_REVISION = 'tej-api-v1-adjustment-chain-2026-09-10';
export const TEJHQ_INTERNAL_DAILY_KEYED_REQUEST_BUDGET = 200;
export const TEJHQ_MAX_HISTORY_DAYS = 366;
export const TEJHQ_MAX_HISTORY_ROWS = 366;
export const TEJHQ_MAX_RESPONSE_BYTES = 2_000_000;
export const TEJHQ_RECENT_HISTORY_CACHE_TTL_SECONDS = 15 * 60;
export const TEJHQ_ESTABLISHED_HISTORY_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
export const TEJHQ_ADJUSTED_HISTORY_CACHE_TTL_SECONDS = 60 * 60;
export const TEJHQ_ACTIONS_CACHE_TTL_SECONDS = 6 * 60 * 60;
export const TEJHQ_SYMBOLS_CACHE_TTL_SECONDS = 24 * 60 * 60;
export const TEJHQ_STATUS_CACHE_TTL_SECONDS = 15 * 60;

const ISIN_PATTERN = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
const SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9&-]{0,29}$/;
const ACTION_TYPES = new Set(['dividend', 'split', 'bonus', 'rights', 'buyback', 'demerger', 'merger', 'agm', 'other']);
const MAX_SAFE_PRICE = Number.MAX_SAFE_INTEGER;

export class TejHqDataContractError extends Error {
  constructor(code) {
    super(code);
    this.name = 'TejHqDataContractError';
    this.code = code;
  }
}

function requireIsoDate(value, field) {
  const text = String(value || '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw new TypeError(`${field} must use YYYY-MM-DD format.`);
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (month < 1 || month > 12 || day < 1
      || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new TypeError(`${field} must use YYYY-MM-DD format.`);
  }
  return text;
}

export function normalizeTejHqIdentity({ exchange, symbol, isin = null } = {}) {
  const normalizedExchange = String(exchange || '').trim().toUpperCase();
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  const normalizedIsin = isin === null || isin === undefined || String(isin).trim() === ''
    ? null
    : String(isin).trim().toUpperCase();
  if (!['NSE', 'BSE'].includes(normalizedExchange)) throw new TypeError('exchange must be NSE or BSE.');
  if (!SYMBOL_PATTERN.test(normalizedSymbol)) throw new TypeError('symbol does not match the TejHQ trading-symbol format.');
  if (normalizedIsin !== null && !ISIN_PATTERN.test(normalizedIsin)) throw new TypeError('isin must be a 12-character ISIN.');
  return { exchange: normalizedExchange, symbol: normalizedSymbol, isin: normalizedIsin };
}

function normalizeHistoryRequest({ exchange, symbol, isin = null, fromDate, toDate } = {}) {
  const identity = normalizeTejHqIdentity({ exchange, symbol, isin });
  const normalizedFromDate = requireIsoDate(fromDate, 'fromDate');
  const normalizedToDate = requireIsoDate(toDate, 'toDate');
  if (normalizedFromDate > normalizedToDate) throw new RangeError('fromDate must not be after toDate.');
  const days = (Date.parse(`${normalizedToDate}T00:00:00.000Z`) - Date.parse(`${normalizedFromDate}T00:00:00.000Z`)) / 86_400_000 + 1;
  if (days > TEJHQ_MAX_HISTORY_DAYS) throw new RangeError(`TejHQ history is limited to ${TEJHQ_MAX_HISTORY_DAYS} calendar days per request.`);
  return { ...identity, fromDate: normalizedFromDate, toDate: normalizedToDate };
}

function normalizePositive(value) {
  const parsed = nullableFiniteNumber(value);
  return parsed !== null && parsed > 0 && parsed <= MAX_SAFE_PRICE ? parsed : null;
}

function normalizeNonNegativeInteger(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

function validateEnvelope(payload, { exchange, symbol, fromDate, toDate } = {}) {
  if (!payload || !Array.isArray(payload.data) || !payload.meta || typeof payload.meta !== 'object') {
    throw new TejHqDataContractError('TEJHQ_RESPONSE_SCHEMA_INVALID');
  }
  const metaExchange = String(payload.meta.exchange || '').toUpperCase();
  const metaSymbol = String(payload.meta.symbol || '').toUpperCase();
  if (metaExchange !== exchange || metaSymbol !== symbol) {
    throw new TejHqDataContractError('TEJHQ_SOURCE_IDENTITY_MISMATCH');
  }
  if (payload.meta.from !== fromDate || payload.meta.to !== toDate) {
    throw new TejHqDataContractError('TEJHQ_RESPONSE_RANGE_MISMATCH');
  }
  if (!Number.isSafeInteger(payload.meta.count) || payload.meta.count !== payload.data.length) {
    throw new TejHqDataContractError('TEJHQ_RESPONSE_COUNT_MISMATCH');
  }
  if (payload.data.length > TEJHQ_MAX_HISTORY_ROWS) {
    throw new TejHqDataContractError('TEJHQ_RESPONSE_TOO_LARGE');
  }
  return payload.data;
}

function normalizeCandleRows(rows, {
  isin = null,
  fromDate,
  toDate,
  now,
  adjusted = false,
} = {}) {
  const candles = [];
  let previousDate = null;
  const currentDate = now.toISOString().slice(0, 10);
  for (const row of rows) {
    const date = requireIsoDate(row?.date, 'row.date');
    if (date < fromDate || date > toDate) throw new TejHqDataContractError('TEJHQ_ROW_DATE_OUT_OF_RANGE');
    if (date > currentDate) throw new TejHqDataContractError('TEJHQ_FUTURE_DATED_ROW');
    if (previousDate && date === previousDate) throw new TejHqDataContractError('TEJHQ_DUPLICATE_TRADING_DATE');
    if (previousDate && date < previousDate) throw new TejHqDataContractError('TEJHQ_ROWS_OUT_OF_ORDER');
    previousDate = date;

    const open = normalizePositive(row.open);
    const high = normalizePositive(row.high);
    const low = normalizePositive(row.low);
    const close = normalizePositive(row.close);
    const volume = normalizeNonNegativeInteger(row.volume);
    if (open === null || high === null || low === null || close === null || volume === null
        || high < Math.max(open, close, low) || low > Math.min(open, close)) {
      throw new TejHqDataContractError('TEJHQ_INVALID_OHLCV_ROW');
    }

    const candle = {
      date,
      timestamp: null,
      open,
      high,
      low,
      close,
      volume,
      turnover: row.turnover === null || row.turnover === undefined ? null : nullableFiniteNumber(row.turnover),
      trades: row.trades === null || row.trades === undefined ? null : normalizeNonNegativeInteger(row.trades),
      ...(row.isin ? { isin: String(row.isin).toUpperCase() } : {}),
    };
    if (row.isin && (!ISIN_PATTERN.test(candle.isin) || (isin && candle.isin !== isin))) {
      throw new TejHqDataContractError('TEJHQ_SOURCE_ISIN_MISMATCH');
    }
    if (row.turnover !== null && row.turnover !== undefined
        && (candle.turnover === null || !Number.isFinite(candle.turnover) || candle.turnover < 0 || candle.turnover > Number.MAX_SAFE_INTEGER)) {
      throw new TejHqDataContractError('TEJHQ_INVALID_TURNOVER');
    }
    if (row.trades !== null && row.trades !== undefined && candle.trades === null) {
      throw new TejHqDataContractError('TEJHQ_INVALID_TRADE_COUNT');
    }
    if (adjusted) {
      const adjustmentFactor = normalizePositive(row.adj_factor_cumulative);
      const adjustedClose = normalizePositive(row.adj_close);
      const expectedAdjustedClose = close * (adjustmentFactor ?? NaN);
      const tolerance = Number.isFinite(expectedAdjustedClose) ? Math.max(0.01, expectedAdjustedClose * 1e-6) : 0;
      if (adjustmentFactor === null || adjustedClose === null
          || !Number.isFinite(expectedAdjustedClose)
          || Math.abs(expectedAdjustedClose - adjustedClose) > tolerance) {
        throw new TejHqDataContractError('TEJHQ_ADJUSTMENT_FACTOR_MISMATCH');
      }
      if (isin && candle.isin && candle.isin !== isin) {
        throw new TejHqDataContractError('TEJHQ_SOURCE_ISIN_MISMATCH');
      }
      candle.adjustmentFactor = adjustmentFactor;
      candle.adjustedClose = adjustedClose;
    }
    candles.push(candle);
  }
  return candles;
}

function freshnessUnknown() {
  return { status: FRESHNESS.UNKNOWN, ageSeconds: null, maxAgeSeconds: null, reasonCode: 'TEJHQ_DATE_ONLY_OBSERVATION' };
}

function buildHistoricalSnapshot({ payload, request, fetchedAt, now, sourceUrl, adjusted = false }) {
  const rows = validateEnvelope(payload, request);
  const candles = normalizeCandleRows(rows, { ...request, now, adjusted });
  const canonicalProductId = request.isin
    ? `market:equity:${request.exchange.toLowerCase()}:${request.isin}`
    : null;
  return {
    schemaVersion: MARKET_DATA_SCHEMA_VERSION,
    provider: PROVIDERS.TEJHQ,
    status: candles.length > 0 ? AVAILABILITY.AVAILABLE : AVAILABILITY.UNAVAILABLE,
    ...(canonicalProductId ? { canonicalProductId } : {}),
    instrumentKey: `${request.exchange}:${request.symbol}`,
    instrumentIdentity: { exchange: request.exchange, tradingSymbol: request.symbol, isin: request.isin },
    identityStatus: request.isin ? 'SYMBOL_HISTORY_REQUIRED_FOR_QUALIFICATION' : 'PROVIDER_META_ONLY',
    interval: '1 day',
    dataClass: 'HISTORICAL_EOD',
    priceBasis: adjusted ? 'BACK_ADJUSTED' : 'RAW_UNADJUSTED',
    ...(adjusted ? { adjustmentSemantics: 'SPLITS_BONUSES_AND_DIVIDENDS' } : {}),
    sourceDatasetRevision: TEJHQ_DATASET_CONTRACT_REVISION,
    fetchedAt,
    observedAt: null,
    observedDate: candles.at(-1)?.date ?? null,
    effectiveTradingDate: candles.at(-1)?.date ?? null,
    freshness: freshnessUnknown(),
    candleCount: candles.length,
    candles,
    source: { provider: PROVIDERS.TEJHQ, instrumentId: `${request.exchange}:${request.symbol}`, url: sourceUrl },
    sourceAttribution: {
      provider: PROVIDERS.TEJHQ,
      sourceUrl: TEJHQ_API_DOCUMENTATION_URL,
      upstreamData: 'NSE/BSE exchange-published end-of-day equity Bhavcopy',
    },
    fallbackUsed: false,
    providerPublicationStatus: 'NOT_ATTACHED',
    reasonCodes: candles.length > 0 ? [] : ['TEJHQ_NO_OBSERVATION'],
  };
}

function validateActionDate(value, now, code) {
  const date = requireIsoDate(value, 'action date');
  if (date > now.toISOString().slice(0, 10)) throw new TejHqDataContractError(code);
  return date;
}

function optionalPositive(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = nullableFiniteNumber(value);
  return parsed !== null && parsed > 0 && parsed <= Number.MAX_SAFE_INTEGER ? parsed : NaN;
}

function optionalRatio(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 1000 ? parsed : NaN;
}

function actionIdentity(event) {
  return [event.exchange, event.isin || event.symbol, event.exDate, event.type, event.rawSubject || ''].join('|');
}

export function parseTejHqOhlcvEnvelope(payload, options = {}) {
  const request = normalizeHistoryRequest(options);
  const fetchedAt = normalizeTimestamp(options.fetchedAt);
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const sourceUrl = options.sourceUrl || `${TEJHQ_API_BASE_URL}/v1/ohlcv/${request.exchange.toLowerCase()}/${request.symbol}`;
  if (!fetchedAt) throw new TypeError('fetchedAt must be a valid timestamp.');
  return buildHistoricalSnapshot({ payload, request, fetchedAt, now, sourceUrl });
}

export function parseTejHqAdjustedEnvelope(payload, options = {}) {
  const request = normalizeHistoryRequest(options);
  if (!request.isin) throw new TypeError('Adjusted history requires a qualified ISIN.');
  const fetchedAt = normalizeTimestamp(options.fetchedAt);
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const sourceUrl = options.sourceUrl || `${TEJHQ_API_BASE_URL}/v1/adjusted/${request.exchange.toLowerCase()}/${request.symbol}`;
  if (!fetchedAt) throw new TypeError('fetchedAt must be a valid timestamp.');
  return buildHistoricalSnapshot({ payload, request, fetchedAt, now, sourceUrl, adjusted: true });
}

export function parseTejHqSymbolHistoryEnvelope(payload, { exchange, isin, fetchedAt, sourceUrl: requestUrl } = {}) {
  const normalizedExchange = String(exchange || '').trim().toUpperCase();
  const normalizedIsin = String(isin || '').trim().toUpperCase();
  const normalizedFetchedAt = normalizeTimestamp(fetchedAt);
  if (!['NSE', 'BSE'].includes(normalizedExchange) || !ISIN_PATTERN.test(normalizedIsin) || !normalizedFetchedAt) {
    throw new TypeError('Qualified exchange, ISIN, and fetchedAt are required.');
  }
  if (!payload || !Array.isArray(payload.data) || payload.data.length > 10_000) {
    throw new TejHqDataContractError('TEJHQ_SYMBOL_HISTORY_SCHEMA_INVALID');
  }
  const exactRows = new Map();
  const intervals = [];
  for (const row of payload.data) {
    const rowExchange = String(row?.exchange || '').toUpperCase();
    const rowIsin = String(row?.isin || '').toUpperCase();
    const symbol = String(row?.symbol || '').toUpperCase();
    if (rowExchange !== normalizedExchange || rowIsin !== normalizedIsin || !ISIN_PATTERN.test(rowIsin)
        || !SYMBOL_PATTERN.test(symbol)) {
      throw new TejHqDataContractError('TEJHQ_SYMBOL_IDENTITY_MISMATCH');
    }
    const validFrom = requireIsoDate(row.valid_from, 'valid_from');
    const validTo = requireIsoDate(row.valid_to, 'valid_to');
    const tradingDays = normalizeNonNegativeInteger(row.trading_days);
    if (validFrom > validTo || tradingDays === null || tradingDays < 1) {
      throw new TejHqDataContractError('TEJHQ_SYMBOL_INTERVAL_INVALID');
    }
    const interval = { exchange: rowExchange, isin: rowIsin, symbol, validFrom, validTo, tradingDays };
    const key = `${rowExchange}|${rowIsin}|${symbol}|${validFrom}|${validTo}`;
    const previous = exactRows.get(key);
    if (previous) {
      if (previous.tradingDays !== tradingDays) throw new TejHqDataContractError('TEJHQ_SYMBOL_INTERVAL_CONFLICT');
      continue;
    }
    exactRows.set(key, interval);
    intervals.push(interval);
  }
  intervals.sort((a, b) => a.validFrom.localeCompare(b.validFrom) || a.validTo.localeCompare(b.validTo));
  for (let index = 1; index < intervals.length; index += 1) {
    if (intervals[index].validFrom <= intervals[index - 1].validTo) {
      throw new TejHqDataContractError('TEJHQ_SYMBOL_INTERVAL_OVERLAP');
    }
  }
  return {
    schemaVersion: MARKET_DATA_SCHEMA_VERSION,
    provider: PROVIDERS.TEJHQ,
    status: intervals.length ? AVAILABILITY.AVAILABLE : AVAILABILITY.UNAVAILABLE,
    exchange: normalizedExchange,
    isin: normalizedIsin,
    fetchedAt: normalizedFetchedAt,
    intervals,
    sourceDatasetRevision: TEJHQ_DATASET_CONTRACT_REVISION,
    source: {
      provider: PROVIDERS.TEJHQ,
      instrumentId: `${normalizedExchange}:${normalizedIsin}`,
      url: requestUrl || sourceUrl(`/v1/symbols/${normalizedExchange.toLowerCase()}`, { isin: normalizedIsin }),
    },
    identityStatus: intervals.length ? 'SOURCE_INTERVALS_VALIDATED' : 'UNAVAILABLE',
  };
}

export function parseTejHqActionsEnvelope(payload, { symbol, now = new Date(), fetchedAt } = {}) {
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  const normalizedFetchedAt = normalizeTimestamp(fetchedAt);
  if (!SYMBOL_PATTERN.test(normalizedSymbol) || !normalizedFetchedAt) {
    throw new TypeError('A valid symbol and fetchedAt are required.');
  }
  if (!payload || !Array.isArray(payload.data) || payload.data.length > 10_000) {
    throw new TejHqDataContractError('TEJHQ_ACTIONS_SCHEMA_INVALID');
  }
  const current = now instanceof Date ? now : new Date(now);
  const seen = new Map();
  const events = [];
  for (const row of payload.data) {
    const exchange = String(row?.exchange || '').toUpperCase();
    const rowSymbol = String(row?.symbol || '').toUpperCase();
    const isin = row?.isin ? String(row.isin).toUpperCase() : null;
    const type = String(row?.type || '').trim().toLowerCase();
    if (!['NSE', 'BSE'].includes(exchange) || !SYMBOL_PATTERN.test(rowSymbol)
        || (isin && !ISIN_PATTERN.test(isin)) || !ACTION_TYPES.has(type)) {
      throw new TejHqDataContractError('TEJHQ_ACTION_IDENTITY_OR_TYPE_INVALID');
    }
    const exDate = validateActionDate(row.ex_date, current, 'TEJHQ_FUTURE_ACTION_DATE');
    const recordDate = row.record_date ? requireIsoDate(row.record_date, 'record_date') : null;
    if (recordDate && (recordDate < exDate || recordDate > current.toISOString().slice(0, 10))) {
      throw new TejHqDataContractError('TEJHQ_ACTION_CHRONOLOGY_INVALID');
    }
    const ratioNumerator = optionalRatio(row.ratio_num);
    const ratioDenominator = optionalRatio(row.ratio_den);
    const faceValueFrom = optionalPositive(row.face_value_from);
    const faceValueTo = optionalPositive(row.face_value_to);
    const cashAmount = optionalPositive(row.cash_amount);
    if ([ratioNumerator, ratioDenominator].some(Number.isNaN)) {
      throw new TejHqDataContractError('TEJHQ_ACTION_RATIO_INVALID');
    }
    if ([faceValueFrom, faceValueTo, cashAmount].some(Number.isNaN)) {
      throw new TejHqDataContractError('TEJHQ_ACTION_VALUE_INVALID');
    }
    if (type === 'split' && !((ratioNumerator && ratioDenominator) || (faceValueFrom && faceValueTo))) {
      throw new TejHqDataContractError('TEJHQ_SPLIT_RATIO_MISSING');
    }
    if ((type === 'bonus' || type === 'rights') && !(ratioNumerator && ratioDenominator)) {
      throw new TejHqDataContractError('TEJHQ_ACTION_RATIO_MISSING');
    }
    const event = {
      exchange,
      symbol: rowSymbol,
      isin,
      company: typeof row.company === 'string' ? row.company : null,
      type,
      exDate,
      recordDate,
      ratioNumerator,
      ratioDenominator,
      cashAmount,
      faceValueFrom,
      faceValueTo,
      rawSubject: typeof row.raw_subject === 'string' ? row.raw_subject.slice(0, 1000) : null,
      observedAt: null,
    };
    const identity = actionIdentity(event);
    const comparable = JSON.stringify(event);
    if (seen.has(identity)) {
      if (seen.get(identity) !== comparable) throw new TejHqDataContractError('TEJHQ_CONFLICTING_ACTION_DUPLICATE');
      continue;
    }
    seen.set(identity, comparable);
    events.push(event);
  }
  events.sort((a, b) => a.exDate.localeCompare(b.exDate) || a.exchange.localeCompare(b.exchange) || a.type.localeCompare(b.type));
  return {
    schemaVersion: MARKET_DATA_SCHEMA_VERSION,
    provider: PROVIDERS.TEJHQ,
    status: events.length ? AVAILABILITY.AVAILABLE : AVAILABILITY.UNAVAILABLE,
    symbol: normalizedSymbol,
    fetchedAt: normalizedFetchedAt,
    events,
    completeness: 'NOT_CONCLUSIVE',
    identityStatus: 'EXCHANGE_AND_ISIN_REQUIRED_FOR_PRODUCT_BINDING',
    sourceDatasetRevision: TEJHQ_DATASET_CONTRACT_REVISION,
    source: { provider: PROVIDERS.TEJHQ, instrumentId: normalizedSymbol, url: `${TEJHQ_API_BASE_URL}/v1/actions/${normalizedSymbol}` },
    reasonCodes: events.length ? ['TEJHQ_ACTION_FEED_NOT_CONCLUSIVE'] : ['TEJHQ_NO_ACTION_OBSERVATIONS'],
  };
}

export function parseTejHqStatus(payload, { fetchedAt, now = new Date() } = {}) {
  const normalizedFetchedAt = normalizeTimestamp(fetchedAt);
  const current = now instanceof Date ? now : new Date(now);
  if (!normalizedFetchedAt || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TejHqDataContractError('TEJHQ_STATUS_SCHEMA_INVALID');
  }
  const tradingDate = requireIsoDate(payload.trading_date, 'trading_date');
  const nowDate = current.toISOString().slice(0, 10);
  if (tradingDate > nowDate) throw new TejHqDataContractError('TEJHQ_FUTURE_STATUS_DATE');
  const pricesPublishedAt = normalizeTimestamp(payload.prices_published_at);
  const derivedPublishedAt = normalizeTimestamp(payload.derived_published_at);
  const generatedAt = normalizeTimestamp(payload.generated_at);
  if (!pricesPublishedAt || !generatedAt || (payload.derived_published_at && !derivedPublishedAt)) {
    throw new TejHqDataContractError('TEJHQ_STATUS_TIMESTAMP_INVALID');
  }
  const fetchedMs = Date.parse(normalizedFetchedAt);
  if ([pricesPublishedAt, derivedPublishedAt, generatedAt].filter(Boolean).some(timestamp => Date.parse(timestamp) > fetchedMs)) {
    throw new TejHqDataContractError('TEJHQ_FUTURE_PUBLICATION_TIMESTAMP');
  }
  return {
    schemaVersion: MARKET_DATA_SCHEMA_VERSION,
    provider: PROVIDERS.TEJHQ,
    status: AVAILABILITY.AVAILABLE,
    fetchedAt: normalizedFetchedAt,
    serviceReachability: 'REACHABLE',
    publication: {
      datasetTradingDate: tradingDate,
      pricesPublishedAt,
      rawDatasetStatus: 'PUBLISHED',
      derivedPublishedAt,
      derivedDatasetStatus: derivedPublishedAt ? 'PUBLISHED' : 'NOT_REPORTED',
      expectedSessionStatus: 'UNKNOWN',
      expectedSessionReason: 'No qualified exchange-session calendar is supplied by the provider status endpoint.',
      stage: typeof payload.stage === 'string' ? payload.stage.slice(0, 40) : null,
    },
    source: { provider: PROVIDERS.TEJHQ, instrumentId: 'publication-status', url: `${TEJHQ_API_BASE_URL}/v1/status` },
  };
}

function errorCodeFor(error) {
  if (error instanceof TejHqDataContractError) return error.code;
  const status = Number(error?.response?.status);
  if (status === 401) return 'TEJHQ_AUTHENTICATION_FAILED';
  if (status === 403) return 'TEJHQ_PERMISSION_DENIED';
  if (status === 404) return 'TEJHQ_INSTRUMENT_OR_ENDPOINT_UNAVAILABLE';
  if (status === 402) return 'TEJHQ_PAID_CAPABILITY_UNAVAILABLE';
  if (status === 429) return 'TEJHQ_RATE_LIMITED';
  if (status >= 500) return 'TEJHQ_PROVIDER_UNAVAILABLE';
  if (['ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(error?.code)) return 'TEJHQ_TIMEOUT';
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED'].includes(error?.code)) {
    return 'TEJHQ_NETWORK_OR_TLS_ERROR';
  }
  if (['ERR_FR_MAX_BODY_LENGTH_EXCEEDED', 'ERR_BAD_RESPONSE', 'ERR_BAD_REQUEST'].includes(error?.code)
      || error instanceof SyntaxError) return 'TEJHQ_RESPONSE_INVALID';
  return 'TEJHQ_REQUEST_FAILED';
}

const ERROR_MESSAGES = Object.freeze({
  TEJHQ_DISABLED: 'TejHQ market data is disabled by server configuration.',
  TEJHQ_LICENSE_NOT_CONFIRMED: 'TejHQ market data remains disabled until its permitted use is explicitly confirmed by an operator.',
  TEJHQ_KEY_NOT_CONFIGURED: 'TejHQ keyed market-data capability is not configured.',
  TEJHQ_AUTHENTICATION_FAILED: 'TejHQ rejected the configured API credential; keyed requests are paused until server restart after credential correction.',
  TEJHQ_PERMISSION_DENIED: 'TejHQ denied access to this free-key capability.',
  TEJHQ_INSTRUMENT_OR_ENDPOINT_UNAVAILABLE: 'TejHQ did not provide the requested instrument or endpoint.',
  TEJHQ_PAID_CAPABILITY_UNAVAILABLE: 'The requested TejHQ capability is outside the configured free tier; no paid fallback was attempted.',
  TEJHQ_RATE_LIMITED: 'TejHQ rate-limited the request; keyed retries are temporarily paused.',
  TEJHQ_PROVIDER_UNAVAILABLE: 'TejHQ market data is temporarily unavailable.',
  TEJHQ_TIMEOUT: 'The TejHQ market-data request timed out.',
  TEJHQ_NETWORK_OR_TLS_ERROR: 'The TejHQ network or TLS request failed.',
  TEJHQ_RESPONSE_INVALID: 'TejHQ returned a response that did not match the bounded API contract.',
  TEJHQ_REQUEST_FAILED: 'The TejHQ market-data request failed.',
  TEJHQ_INTERNAL_DAILY_BUDGET_EXHAUSTED: 'The application daily TejHQ keyed-request budget is exhausted.',
  TEJHQ_BUDGET_STORE_UNAVAILABLE: 'The shared TejHQ keyed-request budget cannot be verified.',
  TEJHQ_BUDGET_CONFIG_INVALID: 'The TejHQ internal keyed-request budget configuration is invalid.',
  TEJHQ_BUDGET_CLOCK_INVALID: 'The TejHQ request budget clock is unavailable.',
  TEJHQ_BUDGET_STORE_INVALID: 'The shared TejHQ keyed-request budget returned invalid state.',
  TEJHQ_FEATURE_DISABLED: 'The requested TejHQ capability is disabled by server configuration.',
});

function safeError(errorOrCode) {
  const code = typeof errorOrCode === 'string' ? errorOrCode : errorCodeFor(errorOrCode);
  return { code, message: ERROR_MESSAGES[code] || 'The TejHQ market-data request failed.' };
}

function safeHeaders(headers = {}) {
  const read = name => headers[name] ?? headers[name.toLowerCase()] ?? null;
  const rawLimit = read('x-ratelimit-limit-day');
  const rawRemaining = read('x-ratelimit-remaining-day');
  const limit = rawLimit === null ? NaN : Number(rawLimit);
  const remaining = rawRemaining === null ? NaN : Number(rawRemaining);
  return {
    ...(Number.isSafeInteger(limit) && limit >= 0 && limit <= 1000 ? { limitPerDay: limit } : {}),
    ...(Number.isSafeInteger(remaining) && remaining >= 0 && remaining <= 1000 ? { remainingPerDay: remaining } : {}),
  };
}

function sourceUrl(path, params = {}) {
  const url = new URL(path, TEJHQ_API_BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function cacheKeyFor(operation, identity) {
  const digest = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  return `market:tejhq:${operation}:${MARKET_DATA_SCHEMA_VERSION}:${TEJHQ_DATASET_CONTRACT_REVISION}:${digest}`;
}

function cacheTtlFor(request, now, adjusted = false) {
  if (adjusted) return TEJHQ_ADJUSTED_HISTORY_CACHE_TTL_SECONDS;
  const today = now.toISOString().slice(0, 10);
  const ageDays = (Date.parse(`${today}T00:00:00.000Z`) - Date.parse(`${request.toDate}T00:00:00.000Z`)) / 86_400_000;
  return ageDays > 7 ? TEJHQ_ESTABLISHED_HISTORY_CACHE_TTL_SECONDS : TEJHQ_RECENT_HISTORY_CACHE_TTL_SECONDS;
}

function errorSnapshot({ fetchedAt, source, code, provider = PROVIDERS.TEJHQ, identity = null, quotaObservation = null }) {
  const error = safeError(code);
  return {
    schemaVersion: MARKET_DATA_SCHEMA_VERSION,
    provider,
    status: code === 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED'
      ? AVAILABILITY.UNAVAILABLE
      : ['TEJHQ_DISABLED', 'TEJHQ_LICENSE_NOT_CONFIRMED', 'TEJHQ_KEY_NOT_CONFIGURED'].includes(code)
        ? AVAILABILITY.PROVIDER_NOT_CONFIGURED
        : AVAILABILITY.SOURCE_ERROR,
    ...(identity ? { ...identity } : {}),
    fetchedAt,
    observedAt: null,
    observedDate: null,
    effectiveTradingDate: null,
    freshness: freshnessUnknown(),
    candleCount: code === 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED' ? null : 0,
    candles: [],
    source,
    fallbackUsed: false,
    reasonCodes: [code],
    error,
    ...(quotaObservation ? { quotaObservation } : {}),
  };
}

export default class TejHqHistoricalDataProvider extends MarketDataProvider {
  constructor(options = {}) {
    const {
      apiKey = undefined,
      env = process.env,
      httpClient = axios,
      clock = () => new Date(),
      budget = consumeTejHqKeyedRequest,
      requestCache = readThroughMarketCache,
    } = options;
    super({
      providerName: PROVIDERS.TEJHQ,
      httpClient,
      clock,
      env,
    });
    this.env = env;
    this.apiKey = String(apiKey ?? env.TEJHQ_API_KEY ?? '').trim();
    this.configuredEnabled = env.TEJHQ_ENABLED === 'true';
    this.licenseConfirmed = env.TEJHQ_LICENSE_CONFIRMED === 'true';
    this.enabled = this.configuredEnabled && this.licenseConfirmed;
    this.budget = budget;
    this.requestCache = requestCache;
    this.keyFingerprint = this.apiKey ? crypto.createHash('sha256').update(this.apiKey).digest('hex') : null;
    this.invalidKeyFingerprint = null;
    this.disabledKeyedOperations = new Set();
    this.quotaExhaustedDay = null;
    this.rateLimitedUntilMs = 0;
  }

  isConfigured() {
    return this.enabled;
  }

  async getRawHistory(options = {}) {
    const request = normalizeHistoryRequest(options);
    const path = `/v1/ohlcv/${request.exchange.toLowerCase()}/${encodeURIComponent(request.symbol)}`;
    return this.#fetch({
      operation: 'ohlcv', path, params: { from: request.fromDate, to: request.toDate }, request,
      cacheTtlSeconds: cacheTtlFor(request, this.clock()),
      parse: (data, meta) => parseTejHqOhlcvEnvelope(data, { ...request, ...meta }),
      enabledFlag: 'TEJHQ_HISTORICAL_FALLBACK_ENABLED',
    });
  }

  async getAdjustedHistory(options = {}) {
    const request = normalizeHistoryRequest(options);
    if (!request.isin) throw new TypeError('Adjusted history requires a qualified ISIN.');
    const path = `/v1/adjusted/${request.exchange.toLowerCase()}/${encodeURIComponent(request.symbol)}`;
    return this.#fetch({
      operation: 'adjusted', path, params: { from: request.fromDate, to: request.toDate }, request,
      keyed: true,
      cacheTtlSeconds: TEJHQ_ADJUSTED_HISTORY_CACHE_TTL_SECONDS,
      parse: (data, meta) => parseTejHqAdjustedEnvelope(data, { ...request, ...meta }),
      enabledFlag: 'TEJHQ_ADJUSTED_HISTORY_ENABLED',
    });
  }

  async getSymbolHistory({ exchange, isin, forceRefresh = false } = {}) {
    const normalizedExchange = String(exchange || '').trim().toUpperCase();
    const normalizedIsin = String(isin || '').trim().toUpperCase();
    if (!['NSE', 'BSE'].includes(normalizedExchange) || !ISIN_PATTERN.test(normalizedIsin)) {
      throw new TypeError('A qualified NSE/BSE exchange and ISIN are required for symbol history.');
    }
    const path = `/v1/symbols/${normalizedExchange.toLowerCase()}`;
    return this.#fetch({
      operation: 'symbols', path, params: { isin: normalizedIsin },
      identity: { exchange: normalizedExchange, isin: normalizedIsin },
      keyed: true,
      forceRefresh,
      cacheTtlSeconds: TEJHQ_SYMBOLS_CACHE_TTL_SECONDS,
      parse: (data, meta) => parseTejHqSymbolHistoryEnvelope(data, { exchange: normalizedExchange, isin: normalizedIsin, ...meta }),
      enabledFlag: ['TEJHQ_HISTORICAL_FALLBACK_ENABLED', 'TEJHQ_ADJUSTED_HISTORY_ENABLED'],
    });
  }

  async getCorporateActions({ symbol, forceRefresh = false } = {}) {
    const normalizedSymbol = String(symbol || '').trim().toUpperCase();
    if (!SYMBOL_PATTERN.test(normalizedSymbol)) throw new TypeError('symbol does not match the TejHQ trading-symbol format.');
    const path = `/v1/actions/${encodeURIComponent(normalizedSymbol)}`;
    return this.#fetch({
      operation: 'actions', path, params: {}, identity: { symbol: normalizedSymbol }, forceRefresh,
      cacheTtlSeconds: TEJHQ_ACTIONS_CACHE_TTL_SECONDS,
      parse: (data, meta) => parseTejHqActionsEnvelope(data, { symbol: normalizedSymbol, ...meta }),
      enabledFlag: 'TEJHQ_CORPORATE_ACTIONS_ENABLED',
    });
  }

  async getStatus({ forceRefresh = false } = {}) {
    return this.#fetch({
      operation: 'status', path: '/v1/status', params: {}, forceRefresh,
      cacheTtlSeconds: TEJHQ_STATUS_CACHE_TTL_SECONDS,
      parse: (data, meta) => parseTejHqStatus(data, meta),
      enabledFlag: 'TEJHQ_ENABLED',
    });
  }

  #disabledSnapshot({ path, params, identity, code }) {
    const url = sourceUrl(path, params);
    return errorSnapshot({ fetchedAt: this.nowIso(), source: { provider: PROVIDERS.TEJHQ, url }, code, identity });
  }

  #keyedUnavailableCode(operation) {
    const now = this.clock();
    const day = now.toISOString().slice(0, 10);
    if (this.invalidKeyFingerprint && this.invalidKeyFingerprint === this.keyFingerprint) return 'TEJHQ_AUTHENTICATION_FAILED';
    if (this.disabledKeyedOperations.has(operation)) return 'TEJHQ_PAID_CAPABILITY_UNAVAILABLE';
    if (this.quotaExhaustedDay === day) return 'TEJHQ_INTERNAL_DAILY_BUDGET_EXHAUSTED';
    if (this.rateLimitedUntilMs > now.getTime()) return 'TEJHQ_RATE_LIMITED';
    return null;
  }

  #recordProviderResponse(response, keyed) {
    if (!keyed) return {};
    const quotaObservation = safeHeaders(response?.headers);
    if (quotaObservation.remainingPerDay === 0) this.quotaExhaustedDay = this.clock().toISOString().slice(0, 10);
    return quotaObservation;
  }

  #recordProviderFailure(operation, code, error) {
    if (code === 'TEJHQ_AUTHENTICATION_FAILED' && this.keyFingerprint) {
      this.invalidKeyFingerprint = this.keyFingerprint;
    }
    if (code === 'TEJHQ_PAID_CAPABILITY_UNAVAILABLE') this.disabledKeyedOperations.add(operation);
    if (code === 'TEJHQ_RATE_LIMITED') {
      const retryAfter = Number(error?.response?.headers?.['retry-after']);
      const cooldownMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 60 * 60 * 1000)
        : 60 * 1000;
      this.rateLimitedUntilMs = this.clock().getTime() + cooldownMs;
    }
  }

  async #fetch({
    operation,
    path,
    params,
    identity = null,
    request = null,
    keyed = false,
    forceRefresh = false,
    cacheTtlSeconds,
    parse,
    enabledFlag,
  }) {
    const url = sourceUrl(path, params);
    const normalizedIdentity = identity || (request ? {
      instrumentKey: `${request.exchange}:${request.symbol}`,
      ...(request.isin ? { canonicalProductId: `market:equity:${request.exchange.toLowerCase()}:${request.isin}` } : {}),
    } : null);
    if (!isMarketDataProductionUseAllowed(
      PROVIDERS.TEJHQ,
      url,
      this.env,
      this.marketDataTestFixtureRightsCapability,
    )) {
      const rights = evaluateMarketDataProductionRights(PROVIDERS.TEJHQ, url);
      return {
        ...this.#disabledSnapshot({
          operation,
          path,
          params,
          identity: normalizedIdentity,
          code: 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED',
        }),
        sourceRights: { status: rights.status, sourceId: rights.sourceId, productionUseAllowed: false },
        cache: { hit: false, backend: 'NONE', status: 'NOT_READ_SOURCE_RIGHTS_BLOCKED' },
      };
    }
    const cacheKey = cacheKeyFor(operation, { params, identity: normalizedIdentity });
    const featureEnabled = (Array.isArray(enabledFlag) ? enabledFlag : [enabledFlag])
      .some(flag => this.env[flag] === 'true');
    if (!this.enabled || !featureEnabled) {
      const code = !this.configuredEnabled
        ? 'TEJHQ_DISABLED'
        : !this.licenseConfirmed ? 'TEJHQ_LICENSE_NOT_CONFIRMED' : 'TEJHQ_FEATURE_DISABLED';
      return this.#disabledSnapshot({ operation, path, params, identity: normalizedIdentity, code });
    }
    if (keyed && !this.apiKey) {
      return this.#disabledSnapshot({ operation, path, params, identity: normalizedIdentity, code: 'TEJHQ_KEY_NOT_CONFIGURED' });
    }
    if (keyed) {
      const pausedCode = this.#keyedUnavailableCode(operation);
      if (pausedCode) return this.#disabledSnapshot({ operation, path, params, identity: normalizedIdentity, code: pausedCode });
    }

    return this.requestCache({
      cacheKey,
      ttlSeconds: cacheTtlSeconds,
      forceRefresh,
      shouldCache: result => result?.status === AVAILABILITY.AVAILABLE
        || (result?.status === AVAILABILITY.UNAVAILABLE && result?.reasonCodes?.includes('TEJHQ_NO_OBSERVATION')),
      loader: async () => {
        const requestFetchedAt = this.nowIso();
        let quotaObservation = null;
        if (keyed) {
          const budget = await this.budget();
          if (!budget?.allowed) {
            return errorSnapshot({
              fetchedAt: requestFetchedAt,
              source: { provider: PROVIDERS.TEJHQ, url },
              code: budget?.code || 'TEJHQ_BUDGET_STORE_UNAVAILABLE',
              identity: normalizedIdentity,
            });
          }
        }
        try {
          const response = await this.httpClient.get(url, {
            params: undefined,
            timeout: 8000,
            maxRedirects: 0,
            maxContentLength: TEJHQ_MAX_RESPONSE_BYTES,
            maxBodyLength: TEJHQ_MAX_RESPONSE_BYTES,
            headers: {
              Accept: 'application/json',
              ...(keyed ? { Authorization: `Bearer ${this.apiKey}` } : {}),
            },
          });
          quotaObservation = this.#recordProviderResponse(response, keyed);
          const parsed = parse(response.data, { fetchedAt: requestFetchedAt, now: this.clock(), sourceUrl: url });
          return { ...parsed, ...(Object.keys(quotaObservation).length ? { quotaObservation } : {}) };
        } catch (error) {
          const code = errorCodeFor(error);
          this.#recordProviderFailure(operation, code, error);
          return errorSnapshot({
            fetchedAt: requestFetchedAt,
            source: { provider: PROVIDERS.TEJHQ, url },
            code,
            identity: normalizedIdentity,
            quotaObservation,
          });
        }
      },
    });
  }
}
