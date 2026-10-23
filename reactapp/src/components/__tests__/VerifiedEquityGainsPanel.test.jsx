import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import api from '../../services/api';
import VerifiedEquityGainsPanel from '../VerifiedEquityGainsPanel';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function fill() {
  fireEvent.change(screen.getByLabelText('Ordinary income category'), { target: { value: 'already_taxable' } });
  fireEvent.change(screen.getByLabelText('Primary ordinary annual income (₹)'), { target: { value: '1500000' } });
  fireEvent.change(screen.getByLabelText(/Additional ordinary taxable income, excluding gains/), { target: { value: '0' } });
  fireEvent.change(screen.getByLabelText(/Net annual qualified STCG/), { target: { value: '200000' } });
  fireEvent.change(screen.getByLabelText(/Net annual qualified LTCG/), { target: { value: '225000' } });
  fireEvent.change(screen.getByLabelText(/Residency for Tax Year/), { target: { value: 'resident' } });
  for (const checkbox of screen.getAllByRole('checkbox')) fireEvent.click(checkbox);
}
const golden = (input, overrides = {}) => ({
  taxYear: '2026-27', policyVersion: 'verified-capital-gains-TY2026-27-v1',
  inputsUsed: { ...input }, status: 'CALCULATED',
  calculationClass: 'VERIFIED_RESIDENT_EQUITY_GAINS_ABOVE_REBATE_BELOW_SURCHARGE',
  unavailableReasons: [], ordinaryTaxableIncome: '1500000',
  shortTermGains: '200000', longTermGains: '225000', grossTotalIncome: '1925000',
  standardDeduction: '0', section198ExemptLongTermGain: '125000',
  ordinarySlabTax: '105000.000', section196Tax: '40000.000',
  section198Tax: '12500.000', rebate: '0.000', surcharge: '0.000',
  cess: '6300.000', taxBeforeStatutoryRounding: '163800.000',
  finalTax: '163800',
  ...overrides,
});

describe('qualified equity gains: adversarial browser contract', () => {
  it('starts unqualified and never transmits financial amounts', () => {
    const apiCall = vi.spyOn(api, 'computeVerifiedComplexCapitalGainsTax').mockResolvedValue({});
    render(<VerifiedEquityGainsPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Calculate qualified equity-gains tax/ }));
    expect(apiCall).not.toHaveBeenCalled();
    fill();
    fireEvent.click(screen.getByRole('checkbox', { name: /I have included all Section 196/ }));
    fireEvent.click(screen.getByRole('button', { name: /Calculate qualified equity-gains tax/ }));
    expect(apiCall).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/No financial amounts were submitted/i);
  });
  it('renders a structurally valid response from the authoritative server', async () => {
    const apiCall = vi.spyOn(api, 'computeVerifiedComplexCapitalGainsTax').mockImplementation(async input => golden(input));
    render(<VerifiedEquityGainsPanel />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: /Calculate qualified equity-gains tax/ }));
    await waitFor(() => expect(apiCall).toHaveBeenCalledOnce());
    const data = apiCall.mock.calls[0][0];
    expect(data.stcg196).toBe('200000');
    expect(data.ltcg198).toBe('225000');
    expect(data.completeYearGainsConfirmed).toBe(true);
    await waitFor(() => expect(screen.getByText(/Verified restricted-scope tax liability/i)).toBeInTheDocument());
    expect(screen.getAllByText(/₹1,63,800/).length).toBeGreaterThan(0);
  });
  it.each([
    ['policy version', input => golden(input, { policyVersion: 'unrecognized-policy' })],
    ['input echo', input => golden(input, { inputsUsed: { ...input, ltcg198: '220000' } })],
    ['tax year', input => golden(input, { taxYear: '2025-26' })],
  ])('rejects a response with a mismatched %s', async (_label, createResponse) => {
    const apiCall = vi.spyOn(api, 'computeVerifiedComplexCapitalGainsTax')
      .mockImplementation(async input => createResponse(input));
    render(<VerifiedEquityGainsPanel />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: /Calculate qualified equity-gains tax/ }));
    await waitFor(() => expect(apiCall).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/failed financial reconciliation/i));
    expect(screen.queryByText(/Verified restricted-scope tax liability/i)).not.toBeInTheDocument();
  });

  it('displays a structurally valid server result without recomputing inconsistent tax fields', async () => {
    const apiCall = vi.spyOn(api, 'computeVerifiedComplexCapitalGainsTax').mockImplementation(async input => golden(input, {
      ordinaryTaxableIncome: '1', shortTermGains: '999999', longTermGains: '0',
      grossTotalIncome: '2', standardDeduction: '888', section198ExemptLongTermGain: '777',
      ordinarySlabTax: '999.999', section196Tax: '0.000', section198Tax: '0.000',
      rebate: '111.111', surcharge: '222.222', cess: '333.333',
      taxBeforeStatutoryRounding: '444.444', finalTax: '42',
    }));
    render(<VerifiedEquityGainsPanel />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: /Calculate qualified equity-gains tax/ }));
    await waitFor(() => expect(apiCall).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByText(/Verified restricted-scope tax liability/i)).toBeInTheDocument());
    const result = screen.getByRole('status');
    for (const value of ['₹42', '₹2', '₹1', '₹888', '₹9,99,999', '₹777',
      '₹999.999', '₹0.000', '₹111.111', '₹222.222', '₹333.333', '₹444.444']) {
      expect(result).toHaveTextContent(value);
    }
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('maps known and unknown unavailable reasons to safe plain-language messages', async () => {
    const apiCall = vi.spyOn(api, 'computeVerifiedComplexCapitalGainsTax').mockImplementation(async input => ({
      taxYear: '2026-27', policyVersion: 'verified-capital-gains-TY2026-27-v1',
      inputsUsed: { ...input }, status: 'UNAVAILABLE', finalTax: null,
      unavailableReasons: ['SURCHARGE_REQUIRES_FULL_RETURN', 'toString'],
    }));
    render(<VerifiedEquityGainsPanel />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: /Calculate qualified equity-gains tax/ }));
    await waitFor(() => expect(apiCall).toHaveBeenCalledOnce());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/requires surcharge handling in a full tax return/i);
    expect(alert).toHaveTextContent(/outside the calculator’s supported scope/i);
    expect(alert).not.toHaveTextContent(/SURCHARGE_REQUIRES_FULL_RETURN|toString/);
    expect(screen.queryByText(/Verified restricted-scope tax liability/i)).not.toBeInTheDocument();
  });

  it('keeps invalid amount syntax local and lets the server gate unsupported income ranges', async () => {
    const apiCall = vi.spyOn(api, 'computeVerifiedComplexCapitalGainsTax').mockImplementation(async input => ({
      taxYear: '2026-27', policyVersion: 'verified-capital-gains-TY2026-27-v1',
      inputsUsed: { ...input }, status: 'UNAVAILABLE', finalTax: null,
      unavailableReasons: ['SURCHARGE_REQUIRES_FULL_RETURN'],
    }));
    render(<VerifiedEquityGainsPanel />);
    fill();
    fireEvent.change(screen.getByLabelText(/Net annual qualified STCG/), { target: { value: '200005' } });
    fireEvent.click(screen.getByRole('button', { name: /Calculate qualified equity-gains tax/ }));
    expect(apiCall).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/Net annual qualified STCG/), { target: { value: '4000000' } });
    fireEvent.click(screen.getByRole('button', { name: /Calculate qualified equity-gains tax/ }));
    await waitFor(() => expect(apiCall).toHaveBeenCalledOnce());
    expect(apiCall.mock.calls[0][0].stcg196).toBe('4000000');
    expect(await screen.findByRole('alert')).toHaveTextContent(/requires surcharge handling in a full tax return/i);
  });

  it('submits below-range income for an authoritative unavailable response', async () => {
    const apiCall = vi.spyOn(api, 'computeVerifiedComplexCapitalGainsTax').mockImplementation(async input => ({
      taxYear: '2026-27', policyVersion: 'verified-capital-gains-TY2026-27-v1',
      inputsUsed: { ...input }, status: 'UNAVAILABLE', finalTax: null,
      unavailableReasons: ['BASIC_EXEMPTION_OR_87A_REBATE_REQUIRES_FULL_RETURN'],
    }));
    render(<VerifiedEquityGainsPanel />);
    fill();
    fireEvent.change(screen.getByLabelText('Primary ordinary annual income (₹)'), { target: { value: '1200000' } });
    fireEvent.click(screen.getByRole('button', { name: /Calculate qualified equity-gains tax/ }));
    await waitFor(() => expect(apiCall).toHaveBeenCalledOnce());
    expect(apiCall.mock.calls[0][0].primaryIncome).toBe('1200000');
    expect(await screen.findByRole('alert')).toHaveTextContent(/requires a full tax return calculation/i);
  });
});
