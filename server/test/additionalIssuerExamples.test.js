import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { listAdditionalIssuerExamples } from '../services/additionalIssuerExamples.js';
import { listFinancialDiscoveryDirectory } from '../services/financialDiscoveryDirectory.js';

const source = JSON.parse(readFileSync(
  new URL('../data/qualificationPilots/issuerAdditionalExamples2026-11-01.json', import.meta.url),
  'utf8',
));
const familyIds = [
  'catalog_2026_index_nifty500',
  'catalog_2026_index_nifty50_equal',
  'catalog_2026_etf_nifty100',
];
test('exactly nine issuer-sourced names map to three distinct 2026 catalog families', () => {
  const candidates = listAdditionalIssuerExamples();
  assert.deepEqual([...candidates.keys()], familyIds);
  assert.equal([...candidates.values()].reduce((sum, v) => sum + v.length, 0), 9);
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
  assert.equal(response.items.reduce((sum, x) => sum + x.researchCandidates.length, 0), 23);
  assert.equal(response.items.filter(x => x.researchCandidates.length > 0).length, 8);
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
