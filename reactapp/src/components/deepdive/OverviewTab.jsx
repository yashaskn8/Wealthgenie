/**
 * DeepDiveModal — Overview Tab
 * ────────────────────────────
 * Renders: Asset Intelligence, Strategic Advantages/Risk Considerations (from master DB),
 * Category-Specific Asset Parameters, Safety & Regulation, Alternatives ("People also consider"),
 * Performance Indexing chart, and Data Provenance footer.
 */
import React from 'react';
import { Shield, Zap, Target, Activity, TrendingUp, AlertCircle, Lock, BarChart3, ShieldCheck, Landmark, ArrowRight, Clock, Info, Layers } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { TRUST_BADGES, investmentDatabase } from '../../investmentDatabase';
import JargonTooltip from '../JargonTooltip';

const formatCatalogRate = value => {
  if (value === null || value === undefined || value === '') return 'Unavailable';
  const rate = Number(value);
  return Number.isFinite(rate) ? `${rate}% p.a.` : 'Unavailable';
};

const formatCatalogHorizon = horizon => (
  Number.isFinite(Number(horizon?.min)) && Number.isFinite(Number(horizon?.max))
    ? `${horizon.min}–${horizon.max} years`
    : 'Unavailable'
);

const neutralizeUnverifiedReferenceClaim = value => {
  if (typeof value !== 'string') return value;
  return /(?:\d+(?:\.\d+)?\s*%|guarantee|risk[ -]?free|dicgc|tax[ -]?free|highest|best\b)/i.test(value)
    ? 'Unavailable until this exact product claim is source-qualified.'
    : value;
};

const OverviewTab = ({ inv, comparisonData, onSelectInvestment }) => {
  // ─── Category-Specific Parameters ───
  const categoryParams = (() => {
    const cat = (inv.category || '').toLowerCase();
    const id = (inv.id || '');
    const horizon = inv.idealHorizon || inv.dynamicData?.idealHorizon || null;

    if (cat.includes('etf')) {
      return [
        { label: 'Expense Ratio', value: 'Unavailable — verify exact product' },
        { label: 'Model Risk Category', value: inv.riskLabel || inv.risk_level || 'Unavailable' },
        { label: 'Model Horizon Assumption', value: formatCatalogHorizon(horizon) },
        { label: 'Settlement', value: 'Unavailable — verify exact product' },
        { label: 'Exchange', value: 'Unavailable — verify exact product' },
        { label: 'Demat Requirement', value: 'Unavailable — verify exact product' },
      ];
    }
    if (cat.includes('mutual') || cat.includes('hybrid')) {
      return [
        { label: 'Expense Ratio', value: 'Unavailable — verify exact product' },
        { label: 'Model Risk Category', value: inv.riskLabel || inv.risk_level || 'Unavailable' },
        { label: 'Model Horizon Assumption', value: formatCatalogHorizon(horizon) },
        { label: 'Settlement', value: 'Unavailable — verify exact product' },
        { label: 'SIP Availability', value: 'Unavailable — verify exact product' },
        { label: 'Demat Requirement', value: 'Unavailable — verify exact product' },
      ];
    }
    if (cat.includes('bond') || cat.includes('debenture')) {
      return [
        { label: 'Model Return Assumption', value: formatCatalogRate(inv.expectedReturn) },
        { label: 'Credit Quality', value: 'Unavailable — verify exact product' },
        { label: 'Model Horizon Assumption', value: formatCatalogHorizon(horizon) },
        { label: 'Settlement', value: 'Unavailable — verify exact product' },
        { label: 'Demat Requirement', value: 'Unavailable — verify exact product' },
      ];
    }
    if (cat.includes('government') || inv.assetClass === 'Sovereign') {
      return [
        { label: 'Model Return Assumption', value: formatCatalogRate(inv.expectedReturn) },
        { label: 'Lock-in Period', value: 'Unavailable here — see verified product facts' },
        { label: 'Backing / Guarantee', value: 'Unavailable here — verify exact scheme terms' },
        { label: 'Tax Treatment', value: 'Requires explicit Tax view inputs and classification' },
        { label: 'Contribution Limit', value: 'Unavailable here — verify exact scheme terms' },
      ];
    }
    if (cat.includes('reit') || cat.includes('invit')) {
      return [
        { label: 'Model Return Assumption', value: formatCatalogRate(inv.expectedReturn) },
        { label: 'Model Risk Category', value: inv.riskLabel || inv.risk_level || 'Unavailable' },
        { label: 'Distribution Terms', value: 'Unavailable — verify exact product' },
        { label: 'Settlement', value: 'Unavailable — verify exact product' },
        { label: 'Exchange', value: 'Unavailable — verify exact product' },
        { label: 'Demat Requirement', value: 'Unavailable — verify exact product' },
      ];
    }
    if (cat.includes('gold') || id.includes('gold') || id === 'sgb') {
      return [
        { label: 'Asset Type', value: 'Gold / Precious Metal' },
        { label: 'Coupon / Interest', value: 'Unavailable — verify exact product or issue' },
        { label: 'Model Horizon Assumption', value: formatCatalogHorizon(horizon) },
        { label: 'Settlement', value: 'Unavailable — verify exact product' },
        { label: 'Inflation Hedge', value: 'Not guaranteed; outcomes depend on product and market' },
      ];
    }
    if (cat.includes('deposit') || id.endsWith('_fd')) {
      return [
        { label: 'Model Return Assumption', value: formatCatalogRate(inv.expectedReturn) },
        { label: 'Deposit Insurance', value: 'Unavailable here — verify provider and ownership scope' },
        { label: 'Model Tenure Assumption', value: formatCatalogHorizon(horizon) },
        { label: 'Premature Withdrawal', value: 'Unavailable — verify exact product' },
        { label: 'Compounding', value: 'Unavailable — verify exact product' },
      ];
    }
    // Fallback for Direct Equity, Insurance, Retirement, Other
    return [
      { label: 'Catalog Return Assumption', value: formatCatalogRate(inv.expectedReturn) },
      { label: 'Risk Category', value: inv.riskLabel || inv.risk_level || 'Unavailable' },
      { label: 'Ideal Horizon', value: formatCatalogHorizon(horizon) },
      { label: 'Settlement', value: 'Unavailable — verify exact product' },
    ];
  })();

  // ─── Pros / Cons from master DB ───
  const pros = inv.pros || inv.staticData?.pros || [];
  const cons = inv.cons || inv.staticData?.cons || [];

  // ─── Alternatives ───
  const alternativeIds = inv.alternatives || inv.staticData?.alternatives || [];
  const alternativeInstruments = alternativeIds
    .map(altId => investmentDatabase.find(x => x.id === altId))
    .filter(Boolean)
    .slice(0, 4);

  // ─── Data Provenance ───
  const metadata = inv.metadata || inv.staticData?.metadata || {};
  const returnSource = inv.dynamicData?.expectedReturn?.source || '';
  const returnLastUpdated = inv.dynamicData?.expectedReturn?.lastUpdated || '';

  return (
    <div className="tab-fade-in">
      <div className="ddm-section-header">Asset Intelligence</div>
      <div className="ddm-desc-card">
        <p>{neutralizeUnverifiedReferenceClaim(inv.description)}</p>
        <p style={{ color: '#94a3b8', fontSize: '0.78rem', marginTop: '8px' }}>
          REFERENCE METADATA only. Current source-backed rates and product facts appear in Where to Invest; numerical return ranges here are versioned model assumptions.
        </p>
      </div>

      {/* Category-Specific Asset Parameters */}
      <div className="ddm-section-header">Asset Parameters</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '10px', marginBottom: '24px' }}>
        {categoryParams.map((param, idx) => (
          <div key={idx} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: '12px', padding: '14px 16px' }}>
            <div style={{ fontSize: '0.72rem', color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>{param.label}</div>
            <div style={{ fontSize: '0.92rem', color: '#e2e8f0', fontWeight: 600 }}>{param.value}</div>
          </div>
        ))}
      </div>

      {/* Strategic Advantages (Pros from Master DB) */}
      <div className="ddm-pc-grid">
        <div className="pc-card pc-card--pros">
          <div className="pc-title" style={{ color: '#22c55e' }}><Shield size={20} /> Strategic Advantages</div>
          <ul className="pc-list">
            {pros.map((pro, idx) => (
              <li key={idx} className="pc-item"><Zap size={14} className="pc-icon" /> {neutralizeUnverifiedReferenceClaim(pro)}</li>
            ))}
          </ul>
        </div>
        <div className="pc-card pc-card--cons">
          <div className="pc-title" style={{ color: '#f59e0b' }}><AlertCircle size={20} /> Risk Considerations</div>
          <ul className="pc-list">
            {cons.map((con, idx) => (
              <li key={idx} className="pc-item"><BarChart3 size={14} className="pc-icon" /> {neutralizeUnverifiedReferenceClaim(con)}</li>
            ))}
          </ul>
        </div>
      </div>

      {/* Safety & Regulation Section */}
      {(() => {
        const trustInfo = inv.trustBadge || inv.staticData?.trustBadge || TRUST_BADGES[inv.id] || null;
        if (!trustInfo) return null;
        const isSovereign = trustInfo.type === 'sovereign' || trustInfo.type === 'rbi';
        const isInsured = trustInfo.type === 'insured';
        const accentColor = isSovereign ? '#38bdf8' : isInsured ? '#10b981' : '#8b5cf6';
        const accentBg = isSovereign ? 'rgba(56, 189, 248, 0.06)' : isInsured ? 'rgba(16, 185, 129, 0.06)' : 'rgba(139, 92, 246, 0.06)';
        return (
          <>
            <div className="ddm-section-header">Safety & Regulation</div>
            <div className="ddm-trust-card" style={{ borderColor: accentColor.replace(')', ', 0.2)').replace('rgb', 'rgba') }}>
              <div className="ddm-trust-header">
                <div className="ddm-trust-icon" style={{ background: accentBg, color: accentColor }}>
                  {isSovereign ? <Landmark size={22} /> : <ShieldCheck size={22} />}
                </div>
                <div className="ddm-trust-titles">
                  <span className="ddm-trust-label" style={{ color: accentColor }}>Reference Safety Metadata</span>
                  <span className="ddm-trust-body">Unavailable until source-qualified for the exact product.</span>
                </div>
              </div>
              <p className="ddm-trust-desc">The legacy catalog badge is not current provider evidence. Verify current backing, insurance, limits, issuer risk, and product terms from an official source.</p>
              <div className="ddm-trust-footer">
                <span className="ddm-trust-chip"><Lock size={11} /> Catalog disclosure</span>
                <span className="ddm-trust-chip"><ShieldCheck size={11} /> Verify current terms</span>
                {isSovereign && <span className="ddm-trust-chip"><Landmark size={11} /> Exact backing unverified here</span>}
                {isInsured && <span className="ddm-trust-chip"><Shield size={11} /> Exact insurance scope unverified here</span>}
              </div>
            </div>
          </>
        );
      })()}

      {/* People Also Consider (Alternatives) */}
      {alternativeInstruments.length > 0 && (
        <>
          <div className="ddm-section-header">Related Catalog Entries (Not Recommendations)</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '10px', marginBottom: '24px' }}>
            {alternativeInstruments.map(alt => (
              <button
                key={alt.id}
                onClick={() => onSelectInvestment && onSelectInvestment(alt)}
                style={{
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: '14px',
                  padding: '16px',
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'all 0.25s ease',
                  outline: 'none',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(56, 189, 248, 0.08)'; e.currentTarget.style.borderColor = 'rgba(56, 189, 248, 0.3)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'; }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <span style={{ fontSize: '0.88rem', fontWeight: 700, color: '#f1f5f9' }}>{alt.abbr || alt.name}</span>
                  <ArrowRight size={14} style={{ color: '#38bdf8', opacity: 0.7 }} />
                </div>
                <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginBottom: '6px' }}>{alt.category}</div>
                <div style={{ display: 'flex', gap: '12px', fontSize: '0.75rem' }}>
                  <span style={{ color: '#22c55e' }}>Model assumption: {formatCatalogRate(alt.expectedReturn)}</span>
                  <span style={{ color: alt.riskLabel?.includes?.('High') ? '#f43f5e' : '#94a3b8' }}>{alt.riskLabel || 'Unavailable'}</span>
                </div>
              </button>
            ))}
          </div>
        </>
      )}

      <div className="ddm-section-header">Model Assumption Comparison</div>
      <div className="ddm-chart-container">
        <ResponsiveContainer width="100%" height={360} initialDimension={{ width: 1, height: 1 }}>
          <BarChart data={comparisonData} margin={{ top: 20, right: 20, left: -10, bottom: 30 }}>
            <defs>
              <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#38bdf8" stopOpacity={1}/>
                <stop offset="50%" stopColor="#8b5cf6" stopOpacity={0.8}/>
                <stop offset="100%" stopColor="#8b5cf6" stopOpacity={0.1}/>
              </linearGradient>
              <linearGradient id="barGradMuted" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#94a3b8" stopOpacity={0.4}/>
                <stop offset="100%" stopColor="#475569" stopOpacity={0.05}/>
              </linearGradient>
              <linearGradient id="cursorGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.1}/>
                <stop offset="100%" stopColor="transparent" stopOpacity={0}/>
              </linearGradient>
              <filter id="barGlow" x="-30%" y="-30%" width="160%" height="160%">
                <feGaussianBlur stdDeviation="6" result="blur" />
                <feComposite in="SourceGraphic" in2="blur" operator="over" />
              </filter>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
            <XAxis dataKey="name" tick={{ fill: '#cbd5e1', fontSize: 11, fontWeight: 600 }} axisLine={{ stroke: 'rgba(255,255,255,0.1)' }} tickLine={false} dy={16} />
            <YAxis tick={{ fill: '#94a3b8', fontSize: 10, fontWeight: 600 }} axisLine={false} tickLine={false} dx={-10} />
            <Tooltip cursor={{ fill: 'url(#cursorGrad)' }} contentStyle={{ background: 'rgba(15, 23, 42, 0.9)', backdropFilter: 'blur(24px)', border: '1px solid rgba(56, 189, 248, 0.3)', borderRadius: 16, boxShadow: '0 16px 32px rgba(0,0,0,0.8), 0 0 20px rgba(56, 189, 248, 0.15)', color: '#f8fafc', fontWeight: 600, padding: '16px' }} itemStyle={{ color: '#38bdf8', fontWeight: 800, fontSize: '1.1rem' }} labelStyle={{ color: '#cbd5e1', marginBottom: '8px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '8px' }} />
            <Bar dataKey="returnMax" name="Model Return Assumption %" radius={[6, 6, 0, 0]} barSize={32}>
              {comparisonData.map((entry, idx) => (
                <Cell key={idx} fill={entry.isThis ? 'url(#barGrad)' : 'url(#barGradMuted)'} filter={entry.isThis ? 'url(#barGlow)' : 'none'} style={{ transition: 'all 0.4s cubic-bezier(0.16, 1, 0.3, 1)' }} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Data Provenance & Versioning Footer */}
      {metadata.version && (
        <div style={{ marginTop: '24px', padding: '16px 20px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
            <Info size={14} style={{ color: '#64748b' }} />
            <span style={{ fontSize: '0.75rem', color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Data Provenance</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '8px', fontSize: '0.78rem' }}>
            <div><span style={{ color: '#64748b' }}>Catalog Version:</span> <span style={{ color: '#94a3b8', fontWeight: 600 }}>v{metadata.version}</span></div>
            <div><span style={{ color: '#64748b' }}>Last Updated:</span> <span style={{ color: '#94a3b8', fontWeight: 600 }}>{metadata.lastUpdated}</span></div>
            <div><span style={{ color: '#64748b' }}>Reviewed By:</span> <span style={{ color: '#94a3b8', fontWeight: 600 }}>{metadata.reviewedBy}</span></div>
            <div><span style={{ color: '#64748b' }}>Confidence:</span> <span style={{ color: metadata.sourceConfidence === 'High' ? '#22c55e' : '#f59e0b', fontWeight: 600 }}>{metadata.sourceConfidence}</span></div>
            <div style={{ gridColumn: '1 / -1' }}><span style={{ color: '#64748b' }}>Return Classification:</span> <span style={{ color: '#94a3b8', fontWeight: 600 }}>{inv.returnDataClass === 'UNAVAILABLE'
              ? 'UNAVAILABLE · No current bank quote is available in this catalog'
              : `MODEL_ASSUMPTION · ${inv.returnAssumptionVersion || 'wealthgenie-projection-assumptions-1.0.0'} · not an observed market fact or provider forecast`}</span></div>
            {returnSource && <div style={{ gridColumn: '1 / -1' }}><span style={{ color: '#64748b' }}>Legacy Catalog Citation:</span> <span style={{ color: '#94a3b8', fontWeight: 600 }}>{returnSource} ({returnLastUpdated}) — reference metadata only</span></div>}
          </div>
        </div>
      )}
    </div>
  );
};

export default OverviewTab;
