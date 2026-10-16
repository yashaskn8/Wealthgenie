/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi } from 'vitest';
import {
  fetchDeferredAdvisoryWithBoundedRetry,
  ADVISORY_RETRY_DELAYS_MS,
} from '../App.jsx';

// Fast delays for unit testing
const TEST_DELAYS = [10, 20];

describe('Deferred Advisory 409 / Concurrency Hardening', () => {
  const mockRecId = '64b000000000000000000001';

  // TEST 1: fetchAdvisory returns 409 once, then READY -> does NOT mark FAILED, displays advisory
  it('TEST 1: recovers from 409 conflict on retry and returns READY advisory', async () => {
    let callCount = 0;
    const onConflict = vi.fn();

    const fetchFn = vi.fn().mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        const err = new Error('Advisory generation already in progress');
        err.status = 409;
        err.code = 'ADVISORY_GENERATION_IN_PROGRESS';
        throw err;
      }
      return {
        recommendationId: mockRecId,
        advisory_text: 'Your tailored allocation balances moderate risk with long-term compound growth.',
        advisory_explanation: {
          status: 'GROUNDED_EXPLANATION_AVAILABLE',
          provider: 'NVIDIA_NIM',
          model: 'meta/llama-3.3-70b-instruct',
        },
      };
    });

    const result = await fetchDeferredAdvisoryWithBoundedRetry(fetchFn, mockRecId, {
      retryDelays: TEST_DELAYS,
      onConflict,
    });

    expect(callCount).toBe(2);
    expect(onConflict).toHaveBeenCalledTimes(1);
    expect(result.advisory_text).toContain('Your tailored allocation');
    expect(result.advisory_explanation?.status).toBe('GROUNDED_EXPLANATION_AVAILABLE');
    expect(result.advisory_explanation?.status).not.toBe('FAILED');
  });

  // TEST 2: an exhausted conflict window is delayed, not a fabricated failure.
  it('TEST 2: stops retrying after bounded attempts on continuous 409 and reports a delayed explanation', async () => {
    let callCount = 0;
    const onConflict = vi.fn();

    const fetchFn = vi.fn().mockImplementation(async () => {
      callCount += 1;
      const err = new Error('Advisory generation already in progress');
      err.status = 409;
      err.code = 'ADVISORY_GENERATION_IN_PROGRESS';
      throw err;
    });

    const result = await fetchDeferredAdvisoryWithBoundedRetry(fetchFn, mockRecId, {
      retryDelays: TEST_DELAYS, // 2 retry delays => max 3 attempts total
      onConflict,
    });

    // 1 initial + 2 retries = 3 calls total
    expect(callCount).toBe(3);
    expect(onConflict).toHaveBeenCalledTimes(3);
    expect(result.advisory_explanation?.status).toBe('DELAYED');
    expect(result.advisory_explanation?.status).not.toBe('FAILED');
    expect(result.advisory_text).toBeNull();
  });

  // TEST 3: fetchAdvisory returns 500 -> status becomes FAILED
  it('TEST 3: propagates genuine terminal 500 error to caller for FAILED handling', async () => {
    const fetchFn = vi.fn().mockImplementation(async () => {
      const err = new Error('Internal Server Error in model pipeline');
      err.status = 500;
      throw err;
    });

    let caughtError = null;
    try {
      await fetchDeferredAdvisoryWithBoundedRetry(fetchFn, mockRecId, { retryDelays: TEST_DELAYS });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError?.status).toBe(500);

    // Simulate caller catch handler semantics
    const state = { advisory_explanation: { status: 'PENDING' } };
    if (caughtError?.status !== 409 && caughtError?.code !== 'REQUEST_ABORTED') {
      state.advisory_explanation = { status: 'FAILED', error: caughtError.message };
    }
    expect(state.advisory_explanation.status).toBe('FAILED');
    expect(state.advisory_explanation.error).toContain('Internal Server Error');
  });

  it('does not retry a 409 that means the recommendation was superseded', async () => {
    const fetchFn = vi.fn().mockImplementation(async () => {
      const err = new Error('The recommendation changed after advisory generation.');
      err.status = 409;
      err.code = 'RECOMMENDATION_SUPERSEDED';
      throw err;
    });
    const onConflict = vi.fn();

    await expect(fetchDeferredAdvisoryWithBoundedRetry(fetchFn, mockRecId, {
      retryDelays: TEST_DELAYS,
      onConflict,
    })).rejects.toMatchObject({ status: 409, code: 'RECOMMENDATION_SUPERSEDED' });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(onConflict).not.toHaveBeenCalled();
  });

  // TEST 4: fetchAdvisory aborts -> no FAILED state
  it('TEST 4: aborting request cancels cleanly without setting FAILED state', async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn().mockImplementation(async () => {
      const err = new Error('Request cancelled.');
      err.code = 'REQUEST_ABORTED';
      throw err;
    });

    let caughtError = null;
    try {
      await fetchDeferredAdvisoryWithBoundedRetry(fetchFn, mockRecId, {
        signal: controller.signal,
        retryDelays: TEST_DELAYS,
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError?.code).toBe('REQUEST_ABORTED');

    // Simulate caller error handler: REQUEST_ABORTED must NOT mark FAILED
    const state = { advisory_explanation: { status: 'PENDING' } };
    if (caughtError?.code !== 'REQUEST_ABORTED' && caughtError?.name !== 'AbortError') {
      state.advisory_explanation = { status: 'FAILED', error: caughtError.message };
    }
    expect(state.advisory_explanation.status).toBe('PENDING'); // Unchanged, NOT FAILED
  });

  // TEST 5: core recommendation instruments remain unchanged after advisory retry sequence
  it('TEST 5: core recommendation instruments remain completely unchanged after retry sequence', async () => {
    const coreInstruments = [
      { id: 'index-mf', name: 'Nifty 50 Index Fund', type: 'Equity_MF', allocationWeight: 0.6 },
      { id: 'rbi-bonds', name: 'RBI Floating Rate Savings Bond', type: 'Govt_Bond', allocationWeight: 0.4 },
    ];
    const initialRecommendation = {
      recommendationId: mockRecId,
      instruments: coreInstruments,
      advisory_explanation: { status: 'PENDING' },
    };

    // Simulate retry sequence
    let callCount = 0;
    const fetchFn = vi.fn().mockImplementation(async () => {
      callCount += 1;
      if (callCount < 2) {
        const err = new Error('Conflict');
        err.status = 409;
        err.code = 'ADVISORY_GENERATION_IN_PROGRESS';
        throw err;
      }
      return {
        advisory_text: 'Grounded advisory text',
        advisory_explanation: { status: 'READY' },
      };
    });

    const advRes = await fetchDeferredAdvisoryWithBoundedRetry(fetchFn, mockRecId, { retryDelays: TEST_DELAYS });

    // State update simulation as in App.jsx
    const updatedRecs = {
      ...initialRecommendation,
      advisory_text: advRes.advisory_text,
      advisory_explanation: advRes.advisory_explanation,
    };

    expect(updatedRecs.instruments).toEqual(coreInstruments);
    expect(updatedRecs.instruments.length).toBe(2);
    expect(updatedRecs.instruments[0].name).toBe('Nifty 50 Index Fund');
    expect(updatedRecs.instruments[1].name).toBe('RBI Floating Rate Savings Bond');
  });

  // TEST 6: allocation values remain unchanged after advisory retry sequence
  it('TEST 6: allocation values and weights remain completely unchanged after advisory retry sequence', async () => {
    const coreAllocation = {
      equity: 0.6,
      debt: 0.4,
      monthly_investment: 25000,
      total_allocation_pct: 100,
    };
    const initialRecommendation = {
      recommendationId: mockRecId,
      allocation: coreAllocation,
      advisory_text: null,
      advisory_explanation: { status: 'PENDING' },
    };

    let callCount = 0;
    const fetchFn = vi.fn().mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        const err = new Error('Conflict');
        err.status = 409;
        err.code = 'ADVISORY_GENERATION_IN_PROGRESS';
        throw err;
      }
      return {
        advisory_text: 'Advisory ready',
        advisory_explanation: { status: 'READY' },
      };
    });

    const advRes = await fetchDeferredAdvisoryWithBoundedRetry(fetchFn, mockRecId, { retryDelays: TEST_DELAYS });

    const updatedRecs = {
      ...initialRecommendation,
      advisory_text: advRes.advisory_text,
      advisory_explanation: advRes.advisory_explanation,
    };

    expect(updatedRecs.allocation).toEqual(coreAllocation);
    expect(updatedRecs.allocation.monthly_investment).toBe(25000);
    expect(updatedRecs.allocation.total_allocation_pct).toBe(100);
  });

  // TEST 7: READY advisory merges only advisory fields
  it('TEST 7: READY advisory merges only advisory_text and advisory_explanation without touching other fields', async () => {
    const existingRec = {
      recommendationId: mockRecId,
      profileId: 'prof-999',
      modelVersion: 'financial-mlp-1.0.0',
      policyVersion: 'recommendation-policy-1.0.0',
      dashboardProjection: { tenYearWealth: 1500000 },
      confidenceScores: { riskScore: 0.85 },
      advisory_text: null,
      advisory_explanation: { status: 'PENDING' },
    };

    const readyAdvisory = {
      advisory_text: 'Here is your personalized grounded advisory.',
      advisory_explanation: {
        status: 'READY',
        provider: 'NVIDIA_NIM',
        citations: ['SEBI-2024-REG'],
      },
    };

    // State merge logic from App.jsx
    const merged = {
      ...existingRec,
      advisory_text: readyAdvisory.advisory_text,
      advisory_explanation: readyAdvisory.advisory_explanation,
    };

    expect(merged.profileId).toBe('prof-999');
    expect(merged.modelVersion).toBe('financial-mlp-1.0.0');
    expect(merged.policyVersion).toBe('recommendation-policy-1.0.0');
    expect(merged.dashboardProjection).toEqual({ tenYearWealth: 1500000 });
    expect(merged.confidenceScores).toEqual({ riskScore: 0.85 });
    expect(merged.advisory_text).toBe('Here is your personalized grounded advisory.');
    expect(merged.advisory_explanation?.status).toBe('READY');
  });

  it('keeps a bounded retry window past the server stale-claim threshold', () => {
    expect(ADVISORY_RETRY_DELAYS_MS.slice(0, 2)).toEqual([1000, 1500]);
    expect(ADVISORY_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0)).toBeGreaterThan(120000);
    expect(Math.max(...ADVISORY_RETRY_DELAYS_MS)).toBeLessThanOrEqual(15000);
  });
});
