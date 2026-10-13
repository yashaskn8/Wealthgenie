import { describe, expect, it } from 'vitest';
import { isPresentFiniteNumber, toOptionalNumber } from './financialValues';

describe('financial value conversion', () => {
  it('preserves an explicit numeric zero', () => {
    expect(isPresentFiniteNumber(0)).toBe(true);
    expect(isPresentFiniteNumber('0')).toBe(true);
    expect(toOptionalNumber(0)).toBe(0);
    expect(toOptionalNumber('12.5e2')).toBe(1250);
    expect(toOptionalNumber('invalid')).toBeUndefined();
  });

  it.each([null, undefined, '', '  ', 'NaN', 'Infinity', '0x10', Infinity, NaN, true, {}, []])(
    'rejects missing or malformed value %j',
    value => {
      expect(isPresentFiniteNumber(value)).toBe(false);
    },
  );

  it('accepts decimal values and scientific notation as numeric text', () => {
    expect(isPresentFiniteNumber('12.5')).toBe(true);
    expect(isPresentFiniteNumber('12.5e2')).toBe(true);
  });
});
