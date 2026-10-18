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

  it('shows permission failures as unavailable even when an older snapshot exists', () => {
    const blocked = {
      reasonCodes: ['MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED'],
      marketSnapshot: { status: 'CURRENT' },
    };
    expect(getMarketDisplayState(blocked, { refreshFailed: true }).key).toBe('RIGHTS_UNAVAILABLE');
    expect(getMarketDisplayState({
      marketSnapshot: { policyOutput: { reasonCodes: ['UPSTOX_PUBLIC_DISTRIBUTION_DISABLED'] } },
    }).label).toBe('Market data permission unavailable');
  });


  it('retains exact blocked-rights explanation when provider pair validation fails', () => {
    const unqualifiedPair = {
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
    expect(getMarketDisplayState(unqualifiedPair).key).toBe('RIGHTS_UNAVAILABLE');
    expect(getMarketDisplayState({
      marketSnapshot: {
        status: 'UNAVAILABLE',
        providerStatus: {
          quotes: { error: { code: 'UPSTOX_PUBLIC_DISTRIBUTION_DISABLED' } },
        },
      },
    }).key).toBe('RIGHTS_UNAVAILABLE');
  });

  it('does not mark qualified fallback data unlicensed due to an unused provider failure', () => {
    expect(getMarketDisplayState({
      marketSnapshot: {
        status: 'CURRENT',
        providerSelection: {
          attemptedProviders: ['NSE', 'UPSTOX'],
          selectedProvider: 'UPSTOX',
          providerFailures: [{ provider: 'NSE',
            reasonCodes: ['MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED'] }],
        },
      },
    }).key).toBe('CURRENT');
  });

  it('humanizes provenance without accepting unsafe evidence links', () => {
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
    ] } })).toBe('UPSTOX');
    expect(getMarketAttemptedProvider({ marketSnapshot: {
      providerSelection: { attemptedProviders: ['NSE', 'UPSTOX'], selectedProvider: 'UPSTOX' },
    } })).toBe('NSE, UPSTOX');
    expect(getMarketAttemptedProvider({
      liveProviderSelection: { attemptedProviders: ['NSE', 'UPSTOX'], selectedProvider: null },
      marketSnapshot: { observedFacts: [{ availabilityStatus: 'AVAILABLE', source: { provider: 'NSE' } }] },
    })).toBe('NSE, UPSTOX');
  });

  it('formats only valid observed timestamps', () => {
    expect(formatMarketTimestamp('not-a-date')).toBeNull();
    expect(formatMarketTimestamp('2026-09-08T10:00:00.000Z')).toContain('8 Sept 2026');
  });
});
