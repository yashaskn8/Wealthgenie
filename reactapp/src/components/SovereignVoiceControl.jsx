import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Mic, MicOff, Volume2, VolumeX } from 'lucide-react';
import * as api from '../services/api';
import { PAGE_ALLOWLIST } from '../utils/navigationMap';
import SovereignSipComparison from './SovereignSipComparison';
import './SovereignVoiceControl.css';

/**
 * An opt-in, bounded voice experience. The model is never an action executor.
 * Only server-classified, independently allowlisted app navigation is supported.
 */
export default function SovereignVoiceControl({
  onNavigate, onTranscript, onQuestion, lastAnswer, sessionKey, chatBusy = false, disabled = false,
}) {
  const [state, setState] = useState('idle');
  const [spokenAnswer, setSpokenAnswer] = useState(null);
  const [status, setStatus] = useState('');
  const [showComparison, setShowComparison] = useState(false);
  const [handsFree, setHandsFree] = useState(false);
  const [caption, setCaption] = useState('');
  const handsFreeRef = useRef(false);
  // Pending turns are local to the current mounted financial/chat session.
  // Never persist a spoken transcript or enable an assistant action implicitly.
  const pendingReplyRef = useRef(null);
  const restartTimerRef = useRef(null);
  const lastAnswerRef = useRef(lastAnswer);
  const busyRef = useRef(chatBusy);
  const listeningRef = useRef(null);
  const requestRef = useRef(null);
  const utteranceRef = useRef(null);
  const generationRef = useRef(0);
  const callbacksRef = useRef({ onNavigate, onTranscript, onQuestion });
  const enabledRef = useRef(!disabled);
  useLayoutEffect(() => {
    enabledRef.current = !disabled;
    busyRef.current = chatBusy;
    lastAnswerRef.current = lastAnswer;
    callbacksRef.current = { onNavigate, onTranscript, onQuestion };
  }, [disabled, chatBusy, lastAnswer, onNavigate, onTranscript, onQuestion]);

  const cancelAll = useCallback(() => {
    generationRef.current += 1;
    if (restartTimerRef.current !== null) clearTimeout(restartTimerRef.current);
    restartTimerRef.current = null;
    const recognition = listeningRef.current;
    listeningRef.current = null;
    if (recognition) {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.abort?.();
    }
    requestRef.current?.abort();
    requestRef.current = null;
    if (utteranceRef.current) window.speechSynthesis?.cancel?.();
    utteranceRef.current = null;
  }, []);

  useLayoutEffect(() => () => {
    handsFreeRef.current = false;
    pendingReplyRef.current = null;
    cancelAll();
  }, [cancelAll, sessionKey]);
  // A changed verified reply must never leave the old answer speaking.
  useLayoutEffect(() => () => cancelAll(), [cancelAll, lastAnswer]);
  useEffect(() => {
    if (disabled) {
      handsFreeRef.current = false;
      pendingReplyRef.current = null;
      setHandsFree(false);
      setCaption('');
      cancelAll();
    }
  }, [disabled, cancelAll]);
  useEffect(() => {
    if (!chatBusy) return;
    // The input microphone is OFF while the grounded chat pipeline is working.
    cancelAll();
    setState(pendingReplyRef.current ? 'thinking' : 'idle');
  }, [chatBusy, cancelAll]);
  // Reset derived control state during the render that receives the new props,
  // not synchronously inside an effect (which causes cascading renders).
  // This also prevents an old 'checking' latch surviving disable/re-enable.
  const [boundContext, setBoundContext] = useState({ sessionKey, lastAnswer, disabled });
  if (boundContext.sessionKey !== sessionKey ||
      boundContext.lastAnswer !== lastAnswer || boundContext.disabled !== disabled) {
    setBoundContext({ sessionKey, lastAnswer, disabled });
    setState('idle');
    setSpokenAnswer(null);
    setStatus('');
    setCaption('');
  }

  const stop = () => {
    handsFreeRef.current = false;
    setHandsFree(false);
    pendingReplyRef.current = null;
    cancelAll();
    setState('idle');
    setSpokenAnswer(null);
    setCaption('');
    setStatus('Voice operation stopped.');
  };

  // Re-arm only after a completed, authorized navigation or completed TTS.
  // No always-on recognition, hidden microphone, or overlap with TTS.
  const resumeAfterTurn = current => {
    if (!handsFreeRef.current || !enabledRef.current || busyRef.current) return;
    restartTimerRef.current = setTimeout(() => {
      restartTimerRef.current = null;
      if (generationRef.current === current && handsFreeRef.current &&
          enabledRef.current && !busyRef.current) listen();
    }, 450);
  };

  const listen = () => {
    if (disabled || chatBusy || !enabledRef.current || busyRef.current) return;
    cancelAll();
    setStatus('');
    setCaption('');
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (typeof Recognition !== 'function') {
      handsFreeRef.current = false;
      setHandsFree(false);
      setState('idle');
      setStatus('Voice input is unavailable in this browser. Use text chat.');
      return;
    }
    const current = generationRef.current;
    const recognition = new Recognition();
    listeningRef.current = recognition;
    recognition.lang = 'en-IN';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.onresult = event => {
      // Only a final segment can trigger a request. Interim segments are captions.
      if (current !== generationRef.current || listeningRef.current !== recognition) return;
      let finalTranscript = null;
      const segments = event.results || [];
      for (let i = Math.max(0, event.resultIndex || 0); i < segments.length; i += 1) {
        const candidate = segments[i]?.[0]?.transcript;
        if (typeof candidate !== 'string') continue;
        if (segments[i].isFinal === false) {
          setCaption(candidate.slice(0, 1000));
        } else {
          finalTranscript = candidate;
        }
      }
      if (finalTranscript === null) return;
      listeningRef.current = null;
      // Validate raw ASR before trim. Trimming CR/LF or invisible chars would
      // bypass the backend's exact same untrusted-input boundary.
      const transcript = finalTranscript.trim();
      if (finalTranscript.length > 1000 ||
          /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(finalTranscript)) {
        setState('idle');
        setStatus('Voice transcript exceeded safety limits. Use text chat instead.');
        return;
      }
      if (!transcript) {
        setState('idle'); setStatus('No voice command was captured.'); return;
      }
      setCaption(transcript);
      // A local opt-out never goes to the server, chat or the action router.
      if (/^(?:stop listening|goodbye genie|end conversation|cancel voice mode)[.!?]*$/i.test(transcript)) {
        stop();
        return;
      }
      const controller = new AbortController();
      requestRef.current = controller;
      setState('checking');
      void api.interpretVoiceCommand(transcript, { signal: controller.signal })
        .then(result => {
          if (current !== generationRef.current || controller.signal.aborted || !enabledRef.current) return;
          if (result?.version !== 'sovereign-voice-intent-v1') {
            setStatus('Unrecognized voice response. No action executed.');
          } else if (result.action === 'APP_NAVIGATE' && result.tab === null &&
            PAGE_ALLOWLIST.includes(result.page) && result.page !== 'genieproof') {
            try {
              callbacksRef.current.onNavigate?.({ page: result.page, tab: null });
              setStatus('Navigation requested: ' + result.page.replace(/-/g, ' ') + '.');
              resumeAfterTurn(current);
            } catch {
              setStatus('Navigation outcome could not be confirmed. No further tasks will run.');
            }
          } else if (result.action === 'OPEN_SIP_COMPARISON') {
            setShowComparison(true);
            setStatus('SIP comparison ready. Enter and review two hypothetical return assumptions before calculating.');
          } else if (result.action === 'CHAT') {
            if (handsFreeRef.current && typeof callbacksRef.current.onQuestion === 'function') {
              // Informational questions only, and only after the user explicitly
              // enables hands-free mode. Never auto-dispatch rejected operations.
              pendingReplyRef.current = { previousAnswer: lastAnswerRef.current, sawBusy: false };
              setState('thinking');
              setStatus('Asking Genie. The microphone is off while Genie responds.');
              try {
                const request = callbacksRef.current.onQuestion(transcript);
                Promise.resolve(request).catch(() => {
                  if (current === generationRef.current) {
                    pendingReplyRef.current = null;
                    setState('idle');
                    setStatus('Genie could not send that question. Review the chat before retrying.');
                  }
                });
              } catch {
                pendingReplyRef.current = null;
                setState('idle');
                setStatus('Genie could not send that question. Review the chat before retrying.');
              }
            } else {
              callbacksRef.current.onTranscript?.(transcript);
              setStatus('Transcript added to chat. Review it before sending.');
            }
          } else {
            setStatus('That voice action is not authorized. Nothing was executed.');
          }
        })
        .catch(() => {
          if (current !== generationRef.current || controller.signal.aborted || !enabledRef.current) return;
          handsFreeRef.current = false;
          setHandsFree(false);
          pendingReplyRef.current = null;
          callbacksRef.current.onTranscript?.(transcript);
          setStatus('Voice tasks unavailable. Review the transcript before sending.');
        })
        .finally(() => {
          if (requestRef.current === controller) requestRef.current = null;
          if (current === generationRef.current)
            setState(pendingReplyRef.current ? 'thinking' : 'idle');
        });
    };
    recognition.onerror = event => {
      if (current !== generationRef.current) return;
      listeningRef.current = null;
      setState('idle');
      handsFreeRef.current = false;
      setHandsFree(false);
      setStatus(event?.error === 'not-allowed' ? 'Microphone permission denied.' :
        'Voice capture failed. Use text chat.');
    };
    recognition.onend = () => {
      if (current !== generationRef.current) return;
      listeningRef.current = null;
      // onend commonly fires after onresult, while classification remains pending.
      if (!requestRef.current) setState('idle');
    };
    try {
      recognition.start();
      setState('listening');
    } catch {
      listeningRef.current = null;
      handsFreeRef.current = false;
      setHandsFree(false);
      setState('idle');
      setStatus('Microphone could not start. Use text chat.');
    }
  };

  const canSpeak = lastAnswer?.grounded === true &&
    lastAnswer.validation_status === 'PASS' &&
    Array.isArray(lastAnswer.evidence_ids_used) &&
    lastAnswer.evidence_ids_used.length > 0 &&
    lastAnswer.evidence_ids_used.every(id => typeof id === 'string' && id.startsWith('E_') &&
      id !== 'E_CHAT_ANSWER_UNAVAILABLE') &&
    typeof lastAnswer.content === 'string';

  const speak = (autoResume = false) => {
    if (!canSpeak || disabled || chatBusy) return;
    const synth = window.speechSynthesis;
    if (!synth || typeof window.SpeechSynthesisUtterance !== 'function') {
      setStatus('Browser speech output is unavailable. Read the answer in chat.');
      return;
    }
    const words = lastAnswer.content.replace(/\[E_[A-Z0-9_:-]+\]/g, '').trim();
    if (!words || words.length > 2400) {
      setStatus('The answer cannot safely be played as browser speech.');
      return;
    }
    cancelAll();
    const current = generationRef.current;
    const utterance = new window.SpeechSynthesisUtterance(words);
    utterance.lang = 'en-IN';
    utterance.onend = () => {
      if (generationRef.current === current) {
        utteranceRef.current = null;
        setSpokenAnswer(null);
        setState('idle');
        if (autoResume) resumeAfterTurn(current);
      }
    };
    utterance.onerror = () => {
      if (generationRef.current === current) {
        utteranceRef.current = null;
        setSpokenAnswer(null);
        setState('idle');
        handsFreeRef.current = false;
        setHandsFree(false);
        setStatus('Spoken playback failed. Read the answer in chat.');
      }
    };
    utteranceRef.current = utterance;
    setSpokenAnswer(lastAnswer);
    try {
      synth.speak(utterance);
      setState('speaking');
      setStatus('Reading the grounded answer shown in chat.');
    } catch {
      utteranceRef.current = null;
      setSpokenAnswer(null);
      setState('idle');
      setStatus('Speech playback could not start.');
    }
  };

  // Chat completion may happen after a busy render. Never read old or unverified
  // financial responses, even if another conversation changed meanwhile.
  useEffect(() => {
    const pending = pendingReplyRef.current;
    if (!handsFreeRef.current || !pending || disabled) return;
    if (chatBusy) {
      pending.sawBusy = true;
      return;
    }
    if (lastAnswer && lastAnswer !== pending.previousAnswer) {
      pendingReplyRef.current = null;
      if (canSpeak) speak(true);
      else {
        setState('idle');
        setStatus('The reply is in chat, but is not verified for voice playback.');
      }
    } else if (pending.sawBusy) {
      // A failed or rate-limited question must not start listening again.
      pendingReplyRef.current = null;
      setState('idle');
      setStatus('The voice question did not produce a new answer. Check chat to retry.');
    }
  }, [lastAnswer, chatBusy, disabled, canSpeak, speak]);

  const toggleConversation = () => {
    if (handsFreeRef.current) {
      stop();
      return;
    }
    handsFreeRef.current = true;
    setHandsFree(true);
    listen(); // direct user gesture is required for microphone permission
    setStatus('Conversation mode on. Questions send to chat automatically; no financial transactions.');
  };

  const activelySpeaking = state === 'speaking' && spokenAnswer === lastAnswer;
  return (
    <div className="sovereign-voice-control" aria-label="GenieVoice controls">
      <button type="button" disabled={disabled || chatBusy}
        aria-label={state === 'listening' ? 'Stop GenieVoice listening' :
          state === 'checking' ? 'Stop GenieVoice task' : 'Start GenieVoice navigation'}
        onClick={state === 'listening' || state === 'checking' ? stop : listen}>
        {state === 'listening' || state === 'checking' ? <MicOff size={16} /> : <Mic size={16} />}
        {state === 'listening' ? 'Stop listening' :
          state === 'checking' ? 'Stop task' : 'GenieVoice navigation'}
      </button>
      <button type="button" disabled={disabled || chatBusy}
        aria-label={handsFree ? 'End GenieVoice conversation' : 'Start GenieVoice hands-free conversation'}
        aria-pressed={handsFree} onClick={toggleConversation}>
        {handsFree ? 'End conversation' : 'Conversation mode'}
      </button>
      {canSpeak && (
        <button type="button" disabled={disabled || chatBusy}
          aria-label={activelySpeaking ? 'Stop verified answer playback' : 'Speak verified answer'}
          onClick={activelySpeaking ? stop : () => speak(false)}>
          {activelySpeaking ? <VolumeX size={16} /> : <Volume2 size={16} />}
          {activelySpeaking ? 'Stop speaking' : 'Speak verified answer'}
        </button>
      )}
      <button type="button" disabled={disabled || chatBusy || state === 'checking'}
        onClick={() => { cancelAll(); setState('idle'); setShowComparison(v => !v); }}
        aria-label={showComparison ? 'Close SIP comparison' : 'Open SIP comparison'}>
        {showComparison ? 'Close SIP comparison' : 'Compare SIP scenarios'}
      </button>
      {!disabled && showComparison && <SovereignSipComparison
        key={String(sessionKey ?? '')} disabled={disabled || chatBusy}
        onClose={() => setShowComparison(false)} />}
      {state === 'checking' && <span role="status">Checking voice command…</span>}
      {state === 'thinking' && <span role="status">Genie is preparing a grounded answer…</span>}
      {caption && <div className="genie-voice-caption" aria-label="Voice transcript">{caption}</div>}
      <small>Conversation mode automatically sends spoken questions and listens again only after verified speech.
        Stop it anytime. Browser recognition may process audio through its provider.</small>
      {status && <div role="status">{status}</div>}
    </div>
  );
}
