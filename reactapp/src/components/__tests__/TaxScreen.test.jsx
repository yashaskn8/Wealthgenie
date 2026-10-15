import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import TaxScreen from '../TaxScreen';
import api from '../../services/api';
import { assertTaxComparisonResponse } from '../../utils/taxResponseIntegrity';

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


  const enterTaxYearAge = () => fireEvent.change(
    screen.getByLabelText('Age on March 31 of selected fiscal year'),
    { target: { value: '35' } },
  );
  const taxComparison = ({ newTax = 0, newTaxableIncome = 0, oldTax = 0, oldTaxableIncome = 0, income = 0, incomeSource = 'salary', fiscalYear = 'FY2026-27', age = 35 } = {}) => ({
    income,
    fiscal_year: fiscalYear,
    verified: true,
    policyVersion: 'tax-policy-FY2026-27-v2',
    calculation_classification: 'SEPARATE_TAX_WHAT_IF',
    saving: Math.abs(newTax - oldTax),
    saving_pct: 0,
    saving_with: newTax <= oldTax ? 'new' : 'old',
    recommended_regime: newTax <= oldTax ? 'new' : 'old',
    inputsUsed: {
      annualIncome: income,
      incomeSource,
      fiscalYear,
      deductions: {
        section80C: 0, nps80CCD1B: 0, hra: 0, homeLoanInterest: 0,
        section80D_self: 0, section80D_parents: 0, age,
      },
    },
    new_regime: { tax: newTax, taxable_income: newTaxableIncome, effective_rate: 0, standard_deduction: 0, cess: 0, nps80CCD2: 0, allowed80D: 0, marginal_relief_amount: 0, slab_breakdown: [{ label: 'Your Total Tax', rate: '', taxableInSlab: Math.round(newTaxableIncome), taxInSlab: newTax, isTotalRow: true }], marginal_relief_applied: false, rebate_applied: newTax === 0 && newTaxableIncome > 0 },
    old_regime: { tax: oldTax, taxable_income: oldTaxableIncome, effective_rate: 0, standard_deduction: 0, cess: 0, nps80CCD2: 0, allowed80D: 0, old_regime_deductions: 0, marginal_relief_amount: 0, slab_breakdown: [{ label: 'Your Total Tax', rate: '', taxableInSlab: Math.round(oldTaxableIncome), taxInSlab: oldTax, isTotalRow: true }], marginal_relief_applied: false, rebate_applied: false },
    deduction_limits: {},
    remaining_deductions: {},
    optimized_old_regime_tax: oldTax,
    potential_tax_saving: 0,
    crossover_breakpoint: null,
  });

  it('rejects incomplete slab totals and malformed old-regime deduction output', () => {
    const response = taxComparison({ newTax: 1000, newTaxableIncome: 100000, oldTax: 2000, oldTaxableIncome: 90000, income: 150000 });
    const expected = {
      annualIncome: 150000, incomeSource: 'salary', fiscalYear: 'FY2026-27',
      deductions: {
        section80C: 0, nps80CCD1B: 0, hra: 0, homeLoanInterest: 0,
        section80D_self: 0, section80D_parents: 0, age: 35,
      },
    };
    expect(() => assertTaxComparisonResponse(response, expected)).not.toThrow();
    expect(() => assertTaxComparisonResponse({
      ...response,
      new_regime: { ...response.new_regime, slab_breakdown: [] },
    }, expected)).toThrow(/incomplete regime comparison/i);
    expect(() => assertTaxComparisonResponse({
      ...response,
      old_regime: { ...response.old_regime, old_regime_deductions: '0' },
    }, expected)).toThrow(/incomplete regime comparison/i);
    expect(() => assertTaxComparisonResponse({
      ...response,
      new_regime: {
        ...response.new_regime,
        slab_breakdown: [
          { label: 'Invalid slab', rate: '10', taxableInSlab: 1000, taxInSlab: 100 },
          ...response.new_regime.slab_breakdown,
        ],
      },
    }, expected)).toThrow(/incomplete regime comparison/i);
  });
  it('describes zero tax by the verified result when taxable income is positive under a rebate scenario', async () => {
    vi.spyOn(api, 'getTaxPolicyMetadata').mockResolvedValue(verifiedTaxMetadata);
    vi.spyOn(api, 'compareTax').mockResolvedValue(taxComparison({ newTax: 0, newTaxableIncome: 900_000, income: 900_000 }));

    render(<TaxScreen profile={{ age: 35 }} recommendations={[]} />);
    await waitFor(() => expect(screen.getByLabelText('Fiscal year for tax calculation')).toHaveValue('FY2026-27'));
    enterTaxYearAge();
    fireEvent.change(screen.getByLabelText('Enter yearly income amount'), { target: { value: '900000' } });
    fireEvent.change(screen.getByLabelText('Income source for tax calculation'), { target: { value: 'salary' } });
    fireEvent.click(screen.getByRole('button', { name: 'New Regime' }));

    expect(await screen.findByText(/Based on the selected fiscal year, income source, and inputs/)).toHaveTextContent(/server-calculated tax under the New Regime is/);
    expect(screen.getByText(/server-calculated tax under the New Regime is/)).toHaveTextContent('₹0');
    expect(screen.queryByText(/below the tax-free limit/i)).not.toBeInTheDocument();
  });

  it('uses source-neutral taxable-income copy for a business-income calculation', async () => {
    vi.spyOn(api, 'getTaxPolicyMetadata').mockResolvedValue(verifiedTaxMetadata);
    vi.spyOn(api, 'compareTax').mockResolvedValue(taxComparison({ newTax: 100_000, newTaxableIncome: 1_200_000, income: 1_500_000, incomeSource: 'business' }));

    render(<TaxScreen profile={{ age: 35 }} recommendations={[]} />);
    await waitFor(() => expect(screen.getByLabelText('Fiscal year for tax calculation')).toHaveValue('FY2026-27'));
    enterTaxYearAge();
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
    enterTaxYearAge();
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
    enterTaxYearAge();
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
    enterTaxYearAge();
    fireEvent.change(screen.getByLabelText('Income source for tax calculation'), { target: { value: 'salary' } });
    fireEvent.change(screen.getByLabelText('Enter yearly income amount'), { target: { value: '0' } });
    await waitFor(() => expect(api.compareTax).toHaveBeenCalledTimes(1));

    finishComparison(taxComparison({ income: 0 }));

    await waitFor(() => expect(screen.getByText('FY2026-27 · Verified Server Rules')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Enter yearly income amount'), { target: { value: '50000' } });

    expect(screen.queryByText('FY2026-27 · Verified Server Rules')).not.toBeInTheDocument();
    expect(screen.getByText('The authoritative tax service is calculating your comparison.')).toBeInTheDocument();
  });

  it('rejects an empty successful response without recommending a regime', async () => {
    vi.spyOn(api, 'getTaxPolicyMetadata').mockResolvedValue(verifiedTaxMetadata);
    vi.spyOn(api, 'compareTax').mockResolvedValue({});

    render(<TaxScreen profile={{ age: 35 }} recommendations={[]} />);
    await waitFor(() => expect(screen.getByLabelText('Fiscal year for tax calculation')).toHaveValue('FY2026-27'));
    enterTaxYearAge();
    fireEvent.change(screen.getByLabelText('Enter yearly income amount'), { target: { value: '500000' } });
    fireEvent.change(screen.getByLabelText('Income source for tax calculation'), { target: { value: 'salary' } });

    expect(await screen.findByText(/different or unverified tax request/i)).toBeInTheDocument();
    expect(screen.queryByText(/you'll pay less tax with the/i)).not.toBeInTheDocument();
  });

  it('keeps missing tax-savings recommendation amounts and nominal assumptions unavailable', async () => {
    vi.spyOn(api, 'getTaxPolicyMetadata').mockResolvedValue(verifiedTaxMetadata);
    vi.spyOn(api, 'compareTax').mockResolvedValue(taxComparison({
      newTax: 1500, newTaxableIncome: 500000, oldTax: 2000, oldTaxableIncome: 500000, income: 500000,
    }));

    render(<TaxScreen profile={{ age: 35 }} recommendations={[{
      id: 'tax-saving-unknown-facts',
      name: 'Tax Saving Instrument',
      goalTags: ['Tax Saving'],
      monthly_allocation: null,
      nominalReturn: null,
    }]} />);
    await waitFor(() => expect(screen.getByLabelText('Fiscal year for tax calculation')).toHaveValue('FY2026-27'));
    enterTaxYearAge();
    fireEvent.change(screen.getByLabelText('Enter yearly income amount'), { target: { value: '500000' } });
    fireEvent.change(screen.getByLabelText('Income source for tax calculation'), { target: { value: 'salary' } });
    await waitFor(() => expect(api.compareTax).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Old Regime' }));

    expect(await screen.findByText('Tax Saving Instrument')).toBeInTheDocument();
    expect(screen.getByText('Pre-tax Nominal Assumption').nextElementSibling).toHaveTextContent('Unavailable');
    expect(screen.getByText('Current Plan / Year').nextElementSibling).toHaveTextContent('—');
    expect(screen.queryByText('0.0% pre-tax nominal')).not.toBeInTheDocument();
  });

  it('does not substitute the saved profile age for the selected fiscal-year age', async () => {
    vi.spyOn(api, 'getTaxPolicyMetadata').mockResolvedValue(verifiedTaxMetadata);
    const compareTax = vi.spyOn(api, 'compareTax').mockResolvedValue(taxComparison({ income: 500000 }));

    render(<TaxScreen profile={{ age: 60 }} recommendations={[]} />);
    await waitFor(() => expect(screen.getByLabelText('Fiscal year for tax calculation')).toHaveValue('FY2026-27'));
    fireEvent.change(screen.getByLabelText('Enter yearly income amount'), { target: { value: '500000' } });
    fireEvent.change(screen.getByLabelText('Income source for tax calculation'), { target: { value: 'salary' } });
    await new Promise(resolve => setTimeout(resolve, 600));

    expect(compareTax).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Age on March 31 of selected fiscal year')).toHaveValue(null);
    expect(document.getElementById('tax-year-age-help')).toHaveTextContent(/saved profile age is not substituted/i);
  });

  it('clears the entered age when the selected fiscal year changes', async () => {
    vi.spyOn(api, 'getTaxPolicyMetadata').mockResolvedValue({
      ...verifiedTaxMetadata,
      verifiedFiscalYears: ['FY2025-26', 'FY2026-27'],
    });
    vi.spyOn(api, 'compareTax').mockResolvedValue(taxComparison({ income: 500000 }));

    render(<TaxScreen profile={{ age: 35 }} recommendations={[]} />);
    await waitFor(() => expect(screen.getByLabelText('Fiscal year for tax calculation')).toHaveValue('FY2026-27'));
    enterTaxYearAge();
    fireEvent.change(screen.getByLabelText('Fiscal year for tax calculation'), { target: { value: 'FY2025-26' } });

    expect(screen.getByLabelText('Age on March 31 of selected fiscal year')).toHaveValue(null);
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
    enterTaxYearAge();
    expect(api.compareTax).not.toHaveBeenCalled();
  });

  it('shows retry after an active metadata request is aborted during auth refresh', async () => {
    const metadata = vi.spyOn(api, 'getTaxPolicyMetadata')
      .mockRejectedValueOnce(Object.assign(new Error('session changed'), { code: 'REQUEST_ABORTED' }))
      .mockResolvedValueOnce(verifiedTaxMetadata);
    vi.spyOn(api, 'compareTax').mockResolvedValue({});

    render(<TaxScreen profile={{ age: 35 }} recommendations={[]} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/verified tax-year information could not be loaded/i);
    expect(screen.getByLabelText('Fiscal year for tax calculation')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry tax policy loading' }));
    await waitFor(() => expect(screen.getByLabelText('Fiscal year for tax calculation')).toHaveValue('FY2026-27'));
    expect(metadata).toHaveBeenCalledTimes(2);
    expect(api.compareTax).not.toHaveBeenCalled();
  });
});
