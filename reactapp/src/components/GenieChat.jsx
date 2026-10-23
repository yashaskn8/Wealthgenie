import React, { useState, useRef, useEffect, useCallback } from 'react';
import { X, Send, Trash2, Sparkles, RefreshCw, Scale, Coins, Percent, Target, ArrowLeft, ExternalLink, Mic, MicOff, ChevronRight, TrendingUp, Maximize2, Minimize2 } from 'lucide-react';
import JargonTooltip from './JargonTooltip';
import './GenieChat.css';
import * as api from '../services/api';
import { isPresentFiniteNumber } from '../utils/financialValues';
import {
  formatFullINR,
  getSuggestedQuestions,
  generateContextualPills
} from '../utils/genieChatHelpers.js';
import {
  MessageBubble,
  ProactiveNudge,
  PortfolioSnapshot,
  GenieFAB
} from './GenieChatSubcomponents.jsx';

function formatLakhs(value) {
  if (!isPresentFiniteNumber(value)) return '—';
  const numericValue = Number(value);
  return `₹${(numericValue / 100000).toFixed(1)}L`;
}

const SESSION_STORAGE_WARNING = 'Chat session storage is unavailable. This conversation is temporary on this device and may not appear after a reload.';
const SESSION_BINDING_WARNING = 'Chat session could not be safely linked to this profile. This conversation may not appear after a reload.';
const CHAT_SESSION_ID_KEY = 'genie_session_id';
const CHAT_SESSION_BINDING_KEY = 'genie_session_binding_fingerprint';
const CHAT_SESSION_BINDING_FINGERPRINT_VERSION = 'wg-chat-binding-v3:';

function createNewChatSession(bindingFingerprint = null) {
  const id = crypto.randomUUID();
  try {
    sessionStorage.setItem(CHAT_SESSION_ID_KEY, id);
    sessionStorage.removeItem(CHAT_SESSION_BINDING_KEY);
    if (bindingFingerprint) sessionStorage.setItem(CHAT_SESSION_BINDING_KEY, bindingFingerprint);
    return { id, storageWarning: null };
  } catch {
    return { id, storageWarning: SESSION_STORAGE_WARNING };
  }
}

function restoreOrCreateChatSession() {
  let storageReadFailed = false;
  try {
    const stored = sessionStorage.getItem(CHAT_SESSION_ID_KEY);
    if (stored) {
      return {
        id: stored,
        storedBindingFingerprint: sessionStorage.getItem(CHAT_SESSION_BINDING_KEY),
        storageWarning: null,
      };
    }
  } catch {
    storageReadFailed = true;
  }
  const created = createNewChatSession();
  return {
    ...created,
    storedBindingFingerprint: null,
    storageWarning: storageReadFailed ? SESSION_STORAGE_WARNING : created.storageWarning,
  };
}

async function fingerprintChatFinancialBinding(binding) {
  const cryptoProvider = globalThis.crypto;
  if (typeof cryptoProvider?.subtle?.digest !== 'function' || typeof TextEncoder !== 'function') return null;
  try {
    const state = JSON.parse(binding);
    const persistenceBinding = JSON.stringify({
      profileId: state.profileId,
      profileVersion: state.profileVersion,
      profileInputHash: state.profileInputHash,
      recommendationId: state.recommendationId,
      allocationRevision: state.allocationRevision,
      allocationRevisionId: state.allocationRevisionId,
      recommendationFingerprint: state.recommendationFingerprint,
      portfolioFingerprint: state.portfolioFingerprint,
    });
    const digest = await cryptoProvider.subtle.digest('SHA-256', new TextEncoder().encode(persistenceBinding));
    const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    return `${CHAT_SESSION_BINDING_FINGERPRINT_VERSION}${fingerprint}`;
  } catch {
    return null;
  }
}

async function fingerprintChatTurnKey(sessionId, idempotencyKey, message) {
  const cryptoProvider = globalThis.crypto;
  if (typeof cryptoProvider?.subtle?.digest !== 'function' || typeof TextEncoder !== 'function') return null;
  try {
    const digest = await cryptoProvider.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`${sessionId}\0${idempotencyKey}\0${String(message || '').trim()}`),
    );
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

function persistChatSessionBinding(sessionId, fingerprint) {
  if (!fingerprint) return false;
  try {
    if (sessionStorage.getItem(CHAT_SESSION_ID_KEY) !== sessionId) return false;
    sessionStorage.setItem(CHAT_SESSION_BINDING_KEY, fingerprint);
    return true;
  } catch {
    return false;
  }
}

function retryAfterSeconds(error) {
  const resetAt = Date.parse(error?.details?.resetAt ?? error?.details?.rate_limit_reset_at ?? '');
  if (Number.isFinite(resetAt)) return Math.max(1, Math.ceil((resetAt - Date.now()) / 1000));
  const structuredSeconds = Number(error?.details?.retryAfterSeconds ?? error?.details?.retry_after_seconds);
  if (Number.isSafeInteger(structuredSeconds) && structuredSeconds > 0) return structuredSeconds;
  return null;
}

function formatRetryAfter(seconds) {
  if (seconds < 60) return `about ${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return `about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

function chatRateLimitMessage(error) {
  const seconds = retryAfterSeconds(error);
  if (seconds) {
    return `You've reached Genie’s hourly message limit. The server says you can retry in ${formatRetryAfter(seconds)}.`;
  }
  return error?.message || "You've reached Genie’s hourly message limit. Try again when the limit resets.";
}

function buildChatFinancialBinding(profile, recommendationMeta) {
  const recommendationState = {
    profileId: recommendationMeta?.profileId ?? recommendationMeta?.profile_id ?? profile?.profileId ?? profile?._id ?? null,
    profileVersion: recommendationMeta?.profile_version ?? profile?.version ?? null,
    profileInputHash: recommendationMeta?.profile_input_hash ?? null,
    recommendationId: recommendationMeta?.recommendationId ?? recommendationMeta?.recommendation_id ?? null,
    allocationRevision: recommendationMeta?.allocation_revision ?? null,
    allocationRevisionId: recommendationMeta?.allocation_revision_id ?? null,
    recommendationFingerprint: recommendationMeta?.recommendation_fingerprint ?? null,
    portfolioFingerprint: recommendationMeta?.portfolio_fingerprint ?? null,
  };
  return JSON.stringify(recommendationState);
}

function mapStoredChatMessages(messages) {
  return messages.map(message => ({
    role: message.role === 'model' ? 'assistant' : 'user',
    content: message.content,
    timestamp: message.timestamp || new Date().toISOString(),
    latency_ms: message.metadata?.latency_ms,
    grounded: message.metadata?.grounded_on_profile,
    provider: message.metadata?.provider,
    model: message.metadata?.model,
    grounding_version: message.metadata?.grounding_version,
    evidence_ids_used: message.metadata?.evidence_ids_used || [],
    unavailable_facts: message.metadata?.unavailable_facts || [],
    fallback: message.metadata?.fallback_used === true,
    fallback_reason_codes: message.metadata?.fallback_used ? message.metadata?.validation_reason_codes || [] : [],
    citations: message.metadata?.citations || [],
    _clientTurnHash: message.metadata?.client_turn_hash || null,
    _streamed: true,
  }));
}

// ── Main Component ────────────────────────────────────────────────
const GenieChat = ({ profile, recommendationMeta = null, recommendationContextReady = true, cancelPendingSendRef = null, onNavigate }) => {
  const financialBinding = buildChatFinancialBinding(profile, recommendationMeta);
  const [isOpen, setIsOpen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [historyStatus, setHistoryStatus] = useState('idle');
  const [historyError, setHistoryError] = useState(null);
  const [clearStatus, setClearStatus] = useState('idle');
  const [isClearing, setIsClearing] = useState(false);
  const [rateLimit, setRateLimit] = useState({ remaining: 30, total: 30 });
  const [isListening, setIsListening] = useState(false);
  const [voiceError, setVoiceError] = useState(null);
  const [chatSession, setChatSession] = useState(() => ({
    ...restoreOrCreateChatSession(),
    financialBinding: null,
    bindingReady: false,
  }));
  const sessionId = chatSession.id;
  const sessionMatchesProfile = recommendationContextReady
    && chatSession.bindingReady
    && chatSession.financialBinding === financialBinding;
  const [sessionStorageWarning, setSessionStorageWarning] = useState(chatSession.storageWarning);
  const chatEndRef = useRef(null);
  const inputRef = useRef(null);
  const recognitionRef = useRef(null);
  const historyRequestIdRef = useRef(0);
  const sessionGenerationRef = useRef(0);
  const sendGenerationRef = useRef(0);
  const sendControllerRef = useRef(null);
  const pendingSendRef = useRef(null);
  const retryableTurnRef = useRef(null);
  const sendInFlightRef = useRef(false);
  const clearingRef = useRef(false);
  const sessionIdRef = useRef(sessionId);
  const financialBindingRef = useRef(financialBinding);
  const sessionBindingRef = useRef(chatSession.financialBinding);
  const initialSessionIdRef = useRef(chatSession.id);
  const initialBindingFingerprintRef = useRef(chatSession.storedBindingFingerprint);
  const bindingHydratedRef = useRef(false);
  sessionIdRef.current = sessionId;
  financialBindingRef.current = financialBinding;
  sessionBindingRef.current = chatSession.financialBinding;
  const previousFinancialBindingRef = useRef(financialBinding);
  const rateLimitRetryAt = rateLimit.retryAt;
  const invalidatePendingSend = useCallback((resetLoading = false) => {
    sendGenerationRef.current += 1;
    sendControllerRef.current?.abort();
    sendControllerRef.current = null;
    sendInFlightRef.current = false;
    if (resetLoading) setIsLoading(false);
  }, []);

  // ── 2026 Agentic Workspace State ────────────────────────────────
  const [activeWorkspace, setActiveWorkspace] = useState(null); // null | 'rebalancer' | 'sip-planner'

  // Rebalancer Workspace parameters
  const [targetEquity, setTargetEquity] = useState(50);
  const [rebalanceMonthlySIP, setRebalanceMonthlySIP] = useState(profile?.monthly_savings ?? 1000);
  const [allocationSplit, setAllocationSplit] = useState(null);
  const [allocationSplitError, setAllocationSplitError] = useState(null);

  // SIP Step-Up parameters
  const [sipMonthlyAmount, setSipMonthlyAmount] = useState(profile?.monthly_savings ?? 1000);
  const [sipStepUpPercent, setSipStepUpPercent] = useState(10);
  const [sipHorizon, setSipHorizon] = useState(profile?.investment_horizon_years ?? 5);
  const [sipReturnRate, setSipReturnRate] = useState(12);
  const [sipProjection, setSipProjection] = useState(null);
  const [sipProjectionError, setSipProjectionError] = useState(null);

  useEffect(() => {
    if (profile) {
      if (Number(profile.monthly_savings) > 0) {
        setRebalanceMonthlySIP(Number(profile.monthly_savings));
        setSipMonthlyAmount(Number(profile.monthly_savings));
      }
      if (Number(profile.investment_horizon_years) > 0) {
        setSipHorizon(Number(profile.investment_horizon_years));
      }
    }
  }, [profile]);

  useEffect(() => {
    if (activeWorkspace !== 'rebalancer') return undefined;
    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setAllocationSplit(null);
      setAllocationSplitError(null);
      api.calculateAllocationSplit(
        rebalanceMonthlySIP,
        targetEquity,
        { signal: controller.signal },
      ).then(result => {
        if (!cancelled) setAllocationSplit(result);
      }).catch(requestError => {
        if (!cancelled && requestError?.code !== 'REQUEST_ABORTED') {
          setAllocationSplit(null);
          setAllocationSplitError(requestError.message);
        }
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [activeWorkspace, rebalanceMonthlySIP, targetEquity]);

  useEffect(() => {
    if (activeWorkspace !== 'sip-planner') return undefined;
    let cancelled = false;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSipProjectionError(null);
      api.calculateStepUpProjection(
        sipMonthlyAmount,
        sipReturnRate / 100,
        sipHorizon,
        sipStepUpPercent / 100,
        { signal: controller.signal },
      ).then(result => {
        if (!cancelled) setSipProjection(result);
      }).catch(requestError => {
        if (!cancelled && requestError?.code !== 'REQUEST_ABORTED') {
          setSipProjection(null);
          setSipProjectionError(requestError.message);
        }
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [activeWorkspace, sipMonthlyAmount, sipReturnRate, sipHorizon, sipStepUpPercent]);

  const visibleMessages = sessionMatchesProfile ? messages : [];
  const lastUserMessage = visibleMessages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
  const lastAssistantMsg = visibleMessages.filter(m => m.role === 'assistant').slice(-1)[0];

  const startFreshSession = useCallback((nextFinancialBinding, knownFingerprint = null) => {
    sessionGenerationRef.current += 1;
    sendGenerationRef.current += 1;
    historyRequestIdRef.current += 1;
    sendControllerRef.current?.abort();
    sendControllerRef.current = null;
    retryableTurnRef.current = null;
    sendInFlightRef.current = false;
    clearingRef.current = false;
    const nextSession = createNewChatSession(knownFingerprint);
    sessionIdRef.current = nextSession.id;
    sessionBindingRef.current = nextFinancialBinding;
    previousFinancialBindingRef.current = nextFinancialBinding;
    bindingHydratedRef.current = true;
    setChatSession({ ...nextSession, financialBinding: nextFinancialBinding, bindingReady: true });
    setSessionStorageWarning(nextSession.storageWarning);
    setMessages([]);
    setInput('');
    setIsLoading(false);
    setIsClearing(false);
    setError(null);
    setHistoryStatus('idle');
    setHistoryError(null);
    setClearStatus('idle');
    setActiveWorkspace(null);
    setAllocationSplit(null);
    setAllocationSplitError(null);
    setSipProjection(null);
    setSipProjectionError(null);
    void (knownFingerprint
      ? Promise.resolve(knownFingerprint)
      : fingerprintChatFinancialBinding(nextFinancialBinding))
      .then(fingerprint => {
        if (sessionIdRef.current !== nextSession.id) return;
        if (!fingerprint) {
          setSessionStorageWarning(current => current || SESSION_BINDING_WARNING);
          return;
        }
        if (!persistChatSessionBinding(nextSession.id, fingerprint)) {
          setSessionStorageWarning(current => current || SESSION_STORAGE_WARNING);
        }
      });
    return nextSession.storageWarning;
  }, []);

  useEffect(() => {
    if (!recommendationContextReady || bindingHydratedRef.current) return undefined;
    let cancelled = false;
    const requestedSessionId = initialSessionIdRef.current;
    void fingerprintChatFinancialBinding(financialBinding).then(fingerprint => {
      if (cancelled || bindingHydratedRef.current || requestedSessionId !== sessionIdRef.current) return;
      const storedFingerprint = initialBindingFingerprintRef.current;
      const hasCurrentFingerprint = typeof storedFingerprint === 'string'
        && storedFingerprint.startsWith(CHAT_SESSION_BINDING_FINGERPRINT_VERSION);
      if (fingerprint && fingerprint === storedFingerprint) {
        bindingHydratedRef.current = true;
        sessionBindingRef.current = financialBinding;
        previousFinancialBindingRef.current = financialBinding;
        setChatSession(current => (current.id === requestedSessionId
          ? { ...current, financialBinding, bindingReady: true }
          : current));
        return;
      }
      if (!hasCurrentFingerprint) {
        // Older clients stored a digest of profile values and recommendation
        // data. Keep the opaque session ID so the server can decide whether
        // its history still matches current provenance; then replace the old
        // digest with the privacy-safe versioned binding.
        bindingHydratedRef.current = true;
        sessionBindingRef.current = financialBinding;
        previousFinancialBindingRef.current = financialBinding;
        setChatSession(current => (current.id === requestedSessionId
          ? { ...current, financialBinding, bindingReady: true }
          : current));
        if (fingerprint && persistChatSessionBinding(requestedSessionId, fingerprint)) {
          setSessionStorageWarning(null);
        } else if (!fingerprint) {
          setSessionStorageWarning(current => current || SESSION_BINDING_WARNING);
        }
        return;
      }
      startFreshSession(financialBinding, fingerprint);
    });
    return () => { cancelled = true; };
  }, [financialBinding, recommendationContextReady, startFreshSession]);

  useEffect(() => {
    if (!Number.isFinite(rateLimitRetryAt)) return undefined;
    const delay = Math.max(0, rateLimitRetryAt - Date.now());
    const timer = setTimeout(() => {
      setRateLimit(current => (current.retryAt === rateLimitRetryAt
        ? { ...current, remaining: null, retryAt: null }
        : current));
    }, delay);
    return () => clearTimeout(timer);
  }, [rateLimitRetryAt]);

  const rateLimitBlocked = rateLimit.remaining === 0
    && Number.isFinite(rateLimit.retryAt)
    && rateLimit.retryAt > Date.now();

  useEffect(() => {
    if (!recommendationContextReady || !bindingHydratedRef.current) return;
    if (previousFinancialBindingRef.current === financialBinding) return;
    previousFinancialBindingRef.current = financialBinding;
    startFreshSession(financialBinding);
  }, [financialBinding, recommendationContextReady, startFreshSession]);

  const loadHistory = useCallback(async () => {
    if (!sessionMatchesProfile) return;
    const requestId = ++historyRequestIdRef.current;
    const generation = sessionGenerationRef.current;
    const requestedSessionId = sessionId;
    const requestedBinding = chatSession.financialBinding;
    const isCurrent = () => requestId === historyRequestIdRef.current
      && generation === sessionGenerationRef.current
      && requestedSessionId === sessionIdRef.current
      && requestedBinding === sessionBindingRef.current
      && requestedBinding === financialBindingRef.current;
    setHistoryStatus('loading');
    setHistoryError(null);
    try {
      const data = await api.getChatHistory(requestedSessionId);
      if (!isCurrent()) return;
      if (!Array.isArray(data?.conversations)) throw new Error('Invalid chat history response');
      const conversation = data.conversations[0];
      if (conversation && !Array.isArray(conversation.messages)) throw new Error('Invalid chat history response');
      if (conversation?.messages) {
        setMessages(mapStoredChatMessages(conversation.messages));
      } else {
        setMessages([]);
      }
      setHistoryStatus('loaded');
    } catch {
      if (!isCurrent()) return;
      setHistoryStatus('failed');
      setHistoryError('Saved chat history could not be loaded. Check your connection and retry.');
    }
  }, [chatSession.financialBinding, sessionId, sessionMatchesProfile]);

  useEffect(() => {
    if (isOpen && sessionId && historyStatus === 'idle') {
      loadHistory();
    }
  }, [isOpen, sessionId, historyStatus, loadHistory]);
  useEffect(() => {
    const cancelForLogout = () => {
      if (pendingSendRef.current) {
        setError("We couldn't confirm whether your message was sent before sign-out interrupted it.");
        setInput(retryableTurnRef.current?.message || '');
      }
      invalidatePendingSend(true);
    };
    if (cancelPendingSendRef) cancelPendingSendRef.current = cancelForLogout;
    return () => {
      if (cancelPendingSendRef?.current === cancelForLogout) cancelPendingSendRef.current = null;
      invalidatePendingSend(false);
      historyRequestIdRef.current += 1;
    };
  }, [cancelPendingSendRef, invalidatePendingSend]);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, isLoading]);

  // Voice recognition setup
  useEffect(() => {
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      recognitionRef.current = new SpeechRecognition();
      recognitionRef.current.continuous = false;
      recognitionRef.current.interimResults = false;
      recognitionRef.current.lang = 'en-IN';
      recognitionRef.current.onresult = (e) => {
        const transcript = e.results?.[0]?.[0]?.transcript;
        if (typeof transcript === 'string' && transcript.trim()) {
          setInput(prev => prev + transcript);
          setVoiceError(null);
        } else {
          setVoiceError('No speech was captured. Please try again or type your question.');
        }
        setIsListening(false);
      };
      recognitionRef.current.onerror = (event) => {
        const code = String(event?.error || '');
        const message = code === 'not-allowed' || code === 'service-not-allowed'
          ? 'Microphone access was blocked. Allow microphone permission in your browser or type your question.'
          : code === 'audio-capture'
            ? 'No microphone was detected. Connect a microphone or type your question.'
            : code === 'network'
              ? 'Speech recognition is unavailable due to a network error. Please type your question.'
              : 'Voice input could not capture your speech. Please try again or type your question.';
        setVoiceError(message);
        setIsListening(false);
      };
      recognitionRef.current.onend = () => setIsListening(false);
    }
  }, []);

  const toggleVoice = () => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    if (isListening) {
      recognition.stop();
      setIsListening(false);
      return;
    }
    setVoiceError(null);
    try {
      // Speech recognition can synchronously reject start() if the permission
      // is denied or the recognition session is already active.
      recognition.start();
      setIsListening(true);
    } catch {
      setIsListening(false);
      setVoiceError('Voice input could not start. Check microphone access or type your question.');
    }
  };

  const sendMessage = useCallback(async (text) => {
    const messageText = (text || input).trim();
    if (!messageText || isLoading || sendInFlightRef.current || isClearing || clearingRef.current) return;
    if (!recommendationContextReady || !bindingHydratedRef.current) return;
    if (!sessionMatchesProfile) {
      startFreshSession(financialBinding);
      return;
    }
    const requestedSessionId = sessionId;
    const requestedBinding = chatSession.financialBinding;
    let retryableTurn = retryableTurnRef.current;
    if (retryableTurn && (retryableTurn.sessionId !== requestedSessionId
        || retryableTurn.binding !== requestedBinding)) {
      retryableTurnRef.current = null;
      retryableTurn = null;
    }
    if (retryableTurn && retryableTurn.message !== messageText) {
      setInput(retryableTurn.message);
      setError('A previous message may still be processing. Retry that same message or clear this chat before sending a different one.');
      return;
    }
    if (!retryableTurn) {
      retryableTurn = {
        sessionId: requestedSessionId,
        binding: requestedBinding,
        message: messageText,
        idempotencyKey: crypto.randomUUID(),
      };
      retryableTurnRef.current = retryableTurn;
    }
    const generation = sessionGenerationRef.current;
    const sendGeneration = sendGenerationRef.current;
    const controller = new AbortController();
    sendInFlightRef.current = true;
    sendControllerRef.current = controller;
    let settlePendingSend;
    const pendingSend = {
      sessionId: requestedSessionId,
      settled: new Promise(resolve => { settlePendingSend = resolve; }),
    };
    pendingSendRef.current = pendingSend;
    const isCurrent = () => generation === sessionGenerationRef.current
      && sendGeneration === sendGenerationRef.current
      && requestedSessionId === sessionIdRef.current
      && requestedBinding === sessionBindingRef.current
      && requestedBinding === financialBindingRef.current;
    historyRequestIdRef.current += 1;
    setHistoryStatus('loaded');
    setHistoryError(null);
    setInput(''); setError(null);
    setMessages(prev => (prev.some(item => item._turnKey === retryableTurn.idempotencyKey)
      ? prev
      : [...prev, { role: 'user', content: messageText, timestamp: new Date().toISOString(), _turnKey: retryableTurn.idempotencyKey }]));
    setIsLoading(true);
    try {
      const data = await api.sendChatMessage(messageText, requestedSessionId, {
        signal: controller.signal,
        headers: { 'Idempotency-Key': retryableTurn.idempotencyKey },
      });
      if (!isCurrent()) return;
      retryableTurnRef.current = null;
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: data.response,
        timestamp: new Date().toISOString(),
        latency_ms: data.latency_ms,
        citations: data.citations || [],
        grounded: data.grounded,
        provider: data.provider,
        model: data.model,
        grounding_version: data.grounding_version,
        evidence_ids_used: data.evidence_ids_used || [],
        unavailable_facts: data.unavailable_facts || [],
        fallback: data.fallback === true,
        fallback_reason_codes: data.fallback ? data.fallback_reason_codes || [] : [],
        _streamed: false,
        _turnKey: retryableTurn.idempotencyKey,
      }]);
      if (!data.idempotent_replay) {
        const remaining = Number(data.rate_limit_remaining);
        const nextRemaining = Number.isInteger(remaining) && remaining >= 0 && remaining <= 30
          ? remaining
          : null;
        const resetAt = Date.parse(data.rate_limit_reset_at || '');
        const retryAt = nextRemaining === 0 && Number.isFinite(resetAt) ? resetAt : null;
        setRateLimit(current => ({ ...current, remaining: nextRemaining, retryAt }));
        if (nextRemaining === 0) {
          setError(retryAt
            ? `You've used the last message in your current chat limit. Genie will be available again at ${new Date(retryAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`
            : 'You used the last message reported by the server. Genie will check availability on your next message.');
        }
      }
    } catch (err) {
      if (isCurrent() && err?.code !== 'REQUEST_ABORTED') {
        if (err?.code === 'CHAT_RATE_LIMIT_EXCEEDED') {
          setInput(current => current.trim() ? current : messageText);
          const seconds = retryAfterSeconds(err);
          const resetAt = Date.parse(err?.details?.resetAt ?? err?.details?.rate_limit_reset_at ?? '');
          setRateLimit(current => ({
            ...current,
            remaining: 0,
            retryAt: Number.isFinite(resetAt) ? resetAt : (seconds ? Date.now() + (seconds * 1000) : null),
          }));
          setError(chatRateLimitMessage(err));
        } else if (['CHAT_PROFILE_STATE_CHANGED', 'CHAT_SESSION_PROVENANCE_MISSING'].includes(err?.code)) {
          const nextFingerprint = await fingerprintChatFinancialBinding(financialBinding);
          if (isCurrent()) {
            startFreshSession(financialBinding, nextFingerprint);
            setInput(messageText);
            setError('Your profile or recommendation changed. This message was not sent. Review it and send again.');
          }
        } else {
          setInput(current => current.trim() ? current : messageText);
          setError(err.message || 'Genie is temporarily unavailable.');
        }
      }
    } finally {
      settlePendingSend();
      if (pendingSendRef.current === pendingSend) pendingSendRef.current = null;
      if (sendControllerRef.current === controller) sendControllerRef.current = null;
      sendInFlightRef.current = false;
      if (isCurrent()) {
        setIsLoading(false);
        inputRef.current?.focus();
      }
    }
  }, [
    chatSession.financialBinding,
    financialBinding,
    input,
    isClearing,
    isLoading,
    recommendationContextReady,
    sessionId,
    sessionMatchesProfile,
    startFreshSession,
  ]);

  const handleKeyDown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } };

  const checkClearOutcome = async () => {
    if (isClearing || clearingRef.current || !sessionMatchesProfile) return;
    const requestedSessionId = sessionId;
    const requestedBinding = sessionBindingRef.current;
    const requestId = ++historyRequestIdRef.current;
    const generation = sessionGenerationRef.current;
    const isCurrent = () => requestId === historyRequestIdRef.current
      && generation === sessionGenerationRef.current
      && requestedSessionId === sessionIdRef.current
      && requestedBinding === sessionBindingRef.current
      && financialBindingRef.current === sessionBindingRef.current;
    clearingRef.current = true;
    setIsClearing(true);
    setClearStatus('checking');
    try {
      const data = await api.getChatHistory(requestedSessionId);
      if (!isCurrent()) return;
      if (!Array.isArray(data?.conversations)) throw new Error('Invalid chat history response');
      const conversation = data.conversations[0];
      if (conversation && !Array.isArray(conversation.messages)) throw new Error('Invalid chat history response');
      if (!conversation || conversation.messages.length === 0) {
        const storageWarning = startFreshSession(financialBindingRef.current);
        setClearStatus(storageWarning ? 'storage-warning' : 'confirmed');
      } else {
        const pendingTurn = retryableTurnRef.current;
        const pendingClientTurnHash = pendingTurn?.sessionId === requestedSessionId
          ? await fingerprintChatTurnKey(requestedSessionId, pendingTurn.idempotencyKey, pendingTurn.message)
          : null;
        if (!isCurrent()) return;
        const savedMessages = conversation.messages;
        const trailingPair = savedMessages.slice(-2);
        const pendingTurnWasSaved = Boolean(pendingTurn
          && pendingClientTurnHash
          && pendingTurn.binding === requestedBinding
          && trailingPair.length === 2
          && trailingPair[0]?.role === 'user'
          && trailingPair[1]?.role === 'model'
          && trailingPair.every(message => message.metadata?.client_turn_hash === pendingClientTurnHash));
        if (pendingTurnWasSaved) retryableTurnRef.current = null;
        setMessages(mapStoredChatMessages(conversation.messages));
        setHistoryStatus('loaded');
        setHistoryError(null);
        setClearStatus('failed');
        if (pendingTurnWasSaved) {
          setError('Your pending message and reply were saved before clearing failed. They have been restored; you can continue with a new question.');
        }
      }
    } catch {
      if (isCurrent()) setClearStatus('unconfirmed');
    } finally {
      if (generation === sessionGenerationRef.current) {
        clearingRef.current = false;
        setIsClearing(false);
      }
    }
  };

  const clearChat = async () => {
    if (isClearing || clearingRef.current) return;
    if (!recommendationContextReady || !bindingHydratedRef.current) return;
    if (!sessionMatchesProfile) {
      startFreshSession(financialBinding);
      return;
    }
    const requestedSessionId = sessionId;
    const generation = sessionGenerationRef.current;
    const pendingSend = pendingSendRef.current?.sessionId === requestedSessionId
      ? pendingSendRef.current.settled
      : Promise.resolve();
    clearingRef.current = true;
    sendGenerationRef.current += 1;
    setIsClearing(true);
    setIsLoading(false);
    setClearStatus('pending');
    setHistoryError(null);
    try {
      await pendingSend;
      if (generation !== sessionGenerationRef.current || requestedSessionId !== sessionIdRef.current) return;
      await api.clearChatSession(requestedSessionId);
      if (generation !== sessionGenerationRef.current || requestedSessionId !== sessionIdRef.current) return;
      const storageWarning = startFreshSession(financialBindingRef.current);
      setClearStatus(storageWarning ? 'storage-warning' : 'confirmed');
    } catch {
      if (generation === sessionGenerationRef.current && requestedSessionId === sessionIdRef.current) {
        // DELETE may have committed before its response was lost. Keep the
        // local transcript, but reconcile server history before describing it.
        setClearStatus('unconfirmed');
      }
    }
    finally {
      if (generation === sessionGenerationRef.current) {
        clearingRef.current = false;
        setIsClearing(false);
      }
    }
  };

  const suggestedQuestions = getSuggestedQuestions(profile);
  const pills = generateContextualPills(lastUserMessage);

  return (
    <>
      {!isOpen && <GenieFAB onClick={() => setIsOpen(true)} hasNudge={!!profile} />}
      {isOpen && (
        <div className={`genie-panel ${activeWorkspace ? 'genie-panel--with-workspace' : ''} ${isExpanded ? 'genie-panel--expanded' : ''}`}>
          <div className="genie-panel-chat-pane">
            {/* Header */}
            <div className="genie-panel-header">
              <div className="genie-header-left">
                <div className="genie-avatar-wrap"><span className="ba-letter">G</span></div>
                <div>
                  <div className="genie-header-title">Genie</div>
                  <div className="genie-header-sub"><span className="online-dot"></span> Your Personal Money Helper</div>
                </div>
              </div>
              <div className="genie-header-actions">
                <button onClick={() => setIsExpanded(prev => !prev)} title={isExpanded ? "Restore compact size" : "Expand size"} aria-label={isExpanded ? "Restore compact size" : "Expand size"}>
                  {isExpanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                </button>
                <button onClick={clearChat} title="Clear chat" aria-label="Clear chat conversation" disabled={isClearing || !recommendationContextReady || !chatSession.bindingReady}><Trash2 size={16} /></button>
                <button onClick={() => setIsOpen(false)} title="Close" aria-label="Close chat helper"><X size={18} /></button>
              </div>
            </div>

            {/* Messages */}
            <div className="genie-messages">
              {sessionStorageWarning && <div role="status" className="chat-history-status">{sessionStorageWarning}</div>}
              {(!recommendationContextReady || !chatSession.bindingReady) && (
                <div role="status" className="chat-history-status">Verifying your current financial plan before restoring chat history…</div>
              )}
              {sessionMatchesProfile && historyStatus === 'loading' && visibleMessages.length === 0 && (
                <div role="status" className="chat-history-status">Loading saved conversation…</div>
              )}
              {sessionMatchesProfile && historyError && (
                <div role="alert" className="chat-error-banner">
                  <span>{historyError}</span>
                  <button type="button" onClick={loadHistory}>Retry loading history</button>
                </div>
              )}
              {sessionMatchesProfile && clearStatus === 'pending' && <div role="status" className="chat-history-status">Clearing saved conversation…</div>}
              {sessionMatchesProfile && clearStatus === 'checking' && <div role="status" className="chat-history-status">Checking saved conversation status…</div>}
              {sessionMatchesProfile && clearStatus === 'confirmed' && <div role="status" className="chat-history-status">Saved conversation cleared.</div>}
              {sessionMatchesProfile && clearStatus === 'storage-warning' && <div role="status" className="chat-history-status">Saved conversation cleared, but the new chat session could not be remembered for the next visit.</div>}
              {sessionMatchesProfile && clearStatus === 'failed' && (
                <div role="alert" className="chat-error-banner">
                  <span>{error || 'Saved chat history is still present. Your current messages remain visible; retry clearing when ready.'}</span>
                  <button type="button" onClick={clearChat}>Retry clear</button>
                </div>
              )}
              {sessionMatchesProfile && clearStatus === 'unconfirmed' && (
                <div role="alert" className="chat-error-banner">
                  <span>We could not confirm whether saved chat history was cleared. Your current messages remain visible here; saved history status is unknown.</span>
                  <button type="button" onClick={checkClearOutcome} disabled={isClearing}>Check saved history</button>
                  <button type="button" onClick={clearChat} disabled={isClearing}>Retry clear</button>
                </div>
              )}
              {visibleMessages.length === 0 && !isLoading && historyStatus === 'loaded' && !historyError && sessionMatchesProfile && (
                <div className="genie-welcome">
                  <div className="genie-welcome-glow" />
                  <div className="genie-welcome-avatar"><div className="welcome-avatar-ring"><span className="ba-letter ba-large">G</span></div></div>
                  <p className="welcome-headline">Hi{profile?.name ? `, ${profile.name.split(' ')[0]}` : ''}! I'm <strong>Genie</strong></p>
                  <p className="welcome-sub">Your personal money guide. Ask me anything and I'll create <strong style={{ color: '#38bdf8' }}>simple action plans</strong> to help you start investing smartly.</p>
                  <PortfolioSnapshot profile={profile} />
                  <div className="welcome-capability-cards">
                    <div className="capability-card"><Scale size={15} style={{color:'#38bdf8'}}/><span>Balance My Investments</span></div>
                    <div className="capability-card"><Percent size={15} style={{color:'#22c55e'}}/><span>Save on Taxes</span></div>
                    <div className="capability-card"><Coins size={15} style={{color:'#a855f7'}}/><span>Grow My SIP</span></div>
                    <div className="capability-card"><Target size={15} style={{color:'#f59e0b'}}/><span>Track My Goals</span></div>
                  </div>
                  {suggestedQuestions.length > 0 && (
                    <div className="welcome-suggestions">
                      {suggestedQuestions.map((q, i) => <button key={i} className="suggestion-pill" onClick={() => sendMessage(q)}><Sparkles size={12} /> {q}</button>)}
                    </div>
                  )}
                </div>
              )}

              <ProactiveNudge profile={profile} onAsk={sendMessage} />

              {visibleMessages.map((msg, i) => <MessageBubble key={i} msg={msg} isLatest={i === visibleMessages.length - 1} />)}

              {sessionMatchesProfile && isLoading && (
                <div className="chat-bubble chat-bubble--genie">
                  <div className="bubble-avatar"><span className="ba-letter">G</span></div>
                  <div className="typing-indicator">
                    <div className="typing-label">Genie is working on your plan...</div>
                    <div className="typing-dots"><span></span><span></span><span></span></div>
                  </div>
                </div>
              )}
              {sessionMatchesProfile && error && <div role="status" className="chat-error-banner">{error}</div>}
              <div ref={chatEndRef} />
            </div>

            {/* Follow-up pills */}
            {visibleMessages.length > 0 && !isLoading && lastAssistantMsg?.content?.length > 50 && (
              <div className="quick-replies">
                {pills.map((p, i) => <button key={i} className="quick-chip follow-up" onClick={() => sendMessage(p)}><Sparkles size={12} /> {p}</button>)}
              </div>
            )}

            {/* Input Bar */}
            <div className="genie-input-bar">
              {recognitionRef.current && (
                <button className={`voice-btn ${isListening ? 'voice-active' : ''}`} onClick={toggleVoice} title="Voice input" aria-label={isListening ? "Stop voice input" : "Start voice input"}>
                  {isListening ? <MicOff size={16} /> : <Mic size={16} />}
                </button>
              )}
              <input ref={inputRef} type="text" value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKeyDown} placeholder={isListening ? 'Listening...' : 'Ask me anything about saving & investing...'} aria-label="Ask Genie a financial question" className="genie-input" maxLength={1000} disabled={isLoading || isClearing || !sessionMatchesProfile || !chatSession.bindingReady || rateLimitBlocked} />
              <button className="genie-send-btn" onClick={() => sendMessage()} aria-label="Send message" disabled={isLoading || isClearing || !input.trim() || !sessionMatchesProfile || !chatSession.bindingReady || rateLimitBlocked}>
                {isLoading ? <RefreshCw size={18} className="spin-icon" /> : <Send size={18} />}
              </button>
            </div>
            {voiceError && <div role="status" className="chat-error-banner">{voiceError}</div>}
            <div className="genie-disclaimer">For informational purposes only. Not registered investment advice under SEBI (IA) Regulations, 2013. Consult a SEBI-registered adviser before investing. Mutual fund investments are subject to market risks.</div>
          </div>

          {activeWorkspace && (
            <div className="genie-panel-workspace-pane">
              <div className="workspace-header">
                <div className="workspace-title-section">
                  <button className="workspace-back-btn" onClick={() => setActiveWorkspace(null)} title="Back to Chat" aria-label="Back to Chat">
                    <ArrowLeft size={16} />
                  </button>
                  <div>
                    <div className="workspace-title">
                      {activeWorkspace === 'rebalancer' && <span>Investment Mix Planner</span>}
                      {activeWorkspace === 'sip-planner' && <span>SIP Growth Calculator</span>}
                      {activeWorkspace === 'taxes' && 'New-Regime Taxes'}
                    </div>
                    <div className="workspace-subtitle">Try it out — play with the numbers below!</div>
                  </div>
                </div>
                <div className="workspace-header-actions">
                  <button className="workspace-fullscreen-btn" onClick={() => { onNavigate(activeWorkspace); setIsOpen(false); }} title="Open Full Page View" aria-label="Open Full Page View">
                    <ExternalLink size={14} /> Full Page View
                  </button>
                  <button className="workspace-close-btn" onClick={() => setActiveWorkspace(null)} aria-label="Close workspace">✕</button>
                </div>
              </div>

              <div className="workspace-content">
                {activeWorkspace === 'rebalancer' && (
                  <div className="workspace-sandbox">
                    <div className="sandbox-intro">
                      <Sparkles size={14} className="text-sky" style={{ flexShrink: 0, marginTop: 2 }} />
                      <span>Explore an allocation split between stocks and safer options. This is a what-if calculator, not a suitability recommendation.</span>
                    </div>

                    {!allocationSplit && (
                      <div role="status" className="sandbox-intro">
                        {allocationSplitError ? `Allocation service unavailable: ${allocationSplitError}` : 'Calculating with the authoritative allocation service...'}
                      </div>
                    )}

                    <div className="sandbox-group">
                      <div className="sandbox-label-row">
                        <span className="sandbox-label"><Scale size={14} /> How much in <JargonTooltip term="Asset Allocation">stocks</JargonTooltip>?</span>
                        <span className="sandbox-val text-sky">{targetEquity}%</span>
                      </div>
                      <input type="range" min="10" max="90" step="5" value={targetEquity} onChange={e => setTargetEquity(Number(e.target.value))} aria-label="Target equity allocation percentage" className="sandbox-slider" />
                      <div className="slider-limits"><span>10% — Play it safe</span><span>90% — Go for growth</span></div>
                    </div>

                    <div className="sandbox-group">
                      <div className="sandbox-label-row">
                        <span className="sandbox-label"><Coins size={14} /> Monthly investment (<JargonTooltip term="SIP">SIP</JargonTooltip>)</span>
                        <span className="sandbox-val text-sky">₹{rebalanceMonthlySIP.toLocaleString('en-IN')}</span>
                      </div>
                      <input type="range" min="1000" max="100000" step="1000" value={rebalanceMonthlySIP} onChange={e => setRebalanceMonthlySIP(Number(e.target.value))} aria-label="Monthly SIP investment amount" className="sandbox-slider" />
                      <div className="slider-limits"><span>₹1K</span><span>₹100K</span></div>
                    </div>

                    {/* Target Allocation Visual Bar */}
                    <div className="allocation-visualizer">
                      <div className="vis-bars-header">Asset Targets</div>
                      <div className="vis-bar-row">
                        <span className="vis-bar-label">Equity ({targetEquity}%)</span>
                        <div className="vis-bar-track"><div className="vis-bar-fill fill-equity" style={{ width: `${targetEquity}%` }} /></div>
                      </div>
                      <div className="vis-bar-row">
                        <span className="vis-bar-label">Debt ({allocationSplit ? `${allocationSplit.debtPct}%` : '—'})</span>
                        <div className="vis-bar-track"><div className="vis-bar-fill fill-debt" style={{ width: `${allocationSplit?.debtPct ?? 0}%` }} /></div>
                      </div>
                    </div>

                    {/* Directed Monthly Plan */}
                    <div className="directed-inflows-card">
                      <div className="inflow-title">Directed Monthly Allocation Plan:</div>
                      <div className="inflow-rows">
                        <div className="inflow-row">
                          <span className="inflow-label">Goes into <JargonTooltip term="Equity">stocks</JargonTooltip>:</span>
                          <span className="inflow-val text-sky">{formatFullINR(allocationSplit?.equityAmount)}</span>
                        </div>
                        <div className="inflow-row">
                          <span className="inflow-label">Goes into <JargonTooltip term="Debt Fund">safer funds</JargonTooltip>:</span>
                          <span className="inflow-val text-purple">{formatFullINR(allocationSplit?.debtAmount)}</span>
                        </div>
                      </div>
                      <div className="inflow-insight">
                        <ChevronRight size={14} className="insight-icon" style={{ flexShrink: 0, marginTop: 2 }} />
                        <span>This view only splits the amount you entered. Product suitability, returns, taxes, fees, and rebalancing trades are intentionally not inferred here.</span>
                      </div>
                    </div>
                  </div>
                )}

                {activeWorkspace === 'sip-planner' && (() => {
                  const stdVal = {
                    terminalValue: sipProjection?.flatFinal ?? null,
                    totalInvested: sipProjection?.flatInvested ?? null,
                  };
                  const stepUpVal = {
                    terminalValue: sipProjection?.stepUpFinal ?? null,
                    totalInvested: sipProjection?.stepUpInvested ?? null,
                  };
                  const diff = sipProjection?.additionalCorpus ?? null;
                  const pct = isPresentFiniteNumber(sipProjection?.additionalPercent)
                    ? Math.round(Number(sipProjection.additionalPercent))
                    : null;

                  return (
                    <div className="workspace-sandbox">
                      <div className="sandbox-intro">
                        <Sparkles size={14} className="text-purple" style={{ flexShrink: 0, marginTop: 2 }} />
                        <span>See how increasing your monthly investment a little each year can make a huge difference over time!</span>
                      </div>

                      {!sipProjection && (
                        <div role="status" className="sandbox-intro">
                          {sipProjectionError ? `Projection service unavailable: ${sipProjectionError}` : 'Calculating with the authoritative projection service...'}
                        </div>
                      )}

                      <div className="sandbox-group">
                        <div className="sandbox-label-row">
                          <span className="sandbox-label"><Coins size={14} /> Base Monthly <JargonTooltip term="SIP">SIP</JargonTooltip></span>
                          <span className="sandbox-val text-purple">₹{sipMonthlyAmount.toLocaleString('en-IN')}</span>
                        </div>
                        <input type="range" min="1000" max="100000" step="1000" value={sipMonthlyAmount} onChange={e => setSipMonthlyAmount(Number(e.target.value))} className="sandbox-slider" />
                        <div className="slider-limits"><span>₹1K</span><span>₹100K</span></div>
                      </div>

                      <div className="sandbox-group">
                        <div className="sandbox-label-row">
                          <span className="sandbox-label"><TrendingUp size={14} /> Expected Pre-Tax Return</span>
                          <span className="sandbox-val text-purple">{sipReturnRate}%</span>
                        </div>
                        <input type="range" min="1" max="30" step="0.5" value={sipReturnRate} onChange={e => setSipReturnRate(Number(e.target.value))} className="sandbox-slider" aria-label="Expected pre-tax annual return" />
                        <div className="slider-limits"><span>1%</span><span>30%</span></div>
                      </div>

                      <div className="sandbox-group">
                        <div className="sandbox-label-row">
                          <span className="sandbox-label"><Percent size={14} /> Yearly <JargonTooltip term="SIP">SIP</JargonTooltip> Increase %</span>
                          <span className="sandbox-val text-purple">{sipStepUpPercent}%</span>
                        </div>
                        <input type="range" min="0" max="25" step="1" value={sipStepUpPercent} onChange={e => setSipStepUpPercent(Number(e.target.value))} className="sandbox-slider" />
                        <div className="slider-limits"><span>0% (Flat)</span><span>25% (Booster)</span></div>
                      </div>

                      <div className="sandbox-group">
                        <div className="sandbox-label-row">
                          <span className="sandbox-label"><Target size={14} /> Years to Invest</span>
                          <span className="sandbox-val text-purple">{sipHorizon} Years</span>
                        </div>
                        <input type="range" min="5" max="35" step="1" value={sipHorizon} onChange={e => setSipHorizon(Number(e.target.value))} className="sandbox-slider" />
                        <div className="slider-limits"><span>5 Yrs</span><span>35 Yrs</span></div>
                      </div>

                      {/* Visual Bar Comparison */}
                      <div className="comparison-viz">
                        <div className="comp-bars-header">Accumulated Wealth Projections ({sipReturnRate}% <JargonTooltip term="CAGR">yearly growth</JargonTooltip>)</div>
                        <div className="comp-bar-container">
                          <div className="comp-bar-label-col">Flat <JargonTooltip term="SIP">SIP</JargonTooltip></div>
                          <div className="comp-bar-val-col">
                            <div className="comp-bar-fill-track">
                              <div className="comp-bar-fill bg-grey" style={{ width: '50%' }} />
                            </div>
                            <span className="comp-val">{formatLakhs(stdVal.terminalValue)}</span>
                          </div>
                        </div>

                        <div className="comp-bar-container">
                          <div className="comp-bar-label-col">Step-Up</div>
                          <div className="comp-bar-val-col">
                            <div className="comp-bar-fill-track">
                              <div className="comp-bar-fill bg-gradient-purple" style={{ width: `${pct === null ? 0 : Math.min(100, 50 * (1 + pct / 100))}%` }} />
                            </div>
                            <span className="comp-val text-purple font-bold">{formatLakhs(stepUpVal.terminalValue)}</span>
                          </div>
                        </div>
                      </div>

                      {/* Wealth boost highlight card */}
                      <div className="wealth-boost-card">
                        <div className="boost-header">
                          <TrendingUp size={20} className="text-green" />
                          <div>
                            <div className="boost-title">Your Extra Projected Corpus: {pct === null ? '—' : `+${pct}%`}</div>
                            <div className="boost-val">Projected difference: {formatLakhs(diff)}</div>
                          </div>
                        </div>
                        <div className="boost-details">
                          You'd invest {formatLakhs(stepUpVal.totalInvested)} total (instead of {formatLakhs(stdVal.totalInvested)} without yearly increase). With the explicit {sipStepUpPercent}% annual increase, the server projects an additional {formatFullINR(diff)} before tax and costs.
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {/* Income tax is calculated only through the verified Taxes hub. */}
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
};

export default GenieChat;
