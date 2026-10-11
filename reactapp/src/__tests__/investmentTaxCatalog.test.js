import { describe, expect, it } from 'vitest';
import { investmentDatabase } from '../investmentDatabase';

describe('investment catalog tax boundary', () => {
  it('does not expose legacy PPF or SSY exemption tags as a current tax conclusion', () => {
    for (const id of ['ppf', 'sukanya']) {
      const instrument = investmentDatabase.find(item => item.id === id);
      expect(instrument).toBeDefined();
      expect(instrument.taxation).not.toHaveProperty('taxFreeInterest', true);
      expect(instrument.taxation).not.toHaveProperty('section', '80C');
      expect(instrument.taxType).toBeNull();
      expect(instrument.taxEfficiencyScore).toBeNull();
      expect(instrument.staticData.taxation).not.toHaveProperty('taxFreeInterest', true);
    }
  });

  it('does not present legacy bank-deposit catalog rates as current provider quotes', () => {
    const deposits = investmentDatabase.filter(item => item.category === 'Bank Deposits');
    expect(deposits.length).toBeGreaterThan(0);
    for (const deposit of deposits) {
      expect(deposit.rate).toBeNull();
      expect(deposit.expectedReturn).toBeNull();
      expect(deposit.returnRange).toEqual({ min: null, max: null });
      expect(deposit.returnDataClass).toBe('UNAVAILABLE');
      expect(deposit.metadata.sourceConfidence).toBe('Not established');
      expect(deposit.desc).toMatch(/does not provide a current bank quote/i);
      expect(deposit.desc).not.toMatch(/\d+(?:\.\d+)?\s*%/);
      expect(deposit.dynamicData.expectedReturn.source).toBeNull();
      expect(deposit.dynamicData.topSchemes).toEqual([]);
    }
  });
});
