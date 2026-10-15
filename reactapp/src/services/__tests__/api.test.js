import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api.js';

function jsonResponse(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    headers: { get: vi.fn(name => headers[name.toLowerCase()] || null) },
  };
}

const CANONICAL_PROFILE = Object.freeze({
  monthly_take_home: 100000,
  monthly_savings: 20000,
  age: 35,
  risk_tolerance: 'Moderate',
  sold_property_proceeds: 0,
  has_lump_sum: false,
  lump_sum_amount: 0,
  liquid_savings: 200000,
  emi_burden_pct: 10,
  financial_dependents: 1,
  emergency_fund_months: 6,
  investment_goals: ['Wealth Growth'],
  investment_horizon_years: 10,
});

describe('frontend API contracts', () => {
  it('sends the explicit GenieProof private-save consent with confirmed claims', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ created: true }));
    vi.stubGlobal('fetch', fetchMock);
    const request = {
      offerText: 'The current PPF interest rate is 7.1% p.a.',
      submissionHash: 'a'.repeat(64),
      savingConsent: true,
      confirmedClaims: [{ claimId: 'b'.repeat(32), statement: 'The current PPF interest rate is 7.1% p.a.' }],
    };

    await api.createGenieProofCase(request);

    expect(fetchMock.mock.calls[0][0]).toContain('/genieproof/cases');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(request);
    expect(fetchMock.mock.calls[0][1].headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('preserves the chat turn idempotency key supplied for a retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ response: 'Grounded reply.' }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await api.sendChatMessage('Explain my profile.', 'session-for-retry', {
      signal: controller.signal,
      headers: { 'Idempotency-Key': 'stable-chat-turn-001' },
    });

    const [url, config] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/chat/message');
    expect(JSON.parse(config.body)).toEqual({ message: 'Explain my profile.', session_id: 'session-for-retry' });
    expect(config.headers['Idempotency-Key']).toBe('stable-chat-turn-001');
    expect(config.signal).toBeInstanceOf(AbortSignal);
  });

  it('uses the authenticated ProofBreak availability, watch, timeline, and acknowledgment contracts', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ canEnable: false }))
      .mockResolvedValueOnce(jsonResponse({ created: true, watch: { status: 'ACTIVE' } }, 201))
      .mockResolvedValueOnce(jsonResponse({ events: [], nextCursor: null }))
      .mockResolvedValueOnce(jsonResponse(null, 204));
    vi.stubGlobal('fetch', fetchMock);
    const caseId = '00000000-0000-4000-8000-000000000001';
    const eventId = '00000000-0000-4000-8000-000000000002';

    await api.getProofWatchAvailability(caseId);
    await api.createProofWatch(caseId);
    await api.listProofBreakEvents(caseId, { limit: 10 });
    await api.acknowledgeProofBreakEvent(eventId);

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      expect.stringContaining(`/genieproof/cases/${caseId}/watch/availability`),
      expect.stringContaining(`/genieproof/cases/${caseId}/watch`),
      expect.stringContaining(`/genieproof/cases/${caseId}/events?limit=10`),
      expect.stringContaining(`/genieproof/events/${eventId}/acknowledge`),
    ]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ watchConsent: true });
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toEqual({ acknowledge: true });
    expect(fetchMock.mock.calls[1][1].headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('passes tax cancellation as a request option, never a financial input', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    await api.computePostTaxReturnBatch([{ instrumentType: 'FD', nominalRate: 0.07, monthlySIP: 10000, holdingYears: 3 }], 1000000, 'new', 30, 'salary', 0.06, 'FY2026-27', { signal: controller.signal, body: { deductions: { section80C: 0 } } });
    const config = fetchMock.mock.calls[0][1];
    expect(config.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(config.body)).toMatchObject({ deductions: { section80C: 0 }, inflationRate: 0.06 });
    expect(JSON.parse(config.body)).not.toHaveProperty('signal');
  });

  it('sends tax compute and comparison inputs in POST bodies, never in request URLs', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ taxAmount: 1 }))
      .mockResolvedValueOnce(jsonResponse({ saving: 2 }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await api.computeTax(1_200_000, 'new', {
      incomeSource: 'salary', fiscalYear: 'FY2026-27', age: 35, section80C: 150_000,
    }, { signal: controller.signal });
    await api.compareTax(1_200_000, {
      incomeSource: 'salary', fiscalYear: 'FY2026-27', age: 35, section80C: 150_000,
    }, { signal: controller.signal });

    for (const [url, config] of fetchMock.mock.calls) {
      expect(String(url)).toMatch(/\/api\/tax\/(compute|compare)$/);
      expect(String(url)).not.toContain('income');
      expect(String(url)).not.toContain('section80C');
      expect(config.method).toBe('POST');
      expect(config.signal).toBeInstanceOf(AbortSignal);
    }
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      incomeSource: 'salary', fiscalYear: 'FY2026-27', age: 35, section80C: 150_000,
      income: 1_200_000, regime: 'new',
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      incomeSource: 'salary', fiscalYear: 'FY2026-27', age: 35, section80C: 150_000,
      income: 1_200_000,
    });
  });
  beforeEach(() => {
    api.clearAuthToken();
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('sends the mobile number collected by registration to the backend', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ token: 'token', user: {} }, 201));
    vi.stubGlobal('fetch', fetchMock);

    await api.register('Test User', 'test@example.com', 'StrongPass1!', '9876543210');

    const [, config] = fetchMock.mock.calls[0];
    expect(JSON.parse(config.body)).toEqual({
      name: 'Test User',
      email: 'test@example.com',
      password: 'StrongPass1!',
      mobile: '9876543210',
    });
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('sends explicit Monte Carlo inputs and the authoritative profile ID', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true }));
    vi.stubGlobal('fetch', fetchMock);

    await api.runMonteCarlo('FD', 5000, 10, null, '64b000000000000000000001');

    const [, config] = fetchMock.mock.calls[0];
    expect(JSON.parse(config.body)).toEqual({
      profileId: '64b000000000000000000001',
      instrument: 'FD',
      monthly_investment: 5000,
      years: 10,
    });
  });

  it('surfaces backend validation details instead of a generic error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      error: 'Validation failed',
      details: ['target_amount must be at least 1000'],
    }, 400)));

    await expect(api.runMonteCarlo('FD', 5000, 10, 500, '64b000000000000000000001')).rejects.toThrow(
      'target_amount must be at least 1000'
    );
  });

  it('requires explicit fractional weights and preserves them exactly', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ instruments: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await api.updateRecommendationWeights('64b000000000000000000001', {
      Equity_MF: 0.75,
      Debt_MF: 0.25,
    }, {
      recommendationId: '64b000000000000000000002',
      expectedAllocationRevision: 1,
      expectedPortfolioFingerprint: 'a'.repeat(64),
    });

    const [, config] = fetchMock.mock.calls[0];
    expect(JSON.parse(config.body)).toEqual({
      profileId: '64b000000000000000000001',
      recommendationId: '64b000000000000000000002',
      expectedAllocationRevision: 1,
      expectedPortfolioFingerprint: 'a'.repeat(64),
      weights: {
        Equity_MF: 0.75,
        Debt_MF: 0.25,
      },
    });
  });

  it('routes market data through the same-origin API client and includes auth on refresh', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ sources: {} }))
      .mockResolvedValueOnce(jsonResponse({ refreshed: true }));
    vi.stubGlobal('fetch', fetchMock);
    api.setAuthToken('market-token');

    await api.getMarketRates();
    await api.refreshMarketRates();

    const ratesUrl = fetchMock.mock.calls[0][0];
    const refreshUrl = fetchMock.mock.calls[1][0];
    expect(ratesUrl).toMatch(/\/api\/market\/rates$/);
    expect(refreshUrl).toBe(ratesUrl.replace('/market/rates', '/market/refresh'));
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer market-token');
  });

  it('bounds and encodes official benchmark and AMFI fact requests', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ provider: 'UPSTOX', facts: [] }))
      .mockResolvedValueOnce(jsonResponse({ provider: 'AMFI', facts: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await api.getBenchmarkMarketFacts();
    await api.getMutualFundNavFacts(['123', '123', '456']);

    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/market\/benchmarks$/);
    expect(fetchMock.mock.calls[1][0]).toMatch(/\/api\/market\/mutual-funds\/nav\?schemeCodes=123%2C456$/);
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
    await expect(api.getMutualFundNavFacts([])).rejects.toThrow(/1-50/);
    await expect(api.getMutualFundNavFacts(['not-a-code'])).rejects.toThrow(/numeric/);
  });

  it('binds personalized product ranking to the current recommendation state without a client product universe', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ products: [{ id: 'index' }] }));
    vi.stubGlobal('fetch', fetchMock);

    await api.rankInvestmentCandidates(
      '64b000000000000000000001',
      'Index_MF',
      null,
      {},
      {
        profileId: '64b000000000000000000001',
        profileVersion: 4,
        recommendationId: '64b000000000000000000002',
        allocationRevision: 3,
        allocationRevisionId: '64b000000000000000000003',
        portfolioFingerprint: 'a'.repeat(64),
        recommendationFingerprint: 'b'.repeat(64),
      },
    );

    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/instruments\/rank-wti$/);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      profileId: '64b000000000000000000001',
      parentInstrumentId: 'Index_MF',
      profileVersion: 4,
      recommendationId: '64b000000000000000000002',
      expectedAllocationRevision: 3,
      expectedAllocationRevisionId: '64b000000000000000000003',
      expectedPortfolioFingerprint: 'a'.repeat(64),
      expectedRecommendationFingerprint: 'b'.repeat(64),
    });
  });

  it('refuses a product-ranking profile that disagrees with its financial-state binding', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.rankInvestmentCandidates(
      '64b000000000000000000001',
      'Index_MF',
      null,
      {},
      {
        profileId: '64b000000000000000000099',
        profileVersion: 4,
        recommendationId: '64b000000000000000000002',
        allocationRevision: 3,
        allocationRevisionId: '64b000000000000000000003',
        portfolioFingerprint: 'a'.repeat(64),
        recommendationFingerprint: 'b'.repeat(64),
      },
    )).rejects.toThrow(/profile does not match/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('runs stress scenarios against the authoritative profile and recommendation instrument', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      calculation_classification: 'NON_RECOMMENDATION_STRESS_WHAT_IF',
      scenarios: [],
    }));
    vi.stubGlobal('fetch', fetchMock);

    await api.runInstrumentStressTest(
      '64b000000000000000000001',
      'Index_MF',
      250000,
    );

    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/projection\/stress-test$/);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      profileId: '64b000000000000000000001',
      instrumentId: 'Index_MF',
      principal: 250000,
    });
  });

  it('routes allocation what-if arithmetic through the server', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      calculation_classification: 'NON_RECOMMENDATION_ALLOCATION_WHAT_IF',
      equityAmount: 7500,
      debtAmount: 2500,
    }));
    vi.stubGlobal('fetch', fetchMock);

    await api.calculateAllocationSplit(10000, 75);

    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/projection\/allocation-split$/);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      monthlyInvestment: 10000,
      equityPct: 75,
    });
  });

  it('loads verified market context and requests a server-owned profile adjustment', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'MARKET_CONTEXT_AVAILABLE', context: 'NORMAL' }))
      .mockResolvedValueOnce(jsonResponse({
        classification: 'PROFILE_SAFE_MARKET_CONTEXT_ADJUSTMENT',
        adjustedWeights: { Index_MF: 1 },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await api.getCurrentMarketContext();
    await api.previewMarketContextAdjustment('64b000000000000000000001');

    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/regime\/current$/);
    expect(fetchMock.mock.calls[1][0]).toMatch(/\/api\/regime\/adjust$/);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ profileId: '64b000000000000000000001' });
  });

  it('adds a correlation ID and does not retry failed mutations', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.createGoal({ goal_name: 'Home' })).rejects.toMatchObject({
      name: 'ApiError',
      code: 'NETWORK_ERROR',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers['X-Correlation-ID']).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('preserves the canonical server error code, request ID, and structured details', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      error: 'Version conflict.',
      message: 'Version conflict.',
      code: 'PROFILE_VERSION_CONFLICT',
      request_id: '8ba3f55e-4719-41b5-a5b1-671af22871b4',
      details: { currentVersion: 4, expectedVersion: 3 },
    }, 409)));

    await expect(api.updateProfile('profile-1', { ...CANONICAL_PROFILE, version: 3 })).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      code: 'PROFILE_VERSION_CONFLICT',
      requestId: '8ba3f55e-4719-41b5-a5b1-671af22871b4',
      details: { currentVersion: 4, expectedVersion: 3 },
    });
  });

  it('preserves the server chat-quota reset time for the chat input cooldown', async () => {
    const resetAt = '2026-10-14T11:00:00.000Z';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      message: 'The hourly chat message limit has been reached.',
      code: 'CHAT_RATE_LIMIT_EXCEEDED',
      details: { retryAfterSeconds: 245, resetAt },
    }, 429)));

    await expect(api.sendChatMessage('A question', 'session-1')).rejects.toMatchObject({
      name: 'ApiError',
      status: 429,
      code: 'CHAT_RATE_LIMIT_EXCEEDED',
      details: { retryAfterSeconds: 245, resetAt },
    });
  });
  it('aborts requests that exceed their timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((url, config) => new Promise((resolve, reject) => {
      config.signal.addEventListener('abort', () => {
        const error = new Error(`aborted ${url}`);
        error.name = 'AbortError';
        reject(error);
      });
    })));

    const pending = api.healthCheck({ timeoutMs: 10, retries: 0 });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(11);
    await assertion;
  });

  it('logs out through the backend and clears user-scoped browser data', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ message: 'Logout successful.' }));
    vi.stubGlobal('fetch', fetchMock);
    api.setAuthToken('logout-token');
    api.setUserInfo({ id: 'user-1' });
    localStorage.setItem('wealthgenie_user_profile', '{"age":30}');
    sessionStorage.setItem('genie_session_id', 'session-1');

    await api.logout();

    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/auth\/logout$/);
    expect(api.getAuthToken()).toBeNull();
    expect(api.getUserInfo()).toBeNull();
    expect(localStorage.getItem('wealthgenie_user_profile')).toBeNull();
    expect(sessionStorage.getItem('genie_session_id')).toBeNull();
  });

  it('preserves local auth after failed logout and clears it only after a successful retry', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 'TOKEN_REVOCATION_UNAVAILABLE', message: 'Retry logout.' }, 503))
      .mockResolvedValueOnce(jsonResponse({ message: 'Logout successful.' }));
    vi.stubGlobal('fetch', fetchMock);
    api.setAuthToken('retryable-logout-token');
    api.setUserInfo({ id: 'user-retry' });
    localStorage.setItem('wealthgenie_user_profile', '{"age":30}');

    await expect(api.logout()).rejects.toMatchObject({ status: 503, code: 'TOKEN_REVOCATION_UNAVAILABLE' });
    expect(api.getAuthToken()).toBe('retryable-logout-token');
    expect(api.getUserInfo()).toMatchObject({ id: 'user-retry' });
    expect(localStorage.getItem('wealthgenie_user_profile')).not.toBeNull();

    await api.logout();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(api.getAuthToken()).toBeNull();
    expect(api.getUserInfo()).toBeNull();
    expect(localStorage.getItem('wealthgenie_user_profile')).toBeNull();
  });

  it('clears local auth when logout receives an explicit invalid-session response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ code: 'AUTH_TOKEN_EXPIRED' }, 401));
    vi.stubGlobal('fetch', fetchMock);
    api.setAuthToken('expired-logout-token');
    api.setUserInfo({ id: 'expired-user' });

    await expect(api.logout()).resolves.toMatchObject({ alreadyInvalid: true });

    expect(api.getAuthToken()).toBeNull();
    expect(api.getUserInfo()).toBeNull();
  });

  it('clears local auth when logout confirms no server session was supplied', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ code: 'AUTH_REQUIRED' }, 401));
    vi.stubGlobal('fetch', fetchMock);
    api.setAuthToken('missing-server-session-token');
    api.setUserInfo({ id: 'already-signed-out-user' });

    await expect(api.logout()).resolves.toMatchObject({ alreadyInvalid: true });

    expect(api.getAuthToken()).toBeNull();
    expect(api.getUserInfo()).toBeNull();
  });

  it('does not let a late successful logout replace a newer authenticated user', async () => {
    let finishLogout;
    const pendingLogout = new Promise(resolve => { finishLogout = resolve; });
    const fetchMock = vi.fn()
      .mockReturnValueOnce(pendingLogout)
      .mockResolvedValueOnce(jsonResponse({ token: 'user-b-token', user: { id: 'user-b' } }));
    vi.stubGlobal('fetch', fetchMock);
    api.setAuthToken('user-a-token');
    api.setUserInfo({ id: 'user-a' });

    const logoutResult = api.logout().then(value => ({ value }), error => ({ error }));
    await api.login('b@example.com', 'safe-test-password');
    finishLogout(jsonResponse({ message: 'Logout successful.' }));
    const result = await logoutResult;

    expect(result.error).toMatchObject({ code: 'REQUEST_ABORTED' });
    expect(api.getAuthToken()).toBe('user-b-token');
    expect(api.getUserInfo()).toMatchObject({ id: 'user-b' });
  });

  it('preserves local auth when logout failure does not prove the session invalid', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ code: 'HTTP_ERROR' }, 401));
    vi.stubGlobal('fetch', fetchMock);
    api.setAuthToken('ambiguous-logout-token');
    api.setUserInfo({ id: 'user-still-present' });

    await expect(api.logout()).rejects.toMatchObject({ status: 401, code: 'HTTP_ERROR' });

    expect(api.getAuthToken()).toBe('ambiguous-logout-token');
    expect(api.getUserInfo()).toMatchObject({ id: 'user-still-present' });
  });

  it('preserves local auth when protected API access is temporarily unavailable for revocation verification', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      code: 'TOKEN_REVOCATION_UNAVAILABLE',
      message: 'Authentication session status is temporarily unavailable.',
    }, 503));
    vi.stubGlobal('fetch', fetchMock);
    api.setAuthToken('redis-outage-session-token');
    api.setUserInfo({ id: 'redis-outage-user' });

    await expect(api.healthCheck({ retries: 0 })).rejects.toMatchObject({
      status: 503,
      code: 'TOKEN_REVOCATION_UNAVAILABLE',
    });

    expect(api.getAuthToken()).toBe('redis-outage-session-token');
    expect(api.getUserInfo()).toMatchObject({ id: 'redis-outage-user' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('encodes chat session IDs as query data', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ messages: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await api.getChatHistory('session&limit=999');

    expect(fetchMock.mock.calls[0][0]).toContain('session_id=session%26limit%3D999');
    expect(fetchMock.mock.calls[0][0]).toContain('&limit=50');
  });

  it('restores an HttpOnly cookie session without requiring a bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      user: { id: 'cookie-user', email: 'cookie@example.com' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await api.restoreSession();

    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/auth\/session$/);
    expect(fetchMock.mock.calls[0][1].credentials).toBe('include');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
    expect(api.getUserInfo()).toMatchObject({ id: 'cookie-user' });
    expect(localStorage.getItem('wg_user')).toBeNull();
    expect(localStorage.getItem('wg_token')).toBeNull();
  });

  it('does not let a late session restore overwrite a newer login', async () => {
    let finishRestore;
    const restore = new Promise(resolve => { finishRestore = resolve; });
    const fetchMock = vi.fn()
      .mockReturnValueOnce(restore)
      .mockResolvedValueOnce(jsonResponse({ token: 'user-b-token', user: { id: 'user-b' } }));
    vi.stubGlobal('fetch', fetchMock);

    const restoring = api.restoreSession();
    await api.login('b@example.com', 'safe-test-password');
    finishRestore(jsonResponse({ user: { id: 'user-a' } }));
    await restoring;

    expect(api.getUserInfo()).toMatchObject({ id: 'user-b' });
    expect(api.getAuthToken()).toBe('user-b-token');
  });

  it('does not let a late 401 from an old identity clear a newer login', async () => {
    let finishOldRequest;
    const oldRequest = new Promise(resolve => { finishOldRequest = resolve; });
    const fetchMock = vi.fn()
      .mockReturnValueOnce(oldRequest)
      .mockResolvedValueOnce(jsonResponse({ token: 'user-b-token', user: { id: 'user-b' } }));
    vi.stubGlobal('fetch', fetchMock);
    api.setAuthToken('user-a-token');
    api.setUserInfo({ id: 'user-a' });

    const oldRequestResult = api.healthCheck({ retries: 0 }).then(
      value => ({ value }),
      error => ({ error }),
    );
    await api.login('b@example.com', 'safe-test-password');
    finishOldRequest(jsonResponse({ code: 'SESSION_EXPIRED' }, 401));
    const result = await oldRequestResult;

    expect(result.error).toMatchObject({ code: 'REQUEST_ABORTED' });
    expect(result.value).toBeUndefined();
    expect(api.getUserInfo()).toMatchObject({ id: 'user-b' });
    expect(api.getAuthToken()).toBe('user-b-token');
  });

  it('does not return a late successful response from an old identity after a newer login', async () => {
    let finishOldRequest;
    const oldRequest = new Promise(resolve => { finishOldRequest = resolve; });
    const fetchMock = vi.fn()
      .mockReturnValueOnce(oldRequest)
      .mockResolvedValueOnce(jsonResponse({ token: 'user-b-token', user: { id: 'user-b' } }));
    vi.stubGlobal('fetch', fetchMock);
    api.setAuthToken('user-a-token');
    api.setUserInfo({ id: 'user-a' });

    const oldRequestResult = api.healthCheck({ retries: 0 }).then(
      value => ({ value }),
      error => ({ error }),
    );
    await api.login('b@example.com', 'safe-test-password');
    finishOldRequest(jsonResponse({ privateData: 'user-a-only' }));
    const result = await oldRequestResult;

    expect(result.error).toMatchObject({ code: 'REQUEST_ABORTED' });
    expect(result.value).toBeUndefined();
    expect(api.getUserInfo()).toMatchObject({ id: 'user-b' });
    expect(api.getAuthToken()).toBe('user-b-token');
  });

  it('uses the server-side precompute and single authoritative completion contracts', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ candidateId: '4f4f4f4f-1111-4111-8111-111111111111' }))
      .mockResolvedValueOnce(jsonResponse({ profile: CANONICAL_PROFILE, recommendation: { instruments: [] } }));
    vi.stubGlobal('fetch', fetchMock);

    await api.precomputeProfile(CANONICAL_PROFILE);
    await api.completeFinancialProfile(
      CANONICAL_PROFILE,
      '4f4f4f4f-1111-4111-8111-111111111111',
      { headers: { 'Idempotency-Key': 'stable-completion-key' } },
    );

    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/profile\/precompute$/);
    expect(fetchMock.mock.calls[1][0]).toMatch(/\/api\/profile\/complete$/);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      monthly_savings: 20000,
      candidateId: '4f4f4f4f-1111-4111-8111-111111111111',
    });
    expect(fetchMock.mock.calls[1][1].headers['Idempotency-Key']).toBe('stable-completion-key');
  });

  it('restores a persisted recommendation through the read-only endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      profileId: '64b000000000000000000001',
      recommendationId: '64b000000000000000000002',
      instruments: [],
    }));
    vi.stubGlobal('fetch', fetchMock);

    await api.getCurrentRecommendation('64b000000000000000000001');

    expect(fetchMock.mock.calls[0][0]).toMatch(
      /\/api\/recommend\/current\?profileId=64b000000000000000000001$/,
    );
    expect(fetchMock.mock.calls[0][1].headers['Idempotency-Key']).toBeUndefined();
  });

  it('never persists financial lifecycle payloads in browser storage', async () => {
    const responses = [
      { csrfToken: 'csrf', user: { id: 'privacy-user', email: 'privacy@example.com' } },
      { profileId: '64b000000000000000000001', ...CANONICAL_PROFILE },
      { recommendationId: 'rec-1', auditId: 'audit-1', instruments: [{ type: 'ETF' }] },
      { id: 'goal-1', goal_name: 'Private home goal', target_amount: 7654321 },
      { message: 'Logout successful.' },
    ];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(responses.shift()))));
    const localSet = vi.spyOn(Storage.prototype, 'setItem');

    await api.login('privacy@example.com', 'StrongPass1!');
    await api.buildProfile(CANONICAL_PROFILE);
    await api.getRecommendations('64b000000000000000000001');
    await api.createGoal({ goal_name: 'Private home goal', target_amount: 7654321, target_date: '2035-01-01' });
    await api.logout();

    const persisted = [...Array(localStorage.length)].map((_, index) => localStorage.getItem(localStorage.key(index))).join(' ')
      + [...Array(sessionStorage.length)].map((_, index) => sessionStorage.getItem(sessionStorage.key(index))).join(' ');
    expect(persisted).not.toContain('100000');
    expect(persisted).not.toContain('20000');
    expect(persisted).not.toContain('200000');
    expect(persisted).not.toContain('7654321');
    expect(persisted).not.toContain('rec-1');
    expect(persisted).not.toContain('privacy@example.com');
    expect(localSet).not.toHaveBeenCalled();
  });

  it('binds cookie-authenticated mutations to the server-issued CSRF token', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        csrfToken: 'server-csrf-token',
        user: { id: 'cookie-user' },
      }))
      .mockResolvedValueOnce(jsonResponse({ id: 'goal-1' }, 201));
    vi.stubGlobal('fetch', fetchMock);

    await api.login('cookie@example.com', 'StrongPass1!');
    await api.createGoal({ goal_name: 'Retirement' });

    const mutation = fetchMock.mock.calls[1][1];
    expect(mutation.credentials).toBe('include');
    expect(mutation.headers.Authorization).toBeUndefined();
    expect(mutation.headers['X-CSRF-Token']).toBe('server-csrf-token');
  });

  it('uses the current CSRF cookie if a late session restore replaced a cached login token', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        csrfToken: 'new-login-csrf-token',
        user: { id: 'new-login-user' },
      }))
      .mockResolvedValueOnce(jsonResponse({ id: 'goal-1' }, 201));
    vi.stubGlobal('fetch', fetchMock);

    try {
      await api.login('cookie@example.com', 'StrongPass1!');
      // Model a delayed Set-Cookie from a restore request that started before
      // this login. Browser cookie processing happens outside the auth revision
      // fence, so the mutation must follow the cookie jar the server receives.
      document.cookie = 'wg_csrf=late-restore-csrf-token; path=/';
      await api.createGoal({ goal_name: 'Retirement' });

      expect(fetchMock.mock.calls[1][1].headers['X-CSRF-Token']).toBe('late-restore-csrf-token');
    } finally {
      document.cookie = 'wg_csrf=; Max-Age=0; path=/';
    }
  });

  it('honours Retry-After when retrying safe requests', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'busy' }, 503, { 'retry-after': '1' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'ok' }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = api.healthCheck();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toEqual({ status: 'ok' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
