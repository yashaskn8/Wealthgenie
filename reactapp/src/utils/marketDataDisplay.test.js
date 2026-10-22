import { describe, expect, it } from 'vitest';
import {
  formatMarketTimestamp,
  formatNullablePercent,
  getMarketAttemptedProvider,
  getMarketDisplayState,
  getMarketEvidenceSource,
  nullableMarketNumber,
  readableSource,
  safeSourceUrl,
} from './marketDataDisplay';

describe('nullable market-data presentation', () => {
  it('does not coerce missing or invalid facts to zero', () => {
    expect(nullableMarketNumber(null)).toBeNull();
    expect(nullableMarketNumber(undefined)).toBeNull();
    expect(nullableMarketNumber('')).toBeNull();
    expect(nullableMarketNumber('unavailable')).toBeNull();
    for (const value of ['  ', false, true, [], {}]) expect(nullableMarketNumber(value)).toBeNull();
    expect(formatNullablePercent(null)).toBeNull();
  });

  it('never calls a retained snapshot current after revalidation failed', () => {
    const current = { marketSnapshot: { status: 'CURRENT' } };
    expect(getMarketDisplayState(current).key).toBe('CURRENT');
    expect(getMarketDisplayState(current, { refreshFailed: true }).key).toBe('LAST_AVAILABLE');
    expect(getMarketDisplayState({ marketSnapshot: { status: 'STALE' } }).key).not.toBe('CURRENT');
    expect(getMarketDisplayState({ status: 'MARKET_CONTEXT_UNAVAILABLE' }).key).toBe('UNAVAILABLE');
  });

  it('preserves unavailable, stale, and partial snapshot states after a failed refresh', () => {
    for (const status of ['UNAVAILABLE', 'STALE', 'PARTIAL_DATA']) {
      expect(getMarketDisplayState(
        { marketSnapshot: { status } }, { refreshFailed: true },
      ).key).toBe(status);
    }
    expect(getMarketDisplayState(
      { status: 'MARKET_CONTEXT_UNAVAILABLE' }, { refreshFailed: true },
    ).key).toBe('UNAVAILABLE');
    expect(getMarketDisplayState(
      { marketSnapshot: { status: 'MARKET_CLOSED' } }, { refreshFailed: true },
    ).key).toBe('LAST_AVAILABLE');
  });

  it('shows permission failures as unavailable even when an older snapshot exists', () => {
    const blocked = {
      reasonCodes: ['MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED'],
      marketSnapshot: { status: 'CURRENT' },
    };
    expect(getMarketDisplayState(blocked, { refreshFailed: true }).key).toBe('RIGHTS_UNAVAILABLE');
    expect(getMarketDisplayState({
      marketSnapshot: { policyOutput: { reasonCodes: ['UPSTOX_PUBLIC_DISTRIBUTION_DISABLED'] } },
    }).label).toBe('Market source permissions not verified');
    expect(getMarketDisplayState(blocked).detail).toMatch(/Authenticated local Upstox observations are shown separately/);
    expect(getMarketDisplayState({
      marketSnapshot: { providerStatus: { quotes: {
        error: { code: 'UPSTOX_PUBLIC_DISTRIBUTION_DISABLED' },
      } } },
    }).key).toBe('RIGHTS_UNAVAILABLE');
  });

  it('preserves nested rights failures only when no qualified provider was selected', () => {
    const unqualified = {
      marketSnapshot: {
        status: 'UNAVAILABLE',
        providerSelection: {
          attemptedProviders: ['UPSTOX'],
          selectedProvider: null,
          providerFailures: [{ provider: 'UPSTOX',
            reasonCodes: ['MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED'] }],
        },
      },
    };
    expect(getMarketDisplayState(unqualified).key).toBe('RIGHTS_UNAVAILABLE');

    expect(getMarketDisplayState({
      marketSnapshot: {
        status: 'CURRENT',
        providerSelection: {
          attemptedProviders: ['UPSTOX', 'NSE'],
          selectedProvider: 'NSE',
          providerFailures: [{ provider: 'UPSTOX',
            reasonCodes: ['MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED'] }],
        },
      },
    }).key).toBe('CURRENT');
  });

  it('keeps malformed provider-failure data from breaking market-state rendering', () => {
    for (const providerFailures of [null, {}, 'not-a-list', [{ reasonCodes: {} }]]) {
      expect(getMarketDisplayState({
        marketSnapshot: {
          status: 'UNAVAILABLE',
          providerSelection: { selectedProvider: null, providerFailures },
        },
      }).key).toBe('UNAVAILABLE');
    }
  });

  it('humanizes provenance without accepting unsafe evidence links', () => {
    expect(readableSource('UPSTOX')).toBe('Upstox');
    expect(readableSource('GOVERNMENT_OF_INDIA')).toBe('Government of India');
    expect(readableSource('OFFICIAL_BANK_PUBLISHED_RATE')).toBe('Official bank published rate');
    expect(safeSourceUrl('https://www.rbi.org.in/')).toBe('https://www.rbi.org.in/');
    for (const value of ['javascript:alert(1)', 'https://secret@example.com/', '/relative', null]) {
      expect(safeSourceUrl(value)).toBeNull();
    }
  });

  it('preserves a genuinely observed zero', () => {
    expect(nullableMarketNumber(0)).toBe(0);
    expect(formatNullablePercent(0)).toBe('0.0%');
  });

  it('uses backend snapshot status and keeps legacy contexts explicitly last-available', () => {
    expect(getMarketDisplayState(null, { loading: true }).key).toBe('LOADING');
    expect(getMarketDisplayState({ status: 'MARKET_CONTEXT_AVAILABLE', context: 'NORMAL' }).key).toBe('LAST_AVAILABLE');
    expect(getMarketDisplayState({ marketSnapshot: { status: 'MARKET_CLOSED' } }).label).toBe('Market closed');
    const failed = {
      marketSnapshot: { providerStatus: { quotes: { provider: 'NSE' } } },
    };
    expect(getMarketEvidenceSource(failed)).toBeNull();
    expect(getMarketAttemptedProvider(failed)).toBe('NSE');
    expect(getMarketEvidenceSource({ marketSnapshot: { observedFacts: [
      { availabilityStatus: 'AVAILABLE', source: { provider: 'UPSTOX' } },
      { availabilityStatus: 'UNAVAILABLE', source: { provider: 'NSE' } },
    ] } })).toBe('Upstox');
    expect(getMarketAttemptedProvider({ marketSnapshot: {
      providerSelection: { attemptedProviders: ['NSE', 'UPSTOX'], selectedProvider: 'UPSTOX' },
    } })).toBe('NSE, Upstox');
    expect(getMarketAttemptedProvider({
      liveProviderSelection: { attemptedProviders: ['NSE', 'UPSTOX'], selectedProvider: null },
      marketSnapshot: { observedFacts: [{ availabilityStatus: 'AVAILABLE', source: { provider: 'NSE' } }] },
    })).toBe('NSE, Upstox');
  });

  it('formats only valid observed timestamps', () => {
    expect(formatMarketTimestamp('not-a-date')).toBeNull();
    expect(formatMarketTimestamp('2026-09-08T10:00:00.000Z')).toContain('8 Sept 2026');
  });
});
