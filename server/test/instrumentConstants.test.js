import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INSTRUMENT_PARAMS,
  PROJECTION_ASSUMPTION_DATA_CLASS,
  PROJECTION_ASSUMPTION_POLICY_HASH,
  PROJECTION_ASSUMPTION_SOURCE,
  PROJECTION_ASSUMPTION_VERSION,
  RISK_FREE_RATE,
  CESS_RATE,
} from '../services/instrumentConstants.js';
import { investmentDatabase } from '../data/investmentDatabase.js';
import { resolveBackendType } from '../services/RecommendationPipeline.js';

test('WG-015: Single source of truth for instrument parameters and rates', () => {
  assert.ok(INSTRUMENT_PARAMS, 'INSTRUMENT_PARAMS must be defined');
  assert.ok(INSTRUMENT_PARAMS.Equity_MF, 'Equity_MF parameters must exist in single source of truth');
  assert.equal(typeof RISK_FREE_RATE, 'number', 'RISK_FREE_RATE must be a number');
  assert.equal(CESS_RATE, 0.04, 'CESS_RATE must equal 0.04 (4% Health & Education Cess)');
  assert.equal(INSTRUMENT_PARAMS.Equity_MF.nominalRate, 15.0, 'Equity_MF nominal rate must match the explicit recommendation-type catalog average (15.0%)');
});

test('projection and product-ranking returns retain separate versioned model-assumption provenance', () => {
  for (const [key, params] of Object.entries(INSTRUMENT_PARAMS)) {
    assert.ok(Number.isFinite(params.nominalRate), `Projection scenario rate must exist for ${key}`);
    assert.equal(params.dataClass, PROJECTION_ASSUMPTION_DATA_CLASS);
    assert.equal(params.assumptionVersion, PROJECTION_ASSUMPTION_VERSION);
    assert.equal(params.assumptionHash, PROJECTION_ASSUMPTION_POLICY_HASH);
    assert.equal(params.source, PROJECTION_ASSUMPTION_SOURCE);
    assert.equal(params.observedMarketFact, false);
    assert.equal(params.providerForecast, false);
  }

  for (const instrument of investmentDatabase) {
    if (instrument.returnDataClass === 'UNAVAILABLE') {
      assert.equal(instrument.expectedReturn, null, `Unavailable product return must stay null for ${instrument.id}`);
      assert.equal(instrument.returnAssumptionVersion, null);
      assert.equal(instrument.returnAssumptionHash, null);
      assert.equal(instrument.returnSource, null);
      assert.equal(instrument.providerForecast, false);
      continue;
    }
    assert.ok(Number.isFinite(instrument.expectedReturn), `Product ranking assumption must exist for ${instrument.id}`);
    assert.equal(instrument.returnDataClass, PROJECTION_ASSUMPTION_DATA_CLASS);
    assert.equal(instrument.returnAssumptionVersion, PROJECTION_ASSUMPTION_VERSION);
    assert.equal(instrument.returnAssumptionHash, PROJECTION_ASSUMPTION_POLICY_HASH);
    assert.equal(instrument.returnSource, PROJECTION_ASSUMPTION_SOURCE);
    assert.equal(instrument.providerForecast, false);
  }

  // RBI_Bond demonstrates why the old category-average drift test was invalid:
  // product-ranking and category-level projection inputs are separately named
  // model assumptions bound by the same policy hash, not provider observations
  // that must be numerically equal.
  const [rbiBondCatalog] = investmentDatabase.filter(instrument => resolveBackendType(instrument) === 'RBI_Bond');
  assert.ok(rbiBondCatalog);
  assert.equal(INSTRUMENT_PARAMS.RBI_Bond.dataClass, 'MODEL_ASSUMPTION');
  assert.equal(rbiBondCatalog.returnDataClass, 'MODEL_ASSUMPTION');
  assert.notEqual(rbiBondCatalog.expectedReturn, INSTRUMENT_PARAMS.RBI_Bond.nominalRate);
});
