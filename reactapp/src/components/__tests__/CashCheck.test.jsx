/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import CashCheck from '../CashCheck';
import * as api from '../../services/api';

vi.mock('../../services/api', () => ({
  getCoverageLedger: vi.fn(), saveCoverageLedger: vi.fn(),
  previewCoverageScenario: vi.fn(), deleteCoverageLedger: vi.fn(),
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
    await screen.findByRole('heading', { name: '90-day cash check' });
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
      }), 0,
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
    await screen.findByRole('heading', { name: '90-day cash check' });
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
    await screen.findByRole('heading', { name: '90-day cash check' });
    fireEvent.click(screen.getByLabelText(/I understand this permanently removes/i));
    fireEvent.click(screen.getByRole('button', { name: /delete my saved cash records/i }));
    await waitFor(() => expect(api.deleteCoverageLedger).toHaveBeenCalledWith(1));
    expect(screen.getByText(/Revision 2/)).toBeTruthy();
    expect(screen.queryByText(/No shortfall in the entries supplied for these dates/i)).toBeNull();
  });
});
