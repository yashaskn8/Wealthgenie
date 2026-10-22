/** @vitest-environment jsdom */
import React from 'react';
import { act, render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import GoalFinanceWorkspace from '../GoalFinanceWorkspace';
import api from '../../services/api';

vi.mock('../../services/api', () => ({
  generateUUID: vi.fn(() => 'goals-client-retry-key-test-0001'),
  default: {
    getGoalBudget: vi.fn(), saveGoalBudget: vi.fn(),
    getGoalFundingPlan: vi.fn(), assessGoalVehiclePurchase: vi.fn(),
    projectGoalSavings: vi.fn(), getGoalSpecifications: vi.fn(),
    createGoalSpecification: vi.fn(), updateGoalSpecification: vi.fn(),
    deleteGoalSpecification: vi.fn(),
  },
}));

const budget = {
  month: '2026-10', version: 3, monthlyIncome: 60000, expensesComplete: true,
  protectedMonthlyContributions: 2000,
  expenses: [{ category: 'housing', frequency: 'recurring', amount: 25000 }],
};
const summary = {
  budgetStatus: 'SELF_REPORTED', recurringExpenses: 25000, oneOffExpenses: 0,
  recurringSurplus: 33000, actualMonthSurplus: 33000, missing: [],
};
const funding = {
  plan: { status: 'WITHIN_CAPACITY', capacity: 33000,
    totalRequested: 12000, totalAllocated: 12000, allocations: [], warnings: [] },
};
describe('Goal financial workspace — keyless budget and purchase flows', () => {
  beforeEach(() => {
    Object.values(api).forEach(mock => mock.mockReset());
    api.getGoalBudget.mockResolvedValue({ budget, summary });
    api.getGoalFundingPlan.mockResolvedValue(funding);
    api.getGoalSpecifications.mockResolvedValue({ specifications: [] });
    api.saveGoalBudget.mockResolvedValue({ budget: { ...budget, version: 4 }, summary });
    api.createGoalSpecification.mockResolvedValue({ specification: { id: 'one' } });
    api.assessGoalVehiclePurchase.mockResolvedValue({
      primary: {
        status: 'BUDGET_SHORTFALL', reasons: ['NEGATIVE_MONTHLY_CASHFLOW'],
        loan: { monthlyEmi: 14000, totalInterest: 180000 },
        additionalMonthlyCommitment: 18000, monthlySurplusAfterPurchase: -2000,
        emergencyCashAfterPurchase: 100000, totalNominalCostDuringLoan: 1080000,
      },
      alternatives: [], livePriceVerified: false, source: 'USER_ENTERED_QUOTES_ONLY',
    });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('renders private monthly budget, reports self-declared cash flow and saves with CAS version', async () => {
    render(<GoalFinanceWorkspace />);
    await screen.findByText('Monthly income and expense tracking');
    expect(screen.getByText('Monthly cash flow — SELF REPORTED')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Monthly take-home income (₹)'), { target: { value: '62000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save month and recalculate' }));
    await waitFor(() => expect(api.saveGoalBudget).toHaveBeenCalledOnce());
    const [, payload] = api.saveGoalBudget.mock.calls[0];
    expect(payload.expectedVersion).toBe(3);
    expect(payload.monthlyIncome).toBe(62000);
    expect(payload.expenses[0].amount).toBe(25000);
  });

  it('does not claim live vehicle prices and reveals user-supplied loan form', async () => {
    render(<GoalFinanceWorkspace />);
    await screen.findByText('Monthly income and expense tracking');
    fireEvent.click(screen.getByRole('button', { name: 'EMI & vehicles' }));
    expect(screen.getByText('Can I afford this vehicle?')).toBeTruthy();
    expect(screen.getByText(/Use your own dealer quotes/)).toBeTruthy();
    expect(api.assessGoalVehiclePurchase).not.toHaveBeenCalled();
  });


  it('does not display a prior-month save after switching budget periods', async () => {
    let finishOldSave;
    const oldSave = new Promise(resolve => { finishOldSave = resolve; });
    api.saveGoalBudget.mockReturnValueOnce(oldSave);
    api.getGoalBudget.mockImplementation(month => Promise.resolve({
      budget: { ...budget, month, monthlyIncome: month === '2027-01' ? 41000 : 60000 },
      summary,
    }));
    render(<GoalFinanceWorkspace />);
    await screen.findByText('Monthly income and expense tracking');
    fireEvent.click(screen.getByRole('button', { name: 'Save month and recalculate' }));
    await waitFor(() => expect(api.saveGoalBudget).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByLabelText('Budget month'), { target: { value: '2027-01' } });
    await waitFor(() => expect(screen.getByLabelText('Monthly take-home income (₹)').value).toBe('41000'));
    finishOldSave({ budget: { ...budget, version: 4, monthlyIncome: 99999 }, summary });
    await waitFor(() => expect(screen.getByLabelText('Monthly take-home income (₹)').value).toBe('41000'));
  });


  it('blocks vehicle assessments against unsaved budget edits', async () => {
    render(<GoalFinanceWorkspace />);
    await screen.findByText('Monthly income and expense tracking');
    fireEvent.change(screen.getByLabelText('Monthly take-home income (₹)'), { target: { value: '20000' } });
    fireEvent.click(screen.getByRole('button', { name: 'EMI & vehicles' }));
    expect(screen.getByText(/Save your updated monthly budget before assessing a purchase/)).toBeTruthy();
    expect(screen.queryByText('Can I afford this vehicle?')).toBeNull();
    expect(api.assessGoalVehiclePurchase).not.toHaveBeenCalled();
  });

  it('never displays a stale vehicle verdict after the price is edited while its request is pending', async () => {
    let release;
    api.assessGoalVehiclePurchase.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    const response = {
      primary: {
        status: 'PASSES_SELF_REPORTED_CHECKS', reasons: [], loan: { monthlyEmi: 9000, totalInterest: 70000 },
        additionalMonthlyCommitment: 12000, monthlySurplusAfterPurchase: 21000,
        purchaseMonthSurplusAfterPurchase: 21000,
        requiredMonthlyGoalContributions: 0, purchaseMonthSurplusAfterGoals: 21000,
        emergencyCashAfterPurchase: 180000, totalNominalCostDuringLoan: 900000,
      }, alternatives: [],
    };
    render(<GoalFinanceWorkspace />);
    await screen.findByText('Monthly income and expense tracking');
    fireEvent.click(screen.getByRole('button', { name: 'EMI & vehicles' }));
    const inputs = [
      ['Vehicle purchase price (₹)', '600000'], ['Cash down payment (₹)', '200000'],
      ['Registration, taxes, insurance and fees upfront (₹)', '20000'],
      ['Fuel, servicing, parking and insurance renewals / month (₹)', '5000'],
      ['Loan annual nominal interest rate (%)', '10'],
      ['Available cash reserve before buying (₹)', '400000'],
      ['Cash reserve to protect after buying (₹)', '150000'],
    ];
    for (const [label, value] of inputs) fireEvent.change(screen.getByLabelText(label), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Analyze purchase and alternatives' }));
    await waitFor(() => expect(api.assessGoalVehiclePurchase).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByLabelText('Vehicle purchase price (₹)'), { target: { value: '500000' } });
    await act(async () => { release(response); });
    expect(screen.queryByText(/Assessment: PASSES SELF REPORTED CHECKS/)).toBeNull();
  });

  it('creates a typed goal independently from portfolio advice', async () => {
    render(<GoalFinanceWorkspace />);
    await screen.findByText('Monthly income and expense tracking');
    fireEvent.click(screen.getByRole('button', { name: 'Goal specifications' }));
    await screen.findByText('New goal specification');
    fireEvent.change(screen.getByLabelText('Your goal name'), { target: { value: 'Practical city car' } });
    fireEvent.change(screen.getByLabelText('Target cost (₹)'), { target: { value: '450000' } });
    fireEvent.change(screen.getByLabelText('Desired date'), { target: { value: '2028-10-23' } });
    fireEvent.change(screen.getByLabelText('Annual price rise assumption (%)'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save goal specification' }));
    await waitFor(() => expect(api.createGoalSpecification).toHaveBeenCalledOnce());
    expect(api.createGoalSpecification.mock.calls[0][0].targetAmount).toBe(450000);
    expect(api.createGoalSpecification.mock.calls[0][0].kind).toBe('vehicle');
  });
});
