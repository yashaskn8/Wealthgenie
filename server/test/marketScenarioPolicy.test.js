import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGbmScenarioAdmission } from '../services/marketScenarioPolicy.js';
test('market-priced funds can request a clearly labelled GBM policy scenario',()=>{
 const x=evaluateGbmScenarioAdmission(['ETF','Equity_MF','Debt_MF']);
 assert.equal(x.admitted,true); assert.equal(x.reasonCode,null);
});
test('contractual deposits, government schemes, bonds and retirement accounts fail closed',()=>{
 const keys=['FD','PPF','SSY','SCSS','G-Sec','RBI_Bond','NPS','SGB'];
 const x=evaluateGbmScenarioAdmission(keys);
 assert.equal(x.admitted,false);
 assert.deepEqual(x.unsupportedKeys,[...keys].sort());
 assert.equal(x.reasonCode,'ASSET_SPECIFIC_CASHFLOW_MODEL_REQUIRED');
});
test('ambiguous classifications are rejected',()=>{
 for(const xs of [[],[null],['ETF',null],['UnverifiedProduct']])
   assert.equal(evaluateGbmScenarioAdmission(xs).admitted,false);
});
