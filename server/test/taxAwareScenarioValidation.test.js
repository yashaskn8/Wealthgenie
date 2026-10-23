import test from 'node:test';
import assert from 'node:assert/strict';
import {
  taxAwareScenarioInputSchema, taxAwareHistoryRiskInputSchema,
} from '../routes/taxAwareScenario.js';

const base = {
  profileId: '65b000000000000000000001', taxContextVersion: 1,
  principal: 100000, annualExpectedReturn: 0.08,
  annualVolatility: 0.15, years: 1, simulations: 100,
  inflationRate: 0.05, seed: 17, targetAmount: null,
  acquisitionDate: '2025-06-01', redemptionDate: '2026-06-01',
};

test('Monte Carlo route preserves explicit STT assumption without implicitly setting true', () => {
  for (const assumption of [true, false]) {
    const result = taxAwareScenarioInputSchema.validate({
      ...base, sttConditionAssumedSatisfied: assumption,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.value.sttConditionAssumedSatisfied, assumption);
  }
  const missing = taxAwareScenarioInputSchema.validate(base);
  assert.equal(missing.error, undefined);
  assert.equal(Object.hasOwn(missing.value, 'sttConditionAssumedSatisfied'), false);
  for (const forged of ['true', 1, null]) {
    assert.ok(taxAwareScenarioInputSchema.validate({
      ...base, sttConditionAssumedSatisfied: forged,
    }).error, String(forged));
  }
});

test('qualified-history route validates STT but does not permit a supplied volatility', () => {
  const { annualVolatility, ...withoutVolatility } = base;
  void annualVolatility;
  const qualified = {
    ...withoutVolatility, canonicalProductId: 'exchange:nse:example',
    sourceId: 'source_qualified_test', observationKind: 'PRICE',
    sttConditionAssumedSatisfied: true,
  };
  assert.equal(taxAwareHistoryRiskInputSchema.validate(qualified).error, undefined);
  assert.ok(taxAwareHistoryRiskInputSchema.validate({
    ...qualified, annualVolatility: 0.60,
  }).error, 'Volatility must come from qualified historical observations');
  assert.ok(taxAwareHistoryRiskInputSchema.validate({
    ...qualified, sttConditionAssumedSatisfied: 'true',
  }).error);
});
