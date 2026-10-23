import { describe, it, expect } from 'vitest';
import { fromSearchParams, NAV_PAGES, resolveNavigation } from '../utils/navigationMap';

describe('Household Runway navigation release gate', () => {
  it('blocks direct URL without local feature activation', () => {
    expect(fromSearchParams(new URLSearchParams('page=runway')).page).toBe(NAV_PAGES.HOME);
    expect(resolveNavigation('runway').page).toBe(NAV_PAGES.HOME);
  });
  it('allows gated navigation without changing other destinations', () => {
    expect(fromSearchParams(new URLSearchParams('page=runway'), { allowRunway: true }).page).toBe(NAV_PAGES.RUNWAY);
    expect(resolveNavigation('runway', undefined, { allowRunway: true }).page).toBe(NAV_PAGES.RUNWAY);
    expect(resolveNavigation('goals', undefined, { allowRunway: true }).page).toBe(NAV_PAGES.GOALS);
  });
});
