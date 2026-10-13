import { describe, expect, it } from 'vitest';
import { formatCurrency, getCategoryDescription } from '../../utils/allocationPlannerPresentation';

describe('allocation plan financial presentation', () => {
  it('keeps an explicit zero distinct from missing or malformed amounts', () => {
    expect(formatCurrency(0)).toBe('₹0');
    expect(formatCurrency('0')).toBe('₹0');
    expect(formatCurrency(null)).toBe('Unavailable');
    expect(formatCurrency('0x10')).toBe('Unavailable');
  });

  it('uses neutral category copy without deriving product guarantees or risk from its name', () => {
    expect(getCategoryDescription({ cat: 'Debt', name: 'Guaranteed Zero-Risk FD' })).toBe('Debt investments');
    expect(getCategoryDescription({ name: 'Guaranteed Zero-Risk FD' })).toBe('Investment category');
  });
});
