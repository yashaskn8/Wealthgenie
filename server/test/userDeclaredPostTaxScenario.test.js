import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import taxRoutes from '../routes/tax.js';
import { calculateUserDeclaredPostTaxScenario } from '../services/userDeclaredPostTaxScenario.js';
import { userDeclaredPostTaxScenarioSchema } from '../validation/schemas.js';
import { withServer, jsonRequest } from '../test-utils/httpTestUtils.js';

const taxContext = {
  annualGrossIncome: 1_000_000,
  incomeSource: 'salary',
  regime: 'new',
  fiscalYear: 'FY2026-27',
  userAge: 35,
};

function interestScenario(overrides = {}) {
  return {
    ...taxContext,
    canonicalInstrumentId: 'sbi_fd',
    scenarioType: 'INTEREST_INCOME',
    interestReceived: 0,
    ...overrides,
  };
}

function equityScenario(overrides = {}) {
  return {
    ...taxContext,
    annualGrossIncome: 3_000_000,
    canonicalInstrumentId: 'nifty_etf',
    canonicalProductId: 'etf:isin:INF204KB14I2',
    scenarioType: 'EQUITY_REALIZED_GAIN',
    acquisitionCostBasis: 100_000,
    saleProceeds: 110_000,
    acquisitionDate: '2025-01-01',
    redemptionDate: '2025-12-31',
    section112AExemptionUsed: 0,
    sttConditionAssumedSatisfied: true,
    ...overrides,
  };
}

test('user-declared bank interest uses incremental tax and never presents an annualized return', () => {
  const result = calculateUserDeclaredPostTaxScenario(interestScenario({ interestReceived: 5000 }));
  assert.equal(result.status, 'CALCULATED');
  assert.equal(result.calculationClass, 'TRANSACTION_TAX_ESTIMATE');
  assert.equal(result.dataClass, 'USER_DECLARED_TRANSACTION');
  assert.equal(result.inputBasis, 'USER_DECLARED_SCENARIO');
  assert.equal(result.grossGain, 5000);
  assert.equal(result.netGain, result.grossGain - result.incrementalTax);
  assert.equal(result.postTaxRatePct, null);
  assert.equal(result.transactionGainPct, null);
  assert.ok(result.sourceReferences.some(source => source.url?.includes('income_tax_act_2025_as_amended_by_fa_act_2026')));
  assert.equal(result.sourceReferences.some(source => source.url?.includes('sbi.co.in/web/interest-rates')), false);
  assert.match(result.disclosure, /does not report a product rate/i);
  assert.match(result.disclosure, /not verified market facts/i);
});

test('the exact qualified NIFTYBEES scenario uses transaction dates and taxpayer-wide Section 112A usage', () => {
  const result = calculateUserDeclaredPostTaxScenario(equityScenario());
  assert.equal(result.status, 'CALCULATED');
  assert.equal(result.canonicalProductId, 'etf:isin:INF204KB14I2');
  assert.equal(result.grossGain, 10_000);
  assert.equal(result.holdingPeriod.isLongTerm, false);
  assert.equal(result.holdingPeriod.basis, 'EXACT_USER_DECLARED_TRANSACTION_DATES');
  assert.ok(result.incrementalTax > 0);
  assert.ok(result.incrementalTax < result.grossGain);
  assert.equal(result.netGain, result.grossGain - result.incrementalTax);
  assert.equal(result.dataClass, 'USER_DECLARED_TRANSACTION');
  assert.match(result.disclosure, /STT was assumed as you specified and was not verified/i);
});

test('NIFTYBEES losses and unassumed STT fail closed without a tax amount', () => {
  const loss = calculateUserDeclaredPostTaxScenario(equityScenario({ saleProceeds: 90_000 }));
  assert.equal(loss.status, 'UNAVAILABLE');
  assert.equal(loss.grossGain, -10_000);
  assert.equal(loss.incrementalTax, null);
  assert.equal(loss.netGain, null);
  assert.ok(loss.unavailableReasons.includes('CAPITAL_LOSS_SET_OFF_CONTEXT_REQUIRED'));

  const sttUnavailable = calculateUserDeclaredPostTaxScenario(equityScenario({ sttConditionAssumedSatisfied: false }));
  assert.equal(sttUnavailable.status, 'UNAVAILABLE');
  assert.equal(sttUnavailable.incrementalTax, null);
  assert.ok(sttUnavailable.unavailableReasons.includes('EQUITY_TRANSFER_STT_CONDITION_NOT_ESTABLISHED'));
});

test('scenario request validation binds the only ETF calculation to its exact canonical identity', () => {
  assert.equal(userDeclaredPostTaxScenarioSchema.validate(equityScenario()).error, undefined);
  assert.ok(userDeclaredPostTaxScenarioSchema.validate(equityScenario({ canonicalProductId: 'etf:isin:OTHER' })).error);
  assert.ok(userDeclaredPostTaxScenarioSchema.validate(equityScenario({ acquisitionDate: '2025-02-30' })).error);
  assert.ok(userDeclaredPostTaxScenarioSchema.validate(equityScenario({ taxClass: 'EQUITY_MF_SECTION_112A' })).error);
  assert.ok(userDeclaredPostTaxScenarioSchema.validate(interestScenario({ canonicalInstrumentId: 'nifty_etf' })).error);
  assert.ok(userDeclaredPostTaxScenarioSchema.validate(interestScenario({ section112AExemptionUsed: 0 })).error);
});

test('POST /api/tax/post-tax-scenario returns an ephemeral USER_DECLARED_SCENARIO response', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/tax', taxRoutes);
  await withServer(app, async baseUrl => {
    const { response, body } = await jsonRequest(`${baseUrl}/api/tax/post-tax-scenario`, {
      method: 'POST',
      body: JSON.stringify(interestScenario({ interestReceived: 2500 })),
    });
    assert.equal(response.status, 200);
    assert.equal(body.status, 'CALCULATED');
    assert.equal(body.dataClass, 'USER_DECLARED_TRANSACTION');
    assert.equal(body.inputBasis, 'USER_DECLARED_SCENARIO');
    assert.equal(body.canonicalInstrumentId, 'sbi_fd');
    assert.equal(body.postTaxRatePct, null);
  });
});
