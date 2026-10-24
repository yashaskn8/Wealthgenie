import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Volume2, VolumeX } from 'lucide-react';
import * as api from '../services/api';
import { PAGE_ALLOWLIST } from '../utils/navigationMap';

/**
 * An opt-in, bounded voice experience. The model is never an action executor.
 * Only server-classified, independently allowlisted app navigation is supported.
 */
export default function SovereignVoiceControl({
  onNavigate, onTranscript, lastAnswer, sessionKey, disabled = false,
}) {
  const [state, setState] = useState('idle');
  const [status, setStatus] = useState('');
  const listeningRef = useRef(null);
  const requestRef = useRef(null);
  const utteranceRef = useRef(null);
  const generationRef = useRef(0);
  const callbacksRef = useRef({ onNavigate, onTranscript });
  callbacksRef.current = { onNavigate, onTranscript };

  const cancelAll = useCallback(() => {
    generationRef.current += 1;
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

  useEffect(() => () => cancelAll(), [cancelAll, sessionKey]);
  useEffect(() => {
    if (disabled) {
      cancelAll();
      setState('idle');
    }
  }, [disabled, cancelAll]);

  const stop = () => {
    cancelAll();
    setState('idle');
    setStatus('Voice operation stopped.');
  };

  const listen = () => {
    if (disabled) return;
    cancelAll();
    setStatus('');
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (typeof Recognition !== 'function') {
      setState('idle');
      setStatus('Voice input is unavailable in this browser. Use text chat.');
      return;
    }
    const current = generationRef.current;
    const recognition = new Recognition();
    listeningRef.current = recognition;
    recognition.lang = 'en-IN';
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = event => {
      if (current !== generationRef.current) return;
      listeningRef.current = null;
      const transcript = String(event.results?.[0]?.[0]?.transcript || '').trim();
      if (!transcript) {
        setState('idle'); setStatus('No voice command was captured.'); return;
      }
      const controller = new AbortController();
      requestRef.current = controller;
      setState('checking');
      void api.interpretVoiceCommand(transcript, { signal: controller.signal })
        .then(result => {
          if (current !== generationRef.current || controller.signal.aborted) return;
          if (result?.version !== 'sovereign-voice-intent-v1') {
            setStatus('Unrecognized voice response. No action executed.');
          } else if (result.action === 'APP_NAVIGATE' && result.tab === null &&
            PAGE_ALLOWLIST.includes(result.page) && result.page !== 'genieproof') {
            callbacksRef.current.onNavigate?.({ page: result.page, tab: null });
            setStatus('Opened ' + result.page.replace(/-/g, ' ') + '.');
          } else if (result.action === 'CHAT') {
            callbacksRef.current.onTranscript?.(transcript);
            setStatus('Transcript added to chat. Review it before sending.');
          } else {
            setStatus('That voice action is not authorized. Nothing was executed.');
          }
        })
        .catch(() => {
          if (current !== generationRef.current || controller.signal.aborted) return;
          callbacksRef.current.onTranscript?.(transcript);
          setStatus('Voice tasks unavailable. Review the transcript before sending.');
        })
        .finally(() => {
          if (requestRef.current === controller) requestRef.current = null;
          if (current === generationRef.current) setState('idle');
        });
    };
    recognition.onerror = event => {
      if (current !== generationRef.current) return;
      listeningRef.current = null;
      setState('idle');
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
      setState('idle');
      setStatus('Microphone could not start. Use text chat.');
    }
  };

  const canSpeak = lastAnswer?.grounded === true &&
    Array.isArray(lastAnswer.evidence_ids_used) &&
    lastAnswer.evidence_ids_used.length > 0 &&
    lastAnswer.evidence_ids_used.every(id => typeof id === 'string' && id.startsWith('E_') &&
      id !== 'E_CHAT_ANSWER_UNAVAILABLE') &&
    typeof lastAnswer.content === 'string';

  const speak = () => {
    if (!canSpeak || disabled) return;
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
      if (generationRef.current === current) { utteranceRef.current = null; setState('idle'); }
    };
    utterance.onerror = () => {
      if (generationRef.current === current) {
        utteranceRef.current = null;
        setState('idle');
        setStatus('Spoken playback failed. Read the answer in chat.');
      }
    };
    utteranceRef.current = utterance;
    try {
      synth.speak(utterance);
      setState('speaking');
      setStatus('Reading the grounded answer shown in chat.');
    } catch {
      utteranceRef.current = null;
      setState('idle');
      setStatus('Speech playback could not start.');
    }
  };

  return (
    <div className="sovereign-voice-control" aria-label="GenieVoice controls">
      <button type="button" disabled={disabled}
        aria-label={state === 'listening' ? 'Stop GenieVoice listening' :
          state === 'checking' ? 'Stop GenieVoice task' : 'Start GenieVoice navigation'}
        onClick={state === 'listening' || state === 'checking' ? stop : listen}>
        {state === 'listening' || state === 'checking' ? <MicOff size={16} /> : <Mic size={16} />}
        {state === 'listening' ? 'Stop listening' :
          state === 'checking' ? 'Stop task' : 'GenieVoice navigation'}
      </button>
      {canSpeak && (
        <button type="button" disabled={disabled}
          aria-label={state === 'speaking' ? 'Stop verified answer playback' : 'Speak verified answer'}
          onClick={state === 'speaking' ? stop : speak}>
          {state === 'speaking' ? <VolumeX size={16} /> : <Volume2 size={16} />}
          {state === 'speaking' ? 'Stop speaking' : 'Speak verified answer'}
        </button>
      )}
      {state === 'checking' && <span role="status">Checking voice command…</span>}
      <small>Browser speech recognition may process audio through its provider. No background listening.</small>
      {status && <div role="status">{status}</div>}
    </div>
  );
}
