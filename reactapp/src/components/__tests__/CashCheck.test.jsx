/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import CashCheck from '../CashCheck';
import * as api from '../../services/api';

vi.mock('../../services/api', () => ({
  generateUUID: vi.fn(() => 'coverage-test-client-uuid-000001'),
  getCoverageLedger: vi.fn(), saveCoverageLedger: vi.fn(),
  previewCoverageScenario: vi.fn(), deleteCoverageLedger: vi.fn(),
  exportCoverageHistoryPage: vi.fn(),
  getCoverageAlerts: vi.fn(), acknowledgeCoverageAlert: vi.fn(),
  settleCoverageOneOff: vi.fn(), getCoverageSettlements: vi.fn(),
  exportCoverageSettlementPage: vi.fn(),
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
  api.getCoverageAlerts.mockResolvedValue({ revision: 1, alerts: [] });
  api.acknowledgeCoverageAlert.mockResolvedValue({ revision: 1, acknowledged: true });
  api.getCoverageSettlements.mockResolvedValue({ settlements: [] });
  api.exportCoverageSettlementPage.mockResolvedValue({ settlements: [], nextAfterRevision: null });
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
    await waitFor(() => expect(api.deleteCoverageLedger).toHaveBeenCalledWith(1, {
      headers: { 'Idempotency-Key': 'coverage-test-client-uuid-000001' },
    }));
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
    api.saveCoverageLedger.mockRejectedValueOnce(Object.assign(new Error('conflict'), { status: 409, code: 'COVERAGE_REVISION_CONFLICT' }));
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
  it('does not falsely classify history-limit errors as a concurrent edit', async () => {
    api.saveCoverageLedger.mockRejectedValueOnce(Object.assign(
      new Error('Saved cash history has reached its 256-revision limit.'),
      { status: 409, code: 'COVERAGE_HISTORY_LIMIT_REACHED' },
    ));
    render(<CashCheck />);
    await screen.findByRole('heading', { name: '90-day cash check', level: 1 });
    fireEvent.change(screen.getByPlaceholderText('50000.00'), { target: { value: '1000.00' } });
    fireEvent.click(screen.getByRole('button', { name: /save and calculate/i }));
    await screen.findByText(/Saved cash history has reached its 256-revision limit/i);
    expect(screen.queryByRole('region', { name: 'Resolve cash plan conflict' })).toBeNull();
  });

  it('refuses to show a superseded idempotent replay as a current cash result', async () => {
    api.getCoverageLedger.mockResolvedValueOnce({ revision: 0, ledger: null, latestResult: null })
      .mockResolvedValueOnce({
        revision: 3,
        ledger: { asOfDate: indiaToday(), openingCashPaise: 20000,
          cashSource: 'USER_DECLARED_BANK_CASH', completenessConfirmed: true, entries: [] },
        latestResult: { result: baseline() }, requiresCashReconfirmation: false,
      });
    api.saveCoverageLedger.mockResolvedValueOnce({
      revision: 1, result: baseline(), replayed: true, superseded: true, currentRevision: 3,
    });
    render(<CashCheck />);
    await screen.findByRole('heading', { name: '90-day cash check', level: 1 });
    fireEvent.change(screen.getByPlaceholderText('50000.00'), { target: { value: '450.00' } });
    fireEvent.click(screen.getByLabelText(/I have entered the commitments/i));
    fireEvent.click(screen.getByRole('button', { name: /save and calculate/i }));
    await screen.findByRole('region', { name: 'Resolve cash plan conflict' });
    expect(screen.getByPlaceholderText('50000.00').value).toBe('450.00');
    expect(screen.queryByText(/Entries saved and recalculated/i)).toBeNull();
    expect(screen.queryByText(/No shortfall in the entries supplied for these dates/i)).toBeNull();
  });

  it('parses CSV only in the browser and adds historical recurrence as an unsaved opt-in commitment', async () => {
    const today = indiaToday();
    const d = new Date(today + 'T00:00:00Z');
    const anchor = Math.min(15, d.getUTCDate());
    const dates = [2, 1, 0].map(offset =>
      new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - offset, anchor))
        .toISOString().slice(0, 10));
    const csv = 'Date,Description,Debit,Credit,Balance\n'
      + dates.map((day, i) => day + ',Rent for flat,12000.01,,' + (50000 - i * 12000)).join('\n');
    const file = new File([csv], 'statement.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: vi.fn().mockResolvedValue(csv) });
    render(<CashCheck />);
    await screen.findByRole('heading', { name: '90-day cash check', level: 1 });
    fireEvent.change(screen.getByLabelText('Choose bank statement CSV'), { target: { files: [file] } });
    const report = await screen.findByRole('region', { name: 'Statement review' });
    expect(report.textContent).toMatch(/Unverified local statement/);
    expect(report.textContent).toContain('Rent for flat');
    expect(report.textContent).toContain('12,000.01');
    expect(api.saveCoverageLedger).not.toHaveBeenCalled();
    const add = screen.getByRole('button', { name: 'Add reviewed payment to unsaved draft' });
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Confirm payment type'), {
      target: { value: 'CONTRACTUAL_PAYMENT' },
    });
    fireEvent.click(add);
    expect(screen.getByLabelText('Description').value).toBe('Rent for flat');
    expect(screen.getByLabelText('Amount (₹)').value).toBe('12000.01');
    expect(screen.getByLabelText(/I have entered the commitments/i).checked).toBe(false);
    expect(api.saveCoverageLedger).not.toHaveBeenCalled();
    fireEvent.change(screen.getByPlaceholderText('50000.00'), {
      target: { value: '50000.00' },
    });
    fireEvent.click(screen.getByLabelText(/I have entered the commitments/i));
    fireEvent.click(screen.getByRole('button', { name: /save and calculate/i }));
    await waitFor(() => expect(api.saveCoverageLedger).toHaveBeenCalled());
    expect(api.saveCoverageLedger.mock.calls[0][0]).toEqual(expect.objectContaining({
      openingCashPaise: 5000000, completenessConfirmed: true,
      entries: [expect.objectContaining({
        label: 'Rent for flat', amountPaise: 1200001,
        type: 'CONTRACTUAL_PAYMENT', recurrence: 'MONTHLY',
      })],
    }));
  });
  it('blocks unsupported files and does not upload their contents', async () => {
    render(<CashCheck />);
    await screen.findByRole('heading', { name: '90-day cash check', level: 1 });
    const file = new File(['PDF content'], 'statement.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText('Choose bank statement CSV'), { target: { files: [file] } });
    await screen.findByText(/Choose a nonempty \.csv statement of at most 512 KB/i);
    expect(api.saveCoverageLedger).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Statement review' })).toBeNull();
  });
  it('rechecks a newer cash revision on page refocus and displays its risk without claiming live bank data', async () => {
    api.getCoverageLedger.mockResolvedValueOnce({ revision: 0, ledger: null, latestResult: null })
      .mockResolvedValueOnce({
        revision: 1,
        ledger: {
          asOfDate: indiaToday(), openingCashPaise: 10000,
          cashSource: 'USER_DECLARED_BANK_CASH', completenessConfirmed: true, entries: [],
        },
        latestResult: {
          calculatedAt: '2026-10-23T12:00:00.000Z',
          result: { ...baseline(), status: 'SHORTFALL_IN_ENTERED_PLAN',
            baseline: { ...baseline().baseline,
              earliestShortfall: { date: indiaToday(), lowestBalancePaise: -100, dueOutflowEntryIds: [] },
              minWithinDayPaise: -100 },
          },
        },
        requiresCashReconfirmation: false,
      });
    render(<CashCheck />);
    await screen.findByRole('heading', { name: '90-day cash check', level: 1 });
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => expect(api.getCoverageLedger).toHaveBeenCalledTimes(2));
    await screen.findByText(/New saved revision shows a shortfall/i);
    expect(screen.getByRole('region', { name: 'Cash data freshness' }).textContent)
      .toMatch(/does not stream actual bank transactions/i);
  });

  it('removes all saved values after an unauthorized background refresh', async () => {
    api.getCoverageLedger.mockResolvedValueOnce({
      revision: 1,
      ledger: { asOfDate: indiaToday(), openingCashPaise: 820050,
        cashSource: 'USER_DECLARED_BANK_CASH', completenessConfirmed: true, entries: [] },
      latestResult: { result: baseline() }, requiresCashReconfirmation: false,
    }).mockRejectedValueOnce(Object.assign(new Error('Token expired'), { status: 401 }));
    render(<CashCheck />);
    await screen.findByRole('heading', { name: '90-day cash check', level: 1 });
    await screen.findByText(/No shortfall in the entries supplied for these dates/);
    fireEvent(document, new Event('visibilitychange'));
    await screen.findByRole('button', { name: 'Retry loading saved records' });
    expect(screen.queryByPlaceholderText('50000.00')).toBeNull();
    expect(screen.queryByRole('button', { name: /delete my saved cash records/i })).toBeNull();
  });
  it('hides a positive shortfall status when an automatic current-revision check fails', async () => {
    api.getCoverageLedger.mockResolvedValueOnce({
      revision: 1,
      ledger: { asOfDate: indiaToday(), openingCashPaise: 820050,
        cashSource: 'USER_DECLARED_BANK_CASH', completenessConfirmed: true, entries: [] },
      latestResult: { result: baseline() }, requiresCashReconfirmation: false,
    }).mockRejectedValueOnce(new Error('Database unavailable'));
    render(<CashCheck />);
    await screen.findByRole('heading', { name: '90-day cash check', level: 1 });
    await screen.findByText(/No shortfall in the entries supplied for these dates/);
    fireEvent(document, new Event('visibilitychange'));
    await screen.findByText(/latest cash revision could not be verified/i);
    expect(screen.queryByText(/No shortfall in the entries supplied for these dates/)).toBeNull();
  });

  it('reloads a different server cash snapshot even if another account has an identical revision number', async () => {
    api.getCoverageLedger.mockResolvedValueOnce({
      revision: 1,
      ledger: { asOfDate: indiaToday(), openingCashPaise: 10000,
        cashSource: 'USER_DECLARED_BANK_CASH', completenessConfirmed: true, entries: [] },
      latestResult: { inputHash: 'a'.repeat(64), result: baseline() },
      requiresCashReconfirmation: false,
    }).mockResolvedValueOnce({
      revision: 1,
      ledger: { asOfDate: indiaToday(), openingCashPaise: 900000,
        cashSource: 'USER_DECLARED_BANK_CASH', completenessConfirmed: true, entries: [] },
      latestResult: { inputHash: 'b'.repeat(64), result: baseline() },
      requiresCashReconfirmation: false,
    });
    render(<CashCheck />);
    await screen.findByRole('heading', { name: '90-day cash check', level: 1 });
    await screen.findByDisplayValue('100.00');
    fireEvent(document, new Event('visibilitychange'));
    await screen.findByDisplayValue('9000.00');
    expect(api.getCoverageLedger).toHaveBeenCalledTimes(2);
  });

  it('never resurrects a pending old-account CSV import after logout and a new login', async () => {
    const csv = 'Date,Description,Debit,Credit\n2026-09-01,Private old account rent,500,\n';
    let completeRead;
    const delayedRead = new Promise(resolve => { completeRead = resolve; });
    const file = new File([csv], 'private.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: vi.fn(() => delayedRead) });
    api.getCoverageLedger.mockResolvedValueOnce({
      revision: 1, ledger: { asOfDate: indiaToday(), openingCashPaise: 10000,
        cashSource: 'USER_DECLARED_BANK_CASH', completenessConfirmed: true, entries: [] },
      latestResult: { inputHash: 'a'.repeat(64), result: baseline() },
      requiresCashReconfirmation: false,
    }).mockRejectedValueOnce(Object.assign(new Error('Session expired'), { status: 401 }))
      .mockResolvedValueOnce({ revision: 0, ledger: null, latestResult: null });
    render(<CashCheck />);
    await screen.findByRole('heading', { name: '90-day cash check', level: 1 });
    fireEvent.change(screen.getByLabelText('Choose bank statement CSV'), {
      target: { files: [file] },
    });
    await screen.findByText('Reviewing local statement…');
    fireEvent(document, new Event('visibilitychange'));
    await screen.findByRole('button', { name: 'Retry loading saved records' });
    await act(async () => { completeRead(csv); });
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading saved records' }));
    await screen.findByRole('heading', { name: '90-day cash check', level: 1 });
    await screen.findByPlaceholderText('50000.00');
    expect(screen.queryByRole('region', { name: 'Statement review' })).toBeNull();
    expect(screen.queryByText(/Private old account rent/)).toBeNull();
  });

  it('shows durable risk notifications only for the current revision and acknowledges once', async () => {
    const id = '507f191e810c19729de860ea';
    api.getCoverageLedger.mockResolvedValue({
      revision: 1, ledger: {
        asOfDate: indiaToday(), openingCashPaise: 10000,
        cashSource: 'USER_DECLARED_BANK_CASH', completenessConfirmed: true, entries: [],
      }, latestResult: { result: baseline() }, requiresCashReconfirmation: false,
    });
    api.getCoverageAlerts.mockResolvedValue({
      revision: 1, alerts: [{ id, kind: 'SHORTFALL_DETECTED', dueDate: indiaToday(),
        sourceAsOfDate: indiaToday(), acknowledged: false }],
    });
    render(<CashCheck />);
    await screen.findByText('Possible cash shortfall detected');
    const button = screen.getByRole('button', { name: 'Mark alert as reviewed' });
    fireEvent.click(button);
    await waitFor(() => expect(api.acknowledgeCoverageAlert).toHaveBeenCalledWith(id));
    await screen.findByText('Reviewed');
    expect(screen.queryByRole('button', { name: 'Mark alert as reviewed' })).toBeNull();
  });
  it('hides unverifiable alerts rather than displaying stale risk events', async () => {
    api.getCoverageLedger.mockResolvedValue({
      revision: 1, ledger: {
        asOfDate: indiaToday(), openingCashPaise: 10000,
        cashSource: 'USER_DECLARED_BANK_CASH', completenessConfirmed: true, entries: [],
      }, latestResult: { result: baseline() }, requiresCashReconfirmation: false,
    });
    api.getCoverageAlerts.mockRejectedValue(new Error('Backend unavailable'));
    render(<CashCheck />);
    await screen.findByText(/Risk alerts could not be verified/i);
    expect(screen.queryByText('Possible cash shortfall detected')).toBeNull();
  });

  it('requires post-payment cash attestation and never settles an unconfirmed bill', async () => {
    const original = { asOfDate: indiaToday(), openingCashPaise: 20000,
      cashSource: 'USER_DECLARED_BANK_CASH', completenessConfirmed: true,
      entries: [{ id: 'rent', label: 'Rent', type: 'ESSENTIAL_PAYMENT',
        amountPaise: 19000, startDate: indiaToday(), recurrence: 'ONCE' }] };
    api.getCoverageLedger.mockResolvedValueOnce({
      revision: 1, ledger: original, latestResult: { result: baseline() },
    }).mockResolvedValueOnce({
      revision: 2, ledger: { ...original, openingCashPaise: 1000, entries: [] },
      latestResult: { result: baseline() },
    });
    api.settleCoverageOneOff.mockResolvedValue({
      revision: 2, userConfirmedSettlement: true, bankVerified: false,
    });
    render(<CashCheck />);
    await screen.findByRole('heading', { name: '90-day cash check', level: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm this one-time payment is settled' }));
    expect(api.settleCoverageOneOff).not.toHaveBeenCalled();
    fireEvent.change(screen.getByPlaceholderText('Enter current post-payment cash'), {
      target: { value: '10.00' },
    });
    fireEvent.click(screen.getByLabelText(/I confirm this one-off bill is already paid/i));
    fireEvent.click(screen.getByRole('button', { name: 'Record payment and recalculate' }));
    await waitFor(() => expect(api.settleCoverageOneOff).toHaveBeenCalledWith(
      'rent', { asOfDate: indiaToday(), openingCashPaise: 1000,
        completenessConfirmed: true, settlementConfirmed: true }, 1,
      { headers: { 'Idempotency-Key': 'coverage-test-client-uuid-000001' } },
    ));
    await screen.findByText(/one-time payment was marked settled by your confirmation/i);
    expect(screen.queryByRole('button', { name: 'Confirm this one-time payment is settled' })).toBeNull();
    expect(screen.getByPlaceholderText('50000.00').value).toBe('10.00');
  });

});
