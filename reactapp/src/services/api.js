/**
 * WealthGenie API Client
 * Configured for the Express backend.
 * Production authentication uses an HttpOnly session cookie. Optional development
 * bearer compatibility is memory-only and never persists authentication material.
 */

import { toFinancialProfilePayload } from '../utils/financialProfile';
import {
  PROFILE_USER_FLOW_TIMEOUT_MS,
  WTI_USER_FLOW_TIMEOUT_MS,
} from '../../../shared/demoPreflightContracts.js';

const API_BASE = (import.meta.env.VITE_API_URL || '/api').replace(/\/+$/, '');
const configuredTimeout = Number(import.meta.env.VITE_API_TIMEOUT_MS);
const DEFAULT_TIMEOUT_MS = Number.isFinite(configuredTimeout) && configuredTimeout >= 1000
  ? configuredTimeout
  : 20000;
const BEARER_AUTH_ENABLED = !import.meta.env.PROD
  && import.meta.env.VITE_ENABLE_BEARER_AUTH !== 'false';

const LEGACY_SENSITIVE_KEYS = [
  'wg_token', 'wg_user', 'wg_profile', 'wg_profile_complete', 'wealthgenie_user_profile',
];

export function purgeSensitiveBrowserStorage({ includeChatSession = false } = {}) {
  if (typeof window === 'undefined') return;
  for (const storageName of ['localStorage', 'sessionStorage']) {
    try {
      const storage = window[storageName];
      LEGACY_SENSITIVE_KEYS.forEach(key => storage.removeItem(key));
      if (includeChatSession) storage.removeItem('genie_session_id');
    } catch {
      // Privacy-disabled storage needs no cleanup.
    }
  }
}

function readCookie(name) {
  if (typeof document === 'undefined') return null;
  const prefix = `${name}=`;
  for (const entry of document.cookie.split(';')) {
    const value = entry.trim();
    if (value.startsWith(prefix)) {
      try { return decodeURIComponent(value.slice(prefix.length)); } catch { return null; }
    }
  }
  return null;
}

// Sensitive state is memory-only; a refresh restores it through /auth/session.
let authToken = null;
let csrfToken = readCookie('wg_csrf');
let authRevision = 0;
const authListeners = new Set();
const activeAuthenticatedRequests = new Set();
const authTabId = generateUUID();
const remoteAuthRevisions = new Map();
let authBroadcastRevision = 0;
let authBroadcastChannel = null;
const AUTH_CHANNEL_NAME = 'wealthgenie-auth-state';
const AUTH_STORAGE_KEY = '__wealthgenie_auth_signal__';
const PROFILE_CHANNEL_NAME = 'wealthgenie-profile-state';
const PROFILE_STORAGE_KEY = '__wealthgenie_profile_signal__';
let profileBroadcastChannel = null;
let profileBroadcastRevision = 0;
const profileListeners = new Set();
const remoteProfileRevisions = new Map();

// Track the current authenticated user
let currentUser = null;

purgeSensitiveBrowserStorage();

function readAuthSignal(value) {
  if (!value || typeof value !== 'object') return null;
  const { source, revision, type } = value;
  if (typeof source !== 'string' || source === authTabId || !Number.isSafeInteger(revision)
      || revision < 1 || !['SESSION_CHANGED', 'AUTH_INVALIDATED'].includes(type)) return null;
  if (revision <= (remoteAuthRevisions.get(source) || 0)) return null;
  remoteAuthRevisions.set(source, revision);
  return type;
}

function broadcastAuthSignal(type) {
  if (typeof window === 'undefined') return;
  const message = { source: authTabId, revision: ++authBroadcastRevision, type };
  try {
    if (authBroadcastChannel) authBroadcastChannel.postMessage(message);
    else {
      window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(message));
      window.localStorage.removeItem(AUTH_STORAGE_KEY);
    }
  } catch {
    // Auth remains server-authorized when browser messaging or storage is unavailable.
  }
}

function readProfileSignal(value) {
  if (!value || typeof value !== 'object') return false;
  const { source, revision, type } = value;
  if (typeof source !== 'string' || source === authTabId || !Number.isSafeInteger(revision)
      || revision < 1 || type !== 'PROFILE_CHANGED') return false;
  if (revision <= (remoteProfileRevisions.get(source) || 0)) return false;
  remoteProfileRevisions.set(source, revision);
  return true;
}

function broadcastProfileSignal() {
  if (typeof window === 'undefined') return;
  const message = { source: authTabId, revision: ++profileBroadcastRevision, type: 'PROFILE_CHANGED' };
  try {
    if (profileBroadcastChannel) profileBroadcastChannel.postMessage(message);
    else {
      window.localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(message));
      window.localStorage.removeItem(PROFILE_STORAGE_KEY);
    }
  } catch {
    // Server state remains authoritative when browser signaling is unavailable.
  }
}

function receiveProfileSignal(value) {
  if (readProfileSignal(value)) profileListeners.forEach(listener => listener());
}

function abortAuthenticatedRequests() {
  for (const controller of activeAuthenticatedRequests) {
    controller.abort(new ApiError('Authentication changed in another request.', { code: 'REQUEST_ABORTED' }));
  }
  activeAuthenticatedRequests.clear();
}

function clearLocalAuthState({ includeChatSession = false } = {}) {
  authToken = null;
  csrfToken = null;
  currentUser = null;
  abortAuthenticatedRequests();
  purgeSensitiveBrowserStorage({ includeChatSession });
  notifyAuthChange();
}

async function receiveAuthSignal(value) {
  const type = readAuthSignal(value);
  if (!type) return;
  clearLocalAuthState({ includeChatSession: true });
  try {
    await restoreSession({ suppressAuthBroadcast: true });
  } catch {
    // The server session may have ended before this tab could restore it.
  }
}

if (typeof window !== 'undefined') {
  if (typeof window.BroadcastChannel === 'function') {
    authBroadcastChannel = new window.BroadcastChannel(AUTH_CHANNEL_NAME);
    authBroadcastChannel.addEventListener('message', event => { void receiveAuthSignal(event.data); });
  } else {
    window.addEventListener('storage', event => {
      if (event.key !== AUTH_STORAGE_KEY || !event.newValue) return;
      try { void receiveAuthSignal(JSON.parse(event.newValue)); } catch { /* Ignore malformed signals. */ }
    });
  }
  if (typeof window.BroadcastChannel === 'function') {
    profileBroadcastChannel = new window.BroadcastChannel(PROFILE_CHANNEL_NAME);
    profileBroadcastChannel.addEventListener('message', event => receiveProfileSignal(event.data));
  } else {
    window.addEventListener('storage', event => {
      if (event.key !== PROFILE_STORAGE_KEY || !event.newValue) return;
      try { receiveProfileSignal(JSON.parse(event.newValue)); } catch { /* Ignore malformed signals. */ }
    });
  }
}

function notifyAuthChange() {
  authRevision += 1;
  authListeners.forEach(listener => listener());
}

export function subscribeAuth(listener) {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

export function getAuthSnapshot() {
  return authRevision;
}

/** A profile signal contains no profile fields; subscribers reload canonical server state. */
export function subscribeProfileChanges(listener) {
  profileListeners.add(listener);
  return () => profileListeners.delete(listener);
}

export function setUserInfo(user, { broadcast = true } = {}) {
  currentUser = user;
  notifyAuthChange();
  if (broadcast) broadcastAuthSignal(user ? 'SESSION_CHANGED' : 'AUTH_INVALIDATED');
}

export function getUserInfo() {
  return currentUser;
}

export function setAuthToken(token, { broadcast = true } = {}) {
  authToken = BEARER_AUTH_ENABLED ? token : null;
  notifyAuthChange();
  if (broadcast) broadcastAuthSignal(token ? 'SESSION_CHANGED' : 'AUTH_INVALIDATED');
}

export function getAuthToken() {
  return authToken;
}

export function clearAuthToken() {
  clearLocalAuthState();
  broadcastAuthSignal('AUTH_INVALIDATED');
}

export function clearUserSession() {
  clearLocalAuthState({ includeChatSession: true });
  broadcastAuthSignal('AUTH_INVALIDATED');
}

export function generateUUID(randomSource = globalThis.crypto) {
  if (typeof randomSource?.randomUUID === 'function') {
    return randomSource.randomUUID();
  }
  if (typeof randomSource?.getRandomValues !== 'function') {
    throw new Error('Secure request identification is unavailable. Use a secure browser context and try again.');
  }
  const bytes = new Uint8Array(16);
  randomSource.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return [value.slice(0, 8), value.slice(8, 12), value.slice(12, 16), value.slice(16, 20), value.slice(20)].join('-');
}

export class ApiError extends Error {
  constructor(message, {
    status = null,
    code = 'API_ERROR',
    requestId = null,
    details = [],
    retryable = false,
    retryAfterMs = null,
    cause,
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(30000, Math.max(0, seconds * 1000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(30000, Math.max(0, date - Date.now())) : null;
}

function retryDelay(attempt, retryAfterMs) {
  if (Number.isFinite(retryAfterMs)) return retryAfterMs;
  const exponential = Math.min(5000, 300 * (2 ** attempt));
  return Math.round(exponential * (0.75 + Math.random() * 0.5));
}

function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ApiError('Request cancelled.', { code: 'REQUEST_ABORTED' }));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ApiError('Request cancelled.', { code: 'REQUEST_ABORTED' }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function request(method, path, data = null, options = {}) {
  const requestAuthRevision = authRevision;
  const requestWasAuthenticated = Boolean(authToken || currentUser);
  const url = `${API_BASE}${path}`;
  const upperMethod = method.toUpperCase();
  const isMutating = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(upperMethod);
  const {
    headers: optionHeaders = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = isMutating ? 0 : 1,
    signal: externalSignal,
    suppressAuthBroadcast = false,
    preserveAuthOn401 = false,
    ...fetchOptions
  } = options;
  const headers = { Accept: 'application/json', ...optionHeaders };
  if (data !== null && data !== undefined) headers['Content-Type'] = 'application/json';
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (!headers['X-Correlation-ID'] && !headers['x-correlation-id']) {
    headers['X-Correlation-ID'] = generateUUID();
  }

  // Attach Idempotency-Key for mutating requests (POST, PUT, DELETE, PATCH)
  if (isMutating) {
    if (!headers['Idempotency-Key'] && !headers['idempotency-key']) {
      headers['Idempotency-Key'] = generateUUID();
    }
    // A late /auth/session Set-Cookie can update the browser cookie jar after
    // this module cached a token from a newer login. The cookie is the value
    // the server will compare, so prefer it over the in-memory copy.
    const activeCsrfToken = readCookie('wg_csrf') || csrfToken;
    if (!authToken && activeCsrfToken && !headers['X-CSRF-Token'] && !headers['x-csrf-token']) {
      headers['X-CSRF-Token'] = activeCsrfToken;
    }
  }

  const maxRetries = Math.max(0, Math.min(3, Number(retries) || 0));
  const boundedTimeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Number(timeoutMs)
    : DEFAULT_TIMEOUT_MS;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (externalSignal?.aborted) {
      throw new ApiError('Request cancelled.', { code: 'REQUEST_ABORTED' });
    }
    if (requestWasAuthenticated && authRevision !== requestAuthRevision) {
      throw new ApiError('Request cancelled because authentication changed.', { code: 'REQUEST_ABORTED' });
    }

    const controller = new AbortController();
    if (requestWasAuthenticated) activeAuthenticatedRequests.add(controller);
    let timedOut = false;
    const abortFromCaller = () => controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener('abort', abortFromCaller, { once: true });
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, boundedTimeout);

    const config = {
      method: upperMethod,
      headers,
      credentials: 'include',
      ...fetchOptions,
      signal: controller.signal,
    };
    if (data !== null && data !== undefined) config.body = JSON.stringify(data);

    try {
      const res = await fetch(url, config);
      let json = null;
      try {
        json = await res.json();
      } catch {
        // Some proxies and valid 204 responses do not return a JSON body.
      }

      if (requestWasAuthenticated && authRevision !== requestAuthRevision) {
        throw new ApiError('Request cancelled because authentication changed.', { code: 'REQUEST_ABORTED' });
      }
      const requestId = res.headers?.get?.('x-correlation-id') || json?.request_id || headers['X-Correlation-ID'];
      if (!res.ok) {
        if (res.status === 401 && authRevision === requestAuthRevision && !preserveAuthOn401) {
          clearLocalAuthState({ includeChatSession: true });
          if (!suppressAuthBroadcast) broadcastAuthSignal('AUTH_INVALIDATED');
          if (typeof window !== 'undefined' && window.location.pathname !== '/' && window.location.pathname !== '/login') {
            window.location.href = '/login';
          }
        }
        const responseDetails = (Array.isArray(json?.details)
          || (json?.details && typeof json.details === 'object'))
          ? json.details
          : [];
        const validationMessage = Array.isArray(responseDetails) ? responseDetails.join(' ') : '';
        throw new ApiError(
          json?.message || validationMessage || json?.error || `Request failed with status ${res.status}`,
          {
            status: res.status,
            code: json?.code || 'HTTP_ERROR',
            requestId,
            details: responseDetails,
            retryable: RETRYABLE_STATUS.has(res.status),
            retryAfterMs: parseRetryAfter(res.headers?.get?.('retry-after')),
          }
        );
      }
      return json;
    } catch (error) {
      let apiError = error;
      if (!(error instanceof ApiError)) {
        if (timedOut) {
          apiError = new ApiError('The server took too long to respond.', {
            code: 'REQUEST_TIMEOUT', retryable: true, cause: error,
          });
        } else if (externalSignal?.aborted) {
          apiError = new ApiError('Request cancelled.', { code: 'REQUEST_ABORTED', cause: error });
        } else if (controller.signal.aborted && authRevision !== requestAuthRevision) {
          apiError = new ApiError('Request cancelled because authentication changed.', { code: 'REQUEST_ABORTED', cause: error });
        } else {
          apiError = new ApiError('Unable to reach the server. Check your connection and try again.', {
            code: 'NETWORK_ERROR', retryable: true, cause: error,
          });
        }
      }

      if (apiError.retryable && attempt < maxRetries) {
        await wait(retryDelay(attempt, apiError.retryAfterMs), externalSignal);
        continue;
      }
      throw apiError;
    } finally {
      clearTimeout(timeoutId);
      externalSignal?.removeEventListener('abort', abortFromCaller);
      activeAuthenticatedRequests.delete(controller);
    }
  }

  throw new ApiError('Request failed.', { code: 'API_ERROR' });
}

// ─── AUTH ─────────────────────────────────────────────────
export async function register(name, email, password, mobile) {
  const data = await request('POST', '/auth/register', { name, email, password, mobile });
  csrfToken = data.csrfToken || readCookie('wg_csrf');
  setAuthToken(data.token || null, { broadcast: false });
  if (data.user) setUserInfo(data.user, { broadcast: false });
  broadcastAuthSignal('SESSION_CHANGED');
  return data;
}

export async function login(email, password) {
  const data = await request('POST', '/auth/login', { email, password });
  csrfToken = data.csrfToken || readCookie('wg_csrf');
  setAuthToken(data.token || null, { broadcast: false });
  if (data.user) setUserInfo(data.user, { broadcast: false });
  broadcastAuthSignal('SESSION_CHANGED');
  return data;
}

const INVALID_LOGOUT_SESSION_CODES = new Set([
  'AUTH_REQUIRED',
  'AUTH_TOKEN_INVALID',
  'AUTH_TOKEN_EXPIRED',
  'AUTH_TOKEN_REVOKED',
]);

export async function logout() {
  if (!authToken && !currentUser) return null;
  try {
    const result = await request('POST', '/auth/logout', {}, { timeoutMs: 5000, retries: 0, preserveAuthOn401: true });
    clearUserSession();
    return result;
  } catch (error) {
    // These server-authenticated responses prove this credential is already unusable.
    // Unavailable or ambiguous failures retain the current session so the user can retry.
    if (error.status === 401 && INVALID_LOGOUT_SESSION_CODES.has(error.code)) {
      clearUserSession();
      return { alreadyInvalid: true };
    }
    throw error;
  }
}

export async function restoreSession(options = {}) {
  const requestAuthRevision = authRevision;
  const data = await request('GET', '/auth/session', null, {
    retries: 0,
    suppressAuthBroadcast: true,
    ...options,
  });
  if (authRevision !== requestAuthRevision) return data;
  csrfToken = data?.csrfToken || readCookie('wg_csrf');
  if (data?.user) setUserInfo(data.user, { broadcast: false });
  return data;
}

// ─── PROFILE ─────────────────────────────────────────────
export async function buildProfile(profile, requestOptions = {}) {
  return request('POST', '/profile/build', toFinancialProfilePayload(profile), requestOptions);
}

export async function precomputeProfile(profile, requestOptions = {}) {
  return request('POST', '/profile/precompute', toFinancialProfilePayload(profile), {
    timeoutMs: PROFILE_USER_FLOW_TIMEOUT_MS,
    ...requestOptions,
  });
}

export async function completeFinancialProfile(profile, candidateId = null, requestOptions = {}) {
  try {
    return await request('POST', '/profile/complete', {
      ...toFinancialProfilePayload(profile),
      ...(candidateId ? { candidateId } : {}),
    }, {
      timeoutMs: PROFILE_USER_FLOW_TIMEOUT_MS,
      ...requestOptions,
    });
  } finally {
    // The server may commit before the response is lost. Invalidate other tabs
    // even on timeout/abort so they reload canonical state instead of retaining
    // a recommendation bound to an older profile revision.
    broadcastProfileSignal();
  }
}

export async function getCurrentRecommendation(profileId, options = {}) {
  if (!profileId) throw new Error('A profile ID is required to restore a recommendation.');
  return request('GET', `/recommend/current?profileId=${encodeURIComponent(profileId)}`, null, {
    retries: 0,
    ...options,
  });
}

// Authoritative risk-group shortlist. Only the backend ranks and filters candidates.
// These endpoints are disabled until the financial architecture's storage gates pass.
export async function getRiskShortlist(profileId, options = {}) {
  if (!profileId) throw new TypeError('A profile ID is required for risk-group suitability.');
  return request('GET', `/recommendation-shortlist?profileId=${encodeURIComponent(profileId)}`,
    null, { retries:0, ...options });
}
export async function getSavedRiskShortlist(profileId, options = {}) {
  if (!profileId) throw new TypeError('A profile ID is required for saved recommendations.');
  return request('GET', `/recommendation-shortlist/saved?profileId=${encodeURIComponent(profileId)}`,
    null, { retries:0, ...options });
}
export async function saveRiskShortlist(profileId, options = {}) {
  if (!profileId) throw new TypeError('A profile ID is required to save a shortlist.');
  return request('POST', '/recommendation-shortlist/save', { profileId }, { retries:0, ...options });
}
export async function getQualifiedFamilyTopProducts(familyId, profileId, options = {}) {
  if (!/^[a-zA-Z0-9:_-]{1,160}$/.test(familyId) || !/^[a-fA-F0-9]{24}$/.test(profileId)) {
    throw new TypeError('A current profile and a valid financial family ID are required.');
  }
  return request('POST', '/financial-universe/' + encodeURIComponent(familyId) + '/top-products',
    { profileId }, { retries: 0, ...options });
}

export async function getThreeProductReadyFamilies(options = {}) {
  return request('GET', '/financial-universe/three-product-families', null,
    { retries: 0, ...options });
}

export async function getFinancialUniverseCategories(options={}) {
  return request('GET','/financial-universe/categories',null,{retries:0,...options});
}
export async function getFinancialUniverseSummary(options={}) {
  return request('GET', '/financial-universe/summary', null, { retries:0, ...options });
}
export async function getFinancialUniverse({category, subcategory, cursor, limit=20}={},options={}) {
  const q = new URLSearchParams({limit:String(limit)});
  if (category) q.set('category',category);
  if (subcategory) q.set('subcategory',subcategory);
  if (cursor) q.set('cursor',cursor);
  return request('GET', `/financial-universe?${q.toString()}`, null, { retries:0, ...options });
}

// On-demand keyless research. No provider facts are persisted or auto-promoted
// into the qualified product/tax calculation authority.
export async function searchFreeMutualFunds(q, options={}) {
  return request('GET','/free-financial-sources/mutual-funds/search?q='+encodeURIComponent(q),
    null,{retries:0,...options});
}
export async function simulateFreeMutualFundNavResearch(input,options={}) {
  return request('POST','/free-financial-sources/mutual-funds/simulate',
    input,{retries:0,...options});
}
export async function getFreeFinancialSourceCoverage(options={}) {
  return request('GET','/free-financial-sources/coverage',null,{retries:0,...options});
}
export async function getFreeSmallSavingsRates(options={}) {
  return request('GET','/free-financial-sources/small-savings',null,{retries:0,...options});
}
export async function calculateFreeSmallSavingsGross(input,options={}) {
  return request('POST','/free-financial-sources/small-savings/calculate',
    input,{retries:0,...options});
}

export async function getCurrentProfile(options = {}) {
  return request('GET', '/profile/current', null, { retries: 0, ...options });
}

export async function updateProfile(profileId, profile, requestOptions = {}) {
  try {
    return await request(
      'PUT',
      `/profile/${profileId}`,
      toFinancialProfilePayload(profile, { requireVersion: true }),
      requestOptions,
    );
  } finally {
    broadcastProfileSignal();
  }
}
// ─── RECOMMENDATIONS ─────────────────────────────────────
export async function getRecommendations(profileId, options = {}) {
  // Recommendation generation can include a cold ML-service prediction and an
  // audited MongoDB transaction. Keep the UI request alive for the same bounded
  // window used by the real-dependency browser contract instead of aborting at
  // the generic 20-second API timeout and leaving every dashboard panel empty.
  return request('POST', '/recommend', { profileId }, { timeoutMs: 90000, ...options });
}

export async function runPlanReview(profileId, options = {}) {
  if (!profileId) throw new TypeError('A profile ID is required to review a plan.');
  return request('POST', '/agent/plan-review', { profileId }, { timeoutMs: 45000, retries: 0, ...options });
}

export async function getPlanReviewRun(runId, options = {}) {
  if (!runId) throw new TypeError('A plan review run ID is required.');
  return request('GET', `/agent/plan-review/${encodeURIComponent(runId)}`, null, { retries: 0, ...options });
}

export async function getCurrentPlanReviewRun(profileId, options = {}) {
  if (!profileId) throw new TypeError('A profile ID is required.');
  return request('GET', `/agent/plan-review/current?profileId=${encodeURIComponent(profileId)}`, null, { retries: 0, ...options });
}

export async function cancelPlanReviewRun(runId, options = {}) {
  if (!runId) throw new TypeError('A plan review run ID is required.');
  return request('POST', `/agent/plan-review/${encodeURIComponent(runId)}/cancel`, {}, { retries: 0, ...options });
}

export async function actOnPlanReview(runId, action, options = {}) {
  if (!runId) throw new TypeError('A plan review run ID is required.');
  return request('POST', `/agent/plan-review/${encodeURIComponent(runId)}/action`, { action }, { retries: 0, ...options });
}

export async function getGenieProofCapabilities(options = {}) {
  return request('GET', '/genieproof/capabilities', null, { retries: 0, ...options });
}

export async function checkGenieProofClaims(offerText, options = {}) {
  if (typeof offerText !== 'string' || !offerText.trim()) {
    throw new TypeError('Enter a financial claim to check.');
  }
  return request('POST', '/genieproof/check', { offerText }, { retries: 0, ...options });
}

export async function reviewGenieProofWithNvidia(statement, claimId, options = {}) {
  if (typeof statement !== 'string' || !statement.trim()
    || typeof claimId !== 'string' || !/^[a-f0-9]{32}$/.test(claimId)) {
    throw new TypeError('A checked financial statement and claim ID are required.');
  }
  return request('POST', '/genieproof/nvidia-review',
    { statement, claimId, consent: true }, { retries: 0, ...options });
}

export async function calculateGenieProofScenario(scenario, options = {}) {
  return request('POST', '/genieproof/calculate', scenario, { retries: 0, ...options });
}

export async function previewGenieProofClaims(offerText, options = {}) {
  if (typeof offerText !== 'string' || !offerText.trim()) {
    throw new TypeError('Offer text is required for an unsaved claim preview.');
  }
  return request('POST', '/genieproof/extract-preview', { offerText }, { retries: 0, ...options });
}

export async function extractGenieProofClaims(offerText, options = {}) {
  return request('POST', '/genieproof/extract', { offerText }, { retries: 0, ...options });
}

export async function createGenieProofCase({ offerText, submissionHash, savingConsent, confirmedClaims }, options = {}) {
  return request('POST', '/genieproof/cases', { offerText, submissionHash, savingConsent, confirmedClaims }, { retries: 0, ...options });
}

export async function listGenieProofCases(options = {}) {
  return request('GET', '/genieproof/cases', null, { retries: 0, ...options });
}

export async function getGenieProofCase(caseId, options = {}) {
  if (!caseId) throw new TypeError('A GenieProof case ID is required.');
  return request('GET', `/genieproof/cases/${encodeURIComponent(caseId)}`, null, { retries: 0, ...options });
}

export async function verifyGenieProofCase(caseId, options = {}) {
  if (!caseId) throw new TypeError('A GenieProof case ID is required.');
  return request('GET', `/genieproof/cases/${encodeURIComponent(caseId)}/verify`, null, { retries: 0, ...options });
}

export async function listGenieProofRevisions(caseId, options = {}) {
  if (!caseId) throw new TypeError('A GenieProof case ID is required.');
  return request('GET', `/genieproof/cases/${encodeURIComponent(caseId)}/revisions`, null, { retries: 0, ...options });
}

export async function reassessGenieProofCase({ caseId, expectedRevision, expectedManifestHash, reassessmentConsent }, options = {}) {
  if (!caseId || !Number.isInteger(expectedRevision) || !expectedManifestHash) {
    throw new TypeError('The current GenieProof case revision and manifest hash are required.');
  }
  return request('POST', `/genieproof/cases/${encodeURIComponent(caseId)}/reassess`, {
    expectedRevision, expectedManifestHash, reassessmentConsent,
  }, { retries: 0, ...options });
}

export async function withdrawGenieProofConsent(caseId, options = {}) {
  if (!caseId) throw new TypeError('A GenieProof case ID is required.');
  return request('POST', `/genieproof/cases/${encodeURIComponent(caseId)}/consent/withdraw`, { withdrawConsent: true }, { retries: 0, ...options });
}

export async function getProofWatchAvailability(caseId, options = {}) {
  if (!caseId) throw new TypeError('A GenieProof case ID is required.');
  return request('GET', `/genieproof/cases/${encodeURIComponent(caseId)}/watch/availability`, null, { retries: 0, ...options });
}

export async function createProofWatch(caseId, options = {}) {
  if (!caseId) throw new TypeError('A GenieProof case ID is required.');
  return request('POST', `/genieproof/cases/${encodeURIComponent(caseId)}/watch`, { watchConsent: true }, { retries: 0, ...options });
}

export async function listProofWatches({ caseId, limit = 25 } = {}, options = {}) {
  const query = new URLSearchParams({ limit: String(limit) });
  if (caseId) query.set('caseId', caseId);
  return request('GET', `/genieproof/watches?${query.toString()}`, null, { retries: 0, ...options });
}

export async function updateProofWatch(watchId, action, options = {}) {
  if (!watchId) throw new TypeError('A ProofBreak watch ID is required.');
  return request('PATCH', `/genieproof/watches/${encodeURIComponent(watchId)}`, { action }, { retries: 0, ...options });
}

export async function deleteProofWatch(watchId, options = {}) {
  if (!watchId) throw new TypeError('A ProofBreak watch ID is required.');
  return request('DELETE', `/genieproof/watches/${encodeURIComponent(watchId)}`, null, { retries: 0, ...options });
}

export async function listProofBreakEvents(caseId, { limit = 25, cursor = null } = {}, options = {}) {
  if (!caseId) throw new TypeError('A GenieProof case ID is required.');
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set('cursor', cursor);
  return request('GET', `/genieproof/cases/${encodeURIComponent(caseId)}/events?${query.toString()}`, null, { retries: 0, ...options });
}

export async function acknowledgeProofBreakEvent(eventId, options = {}) {
  if (!eventId) throw new TypeError('A ProofBreak event ID is required.');
  return request('POST', `/genieproof/events/${encodeURIComponent(eventId)}/acknowledge`, { acknowledge: true }, { retries: 0, ...options });
}

export async function deleteGenieProofCase(caseId, options = {}) {
  if (!caseId) throw new TypeError('A GenieProof case ID is required.');
  return request('DELETE', `/genieproof/cases/${encodeURIComponent(caseId)}`, null, { retries: 0, ...options });
}

export async function listAuthorizedMandates(options = {}) {
  return request('GET', '/agent/mandates', null, { retries: 0, ...options });
}

export async function getAuthorizedMandate(mandateId, options = {}) {
  if (!mandateId) throw new TypeError('A mandate ID is required.');
  return request('GET', `/agent/mandates/${encodeURIComponent(mandateId)}`, null, { retries: 0, ...options });
}

export async function getMandateApprovalOptions(mandateId, options = {}) {
  if (!mandateId) throw new TypeError('A mandate ID is required.');
  return request('POST', `/agent/mandates/${encodeURIComponent(mandateId)}/approval/options`, {}, { retries: 0, ...options });
}

export async function getPasskeyRegistrationOptions(options = {}) {
  return request('POST', '/agent/passkeys/registration/options', {}, { retries: 0, ...options });
}

export async function verifyPasskeyRegistration(response, options = {}) {
  if (!response) throw new TypeError('A passkey registration response is required.');
  return request('POST', '/agent/passkeys/registration/verify', response, { retries: 0, ...options });
}

export async function verifyMandateApproval(mandateId, assertion, options = {}) {
  if (!mandateId || !assertion) throw new TypeError('A mandate ID and approval assertion are required.');
  return request('POST', `/agent/mandates/${encodeURIComponent(mandateId)}/approval/verify`, assertion, { retries: 0, ...options });
}

export async function revokeAuthorizedMandate(mandateId, reason, options = {}) {
  if (!mandateId) throw new TypeError('A mandate ID is required.');
  return request('POST', `/agent/mandates/${encodeURIComponent(mandateId)}/revoke`, { reason }, { retries: 0, ...options });
}

export async function executeAuthorizedMandate(mandateId, options = {}) {
  if (!mandateId) throw new TypeError('A mandate ID is required.');
  return request('POST', `/agent/mandates/${encodeURIComponent(mandateId)}/execute`, {}, { retries: 0, ...options });
}

export async function getExecutionReceipt(receiptId, options = {}) {
  if (!receiptId) throw new TypeError('A receipt ID is required.');
  return request('GET', `/agent/receipts/${encodeURIComponent(receiptId)}`, null, { retries: 0, ...options });
}

export async function verifyExecutionReceipt(receiptId, options = {}) {
  if (!receiptId) throw new TypeError('A receipt ID is required.');
  return request('GET', `/agent/receipts/${encodeURIComponent(receiptId)}/verify`, null, { retries: 0, ...options });
}

export async function getPlanHealth(profileId, options = {}) {
  if (!profileId) throw new TypeError('A profile ID is required.');
  return request('GET', `/agent/plan-health?profileId=${encodeURIComponent(profileId)}`, null, options);
}

export async function getPlanHealthEvents(options = {}) {
  return request('GET', '/agent/plan-health/events', null, options);
}

export async function fetchAdvisory(recommendationId, options = {}) {
  return request('POST', `/recommend/${recommendationId}/advisory`, {}, { timeoutMs: 90000, ...options });
}

// ─── VERIFIED MARKET DATA (PHASE 1) ──────────────────────
export async function getBenchmarkMarketFacts(options = {}) {
  return request('GET', '/market/benchmarks', null, options);
}

/** Read only authorized, retained benchmark observations from MongoDB. */
export async function getStoredBenchmarkMarketFacts(options = {}) {
  return request('GET', '/market-data/quotes/persisted', null, { retries: 0, ...options });
}

/** Qualified retained equity history; server independently rechecks provider rights. */
export async function getStoredEquityHistory({
  exchange = 'NSE', symbol, isin, fromDate, toDate, basis = 'RAW',
}, options = {}) {
  const params = new URLSearchParams({ exchange, symbol, isin, fromDate, toDate, basis });
  return request('GET', '/market-data/equity-history/persisted?' + params.toString(), null, {
    retries: 0, ...options,
  });
}

export async function getMutualFundNavFacts(schemeCodes, options = {}) {
  const normalized = [...new Set((schemeCodes || []).map(value => String(value).trim()).filter(Boolean))];
  if (normalized.length === 0 || normalized.length > 50 || normalized.some(code => !/^\d+$/.test(code))) {
    throw new TypeError('schemeCodes must contain 1-50 AMFI numeric scheme codes.');
  }
  return request('GET', `/market/mutual-funds/nav?schemeCodes=${encodeURIComponent(normalized.join(','))}`, null, options);
}

// ─── INSTRUMENTS ─────────────────────────────────────────
export async function getInstruments(type, sort = 'rate', order = 'desc', limit = 20) {
  const params = new URLSearchParams();
  if (type) params.set('type', type);
  params.set('sort', sort);
  params.set('order', order);
  params.set('limit', limit);
  return request('GET', `/instruments?${params.toString()}`);
}

export async function rankInvestmentCandidates(profileId, parentInstrumentId, taxCalculationContext = null, requestOptions = {}, financialStateBinding = null) {
  let actualTaxContext = null;
  let actualOptions = requestOptions;
  if (taxCalculationContext && !taxCalculationContext.signal && !taxCalculationContext.timeoutMs && !taxCalculationContext.headers) {
    actualTaxContext = taxCalculationContext;
  } else if (taxCalculationContext && (taxCalculationContext.signal || taxCalculationContext.timeoutMs || taxCalculationContext.headers)) {
    actualOptions = taxCalculationContext;
    actualTaxContext = null;
  }

  const binding = financialStateBinding || {};
  if (binding.profileId && binding.profileId !== profileId) {
    throw new Error('Product ranking profile does not match the bound financial state.');
  }
  const payload = {
    profileId,
    parentInstrumentId,
  };
  const expectedBindingFields = [
    ['profileVersion', 'profileVersion'],
    ['recommendationId', 'recommendationId'],
    ['expectedAllocationRevision', 'allocationRevision'],
    ['expectedAllocationRevisionId', 'allocationRevisionId'],
    ['expectedPortfolioFingerprint', 'portfolioFingerprint'],
    ['expectedRecommendationFingerprint', 'recommendationFingerprint'],
  ];
  for (const [requestField, stateField] of expectedBindingFields) {
    const value = binding[requestField] ?? binding[stateField];
    if (value !== undefined) payload[requestField] = value;
  }
  if (actualTaxContext) {
    payload.taxCalculationContext = actualTaxContext;
  }

  const requestedTimeout = Number(actualOptions.timeoutMs);
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.min(requestedTimeout, WTI_USER_FLOW_TIMEOUT_MS)
    : WTI_USER_FLOW_TIMEOUT_MS;
  return request('POST', '/instruments/rank-wti', payload, { ...actualOptions, timeoutMs });
}

// ─── PROJECTIONS ─────────────────────────────────────────
export async function getProjections(profileId, instruments, monthlyInvestment, years) {
  const payload = {
    profileId,
    instruments,
    monthly_investment: monthlyInvestment,
  };
  if (years !== undefined) payload.years = years;
  return request('POST', '/projection', payload);
}

export async function calculateStepUpProjection(monthlyInvestment, annualReturnRate, years, annualStepUpRate, options = {}) {
  const { body = {}, ...requestOptions } = options;
  return request('POST', '/projection/step-up', {
    ...body,
    // Positional money and time inputs are authoritative. Optional scenario
    // fields may extend the request but cannot silently replace its core.
    monthlyInvestment,
    annualReturnRate,
    years,
    annualStepUpRate,
  }, requestOptions);
}

export async function calculateAllocationSplit(monthlyInvestment, equityPct, options = {}) {
  return request('POST', '/projection/allocation-split', {
    monthlyInvestment,
    equityPct,
  }, options);
}

export async function compareInvestmentProjection(monthlyInvestment, annualReturnRate, benchmarkRate, inflationRate, years, options = {}) {
  return request('POST', '/projection/compare', {
    monthlyInvestment,
    annualReturnRate,
    benchmarkRate,
    inflationRate,
    years,
  }, options);
}

export async function getCustomPortfolioProjection(profileId, allocations, years, options = {}) {
  return request('POST', '/projection/custom-portfolio', { profileId, allocations, years }, options);
}

export async function runInstrumentStressTest(profileId, instrumentId, principal, options = {}) {
  return request('POST', '/projection/stress-test', {
    profileId,
    instrumentId,
    principal,
  }, options);
}

// ─── MONTE CARLO ─────────────────────────────────────────
export async function runMonteCarlo(instrument, monthlyInvestment, years, targetAmount, profileId) {
  const payload = {
    profileId,
    instrument,
    monthly_investment: monthlyInvestment,
    years,
  };
  if (targetAmount !== null && targetAmount !== undefined && targetAmount !== '') {
    payload.target_amount = targetAmount;
  }
  return request('POST', '/montecarlo/montecarlo', payload);
}

export async function runPortfolioMonteCarlo(profileId, allocations, years, targetAmount, options = {}) {
  const payload = { profileId, allocations, years };
  if (targetAmount !== null && targetAmount !== undefined && targetAmount !== '') {
    payload.target_amount = targetAmount;
  }
  return request('POST', '/montecarlo/portfolio', payload, options);
}

// ─── GOALS ───────────────────────────────────────────────
export async function createGoal(goalData) {
  return request('POST', '/goals/create', goalData);
}

export async function getGoals() {
  return request('GET', '/goals');
}

export async function updateGoal(goalId, goalData) {
  return request('PATCH', `/goals/${goalId}`, goalData);
}

export async function simulateGoal(goalId, monthlyContribution, options = {}) {
  return request('POST', `/goals/${goalId}/simulate`, { monthly_contribution: monthlyContribution }, options);
}

export async function deleteGoal(goalId, expectedVersion) {
  if (!Number.isSafeInteger(Number(expectedVersion)) || Number(expectedVersion) < 1) {
    throw new TypeError('A current goal version is required to delete this goal.');
  }
  return request('DELETE', `/goals/${goalId}`, null, {
    headers: { 'If-Match': `"${Number(expectedVersion)}"` },
  });
}

// ─── GOALS: independent keyless budgeting and purchase planning ───
export async function getGoalBudget(month) {
  return request('GET', `/goals/finance/budget/${encodeURIComponent(month)}`);
}

export async function saveGoalBudget(month, payload) {
  return request('PUT', `/goals/finance/budget/${encodeURIComponent(month)}`, payload);
}

export async function getGoalFundingPlan(month) {
  return request('GET', `/goals/finance/funding/${encodeURIComponent(month)}`);
}

export async function assessGoalVehiclePurchase(month, payload) {
  return request('POST', `/goals/finance/vehicle/${encodeURIComponent(month)}`, payload);
}

export async function projectGoalSavings(payload) {
  return request('POST', '/goals/finance/projection', payload);
}

export async function getGoalSpecifications() {
  return request('GET', '/goals/finance/specifications');
}
export async function createGoalSpecification(payload, idempotencyKey = null) {
  return request('POST', '/goals/finance/specifications', payload, {
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
  });
}
export async function updateGoalSpecification(id, payload) {
  return request('PUT', `/goals/finance/specifications/${encodeURIComponent(id)}`, payload);
}
export async function deleteGoalSpecification(id, expectedVersion) {
  return request('DELETE', `/goals/finance/specifications/${encodeURIComponent(id)}`, null, {
    headers: { 'If-Match': `"${expectedVersion}"` },
  });
}

// ─── HEALTH ──────────────────────────────────────────────
export async function healthCheck(options = {}) {
  return request('GET', '/health', null, options);
}

// ─── MARKET DATA ─────────────────────────────────────────
export async function getMarketRates(options = {}) {
  return request('GET', '/market/rates', null, options);
}

export async function refreshMarketRates() {
  return request('POST', '/market/refresh');
}

// ─── CHAT (Genie) ────────────────────────────────────────
export async function sendChatMessage(message, sessionId, options = {}) {
  // The grounded Groq-to-NVIDIA chain allows up to 60s; do not abort a valid
  // response at 45s. Leave margin for authenticated persistence and the route.
  return request('POST', '/chat/message', { message, session_id: sessionId }, { timeoutMs: 75000, ...options });
}

export async function getChatHistory(sessionId, options = {}) {
  const params = new URLSearchParams({ session_id: String(sessionId), limit: '50' });
  return request('GET', `/chat/history?${params.toString()}`, null, options);
}

export async function clearChatSession(sessionId) {
  return request('DELETE', `/chat/session/${encodeURIComponent(sessionId)}`);
}

function omitEmptyTaxInputs(inputs) {
  return Object.fromEntries(Object.entries(inputs).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

export async function computeTax(income, regime, deductions = {}, options = {}) {
  return request('POST', '/tax/compute', { ...omitEmptyTaxInputs(deductions), income, regime }, options);
}

export async function compareTax(income, deductions = {}, options = {}) {
  return request('POST', '/tax/compare', { ...omitEmptyTaxInputs(deductions), income }, options);
}

/** Qualified resident equity-gains path (196/198), separate from ordinary tax. */
export async function computeVerifiedComplexCapitalGainsTax(input, options = {}) {
  return request('POST', '/tax/new-regime-verified-complex', input, { retries: 0, ...options });
}

/** Supplementary TY2026-27 NPS, house-loss, and lottery qualified cases. */
export async function computeAdvancedNewRegimeTax(input, options = {}) {
  return request('POST', '/tax/new-regime-advanced', input, { retries: 0, ...options });
}

/** TY2026-27 only: fail-closed ordinary-income new-regime calculation. */
export async function computeVerifiedNewRegimeTax(input, options = {}) {
  return request('POST', '/tax/new-regime-verified', input, { retries: 0, ...options });
}

export async function getTaxPolicyMetadata(options = {}) {
  return request('GET', '/tax/policies', null, options);
}

export async function computeUserDeclaredPostTaxScenario(scenario, options = {}) {
  return request('POST', '/tax/post-tax-scenario', scenario, options);
}

export async function getCurrentMarketContext(options = {}) {
  return request('GET', '/regime/current', null, options);
}

/** Private loopback-only market observations; never inputs to recommendations. */
export async function getPrivateMarketDemo(options = {}) {
  return request('GET', '/market-data/private-demo', null, { retries: 0, ...options });
}

export async function getPrivateMarketDemoData(options = {}) {
  return request('GET', '/market-data/private-demo', null, { retries: 0, ...options });
}

export async function previewMarketContextAdjustment(profileId, options = {}) {
  return request('POST', '/regime/adjust', { profileId }, options);
}

export async function rebalancePortfolio(profileId, currentAllocation, targetAllocation, threshold, partialRatio, holdingMonths) {
  return request('POST', '/portfolio/rebalance', {
    profileId,
    current_allocation: currentAllocation,
    target_allocation: targetAllocation,
    threshold,
    partial_ratio: partialRatio,
    holding_months: holdingMonths,
  });
}

export async function updateRecommendationWeights(profileId, weights, stateToken = {}) {
  if (!weights || typeof weights !== 'object' || Array.isArray(weights)) {
    throw new TypeError('weights must be an explicit instrument-weight map');
  }
  const entries = Object.entries(weights);
  if (!entries.length || entries.some(([, value]) => !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new TypeError('Every recommendation weight must be a number from 0 to 1');
  }
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (Math.abs(total - 1) > 0.0001) throw new RangeError('Recommendation weights must sum to exactly 1');
  if (!stateToken?.recommendationId || !Number.isInteger(Number(stateToken.expectedAllocationRevision))
      || !/^[a-f0-9]{64}$/i.test(String(stateToken.expectedPortfolioFingerprint || ''))) {
    throw new TypeError('A current recommendation state token is required to rebalance');
  }
  return request('POST', '/recommend/weights', {
    profileId,
    recommendationId: stateToken.recommendationId,
    expectedAllocationRevision: Number(stateToken.expectedAllocationRevision),
    expectedPortfolioFingerprint: String(stateToken.expectedPortfolioFingerprint).toLowerCase(),
    weights,
  });
}

export async function optimisePortfolio(profileId, assets, strategy) {
  return request('POST', '/portfolio/optimise', {
    profileId,
    assets,
    strategy,
  });
}

// ─── POST-TAX RETURN (WG-038: backend single source of truth) ────
export async function computePostTaxReturn(instrumentType, nominalRate, annualIncome, holdingYears, regime, monthlySIP, userAge, incomeSource, fiscalYear, options = {}) {
  return request('POST', '/tax/post-tax-return', {
    instrumentType, nominalRate, annualIncome, holdingYears, regime, monthlySIP, userAge, incomeSource, fiscalYear,
    ...(options.body || {}),
  }, options);
}

export async function computePostTaxReturnBatch(instruments, annualIncome, regime, userAge, incomeSource, inflationRate, fiscalYear, options = {}) {
  const { body = {}, ...requestOptions } = options;
  return request('POST', '/tax/post-tax-return/batch', {
    instruments, annualIncome, regime, userAge, incomeSource, inflationRate, fiscalYear,
    ...body,
  }, requestOptions);
}

export function getCoverageAlerts(options = {}) {
  return request('GET', '/coverage/alerts?limit=20', null, options);
}
export function acknowledgeCoverageAlert(id, options = {}) {
  if (typeof id !== 'string' || !/^[a-f0-9]{24}$/i.test(id)) throw new TypeError('Invalid cash alert identity.');
  return request('PATCH', '/coverage/alerts/' + encodeURIComponent(id) + '/ack', {}, options);
}
export function getCoverageLedger(options = {}) {
  return request('GET', '/coverage/ledger', null, options);
}

export function saveCoverageLedger(ledger, revision, options = {}) {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new TypeError('Coverage revision must be nonnegative integer.');
  return request('PUT', '/coverage/ledger', ledger, {
    ...options, headers: { ...options.headers, 'If-Match': String.fromCharCode(34) + revision + String.fromCharCode(34) },
  });
}

export function previewCoverageScenario(revision, excludedVoluntaryEntryIds = [], options = {}) {
  return request('POST', '/coverage/scenarios/preview', { revision, excludedVoluntaryEntryIds }, options);
}

export function getCoverageRevision(revision, options = {}) {
  return request('GET', '/coverage/revisions/' + encodeURIComponent(String(revision)), null, options);
}

export function deleteCoverageLedger(revision, options = {}) {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new TypeError('Coverage revision must be positive integer.');
  return request('DELETE', '/coverage/ledger', null, {
    ...options, headers: { ...options.headers, 'If-Match': String.fromCharCode(34) + revision + String.fromCharCode(34) },
  });
}

export function exportCoverageHistoryPage(afterRevision = 0, options = {}) {
  if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) throw new TypeError('Invalid coverage export cursor.');
  return request('GET', '/coverage/export?limit=20&afterRevision=' + afterRevision, null, options);
}

// Default export for convenience
const api = {
  getCoverageLedger, getCoverageAlerts, acknowledgeCoverageAlert,
  saveCoverageLedger, previewCoverageScenario, getCoverageRevision, deleteCoverageLedger, exportCoverageHistoryPage,
  register, login, logout, restoreSession,
  setAuthToken, getAuthToken, clearAuthToken, clearUserSession,
  subscribeAuth, getAuthSnapshot,
  setUserInfo, getUserInfo,
  buildProfile, precomputeProfile, completeFinancialProfile, getCurrentProfile, getCurrentRecommendation, updateProfile, getRecommendations, runPlanReview, getPlanReviewRun, getCurrentPlanReviewRun, cancelPlanReviewRun, actOnPlanReview, extractGenieProofClaims, createGenieProofCase, listGenieProofCases, getGenieProofCase, verifyGenieProofCase, listGenieProofRevisions, reassessGenieProofCase, withdrawGenieProofConsent, getProofWatchAvailability, createProofWatch, listProofWatches, updateProofWatch, deleteProofWatch, listProofBreakEvents, acknowledgeProofBreakEvent, deleteGenieProofCase, listAuthorizedMandates, getAuthorizedMandate, getMandateApprovalOptions, getPasskeyRegistrationOptions, verifyPasskeyRegistration, verifyMandateApproval, revokeAuthorizedMandate, executeAuthorizedMandate, getExecutionReceipt, verifyExecutionReceipt, getPlanHealth, getPlanHealthEvents, getInstruments, rankInvestmentCandidates, getProjections, calculateStepUpProjection, calculateAllocationSplit, compareInvestmentProjection, getCustomPortfolioProjection, runInstrumentStressTest,
  runMonteCarlo, runPortfolioMonteCarlo, createGoal, getGoals, updateGoal, simulateGoal, deleteGoal,
  getGoalBudget, saveGoalBudget, getGoalFundingPlan, assessGoalVehiclePurchase, projectGoalSavings,
  getGoalSpecifications, createGoalSpecification, updateGoalSpecification, deleteGoalSpecification, healthCheck,
  getMarketRates, getBenchmarkMarketFacts, getStoredBenchmarkMarketFacts, getMutualFundNavFacts, refreshMarketRates,
  sendChatMessage, getChatHistory, clearChatSession, rebalancePortfolio,
  updateRecommendationWeights, optimisePortfolio,
  computeTax, compareTax, computeAdvancedNewRegimeTax, computeVerifiedNewRegimeTax, computeVerifiedComplexCapitalGainsTax, getTaxPolicyMetadata, computeUserDeclaredPostTaxScenario, getCurrentMarketContext, getPrivateMarketDemoData, previewMarketContextAdjustment, computePostTaxReturn, computePostTaxReturnBatch,
};

export default api;
