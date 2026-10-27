/**
 * WealthGenie Projection Model Assumptions — Single Source of Truth
 *
 * These values are frozen policy assumptions used only for model-based projections,
 * recommendation scoring and simulation. They are not observed market facts,
 * provider forecasts, official product rates, or promises of future performance.
 *
 * DO NOT duplicate these values in any other file.
 *
 * =========================================================================
 * 📘 BEGINNER NOTE: NOMINAL RATE vs. REAL RATE & VOLATILITY
 * =========================================================================
 * 1. Nominal Rate (nominalRate): A versioned WealthGenie model-policy input used
 *    for scenarios before inflation or taxes. It is not a live product rate,
 *    historical return, provider forecast, or promise of future performance.
 *    To get the "Real Rate" (purchasing power growth), you subtract the inflation rate 
 *    (e.g., if inflation is 5%, the real return is roughly 6.5% - 5% = 1.5%).
 * 
 * 2. Volatility (volatility): A measure of how much the price of an asset fluctuates 
 *    up and down over a year. We represent it as a decimal (e.g., 0.18 means 18% volatility).
 *    - Low volatility (e.g. FDs, PPF at 0.005 / 0.5%): Growth is a steady, straight line.
 *    - High volatility (e.g. Smallcap MFs at 0.28 / 28%): High highs and low lows; the path
 *      resembles a jagged mountain range. This is modeled stochastically in our Monte Carlo simulator.
 */

import { canonicalSha256 } from '../utils/canonicalJson.js';
import { readFileSync } from 'node:fs';

export const CESS_RATE = 0.04;
export const PROJECTION_ASSUMPTION_VERSION = 'wealthgenie-projection-assumptions-1.1.6';
export const PROJECTION_ASSUMPTION_SOURCE = 'WEALTHGENIE_MODEL_POLICY';
export const PROJECTION_ASSUMPTION_DATA_CLASS = 'MODEL_ASSUMPTION';

// The recommendation pipeline ranks using each catalog instrument's expected
// return, not only the category-level projection table below. Bind those exact
// values into the same policy identity so ranking inputs cannot drift while
// continuing to claim the old assumption hash. These are model assumptions;
// catalog source labels are not provider authority for recommendation scoring.
const assumptionCatalog = JSON.parse(readFileSync(
  new URL('../data/investment_master.json', import.meta.url),
  'utf8',
));
const catalogReturnAssumptions = assumptionCatalog.instruments
  .map(instrument => {
    const expectedReturn = instrument.dynamicData?.expectedReturn;
    if (expectedReturn?.dataClass === 'UNAVAILABLE'
      && ['min', 'avg', 'max'].every(key => expectedReturn[key] === null)) return null;
    if (!instrument.id || !['min', 'avg', 'max'].every(key => Number.isFinite(expectedReturn?.[key]))) {
      throw new Error(`Recommendation return assumption is incomplete for catalog instrument ${instrument.id || '(missing id)'}.`);
    }
    return {
      instrumentId: instrument.id,
      min: expectedReturn.min,
      average: expectedReturn.avg,
      max: expectedReturn.max,
    };
  })
  .filter(Boolean)
  .sort((left, right) => left.instrumentId.localeCompare(right.instrumentId));

if (new Set(catalogReturnAssumptions.map(item => item.instrumentId)).size !== catalogReturnAssumptions.length) {
  throw new Error('Recommendation return assumption catalog contains duplicate instrument IDs.');
}

// MODEL NOTE: nominalRate and expenseRatio are frozen academic policy assumptions.
// They are not source-established current product facts and must never be labelled as such.
const rawModelAssumptions = {
  // Versioned scenario inputs. Any future recalibration requires a new assumption
  // version and regression evidence; provider observations must never mutate them.
  FD:           { nominalRate: 7.5,   volatility: 0.005,  expenseRatio: 0.0,    riskLevel: 'Low',        lockIn: 0,  name: 'Bank Fixed Deposit',       tags: ['Model Assumption', 'Verify Bank Terms'] },
  ELSS:         { nominalRate: 14.4,  volatility: 0.18,   expenseRatio: 0.015,  riskLevel: 'High',       lockIn: 3,  name: 'ELSS Mutual Fund',         tags: ['Tax Saving', '80C'] },
  Equity_MF:    { nominalRate: 15.0,  volatility: 0.18,   expenseRatio: 0.015,  riskLevel: 'High',       lockIn: 0,  name: 'Equity Mutual Fund',       tags: ['Wealth Growth'] },
  ETF:          { nominalRate: 14.5,  volatility: 0.16,   expenseRatio: 0.001,  riskLevel: 'Medium',     lockIn: 0,  name: 'Nifty 50 ETF',             tags: ['Passive', 'Low Cost'] },
  Debt_MF:      { nominalRate: 7.7,   volatility: 0.03,   expenseRatio: 0.008,  riskLevel: 'Low-Medium', lockIn: 0,  name: 'Debt Mutual Fund',         tags: ['Liquid'] },
  RBI_Bond:     { nominalRate: 7.5,   volatility: 0.002,  expenseRatio: 0.0,    riskLevel: 'Very Low',   lockIn: 7,  name: 'RBI Savings Bond',         tags: ['Sovereign'] },
  'G-Sec':      { nominalRate: 7.3,   volatility: 0.01,   expenseRatio: 0.0,    riskLevel: 'Very Low',   lockIn: 0,  name: 'Government Security',      tags: ['Sovereign', 'Gilt'] },
  PPF:          { nominalRate: 7.1,   volatility: 0.003,  expenseRatio: 0.0,    riskLevel: 'Very Low',   lockIn: 15, name: 'Public Provident Fund',    tags: ['EEE', 'Tax Free', '80C'] },
  NPS:          { nominalRate: 10.1,  volatility: 0.12,   expenseRatio: 0.0001, riskLevel: 'Medium',     lockIn: 60, name: 'National Pension System',  tags: ['Retirement', '80CCD'] },
  Gold:         { nominalRate: 11.3,  volatility: 0.15,   expenseRatio: 0.005,  riskLevel: 'Medium',     lockIn: 0,  name: 'Gold (Commodity)',          assetClass: 'Commodity', tags: ['Hedge', 'Inflation'] },
  SGB:          { nominalRate: 13.0,  volatility: 0.14,   expenseRatio: 0.0,    riskLevel: 'Low-Medium', lockIn: 8,  name: 'Sovereign Gold Bond',      tags: ['Gold', 'Conditional Maturity Tax Treatment'] },
  Liquid_MF:    { nominalRate: 6.8,   volatility: 0.005,  expenseRatio: 0.0025, riskLevel: 'Low',        lockIn: 0,  name: 'Liquid Mutual Fund',       tags: ['Emergency Fund', 'T+1'] },
  Arbitrage_MF: { nominalRate: 7.5,   volatility: 0.02,   expenseRatio: 0.0035, riskLevel: 'Low',        lockIn: 0,  name: 'Arbitrage Mutual Fund',    tags: ['Low Volatility', 'Equity Taxed'] },
  Hybrid_MF:    { nominalRate: 11.8,  volatility: 0.10,   expenseRatio: 0.012,  riskLevel: 'Medium',     lockIn: 0,  name: 'Balanced Advantage Fund',  tags: ['Hybrid', 'Dynamic'] },
  Index_MF:     { nominalRate: 14.2,  volatility: 0.16,   expenseRatio: 0.002,  riskLevel: 'Medium',     lockIn: 0,  name: 'Nifty 50 Index Fund',      tags: ['Passive', 'Low Cost'] },
  Midcap_MF:    { nominalRate: 17.5,  volatility: 0.22,   expenseRatio: 0.015,  riskLevel: 'High',       lockIn: 0,  name: 'Mid-Cap Mutual Fund',      tags: ['High Growth'] },
  Smallcap_MF:  { nominalRate: 21.0,  volatility: 0.28,   expenseRatio: 0.015,  riskLevel: 'Very High',  lockIn: 0,  name: 'Small-Cap Mutual Fund',    tags: ['Highest Risk'] },
  SCSS:         { nominalRate: 8.2,   volatility: 0.002,  expenseRatio: 0.0,    riskLevel: 'Very Low',   lockIn: 5,  name: 'Senior Citizens Savings',  tags: ['Sovereign', 'Senior'] },
  SSY:          { nominalRate: 8.2,   volatility: 0.002,  expenseRatio: 0.0,    riskLevel: 'Very Low',   lockIn: 21, name: 'Sukanya Samriddhi',        tags: ['EEE', 'Girl Child'] },
};

// This hash is deliberately derived from the committed policy inputs. A
// change to any model value changes the hash and therefore requires an
// explicit review/version decision instead of silently retaining the same
// assumption identity.
export const PROJECTION_ASSUMPTION_POLICY_HASH = canonicalSha256({
  version: PROJECTION_ASSUMPTION_VERSION,
  source: PROJECTION_ASSUMPTION_SOURCE,
  inputs: {
    projection: rawModelAssumptions,
    recommendationCatalogReturns: {
      catalogVersion: assumptionCatalog.catalogVersion,
      instruments: catalogReturnAssumptions,
    },
  },
});

// This is a committed policy manifest, not a value generated by the test
// suite.  Changing any projection input therefore requires an explicit
// assumption-policy version/hash review instead of silently changing the
// financial model under the existing identity.
export const PROJECTION_ASSUMPTION_POLICY_MANIFEST = Object.freeze({
  version: PROJECTION_ASSUMPTION_VERSION,
  source: PROJECTION_ASSUMPTION_SOURCE,
  dataClass: PROJECTION_ASSUMPTION_DATA_CLASS,
  expectedHash: 'ec0c527f383439030e924a1dc12a7f4d53247fc65def2236308ffb839e2da448',
});

if (PROJECTION_ASSUMPTION_POLICY_HASH !== PROJECTION_ASSUMPTION_POLICY_MANIFEST.expectedHash) {
  throw new Error('Projection assumption inputs changed without updating the committed policy manifest/version.');
}

export const INSTRUMENT_PARAMS = Object.freeze(Object.fromEntries(
  Object.entries(rawModelAssumptions).map(([key, value]) => [key, Object.freeze({
    ...value,
    dataClass: PROJECTION_ASSUMPTION_DATA_CLASS,
    assumptionVersion: PROJECTION_ASSUMPTION_VERSION,
    assumptionHash: PROJECTION_ASSUMPTION_POLICY_HASH,
    source: PROJECTION_ASSUMPTION_SOURCE,
    observedMarketFact: false,
    providerForecast: false,
  })]),
));

/**
 * Get nominal rate for an instrument key (as percentage, e.g. 12.5).
 * Unknown instruments fail closed; callers must establish a catalog mapping.
 */
export function getNominalRate(key) {
  return INSTRUMENT_PARAMS[key]?.nominalRate ?? null;
}

/**
 * Get volatility for an instrument key (as decimal, e.g. 0.18).
 * Unknown instruments fail closed; callers must establish a catalog mapping.
 */
export function getVolatility(key) {
  return INSTRUMENT_PARAMS[key]?.volatility ?? null;
}

/**
 * Build a RATE_LOOKUP map {key: rate} for projection engine compatibility.
 */
export function buildRateLookup() {
  const lookup = {};
  for (const [key, params] of Object.entries(INSTRUMENT_PARAMS)) {
    lookup[key] = params.nominalRate;
  }
  return lookup;
}

/** Versioned policy benchmark used only by model scoring; not an observed risk-free product rate. */
export const RISK_FREE_RATE = 0.05;

/** SEBI disclaimer */
export const DISCLAIMER = 'WealthGenie provides AI-generated investment analysis for educational and informational purposes only. It does not constitute registered investment advice under SEBI (Investment Advisers) Regulations, 2013. Past returns are not indicative of future performance. Please consult a SEBI-registered investment adviser before making investment decisions. Mutual fund investments are subject to market risks.';

/**
 * Convert annual return rate (decimal) to monthly rate.
 *
 * BEGINNER NOTE: SIMPLE vs CONTINUOUS COMPOUNDING
 * 1. Simple Compounding (continuous = false): We divide the annual rate by 12 (e.g. 12% annual / 12 = 1% monthly).
 *    This assumes interest is only added at the end of each period.
 * 2. Continuous Compounding (continuous = true): Uses the exponential formula `exp(annualRate / 12) - 1`.
 *    This assumes interest is constantly compounding at every infinitesimal split second, which is standard
 *    in log-normal stock models (like Geometric Brownian Motion used in our Monte Carlo simulator).
 *
 * @param {number} annualRate - Annual rate as a decimal (e.g. 0.12)
 * @param {boolean} [continuous=false] - If true, use exp(rate/12)-1, else rate/12
 * @returns {number} Monthly rate
 */
export function toMonthlyRate(annualRate, continuous = false) {
  if (!Number.isFinite(annualRate)) throw new TypeError('annualRate must be finite');
  return continuous ? Math.exp(annualRate / 12) - 1 : annualRate / 12;
}
