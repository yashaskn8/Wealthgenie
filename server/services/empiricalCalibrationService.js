/**
 * WealthGenie Empirical Calibration & Asset-Class Simulation Service
 *
 * Computes conditional statistics from caller-supplied historical prices. Such
 * data is NOT automatically licensed, verified or admissible to production.
 * Uses diagonal shrinkage, not a Ledoit-Wolf estimator. Unsupported financial
 * instruments and settlement rules must fail closed.
 */

import { canonicalSha256 } from '../utils/canonicalJson.js';
import { runMonteCarlo, buildProjectionHorizon } from './monteCarloEngine.js';

export const EMPIRICAL_CALIBRATION_VERSION = 'wealthgenie-empirical-calibration-1.0.0';

export const SIMULATION_MODELS = Object.freeze({
  GBM_LOGNORMAL: 'GBM_LOGNORMAL',
  CONTRACTUAL_COMPOUNDING: 'CONTRACTUAL_COMPOUNDING',
  BOND_CASHFLOW_YTM: 'BOND_CASHFLOW_YTM',
  HISTORICAL_BLOCK_BOOTSTRAP: 'HISTORICAL_BLOCK_BOOTSTRAP',
});

export const CALIBRATION_MODES = Object.freeze({
  MODEL_POLICY: 'MODEL_POLICY',
  EMPIRICAL_CALIBRATED: 'EMPIRICAL_CALIBRATED',
});

/**
 * Validates whether a square symmetric matrix is Positive Semi-Definite (PSD) via Cholesky decomposition.
 */
export function isMatrixPSD(matrix, tolerance = 1e-9) {
  if (!Array.isArray(matrix) || matrix.length === 0 ||
      !Number.isFinite(tolerance) || tolerance < 0) return false;
  const n = matrix.length;
  if (matrix.some(row => !Array.isArray(row) && !(row instanceof Float64Array))) return false;
  if (matrix.some(row => row.length !== n || Array.from(row).some(x => !Number.isFinite(x)))) return false;
  const L = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    if (matrix[i][i] < -tolerance) return false;
    for (let j = 0; j < i; j++) {
      if (Math.abs(matrix[i][j] - matrix[j][i]) > tolerance) return false;
    }
    for (let j = 0; j <= i; j++) {
      let residual = matrix[i][j];
      for (let k = 0; k < j; k++) residual -= L[i][k] * L[j][k];
      if (i === j) {
        if (residual < -tolerance) return false;
        L[i][j] = Math.sqrt(Math.max(0, residual));
      } else if (L[j][j] > tolerance) {
        L[i][j] = residual / L[j][j];
      } else if (Math.abs(residual) > tolerance) {
        // A zero pivot with a nonzero off-diagonal residual is not PSD.
        return false;
      }
    }
  }
  return true;
}

/**
 * Diagonal covariance shrinkage. NOT Ledoit-Wolf: that estimator requires
 * estimating shrinkage intensity from observed data.
 */
export function applyCovarianceShrinkage(covMatrix, initialShrinkage = 0.20) {
  if (!Array.isArray(covMatrix) || !Number.isFinite(initialShrinkage) ||
      initialShrinkage < 0 || initialShrinkage > 1) {
    throw new RangeError('covariance matrix and shrinkage intensity must be valid');
  }
  const n = covMatrix.length;
  if (n === 0 || covMatrix.some(row => !Array.isArray(row) && !(row instanceof Float64Array)) ||
      covMatrix.some(row => row.length !== n || Array.from(row).some(x => !Number.isFinite(x)))) {
    throw new TypeError('covMatrix must be a finite square matrix');
  }
  for (let i = 0; i < n; i++) {
    if (covMatrix[i][i] < 0) throw new RangeError('negative covariance diagonal');
    for (let j = 0; j < i; j++) {
      if (Math.abs(covMatrix[i][j] - covMatrix[j][i]) > 1e-9)
        throw new RangeError('covariance must be symmetric');
    }
  }
  if (isMatrixPSD(covMatrix)) return covMatrix.map(row => Array.from(row));
  const candidate = alpha => covMatrix.map((row, i) =>
    Array.from(row, (value, j) => i === j ? value : value * (1 - alpha)));
  // The diagonal is PSD when valid; increase shrinkage monotonically
  // until a valid numerical matrix is reached.
  let low = initialShrinkage, high = 1;
  if (isMatrixPSD(candidate(low))) return candidate(low);
  for (let i = 0; i < 50; i++) {
    const mid = (low + high) / 2;
    if (isMatrixPSD(candidate(mid))) high = mid;
    else low = mid;
  }
  const repaired = candidate(high);
  if (!isMatrixPSD(repaired)) throw new RangeError('cannot repair covariance matrix');
  return repaired;
}

/**
 * Calibrate single-asset historical price series.
 * @param {Array<{ date: string, close: number }>} series
 */
export function calibrateAssetHistory({ series, assetKey, frequency = 'DAILY' }) {
  if (!Array.isArray(series) || series.length < 20) {
    throw new RangeError(`series for ${assetKey} must contain at least 20 valid historical bars.`);
  }

  const sorted = [...series].sort((a, b) => new Date(a.date) - new Date(b.date));
  if (frequency !== 'DAILY' && frequency !== 'MONTHLY' && frequency !== 'WEEKLY')
    throw new RangeError('frequency must be DAILY, MONTHLY or WEEKLY');
  if (sorted.some(bar => !/^\d{4}-\d{2}-\d{2}$/.test(bar?.date) ||
      !Number.isFinite(Date.parse(bar.date)) || !Number.isFinite(bar?.close) || bar.close <= 0))
    throw new RangeError('history contains invalid date or nonpositive/nonfinite close');
  if (sorted.some((bar, i) => i > 0 && bar.date === sorted[i - 1].date))
    throw new RangeError('history contains duplicate dates');
  const validBars = sorted;
  if (validBars.length < 20) {
    throw new RangeError(`series for ${assetKey} has insufficient positive close prices.`);
  }

  const periodsPerYear = frequency === 'DAILY' ? 250 : frequency === 'MONTHLY' ? 12 : 52;
  const logReturns = [];
  for (let i = 1; i < validBars.length; i++) {
    const prev = validBars[i - 1].close;
    const curr = validBars[i].close;
    logReturns.push(Math.log(curr / prev));
  }

  const N = logReturns.length;
  const meanReturnPeriod = logReturns.reduce((s, r) => s + r, 0) / N;
  const variancePeriod = logReturns.reduce((s, r) => s + Math.pow(r - meanReturnPeriod, 2), 0) / (N - 1);
  const stdPeriod = Math.sqrt(variancePeriod);

  const annualizedMean = meanReturnPeriod * periodsPerYear;
  const annualizedVolatility = stdPeriod * Math.sqrt(periodsPerYear);

  // Maximum Drawdown
  let peak = validBars[0].close;
  let maxDrawdown = 0;
  for (const bar of validBars) {
    if (bar.close > peak) {
      peak = bar.close;
    } else {
      const dd = (peak - bar.close) / peak;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
  }

  // Tail Risk: Skewness, Kurtosis, VaR 95%, CVaR 95%
  const sortedReturns = [...logReturns].sort((a, b) => a - b);
  const m3 = stdPeriod > 1e-12 ? logReturns.reduce((s, r) => s + Math.pow((r - meanReturnPeriod) / stdPeriod, 3), 0) / N : null;
  const m4 = stdPeriod > 1e-12 ? logReturns.reduce((s, r) => s + Math.pow((r - meanReturnPeriod) / stdPeriod, 4), 0) / N : null;
  const excessKurtosis = m4 === null ? null : m4 - 3;

  const varIndex = Math.floor(0.05 * N);
  const var95Period = -sortedReturns[varIndex];
  const cvarReturns = sortedReturns.slice(0, varIndex + 1);
  const cvar95Period = -(cvarReturns.reduce((s, r) => s + r, 0) / cvarReturns.length);

  const annualizedVaR95 = var95Period * Math.sqrt(periodsPerYear);
  const annualizedCVaR95 = cvar95Period * Math.sqrt(periodsPerYear);

  const datasetFingerprint = canonicalSha256({
    assetKey,
    barCount: validBars.length,
    startDate: validBars[0].date,
    endDate: validBars[validBars.length - 1].date,
    firstClose: validBars[0].close,
    lastClose: validBars[validBars.length - 1].close,
    allObservedBars: validBars.map(bar => [bar.date, bar.close]),
  });

  return {
    assetKey,
    calibrationVersion: EMPIRICAL_CALIBRATION_VERSION,
    datasetFingerprint,
    frequency,
    observationCount: validBars.length,
    startDate: validBars[0].date,
    endDate: validBars[validBars.length - 1].date,
    annualizedMean: Number(annualizedMean.toFixed(6)),
    annualizedVolatility: Number(annualizedVolatility.toFixed(6)),
    maxDrawdown: Number(maxDrawdown.toFixed(6)),
    skewness: m3 === null ? null : Number(m3.toFixed(4)),
    excessKurtosis: excessKurtosis === null ? null : Number(excessKurtosis.toFixed(4)),
    annualizedVaR95: Number(annualizedVaR95.toFixed(6)),
    annualizedCVaR95: Number(annualizedCVaR95.toFixed(6)),
    tailRiskMethod: 'SQRT_TIME_SCALED_ONE_PERIOD_HEURISTIC_NOT_BACKTESTED',
    dataQualityScore: Number(Math.min(1.0, validBars.length / (periodsPerYear * 3)).toFixed(3)),
    dataAdmissionStatus: 'NOT_VERIFIED_PROVIDER_PROVENANCE_AND_RIGHTS',
    forecastStatus: 'NOT_AN_AUTHORIZED_LIVE_RETURN_FORECAST',
  };
}

/**
 * Calibrate multivariate covariance and correlation across assets with calendar alignment.
 * @param {Record<string, Array<{ date: string, close: number }>>} assetSeriesMap
 */
export function calibrateMultivariateHistory({ assetSeriesMap, frequency = 'DAILY', shrinkage = 0.15 }) {
  if (!assetSeriesMap || typeof assetSeriesMap !== 'object' || Array.isArray(assetSeriesMap) ||
      !['DAILY', 'MONTHLY', 'WEEKLY'].includes(frequency)) throw new TypeError('valid history map and frequency required');
  const assetKeys = Object.keys(assetSeriesMap).sort();
  if (assetKeys.length === 0) {
    throw new TypeError('assetSeriesMap must contain at least one asset series.');
  }

  for (const key of assetKeys) {
    const history = assetSeriesMap[key];
    if (!Array.isArray(history) || history.some(bar => !/^\d{4}-\d{2}-\d{2}$/.test(bar?.date) ||
        !Number.isFinite(Date.parse(bar.date)) || !Number.isFinite(bar?.close) || bar.close <= 0) ||
        new Set(history.map(bar => bar.date)).size !== history.length)
      throw new RangeError(`asset ${key} contains invalid, duplicate or nonpositive historical bars`);
  }
  // Intersect trading dates across all assets
  const dateMaps = assetKeys.map(k => new Map(assetSeriesMap[k].map(b => [b.date, b.close])));
  const commonDates = [...dateMaps[0].keys()].filter(date =>
    dateMaps.every(m => m.has(date) && Number.isFinite(m.get(date)) && m.get(date) > 0)
  ).sort((a, b) => new Date(a) - new Date(b));

  if (commonDates.length < 20) {
    throw new RangeError(`Aligned history across assets has only ${commonDates.length} common dates (minimum 20 required).`);
  }

  const periodsPerYear = frequency === 'DAILY' ? 250 : frequency === 'MONTHLY' ? 12 : 52;
  const N = commonDates.length - 1;
  const returnsByAsset = assetKeys.map(key => {
    const prices = commonDates.map(d => dateMaps[assetKeys.indexOf(key)].get(d));
    const rets = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      rets[i] = Math.log(prices[i + 1] / prices[i]);
    }
    return rets;
  });

  const means = returnsByAsset.map(rets => {
    let s = 0;
    for (let i = 0; i < N; i++) s += rets[i];
    return s / N;
  });

  const numAssets = assetKeys.length;
  const rawCov = Array.from({ length: numAssets }, () => new Float64Array(numAssets));
  for (let i = 0; i < numAssets; i++) {
    for (let j = i; j < numAssets; j++) {
      let sumProd = 0;
      for (let t = 0; t < N; t++) {
        sumProd += (returnsByAsset[i][t] - means[i]) * (returnsByAsset[j][t] - means[j]);
      }
      const covPeriod = sumProd / (N - 1);
      const covAnnual = covPeriod * periodsPerYear;
      rawCov[i][j] = covAnnual;
      rawCov[j][i] = covAnnual;
    }
  }

  const rawPSD = isMatrixPSD(rawCov);
  const finalCov = rawPSD ? rawCov : applyCovarianceShrinkage(rawCov, shrinkage);
  const finalPSD = isMatrixPSD(finalCov);

  // Correlation matrix
  const corr = Array.from({ length: numAssets }, () => new Float64Array(numAssets));
  for (let i = 0; i < numAssets; i++) {
    for (let j = 0; j < numAssets; j++) {
      const denom = Math.sqrt(finalCov[i][i] * finalCov[j][j]);
      corr[i][j] = denom > 1e-12 ? finalCov[i][j] / denom : (i === j ? 1 : 0);
    }
  }

  const datasetFingerprint = canonicalSha256({
    assetKeys,
    commonDatesCount: commonDates.length,
    startDate: commonDates[0],
    endDate: commonDates[commonDates.length - 1],
    alignedObservations: commonDates.map(date => [date, ...assetKeys.map(key => dateMaps[assetKeys.indexOf(key)].get(date))]),
  });

  return {
    calibrationVersion: EMPIRICAL_CALIBRATION_VERSION,
    datasetFingerprint,
    assetKeys,
    commonObservationCount: commonDates.length,
    startDate: commonDates[0],
    endDate: commonDates[commonDates.length - 1],
    covarianceMatrix: finalCov.map(row => Array.from(row)),
    correlationMatrix: corr.map(row => Array.from(row)),
    isPSD: finalPSD,
    shrinkageApplied: !rawPSD,
    shrinkageIntensity: !rawPSD ? null : 0, // numeric intensity not independently estimated
    shrinkageMethod: !rawPSD ? 'ADAPTIVE_DIAGONAL_SHRINKAGE_NOT_LEDOIT_WOLF' : 'NONE',
    dataAdmissionStatus: 'NOT_VERIFIED_PROVIDER_PROVENANCE_AND_RIGHTS',
    annualizedMeans: Object.fromEntries(assetKeys.map((key, i) => [key, Number((means[i] * periodsPerYear).toFixed(6))])),
    annualizedVolatilities: Object.fromEntries(assetKeys.map((key, i) => [key, Number((Math.sqrt(finalCov[i][i])).toFixed(6))])),
  };
}

/**
 * Asset-class specific simulation engine.
 * Applies contractual compounding to Fixed Income / PPF / FDs and GBM / bootstrap to equities.
 */
/**
 * Pure, scenario-only fixed-income reference models. No institution's
 * contractual terms, withholding, default probabilities or eligibility
 * are inferred. These numbers are NOT tradeable prices or verified yields.
 */
const GBM_CLASSES = new Set([
  'EQUITY', 'EQUITY_MF', 'INDEX_MF', 'ETF', 'EQUITY_ETF', 'INDEX_FUND', 'MUTUAL_FUND',
]);
function finiteRange(value, name, minimum, maximum) {
  if (!Number.isFinite(value) || value < minimum || value > maximum)
    throw new RangeError(`${name} must be a finite number in [${minimum}, ${maximum}]`);
}
function createReferenceScenario({
  assetClass, simulationModel, yearsArray, balances, inflationRate, details,
}) {
  const amounts = balances.map(value => {
    if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(value)))
      throw new RangeError('calculated nominal proceeds exceed supported monetary precision');
    return Math.round(value);
  });
  const real = balances.map((value, i) =>
    Math.round(value / Math.pow(1 + inflationRate, yearsArray[i])));
  return {
    assetClass,
    simulation_model: simulationModel,
    scenario_classification: 'UNVERIFIED_CONTRACT_TERMS_ILLUSTRATION',
    valuation_classification: 'NOT_A_TRADABLE_MARKET_QUOTE',
    post_tax_status: 'REQUIRES_VERIFIED_PRODUCT_AND_TAX_PROFILE',
    guaranteed_proceeds: false,
    is_contractual: true,
    simulations_run: 1,
    years_array: yearsArray,
    p10: amounts, p25: [...amounts], p50: [...amounts],
    p75: [...amounts], p90: [...amounts], mean: [...amounts],
    p10_real: real, p25_real: [...real], p50_real: [...real],
    p75_real: [...real], p90_real: [...real], mean_real: [...real],
    deterministic_fv: amounts.at(-1),
    nominal_real_path_aligned: true,
    ...details,
  };
}

/**
 * Asset-specific reference cash flows; disallowed schemes and unsupported
 * bond structures fail closed instead of being disguised as generic GBM.
 *
 * FD: one initial deposit, single stated nominal annual rate, no interim
 *     contributions or withdrawals, credited at specified frequency.
 * RD: equal monthly contributions, explicit beginning/end-of-month timing,
 *     a constant nominal rate, no missed instalments.
 * Fixed-coupon bond: purchased at par, held to maturity, fixed coupons and
 *     explicit reinvestment assumption; no mark-to-market valuation.
 */
export function simulateAssetClassSpecific({
  assetClass,
  modelType = null,
  monthlyInvestment = 0,
  currentSavings = 0,
  annualExpectedReturn,
  annualVolatility = 0,
  years,
  simulations = 1000,
  inflationRate = 0.05,
  seed = null,
  contractualParams = {},
}) {
  const category = String(assetClass || '').trim().toUpperCase();
  if (!category || typeof contractualParams !== 'object' || contractualParams === null ||
      Array.isArray(contractualParams)) throw new TypeError('valid assetClass and contractualParams required');
  const isBond = ['G-SEC', 'GOVERNMENT_BOND', 'BOND', 'CORPORATE_BOND'].includes(category);
  const isDeposit = category === 'FD' || category === 'RD';
  const expected = isBond ? SIMULATION_MODELS.BOND_CASHFLOW_YTM
    : isDeposit ? SIMULATION_MODELS.CONTRACTUAL_COMPOUNDING
    : GBM_CLASSES.has(category) ? SIMULATION_MODELS.GBM_LOGNORMAL : null;

  if (expected === null)
    throw new RangeError(`UNSUPPORTED_ASSET_MODEL: ${category} requires product-specific terms and verified rate schedules`);
  if (modelType !== null && modelType !== expected)
    throw new RangeError('modelType must match the asset-class cashflow model');
  finiteRange(inflationRate, 'inflationRate', 0, 1);
  finiteRange(monthlyInvestment, 'monthlyInvestment', 0, Number.MAX_SAFE_INTEGER);
  finiteRange(currentSavings, 'currentSavings', 0, Number.MAX_SAFE_INTEGER);
  if (monthlyInvestment === 0 && currentSavings === 0)
    throw new RangeError('a positive capital amount is required');

  if (expected === SIMULATION_MODELS.GBM_LOGNORMAL) {
    if (!Number.isFinite(annualVolatility))
      throw new RangeError('annualVolatility is required');
    return {
      ...runMonteCarlo({ monthlyInvestment, currentSavings, annualExpectedReturn,
        annualVolatility, years, simulations, inflationRate, seed }),
      simulation_model: expected,
      assetClass: category,
      calibration_mode: 'MODEL_POLICY',
      post_tax_status: 'REQUIRES_VERIFIED_TAX_AND_REALIZATION_FACTS',
    };
  }

  const horizon = buildProjectionHorizon(years);
  const { totalMonths, checkpointMonths, yearsArray } = horizon;
  const balances = [];
  if (isDeposit) {
    finiteRange(annualExpectedReturn, 'annualExpectedReturn', 0, 1);
    const periods = { MONTHLY: 12, QUARTERLY: 4, ANNUAL: 1 };
    const frequency = contractualParams.compoundingFrequency;
    const perYear = periods[frequency];
    if (!perYear)
      throw new RangeError('FD/RD require explicit compoundingFrequency: MONTHLY, QUARTERLY, ANNUAL');
    if (totalMonths % (12 / perYear) !== 0)
      throw new RangeError('tenure must end on a credited interest period; day-count terms required otherwise');
    if (category === 'FD' && (monthlyInvestment !== 0 || currentSavings <= 0))
      throw new RangeError('FD illustration requires a lump sum and no monthly contributions');
    if (category === 'RD' && (currentSavings !== 0 || monthlyInvestment <= 0))
      throw new RangeError('RD illustration requires monthly instalments and no opening lump sum');
    const timing = category === 'RD' ? contractualParams.contributionTiming : null;
    if (category === 'RD' && !['BEGINNING_OF_MONTH', 'END_OF_MONTH'].includes(timing))
      throw new RangeError('RD contributionTiming is required');
    const creditedMonthlyRate = Math.pow(1 + annualExpectedReturn / perYear, perYear / 12) - 1;
    for (const m of checkpointMonths) {
      if (category === 'FD') {
        balances.push(currentSavings * Math.pow(1 + annualExpectedReturn / perYear, m * perYear / 12));
      } else {
        let value = 0;
        for (let deposit = 0; deposit < m; deposit++) {
          const monthsEarning = m - deposit - (timing === 'END_OF_MONTH' ? 1 : 0);
          value += monthlyInvestment * Math.pow(1 + creditedMonthlyRate, monthsEarning);
        }
        balances.push(value);
      }
    }
    return createReferenceScenario({
      assetClass: category, simulationModel: expected, yearsArray, balances, inflationRate,
      details: { compounding_frequency: frequency,
        contribution_timing: timing,
        rate_basis: 'UNVERIFIED_EXPLICIT_NOMINAL_ANNUAL_ASSUMPTION',
        interest_calculation_basis: 'MONTHLY_INTERPOLATED_COMPOUNDING',
        is_bond_ytm: false },
    });
  }

  // Floating-rate RBI savings bonds and coupon-reset bonds must not be
  // represented as one static coupon. This branch accepts only a fixed-coupon,
  // at-par holding with explicit face amount, maturity and reinvestment rate.
  if (monthlyInvestment !== 0 || currentSavings <= 0)
    throw new RangeError('bond illustration requires one at-par lump-sum holding');
  const { faceValue, purchasePrice, couponRate, reinvestmentRate, couponFrequency, maturityMonths } = contractualParams;
  finiteRange(faceValue, 'faceValue', 0.01, Number.MAX_SAFE_INTEGER);
  finiteRange(purchasePrice, 'purchasePrice', 0.01, Number.MAX_SAFE_INTEGER);
  finiteRange(couponRate, 'couponRate', 0, 1);
  finiteRange(reinvestmentRate, 'reinvestmentRate', 0, 1);
  if (couponFrequency !== 1 && couponFrequency !== 2 && couponFrequency !== 4)
    throw new RangeError('bond couponFrequency must be 1, 2 or 4');
  if (maturityMonths !== totalMonths)
    throw new RangeError('bond cashflow horizon must be the actual maturity');
  if (annualExpectedReturn !== undefined && annualExpectedReturn !== null && annualExpectedReturn !== couponRate)
    throw new RangeError('annualExpectedReturn cannot substitute for a different explicit bond couponRate');
  if (purchasePrice !== faceValue || currentSavings !== purchasePrice)
    throw new RangeError('only explicitly at-par bond purchases are supported');
  const couponInterval = 12 / couponFrequency;
  if (totalMonths % couponInterval !== 0)
    throw new RangeError('maturity must align to the specified coupon schedule');
  const coupon = faceValue * couponRate / couponFrequency;
  const reinvestMonthly = Math.pow(1 + reinvestmentRate, 1 / 12) - 1;
  for (const month of checkpointMonths) {
    let paidCouponsValue = 0;
    for (let paid = couponInterval; paid <= month; paid += couponInterval) {
      paidCouponsValue += coupon * Math.pow(1 + reinvestMonthly, month - paid);
    }
    balances.push(faceValue + paidCouponsValue);
  }
  return createReferenceScenario({
    assetClass: category, simulationModel: expected, yearsArray, balances, inflationRate,
    details: {
      is_bond_ytm: false,
      coupon_cashflows_modelled: true,
      purchase_basis: 'AT_PAR_HELD_TO_MATURITY',
      reinvestment_rate_basis: 'EXPLICIT_UNVERIFIED_ASSUMPTION',
      market_valuation_available: false,
    },
  });
}
