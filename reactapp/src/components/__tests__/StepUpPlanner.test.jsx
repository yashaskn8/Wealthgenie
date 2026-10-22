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
function sipResponse(fields = {}, request = {}) {
  const monthlyInvestment = request.monthlyInvestment ?? 1000;
  const annualReturnRate = request.annualReturnRate ?? 0.08;
  const annualStepUpRate = request.annualStepUpRate ?? 0.1;
  const years = request.years ?? 5;
  const inflationRate = request.inflationRate ?? 0.06;
  const downsideAnnualReturnRate = request.downsideAnnualReturnRate ?? 0;
  const incomeGrowth = request.annualIncomeGrowthRate ?? 0;
  const expenseGrowth = request.annualExpenseGrowthRate ?? 0.06;
  const paise = n => Math.round(n * 100) / 100;
  const monthly = Math.expm1(Math.log1p(annualReturnRate) / 12);
  const downsideMonthly = Math.expm1(Math.log1p(downsideAnnualReturnRate) / 12);
  let flat = 0, step = 0, downside = 0, flatPaid = 0, stepPaid = 0;
  const chartData = [];
  for (let year = 1; year <= years; year++) {
    const monthlySip = paise(monthlyInvestment * Math.pow(1 + annualStepUpRate, year - 1));
    const surplus = [request.monthlyIncome, request.monthlyExpenses, request.monthlyEmi].every(Number.isFinite)
      ? request.monthlyIncome * Math.pow(1 + incomeGrowth, year - 1)
        - request.monthlyExpenses * Math.pow(1 + expenseGrowth, year - 1) - request.monthlyEmi - monthlySip
      : null;
    for (let m = 0; m < 12; m++) {
      flat = (flat + monthlyInvestment) * (1 + monthly);
      step = (step + monthlySip) * (1 + monthly);
      downside = (downside + monthlySip) * (1 + downsideMonthly);
      flatPaid += monthlyInvestment;
      stepPaid += monthlySip;
    }
    chartData.push({
      year, flatSIP: Math.round(flat), stepUpSIP: Math.round(step),
      flatInvested: paise(flatPaid), stepUpInvested: paise(stepPaid),
      downsideStepUp: Math.round(downside),
      inflationAdjustedStepUp: Math.round(step / Math.pow(1 + inflationRate, year)),
      monthlySip,
      monthlyBudgetSurplus: surplus === null ? null : paise(surplus),
    });
  }
  const last = chartData[years - 1];
  const corpus = fields.flatFinal ?? last.flatSIP;
  const stepUpCorpus = fields.stepUpFinal ?? (fields.flatFinal === undefined ? last.stepUpSIP : corpus + 30000);
  const budgetKnown = [request.monthlyIncome, request.monthlyExpenses, request.monthlyEmi].every(Number.isFinite);
  const firstUnaffordableIndex = chartData.findIndex(row => row.monthlyBudgetSurplus !== null && row.monthlyBudgetSurplus < -0.005);
  const maxShortfall = Math.max(0, ...chartData.map(row => Math.max(0, -(row.monthlyBudgetSurplus ?? 0))));
  const hasEmergency = [request.monthlyExpenses, request.monthlyEmi, request.emergencySavings].every(Number.isFinite);
  const emergencyRequired = hasEmergency ? paise((request.monthlyExpenses + request.monthlyEmi) * 6) : null;
  const result = {
    schema_version: 'sip-plan-v1',
    monthly_rate_convention: 'EFFECTIVE_ANNUAL_CAGR',
    annual_return_interpretation: 'USER_ASSUMED_EFFECTIVE_ANNUAL_RETURN',
    observed_market_fact: false, provider_forecast: false,
    capital_gains_tax: null, estimated_post_tax_corpus: null,
    flatFinal: corpus, stepUpFinal: stepUpCorpus,
    flatInvested: last.flatInvested, stepUpInvested: last.stepUpInvested,
    additionalCorpus: stepUpCorpus - corpus,
    additionalContributions: paise(last.stepUpInvested - last.flatInvested),
    additionalProjectedGrowth: (stepUpCorpus - corpus) - paise(last.stepUpInvested - last.flatInvested),
    additionalPercent: 10,
    downsideFinal: last.downsideStepUp,
    inflationAdjustedStepUpFinal: last.inflationAdjustedStepUp,
    finalMonthlySip: last.monthlySip, chartData,
    affordability: {
      status: !budgetKnown ? 'NOT_ASSESSED' : firstUnaffordableIndex < 0
        ? 'WITHIN_DECLARED_BUDGET' : 'OVER_DECLARED_BUDGET',
      firstUnaffordableMonth: firstUnaffordableIndex < 0 ? null : firstUnaffordableIndex * 12 + 1,
      maxMonthlyShortfall: paise(maxShortfall),
    },
    emergency_buffer: {
      status: !hasEmergency ? 'NOT_ASSESSED'
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
      emergencySavings: request.emergencySavings ?? null,
      emergencyMonths: 6,
    },
  };
  // Deliberately corrupt only fields selected by individual adversarial tests.
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'flatInvested' || key === 'stepUpInvested'
        || key === 'additionalContributions' || key === 'additionalProjectedGrowth'
        || key === 'finalMonthlySip') continue;
    if (key === 'affordability' || key === 'emergency_buffer') {
      result[key] = { ...result[key], ...value };
    } else {
      result[key] = value;
    }
  }
  result.additionalCorpus = result.stepUpFinal - result.flatFinal;
  result.additionalProjectedGrowth = result.additionalCorpus - result.additionalContributions;
  // Keep the last chart endpoint consistent with the synthetic displayed
  // corpus values used by a few focused stale-response UI tests.
  result.chartData[years - 1] = {
    ...result.chartData[years - 1],
    flatSIP: result.flatFinal,
    stepUpSIP: result.stepUpFinal,
    downsideStepUp: result.downsideFinal,
    inflationAdjustedStepUp: result.inflationAdjustedStepUpFinal,
  };
  return result;
}

it('labels the step-up difference as extra projected corpus, not investment gain', async () => {
  vi.spyOn(api, 'calculateStepUpProjection').mockResolvedValue(sipResponse({
    flatFinal: 90000,
    stepUpFinal: 120000,
    flatInvested: 60000,
    stepUpInvested: 75000,
    additionalCorpus: 30000,
    additionalPercent: 33.3,
  }));

  render(<StepUpPlanner profile={{ monthly_savings: 1000, investment_horizon_years: 5 }} />);

  expect(screen.getByText('Extra projected corpus (nearest ₹1)')).toBeInTheDocument();
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

  render(<StepUpPlanner profile={{ monthly_savings: 1000, investment_horizon_years: 5 }} />);
  await waitFor(() => expect(calculate).toHaveBeenCalledTimes(1));
  await act(async () => initial.resolve(sipResponse({ flatFinal: 123000000 })));
  expect(await screen.findByText('₹12,30,00,000')).toBeInTheDocument();

  const numericInputs = screen.getAllByRole('spinbutton');
  fireEvent.change(numericInputs[0], { target: { value: '2000' } });
  expect(screen.queryByText('₹12,30,00,000')).not.toBeInTheDocument();
  await waitFor(() => expect(calculate).toHaveBeenCalledTimes(2));

  fireEvent.change(numericInputs[1], { target: { value: '15' } });
  await waitFor(() => expect(calculate).toHaveBeenCalledTimes(3));
  await act(async () => latest.resolve(sipResponse({ flatFinal: 67000000 }, { monthlyInvestment: 2000, annualStepUpRate: 0.15 })));
  expect(await screen.findByText('₹6,70,00,000')).toBeInTheDocument();

  await act(async () => recalculation.resolve(sipResponse({ flatFinal: 89000000 }, { monthlyInvestment: 2000 })));
  expect(screen.getByText('₹6,70,00,000')).toBeInTheDocument();
  expect(screen.queryByText('₹8,90,00,000')).not.toBeInTheDocument();
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
  const calculate = vi.spyOn(api, 'calculateStepUpProjection').mockResolvedValue(sipResponse({
    flatFinal: 100000, stepUpFinal: 110000,
    flatInvested: 80000, stepUpInvested: 90000,
    additionalCorpus: 10000, additionalPercent: 10,
    additionalContributions: 10000, additionalProjectedGrowth: 0,
    finalMonthlySip: 1800, downsideFinal: 90000, inflationAdjustedStepUpFinal: 95000,
    affordability: { status: 'WITHIN_DECLARED_BUDGET' },
    emergency_buffer: { status: 'DECLARED_BUFFER_MET', requiredAmount: 126000 },
  }, {
    monthlyIncome: 30000, monthlyExpenses: 18000, monthlyEmi: 3000,
    emergencySavings: 200000,
  }));
  render(<StepUpPlanner profile={{ monthly_savings: 1000, investment_horizon_years: 5 }} />);

  fireEvent.change(screen.getByLabelText('Monthly take-home (₹)'), { target: { value: '30000' } });
  fireEvent.change(screen.getByLabelText('Monthly living expenses excluding EMI (₹)'), { target: { value: '18000' } });
  fireEvent.change(screen.getByLabelText('Monthly EMI / debt payments (₹; enter 0 if none)'), { target: { value: '3000' } });
  fireEvent.change(screen.getByLabelText('Liquid emergency savings (₹)'), { target: { value: '200000' } });
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
  expect(screen.getByText(/Extra money contributed:/)).toBeInTheDocument();
  expect(screen.getByText(/Extra projected investment growth:/)).toBeInTheDocument();
});

it('shows a safe backend failure rather than inventing numerical results', async () => {
  vi.spyOn(api, 'calculateStepUpProjection').mockRejectedValue(new Error('Backend is temporarily unavailable'));
  render(<StepUpPlanner profile={{ monthly_savings: 1000, investment_horizon_years: 5 }} />);
  expect(await screen.findByText('Backend is temporarily unavailable')).toBeInTheDocument();
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
  vi.spyOn(api, 'calculateStepUpProjection').mockResolvedValue(sipResponse({
    flatFinal: 123000000, stepUpFinal: 123000000,
  }, { monthlyInvestment: 1000.37, years: 1 }));
  render(<StepUpPlanner profile={{ monthly_savings: 1000.37, investment_horizon_years: 1 }} />);
  expect((await screen.findAllByText('₹12,30,00,000')).length).toBe(2);
  expect(screen.getAllByText(/₹12,004\\.44/).length).toBeGreaterThan(0);
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
  expect(await screen.findByText(/invalid or incompatible financial projection/)).toBeInTheDocument();
  expect(screen.queryByText('₹90,000')).not.toBeInTheDocument();
  expect(calculate).toHaveBeenCalled();
});

it('rejects malformed affordability data and refuses to show a false affordable result', async () => {
  vi.spyOn(api, 'calculateStepUpProjection').mockResolvedValue(
    sipResponse({ affordability: { status: 'UNKNOWN' } }),
  );
  render(<StepUpPlanner profile={{ monthly_savings: 1000, investment_horizon_years: 5 }} />);
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
