/* eslint-disable react-hooks/set-state-in-effect -- external microphone, visibility and
   synthesis events must synchronously invalidate pending audio on prop changes */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Mic, MicOff, Volume2, VolumeX } from 'lucide-react';
import * as api from '../services/api';
import SovereignSipComparison from './SovereignSipComparison';
import {
  VOICE_INTENT_VERSION, VOICE_CAPTURE_TIMEOUT_MS, VOICE_INTENT_TIMEOUT_MS,
  VOICE_REPLY_TIMEOUT_MS, VOICE_SPEECH_TIMEOUT_MS, VOICE_CONVERSATION_MAX_MS,
  validateVoiceTranscript,
  isVoiceStopPhrase, isAuthorizedVoiceNavigation, isVerifiedVoiceAnswer,
  sameVerifiedVoiceReply, voiceAnswerText,
} from '../utils/voiceRuntimePolicy';
import { VOICE_LANGUAGES, validVoiceLanguage, isLocalVoiceStop,
  speechLocaleForText, voiceInLocale } from '../utils/voiceLanguagePolicy';
import { needsFinancialTranscriptReview } from '../utils/voiceFinancialTranscriptReview';
import './SovereignVoiceControl.css';

function clearVoiceTimer(ref) {
  if (ref.current !== null) clearTimeout(ref.current);
  ref.current = null;
}

/**
 * Opt-in, foreground-only voice controller.
 *
 * One microphone -> one final transcript -> one authenticated intent -> at most
 * one authorized action or chat turn. A generation fence invalidates all
 * callbacks when the user stops or changes sessions. Neither ASR, model output,
 * nor web content may grant additional tool privileges.
 */
export default function SovereignVoiceControl({
  onNavigate, onTranscript, onQuestion, lastAnswer, sessionKey,
  chatBusy = false, disabled = false,
}) {
  const [language, setLanguage] = useState('en-IN');
  const [pendingReview, setPendingReview] = useState(null);
  const [reviewDraft, setReviewDraft] = useState('');
  const [reviewError, setReviewError] = useState('');
  const [phase, setPhase] = useState('idle');
  const [status, setStatus] = useState('');
  const [caption, setCaption] = useState('');
  const [handsFree, setHandsFree] = useState(false);
  const [spokenAnswer, setSpokenAnswer] = useState(null);
  const [showComparison, setShowComparison] = useState(false);
  const [replyVersion, setReplyVersion] = useState(0);

  const epochRef = useRef(0);
  const conversationEpochRef = useRef(0);
  const enabledRef = useRef(!disabled);
  const busyRef = useRef(chatBusy);
  const handsFreeRef = useRef(false);
  const callbacksRef = useRef({ onNavigate, onTranscript, onQuestion });
  const listeningRef = useRef(null);
  const reviewRef = useRef(null);
  const intentRef = useRef(null);
  const utteranceRef = useRef(null);
  const spokenRef = useRef(null);
  const replyReadyRef = useRef(null);
  const latestAnswerRef = useRef(lastAnswer);
  const listenActionRef = useRef(null);
  const captureTimerRef = useRef(null);
  const intentTimerRef = useRef(null);
  const replyTimerRef = useRef(null);
  const replyDisplayTimerRef = useRef(null);
  const speechTimerRef = useRef(null);
  const restartTimerRef = useRef(null);
  const conversationTimerRef = useRef(null);

  useLayoutEffect(() => {
    enabledRef.current = !disabled;
    busyRef.current = chatBusy;
    callbacksRef.current = { onNavigate, onTranscript, onQuestion };
  }, [disabled, chatBusy, onNavigate, onTranscript, onQuestion]);

    const stopRecognition = useCallback(() => {
    if (captureTimerRef.current !== null) clearTimeout(captureTimerRef.current);
    captureTimerRef.current = null;
    const recognition = listeningRef.current;
    listeningRef.current = null;
    if (recognition) {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      try { recognition.abort?.(); } catch { /* already closed */ }
    }
  }, []);

  const stopSpeech = useCallback(() => {
    if (speechTimerRef.current !== null) clearTimeout(speechTimerRef.current);
    speechTimerRef.current = null;
    const utterance = utteranceRef.current;
    utteranceRef.current = null;
    spokenRef.current = null;
    if (utterance) {
      utterance.onend = null;
      utterance.onerror = null;
      try { window.speechSynthesis?.cancel?.(); } catch { /* provider shutdown */ }
    }
  }, []);

  const stopIO = useCallback(() => {
    for (const ref of [intentTimerRef, replyTimerRef, replyDisplayTimerRef, restartTimerRef]) {
      if (ref.current !== null) clearTimeout(ref.current);
      ref.current = null;
    }
    stopRecognition();
    intentRef.current?.abort();
    intentRef.current = null;
    stopSpeech();
    replyReadyRef.current = null;
  }, [stopRecognition, stopSpeech]);

  const endConversation = useCallback((message = 'Voice operation stopped.') => {
    epochRef.current += 1;
    conversationEpochRef.current += 1;
    handsFreeRef.current = false;
    reviewRef.current = null;
    clearVoiceTimer(conversationTimerRef);
    stopIO();
    setPendingReview(null);
    setReviewDraft('');
    setReviewError('');
    setHandsFree(false);
    setPhase('idle');
    setSpokenAnswer(null);
    setCaption('');
    setStatus(message);
  }, [stopIO]);

  // Unmount, logout or session rebinding must fence every old callback before
  // any new account can receive a voice response.
  useLayoutEffect(() => {
    return () => {
      epochRef.current += 1;
      conversationEpochRef.current += 1;
      handsFreeRef.current = false;
      reviewRef.current = null;
      clearVoiceTimer(conversationTimerRef);
      stopIO();
    };
  }, [sessionKey, stopIO]);

  useEffect(() => {
    if (disabled) endConversation('Voice is unavailable for this session.');
  }, [disabled, endConversation]);

  useLayoutEffect(() => {
    // A component may survive a financial account change without remounting.
    // Reset all UI state, in addition to the separate epoch cleanup above.
    setHandsFree(false);
    setPendingReview(null);
    setReviewDraft('');
    setReviewError('');
    setPhase('idle');
    setSpokenAnswer(null);
    setCaption('');
    setShowComparison(false);
  }, [sessionKey]);

  // Browser visibility is part of the microphone's permission boundary.
  useEffect(() => {
    const hide = () => {
      if (document.visibilityState === 'hidden' || !enabledRef.current)
        endConversation('Voice stopped because this page is no longer active.');
    };
    const pagehide = () => endConversation('Voice stopped because the page is leaving.');
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('pagehide', pagehide);
    return () => {
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('pagehide', pagehide);
    };
  }, [endConversation]);

  // A manual chat send while the microphone is active is an interruption.
  // Do not cancel a voice-originated chat response (the mic is already off).
  useEffect(() => {
    if (chatBusy && listeningRef.current) {
      endConversation('Voice paused because another chat request started.');
    }
  }, [chatBusy, endConversation]);

  // A new unrelated chat answer invalidates in-flight intent classification
  // and any stale narration. A voice-originated reply is matched separately
  // against the exact authenticated response after its request finishes.
  useLayoutEffect(() => {
    if (latestAnswerRef.current !== lastAnswer) {
      latestAnswerRef.current = lastAnswer;
      if (intentRef.current ||
          (utteranceRef.current && !sameVerifiedVoiceReply(spokenRef.current?.answer, lastAnswer))) {
        endConversation('The displayed answer changed; the old voice turn was stopped.');
      }
    }
  }, [lastAnswer, endConversation]);

  const scheduleResume = useCallback(token => {
    if (!handsFreeRef.current || !enabledRef.current || busyRef.current ||
        document.visibilityState === 'hidden') return;
    clearVoiceTimer(restartTimerRef);
    restartTimerRef.current = setTimeout(() => {
      restartTimerRef.current = null;
      if (epochRef.current === token && handsFreeRef.current &&
          enabledRef.current && !busyRef.current &&
          document.visibilityState !== 'hidden') {
        listenActionRef.current?.();
      }
    }, 500);
  }, []);

  const startSpeech = useCallback((answer, resume, token) => {
    if (!enabledRef.current || busyRef.current || epochRef.current !== token) return;
    const words = voiceAnswerText(answer);
    if (!words) {
      if (resume) endConversation('The answer is in chat but cannot be verified for voice playback.');
      else setStatus('This answer cannot safely be played as browser speech.');
      return;
    }
    const synth = window.speechSynthesis;
    const Utterance = window.SpeechSynthesisUtterance;
    if (!synth || typeof synth.speak !== 'function' || typeof Utterance !== 'function') {
      endConversation('Speech playback is unavailable. Read the verified answer in chat.');
      return;
    }
    stopRecognition();
    stopSpeech();
    const speech = new Utterance(words);
    // Speak in the language of the *verified content*, not merely the mic
    // locale. Never read English claims with a Hindi/Kannada voice as if
    // they had been translated and source-checked.
    const outputLocale = speechLocaleForText(words);
    speech.lang = outputLocale;
    speech.rate = 1.04;
    speech.pitch = 1;
    try {
      const preferred = voiceInLocale(
        typeof synth.getVoices === 'function' ? synth.getVoices() : [], outputLocale,
      );
      if (preferred) {
        speech.voice = preferred;
        speech.lang = preferred.lang;
      }
    } catch { /* Keep the default voice. */ }
    utteranceRef.current = speech;
    spokenRef.current = { answer };
    speech.onend = () => {
      if (epochRef.current !== token || utteranceRef.current !== speech) return;
      utteranceRef.current = null;
      spokenRef.current = null;
      clearVoiceTimer(speechTimerRef);
      setSpokenAnswer(null);
      setPhase('idle');
      setStatus(resume ? 'Listening will resume after speech ends.' : 'Finished reading the answer.');
      if (resume) scheduleResume(token);
    };
    speech.onerror = () => {
      if (epochRef.current === token && utteranceRef.current === speech)
        endConversation('Speech playback failed. Read the answer in chat.');
    };
    speechTimerRef.current = setTimeout(() => {
      if (epochRef.current === token && utteranceRef.current === speech)
        endConversation('Speech timed out. You can restart conversation mode.');
    }, VOICE_SPEECH_TIMEOUT_MS);
    setSpokenAnswer(answer);
    setPhase('speaking');
    try {
      synth.speak(speech);
      const answerLanguage = VOICE_LANGUAGES.find(item=>item.code===outputLocale)?.label || 'its original language';
      setStatus(language !== outputLocale
        ? 'The answer is in a different language. Reading in ' + answerLanguage +
          '; no unverified translation was made.'
        : 'Reading the verified answer. Press Speak now to interrupt.');
    } catch {
      endConversation('Browser speech could not start. Read the answer in chat.');
    }
  }, [endConversation, scheduleResume, stopRecognition, stopSpeech, language]);

  // The assistant response comes from the *same* authenticated chat request,
  // not merely the most recent message. Wait until it is visible and chat has
  // completed before starting TTS; old account responses cannot pass the fence.
  useEffect(() => {
    const ready = replyReadyRef.current;
    if (!ready || chatBusy) return;
    if (epochRef.current !== ready.token || !handsFreeRef.current ||
        !enabledRef.current) {
      replyReadyRef.current = null;
      return;
    }
    const displayed = sameVerifiedVoiceReply(ready.answer, lastAnswer);
    if (!displayed) return;
    replyReadyRef.current = null;
    clearVoiceTimer(replyDisplayTimerRef);
    startSpeech(ready.answer, true, ready.token);
  }, [replyVersion, chatBusy, lastAnswer, startSpeech]);

  const sendVerifiedVoiceQuestion = useCallback(async (transcript, token) => {
    if (epochRef.current !== token || !handsFreeRef.current ||
        !enabledRef.current || busyRef.current) return;
    setPhase('thinking');
    setStatus('Asking Genie. The microphone is off while the answer is prepared.');
    let answer;
    replyTimerRef.current = setTimeout(() => {
      if (epochRef.current === token)
        endConversation('The answer took too long. Check chat before retrying.');
    }, VOICE_REPLY_TIMEOUT_MS);
    try {
      answer = await callbacksRef.current.onQuestion(transcript);
    } catch {
      if (epochRef.current === token)
        endConversation('Could not send the voice question. Review the chat to retry.');
      return;
    } finally {
      // An older cancelled request must not disable a newer turn's deadline.
      if (epochRef.current === token) clearVoiceTimer(replyTimerRef);
    }
    if (epochRef.current !== token || !handsFreeRef.current) return;
    if (!isVerifiedVoiceAnswer(answer) || !voiceAnswerText(answer)) {
      endConversation('The response could not be verified for voice. Read it in chat.');
      return;
    }
    // Keep the exact response until the matching message is rendered.
    const ready = { token, answer };
    replyReadyRef.current = ready;
    replyDisplayTimerRef.current = setTimeout(() => {
      if (replyReadyRef.current === ready && epochRef.current === token)
        endConversation('The voice response no longer matches chat. It was not narrated.');
    }, 2000);
    setReplyVersion(value => value + 1);
  }, [endConversation]);

  const interpret = useCallback(async (raw, token) => {
    const transcript = validateVoiceTranscript(raw);
    if (epochRef.current !== token) return;
    if (!transcript) {
      endConversation('Voice transcript exceeded safety limits or was empty. Try a shorter question.');
      return;
    }
    setCaption(transcript);
    if (isVoiceStopPhrase(transcript) || isLocalVoiceStop(transcript)) {
      endConversation();
      return;
    }
    const abort = new AbortController();
    intentRef.current = abort;
    setPhase('checking');
    setStatus('Checking the requested action...');
    intentTimerRef.current = setTimeout(() => {
      if (epochRef.current === token && intentRef.current === abort) {
        abort.abort();
        endConversation('Voice interpretation timed out. No action was executed.');
      }
    }, VOICE_INTENT_TIMEOUT_MS);
    let intent;
    try {
      intent = await api.interpretVoiceCommand(transcript, { signal: abort.signal });
    } catch {
      if (epochRef.current !== token) return;
      if (!handsFreeRef.current) callbacksRef.current.onTranscript?.(transcript);
      endConversation('Voice interpretation failed. No action was executed.');
      return;
    } finally {
      // Only the active request owns the timeout; stale finally blocks must
      // never clear the watchdog for a new microphone session.
      if (intentRef.current === abort) {
        clearVoiceTimer(intentTimerRef);
        intentRef.current = null;
      }
    }
    if (epochRef.current !== token || !enabledRef.current || abort.signal.aborted) return;
    if (isAuthorizedVoiceNavigation(intent)) {
      if (typeof callbacksRef.current.onNavigate !== 'function') {
        endConversation('Navigation is unavailable. No action was executed.');
        return;
      }
      try {
        await callbacksRef.current.onNavigate({ page: intent.page, tab: null });
        if (epochRef.current !== token) return;
        setPhase('idle');
        setStatus('Navigation requested: ' + intent.page.replace(/-/g, ' ') + '.');
        scheduleResume(token);
      } catch {
        endConversation('Navigation could not be confirmed. No more actions will run.');
      }
      return;
    }
    if (intent?.version !== VOICE_INTENT_VERSION) {
      endConversation('Invalid voice response. No action was executed.');
      return;
    }
    if (intent.action === 'OPEN_SIP_COMPARISON') {
      endConversation('Review SIP assumptions before running a comparison.');
      setShowComparison(true);
      return;
    }
    if (intent.action !== 'CHAT') {
      endConversation('That action is not authorized. Nothing was executed.');
      return;
    }
    if (!handsFreeRef.current) {
      callbacksRef.current.onTranscript?.(transcript);
      setPhase('idle');
      setStatus('Transcript added to chat. Review it before sending.');
      return;
    }
    if (typeof callbacksRef.current.onQuestion !== 'function') {
      endConversation('Chat is unavailable. Nothing was sent.');
      return;
    }
    if (needsFinancialTranscriptReview(transcript)) {
      // Speech-to-text numbers are prone to material errors (for example,
      // fifteen vs fifty thousand). Never auto-send such questions.
      const review = { token, transcript };
      reviewRef.current = review;
      setPendingReview(review);
      setReviewDraft(transcript);
      setReviewError('');
      setPhase('confirming');
      setStatus('Confirm the recognized financial amounts and assumptions before sending.');
      return;
    }
    void sendVerifiedVoiceQuestion(transcript, token);
  }, [endConversation, scheduleResume, sendVerifiedVoiceQuestion]);

  const startListening = useCallback(() => {
    if (!enabledRef.current || busyRef.current) return;
    if (document.visibilityState === 'hidden') {
      endConversation('Return to the app before using the microphone.');
      return;
    }
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (typeof Recognition !== 'function') {
      endConversation('Microphone speech recognition is unsupported in this browser.');
      return;
    }
    // Button-triggered interruption is an explicit microphone gesture.
    stopIO();
    reviewRef.current = null;
    setPendingReview(null);
    setReviewDraft('');
    setReviewError('');
    const token = ++epochRef.current;
    let recognition;
    try {
      recognition = new Recognition();
      recognition.lang = language;
      recognition.continuous = false;
      recognition.interimResults = true;
      listeningRef.current = recognition;
      recognition.onresult = event => {
        if (epochRef.current !== token || listeningRef.current !== recognition) return;
        const results = event.results || [];
        const finalParts = [];
        let interimText = '';
        // Browser ASR may split one utterance across several result entries.
        // Sending the first final chunk can silently drop a subsequent amount,
        // inflation rate or negation. Await *all* chunks becoming final.
        for (let i = 0; i < results.length; i += 1) {
          const text = results[i]?.[0]?.transcript;
          if (typeof text !== 'string') continue;
          if (results[i].isFinal === false) interimText += ' ' + text;
          else finalParts.push(text); // Retain controls for downstream raw validation.
        }
        const assembled = finalParts.join(' ');
        if (interimText.trim()) {
          setCaption((assembled + ' ' + interimText.trim()).trim().slice(0, 1000));
          return;
        }
        if (!assembled.trim()) return;
        stopRecognition();
        void interpret(assembled, token);
      };
      recognition.onerror = event => {
        if (epochRef.current !== token) return;
        const code = event?.error;
        endConversation(code === 'not-allowed' || code === 'service-not-allowed'
          ? 'Microphone permission denied. Enable it in browser settings.'
          : 'Voice capture failed. Use text chat or restart conversation mode.');
      };
      recognition.onend = () => {
        if (epochRef.current !== token || listeningRef.current !== recognition) return;
        endConversation('No final speech was captured. Restart conversation mode to try again.');
      };
      recognition.start();
      captureTimerRef.current = setTimeout(() => {
        if (epochRef.current === token && listeningRef.current === recognition)
          endConversation('Microphone stopped after 20 seconds without a final command.');
      }, VOICE_CAPTURE_TIMEOUT_MS);
      setCaption('');
      setStatus('Listening…');
      setPhase('listening');
    } catch {
      endConversation('Microphone could not start. Check browser permissions.');
    }
  }, [endConversation, interpret, stopIO, stopRecognition, language]);

  useLayoutEffect(() => {
    listenActionRef.current = startListening;
  }, [startListening]);

  const toggleConversation = () => {
    if (handsFreeRef.current) {
      endConversation();
    } else {
      handsFreeRef.current = true;
      setHandsFree(true);
      const conversationEpoch = ++conversationEpochRef.current;
      clearVoiceTimer(conversationTimerRef);
      conversationTimerRef.current = setTimeout(() => {
        if (conversationEpochRef.current === conversationEpoch && handsFreeRef.current)
          endConversation('Conversation ended after five minutes. Start again to renew microphone access.');
      }, VOICE_CONVERSATION_MAX_MS);
      startListening();
    }
  };

  const stop = () => endConversation();

  const canSpeak = isVerifiedVoiceAnswer(lastAnswer) && !!voiceAnswerText(lastAnswer);
  const activelySpeaking = phase === 'speaking' &&
    sameVerifiedVoiceReply(spokenAnswer, lastAnswer);

  const confirmFinancialReview = async () => {
    const review = reviewRef.current;
    if (!review || epochRef.current !== review.token ||
        !handsFreeRef.current || !enabledRef.current || busyRef.current ||
        document.visibilityState === 'hidden') {
      endConversation('The voice question is no longer valid. Please repeat it.');
      return;
    }
    const reviewedText = validateVoiceTranscript(reviewDraft);
    if (!reviewedText) {
      setReviewError('Enter a question of at most 1000 characters, without hidden or control characters.');
      return;
    }
    if (isVoiceStopPhrase(reviewedText) || isLocalVoiceStop(reviewedText)) {
      endConversation('Voice question cancelled.');
      return;
    }
    // Lock synchronously before any awaited classifier call; rapid clicks
    // cannot authorize or bill the same financial question twice.
    if (review.confirming) return;
    review.confirming = true;
    // Editing may change a harmless question into a navigation or forbidden
    // action. Re-run the server allowlist: corrected text may only become CHAT.
    if (reviewedText !== review.transcript) {
      const abort = new AbortController();
      intentRef.current = abort;
      setPhase('checking');
      setStatus('Rechecking the corrected question...');
      intentTimerRef.current = setTimeout(() => {
        if (epochRef.current === review.token && intentRef.current === abort) {
          abort.abort();
          endConversation('Corrected question verification timed out. Nothing was sent.');
        }
      }, VOICE_INTENT_TIMEOUT_MS);
      let intent;
      try {
        intent = await api.interpretVoiceCommand(reviewedText, { signal: abort.signal });
      } catch {
        if (epochRef.current === review.token)
          endConversation('Could not verify the corrected question. Nothing was sent.');
        return;
      } finally {
        if (intentRef.current === abort) {
          clearVoiceTimer(intentTimerRef);
          intentRef.current = null;
        }
      }
      if (epochRef.current !== review.token || !handsFreeRef.current ||
          !enabledRef.current || busyRef.current || abort.signal.aborted ||
          document.visibilityState === 'hidden') return;
      if (intent?.version !== VOICE_INTENT_VERSION || intent.action !== 'CHAT') {
        endConversation('Corrected question is not an approved informational request. Nothing was sent.');
        return;
      }
    }
    if (reviewRef.current !== review || epochRef.current !== review.token) return;
    reviewRef.current = null;
    setPendingReview(null);
    setReviewDraft('');
    setReviewError('');
    void sendVerifiedVoiceQuestion(reviewedText, review.token);
  };

  return (
    <div className="sovereign-voice-control" data-phase={phase} aria-label="GenieVoice controls">
      <span className="genie-voice-status-light" aria-hidden="true" />
      <label className="genie-voice-locale-label" htmlFor="genievoice-language">Speech language</label>
      <select id="genievoice-language" aria-label="GenieVoice speech language"
        value={language} disabled={disabled || chatBusy}
        onChange={event => {
          const next=event.target.value;
          if (!validVoiceLanguage(next) || next===language) return;
          endConversation('Language changed. Start the microphone again for the new language.');
          setLanguage(next);
        }}>
        {VOICE_LANGUAGES.map(item =>
          <option key={item.code} value={item.code}>{item.label}</option>)}
      </select>
      <button type="button" disabled={disabled || chatBusy}
        aria-label={phase === 'listening' ? 'Stop GenieVoice listening' :
          phase === 'checking' ? 'Stop GenieVoice task' :
          phase === 'speaking' ? 'Interrupt Genie and speak' : 'Start GenieVoice navigation'}
        onClick={phase === 'listening' || phase === 'checking' ? stop : startListening}>
        {phase === 'listening' || phase === 'checking' ? <MicOff size={16} /> : <Mic size={16} />}
        {phase === 'listening' ? 'Stop listening' :
          phase === 'checking' ? 'Stop task' :
          phase === 'speaking' ? 'Speak now' : 'GenieVoice navigation'}
      </button>
      <button type="button" disabled={disabled || (chatBusy && !handsFree)}
        aria-label={handsFree ? 'End GenieVoice conversation' : 'Start GenieVoice hands-free conversation'}
        aria-pressed={handsFree} onClick={toggleConversation}>
        {handsFree ? 'End conversation' : 'Conversation mode'}
      </button>
      {canSpeak && (
        <button type="button" disabled={disabled || chatBusy}
          aria-label={activelySpeaking ? 'Stop verified answer playback' : 'Speak verified answer'}
          onClick={activelySpeaking ? stop : () => {
            // Manual speech is one-shot and cannot covertly start the microphone.
            endConversation('');
            const token = epochRef.current;
            startSpeech(lastAnswer, false, token);
          }}>
          {activelySpeaking ? <VolumeX size={16} /> : <Volume2 size={16} />}
          {activelySpeaking ? 'Stop speaking' : 'Speak verified answer'}
        </button>
      )}
      <button type="button" disabled={disabled || chatBusy || phase === 'checking'}
        onClick={() => {
          endConversation('');
          setShowComparison(value => !value);
        }} aria-label={showComparison ? 'Close SIP comparison' : 'Open SIP comparison'}>
        {showComparison ? 'Close SIP comparison' : 'Compare SIP scenarios'}
      </button>
      {!disabled && showComparison && (
        <SovereignSipComparison key={String(sessionKey ?? '')}
          disabled={disabled || chatBusy} onClose={() => setShowComparison(false)} />
      )}
      {pendingReview && phase === 'confirming' && (
        <div className="genie-voice-financial-review" role="group"
          aria-label="Review recognized financial question">
          <strong>Review financial values before sending</strong>
          <p>The microphone may confuse amounts, percentages or years. Verify and correct the transcript before sending:</p>
          <p className="genie-voice-financial-review-text">Recognized: {pendingReview.transcript}</p>
          <label htmlFor="genie-voice-reviewed-question">Corrected question</label>
          <textarea id="genie-voice-reviewed-question"
            aria-label="Edit recognized financial question" rows={3}
            maxLength={1000} value={reviewDraft} disabled={disabled || chatBusy}
            onChange={event => {
              setReviewDraft(event.target.value);
              setReviewError('');
            }} />
          {reviewError && <p role="alert">{reviewError}</p>}
          <button type="button" disabled={disabled || chatBusy}
            onClick={() => { void confirmFinancialReview(); }}>Confirm and ask Genie</button>
          <button type="button" onClick={() => endConversation('Voice question cancelled.')}>
            Cancel voice question
          </button>
        </div>
      )}
      {phase === 'checking' && <span role="status">Checking voice command…</span>}
      {phase === 'thinking' && <span role="status">Genie is preparing a grounded answer…</span>}
      {caption && <div className="genie-voice-caption" aria-label="Voice transcript">{caption}</div>}
      <small>Conversation mode sends ordinary spoken questions automatically; recognized financial
        amounts require confirmation and can be corrected. Only verified answers are narrated.
        Conversation mode ends after five minutes unless you explicitly start it again.
        The mic is off during responses and narration; you can interrupt or stop anytime.
        Browser speech recognition may process audio through its provider.
        Hindi and Kannada recognition depend on device support; answers are spoken in their verified text language.</small>
      {status && <div role="status" aria-live="polite">{status}</div>}
    </div>
  );
}
