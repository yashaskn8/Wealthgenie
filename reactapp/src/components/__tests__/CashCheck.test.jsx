/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import CashCheck from '../CashCheck';
import * as api from '../../services/api';

vi.mock('../../services/api', () => ({
  generateUUID: vi.fn(() => 'coverage-test-client-uuid-000001'),
  getCoverageLedger: vi.fn(), saveCoverageLedger: vi.fn(),
  previewCoverageScenario: vi.fn(), deleteCoverageLedger: vi.fn(),
  exportCoverageHistoryPage: vi.fn(),
}));

const baseline = () => ({
  status: 'NO_SHORTFALL_IN_ENTERED_PLAN', missingInputCodes: [],
  baseline: { minWithinDayPaise: 100000, closingBalancePaise: 100000, earliestShortfall: null, daily: [] },
  noExpectedIncome: { earliestShortfall: null },
});
const indiaToday = () => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.filter(v => v.type !== 'literal').map(v => [v.type, v.value]));
  return p.year + '-' + p.month + '-' + p.day;
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getCoverageLedger.mockResolvedValue({ revision: 0, ledger: null, latestResult: null });
  api.saveCoverageLedger.mockResolvedValue({ revision: 1, result: baseline() });
  api.deleteCoverageLedger.mockResolvedValue({ deleted: true, deletedRevision: 1, nextRevision: 2 });
});
afterEach(cleanup);

describe('90-day cash check', () => {
  it('saves exact paise and hides old results as soon as the user edits', async () => {
    render(<CashCheck />);
    await screen.findByRole('heading', { name: '90-day cash check', level: 1 });
    fireEvent.change(screen.getByPlaceholderText('50000.00'), { target: { value: '1000.01' } });
    fireEvent.click(screen.getByRole('button', { name: /add entry/i }));
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Rent' } });
    fireEvent.change(screen.getByLabelText('Amount (₹)'), { target: { value: '400.25' } });
    fireEvent.click(screen.getByLabelText(/I have entered the commitments/i));
    fireEvent.click(screen.getByRole('button', { name: /save and calculate/i }));
    await waitFor(() => expect(api.saveCoverageLedger).toHaveBeenCalledWith(
      expect.objectContaining({
        openingCashPaise: 100001,
        entries: [expect.objectContaining({ label: 'Rent', amountPaise: 40025 })],
      }), 0, { headers: { 'Idempotency-Key': 'coverage-test-client-uuid-000001' } },
    ));
    await screen.findByText(/Entries saved and recalculated/i);
    expect(screen.getByText(/No shortfall in the entries supplied for these dates/i)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('50000.00'), { target: { value: '2000.00' } });
    expect(screen.getByText(/Unsaved edits: the previous result is hidden/i)).toBeTruthy();
    expect(screen.queryByText(/No shortfall in the entries supplied for these dates/i)).toBeNull();
  });

  it('suppresses an old positive result until cash is reconfirmed', async () => {
    api.getCoverageLedger.mockResolvedValue({
      revision: 4, ledger: {
        asOfDate: '2020-01-01', openingCashPaise: 10000,
        cashSource: 'USER_DECLARED_BANK_CASH', completenessConfirmed: true, entries: [],
      },
      latestResult: { result: baseline() }, requiresCashReconfirmation: true,
    });
    render(<CashCheck />);
    await screen.findByRole('heading', { name: '90-day cash check', level: 1 });
    expect(screen.getByText(/Saved cash entries are out of date/i)).toBeTruthy();
    expect(screen.queryByText(/No shortfall in the entries supplied for these dates/i)).toBeNull();
  });

  it('uses the surviving tombstone revision after explicit data deletion', async () => {
    api.getCoverageLedger.mockResolvedValue({
      revision: 1, ledger: {
        asOfDate: indiaToday(), openingCashPaise: 10000,
        cashSource: 'USER_DECLARED_BANK_CASH', completenessConfirmed: true, entries: [],
      },
      latestResult: { result: baseline() }, requiresCashReconfirmation: false,
    });
    render(<CashCheck />);
    await screen.findByRole('heading', { name: '90-day cash check', level: 1 });
    fireEvent.click(screen.getByLabelText(/I understand this permanently removes/i));
    fireEvent.click(screen.getByRole('button', { name: /delete my saved cash records/i }));
    await waitFor(() => expect(api.deleteCoverageLedger).toHaveBeenCalledWith(1));
    expect(screen.getByText(/Revision 2/)).toBeTruthy();
    expect(screen.queryByText(/No shortfall in the entries supplied for these dates/i)).toBeNull();
  });
  it('reuses the identical idempotency key after a failed network response', async () => {
    api.saveCoverageLedger.mockRejectedValueOnce(new Error('Network response lost'))
      .mockResolvedValueOnce({ revision: 1, result: baseline() });
    render(<CashCheck />);
    await screen.findByRole('heading', { name: '90-day cash check', level: 1 });
    fireEvent.change(screen.getByPlaceholderText('50000.00'), { target: { value: '200.00' } });
    fireEvent.click(screen.getByLabelText(/I have entered the commitments/i));
    fireEvent.click(screen.getByRole('button', { name: /save and calculate/i }));
    await screen.findByText(/Network response lost/i);
    fireEvent.click(screen.getByRole('button', { name: /save and calculate/i }));
    await waitFor(() => expect(api.saveCoverageLedger).toHaveBeenCalledTimes(2));
    expect(api.saveCoverageLedger.mock.calls[1][2].headers['Idempotency-Key']).toBe(
      api.saveCoverageLedger.mock.calls[0][2].headers['Idempotency-Key'],
    );
    await screen.findByText(/Entries saved and recalculated/i);
  });

  it('blocks all edits when the initial private ledger fetch fails, then offers retry', async () => {
    api.getCoverageLedger.mockRejectedValueOnce(new Error('Mongo unavailable'))
      .mockResolvedValueOnce({ revision: 0, ledger: null, latestResult: null });
    render(<CashCheck />);
    await screen.findByRole('button', { name: 'Retry loading saved records' });
    expect(screen.queryByRole('button', { name: /save and calculate/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading saved records' }));
    await screen.findByRole('button', { name: /save and calculate/i });
  });

  it('reuses one deletion operation key on response loss and clears the plan after replay', async () => {
    api.getCoverageLedger.mockResolvedValue({
      revision: 1, ledger: {
        asOfDate: indiaToday(), openingCashPaise: 10000,
        cashSource: 'USER_DECLARED_BANK_CASH', completenessConfirmed: true, entries: [],
      }, latestResult: { result: baseline() }, requiresCashReconfirmation: false,
    });
    api.deleteCoverageLedger.mockRejectedValueOnce(new Error('Network response lost'))
      .mockResolvedValueOnce({ deleted: true, deletedRevision: 1, nextRevision: 2 });
    render(<CashCheck />);
    await screen.findByRole('heading', { name: '90-day cash check', level: 1 });
    fireEvent.click(screen.getByLabelText(/I understand this permanently removes/i));
    fireEvent.click(screen.getByRole('button', { name: /delete my saved cash records/i }));
    await screen.findByText(/Network response lost/i);
    fireEvent.click(screen.getByRole('button', { name: /delete my saved cash records/i }));
    await waitFor(() => expect(api.deleteCoverageLedger).toHaveBeenCalledTimes(2));
    expect(api.deleteCoverageLedger.mock.calls[1][1].headers['Idempotency-Key']).toBe(
      api.deleteCoverageLedger.mock.calls[0][1].headers['Idempotency-Key'],
    );
    await screen.findByText(/saved cash entries and calculations deleted/i);
    expect(screen.queryByRole('button', { name: /delete my saved cash records/i })).toBeNull();
  });

  it('fails export closed when another tab changes the ledger mid-download', async () => {
    const currentLedger = {
      asOfDate: indiaToday(), openingCashPaise: 10000,
      cashSource: 'USER_DECLARED_BANK_CASH', completenessConfirmed: true, entries: [],
    };
    api.getCoverageLedger.mockResolvedValueOnce({
      revision: 1, ledger: currentLedger, latestResult: { result: baseline() },
      requiresCashReconfirmation: false,
    }).mockResolvedValueOnce({ revision: 1, ledger: currentLedger })
      .mockResolvedValueOnce({ revision: 2, ledger: currentLedger });
    api.exportCoverageHistoryPage.mockResolvedValue({
      records: [{ revision: 1, input: currentLedger }], nextAfterRevision: null,
    });
    render(<CashCheck />);
    await screen.findByRole('heading', { name: '90-day cash check', level: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Download saved history' }));
    await screen.findByText(/Export cancelled to prevent a mixed history/i);
  });
  it('formats near-maximum exact paise and negative shortfalls without floating-point rounding', async () => {
    const nearMax = 9007199254740991;
    api.getCoverageLedger.mockResolvedValue({
      revision: 1, ledger: {
        asOfDate: indiaToday(), openingCashPaise: 10000,
        cashSource: 'USER_DECLARED_BANK_CASH', completenessConfirmed: true, entries: [],
      },
      latestResult: { result: {
        ...baseline(),
        baseline: { ...baseline().baseline, minWithinDayPaise: -987, closingBalancePaise: nearMax },
      } },
      requiresCashReconfirmation: false,
    });
    render(<CashCheck />);
    await screen.findByRole('heading', { name: '90-day cash check', level: 1 });
    expect(screen.getByText('-₹9.87')).toBeTruthy();
    expect(screen.getByText(/409\.91$/)).toBeTruthy();
    expect(screen.queryByText(/409\.90$/)).toBeNull();
  });


  it('never auto-overwrites another tab and requires explicit conflict reconciliation', async () => {
    api.saveCoverageLedger.mockRejectedValueOnce(Object.assign(new Error('conflict'), { status: 409 }));
    api.getCoverageLedger.mockResolvedValueOnce({ revision: 0, ledger: null, latestResult: null })
      .mockResolvedValueOnce({
        revision: 2,
        ledger: { asOfDate: indiaToday(), openingCashPaise: 70000,
          cashSource: 'USER_DECLARED_BANK_CASH', completenessConfirmed: true, entries: [] },
        latestResult: { result: baseline() }, requiresCashReconfirmation: false,
      });
    render(<CashCheck />);
    await screen.findByRole('heading', { name: '90-day cash check', level: 1 });
    fireEvent.change(screen.getByPlaceholderText('50000.00'), { target: { value: '200.00' } });
    fireEvent.click(screen.getByLabelText(/I have entered the commitments/i));
    fireEvent.click(screen.getByRole('button', { name: /save and calculate/i }));
    await screen.findByRole('region', { name: 'Resolve cash plan conflict' });
    expect(screen.getByText(/Your unsaved draft was based on revision 0/)).toBeTruthy();
    const useLocal = screen.getByRole('button', { name: /Use reviewed local draft for next save/i });
    expect(useLocal.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/I reviewed both versions/));
    fireEvent.click(useLocal);
    expect(screen.queryByRole('region', { name: 'Resolve cash plan conflict' })).toBeNull();
    expect(screen.getByPlaceholderText('50000.00').value).toBe('200.00');
    api.saveCoverageLedger.mockResolvedValue({ revision: 3, result: baseline() });
    fireEvent.click(screen.getByRole('button', { name: /save and calculate/i }));
    await waitFor(() => expect(api.saveCoverageLedger).toHaveBeenCalledTimes(2));
    expect(api.saveCoverageLedger.mock.calls[1][1]).toBe(2);
  });

});
