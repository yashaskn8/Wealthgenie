import { describe, it, expect } from 'vitest';
import {
  NAV_PAGES,
  PAGE_ALLOWLIST,
  HUB_TABS,
  normalizeNavigation,
  resolveNavigation,
  fromSearchParams,
  toSearchParams,
} from '../../utils/navigationMap';

describe('navigationMap architecture', () => {
  it('correctly normalizes valid pages without tabs', () => {
    const result = normalizeNavigation('home', null);
    expect(result).toEqual({ page: 'home', tab: null, isNormalized: false });
  });

  it('normalizes unknown pages to home', () => {
    const result = normalizeNavigation('unknown-page-xyz', 'some-tab');
    expect(result).toEqual({ page: 'home', tab: null, isNormalized: true });
  });

  it('normalizes legacy IDs to both hub and sub-tab', () => {
    expect(resolveNavigation('tax-optimizer')).toEqual({ page: 'taxes', tab: 'regime-savings' });
    expect(resolveNavigation('post-tax')).toEqual({ page: 'taxes', tab: 'real-returns' });
    expect(resolveNavigation('goals')).toEqual({ page: 'progress', tab: 'goals' });
    expect(resolveNavigation('goal-planner')).toEqual({ page: 'progress', tab: 'plan-goal' });
    expect(resolveNavigation('sip-planner')).toEqual({ page: 'progress', tab: 'grow-sip' });
    expect(resolveNavigation('health')).toEqual({ page: 'progress', tab: 'indicators' });
    expect(resolveNavigation('rebalancer')).toEqual({ page: 'progress', tab: 'rebalancer' });
    expect(resolveNavigation('compare')).toEqual({ page: 'home', tab: null });
    expect(resolveNavigation('insights')).toEqual({ page: 'home', tab: null });
    expect(resolveNavigation('diagnostics')).toEqual({ page: 'home', tab: null });
    expect(resolveNavigation('genieproof')).toEqual({ page: 'home', tab: null });
    expect(resolveNavigation('genieproof', undefined, { allowGenieProof: true })).toEqual({ page: 'genieproof', tab: null });
    expect(resolveNavigation('dashboard')).toEqual({ page: 'home', tab: null });
    expect(resolveNavigation('allocation')).toEqual({ page: 'plan', tab: null });
    expect(resolveNavigation('where-to-invest')).toEqual({ page: 'investments', tab: null });
    expect(resolveNavigation('profile')).toEqual({ page: 'account', tab: null });
  });

  it('explicit tab: null clears a previous tab and does not leak it', () => {
    const res = resolveNavigation({ page: 'home', tab: null });
    expect(res).toEqual({ page: 'home', tab: null });

    // Non-hub pages strip tab even if passed
    const res2 = resolveNavigation({ page: 'plan', tab: 'real-returns' });
    expect(res2).toEqual({ page: 'plan', tab: null });
  });

  it('invalid hub tabs default safely to the hub default tab', () => {
    const taxesInvalid = normalizeNavigation('taxes', 'non-existent-tax-tab');
    expect(taxesInvalid).toEqual({ page: 'taxes', tab: 'regime-savings', isNormalized: true });

    const progressInvalid = normalizeNavigation('progress', 'non-existent-prog-tab');
    expect(progressInvalid).toEqual({ page: 'progress', tab: 'goals', isNormalized: true });

    const retiredPage = normalizeNavigation('advanced', 'comparison');
    expect(retiredPage).toEqual({ page: 'home', tab: null, isNormalized: true });
    const gatedLegacyProof = normalizeNavigation('advanced', 'genieproof', { allowGenieProof: true });
    expect(gatedLegacyProof).toEqual({ page: 'genieproof', tab: null, isNormalized: true });
    const blockedLegacyProof = normalizeNavigation('advanced', 'genieproof');
    expect(blockedLegacyProof).toEqual({ page: 'home', tab: null, isNormalized: true });
    expect(normalizeNavigation('genieproof', null)).toEqual({ page: 'home', tab: null, isNormalized: true });
    expect(normalizeNavigation('genieproof', null, { allowGenieProof: true })).toEqual({ page: 'genieproof', tab: null, isNormalized: false });
    expect(normalizeNavigation('progress', 'health')).toEqual({ page: 'progress', tab: 'goals', isNormalized: true });
    expect(normalizeNavigation('progress', 'indicators')).toEqual({ page: 'progress', tab: 'indicators', isNormalized: false });
  });

  it('converts to and from URLSearchParams accurately', () => {
    const params = new URLSearchParams('page=taxes&tab=real-returns');
    const { page, tab, needsReplace } = fromSearchParams(params);
    expect(page).toBe('taxes');
    expect(tab).toBe('real-returns');
    expect(needsReplace).toBe(false);

    // Malformed searchParams triggers needsReplace
    const badParams = new URLSearchParams('page=invalid&tab=random');
    const normalized = fromSearchParams(badParams);
    expect(normalized.page).toBe('home');
    expect(normalized.tab).toBe(null);
    expect(normalized.needsReplace).toBe(true);

    // Serialization
    expect(toSearchParams({ page: 'progress', tab: 'rebalancer' })).toEqual({
      page: 'progress',
      tab: 'rebalancer',
    });
    expect(toSearchParams({ page: 'home', tab: null })).toEqual({
      page: 'home',
    });
  });
});
