import { describe, expect, it } from 'vitest';
import {
  isProjectionResponseValid,
  isTaxResponseValid,
  TAX_UNAVAILABLE_NUMERIC_FIELDS,
} from '../deepdive/financialResponseIntegrity';

const assumptions = {
  monthlyInvestment: 1000,
  annualReturnRate: 0,
  benchmarkRate: 0,
  inflationRate: 0,
  years: 1,
};

const projection = {
  calculation_classification: 'NON_RECOMMENDATION_PROJECTION_COMPARISON',
  return_basis: 'PRE_TAX_NOMINAL_WITH_EXPLICIT_INFLATION_VIEW',
  return_data_class: 'USER_INPUT',
  return_assumption_source: 'USER_SUPPLIED_WHAT_IF',
  observed_market_fact: false,
  provider_forecast: false,
  assumptions,
  totalInvested: 12000,
  investmentMaturity: 12000,
  investmentReal: 12000,
  benchmarkMaturity: 12000,
  benchmarkReal: 12000,
  estimatedReturns: 0,
  opportunityCost: 0,
  purchasingPowerLost: 0,
  benchmarkRealAnnualRate: 0,
  inflationHalfLifeYears: null,
  yearlyBreakdown: [{
    year: 1,
    invested: 12000,
    investmentNominal: 12000,
    investmentReal: 12000,
    benchmarkNominal: 12000,
    benchmarkReal: 12000,
    gains: 0,
  }],
  normalizedChart: [{ year: 'Year 1', investment: 100, benchmark: 100, inflation: 100 }],
};

const taxInputs = {
  instrumentType: 'Equity_MF',
  nominalRate: 0.1,
  annualIncome: 0,
  holdingYears: 15,
  regime: 'new',
  monthlySIP: 5000,
  userAge: 35,
  incomeSource: 'salary',
  fiscalYear: 'FY2026-27',
  section112AExemptionUsed: null,
};

const unavailableTax = {
  status: 'REQUIRES_TAX_INPUTS',
  calculation_classification: 'SEPARATE_TAX_WHAT_IF',
  calculationClass: 'MODELLED_POST_TAX_PROJECTION',
  dataClass: 'MODEL_ASSUMPTION',
  fiscalYear: 'FY2026-27',
  policyVersion: 'tax-policy-test-v1',
  what_if_principal: 100000,
  unavailableReasons: ['section112AExemptionUsed'],
  inputsUsed: { ...taxInputs },
  grossGain: null,
  taxableGain: null,
  postTaxReturn: null,
  effectiveYield: null,
  taxRate: null,
  incrementalTax: null,
  what_if_nominal_gain: null,
  what_if_estimated_tax: null,
  what_if_net_gain: null,
};

describe('financial response integrity', () => {
  it('accepts an explicit zero-valued projection while rejecting missing and mismatched results', () => {
    expect(isProjectionResponseValid(projection, assumptions)).toBe(true);
    expect(isProjectionResponseValid({ ...projection, investmentMaturity: null }, assumptions)).toBe(false);
    expect(isProjectionResponseValid(projection, { ...assumptions, monthlyInvestment: 2000 })).toBe(false);
    expect(isProjectionResponseValid({ ...projection, assumptions: { ...assumptions, years: '1' } }, assumptions)).toBe(false);
    expect(isProjectionResponseValid({ ...projection, yearlyBreakdown: [] }, assumptions)).toBe(false);
  });

  it('requires tax what-if unavailable metrics to remain explicit nulls', () => {
    expect(isTaxResponseValid(unavailableTax, taxInputs)).toBe(true);
    for (const field of TAX_UNAVAILABLE_NUMERIC_FIELDS) {
      expect(isTaxResponseValid({ ...unavailableTax, [field]: 0 }, taxInputs), field).toBe(false);
      expect(isTaxResponseValid({ ...unavailableTax, [field]: undefined }, taxInputs), field).toBe(false);
    }
  });

  it('rejects an unavailable-to-zero Section 112A substitution and accepts an explicit zero echo', () => {
    const explicitZeroInputs = { ...taxInputs, section112AExemptionUsed: 0 };
    const explicitZeroResponse = {
      ...unavailableTax,
      status: 'CALCULATED',
      unavailableReasons: [],
      inputsUsed: { ...unavailableTax.inputsUsed, section112AExemptionUsed: 0 },
      postTaxReturn: 0.05,
      effectiveYield: 5,
      taxRate: 0.5,
      grossGain: 5000,
      taxableGain: 5000,
      incrementalTax: 5000,
      what_if_nominal_gain: 10000,
      what_if_estimated_tax: 5000,
      what_if_net_gain: 5000,
    };
    expect(isTaxResponseValid(explicitZeroResponse, explicitZeroInputs)).toBe(true);
    expect(isTaxResponseValid(explicitZeroResponse, taxInputs)).toBe(false);
    expect(isTaxResponseValid({
      ...explicitZeroResponse,
      effectiveYield: 0,
    }, explicitZeroInputs)).toBe(false);
  });
});
