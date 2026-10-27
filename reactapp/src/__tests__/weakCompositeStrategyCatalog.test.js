import { describe, expect, it } from 'vitest';
import { investmentDatabase } from '../investmentDatabase';

describe('term cover plus fund discovery strategy', () => {
  it('does not display a combined investment rate, tax class, or invented product list', () => {
    const strategy = investmentDatabase.find(item => item.id === 'term_mf_combo');
    expect(strategy).toBeDefined();
    expect(strategy.returnDataClass).toBe('UNAVAILABLE');
    expect(strategy.expectedReturn).toBeNull();
    expect(strategy.returnSource).toBeNull();
    expect(strategy.rate).toBeNull();
    expect(strategy.expenseRatio).toBeNull();
    expect(strategy.taxType).toBeNull();
    expect(strategy.dynamicData.topSchemes).toEqual([]);
    expect(strategy.staticData.whereToInvest.platforms).toEqual([]);
    expect(strategy.trustBadge).toBeNull();
    expect(strategy.description).toMatch(/not one investable product/i);
  });
});

describe('ULIP discovery entry', () => {
  it('does not present a generic return or blanket tax exemption', () => {
    const entry = investmentDatabase.find(item => item.id === 'ulip');
    expect(entry).toBeDefined();
    expect(entry.returnDataClass).toBe('UNAVAILABLE');
    expect(entry.expectedReturn).toBeNull();
    expect(entry.taxType).toBeNull();
    expect(entry.dynamicData.topSchemes).toEqual([]);
    expect(entry.staticData.taxation.type).not.toBe('EEE');
    expect(entry.staticData.whereToInvest.platforms).toEqual([]);
    expect(entry.explainer.lockInPlain).toMatch(/five-year regulatory lock-in/i);
  });
});

describe('endowment discovery entry', () => {
  it('shows no generic return, tax exemption, broker product or lock-in', () => {
    const entry = investmentDatabase.find(item => item.id === 'endowment_plan');
    expect(entry).toBeDefined();
    expect(entry.returnDataClass).toBe('UNAVAILABLE');
    expect(entry.expectedReturn).toBeNull();
    expect(entry.taxType).toBeNull();
    expect(entry.lockIn).toBeNull();
    expect(entry.dynamicData.topSchemes).toEqual([]);
    expect(entry.staticData.taxation.type).not.toBe('EEE');
    expect(entry.staticData.whereToInvest.platforms).toEqual([]);
    expect(entry.trustBadge).toBeNull();
  });
});

describe('blue-chip stock discovery entry', () => {
  it('does not display broker names as products or a category-wide stock return', () => {
    const entry = investmentDatabase.find(item => item.id === 'bluechip_stocks');
    expect(entry).toBeDefined();
    expect(entry.returnDataClass).toBe('UNAVAILABLE');
    expect(entry.expectedReturn).toBeNull();
    expect(entry.taxType).toBeNull();
    expect(entry.dynamicData.topSchemes).toEqual([]);
    expect(entry.staticData.whereToInvest.platforms).toEqual([]);
    expect(entry.trustBadge).toBeNull();
    expect(entry.description).toMatch(/not one investable product/i);
  });
});

it('keeps the frontend model assumption label on the current backend policy version', () => {
  const modelEntry = investmentDatabase.find(item => item.id === 'ppf');
  expect(modelEntry.returnAssumptionVersion).toBe('wealthgenie-projection-assumptions-1.1.5');
});
