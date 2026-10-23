import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import api from '../../services/api';
import AdvancedNewRegimeTaxPanel from '../AdvancedNewRegimeTaxPanel';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function qualified(incomeType = 'salary') {
  fireEvent.change(screen.getByLabelText('Ordinary income category'), { target: { value: incomeType } });
  fireEvent.change(screen.getByLabelText('Primary annual income (₹)'), { target: { value: '1200000' } });
  fireEvent.change(screen.getByLabelText(/Residency in India during Tax Year/i), { target: { value: 'resident' } });
  fireEvent.click(screen.getAllByRole('checkbox')[1]);
}

function calculatedResponse(request, overrides = {}) {
  return {
    inputsUsed: { ...request }, taxYear: '2026-27',
    policyVersion: 'advanced-new-regime-TY2026-27-v1',
    status: 'CALCULATED', calculationClass: 'ADVANCED_QUALIFIED_INCOME_ONLY',
    unavailableReasons: [], grossOrdinaryIncome: '1200000.0000',
    standardDeduction: '75000.0000', employerNpsDeduction: '0.0000',
    excessNpsNotDeducted: '0.0000', housePropertyLossNotSetOff: '0.0000',
    ordinaryTaxableIncome: '1125000', specialIncomeTaxable: '0',
    totalTaxableIncome: '1125000', ordinaryTaxBeforeRebate: '52500.0000',
    specialIncomeTax: '0.0000', rebate: '52500.0000', surcharge: '0.0000',
    surchargeMarginalRelief: '0.0000', cess: '0.0000',
    taxBeforeStatutoryRounding: '0.0000', finalTax: '0', notes: [],
    ...overrides,
  };
}

describe('advanced new-regime tax privacy and reconciliation', () => {
  it('requires an explicit income category and does not submit amounts while it is blank', () => {
    const call = vi.spyOn(api, 'computeAdvancedNewRegimeTax').mockResolvedValue({});
    render(<AdvancedNewRegimeTaxPanel />);
    expect(screen.getByLabelText('Ordinary income category')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Primary annual income (₹)'), { target: { value: '1200000' } });
    fireEvent.change(screen.getByLabelText(/Residency in India during Tax Year/i), { target: { value: 'resident' } });
    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    fireEvent.click(screen.getByRole('button', { name: /Calculate advanced tax case/i }));
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/Choose an income category/i);
    expect(screen.getByRole('alert')).toHaveTextContent(/No income figures were submitted/i);
  });

  it('never transmits the taxpayer income when residence or return context is unknown', () => {
    const call = vi.spyOn(api, 'computeAdvancedNewRegimeTax').mockResolvedValue({});
    render(<AdvancedNewRegimeTaxPanel />);
    fireEvent.change(screen.getByLabelText('Ordinary income category'), { target: { value: 'salary' } });
    fireEvent.change(screen.getByLabelText('Primary annual income (₹)'), { target: { value: '1200000' } });
    fireEvent.click(screen.getByRole('button', { name: /Calculate advanced tax case/i }));
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/No income figures were submitted/i);
  });

  it('displays a structurally valid server result bound to the exact submitted inputs', async () => {
    const call = vi.spyOn(api, 'computeAdvancedNewRegimeTax')
      .mockImplementation(async request => calculatedResponse(request));
    render(<AdvancedNewRegimeTaxPanel />);
    qualified();
    fireEvent.click(screen.getByRole('button', { name: /Calculate advanced tax case/i }));
    await waitFor(() => expect(call).toHaveBeenCalledOnce());
    expect(call.mock.calls[0][0]).toMatchObject({
      taxYear: '2026-27', incomeType: 'salary', primaryIncome: '1200000',
      residency: 'resident', confirmedNoOtherTaxAdjustments: true,
    });
    await waitFor(() => expect(screen.getByText('Tax for the specifically declared and qualified scenario')).toBeInTheDocument());
    expect(screen.getByText('Total primary and additional ordinary income entered')).toBeInTheDocument();
    expect(screen.getAllByText('₹0').length).toBeGreaterThan(0);
  });

  it('uses an accurate income label when the entered amount is already taxable', async () => {
    const call = vi.spyOn(api, 'computeAdvancedNewRegimeTax').mockImplementation(async request => (
      calculatedResponse(request, {
        grossOrdinaryIncome: '1200000.0000', standardDeduction: '0.0000',
        ordinaryTaxableIncome: '1200000', totalTaxableIncome: '1200000',
        ordinaryTaxBeforeRebate: '60000.0000', rebate: '60000.0000',
      })
    ));
    render(<AdvancedNewRegimeTaxPanel />);
    qualified('already_taxable');
    fireEvent.click(screen.getByRole('button', { name: /Calculate advanced tax case/i }));
    await waitFor(() => expect(call).toHaveBeenCalledOnce());
    expect(call.mock.calls[0][0].incomeType).toBe('already_taxable');
    await waitFor(() => expect(screen.getByText('Tax for the specifically declared and qualified scenario')).toBeInTheDocument());
    expect(screen.getByText('Total primary and additional ordinary income entered')).toBeInTheDocument();
    expect(screen.queryByText('Total gross ordinary income')).not.toBeInTheDocument();
  });

  it('translates unavailable reason codes into plain-language guidance', async () => {
    const reason = 'NPS_14_PERCENT_CAP_REQUIRES_SUB_PAISE_PRECISION';
    const call = vi.spyOn(api, 'computeAdvancedNewRegimeTax').mockImplementation(async request => ({
      inputsUsed: { ...request }, taxYear: '2026-27',
      policyVersion: 'advanced-new-regime-TY2026-27-v1',
      status: 'UNAVAILABLE', calculationClass: 'ADVANCED_QUALIFIED_INCOME_ONLY', finalTax: null,
      unavailableReasons: [reason, 'UNRECOGNIZED_REASON'],
    }));
    render(<AdvancedNewRegimeTaxPanel />);
    qualified();
    fireEvent.change(screen.getByLabelText(/Employer contribution to notified NPS/), { target: { value: '14.01' } });
    fireEvent.change(screen.getByLabelText(/NPS eligible basic salary/), { target: { value: '100.01' } });
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    fireEvent.click(screen.getByRole('button', { name: /Calculate advanced tax case/i }));
    await waitFor(() => expect(call).toHaveBeenCalledOnce());
    expect(await screen.findByText(/employer NPS limit for these figures falls between paise/i)).toBeInTheDocument();
    expect(screen.getByText(/outside the calculator’s verified scope/i)).toBeInTheDocument();
    expect(screen.getByRole('status')).not.toHaveTextContent(reason);
    expect(screen.getByRole('status')).not.toHaveTextContent('UNRECOGNIZED_REASON');
  });

  it('sends unsupported mixed-income scenarios to the backend for an authoritative refusal', async () => {
    const call = vi.spyOn(api, 'computeAdvancedNewRegimeTax').mockImplementation(async request => ({
      inputsUsed: { ...request }, taxYear: '2026-27',
      policyVersion: 'advanced-new-regime-TY2026-27-v1',
      status: 'UNAVAILABLE', calculationClass: 'ADVANCED_QUALIFIED_INCOME_ONLY', finalTax: null,
      unavailableReasons: ['MIXED_SPECIAL_RATE_SURCHARGE_NEEDS_FULL_RETURN'],
    }));
    render(<AdvancedNewRegimeTaxPanel />);
    qualified();
    fireEvent.change(screen.getByLabelText('Primary annual income (₹)'), { target: { value: '6000000' } });
    fireEvent.change(screen.getByLabelText(/Gross non-online lottery/), { target: { value: '10000' } });
    fireEvent.click(screen.getByRole('button', { name: /Calculate advanced tax case/i }));
    await waitFor(() => expect(call).toHaveBeenCalledOnce());
    expect(call.mock.calls[0][0]).toMatchObject({ primaryIncome: '6000000', lotteryWinnings: '10000' });
    expect(await screen.findByText(/needs surcharge rules not covered/i)).toBeInTheDocument();
    expect(screen.queryByText('MIXED_SPECIAL_RATE_SURCHARGE_NEEDS_FULL_RETURN')).not.toBeInTheDocument();
  });

  it('passes through a structurally valid server ledger without recomputing deductions or tax', async () => {
    const call = vi.spyOn(api, 'computeAdvancedNewRegimeTax').mockImplementation(async request => (
      calculatedResponse(request, {
        standardDeduction: '0.0000', ordinaryTaxableIncome: '1200000',
        totalTaxableIncome: '1200000', ordinaryTaxBeforeRebate: '60000.0000',
        rebate: '60000.0000',
      })
    ));
    render(<AdvancedNewRegimeTaxPanel />);
    qualified();
    fireEvent.click(screen.getByRole('button', { name: /Calculate advanced tax case/i }));
    await waitFor(() => expect(call).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByText('Tax for the specifically declared and qualified scenario')).toBeInTheDocument());
    expect(screen.getAllByText('₹12,00,000').length).toBeGreaterThan(0);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('displays a structurally valid server tax ledger without recalculating rebate or cess', async () => {
    const call = vi.spyOn(api, 'computeAdvancedNewRegimeTax').mockImplementation(async request => (
      calculatedResponse(request, {
        rebate: '0.0000', cess: '2100.0000',
        taxBeforeStatutoryRounding: '54600.0000', finalTax: '54600',
      })
    ));
    render(<AdvancedNewRegimeTaxPanel />);
    qualified();
    fireEvent.click(screen.getByRole('button', { name: /Calculate advanced tax case/i }));
    await waitFor(() => expect(call).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByText('Tax for the specifically declared and qualified scenario')).toBeInTheDocument());
    expect(screen.getAllByText('₹54,600').length).toBeGreaterThan(0);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([
    ['echoed request mismatch', request => ({ inputsUsed: { ...request, primaryIncome: '1' } })],
    ['policy-version mismatch', () => ({ policyVersion: 'different-policy' })],
    ['calculation-class mismatch', () => ({ calculationClass: 'OTHER_CLASS' })],
    ['malformed output shape', () => ({ finalTax: 'not-a-number' })],
  ])('rejects a response with %s', async (_name, overrideFor) => {
    const call = vi.spyOn(api, 'computeAdvancedNewRegimeTax').mockImplementation(async request => (
      calculatedResponse(request, overrideFor(request))
    ));
    render(<AdvancedNewRegimeTaxPanel />);
    qualified();
    fireEvent.click(screen.getByRole('button', { name: /Calculate advanced tax case/i }));
    await waitFor(() => expect(call).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/failed input binding or response validation/i));
    expect(screen.queryByText('Tax for the specifically declared and qualified scenario')).not.toBeInTheDocument();
  });

  it('keeps employer NPS amounts local until the user confirms inclusion in salary', () => {
    const call = vi.spyOn(api, 'computeAdvancedNewRegimeTax').mockResolvedValue({});
    render(<AdvancedNewRegimeTaxPanel />);
    qualified();
    fireEvent.change(screen.getByLabelText(/Employer contribution to notified NPS/), { target: { value: '200000' } });
    fireEvent.change(screen.getByLabelText(/NPS eligible basic salary/), { target: { value: '1000000' } });
    fireEvent.click(screen.getByRole('button', { name: /Calculate advanced tax case/i }));
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/Confirm employer NPS is included/i);
    expect(screen.getByRole('alert')).toHaveTextContent(/No income figures were submitted/i);
  });

});
