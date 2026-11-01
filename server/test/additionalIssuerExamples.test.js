import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { listAdditionalIssuerExamples } from '../services/additionalIssuerExamples.js';
import { listFinancialDiscoveryDirectory } from '../services/financialDiscoveryDirectory.js';
import { assertDistinctIssuerOptionsByCategory } from '../services/issuerCandidateUniqueness.js';

const source = JSON.parse(readFileSync(
  new URL('../data/qualificationPilots/issuerAdditionalExamples2026-11-01.json', import.meta.url),
  'utf8',
));
const familyIds = [
  'catalog_2026_index_nifty500',
  'catalog_2026_index_nifty50_equal',
  'catalog_2026_etf_nifty100',
  'catalog_2026_index_nifty100_equal',
  'catalog_2026_etf_nifty50_equal',
  'catalog_2026_index_nifty500_momentum',
  'catalog_2026_bank_tax_saver_fd',
];
test('21 distinct issuer-sourced names map to seven exact 2026 catalog families', () => {
  const candidates = listAdditionalIssuerExamples();
  assert.deepEqual([...candidates.keys()], familyIds);
  assert.equal([...candidates.values()].reduce((sum, v) => sum + v.length, 0), 21);
  for (const [id, products] of candidates) {
    assert.equal(products.length, 3, id);
    assert.equal(new Set(products.map(x => x.issuer)).size, 3, id);
    assert.ok(products.every(x => x.issuerUrl.startsWith('https://')
      && x.displayScope === 'PUBLIC_ISSUER_RESEARCH_ONLY'
      && !('afterTaxReturn' in x) && !('returnPercent' in x)));
  }
});
test('directory keeps all 250 archetypes and adds only independent issuer links, not financial market facts', () => {
  const response = listFinancialDiscoveryDirectory();
  assert.equal(response.totalCount, 250);
  const indexed = new Map(response.items.map(x => [x.id, x]));
  for (const id of familyIds) {
    const item = indexed.get(id);
    assert.ok(item);
    assert.equal(item.researchCandidates.length, 3);
    assert.equal(item.productAvailability, 'NOT_VERIFIED');
    assert.equal(item.dataRights, 'NOT_VERIFIED');
    assert.equal(item.recommendationEligible, false);
    assert.ok(Object.values(item.productData).every(v => v === null));
  }
  assert.equal(indexed.get('catalog_2026_bank_rd').researchCandidates.length, 2);
  assert.equal(response.items.reduce((sum, x) => sum + x.researchCandidates.length, 0), 35);
  assert.equal(response.items.filter(x => x.researchCandidates.length > 0).length, 12);
  indexed.get(familyIds[0]).researchCandidates[0].name = 'Forged product';
  assert.notEqual(listFinancialDiscoveryDirectory().items
    .find(x => x.id === familyIds[0]).researchCandidates[0].name, 'Forged product');
});
test('unrelated index benchmarks and fund-versus-ETF substitutions cannot enter the directory', () => {
  const forged = structuredClone(source);
  forged.families[1].products[0].name = 'HDFC NIFTY 50 Index Fund';
  assert.throws(() => listAdditionalIssuerExamples(forged), /FINANCIAL_ISSUER_EXAMPLES_INSTRUMENT_IDENTITY/);
  const host = structuredClone(source);
  host.families[0].products[0].issuerUrl = 'https://example.com/nifty-500-index-fund';
  assert.throws(() => listAdditionalIssuerExamples(host), /FINANCIAL_ISSUER_EXAMPLES_SOURCE_HOST/);
  const duplicate = structuredClone(source);
  duplicate.families[0].products[1].issuer = duplicate.families[0].products[0].issuer;
  assert.throws(() => listAdditionalIssuerExamples(duplicate), /FINANCIAL_ISSUER_EXAMPLES_INSTRUMENT_IDENTITY/);
  const etf = structuredClone(source);
  etf.families[2].instrument = 'INDEX_FUND';
  assert.throws(() => listAdditionalIssuerExamples(etf), /FINANCIAL_ISSUER_EXAMPLES_FAMILY_OR_BENCHMARK/);
});

test('the full 250-family catalog cannot recycle the same fund for two options in one category', () => {
  const response = listFinancialDiscoveryDirectory();
  const report = assertDistinctIssuerOptionsByCategory(response.items);
  assert.deepEqual(report, {
    familyCount: 250, issuerExampleCount: 35,
    familiesWithIssuerExamples: 12, crossFamilyCategoryDuplicates: 0,
  });
  const rows = structuredClone(response.items);
  const a = rows.find(x => x.id === 'catalog_2026_index_nifty100');
  const b = rows.find(x => x.id === 'catalog_2026_index_nifty100_equal');
  assert.equal(a.category, b.category);
  // An unrelated index fund must not be recycled for another strategy under
  // "Equity Mutual Funds", even if its official source URL is legitimate.
  b.researchCandidates[0] = { ...a.researchCandidates[0] };
  assert.throws(() => assertDistinctIssuerOptionsByCategory(rows),
    /FINANCIAL_DUPLICATE_PRODUCT_IN_CATEGORY/);
  // Different strings describing one scheme are also treated as duplicates.
  b.researchCandidates[0].name = a.researchCandidates[0].name.replace(/\\W+/g, '');
  assert.throws(() => assertDistinctIssuerOptionsByCategory(rows),
    /FINANCIAL_DUPLICATE_PRODUCT_IN_CATEGORY/);
  // The same name in a different category is not automatically a duplicate
  // instrument (product form could differ); benchmark/type checks still apply.
  b.category = 'ETFs';
  assert.equal(assertDistinctIssuerOptionsByCategory(rows).crossFamilyCategoryDuplicates, 0);
  b.category = a.category;
  b.researchCandidates[0] = { ...b.researchCandidates[1] };
  assert.throws(() => assertDistinctIssuerOptionsByCategory(rows),
    /FINANCIAL_DUPLICATE_PRODUCT_IN_CATEGORY/);
});
