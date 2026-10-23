import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import api from '../../services/api';
import StepUpPlanner from '../StepUpPlanner';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Test-only protocol fixture: each display number must belong to a complete,
// explicitly-CAGR response. Partial API responses are rejected in production.
// The fixture uses the real declared compounding convention. Never permit a
// made-up projected corpus to masquerade as a valid backend response.
function sipResponse(overrides = {}, request = {}) {
  const monthlyInvestment = request.monthlyInvestment ?? 1000;
  const annualReturnRate = request.annualReturnRate ?? 0.08;
  const annualStepUpRate = request.annualStepUpRate ?? 0.1;
  const years = request.years ?? 5;
  const inflationRate = request.inflationRate ?? 0.06;
  const downsideAnnualReturnRate = request.downsideAnnualReturnRate ?? 0;
  const incomeGrowth = request.annualIncomeGrowthRate ?? 0;
  const expenseGrowth = request.annualExpenseGrowthRate ?? 0.06;
  const roundPaise = value => Math.round((value + Math.sign(value) * Number.EPSILON) * 100) / 100;
  const monthly = Math.expm1(Math.log1p(annualReturnRate) / 12);
  const downsideMonthly = Math.expm1(Math.log1p(downsideAnnualReturnRate) / 12);
  let flat = 0, step = 0, downside = 0, flatPaid = 0, stepPaid = 0;
  let firstUnaffordableMonth = null, maxMonthlyShortfall = 0, worstMonthlySurplus = null;
  const chartData = [];
  for (let year = 1; year <= years; year++) {
    const monthlySip = roundPaise(monthlyInvestment * Math.pow(1 + annualStepUpRate, year - 1));
    const surplus = [request.monthlyIncome, request.monthlyExpenses, request.monthlyEmi].every(Number.isFinite)
      ? request.monthlyIncome * Math.pow(1 + incomeGrowth, year - 1)
        - request.monthlyExpenses * Math.pow(1 + expenseGrowth, year - 1) - request.monthlyEmi - monthlySip
      : null;
    if (surplus !== null) worstMonthlySurplus = worstMonthlySurplus === null ? surplus : Math.min(worstMonthlySurplus, surplus);
    if (surplus !== null && surplus < -0.005) {
      if (firstUnaffordableMonth === null) firstUnaffordableMonth = (year - 1) * 12 + 1;
      maxMonthlyShortfall = Math.max(maxMonthlyShortfall, -surplus);
    }
    for (let m = 0; m < 12; m++) {
      flat = (flat + monthlyInvestment) * (1 + monthly);
      step = (step + monthlySip) * (1 + monthly);
      downside = (downside + monthlySip) * (1 + downsideMonthly);
      flatPaid += monthlyInvestment;
      stepPaid += monthlySip;
    }
    chartData.push({
      year, flatSIP: Math.round(flat), stepUpSIP: Math.round(step),
      flatInvested: roundPaise(flatPaid), stepUpInvested: roundPaise(stepPaid),
      downsideStepUp: Math.round(downside),
      inflationAdjustedFlat: Math.round(flat / Math.pow(1 + inflationRate, year)),
      inflationAdjustedStepUp: Math.round(step / Math.pow(1 + inflationRate, year)),
      monthlySip, monthlyBudgetSurplus: surplus === null ? null : roundPaise(surplus),
    });
  }
  const last = chartData[years - 1];
  const budgetKnown = [request.monthlyIncome, request.monthlyExpenses, request.monthlyEmi].every(Number.isFinite);
  const emergencyKnown = [request.monthlyExpenses, request.monthlyEmi, request.emergencySavings].every(Number.isFinite);
  const emergencyRequired = emergencyKnown ? roundPaise((request.monthlyExpenses + request.monthlyEmi) * 6) : null;
  const additionalContributions = roundPaise(last.stepUpInvested - last.flatInvested);
  const additionalCorpus = last.stepUpSIP - last.flatSIP;
  const result = {
    schema_version: 'sip-plan-v1',
    calculation_classification: 'NON_RECOMMENDATION_STEP_UP_CALCULATION',
    return_basis: 'PRE_TAX_NOMINAL',
    return_data_class: 'USER_INPUT',
    return_assumption_source: 'USER_SUPPLIED_WHAT_IF',
    contribution_timing: 'START_OF_MONTH',
    scenario_interpretation: 'ILLUSTRATIVE_CONSTANT_RETURN_PATHS_NOT_PROBABILITIES',
    warnings: [
      ...(!budgetKnown ? ['AFFORDABILITY_NOT_ASSESSED'] : []),
      ...(request.monthlyEmi === undefined ? ['MONTHLY_EMI_NOT_DECLARED'] : []),
      ...(firstUnaffordableMonth !== null ? ['STEP_UP_EXCEEDS_DECLARED_BUDGET'] : []),
      ...(emergencyKnown && request.emergencySavings < emergencyRequired ? ['DECLARED_EMERGENCY_BUFFER_SHORT'] : []),
      ...(!emergencyKnown ? ['EMERGENCY_BUFFER_NOT_ASSESSED'] : []),
      'PRE_TAX_NOT_A_TAX_ESTIMATE', 'ASSUMED_RETURNS_NOT_GUARANTEED',
    ],
    monthly_rate_convention: 'EFFECTIVE_ANNUAL_CAGR',
    annual_return_interpretation: 'USER_ASSUMED_EFFECTIVE_ANNUAL_RETURN',
    observed_market_fact: false, provider_forecast: false,
    capital_gains_tax: null, estimated_post_tax_corpus: null,
    flatFinal: last.flatSIP, stepUpFinal: last.stepUpSIP,
    flatInvested: last.flatInvested, stepUpInvested: last.stepUpInvested,
    additionalCorpus, additionalContributions,
    additionalProjectedGrowth: roundPaise(additionalCorpus - additionalContributions),
    flatProjectedGrowth: roundPaise(last.flatSIP - last.flatInvested),
    stepUpProjectedGrowth: roundPaise(last.stepUpSIP - last.stepUpInvested),
    additionalPercent: flat >= 0.5 ? ((step / flat) - 1) * 100 : null,
    downsideFinal: last.downsideStepUp,
    inflationAdjustedStepUpFinal: last.inflationAdjustedStepUp,
    finalMonthlySip: last.monthlySip, chartData,
    affordability: {
      status: !budgetKnown ? 'NOT_ASSESSED' : firstUnaffordableMonth === null
        ? 'WITHIN_DECLARED_BUDGET' : 'OVER_DECLARED_BUDGET',
      firstUnaffordableMonth, maxMonthlyShortfall: roundPaise(maxMonthlyShortfall),
      worstMonthlySurplus: worstMonthlySurplus === null ? null : roundPaise(worstMonthlySurplus),
      assumesEmiConstant: true, incomeExpensesUserDeclared: budgetKnown,
      annualContributionSchedule: chartData.map(row => ({
        year: row.year, monthlySip: row.monthlySip,
        monthlyBudgetSurplus: row.monthlyBudgetSurplus,
      })),
    },
    emergency_buffer: {
      status: !emergencyKnown ? 'NOT_ASSESSED'
        : request.emergencySavings >= emergencyRequired ? 'DECLARED_BUFFER_MET' : 'DECLARED_BUFFER_SHORT',
      requiredAmount: emergencyRequired, declaredAmount: request.emergencySavings ?? null,
    },
    assumptions: {
      monthlyInvestment, annualReturnRate, annualStepUpRate, years,
      returnRateConvention: 'EFFECTIVE_ANNUAL_CAGR',
      inflationRate, downsideAnnualReturnRate,
      annualIncomeGrowthRate: incomeGrowth, annualExpenseGrowthRate: expenseGrowth,
      monthlyIncome: request.monthlyIncome ?? null,
      monthlyExpenses: request.monthlyExpenses ?? null,
      monthlyEmi: request.monthlyEmi ?? null,
      emergencySavings: request.emergencySavings ?? null, emergencyMonths: 6,
    },
  };
  for (const [key, value] of Object.entries(overrides)) {
    result[key] = key === 'affordability' || key === 'emergency_buffer'
      ? { ...result[key], ...value } : value;
  }
  return result;
}

const formattedINR = value => new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 2,
}).format(value);

it('labels the step-up difference as extra projected corpus, not investment gain', async () => {
  vi.spyOn(api, 'calculateStepUpProjection').mockResolvedValue(sipResponse());

  render(<StepUpPlanner profile={{ monthly_savings: 1000, investment_horizon_years: 5 }} />);
  expect(screen.queryByText('Extra projected corpus (nearest ₹1)')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Calculate SIP projection' }));
  expect(await screen.findByText('Extra projected corpus (nearest ₹1)')).toBeInTheDocument();
  expect(screen.queryByText('Extra Wealth Gained')).not.toBeInTheDocument();
});

it('hides a prior projection when inputs change and ignores late results from older inputs', async () => {
  const initial = deferred();
  const recalculation = deferred();
  const latest = deferred();
  const calculate = vi.spyOn(api, 'calculateStepUpProjection')
    .mockImplementationOnce(() => initial.promise)
    .mockImplementationOnce(() => recalculation.promise)
    .mockImplementationOnce(() => latest.promise);

  const before = sipResponse();
  const middle = sipResponse({}, { monthlyInvestment: 2000 });
  const after = sipResponse({}, { monthlyInvestment: 2000, annualStepUpRate: 0.15 });
  render(<StepUpPlanner profile={{ monthly_savings: 1000, investment_horizon_years: 5 }} />);
  expect(calculate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Calculate SIP projection' }));
  await waitFor(() => expect(calculate).toHaveBeenCalledTimes(1));
  await act(async () => initial.resolve(before));
  expect(await screen.findByText(formattedINR(before.stepUpFinal))).toBeInTheDocument();

  fireEvent.change(screen.getByRole('spinbutton', { name: 'Starting monthly SIP amount (INR)' }), { target: { value: '2000' } });
  expect(screen.queryByText(formattedINR(before.stepUpFinal))).not.toBeInTheDocument();
  expect(calculate).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Calculate SIP projection' }));
  await waitFor(() => expect(calculate).toHaveBeenCalledTimes(2));

  fireEvent.change(screen.getByRole('spinbutton', { name: 'Annual SIP increase percentage' }), { target: { value: '15' } });
  fireEvent.click(screen.getByRole('button', { name: 'Calculate SIP projection' }));
  await waitFor(() => expect(calculate).toHaveBeenCalledTimes(3));
  await act(async () => latest.resolve(after));
  expect(await screen.findByText(formattedINR(after.stepUpFinal))).toBeInTheDocument();

  await act(async () => recalculation.resolve(middle));
  expect(screen.getByText(formattedINR(after.stepUpFinal))).toBeInTheDocument();
  expect(screen.queryByText(formattedINR(middle.stepUpFinal))).not.toBeInTheDocument();
});

it.each([
  ['zero monthly savings', 0],
  ['negative return assumption', -100],
])('does not request a projection for %s', async (label, invalidValue) => {
  const calculate = vi.spyOn(api, 'calculateStepUpProjection').mockResolvedValue({});
  render(<StepUpPlanner profile={{ monthly_savings: 1000, investment_horizon_years: 5 }} />);
  const numericInputs = screen.getAllByRole('spinbutton');
  const inputIndex = label === 'zero monthly savings' ? 0 : 3;
  fireEvent.change(numericInputs[inputIndex], { target: { value: String(invalidValue) } });

  await new Promise(resolve => setTimeout(resolve, 320));
  expect(calculate).not.toHaveBeenCalled();
});


it('sends explicit affordability inputs and zero EMI without provider keys or market calls', async () => {
  const calculate = vi.spyOn(api, 'calculateStepUpProjection').mockResolvedValue(sipResponse({}, {
    monthlyIncome: 30000, monthlyExpenses: 18000, monthlyEmi: 3000,
    emergencySavings: 200000,
  }));
  render(<StepUpPlanner profile={{ monthly_savings: 1000, investment_horizon_years: 5 }} />);

  fireEvent.change(screen.getByLabelText('Monthly take-home (₹)'), { target: { value: '30000' } });
  fireEvent.change(screen.getByLabelText('Monthly living expenses excluding EMI (₹)'), { target: { value: '18000' } });
  fireEvent.change(screen.getByLabelText('Monthly EMI / debt payments (₹; enter 0 if none)'), { target: { value: '3000' } });
  fireEvent.change(screen.getByLabelText('Liquid emergency savings (₹)'), { target: { value: '200000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Calculate SIP projection' }));
  await waitFor(() => {
    const last = calculate.mock.lastCall;
    expect(last).toBeDefined();
    expect(last[0]).toBe(1000);
    expect(last[4].body).toMatchObject({
      returnRateConvention: 'EFFECTIVE_ANNUAL_CAGR',
      monthlyIncome: 30000, monthlyExpenses: 18000, monthlyEmi: 3000,
      emergencySavings: 200000, inflationRate: 0.06,
      downsideAnnualReturnRate: 0, annualIncomeGrowthRate: 0,
      annualExpenseGrowthRate: 0.06,
    });
    expect(last[4].body).not.toHaveProperty('apiKey');
    expect(last[4].body).not.toHaveProperty('provider');
  });
  expect(await screen.findByText(/Every planned instalment fits the declared monthly cash surplus/)).toBeInTheDocument();
  expect(screen.getByText(/Extra money you contribute:/)).toBeInTheDocument();
  expect(screen.getByText(/Extra hypothetical return component:/)).toBeInTheDocument();
});

it('shows a safe backend failure rather than inventing numerical results', async () => {
  vi.spyOn(api, 'calculateStepUpProjection').mockRejectedValue(new Error('Backend is temporarily unavailable'));
  render(<StepUpPlanner profile={{ monthly_savings: 1000, investment_horizon_years: 5 }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Calculate SIP projection' }));
  expect(await screen.findByText('Backend is temporarily unavailable')).toBeInTheDocument();
  expect(screen.queryByText('Calculating with your inputs…')).not.toBeInTheDocument();
  expect(screen.getByText(/No amounts are shown until a verified calculation succeeds/)).toBeInTheDocument();
  expect(screen.queryByText('₹12,30,00,000')).not.toBeInTheDocument();
});

it('does not send a misleading downside scenario stronger than the base return', async () => {
  const calculate = vi.spyOn(api, 'calculateStepUpProjection').mockResolvedValue({});
  render(<StepUpPlanner profile={{ monthly_savings: 1000, investment_horizon_years: 5 }} />);
  fireEvent.change(screen.getByLabelText('Downside annual return (%)'), { target: { value: '20' } });
  await new Promise(resolve => setTimeout(resolve, 350));
  expect(calculate).not.toHaveBeenCalled();
  expect(screen.getByText(/the downside return must not exceed the base return/)).toBeInTheDocument();
});

it('renders exact rupee and paise deposits without abbreviating the values', async () => {
  const actual = sipResponse({}, { monthlyInvestment: 1000.37, years: 1 });
  vi.spyOn(api, 'calculateStepUpProjection').mockResolvedValue(actual);
  render(<StepUpPlanner profile={{ monthly_savings: 1000.37, investment_horizon_years: 1 }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Calculate SIP projection' }));
  expect((await screen.findAllByText(formattedINR(actual.flatFinal))).length).toBe(2);
  expect(screen.getAllByText(/₹12,004\.44/).length).toBeGreaterThan(0);
  expect(screen.queryByText('₹12.3 Cr')).not.toBeInTheDocument();
});

it('does not convert a temporarily cleared downside rate to a zero-percent assumption', async () => {
  const calculate = vi.spyOn(api, 'calculateStepUpProjection').mockResolvedValue({});
  render(<StepUpPlanner profile={{ monthly_savings: 1000, investment_horizon_years: 5 }} />);
  fireEvent.change(screen.getByLabelText('Downside annual return (%)'), { target: { value: '' } });
  await new Promise(resolve => setTimeout(resolve, 350));
  expect(calculate).not.toHaveBeenCalled();
});

it('rejects a nominal-APR or legacy response instead of displaying it as CAGR', async () => {
  const calculate = vi.spyOn(api, 'calculateStepUpProjection').mockResolvedValue(
    sipResponse({ monthly_rate_convention: 'NOMINAL_APR_DIVIDED_BY_12' }),
  );
  render(<StepUpPlanner profile={{ monthly_savings: 1000, investment_horizon_years: 5 }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Calculate SIP projection' }));
  expect(await screen.findByText(/invalid or incompatible financial projection/)).toBeInTheDocument();
  expect(screen.queryByText('₹90,000')).not.toBeInTheDocument();
  expect(calculate).toHaveBeenCalled();
});

it('rejects malformed affordability data and refuses to show a false affordable result', async () => {
  vi.spyOn(api, 'calculateStepUpProjection').mockResolvedValue(
    sipResponse({ affordability: { status: 'UNKNOWN' } }),
  );
  render(<StepUpPlanner profile={{ monthly_savings: 1000, investment_horizon_years: 5 }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Calculate SIP projection' }));
  expect(await screen.findByText(/invalid or incompatible financial projection/)).toBeInTheDocument();
  expect(screen.queryByText(/Every planned instalment fits/)).not.toBeInTheDocument();
});

it.each([
  'Starting monthly SIP amount (INR)',
  'Annual SIP increase percentage',
  'Investment horizon in years',
  'Assumed annualised return CAGR percentage',
])('keeps an intentionally cleared %s invalid after losing focus', async label => {
  const calculate = vi.spyOn(api, 'calculateStepUpProjection').mockResolvedValue(sipResponse());
  render(<StepUpPlanner profile={{ monthly_savings: 1000, investment_horizon_years: 5 }} />);
  const input = screen.getByRole('spinbutton', { name: label });
  fireEvent.change(input, { target: { value: '' } });
  fireEvent.blur(input);
  expect(input).toHaveValue(null);
  await new Promise(resolve => setTimeout(resolve, 350));
  expect(calculate).not.toHaveBeenCalled();
  expect(screen.getByText(/Enter valid numbers/)).toBeInTheDocument();
});

it('recovers from an aborted in-flight request using the visible retry action', async () => {
  const rejected = Object.assign(new Error('Interrupted'), { code: 'REQUEST_ABORTED' });
  const calculate = vi.spyOn(api, 'calculateStepUpProjection')
    .mockRejectedValueOnce(rejected)
    .mockResolvedValueOnce(sipResponse());
  render(<StepUpPlanner profile={{ monthly_savings: 1000, investment_horizon_years: 5 }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Calculate SIP projection' }));
  expect(await screen.findByText(/projection request was interrupted/)).toBeInTheDocument();
  expect(screen.queryByText(/Every planned instalment fits/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry projection' }));
  await waitFor(() => expect(calculate).toHaveBeenCalledTimes(2));
  expect(await screen.findAllByText(formattedINR(sipResponse().stepUpFinal))).not.toHaveLength(0);
  expect(screen.queryByText(/projection request was interrupted/)).not.toBeInTheDocument();
});

it('does not make an investment forecast or display random looking rupee amounts on initial profile load', async () => {
  const calculate = vi.spyOn(api, 'calculateStepUpProjection').mockResolvedValue(sipResponse());
  render(<StepUpPlanner profile={{ monthly_savings: 11998, investment_horizon_years: 20 }} />);
  expect(screen.getByText(/No projection calculated yet/)).toBeInTheDocument();
  expect(screen.getByText(/₹11,998 per month, increasing 10% each year for 20 years/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Calculate SIP projection' })).toBeEnabled();
  expect(screen.queryByText('Projected step-up corpus (nearest ₹1)')).not.toBeInTheDocument();
  await new Promise(resolve => setTimeout(resolve, 350));
  expect(calculate).not.toHaveBeenCalled();
});

it('does not invent a starting SIP or horizon when financial profile is missing', async () => {
  const calculate = vi.spyOn(api, 'calculateStepUpProjection').mockResolvedValue(sipResponse());
  render(<StepUpPlanner profile={{}} />);
  expect(screen.getByRole('button', { name: 'Calculate SIP projection' })).toBeDisabled();
  expect(screen.getByRole('spinbutton', { name: 'Starting monthly SIP amount (INR)' })).toHaveValue(null);
  expect(screen.getByRole('spinbutton', { name: 'Investment horizon in years' })).toHaveValue(null);
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(calculate).not.toHaveBeenCalled();
});

it('makes clear that an omitted EMI means budget unassessed, even when a user explicitly calculates', async () => {
  const response = sipResponse();
  const calculate = vi.spyOn(api, 'calculateStepUpProjection').mockResolvedValue(response);
  render(<StepUpPlanner profile={{ monthly_savings: 1000, investment_horizon_years: 5 }} />);
  expect(screen.getByText(/Budget NOT ASSESSED/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Calculate SIP projection' }));
  expect(await screen.findByText(/Not assessed — provide take-home income/)).toBeInTheDocument();
  expect(screen.getByText(/in extra deposits/)).toBeInTheDocument();
  expect(calculate).toHaveBeenCalledTimes(1);
});

it('requires another explicit calculation after editing a previously calculated assumption', async () => {
  const actual = sipResponse();
  const calculate = vi.spyOn(api, 'calculateStepUpProjection').mockResolvedValue(actual);
  render(<StepUpPlanner profile={{ monthly_savings: 1000, investment_horizon_years: 5 }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Calculate SIP projection' }));
  expect(await screen.findByText('Projected step-up corpus (nearest ₹1)')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Investment horizon in years' }), { target: { value: '7' } });
  expect(screen.queryByText('Projected step-up corpus (nearest ₹1)')).not.toBeInTheDocument();
  expect(screen.getByText(/Inputs changed. The previous projection is hidden/)).toBeInTheDocument();
  await new Promise(resolve => setTimeout(resolve, 350));
  expect(calculate).toHaveBeenCalledTimes(1);
});

it('does not leave old results visible when a user replaces valid inputs with invalid ones', async () => {
  const calculate = vi.spyOn(api, 'calculateStepUpProjection').mockResolvedValue(sipResponse());
  render(<StepUpPlanner profile={{ monthly_savings: 1000, investment_horizon_years: 5 }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Calculate SIP projection' }));
  expect(await screen.findByText('Projected step-up corpus (nearest ₹1)')).toBeInTheDocument();
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Assumed annualised return CAGR percentage' }), { target: { value: '' } });
  expect(screen.getByRole('button', { name: 'Calculate SIP projection' })).toBeDisabled();
  expect(screen.queryByText('Projected step-up corpus (nearest ₹1)')).not.toBeInTheDocument();
  expect(calculate).toHaveBeenCalledTimes(1);
});
