/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import HouseholdRunway from '../components/HouseholdRunway.jsx';
import * as api from '../services/api.js';

const today = () => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = type => parts.find(p => p.type === type).value;
  return get('year') + '-' + get('month') + '-' + get('day');
};
const savedLedger = () => ({
  asOfDate: today(), confirmationDate: today(), openingCashPaise: '150000',
  entries: [
    { id: 'rent', label: 'Rent', kind: 'OBLIGATION', amountPaise: '100000',
      date: today(), recurrence: 'NONE' },
  ],
});
const historyItem = {
  snapshotId: 'f'.repeat(64), ledgerRevision: 1, status: 'CURRENT',
  createdAt: new Date().toISOString(), inputHash: 'a'.repeat(64),
};
const emptyHistory = { page: 0, total: 0, hasMore: false, items: [] };
const sampleResult = {
  status: 'READY', asOfDate: today(), scenarios: [{
    scenarioId: 'baseline',
    cashAlreadyAvailable: { status: 'NO_LISTED_SHORTFALL', endBalancePaise: '50000', timingAmbiguities: [] },
    ifExpectedIncomeArrives: {
      status: 'LISTED_SHORTFALL', endBalancePaise: '50000', timingAmbiguities: [],
      firstPossibleShortfall: { date: today(), label: 'Rent', deficitPaise: '30000' },
      firstCertainShortfall: { date: today(), label: 'Rent', deficitPaise: '10000' },
    },
  }],
};
beforeEach(() => {
  vi.spyOn(api, 'getRunwayLiveOverview').mockResolvedValue({
    mode: 'FREE_SELF_MANAGED_NEAR_REAL_TIME', freshness: 'NO_IMPORTED_EVIDENCE',
    observedStatement: null, modeled: { status: 'NO_CONFIRMED_LEDGER' },
  });
  vi.spyOn(api, 'listRunwayStatements').mockResolvedValue({ items: [], maxImports: 30 });
  vi.spyOn(api, 'getRunwayLiveEvents').mockResolvedValue({ items: [], nextCursor: null });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function absentLedger() {
  vi.spyOn(api, 'getRunwayCurrent').mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }));
  vi.spyOn(api, 'listRunwaySnapshots').mockResolvedValue(emptyHistory);
}
describe('Household Runway browser security, money and persistence journey', () => {
  it('does not accept typed cash without explicit acknowledgement, and retries an uncertain save with one key', async () => {
    absentLedger();
    vi.spyOn(api, 'saveRunwayLedger')
      .mockRejectedValueOnce(new Error('Transport failed after server commit'))
      .mockImplementation(async ledger => ({ revision: 1, ledger }));
    render(<HouseholdRunway />);
    const save = screen.getByRole('button', { name: 'Save confirmed ledger' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Available cash (₹)'), { target: { value: '25000.45' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Rent' } });
    fireEvent.change(screen.getByLabelText('Amount (₹)'), { target: { value: '500.10' } });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /I confirmed this amount is accessible today/ }));
    expect(save).not.toBeDisabled();
    fireEvent.click(save);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Transport failed'));
    expect(api.saveRunwayLedger).toHaveBeenCalledTimes(1);
    const firstCall = api.saveRunwayLedger.mock.calls[0];
    expect(firstCall[0].openingCashPaise).toBe('2500045');
    expect(firstCall[0].entries[0].amountPaise).toBe('50010');
    expect(firstCall[1]).toBe(0);
    fireEvent.click(save);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Ledger revision 1 saved'));
    expect(api.saveRunwayLedger).toHaveBeenCalledTimes(2);
    const secondCall = api.saveRunwayLedger.mock.calls[1];
    expect(secondCall[2].headers['Idempotency-Key']).toBe(firstCall[2].headers['Idempotency-Key']);
    expect(secondCall[2].headers['Idempotency-Key']).toMatch(/^e_[A-Za-z0-9_-]+$/);
    expect(save).toBeDisabled();
  });
  it('allows reopening an owner-owned saved result, then requires a second click to delete only that result', async () => {
    vi.spyOn(api, 'getRunwayCurrent').mockResolvedValue({ revision: 1, ledger: savedLedger() });
    vi.spyOn(api, 'listRunwaySnapshots')
      .mockResolvedValueOnce({ page: 0, total: 1, hasMore: false, items: [historyItem] })
      .mockResolvedValue(emptyHistory);
    vi.spyOn(api, 'getRunwaySnapshot').mockResolvedValue({
      result: sampleResult, snapshotId: historyItem.snapshotId, ledgerRevision: 1, status: 'CURRENT',
    });
    vi.spyOn(api, 'deleteRunwaySnapshot').mockResolvedValue({ status: 'DELETED' });
    render(<HouseholdRunway />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'View result' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'View result' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: /Conditional results/ })).toBeInTheDocument());
    expect(screen.getAllByText(/₹500\.00/)).toHaveLength(2);
    expect(screen.getByText(/Listed shortfall even if expected income arrives/)).toBeInTheDocument();
    expect(screen.getByText(/Debit-first shortfall possible/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete result' }));
    expect(api.deleteRunwaySnapshot).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
    await waitFor(() => expect(api.deleteRunwaySnapshot).toHaveBeenCalledWith(historyItem.snapshotId));
    await waitFor(() => expect(screen.getByText('No saved results on this page.')).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: /Conditional results/ })).not.toBeInTheDocument();
  });
  it('rejects a late server ledger load without overwriting active unsaved input', async () => {
    let resolveLoad;
    vi.spyOn(api, 'getRunwayCurrent').mockImplementation(() => new Promise(resolve => { resolveLoad = resolve; }));
    vi.spyOn(api, 'listRunwaySnapshots').mockResolvedValue(emptyHistory);
    render(<HouseholdRunway />);
    const cashInput = screen.getByLabelText('Available cash (₹)');
    fireEvent.change(cashInput, { target: { value: '1234.56' } });
    resolveLoad({ revision: 9, ledger: savedLedger() });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Reload the page before saving/));
    expect(cashInput).toHaveValue('1234.56');
    expect(screen.getByText(/Current revision:/)).toHaveTextContent('Not saved');
  });
  it('renders without automated axe violations other than jsdom-unreliable contrast', async () => {
    absentLedger();
    const { container } = render(<HouseholdRunway />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Household Runway' })).toBeInTheDocument());
    const results = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(results.violations.map(v => ({ id: v.id, impact: v.impact }))).toEqual([]);
  });
});
