/** @vitest-environment jsdom */
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import GoalFinanceWorkspace from '../GoalFinanceWorkspace';
import api from '../../services/api';

vi.mock('../../services/api', () => ({
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

  it('creates a typed goal independently from portfolio advice', async () => {
    render(<GoalFinanceWorkspace />);
    await screen.findByText('Monthly income and expense tracking');
    fireEvent.click(screen.getByRole('button', { name: 'Goal specifications' }));
    await screen.findByText('New goal specification');
    fireEvent.change(screen.getByLabelText('Your goal name'), { target: { value: 'Practical city car' } });
    fireEvent.change(screen.getByLabelText('Target cost (₹)'), { target: { value: '450000' } });
    fireEvent.change(screen.getByLabelText('Desired date'), { target: { value: '2028-10-23' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save goal specification' }));
    await waitFor(() => expect(api.createGoalSpecification).toHaveBeenCalledOnce());
    expect(api.createGoalSpecification.mock.calls[0][0].targetAmount).toBe(450000);
    expect(api.createGoalSpecification.mock.calls[0][0].kind).toBe('vehicle');
  });
});
