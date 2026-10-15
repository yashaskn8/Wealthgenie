import {
  AVAILABILITY,
  FRESHNESS,
  MARKET_FACT_SEMANTIC_CLASSES,
} from './marketData/contracts.js';
import { MARKET_BENCHMARKS } from './marketData/marketBenchmarks.js';

export const NIFTY_50_BENCHMARK_ID = MARKET_BENCHMARKS.NIFTY_50.canonicalProductId;
export const INDIA_VIX_BENCHMARK_ID = MARKET_BENCHMARKS.INDIA_VIX.canonicalProductId;
export const MARKET_CONTEXT_MINIMUM_HISTORY_SESSIONS = 50;
export const MARKET_CONTEXT_RECENT_HIGH_SESSIONS = 252;

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function round(value, digits = 6) {
  return Number(Number(value).toFixed(digits));
}

function signal(value, unit, basis, semanticClass = MARKET_FACT_SEMANTIC_CLASSES.DERIVED) {
  return {
    value: Number.isFinite(value) ? value : null,
    unit,
    basis,
    semanticClass,
    available: Number.isFinite(value),
  };
}

function emptySignals() {
  return {
    nifty50Current: signal(null, 'INDEX_POINTS', 'VERIFIED_CURRENT_NIFTY50_QUOTE', MARKET_FACT_SEMANTIC_CLASSES.OBSERVED),
    nifty50PreviousClose: signal(null, 'INDEX_POINTS', 'VERIFIED_PREVIOUS_TRADING_SESSION_CLOSE', MARKET_FACT_SEMANTIC_CLASSES.OBSERVED),
    indiaVixCurrent: signal(null, 'INDEX_POINTS', 'VERIFIED_CURRENT_INDIA_VIX_QUOTE', MARKET_FACT_SEMANTIC_CLASSES.OBSERVED),
    return1DayPct: signal(null, 'PERCENT', 'CURRENT_VS_PREVIOUS_TRADING_SESSION_CLOSE'),
    return5DayPct: signal(null, 'PERCENT', 'CURRENT_VS_CLOSE_5_TRADING_SESSIONS_AGO'),
    return20DayPct: signal(null, 'PERCENT', 'CURRENT_VS_CLOSE_20_TRADING_SESSIONS_AGO'),
    drawdownFromRecentHighPct: signal(null, 'PERCENT', 'CURRENT_VS_MAX_DAILY_HIGH_UP_TO_252_SESSIONS'),
    realizedVolatility20DayAnnualizedPct: signal(null, 'PERCENT', 'STDDEV_20_DAILY_LOG_RETURNS_SQRT_252'),
    movingAverage50Day: signal(null, 'INDEX_POINTS', 'MEAN_OF_50_COMPLETED_DAILY_CLOSES'),
    movingAverage200Day: signal(null, 'INDEX_POINTS', 'MEAN_OF_200_COMPLETED_DAILY_CLOSES'),
    priceVsMovingAverage50Pct: signal(null, 'PERCENT', 'CURRENT_VS_50_DAY_MOVING_AVERAGE'),
    priceVsMovingAverage200Pct: signal(null, 'PERCENT', 'CURRENT_VS_200_DAY_MOVING_AVERAGE'),
  };
}

function average(values) {
  if (!values.length || values.some(value => !Number.isFinite(value))) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleStandardDeviation(values) {
  if (values.length < 2 || values.some(value => !Number.isFinite(value))) return null;
  const mean = average(values);
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function returnPct(current, base) {
  return current > 0 && base > 0 ? round(((current / base) - 1) * 100) : null;
}

function findQuote(snapshot, canonicalProductId) {
  return (snapshot?.facts || []).find(fact => fact?.canonicalProductId === canonicalProductId) || null;
}

function quoteProblem(fact, label) {
  if (!fact || fact.availabilityStatus !== AVAILABILITY.AVAILABLE || finitePositive(fact.value) === null) {
    return `${label}_UNAVAILABLE`;
  }
  if (fact.freshness?.status === FRESHNESS.UNKNOWN) return `${label}_FRESHNESS_UNKNOWN`;
  if (fact.freshness?.status !== FRESHNESS.FRESH) return `${label}_STALE`;
  return null;
}

/**
 * Build one deterministic row per verified trading session. The current quote
 * is excluded from the completed-session series so an after-close quote cannot
 * be counted twice when daily history already contains that same session.
 */
export function buildCanonicalSessionSeries({ currentQuoteFact, historyCandles = [] } = {}) {
  const quoteDate = currentQuoteFact?.effectiveTradingDate
    || (currentQuoteFact?.observedAt ? String(currentQuoteFact.observedAt).slice(0, 10) : null);
  const byDate = new Map();
  for (const candle of Array.isArray(historyCandles) ? historyCandles : []) {
    const effectiveTradingDate = String(
      candle?.effectiveTradingDate || (candle?.timestamp ? String(candle.timestamp).slice(0, 10) : ''),
    ).trim();
    const close = finitePositive(candle?.close);
    const high = finitePositive(candle?.high);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveTradingDate) || close === null || high === null) continue;
    const existing = byDate.get(effectiveTradingDate);
    const timestamp = Date.parse(candle?.timestamp);
    const existingTimestamp = Date.parse(existing?.timestamp);
    if (!existing || (Number.isFinite(timestamp) && timestamp >= existingTimestamp)) {
      byDate.set(effectiveTradingDate, { ...candle, effectiveTradingDate, close, high });
    }
  }
  const allSessions = [...byDate.values()].sort((left, right) => (
    left.effectiveTradingDate.localeCompare(right.effectiveTradingDate)
  ));
  const completedSessions = quoteDate
    ? allSessions.filter(session => session.effectiveTradingDate < quoteDate)
    : allSessions;
  return { quoteDate, allSessions, completedSessions };
}

function sourceDescriptor(source, observedAt, fetchedAt, freshness, metadata = {}) {
  return {
    provider: source?.provider ?? null,
    instrumentId: source?.instrumentId ?? null,
    url: source?.url ?? null,
    ...(Array.isArray(source?.requestUrls) ? { requestUrls: [...source.requestUrls] } : {}),
    observedAt: observedAt ?? null,
    fetchedAt: fetchedAt ?? null,
    freshness: freshness ?? null,
    providerTimestamp: metadata?.providerTimestamp ?? null,
    effectiveTradingDate: metadata?.effectiveTradingDate ?? null,
    dataClass: metadata?.dataClass ?? null,
  };
}

function snapshotProviderIdentities(snapshot, evidenceRole) {
  const status = snapshot?.providerStatus || {};
  const providers = [
    snapshot?.provider,
    snapshot?.providerSelection?.selectedProvider,
    status[evidenceRole]?.provider,
    ...(snapshot?.facts || []).flatMap(fact => [fact?.source?.provider, fact?.sourceProvider, fact?.provider]),
    ...(snapshot?.candles || []).flatMap(candle => [
      candle?.source?.provider,
      candle?.sourceProvider,
      candle?.provider,
      snapshot?.source?.provider,
    ]),
  ].filter(provider => typeof provider === 'string' && provider.trim())
    .map(provider => provider.trim().toUpperCase());
  return new Set(providers);
}

function hasCoherentProviderPair(quoteSnapshot, historicalSnapshot) {
  const quoteProviders = snapshotProviderIdentities(quoteSnapshot, 'quotes');
  const historyProviders = snapshotProviderIdentities(historicalSnapshot, 'history');
  return quoteProviders.size === 1
    && historyProviders.size === 1
    && quoteProviders.values().next().value === historyProviders.values().next().value;
}

function combinedFetchedAt(...snapshots) {
  return snapshots
    .map(snapshot => snapshot?.fetchedAt)
    .filter(Boolean)
    .sort()
    .at(-1) || null;
}

function semanticFact({ key, item, semanticClass, dataClass = null, observedAt, fetchedAt, freshness, source, derivation = null, provenance = null }) {
  const available = item?.available === true && Number.isFinite(item.value);
  return {
    key,
    value: available ? item.value : null,
    unit: item?.unit ?? null,
    dataClass,
    semanticClass,
    availabilityStatus: available ? AVAILABILITY.AVAILABLE : AVAILABILITY.UNAVAILABLE,
    observedAt: observedAt ?? null,
    fetchedAt: fetchedAt ?? null,
    freshness: freshness ?? { status: FRESHNESS.UNKNOWN, ageSeconds: null, maxAgeSeconds: null },
    source: source ?? null,
    derivation,
    provenance,
  };
}

function buildSemanticFacts({ signals, niftyFact, vixFact, quoteSnapshot, historicalSnapshot, sources }) {
  const quoteFetchedAt = quoteSnapshot?.fetchedAt || niftyFact?.fetchedAt || vixFact?.fetchedAt || null;
  const observedFacts = [
    semanticFact({
      key: 'nifty50Current',
      item: signals.nifty50Current,
      semanticClass: MARKET_FACT_SEMANTIC_CLASSES.OBSERVED,
      dataClass: niftyFact?.dataClass ?? null,
      observedAt: niftyFact?.observedAt,
      fetchedAt: quoteFetchedAt,
      freshness: niftyFact?.freshness,
      source: niftyFact?.source,
    }),
    semanticFact({
      key: 'nifty50PreviousClose',
      item: signals.nifty50PreviousClose,
      semanticClass: MARKET_FACT_SEMANTIC_CLASSES.OBSERVED,
      dataClass: niftyFact?.dataClass ?? null,
      observedAt: niftyFact?.observedAt,
      fetchedAt: quoteFetchedAt,
      freshness: niftyFact?.freshness,
      source: niftyFact?.source,
    }),
    semanticFact({
      key: 'indiaVixCurrent',
      item: signals.indiaVixCurrent,
      semanticClass: MARKET_FACT_SEMANTIC_CLASSES.OBSERVED,
      dataClass: vixFact?.dataClass ?? null,
      observedAt: vixFact?.observedAt,
      fetchedAt: quoteFetchedAt,
      freshness: vixFact?.freshness,
      source: vixFact?.source,
    }),
  ];

  const derivedFreshness = [niftyFact?.freshness, vixFact?.freshness, historicalSnapshot?.freshness]
    .map(value => value?.status)
    .includes(FRESHNESS.STALE)
    ? { status: FRESHNESS.STALE, ageSeconds: null, maxAgeSeconds: null }
    : [niftyFact?.freshness, vixFact?.freshness, historicalSnapshot?.freshness]
      .every(value => value?.status === FRESHNESS.FRESH)
      ? { status: FRESHNESS.FRESH, ageSeconds: null, maxAgeSeconds: null }
      : { status: FRESHNESS.UNKNOWN, ageSeconds: null, maxAgeSeconds: null };

  const derivedFacts = Object.entries(signals)
    .filter(([, item]) => item?.semanticClass === MARKET_FACT_SEMANTIC_CLASSES.DERIVED)
    .map(([key, item]) => semanticFact({
      key,
      item,
      semanticClass: MARKET_FACT_SEMANTIC_CLASSES.DERIVED,
      observedAt: niftyFact?.observedAt || historicalSnapshot?.observedAt,
      fetchedAt: combinedFetchedAt(quoteSnapshot, historicalSnapshot),
      freshness: derivedFreshness,
      derivation: item.basis,
      provenance: {
        engine: 'market-context-feature-engine',
        evidence: sources,
      },
    }));

  return { observedFacts, derivedFacts };
}

function unavailableResult({ quoteSnapshot, historicalSnapshot, signals, reasonCodes, sources }) {
  return {
    status: 'FEATURES_UNAVAILABLE',
    policyAvailability: 'UNAVAILABLE',
    dataCompleteness: 'UNAVAILABLE',
    signals,
    reasonCodes: [...new Set(reasonCodes)],
    observedAt: null,
    freshness: {
      status: FRESHNESS.UNKNOWN,
      nifty50Quote: findQuote(quoteSnapshot, NIFTY_50_BENCHMARK_ID)?.freshness ?? null,
      indiaVixQuote: findQuote(quoteSnapshot, INDIA_VIX_BENCHMARK_ID)?.freshness ?? null,
      nifty50History: historicalSnapshot?.freshness ?? null,
    },
    sources,
  };
}

/**
 * Converts verified provider-neutral quote/history payloads into deterministic
 * signals. It has no fallback values and performs no market classification.
 */
export function computeMarketContextFeatures({ quoteSnapshot, historicalSnapshot }) {
  const signals = emptySignals();
  const niftyFact = findQuote(quoteSnapshot, NIFTY_50_BENCHMARK_ID);
  const vixFact = findQuote(quoteSnapshot, INDIA_VIX_BENCHMARK_ID);
  const sources = [
    sourceDescriptor(niftyFact?.source, niftyFact?.observedAt, niftyFact?.fetchedAt, niftyFact?.freshness, niftyFact),
    sourceDescriptor(vixFact?.source, vixFact?.observedAt, vixFact?.fetchedAt, vixFact?.freshness, vixFact),
    sourceDescriptor(
      historicalSnapshot?.source,
      historicalSnapshot?.observedAt,
      historicalSnapshot?.fetchedAt,
      historicalSnapshot?.freshness,
      historicalSnapshot,
    ),
  ].filter(source => source.provider || source.instrumentId || source.url);

  const reasonCodes = [];
  if (!hasCoherentProviderPair(quoteSnapshot, historicalSnapshot)) {
    reasonCodes.push('MARKET_PROVIDER_PAIR_MISMATCH');
  }
  if (quoteSnapshot?.status === AVAILABILITY.PROVIDER_NOT_CONFIGURED
      || historicalSnapshot?.status === AVAILABILITY.PROVIDER_NOT_CONFIGURED) {
    reasonCodes.push('PROVIDER_NOT_CONFIGURED');
  }
  if (quoteSnapshot?.status === AVAILABILITY.SOURCE_ERROR) reasonCodes.push('MARKET_QUOTE_SOURCE_ERROR');
  if (historicalSnapshot?.status === AVAILABILITY.SOURCE_ERROR) reasonCodes.push('MARKET_HISTORY_SOURCE_ERROR');
  const niftyProblem = quoteProblem(niftyFact, 'NIFTY50_QUOTE');
  const vixProblem = quoteProblem(vixFact, 'INDIA_VIX');
  if (niftyProblem) reasonCodes.push(niftyProblem);
  if (vixProblem) reasonCodes.push(vixProblem);

  const niftyCurrent = finitePositive(niftyFact?.value);
  const previousClose = finitePositive(niftyFact?.metrics?.previousClose);
  const vixCurrent = finitePositive(vixFact?.value);
  signals.nifty50Current = signal(
    niftyCurrent,
    'INDEX_POINTS',
    'VERIFIED_CURRENT_NIFTY50_QUOTE',
    MARKET_FACT_SEMANTIC_CLASSES.OBSERVED,
  );
  signals.nifty50PreviousClose = signal(
    previousClose,
    'INDEX_POINTS',
    'VERIFIED_PREVIOUS_TRADING_SESSION_CLOSE',
    MARKET_FACT_SEMANTIC_CLASSES.OBSERVED,
  );
  signals.indiaVixCurrent = signal(
    vixCurrent,
    'INDEX_POINTS',
    'VERIFIED_CURRENT_INDIA_VIX_QUOTE',
    MARKET_FACT_SEMANTIC_CLASSES.OBSERVED,
  );
  if (previousClose === null) reasonCodes.push('NIFTY50_PREVIOUS_CLOSE_UNAVAILABLE');

  if (historicalSnapshot?.status !== AVAILABILITY.AVAILABLE) {
    if (!reasonCodes.includes('PROVIDER_NOT_CONFIGURED') && !reasonCodes.includes('MARKET_HISTORY_SOURCE_ERROR')) {
      reasonCodes.push('NIFTY50_HISTORY_UNAVAILABLE');
    }
  } else if (historicalSnapshot?.freshness?.status === FRESHNESS.UNKNOWN) {
    reasonCodes.push('NIFTY50_HISTORY_FRESHNESS_UNKNOWN');
  } else if (historicalSnapshot?.freshness?.status !== FRESHNESS.FRESH) {
    reasonCodes.push('NIFTY50_HISTORY_STALE');
  }

  const candles = Array.isArray(historicalSnapshot?.candles) ? historicalSnapshot.candles : [];
  const validCandles = candles.filter(candle => (
    finitePositive(candle?.close) !== null && finitePositive(candle?.high) !== null
  ));
  if (validCandles.length < MARKET_CONTEXT_MINIMUM_HISTORY_SESSIONS) {
    reasonCodes.push('INSUFFICIENT_NIFTY50_HISTORY');
  }

  if (reasonCodes.length > 0) {
    return {
      ...unavailableResult({ quoteSnapshot, historicalSnapshot, signals, reasonCodes, sources }),
      ...buildSemanticFacts({ signals, niftyFact, vixFact, quoteSnapshot, historicalSnapshot, sources }),
      providerStatus: {
        quotes: {
          provider: quoteSnapshot?.provider ?? null,
          status: quoteSnapshot?.status ?? AVAILABILITY.UNAVAILABLE,
          qualification: quoteSnapshot?.qualification ?? null,
          fetchedAt: quoteSnapshot?.fetchedAt ?? null,
          cache: quoteSnapshot?.cache ?? null,
          calendar: quoteSnapshot?.calendar ?? null,
          reasonCodes: quoteSnapshot?.reasonCodes ?? [],
        },
        history: {
          provider: historicalSnapshot?.provider ?? null,
          status: historicalSnapshot?.status ?? AVAILABILITY.UNAVAILABLE,
          qualification: historicalSnapshot?.qualification ?? null,
          fetchedAt: historicalSnapshot?.fetchedAt ?? null,
          cache: historicalSnapshot?.cache ?? null,
          calendar: historicalSnapshot?.calendar ?? null,
          reasonCodes: historicalSnapshot?.reasonCodes ?? [],
        },
      },
    };
  }

  const sessionSeries = buildCanonicalSessionSeries({ currentQuoteFact: niftyFact, historyCandles: validCandles });
  const completedSessions = sessionSeries.completedSessions;
  const closes = completedSessions.map(candle => Number(candle.close));
  const recentCandles = completedSessions.slice(-MARKET_CONTEXT_RECENT_HIGH_SESSIONS);
  const recentHigh = recentCandles.length > 0
    ? Math.max(...recentCandles.map(candle => Number(candle.high)))
    : null;
  const recentCloses = closes.slice(-21);
  const dailyLogReturns = recentCloses.slice(1).map((close, index) => (
    Math.log(close / recentCloses[index])
  ));
  const ma50 = closes.length >= 50 ? average(closes.slice(-50)) : null;
  const ma200 = closes.length >= 200 ? average(closes.slice(-200)) : null;
  const realizedVolatility = sampleStandardDeviation(dailyLogReturns);

  signals.return1DayPct = signal(returnPct(niftyCurrent, previousClose), 'PERCENT', 'CURRENT_VS_PREVIOUS_TRADING_SESSION_CLOSE');
  signals.return5DayPct = signal(returnPct(niftyCurrent, closes.at(-5)), 'PERCENT', 'CURRENT_VS_CLOSE_5_TRADING_SESSIONS_AGO');
  signals.return20DayPct = signal(returnPct(niftyCurrent, closes.at(-20)), 'PERCENT', 'CURRENT_VS_CLOSE_20_TRADING_SESSIONS_AGO');
  signals.drawdownFromRecentHighPct = signal(returnPct(niftyCurrent, recentHigh), 'PERCENT', 'CURRENT_VS_MAX_DAILY_HIGH_UP_TO_252_SESSIONS');
  signals.realizedVolatility20DayAnnualizedPct = signal(
    realizedVolatility === null ? null : round(realizedVolatility * Math.sqrt(252) * 100),
    'PERCENT',
    'STDDEV_20_DAILY_LOG_RETURNS_SQRT_252',
  );
  signals.movingAverage50Day = signal(round(ma50), 'INDEX_POINTS', 'MEAN_OF_50_COMPLETED_DAILY_CLOSES');
  signals.movingAverage200Day = signal(ma200 === null ? null : round(ma200), 'INDEX_POINTS', 'MEAN_OF_200_COMPLETED_DAILY_CLOSES');
  signals.priceVsMovingAverage50Pct = signal(returnPct(niftyCurrent, ma50), 'PERCENT', 'CURRENT_VS_50_DAY_MOVING_AVERAGE');
  signals.priceVsMovingAverage200Pct = signal(
    ma200 === null ? null : returnPct(niftyCurrent, ma200),
    'PERCENT',
    'CURRENT_VS_200_DAY_MOVING_AVERAGE',
  );

  const quoteObserved = [niftyFact.observedAt, vixFact.observedAt].map(Date.parse).filter(Number.isFinite);
  return {
    status: 'FEATURES_AVAILABLE',
    policyAvailability: 'AVAILABLE',
    dataCompleteness: ma200 === null ? 'PARTIAL' : 'COMPLETE',
    signals,
    reasonCodes: ma200 === null ? ['MA200_UNAVAILABLE_INSUFFICIENT_HISTORY'] : [],
    observedAt: quoteObserved.length === 2 ? new Date(Math.min(...quoteObserved)).toISOString() : null,
    freshness: {
      status: FRESHNESS.FRESH,
      nifty50Quote: niftyFact.freshness,
      indiaVixQuote: vixFact.freshness,
      nifty50History: historicalSnapshot.freshness,
    },
    sources,
    ...buildSemanticFacts({ signals, niftyFact, vixFact, quoteSnapshot, historicalSnapshot, sources }),
    providerStatus: {
      quotes: {
        provider: quoteSnapshot?.provider ?? null,
        status: quoteSnapshot?.status ?? AVAILABILITY.UNAVAILABLE,
        qualification: quoteSnapshot?.qualification ?? null,
        fetchedAt: quoteSnapshot?.fetchedAt ?? null,
        cache: quoteSnapshot?.cache ?? null,
        calendar: quoteSnapshot?.calendar ?? null,
        reasonCodes: quoteSnapshot?.reasonCodes ?? [],
      },
      history: {
        provider: historicalSnapshot?.provider ?? null,
        status: historicalSnapshot?.status ?? AVAILABILITY.UNAVAILABLE,
        qualification: historicalSnapshot?.qualification ?? null,
        fetchedAt: historicalSnapshot?.fetchedAt ?? null,
        cache: historicalSnapshot?.cache ?? null,
        calendar: historicalSnapshot?.calendar ?? null,
        reasonCodes: historicalSnapshot?.reasonCodes ?? [],
      },
    },
  };
}
