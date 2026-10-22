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
const golden = input => ({
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
  it('accepts an exact, independently reconciled legal calculation', async () => {
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
  it('rejects server figures that reconcile superficially but violate statutory 196 rate', async () => {
    const apiCall = vi.spyOn(api, 'computeVerifiedComplexCapitalGainsTax').mockImplementation(async input => ({
      ...golden(input), section196Tax: '30000.000', taxBeforeStatutoryRounding: '153400.000', cess: '5900.000', finalTax: '153400',
    }));
    render(<VerifiedEquityGainsPanel />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: /Calculate qualified equity-gains tax/ }));
    await waitFor(() => expect(apiCall).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/failed financial reconciliation/i));
    expect(screen.queryByText(/Verified restricted-scope tax liability/i)).not.toBeInTheDocument();
  });
  it('does not transmit unsupported high-income surcharge and non-rupee-ten inputs', () => {
    const apiCall = vi.spyOn(api, 'computeVerifiedComplexCapitalGainsTax').mockResolvedValue({});
    render(<VerifiedEquityGainsPanel />);
    fill();
    fireEvent.change(screen.getByLabelText(/Net annual qualified STCG/), { target: { value: '200005' } });
    fireEvent.click(screen.getByRole('button', { name: /Calculate qualified equity-gains tax/ }));
    expect(apiCall).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/Net annual qualified STCG/), { target: { value: '4000000' } });
    fireEvent.click(screen.getByRole('button', { name: /Calculate qualified equity-gains tax/ }));
    expect(apiCall).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/up to ₹50 lakh/i);
  });
});
