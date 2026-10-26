import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import SovereignVoiceControl from '../SovereignVoiceControl';
import * as api from '../../services/api';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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

  it('stops narration when unrelated text chat starts while playback is active', () => {
    const cancel=vi.fn(),speak=vi.fn();
    vi.stubGlobal('speechSynthesis',{speak,cancel});
    vi.stubGlobal('SpeechSynthesisUtterance',class Utterance {
      constructor(content){this.text=content;}
    });
    const answer={content:'Verified summary.',grounded:true,validation_status:'PASS',
      evidence_ids_used:['E_PROFILE_RISK'],_turnKey:'manual-spoken-1'};
    const ui=render(<SovereignVoiceControl sessionKey="account-a" lastAnswer={answer}/>);
    fireEvent.click(screen.getByRole('button',{name:'Speak verified answer'}));
    expect(speak).toHaveBeenCalledTimes(1);
    ui.rerender(<SovereignVoiceControl sessionKey="account-a" lastAnswer={answer}
      chatBusy/>);
    expect(cancel).toHaveBeenCalled();
    expect(screen.queryByRole('button',{name:'Stop verified answer playback'}))
      .not.toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice navigation'}));
    await act(async()=>{x.getRecognition().onresult({results:[[{transcript:'open\u2028goals'}]]});});
    expect(api.interpretVoiceCommand).not.toHaveBeenCalled();
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
    fireEvent.click(screen.getByRole('button',{name:'Open SIP comparison'}));
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
    expect(screen.queryByRole('spinbutton',{name:'Monthly SIP amount'})).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Open SIP comparison'}));
    expect(screen.getByRole('spinbutton',{name:'Monthly SIP amount'})).toHaveValue(null);
  });

  it('treats interim captions as text only and dispatches once after final speech', async () => {
    const x=setup({version:'sovereign-voice-intent-v1',action:'CHAT'});
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice navigation'}));
    const recognition=x.getRecognition();
    await act(async()=>{
      recognition.onresult({results:[{0:{transcript:'explain my'},isFinal:false,length:1}]});
    });
    expect(api.interpretVoiceCommand).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Voice transcript')).toHaveTextContent('explain my');
    await act(async()=>{
      recognition.onresult({results:[{0:{transcript:'explain my SIP'},isFinal:true,length:1}]});
    });
    expect(api.interpretVoiceCommand).toHaveBeenCalledTimes(1);
  });

  it('conversation mode sends informational questions only after opt-in and reads verified new replies', async () => {
    let recognition;
    class Recognition {
      constructor(){recognition=this;}
      start(){}
      abort(){}
    }
    vi.stubGlobal('SpeechRecognition',Recognition);
    const speak=vi.fn(),cancel=vi.fn();
    let resolveAsk;
    const ask=vi.fn(() => new Promise(resolve => { resolveAsk=resolve; }));
    vi.stubGlobal('speechSynthesis',{speak,cancel});
    vi.stubGlobal('SpeechSynthesisUtterance',class Utterance{
      constructor(content){this.text=content;}
    });
    vi.spyOn(api,'interpretVoiceCommand').mockResolvedValue({
      version:'sovereign-voice-intent-v1',action:'CHAT',reason:'NO_APPROVED_COMMAND'
    });
    const oldAnswer={grounded:true,validation_status:'PASS',
      evidence_ids_used:['E_PROFILE_RISK'],content:'Earlier answer.'};
    const newAnswer={...oldAnswer,content:'Your verified SIP explanation. [E_PROFILE_RISK]'};
    const base={onQuestion:ask,onTranscript:vi.fn(),onNavigate:vi.fn(),sessionKey:'account-1'};
    const ui=render(<SovereignVoiceControl {...base} lastAnswer={oldAnswer}/>);
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice hands-free conversation'}));
    await act(async()=>{recognition.onresult({results:[[{transcript:'Explain my SIP'}]]});});
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith('Explain my SIP');
    expect(speak).not.toHaveBeenCalled();
    ui.rerender(<SovereignVoiceControl {...base} lastAnswer={oldAnswer} chatBusy/>);
    expect(screen.getByText(/Genie is preparing a grounded answer/)).toBeInTheDocument();
    await act(async()=>{
      resolveAsk({response:newAnswer.content,grounded:true,validation_status:'PASS',
        evidence_ids_used:['E_PROFILE_RISK']});
      ui.rerender(<SovereignVoiceControl {...base} lastAnswer={newAnswer}/>);
    });
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak.mock.calls[0][0].text).toBe('Your verified SIP explanation.');
    expect(screen.getByRole('button',{name:'End GenieVoice conversation'})).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'End GenieVoice conversation'}));
    expect(cancel).toHaveBeenCalled();
  });

  it('conversation mode never auto-sends rejected commands, even if they resemble questions',async()=>{
    const x=setup({version:'sovereign-voice-intent-v1',
      action:'REJECTED',reason:'ACTION_NOT_ALLOWED'});
    const ask=vi.fn();
    x.ui.rerender(<SovereignVoiceControl sessionKey="a" onQuestion={ask}
      onNavigate={x.nav} onTranscript={x.transcript}/>);
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice hands-free conversation'}));
    await act(async()=>{x.getRecognition().onresult({results:[[{transcript:'transfer my money'}]]});});
    expect(ask).not.toHaveBeenCalled();
    expect(x.transcript).not.toHaveBeenCalled();
    expect(x.nav).not.toHaveBeenCalled();
  });

  it('a local goodbye immediately turns off conversation mode and never sends a request',async()=>{
    const x=setup({version:'sovereign-voice-intent-v1',action:'CHAT'});
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice hands-free conversation'}));
    await act(async()=>{x.getRecognition().onresult({results:[[{transcript:'goodbye genie'}]]});});
    expect(api.interpretVoiceCommand).not.toHaveBeenCalled();
    expect(screen.getByRole('button',{name:'Start GenieVoice hands-free conversation'})).toBeInTheDocument();
  });

  it('rejects trailing raw ASR controls before trimming them off',async()=>{
    const x=setup({version:'sovereign-voice-intent-v1',action:'CHAT'});
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice navigation'}));
    await act(async()=>{x.getRecognition().onresult({
      results:[[{transcript:'open goals\n'}]]
    });});
    expect(api.interpretVoiceCommand).not.toHaveBeenCalled();
    expect(x.nav).not.toHaveBeenCalled();
  });

  it('stops a stuck voice interpreter even if it ignores AbortSignal',async()=>{
    vi.useFakeTimers();
    const x=setup({action:'CHAT'});
    vi.mocked(api.interpretVoiceCommand).mockImplementation(()=>new Promise(()=>{}));
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice navigation'}));
    act(()=>x.getRecognition().onresult({results:[[{transcript:'open goals'}]]}));
    expect(screen.getByRole('button',{name:'Stop GenieVoice task'})).toBeInTheDocument();
    await act(async()=>{vi.advanceTimersByTime(10_100);});
    expect(screen.queryByRole('button',{name:'Stop GenieVoice task'})).not.toBeInTheDocument();
    expect(screen.getByText(/interpretation timed out/i)).toBeInTheDocument();
    expect(x.nav).not.toHaveBeenCalled();
  });

  it('ends an active conversation when the page is hidden',async()=>{
    const x=setup({action:'CHAT'});
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice hands-free conversation'}));
    expect(screen.getByRole('button',{name:'End GenieVoice conversation'})).toBeInTheDocument();
    vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden');
    await act(async()=>{document.dispatchEvent(new Event('visibilitychange'));});
    expect(screen.getByRole('button',{name:'Start GenieVoice hands-free conversation'})).toBeInTheDocument();
    expect(screen.getByText(/page is no longer active/i)).toBeInTheDocument();
    expect(api.interpretVoiceCommand).not.toHaveBeenCalled();
    // Once the page has been backgrounded, voice may resume only with an explicit gesture.
    expect(x.nav).not.toHaveBeenCalled();
  });

  it('lets the user stop a pending chat reply and fences its late voice answer',async()=>{
    const response={version:'sovereign-voice-intent-v1',action:'CHAT'};
    let resolveAsk;
    const ask=vi.fn(()=>new Promise(resolve=>{resolveAsk=resolve;}));
    const x=setup(response);
    const base={sessionKey:'a',onNavigate:x.nav,onTranscript:x.transcript,onQuestion:ask};
    const voice=vi.fn();
    vi.stubGlobal('speechSynthesis',{speak:voice,cancel:vi.fn()});
    vi.stubGlobal('SpeechSynthesisUtterance',class Utterance {
      constructor(value){this.text=value;}
    });
    x.ui.rerender(<SovereignVoiceControl {...base}/>);
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice hands-free conversation'}));
    await act(async()=>{x.getRecognition().onresult({results:[[{transcript:'Explain my SIP'}]]});});
    expect(ask).toHaveBeenCalledTimes(1);
    x.ui.rerender(<SovereignVoiceControl {...base} chatBusy/>);
    expect(screen.getByRole('button',{name:'End GenieVoice conversation'})).toBeEnabled();
    fireEvent.click(screen.getByRole('button',{name:'End GenieVoice conversation'}));
    const answer={content:'Only a specific verified reply.',grounded:true,validation_status:'PASS',
      evidence_ids_used:['E_PROFILE_RISK']};
    await act(async()=>{
      resolveAsk({...answer,response:answer.content});
      x.ui.rerender(<SovereignVoiceControl {...base} lastAnswer={answer}/>);
    });
    expect(voice).not.toHaveBeenCalled();
    expect(screen.getByRole('button',{name:'Start GenieVoice hands-free conversation'})).toBeInTheDocument();
  });

  it('does not narrate a reply that fails to match the visible chat answer',async()=>{
    vi.useFakeTimers();
    let recognition;
    class Recognition {
      constructor(){recognition=this;}
      start(){}
      abort(){}
    }
    vi.stubGlobal('SpeechRecognition',Recognition);
    const speak=vi.fn();
    vi.stubGlobal('speechSynthesis',{speak,cancel:vi.fn()});
    vi.stubGlobal('SpeechSynthesisUtterance',class Utterance{
      constructor(text){this.text=text;}
    });
    vi.spyOn(api,'interpretVoiceCommand').mockResolvedValue({
      version:'sovereign-voice-intent-v1',action:'CHAT'
    });
    const expected={response:'Expected reply',grounded:true,validation_status:'PASS',
      evidence_ids_used:['E_PROFILE_RISK']};
    const unrelated={content:'Some other conversation',grounded:true,validation_status:'PASS',
      evidence_ids_used:['E_PROFILE_RISK']};
    const ui=render(<SovereignVoiceControl sessionKey="a" onQuestion={()=>Promise.resolve(expected)}/>);
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice hands-free conversation'}));
    await act(async()=>{recognition.onresult({results:[[{transcript:'Explain my goals'}]]});});
    await act(async()=>{ui.rerender(<SovereignVoiceControl sessionKey="a"
      onQuestion={()=>Promise.resolve(expected)} lastAnswer={unrelated}/>);});
    expect(speak).not.toHaveBeenCalled();
    await act(async()=>{vi.advanceTimersByTime(2_100);});
    expect(screen.getByText(/no longer matches chat/i)).toBeInTheDocument();
    expect(speak).not.toHaveBeenCalled();
  });

  it('cancels narration when identical text is replaced by different evidence', () => {
    const speak=vi.fn(),cancel=vi.fn();
    vi.stubGlobal('speechSynthesis',{speak,cancel});
    vi.stubGlobal('SpeechSynthesisUtterance',class Utterance {
      constructor(text){this.text=text;}
    });
    const answer={content:'Verified portfolio statement.',grounded:true,
      validation_status:'PASS',evidence_ids_used:['E_PROFILE_RISK'],
      _turnKey:'same-session-1'};
    const ui=render(<SovereignVoiceControl sessionKey="a" lastAnswer={answer}/>);
    fireEvent.click(screen.getByRole('button',{name:'Speak verified answer'}));
    expect(speak).toHaveBeenCalledTimes(1);
    ui.rerender(<SovereignVoiceControl sessionKey="a" lastAnswer={{
      ...answer,evidence_ids_used:['E_DIFFERENT_EVIDENCE']
    }}/>);
    expect(cancel).toHaveBeenCalled();
    expect(screen.queryByRole('button',{name:'Stop verified answer playback'}))
      .not.toBeInTheDocument();
  });

  it('refuses to narrate the wrong turn even if text and evidence are identical', async () => {
    vi.useFakeTimers();
    let recognition;
    vi.stubGlobal('SpeechRecognition',class Recognition {
      constructor(){recognition=this;}
      start(){}
      abort(){}
    });
    const speak=vi.fn();
    vi.stubGlobal('speechSynthesis',{speak,cancel:vi.fn()});
    vi.stubGlobal('SpeechSynthesisUtterance',class Utterance {
      constructor(text){this.text=text;}
    });
    vi.spyOn(api,'interpretVoiceCommand').mockResolvedValue({
      version:'sovereign-voice-intent-v1',action:'CHAT'
    });
    const response={response:'The shared response.',grounded:true,
      validation_status:'PASS',evidence_ids_used:['E_PROFILE_RISK'],_turnKey:'new-turn'};
    const oldAnswer={content:'The shared response.',grounded:true,
      validation_status:'PASS',evidence_ids_used:['E_PROFILE_RISK'],_turnKey:'old-turn'};
    const ask=vi.fn().mockResolvedValue(response);
    const ui=render(<SovereignVoiceControl sessionKey="a" onQuestion={ask}/>);
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice hands-free conversation'}));
    await act(async()=>recognition.onresult({results:[[{transcript:'Explain diversification'}]]}));
    await act(async()=>ui.rerender(<SovereignVoiceControl sessionKey="a"
      onQuestion={ask} lastAnswer={oldAnswer}/>));
    expect(speak).not.toHaveBeenCalled();
    await act(async()=>vi.advanceTimersByTime(2_100));
    expect(screen.getByText(/no longer matches chat/i)).toBeInTheDocument();
    expect(speak).not.toHaveBeenCalled();
  });

  it('interrupts current speech on a new explicit microphone gesture',()=>{
    const speak=vi.fn(),cancel=vi.fn();
    let micStarts=0;
    vi.stubGlobal('SpeechRecognition',class Recognition{
      start(){micStarts+=1;}
      abort(){}
    });
    vi.stubGlobal('speechSynthesis',{speak,cancel});
    vi.stubGlobal('SpeechSynthesisUtterance',class Utterance{
      constructor(text){this.text=text;}
    });
    const lastAnswer={grounded:true,validation_status:'PASS',
      evidence_ids_used:['E_PROFILE_RISK'],content:'A verified answer.'};
    render(<SovereignVoiceControl sessionKey="a" lastAnswer={lastAnswer}/>);
    fireEvent.click(screen.getByRole('button',{name:'Speak verified answer'}));
    expect(speak).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button',{name:'Interrupt Genie and speak'}));
    expect(cancel).toHaveBeenCalled();
    expect(micStarts).toBe(1);
    expect(screen.getByRole('button',{name:'Stop GenieVoice listening'})).toBeInTheDocument();
  });

  it('switches recognition language only after explicitly stopping the active session',async()=>{
    const x=setup({version:'sovereign-voice-intent-v1',action:'CHAT'});
    fireEvent.change(screen.getByRole('combobox',{name:'GenieVoice speech language'}),{
      target:{value:'hi-IN'}
    });
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice navigation'}));
    expect(x.getRecognition().lang).toBe('hi-IN');
    fireEvent.change(screen.getByRole('combobox',{name:'GenieVoice speech language'}),{
      target:{value:'kn-IN'}
    });
    expect(screen.getByRole('button',{name:'Start GenieVoice navigation'})).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice navigation'}));
    expect(x.getRecognition().lang).toBe('kn-IN');
  });
  it('processes Hindi/Kannada local stop commands without sending any request',async()=>{
    const x=setup({version:'sovereign-voice-intent-v1',action:'CHAT'});
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice hands-free conversation'}));
    await act(async()=>x.getRecognition().onresult({results:[[{transcript:'सुनना बंद करो'}]]}));
    expect(api.interpretVoiceCommand).not.toHaveBeenCalled();
    expect(screen.getByRole('button',{name:'Start GenieVoice hands-free conversation'})).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice hands-free conversation'}));
    await act(async()=>x.getRecognition().onresult({results:[[{transcript:'ಸಂಭಾಷಣೆ ನಿಲ್ಲಿಸು'}]]}));
    expect(api.interpretVoiceCommand).not.toHaveBeenCalled();
  });

});


describe('GenieVoice high-stakes speech review', () => {
  function setup() {
    let recognition;
    class Recognition {
      constructor() { recognition=this; }
      start() {}
      abort() {}
    }
    vi.stubGlobal('SpeechRecognition', Recognition);
    vi.spyOn(api,'interpretVoiceCommand').mockResolvedValue({
      version:'sovereign-voice-intent-v1',action:'CHAT',reason:'NO_APPROVED_COMMAND'
    });
    const ask=vi.fn().mockResolvedValue({grounded:false,validation_status:'UNVERIFIED'});
    const props={sessionKey:'profile-1',onNavigate:vi.fn(),onQuestion:ask,
      onTranscript:vi.fn()};
    const ui=render(<SovereignVoiceControl {...props}/>);
    return {ask,props,ui,getRecognition:()=>recognition};
  }

  it('will not auto-send an ASR financial number until the user confirms it', async () => {
    const t=setup();
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice hands-free conversation'}));
    await act(async()=>{
      t.getRecognition().onresult({results:[[{transcript:
        'What if I invest ₹15000 monthly SIP for 10 years at 8% annual return?'}]]});
    });
    expect(t.ask).not.toHaveBeenCalled();
    expect(screen.getByRole('group',{name:'Review recognized financial question'}))
      .toHaveTextContent('₹15000');
    fireEvent.click(screen.getByRole('button',{name:'Confirm and ask Genie'}));
    await act(async()=>{});
    expect(t.ask).toHaveBeenCalledTimes(1);
    expect(t.ask).toHaveBeenCalledWith(
      'What if I invest ₹15000 monthly SIP for 10 years at 8% annual return?');
    expect(screen.queryByRole('button',{name:'Confirm and ask Genie'})).not.toBeInTheDocument();
  });

  it('cancel, locale switch and profile rebind invalidate an unconfirmed amount', async () => {
    const t=setup();
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice hands-free conversation'}));
    await act(async()=>t.getRecognition().onresult({results:[[{transcript:
      'ಒಂದು ವೇಳೆ ₹೧೫೦೦೦ ಸಿಪ್ ೧೦ ವರ್ಷ ಆಗಿದ್ದರೆ?'}]]}));
    expect(screen.getByRole('button',{name:'Confirm and ask Genie'})).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Cancel voice question'}));
    expect(t.ask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice hands-free conversation'}));
    await act(async()=>t.getRecognition().onresult({results:[[{transcript:
      'What if my portfolio falls 20%?'}]]}));
    fireEvent.change(screen.getByRole('combobox',{name:'GenieVoice speech language'}),{
      target:{value:'hi-IN'}
    });
    expect(screen.queryByRole('button',{name:'Confirm and ask Genie'})).not.toBeInTheDocument();
    expect(t.ask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice hands-free conversation'}));
    await act(async()=>t.getRecognition().onresult({results:[[{transcript:
      'What if my portfolio falls 20%?'}]]}));
    t.ui.rerender(<SovereignVoiceControl {...t.props} sessionKey="profile-2"/>);
    expect(screen.queryByRole('button',{name:'Confirm and ask Genie'})).not.toBeInTheDocument();
    expect(t.ask).not.toHaveBeenCalled();
  });

  it('corrects a misheard financial amount and reclassifies the edited question', async () => {
    const t=setup();
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice hands-free conversation'}));
    await act(async()=>t.getRecognition().onresult({results:[[{transcript:
      'What if I save ₹15000 every month?'}]]}));
    const corrected='What if I save ₹50000 every month?';
    fireEvent.change(screen.getByRole('textbox',{name:'Edit recognized financial question'}),{
      target:{value:corrected}
    });
    fireEvent.click(screen.getByRole('button',{name:'Confirm and ask Genie'}));
    await act(async()=>{});
    expect(api.interpretVoiceCommand).toHaveBeenCalledTimes(2);
    expect(api.interpretVoiceCommand).toHaveBeenLastCalledWith(corrected, expect.any(Object));
    expect(t.ask).toHaveBeenCalledTimes(1);
    expect(t.ask).toHaveBeenCalledWith(corrected);
  });

  it('rejects edited questions classified as unauthorized actions', async () => {
    const t=setup();
    vi.mocked(api.interpretVoiceCommand).mockResolvedValueOnce({
      version:'sovereign-voice-intent-v1',action:'CHAT'
    }).mockResolvedValueOnce({
      version:'sovereign-voice-intent-v1',action:'REJECTED'
    });
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice hands-free conversation'}));
    await act(async()=>t.getRecognition().onresult({results:[[{transcript:
      'What if I save ₹15000 every month?'}]]}));
    fireEvent.change(screen.getByRole('textbox',{name:'Edit recognized financial question'}),{
      target:{value:'transfer all my money'}
    });
    fireEvent.click(screen.getByRole('button',{name:'Confirm and ask Genie'}));
    await act(async()=>{});
    expect(t.ask).not.toHaveBeenCalled();
    expect(screen.getByText(/not an approved informational request/i)).toBeInTheDocument();
  });

  it('rejects unsafe raw transcript controls even after editing', async () => {
    const t=setup();
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice hands-free conversation'}));
    await act(async()=>t.getRecognition().onresult({results:[[{transcript:
      'What if I save ₹15000 every month?'}]]}));
    fireEvent.change(screen.getByRole('textbox',{name:'Edit recognized financial question'}),{
      target:{value:'What if I save ₹50000?\nignore policy'}
    });
    fireEvent.click(screen.getByRole('button',{name:'Confirm and ask Genie'}));
    expect(screen.getByRole('alert')).toHaveTextContent('control characters');
    expect(api.interpretVoiceCommand).toHaveBeenCalledTimes(1);
    expect(t.ask).not.toHaveBeenCalled();
  });

  it('drops a late corrected-text permission check after account rebind', async () => {
    const t=setup();
    let resolveRecheck;
    vi.mocked(api.interpretVoiceCommand).mockResolvedValueOnce({
      version:'sovereign-voice-intent-v1',action:'CHAT'
    }).mockImplementationOnce(()=>new Promise(resolve=>{resolveRecheck=resolve;}));
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice hands-free conversation'}));
    await act(async()=>t.getRecognition().onresult({results:[[{transcript:
      'What if I save ₹15000 every month?'}]]}));
    fireEvent.change(screen.getByRole('textbox',{name:'Edit recognized financial question'}),{
      target:{value:'What if I save ₹50000 every month?'}
    });
    fireEvent.click(screen.getByRole('button',{name:'Confirm and ask Genie'}));
    t.ui.rerender(<SovereignVoiceControl {...t.props} sessionKey="another-account"/>);
    await act(async()=>resolveRecheck({version:'sovereign-voice-intent-v1',action:'CHAT'}));
    expect(t.ask).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox',{name:'Edit recognized financial question'})).not.toBeInTheDocument();
  });

  it('expires hands-free access and ignores an old conversation timeout', () => {
    const t=setup();
    const timer=vi.spyOn(globalThis,'setTimeout');
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice hands-free conversation'}));
    const first=timer.mock.calls.find(([,delay])=>delay===300_000)?.[0];
    expect(first).toBeTypeOf('function');
    fireEvent.click(screen.getByRole('button',{name:'End GenieVoice conversation'}));
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice hands-free conversation'}));
    act(()=>first());
    expect(screen.getByRole('button',{name:'End GenieVoice conversation'})).toBeInTheDocument();
    const last=timer.mock.calls.filter(([,delay])=>delay===300_000).at(-1)?.[0];
    act(()=>last());
    expect(screen.getByRole('button',{name:'Start GenieVoice hands-free conversation'})).toBeInTheDocument();
    expect(screen.getByText(/ended after five minutes/i)).toBeInTheDocument();
    expect(t.ask).not.toHaveBeenCalled();
  });

});


describe('GenieVoice segmented ASR transcript integrity', () => {
  it('waits for all chunks and retains the final financial amount and timing', async () => {
    let recognition;
    class Recognition {
      constructor() { recognition=this; }
      start() {}
      abort() {}
    }
    vi.stubGlobal('SpeechRecognition', Recognition);
    vi.spyOn(api,'interpretVoiceCommand').mockResolvedValue({
      version:'sovereign-voice-intent-v1',action:'CHAT'
    });
    const ask=vi.fn();
    render(<SovereignVoiceControl sessionKey="acct" onQuestion={ask}/>);
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice hands-free conversation'}));
    const first={0:{transcript:'What if my portfolio falls'},isFinal:true,length:1};
    const second={0:{transcript:'20% after year 5'},isFinal:false,length:1};
    await act(async()=>recognition.onresult({results:[first,second],resultIndex:1}));
    expect(api.interpretVoiceCommand).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Voice transcript')).toHaveTextContent('20% after year 5');
    second.isFinal=true;
    await act(async()=>recognition.onresult({results:[first,second],resultIndex:1}));
    expect(api.interpretVoiceCommand).toHaveBeenCalledWith(
      'What if my portfolio falls 20% after year 5',expect.any(Object));
    expect(ask).not.toHaveBeenCalled();
    expect(screen.getByRole('button',{name:'Confirm and ask Genie'})).toBeInTheDocument();
  });
});

describe('GenieVoice adversarial async-boundary regressions', () => {
  it('keeps the newer intent timeout after a cancelled older request settles', async () => {
    vi.useFakeTimers();
    let recognition;
    class Recognition {
      constructor(){ recognition=this; }
      start(){}
      abort(){}
    }
    vi.stubGlobal('SpeechRecognition', Recognition);
    const resolvers=[];
    vi.spyOn(api,'interpretVoiceCommand').mockImplementation(() =>
      new Promise(resolve => { resolvers.push(resolve); }));
    render(<SovereignVoiceControl sessionKey="account-1" onNavigate={vi.fn()}/>);
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice navigation'}));
    act(()=>recognition.onresult({results:[[{transcript:'open goals'}]]}));
    expect(resolvers).toHaveLength(1);
    fireEvent.click(screen.getByRole('button',{name:'Stop GenieVoice task'}));
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice navigation'}));
    act(()=>recognition.onresult({results:[[{transcript:'open goals'}]]}));
    expect(resolvers).toHaveLength(2);
    await act(async()=>resolvers[0]({version:'sovereign-voice-intent-v1',action:'CHAT'}));
    await act(async()=>vi.advanceTimersByTime(10_100));
    expect(screen.getByText(/interpretation timed out/i)).toBeInTheDocument();
    expect(screen.queryByText(/Checking voice command/i)).not.toBeInTheDocument();
  });

  it('keeps the newer answer timeout after an older cancelled answer settles', async () => {
    vi.useFakeTimers();
    let recognition;
    class Recognition {
      constructor(){ recognition=this; }
      start(){}
      abort(){}
    }
    vi.stubGlobal('SpeechRecognition', Recognition);
    vi.spyOn(api,'interpretVoiceCommand').mockResolvedValue({
      version:'sovereign-voice-intent-v1',action:'CHAT'
    });
    const resolveAnswers=[];
    const ask=vi.fn(() => new Promise(resolve => {resolveAnswers.push(resolve);}));
    render(<SovereignVoiceControl sessionKey="account-1" onQuestion={ask}/>);
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice hands-free conversation'}));
    await act(async()=>recognition.onresult({results:[[{transcript:'Explain SIP'}]]}));
    expect(ask).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button',{name:'End GenieVoice conversation'}));
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice hands-free conversation'}));
    await act(async()=>recognition.onresult({results:[[{transcript:'Explain diversification'}]]}));
    expect(ask).toHaveBeenCalledTimes(2);
    await act(async()=>resolveAnswers[0]({grounded:false,validation_status:'UNVERIFIED'}));
    await act(async()=>vi.advanceTimersByTime(45_100));
    expect(screen.getByText(/answer took too long/i)).toBeInTheDocument();
    expect(screen.getByRole('button',{name:'Start GenieVoice hands-free conversation'})).toBeInTheDocument();
  });

  it('does not narrate a same-text answer with different evidence identifiers', async () => {
    vi.useFakeTimers();
    let recognition;
    vi.stubGlobal('SpeechRecognition',class Recognition {
      constructor(){recognition=this;}
      start(){}
      abort(){}
    });
    vi.spyOn(api,'interpretVoiceCommand').mockResolvedValue({
      version:'sovereign-voice-intent-v1',action:'CHAT'
    });
    const speech=vi.fn();
    vi.stubGlobal('speechSynthesis',{speak:speech,cancel:vi.fn()});
    vi.stubGlobal('SpeechSynthesisUtterance',class Utterance {
      constructor(text){this.text=text;}
    });
    const reply={response:'The same sentence.',grounded:true,
      validation_status:'PASS',evidence_ids_used:['E_PROFILE_RISK']};
    const differentEvidence={content:'The same sentence.',grounded:true,
      validation_status:'PASS',evidence_ids_used:['E_UNRELATED_SOURCE']};
    const ui=render(<SovereignVoiceControl sessionKey="account-1"
      onQuestion={()=>Promise.resolve(reply)}/>);
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice hands-free conversation'}));
    await act(async()=>recognition.onresult({results:[[{transcript:'Explain diversification'}]]}));
    await act(async()=>ui.rerender(<SovereignVoiceControl sessionKey="account-1"
      onQuestion={()=>Promise.resolve(reply)} lastAnswer={differentEvidence}/>));
    expect(speech).not.toHaveBeenCalled();
    await act(async()=>vi.advanceTimersByTime(2_100));
    expect(screen.getByText(/no longer matches chat/i)).toBeInTheDocument();
  });

  it('allows only one edited numeric confirmation even when activated twice before rerender', async () => {
    let recognition;
    vi.stubGlobal('SpeechRecognition',class Recognition {
      constructor(){recognition=this;}
      start(){}
      abort(){}
    });
    let resolveCheck;
    const check=vi.spyOn(api,'interpretVoiceCommand')
      .mockResolvedValueOnce({version:'sovereign-voice-intent-v1',action:'CHAT'})
      .mockImplementationOnce(()=>new Promise(resolve=>{resolveCheck=resolve;}));
    const ask=vi.fn().mockResolvedValue({grounded:false,validation_status:'UNVERIFIED'});
    render(<SovereignVoiceControl sessionKey="account-1" onQuestion={ask}/>);
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice hands-free conversation'}));
    await act(async()=>recognition.onresult({results:[[{transcript:
      'What if I invest ₹15000 monthly?'}]]}));
    fireEvent.change(screen.getByRole('textbox',{name:'Edit recognized financial question'}),{
      target:{value:'What if I invest ₹50000 monthly?'}
    });
    const button=screen.getByRole('button',{name:'Confirm and ask Genie'});
    act(()=>{fireEvent.click(button);fireEvent.click(button);});
    expect(check).toHaveBeenCalledTimes(2);
    await act(async()=>resolveCheck({version:'sovereign-voice-intent-v1',action:'CHAT'}));
    expect(ask).toHaveBeenCalledTimes(1);
  });
});

describe('GenieVoice final malformed-ASR adversarial boundaries', () => {
  it('rejects oversized fragmented browser speech without querying the server', async () => {
    let recognition;
    vi.stubGlobal('SpeechRecognition',class Recognition {
      constructor(){recognition=this;}
      start(){}
      abort(){}
    });
    const classify=vi.spyOn(api,'interpretVoiceCommand').mockResolvedValue({
      version:'sovereign-voice-intent-v1',action:'CHAT'
    });
    render(<SovereignVoiceControl sessionKey="final-security-audit"/>);
    fireEvent.click(screen.getByRole('button',{name:'Start GenieVoice navigation'}));
    await act(async()=>recognition.onresult({
      results:Array.from({length:25},()=>[{transcript:'open goals'}])
    }));
    expect(classify).not.toHaveBeenCalled();
    expect(screen.getByText(/capture exceeded safety limits/i)).toBeInTheDocument();
  });
});
