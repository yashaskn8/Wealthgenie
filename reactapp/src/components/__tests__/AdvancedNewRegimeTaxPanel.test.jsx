import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import api from '../../services/api';
import AdvancedNewRegimeTaxPanel from '../AdvancedNewRegimeTaxPanel';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function qualified() {
  fireEvent.change(screen.getByLabelText('Primary annual income (₹)'), { target: { value: '1200000' } });
  fireEvent.change(screen.getByLabelText(/Residency in India during Tax Year/i), { target: { value: 'resident' } });
  fireEvent.click(screen.getAllByRole('checkbox')[1]);
}

describe('advanced new-regime tax privacy and reconciliation', () => {
  it('never transmits the taxpayer income when residence or return context is unknown', () => {
    const call = vi.spyOn(api, 'computeAdvancedNewRegimeTax').mockResolvedValue({});
    render(<AdvancedNewRegimeTaxPanel />);
    fireEvent.change(screen.getByLabelText('Primary annual income (₹)'), { target: { value: '1200000' } });
    fireEvent.click(screen.getByRole('button', { name: /Calculate advanced tax case/i }));
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/No income figures were submitted/i);
  });

  it('shows only financially reconciled server results for the exact submitted inputs', async () => {
    const call = vi.spyOn(api, 'computeAdvancedNewRegimeTax').mockImplementation(async request => ({
      inputsUsed: { ...request },
      taxYear: '2026-27',
      policyVersion: 'advanced-new-regime-TY2026-27-v1',
      status: 'CALCULATED',
      unavailableReasons: [],
      grossOrdinaryIncome: '1200000.0000',
      standardDeduction: '75000.0000',
      employerNpsDeduction: '0.0000',
      excessNpsNotDeducted: '0.0000',
      housePropertyLossNotSetOff: '0.0000',
      ordinaryTaxableIncome: '1125000',
      specialIncomeTaxable: '0',
      totalTaxableIncome: '1125000',
      ordinaryTaxBeforeRebate: '52500.0000',
      specialIncomeTax: '0.0000',
      rebate: '52500.0000',
      surcharge: '0.0000',
      surchargeMarginalRelief: '0.0000',
      cess: '0.0000',
      taxBeforeStatutoryRounding: '0.0000',
      finalTax: '0',
      notes: [],
    }));
    render(<AdvancedNewRegimeTaxPanel />);
    qualified();
    fireEvent.click(screen.getByRole('button', { name: /Calculate advanced tax case/i }));
    await waitFor(() => expect(call).toHaveBeenCalledOnce());
    expect(call.mock.calls[0][0]).toMatchObject({
      taxYear: '2026-27', incomeType: 'salary', primaryIncome: '1200000',
      residency: 'resident', confirmedNoOtherTaxAdjustments: true,
    });
    await waitFor(() => expect(screen.getByText('Tax for the specifically declared and qualified scenario')).toBeInTheDocument());
    expect(screen.getAllByText('₹0').length).toBeGreaterThan(0);
  });

  it('rejects an internally inconsistent result instead of displaying a believable but false tax', async () => {
    const call = vi.spyOn(api, 'computeAdvancedNewRegimeTax').mockImplementation(async request => ({
      inputsUsed: { ...request }, taxYear: '2026-27',
      policyVersion: 'advanced-new-regime-TY2026-27-v1',
      status: 'CALCULATED', unavailableReasons: [],
      grossOrdinaryIncome: '1200000.0000',
      standardDeduction: '0.0000', employerNpsDeduction: '0.0000',
      excessNpsNotDeducted: '0.0000', housePropertyLossNotSetOff: '0.0000',
      ordinaryTaxableIncome: '1200000', specialIncomeTaxable: '0',
      totalTaxableIncome: '1200000', ordinaryTaxBeforeRebate: '60000.0000',
      specialIncomeTax: '0.0000', rebate: '60000.0000',
      surcharge: '0.0000', surchargeMarginalRelief: '0.0000',
      cess: '0.0000', taxBeforeStatutoryRounding: '0.0000',
      finalTax: '0', notes: [],
    }));
    render(<AdvancedNewRegimeTaxPanel />);
    qualified();
    fireEvent.click(screen.getByRole('button', { name: /Calculate advanced tax case/i }));
    await waitFor(() => expect(call).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/failed input binding or financial reconciliation/i));
    expect(screen.queryByText('Tax for the specifically declared and qualified scenario')).not.toBeInTheDocument();
  });
});
