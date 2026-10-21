import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateQualifiedProductCashflow } from '../services/productCashflowEngine.js';
import { enrichProductsWithPostTaxAndSuitability } from '../services/productPostTaxCalculator.js';

const SOURCE = 'https://www.indiapost.gov.in/banking-services/savings';
const RATE = {
  value: 7.7, unit: 'PERCENT_PER_ANNUM',
  basis: 'OFFICIAL_NOMINAL_RATE_PER_ANNUM', dataClass: 'QUARTERLY_OFFICIAL_RATE',
  effectiveFrom: '2026-10-01', effectiveTo: '2026-12-31',
};
const TODAY = new Date('2026-10-21T09:00:00.000Z');
function qualified(id = 'nsc', overrides = {}) {
  const isNsc = id === 'nsc';
  const name = isNsc ? 'nsc' : ('post-office-td-' + (id === 'td' ? '1' : id) + 'y');
  const tdYears = id === 'td' ? 1 : Number(id);
  const canonicalProductId = 'government:india-post:' + name;
  return {
    id: canonicalProductId, canonicalProductId, parentInstrumentId: isNsc ? 'nsc' : 'po_td_1yr',
    presentationStatus: 'VERIFIED_COMPARABLE_OPTION',
    productType: 'GOVERNMENT_SCHEME',
    source: { provider: 'GOVERNMENT_OF_INDIA', url: SOURCE },
    availabilityStatus: 'AVAILABLE', freshness: { status: 'FRESH' },
    tenureMonths: isNsc ? 60 : tdYears * 12, compoundingBasis: isNsc ? 'Annually' : 'Quarterly',
    officialRate: { ...RATE, value: isNsc ? 7.7 : 6.9 },
    ...overrides,
  };
}
function calculate(product, options = {}) {
  return calculateQualifiedProductCashflow({
    product, principal: 10000, now: TODAY, enforceSourceRights: true,
    productionUseAllowed: true, ...options,
  });
}
test('NSC 5-year annual accumulation equals independent compound interest', () => {
  const result = calculate(qualified());
  const reference = 10000 * Math.pow(1.077, 5);
  assert.equal(result.status, 'CALCULATED');
  assert.ok(Math.abs(result.grossMaturityProceeds - reference) <= 0.005);
  assert.ok(Math.abs(result.grossInterest - (reference - 10000)) <= 0.005);
  assert.equal(result.postTaxProceeds, null);
  assert.equal(result.source.effectiveFrom, '2026-10-01');
});
test('1-year Post Office TD uses quarterly compounding, not annual simple interest', () => {
  const result = calculate(qualified('td'));
  const reference = 10000 * Math.pow(1 + 0.069 / 4, 4);
  assert.equal(result.status, 'CALCULATED');
  assert.equal(result.grossMaturityProceeds, 10000 + Math.round(reference - 10000));
  assert.notEqual(result.grossMaturityProceeds, 10690);
  assert.equal(result.grossTotalProceeds, result.grossMaturityProceeds);
});
test('multi-year Post Office TD pays separate annual interest without silent reinvestment', () => {
  for (const years of [2, 3, 5]) {
    const result = calculate(qualified(String(years)));
    const annualInterest = Math.round(10000 * ((1 + .069 / 4) ** 4 - 1));
    assert.equal(result.status, 'CALCULATED');
    assert.equal(result.annualPayouts.length, years);
    assert.equal(result.annualPayouts[0].annualInterestPaid, annualInterest);
    assert.equal(result.grossTotalProceeds, 10000 + years * annualInterest);
    assert.equal(result.grossMaturityProceeds, 10000 + annualInterest);
    assert.notEqual(result.grossTotalProceeds, 10000 * (1 + .069 / 4) ** (years * 4));
  }
});
test('missing contractual dates, mismatched identity or invalid source fail closed', () => {
  for (const product of [
    qualified('nsc', { id: 'wrong-id' }),
    qualified('nsc', { compoundingBasis: 'Quarterly' }),
    qualified('nsc', { tenureMonths: 24 }),
    qualified('nsc', { freshness: { status: 'STALE' } }),
    qualified('nsc', { source: { provider: 'AMFI', url: SOURCE } }),
    qualified('nsc', { officialRate: { ...RATE, value: null } }),
    qualified('nsc', { officialRate: { ...RATE, effectiveTo: null } }),
    qualified('nsc', { presentationStatus: 'UNAVAILABLE' }),
  ]) {
    const value = calculate(product);
    assert.equal(value.status, 'UNAVAILABLE');
    assert.equal(value.grossMaturityProceeds, null);
  }
});
test('expired effective quarter and calendar invalidity return unavailable', () => {
  assert.equal(calculate(qualified(), { now: new Date('2027-01-02T09:00:00Z') }).status, 'UNAVAILABLE');
  assert.equal(calculate(qualified('nsc', { officialRate: { ...RATE, effectiveFrom: '2026-02-31' } })).status, 'UNAVAILABLE');
});
test('unverified terms for PPF SSY SCSS RD KVP RBI bonds MF and bank FD never fabricate numbers', () => {
  for (const id of ['ppf','sukanya','scss','post-office-rd-5y','kvp','frsb-2020-taxable','generic-mf','sbi-fd']) {
    const item = qualified('nsc', {
      id: id, canonicalProductId: id, officialRate: { ...RATE, value: 7.1 },
    });
    const out = calculate(item);
    assert.equal(out.status, 'UNAVAILABLE', id);
    assert.equal(out.grossMaturityProceeds, null, id);
    assert.equal(out.postTaxProceeds, null, id);
  }
});
test('source licensing is enforced and null/negative/user-unentered principal is unavailable', () => {
  assert.equal(calculate(qualified(), { productionUseAllowed: false }).reasonCode, 'SOURCE_RIGHTS_UNQUALIFIED');
  for (const principal of [null, undefined, -1, 0, NaN, Infinity, 1e13, '10000']) {
    assert.equal(calculate(qualified(), { principal }).reasonCode, 'EXPLICIT_PRINCIPAL_REQUIRED');
  }
});
test('enrichment binds cashflow illustration to same product and rights, never to generic postTaxReturn', () => {
  const product = qualified();
  const out = enrichProductsWithPostTaxAndSuitability([product], {
    now: TODAY, taxCalculationContext: { illustrativePrincipal: 10000 },
    enforceSourceRights: true,
    sourceRightsResolver: () => ({ productionPostTaxUseAllowed: false }),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].cashflowIllustration.status, 'UNAVAILABLE');
  assert.equal(out[0].cashflowIllustration.grossMaturityProceeds, null);
  assert.equal(out[0].postTaxReturn, null);
});
