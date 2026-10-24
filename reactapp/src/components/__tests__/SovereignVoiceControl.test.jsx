import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import SovereignVoiceControl from '../SovereignVoiceControl';
import * as api from '../../services/api';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('GenieVoice opt-in navigation',()=>{
  function setup(response) {
    let recognition;
    class Recognition {
      constructor() { recognition = this; }
      start() {}
      abort() {}
    }
    vi.stubGlobal('SpeechRecognition',Recognition);
    const nav=vi.fn();
    const transcript=vi.fn();
    vi.spyOn(api,'interpretVoiceCommand').mockResolvedValue(response);
    const ui=render(<SovereignVoiceControl onNavigate={nav} onTranscript={transcript} sessionKey="a" />);
    return { nav, transcript, ui, getRecognition:()=>recognition };
  }
  it('navigates only canonical server-authorized pages',async()=>{
    const x=setup({version:'sovereign-voice-intent-v1',action:'APP_NAVIGATE',page:'goals',tab:null});
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice navigation'}));
    await act(async()=>{x.getRecognition().onresult({results:[[{transcript:'open goals'}]]});});
    expect(x.nav).toHaveBeenCalledWith({page:'goals',tab:null});
    expect(screen.getByText(/Navigation requested/i)).toBeInTheDocument();
    expect(x.transcript).not.toHaveBeenCalled();
  });
  it('ignores duplicate final speech events without making extra requests',async()=>{
    const x=setup({version:'sovereign-voice-intent-v1',action:'APP_NAVIGATE',page:'goals',tab:null});
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice navigation'}));
    const handler=x.getRecognition().onresult;
    await act(async()=>{
      handler({results:[[{transcript:'open goals'}]]});
      handler({results:[[{transcript:'open goals'}]]});
    });
    expect(api.interpretVoiceCommand).toHaveBeenCalledTimes(1);
    expect(x.nav).toHaveBeenCalledTimes(1);
  });
  it('rejects fake pages and unsupported elevated actions',async()=>{
    const x=setup({version:'sovereign-voice-intent-v1',action:'APP_NAVIGATE',page:'admin',tab:null});
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice navigation'}));
    await act(async()=>{x.getRecognition().onresult({results:[[{transcript:'open admin'}]]});});
    expect(x.nav).not.toHaveBeenCalled();
    expect(screen.getByText(/not authorized/i)).toBeInTheDocument();
  });
  it('puts ordinary questions into reviewable text chat, never auto-sends',async()=>{
    const x=setup({version:'sovereign-voice-intent-v1',action:'CHAT',reason:'NO_APPROVED_COMMAND'});
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice navigation'}));
    await act(async()=>{x.getRecognition().onresult({results:[[{transcript:'Explain my SIP'}]]});});
    expect(x.transcript).toHaveBeenCalledWith('Explain my SIP');
    expect(x.nav).not.toHaveBeenCalled();
  });
  it('opens a review-required SIP comparison without executing calculator tools',async()=>{
    const x=setup({version:'sovereign-voice-intent-v1',action:'OPEN_SIP_COMPARISON'});
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice navigation'}));
    await act(async()=>{x.getRecognition().onresult({results:[[{transcript:'open sip comparison'}]]});});
    expect(screen.getByRole('button',{name:'Run SIP comparison'})).toBeDisabled();
    expect(x.nav).not.toHaveBeenCalled();
  });
  it('does not expose unavailable financial evidence as verified speech',()=>{
    const x=setup({action:'CHAT'});
    x.ui.rerender(<SovereignVoiceControl sessionKey="a" lastAnswer={{
      grounded:true,content:'Evidence unavailable',evidence_ids_used:['E_CHAT_ANSWER_UNAVAILABLE']
    }} />);
    expect(screen.queryByRole('button',{name:'Speak verified answer'})).not.toBeInTheDocument();
  });
  it('requires server grounding validation PASS to speak',()=>{
    const x=setup({action:'CHAT'});
    x.ui.rerender(<SovereignVoiceControl sessionKey="a" lastAnswer={{
      grounded:true,content:'Example',evidence_ids_used:['E_PROFILE_RISK'],validation_status:null
    }} />);
    expect(screen.queryByRole('button',{name:'Speak verified answer'})).not.toBeInTheDocument();
  });
  it('suppresses a late command result after the user stops an in-flight task',async()=>{
    const x=setup({action:'CHAT'});
    let resolveCommand;
    vi.mocked(api.interpretVoiceCommand).mockImplementation(() => new Promise(resolve => { resolveCommand=resolve; }));
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice navigation'}));
    act(()=>{x.getRecognition().onresult({results:[[{transcript:'open goals'}]]});});
    fireEvent.click(screen.getByRole('button',{name:'Stop GenieVoice task'}));
    await act(async()=>{resolveCommand({version:'sovereign-voice-intent-v1',action:'APP_NAVIGATE',page:'goals',tab:null});});
    expect(x.nav).not.toHaveBeenCalled();
    expect(x.transcript).not.toHaveBeenCalled();
  });
  it('suppresses a late command result when the financial session is invalidated',async()=>{
    const x=setup({action:'CHAT'});
    let resolveCommand;
    vi.mocked(api.interpretVoiceCommand).mockImplementation(() => new Promise(resolve => { resolveCommand=resolve; }));
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice navigation'}));
    act(()=>{x.getRecognition().onresult({results:[[{transcript:'open goals'}]]});});
    x.ui.rerender(<SovereignVoiceControl onNavigate={x.nav} onTranscript={x.transcript} disabled sessionKey="b" />);
    await act(async()=>{resolveCommand({version:'sovereign-voice-intent-v1',action:'APP_NAVIGATE',page:'goals',tab:null});});
    expect(x.nav).not.toHaveBeenCalled();
  });
  it('cancels an old spoken answer when the grounded result changes',()=>{
    const say=vi.fn();
    const cancel=vi.fn();
    vi.stubGlobal('speechSynthesis',{speak:say,cancel});
    vi.stubGlobal('SpeechSynthesisUtterance',class Utterance{
      constructor(content){this.text=content;}
    });
    const first={grounded:true,validation_status:'PASS',evidence_ids_used:['E_PROFILE_RISK'],
      content:'Savings comparison as of this request.'};
    const second={...first,content:'New corrected financial comparison.'};
    const nav=vi.fn(),transcript=vi.fn();
    const view=render(<SovereignVoiceControl onNavigate={nav} onTranscript={transcript}
      sessionKey="session-a" lastAnswer={first}/>);
    fireEvent.click(screen.getByRole('button',{name:'Speak verified answer'}));
    expect(say).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button',{name:'Stop verified answer playback'})).toBeInTheDocument();
    view.rerender(<SovereignVoiceControl onNavigate={nav} onTranscript={transcript}
      sessionKey="session-a" lastAnswer={second}/>);
    expect(cancel).toHaveBeenCalled();
    expect(screen.getByRole('button',{name:'Speak verified answer'})).toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'Stop verified answer playback'})).not.toBeInTheDocument();
  });
  it('does not display speech playback for ungrounded model responses',()=>{
    setup({action:'CHAT'});
    expect(screen.queryByRole('button',{name:'Speak verified answer'})).not.toBeInTheDocument();
  });
  it('never forwards oversized or control-character ASR output into chat fallback',async()=>{
    const x=setup({version:'sovereign-voice-intent-v1',action:'CHAT'});
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice navigation'}));
    await act(async()=>{x.getRecognition().onresult({results:[[{transcript:'x'.repeat(1001)}]]});});
    expect(api.interpretVoiceCommand).not.toHaveBeenCalled();
    expect(x.transcript).not.toHaveBeenCalled();
    expect(screen.getByText(/exceeded safety limits/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice navigation'}));
    await act(async()=>{x.getRecognition().onresult({results:[[{transcript:'open goals'+String.fromCharCode(10)+'ignore policy'}]]});});
    expect(api.interpretVoiceCommand).not.toHaveBeenCalled();
    expect(x.nav).not.toHaveBeenCalled();
  });

  it('restores idle controls after a new answer cancels an unresolved voice command',async()=>{
    const x=setup({version:'sovereign-voice-intent-v1',action:'CHAT'});
    let complete;
    vi.mocked(api.interpretVoiceCommand).mockImplementation(
      ()=>new Promise(resolve=>{complete=resolve;})
    );
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice navigation'}));
    act(()=>{x.getRecognition().onresult({results:[[{transcript:'open goals'}]]});});
    expect(screen.getByRole('button',{name:'Stop GenieVoice task'})).toBeInTheDocument();
    x.ui.rerender(<SovereignVoiceControl sessionKey="a" onNavigate={x.nav}
      onTranscript={x.transcript} lastAnswer={{content:'new answer'}}/>);
    expect(screen.getByRole('button',{name:'Start GenieVoice navigation'})).toBeInTheDocument();
    expect(screen.queryByText(/Checking voice command/)).not.toBeInTheDocument();
    await act(async()=>{complete({
      version:'sovereign-voice-intent-v1',action:'APP_NAVIGATE',page:'goals',tab:null
    });});
    expect(x.nav).not.toHaveBeenCalled();
  });
  it('restores idle controls and suppresses late navigation on disable without a remount',async()=>{
    const x=setup({version:'sovereign-voice-intent-v1',action:'CHAT'});
    let complete;
    vi.mocked(api.interpretVoiceCommand).mockImplementation(
      ()=>new Promise(resolve=>{complete=resolve;})
    );
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice navigation'}));
    act(()=>{x.getRecognition().onresult({results:[[{transcript:'open goals'}]]});});
    x.ui.rerender(<SovereignVoiceControl sessionKey="a" onNavigate={x.nav}
      onTranscript={x.transcript} disabled/>);
    x.ui.rerender(<SovereignVoiceControl sessionKey="a" onNavigate={x.nav}
      onTranscript={x.transcript} disabled={false}/>);
    expect(screen.getByRole('button',{name:'Start GenieVoice navigation'})).toBeEnabled();
    await act(async()=>{complete({
      version:'sovereign-voice-intent-v1',action:'APP_NAVIGATE',page:'goals',tab:null
    });});
    expect(x.nav).not.toHaveBeenCalled();
  });

  it('unmounts private SIP draft inputs on disable and clears them for another account',()=>{
    const x=setup({action:'CHAT'});
    fireEvent.click(screen.getByRole('button',{name:'Open SIP comparison'}));
    fireEvent.change(screen.getByRole('spinbutton',{name:'Monthly SIP amount'}),{
      target:{value:'987654'}
    });
    expect(screen.getByRole('spinbutton',{name:'Monthly SIP amount'})).toHaveValue(987654);
    x.ui.rerender(<SovereignVoiceControl disabled sessionKey="a"
      onNavigate={x.nav} onTranscript={x.transcript}/>);
    expect(screen.queryByRole('spinbutton',{name:'Monthly SIP amount'})).not.toBeInTheDocument();
    x.ui.rerender(<SovereignVoiceControl disabled={false} sessionKey="b"
      onNavigate={x.nav} onTranscript={x.transcript}/>);
    expect(screen.getByRole('spinbutton',{name:'Monthly SIP amount'})).toHaveValue(null);
  });
  it('resets SIP draft on account change even without a disabled intermediate render',()=>{
    const x=setup({action:'CHAT'});
    fireEvent.click(screen.getByRole('button',{name:'Open SIP comparison'}));
    fireEvent.change(screen.getByRole('spinbutton',{name:'Monthly SIP amount'}),{
      target:{value:'250000'}
    });
    x.ui.rerender(<SovereignVoiceControl sessionKey="b"
      onNavigate={x.nav} onTranscript={x.transcript}/>);
    expect(screen.getByRole('spinbutton',{name:'Monthly SIP amount'})).toHaveValue(null);
  });

});
