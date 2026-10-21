/**
 * WealthGenie Monte Carlo Simulation Engine
 * Runs N simulations with log-normally distributed returns (GBM)
 * to produce probabilistic wealth projections (percentile bands).
 */
import { INSTRUMENT_PARAMS as CENTRAL_PARAMS, RISK_FREE_RATE } from './instrumentConstants.js';
const INSTRUMENT_PARAMS = {};
for (const [key, p] of Object.entries(CENTRAL_PARAMS)) {
    INSTRUMENT_PARAMS[key] = { mean: p.nominalRate / 100, stdDev: p.volatility };
}
/**
 * Halton low-discrepancy sequence generator.
 */
export function halton(index, base) {
    let result = 0;
    let f = 1 / base;
    let i = index;
    while (i > 0) {
        result += f * (i % base);
        i = Math.floor(i / base);
        f /= base;
    }
    return result;
}
/**
 * Mulberry32 deterministic 32-bit PRNG for reproducible Monte Carlo simulation.
 */
export function createMulberry32(seed) {
    let s = (typeof seed === 'number' ? Math.floor(Math.abs(seed)) : 1337) >>> 0;
    if (s === 0) s = 1337;
    return function nextFloat() {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/**
 * Box-Muller transform — generates a normally distributed random number.
 */
export function boxMuller(u1, u2, rng = null) {
    const random = rng || Math.random;
    if (u1 === undefined || u1 <= 0 || u1 >= 1) {
        u1 = random() || 0.5;
    }
    if (u2 === undefined || u2 <= 0 || u2 >= 1) {
        u2 = random() || 0.5;
    }
    u1 = Math.max(1e-15, Math.min(u1, 1 - 1e-15));
    u2 = Math.max(1e-15, Math.min(u2, 1 - 1e-15));
    return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}
/**
 * Compute percentile from a sorted array using linear interpolation.
 */
export function percentile(sortedArr, p) {
    if (!Array.isArray(sortedArr) || sortedArr.length === 0 || sortedArr.some(value => !Number.isFinite(value)))
        throw new TypeError('sortedArr must be a non-empty array of finite numbers');
    if (!Number.isFinite(p) || p < 0 || p > 100)
        throw new RangeError('p must be an explicit percentile from 0 to 100');
    const idx = (p / 100) * (sortedArr.length - 1);
    const lower = Math.floor(idx);
    const upper = Math.ceil(idx);
    if (lower === upper)
        return sortedArr[lower];
    return sortedArr[lower] + (sortedArr[upper] - sortedArr[lower]) * (idx - lower);
}
export function buildProjectionHorizon(years) {
    if (!Number.isFinite(years) || years <= 0 || years > 30) {
        throw new RangeError('years must be an explicit finite number from 0 (exclusive) to 30');
    }
    const totalMonths = Math.round(years * 12);
    if (totalMonths < 1) throw new RangeError('years must represent at least one month');
    const checkpointMonths = [];
    for (let month = 12; month < totalMonths; month += 12) {
        checkpointMonths.push(month);
    }
    if (!checkpointMonths.includes(totalMonths)) {
        checkpointMonths.push(totalMonths);
    }
    return {
        years: totalMonths / 12,
        totalMonths,
        checkpointMonths,
        yearsArray: checkpointMonths.map(month => Number((month / 12).toFixed(2))),
    };
}
export function annuityDueFV(monthlyInvestment, monthlyRate, totalMonths) {
    if (!Number.isFinite(monthlyInvestment) || monthlyInvestment < 0)
        throw new TypeError('monthlyInvestment must be an explicit non-negative number');
    if (!Number.isFinite(monthlyRate) || monthlyRate <= -1)
        throw new RangeError('monthlyRate must be an explicit decimal greater than -1');
    if (!Number.isInteger(totalMonths) || totalMonths <= 0)
        throw new RangeError('totalMonths must be an explicit positive integer');
    if (monthlyInvestment === 0) return 0;
    if (Math.abs(monthlyRate) < 1e-12) {
        return monthlyInvestment * totalMonths;
    }
    return monthlyInvestment
        * ((Math.pow(1 + monthlyRate, totalMonths) - 1) / monthlyRate)
        * (1 + monthlyRate);
}
/**
 * Helper to sample a single monthly log-normal multiplier (GBM).
 */
export function sampleLogNormalMonthly(annualMean, annualVol, zVal) {
    const dt = 1 / 12;
    const drift = (Math.log1p(annualMean) - 0.5 * annualVol * annualVol) * dt;
    const vol = annualVol * Math.sqrt(dt);
    return Math.exp(drift + vol * zVal);
}
/**
 * Compute Sequence of Returns Risk and dispersion CV.
 */
export function computeSequenceRisk(finalValues, simulations, years, monthlyWithdrawal = 0) {
    if (!finalValues || finalValues.length === 0)
        return 0;
    if (monthlyWithdrawal > 0) {
        const bankruptCount = finalValues.filter(v => v <= 0).length;
        return parseFloat((bankruptCount / finalValues.length).toFixed(4));
    }
    const meanVal = finalValues.reduce((a, b) => a + b, 0) / finalValues.length;
    if (meanVal <= 0)
        return 0;
    const variance = finalValues.reduce((s, v) => s + Math.pow(v - meanVal, 2), 0) / finalValues.length;
    const stdDev = Math.sqrt(variance);
    const cv = stdDev / meanVal;
    return parseFloat(cv.toFixed(4));
}
/**
 * Compute implied annual volatility and Sharpe ratio proxy.
 */
export function computeRiskMetrics(p50Values, p10Values, years, riskFreeRate, annualExpectedReturn) {
    if (!Number.isFinite(riskFreeRate) || !Number.isFinite(annualExpectedReturn)) {
        throw new TypeError('riskFreeRate and annualExpectedReturn must be explicit finite decimals');
    }
    if (!p50Values || !p10Values || p50Values.length === 0 || p10Values.length === 0 || years <= 0) {
        return { impliedVol: 0, sharpeRatio: 0 };
    }
    const p50Last = p50Values[p50Values.length - 1];
    const p10Last = p10Values[p10Values.length - 1];
    let impliedVol = 0;
    if (p50Last > 0 && p10Last > 0 && p50Last > p10Last) {
        impliedVol = Math.log(p50Last / p10Last) / (1.28155 * Math.sqrt(years));
    }
    const sharpeRatio = impliedVol > 0.0001 ? (annualExpectedReturn - riskFreeRate) / impliedVol : 0;
    return {
        impliedVol: parseFloat(impliedVol.toFixed(4)),
        sharpeRatio: parseFloat(sharpeRatio.toFixed(4)),
    };
}
/**
 * Run Monte Carlo simulation for SIP investment using GBM.
 * Synchronously computes real purchasing-power paths along the exact same stochastic paths.
 */
export function runMonteCarlo({
    monthlyInvestment,
    annualExpectedReturn,
    annualVolatility,
    years,
    simulations,
    inflationRate,
    isRealTrack = false,
    currentSavings,
    seed = null,
    controlVariateMethod = 'none',
}) {
    const horizon = buildProjectionHorizon(years);
    years = horizon.years;
    if (!Number.isFinite(monthlyInvestment) || monthlyInvestment < 0) {
        throw new TypeError('monthlyInvestment must be an explicit non-negative number');
    }
    if (!Number.isFinite(currentSavings) || currentSavings < 0) {
        throw new TypeError('currentSavings must be an explicit non-negative number');
    }
    if (monthlyInvestment === 0 && currentSavings === 0) {
        throw new RangeError('monthlyInvestment or currentSavings must be greater than zero');
    }
    if (!Number.isFinite(annualExpectedReturn) || annualExpectedReturn <= -1 || annualExpectedReturn > 1) {
        throw new RangeError('annualExpectedReturn must be an explicit decimal greater than -1 and at most 1');
    }
    if (!Number.isFinite(annualVolatility) || annualVolatility < 0 || annualVolatility > 0.60) {
        throw new RangeError('annualVolatility must be an explicit decimal from 0 to 0.60');
    }
    if (!Number.isInteger(simulations) || simulations < 100 || simulations > 50000) {
        throw new RangeError('simulations must be an explicit integer from 100 to 50000');
    }
    if (!Number.isFinite(inflationRate) || inflationRate < 0 || inflationRate > 1) {
        throw new RangeError('inflationRate must be an explicit decimal from 0 to 1');
    }
    if (seed != null && (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)) {
        throw new RangeError('seed must be an unsigned 32-bit integer');
    }
    if (controlVariateMethod !== 'none') {
        throw new RangeError('Unsupported control variate: checkpoint rescaling distorts simulated outcomes');
    }
    const safeInvestment = monthlyInvestment;
    const safeSavings = currentSavings;
    const safeVolatility = annualVolatility;
    const rng = (seed !== null && seed !== undefined) ? createMulberry32(seed) : null;
    // Warn on negative return assumptions (possible during extreme market conditions)
    if (annualExpectedReturn < 0 && !isRealTrack) {
        console.warn(`[MC] Negative annual return assumption: ${(annualExpectedReturn * 100).toFixed(2)}%. `
            + `Simulation will proceed but projections may show capital erosion.`);
    }
    const { totalMonths, checkpointMonths, yearsArray } = horizon;
    const checkpointMonthToIndex = new Map(checkpointMonths.map((month, index) => [month, index]));
    // finalValues[year_index] = array of terminal values across all simulations
    const allSimResults = yearsArray.map(() => []);
    const allSimResults_real = yearsArray.map(() => []);
    let finalValues = []; // terminal balances for goal probability
    let finalValues_real = [];
    const halfSims = Math.ceil(simulations / 2);
    const actualSims = halfSims * 2;
    // Match the monthly multiplier used by the simulated path when volatility is zero.
    // annualExpectedReturn is an effective annual assumption, not a log return.
    const r = Math.expm1(Math.log1p(annualExpectedReturn) / 12);
    const fvSIP = annuityDueFV(safeInvestment, r, totalMonths);
    const fvSavings = safeSavings * Math.pow(1 + r, totalMonths);
    const deterministicFV = fvSIP + fvSavings;
    for (let sim = 0; sim < halfSims; sim++) {
        const useQMC = sim < halfSims * 0.4;
        const zValues = new Array(totalMonths);
        for (let i = 0; i < totalMonths; i++) {
            if (useQMC) {
                const seqIdx = sim * totalMonths + i + 1;
                const base1 = (i % 2 === 0) ? 2 : 5;
                const base2 = (i % 2 === 0) ? 3 : 7;
                const u1 = halton(seqIdx, base1) || 0.5;
                const u2 = halton(seqIdx, base2) || 0.5;
                zValues[i] = boxMuller(u1, u2);
            }
            else {
                zValues[i] = boxMuller(undefined, undefined, rng);
            }
        }
        // ── Path 1: use +Z ──────────────────────────────────────────────
        let balance1 = safeSavings;
        for (let monthIdx = 0; monthIdx < totalMonths; monthIdx++) {
            balance1 += safeInvestment;
            const z = zValues[monthIdx];
            balance1 *= sampleLogNormalMonthly(annualExpectedReturn, safeVolatility, z);
            const checkpointIdx = checkpointMonthToIndex.get(monthIdx + 1);
            if (checkpointIdx !== undefined) {
                allSimResults[checkpointIdx].push(balance1);
                const inflationDeflator = Math.pow(1 + inflationRate, (monthIdx + 1) / 12);
                allSimResults_real[checkpointIdx].push(balance1 / inflationDeflator);
            }
        }
        finalValues.push(balance1);
        finalValues_real.push(balance1 / Math.pow(1 + inflationRate, totalMonths / 12));
        // ── Path 2: use -Z (antithetic mirror) ──────────────────────────
        let balance2 = safeSavings;
        for (let monthIdx = 0; monthIdx < totalMonths; monthIdx++) {
            balance2 += safeInvestment;
            const z = zValues[monthIdx];
            balance2 *= sampleLogNormalMonthly(annualExpectedReturn, safeVolatility, -z);
            const checkpointIdx = checkpointMonthToIndex.get(monthIdx + 1);
            if (checkpointIdx !== undefined) {
                allSimResults[checkpointIdx].push(balance2);
                const inflationDeflator = Math.pow(1 + inflationRate, (monthIdx + 1) / 12);
                allSimResults_real[checkpointIdx].push(balance2 / inflationDeflator);
            }
        }
        finalValues.push(balance2);
        finalValues_real.push(balance2 / Math.pow(1 + inflationRate, totalMonths / 12));
    }
    // Never force an empirical sample mean to its analytic reference
    // by changing the simulated path distribution and its quantiles.
    finalValues = [...allSimResults[allSimResults.length - 1]];
    const rawMean = finalValues.reduce((sum, value) => sum + value, 0) / finalValues.length;
    const samplingMeanError = rawMean - deterministicFV;
    // Sort each year's results ONCE, then extract all percentiles
    const p10 = [], p25 = [], p50 = [], p75 = [], p90 = [], mean = [];
    const stdErr = [];
    for (let y = 0; y < allSimResults.length; y++) {
        const sorted = [...allSimResults[y]].sort((a, b) => a - b);
        const yrNom = Math.round(percentile(sorted, 10));
        const yrP25 = Math.round(percentile(sorted, 25));
        const yrP50 = Math.round(percentile(sorted, 50));
        const yrP75 = Math.round(percentile(sorted, 75));
        const yrP90 = Math.round(percentile(sorted, 90));
        const avg = sorted.reduce((s, v) => s + v, 0) / sorted.length;
        const yrMean = Math.round(avg);
        p10.push(yrNom);
        p25.push(yrP25);
        p50.push(yrP50);
        p75.push(yrP75);
        p90.push(yrP90);
        mean.push(yrMean);
        const variance = sorted.reduce((s, v) => s + (v - avg) ** 2, 0) / (sorted.length - 1);
        stdErr.push(Math.round(Math.sqrt(variance / sorted.length)));
    }
    // Compute real percentiles directly from the synchronous deflation of the SAME simulated paths
    const p10_real = [], p25_real = [], p50_real = [], p75_real = [], p90_real = [], mean_real = [];
    for (let y = 0; y < allSimResults_real.length; y++) {
        const sortedReal = [...allSimResults_real[y]].sort((a, b) => a - b);
        p10_real.push(Math.round(percentile(sortedReal, 10)));
        p25_real.push(Math.round(percentile(sortedReal, 25)));
        p50_real.push(Math.round(percentile(sortedReal, 50)));
        p75_real.push(Math.round(percentile(sortedReal, 75)));
        p90_real.push(Math.round(percentile(sortedReal, 90)));
        const avgReal = sortedReal.reduce((s, v) => s + v, 0) / sortedReal.length;
        mean_real.push(Math.round(avgReal));
    }
    const realTrackResult = {
        years_array: yearsArray,
        p10: p10_real,
        p25: p25_real,
        p50: p50_real,
        p75: p75_real,
        p90: p90_real,
        mean: mean_real,
        simulations_run: actualSims,
        nominal_path_aligned: true,
    };
    const sequenceOfReturnsRisk = computeSequenceRisk(finalValues, actualSims, years, 0);
    const baseSharpe = safeVolatility > 0.001 ? (annualExpectedReturn - RISK_FREE_RATE) / safeVolatility : 0;
    const sharpeSensitivity = {
        minus_5pct: (safeVolatility - 0.05) > 0.001 ? (annualExpectedReturn - RISK_FREE_RATE) / (safeVolatility - 0.05) : 0,
        minus_2pct: (safeVolatility - 0.02) > 0.001 ? (annualExpectedReturn - RISK_FREE_RATE) / (safeVolatility - 0.02) : 0,
        base: baseSharpe,
        plus_2pct: (annualExpectedReturn - RISK_FREE_RATE) / (safeVolatility + 0.02),
        plus_5pct: (annualExpectedReturn - RISK_FREE_RATE) / (safeVolatility + 0.05),
    };
    const response = {
        years_array: yearsArray,
        p10, p25, p50, p75, p90, mean,
        p10_real, p25_real, p50_real, p75_real, p90_real, mean_real,
        standard_error: stdErr,
        deterministic_fv: Math.round(deterministicFV),
        control_correction: null,
        sampling_mean_error: Math.round(samplingMeanError) || 0,
        model_version: 'monte-carlo-gbm-2.1.0',
        finalValues, // expose for goal probability reuse
        simulations_run: actualSims,
        nominal_real_path_aligned: true,
        seed_used: seed !== null && seed !== undefined ? seed : null,
        is_reproducible: seed !== null && seed !== undefined,
        dispersion_cv: sequenceOfReturnsRisk,
        sequence_risk_metric: 'terminal_dispersion_cv',
    };
    if (!isRealTrack) {
        response.real = realTrackResult;
        response.inflationRateUsed = inflationRate;
        response.sequenceRisk = sequenceOfReturnsRisk;
        response.riskMetrics = computeRiskMetrics(p50, p10, years, RISK_FREE_RATE, annualExpectedReturn);
        response.variance_reduction = 'halton_qmc+antithetic';
        response.control_variate_method = controlVariateMethod;
        response.sequence_of_returns_risk = null;
        response.terminal_wealth_cv = sequenceOfReturnsRisk;
        response.sharpe_ratio_sensitivity = sharpeSensitivity;
        response.inflation_rate = inflationRate;
    }
    return response;
}

/**
 * Generate an empty result set (for invalid inputs).
 */
/** Compute the probability that a goal amount is reached. */
export function computeGoalProbability(terminalValues, targetAmount) {
    if (!Array.isArray(terminalValues) || terminalValues.length === 0
        || terminalValues.some(value => !Number.isFinite(value))) {
        throw new TypeError('terminalValues must be a non-empty array of finite values');
    }
    if (!Number.isFinite(targetAmount) || targetAmount <= 0)
        throw new RangeError('targetAmount must be an explicit positive number');
    const successes = terminalValues.filter(v => v >= targetAmount).length;
    return parseFloat((successes / terminalValues.length).toFixed(4));
}
/**
 * Compute the Wilson score confidence interval for a binomial proportion.
 */
export function computeWilsonCI(p, n) {
    if (!Number.isFinite(p) || p < 0 || p > 1)
        throw new RangeError('p must be an explicit probability from 0 to 1');
    if (!Number.isInteger(n) || n <= 0)
        throw new RangeError('n must be an explicit positive integer');
    const z = 1.95996; // 95% confidence level
    const pVal = Math.min(Math.max(p, 0), 1);
    const factor = (z * z) / n;
    const term1 = pVal + factor / 2;
    const term2 = z * Math.sqrt((pVal * (1 - pVal) + factor / 4) / n);
    const denom = 1 + factor;
    const lower = (term1 - term2) / denom;
    const upper = (term1 + term2) / denom;
    return {
        lower: parseFloat(Math.max(0, lower).toFixed(4)),
        upper: parseFloat(Math.min(1, upper).toFixed(4)),
    };
}
/**
 * Run a full Monte Carlo simulation and also compute goal probability.
 */
export function runMonteCarloWithGoal(params) {
    const { targetAmount, ...mcParams } = params;
    if (targetAmount !== null && targetAmount !== undefined
        && (!Number.isFinite(targetAmount) || targetAmount <= 0)) {
        throw new RangeError('targetAmount must be null or a positive finite number');
    }
    const result = runMonteCarlo(mcParams);
    // Reuse terminal values from the primary simulation run
    const goalProbability = targetAmount !== null && targetAmount !== undefined && result.finalValues
        ? computeGoalProbability(result.finalValues, targetAmount)
        : null;
    // Quasi-random and antithetic paths are dependent samples. A Wilson
    // interval would misleadingly assume independent Bernoulli trials.
    const goalProbabilityCI = null;
    // Remove raw finalValues from response
    const { finalValues, ...cleanResult } = result;
    if (cleanResult.real) {
        delete cleanResult.real.finalValues;
    }
    return {
        ...cleanResult,
        goal_probability: goalProbability,
        goal_probability_ci: goalProbabilityCI,
        goal_probability_ci_status: 'NOT_ESTIMATED_DEPENDENT_SIMULATIONS',
        target_amount: targetAmount ?? null,
    };
}
/**
 * Get default volatility parameters for an instrument type.
 */
export function getInstrumentVolatility(instrumentType, overrideMean) {
    const params = INSTRUMENT_PARAMS[instrumentType];
    if (!params) return null;
    if (overrideMean !== undefined && !Number.isFinite(overrideMean)) {
        throw new TypeError('overrideMean must be a finite decimal when supplied');
    }
    return {
        mean: overrideMean !== undefined ? overrideMean : params.mean,
        stdDev: params.stdDev,
    };
}
/**
 * Reverse SIP formula — compute monthly SIP required to reach a target.
 */
export function reverseSIP(targetAmount, annualRate, years, currentSavings) {
    if (!Number.isFinite(targetAmount) || targetAmount <= 0)
        throw new RangeError('targetAmount must be a positive finite number');
    if (!Number.isFinite(years) || years <= 0)
        throw new RangeError('years must be a positive finite number');
    if (!Number.isFinite(annualRate) || annualRate <= -1 || annualRate > 1)
        throw new RangeError('annualRate must be a decimal greater than -1 and at most 1');
    if (!Number.isFinite(currentSavings) || currentSavings < 0)
        throw new RangeError('currentSavings must be an explicit non-negative finite number');
    const r = Math.expm1(Math.log1p(annualRate) / 12);
    const n = years * 12;
    const fvCurrent = currentSavings > 0
        ? currentSavings * Math.pow(1 + r, n)
        : 0;
    const remaining = Math.max(0, targetAmount - fvCurrent);
    if (remaining === 0)
        return 0;
    if (r === 0)
        return remaining / n;
    return remaining * r / ((Math.pow(1 + r, n) - 1) * (1 + r));
}
