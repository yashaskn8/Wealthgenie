import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import api from '../../services/api';
import CalculatorTab from '../deepdive/CalculatorTab';
import TaxTab from '../deepdive/TaxTab';

vi.mock('../../services/api', () => ({
  default: {
    getTaxPolicyMetadata: vi.fn(),
    computePostTaxReturn: vi.fn(),
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function makeProjection() {
  const assumptions = {
    monthlyInvestment: 1000,
    annualReturnRate: 0,
    benchmarkRate: 0,
    inflationRate: 0,
    years: 1,
  };
  return {
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
}

function makeTaxResponse(args, status, reasons) {
  const [instrumentType, nominalRate, annualIncome, holdingYears, regime, monthlySIP, userAge, incomeSource, fiscalYear, options] = args;
  const section112AExemptionUsed = options?.body?.section112AExemptionUsed ?? null;
  const inputsUsed = {
    instrumentType, nominalRate, annualIncome, holdingYears, regime, monthlySIP,
    userAge, incomeSource, fiscalYear, section112AExemptionUsed,
  };
  const base = {
    status,
    calculation_classification: 'SEPARATE_TAX_WHAT_IF',
    calculationClass: 'MODELLED_POST_TAX_PROJECTION',
    dataClass: 'MODEL_ASSUMPTION',
    fiscalYear,
    policyVersion: 'tax-policy-test-v1',
    what_if_principal: 100000,
    unavailableReasons: reasons,
    inputsUsed,
  };
  if (status !== 'CALCULATED') {
    return {
      ...base,
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
  }
  const nominalGain = Math.round(100000 * nominalRate);
  const netGain = Math.round(100000 * 0.05);
  return {
    ...base,
    grossGain: 5000,
    taxableGain: 5000,
    postTaxReturn: 0.05,
    effectiveYield: 5,
    taxRate: 0.5,
    incrementalTax: 5000,
    what_if_nominal_gain: nominalGain,
    what_if_estimated_tax: nominalGain - netGain,
    what_if_net_gain: netGain,
  };
}

const taxProps = {
  inv: { id: 'equity-1', type: 'Equity_MF', name: 'Test Equity', nominalReturn: 10 },
  calcAmount: 5000,
  calcYears: 15,
  userProfile: { age: 35, profileId: 'profile-1', version: 2 },
  profileStateKey: 'profile-state-2',
  recommendationMeta: { recommendationId: 'recommendation-3', profile_version: 2 },
};

function configureTaxMetadata() {
  api.getTaxPolicyMetadata.mockResolvedValue({
    currentFiscalYear: 'FY2026-27',
    currentFiscalYearVerified: true,
    verifiedFiscalYears: ['FY2025-26', 'FY2026-27'],
    policyVersion: 'tax-policy-test-v1',
  });
}

it('keeps a real zero projection valid but blocks null, pending, and assumption-mismatched exports', () => {
  const props = {
    inv: { id: 'test', name: 'Test Investment', category: 'Test' },
    calcAmount: 1000,
    calcYears: 1,
    calcReturn: 0,
    calcBounds: { returnBoundsBasis: 'GENERIC_WHAT_IF', returnMin: 0, returnMax: 15, yearMin: 1, yearMax: 50, yearBoundsBasis: 'GENERIC_WHAT_IF' },
    inflationRate: 0,
    benchmarkRate: 0,
    projectionAssumptions: { monthlyInvestment: 1000, annualReturnRate: 0, benchmarkRate: 0, inflationRate: 0, years: 1 },
    setCalcAmount: vi.fn(),
    setCalcYears: vi.fn(),
    setCalcReturn: vi.fn(),
    setInflationRate: vi.fn(),
    projection: makeProjection(),
    projectionError: null,
    projectionLoading: false,
  };
  const view = render(<CalculatorTab {...props} />);
  expect(screen.getByRole('button', { name: /save goal report/i })).toBeEnabled();
  expect(screen.getByRole('button', { name: /copy summary/i })).toBeEnabled();
  expect(screen.getAllByText('₹12,000').length).toBeGreaterThan(0);

  view.rerender(<CalculatorTab {...props} projection={{ ...makeProjection(), investmentMaturity: null }} />);
  expect(screen.getByRole('button', { name: /save goal report/i })).toBeDisabled();
  expect(screen.getByRole('button', { name: /copy summary/i })).toBeDisabled();

  view.rerender(<CalculatorTab {...props} projection={makeProjection()} projectionLoading />);
  expect(screen.getByRole('button', { name: /save goal report/i })).toBeDisabled();

  view.rerender(<CalculatorTab {...props} projection={{ ...makeProjection(), assumptions: { ...props.projectionAssumptions, annualReturnRate: 0.04 } }} />);
  expect(screen.getByRole('button', { name: /copy summary/i })).toBeDisabled();
});

it('asks for explicit Section 112A prior use and sends entered zero, while unavailable metrics stay hidden', async () => {
  configureTaxMetadata();
  api.computePostTaxReturn.mockImplementation(async (...args) => (
    args[9]?.body?.section112AExemptionUsed === 0
      ? makeTaxResponse(args, 'CALCULATED', [])
      : makeTaxResponse(args, 'REQUIRES_TAX_INPUTS', ['section112AExemptionUsed'])
  ));

  render(<TaxTab {...taxProps} />);
  fireEvent.change(screen.getByLabelText(/gross annual income/i), { target: { value: '0' } });
  fireEvent.change(screen.getByLabelText(/income source/i), { target: { value: 'salary' } });
  expect(screen.getByText('New tax regime only')).toBeVisible();
  fireEvent.change(screen.getByLabelText(/Your age on March 31/i), { target: { value: '35' } });

  await screen.findByText(/Enter how much of the Section 112A exemption you used earlier/i);
  expect(screen.queryByText(/0\.00%/)).toBeNull();
  expect(screen.getByLabelText(/Section 112A exemption already used/i)).toBeVisible();

  fireEvent.change(screen.getByLabelText(/Section 112A exemption already used/i), { target: { value: '0' } });
  await screen.findByText(/Net growth on fixed principal/i);
  await waitFor(() => expect(screen.getByText('₹5,000 (5.00% modelled net)')).toBeVisible());
  expect(api.computePostTaxReturn.mock.calls.at(-1)[9].body).toEqual({ section112AExemptionUsed: 0 });
});

it('requires an explicitly entered age for the selected fiscal year and clears it when that year changes', async () => {
  configureTaxMetadata();
  api.computePostTaxReturn.mockImplementation(async (...args) => makeTaxResponse(args, 'CALCULATED', []));
  render(<TaxTab {...taxProps} />);

  const income = screen.getByLabelText(/gross annual income/i);
  const age = screen.getByLabelText(/Your age on March 31/i);
  const fiscalYear = screen.getByLabelText('Fiscal year');
  expect(age).toHaveValue(null);

  fireEvent.change(income, { target: { value: '1000000' } });
  fireEvent.change(screen.getByLabelText(/income source/i), { target: { value: 'salary' } });
  expect(screen.getByText('New tax regime only')).toBeVisible();
  expect(api.computePostTaxReturn).not.toHaveBeenCalled();

  fireEvent.change(age, { target: { value: '65' } });
  await waitFor(() => expect(api.computePostTaxReturn).toHaveBeenCalledTimes(1));
  fireEvent.change(fiscalYear, { target: { value: 'FY2025-26' } });
  expect(age).toHaveValue(null);
  expect(screen.queryByText('₹5,000 (5.00% modelled net)')).toBeNull();
  expect(api.computePostTaxReturn).toHaveBeenCalledTimes(1);

  fireEvent.change(age, { target: { value: '64' } });
  await waitFor(() => expect(api.computePostTaxReturn).toHaveBeenCalledTimes(2));
  expect(api.computePostTaxReturn.mock.calls.at(-1)[6]).toBe(64);
  expect(api.computePostTaxReturn.mock.calls.at(-1)[8]).toBe('FY2025-26');
});
it('hides a prior result immediately when the selected tax income changes', async () => {
  configureTaxMetadata();
  api.computePostTaxReturn.mockImplementation(async (...args) => makeTaxResponse(args, 'CALCULATED', []));
  render(<TaxTab {...taxProps} />);
  const income = screen.getByLabelText(/gross annual income/i);
  fireEvent.change(income, { target: { value: '1000000' } });
  fireEvent.change(screen.getByLabelText(/income source/i), { target: { value: 'salary' } });
  expect(screen.getByText('New tax regime only')).toBeVisible();
  fireEvent.change(screen.getByLabelText(/Your age on March 31/i), { target: { value: '35' } });

  await waitFor(() => expect(screen.getByText('₹5,000 (5.00% modelled net)')).toBeVisible());
  fireEvent.change(income, { target: { value: '1200000' } });
  expect(screen.queryByText('₹5,000 (5.00% modelled net)')).toBeNull();
  expect(screen.queryByText(/- ₹5,000/)).toBeNull();
});
