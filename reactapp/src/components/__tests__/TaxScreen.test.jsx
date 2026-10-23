import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import TaxScreen from '../TaxScreen';
import NewRegimeTaxScreen from '../NewRegimeTaxScreen';
import api from '../../services/api';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('retired TaxScreen import path preserves new-only contract', () => {
  it('is an exact alias to the verified new-regime calculator, not a legacy comparison implementation', () => {
    expect(TaxScreen).toBe(NewRegimeTaxScreen);
  });

  it('has no old-regime selection and never requests old/new comparison on initial render', () => {
    const legacy = vi.spyOn(api, 'compareTax').mockRejectedValue(new Error('RETIRED'));
    const verified = vi.spyOn(api, 'computeVerifiedNewRegimeTax').mockResolvedValue({});
    render(<TaxScreen />);
    expect(screen.getByRole('heading', { name: 'Income Tax Calculator' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Old Regime/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /Old Regime/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Old Regime/i })).not.toBeInTheDocument();
    expect(legacy).not.toHaveBeenCalled();
    expect(verified).not.toHaveBeenCalled();
  });

  it('never interprets an unconfirmed input as old regime or calls the comparison API', async () => {
    const old = vi.spyOn(api, 'compareTax').mockRejectedValue(new Error('RETIRED'));
    const verified = vi.spyOn(api, 'computeVerifiedNewRegimeTax').mockResolvedValue({});
    render(<TaxScreen />);
    fireEvent.change(screen.getByLabelText('Income category'), { target: { value: 'salary' } });
    fireEvent.change(screen.getByLabelText(/Annual taxable gross salary.*before standard deduction/i), {
      target: { value: '1275000.00' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Calculate income tax/i }));
    await Promise.resolve();
    expect(old).not.toHaveBeenCalled();
    expect(verified).not.toHaveBeenCalled();
  });

  it('submits only explicit, fully qualified TY2026-27 facts through the verified tax endpoint', async () => {
    const old = vi.spyOn(api, 'compareTax').mockRejectedValue(new Error('RETIRED'));
    const verified = vi.spyOn(api, 'computeVerifiedNewRegimeTax').mockResolvedValue({
      status: 'UNAVAILABLE', taxYear: '2026-27',
      policyVersion: 'verified-simple-new-regime-TY2026-27-v1',
      unavailableReasons: ['SAMPLE_UNQUALIFIED_FACTS'],
    });
    render(<TaxScreen />);
    fireEvent.change(screen.getByLabelText('Income category'), { target: { value: 'salary' } });
    fireEvent.change(screen.getByLabelText(/Annual taxable gross salary.*before standard deduction/i), {
      target: { value: '1275000.00' },
    });
    fireEvent.change(screen.getByLabelText('Additional ordinary-rate taxable income (₹)'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText(/Residential status/i), { target: { value: 'resident' } });
    fireEvent.change(screen.getByLabelText(/Any special-rate income or dividends/i), { target: { value: 'no' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /I confirm this is a single-individual/i }));
    fireEvent.click(screen.getByRole('button', { name: /Calculate income tax/i }));
    await waitFor(() => expect(verified).toHaveBeenCalledOnce());
    const payload = verified.mock.calls[0][0];
    expect(payload.taxYear).toBe('2026-27');
    expect(payload.primaryIncome).toBe('1275000.00');
    expect(payload.otherOrdinaryIncome).toBe('0');
    expect(payload.confirmedOrdinaryOnly).toBe(true);
    expect(payload).not.toHaveProperty('regime');
    expect(old).not.toHaveBeenCalled();
    expect(screen.queryByText(/Estimated tax liability under the new regime/i)).not.toBeInTheDocument();
  });
});
