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
    expect(x.transcript).not.toHaveBeenCalled();
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
  it('does not display speech playback for ungrounded model responses',()=>{
    setup({action:'CHAT'});
    expect(screen.queryByRole('button',{name:'Speak verified answer'})).not.toBeInTheDocument();
  });
});
