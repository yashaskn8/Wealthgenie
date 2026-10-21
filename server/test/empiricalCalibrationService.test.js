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

test('simulateAssetClassSpecific applies contractual compounding for FDs without stochastic noise', () => {
  const result = simulateAssetClassSpecific({
    assetClass: 'FD',
    monthlyInvestment: 10_000,
    currentSavings: 100_000,
    annualExpectedReturn: 0.075,
    years: 2,
    inflationRate: 0.05,
    contractualParams: { compoundingFrequency: 'QUARTERLY' },
  });

  assert.equal(result.simulation_model, SIMULATION_MODELS.CONTRACTUAL_COMPOUNDING);
  assert.equal(result.is_contractual, true);
  assert.equal(result.simulations_run, 1);
  // All percentile bands must be identical because contractual compounding is deterministic
  assert.deepEqual(result.p10, result.p50);
  assert.deepEqual(result.p50, result.p90);
  assert.deepEqual(result.p10_real, result.p50_real);
  assert.ok(result.p50[1] > 100_000 + 24 * 10_000);
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
