import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRebalance,
  optimisePortfolio,
  solveMinVariance,
  solveMaxSharpe,
  solveRiskParity,
  buildCovarianceMatrix,
  resolveAssetKey,
  projectSimplex,
  matvec,
  dot,
  portfolioVariance,
  portfolioVol,
  portfolioReturn,
  checkCholeskyPSD,
  ASSET_KEYS,
  CORR_LOWER,
  buildFullCorrelation,
  evaluatePortfolio,
} from '../services/portfolioEngine.js';
import { RISK_FREE_RATE } from '../services/instrumentConstants.js';

const ASSETS = ['Equity_MF', 'Debt_MF', 'Gold'];
const RETURNS = [0.10, 0.06, 0.08];

function assertWeights(result) {
  const weights = Object.values(result.weights);
  const sum = weights.reduce((acc, value) => acc + value, 0);
  assert.ok(Math.abs(sum - 1) < 0.00001, `weights sum=${sum}`);
  assert.ok(weights.every(value => value >= 0));
  assert.ok(Number.isFinite(result.expectedReturn));
  assert.ok(Number.isFinite(result.volatility));
  assert.ok(Number.isFinite(result.sharpe));
}

test('portfolio optimizer returns complete metrics for every exposed strategy', () => {
  for (const strategy of ['min_variance', 'max_sharpe', 'risk_parity']) {
    const result = optimisePortfolio(ASSETS, RETURNS, strategy);
    assert.equal(result.strategy, strategy);
    assertWeights(result);
  }

  // Error case: unknown strategy
  assert.throws(
    () => optimisePortfolio(ASSETS, RETURNS, 'invalid_strategy'),
    /Unknown optimisation strategy "invalid_strategy"/
  );
});

test('final portfolio metrics are recomputed from the exact published weights', () => {
  const weights = { Equity_MF: 0.2, Debt_MF: 0.5, Gold: 0.3 };
  const metrics = evaluatePortfolio(ASSETS, RETURNS, weights);
  assert.equal(metrics.expectedReturn, 0.074);
  assert.ok(metrics.volatility > 0);
  assert.equal(metrics.sharpe, Number(((metrics.expectedReturn - RISK_FREE_RATE) / metrics.volatility).toFixed(4)));
  assert.deepEqual(Object.keys(metrics.riskContributions), ASSETS);
});

test('buildCovarianceMatrix handles aliases and rejects unknown or empty inputs', () => {
  // Empty assets error
  assert.throws(() => buildCovarianceMatrix([]), /assetKeys must be non-empty/);

  // Aliases (SCSS -> FD, SSY -> PPF, Gold_Physical -> Gold, Balanced_Advantage -> Hybrid_MF)
  const covRes = buildCovarianceMatrix(['SCSS', 'SSY', 'Gold_Physical', 'Balanced_Advantage']);
  assert.equal(covRes.matrix.length, 4);
  assert.equal(covRes.assetKeys.length, 4);

  assert.throws(
    () => buildCovarianceMatrix(['Unknown_Asset_Class_XYZ']),
    /Unknown asset key/,
  );
});

test('optimizer edge cases: mismatched lengths, negative/zero excess returns', () => {
  // Length mismatch in solveMinVariance & solveMaxSharpe
  assert.throws(
    () => solveMinVariance(['Equity_MF', 'Debt_MF'], [0.10]),
    /postTaxReturns length \(1\) must match assetKeys length \(2\)/
  );

  // All returns below risk free rate (fallback to min variance)
  const lowReturns = [0.01, 0.02, 0.01]; // risk-free rate is ~0.065
  const maxSharpeRes = solveMaxSharpe(ASSETS, lowReturns);
  assertWeights(maxSharpeRes);
});

test('solveRiskParity computes valid risk contributions and metrics', () => {
  const rpRes = solveRiskParity(ASSETS);
  assert.ok(rpRes.volatility > 0);
  assert.ok(rpRes.riskContributions);
  ASSETS.forEach(k => {
    assert.ok(typeof rpRes.riskContributions[k] === 'number');
  });

  // Risk parity in optimisePortfolio
  const optRp = optimisePortfolio(ASSETS, RETURNS, 'risk_parity');
  assert.equal(optRp.strategy, 'risk_parity');
  assert.ok(typeof optRp.expectedReturn === 'number');
  assert.ok(typeof optRp.sharpe === 'number');
});

test('resolveAssetKey mappings and fallback', () => {
  assert.equal(resolveAssetKey('ppf'), 'PPF');
  assert.equal(resolveAssetKey('fd'), 'FD');
  assert.equal(resolveAssetKey('debt_mf'), 'Debt_MF');
  assert.equal(resolveAssetKey('rbi_bonds'), 'RBI_Bond');
  assert.equal(resolveAssetKey('rbi_retail_direct_gilt'), 'G-Sec');
  assert.equal(resolveAssetKey('g-sec'), 'G-Sec');
  assert.equal(resolveAssetKey('balancedadvantage'), 'Hybrid_MF');
  assert.equal(resolveAssetKey('gold_physical'), 'Gold');
  assert.equal(resolveAssetKey('unknown_custom_key'), 'unknown_custom_key');
});

test('computeRebalance returns deterministic drift directives and rejects zero value', () => {
  assert.throws(() => computeRebalance({}, {}, 2, 1, 24), /greater than zero/);

  // Normal rebalance calculation
  const result = computeRebalance(
    { Equity_MF: 80_000, Debt_MF: 20_000 },
    { Equity_MF: 50, Debt_MF: 50 },
    2,
    1,
    24
  );

  assert.equal(result.total_portfolio_value, 100_000);
  assert.ok(result.drift_index > 0);
  assert.ok(result.assets.some(asset => asset.action_type === 'sell'));
  assert.ok(result.assets.some(asset => asset.action_type === 'buy'));
  assert.ok(typeof result.portfolio_tracking_error === 'number');
});

test('rebalance target sum tolerance accepts only the documented ±0.01 percentage-point boundary', () => {
  const currentAllocation = { FD: 100_000 };
  const normalizedTarget = computeRebalance(currentAllocation, { FD: 50, Debt_MF: 50.0099 }, 5, 0.5, 12);
  assert.ok(Math.abs(normalizedTarget.assets.reduce((sum, asset) => sum + asset.target_pct, 0) - 100) < 0.0001);

  for (const targetAllocation of [
    { FD: 50, Debt_MF: 50.0099 },
    { FD: 49.9901, Debt_MF: 50 },
  ]) {
    assert.doesNotThrow(() => computeRebalance(currentAllocation, targetAllocation, 5, 0.5, 12));
  }
  for (const targetAllocation of [
    { FD: 50, Debt_MF: 50.0101 },
    { FD: 49.9899, Debt_MF: 50 },
  ]) {
    assert.throws(
      () => computeRebalance(currentAllocation, targetAllocation, 5, 0.5, 12),
      /targetAllocation must sum to exactly 100/,
    );
  }
});

test('computeRebalance transaction cost rules and drift severities', () => {
  // High drift (> 12) scenario with holdingMonths < 12 (exit loads apply)
  const highDrift = computeRebalance(
    { Equity_MF: 90_000, Debt_MF: 10_000, Arbitrage_MF: 5000, Liquid_MF: 5000 },
    { Equity_MF: 10, Debt_MF: 90 },
    2.0,
    1.0,
    6 // < 12 months holding (exit loads for Equity_MF and Debt_MF apply)
  );

  assert.equal(highDrift.drift_severity, 'High');
  assert.equal(highDrift.rebalance_recommended, true);
  assert.ok(highDrift.total_estimated_transaction_cost > 0);

  // Check specific asset action types and holding exit loads
  const equityAsset = highDrift.assets.find(a => a.asset_class === 'Equity_MF');
  assert.equal(equityAsset.action_type, 'sell');
  assert.ok(equityAsset.estimated_transaction_cost > 0);

  // Gold transaction costs (resolved key 'Gold')
  const goldRebalance = computeRebalance(
    { Gold: 20_000, Debt_MF: 80_000 },
    { Gold: 80, Debt_MF: 20 },
    2.0,
    1.0,
    24
  );
  const goldAsset = goldRebalance.assets.find(a => a.asset_class === 'Gold');
  assert.equal(goldAsset.action_type, 'buy');
  assert.ok(goldAsset.transaction_cost_rate > 0);
});

test('computeRebalance exact transaction cost rates per asset class', () => {
  // Equity sell < 12 months: STT(0.001) + STAMP_DUTY(0.00005) + exitLoad(0.01) = 0.01105
  const eqShort = computeRebalance(
    { Equity_MF: 100_000, Debt_MF: 0 }, { Equity_MF: 0, Debt_MF: 100 }, 0, 1.0, 6
  );
  const eqA = eqShort.assets.find(a => a.asset_class === 'Equity_MF');
  assert.equal(eqA.transaction_cost_rate, 0.001 + 0.00005 + 0.01);

  // Equity sell >= 12 months: no exit load
  const eqLong = computeRebalance(
    { Equity_MF: 100_000, Debt_MF: 0 }, { Equity_MF: 0, Debt_MF: 100 }, 0, 1.0, 24
  );
  const eqAL = eqLong.assets.find(a => a.asset_class === 'Equity_MF');
  assert.equal(eqAL.transaction_cost_rate, 0.001 + 0.00005);

  // Equity buy: stamp duty only = 0.00005
  const eqBuy = computeRebalance(
    { Equity_MF: 0, Debt_MF: 100_000 }, { Equity_MF: 100 }, 0, 1.0, 24
  );
  const eqBuyA = eqBuy.assets.find(a => a.asset_class === 'Equity_MF');
  assert.equal(eqBuyA.transaction_cost_rate, 0.00005);

  // ELSS sell: STT only = 0.001
  const elssSell = computeRebalance(
    { ELSS: 100_000, Debt_MF: 0 }, { ELSS: 0, Debt_MF: 100 }, 0, 1.0, 24
  );
  const elssA = elssSell.assets.find(a => a.asset_class === 'ELSS');
  assert.equal(elssA.transaction_cost_rate, 0.001);

  // ETF sell: STT(0.001) + brokerage(0.0005) = 0.0015
  const etfSell = computeRebalance(
    { ETF: 100_000, Debt_MF: 0 }, { ETF: 0, Debt_MF: 100 }, 0, 1.0, 24
  );
  const etfA = etfSell.assets.find(a => a.asset_class === 'ETF');
  assert.equal(etfA.transaction_cost_rate, 0.001 + 0.0005);

  // Arbitrage_MF sell < 1 month: STT + brokerage + exitLoad(0.0025)
  const arbShort = computeRebalance(
    { Arbitrage_MF: 100_000, Debt_MF: 0 }, { Arbitrage_MF: 0, Debt_MF: 100 }, 0, 1.0, 0
  );
  const arbA = arbShort.assets.find(a => a.asset_class === 'Arbitrage_MF');
  assert.equal(arbA.transaction_cost_rate, 0.001 + 0.0005 + 0.0025);

  // Liquid_MF sell < 1 month: 0.005
  const liqShort = computeRebalance(
    { Liquid_MF: 100_000, Debt_MF: 0 }, { Liquid_MF: 0, Debt_MF: 100 }, 0, 1.0, 0
  );
  const liqA = liqShort.assets.find(a => a.asset_class === 'Liquid_MF');
  assert.equal(liqA.transaction_cost_rate, 0.005);

  // Liquid_MF sell >= 1 month: 0
  const liqLong = computeRebalance(
    { Liquid_MF: 100_000, Debt_MF: 0 }, { Liquid_MF: 0, Debt_MF: 100 }, 0, 1.0, 24
  );
  const liqAL = liqLong.assets.find(a => a.asset_class === 'Liquid_MF');
  assert.equal(liqAL.transaction_cost_rate, 0);

  // Debt_MF sell < 12 months: exit load 0.005
  const debtShort = computeRebalance(
    { Debt_MF: 100_000, PPF: 0 }, { Debt_MF: 0, PPF: 100 }, 0, 1.0, 6
  );
  const debtA = debtShort.assets.find(a => a.asset_class === 'Debt_MF');
  assert.equal(debtA.transaction_cost_rate, 0.005);

  // FD sell < 12 months: 0.01
  const fdShort = computeRebalance(
    { FD: 100_000, Debt_MF: 0 }, { FD: 0, Debt_MF: 100 }, 0, 1.0, 6
  );
  const fdA = fdShort.assets.find(a => a.asset_class === 'FD');
  assert.equal(fdA.transaction_cost_rate, 0.01);

  // FD sell >= 12 months: 0.005
  const fdLong = computeRebalance(
    { FD: 100_000, Debt_MF: 0 }, { FD: 0, Debt_MF: 100 }, 0, 1.0, 24
  );
  const fdAL = fdLong.assets.find(a => a.asset_class === 'FD');
  assert.equal(fdAL.transaction_cost_rate, 0.005);

  // FD buy: 0.0
  const fdBuy = computeRebalance(
    { Debt_MF: 100_000 }, { FD: 100 }, 0, 1.0, 24
  );
  const fdBuyA = fdBuy.assets.find(a => a.asset_class === 'FD');
  assert.equal(fdBuyA.transaction_cost_rate, 0.0);
});

test('computeRebalance drift severity exact thresholds', () => {
  // Low drift: driftIndex <= 5
  const low = computeRebalance(
    { Equity_MF: 52_000, Debt_MF: 48_000 },
    { Equity_MF: 50, Debt_MF: 50 }, // percentages
    2.0, 1.0, 24
  );
  assert.equal(low.drift_severity, 'Low');
  assert.ok(low.drift_index <= 5);

  // Moderate drift: 5 < driftIndex <= 12
  const moderate = computeRebalance(
    { Equity_MF: 58_000, Debt_MF: 42_000 },
    { Equity_MF: 50, Debt_MF: 50 },
    2.0, 1.0, 24
  );
  assert.equal(moderate.drift_severity, 'Moderate');
  assert.ok(moderate.drift_index > 5 && moderate.drift_index <= 12);

  // High drift: driftIndex > 12
  const high = computeRebalance(
    { Equity_MF: 95_000, Debt_MF: 5_000 },
    { Equity_MF: 20, Debt_MF: 80 },
    2.0, 1.0, 24
  );
  assert.equal(high.drift_severity, 'High');
  assert.ok(high.drift_index > 12);
});

test('computeRebalance requires explicit percentage targets summing to 100', () => {
  assert.throws(() => computeRebalance(
    { Equity_MF: 60_000, Debt_MF: 40_000 },
    { Equity_MF: 0.5, Debt_MF: 0.5 },
    2.0, 1.0, 24
  ), /sum to exactly 100/);

  // Percentage targets (0-100 range)
  const pctResult = computeRebalance(
    { Equity_MF: 60_000, Debt_MF: 40_000 },
    { Equity_MF: 50, Debt_MF: 50 },
    2.0, 1.0, 24
  );
  const eqPct = pctResult.assets.find(a => a.asset_class === 'Equity_MF');
  assert.equal(eqPct.target_pct, 50);
});

test('computeRebalance applies partial ratios and rejects negative values', () => {
  // Partial ratio = 0.5: suggested_correction = raw_correction * 0.5
  const partial = computeRebalance(
    { Equity_MF: 80_000, Debt_MF: 20_000 },
    { Equity_MF: 50, Debt_MF: 50 },
    2.0,
    0.5, // partial ratio
    24
  );
  const eqPartial = partial.assets.find(a => a.asset_class === 'Equity_MF');
  assert.equal(eqPartial.suggested_correction, eqPartial.raw_correction * 0.5);

  assert.throws(() => computeRebalance(
    { Equity_MF: 100_000, Debt_MF: -50_000 },
    { Equity_MF: 100 },
    2.0, 1.0, 24
  ), /Invalid current allocation/);

  assert.throws(() => computeRebalance(
    { Equity_MF: 100_000 },
    { Equity_MF: 100, Debt_MF: -50 },
    2.0, 1.0, 24
  ), /target allocation/);
});

test('computeRebalance hold action for negligible corrections', () => {
  // abs(rawCorrection) < 1.0 -> 'hold'
  const holdResult = computeRebalance(
    { Equity_MF: 50_000, Debt_MF: 50_000 },
    { Equity_MF: 50, Debt_MF: 50 },
    2.0, 1.0, 24
  );
  holdResult.assets.forEach(a => {
    assert.equal(a.action_type, 'hold');
  });
});

test('computeRebalance before_stats and after_stats CAGR and risk scores', () => {
  const result = computeRebalance(
    { Equity_MF: 80_000, Debt_MF: 20_000 },
    { Equity_MF: 50, Debt_MF: 50 },
    2.0, 1.0, 24
  );
  assert.ok(typeof result.before_stats.cagr === 'number');
  assert.ok(typeof result.before_stats.risk_score === 'number');
  assert.ok(typeof result.after_stats.cagr === 'number');
  assert.ok(typeof result.after_stats.risk_score === 'number');
  // Shifting from 80% equity to 50% should lower risk
  assert.ok(result.after_stats.risk_score <= result.before_stats.risk_score);
});

test('resolveAssetKey comprehensive canonical map coverage', () => {
  assert.equal(resolveAssetKey('ppf'), 'PPF');
  assert.equal(resolveAssetKey('fd'), 'FD');
  assert.equal(resolveAssetKey('debt_mf'), 'Debt_MF');
  assert.equal(resolveAssetKey('nps'), 'NPS');
  assert.equal(resolveAssetKey('hybrid_mf'), 'Hybrid_MF');
  assert.equal(resolveAssetKey('index_mf'), 'Index_MF');
  assert.equal(resolveAssetKey('gold_etf'), 'Gold');
  assert.equal(resolveAssetKey('gold'), 'Gold');
  assert.equal(resolveAssetKey('gold_physical'), 'Gold');
  assert.equal(resolveAssetKey('goldphysical'), 'Gold');
  assert.equal(resolveAssetKey('elss'), 'ELSS');
  assert.equal(resolveAssetKey('nifty_etf'), 'ETF');
  assert.equal(resolveAssetKey('etf'), 'ETF');
  assert.equal(resolveAssetKey('midcap_mf'), 'Midcap_MF');
  assert.equal(resolveAssetKey('smallcap_mf'), 'Smallcap_MF');
  assert.equal(resolveAssetKey('liquid_mf'), 'Liquid_MF');
  assert.equal(resolveAssetKey('sgb'), 'SGB');
  assert.equal(resolveAssetKey('scss'), 'SCSS');
  assert.equal(resolveAssetKey('ssy'), 'SSY');
  assert.equal(resolveAssetKey('equity_mf'), 'Equity_MF');
  assert.equal(resolveAssetKey('g-sec'), 'G-Sec');
  assert.equal(resolveAssetKey('rbi_bond'), 'RBI_Bond');
  assert.equal(resolveAssetKey('rbi_bonds'), 'RBI_Bond');
  assert.equal(resolveAssetKey('balanced_advantage'), 'Hybrid_MF');
  assert.equal(resolveAssetKey('balancedadvantage'), 'Hybrid_MF');
  assert.equal(resolveAssetKey('balanced_fund'), 'Hybrid_MF');
  assert.equal(resolveAssetKey('arbitrage_mf'), 'Arbitrage_MF');

  // Case-insensitive direct match
  assert.equal(resolveAssetKey('Equity_MF'), 'Equity_MF');
  assert.equal(resolveAssetKey(' PPF '), 'PPF'); // trim handling

  // Unknown -> returned as-is
  assert.equal(resolveAssetKey('unknown_custom_key'), 'unknown_custom_key');
});

test('buildCovarianceMatrix exact covariance values for known assets', () => {
  // For a single asset, cov[0][0] = correlation(1.0) * sigma^2
  const singleCov = buildCovarianceMatrix(['FD']);
  assert.equal(singleCov.matrix.length, 1);
  assert.ok(singleCov.matrix[0][0] > 0); // sigma_FD^2

  // For two known assets, verify symmetry and off-diagonal correlation
  const twoCov = buildCovarianceMatrix(['Equity_MF', 'Debt_MF']);
  assert.equal(twoCov.matrix[0][1], twoCov.matrix[1][0]); // symmetric
  assert.ok(twoCov.matrix[0][0] > twoCov.matrix[0][1]); // diagonal > off-diagonal

  // Aliases produce same correlation profile
  const aliasCov = buildCovarianceMatrix(['SCSS']);
  const fdCov = buildCovarianceMatrix(['FD']);
  assert.equal(aliasCov.matrix[0][0], fdCov.matrix[0][0]); // SCSS -> FD alias
});

test('solveMinVariance concentrates in low-volatility assets', () => {
  const result = solveMinVariance(ASSETS, RETURNS);
  assertWeights(result);
  // Debt_MF has lowest volatility, should have highest weight
  assert.ok(result.weights['Debt_MF'] >= result.weights['Equity_MF']);
});

test('solveMaxSharpe concentrates in high-Sharpe assets', () => {
  const result = solveMaxSharpe(ASSETS, RETURNS);
  assertWeights(result);
  assert.ok(result.sharpe > 0);
});

test('solveRiskParity risk contributions are approximately equal', () => {
  const result = solveRiskParity(ASSETS);
  const rcs = Object.values(result.riskContributions);
  const maxRC = Math.max(...rcs);
  const minRC = Math.min(...rcs);
  // Risk contributions should be reasonably balanced (within 10x)
  assert.ok(maxRC / Math.max(minRC, 1e-10) < 10);
});

test('projectSimplex Euclidean projection onto probability simplex', () => {
  // Vector already on simplex: [0.5, 0.3, 0.2] -> unchanged
  const s1 = projectSimplex(new Float64Array([0.5, 0.3, 0.2]));
  assert.ok(Math.abs(s1[0] - 0.5) < 1e-6);
  assert.ok(Math.abs(s1[1] - 0.3) < 1e-6);
  assert.ok(Math.abs(s1[2] - 0.2) < 1e-6);

  // Vector with negative values and unnormalized sum: [-1, 2, 0] -> projected onto simplex (sum=1, non-negative)
  const s2 = projectSimplex(new Float64Array([-1, 2, 0]));
  const sum2 = s2.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum2 - 1.0) < 1e-6, `Simplex sum should be 1.0, got ${sum2}`);
  assert.ok(s2.every(v => v >= 0), 'All projected components must be non-negative');
  assert.equal(s2[0], 0); // Negative component projected to 0

  // Uniform unnormalized vector: [1, 1, 1] -> [1/3, 1/3, 1/3]
  const s3 = projectSimplex(new Float64Array([1, 1, 1]));
  assert.ok(Math.abs(s3[0] - 1 / 3) < 1e-6);
  assert.ok(Math.abs(s3[1] - 1 / 3) < 1e-6);
  assert.ok(Math.abs(s3[2] - 1 / 3) < 1e-6);
});

test('matvec and dot product exact matrix vector operations', () => {
  // 2x2 matrix multiplication: A = [[1, 2], [3, 4]], x = [5, 6]
  // y[0] = 1*5 + 2*6 = 17, y[1] = 3*5 + 4*6 = 39
  const A = [new Float64Array([1, 2]), new Float64Array([3, 4])];
  const x = new Float64Array([5, 6]);
  const y = matvec(A, x);
  assert.equal(y[0], 17);
  assert.equal(y[1], 39);

  // Dot product: [1, 2, 3] . [4, 5, 6] = 4 + 10 + 18 = 32
  const dotVal = dot(new Float64Array([1, 2, 3]), new Float64Array([4, 5, 6]));
  assert.equal(dotVal, 32);

  // Zero vector dot product
  assert.equal(dot(new Float64Array([0, 0]), new Float64Array([10, 20])), 0);
});

test('portfolioVariance, portfolioVol, and portfolioReturn math precision', () => {
  // 2-asset diagonal cov: cov = [[0.04, 0], [0, 0.01]], w = [0.5, 0.5]
  // var = 0.5^2 * 0.04 + 0.5^2 * 0.01 = 0.25 * 0.05 = 0.0125
  // vol = sqrt(0.0125) = 0.11180339887...
  const cov = [new Float64Array([0.04, 0]), new Float64Array([0, 0.01])];
  const w = new Float64Array([0.5, 0.5]);
  const mu = new Float64Array([0.12, 0.06]);

  const pVar = portfolioVariance(cov, w);
  assert.equal(pVar, 0.0125);

  const pVol = portfolioVol(cov, w);
  assert.equal(pVol, Math.sqrt(0.0125));

  const pRet = portfolioReturn(w, mu);
  assert.equal(pRet, 0.09); // 0.5*0.12 + 0.5*0.06
});

test('checkCholeskyPSD positive semi-definite matrix validation', () => {
  // 2x2 Identity matrix (PSD) -> true
  const identity = [new Float64Array([1, 0]), new Float64Array([0, 1])];
  assert.equal(checkCholeskyPSD(identity), true);

  // 2x2 Valid covariance matrix (PSD) -> true
  const psd = [new Float64Array([1, 0.5]), new Float64Array([0.5, 1])];
  assert.equal(checkCholeskyPSD(psd), true);

  // 2x2 Non-PSD matrix (negative eigenvalue: det = 1 - 4 = -3) -> false
  const nonPsd = [new Float64Array([1, 2]), new Float64Array([2, 1])];
  assert.equal(checkCholeskyPSD(nonPsd), false);

  // Master correlation matrix FULL_CORR check
  const fullCorr = buildFullCorrelation();
  assert.equal(checkCholeskyPSD(fullCorr), true);
});

test('ASSET_KEYS and CORR_LOWER string and dimension integrity', () => {
  assert.equal(ASSET_KEYS.length, 17);
  assert.equal(CORR_LOWER.length, 17);

  // Every diagonal element in CORR_LOWER must be exactly 1.0
  for (let i = 0; i < 17; i++) {
    assert.equal(CORR_LOWER[i][i], 1.0, `CORR_LOWER[${i}][${i}] should be 1.0`);
    assert.equal(CORR_LOWER[i].length, i + 1, `CORR_LOWER[${i}] length should be ${i + 1}`);
  }
});



