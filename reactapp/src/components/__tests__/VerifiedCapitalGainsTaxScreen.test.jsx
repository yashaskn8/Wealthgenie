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
  it('sends bounded typed money inputs and displays the bound server ledger',async()=>{
    const request=vi.spyOn(api,'computeVerifiedComplexCapitalGainsTax')
      .mockImplementation(async req=>validResponse(req));
    render(<VerifiedCapitalGainsTaxScreen/>);
    fill();
    fireEvent.click(screen.getByRole('button',{name:/Calculate verified equity-gains tax/i}));
    await waitFor(()=>expect(request).toHaveBeenCalledOnce());
    expect(request.mock.calls[0][0].ltcg198).toBe('225000');
    expect(request.mock.calls[0][0].completeYearGainsConfirmed).toBe(true);
    expect(request.mock.calls[0][0]).toEqual(validResponse(request.mock.calls[0][0]).inputsUsed);
    await waitFor(()=>expect(screen.getByRole('region',{name:'Verified capital gains tax result'})).toBeInTheDocument());
    expect(screen.getAllByText('₹1,63,800').length).toBeGreaterThan(0);
  });
  it('displays structurally valid server values unchanged without recalculating the tax ledger',async()=>{
    const request=vi.spyOn(api,'computeVerifiedComplexCapitalGainsTax').mockImplementation(async req=>({
      ...validResponse(req),section198ExemptLongTermGain:'5',section196Tax:'777.777',
      rebate:'123.456',surcharge:'12.345',finalTax:'999999',
    }));
    render(<VerifiedCapitalGainsTaxScreen/>);
    fill();
    fireEvent.click(screen.getByRole('button',{name:/Calculate verified equity-gains tax/i}));
    await waitFor(()=>expect(request).toHaveBeenCalledOnce());
    await waitFor(()=>expect(screen.getByRole('region',{name:'Verified capital gains tax result'})).toBeInTheDocument());
    expect(screen.getAllByText('₹9,99,999').length).toBeGreaterThan(0);
    expect(screen.getByText('₹777.777')).toBeInTheDocument();
    expect(screen.getByText('Rebate')).toBeInTheDocument();
    expect(screen.getByText('₹123.456')).toBeInTheDocument();
    expect(screen.getByText('Surcharge')).toBeInTheDocument();
    expect(screen.getByText('₹12.345')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('surfaces backend refusals instead of applying an income threshold in the browser',async()=>{
    const request=vi.spyOn(api,'computeVerifiedComplexCapitalGainsTax').mockImplementation(async req=>({
      taxYear:'2026-27',policyVersion:'verified-capital-gains-TY2026-27-v1',
      inputsUsed:{...req},status:'UNAVAILABLE',finalTax:null,
      unavailableReasons:['BASIC_EXEMPTION_OR_87A_REBATE_REQUIRES_FULL_RETURN','NO_SPECIAL_RATE_GAINS'],
    }));
    render(<VerifiedCapitalGainsTaxScreen/>);
    fill();
    fireEvent.change(screen.getByLabelText(/Annual primary ordinary income/i),{target:{value:'1200000'}});
    fireEvent.change(screen.getByLabelText(/Net annual STCG/i),{target:{value:'0'}});
    fireEvent.change(screen.getByLabelText(/Net annual LTCG/i),{target:{value:'0'}});
    fireEvent.click(screen.getByRole('button',{name:/Calculate verified equity-gains tax/i}));
    await waitFor(()=>expect(request).toHaveBeenCalledOnce());
    expect(request.mock.calls[0][0].primaryIncome).toBe('1200000');
    expect(await screen.findByText(/basic-exemption or rebate rules for this case need a full tax calculation/i)).toBeInTheDocument();
    expect(screen.queryByText('BASIC_EXEMPTION_OR_87A_REBATE_REQUIRES_FULL_RETURN')).not.toBeInTheDocument();
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

describe('adversarial response integrity',()=>{
  it.each([
    ['echoed-input mismatch', data=>({...data,inputsUsed:{...data.inputsUsed,ltcg198:'125000'}})],
    ['policy-version mismatch', data=>({...data,policyVersion:'different-policy'})],
    ['tax-year mismatch', data=>({...data,taxYear:'2025-26'})],
    ['invalid output shape', data=>({...data,section196Tax:'not-a-number'})],
    ['missing ledger field', data=>({...data,section196Tax:undefined})],
    ['invalid status', data=>({...data,status:'PENDING'})],
    ['invented residency echo', data=>({...data,inputsUsed:{...data.inputsUsed,residency:'non_resident'}})],
  ])('rejects a response with %s', async (_name,modify)=>{
    const request=vi.spyOn(api,'computeVerifiedComplexCapitalGainsTax')
      .mockImplementation(async input=>modify(validResponse(input)));
    render(<VerifiedCapitalGainsTaxScreen/>);
    fill();
    fireEvent.click(screen.getByRole('button',{name:/Calculate verified equity-gains tax/i}));
    await waitFor(()=>expect(request).toHaveBeenCalledOnce());
    await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent(/unverifiable computation/i));
    expect(screen.queryByRole('region',{name:'Verified capital gains tax result'})).not.toBeInTheDocument();
  });
});
