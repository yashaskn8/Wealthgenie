/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as api from '../services/api.js';
import RunwayLiveEvidence from '../components/RunwayLiveEvidence.jsx';

const today = () => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const v = name => parts.find(x => x.type === name).value;
  return v('year') + '-' + v('month') + '-' + v('day');
};
const statement = () => ({
  statementId: 'a'.repeat(64), accountLabel: 'Salary account',
  periodStart: today(), periodEnd: today(), closingBalancePaise: '12500',
  transactionCount: 1, verification: 'USER_IMPORTED_UNVERIFIED',
});
function common({ imported = null } = {}) {
  vi.spyOn(api, 'getRunwayLiveOverview').mockResolvedValue({
    mode: 'FREE_SELF_MANAGED_NEAR_REAL_TIME', bankConnected: false,
    freshness: imported ? 'UPLOADED_TODAY_UNVERIFIED' : 'NO_IMPORTED_EVIDENCE',
    observedStatement: imported,
    modeled: { status: 'READY', baseline: {
      cashAlreadyAvailable: { endBalancePaise: '-2000', firstCertainShortfall: null },
      ifExpectedIncomeArrives: { endBalancePaise: '8000' },
    } },
  });
  vi.spyOn(api, 'listRunwayStatements').mockResolvedValue({
    items: imported ? [imported] : [], maxImports: 30,
  });
  vi.spyOn(api, 'getRunwayLiveEvents').mockResolvedValue({ items: [], nextCursor: null });
  vi.spyOn(api, 'getRunwayAlerts').mockResolvedValue({ status: 'NO_ALERT_FOR_CURRENT_REVISION', items: [] });
  vi.spyOn(api, 'getRunwayAccountObservations').mockResolvedValue({
    items: imported ? [{ ...imported, accountNickname: imported.accountLabel,
      asOfDate: imported.periodEnd, evidenceStatus: 'USER_IMPORTED_UNVERIFIED',
      freshness: 'HISTORICAL_OBSERVATION' }] : [],
    householdTotalPaise: null, independentlyVerified: false,
    potentiallyOverlappingNicknames: [],
  });
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it('CSV import requires a saved ledger, uploads only text, and never claims real bank verification', async () => {
  common();
  const onChooseCash = vi.fn();
  vi.spyOn(api, 'importRunwayStatement').mockResolvedValue({ ...statement(), replayed: false });
  const { rerender } = render(<RunwayLiveEvidence canImport={false} onChooseCash={onChooseCash} />);
  await waitFor(() => expect(screen.getByText(/No statement imported/)).toBeInTheDocument());
  expect(screen.getByText(/not connected to a bank/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Import and validate statement' })).toBeDisabled();
  rerender(<RunwayLiveEvidence canImport onChooseCash={onChooseCash} />);
  fireEvent.click(screen.getByText(/Import a bank statement CSV/));
  fireEvent.change(screen.getByLabelText(/Account nickname/), { target: { value: 'Salary account' } });
  const csv = 'date,description,debit,credit,balance,reference\n'
    + today() + ',Salary,0,125.00,125.00,abc';
  const file = new File([csv], 'statement.csv', { type: 'text/csv' });
  Object.defineProperty(file, 'text', { value: async () => csv });
  fireEvent.change(screen.getByLabelText('Statement CSV'), { target: { files: [file] } });
  fireEvent.click(screen.getByRole('button', { name: 'Import and validate statement' }));
  await waitFor(() => expect(api.importRunwayStatement).toHaveBeenCalledWith('Salary account', csv));
  expect(onChooseCash).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/not bank-verified/));
});
it('only explicitly offers importing a same-day nonnegative balance as unconfirmed cash', async () => {
  const sample = statement();
  common({ imported: sample });
  const onChooseCash = vi.fn();
  render(<RunwayLiveEvidence canImport onChooseCash={onChooseCash} />);
  await waitFor(() => expect(screen.getByText(/UPLOADED_TODAY_UNVERIFIED/)).toBeInTheDocument());
  expect(screen.getByText(/No future income counted/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Copy today's observed balance/ }));
  expect(onChooseCash).toHaveBeenCalledOnce();
  expect(onChooseCash).toHaveBeenCalledWith('12500');
});
it('stale statements cannot be offered as current available cash', async () => {
  common({ imported: { ...statement(), periodEnd: '2026-01-01' } });
  render(<RunwayLiveEvidence canImport onChooseCash={vi.fn()} />);
  await waitFor(() => expect(screen.getAllByText(/2026-01-01/).length).toBeGreaterThan(0));
  expect(screen.queryByRole('button', { name: /Copy today's observed balance/ })).not.toBeInTheDocument();
});

it('requires explicit cash reconfirmation and retries an uncertain settlement with one key', async () => {
  common({ imported: statement() });
  const match = { statementId: 'a'.repeat(64), rowIndex: 0, entryId: 'rent',
    entryLabel: 'Rent', date: today(), amountPaise: '1500000',
    status: 'UNIQUE_POSSIBLE_MATCH' };
  vi.spyOn(api, 'getRunwayReconciliationMatches').mockResolvedValue({
    revision: 1, status: 'REVIEW_REQUIRED', items: [match],
  });
  vi.spyOn(api, 'confirmRunwaySettlement')
    .mockRejectedValueOnce(new Error('Response lost after financial commit'))
    .mockResolvedValueOnce({ revision: 2, replayed: true });
  const applied = vi.fn();
  render(<RunwayLiveEvidence canImport canSettle onSettlementApplied={applied}
    onChooseCash={vi.fn()} />);
  fireEvent.click(screen.getByText('Review possible posted payments or received salary'));
  fireEvent.click(screen.getByRole('button', { name: 'Find possible matches' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Review this match' })).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'Review this match' }));
  const confirm = screen.getByRole('button', { name: 'Confirm and update ledger' });
  expect(confirm).toBeDisabled();
  fireEvent.change(screen.getByLabelText(/Total available household cash after posting/),
    { target: { value: '35000.00' } });
  expect(confirm).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: /independently reconfirmed the accessible/ }));
  fireEvent.click(confirm);
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Response lost/));
  expect(api.confirmRunwaySettlement).toHaveBeenCalledTimes(1);
  const first = api.confirmRunwaySettlement.mock.calls[0];
  expect(first[0]).toEqual({
    ledgerRevision: 1, statementId: match.statementId, rowIndex: 0, entryId: 'rent',
    openingCashPaise: '3500000',
    confirmation: 'I_RECONFIRM_HOUSEHOLD_CASH_AFTER_TRANSACTION',
  });
  fireEvent.click(confirm);
  await waitFor(() => expect(api.confirmRunwaySettlement).toHaveBeenCalledTimes(2));
  const second = api.confirmRunwaySettlement.mock.calls[1];
  expect(second[1].headers['Idempotency-Key']).toBe(first[1].headers['Idempotency-Key']);
  await waitFor(() => expect(applied).toHaveBeenCalledWith({ revision: 2, replayed: true }));
});
it('blocks ambiguous matches rather than presenting a confirm action', async () => {
  common({ imported: statement() });
  vi.spyOn(api, 'getRunwayReconciliationMatches').mockResolvedValue({
    revision: 1, status: 'REVIEW_REQUIRED',
    items: [{ statementId: 'a'.repeat(64), rowIndex: 0, entryId: 'rent',
      entryLabel: 'Rent', amountPaise: '1500000', date: today(),
      status: 'AMBIGUOUS_REQUIRES_MANUAL_EDIT' }],
  });
  render(<RunwayLiveEvidence canImport canSettle onChooseCash={vi.fn()} />);
  fireEvent.click(screen.getByText('Review possible posted payments or received salary'));
  fireEvent.click(screen.getByRole('button', { name: 'Find possible matches' }));
  await waitFor(() => expect(screen.getByText(/Ambiguous — edit ledger manually/)).toBeInTheDocument());
  expect(screen.queryByRole('button', { name: 'Review this match' })).not.toBeInTheDocument();
});

it('renders durable shortfall warning without representing self-reported cash as bank verified', async () => {
  common();
  api.getRunwayAlerts.mockResolvedValue({
    status: 'CURRENT_USER_DECLARED_RISK',
    items: [{
      alertId: 'b'.repeat(64), kind: 'LISTED_CASH_SHORTFALL', revision: 3,
      date: today(), deficitPaise: '150012',
    }],
  });
  render(<RunwayLiveEvidence canImport onChooseCash={vi.fn()} />);
  await waitFor(() => expect(screen.getByText(/Review listed-payment shortfall/)).toBeInTheDocument());
  expect(screen.getByText(/bank-confirmed prediction/)).toBeInTheDocument();
  expect(screen.getByText(/₹1,500.12/)).toBeInTheDocument();
});

it('red-team: failed optional alerts and account feeds cannot freeze core financial overview', async () => {
  common({ imported: statement() });
  api.getRunwayAlerts.mockRejectedValue(new Error('Alert backend unavailable'));
  api.getRunwayAccountObservations.mockRejectedValue(new Error('Account view unavailable'));
  render(<RunwayLiveEvidence canImport onChooseCash={vi.fn()} />);
  await waitFor(() => expect(screen.getByText(/UPLOADED_TODAY_UNVERIFIED/)).toBeInTheDocument());
  expect(screen.getByText(/Risk alert verification unavailable/)).toBeInTheDocument();
  expect(screen.getByText(/Separate account observations are temporarily unavailable/))
    .toBeInTheDocument();
  expect(screen.getByText(/No future income counted/)).toBeInTheDocument();
});
it('red-team: unavailable core financial response cannot preserve apparently current old figures', async () => {
  common({ imported: statement() });
  api.getRunwayLiveOverview.mockRejectedValue(new Error('Core ledger unavailable'));
  render(<RunwayLiveEvidence canImport onChooseCash={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole('alert'))
    .toHaveTextContent(/Values were cleared/));
  expect(screen.queryByText(/UPLOADED_TODAY_UNVERIFIED/)).not.toBeInTheDocument();
});

it('red-team: committed import followed by failed refresh is never misreported as rejected', async () => {
  common();
  const onChooseCash = vi.fn();
  vi.spyOn(api, 'importRunwayStatement').mockResolvedValue({ ...statement(), replayed: false });
  render(<RunwayLiveEvidence canImport onChooseCash={onChooseCash} />);
  await waitFor(() => expect(screen.getByText(/No statement imported/)).toBeInTheDocument());
  api.listRunwayStatements.mockRejectedValueOnce(new Error('Temporary read outage'));
  fireEvent.click(screen.getByText(/Import a bank statement CSV/));
  fireEvent.change(screen.getByLabelText(/Account nickname/),
    { target: { value: 'Salary account' } });
  const csv = 'date,description,debit,credit,balance,reference\n'
    + today() + ',Salary,0,125.00,125.00,abc';
  const file = new File([csv], 'statement.csv', { type: 'text/csv' });
  Object.defineProperty(file, 'text', { value: async () => csv });
  fireEvent.change(screen.getByLabelText('Statement CSV'), { target: { files: [file] } });
  fireEvent.click(screen.getByRole('button', { name: 'Import and validate statement' }));
  await waitFor(() => expect(api.importRunwayStatement).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByRole('alert'))
    .toHaveTextContent(/Statement import committed, but the financial screen could not refresh/));
  expect(screen.getByText(/Statement imported and every running balance reconciled/))
    .toBeInTheDocument();
  expect(onChooseCash).not.toHaveBeenCalled();
});
