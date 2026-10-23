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
