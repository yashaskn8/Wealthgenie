/** @vitest-environment jsdom */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import GenieDecisionWorkspace from '../GenieDecisionWorkspace';
import {
  getDecisionAvailability, listDecisionScenarios, getDecisionScenario,
  createDecisionScenario, updateDecisionScenario, evaluateDecisionScenario,
  getDecisionRun, listDecisionRuns, deleteDecisionScenario,
} from '../../services/api';

vi.mock('../../services/api', () => ({
  getDecisionAvailability: vi.fn(), listDecisionScenarios: vi.fn(),
  getDecisionScenario: vi.fn(), createDecisionScenario: vi.fn(),
  updateDecisionScenario: vi.fn(), evaluateDecisionScenario: vi.fn(),
  getDecisionRun: vi.fn(), listDecisionRuns: vi.fn(), deleteDecisionScenario: vi.fn(),
}));

const profileId = '64a000000000000000000001';
const saved = {
  id: '64a000000000000000000004', profileId, scenarioType: 'INCOME_INTERRUPTION',
  revision: 1, title: 'My saved decision', profileStateRevision: 3,
  lastRunId: '64a000000000000000000005',
};
const payload = {
  title: 'My saved decision', scenarioType: 'INCOME_INTERRUPTION',
  horizonMonths: 6,
  baseline: {
    monthlyLivingExpenses: '50000.00', monthlyDebtPayments: '20000.00',
    monthlyInvestments: '20000.00',
  },
  goalReservations: [],
  details: { startMonth: 2, durationMonths: 3, incomeLossPerMonth: '10000.00' },
};
const report = {
  run: {
    id: '64a000000000000000000005', status: 'PARTIAL',
    asOf: '2026-10-23T10:00:00Z',
    result: {
      scenarioType: 'INCOME_INTERRUPTION',
      alternatives: [
        { name: 'Current income', endingProjectedLiquidCash: '100000.00',
          firstCashShortfallMonth: null, rows: [] },
        { name: 'Income interruption', endingProjectedLiquidCash: '70000.00',
          firstCashShortfallMonth: null, rows: [] },
      ],
      alternativeBLiquidCashMinusA: '-30000.00',
      unmodeled: ['Tax and inflation'],
    },
  },
};
describe('GenieDecision workspace red-team integration', () => {
  beforeEach(() => {
    for (const stub of [
      getDecisionAvailability, listDecisionScenarios, getDecisionScenario,
      createDecisionScenario, updateDecisionScenario, evaluateDecisionScenario,
      getDecisionRun, listDecisionRuns, deleteDecisionScenario,
    ]) stub.mockReset();
    getDecisionAvailability.mockResolvedValue({
      available: true, profileId, profileStateRevision: 3,
      openingLiquidCashAvailable: true,
    });
    listDecisionScenarios.mockResolvedValue({ scenarios: [saved] });
    getDecisionScenario.mockResolvedValue({ scenario: saved, payload });
    getDecisionRun.mockResolvedValue(report);
    listDecisionRuns.mockResolvedValue({ runs: [{ id: report.run.id, status: 'PARTIAL', scenarioRevision: 1, asOf: report.run.asOf }] });
    createDecisionScenario.mockResolvedValue({ scenario: { ...saved, lastRunId: null } });
    updateDecisionScenario.mockResolvedValue({ scenario: { ...saved, revision: 2, lastRunId: null } });
    evaluateDecisionScenario.mockResolvedValue(report);
    deleteDecisionScenario.mockResolvedValue({ deleted: true });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('loads a real saved scenario and prevents evaluation of unsaved UI changes', async () => {
    render(<GenieDecisionWorkspace />);
    const savedButton = await screen.findByRole('button', { name: /My saved decision/ });
    fireEvent.click(savedButton);
    const title = await screen.findByDisplayValue('My saved decision');
    await waitFor(() => expect(screen.getByText('Decision comparison')).toBeTruthy());
    const evaluate = screen.getByRole('button', { name: 'Evaluate saved revision' });
    expect(evaluate.disabled).toBe(false);
    fireEvent.change(title, { target: { value: 'Unsaved major edits' } });
    expect(evaluate.disabled).toBe(true);
    expect(screen.getByText(/Unsaved changes detected/)).toBeTruthy();
    expect(evaluateDecisionScenario).not.toHaveBeenCalled();
    fireEvent.change(title, { target: { value: 'My saved decision' } });
    expect(evaluate.disabled).toBe(false);
    fireEvent.click(evaluate);
    await waitFor(() => expect(evaluateDecisionScenario).toHaveBeenCalledWith(
      saved.id, 1,
    ));
  });

  it('lets owners inspect historical decisions when profile readiness cannot be verified', async () => {
    getDecisionAvailability.mockRejectedValueOnce(new Error('canonical pointer unavailable'));
    render(<GenieDecisionWorkspace />);
    expect(await screen.findByText(/Current financial profile readiness is unavailable/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /My saved decision/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save draft' }).disabled).toBe(true);
  });

  it('creates from user-declared money facts, binds the canonical profile and does not invent rates', async () => {
    listDecisionScenarios.mockResolvedValue({ scenarios: [] });
    render(<GenieDecisionWorkspace />);
    await screen.findByText('Your saved decisions will appear here.');
    fireEvent.change(screen.getByLabelText('Monthly living expenses (₹)'), { target: { value: '50000' } });
    fireEvent.change(screen.getByLabelText('Existing total monthly EMI (₹)'), { target: { value: '20000' } });
    fireEvent.change(screen.getByLabelText('Total monthly investments (₹)'), { target: { value: '20000' } });
    fireEvent.change(screen.getByLabelText('Interruption starts in month'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Duration in months'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Monthly income lost (₹)'), { target: { value: '10000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(createDecisionScenario).toHaveBeenCalledTimes(1));
    const [request] = createDecisionScenario.mock.calls[0];
    expect(request.profileId).toBe(profileId);
    expect(request.expectedProfileStateRevision).toBe(3);
    expect(request.baseline.monthlyInvestments).toBe('20000');
    expect(request.details.incomeLossPerMonth).toBe('10000');
    expect(request.details.startMonth).toBe(2);
    expect(request).not.toHaveProperty('assumedMarketReturn');
  });

  it('never enables scenario deletion without explicit user confirmation', async () => {
    render(<GenieDecisionWorkspace />);
    fireEvent.click(await screen.findByRole('button', { name: /My saved decision/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete scenario' })).toBeTruthy());
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: 'Delete scenario' }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(deleteDecisionScenario).not.toHaveBeenCalled();
  });
});
