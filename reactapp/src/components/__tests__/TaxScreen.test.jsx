import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import TaxScreen from '../TaxScreen';
import api from '../../services/api';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('TaxScreen request binding', () => {
  it('does not treat the initial income display as an explicit zero-income entry', async () => {
    vi.spyOn(api, 'getTaxPolicyMetadata').mockResolvedValue({
      currentFiscalYearVerified: true,
      currentFiscalYear: 'FY2026-27',
      verifiedFiscalYears: ['FY2026-27'],
    });
    vi.spyOn(api, 'compareTax').mockResolvedValue({});

    render(<TaxScreen profile={{ age: 35 }} recommendations={[]} />);
    await waitFor(() => expect(screen.getByLabelText('Fiscal year for tax calculation')).toHaveValue('FY2026-27'));
    fireEvent.change(screen.getByLabelText('Income source for tax calculation'), { target: { value: 'salary' } });
    await new Promise(resolve => setTimeout(resolve, 500));

    expect(api.compareTax).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Enter yearly income amount'), { target: { value: '0' } });
    await waitFor(() => expect(api.compareTax).toHaveBeenCalledTimes(1));
    expect(api.compareTax).toHaveBeenCalledWith(
      0,
      expect.objectContaining({ incomeSource: 'salary', fiscalYear: 'FY2026-27' }),
      expect.any(Object),
    );
  });

  it('hides a verified tax result immediately when its income inputs change', async () => {
    let finishComparison;
    vi.spyOn(api, 'getTaxPolicyMetadata').mockResolvedValue({
      currentFiscalYearVerified: true,
      currentFiscalYear: 'FY2026-27',
      verifiedFiscalYears: ['FY2026-27'],
    });
    vi.spyOn(api, 'compareTax').mockImplementation(() => new Promise(resolve => {
      finishComparison = resolve;
    }));

    render(<TaxScreen profile={{ age: 35 }} recommendations={[]} />);
    await waitFor(() => expect(screen.getByLabelText('Fiscal year for tax calculation')).toHaveValue('FY2026-27'));
    fireEvent.change(screen.getByLabelText('Income source for tax calculation'), { target: { value: 'salary' } });
    fireEvent.change(screen.getByLabelText('Enter yearly income amount'), { target: { value: '0' } });
    await waitFor(() => expect(api.compareTax).toHaveBeenCalledTimes(1));

    finishComparison({
      fiscal_year: 'FY2026-27',
      verified: true,
      saving: 0,
      recommended_regime: 'new',
      new_regime: { tax: 0, taxable_income: 0, effective_rate: 0, standard_deduction: 0, slab_breakdown: [], marginal_relief_applied: false },
      old_regime: { tax: 0, taxable_income: 0, effective_rate: 0, standard_deduction: 0, slab_breakdown: [], marginal_relief_applied: false },
      deduction_limits: {},
      remaining_deductions: {},
    });

    await waitFor(() => expect(screen.getByText('FY2026-27 · Verified Server Rules')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Enter yearly income amount'), { target: { value: '50000' } });

    expect(screen.queryByText('FY2026-27 · Verified Server Rules')).not.toBeInTheDocument();
    expect(screen.getByText('The authoritative tax service is calculating your comparison.')).toBeInTheDocument();
  });

  it('shows a retryable tax-policy metadata error and does not accept an unverified year', async () => {
    const metadata = vi.spyOn(api, 'getTaxPolicyMetadata')
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce({
        currentFiscalYearVerified: true,
        currentFiscalYear: 'FY2026-27',
        verifiedFiscalYears: ['FY2026-27'],
      });
    vi.spyOn(api, 'compareTax').mockResolvedValue({});

    render(<TaxScreen profile={{ age: 35 }} recommendations={[]} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/verified tax-year information could not be loaded/i);
    expect(screen.getByLabelText('Fiscal year for tax calculation')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry tax policy loading' }));

    await waitFor(() => expect(metadata).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByLabelText('Fiscal year for tax calculation')).toHaveValue('FY2026-27'));
    expect(api.compareTax).not.toHaveBeenCalled();
  });
});
