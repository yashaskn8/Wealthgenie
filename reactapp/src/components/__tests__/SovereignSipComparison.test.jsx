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
  it('shows only expected verified read-only engine output',async()=>{
    const call=vi.spyOn(api,'compareVoiceSipScenarios').mockResolvedValue({
      version:'sovereign-voice-sip-compare-v1',classification:'UNSAVED_WHAT_IF_SIMULATION',
      persisted:false,note:'Hypothetical returns.',
      scenarios:[
        {assumedAnnualReturnPct:7,totalInvested:600000,futureValue:850000,returnBasis:'USER_SUPPLIED_NOMINAL_ASSUMPTION'},
        {assumedAnnualReturnPct:10,totalInvested:600000,futureValue:950000,returnBasis:'USER_SUPPLIED_NOMINAL_ASSUMPTION'}
      ]
    });
    render(<SovereignSipComparison/>);fill();
    await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Run SIP comparison'}));});
    expect(call).toHaveBeenCalledWith({
      monthlyInvestment:5000,years:10,annualReturnAssumptionsPct:[7,10]
    },expect.objectContaining({signal:expect.anything()}));
    expect(screen.getByText('Hypothetical returns.')).toBeInTheDocument();
    expect(screen.getByText(/₹9,50,000/)).toBeInTheDocument();
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
