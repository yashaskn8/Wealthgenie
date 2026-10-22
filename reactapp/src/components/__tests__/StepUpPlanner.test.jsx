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

it('labels the step-up difference as extra projected corpus, not investment gain', async () => {
  vi.spyOn(api, 'calculateStepUpProjection').mockResolvedValue({
    flatFinal: 90000,
    stepUpFinal: 120000,
    flatInvested: 60000,
    stepUpInvested: 75000,
    additionalCorpus: 30000,
    additionalPercent: 33.3,
    chartData: [],
  });

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
  await act(async () => initial.resolve({ flatFinal: 123000000 }));
  expect(await screen.findByText('₹12,30,00,000')).toBeInTheDocument();

  const numericInputs = screen.getAllByRole('spinbutton');
  fireEvent.change(numericInputs[0], { target: { value: '2000' } });
  expect(screen.queryByText('₹12,30,00,000')).not.toBeInTheDocument();
  await waitFor(() => expect(calculate).toHaveBeenCalledTimes(2));

  fireEvent.change(numericInputs[1], { target: { value: '15' } });
  await waitFor(() => expect(calculate).toHaveBeenCalledTimes(3));
  await act(async () => latest.resolve({ flatFinal: 67000000 }));
  expect(await screen.findByText('₹6,70,00,000')).toBeInTheDocument();

  await act(async () => recalculation.resolve({ flatFinal: 89000000 }));
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
  const calculate = vi.spyOn(api, 'calculateStepUpProjection').mockResolvedValue({
    flatFinal: 100000, stepUpFinal: 110000,
    flatInvested: 80000, stepUpInvested: 90000,
    additionalCorpus: 10000, additionalPercent: 10,
    additionalContributions: 10000, additionalProjectedGrowth: 0,
    finalMonthlySip: 1800, downsideFinal: 90000, inflationAdjustedStepUpFinal: 95000,
    affordability: { status: 'WITHIN_DECLARED_BUDGET' },
    emergency_buffer: { status: 'DECLARED_BUFFER_MET', requiredAmount: 126000 },
    chartData: [],
  });
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

it('renders exact rupee and paise amounts rather than silently abbreviating deposits', async () => {
  vi.spyOn(api, 'calculateStepUpProjection').mockResolvedValue({
    flatFinal: 123000000, stepUpFinal: 123000000,
    flatInvested: 12004.44, stepUpInvested: 12004.44,
    additionalCorpus: 0, additionalPercent: 0,
    additionalContributions: 0, additionalProjectedGrowth: 0,
    finalMonthlySip: 1000.37, downsideFinal: 12004,
    inflationAdjustedStepUpFinal: 11500,
    affordability: { status: 'NOT_ASSESSED' },
    emergency_buffer: { status: 'NOT_ASSESSED' },
    chartData: [],
  });
  render(<StepUpPlanner profile={{ monthly_savings: 1000, investment_horizon_years: 5 }} />);
  expect(await screen.findByText('₹12,30,00,000')).toBeInTheDocument();
  expect(screen.getAllByText(/₹12,004\.44/).length).toBeGreaterThan(0);
  expect(screen.queryByText('₹12.3 Cr')).not.toBeInTheDocument();
});
