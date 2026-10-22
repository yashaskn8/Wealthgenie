/**
 * WealthGenie — GenieChat UI Subcomponents
 * ────────────────────────────────────────
 * Extracted from GenieChat.jsx for maintainability.
 */
import React, { useState, useEffect } from 'react';
import { Sparkles, ChevronRight, TrendingUp, TrendingDown, Shield, Target, BarChart3, Zap, AlertTriangle, DollarSign, Copy, ThumbsUp, ThumbsDown, Info, BookOpen, ChevronDown } from 'lucide-react';
import chatGenie from '../assets/chat_genie.png';
import { parseActionCards, useStreamedText, streamedMessages } from '../utils/genieChatHelpers.js';

// ── Citations List Component ──────────────────────────────────────
export function CitationsList({ citations }) {
  const [isOpen, setIsOpen] = useState(false);
  if (!Array.isArray(citations) || citations.length === 0) return null;

  return (
    <div className="genie-citations">
      <button 
        type="button" 
        className="citations-toggle-btn" 
        onClick={() => setIsOpen(prev => !prev)}
      >
        <BookOpen size={12} style={{ marginRight: 4 }} />
        <span>Evidence ({citations.length})</span>
        <ChevronDown size={12} style={{ transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s', marginLeft: 'auto' }} />
      </button>
      {isOpen && (
        <div className="citations-list">
          {citations.map((c, i) => {
            const scorePct = typeof c.relevance_score === 'number' && Number.isFinite(c.relevance_score)
              && c.relevance_score >= 0 && c.relevance_score <= 1
              ? Math.round(c.relevance_score * 100) : null;
            // A URL in retrieved or cached RAG data is untrusted. Only HTTPS
            // links are navigable; local computations are not external sources.
            const sourceUrl = typeof c.source_url === 'string'
              && /^https:\/\/[^\s"'<>]+$/i.test(c.source_url) ? c.source_url : null;
            const originLabel = c.evidence_class === 'USER_INPUT'
              ? 'Your stated input'
              : String(c.evidence_class || '').startsWith('DETERMINISTIC_')
                ? 'WealthGenie calculation — not an external source'
                : (c.source || 'Knowledge Base');
            return (
              <div key={i} className="citation-item" style={{ padding: '6px 8px', background: 'rgba(255,255,255,0.03)', borderRadius: '6px', fontSize: '0.8rem' }}>
                <div className="citation-title" style={{ fontWeight: 600, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>
                    <span className="citation-idx" style={{ color: '#38bdf8', marginRight: '4px' }}>[{i + 1}]</span>
                    {sourceUrl ? (
                      <a href={sourceUrl} target="_blank" rel="noopener noreferrer">{c.document_title || 'Source document'}</a>
                    ) : (c.source === 'USER_INPUT' ? 'Your stated information' : c.document_title || 'Verified evidence')}
                    <span style={{ color: '#94a3b8', fontWeight: 400, marginLeft: '6px', fontSize: '0.75rem' }}>({originLabel}{typeof c.chunk_id === 'string' && c.chunk_id ? ` #${c.chunk_id.split('#')[1] || c.chunk_id}` : ''})</span>
                  </span>
                  {scorePct !== null && (
                    <span style={{ fontSize: '0.7rem', padding: '1px 6px', background: 'rgba(56,189,248,0.15)', color: '#38bdf8', borderRadius: '4px' }}>
                      {scorePct}% Match
                    </span>
                  )}
                </div>
                {c.excerpt && <div className="citation-excerpt" style={{ marginTop: '4px', color: '#cbd5e1', fontStyle: 'italic', fontSize: '0.75rem' }}>Evidence summary: {c.excerpt}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Severity theme config ─────────────────────────────────────────
const severityColors = {
  info: { bg: 'rgba(56,189,248,0.08)', border: 'rgba(56,189,248,0.25)', accent: '#38bdf8', glow: 'rgba(56,189,248,0.15)' },
  success: { bg: 'rgba(34,197,94,0.08)', border: 'rgba(34,197,94,0.25)', accent: '#22c55e', glow: 'rgba(34,197,94,0.15)' },
  warning: { bg: 'rgba(245,158,11,0.08)', border: 'rgba(245,158,11,0.25)', accent: '#f59e0b', glow: 'rgba(245,158,11,0.15)' },
  critical: { bg: 'rgba(239,68,68,0.08)', border: 'rgba(239,68,68,0.25)', accent: '#ef4444', glow: 'rgba(239,68,68,0.15)' },
};

const cardIcons = {
  rebalance: <BarChart3 size={18}/>,
  sip_stepup: <TrendingUp size={18}/>,
  tax_save: <Shield size={18}/>,
  goal_insight: <Target size={18}/>,
  market_alert: <AlertTriangle size={18}/>,
  fee_xray: <DollarSign size={18}/>
};

const trendIcons = {
  up: <TrendingUp size={13} style={{color:'#22c55e'}}/>,
  down: <TrendingDown size={13} style={{color:'#ef4444'}}/>,
  neutral: null
};

// ── Sparkline Mini-Chart (inline bar chart for metrics) ───────────
export function SparkBars({ data, color }) {
  if (!data || !data.length) return null;
  const max = Math.max(...data) || 1;
  return (
    <div className="spark-bars">
      {data.map((v, i) => (
        <div key={i} className="spark-bar" style={{ height: `${(v / max) * 100}%`, background: color || '#38bdf8', opacity: 0.4 + (i / data.length) * 0.6 }} />
      ))}
    </div>
  );
}

// ── Action Card Component ─────────────────────────────────────────
export function ActionCard({ card, onAction }) {
  const colors = severityColors[card.severity] || severityColors.info;
  const icon = cardIcons[card.type] || <Zap size={18}/>;
  const [executed, setExecuted] = useState(null);

  const handleAction = (action) => {
    setExecuted(action.label);
    if (onAction) onAction(action);
  };

  return (
    <div className="action-card" style={{ '--ac-bg': colors.bg, '--ac-border': colors.border, '--ac-accent': colors.accent, '--ac-glow': colors.glow }}>
      <div className="ac-header">
        <div className="ac-icon-wrap" style={{ color: colors.accent }}>{icon}</div>
        <div className="ac-header-text">
          <div className="ac-title">{card.title}</div>
          <div className="ac-subtitle">{card.subtitle}</div>
        </div>
        <div className="ac-severity-dot" style={{ background: colors.accent }} />
      </div>
      {card.metrics?.length > 0 && (
        <div className="ac-metrics">
          {card.metrics.map((m, i) => (
            <div key={i} className="ac-metric">
              <div className="ac-metric-label">{m.label}</div>
              <div className="ac-metric-value">{m.value}{m.trend && <span className="ac-trend">{trendIcons[m.trend]}</span>}</div>
            </div>
          ))}
        </div>
      )}
      {card.sparkData && <SparkBars data={card.sparkData} color={colors.accent} />}
      {card.insight && (
        <div className="ac-insight">
          <Sparkles size={12} style={{ color: colors.accent, flexShrink: 0, marginTop: 2 }} />
          <span>{card.insight}</span>
        </div>
      )}
      {card.actions?.length > 0 && (
        <div className="ac-actions">
          {card.actions.map((action, i) => (
            <button key={i} className={`ac-btn ${i === 0 ? 'ac-btn-primary' : 'ac-btn-secondary'} ${executed === action.label ? 'ac-btn-executed' : ''}`} onClick={() => handleAction(action)} disabled={!!executed} style={i === 0 ? { '--btn-accent': colors.accent } : {}}>
              {executed === action.label ? <>✓ Done</> : <>{action.label}<ChevronRight size={14} /></>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Confidence Meter ──────────────────────────────────────────────
export function ConfidenceMeter() {
  // No model answer has a statistically calibrated probability of being right.
  // Historical high/medium/low values were mapped to invented 95/70/40 scores.
  return (
    <div className="confidence-meter" title="Answer accuracy has not been statistically calibrated">
      <span className="confidence-label">Confidence not scored</span>
    </div>
  );
}

// ── Message Feedback (thumbs up/down) ─────────────────────────────
export function MessageFeedback() {
  const [feedback, setFeedback] = useState(null);
  return (
    <div className="msg-feedback">
      <button className={`fb-btn ${feedback === 'up' ? 'fb-active-up' : ''}`} onClick={() => setFeedback('up')} title="Helpful"><ThumbsUp size={11} /></button>
      <button className={`fb-btn ${feedback === 'down' ? 'fb-active-down' : ''}`} onClick={() => setFeedback('down')} title="Not helpful"><ThumbsDown size={11} /></button>
    </div>
  );
}

// ── Inline Markdown renderer ──────────────────────────────────────
function renderInline(line) {
  if (!line) return null;
  const cleaned = line.replace(/^#{1,3}\s+/, '').replace(/^[*-]\s+/, '').replace(/^>\s+/, '');
  const parts = cleaned.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) return <em key={i}>{part.slice(1, -1)}</em>;
    return <span key={i}>{part}</span>;
  });
}

function formatEvidenceMarkers(text, citations, hideDisclosure = false) {
  // The backend retains the canonical disclosure in signed evidence and chat
  // history; the chat panel displays it once in its persistent footer.
  const notice = 'For informational purposes only. Not registered investment advice under SEBI (IA) Regulations, 2013. Consult a SEBI-registered adviser before investing. Mutual fund investments are subject to market risks. [E_REGULATORY_NOTICE]';
  const displayed = hideDisclosure
    ? text.replaceAll(notice, '').trim() || 'No source-backed answer is available for this question.'
    : text;
  if (!Array.isArray(citations) || citations.length === 0) return displayed;
  const sourceNumbers = new Map(citations.map((citation, index) => [citation.citation_id, index + 1]));
  return displayed.replace(/\[(E_[A-Z0-9_:-]+)\]/g, (marker, id) =>
    sourceNumbers.has(id) ? `[${sourceNumbers.get(id)}]` : marker);
}

// ── Message Content with Action Cards ─────────────────────────────
export function MessageContent({ content, citations, onAction, hideDisclosure = false }) {
  if (!content) return null;
  const { cleanText, cards } = parseActionCards(content);
  const lines = formatEvidenceMarkers(cleanText, citations, hideDisclosure).split('\n');
  return (
    <span className="genie-message-content">
      {lines.map((line, li) => {
        if (!line.trim() && li === lines.length - 1) return null;
        return <span key={li}>{renderInline(line)}{li < lines.length - 1 && <br />}</span>;
      })}
      {cards.map((card, i) => <ActionCard key={i} card={card} onAction={onAction} />)}
    </span>
  );
}

// ── Message Bubble ────────────────────────────────────────────────
export const MessageBubble = ({ msg, onAction, isLatest }) => {
  const [copied, setCopied] = useState(false);
  const isAssistant = msg.role === 'assistant';
  const displayCitations = isAssistant
    ? msg.citations?.filter(citation => citation.citation_id !== 'E_REGULATORY_NOTICE')
    : null;
  const shouldStream = isAssistant && isLatest && !msg._streamed && !streamedMessages.has(msg);
  const { displayed, done } = useStreamedText(shouldStream ? msg.content : null, 6);
  const content = shouldStream ? (done ? msg.content : displayed) : msg.content;

  useEffect(() => {
    if (done && shouldStream) {
      streamedMessages.add(msg);
    }
  }, [done, shouldStream, msg]);

  const handleCopy = () => {
    const { cleanText } = parseActionCards(msg.content);
    navigator.clipboard.writeText(formatEvidenceMarkers(cleanText, displayCitations, isAssistant));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className={`chat-bubble ${msg.role === 'user' ? 'chat-bubble--user' : 'chat-bubble--genie'}`}>
      {isAssistant && <div className="bubble-avatar"><span className="ba-letter">G</span></div>}
      <div className="bubble-body">
        {isAssistant && msg.fallback && msg.provider === 'DETERMINISTIC_TEMPLATE' && (
          <div className="chat-fallback-note">{msg.fallback_reason_codes?.length ? 'Genie used a source-backed fallback because a model answer was unavailable or did not pass verification.' : 'Genie used a deterministic, evidence-based explanation without a model forecast.'}</div>
        )}
        {isAssistant && msg.grounded === false && msg.provider !== 'SYSTEM' && (
          <div className="chat-fallback-note">
            General AI answer · not checked against external sources or live information.
          </div>
        )}
        <div className="bubble-text">
          <MessageContent content={content} citations={displayCitations} onAction={onAction} hideDisclosure={isAssistant} />
          {shouldStream && !done && <span className="stream-cursor">|</span>}
        </div>
        {isAssistant && displayCitations?.length > 0 && (
          <CitationsList citations={displayCitations} />
        )}
        {isAssistant && msg.grounded && (
          <details className="grounding-details" style={{ marginTop: 6, fontSize: '0.72rem', color: '#94a3b8' }}>
            <summary style={{ cursor: 'pointer', color: '#38bdf8' }}>Answer evidence and provenance</summary>
            <div style={{ marginTop: 4 }}>
              Provider: {msg.provider || 'Unavailable'}{msg.model ? ` · Model: ${msg.model}` : ''}
              {msg.grounding_version ? ` · Contract: ${msg.grounding_version}` : ''}
            </div>
            {msg.unavailable_facts?.length > 0 && (
              <div style={{ marginTop: 3 }}>Unavailable: {msg.unavailable_facts.join(', ')}</div>
            )}
            {msg.fallback_reason_codes?.length > 0 && (
              <div style={{ marginTop: 3 }}>Fallback diagnostics: {msg.fallback_reason_codes.join(', ')}</div>
            )}
          </details>
        )}
        <div className="bubble-meta">
          <span className="bubble-time">{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          {isAssistant && msg.latency_ms && <span className="bubble-latency">{(msg.latency_ms / 1000).toFixed(1)}s</span>}
          {isAssistant && <MessageFeedback />}
          {isAssistant && <button className="bubble-copy" onClick={handleCopy} title="Copy">{copied ? '✓' : <Copy size={12} />}</button>}
        </div>
      </div>
    </div>
  );
};

// ── Proactive Nudge Banner ────────────────────────────────────────
export function ProactiveNudge({ profile, onAsk }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || !profile) return null;
  let nudge = null;
  if (profile.final_suitability_risk && profile.final_suitability_risk !== profile.risk_tolerance) {
    nudge = { 
      icon: <AlertTriangle size={15} style={{ verticalAlign: 'middle' }} />, 
      text: `Your declared ${profile.risk_tolerance} preference was reduced to ${profile.final_suitability_risk} by the server suitability assessment.`,
      question: 'Why did my suitability assessment reduce my risk level?'
    };
  }
  if (!nudge) return null;
  return (
    <div className="proactive-nudge">
      <span className="nudge-icon">{nudge.icon}</span>
      <span className="nudge-text">{nudge.text}</span>
      <button className="nudge-btn" onClick={() => { onAsk(nudge.question); setDismissed(true); }}>Ask Genie</button>
      <button className="nudge-dismiss" onClick={() => setDismissed(true)}>✕</button>
    </div>
  );
}

// ── Portfolio Snapshot Widget ─────────────────────────────────────
export function PortfolioSnapshot({ profile }) {
  if (!profile) return null;
  const parsePresentNumber = value => (value === null || value === undefined || String(value).trim() === ''
    ? null : Number.isFinite(Number(value)) ? Number(value) : null);
  const monthlySavings = parsePresentNumber(profile.monthly_savings);
  const riskLabel = typeof profile.final_suitability_risk === 'string'
    ? profile.final_suitability_risk : 'N/A';
  const horizon = parsePresentNumber(profile.investment_horizon_years);
  const items = [
    { label: 'Monthly capacity', value: monthlySavings !== null && monthlySavings >= 0 ? `₹${monthlySavings.toLocaleString('en-IN')}` : 'N/A', color: '#38bdf8' },
    { label: 'Risk', value: riskLabel, color: riskLabel.includes('Aggressive') ? '#ef4444' : riskLabel.includes('Conservative') ? '#22c55e' : '#f59e0b' },
    { label: 'Horizon', value: horizon !== null && horizon > 0 ? `${horizon} years` : 'N/A', color: '#a855f7' },
  ];
  return (
    <div className="portfolio-snapshot">
      {items.map((item, i) => (
        <div key={i} className="snapshot-item">
          <div className="snapshot-label">{item.label}</div>
          <div className="snapshot-value" style={{ color: item.color }}>{item.value}</div>
        </div>
      ))}
    </div>
  );
}

// ── FAB Button ────────────────────────────────────────────────────
export const GenieFAB = ({ onClick, hasNudge }) => (
  <button className="genie-fab" onClick={onClick} title="Ask Genie">
    <img src={chatGenie} alt="Genie AI" className="genie-fab-logo" />
    <span className="genie-fab-ring"></span>
    {hasNudge && <span className="fab-nudge-dot" />}
  </button>
);
