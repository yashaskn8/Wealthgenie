import { useEffect, useState } from 'react';
import * as api from '../services/api';

const OPEN_REFRESH_MS = 90_000;
const CLOSED_REFRESH_MS = 10 * 60_000;
const OPEN_REVALIDATE_MS = 60_000;
const CLOSED_REVALIDATE_MS = 5 * 60_000;

const store = {
  snapshot: null,
  error: null,
  isLoading: false,
  isRefreshing: false,
  lastResolvedAt: null,
  revision: 0,
  transport: {
    lastAttemptAt: null,
    lastSuccessfulAt: null,
    revalidationStatus: 'IDLE',
  },
};

const listeners = new Set();
let inFlight = null;
let requestGeneration = 0;
let pollTimer = null;
let consumerCount = 0;
let lifecycleBound = false;
let lifecycleRevalidate = null;

function emit() {
  listeners.forEach(listener => listener());
}

function currentCadence() {
  const status = store.snapshot?.marketSnapshot?.status;
  const session = store.snapshot?.marketSnapshot?.marketSession?.status;
  return status === 'CURRENT' || session === 'MARKET_OPEN' ? OPEN_REFRESH_MS : CLOSED_REFRESH_MS;
}

function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer);
  if (consumerCount === 0) {
    pollTimer = null;
    return;
  }
  pollTimer = setTimeout(() => {
    pollTimer = null;
    requestMarketContext({ reason: 'poll' });
  }, currentCadence());
}

function shouldRevalidate() {
  if (!store.lastResolvedAt) return true;
  const age = Date.now() - store.lastResolvedAt;
  const threshold = store.snapshot?.marketSnapshot?.status === 'CURRENT'
    || store.snapshot?.marketSnapshot?.marketSession?.status === 'MARKET_OPEN'
    ? OPEN_REVALIDATE_MS
    : CLOSED_REVALIDATE_MS;
  return age >= threshold;
}

async function requestMarketContext({ force = false } = {}) {
  if (inFlight) return inFlight;
  if (!force && !shouldRevalidate()) return store.snapshot;

  store.transport = {
    ...store.transport,
    lastAttemptAt: new Date().toISOString(),
    revalidationStatus: 'REFRESHING',
  };
  store.isLoading = !store.snapshot;
  store.isRefreshing = Boolean(store.snapshot);
  emit();
  const generation = ++requestGeneration;
  const request = api.getCurrentMarketContext()
    .then((snapshot) => {
      if (generation !== requestGeneration) return store.snapshot;
      store.snapshot = snapshot;
      store.error = null;
      store.lastResolvedAt = Date.now();
      store.revision += 1;
      store.transport = {
        ...store.transport,
        lastSuccessfulAt: new Date().toISOString(),
        revalidationStatus: 'SUCCESS',
      };
      return snapshot;
    })
    .catch((error) => {
      if (generation !== requestGeneration) return store.snapshot;
      if (error?.code !== 'REQUEST_ABORTED') {
        store.error = error?.message || 'Live market context request failed.';
        store.transport = {
          ...store.transport,
          revalidationStatus: 'FAILED',
        };
      } else {
        store.transport = {
          ...store.transport,
          revalidationStatus: 'IDLE',
        };
      }
      return store.snapshot;
    })
    .finally(() => {
      if (generation !== requestGeneration) return;
      store.isLoading = false;
      store.isRefreshing = false;
      inFlight = null;
      emit();
      schedulePoll();
    });
  inFlight = request;
  return inFlight;
}

function acceptMarketContext(snapshot) {
  if (!snapshot?.marketSnapshot) return false;
  requestGeneration += 1;
  inFlight = null;
  store.snapshot = snapshot;
  store.error = null;
  store.isLoading = false;
  store.isRefreshing = false;
  store.lastResolvedAt = Date.now();
  store.revision += 1;
  store.transport = {
    ...store.transport,
    lastSuccessfulAt: new Date().toISOString(),
    revalidationStatus: 'SUCCESS',
  };
  emit();
  schedulePoll();
  return true;
}

function bindLifecycle() {
  if (lifecycleBound || typeof window === 'undefined') return;
  lifecycleRevalidate = () => {
    if (consumerCount === 0 || document.visibilityState === 'hidden' || !shouldRevalidate()) return;
    requestMarketContext();
  };
  window.addEventListener('focus', lifecycleRevalidate);
  document.addEventListener('visibilitychange', lifecycleRevalidate);
  lifecycleBound = true;
}

function unbindLifecycle() {
  if (!lifecycleBound || typeof window === 'undefined') return;
  window.removeEventListener('focus', lifecycleRevalidate);
  document.removeEventListener('visibilitychange', lifecycleRevalidate);
  lifecycleRevalidate = null;
  lifecycleBound = false;
}

function subscribe(listener) {
  listeners.add(listener);
  consumerCount += 1;
  bindLifecycle();
  // Normal consumers share the current snapshot and cadence. Only the explicit
  // refresh control bypasses revalidation thresholds.
  requestMarketContext();
  return () => {
    listeners.delete(listener);
    consumerCount = Math.max(0, consumerCount - 1);
    if (consumerCount === 0) {
      unbindLifecycle();
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
    }
  };
}

export function useMarketContext() {
  const [, forceRender] = useState(0);
  useEffect(() => subscribe(() => forceRender(value => value + 1)), []);
  return {
    marketContext: store.snapshot,
    marketContextError: store.error,
    marketContextLoading: store.isLoading,
    marketContextRefreshing: store.isRefreshing,
    marketContextTransport: store.transport,
    marketContextRevision: store.revision,
    refreshMarketContext: () => requestMarketContext({ force: true }),
    acceptMarketContext,
  };
}

export function resetMarketContextStoreForTest() {
  unbindLifecycle();
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  store.snapshot = null;
  store.error = null;
  store.isLoading = false;
  store.isRefreshing = false;
  store.lastResolvedAt = null;
  store.revision = 0;
  store.transport = {
    lastAttemptAt: null,
    lastSuccessfulAt: null,
    revalidationStatus: 'IDLE',
  };
  inFlight = null;
  requestGeneration += 1;
  consumerCount = 0;
  listeners.clear();
}
