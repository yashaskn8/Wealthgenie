import React from 'react';
import{afterEach,describe,it,expect,vi}from'vitest';
import{render,screen,fireEvent,act,cleanup}from'@testing-library/react';
import SovereignSipComparison from '../SovereignSipComparison';
import * as api from '../../services/api';
afterEach(()=>{cleanup();vi.restoreAllMocks();});
describe('Sovereign SIP comparison',()=>{
  function fill(){
    fireEvent.change(screen.getByRole('spinbutton',{name:'Monthly SIP amount'}),{target:{value:'5000'}});
    fireEvent.change(screen.getByRole('spinbutton',{name:'SIP years'}),{target:{value:'10'}});
    fireEvent.change(screen.getByRole('spinbutton',{name:'First annual return assumption'}),{target:{value:'7'}});
    fireEvent.change(screen.getByRole('spinbutton',{name:'Second annual return assumption'}),{target:{value:'10'}});
  }
  it('never submits invalid or missing assumptions',()=>{
    render(<SovereignSipComparison/>);
    expect(screen.getByRole('button',{name:'Run SIP comparison'})).toBeDisabled();
    fill();
    expect(screen.getByRole('button',{name:'Run SIP comparison'})).toBeEnabled();
    fireEvent.change(screen.getByRole('spinbutton',{name:'Second annual return assumption'}),{target:{value:'7'}});
    expect(screen.getByRole('button',{name:'Run SIP comparison'})).toBeDisabled();
  });
  const verifiedResponse=()=>({
    version:'sovereign-voice-sip-compare-v1',
    classification:'UNSAVED_WHAT_IF_SIMULATION',persisted:false,
    note:'These are hypothetical nominal SIP projections.',
    scenarios:[
      {assumedAnnualReturnPct:7,monthlyInvestment:5000,years:10,
        totalInvested:600000,futureValue:850000,totalReturns:250000,
        returnBasis:'USER_SUPPLIED_NOMINAL_ASSUMPTION',
        classification:'NON_RECOMMENDATION_PROFILE_CONSTRAINED_WHAT_IF'},
      {assumedAnnualReturnPct:10,monthlyInvestment:5000,years:10,
        totalInvested:600000,futureValue:950000,totalReturns:350000,
        returnBasis:'USER_SUPPLIED_NOMINAL_ASSUMPTION',
        classification:'NON_RECOMMENDATION_PROFILE_CONSTRAINED_WHAT_IF'}
    ],
    differences:{futureValue:100000,invested:0}
  });
  it('shows only expected verified read-only engine output',async()=>{
    const call=vi.spyOn(api,'compareVoiceSipScenarios').mockResolvedValue(verifiedResponse());
    render(<SovereignSipComparison/>);fill();
    await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Run SIP comparison'}));});
    expect(call).toHaveBeenCalledWith({
      monthlyInvestment:5000,years:10,annualReturnAssumptionsPct:[7,10]
    },expect.objectContaining({signal:expect.anything()}));
    expect(screen.getByText('These are hypothetical nominal SIP projections.')).toBeInTheDocument();
    expect(screen.getByText(/₹9,50,000/)).toBeInTheDocument();
  });
  it('never renders an older scenario after editing inputs during an in-flight request',async()=>{
    let resolveRequest;
    const request=vi.spyOn(api,'compareVoiceSipScenarios').mockImplementation(
      () => new Promise(resolve=>{resolveRequest=resolve;})
    );
    render(<SovereignSipComparison/>);fill();
    fireEvent.click(screen.getByRole('button',{name:'Run SIP comparison'}));
    const signal=request.mock.calls[0][1].signal;
    expect(signal.aborted).toBe(false);
    fireEvent.change(screen.getByRole('spinbutton',{name:'Monthly SIP amount'}),{target:{value:'7000'}});
    expect(signal.aborted).toBe(true);
    await act(async()=>{resolveRequest(verifiedResponse());});
    expect(screen.queryByText(/₹8,50,000/)).not.toBeInTheDocument();
    expect(screen.getByRole('button',{name:'Run SIP comparison'})).toBeEnabled();
  });
  it('rejects mismatching source inputs even if server metadata claims validation',async()=>{
    const response=verifiedResponse();
    response.scenarios[0].monthlyInvestment=10000;
    vi.spyOn(api,'compareVoiceSipScenarios').mockResolvedValue(response);
    render(<SovereignSipComparison/>);fill();
    await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Run SIP comparison'}));});
    expect(screen.getByRole('alert')).toHaveTextContent(/Unverified comparison/);
    expect(screen.queryByText(/₹8,50,000/)).not.toBeInTheDocument();
  });
  it('aborts the in-flight comparison immediately on teardown',async()=>{
    let resolveRequest;
    const request=vi.spyOn(api,'compareVoiceSipScenarios').mockImplementation(
      () => new Promise(resolve=>{resolveRequest=resolve;})
    );
    const view=render(<SovereignSipComparison/>);fill();
    fireEvent.click(screen.getByRole('button',{name:'Run SIP comparison'}));
    expect(request).toHaveBeenCalledTimes(1);
    const signal=request.mock.calls[0][1].signal;
    expect(signal.aborted).toBe(false);
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async()=>{resolveRequest({});});
  });
  it('rejects unqualified server responses instead of displaying numbers',async()=>{
    vi.spyOn(api,'compareVoiceSipScenarios').mockResolvedValue({
      version:'sovereign-voice-sip-compare-v1',classification:'PERSONAL_ADVICE',
      persisted:true,scenarios:[{futureValue:99999999}]
    });
    render(<SovereignSipComparison/>);fill();
    await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Run SIP comparison'}));});
    expect(screen.getByRole('alert')).toHaveTextContent(/Unverified comparison/);
    expect(screen.queryByText('99999999')).not.toBeInTheDocument();
  });
});
