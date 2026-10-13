import crypto from 'node:crypto';
import { getCache, setCache } from '../config/redis.js';
import {
  fetchQualifiedMarketContextSnapshots,
  fetchBenchmarkQuotes,
  fetchNiftyHistoricalCandles,
} from './marketDataService.js';
import {
  AVAILABILITY,
  FRESHNESS,
  MARKET_FACT_SEMANTIC_CLASSES,
} from './marketData/contracts.js';
import { computeMarketContextFeatures } from './marketContextFeatureEngine.js';
import { readLatestPersistedMarketContext, persistMarketContextSnapshot } from './marketData/MarketDataRepository.js';
import {
  MARKET_CONTEXT_POLICY_VERSION,
  applyMarketContextHysteresis,
  classifyDeterministicMarketContext,
} from './marketContextPolicy.js';

const MARKET_CONTEXT_STATE_CACHE_KEY = `market:context:state:${MARKET_CONTEXT_POLICY_VERSION}`;
const MARKET_CONTEXT_STATE_TTL_SECONDS = 7 * 24 * 60 * 60;
const MARKET_CONTEXT_LKG_CACHE_KEY = 'market:context:last-known-good:market-snapshot-1.0.0';
const MARKET_CONTEXT_LKG_TTL_SECONDS = 7 * 24 * 60 * 60;
const MARKET_CONTEXT_CLOSED_MAX_AGE_SECONDS = 36 * 60 * 60;
const MARKET_CONTEXT_OPEN_MAX_AGE_SECONDS = 15 * 60;

export const MARKET_SNAPSHOT_SCHEMA_VERSION = 'market-snapshot-1.0.0';
export const MARKET_SNAPSHOT_CONTENT_REVISION_VERSION = 'market-snapshot-content-1.0.0';
export const MARKET_DISPLAY_STATUS = Object.freeze({
  CURRENT: 'CURRENT',
  MARKET_CLOSED: 'MARKET_CLOSED',
  LAST_AVAILABLE: 'LAST_AVAILABLE',
  STALE: 'STALE',
  PARTIAL_DATA: 'PARTIAL_DATA',
  UNAVAILABLE: 'UNAVAILABLE',
});

let processState = null;
let processLastKnownGood = null;

const VOLATILE_REVISION_FIELDS = new Set([
  'ageSeconds',
  'cache',
  'cacheAgeSeconds',
  'cacheMetadata',
  'cachedAt',
  'cacheHit',
  'checkedAt',
  'createdAt',
  'evaluatedAt',
  'expiresAt',
  'fetchedAt',
  'lastFetchedAt',
  'lastCheckedAt',
  'latencyMs',
  'durationMs',
  'requestId',
  'updatedAt',
]);

const ORDER_INSENSITIVE_REVISION_ARRAYS = new Set([
  'candles',
  'facts',
  'observedFacts',
  'derivedFacts',
  'providerFailures',
  'reasonCodes',
  'sources',
]);

function normalizeRevisionEvidence(value, parentKey = '') {
  if (Array.isArray(value)) {
    const normalized = value.map(item => normalizeRevisionEvidence(item));
    return ORDER_INSENSITIVE_REVISION_ARRAYS.has(parentKey)
      ? normalized.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
      : normalized;
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value)
    .filter(key => !VOLATILE_REVISION_FIELDS.has(key))
    .sort()
    .map(key => [key, normalizeRevisionEvidence(value[key], key)]));
}

function sha256Revision(value) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(normalizeRevisionEvidence(value)))
    .digest('hex');
}

function snapshotContentRevision(snapshot, evidenceRevision = snapshot.evidenceRevision) {
  const policyOutput = snapshot.policyOutput || {};
  return {
    version: MARKET_SNAPSHOT_CONTENT_REVISION_VERSION,
    digest: sha256Revision({
      version: MARKET_SNAPSHOT_CONTENT_REVISION_VERSION,
      evidenceRevision,
      status: snapshot.status,
      availability: snapshot.availability,
      providerStatus: snapshot.providerStatus,
      providerSelection: snapshot.providerSelection,
      policyOutput: {
        status: policyOutput.status,
        context: policyOutput.context,
        classification: policyOutput.classification,
        policyVersion: policyOutput.policyVersion,
        reasonCodes: policyOutput.reasonCodes,
        observedAt: policyOutput.observedAt,
      },
      policyAvailability: snapshot.policyAvailability,
      dataCompleteness: snapshot.dataCompleteness,
      freshness: snapshot.freshness,
      provenance: snapshot.provenance,
      observedAt: snapshot.observedAt,
      marketSession: snapshot.marketSession,
    }),
  };
}

function evidenceRevisionFromSnapshot(snapshot) {
  return sha256Revision({
    schemaVersion: snapshot.schemaVersion,
    providerStatus: snapshot.providerStatus,
    providerSelection: snapshot.providerSelection,
    observedFacts: snapshot.observedFacts,
    derivedFacts: snapshot.derivedFacts,
    freshness: snapshot.freshness,
    provenance: snapshot.provenance,
    observedAt: snapshot.observedAt,
    marketSession: snapshot.marketSession,
  });
}

function finalizeMarketSnapshot(snapshot, recommendationUsability, evidenceRevision = snapshot.evidenceRevision) {
  const finalized = {
    ...snapshot,
    recommendationUsability,
  };
  finalized.evidenceRevision = evidenceRevision || evidenceRevisionFromSnapshot(finalized);
  finalized.contentRevision = snapshotContentRevision(finalized, finalized.evidenceRevision);
  return finalized;
}

function sourceFailureSnapshot(code, message) {
  return {
    status: AVAILABILITY.SOURCE_ERROR,
    facts: [],
    candles: [],
    fetchedAt: new Date().toISOString(),
    freshness: null,
    error: { code, message },
  };
}

function availableFactCount(snapshot) {
  return (snapshot?.facts || []).filter(fact => (
    fact?.availabilityStatus === AVAILABILITY.AVAILABLE && Number.isFinite(fact.value)
  )).length;
}

function hasStaleEvidence(quoteSnapshot, historicalSnapshot) {
  return [
    ...(quoteSnapshot?.facts || []).map(fact => fact?.freshness?.status),
    historicalSnapshot?.freshness?.status,
  ].includes(FRESHNESS.STALE);
}

function displayStatusFor({ quoteSnapshot, historicalSnapshot, features }) {
  const availableQuotes = availableFactCount(quoteSnapshot);
  const availableHistory = historicalSnapshot?.status === AVAILABILITY.AVAILABLE
    && Array.isArray(historicalSnapshot?.candles)
    && historicalSnapshot.candles.length > 0;
  const anyAvailable = availableQuotes > 0 || availableHistory;
  if (features?.status !== 'FEATURES_AVAILABLE') {
    if (hasStaleEvidence(quoteSnapshot, historicalSnapshot)) return MARKET_DISPLAY_STATUS.STALE;
    return anyAvailable ? MARKET_DISPLAY_STATUS.PARTIAL_DATA : MARKET_DISPLAY_STATUS.UNAVAILABLE;
  }

  const session = quoteSnapshot?.marketSession?.status
    || quoteSnapshot?.facts?.find(fact => fact?.freshness?.marketSession)?.freshness?.marketSession;
  if (session === 'MARKET_OPEN') return MARKET_DISPLAY_STATUS.CURRENT;
  if (session === 'MARKET_CLOSED' || session === 'MARKET_HOLIDAY') return MARKET_DISPLAY_STATUS.MARKET_CLOSED;
  return MARKET_DISPLAY_STATUS.LAST_AVAILABLE;
}

function ageSeconds(timestamp, now) {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return null;
  const age = Math.floor((now.getTime() - parsed) / 1000);
  return age < 0 ? null : age;
}

function cacheDescriptor(snapshot, now) {
  const cachedAt = snapshot?.cacheMetadata?.cachedAt ?? null;
  return {
    hit: snapshot?.cache?.hit === true,
    cachedAt,
    ageSeconds: cachedAt ? ageSeconds(cachedAt, now) : null,
  };
}

function recommendationUsabilityFor(marketSnapshot, now) {
  const displayStatus = marketSnapshot?.status;
  const policyAvailable = marketSnapshot?.policyOutput?.status === 'MARKET_CONTEXT_AVAILABLE'
    && marketSnapshot?.policyAvailability !== 'UNAVAILABLE';
  if (!policyAvailable) {
    return { status: 'NOT_USABLE', reasonCodes: ['MARKET_POLICY_UNAVAILABLE'] };
  }
  if (![MARKET_DISPLAY_STATUS.CURRENT, MARKET_DISPLAY_STATUS.MARKET_CLOSED, MARKET_DISPLAY_STATUS.LAST_AVAILABLE].includes(displayStatus)) {
    return { status: 'NOT_USABLE', reasonCodes: ['MARKET_SNAPSHOT_NOT_CURRENT_OR_LAST_AVAILABLE'] };
  }
  const session = marketSnapshot?.marketSession?.status;
  if (![ 'MARKET_OPEN', 'MARKET_CLOSED', 'MARKET_HOLIDAY' ].includes(session)) {
    return { status: 'NOT_USABLE', reasonCodes: ['MARKET_SESSION_UNVERIFIED'] };
  }
  const observedAge = ageSeconds(marketSnapshot.observedAt, now);
  const maxAgeSeconds = session === 'MARKET_OPEN'
    ? MARKET_CONTEXT_OPEN_MAX_AGE_SECONDS
    : MARKET_CONTEXT_CLOSED_MAX_AGE_SECONDS;
  if (observedAge === null || observedAge > maxAgeSeconds) {
    return {
      status: 'NOT_USABLE',
      reasonCodes: ['MARKET_SNAPSHOT_OBSERVATION_TOO_OLD'],
      observedAgeSeconds: observedAge,
      maxAgeSeconds,
    };
  }
  return {
    status: 'USABLE',
    reasonCodes: [],
    observedAgeSeconds: observedAge,
    maxAgeSeconds,
  };
}

/**
 * Additive DTO for the frontend. Raw provider facts, deterministic derived
 * features, and policy output remain separate so presentation cannot mistake
 * a calculation or classification for an observed market value.
 */
export function buildMarketSnapshot({ quoteSnapshot, historicalSnapshot, features, policy, evaluatedAt, now = new Date(evaluatedAt || Date.now()) }) {
  const displayStatus = displayStatusFor({ quoteSnapshot, historicalSnapshot, features });
  const policyOutput = {
    semanticClass: MARKET_FACT_SEMANTIC_CLASSES.POLICY_OUTPUT,
    dataClass: MARKET_FACT_SEMANTIC_CLASSES.POLICY_OUTPUT,
    status: policy?.status ?? 'MARKET_CONTEXT_UNAVAILABLE',
    context: policy?.context ?? null,
    classification: policy?.classification ?? null,
    policyVersion: policy?.policyVersion ?? null,
    reasonCodes: policy?.reasonCodes ?? [],
    observedAt: policy?.observedAt ?? null,
    evaluatedAt: evaluatedAt ?? null,
  };
  const marketSnapshot = {
    schemaVersion: MARKET_SNAPSHOT_SCHEMA_VERSION,
    status: displayStatus,
    availability: features?.status === 'FEATURES_AVAILABLE'
      ? AVAILABILITY.AVAILABLE
      : (displayStatus === MARKET_DISPLAY_STATUS.PARTIAL_DATA || displayStatus === MARKET_DISPLAY_STATUS.STALE)
        ? AVAILABILITY.PARTIAL
        : AVAILABILITY.UNAVAILABLE,
    providerStatus: features?.providerStatus ?? {
      quotes: { provider: quoteSnapshot?.provider ?? null, status: quoteSnapshot?.status ?? AVAILABILITY.UNAVAILABLE },
      history: { provider: historicalSnapshot?.provider ?? null, status: historicalSnapshot?.status ?? AVAILABILITY.UNAVAILABLE },
    },
    providerSelection: quoteSnapshot?.providerSelection ?? historicalSnapshot?.providerSelection ?? null,
    observedFacts: features?.observedFacts ?? [],
    derivedFacts: features?.derivedFacts ?? [],
    policyOutput,
    policyAvailability: policy?.policyAvailability ?? features?.policyAvailability ?? 'UNAVAILABLE',
    dataCompleteness: features?.dataCompleteness ?? 'UNAVAILABLE',
    freshness: features?.freshness ?? null,
    provenance: {
      sources: policy?.sources ?? features?.sources ?? [],
      qualification: quoteSnapshot?.qualification ?? null,
    },
    observedAt: policy?.observedAt ?? features?.observedAt ?? null,
    evaluatedAt: evaluatedAt ?? null,
    marketSession: quoteSnapshot?.marketSession ?? {
      status: 'UNKNOWN',
      tradingDate: null,
      checkedAt: evaluatedAt ?? null,
    },
    cache: {
      quotes: cacheDescriptor(quoteSnapshot, now),
      history: cacheDescriptor(historicalSnapshot, now),
    },
  };
  marketSnapshot.evidenceRevision = sha256Revision({
    version: MARKET_SNAPSHOT_CONTENT_REVISION_VERSION,
    quoteSnapshot,
    historicalSnapshot,
  });
  marketSnapshot.contentRevision = snapshotContentRevision(marketSnapshot);
  return marketSnapshot;
}

async function readState(getState) {
  try {
    const cached = await getState(MARKET_CONTEXT_STATE_CACHE_KEY);
    if (cached && typeof cached === 'object') {
      processState = cached;
      return { state: cached, storage: 'REDIS' };
    }
  } catch {
    // Redis is an optimisation. Process state preserves bounded hysteresis
    // continuity for this instance when the cache is unavailable.
  }
  return { state: processState, storage: processState ? 'PROCESS_MEMORY' : 'NONE' };
}

async function writeState(state, setState) {
  processState = state;
  try {
    const persisted = await setState(MARKET_CONTEXT_STATE_CACHE_KEY, state, MARKET_CONTEXT_STATE_TTL_SECONDS);
    return persisted === true ? 'REDIS_WITH_PROCESS_FALLBACK' : 'PROCESS_MEMORY';
  } catch {
    return 'PROCESS_MEMORY';
  }
}

async function readLastKnownGood(getLkg, getDurable) {
  const candidates = [];
  try {
    const cached = await getLkg(MARKET_CONTEXT_LKG_CACHE_KEY);
    if (cached?.marketContext?.marketSnapshot) candidates.push({ value: cached, storage: 'REDIS' });
  } catch {
    // Redis is an optimisation. The durable observation path is still tried.
  }
  try {
    const durable = await getDurable();
    if (durable?.marketContext?.marketSnapshot) candidates.push({ value: durable, storage: 'MONGODB' });
  } catch {
    // Persistence outages must not turn a previously qualified observation
    // into a fabricated current value.
  }
  if (candidates.length > 0) {
    candidates.sort((left, right) => Date.parse(right.value.storedAt || 0) - Date.parse(left.value.storedAt || 0));
    const newest = candidates[0];
    processLastKnownGood = newest.value;
    return {
      value: newest.value,
      storage: candidates.length > 1 ? `${newest.storage}+OTHER` : newest.storage,
    };
  }
  return { value: processLastKnownGood, storage: processLastKnownGood ? 'PROCESS_MEMORY' : 'NONE' };
}

async function writeLastKnownGood(value, setLkg, persistDurable) {
  processLastKnownGood = value;
  let durableStorage = 'PERSISTENCE_UNAVAILABLE';
  try {
    durableStorage = (await persistDurable(value)).status;
  } catch {
    durableStorage = 'PERSISTENCE_ERROR';
  }
  try {
    const persisted = await setLkg(MARKET_CONTEXT_LKG_CACHE_KEY, value, MARKET_CONTEXT_LKG_TTL_SECONDS);
    if (persisted === true && durableStorage === 'PERSISTED') return 'MONGODB_AND_REDIS_WITH_PROCESS_FALLBACK';
    if (persisted === true) return 'REDIS_WITH_PROCESS_FALLBACK';
    return durableStorage === 'PERSISTED' ? 'MONGODB_WITH_PROCESS_FALLBACK' : 'PROCESS_MEMORY';
  } catch {
    return durableStorage === 'PERSISTED' ? 'MONGODB_WITH_PROCESS_FALLBACK' : 'PROCESS_MEMORY';
  }
}

function recoverLastKnownGood(lastKnownGood, now, liveReasonCodes = [], liveProviderSelection = null) {
  if (!lastKnownGood?.marketContext?.marketSnapshot) return null;
  const saved = lastKnownGood.marketContext;
  const savedSnapshot = saved.marketSnapshot;
  const observedAge = ageSeconds(savedSnapshot.observedAt, now);
  const recoveredStatus = observedAge !== null && observedAge <= MARKET_CONTEXT_CLOSED_MAX_AGE_SECONDS
    ? MARKET_DISPLAY_STATUS.LAST_AVAILABLE
    : MARKET_DISPLAY_STATUS.STALE;
  const marketSnapshot = {
    ...savedSnapshot,
    status: recoveredStatus,
    recoveredFromLastKnownGood: true,
    evaluatedAt: now.toISOString(),
    policyOutput: {
      ...savedSnapshot.policyOutput,
      reasonCodes: [...new Set([
        ...(savedSnapshot.policyOutput?.reasonCodes || []),
        ...liveReasonCodes,
        'LIVE_MARKET_CONTEXT_UNAVAILABLE_RECOVERED_LAST_KNOWN_GOOD',
      ])],
    },
  };
  const recommendationUsability = recommendationUsabilityFor(marketSnapshot, now);
  const finalizedMarketSnapshot = finalizeMarketSnapshot(marketSnapshot, recommendationUsability);
  return {
    ...saved,
    evaluatedAt: now.toISOString(),
    reasonCodes: [...new Set([...(saved.reasonCodes || []), ...liveReasonCodes, 'RECOVERED_LAST_KNOWN_GOOD'])],
    marketSnapshot: finalizedMarketSnapshot,
    recommendationUsability,
    recoveredFromLastKnownGood: true,
    liveProviderSelection,
    statePersistence: 'NOT_MUTATED_UNAVAILABLE_OBSERVATION',
  };
}

/**
 * Builds the sole authoritative market-context response from verified normalized
 * observations. Missing, stale, malformed, or failed data never receives a
 * numeric or classification fallback and never mutates hysteresis state.
 */
export async function getLiveMarketContext(options = {}, dependencies = {}) {
  const fetchQuotes = dependencies.fetchBenchmarkQuotes || fetchBenchmarkQuotes;
  const fetchHistory = dependencies.fetchNiftyHistoricalCandles || fetchNiftyHistoricalCandles;
  const getState = dependencies.getCache || getCache;
  const setState = dependencies.setCache || setCache;
  const getLkg = dependencies.getLkgCache || getState;
  const setLkg = dependencies.setLkgCache || setState;
  const getDurableLkg = dependencies.getDurableLkg || (() => readLatestPersistedMarketContext());
  const persistDurableLkg = dependencies.persistDurableLkg || (value => persistMarketContextSnapshot(value));
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  if (Number.isNaN(now.getTime())) throw new TypeError('now must be a valid date.');

  let quoteResult;
  let historyResult;
  let liveProviderSelection = null;
  const hasLegacyProviderInjection = Boolean(dependencies.fetchBenchmarkQuotes || dependencies.fetchNiftyHistoricalCandles);
  if (!hasLegacyProviderInjection) {
    try {
      const pair = await (dependencies.fetchQualifiedMarketContextSnapshots || fetchQualifiedMarketContextSnapshots)({
        forceQuoteRefresh: options.forceQuoteRefresh === true,
        forceHistoryRefresh: options.forceHistoryRefresh === true,
        now,
        persist: true,
      });
      quoteResult = { status: 'fulfilled', value: pair.quoteSnapshot };
      historyResult = { status: 'fulfilled', value: pair.historicalSnapshot };
      liveProviderSelection = pair.providerSelection ?? null;
    } catch (error) {
      quoteResult = { status: 'rejected', reason: error };
      historyResult = { status: 'rejected', reason: error };
    }
  } else {
    [quoteResult, historyResult] = await Promise.allSettled([
      fetchQuotes({ forceRefresh: options.forceQuoteRefresh === true, persist: true }),
      fetchHistory({ forceRefresh: options.forceHistoryRefresh === true, now }),
    ]);
  }
  const quoteSnapshot = quoteResult.status === 'fulfilled'
    ? quoteResult.value
    : sourceFailureSnapshot('MARKET_QUOTE_REQUEST_FAILED', quoteResult.reason?.message || 'Quote request failed.');
  const historicalSnapshot = historyResult.status === 'fulfilled'
    ? historyResult.value
    : sourceFailureSnapshot('MARKET_HISTORY_REQUEST_FAILED', historyResult.reason?.message || 'History request failed.');
  liveProviderSelection ||= quoteSnapshot.providerSelection ?? historicalSnapshot.providerSelection ?? null;

  const features = computeMarketContextFeatures({ quoteSnapshot, historicalSnapshot });
  const candidate = classifyDeterministicMarketContext(features);
  const evaluatedAt = now.toISOString();
  if (candidate.status !== 'MARKET_CONTEXT_AVAILABLE') {
    // A partial live response is not a coherent market-context snapshot. Do
    // not combine its usable fragments with older quote/history evidence, and
    // do not let the mere presence of one live fact suppress a complete LKG.
    const storedLkg = await readLastKnownGood(getLkg, getDurableLkg);
    const recovered = recoverLastKnownGood(storedLkg.value, now, candidate.reasonCodes, liveProviderSelection);
    if (recovered) return recovered;
    const marketSnapshot = buildMarketSnapshot({
      quoteSnapshot,
      historicalSnapshot,
      features,
      policy: candidate,
      evaluatedAt,
      now,
    });
    const recommendationUsability = recommendationUsabilityFor(marketSnapshot, now);
    return {
      ...candidate,
      evaluatedAt,
      marketSnapshot: finalizeMarketSnapshot(marketSnapshot, recommendationUsability),
      recommendationUsability,
      candidateContext: null,
      hysteresis: { status: 'NOT_APPLIED_MARKET_CONTEXT_UNAVAILABLE' },
      statePersistence: 'NOT_WRITTEN_UNAVAILABLE_OBSERVATION',
    };
  }

  const prior = await readState(getState);
  const transition = applyMarketContextHysteresis(candidate, prior.state, now);
  const statePersistence = transition.changed
    ? await writeState(transition.state, setState)
    : prior.storage;
  const marketSnapshot = buildMarketSnapshot({
    quoteSnapshot,
    historicalSnapshot,
    features,
    policy: transition.result,
    evaluatedAt,
    now,
  });
  const recommendationUsability = recommendationUsabilityFor(marketSnapshot, now);
  const published = {
    ...transition.result,
    evaluatedAt,
    marketSnapshot: finalizeMarketSnapshot(marketSnapshot, recommendationUsability),
    recommendationUsability,
    statePersistence,
  };
  if (recommendationUsability.status === 'USABLE') {
    await writeLastKnownGood({
      schemaVersion: MARKET_SNAPSHOT_SCHEMA_VERSION,
      storedAt: evaluatedAt,
      marketContext: published,
    }, setLkg, persistDurableLkg);
  }
  return published;
}

export function resetMarketContextProcessStateForTest() {
  processState = null;
  processLastKnownGood = null;
}

/**
 * Recommendation path read: returns only a previously qualified snapshot and
 * never calls NSE or another external provider. Freshness is recomputed from
 * observed time; Redis hot-cache age is only observability metadata.
 */
export async function getLatestQualifiedMarketContextForRecommendation(options = {}, dependencies = {}) {
  const getLkg = dependencies.getLkgCache || dependencies.getCache || getCache;
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  if (Number.isNaN(now.getTime())) throw new TypeError('now must be a valid date.');
  const getDurableLkg = dependencies.getDurableLkg || (() => readLatestPersistedMarketContext());
  const stored = await readLastKnownGood(getLkg, getDurableLkg);
  const recovered = recoverLastKnownGood(stored.value, now);
  if (!recovered) {
    return {
      status: 'MARKET_CONTEXT_UNAVAILABLE',
      context: null,
      policyVersion: MARKET_CONTEXT_POLICY_VERSION,
      reasonCodes: ['NO_LAST_KNOWN_GOOD_MARKET_CONTEXT'],
      evaluatedAt: now.toISOString(),
      recommendationUsability: { status: 'NOT_USABLE', reasonCodes: ['NO_LAST_KNOWN_GOOD_MARKET_CONTEXT'] },
      marketSnapshot: finalizeMarketSnapshot(buildMarketSnapshot({
        quoteSnapshot: null,
        historicalSnapshot: null,
        features: null,
        policy: null,
        evaluatedAt: now.toISOString(),
        now,
      }), { status: 'NOT_USABLE', reasonCodes: ['NO_LAST_KNOWN_GOOD_MARKET_CONTEXT'] }),
    };
  }
  return recovered;
}

export {
  MARKET_CONTEXT_STATE_CACHE_KEY,
  MARKET_CONTEXT_STATE_TTL_SECONDS,
  MARKET_CONTEXT_LKG_CACHE_KEY,
  MARKET_CONTEXT_LKG_TTL_SECONDS,
};
