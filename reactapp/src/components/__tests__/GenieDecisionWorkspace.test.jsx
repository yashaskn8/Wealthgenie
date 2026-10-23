/** @vitest-environment jsdom */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import GenieDecisionWorkspace from '../GenieDecisionWorkspace';
import {
  getDecisionAvailability, listDecisionScenarios, getDecisionScenario,
  createDecisionScenario, updateDecisionScenario, evaluateDecisionScenario,
  getDecisionRun, listDecisionRuns, deleteDecisionScenario, generateUUID, subscribeDecisionEvents,
  simulateDecisionScenario, subscribeAuth, getAuthSnapshot, getDecisionMonitor, setDecisionMonitor,
} from '../../services/api';

vi.mock('../../services/api', () => ({
  getDecisionAvailability: vi.fn(), listDecisionScenarios: vi.fn(),
  getDecisionScenario: vi.fn(), createDecisionScenario: vi.fn(),
  updateDecisionScenario: vi.fn(), evaluateDecisionScenario: vi.fn(),
  getDecisionRun: vi.fn(), listDecisionRuns: vi.fn(), deleteDecisionScenario: vi.fn(),
  generateUUID: vi.fn(), subscribeDecisionEvents: vi.fn(),
  simulateDecisionScenario: vi.fn(), subscribeAuth: vi.fn(), getAuthSnapshot: vi.fn(),
  getDecisionMonitor: vi.fn(), setDecisionMonitor: vi.fn(),
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
      getDecisionRun, listDecisionRuns, deleteDecisionScenario, generateUUID, subscribeDecisionEvents,
      simulateDecisionScenario, subscribeAuth, getAuthSnapshot, getDecisionMonitor, setDecisionMonitor,
    ]) stub.mockReset();
    generateUUID.mockReturnValue('test-decision-idempotency-key-0001');
    subscribeDecisionEvents.mockResolvedValue(undefined);
    subscribeAuth.mockReturnValue(() => {});
    getAuthSnapshot.mockReturnValue(0);
    simulateDecisionScenario.mockResolvedValue({ previewOnly: true, status: 'PARTIAL',
      result: report.run.result });
    getDecisionAvailability.mockResolvedValue({
      available: true, profileId, profileStateRevision: 3,
      openingLiquidCashAvailable: true,
    });
    listDecisionScenarios.mockResolvedValue({ scenarios: [saved] });
    getDecisionScenario.mockResolvedValue({ scenario: saved, payload });
    getDecisionMonitor.mockResolvedValue({
      monitor: { enabled: false, generation: 0, workerConfigured: true }, assessments: [],
    });
    setDecisionMonitor.mockResolvedValue({
      monitor: { enabled: true, generation: 1, workerConfigured: true },
    });
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
      saved.id, 1, { headers: { 'Idempotency-Key': 'test-decision-idempotency-key-0001' } },
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
  it('retries a lost create response using the same durable idempotency receipt', async () => {
    listDecisionScenarios.mockResolvedValue({ scenarios: [] });
    createDecisionScenario.mockRejectedValueOnce(new Error('response unavailable'))
      .mockResolvedValueOnce({ scenario: { ...saved, lastRunId: null } });
    render(<GenieDecisionWorkspace />);
    await screen.findByText('Your saved decisions will appear here.');
    fireEvent.change(screen.getByLabelText('Monthly living expenses (₹)'), { target: { value: '50000' } });
    fireEvent.change(screen.getByLabelText('Existing total monthly EMI (₹)'), { target: { value: '20000' } });
    fireEvent.change(screen.getByLabelText('Total monthly investments (₹)'), { target: { value: '20000' } });
    fireEvent.change(screen.getByLabelText('Interruption starts in month'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Duration in months'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Monthly income lost (₹)'), { target: { value: '10000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('response unavailable')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(createDecisionScenario).toHaveBeenCalledTimes(2));
    const first = createDecisionScenario.mock.calls[0];
    const second = createDecisionScenario.mock.calls[1];
    expect(second[0]).toEqual(first[0]);
    expect(second[1].headers['Idempotency-Key']).toBe(first[1].headers['Idempotency-Key']);
    expect(generateUUID).toHaveBeenCalledTimes(1);
  });

  it('retries evaluation with its original receipt after network failure', async () => {
    evaluateDecisionScenario.mockRejectedValueOnce(new Error('evaluation response lost'))
      .mockResolvedValueOnce(report);
    render(<GenieDecisionWorkspace />);
    fireEvent.click(await screen.findByRole('button', { name: /My saved decision/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Evaluate saved revision' }).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Evaluate saved revision' }));
    expect(await screen.findByText('evaluation response lost')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Evaluate saved revision' }));
    await waitFor(() => expect(evaluateDecisionScenario).toHaveBeenCalledTimes(2));
    const first = evaluateDecisionScenario.mock.calls[0];
    const second = evaluateDecisionScenario.mock.calls[1];
    expect(first[2].headers['Idempotency-Key']).toBe(second[2].headers['Idempotency-Key']);
    expect(generateUUID).toHaveBeenCalledTimes(1);
  });

  it('requires explicit monitoring opt-in and allows the user to opt out', async () => {
    render(<GenieDecisionWorkspace />);
    fireEvent.click(await screen.findByRole('button', { name: /My saved decision/ }));
    const enable = await screen.findByRole('button', { name: 'Enable monitoring' });
    expect(setDecisionMonitor).not.toHaveBeenCalled();
    fireEvent.click(enable);
    await waitFor(() => expect(setDecisionMonitor).toHaveBeenCalledWith(saved.id, true, 1));
    expect(await screen.findByRole('button', { name: 'Disable monitoring' })).toBeTruthy();
    setDecisionMonitor.mockResolvedValueOnce({
      monitor: { enabled: false, generation: 2, workerConfigured: true },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Disable monitoring' }));
    await waitFor(() => expect(setDecisionMonitor).toHaveBeenCalledWith(saved.id, false, 1));
  });

  it('never displays a forged result when reassessment asks for a new budget', async () => {
    getDecisionMonitor.mockResolvedValue({
      monitor: { enabled: true, generation: 1, workerConfigured: true },
      assessments: [{
        id: 'assessment-1', originalStatus: 'NEEDS_REVIEW', status: 'NEEDS_REVIEW',
        isCurrent: true, asOf: '2026-10-23T10:00:00Z', result: null,
      }],
    });
    render(<GenieDecisionWorkspace />);
    fireEvent.click(await screen.findByRole('button', { name: /My saved decision/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Needs review/ }));
    expect(screen.getByText(/Your newer financial facts no longer reconcile/)).toBeTruthy();
    expect(setDecisionMonitor).not.toHaveBeenCalled();
  });

});
