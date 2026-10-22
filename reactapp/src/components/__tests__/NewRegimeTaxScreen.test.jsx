import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import api from '../../services/api';
import NewRegimeTaxScreen from '../NewRegimeTaxScreen';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function populate({ primaryIncome = '1275000.00', residency = 'resident', specialRateIncome = 'no' } = {}) {
  fireEvent.change(screen.getByLabelText('Income category'), { target: { value: 'salary' } });
  fireEvent.change(screen.getByLabelText('Additional ordinary-rate taxable income (₹)'), { target: { value: '0' } });
  fireEvent.change(screen.getByLabelText(/Annual taxable gross salary.*before standard deduction/i), {
    target: { value: primaryIncome },
  });
  fireEvent.change(screen.getByLabelText(/Residential status/i), { target: { value: residency } });
  fireEvent.change(screen.getByLabelText(/Any special-rate income or dividends/i), { target: { value: specialRateIncome } });
  fireEvent.click(screen.getByRole('checkbox', { name: /I confirm this is a single-individual/i }));
}

describe('new-regime calculator visible entry point', () => {
  it('contains no old-regime choice and does not calculate on initial render', () => {
    const call = vi.spyOn(api, 'computeVerifiedNewRegimeTax').mockResolvedValue({});
    render(<NewRegimeTaxScreen />);
    expect(screen.getByRole('heading', { name: 'Income Tax Calculator' })).toBeInTheDocument();
    expect(screen.queryByText('Old Regime')).not.toBeInTheDocument();
    expect(call).not.toHaveBeenCalled();
  });

  it('sends exact decimal strings to the authoritative backend, not client tax arithmetic', async () => {
    const call = vi.spyOn(api, 'computeVerifiedNewRegimeTax').mockImplementation(async request => ({
      taxYear: request.taxYear, policyVersion: 'verified-simple-new-regime-TY2026-27-v1',
      status: 'CALCULATED', calculationClass: 'SIMPLE_ORDINARY_INCOME_ONLY',
      unavailableReasons: [],
      inputsUsed: { ...request }, finalTax: '0', taxableIncome: '1200000',
      grossPrimaryIncome: '1275000.0000', otherOrdinaryIncome: '0.0000',
      standardDeduction: '75000.0000', taxableIncomeBeforeRounding: '1200000.0000',
      taxBeforeRebate: '60000.0000', rebate: '60000.0000', taxAfterRebate: '0.0000',
      surcharge: '0.0000', surchargeMarginalRelief: '0.0000', cess: '0.0000',
      taxBeforeStatutoryRounding: '0.0000', slabBreakdown: [
        { from: '0', to: '400000', percent: 0, taxableInSlab: '400000', tax: '0.0000' },
        { from: '400000', to: '800000', percent: 5, taxableInSlab: '400000', tax: '20000.0000' },
        { from: '800000', to: '1200000', percent: 10, taxableInSlab: '400000', tax: '40000.0000' },
      ],
    }));
    render(<NewRegimeTaxScreen />);
    populate();
    fireEvent.click(screen.getByRole('button', { name: /Calculate income tax/i }));
    await waitFor(() => expect(call).toHaveBeenCalledOnce());
    const input = call.mock.calls[0][0];
    expect(input.primaryIncome).toBe('1275000.00');
    expect(input.residency).toBe('resident');
    expect(input.specialRateIncome).toBe('no');
    expect(input.confirmedOrdinaryOnly).toBe(true);
    expect(input.taxYear).toBe('2026-27');
    await waitFor(() => expect(screen.getByText(/Estimated tax liability under the new regime/i)).toBeInTheDocument());
  });

  it('rejects internally balanced figures that do not match entered income or salary deduction', async () => {
    const call = vi.spyOn(api, 'computeVerifiedNewRegimeTax').mockImplementation(async request => ({
      taxYear: request.taxYear,
      policyVersion: 'verified-simple-new-regime-TY2026-27-v1',
      status: 'CALCULATED', calculationClass: 'SIMPLE_ORDINARY_INCOME_ONLY',
      inputsUsed: { ...request }, finalTax: '0', taxableIncome: '1200000',
      // Forged but internally balanced: the real request contains ₹12.75 lakh
      // salary, yet these numbers silently pretend the salary was ₹12 lakh.
      grossPrimaryIncome: '1200000.0000', otherOrdinaryIncome: '0.0000',
      standardDeduction: '0.0000', taxableIncomeBeforeRounding: '1200000.0000',
      taxBeforeRebate: '60000.0000', rebate: '60000.0000', taxAfterRebate: '0.0000',
      surcharge: '0.0000', surchargeMarginalRelief: '0.0000', cess: '0.0000',
      taxBeforeStatutoryRounding: '0.0000', slabBreakdown: [
        { from: '0', to: '400000', percent: 0, taxableInSlab: '400000', tax: '0.0000' },
        { from: '400000', to: '800000', percent: 5, taxableInSlab: '400000', tax: '20000.0000' },
        { from: '800000', to: '1200000', percent: 10, taxableInSlab: '400000', tax: '40000.0000' },
      ],
    }));
    render(<NewRegimeTaxScreen />);
    populate();
    fireEvent.click(screen.getByRole('button', { name: /Calculate income tax/i }));
    await waitFor(() => expect(call).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/unverified or mismatched calculation/i));
    expect(screen.queryByText(/Estimated tax liability under the new regime/i)).not.toBeInTheDocument();
  });

  it('rejects a balanced but legally false ₹62,400 tax when the resident rebate makes it ₹0', async () => {
    const call = vi.spyOn(api, 'computeVerifiedNewRegimeTax').mockImplementation(async request => ({
      taxYear: request.taxYear,
      policyVersion: 'verified-simple-new-regime-TY2026-27-v1',
      status: 'CALCULATED', calculationClass: 'SIMPLE_ORDINARY_INCOME_ONLY',
      inputsUsed: { ...request }, finalTax: '62400', taxableIncome: '1200000',
      grossPrimaryIncome: '1275000.0000', otherOrdinaryIncome: '0.0000',
      standardDeduction: '75000.0000', taxableIncomeBeforeRounding: '1200000.0000',
      taxBeforeRebate: '60000.0000', rebate: '0.0000', taxAfterRebate: '60000.0000',
      surcharge: '0.0000', surchargeMarginalRelief: '0.0000', cess: '2400.0000',
      taxBeforeStatutoryRounding: '62400.0000', slabBreakdown: [
        { from: '0', to: '400000', percent: 0, taxableInSlab: '400000', tax: '0.0000' },
        { from: '400000', to: '800000', percent: 5, taxableInSlab: '400000', tax: '20000.0000' },
        { from: '800000', to: '1200000', percent: 10, taxableInSlab: '400000', tax: '40000.0000' },
      ],
    }));
    render(<NewRegimeTaxScreen />);
    populate();
    fireEvent.click(screen.getByRole('button', { name: /Calculate income tax/i }));
    await waitFor(() => expect(call).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/unverified or mismatched calculation/i));
    expect(screen.queryByText(/Estimated tax liability under the new regime/i)).not.toBeInTheDocument();
  });

  it('discards an in-flight tax response when the submitted amount changes', async () => {
    let resolveResponse;
    const delayed = new Promise(resolve => { resolveResponse = resolve; });
    const call = vi.spyOn(api, 'computeVerifiedNewRegimeTax').mockReturnValue(delayed);
    render(<NewRegimeTaxScreen />);
    populate();
    fireEvent.click(screen.getByRole('button', { name: /Calculate income tax/i }));
    await waitFor(() => expect(call).toHaveBeenCalledOnce());
    const signal = call.mock.calls[0][1].signal;
    fireEvent.change(screen.getByLabelText(/Annual taxable gross salary.*before standard deduction/i), {
      target: { value: '1275001.00' },
    });
    expect(signal.aborted).toBe(true);
    resolveResponse({
      status: 'CALCULATED', finalTax: '0',
      taxYear: '2026-27', policyVersion: 'verified-simple-new-regime-TY2026-27-v1',
    });
    await waitFor(() => expect(screen.getByRole('button', { name: /Calculate income tax/i })).not.toBeDisabled());
    expect(screen.queryByText(/Estimated tax liability under the new regime/i)).not.toBeInTheDocument();
  });

  it('never sends financial figures for known special-rate income', () => {
    const call = vi.spyOn(api, 'computeVerifiedNewRegimeTax').mockResolvedValue({});
    render(<NewRegimeTaxScreen />);
    populate({ specialRateIncome: 'yes' });
    fireEvent.click(screen.getByRole('button', { name: /Calculate income tax/i }));
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/Cannot calculate this simplified return/i);
    expect(screen.getByRole('alert')).toHaveTextContent(/No income figures were submitted/i);
    expect(screen.queryByText(/Estimated tax liability under the new regime/i)).not.toBeInTheDocument();
  });

  it('never sends financial figures for unqualified residency or missing attestation', () => {
    const call = vi.spyOn(api, 'computeVerifiedNewRegimeTax').mockResolvedValue({});
    render(<NewRegimeTaxScreen />);
    populate({ residency: 'unknown' });
    fireEvent.click(screen.getByRole('button', { name: /Calculate income tax/i }));
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/Cannot calculate this simplified return/i);
    fireEvent.change(screen.getByLabelText(/Residential status/i), { target: { value: 'resident' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /I confirm this is a single-individual/i }));
    fireEvent.click(screen.getByRole('button', { name: /Calculate income tax/i }));
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/No income figures were submitted/i);
  });

  it('refuses to show a numeric result from an invalid or unbound backend response', async () => {
    const call = vi.spyOn(api, 'computeVerifiedNewRegimeTax').mockResolvedValue({
      taxYear: '2026-27', policyVersion: 'verified-simple-new-regime-TY2026-27-v1',
      status: 'CALCULATED', finalTax: '0',
      inputsUsed: { residency: 'non_resident' },
    });
    render(<NewRegimeTaxScreen />);
    populate();
    fireEvent.click(screen.getByRole('button', { name: /Calculate income tax/i }));
    await waitFor(() => expect(call).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/unverified or mismatched calculation/i));
    expect(screen.queryByText(/Estimated tax liability under the new regime/i)).not.toBeInTheDocument();
  });

  it('rejects a forged or incomplete slab breakdown instead of displaying false details', async () => {
    const call = vi.spyOn(api, 'computeVerifiedNewRegimeTax').mockImplementation(async request => ({
      taxYear: request.taxYear,
      policyVersion: 'verified-simple-new-regime-TY2026-27-v1',
      status: 'CALCULATED', calculationClass: 'SIMPLE_ORDINARY_INCOME_ONLY',
      inputsUsed: { ...request }, finalTax: '0', taxableIncome: '1200000',
      grossPrimaryIncome: '1275000.0000', otherOrdinaryIncome: '0.0000',
      standardDeduction: '75000.0000', taxableIncomeBeforeRounding: '1200000.0000',
      taxBeforeRebate: '60000.0000', rebate: '60000.0000', taxAfterRebate: '0.0000',
      surcharge: '0.0000', surchargeMarginalRelief: '0.0000', cess: '0.0000',
      taxBeforeStatutoryRounding: '0.0000', slabBreakdown: [
        { from: '0', to: '400000', percent: 0, taxableInSlab: '400000', tax: '0.0000' },
        { from: '400000', to: '800000', percent: 5, taxableInSlab: '400000', tax: '20000.0000' },
      ],
    }));
    render(<NewRegimeTaxScreen />);
    populate();
    fireEvent.click(screen.getByRole('button', { name: /Calculate income tax/i }));
    await waitFor(() => expect(call).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/unverified or mismatched calculation/i));
    expect(screen.queryByText(/Estimated tax liability under the new regime/i)).not.toBeInTheDocument();
  });

  it('does not infer salary income or assume zero other taxable income', () => {
    const call = vi.spyOn(api, 'computeVerifiedNewRegimeTax').mockResolvedValue({});
    render(<NewRegimeTaxScreen />);
    expect(screen.getByLabelText('Income category')).toHaveValue('');
    expect(screen.getByLabelText('Additional ordinary-rate taxable income (₹)')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: /Calculate income tax/i }));
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/Choose an income category/i);
  });

  it('does not submit money with more than two decimal places', () => {
    const call = vi.spyOn(api, 'computeVerifiedNewRegimeTax').mockResolvedValue({});
    render(<NewRegimeTaxScreen />);
    populate({ primaryIncome: '1275000.009' });
    fireEvent.click(screen.getByRole('button', { name: /Calculate income tax/i }));
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/two decimal places/i);
  });
});
