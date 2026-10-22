import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import api from '../../services/api';
import VerifiedCapitalGainsTaxScreen from '../VerifiedCapitalGainsTaxScreen';

afterEach(()=>{cleanup();vi.restoreAllMocks();});
function fill(){
  fireEvent.change(screen.getByLabelText('Ordinary income type'),{target:{value:'already_taxable'}});
  fireEvent.change(screen.getByLabelText(/Annual primary ordinary income/i),{target:{value:'1500000'}});
  fireEvent.change(screen.getByLabelText(/Additional ordinary-rate taxable income/i),{target:{value:'0'}});
  fireEvent.change(screen.getByLabelText(/Net annual STCG/i),{target:{value:'200000'}});
  fireEvent.change(screen.getByLabelText(/Net annual LTCG/i),{target:{value:'225000'}});
  fireEvent.change(screen.getByLabelText('Tax residence'),{target:{value:'resident'}});
  screen.getAllByRole('checkbox').forEach(b=>fireEvent.click(b));
}
function validResponse(req){
  return {
    taxYear:'2026-27',policyVersion:'verified-capital-gains-TY2026-27-v1',
    inputsUsed:{...req},status:'CALCULATED',unavailableReasons:[],
    calculationClass:'VERIFIED_RESIDENT_EQUITY_GAINS_ABOVE_REBATE_BELOW_SURCHARGE',
    ordinaryTaxableIncome:'1500000',shortTermGains:'200000',longTermGains:'225000',
    grossTotalIncome:'1925000',standardDeduction:'0',section198ExemptLongTermGain:'125000',
    ordinarySlabTax:'105000.000',section196Tax:'40000.000',section198Tax:'12500.000',
    rebate:'0.000',surcharge:'0.000',cess:'6300.000',
    taxBeforeStatutoryRounding:'163800.000',finalTax:'163800',
  };
}
describe('verified equity capital gains feature',()=>{
  it('does not call the API when an unconfirmed user attempts the calculation',()=>{
    const request=vi.spyOn(api,'computeVerifiedComplexCapitalGainsTax').mockResolvedValue({});
    render(<VerifiedCapitalGainsTaxScreen/>);
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:/Calculate verified equity-gains tax/i}));
    expect(request).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
  it('sends bounded typed money inputs and verifies independently before displaying',async()=>{
    const request=vi.spyOn(api,'computeVerifiedComplexCapitalGainsTax')
      .mockImplementation(async req=>validResponse(req));
    render(<VerifiedCapitalGainsTaxScreen/>);
    fill();
    fireEvent.click(screen.getByRole('button',{name:/Calculate verified equity-gains tax/i}));
    await waitFor(()=>expect(request).toHaveBeenCalledOnce());
    expect(request.mock.calls[0][0].ltcg198).toBe('225000');
    expect(request.mock.calls[0][0].completeYearGainsConfirmed).toBe(true);
    await waitFor(()=>expect(screen.getByRole('region',{name:'Verified capital gains tax result'})).toBeInTheDocument());
    expect(screen.getAllByText('₹1,63,800').length).toBeGreaterThan(0);
  });
  it('refuses a falsely discounted year-wide Section 198 amount',async()=>{
    const request=vi.spyOn(api,'computeVerifiedComplexCapitalGainsTax')
      .mockImplementation(async req=>({...validResponse(req),section198Tax:'0.000'}));
    render(<VerifiedCapitalGainsTaxScreen/>);
    fill();
    fireEvent.click(screen.getByRole('button',{name:/Calculate verified equity-gains tax/i}));
    await waitFor(()=>expect(request).toHaveBeenCalledOnce());
    await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent(/unverifiable computation/i));
    expect(screen.queryByRole('region',{name:'Verified capital gains tax result'})).not.toBeInTheDocument();
  });
  it('never sends financial amounts for an unverified capital-gains attestation',()=>{
    const request=vi.spyOn(api,'computeVerifiedComplexCapitalGainsTax').mockResolvedValue({});
    render(<VerifiedCapitalGainsTaxScreen/>);
    fill();
    fireEvent.click(screen.getAllByRole('checkbox')[1]);
    fireEvent.click(screen.getByRole('button',{name:/Calculate verified equity-gains tax/i}));
    expect(request).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/No financial amounts were submitted/i);
  });
});
