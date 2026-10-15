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
  const verifiedTaxMetadata = {
    currentFiscalYearVerified: true,
    currentFiscalYear: 'FY2026-27',
    verifiedFiscalYears: ['FY2026-27'],
  };

  const taxComparison = ({ newTax = 0, newTaxableIncome = 0, oldTax = 0, oldTaxableIncome = 0 } = {}) => ({
    fiscal_year: 'FY2026-27',
    verified: true,
    saving: 0,
    recommended_regime: 'new',
    new_regime: { tax: newTax, taxable_income: newTaxableIncome, effective_rate: 0, standard_deduction: 0, slab_breakdown: [], marginal_relief_applied: false, rebate_applied: newTax === 0 && newTaxableIncome > 0 },
    old_regime: { tax: oldTax, taxable_income: oldTaxableIncome, effective_rate: 0, standard_deduction: 0, slab_breakdown: [], marginal_relief_applied: false },
    deduction_limits: {},
    remaining_deductions: {},
  });

  it('describes zero tax by the verified result when taxable income is positive under a rebate scenario', async () => {
    vi.spyOn(api, 'getTaxPolicyMetadata').mockResolvedValue(verifiedTaxMetadata);
    vi.spyOn(api, 'compareTax').mockResolvedValue(taxComparison({ newTax: 0, newTaxableIncome: 900_000 }));

    render(<TaxScreen profile={{ age: 35 }} recommendations={[]} />);
    await waitFor(() => expect(screen.getByLabelText('Fiscal year for tax calculation')).toHaveValue('FY2026-27'));
    fireEvent.change(screen.getByLabelText('Enter yearly income amount'), { target: { value: '900000' } });
    fireEvent.change(screen.getByLabelText('Income source for tax calculation'), { target: { value: 'salary' } });
    fireEvent.click(screen.getByRole('button', { name: 'New Regime' }));

    expect(await screen.findByText(/Based on the selected fiscal year, income source, and inputs/)).toHaveTextContent(/server-calculated tax under the New Regime is/);
    expect(screen.getByText(/server-calculated tax under the New Regime is/)).toHaveTextContent('₹0');
    expect(screen.queryByText(/below the tax-free limit/i)).not.toBeInTheDocument();
  });

  it('uses source-neutral taxable-income copy for a business-income calculation', async () => {
    vi.spyOn(api, 'getTaxPolicyMetadata').mockResolvedValue(verifiedTaxMetadata);
    vi.spyOn(api, 'compareTax').mockResolvedValue(taxComparison({ newTax: 100_000, newTaxableIncome: 1_200_000 }));

    render(<TaxScreen profile={{ age: 35 }} recommendations={[]} />);
    await waitFor(() => expect(screen.getByLabelText('Fiscal year for tax calculation')).toHaveValue('FY2026-27'));
    fireEvent.change(screen.getByLabelText('Enter yearly income amount'), { target: { value: '1500000' } });
    fireEvent.change(screen.getByLabelText('Income source for tax calculation'), { target: { value: 'business' } });
    fireEvent.click(screen.getByRole('button', { name: 'New Regime' }));

    expect(await screen.findByText('FY2026-27 · Verified Server Rules')).toBeInTheDocument();
    expect(await screen.findByText('Taxable Income (after deductions)')).toBeInTheDocument();
    expect(screen.queryByText(/Salary after deductions/i)).not.toBeInTheDocument();
    await waitFor(() => expect(api.compareTax).toHaveBeenCalledWith(
      1_500_000,
      expect.objectContaining({ incomeSource: 'business', fiscalYear: 'FY2026-27' }),
      expect.any(Object),
    ));
  });

  it('accepts the backend-validated annual income ceiling and exposes the same input maximum', async () => {
    vi.spyOn(api, 'getTaxPolicyMetadata').mockResolvedValue({
      currentFiscalYearVerified: true,
      currentFiscalYear: 'FY2026-27',
      verifiedFiscalYears: ['FY2026-27'],
    });
    vi.spyOn(api, 'compareTax').mockResolvedValue({});

    render(<TaxScreen profile={{ age: 35 }} recommendations={[]} />);
    await waitFor(() => expect(screen.getByLabelText('Fiscal year for tax calculation')).toHaveValue('FY2026-27'));
    const incomeInput = screen.getByLabelText('Enter yearly income amount');
    expect(incomeInput).toHaveAttribute('max', '1000000000');
    expect(screen.getByLabelText('Yearly gross income before tax')).toHaveAttribute('max', '1000000000');

    fireEvent.change(screen.getByLabelText('Income source for tax calculation'), { target: { value: 'salary' } });
    fireEvent.change(incomeInput, { target: { value: '1000000000' } });
    await waitFor(() => expect(api.compareTax).toHaveBeenCalledTimes(1));
    expect(api.compareTax).toHaveBeenCalledWith(
      1_000_000_000,
      expect.objectContaining({ incomeSource: 'salary', fiscalYear: 'FY2026-27' }),
      expect.any(Object),
    );

    fireEvent.change(incomeInput, { target: { value: '1000000001' } });
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(api.compareTax).toHaveBeenCalledTimes(1);
  });

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
