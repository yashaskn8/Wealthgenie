import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isMatrixPSD,
  applyCovarianceShrinkage,
  calibrateAssetHistory,
  calibrateMultivariateHistory,
  simulateAssetClassSpecific,
  SIMULATION_MODELS,
  EMPIRICAL_CALIBRATION_VERSION,
} from '../services/empiricalCalibrationService.js';

test('isMatrixPSD correctly validates positive semi-definite and non-PSD matrices', () => {
  // 2x2 Identity (strictly positive definite)
  const identity = [
    [1, 0],
    [0, 1],
  ];
  assert.equal(isMatrixPSD(identity), true);

  // 2x2 valid correlation matrix
  const validCorr = [
    [1, 0.5],
    [0.5, 1],
  ];
  assert.equal(isMatrixPSD(validCorr), true);

  // 2x2 invalid non-PSD matrix (determinant is 1 - 1.44 = -0.44 < 0)
  const invalidMatrix = [
    [1, 1.2],
    [1.2, 1],
  ];
  assert.equal(isMatrixPSD(invalidMatrix), false);
});

test('applyCovarianceShrinkage converts non-PSD matrix to valid PSD matrix', () => {
  const nonPSD = [
    [1.0, 0.95, 0.95],
    [0.95, 1.0, -0.90],
    [0.95, -0.90, 1.0],
  ];
  assert.equal(isMatrixPSD(nonPSD), false);

  const shrunk = applyCovarianceShrinkage(nonPSD, 0.30);
  assert.equal(isMatrixPSD(shrunk), true);
  // Diagonal elements must be preserved
  assert.equal(shrunk[0][0], 1.0);
  assert.equal(shrunk[1][1], 1.0);
  assert.equal(shrunk[2][2], 1.0);
});

test('calibrateAssetHistory calculates accurate statistical and tail metrics', () => {
  // Generate 60 daily bars with a 10% annualized drift and ~15% volatility
  const basePrice = 100;
  const series = [];
  let price = basePrice;
  const startDate = new Date('2025-01-01');

  for (let i = 0; i < 60; i++) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    // Deterministic oscillating return
    const ret = 0.0004 + (i % 2 === 0 ? 0.01 : -0.009);
    price *= Math.exp(ret);
    series.push({
      date: d.toISOString().slice(0, 10),
      close: Number(price.toFixed(2)),
    });
  }

  const calib = calibrateAssetHistory({ series, assetKey: 'NIFTY50_ETF', frequency: 'DAILY' });
  assert.equal(calib.assetKey, 'NIFTY50_ETF');
  assert.equal(calib.calibrationVersion, EMPIRICAL_CALIBRATION_VERSION);
  assert.equal(calib.observationCount, 60);
  assert.ok(Number.isFinite(calib.annualizedMean));
  assert.ok(Number.isFinite(calib.annualizedVolatility));
  assert.ok(calib.annualizedVolatility > 0);
  assert.ok(calib.maxDrawdown >= 0 && calib.maxDrawdown <= 1);
  assert.ok(Number.isFinite(calib.skewness));
  assert.ok(Number.isFinite(calib.excessKurtosis));
  assert.ok(Number.isFinite(calib.annualizedVaR95));
  assert.ok(Number.isFinite(calib.annualizedCVaR95));
  assert.ok(typeof calib.datasetFingerprint === 'string' && calib.datasetFingerprint.length === 64);
});

test('calibrateMultivariateHistory aligns dates and calculates PSD covariance', () => {
  const dates = [];
  const start = new Date('2025-01-01');
  for (let i = 0; i < 40; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }

  const seriesA = dates.map((date, i) => ({ date, close: 100 + i * 0.5 + (i % 2 === 0 ? 1 : -1) }));
  const seriesB = dates.map((date, i) => ({ date, close: 200 + i * 0.3 + (i % 3 === 0 ? 2 : -1.5) }));

  const multi = calibrateMultivariateHistory({
    assetSeriesMap: { 'Asset_A': seriesA, 'Asset_B': seriesB },
    frequency: 'DAILY',
  });

  assert.equal(multi.commonObservationCount, 40);
  assert.deepEqual(multi.assetKeys, ['Asset_A', 'Asset_B']);
  assert.equal(multi.isPSD, true);
  assert.equal(multi.covarianceMatrix.length, 2);
  assert.equal(multi.correlationMatrix.length, 2);
  assert.equal(multi.correlationMatrix[0][0], 1);
  assert.equal(multi.correlationMatrix[1][1], 1);
});

test('FD lump sum matches an independent quarterly compound-interest reference', () => {
  const principal = 100_000, nominalAnnual = 0.075, years = 2;
  const outcome = simulateAssetClassSpecific({
    assetClass: 'FD', currentSavings: principal, annualExpectedReturn: nominalAnnual,
    years, inflationRate: 0.05,
    contractualParams: { compoundingFrequency: 'QUARTERLY' },
  });
  const independentlyExpected = principal * (1 + nominalAnnual / 4) ** (years * 4);
  assert.equal(outcome.p50.at(-1), Math.round(independentlyExpected));
  assert.equal(outcome.p50_real.at(-1), Math.round(independentlyExpected / 1.05 ** years));
  assert.deepEqual(outcome.p10, outcome.p90);
  assert.equal(outcome.guaranteed_proceeds, false);
  assert.equal(outcome.post_tax_status, 'REQUIRES_VERIFIED_PRODUCT_AND_TAX_PROFILE');
  assert.equal(outcome.simulations_run, 1);
  assert.equal(outcome.is_bond_ytm, false);
});

test('RD monthly installment timing agrees with cashflow-by-cashflow independent reference', () => {
  const years = 2, annual = 0.072, monthly = 3000;
  const monthlyEquivalent = (1 + annual / 4) ** (1 / 3) - 1;
  const forTiming = contributionTiming => simulateAssetClassSpecific({
    assetClass: 'RD', monthlyInvestment: monthly, annualExpectedReturn: annual, years,
    contractualParams: { compoundingFrequency: 'QUARTERLY', contributionTiming },
  });
  const beginning = forTiming('BEGINNING_OF_MONTH');
  const ending = forTiming('END_OF_MONTH');
  const expectedBeginning = Array.from({ length: 24 }, (_, i) =>
    monthly * (1 + monthlyEquivalent) ** (24 - i)).reduce((a, b) => a + b, 0);
  const expectedEnding = Array.from({ length: 24 }, (_, i) =>
    monthly * (1 + monthlyEquivalent) ** (23 - i)).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(beginning.p50.at(-1) - expectedBeginning) <= 1);
  assert.ok(Math.abs(ending.p50.at(-1) - expectedEnding) <= 1);
  assert.ok(beginning.p50.at(-1) > ending.p50.at(-1));
});

test('at-par fixed coupon bond separates coupons from principal and interest-on-coupons', () => {
  const principal = 100_000, couponRate = 0.08;
  const bond = simulateAssetClassSpecific({
    assetClass: 'G-Sec', currentSavings: principal, years: 2,
    contractualParams: {
      faceValue: principal, purchasePrice: principal,
      couponRate, reinvestmentRate: 0, couponFrequency: 2, maturityMonths: 24,
    },
  });
  // Four independent semiannual coupons of 4,000, plus principal at maturity.
  assert.equal(bond.p50.at(-1), 116_000);
  assert.equal(bond.is_bond_ytm, false);
  assert.equal(bond.market_valuation_available, false);
  const reinvested = simulateAssetClassSpecific({
    assetClass: 'G-Sec', currentSavings: principal, years: 2,
    contractualParams: { faceValue: principal, purchasePrice: principal,
      couponRate, reinvestmentRate: 0.05, couponFrequency: 2, maturityMonths: 24 },
  });
  assert.ok(reinvested.p50.at(-1) > bond.p50.at(-1));
});

test('unsupported schemes and missing contractual facts fail closed, rather than inventing payouts', () => {
  const run = (assetClass, extra = {}) => simulateAssetClassSpecific({
    assetClass, currentSavings: 100_000, annualExpectedReturn: 0.08,
    years: 2, ...extra,
  });
  for (const assetClass of ['PPF', 'SSY', 'SCSS', 'POTD', 'NSC', 'KVP', 'RBI_Bond', 'Unknown']) {
    assert.throws(() => run(assetClass), /UNSUPPORTED_ASSET_MODEL/);
  }
  assert.throws(() => run('FD'), /compoundingFrequency/);
  assert.throws(() => run('FD', { monthlyInvestment: 1000, contractualParams: { compoundingFrequency: 'QUARTERLY' } }), /lump sum/);
  assert.throws(() => run('RD', { monthlyInvestment: 1000,
    contractualParams: { compoundingFrequency: 'QUARTERLY' } }), /opening lump sum/);
  assert.throws(() => run('G-Sec'), /faceValue/);
  assert.throws(() => run('FD', { contractualParams: { compoundingFrequency: 'QUARTERLY' }, modelType: SIMULATION_MODELS.GBM_LOGNORMAL }), /modelType/);
  assert.throws(() => run('Equity_MF', { annualVolatility: 0.2, modelType: SIMULATION_MODELS.HISTORICAL_BLOCK_BOOTSTRAP }), /modelType/);
  assert.throws(() => run('FD', { years: 0.4, contractualParams: { compoundingFrequency: 'QUARTERLY' } }), /tenure/);
  assert.throws(() => run('G-Sec', { contractualParams: {
    faceValue: 100_000, purchasePrice: 95_000, couponRate: 0.08,
    reinvestmentRate: 0.05, couponFrequency: 2, maturityMonths: 24,
  } }), /at-par/);
});

test('covariance refuses malformed non-symmetric or nonfinite matrices', () => {
  assert.equal(isMatrixPSD([[1, 0.8], [0.2, 1]]), false);
  assert.equal(isMatrixPSD([[1, Infinity], [Infinity, 1]]), false);
  assert.equal(isMatrixPSD([[1, 0.5]]), false);
  assert.equal(isMatrixPSD([[0, 1], [1, 1]]), false);
  assert.throws(() => applyCovarianceShrinkage([[1, 2], [0, 1]]), /symmetric/);
  assert.throws(() => applyCovarianceShrinkage([[1, NaN], [NaN, 1]]), /finite square/);
  assert.throws(() => applyCovarianceShrinkage([[-1, 0], [0, 1]]), /negative/);
});

test('calibration dataset fingerprints cover every observation and reject poisoned historical bars', () => {
  const dates = Array.from({ length: 30 }, (_, i) => new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10));
  const series = dates.map((date, i) => ({ date, close: 100 + 0.5 * i + Math.sin(i) }));
  const first = calibrateAssetHistory({ series, assetKey: 'test-instrument' });
  const modified = series.map((bar, i) => i === 15 ? { ...bar, close: bar.close + 0.1 } : bar);
  const second = calibrateAssetHistory({ series: modified, assetKey: 'test-instrument' });
  assert.notEqual(first.datasetFingerprint, second.datasetFingerprint);
  assert.equal(first.dataAdmissionStatus, 'NOT_VERIFIED_PROVIDER_PROVENANCE_AND_RIGHTS');
  assert.throws(() => calibrateAssetHistory({ series: [...series, { ...series[15] }], assetKey: 'test' }), /duplicate dates/);
  assert.throws(() => calibrateAssetHistory({ series: series.map((bar, i) => i === 5 ? { ...bar, close: NaN } : bar), assetKey: 'test' }), /invalid date/);
});

test('simulateAssetClassSpecific falls back to GBM for equities with reproducible seed', () => {
  const run1 = simulateAssetClassSpecific({
    assetClass: 'Equity_MF',
    monthlyInvestment: 5000,
    currentSavings: 50_000,
    annualExpectedReturn: 0.12,
    annualVolatility: 0.18,
    years: 3,
    simulations: 200,
    seed: 777,
  });

  const run2 = simulateAssetClassSpecific({
    assetClass: 'Equity_MF',
    monthlyInvestment: 5000,
    currentSavings: 50_000,
    annualExpectedReturn: 0.12,
    annualVolatility: 0.18,
    years: 3,
    simulations: 200,
    seed: 777,
  });

  assert.equal(run1.simulation_model, SIMULATION_MODELS.GBM_LOGNORMAL);
  assert.deepEqual(run1.p50, run2.p50);
  assert.deepEqual(run1.p90, run2.p90);
});
