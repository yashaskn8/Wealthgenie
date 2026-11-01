import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { attachSourceBoundAfterTaxReturns } from '../services/familyTopThreePostTax.js';

const sample = () => ({
  status: 'AVAILABLE', familyId: 'government_post_office_td',
  products: [2, 3].map((id) => ({
    id: 'government:india-post:post-office-td-' + id + 'y',
    name: 'Official Time Deposit ' + id,
    marketFact: {
      type: 'PUBLISHED_RATE', sourceId: 'licensed_government', observationId: String(id),
      asOf: '2026-10-30T12:00:00.000Z',
    },
  })),
});
const taxInput = { eventDates: { a: '2026-10-30' }, taxContexts: { 'FY2026-27': {} } };
const approvedResult = id => ({
  status: 'CALCULATED', postTaxStatus: 'CALCULATED',
  dataClass: 'QUALIFIED_PUBLISHED_RATE', canonicalProductId:
    'government:india-post:post-office-td-' + id + 'y',
  postTaxXirr: 0.05234, postTaxProceeds: 10052.34,
  officialSourceId: 'licensed_government', officialObservationId: String(id),
  sourceTermsReviewedIndependently: true,
});

describe('contractual Top-3 net return qualification', () => {
  it('does not attempt tax returns without explicit dated investor facts', async () => {
    let called = 0;
    const calc = async () => { called++; throw Error('Must not calculate'); };
    const comparison = sample();
    const result = await attachSourceBoundAfterTaxReturns({
      pool: {}, comparison, calculate: calc,
    });
    assert.strictEqual(result, comparison);
    assert.equal(called, 0);
    assert.ok(result.products.every(product => !('afterTax' in product)));
  });
  it('publishes exact annualized XIRR only if contract and observed source match', async () => {
    const comparison = sample();
    const result = await attachSourceBoundAfterTaxReturns({
      pool: {}, comparison, principal: 10000, taxEventContext: taxInput,
      calculate: async ({ productId }) => {
        const id = productId.includes('-2y') ? 2 : 3;
        return approvedResult(id);
      },
    });
    assert.equal(result.products.length, 2);
    for (const product of result.products) {
      assert.equal(product.afterTax.status, 'CALCULATED');
      assert.equal(product.afterTax.metric, 'ANNUALIZED_AFTER_TAX_CASHFLOW_XIRR');
      assert.equal(product.afterTax.valuePercent, 5.234);
      assert.equal(product.afterTax.principalInr, 10000);
      assert.equal(product.afterTax.sourceId, product.marketFact.sourceId);
      assert.equal(product.afterTax.observationId, product.marketFact.observationId);
    }
    assert.ok(comparison.products.every(product => !('afterTax' in product)));
  });
  it('drops contradictory, unqualified, hypothetical or source-mismatched results', async () => {
    for (const invalid of [
      { ...approvedResult(2), officialSourceId: 'other_provider' },
      { ...approvedResult(2), officialObservationId: 'other_observation' },
      { ...approvedResult(2), dataClass: 'USER_ASSUMPTION' },
      { ...approvedResult(2), postTaxStatus: 'UNAVAILABLE' },
      { ...approvedResult(2), postTaxXirr: Number.NaN },
      { ...approvedResult(2), postTaxXirr: Infinity },
      { ...approvedResult(2), sourceTermsReviewedIndependently: false },
      { ...approvedResult(2), canonicalProductId: 'another_instrument' },
      { ...approvedResult(2), postTaxProceeds: null },
    ]) {
      const result = await attachSourceBoundAfterTaxReturns({
        pool: {}, comparison: sample(), principal: 10000, taxEventContext: taxInput,
        calculate: async ({ productId }) => productId.includes('-2y')
          ? invalid : { status: 'UNAVAILABLE' },
      });
      assert.equal(result.products[0].afterTax, undefined);
      assert.equal(result.products[1].afterTax, undefined);
    }
  });
  it('does not fabricate figures for equity NAV and unqualified families', async () => {
    const comparison = sample();
    comparison.products[0].marketFact.type = 'NAV';
    const result = await attachSourceBoundAfterTaxReturns({
      pool: {}, comparison, principal: 10000, taxEventContext: taxInput,
      calculate: async ({ productId }) => productId.includes('-2y')
        ? approvedResult(2) : { status: 'UNAVAILABLE' },
    });
    assert.equal(result.products[0].afterTax, undefined);
    assert.equal(result.products[1].afterTax, undefined);
    const blocked = { status: 'INSUFFICIENT_VERIFIED_PRODUCTS', products: [] };
    assert.equal(await attachSourceBoundAfterTaxReturns({
      pool: {}, comparison: blocked, principal: 10000, taxEventContext: taxInput,
    }), blocked);
  });
});
