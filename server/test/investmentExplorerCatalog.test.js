import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import investmentExplorerRoutes from '../routes/investmentExplorer.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { getInvestmentExplorerTaxonomy, searchInvestmentExplorerCatalog, investmentExplorerTestExports } from '../services/investmentExplorerCatalog.js';
import { jsonRequest, withServer } from '../test-utils/httpTestUtils.js';

const slug = value => value.toLocaleLowerCase('en-IN')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '');

function buildApp() {
  const app = express();
  app.use('/api/investment-explorer', investmentExplorerRoutes);
  app.use(errorHandler);
  return app;
}

test('investment taxonomy includes all requested retail investment families without asserting availability', () => {
  const taxonomy = getInvestmentExplorerTaxonomy();
  const subcategories = taxonomy.categories.flatMap(category => category.subcategories);

  assert.equal(taxonomy.categories.length, 12);
  assert.equal(subcategories.length, 140);
  assert.equal(new Set(subcategories.map(item => item.id)).size, subcategories.length);
  assert.equal(taxonomy.catalogLevel, 'DISCOVERY_TAXONOMY');
  assert.equal(taxonomy.currentProductAvailability, 'NOT_VERIFIED_BY_DEFAULT');
  assert.ok(taxonomy.categories.some(category => category.id === 'bank-savings-and-deposits'
    && category.subcategories.some(item => item.name === 'NRE deposits')));
  assert.ok(taxonomy.categories.some(category => category.id === 'mutual-funds'
    && category.subcategories.some(item => item.name === 'Other current SEBI-defined scheme categories')));
  assert.ok(taxonomy.categories.some(category => category.id === 'real-estate-and-infrastructure'
    && category.subcategories.some(item => item.name === 'Registered small and medium REIT schemes')));
  assert.ok(taxonomy.categories.some(category => category.id === 'alternative-and-specialized-investments'
    && category.subcategories.some(item => item.name.includes('restricted review category'))));
});

test('legacy family entries map only to explicit matching subcategories and expose no numeric facts', () => {
  const taxonomyById = new Map(getInvestmentExplorerTaxonomy().categories.map(category => [category.id, category]));
  const families = investmentExplorerTestExports.familyRecords;

  assert.equal(families.length, 155);
  assert.equal(families.filter(family => family.subcategoryId).length > 100, true);
  for (const family of families) {
    const category = taxonomyById.get(family.categoryId);
    if (family.subcategoryId) {
      assert.ok(category?.subcategories.some(option => option.id === family.subcategoryId), family.legacyCatalogId);
      assert.equal(typeof family.subcategoryName, 'string');
    }
    for (const fact of Object.values(family.currentFacts)) {
      assert.equal(fact.value, null, family.legacyCatalogId);
    }
  }
  assert.ok(families.some(family => family.legacyCatalogId === 'crypto_vda'
    && family.classificationStatus === 'RESTRICTED_LEGAL_STATUS_REVIEW'));
  assert.ok(families.some(family => family.legacyCatalogId === 'futures_and_options'
    && family.classificationStatus === 'RESTRICTED_HIGH_RISK_REVIEW'));
});

test('subcategory filters return the explicitly mapped family and do not widen to unrelated products', () => {
  const recurringDeposit = searchInvestmentExplorerCatalog({
    categoryId: 'government-and-post-office-savings',
    subcategoryId: slug('Post Office Recurring Deposit'),
    limit: 100,
  });

  assert.deepEqual(recurringDeposit.products.map(product => product.legacyCatalogId), ['po_rd']);
  assert.equal(recurringDeposit.products[0].subcategoryName, 'Post Office Recurring Deposit');

  const missing = searchInvestmentExplorerCatalog({
    categoryId: 'bank-savings-and-deposits',
    subcategoryId: slug('NRE deposits'),
  });
  assert.equal(missing.pagination.total, 0);
  assert.deepEqual(missing.products, []);
});

test('investment explorer endpoints are read-only, bounded, and reject unknown query fields', async () => {
  await withServer(buildApp(), async baseUrl => {
    const taxonomyResponse = await jsonRequest(`${baseUrl}/api/investment-explorer/taxonomy`);
    assert.equal(taxonomyResponse.response.status, 200);
    assert.equal(taxonomyResponse.body.categories.length, 12);
    assert.equal(taxonomyResponse.body.categories.flatMap(category => category.subcategories).length, 140);
    assert.match(taxonomyResponse.response.headers.get('cache-control'), /max-age=300/);

    const catalogResponse = await jsonRequest(`${baseUrl}/api/investment-explorer/catalog?page=1&limit=5`);
    assert.equal(catalogResponse.response.status, 200);
    assert.equal(catalogResponse.body.products.length, 5);
    assert.equal(catalogResponse.body.pagination.total, 155);
    assert.equal(catalogResponse.body.catalog.currentProductFactsIncluded, false);
    assert.match(catalogResponse.response.headers.get('cache-control'), /max-age=60/);

    const invalidQuery = await jsonRequest(`${baseUrl}/api/investment-explorer/catalog?unexpected=value`);
    assert.equal(invalidQuery.response.status, 400);
    assert.equal(invalidQuery.body.code, 'VALIDATION_ERROR');
  });
});
