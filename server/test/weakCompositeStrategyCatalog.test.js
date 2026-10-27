import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { investmentDatabase } from '../data/investmentDatabase.js';
import { resolveBackendType } from '../services/RecommendationPipeline.js';
import {
  PROJECTION_ASSUMPTION_POLICY_HASH,
  PROJECTION_ASSUMPTION_POLICY_MANIFEST,
  PROJECTION_ASSUMPTION_VERSION,
} from '../services/instrumentConstants.js';

test('term cover plus fund remains educational and never supplies a fictitious combined return', () => {
  const catalog = JSON.parse(readFileSync(new URL('../data/investment_master.json', import.meta.url)));
  const raw = catalog.instruments.find(item => item.id === 'term_mf_combo');
  const adapted = investmentDatabase.find(item => item.id === 'term_mf_combo');
  assert.ok(raw);
  assert.ok(adapted);
  assert.equal(raw.dynamicData.expectedReturn.dataClass, 'UNAVAILABLE');
  assert.deepEqual(Object.values(raw.dynamicData.expectedReturn).filter(Number.isFinite), []);
  assert.deepEqual(raw.dynamicData.topSchemes, []);
  assert.equal(raw.dynamicData.expenseRatio, null);
  assert.equal(raw.dynamicData.risk.value, null);
  assert.equal(raw.dynamicData.liquidity.lockIn, null);
  assert.equal(raw.staticData.trustBadge, null);
  assert.deepEqual(raw.staticData.whereToInvest.platforms, []);
  assert.match(raw.staticData.description, /not one investable product/i);
  assert.equal(adapted.returnDataClass, 'UNAVAILABLE');
  assert.equal(adapted.expectedReturn, null);
  assert.equal(adapted.returnAssumptionVersion, null);
  assert.equal(adapted.returnAssumptionHash, null);
  assert.equal(adapted.taxType, null);
  assert.equal(adapted.rate, null);
  assert.equal(resolveBackendType(adapted), null);
  assert.equal(PROJECTION_ASSUMPTION_VERSION, 'wealthgenie-projection-assumptions-1.1.5');
  assert.equal(PROJECTION_ASSUMPTION_POLICY_HASH, PROJECTION_ASSUMPTION_POLICY_MANIFEST.expectedHash);
  const coverage = JSON.parse(readFileSync(new URL('../data/market_data_coverage.json', import.meta.url)));
  const coverageRow = coverage.entries.find(item => item.catalogId === 'term_mf_combo');
  assert.equal(coverageRow?.dataClass, 'EDUCATIONAL_ONLY');
  assert.equal(coverageRow?.productionUseAllowed, false);
});

test('ULIP discovery never supplies a blanket exemption or category-wide expected return', () => {
  const catalog = JSON.parse(readFileSync(new URL('../data/investment_master.json', import.meta.url)));
  const raw = catalog.instruments.find(item => item.id === 'ulip');
  const adapted = investmentDatabase.find(item => item.id === 'ulip');
  assert.ok(raw);
  assert.ok(adapted);
  assert.equal(raw.dynamicData.expectedReturn.dataClass, 'UNAVAILABLE');
  assert.equal(raw.dynamicData.expectedReturn.avg, null);
  assert.deepEqual(raw.dynamicData.topSchemes, []);
  assert.equal(raw.staticData.taxation.type, null);
  assert.equal(raw.staticData.trustBadge, null);
  assert.deepEqual(raw.staticData.whereToInvest.platforms, []);
  assert.match(raw.staticData.explainer.lockInPlain, /five-year regulatory lock-in/i);
  assert.equal(adapted.type, 'Insurance_Archetype');
  assert.equal(adapted.recommendationType, null);
  assert.equal(adapted.returnDataClass, 'UNAVAILABLE');
  assert.equal(adapted.expectedReturn, null);
  assert.equal(adapted.taxType, null);
  assert.equal(resolveBackendType(adapted), null);
});

test('endowment discovery never supplies fabricated insurer plans, returns or blanket tax', () => {
  const catalog = JSON.parse(readFileSync(new URL('../data/investment_master.json', import.meta.url)));
  const raw = catalog.instruments.find(item => item.id === 'endowment_plan');
  const adapted = investmentDatabase.find(item => item.id === 'endowment_plan');
  assert.ok(raw);
  assert.ok(adapted);
  assert.equal(raw.metadata.sourceConfidence, 'Not established');
  assert.equal(raw.dynamicData.expectedReturn.dataClass, 'UNAVAILABLE');
  assert.equal(raw.dynamicData.expectedReturn.avg, null);
  assert.deepEqual(raw.dynamicData.topSchemes, []);
  assert.equal(raw.staticData.taxation.type, null);
  assert.equal(raw.staticData.trustBadge, null);
  assert.deepEqual(raw.staticData.whereToInvest.platforms, []);
  assert.match(raw.staticData.description, /exact insurer illustration/i);
  assert.equal(adapted.type, 'Insurance_Archetype');
  assert.equal(adapted.recommendationType, null);
  assert.equal(adapted.returnDataClass, 'UNAVAILABLE');
  assert.equal(adapted.expectedReturn, null);
  assert.equal(adapted.taxType, null);
  assert.equal(resolveBackendType(adapted), null);
});

test('blue-chip stock discovery never treats brokers as ranked securities or a fund return as its own', () => {
  const catalog = JSON.parse(readFileSync(new URL('../data/investment_master.json', import.meta.url)));
  const raw = catalog.instruments.find(item => item.id === 'bluechip_stocks');
  const adapted = investmentDatabase.find(item => item.id === 'bluechip_stocks');
  assert.ok(raw);
  assert.ok(adapted);
  assert.equal(raw.metadata.sourceConfidence, 'Not established');
  assert.equal(raw.dynamicData.expectedReturn.dataClass, 'UNAVAILABLE');
  assert.equal(raw.dynamicData.expectedReturn.avg, null);
  assert.deepEqual(raw.dynamicData.topSchemes, []);
  assert.equal(raw.staticData.taxation.type, null);
  assert.equal(raw.staticData.trustBadge, null);
  assert.deepEqual(raw.staticData.whereToInvest.platforms, []);
  assert.match(raw.staticData.description, /not one investable product/i);
  assert.equal(adapted.type, 'Equity_Archetype');
  assert.equal(adapted.recommendationType, null);
  assert.equal(adapted.returnDataClass, 'UNAVAILABLE');
  assert.equal(adapted.expectedReturn, null);
  assert.equal(adapted.taxType, null);
  assert.equal(resolveBackendType(adapted), null);
});
