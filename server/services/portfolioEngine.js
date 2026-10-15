/**
 * WealthGenie Portfolio Optimisation Engine
 * Mean-variance portfolio optimisation for Indian asset classes.
 */
import { INSTRUMENT_PARAMS as CENTRAL_PARAMS, RISK_FREE_RATE } from './instrumentConstants.js';
import {
    normalizeAllocationWeights,
    REBALANCE_TARGET_TOTAL_TOLERANCE_PERCENT,
} from '../utils/allocationWeights.js';
const INSTRUMENT_PARAMS = CENTRAL_PARAMS;
export const ASSET_KEYS = [
    'Equity_MF', 'ELSS', 'ETF', 'Debt_MF', 'FD', 'Gold', 'NPS', 'PPF',
    'RBI_Bond', 'G-Sec', 'SGB', 'Liquid_MF', 'Arbitrage_MF', 'Hybrid_MF',
    'Index_MF', 'Midcap_MF', 'Smallcap_MF',
];
// lower triangular values
export const CORR_LOWER = [
    /* Equity_MF   */ [1.00],
    /* ELSS        */ [0.93, 1.00],
    /* ETF         */ [0.95, 0.91, 1.00],
    /* Debt_MF     */ [0.12, 0.11, 0.13, 1.00],
    /* FD          */ [0.05, 0.05, 0.06, 0.80, 1.00],
    /* Gold        */ [0.08, 0.07, 0.09, 0.18, 0.10, 1.00],
    /* NPS         */ [0.82, 0.80, 0.83, 0.30, 0.15, 0.12, 1.00],
    /* PPF         */ [0.04, 0.04, 0.05, 0.75, 0.88, 0.08, 0.14, 1.00],
    /* RBI_Bond    */ [0.06, 0.06, 0.07, 0.82, 0.90, 0.12, 0.16, 0.85, 1.00],
    /* G-Sec       */ [0.10, 0.09, 0.11, 0.85, 0.78, 0.15, 0.20, 0.80, 0.88, 1.00],
    /* SGB         */ [0.10, 0.09, 0.11, 0.20, 0.12, 0.97, 0.14, 0.10, 0.14, 0.18, 1.00],
    /* Liquid_MF   */ [0.03, 0.03, 0.04, 0.72, 0.85, 0.08, 0.10, 0.82, 0.84, 0.70, 0.09, 1.00],
    /* Arbitrage_MF*/ [0.15, 0.14, 0.16, 0.55, 0.45, 0.10, 0.18, 0.40, 0.42, 0.50, 0.12, 0.48, 1.00],
    /* Hybrid_MF   */ [0.78, 0.76, 0.79, 0.35, 0.18, 0.15, 0.72, 0.16, 0.18, 0.25, 0.17, 0.12, 0.28, 1.00],
    /* Index_MF    */ [0.95, 0.90, 0.98, 0.13, 0.06, 0.09, 0.83, 0.05, 0.07, 0.11, 0.11, 0.04, 0.16, 0.79, 1.00],
    /* Midcap_MF   */ [0.88, 0.86, 0.85, 0.10, 0.04, 0.06, 0.78, 0.03, 0.05, 0.08, 0.08, 0.02, 0.12, 0.74, 0.86, 1.00],
    /* Smallcap_MF */ [0.82, 0.80, 0.78, 0.08, 0.03, 0.05, 0.72, 0.02, 0.04, 0.06, 0.06, 0.01, 0.10, 0.68, 0.80, 0.92, 1.00],
];
export function buildFullCorrelation() {
    const n = ASSET_KEYS.length;
    const C = Array.from({ length: n }, () => new Float64Array(n));
    for (let i = 0; i < n; i++) {
        for (let j = 0; j <= i; j++) {
            const val = CORR_LOWER[i][j];
            C[i][j] = val;
            C[j][i] = val;
        }
    }
    return C;
}
export function checkCholeskyPSD(matrix) {
    const n = matrix.length;
    const L = Array.from({ length: n }, () => new Float64Array(n));
    for (let i = 0; i < n; i++) {
        for (let j = 0; j <= i; j++) {
            let sum = 0;
            for (let k = 0; k < j; k++) {
                sum += L[i][k] * L[j][k];
            }
            if (i === j) {
                const val = matrix[i][i] - sum;
                if (val < -1e-9)
                    return false;
                L[i][j] = Math.sqrt(Math.max(0, val));
            }
            else {
                if (L[j][j] > 1e-12) {
                    L[i][j] = (matrix[i][j] - sum) / L[j][j];
                }
                else {
                    L[i][j] = 0;
                }
            }
        }
    }
    return true;
}
const FULL_CORR = buildFullCorrelation();
if (!checkCholeskyPSD(FULL_CORR)) {
    console.warn('[portfolioEngine] Warning: Master correlation matrix is not Positive Semi-Definite (PSD)!');
}
export function matvec(A, x) {
    const n = x.length;
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        let s = 0;
        for (let j = 0; j < n; j++)
            s += A[i][j] * x[j];
        y[i] = s;
    }
    return y;
}
export function dot(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++)
        s += a[i] * b[i];
    return s;
}
export function portfolioVariance(cov, w) {
    return dot(w, matvec(cov, w));
}
export function portfolioVol(cov, w) {
    return Math.sqrt(Math.max(0, portfolioVariance(cov, w)));
}
export function portfolioReturn(w, mu) {
    return dot(w, mu);
}
export function projectSimplex(v) {
    const n = v.length;
    const u = Array.from(v).sort((a, b) => b - a); // descending
    let cumSum = 0;
    let rho = 0;
    for (let j = 0; j < n; j++) {
        cumSum += u[j];
        if (u[j] + (1 - cumSum) / (j + 1) > 0) {
            rho = j;
        }
    }
    let cumSumRho = 0;
    for (let j = 0; j <= rho; j++)
        cumSumRho += u[j];
    const theta = (cumSumRho - 1) / (rho + 1);
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++)
        w[i] = Math.max(v[i] - theta, 0);
    return w;
}
export function buildCovarianceMatrix(assetKeys) {
    const n = assetKeys.length;
    if (n === 0)
        throw new Error('assetKeys must be non-empty');
    // Mapping for asset classes that share correlation/volatility profiles
    // but aren't directly in ASSET_KEYS
    const COVARIANCE_ALIAS = {
        'SCSS': 'FD',
        'SSY': 'PPF',
        'Gold_Physical': 'Gold',
        'Balanced_Advantage': 'Hybrid_MF',
    };
    const indices = assetKeys.map((key) => {
        let lookupKey = COVARIANCE_ALIAS[key] || key;
        const idx = ASSET_KEYS.indexOf(lookupKey);
        if (idx === -1) {
            throw new Error(`Unknown asset key "${key}". Valid keys: ${ASSET_KEYS.join(', ')}`);
        }
        return idx;
    });
    const sigmas = assetKeys.map((key) => {
        const resolvedKey = COVARIANCE_ALIAS[key] || key;
        const params = INSTRUMENT_PARAMS[resolvedKey] || INSTRUMENT_PARAMS[key];
        if (!params) {
            throw new Error(`No volatility parameters established for "${key}"`);
        }
        return params.volatility;
    });
    const cov = Array.from({ length: n }, () => new Float64Array(n));
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            cov[i][j] = FULL_CORR[indices[i]][indices[j]] * sigmas[i] * sigmas[j];
        }
    }
    return { matrix: cov, assetKeys: [...assetKeys] };
}
function _prepareCovarianceMatrixAndValidate(assetKeys, postTaxReturns) {
    const n = assetKeys.length;
    if (n === 0)
        throw new Error('assetKeys must be non-empty');
    if (postTaxReturns.length !== n) {
        throw new Error(`postTaxReturns length (${postTaxReturns.length}) must match assetKeys length (${n})`);
    }
    const { matrix: cov } = buildCovarianceMatrix(assetKeys);
    let maxDiag = 0;
    for (let i = 0; i < n; i++) {
        maxDiag = Math.max(maxDiag, cov[i][i]);
    }
    const regularization = 1e-6 * (maxDiag > 0 ? maxDiag : 1.0);
    for (let i = 0; i < n; i++) {
        cov[i][i] += regularization;
    }
    return { n, cov };
}

export function solveMinVariance(assetKeys, postTaxReturns) {
    const { n, cov } = _prepareCovarianceMatrixAndValidate(assetKeys, postTaxReturns);
    // Initialise with equal weights
    let w = new Float64Array(n).fill(1 / n);
    const maxIter = 5000;
    const tol = 1e-10;
    let lr = 0.5;
    for (let iter = 0; iter < maxIter; iter++) {
        const grad = matvec(cov, w);
        for (let i = 0; i < n; i++)
            grad[i] *= 2;
        const wNew = new Float64Array(n);
        for (let i = 0; i < n; i++)
            wNew[i] = w[i] - lr * grad[i];
        const wProj = projectSimplex(wNew);
        let maxDelta = 0;
        for (let i = 0; i < n; i++)
            maxDelta = Math.max(maxDelta, Math.abs(wProj[i] - w[i]));
        w = wProj;
        if (maxDelta < tol)
            break;
        if (iter > 0 && iter % 500 === 0)
            lr *= 0.8;
    }
    const vol = portfolioVol(cov, w);
    const ret = portfolioReturn(w, postTaxReturns);
    const sharpe = vol > 0 ? (ret - RISK_FREE_RATE) / vol : 0;
    return {
        weights: _weightsToMap(assetKeys, w),
        expectedReturn: _round6(ret),
        volatility: _round6(vol),
        sharpe: _round4(sharpe),
    };
}
function _runMaxSharpePGD(cov, mu, rf, wInit, maxIter = 8000, tol = 1e-10) {
    const n = wInit.length;
    let w = new Float64Array(wInit);
    let lr = 0.02;
    for (let iter = 0; iter < maxIter; iter++) {
        const sigmaW = matvec(cov, w);
        const portVar = dot(w, sigmaW);
        const portVol = Math.sqrt(Math.max(portVar, 1e-18));
        const portRet = dot(w, mu);
        const excessRet = portRet - rf;
        const grad = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            grad[i] = (mu[i] * portVol - excessRet * sigmaW[i] / portVol) / (portVol * portVol);
        }
        const wNew = new Float64Array(n);
        for (let i = 0; i < n; i++)
            wNew[i] = w[i] + lr * grad[i];
        const wProj = projectSimplex(wNew);
        let maxDelta = 0;
        for (let i = 0; i < n; i++)
            maxDelta = Math.max(maxDelta, Math.abs(wProj[i] - w[i]));
        w = wProj;
        if (maxDelta < tol)
            break;
        if (iter > 0 && iter % 1000 === 0)
            lr *= 0.75;
    }
    const vol = portfolioVol(cov, w);
    const ret = portfolioReturn(w, mu);
    const sharpe = vol > 0 ? (ret - rf) / vol : 0;
    return { w, sharpe, vol, ret };
}
export function solveMaxSharpe(assetKeys, postTaxReturns) {
    const { n, cov } = _prepareCovarianceMatrixAndValidate(assetKeys, postTaxReturns);
    const mu = Float64Array.from(postTaxReturns);
    const rf = RISK_FREE_RATE;
    const excessMu = new Float64Array(n);
    for (let i = 0; i < n; i++)
        excessMu[i] = mu[i] - rf;
    const anyPositive = excessMu.some((e) => e > 0);
    if (!anyPositive) {
        return solveMinVariance(assetKeys, postTaxReturns);
    }
    const candidates = [];
    let wExcess = new Float64Array(n);
    let sumW = 0;
    for (let i = 0; i < n; i++) {
        wExcess[i] = Math.max(excessMu[i], 0);
        sumW += wExcess[i];
    }
    if (sumW > 0) {
        for (let i = 0; i < n; i++)
            wExcess[i] /= sumW;
    }
    else {
        wExcess.fill(1 / n);
    }
    candidates.push(_runMaxSharpePGD(cov, mu, rf, wExcess));
    const wEqual = new Float64Array(n).fill(1 / n);
    candidates.push(_runMaxSharpePGD(cov, mu, rf, wEqual));
    const wRand = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        wRand[i] = Math.abs(Math.sin(i + 1));
    }
    candidates.push(_runMaxSharpePGD(cov, mu, rf, projectSimplex(wRand)));
    let best = candidates[0];
    for (let i = 1; i < candidates.length; i++) {
        if (candidates[i].sharpe > best.sharpe) {
            best = candidates[i];
        }
    }
    const w = best.w;
    const vol = best.vol;
    const ret = best.ret;
    const sharpe = best.sharpe;
    return {
        weights: _weightsToMap(assetKeys, w),
        expectedReturn: _round6(ret),
        volatility: _round6(vol),
        sharpe: _round4(sharpe),
    };
}
export function solveRiskParity(assetKeys) {
    const n = assetKeys.length;
    if (n === 0)
        throw new Error('assetKeys must be non-empty');
    const { matrix: cov } = buildCovarianceMatrix(assetKeys);
    let w = new Float64Array(n).fill(1 / n);
    const maxIter = 5000;
    const tol = 1e-10;
    for (let iter = 0; iter < maxIter; iter++) {
        const sigmaW = matvec(cov, w);
        const portVol = Math.sqrt(Math.max(dot(w, sigmaW), 1e-18));
        const mrc = new Float64Array(n);
        for (let i = 0; i < n; i++)
            mrc[i] = sigmaW[i] / portVol;
        const wNew = new Float64Array(n);
        let sumW = 0;
        for (let i = 0; i < n; i++) {
            wNew[i] = mrc[i] > 1e-18 ? 1 / mrc[i] : 1;
            sumW += wNew[i];
        }
        for (let i = 0; i < n; i++)
            wNew[i] /= sumW;
        let maxDelta = 0;
        for (let i = 0; i < n; i++)
            maxDelta = Math.max(maxDelta, Math.abs(wNew[i] - w[i]));
        w = wNew;
        if (maxDelta < tol)
            break;
    }
    const sigmaW = matvec(cov, w);
    const finalVol = Math.sqrt(Math.max(dot(w, sigmaW), 1e-18));
    const riskContributions = {};
    for (let i = 0; i < n; i++) {
        const mrc_i = sigmaW[i] / finalVol;
        riskContributions[assetKeys[i]] = _round6(w[i] * mrc_i);
    }
    return {
        weights: _weightsToMap(assetKeys, w),
        riskContributions,
        volatility: _round6(finalVol),
    };
}
export function optimisePortfolio(assetKeys, postTaxReturns, strategy) {
    if (!Array.isArray(postTaxReturns) || postTaxReturns.length !== assetKeys.length
        || postTaxReturns.some(value => !Number.isFinite(value))) {
        throw new TypeError('An explicit finite nominal return is required for every asset');
    }
    switch (strategy) {
        case 'min_variance':
            return { strategy, ...solveMinVariance(assetKeys, postTaxReturns) };
        case 'max_sharpe':
            return { strategy, ...solveMaxSharpe(assetKeys, postTaxReturns) };
        case 'risk_parity': {
            const result = solveRiskParity(assetKeys);
            const expectedReturn = assetKeys.reduce((sum, key, index) => {
                const weight = result.weights[key];
                const assetReturn = postTaxReturns[index];
                return sum + weight * assetReturn;
            }, 0);
            const sharpe = result.volatility > 1e-12
                ? (expectedReturn - RISK_FREE_RATE) / result.volatility
                : 0;
            return {
                strategy,
                ...result,
                expectedReturn: _round6(expectedReturn),
                sharpe: _round4(sharpe),
            };
        }
        case 'max_return': {
            const highestIndex = postTaxReturns.reduce(
                (best, value, index, values) => value > values[best] ? index : best,
                0,
            );
            const weights = Object.fromEntries(assetKeys.map((key, index) => [key, index === highestIndex ? 1 : 0]));
            const metrics = evaluatePortfolio(assetKeys, postTaxReturns, weights);
            return { strategy, weights, ...metrics };
        }
        default:
            throw new Error(`Unknown optimisation strategy "${strategy}". ` +
                `Valid values: min_variance, max_sharpe, risk_parity, max_return`);
    }
}

/** Recomputes every reported metric from the final, user-visible weights. */
export function evaluatePortfolio(assetKeys, nominalReturns, weights) {
    if (!Array.isArray(assetKeys) || assetKeys.length === 0 || new Set(assetKeys).size !== assetKeys.length) {
        throw new TypeError('assetKeys must be a non-empty unique array');
    }
    if (!Array.isArray(nominalReturns) || nominalReturns.length !== assetKeys.length
        || nominalReturns.some(value => !Number.isFinite(value))) {
        throw new TypeError('A finite nominal return is required for every asset');
    }
    if (!weights || typeof weights !== 'object' || Array.isArray(weights)) {
        throw new TypeError('weights must be an explicit asset-weight map');
    }
    const vector = assetKeys.map(key => weights[key]);
    if (vector.some(value => !Number.isFinite(value) || value < 0 || value > 1)) {
        throw new TypeError('Every final portfolio weight must be a number from 0 to 1');
    }
    const total = vector.reduce((sum, value) => sum + value, 0);
    if (Math.abs(total - 1) > 0.001) throw new RangeError('Final portfolio weights must total 1');
    const { matrix: covariance } = buildCovarianceMatrix(assetKeys);
    const volatility = portfolioVol(covariance, vector);
    const expectedReturn = portfolioReturn(vector, nominalReturns);
    const sharpe = volatility > 1e-12 ? (expectedReturn - RISK_FREE_RATE) / volatility : 0;
    const covarianceTimesWeights = matvec(covariance, vector);
    const riskContributions = Object.fromEntries(assetKeys.map((key, index) => [
        key,
        _round6(volatility > 1e-12 ? vector[index] * covarianceTimesWeights[index] / volatility : 0),
    ]));
    return {
        expectedReturn: _round6(expectedReturn),
        volatility: _round6(volatility),
        sharpe: _round4(sharpe),
        riskContributions,
    };
}
function _weightsToMap(keys, w) {
    const n = keys.length;
    let temp = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        temp[i] = w[i] < 1e-4 ? 0 : w[i];
    }
    const MIN_ALLOCATION_FLOOR = 0.02; // 2% minimum allocation floor
    for (let iter = 0; iter < 10; iter++) {
        let sum = 0;
        for (let i = 0; i < n; i++) {
            if (temp[i] < MIN_ALLOCATION_FLOOR) {
                temp[i] = 0;
            }
            sum += temp[i];
        }
        if (sum <= 0) {
            let maxIdx = 0;
            let maxVal = -1;
            for (let i = 0; i < n; i++) {
                if (w[i] > maxVal) {
                    maxVal = w[i];
                    maxIdx = i;
                }
            }
            temp = new Float64Array(n);
            temp[maxIdx] = 1.0;
            break;
        }
        let belowFloor = false;
        for (let i = 0; i < n; i++) {
            if (temp[i] > 0) {
                temp[i] /= sum;
                if (temp[i] < MIN_ALLOCATION_FLOOR) {
                    belowFloor = true;
                }
            }
        }
        if (!belowFloor) {
            break;
        }
    }
    const map = {};
    for (let i = 0; i < n; i++) {
        map[keys[i]] = _round6((map[keys[i]] || 0) + temp[i]);
    }
    return map;
}
function _round6(x) { return Math.round(x * 1e6) / 1e6; }
function _round4(x) { return Math.round(x * 1e4) / 1e4; }
const CANONICAL_MAP = {
    'ppf': 'PPF',
    'fd': 'FD',
    'debt_mf': 'Debt_MF',
    'nps': 'NPS',
    'hybrid_mf': 'Hybrid_MF',
    'index_mf': 'Index_MF',
    'gold_etf': 'Gold',
    'gold': 'Gold',
    'gold_physical': 'Gold',
    'goldphysical': 'Gold',
    'elss': 'ELSS',
    'nifty_etf': 'ETF',
    'etf': 'ETF',
    'midcap_mf': 'Midcap_MF',
    'smallcap_mf': 'Smallcap_MF',
    'liquid_mf': 'Liquid_MF',
    'sgb': 'SGB',
    'scss': 'SCSS',
    'ssy': 'SSY',
    'equity_mf': 'Equity_MF',
    'g-sec': 'G-Sec',
    'rbi_retail_direct_gilt': 'G-Sec',
    'rbi_bond': 'RBI_Bond',
    'rbi_bonds': 'RBI_Bond',
    'balanced_advantage': 'Hybrid_MF',
    'balancedadvantage': 'Hybrid_MF',
    'balanced_fund': 'Hybrid_MF',
    'arbitrage_mf': 'Arbitrage_MF',
};
export function resolveAssetKey(key) {
    const norm = key.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (CANONICAL_MAP[norm])
        return CANONICAL_MAP[norm];
    const match = Object.keys(INSTRUMENT_PARAMS).find(k => k.toLowerCase() === key.toLowerCase());
    return match || key;
}
const RISK_SCORE_MAP = {
    'Very Low': 5, 'Low': 20, 'Low-Medium': 30, 'Medium-Low': 35, 'Medium': 50, 'High': 80, 'Very High': 95
};
function getTransactionCostRate(key, isSell, holdingMonths = 24) {
    if (['Equity_MF', 'Index_MF', 'Midcap_MF', 'Smallcap_MF', 'Hybrid_MF', 'Balanced_Advantage'].includes(key)) {
        if (isSell) {
            const STT = 0.001;
            const STAMP_DUTY = 0.00005;
            const exitLoad = holdingMonths < 12 ? 0.01 : 0;
            return STT + STAMP_DUTY + exitLoad;
        }
        return 0.00005;
    }
    if (key === 'ELSS') {
        if (isSell) {
            const STT = 0.001;
            return STT;
        }
        return 0.00005;
    }
    if (['ETF', 'Gold_ETF', 'Gold', 'Arbitrage_MF'].includes(key)) {
        const brokerage = 0.0005;
        if (isSell) {
            const STT = 0.001;
            const exitLoad = (key === 'Arbitrage_MF' && holdingMonths < 1) ? 0.0025 : 0;
            return STT + brokerage + exitLoad;
        }
        return 0.00005 + brokerage;
    }
    if (['Debt_MF', 'Liquid_MF'].includes(key)) {
        if (isSell) {
            if (key === 'Liquid_MF') {
                return holdingMonths < 1 ? 0.005 : 0;
            }
            const exitLoad = holdingMonths < 12 ? 0.005 : 0;
            return exitLoad;
        }
        return 0.00005;
    }
    if (['Gold_Physical'].includes(key)) {
        return isSell ? 0.005 : 0.03;
    }
    if (['FD', 'SCSS'].includes(key)) {
        if (isSell && holdingMonths < 12)
            return 0.01;
        return isSell ? 0.005 : 0.0;
    }
    return 0.0;
}
export function computeRebalance(currentAllocation, targetAllocation, threshold, partialRatio, holdingMonths) {
    if (!currentAllocation || typeof currentAllocation !== 'object' || Array.isArray(currentAllocation)
        || !targetAllocation || typeof targetAllocation !== 'object' || Array.isArray(targetAllocation)) {
        throw new TypeError('currentAllocation and targetAllocation must be explicit objects');
    }
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 50
        || !Number.isFinite(partialRatio) || partialRatio < 0.1 || partialRatio > 1
        || !Number.isFinite(holdingMonths) || holdingMonths < 0 || holdingMonths > 600) {
        throw new RangeError('threshold, partialRatio, and holdingMonths must be explicit and within supported ranges');
    }
    const resolvedCurrent = {};
    let totalValue = 0;
    for (const [k, v] of Object.entries(currentAllocation || {})) {
        if (!Number.isFinite(v) || v < 0) throw new TypeError(`Invalid current allocation for ${k}`);
        const val = v;
        const resolved = resolveAssetKey(k);
        if (!INSTRUMENT_PARAMS[resolved]) throw new Error(`Unknown current allocation instrument "${k}"`);
        resolvedCurrent[resolved] = (resolvedCurrent[resolved] || 0) + val;
        totalValue += val;
    }
    if (totalValue <= 0) {
        throw new RangeError('currentAllocation total must be greater than zero');
    }
    const targetVals = Object.values(targetAllocation);
    if (!targetVals.length || targetVals.some(value => !Number.isFinite(value) || value < 0 || value > 100)) {
        throw new TypeError('Every target allocation must be an explicit percentage from 0 to 100');
    }
    const targetSum = targetVals.reduce((s, v) => s + v, 0);
    if (Math.abs(targetSum - 100) > REBALANCE_TARGET_TOTAL_TOLERANCE_PERCENT) throw new RangeError('targetAllocation must sum to exactly 100');
    const normalizedTargetWeights = normalizeAllocationWeights(targetVals.map(value => value / 100));
    const resolvedTarget = {};
    const targetEntries = Object.entries(targetAllocation);
    for (let index = 0; index < targetEntries.length; index += 1) {
        const [k] = targetEntries[index];
        const resolved = resolveAssetKey(k);
        if (!INSTRUMENT_PARAMS[resolved]) throw new Error(`Unknown target allocation instrument "${k}"`);
        const val = normalizedTargetWeights[index] * 100;
        resolvedTarget[resolved] = (resolvedTarget[resolved] || 0) + val;
    }
    const allKeys = Array.from(new Set([
        ...Object.keys(resolvedCurrent),
        ...Object.keys(resolvedTarget),
    ]));
    const assets = [];
    let sumDiff = 0;
    let beforeWeightedCAGR = 0;
    let afterWeightedCAGR = 0;
    let beforeWeightedRisk = 0;
    let afterWeightedRisk = 0;
    let totalEstimatedTransactionCost = 0;
    for (const key of allKeys) {
        const currentVal = resolvedCurrent[key] || 0;
        const targetPct = resolvedTarget[key] || 0;
        const currentPct = (currentVal / totalValue) * 100;
        const driftPct = currentPct - targetPct;
        const targetVal = (targetPct / 100) * totalValue;
        const rawCorrection = targetVal - currentVal;
        const suggestedCorrection = rawCorrection * partialRatio;
        const driftExceedsThreshold = Math.abs(driftPct) >= threshold;
        sumDiff += Math.abs(driftPct);
        const params = INSTRUMENT_PARAMS[key];
        if (!params) throw new Error(`No instrument parameters established for "${key}"`);
        const nominalRate = params.nominalRate;
        const riskLevel = params.riskLevel;
        const riskWeight = RISK_SCORE_MAP[riskLevel];
        if (!Number.isFinite(riskWeight)) throw new Error(`No risk score established for "${key}"`);
        beforeWeightedCAGR += (currentPct / 100) * nominalRate;
        afterWeightedCAGR += (targetPct / 100) * nominalRate;
        beforeWeightedRisk += (currentPct / 100) * riskWeight;
        afterWeightedRisk += (targetPct / 100) * riskWeight;
        const isSell = rawCorrection < 0;
        const absCorrection = Math.abs(rawCorrection);
        const txCostRate = getTransactionCostRate(key, isSell, holdingMonths);
        const estimatedTxCost = absCorrection * txCostRate;
        totalEstimatedTransactionCost += estimatedTxCost;
        assets.push({
            asset_class: key,
            name: params.name,
            risk_level: riskLevel,
            nominal_return: nominalRate,
            current_value: _round4(currentVal),
            current_pct: _round4(currentPct),
            target_pct: _round4(targetPct),
            target_value: _round4(targetVal),
            drift_pct: _round4(driftPct),
            raw_correction: _round4(rawCorrection),
            suggested_correction: _round4(suggestedCorrection),
            action_type: Math.abs(rawCorrection) < 1.0 ? 'hold' : rawCorrection > 0 ? 'buy' : 'sell',
            rebalance_recommended: driftExceedsThreshold,
            estimated_transaction_cost: _round4(estimatedTxCost),
            transaction_cost_rate: txCostRate,
        });
    }
    const driftIndex = sumDiff / 2;
    const driftSeverity = driftIndex > 12 ? 'High' : driftIndex > 5 ? 'Moderate' : 'Low';
    const rebalanceRecommended = assets.some(a => a.rebalance_recommended);
    let portfolioTrackingError = 0;
    try {
        const { matrix: covActive } = buildCovarianceMatrix(allKeys);
        const wDiff = new Float64Array(allKeys.length);
        for (let i = 0; i < allKeys.length; i++) {
            const key = allKeys[i];
            const currentPct = (resolvedCurrent[key] || 0) / totalValue;
            const targetPct = (resolvedTarget[key] || 0) / 100;
            wDiff[i] = currentPct - targetPct;
        }
        const diffVar = portfolioVariance(covActive, wDiff);
        portfolioTrackingError = Math.sqrt(Math.max(0, diffVar));
    }
    catch (e) {
        console.error('[portfolioEngine] Tracking error calculation failed:', e);
    }
    return {
        total_portfolio_value: _round4(totalValue),
        drift_index: _round4(driftIndex),
        drift_severity: driftSeverity,
        rebalance_recommended: rebalanceRecommended,
        total_estimated_transaction_cost: _round4(totalEstimatedTransactionCost),
        portfolio_tracking_error: _round6(portfolioTrackingError),
        before_stats: {
            cagr: _round4(beforeWeightedCAGR),
            risk_score: _round4(beforeWeightedRisk),
        },
        after_stats: {
            cagr: _round4(afterWeightedCAGR),
            risk_score: _round4(afterWeightedRisk),
        },
        assets: assets.sort((a, b) => b.drift_pct - a.drift_pct),
    };
}
