import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateProjections, generateProjectionComparison,
  sipFV, stepUpSipFV, lumpSumFV,
} from '../services/projectionEngine.js';

const argumentsFor = (inflation, annualStepUpRate = 0) => [
  10000, [{ name: 'ETF', type: 'ETF' }], { ETF: 12 },
  [1, 5, 15], inflation, annualStepUpRate, 250000,
];

test('real nominal-SIP paths are deflated at terminal horizon, not re-compounded at real rate', () => {
  const inflation = 0.08;
  const result = generateProjections(...argumentsFor(inflation, 0.08));
  assert.equal(result.monthly_rate_convention, 'NOMINAL_APR_DIVIDED_BY_12');
  assert.equal(result.real_value_method, 'DEFLATED_NOMINAL_TERMINAL_WEALTH');
  const [series] = result.series;
  for (const [i, year] of result.labels.entries()) {
    const deflator = Math.pow(1 + inflation, year);
    const exactNominal = sipFV(10000, 0.12, year) + lumpSumFV(250000, 0.12, year);
    const exactStepUp = stepUpSipFV(10000, 0.12, year, 0.08) + lumpSumFV(250000, 0.12, year);
    assert.equal(series.realData[i], Math.round(exactNominal / deflator));
    assert.equal(series.stepUpRealData[i], Math.round(exactStepUp / deflator));
    assert.equal(result.chartData[i].ETF_real, series.realData[i]);
    assert.equal(result.chartData[i].ETF_stepUp_real, series.stepUpRealData[i]);
  }
});

test('zero inflation leaves all nominal and real series identical', () => {
  const { series } = generateProjections(...argumentsFor(0, 0.05));
  assert.deepEqual(series[0].realData, series[0].data);
  assert.deepEqual(series[0].stepUpRealData, series[0].stepUpData);
});

test('comparison and standard SIP projection share terminal purchasing-power deflation', () => {
  const comparison = generateProjectionComparison({
    monthlyInvestment: 10000, annualReturnRate: 0.12,
    benchmarkRate: 0.05, inflationRate: 0.08, years: 5,
  });
  const { series } = generateProjections(
    10000, [{ name: 'ETF', type: 'ETF' }], { ETF: 12 }, [5], 0.08, 0, 0,
  );
  assert.equal(comparison.investmentMaturity, series[0].data[0]);
  assert.equal(comparison.investmentReal, series[0].realData[0]);
});
