import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isPresentFiniteFinancialNumber,
  toOptionalFinancialNumber,
} from '../utils/strictFinancialNumber.js';

test('strict financial numbers preserve explicit zero and valid decimal notation', () => {
  assert.equal(isPresentFiniteFinancialNumber(0), true);
  assert.equal(isPresentFiniteFinancialNumber('0'), true);
  assert.equal(toOptionalFinancialNumber(0), 0);
  assert.equal(toOptionalFinancialNumber('12.5e2'), 1250);
});

test('strict financial numbers reject absent and malformed values before coercion', () => {
  for (const value of [null, undefined, '', '  ', 'NaN', 'Infinity', '0x10', Infinity, NaN, true, {}, []]) {
    assert.equal(isPresentFiniteFinancialNumber(value), false, `unexpectedly accepted ${String(value)}`);
    assert.equal(toOptionalFinancialNumber(value), null);
  }
});
