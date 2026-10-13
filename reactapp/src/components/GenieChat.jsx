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

// ── Main Component ────────────────────────────────────────────────
const GenieChat = ({ profile, onNavigate }) => {
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
  const [sessionId, setSessionId] = useState(() => {
    const stored = sessionStorage.getItem('genie_session_id');
    if (stored) return stored;
    const newId = crypto.randomUUID();
    sessionStorage.setItem('genie_session_id', newId);
    return newId;
  });
  const chatEndRef = useRef(null);
  const inputRef = useRef(null);
  const recognitionRef = useRef(null);
  const historyRequestIdRef = useRef(0);

  // ── 2026 Agentic Workspace State ────────────────────────────────
  const [activeWorkspace, setActiveWorkspace] = useState(null); // null | 'rebalancer' | 'sip-planner' | 'tax-optimizer'

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

  // Tax Optimizer parameters
  const [taxGrossIncome, setTaxGrossIncome] = useState(300000);
  const [taxIncomeSource, setTaxIncomeSource] = useState('');
  const [taxFiscalYear, setTaxFiscalYear] = useState('');
  const [tax80C, setTax80C] = useState(0);
  const [taxNPS, setTaxNPS] = useState(0);
  const [taxComparison, setTaxComparison] = useState(null);
  const [taxComparisonError, setTaxComparisonError] = useState(null);
  const [taxPolicyMetadata, setTaxPolicyMetadata] = useState(null);

  useEffect(() => {
    if (typeof api.getTaxPolicyMetadata !== 'function') return undefined;
    let cancelled = false;
    api.getTaxPolicyMetadata()
      .then(metadata => {
        if (cancelled) return;
        setTaxPolicyMetadata(metadata);
        if (metadata?.currentFiscalYearVerified && metadata.currentFiscalYear) {
          setTaxFiscalYear(current => current || metadata.currentFiscalYear);
        }
      })
      .catch(() => {
        if (!cancelled) setTaxPolicyMetadata(null);
      });
    return () => { cancelled = true; };
  }, []);

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

  useEffect(() => {
    if (activeWorkspace !== 'tax-optimizer' || !taxIncomeSource || !taxFiscalYear) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      setTaxComparisonError(null);
      api.compareTax(taxGrossIncome, {
        section80C: tax80C,
        nps80CCD1B: taxNPS,
        age: profile?.age,
        incomeSource: taxIncomeSource,
        fiscalYear: taxFiscalYear,
      })
        .then(result => {
          if (cancelled) return;
          setTaxComparison({
            taxNew: result.new_regime.tax,
            taxOld: result.old_regime.tax,
            difference: result.saving,
            betterRegime: result.recommended_regime,
            standardDeductionNew: result.new_regime.standard_deduction,
            standardDeductionOld: result.old_regime.standard_deduction,
            oldRegimeDeductions: result.old_regime.old_regime_deductions,
            deductionLimits: result.deduction_limits,
            policyVersion: result.policyVersion,
            fiscalYear: result.fiscalYear,
          });
        })
        .catch(error => {
          if (!cancelled) {
            setTaxComparison(null);
            setTaxComparisonError(error.message);
          }
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [activeWorkspace, profile?.age, taxFiscalYear, taxGrossIncome, taxIncomeSource, tax80C, taxNPS]);

  const lastUserMessage = messages.filter(m => m.role === 'user').slice(-1)[0]?.content || '';
  const lastAssistantMsg = messages.filter(m => m.role === 'assistant').slice(-1)[0];

  const loadHistory = useCallback(async () => {
    const requestId = ++historyRequestIdRef.current;
    const requestedSessionId = sessionId;
    setHistoryStatus('loading');
    setHistoryError(null);
    try {
      const data = await api.getChatHistory(requestedSessionId);
      if (requestId !== historyRequestIdRef.current || requestedSessionId !== sessionId) return;
      if (!Array.isArray(data?.conversations)) throw new Error('Invalid chat history response');
      const conversation = data.conversations[0];
      if (conversation && !Array.isArray(conversation.messages)) throw new Error('Invalid chat history response');
      if (conversation?.messages) {
        setMessages(conversation.messages.map(m => ({
          role: m.role === 'model' ? 'assistant' : 'user',
          content: m.content,
          timestamp: m.timestamp || new Date().toISOString(),
          latency_ms: m.metadata?.latency_ms,
          grounded: m.metadata?.grounded_on_profile,
          provider: m.metadata?.provider,
          model: m.metadata?.model,
          grounding_version: m.metadata?.grounding_version,
          evidence_ids_used: m.metadata?.evidence_ids_used || [],
          unavailable_facts: m.metadata?.unavailable_facts || [],
          citations: m.metadata?.citations || [],
          _streamed: true,
        })));
      } else {
        setMessages([]);
      }
      setHistoryStatus('loaded');
    } catch {
      if (requestId !== historyRequestIdRef.current || requestedSessionId !== sessionId) return;
      setHistoryStatus('failed');
      setHistoryError('Saved chat history could not be loaded. Check your connection and retry.');
    }
  }, [sessionId]);

  useEffect(() => {
    if (isOpen && sessionId && historyStatus === 'idle') {
      loadHistory();
    }
  }, [isOpen, sessionId, historyStatus, loadHistory]);
  useEffect(() => () => { historyRequestIdRef.current += 1; }, []);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, isLoading]);

  // Voice recognition setup
  useEffect(() => {
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      recognitionRef.current = new SpeechRecognition();
      recognitionRef.current.continuous = false;
      recognitionRef.current.interimResults = false;
      recognitionRef.current.lang = 'en-IN';
      recognitionRef.current.onresult = (e) => { const t = e.results[0][0].transcript; setInput(prev => prev + t); setIsListening(false); };
      recognitionRef.current.onerror = () => setIsListening(false);
      recognitionRef.current.onend = () => setIsListening(false);
    }
  }, []);

  const toggleVoice = () => {
    if (!recognitionRef.current) return;
    if (isListening) { recognitionRef.current.stop(); setIsListening(false); }
    else { recognitionRef.current.start(); setIsListening(true); }
  };

  const handleAction = useCallback((action) => {
    if (!action) return;
    const target = action.target || action.url || '';
    if (onNavigate) {
      const TARGET_MAPPING = {
        '/rebalancer': 'rebalancer',
        '/portfolio-rebalance': 'rebalancer',
        '/stepup': 'sip-planner',
        '/tax': 'tax-optimizer',
        '/tax-optimizer': 'tax-optimizer',
        '/goals': 'goals',
        '/comparison': 'compare',
        '/compare': 'compare',
        '/investments': 'compare',
        '/invest': 'compare',
        '/recommendations': 'dashboard',
        '/dashboard': 'dashboard',
        '/profile': 'profile',
        '/calculators': 'sip-planner',
        '/allocation': 'allocation',
      };

      let page = TARGET_MAPPING[target];
      if (!page && target) {
        const lower = target.toLowerCase();
        if (lower.includes('rebal')) page = 'rebalancer';
        else if (lower.includes('tax')) page = 'tax-optimizer';
        else if (lower.includes('step') || lower.includes('sip') || lower.includes('calc')) page = 'sip-planner';
        else if (lower.includes('goal')) page = 'goals';
        else if (lower.includes('comp') || lower.includes('invest')) page = 'compare';
        else if (lower.includes('prof')) page = 'profile';
        else if (lower.includes('alloc')) page = 'allocation';
        else page = 'dashboard';
      }

      if (!page) page = 'dashboard';

      if (['rebalancer', 'sip-planner', 'tax-optimizer'].includes(page)) {
        setActiveWorkspace(page);
      } else {
        onNavigate(page);
        setIsOpen(false); // Close chatbot panel on successful navigation
      }
    }
  }, [onNavigate]);

  const sendMessage = useCallback(async (text) => {
    const messageText = (text || input).trim();
    if (!messageText || isLoading) return;
    setInput(''); setError(null);
    setMessages(prev => [...prev, { role: 'user', content: messageText, timestamp: new Date().toISOString() }]);
    setIsLoading(true);
    try {
      const data = await api.sendChatMessage(messageText, sessionId);
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
        _streamed: false,
      }]);
      setRateLimit({ remaining: data.rate_limit_remaining, total: 30 });
    } catch (err) { setError(err.message || 'Genie is temporarily unavailable.'); }
    finally { setIsLoading(false); inputRef.current?.focus(); }
  }, [input, isLoading, sessionId]);

  const handleKeyDown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } };

  const clearChat = async () => {
    if (isClearing) return;
    setIsClearing(true);
    setClearStatus('pending');
    setHistoryError(null);
    try {
      await api.clearChatSession(sessionId);
      historyRequestIdRef.current += 1;
      setMessages([]);
      setError(null);
      setRateLimit({ remaining: 30, total: 30 });
      const newId = crypto.randomUUID();
      setSessionId(newId);
      setHistoryStatus('idle');
      setClearStatus('confirmed');
      try {
        sessionStorage.setItem('genie_session_id', newId);
      } catch {
        setClearStatus('storage-warning');
      }
    } catch {
      setClearStatus('failed');
    }
    finally {
      setIsClearing(false);
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
                <button onClick={clearChat} title="Clear chat" aria-label="Clear chat conversation" disabled={isClearing}><Trash2 size={16} /></button>
                <button onClick={() => setIsOpen(false)} title="Close" aria-label="Close chat helper"><X size={18} /></button>
              </div>
            </div>

            {/* Messages */}
            <div className="genie-messages">
              {historyStatus === 'loading' && messages.length === 0 && (
                <div role="status" className="chat-history-status">Loading saved conversation…</div>
              )}
              {historyError && (
                <div role="alert" className="chat-error-banner">
                  <span>{historyError}</span>
                  <button type="button" onClick={loadHistory}>Retry loading history</button>
                </div>
              )}
              {clearStatus === 'pending' && <div role="status" className="chat-history-status">Clearing saved conversation…</div>}
              {clearStatus === 'confirmed' && <div role="status" className="chat-history-status">Saved conversation cleared.</div>}
              {clearStatus === 'storage-warning' && <div role="status" className="chat-history-status">Saved conversation cleared, but the new chat session could not be remembered for the next visit.</div>}
              {clearStatus === 'failed' && (
                <div role="alert" className="chat-error-banner">
                  <span>The conversation could not be cleared. Your saved messages are still available.</span>
                  <button type="button" onClick={clearChat}>Retry clear</button>
                </div>
              )}
              {messages.length === 0 && !isLoading && historyStatus === 'loaded' && !historyError && (
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

              {messages.map((msg, i) => <MessageBubble key={i} msg={msg} onAction={handleAction} isLatest={i === messages.length - 1} />)}

              {isLoading && (
                <div className="chat-bubble chat-bubble--genie">
                  <div className="bubble-avatar"><span className="ba-letter">G</span></div>
                  <div className="typing-indicator">
                    <div className="typing-label">Genie is working on your plan...</div>
                    <div className="typing-dots"><span></span><span></span><span></span></div>
                  </div>
                </div>
              )}
              {error && <div className="chat-error-banner">{error}</div>}
              <div ref={chatEndRef} />
            </div>

            {/* Follow-up pills */}
            {messages.length > 0 && !isLoading && lastAssistantMsg?.content?.length > 50 && (
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
              <input ref={inputRef} type="text" value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKeyDown} placeholder={isListening ? 'Listening...' : 'Ask me anything about saving & investing...'} aria-label="Ask Genie a financial question" className="genie-input" maxLength={1000} disabled={isLoading || rateLimit.remaining === 0} />
              <button className="genie-send-btn" onClick={() => sendMessage()} aria-label="Send message" disabled={isLoading || !input.trim() || rateLimit.remaining === 0}>
                {isLoading ? <RefreshCw size={18} className="spin-icon" /> : <Send size={18} />}
              </button>
            </div>
            <div className="genie-disclaimer">AI-powered guidance · Not SEBI-registered advice · For learning purposes</div>
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
                      {activeWorkspace === 'tax-optimizer' && 'Tax What-If Helper'}
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

                {activeWorkspace === 'tax-optimizer' && (() => {
                  const taxes = taxComparison;
                  const section80CLimit = Number(taxes?.deductionLimits?.section80C);
                  const npsLimit = Number(taxes?.deductionLimits?.section80CCD1B);

                  return (
                    <div className="workspace-sandbox">
                      <div className="sandbox-intro">
                        <Sparkles size={14} className="text-orange" style={{ flexShrink: 0, marginTop: 2 }} />
                        <span>Find out which tax system saves you more money! Adjust your income and deductions below to compare.</span>
                      </div>

                      <div className="sandbox-group">
                        <div className="sandbox-label-row">
                          <span className="sandbox-label"><Coins size={14} /> Income Source</span>
                        </div>
                        <select value={taxIncomeSource} onChange={e => setTaxIncomeSource(e.target.value)} className="genie-input" aria-label="Tax income source">
                          <option value="">Choose explicitly</option>
                          <option value="salary">Salary</option>
                          <option value="pension">Pension</option>
                          <option value="family_pension">Family pension</option>
                          <option value="business">Business</option>
                          <option value="other">Other</option>
                        </select>
                      </div>

                      <div className="sandbox-group">
                        <div className="sandbox-label-row">
                          <span className="sandbox-label"><Coins size={14} /> Fiscal Year</span>
                        </div>
                        <select value={taxFiscalYear} onChange={e => setTaxFiscalYear(e.target.value)} className="genie-input" aria-label="Tax fiscal year">
                          <option value="">Choose explicitly</option>
                          {(taxPolicyMetadata?.verifiedFiscalYears || []).map(year => (
                            <option key={year} value={year}>{year}</option>
                          ))}
                        </select>
                      </div>

                      {!taxes && (
                        <div role="status" className="sandbox-intro">
                          {!taxIncomeSource || !taxFiscalYear ? 'Choose an income source and fiscal year to calculate without assumptions.' : (taxComparisonError ? `Tax service unavailable: ${taxComparisonError}` : 'Calculating with the authoritative tax service...')}
                        </div>
                      )}

                      <div className="sandbox-group">
                        <div className="sandbox-label-row">
                          <span className="sandbox-label"><Coins size={14} /> Annual Gross Income</span>
                          <span className="sandbox-val text-orange">{formatFullINR(taxGrossIncome)}</span>
                        </div>
                        <input type="range" min="300000" max="3000000" step="50000" value={taxGrossIncome} onChange={e => setTaxGrossIncome(Number(e.target.value))} className="sandbox-slider" />
                        <div className="slider-limits"><span>₹3L</span><span>₹30L</span></div>
                      </div>

                      <div className="sandbox-group">
                        <div className="sandbox-label-row">
                          <span className="sandbox-label"><Percent size={14} /> <JargonTooltip term="Eligible investment deductions">Enter eligible investment deductions already counted</JargonTooltip></span>
                          <span className="sandbox-val text-orange">{formatFullINR(tax80C)}</span>
                        </div>
                        <input type="range" min="0" max={Number.isFinite(section80CLimit) ? section80CLimit : 0} step="5000" value={tax80C} onChange={e => setTax80C(Number(e.target.value))} className="sandbox-slider" disabled={!Number.isFinite(section80CLimit)} />
                        <div className="slider-limits"><span>₹0</span><span>{Number.isFinite(section80CLimit) ? `${formatFullINR(section80CLimit)} server-policy limit` : 'Awaiting server policy'}</span></div>
                      </div>

                      <div className="sandbox-group">
                        <div className="sandbox-label-row">
                          <span className="sandbox-label"><Coins size={14} /> <JargonTooltip term="NPS">NPS</JargonTooltip> Deduction Input</span>
                          <span className="sandbox-val text-orange">{formatFullINR(taxNPS)}</span>
                        </div>
                        <input type="range" min="0" max={Number.isFinite(npsLimit) ? npsLimit : 0} step="5000" value={taxNPS} onChange={e => setTaxNPS(Number(e.target.value))} className="sandbox-slider" disabled={!Number.isFinite(npsLimit)} />
                        <div className="slider-limits"><span>₹0</span><span>{Number.isFinite(npsLimit) ? `${formatFullINR(npsLimit)} server-policy limit` : 'Awaiting server policy'}</span></div>
                      </div>

                      {/* Side-by-side Comparative Table */}
                      {taxes && <div className="tax-comparison-table">
                        <div className="tax-table-header">
                          <div className="tax-th">What's Compared</div>
                          <div className="tax-th text-center">New Tax System</div>
                          <div className="tax-th text-center">Old Tax System</div>
                        </div>
                        <div className="tax-table-row">
                          <div className="tax-td">Gross Income</div>
                          <div className="tax-td text-center">{formatFullINR(taxGrossIncome)}</div>
                          <div className="tax-td text-center">{formatFullINR(taxGrossIncome)}</div>
                        </div>
                        <div className="tax-table-row">
                          <div className="tax-td">Standard Deduction (auto)</div>
                          <div className="tax-td text-center text-green">-{formatFullINR(taxes.standardDeductionNew)}</div>
                          <div className="tax-td text-center text-green">-{formatFullINR(taxes.standardDeductionOld)}</div>
                        </div>
                        <div className="tax-table-row">
                          <div className="tax-td">Eligible deductions in this scenario</div>
                          <div className="tax-td text-center text-grey">Nil</div>
                          <div className="tax-td text-center text-green">-{formatFullINR(taxes.oldRegimeDeductions)}</div>
                        </div>
                        <div className="tax-table-row font-bold border-t border-b">
                          <div className="tax-td">Tax You Pay</div>
                          <div className="tax-td text-center text-sky">{formatFullINR(taxes.taxNew)}</div>
                          <div className="tax-td text-center text-purple">{formatFullINR(taxes.taxOld)}</div>
                        </div>
                        <div className="tax-table-row">
                          <div className="tax-td">Policy evidence</div>
                          <div className="tax-td text-center" style={{ gridColumn: 'span 2' }}>{taxes.fiscalYear} · {taxes.policyVersion}</div>
                        </div>
                      </div>}

                      {/* Verdict Banner */}
                      {taxes && <div className={`tax-verdict-card ${taxes.betterRegime === 'new' ? 'verdict-new' : 'verdict-old'}`}>
                        <div className="verdict-title">
                          Result: {taxes.betterRegime === 'new' ? 'NEW TAX SYSTEM SAVES MORE!' : 'OLD TAX SYSTEM SAVES MORE!'}
                        </div>
                        <div className="verdict-desc">
                          {taxes.difference === 0 ? (
                            <span>Both systems charge the same tax! We recommend the New System since it's simpler — no need to collect receipts or proofs.</span>
                          ) : (
                            <span>The <strong className="font-bold">{taxes.betterRegime === 'new' ? 'New' : 'Old'} Tax System</strong> is better for you, saving <strong className="font-bold">{formatFullINR(taxes.difference)}</strong> in taxes this year!</span>
                          )}
                        </div>
                      </div>}
                    </div>
                  );
                })()}
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
};

export default GenieChat;
