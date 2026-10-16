import React, { useState, useMemo } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, PieChart, Pie, Cell, ResponsiveContainer, BarChart, Bar, ReferenceLine } from 'recharts';
import { ChevronRight, ChevronDown, Filter, Info, Shield, TrendingUp, Zap, Trophy, BarChart3, AlertCircle, Calendar, Target, Activity, Wallet, PiggyBank, Clock, HelpCircle, Building2, MapPin, Star, User, Edit3, Sparkles, ShieldAlert, CheckCircle2, SlidersHorizontal, PieChart as PieChartIcon } from 'lucide-react';
import { RISK_COLORS, CHART_COLORS } from './investmentDatabase';
import { formatINR, getWhy } from './utils/recommendationPresentation';
import { nullableMarketNumber } from './utils/marketDataDisplay';
import { getConfidenceLabel } from './utils/confidenceLabels';
import { INSTRUMENT_EXPLAINERS, CARD_SUBTITLES, RISK_PLAIN_LABELS, getLockInWarning } from './utils/instrumentExplainers';
import SebiDisclaimer from './components/SebiDisclaimer';
import { formatCompactINR } from './utils/indianNumberFormat';
import JargonTooltip from './components/JargonTooltip';
import { computeSuitabilityMatch } from './utils/suitabilityMatch';

import './Dashboard.css';
import './RecommendationDashboardIntro.css';

const CATEGORY_COLORS = {
  'Cash': '#10b981',        // Vibrant emerald green (safe, liquid)
  'Liquid': '#10b981',
  'Sovereign': '#8b5cf6',   // Royal purple (sovereign / government backed)
  'Government': '#06b6d4',  // Bright teal cyan
  'Debt': '#38bdf8',        // Clean electric sky blue
  'Fixed Income': '#38bdf8',
  'Equity': '#6366f1',      // Refined indigo
  'Equities': '#6366f1',
  'Stocks': '#6366f1',
  'Commodity': '#f59e0b',   // Warm amber / gold
  'Gold': '#f59e0b',
  'Hybrid': '#ec4899',      // Modern rose pink
  'Equity-Debt': '#a855f7', // Balanced violet
  'Alternative': '#f97316'  // Tangy orange
};

const DEFAULT_PALETTE = ['#10b981', '#38bdf8', '#8b5cf6', '#6366f1', '#f59e0b', '#06b6d4', '#ec4899', '#f97316'];

const getCategoryColor = (name, index = 0) => {
  if (!name) return DEFAULT_PALETTE[index % DEFAULT_PALETTE.length];
  const trimmed = String(name).trim();
  if (CATEGORY_COLORS[trimmed]) return CATEGORY_COLORS[trimmed];
  const lower = trimmed.toLowerCase();
  for (const [key, color] of Object.entries(CATEGORY_COLORS)) {
    if (key.toLowerCase() === lower) return color;
  }
  if (lower.includes('cash') || lower.includes('liquid')) return '#10b981';
  if (lower.includes('sovereign') || lower.includes('gov') || lower.includes('rbi')) return '#8b5cf6';
  if (lower.includes('debt') || lower.includes('fd') || lower.includes('bond')) return '#38bdf8';
  if (lower.includes('equity') || lower.includes('stock')) return '#6366f1';
  if (lower.includes('gold') || lower.includes('commodity')) return '#f59e0b';
  if (lower.includes('hybrid')) return '#ec4899';
  return DEFAULT_PALETTE[index % DEFAULT_PALETTE.length];
};

const INSTRUMENT_TYPE_LABELS = Object.freeze({
  ETF: 'ETF', MF: 'MF', MUTUAL_FUND: 'MF', FD: 'FD', FIXED_DEPOSIT: 'FD',
  'G-SEC': 'G-SEC', G_SEC: 'G-SEC', RBI_BOND: 'BOND', BOND: 'BOND',
  PPF: 'PPF', SCSS: 'SCSS', SSY: 'SSY', SGB: 'SGB', NPS: 'NPS',
});

const getInstrumentTypeBadge = (type = '') => {
  const label = INSTRUMENT_TYPE_LABELS[String(type).trim().toUpperCase()] || 'IN';
  const style = label === 'IN'
    ? { color: '#94a3b8', bg: 'rgba(148, 163, 184, 0.1)', border: 'rgba(148, 163, 184, 0.22)' }
    : { color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.12)', border: 'rgba(56, 189, 248, 0.28)' };
  return { label, ...style };
};

const getInstrumentIconData = (assetClass = '') => {
  const category = String(assetClass).trim().toLowerCase();
  if (['sovereign', 'government'].includes(category)) {
    return { Icon: Shield, color: '#c084fc', bg: 'rgba(192, 132, 252, 0.14)', border: 'rgba(192, 132, 252, 0.3)' };
  }
  if (['commodity', 'gold'].includes(category)) {
    return { Icon: Sparkles, color: '#fbbf24', bg: 'rgba(251, 191, 36, 0.14)', border: 'rgba(251, 191, 36, 0.3)' };
  }
  if (['cash', 'liquid'].includes(category)) {
    return { Icon: PiggyBank, color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.14)', border: 'rgba(56, 189, 248, 0.3)' };
  }
  if (['debt', 'fixed income'].includes(category)) {
    return { Icon: Building2, color: '#34d399', bg: 'rgba(52, 211, 153, 0.14)', border: 'rgba(52, 211, 153, 0.3)' };
  }
  if (['equity', 'equities', 'stocks'].includes(category)) {
    return { Icon: BarChart3, color: '#818cf8', bg: 'rgba(129, 140, 248, 0.14)', border: 'rgba(129, 140, 248, 0.3)' };
  }
  return { Icon: TrendingUp, color: '#06b6d4', bg: 'rgba(6, 182, 212, 0.14)', border: 'rgba(6, 182, 212, 0.3)' };
};

const getInstrumentSubtitle = (assetClass = '') => (
  typeof assetClass === 'string' && assetClass.trim() ? assetClass.trim() : null
);
const SOURCE_BADGES = {
  backend: { label: 'Live backend', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.10)', border: 'rgba(56, 189, 248, 0.22)' },
};

const _getSourceBadge = (source) => SOURCE_BADGES[source] || null;

export const BackendFallbackBanner = ({ notice, onDismiss }) => {
  if (!notice) return null;
  return (
    <div
      role="status"
      data-testid="backend-fallback-banner"
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 16px',
        background: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.24)',
        borderRadius: 12, marginBottom: 14, fontSize: '0.78rem', lineHeight: 1.5, color: '#fbbf24'
      }}
    >
      <AlertCircle size={18} color="#f59e0b" style={{ flexShrink: 0, marginTop: 1 }} />
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 800, marginBottom: 2 }}>{notice.message || 'Authoritative recommendations are temporarily unavailable'}</div>
        {notice.detail && <div style={{ color: '#94a3b8', fontSize: '0.72rem' }}>{notice.detail}</div>}
      </div>
      <button
        type="button"
        aria-label="Dismiss fallback notice"
        onClick={onDismiss}
        style={{
          background: 'rgba(10, 16, 30, 0.5)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8,
          color: '#f8fafc', fontSize: '0.68rem', padding: '4px 10px', cursor: 'pointer', fontFamily: 'inherit'
        }}
      >Dismiss</button>
    </div>
  );
};

const RecommendationSourceBadge = () => null;

// Map 5-tier riskCategory to slider value (1-10)
const riskCategoryToSlider = (cat) => {
  const c = cat;
  if (!c) return null;
  if (c === 'Conservative') return 2;
  if (c === 'Conservative-Moderate') return 4;
  if (c === 'Moderate') return 6;
  if (c === 'Moderate-Aggressive') return 8;
  if (c === 'Aggressive') return 10;
  return null;
};

const RecommendationDashboard = ({ userProfile, recommendations: propRecommendations, recommendationMeta, onExploreAll, onRebalance, onNavigate, onLearnMore, isLoading: isLoadingProp, isAdvisoryLoading = false, explanation: _explanation, fallbackNotice, onDismissFallbackNotice }) => {
  const profileHorizon = Number(userProfile?.investment_horizon_years);
  const horizon = Number.isFinite(profileHorizon) && profileHorizon > 0 ? profileHorizon : null;
  const isLoading = Boolean(isLoadingProp);

  const riskValue = riskCategoryToSlider(userProfile?.risk_tolerance);

  // The restored controls present the saved profile; edits happen on the profile screen.
  const derivedRiskLabel = userProfile?.risk_tolerance || 'Not provided';
  const recommendations = useMemo(() => propRecommendations || [], [propRecommendations]);
  const [expandedRows, setExpandedRows] = useState({});
  const [expandedWhyCards, setExpandedWhyCards] = useState({});

  const [sortField, setSortField] = useState('');
  const [filterType, setFilterType] = useState('all');
  const [riskGroupOpen, setRiskGroupOpen] = useState({
    low: true,
    medium: true,
    high: true,
  });
  const [mismatchDismissed, setMismatchDismissed] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(
    !localStorage.getItem('wg_onboarded')
  );
  const [activeTooltip, setActiveTooltip] = useState(null);
  const riskAgeMismatch = useMemo(() => {
    const note = recommendationMeta?.reconciliation_note;
    if (!note) return { flag: false };
    return {
      flag: true,
      severity: 'info',
      title: 'Suitability guard applied',
      message: note,
      recommendation: recommendationMeta?.advisory_note || 'This adjustment was supplied by the recommendation service.',
    };
  }, [recommendationMeta]);

  // Eligibility stats — goal-aware
  const isEmergencyFundGoal = (userProfile?.investment_goals || []).includes('Emergency Fund');
  const displayedCount = recommendations?.length || 0;
  const excludedInstruments = Array.isArray(recommendationMeta?.excluded_due_to_eligibility)
    ? recommendationMeta.excluded_due_to_eligibility
    : [];
  const excludedCount = excludedInstruments.length;
  const totalConsidered = displayedCount + excludedCount;

  const toggleRow = (id) => {
    setExpandedRows(prev => ({ ...prev, [id]: prev[id] === false }));
  };

  const isGroupExpanded = id => expandedRows[id] !== false;

  const toggleWhyCard = (id) => {
    setExpandedWhyCards(prev => ({ ...prev, [id]: !prev[id] }));
  };

  // Shape authoritative recommendation data for the restored dashboard UI.
  // Projection values are intentionally left unavailable unless supplied by the server.
  const { allocationDataOuter, tableData, performanceData, currentMonthly, totalProjected } = useMemo(() => {
    if (!recommendations || recommendations.length === 0) return {
      allocationDataOuter: [], tableData: [], performanceData: [], currentMonthly: 0, totalProjected: null
    };

    // Filter out instruments with zero allocation (dropped by budget constraints)
    const activeRecs = recommendations.filter((rec) => {
      const monthlyAllocation = Number(rec?.monthly_allocation);
      return Number.isFinite(monthlyAllocation) && monthlyAllocation > 0;
    });
    if (activeRecs.length === 0) return {
      allocationDataOuter: [], tableData: [], performanceData: [], currentMonthly: 0, totalProjected: null
    };

    let totalMonthly = 0;
    const catMap = {};
    const tableGroupMap = {};

    const dashboardProjection = recommendationMeta?.dashboard_projection;
    const projectedByInstrument = dashboardProjection?.instrument_projected_values || {};

    activeRecs.forEach((rec) => {
      totalMonthly += rec.monthly_allocation;

      // Outer Donut Aggregation
      const cat = rec.cat || rec.category || 'Other';
      if (!catMap[cat]) catMap[cat] = 0;
      catMap[cat] += rec.monthly_allocation;

      // Table Data grouping
      if (!tableGroupMap[cat]) tableGroupMap[cat] = [];
      const nominalReturn = nullableMarketNumber(rec.nominalReturn);
      const projectedValue = nullableMarketNumber(projectedByInstrument[rec.id]);
      tableGroupMap[cat].push({
        instId: rec.id,
        name: rec.abbr || rec.name,
        fullName: rec.name,
        weight: nullableMarketNumber(rec.allocation_pct)
          ?? (nullableMarketNumber(rec.allocationWeight) === null ? null : rec.allocationWeight * 100),
        ret: Number.isFinite(nominalReturn) ? `${nominalReturn.toFixed(1)}%` : '—',
        risk: rec.riskLabel || rec.risk_level || 'Unavailable',
        alloc: rec.monthly_allocation,
        current: (rec.monthly_allocation * 12).toLocaleString('en-IN'),
        proj: Number.isFinite(projectedValue) ? projectedValue : null,
        lockIn: rec.lock_in_years ?? rec.lockIn ?? null,
        taxBadge: rec.taxClassification?.dataClass === 'VERIFIED_PRODUCT_FACT',
        taxLabel: rec.taxClassification?.dataClass === 'VERIFIED_PRODUCT_FACT'
          ? rec.taxClassification.section || rec.taxClassification.label || 'Verified tax class'
          : null,
        source: rec._source || null
      });
    });

    const outerData = Object.keys(catMap).map((k, i) => ({
      name: k,
      value: catMap[k],
      color: getCategoryColor(k, i)
    }));

    // Format server weights; rounded monthly amounts are not allocation authority.
    const formattedTable = Object.keys(tableGroupMap).map((cat, i) => {
      const children = tableGroupMap[cat];
      return {
        id: i.toString(),
        class: cat,
        hasTax: children.some(c => c.taxBadge),
        children
      }
    });

    const suppliedPerformance = Array.isArray(dashboardProjection?.performance_data)
      ? dashboardProjection.performance_data
      : [];
    const suppliedProjected = nullableMarketNumber(dashboardProjection?.total_projected);

    return {
      allocationDataOuter: outerData,
      tableData: formattedTable,
      performanceData: suppliedPerformance,
      currentMonthly: totalMonthly,
      totalProjected: Number.isFinite(suppliedProjected) ? suppliedProjected : null,
    };
  }, [recommendations, recommendationMeta]);

  // Risk-grouped eligible instruments for "Browse by Risk Level"
  const riskGroups = useMemo(() => {
    if (!recommendations || recommendations.length === 0) return { low: [], medium: [], high: [] };

    return {
      low: recommendations.filter(r => nullableMarketNumber(r.risk) !== null && nullableMarketNumber(r.risk) <= 2),
      medium: recommendations.filter(r => nullableMarketNumber(r.risk) === 3),
      high: recommendations.filter(r => nullableMarketNumber(r.risk) !== null && nullableMarketNumber(r.risk) >= 4),
    };
  }, [recommendations]);

  // Scroll to recommendation card
  const scrollToCard = (name) => {
    const el = document.getElementById(`rec-card-${name}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  return (
    <div className="dashboard-page">
      <style>{`
        /* Scoped overrides for dashboard parameter range sliders */
        .dash-range {
          -webkit-appearance: none !important;
          appearance: none !important;
          width: 100% !important;
          background: transparent !important;
          height: 20px !important;
          outline: none !important;
          margin: 0 !important;
          padding: 0 !important;
          border: none !important;
          box-sizing: border-box !important;
        }

        .dash-range::-webkit-slider-runnable-track {
          width: 100% !important;
          height: 4px !important;
          background: linear-gradient(to right, var(--accent-teal) var(--value, 0%), rgba(255, 255, 255, 0.06) var(--value, 0%)) !important;
          border-radius: 2px !important;
          border: none !important;
          box-sizing: border-box !important;
        }

        .dash-range::-webkit-slider-thumb {
          -webkit-appearance: none !important;
          appearance: none !important;
          height: 12px !important;
          width: 12px !important;
          border-radius: 50% !important;
          background: #ffffff !important;
          border: 2.5px solid var(--accent-teal) !important;
          cursor: pointer !important;
          box-shadow: 0 0 8px rgba(56, 189, 248, 0.5), 0 1px 4px rgba(0, 0, 0, 0.3) !important;
          transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.2s ease !important;
          margin-top: -4px !important;
          box-sizing: border-box !important;
        }

        .dash-range::-webkit-slider-thumb:hover {
          transform: scale(1.2) !important;
          box-shadow: 0 0 12px rgba(56, 189, 248, 0.7), 0 2px 6px rgba(0, 0, 0, 0.4) !important;
        }

        .dash-range::-moz-range-track {
          width: 100% !important;
          height: 4px !important;
          background: rgba(255, 255, 255, 0.06) !important;
          border-radius: 2px !important;
          border: none !important;
          box-sizing: border-box !important;
        }

        .dash-range::-moz-range-thumb {
          height: 12px !important;
          width: 12px !important;
          border-radius: 50% !important;
          background: #ffffff !important;
          border: 2.5px solid var(--accent-teal) !important;
          cursor: pointer !important;
          box-shadow: 0 0 8px rgba(56, 189, 248, 0.5), 0 1px 4px rgba(0, 0, 0, 0.3) !important;
          transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.2s ease !important;
          box-sizing: border-box !important;
        }

        .dash-range::-moz-range-thumb:hover {
          transform: scale(1.2) !important;
          box-shadow: 0 0 12px rgba(56, 189, 248, 0.7), 0 2px 6px rgba(0, 0, 0, 0.4) !important;
        }
      `}</style>
        <div className="dashboard-container" style={{maxWidth: 1600, margin: '0 auto'}}>

        {/* Selected dashboard introduction: presentation only. */}
        <section className="wg-plan-intro" aria-label="Personal wealth plan summary">
          <header className="wg-plan-heading">
            <div className="wg-plan-heading-copy">
              <h1>Your Personal Wealth Plan{userProfile?.name && <span> for {userProfile.name}</span>}</h1>
              <p><Sparkles size={13} aria-hidden="true" style={{ display: 'inline', verticalAlign: '-1px', marginRight: 5, color: '#38bdf8' }} />Your personal savings &amp; investment plan</p>
            </div>
            <div className="wg-plan-heading-meta">
              <span><span className="wg-plan-beacon-dot" aria-hidden="true" />{userProfile?.risk_tolerance ? `${userProfile.risk_tolerance} Risk` : 'Risk not provided'}</span>
              <span><Target size={12} aria-hidden="true" style={{ marginRight: 4 }} />{(userProfile?.investment_goals || []).join(' + ') || 'Goals not provided'}</span>
              <time><Calendar size={11} aria-hidden="true" style={{ marginRight: 4 }} />{new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</time>
            </div>
          </header>

          <BackendFallbackBanner notice={fallbackNotice} onDismiss={onDismissFallbackNotice} />

          {(() => {
            const monthlyTakeHome = Number(userProfile?.monthly_take_home);
            const monthlySavings = Number(userProfile?.monthly_savings);
            const hasTakeHome = Number.isFinite(monthlyTakeHome) && monthlyTakeHome > 0;
            const hasSavings = Number.isFinite(monthlySavings) && monthlySavings >= 0;
            const savingsRate = hasTakeHome && hasSavings ? ((monthlySavings / monthlyTakeHome) * 100).toFixed(0) : null;
            const annualTakeHomeLakhs = hasTakeHome ? (monthlyTakeHome * 12 / 100000).toFixed(1) : null;
            const profileVersion = userProfile?.version ?? userProfile?.__v;

            return (
              <div className="wg-plan-surface">
                <div className="wg-plan-hero" data-testid="beginner-home-hero">
                  <section className="wg-plan-overview" aria-labelledby="wg-plan-overview-title">
                    <div className="wg-plan-section-title">
                      <Target size={17} aria-hidden="true" className="wg-plan-header-icon" />
                      <h2 id="wg-plan-overview-title">Plan Overview</h2>
                    </div>
                    <dl className="wg-plan-capacity">
                      <div className="wg-plan-capacity-main">
                        <dt>Monthly Investment Capacity</dt>
                        <dd>{hasSavings ? <>{formatINR(monthlySavings)}<span>/mo</span></> : (currentMonthly > 0 ? <>{formatINR(currentMonthly)}<span>/mo</span></> : 'Not specified')}</dd>
                      </div>
                      <div className="wg-plan-capacity-metrics">
                        <div className="wg-plan-capacity-metric-chip">
                          <Wallet size={13} aria-hidden="true" />
                          <span>{hasSavings ? `${formatINR(currentMonthly)} of ${formatINR(monthlySavings)} allocated` : `${formatINR(currentMonthly)} allocated`}</span>
                        </div>
                        {savingsRate !== null && (
                          <span className="wg-plan-capacity-ratio">
                            <span className="wg-plan-rate-dot" aria-hidden="true" />
                            {savingsRate}% of income
                          </span>
                        )}
                      </div>
                    </dl>
                    <dl className="wg-plan-facts">
                      <div>
                        <dt><Target size={12} aria-hidden="true" style={{ color: '#38bdf8' }} /> Primary Goal</dt>
                        <dd>{(userProfile?.investment_goals || [])[0] || 'Wealth Creation'}</dd>
                      </div>
                      <div>
                        <dt><Shield size={12} aria-hidden="true" style={{ color: derivedRiskLabel === 'High' ? '#f43f5e' : derivedRiskLabel === 'Low' ? '#22c55e' : '#dfbd69' }} /> Risk Comfort</dt>
                        <dd className="wg-plan-risk" style={{ color: derivedRiskLabel === 'High' ? '#f43f5e' : derivedRiskLabel === 'Low' ? '#22c55e' : '#dfbd69' }}>{derivedRiskLabel}</dd>
                      </div>
                      <div>
                        <dt><Clock size={12} aria-hidden="true" style={{ color: '#a78bfa' }} /> Investment Horizon</dt>
                        <dd>{horizon ? `${horizon} Years` : 'Not specified'}</dd>
                      </div>
                    </dl>
                  </section>

                  <section className="wg-plan-next" aria-labelledby="wg-plan-next-title">
                    <div className="wg-plan-action-deck">
                      <div className="wg-plan-action-badge">
                        <Sparkles size={12} aria-hidden="true" />
                        <span>AI RECOMMENDED ACTION</span>
                      </div>
                      <h2 id="wg-plan-next-title">What Should You Do Next?</h2>
                      <p>Review the verified financial choices selected specifically for your profile.</p>
                      <button type="button" className="wg-plan-primary" data-testid="home-cta-where-to-invest" onClick={() => onNavigate && onNavigate('investments')}>
                        <span>See Where to Invest</span>
                        <span className="wg-plan-primary-icon-wrap"><ChevronRight size={18} aria-hidden="true" /></span>
                      </button>
                      <div className="wg-plan-shortcuts-divider">
                        <span>EXPLORE DESTINATIONS</span>
                      </div>
                      <nav className="wg-plan-shortcuts" aria-label="Plan shortcuts">
                        <button type="button" onClick={() => onNavigate && onNavigate('plan')}><TrendingUp size={13} aria-hidden="true" />Understand My Plan<ChevronRight size={13} aria-hidden="true" /></button>
                        <button type="button" onClick={() => onNavigate && onNavigate('taxes')}><Wallet size={13} aria-hidden="true" />Check Taxes<ChevronRight size={13} aria-hidden="true" /></button>
                        <button type="button" onClick={() => onNavigate && onNavigate('progress')}><Activity size={13} aria-hidden="true" />See Progress<ChevronRight size={13} aria-hidden="true" /></button>
                      </nav>
                    </div>
                  </section>
                </div>

                <section className="wg-plan-profile" aria-labelledby="wg-plan-profile-title">
                  <div className="wg-plan-profile-heading">
                    <div className="wg-plan-profile-avatar"><User size={19} aria-hidden="true" /></div>
                    <div className="wg-plan-profile-meta">
                      <h3 id="wg-plan-profile-title">{userProfile?.name || 'Investor Financial Profile'}</h3>
                      <span className="wg-plan-version">{profileVersion !== undefined ? `Profile v${profileVersion}` : 'Financial Profile'}</span>
                    </div>
                  </div>
                  <dl className="wg-plan-profile-facts">
                    <div><dt>Age</dt><dd>{userProfile?.age ?? 'N/A'}</dd></div>
                    <div><dt>Take-home</dt><dd>{annualTakeHomeLakhs ? `₹${annualTakeHomeLakhs}L/yr` : 'N/A'}</dd></div>
                    <div><dt>Savings</dt><dd>{hasSavings ? formatINR(monthlySavings) : 'N/A'} {savingsRate !== null && <span>({savingsRate}%)</span>}</dd></div>
                    <div><dt>Horizon</dt><dd>{horizon ? `${horizon} Yrs` : 'N/A'}</dd></div>
                    <div><dt>Risk Comfort</dt><dd>{derivedRiskLabel}</dd></div>
                  </dl>
                  <button type="button" className="wg-plan-edit" onClick={() => onNavigate && onNavigate('profile')}><Edit3 size={15} aria-hidden="true" />Edit Profile</button>
                </section>
              </div>
            );
          })()}

          <p className="wg-plan-property-note">Sold-property proceeds are not treated as investable capital; they remain context only.</p>

          {excludedCount > 0 && (
            <div className="wg-plan-eligibility">
              <Info size={16} aria-hidden="true" />
              <p>{isEmergencyFundGoal ? (
                <>Showing <strong>{displayedCount} liquid instruments</strong> for Emergency Fund.{' '}<strong>{excludedCount}</strong> excluded (lock-in / liquidity mismatch).</>
              ) : (
                <><strong>{displayedCount}/{totalConsidered}</strong> instruments shown.{' '}{excludedCount > 0 && <>{excludedCount} excluded by the backend suitability and eligibility checks.</>}</>
              )}</p>
            </div>
          )}

          {riskAgeMismatch.flag && !mismatchDismissed && (
            <div className="wg-plan-suitability">
              <ShieldAlert size={19} aria-hidden="true" />
              <div>
                <h3>{riskAgeMismatch.title}</h3>
                <p>{riskAgeMismatch.message}</p>
                <p className="wg-plan-suitability-detail">{riskAgeMismatch.recommendation}</p>
              </div>
              <button type="button" onClick={() => setMismatchDismissed(true)}>Dismiss</button>
            </div>
          )}


        </section>

        {/* Top Grid (3 columns) */}
        <div className="top-row-grid">

          {/* Panel 1: Portfolio Parameters */}
          <div className="panel-card">
            <div className="panel-header">
               <span className="panel-title">
                 <SlidersHorizontal size={14} aria-hidden="true" style={{ color: '#38bdf8' }} />
                 Adjust Your Settings
               </span>
               <span className="panel-header-badge" title="Parameters locked to Verified Financial Profile">
                 <Shield size={11} aria-hidden="true" />
                 Profile Synced
               </span>
            </div>

            <div className="wg-param-well">
              <div className="param-row">
                <span className="wg-param-label"><Clock size={13} aria-hidden="true" /> Investment Horizon</span>
                <span className="wg-param-value-tag">{horizon ?? 'N/A'} {horizon && <small>Yrs</small>}</span>
              </div>
              <input type="range" min="1" max="30" value={horizon || 1} disabled aria-label="Investment horizon from Financial Profile" title="Edit the Financial Profile to change this value" className="dash-range" style={{'--value': `${horizon ? (horizon/30)*100 : 0}%`, marginBottom: 6}} />
              <div className="risk-scale" style={{ color: '#64748b', fontSize: '0.62rem' }}>
                <span>1 Yr</span>
                <span>15 Yrs</span>
                <span>30 Yrs</span>
              </div>
            </div>

            <div className="wg-param-well">
              <div className="param-row">
                <span className="wg-param-label"><Wallet size={13} aria-hidden="true" /><JargonTooltip term="SIP">Monthly SIP</JargonTooltip></span>
                <span className="wg-param-sip-tag">{formatINR(currentMonthly)}</span>
              </div>
              <div className="wg-param-sip-meta">
                <span className="wg-param-sip-pill">
                  <CheckCircle2 size={11} aria-hidden="true" />
                  Allocated from profile
                </span>
                <span className="wg-param-sip-sublabel">Monthly investment capacity</span>
              </div>
            </div>

            <div className="wg-param-well">
              <div className="param-row">
                <span className="wg-param-label"><Shield size={13} aria-hidden="true" /><JargonTooltip term="Risk Profile">Risk Comfort Level</JargonTooltip></span>
                <span style={{background: derivedRiskLabel === 'High' ? 'rgba(244, 63, 94, 0.14)' : derivedRiskLabel === 'Low' ? 'rgba(34, 197, 94, 0.14)' : 'rgba(245, 158, 11, 0.14)', color: derivedRiskLabel === 'High' ? '#f43f5e' : derivedRiskLabel === 'Low' ? '#22c55e' : '#fbbf24', padding: '3px 10px', borderRadius: 9999, fontWeight: 750, fontSize: '0.72rem', letterSpacing: '0.3px', border: `1px solid ${derivedRiskLabel === 'High' ? 'rgba(244, 63, 94, 0.3)' : derivedRiskLabel === 'Low' ? 'rgba(34, 197, 94, 0.3)' : 'rgba(245, 158, 11, 0.3)'}`, display: 'inline-flex', alignItems: 'center', gap: 5}}>
                  <span style={{width: 5, height: 5, borderRadius: '50%', background: 'currentColor', boxShadow: '0 0 6px currentColor'}} />
                  {derivedRiskLabel}
                </span>
              </div>
              <input type="range" min="1" max="10" value={riskValue || 1} disabled aria-label="Risk tolerance from Financial Profile" title="Edit the Financial Profile to change this value" className="dash-range" style={{'--value': `${riskValue ? ((riskValue - 1) / 9) * 100 : 0}%`, marginTop: 6}} />
              <div className="risk-scale">
                 {[1,2,3,4,5,6,7,8,9,10].map(v => <span key={v} className={v === riskValue ? 'active' : ''}>{v}</span>)}
              </div>
            </div>
          </div>

          {/* Panel 2: Multi-Layered Asset Allocation */}
          <div className="panel-card" style={{ position: 'relative' }}>
            <div className="panel-header" style={{ marginBottom: 8 }}>
               <span className="panel-title">
                 <PieChartIcon size={14} aria-hidden="true" style={{ color: '#38bdf8' }} />
                 <JargonTooltip term="Asset Allocation">Your Investment Mix</JargonTooltip>
               </span>
               <span className="panel-header-badge">
                 {allocationDataOuter.length} Classes
               </span>
            </div>
            <div style={{ height: 200, position: 'relative' }}>
              {isLoading ? (
                 <div className="skeleton-box" style={{ width: '160px', height: '160px', borderRadius: '50%', margin: '20px auto' }} />
              ) : (
                <>
                  <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 1, height: 1 }}>
                    <PieChart>
                      <Pie
                        data={allocationDataOuter}
                        dataKey="value"
                        cx="50%"
                        cy="50%"
                        innerRadius={60}
                        outerRadius={88}
                        stroke="rgba(2, 6, 23, 0.8)"
                        strokeWidth={2}
                        paddingAngle={2}
                        cornerRadius={4}
                      >
                        {allocationDataOuter.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={entry.color} />
                        ))}
                      </Pie>
                      <RechartsTooltip
                        formatter={(val) => [`${formatINR(val)}/mo`, 'Allocation']}
                        contentStyle={{
                          background: 'rgba(15, 23, 42, 0.95)',
                          border: '1px solid rgba(255, 255, 255, 0.1)',
                          borderRadius: 12,
                          backdropFilter: 'blur(16px)',
                          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.6)',
                          fontSize: '0.82rem'
                        }}
                        itemStyle={{color: '#e2e8f0'}}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                  {/* Center projected value */}
                   <div className="wg-donut-center-hub">
                     {(() => {
                       const val = nullableMarketNumber(totalProjected);
                       if (!Number.isFinite(val)) {
                         return (
                           <>
                             <div style={{ fontSize: '1.15rem', fontWeight: 800, color: '#fff' }}>N/A</div>
                             <div style={{ fontSize: '0.52rem', color: '#64748b', letterSpacing: '1.4px', textTransform: 'uppercase', marginTop: 3, fontWeight: 700 }}>SERVER PROJECTION</div>
                           </>
                         );
                       }
                       if (val >= 10000000) {
                         return (
                           <>
                             <div style={{ fontSize: '1.4rem', fontWeight: 850, color: '#fff', letterSpacing: '-0.5px', fontVariantNumeric: 'tabular-nums', textShadow: '0 0 20px rgba(56,189,248,0.25)' }}>₹{(val / 10000000).toFixed(2)}</div>
                             <div style={{ fontSize: '0.55rem', color: '#64748b', letterSpacing: '1.5px', textTransform: 'uppercase', marginTop: 3, fontWeight: 700 }}>CRORES AVG.</div>
                           </>
                         );
                       }
                       return (
                         <>
                           <div style={{ fontSize: '1.4rem', fontWeight: 850, color: '#fff', letterSpacing: '-0.5px', fontVariantNumeric: 'tabular-nums', textShadow: '0 0 20px rgba(56,189,248,0.25)' }}>₹{(val / 100000).toFixed(1)}</div>
                           <div style={{ fontSize: '0.55rem', color: '#64748b', letterSpacing: '2px', textTransform: 'uppercase', marginTop: 3, fontWeight: 700 }}>LAKHS AVG.</div>
                         </>
                       );
                     })()}
                   </div>
                 </>
               )}
            </div>
            {/* Category legend with proportion bars */}
             <div style={{ display: 'flex', flexDirection: 'column', gap: 7, padding: '6px 2px 0', marginTop: 8 }}>
              {(() => {
                const rawPcts = allocationDataOuter.map(item =>
                  currentMonthly > 0 ? (item.value / currentMonthly) * 100 : 0
                );
                const floored = rawPcts.map(p => Math.floor(p));
                let remainder = 100 - floored.reduce((s, f) => s + f, 0);
                const fracs = rawPcts.map((p, i) => ({ i, frac: p - floored[i] }));
                fracs.sort((a, b) => b.frac - a.frac);
                for (let k = 0; k < remainder && k < fracs.length; k++) {
                  floored[fracs[k].i]++;
                }
                return allocationDataOuter.map((item, i) => {
                  const pct = floored[i];
                  return (
                    <div key={i} className="wg-mix-row" title={`${item.name}: ${formatINR(item.value)}/month`}>
                      <span style={{
                        width: 9, height: 9, borderRadius: '50%', background: item.color, flexShrink: 0,
                        boxShadow: `0 0 8px ${item.color}80`
                      }} />
                      <span style={{color: '#e2e8f0', flex: 1, fontSize: '0.78rem', fontWeight: 600}}>{item.name}</span>
                      <div style={{width: 56, height: 5, background: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden', flexShrink: 0}}>
                        <div style={{width: `${pct}%`, height: '100%', background: `linear-gradient(90deg, ${item.color}bb, ${item.color})`, borderRadius: 3, transition: 'width 0.6s cubic-bezier(0.16, 1, 0.3, 1)'}} />
                      </div>
                      <span style={{color: '#f8fafc', fontWeight: 750, fontVariantNumeric: 'tabular-nums', minWidth: 34, textAlign: 'right', fontSize: '0.8rem'}}>{pct}%</span>
                    </div>
                  );
                });
              })()}
             </div>
          </div>

          {/* Panel 3: Wealth Trajectory / Emergency Fund Timeline */}
          <div className="panel-card">
             <div className="panel-header">
               <span className="panel-title">
                 <TrendingUp size={14} aria-hidden="true" style={{ color: '#38bdf8' }} />
                 {(userProfile?.investment_goals || []).includes('Emergency Fund')
                   ? 'Goal Achievement Timeline'
                   : 'Wealth Trajectory'}
               </span>
               <span className="panel-header-badge">
                 <span style={{ width: 12, height: 2.5, background: '#38bdf8', borderRadius: 2, display: 'inline-block' }} />
                 Projected
               </span>
            </div>

            {(() => {
              const isEF = (userProfile?.investment_goals || []).includes('Emergency Fund');

              if (isEF) {
                const projection = recommendationMeta?.dashboard_projection;
                const chartData = Array.isArray(projection?.monthly_timeline) ? projection.monthly_timeline : [];
                const emergencyTarget = nullableMarketNumber(projection?.total_projected);
                const savings = nullableMarketNumber(projection?.monthly_contribution);
                const targetMonthReached = chartData.length > 0 ? chartData[chartData.length - 1].month : null;
                const hasEmergencyProjection = Number.isFinite(emergencyTarget)
                  && Number.isFinite(savings)
                  && Number.isFinite(targetMonthReached);

                return (
                  <>
                    <div style={{ fontSize: '0.7rem', color: '#94a3b8', marginBottom: 6, padding: '5px 10px', background: 'rgba(10,16,30,0.5)', borderRadius: 8, display: 'inline-block', border: '1px solid rgba(255,255,255,0.03)' }}>
                      {hasEmergencyProjection
                        ? `Projected: ₹${(emergencyTarget/100000).toFixed(1)}L · ${targetMonthReached} months @ ${formatINR(savings)}/mo`
                        : 'Emergency-fund projection is waiting for the recommendation service.'}
                    </div>
                    <div style={{ height: 200, fontSize: '0.7rem' }}>
                      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 1, height: 1 }}>
                        <AreaChart data={chartData} margin={{top: 10, right: 30, left: -20, bottom: 0}}>
                          <defs>
                            <linearGradient id="colorEF" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3}/>
                              <stop offset="95%" stopColor="#22c55e" stopOpacity={0}/>
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(255,255,255,0.04)" />
                          <XAxis dataKey="month" tick={{fill: '#94a3b8', fontSize: 11}} axisLine={false} tickLine={false} tickFormatter={(v) => `${v}mo`} />
                          <YAxis tick={{fill: '#94a3b8', fontSize: 11}} axisLine={false} tickLine={false} tickFormatter={(val) => {
                            if (val >= 100000) return `₹${(val/100000).toFixed(1)}L`;
                            return `₹${(val/1000).toFixed(0)}K`;
                          }} />
                          <RechartsTooltip formatter={(val) => `₹${Math.round(val).toLocaleString()}`} contentStyle={{background: 'rgba(15, 23, 42, 0.85)', border: '1px solid rgba(34, 197, 94, 0.3)', borderRadius: 12, backdropFilter: 'blur(16px)', boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)'}} itemStyle={{color: '#f8fafc'}} />
                          {hasEmergencyProjection && <ReferenceLine y={emergencyTarget} stroke="#fbbf24" strokeDasharray="6 4" label={{ value: `Projected ₹${(emergencyTarget/100000).toFixed(1)}L`, fill: '#fbbf24', fontSize: 11, position: 'right' }} />}
                          <Area type="monotone" dataKey="value" stroke="#22c55e" strokeWidth={2} fillOpacity={1} fill="url(#colorEF)" />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>

                    {/* FIX 2: Surplus redirect panel */}
                    <div style={{
                        marginTop: 12, padding: '14px 16px', borderRadius: 12,
                        background: 'rgba(34, 197, 94, 0.06)',
                        border: '1px solid rgba(34, 197, 94, 0.15)',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                          <span style={{ width: 22, height: 22, borderRadius: 6, background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.25)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.65rem', fontWeight: 900, color: '#22c55e' }}>✓</span>
                          <strong style={{ fontSize: '0.85rem', color: '#22c55e' }}>Plan your emergency-fund target</strong>
                        </div>
                        <p style={{ fontSize: '0.8rem', color: '#94a3b8', margin: '0 0 10px 0', lineHeight: 1.5 }}>
                          {hasEmergencyProjection
                            ? `The recommendation service projects ${formatCompactINR(emergencyTarget)} over ${targetMonthReached} months from the saved contribution capacity. Add a dated target in Goal Planner to measure goal completion and surplus.`
                            : 'Generate recommendations from a complete Financial Profile, then add a dated target in Goal Planner to measure goal completion and surplus.'}
                        </p>
                        <div style={{ display: 'flex', gap: 10 }}>
                          <button onClick={() => onNavigate && onNavigate('goal-planner')} style={{
                            background: 'rgba(34, 197, 94, 0.1)', border: '1px solid rgba(34, 197, 94, 0.25)',
                            color: '#22c55e', borderRadius: 8, padding: '6px 14px', fontSize: '0.78rem',
                            cursor: 'pointer', fontWeight: 600
                          }}>Set a dated goal →</button>
                          <button onClick={() => onNavigate && onNavigate('sip-planner')} style={{
                            background: 'rgba(6, 182, 212, 0.1)', border: '1px solid rgba(6, 182, 212, 0.25)',
                            color: '#06b6d4', borderRadius: 8, padding: '6px 14px', fontSize: '0.78rem',
                            cursor: 'pointer', fontWeight: 600
                          }}>Review contribution plan →</button>
                        </div>
                      </div>
                  </>
                );
              }

              // Default: Wealth Trajectory
              return (
                <>
                  <div style={{ height: 260, fontSize: '0.72rem', marginTop: 4 }}>
                    {isLoading ? (
                       <div style={{ display: 'flex', gap: 10, height: '100%', alignItems: 'flex-end', paddingBottom: 20 }}>
                          <div className="skeleton-box" style={{ width: '25%', height: '30%' }} />
                          <div className="skeleton-box" style={{ width: '25%', height: '50%' }} />
                          <div className="skeleton-box" style={{ width: '25%', height: '70%' }} />
                          <div className="skeleton-box" style={{ width: '25%', height: '100%' }} />
                       </div>
                    ) : (
                      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 1, height: 1 }}>
                        <AreaChart data={performanceData} margin={{top: 10, right: 16, left: -10, bottom: 0}}>
                          <defs>
                            <linearGradient id="colorAvg" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.35}/>
                              <stop offset="70%" stopColor="#38bdf8" stopOpacity={0.05}/>
                              <stop offset="100%" stopColor="#38bdf8" stopOpacity={0.0}/>
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(255,255,255,0.04)" />
                          <XAxis
                            dataKey="year"
                            tick={{fill: '#94a3b8', fontSize: 11, fontWeight: 500}}
                            axisLine={false}
                            tickLine={false}
                            interval="preserveStartEnd"
                            minTickGap={28}
                            tickFormatter={(val) => `${val} yrs`}
                          />
                          <YAxis
                            tick={{fill: '#94a3b8', fontSize: 11, fontWeight: 500}}
                            axisLine={false}
                            tickLine={false}
                            tickFormatter={(val) => {
                              if (val >= 10000000) return `\u20b9${(val/10000000).toFixed(1)}Cr`;
                              if (val >= 100000) return `\u20b9${(val/100000).toFixed(1)}L`;
                              return `\u20b9${(val/1000).toFixed(0)}K`;
                            }}
                          />
                          <RechartsTooltip
                            formatter={(val) => `\u20b9${Math.round(val).toLocaleString()}`}
                            contentStyle={{
                              background: 'rgba(15, 23, 42, 0.94)',
                              border: '1px solid rgba(56, 189, 248, 0.25)',
                              borderRadius: 12,
                              backdropFilter: 'blur(16px)',
                              boxShadow: '0 8px 32px rgba(0, 0, 0, 0.55)',
                              fontSize: '0.78rem'
                            }}
                            itemStyle={{color: '#f8fafc'}}
                          />
                          <Area
                            type="monotone"
                            dataKey="average"
                            stroke="#38bdf8"
                            strokeWidth={2.5}
                            fillOpacity={1}
                            fill="url(#colorAvg)"
                            dot={false}
                            activeDot={{r: 4.5, fill: '#38bdf8', stroke: '#0f172a', strokeWidth: 2}}
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    )}
                  </div>
                  {/* Projected endpoint summary */}
                  {!isLoading && performanceData.length > 0 && (() => {
                    const last = performanceData[performanceData.length - 1];
                    const fmt = (v) => v >= 10000000 ? `\u20b9${(v/10000000).toFixed(2)}Cr` : `\u20b9${(v/100000).toFixed(1)}L`;
                    return (
                      <div className="wg-trajectory-endpoint-card">
                        <div className="wg-trajectory-endpoint-label">
                          <div className="wg-trajectory-endpoint-title">
                            <Sparkles size={12} aria-hidden="true" />
                            Projected Total Value
                          </div>
                          <span className="wg-trajectory-endpoint-sub">At {horizon ?? 10}-yr horizon · Pre-tax assumption</span>
                        </div>
                        <div className="wg-trajectory-endpoint-value">{fmt(last.average)}</div>
                      </div>
                    );
                  })()}
                </>
              );
            })()}
          </div>

        </div>

        {/* Section divider */}
        <div style={{height: 1, margin: '12px 0', background: 'linear-gradient(90deg, transparent 5%, rgba(56,189,248,0.1) 30%, rgba(139,92,246,0.08) 70%, transparent 95%)'}} />

        {/* Full-width Verified Portfolio Table */}
        <div className="panel-card wg-portfolio-card" style={{ padding: 0, overflow: 'hidden', width: '100%', marginBottom: 16 }}>
            <div className="panel-header wg-portfolio-header">
               <div className="wg-table-header-title">
                 <span className="wg-table-check-badge">
                   <CheckCircle2 size={13} aria-hidden="true" />
                 </span>
                 <span className="wg-table-title-text">VERIFIED PORTFOLIO</span>
                 <span className="wg-table-count-badge">
                   {tableData.reduce((acc, g) => acc + (g.children || []).length, 0)} instruments
                 </span>
               </div>
               <div className="wg-table-controls">
                 <div className="wg-select-wrap">
                   <Filter size={11} aria-hidden="true" className="wg-select-icon" />
                   <select value={filterType} onChange={e => setFilterType(e.target.value)} className="wg-table-select">
                     <option value="all">All Categories</option>
                     <option value="equity">Equity Only</option>
                     <option value="government">Government</option>
                     <option value="has-tax-benefit">Verified Tax Class</option>
                     <option value="low-risk-only">Low Risk</option>
                   </select>
                   <ChevronDown size={11} aria-hidden="true" className="wg-select-caret" />
                 </div>
                 <div className="wg-select-wrap">
                   <SlidersHorizontal size={11} aria-hidden="true" className="wg-select-icon" />
                   <select value={sortField} onChange={e => setSortField(e.target.value)} className="wg-table-select">
                     <option value="">Sort by…</option>
                     <option value="weight_desc">Weight ↓</option>
                     <option value="return_desc">Model Assumption ↓</option>
                     <option value="risk_asc">Risk ↑</option>
                     <option value="projection_desc">Projection ↓</option>
                     <option value="sip_asc">SIP ↑</option>
                   </select>
                   <ChevronDown size={11} aria-hidden="true" className="wg-select-caret" />
                 </div>
               </div>
            </div>

            {/* Responsive scrollable wrapper */}
            <div className="portfolio-table-wrapper" style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
              <table className="dense-table">
                <thead>
                  <tr>
                    <th style={{ width: '29%', paddingLeft: 20, whiteSpace: 'nowrap' }}>Security Name</th>
                    <th style={{ width: '10%', whiteSpace: 'nowrap' }}>Match</th>
                    <th className="col-weight" style={{ width: '10%', whiteSpace: 'nowrap' }}>Weight %</th>
                    <th className="col-exp-return" style={{ width: '11%', whiteSpace: 'nowrap' }}>Model Assumption</th>
                    <th className="col-risk-level" style={{ width: '10%', whiteSpace: 'nowrap' }}>Risk Level</th>
                    <th style={{ width: '9%', whiteSpace: 'nowrap' }}>Tax Class</th>
                    <th style={{ width: '10%', whiteSpace: 'nowrap' }}>Monthly SIP</th>
                    <th style={{ width: '11%', paddingRight: 20, textAlign: 'right', whiteSpace: 'nowrap' }}>Projected ({horizon ? `${horizon} Yrs` : 'N/A'})</th>
                  </tr>
                </thead>
                <tbody>
                  {isLoading ? (
                    /* Enhanced skeleton loader */
                    Array(8).fill(0).map((_, i) => (
                      <tr key={i}>
                        <td colSpan="8" style={{ padding: '12px' }}>
                          <div style={{ display: 'flex', gap: 16 }}>
                            <div className="skeleton-box" style={{ height: 16, flex: 2 }} />
                            <div className="skeleton-box" style={{ height: 16, flex: 1 }} />
                            <div className="skeleton-box" style={{ height: 16, flex: 1 }} />
                            <div className="skeleton-box" style={{ height: 16, flex: 1 }} />
                            <div className="skeleton-box" style={{ height: 16, flex: 1 }} />
                            <div className="skeleton-box" style={{ height: 16, flex: 1 }} />
                            <div className="skeleton-box" style={{ height: 16, flex: 1 }} />
                          </div>
                        </td>
                      </tr>
                    ))
                  ) : tableData.length === 0 ? (
                    <tr>
                       <td colSpan="8" style={{textAlign:'center', padding: 48}}>
                         <Info size={48} color="#94a3b8" style={{opacity: 0.5, margin: '0 auto 16px auto', display: 'block'}} />
                         <div style={{fontSize: '1rem', color: '#94a3b8'}}>No personalized recommendation is being shown because no authoritative backend result is available.</div>
                       </td>
                    </tr>
                  ) : (
                   tableData
                     .filter(group => {
                       if (filterType === 'all') return true;
                       if (filterType === 'equity') return group.class.toLowerCase().includes('equity');
                       if (filterType === 'government') return group.class.toLowerCase().includes('government');
                       if (filterType === 'has-tax-benefit') return group.hasTax;
                       if (filterType === 'low-risk-only') return group.children.every(c => ['very low','low'].includes(c.risk?.toLowerCase()));
                       return true;
                     })
                     .map((group) => {
                       const sortedChildren = [...group.children].sort((a, b) => {
                         const riskOrder = { 'Very Low': 0, 'Low': 1, 'Medium': 2, 'High': 3, 'Very High': 4 };
                         switch (sortField) {
                           case 'weight_desc': return b.weight - a.weight;
                           case 'return_desc': return parseFloat(b.ret) - parseFloat(a.ret);
                           case 'risk_asc': return (riskOrder[a.risk] || 2) - (riskOrder[b.risk] || 2);
                           case 'projection_desc': return (b.proj ?? -Infinity) - (a.proj ?? -Infinity);
                           case 'sip_asc': return a.alloc - b.alloc;
                           default: return 0;
                         }
                       });
                       const catColor = getCategoryColor(group.class);
                       const catAllocTotal = (group.children || []).reduce((s, c) => s + (c.alloc || 0), 0);
                       const catWeightTotal = (group.children || []).reduce((s, c) => s + (Number(c.weight) || 0), 0);
                       return (
                    <React.Fragment key={group.id}>
                      <tr className="wg-cat-row">
                        <td colSpan="8" style={{ padding: 0, border: 'none' }}>
                          <div
                            className={`wg-cat-bar ${isGroupExpanded(group.id) ? 'expanded' : ''}`}
                            style={{ '--cat-tint': catColor }}
                            onClick={() => toggleRow(group.id)}
                          >
                            <div className="wg-cat-bar-left">
                              <span className="wg-cat-toggle-chevron">
                                {isGroupExpanded(group.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                              </span>
                              <span className="wg-cat-beacon" style={{ background: catColor, boxShadow: `0 0 10px ${catColor}99` }} />
                              <span className="wg-cat-title" style={{ color: isGroupExpanded(group.id) ? '#f8fafc' : '#e2e8f0' }}>{group.class}</span>
                              <span className="wg-cat-count-badge">{(group.children || []).length} instruments</span>
                              {group.hasTax && (
                                <span className="tax-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 4 }}>
                                  <Shield size={9} aria-hidden="true" /> Verified Tax Class
                                </span>
                              )}
                            </div>
                            <div className="wg-cat-bar-right">
                              <span className="wg-cat-alloc-value">{formatINR(catAllocTotal)}/mo</span>
                              {catWeightTotal > 0 && (
                                <span className="wg-cat-weight-tag">{catWeightTotal.toFixed(0)}% mix</span>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                      {isGroupExpanded(group.id) && sortedChildren.map((child, idx) => {
                        const isUnfunded = child.weight < 0.1 || child.alloc === 0;
                        const subtitle = getInstrumentSubtitle(child.assetClass || child.category);
                        return (
                          <tr key={`${group.id}-${idx}`} data-testid={`recommendation-row-${child.instId}`} style={{ opacity: isUnfunded ? 0.6 : 1 }}>
                            <td style={{ paddingLeft: 20 }}>
                              {(() => {
                                const typeBadge = getInstrumentTypeBadge(child.type);
                                return (
                                  <div className="wg-inst-cell">
                                    <span
                                      className="wg-inst-badge"
                                      style={{ color: typeBadge.color, background: typeBadge.bg, borderColor: typeBadge.border }}
                                      title={typeBadge.label}
                                    >
                                      {typeBadge.label}
                                    </span>
                                    <div className="wg-inst-name-col">
                                      <div className="wg-inst-name-row">
                                        <span className="wg-inst-name-text">{child.fullName || child.name}</span>
                                        <RecommendationSourceBadge source={child.source} />
                                        {INSTRUMENT_EXPLAINERS[child.instId] && (
                                          <span
                                            onClick={(e) => { e.stopPropagation(); setActiveTooltip(activeTooltip === `tbl-${child.instId}` ? null : `tbl-${child.instId}`); }}
                                            className="wg-inst-help-btn"
                                            title="Explain instrument"
                                          >
                                            <HelpCircle size={11} color="#38bdf8" />
                                          </span>
                                        )}
                                      </div>
                                      {subtitle && <span className="wg-inst-subtitle">{subtitle}</span>}
                                      {activeTooltip === `tbl-${child.instId}` && INSTRUMENT_EXPLAINERS[child.instId] && (
                                        <div style={{background: 'rgba(10,16,30,0.95)', border: '1px solid rgba(56,189,248,0.15)', borderRadius: 8, padding: '8px 10px', marginTop: 4, fontSize: '0.68rem', lineHeight: 1.5, maxWidth: 320, boxShadow: '0 8px 24px rgba(0,0,0,0.5)'}}>
                                          <div style={{color: '#38bdf8', fontWeight: 600, marginBottom: 3}}>What is this?</div>
                                          <div style={{color: '#94a3b8'}}>{INSTRUMENT_EXPLAINERS[child.instId].what}</div>
                                          {INSTRUMENT_EXPLAINERS[child.instId].who_for && <div style={{color: '#cbd5e1', marginTop: 3, fontSize: '0.65rem'}}><b>Best for:</b> {INSTRUMENT_EXPLAINERS[child.instId].who_for}</div>}
                                        </div>
                                      )}
                                      {(() => { const lw = getLockInWarning({id: child.instId}, horizon); return lw ? <div className="wg-inst-lockin-warning">&#x23f0; {lw}</div> : null; })()}
                                    </div>
                                  </div>
                                );
                              })()}
                            </td>
                            <td>
                              {(() => {
                                const recObj = (recommendations || []).find(r => r.id === child.instId);
                                const score = recObj ? computeSuitabilityMatch(recObj, userProfile) : null;
                                if (score === null) return <span style={{color:'#475569', fontSize:'0.72rem'}}>—</span>;
                                const scoreColor = score >= 85 ? '#10b981' : score >= 70 ? '#38bdf8' : score >= 55 ? '#f59e0b' : '#94a3b8';
                                const scoreBg = score >= 85 ? 'rgba(16, 185, 129, 0.12)' : score >= 70 ? 'rgba(56, 189, 248, 0.12)' : score >= 55 ? 'rgba(245, 158, 11, 0.12)' : 'rgba(148, 163, 184, 0.1)';
                                const scoreBorder = score >= 85 ? 'rgba(16, 185, 129, 0.28)' : score >= 70 ? 'rgba(56, 189, 248, 0.28)' : score >= 55 ? 'rgba(245, 158, 11, 0.28)' : 'rgba(148, 163, 184, 0.2)';
                                const scoreFmt = score >= 99.5 ? '100%' : (score % 1 === 0 ? `${score}%` : `${score.toFixed(1)}%`);
                                return (
                                  <span className="wg-match-pill" style={{ color: scoreColor, background: scoreBg, borderColor: scoreBorder }}>
                                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: scoreColor, flexShrink: 0, boxShadow: `0 0 6px ${scoreColor}` }} />
                                    {scoreFmt} Match
                                  </span>
                                );
                              })()}
                            </td>
                            <td className="col-weight" style={{ color: '#94a3b8' }}>
                              {isUnfunded
                                ? <span style={{display: 'inline-block', whiteSpace: 'nowrap', color: '#f59e0b', fontSize: '0.72rem', background: 'rgba(245, 158, 11, 0.1)', border: '1px solid rgba(245, 158, 11, 0.25)', padding: '2px 8px', borderRadius: 6, lineHeight: 1.2}}>Not Funded</span>
                                : (
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                                    <span style={{ color: '#f8fafc', fontWeight: 750, fontVariantNumeric: 'tabular-nums', fontSize: '0.84rem' }}>{Number.isFinite(child.weight) ? `${child.weight.toFixed(1)}%` : 'Unavailable'}</span>
                                    {Number.isFinite(child.weight) && child.weight > 0 && (
                                      <div className="wg-weight-track">
                                        <div className="wg-weight-fill" style={{ width: `${Math.min(100, (child.weight / 25) * 100)}%`, background: catColor, boxShadow: `0 0 6px ${catColor}88` }} />
                                      </div>
                                    )}
                                  </div>
                                )
                              }
                            </td>
                            <td className="col-exp-return">
                              <span className="wg-return-tag">{child.ret}</span>
                            </td>
                            <td className="col-risk-level">
                              {(() => {
                                const r = (child.risk || '').toLowerCase();
                                const isLow = r.includes('low');
                                const isHigh = r.includes('high');
                                const styles = isLow
                                  ? { bg: 'rgba(16, 185, 129, 0.1)', color: '#34d399', border: 'rgba(16, 185, 129, 0.25)' }
                                  : isHigh
                                    ? { bg: 'rgba(244, 63, 94, 0.1)', color: '#fb7185', border: 'rgba(244, 63, 94, 0.25)' }
                                    : { bg: 'rgba(251, 191, 36, 0.1)', color: '#fbbf24', border: 'rgba(251, 191, 36, 0.25)' };
                                return (
                                  <span className="wg-risk-pill" style={{
                                    background: styles.bg, color: styles.color, borderColor: styles.border
                                  }}>
                                    <span style={{ width: 4, height: 4, borderRadius: '50%', background: styles.color, flexShrink: 0 }} />
                                    {child.risk}
                                  </span>
                                );
                              })()}
                            </td>
                            <td>
                               {child.taxBadge ? (
                                 <span className="tax-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                   <Shield size={9} aria-hidden="true" />
                                   {child.taxLabel || 'Verified'}
                                 </span>
                               ) : (
                                 <span className="wg-tax-default">—</span>
                               )}
                            </td>
                            <td className="col-sip">
                              <span className="wg-sip-val">{formatINR(child.alloc)}</span>
                            </td>
                            <td className="col-proj" style={{ paddingRight: 20, textAlign: 'right' }}>
                              <span className="wg-proj-val">
                                {Number.isFinite(child.proj) ? formatCompactINR(child.proj) : '—'}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </React.Fragment>
                  );}))
                  }
                </tbody>
              </table>
            </div>
          </div>

        {/* Executive Overview Deck at Bottom */}
        <div className="wg-bottom-deck-grid">

          {/* Quick Stats Bento Card */}
          <div className="panel-card wg-quick-stats-card">
            <div className="wg-stats-hero-row">
              {(() => {
                const isEF = (userProfile?.investment_goals || []).includes('Emergency Fund');
                const projection = recommendationMeta?.dashboard_projection;
                const projectedValue = nullableMarketNumber(projection?.total_projected);
                const projectedMonth = Array.isArray(projection?.monthly_timeline) && projection.monthly_timeline.length > 0
                  ? projection.monthly_timeline[projection.monthly_timeline.length - 1].month
                  : null;
                if (isEF) {
                  return (
                    <>
                      <div>
                        <div className="wg-stats-hero-label">Projected Fund</div>
                        <div className="wg-stats-hero-value">{Number.isFinite(projectedValue) ? formatCompactINR(projectedValue) : 'N/A'}</div>
                        <div className="wg-stats-hero-sub">{projectedMonth !== null ? `Month ${projectedMonth}` : 'Awaiting projection'}</div>
                      </div>
                      <div style={{textAlign: 'right'}}>
                        <div className="wg-stats-hero-label">{horizon ? `${horizon}-Year Total` : 'Horizon Total'}</div>
                        <div style={{fontSize: '1.25rem', fontWeight: 800, color: '#e2e8f0', letterSpacing: '-0.3px', fontVariantNumeric: 'tabular-nums'}}>{Number.isFinite(projectedValue) ? formatCompactINR(projectedValue) : 'N/A'}</div>
                        <div className="wg-stats-hero-sub">simulated from model assumptions</div>
                      </div>
                    </>
                  );
                }
                const wealthMultiplier = nullableMarketNumber(projection?.wealth_multiple);
                return (
                  <>
                    <div>
                      <div className="wg-stats-hero-label">Projected Value</div>
                      <div className="wg-stats-hero-value">
                        {Number.isFinite(projectedValue) ? formatCompactINR(projectedValue) : 'N/A'}
                      </div>
                    </div>
                    <div style={{textAlign: 'right'}}>
                      <div className="wg-stats-hero-label">Wealth Multiple</div>
                      <div className="wg-stats-hero-multiple">{Number.isFinite(wealthMultiplier) ? `${wealthMultiplier.toFixed(2)}x` : 'N/A'}</div>
                      <div className="wg-stats-hero-sub">on invested capital</div>
                    </div>
                  </>
                );
              })()}
            </div>

            <div className="wg-bento-stats-grid">
              <div className="wg-bento-stat-cell">
                <div className="wg-bento-stat-header">
                  <Wallet size={11} aria-hidden="true" style={{ color: '#34d399' }} />
                  <span>Monthly SIP</span>
                </div>
                <strong className="stat-green">{formatINR(currentMonthly)}</strong>
              </div>
              <div className="wg-bento-stat-cell" style={{textAlign: 'right'}}>
                <div className="wg-bento-stat-header" style={{ justifyContent: 'flex-end' }}>
                  <Clock size={11} aria-hidden="true" style={{ color: '#38bdf8' }} />
                  <span>Horizon</span>
                </div>
                <strong>{horizon ? `${horizon} Yrs` : 'N/A'}</strong>
              </div>
              <div className="wg-bento-stat-cell">
                <div className="wg-bento-stat-header">
                  <PieChartIcon size={11} aria-hidden="true" style={{ color: '#a78bfa' }} />
                  <span>Diversification</span>
                </div>
                <strong>{allocationDataOuter.length} {allocationDataOuter.length === 1 ? 'Category' : 'Categories'}</strong>
              </div>
              <div className="wg-bento-stat-cell" style={{textAlign: 'right'}}>
                <div className="wg-bento-stat-header" style={{ justifyContent: 'flex-end' }}>
                  <Shield size={11} aria-hidden="true" style={{ color: (userProfile?.risk_tolerance || '').includes('Aggressive') ? '#fb7185' : '#fbbf24' }} />
                  <span>Risk Bias</span>
                </div>
                <strong style={{color: (userProfile?.risk_tolerance || '').includes('Aggressive') ? '#fb7185' : (userProfile?.risk_tolerance || '').includes('Conservative') ? '#34d399' : '#dfbd69'}}>
                  {recommendationMeta?.final_risk_tier || 'N/A'}
                </strong>
              </div>
            </div>
          </div>

          {/* Portfolio Insights Card */}
          <div className="panel-card wg-insights-card">
            <div className="wg-insights-header">
              <span className="panel-title" style={{ fontSize: '0.66rem', margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Sparkles size={12} aria-hidden="true" style={{ color: '#38bdf8' }} />
                Portfolio Insights
              </span>
              <span className="wg-insights-badge">Live Context</span>
            </div>
            {(() => {
              const recs = recommendations || [];
              const returnAssumption = nullableMarketNumber(recommendationMeta?.portfolio_return_assumption);
              const avgReturn = Number.isFinite(returnAssumption) ? returnAssumption.toFixed(1) : null;
              const assetAllocations = Object.entries(recommendationMeta?.asset_class_allocation || {})
                .sort((a, b) => b[1] - a[1]);
              const primaryAsset = assetAllocations[0] || null;
              const secondaryAsset = assetAllocations[1] || null;
              return (
                <div className="wg-insights-body">
                  <div className="wg-insight-row">
                    <span className="wg-insight-label">Portfolio Nominal Assumption</span>
                    <span className="wg-insight-val green">{avgReturn !== null ? `${avgReturn}%` : 'N/A'}</span>
                  </div>
                  <div className="wg-insight-row">
                    <span className="wg-insight-label">Return Basis</span>
                    <span className="wg-insight-val cyan">{recommendationMeta?.return_basis === 'PRE_TAX_NOMINAL' ? 'Pre-tax nominal' : 'N/A'}</span>
                  </div>
                  <div className="wg-insight-row">
                    <span className="wg-insight-label">Top Asset Classes</span>
                    <span className="wg-insight-val text-primary">
                      {primaryAsset ? `${primaryAsset[0]} ${primaryAsset[1].toFixed(0)}%` : 'N/A'}
                      {secondaryAsset ? ` / ${secondaryAsset[0]} ${secondaryAsset[1].toFixed(0)}%` : ''}
                    </span>
                  </div>
                  <div className="wg-insight-row">
                    <span className="wg-insight-label">Instruments</span>
                    <span className="wg-insight-val amber">{recs.length} active</span>
                  </div>

                  {/* Status commentary callout */}
                  <div className="wg-insight-callout">
                    <Shield size={13} aria-hidden="true" style={{ color: '#38bdf8', flexShrink: 0, marginTop: 2 }} />
                    <div className="wg-insight-callout-text">
                      {recommendationMeta?.reconciliation_note || 'Suitability commentary will appear after the backend recommendation is generated.'}
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>

        </div>

        {/* Action Buttons Toolbar */}
        <div className="buttons-stack wg-portfolio-actions-bar">
          <button className="btn-portal btn-portal-primary" onClick={onRebalance}>
            <Zap size={15} aria-hidden="true" />
            <span>Rebalance Portfolio</span>
          </button>
          <button className="btn-portal btn-portal-secondary" onClick={onExploreAll}>
            <BarChart3 size={15} aria-hidden="true" />
            <span>Compare Scenarios</span>
          </button>
          <button className="btn-portal btn-portal-secondary" onClick={() => window.print()}>
            <TrendingUp size={14} aria-hidden="true" />
            <span>Export PDF Report</span>
          </button>
        </div>

        {/* Section divider */}
        <div style={{height: 1, margin: '16px 0', background: 'linear-gradient(90deg, transparent, rgba(245,158,11,0.12), rgba(56,189,248,0.08), rgba(139,92,246,0.06), transparent)'}} />

        {/* ═══════════════════════════════════════════════════════════
            SECTION 8: RANKED RECOMMENDATION CARDS WITH "Why recommended?"
            ═══════════════════════════════════════════════════════════ */}
        {recommendations && recommendations.length > 0 && (
          <div style={{ marginTop: 28 }}>
            <div style={{display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18}}>
              <div style={{
                width: 36, height: 36, borderRadius: 12,
                background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.15), rgba(223, 189, 105, 0.08))',
                border: '1px solid rgba(245, 158, 11, 0.2)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 4px 16px rgba(245, 158, 11, 0.1)'
              }}>
                <Trophy size={18} color="#f59e0b" />
              </div>
              <div style={{flex: 1}}>
                <h2 style={{
                  fontSize: '1.15rem', fontWeight: 800, margin: 0, letterSpacing: '-0.4px',
                  background: 'linear-gradient(135deg, #e2e8f0, #94a3b8)',
                  WebkitBackgroundClip: 'text', backgroundClip: 'text', WebkitTextFillColor: 'transparent'
                }}>Your Ranked Recommendations</h2>
                <span style={{fontSize: '0.65rem', color: '#546178', fontWeight: 400}}>Personalised for your goals & risk profile</span>
              </div>
              <div style={{
                background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.15)',
                borderRadius: 20, padding: '4px 12px', fontSize: '0.68rem', color: '#dfbd69', fontWeight: 600,
                fontVariantNumeric: 'tabular-nums'
              }}>{recommendations.length} instruments</div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(310px, 1fr))', gap: 20 }}>
              {recommendations.map((rec, idx) => {
                const whyReasons = getWhy(rec, userProfile);
                const isExpanded = expandedWhyCards[rec.id];
                const cardAccent = rec.color || '#06b6d4';
                const podiumClass = idx === 0 ? 'rec-card--rank-1' : idx === 1 ? 'rec-card--rank-2' : idx === 2 ? 'rec-card--rank-3' : '';
                return (
                  <div
                    key={rec.id}
                    id={`rec-card-${rec.id}`}
                    className={`rec-card ${podiumClass}`}
                    style={{
                      background: 'linear-gradient(165deg, rgba(18, 27, 46, 0.85) 0%, rgba(8, 13, 28, 0.98) 100%)',
                      backdropFilter: 'blur(40px) saturate(160%)',
                      border: `1px solid ${cardAccent}22`,
                      borderTop: `2px solid ${cardAccent}38`,
                      borderRadius: 22,
                      padding: '20px 22px 18px',
                      position: 'relative',
                      overflow: 'hidden',
                      boxShadow: '0 14px 44px rgba(0,0,0,0.38), inset 0 1px 0 rgba(255,255,255,0.06)',
                      display: 'flex',
                      flexDirection: 'column'
                    }}
                  >
                    {/* Top ambient radial glow */}
                    <div style={{
                      position: 'absolute', top: -50, right: -50,
                      width: idx === 0 ? 170 : 120, height: idx === 0 ? 170 : 120,
                      background: `radial-gradient(circle, ${cardAccent}${idx === 0 ? '16' : '0a'}, transparent 70%)`,
                      pointerEvents: 'none'
                    }} />

                    {/* Header main: Avatar + Name/Subtitle on Left, Podium Badge on Right */}
                    {(() => {
                      const instIconData = getInstrumentIconData(rec.assetClass || rec.category);
                      const InstIcon = instIconData.Icon;
                      return (
                        <div className="wg-card-header-main">
                          <div className="wg-card-identity-group">
                            <div
                              className="wg-card-avatar"
                              style={{
                                background: instIconData.bg,
                                borderColor: instIconData.border,
                                color: instIconData.color,
                                boxShadow: `0 4px 16px ${instIconData.color}25`
                              }}
                            >
                              <InstIcon size={20} />
                            </div>
                            <div className="wg-card-name-block">
                              <div className="wg-card-title-row-inner">
                                <h3 className="wg-card-title">{rec.abbr || rec.name}</h3>
                                {INSTRUMENT_EXPLAINERS[rec.id] && (
                                  <button
                                    type="button"
                                    className="wg-card-help-btn"
                                    aria-label={`What is ${rec.abbr || rec.name}?`}
                                    onClick={(e) => { e.stopPropagation(); setActiveTooltip(activeTooltip === rec.id ? null : rec.id); }}
                                  >
                                    <HelpCircle size={12} color="#38bdf8" />
                                  </button>
                                )}
                              </div>
                              <div className="wg-card-subtitle">
                                {getInstrumentSubtitle(rec.assetClass || rec.category) || rec.name}
                              </div>
                            </div>
                          </div>

                          {/* Rank badge */}
                          <div className={`wg-rank-badge ${idx === 0 ? 'wg-rank-badge--1' : idx === 1 ? 'wg-rank-badge--2' : idx === 2 ? 'wg-rank-badge--3' : 'wg-rank-badge--default'}`}>
                            {idx === 0 && <Trophy size={11} style={{ flexShrink: 0 }} />}
                            {(idx === 1 || idx === 2) && <Star size={11} style={{ flexShrink: 0 }} />}
                            <span>#{idx + 1}</span>
                          </div>
                        </div>
                      );
                    })()}

                    {/* Meta & Suitability Row: Asset Type + Match Score on Left, Monthly SIP on Right */}
                    <div className="wg-card-meta-row">
                      <div className="wg-card-meta-left">
                        {/* Type badge */}
                        {(() => {
                          const typeBadge = getInstrumentTypeBadge(rec.type);
                          return (
                            <span
                              className="wg-card-type-pill"
                              style={{
                                color: typeBadge.color,
                                background: typeBadge.bg,
                                borderColor: typeBadge.border
                              }}
                            >
                              {typeBadge.label}
                            </span>
                          );
                        })()}

                        {/* Suitability match badge */}
                        {(() => {
                          const score = computeSuitabilityMatch(rec, userProfile);
                          const scoreColor = score >= 90 ? '#10b981' : score >= 75 ? '#38bdf8' : score >= 60 ? '#f59e0b' : '#94a3b8';
                          const scoreBg = score >= 90 ? 'rgba(16, 185, 129, 0.12)' : score >= 75 ? 'rgba(56, 189, 248, 0.12)' : score >= 60 ? 'rgba(245, 158, 11, 0.12)' : 'rgba(148, 163, 184, 0.1)';
                          const scoreBorder = score >= 90 ? 'rgba(16, 185, 129, 0.28)' : score >= 75 ? 'rgba(56, 189, 248, 0.28)' : score >= 60 ? 'rgba(245, 158, 11, 0.28)' : 'rgba(148, 163, 184, 0.2)';
                          const formattedScore = score % 1 === 0 ? `${score}%` : `${score.toFixed(1)}%`;
                          return (
                            <span
                              className="wg-card-match-tag"
                              style={{
                                color: scoreColor,
                                background: scoreBg,
                                borderColor: scoreBorder,
                                boxShadow: `0 2px 10px ${scoreColor}18`
                              }}
                            >
                              <span className="wg-card-beacon-dot" style={{ background: scoreColor }} />
                              {formattedScore} Match
                            </span>
                          );
                        })()}

                        <RecommendationSourceBadge source={rec._source} />
                      </div>

                      {rec.monthly_allocation > 0 && (
                        <div className="wg-card-alloc-chip">
                          <span className="wg-alloc-chip-label">SIP</span>
                          <span>{formatINR(rec.monthly_allocation)}</span>
                        </div>
                      )}
                    </div>

                    {/* Beginner tooltip */}
                    {activeTooltip === rec.id && INSTRUMENT_EXPLAINERS[rec.id] && (
                      <div style={{
                        background: 'rgba(10, 16, 30, 0.96)', border: '1px solid rgba(56,189,248,0.22)',
                        borderRadius: 12, padding: '12px 14px', marginBottom: 12, fontSize: '0.73rem', lineHeight: 1.6,
                        boxShadow: '0 12px 36px rgba(0,0,0,0.6)', backdropFilter: 'blur(20px)', position: 'relative', zIndex: 10
                      }}>
                        <div style={{fontWeight: 750, color: '#38bdf8', marginBottom: 6, fontSize: '0.76rem', display: 'flex', alignItems: 'center', gap: 6}}>
                          <Sparkles size={12} color="#38bdf8" />
                          What is {rec.abbr || rec.name}?
                        </div>
                        <div style={{color: '#cbd5e1', marginBottom: 8}}>{INSTRUMENT_EXPLAINERS[rec.id].what}</div>
                        <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8}}>
                          <div style={{ background: 'rgba(255,255,255,0.03)', padding: '6px 8px', borderRadius: 6 }}>
                            <span style={{color: '#64748b', fontSize: '0.62rem', textTransform: 'uppercase', fontWeight: 700}}>Risk:</span><br/>
                            <span style={{color: '#94a3b8', fontWeight: 600}}>{INSTRUMENT_EXPLAINERS[rec.id].risk_plain}</span>
                          </div>
                          <div style={{ background: 'rgba(255,255,255,0.03)', padding: '6px 8px', borderRadius: 6 }}>
                            <span style={{color: '#64748b', fontSize: '0.62rem', textTransform: 'uppercase', fontWeight: 700}}>Lock-in:</span><br/>
                            <span style={{color: '#94a3b8', fontWeight: 600}}>{INSTRUMENT_EXPLAINERS[rec.id].lock_in_plain}</span>
                          </div>
                        </div>
                        {INSTRUMENT_EXPLAINERS[rec.id].who_for && (
                          <div style={{color: '#94a3b8', fontSize: '0.70rem', marginBottom: 4}}>
                            <strong style={{color: '#e2e8f0'}}>Best for:</strong> {INSTRUMENT_EXPLAINERS[rec.id].who_for}
                          </div>
                        )}
                        {INSTRUMENT_EXPLAINERS[rec.id].example && (
                          <div style={{color: '#34d399', marginTop: 4, fontSize: '0.70rem', fontWeight: 500}}>
                            💡 {INSTRUMENT_EXPLAINERS[rec.id].example}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Bento 4-Cell Stats Grid */}
                    <div className="wg-card-stats-grid">
                      {/* 1. Model Return Assumption */}
                      <div className="stat-box wg-stat-box-modern">
                        <div className="wg-stat-box-header">
                          <div className="wg-stat-icon-badge wg-stat-icon-badge--return">
                            <TrendingUp size={11} color="#34d399" />
                          </div>
                          <span>Model Return</span>
                        </div>
                        <div className="wg-stat-box-val val-green">
                          {nullableMarketNumber(rec.nominalReturn) !== null ? `${nullableMarketNumber(rec.nominalReturn).toFixed(1)}%` : 'N/A'}
                        </div>
                        <div className="wg-stat-box-sub">pre-tax assumption</div>
                      </div>

                      {/* 2. Risk Level */}
                      <div className="stat-box wg-stat-box-modern">
                        <div className="wg-stat-box-header">
                          <div className="wg-stat-icon-badge wg-stat-icon-badge--risk">
                            <Shield size={11} color={RISK_COLORS[rec.riskLabel] || '#38bdf8'} />
                          </div>
                          <span>Risk Level</span>
                        </div>
                        <div
                          className="wg-stat-box-val"
                          style={{ color: RISK_COLORS[rec.riskLabel] || '#38bdf8' }}
                          title={RISK_PLAIN_LABELS[rec.riskLabel] || ''}
                        >
                          {rec.riskLabel}
                        </div>
                        <div className="wg-stat-box-sub">profile matched</div>
                      </div>

                      {/* 3. Monthly SIP */}
                      <div className="stat-box wg-stat-box-modern">
                        <div className="wg-stat-box-header">
                          <div className="wg-stat-icon-badge wg-stat-icon-badge--sip">
                            <Wallet size={11} color="#818cf8" />
                          </div>
                          <span>Monthly SIP</span>
                        </div>
                        <div className="wg-stat-box-val val-white">
                          {formatINR(rec.monthly_allocation)}
                        </div>
                        <div className="wg-stat-box-sub">recommended plan</div>
                      </div>

                      {/* 4. Lock-in (strictly keeping 'None' / 'Unavailable' text for invariant tests) */}
                      <div className="stat-box wg-stat-box-modern">
                        <div className="wg-stat-box-header">
                          <div className="wg-stat-icon-badge wg-stat-icon-badge--lock">
                            <Clock size={11} color="#94a3b8" />
                          </div>
                          <span>Lock-In</span>
                        </div>
                        <div
                          className="wg-stat-box-val val-white"
                          title={rec.maturity_type === 'age_based'
                            ? `Matures at age ${rec.maturity_age} (${rec.lock_in_years} years from now)`
                            : undefined}
                        >
                          {rec.lock_in_years != null
                            ? (rec.lock_in_years === 0 ? 'None' : `${rec.lock_in_years}Y`)
                            : (rec.lockIn == null ? 'Unavailable' : rec.lockIn === 0 ? 'None' : `${rec.lockIn}Y`)}
                        </div>
                        <div className="wg-stat-box-sub">liquidity horizon</div>
                      </div>
                    </div>

                    {/* Primary Suitability Reason Snippet */}
                    {whyReasons && whyReasons.length > 0 && (
                      <div className="wg-card-reason-snippet">
                        <CheckCircle2 size={13} color="#38bdf8" style={{ flexShrink: 0, marginTop: 2 }} />
                        <span className="wg-reason-snippet-text">{whyReasons[0]}</span>
                      </div>
                    )}

                    {/* ELSS Lock-in Warning */}
                    {(() => {
                      const lockWarning = getLockInWarning(rec, horizon);
                      return lockWarning ? (
                        <div style={{
                          fontSize: '0.68rem', color: '#fbbf24', padding: '6px 10px', marginBottom: 10,
                          background: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.22)',
                          borderRadius: 8, lineHeight: 1.4, display: 'flex', alignItems: 'center', gap: 6
                        }}>
                          <Clock size={12} color="#fbbf24" style={{ flexShrink: 0 }} />
                          <span>{lockWarning}</span>
                        </div>
                      ) : null;
                    })()}

                    {/* ML Telemetry / Provenance HUD bar */}
                    {(() => {
                      const confidence = rec.ml_confidence;
                      const hasRealConfidence = confidence != null && confidence > 0;

                      if (!hasRealConfidence) {
                        return (
                          <div className="wg-card-telemetry wg-card-telemetry--muted confidence-unavailable">
                            <div className="wg-telemetry-note">
                              ML shadow observation unavailable; ranking remains backend-owned
                            </div>
                          </div>
                        );
                      }

                      const confLabel = getConfidenceLabel(confidence);
                      const displayPct = Math.round(confidence * 100);
                      const displayStatus = confLabel.label ? confLabel.label.replace(' Recommendation', '') : `${displayPct}%`;
                      return (
                        <div className="wg-card-telemetry confidence-bar-container">
                          <div className="wg-telemetry-row">
                            <span className="wg-telemetry-label">
                              <Activity size={11} color="#38bdf8" />
                              <span>ML Observation</span>
                            </span>
                            <span
                              className="wg-telemetry-badge confidence-value"
                              style={{
                                color: confLabel.colour,
                                borderColor: `${confLabel.colour}35`,
                                background: `${confLabel.colour}10`
                              }}
                            >
                              {displayStatus} • {displayPct}%
                            </span>
                          </div>
                          <div className="wg-telemetry-track">
                            <div
                              className="wg-telemetry-fill confidence-bar"
                              style={{
                                width: `${Math.min(100, displayPct)}%`,
                                background: `linear-gradient(90deg, #06b6d4, #38bdf8, ${confLabel.colour})`,
                                boxShadow: `0 0 10px ${confLabel.colour}60`
                              }}
                            />
                          </div>
                          {confidence < 0.30 && (
                            <div className="wg-telemetry-alert-chip">
                              <AlertCircle size={12} color="#fbbf24" style={{ flexShrink: 0 }} />
                              <span>Low model confidence — shown for reference only</span>
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    {/* Card Actions Dock */}
                    <div className="wg-card-actions-dock">
                      {/* Why recommended drawer */}
                      <button
                        type="button"
                        onClick={() => toggleWhyCard(rec.id)}
                        className="wg-why-card-btn"
                        aria-expanded={isExpanded}
                      >
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                          <Sparkles size={13} color="#22d3ee" />
                          <span>Why recommended?</span>
                        </span>
                        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>

                      {isExpanded && (
                        <div className="wg-why-drawer">
                          <div className="wg-why-drawer-header">
                            <Sparkles size={11} color="#38bdf8" />
                            <span>Suitability Rationale</span>
                          </div>
                          <ul className="wg-why-reasons-list">
                            {whyReasons.map((reason, i) => (
                              <li key={i} className="wg-why-reason-item">
                                <span className="wg-why-bullet">✦</span>
                                <span>{reason}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Learn More button */}
                      {onLearnMore && (
                        <button
                          type="button"
                          onClick={() => onLearnMore(rec)}
                          className="wg-learn-more-btn"
                        >
                          <span>Learn More — Full Deep Dive</span>
                          <ChevronRight size={15} className="wg-learn-more-arrow" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}



        {/* ═══════════════════════════════════════════════════════════
            SECTION 10: AI ADVISORY CARD — Structured Smart Advisory Synthesis
            ═══════════════════════════════════════════════════════════ */}
        {recommendationMeta?.advisory_text ? (() => {
          const rawText = recommendationMeta.advisory_text;

          // Clean up and extract any leading salutation like "Dear Investor,"
          let cleanText = rawText.trim();
          let salutation = '';
          const salutationMatch = cleanText.match(/^(Dear [^,\n]+,|Hello [^,\n]+,|Hi [^,\n]+,)\s*/i);
          if (salutationMatch) {
            salutation = salutationMatch[1];
            cleanText = cleanText.slice(salutationMatch[0].length).trim();
          }

          // Split by double newlines first (standard paragraph breaks)
          let paragraphs = cleanText
            .split(/\n\s*\n+/)
            .map(p => p.trim())
            .filter(p => p.length > 0);

          // If double-newline split produced only 1 large chunk, try single newlines
          if (paragraphs.length === 1 && paragraphs[0].length > 150) {
            const lines = paragraphs[0].split(/\n+/).map(l => l.trim()).filter(l => l.length > 0);
            if (lines.length >= 2) {
              paragraphs = lines;
            }
          }

          // Prepend salutation to the first paragraph instead of showing it alone
          if (salutation && paragraphs.length > 0) {
            paragraphs[0] = `${salutation} ${paragraphs[0]}`;
          } else if (salutation && paragraphs.length === 0) {
            paragraphs = [salutation];
          }

          const renderSmartFormattedParagraph = (text) => {
            // 1. Format raw 4-decimal percentages like 8.2474% -> 8.25%
            const formattedText = text.replace(/(\d+\.\d{2})\d+%/g, '$1%');

            // 2. Tokenize for monetary amounts, percentages, and horizons
            const tokens = formattedText.split(/(\b₹[\d,]+\b|\b\d+(?:\.\d+)?%\b|\b\d+(?:-year|\s+year)\b)/gi);

            return tokens.map((part, i) => {
              if (/^₹[\d,]+$/i.test(part)) {
                return <span key={i} style={{ color: '#38bdf8', fontWeight: 700, background: 'rgba(56, 189, 248, 0.1)', padding: '1px 6px', borderRadius: 6, border: '1px solid rgba(56, 189, 248, 0.2)' }}>{part}</span>;
              }
              if (/^\d+(?:\.\d+)?%$/i.test(part)) {
                return <span key={i} style={{ color: '#4ade80', fontWeight: 700, background: 'rgba(34, 197, 94, 0.1)', padding: '1px 6px', borderRadius: 6, border: '1px solid rgba(34, 197, 94, 0.2)' }}>{part}</span>;
              }
              if (/^\d+(?:-year|\s+year)/i.test(part)) {
                return <span key={i} style={{ color: '#818cf8', fontWeight: 700, background: 'rgba(129, 140, 248, 0.1)', padding: '1px 6px', borderRadius: 6, border: '1px solid rgba(129, 140, 248, 0.2)' }}>{part}</span>;
              }
              return part;
            });
          };

          return (
            <div className="holographic-card" style={{
              marginTop: 36,
              marginBottom: 36,
              padding: '28px 32px',
              borderRadius: 20,
              background: 'linear-gradient(145deg, rgba(13, 20, 36, 0.96) 0%, rgba(22, 32, 54, 0.92) 100%)',
              border: '1px solid rgba(56, 189, 248, 0.28)',
              boxShadow: '0 16px 48px rgba(0, 0, 0, 0.5), inset 0 1px 1px rgba(255, 255, 255, 0.12)',
              position: 'relative',
              overflow: 'hidden'
            }}>
              {/* Background Ambient Glow */}
              <div style={{
                position: 'absolute', top: -60, right: -60, width: 260, height: 260,
                background: 'radial-gradient(circle, rgba(139, 92, 246, 0.15), transparent 70%)',
                pointerEvents: 'none'
              }} />

              {/* Header Bar */}
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                paddingBottom: 20, marginBottom: 20,
                borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                flexWrap: 'wrap', gap: 14, position: 'relative', zIndex: 1
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                  <div style={{
                    width: 48, height: 48, borderRadius: 14,
                    background: 'linear-gradient(135deg, #06b6d4 0%, #8b5cf6 100%)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                    boxShadow: '0 0 24px rgba(6, 182, 212, 0.4), inset 0 1px 1px rgba(255, 255, 255, 0.3)'
                  }}>
                    <Sparkles size={24} color="#ffffff" />
                  </div>
                  <div>
                    <h3 style={{ fontSize: '1.25rem', fontWeight: 800, color: '#f8fafc', margin: 0, letterSpacing: '-0.3px' }}>
                      Genie's Personal Advisory Summary
                    </h3>
                    <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginTop: 2, fontWeight: 500 }}>
                      Backend-generated allocation and grounded explanation for your saved profile
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{
                    fontSize: '0.68rem', fontWeight: 800, color: '#818cf8', letterSpacing: '0.5px',
                    background: 'rgba(129, 140, 248, 0.12)', border: '1px solid rgba(129, 140, 248, 0.3)',
                    padding: '5px 12px', borderRadius: 20
                  }}>
                    VERIFIED TAX POLICY
                  </span>
                </div>
              </div>

              {/* Structured Smart Content Cards */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, position: 'relative', zIndex: 1 }}>
                {paragraphs.map((para, idx) => {
                  let cardStyle = {
                    background: 'rgba(15, 23, 42, 0.65)',
                    border: '1px solid rgba(56, 189, 248, 0.15)',
                    borderLeft: '4px solid #38bdf8',
                    badgeBg: 'rgba(56, 189, 248, 0.14)',
                    badgeColor: '#38bdf8',
                    badgeText: 'STRATEGIC OVERVIEW',
                    icon: <TrendingUp size={13} color="#38bdf8" />
                  };

                  if (idx === 1) {
                    cardStyle = {
                      background: 'rgba(245, 158, 11, 0.05)',
                      border: '1px solid rgba(245, 158, 11, 0.22)',
                      borderLeft: '4px solid #f59e0b',
                      badgeBg: 'rgba(245, 158, 11, 0.14)',
                      badgeColor: '#fbbf24',
                      badgeText: 'KEY RISKS & MARKET CONSIDERATIONS',
                      icon: <ShieldAlert size={13} color="#fbbf24" />
                    };
                  } else if (idx >= 2) {
                    cardStyle = {
                      background: 'rgba(34, 197, 94, 0.05)',
                      border: '1px solid rgba(34, 197, 94, 0.22)',
                      borderLeft: '4px solid #22c55e',
                      badgeBg: 'rgba(34, 197, 94, 0.14)',
                      badgeColor: '#4ade80',
                      badgeText: 'ACTIONABLE ALLOCATION PLAN',
                      icon: <CheckCircle2 size={13} color="#4ade80" />
                    };
                  }

                  return (
                    <div key={idx} style={{
                      background: cardStyle.background,
                      border: cardStyle.border,
                      borderLeft: cardStyle.borderLeft,
                      borderRadius: 14,
                      padding: '18px 22px',
                      boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 4px 16px rgba(0, 0, 0, 0.2)',
                      transition: 'transform 0.2s ease, boxShadow 0.2s ease'
                    }}>
                      <div style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6,
                        background: cardStyle.badgeBg,
                        color: cardStyle.badgeColor,
                        padding: '3px 10px', borderRadius: 12,
                        fontSize: '0.62rem', fontWeight: 800, letterSpacing: '0.6px',
                        marginBottom: 10
                      }}>
                        {cardStyle.icon}
                        {cardStyle.badgeText}
                      </div>
                      <p style={{
                        fontSize: '0.94rem',
                        color: '#e2e8f0',
                        lineHeight: 1.7,
                        margin: 0,
                        fontWeight: 400,
                        letterSpacing: '-0.1px'
                      }}>
                        {renderSmartFormattedParagraph(para)}
                      </p>
                    </div>
                  );
                })}
              </div>

              {/* Footer Trust Bar */}
              <div style={{
                marginTop: 22, paddingTop: 14,
                borderTop: '1px solid rgba(255, 255, 255, 0.06)',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                fontSize: '0.72rem', color: '#64748b', flexWrap: 'wrap', gap: 10,
                position: 'relative', zIndex: 1
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Shield size={14} color="#38bdf8" />
                  <span>SEBI Regulatory Framework & verified tax-policy compliant</span>
                </div>
                <div>
                  Deterministic 5-Stage Verification • 100% Citation Grounding
                </div>
              </div>
            </div>
          );
        })() : recommendationMeta?.advisory_explanation?.status === 'DELAYED' ? (
          <div role="status" data-testid="advisory-delayed" className="holographic-card" style={{ marginTop: 36, marginBottom: 36, padding: '24px 28px' }}>
            <h3 style={{ margin: 0, color: '#f8fafc' }}>Explanation is taking longer than expected</h3>
            <p style={{ color: '#94a3b8', marginBottom: 0 }}>
              Your investment plan is available. Refresh this page later to check the separate explanation.
            </p>
          </div>
        ) : (isAdvisoryLoading || recommendationMeta?.advisory_explanation?.status === 'PENDING' || recommendationMeta?.advisory_explanation?.status === 'GENERATING') ? (
          <div className="holographic-card" data-testid="advisory-loading-skeleton" style={{
            marginTop: 36,
            marginBottom: 36,
            padding: '28px 32px',
            borderRadius: 20,
            background: 'linear-gradient(145deg, rgba(13, 20, 36, 0.96) 0%, rgba(22, 32, 54, 0.92) 100%)',
            border: '1px solid rgba(56, 189, 248, 0.28)',
            boxShadow: '0 16px 48px rgba(0, 0, 0, 0.5), inset 0 1px 1px rgba(255, 255, 255, 0.12)',
            position: 'relative',
            overflow: 'hidden'
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 16,
              paddingBottom: 18, marginBottom: 18,
              borderBottom: '1px solid rgba(255, 255, 255, 0.08)'
            }}>
              <div style={{
                width: 44, height: 44, borderRadius: 12,
                background: 'linear-gradient(135deg, #06b6d4 0%, #8b5cf6 100%)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                boxShadow: '0 0 20px rgba(6, 182, 212, 0.35)'
              }}>
                <Sparkles size={22} color="#ffffff" />
              </div>
              <div>
                <h3 style={{ fontSize: '1.15rem', fontWeight: 800, color: '#f8fafc', margin: 0, letterSpacing: '-0.2px' }}>
                  Generating grounded explanation…
                </h3>
                <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginTop: 3, fontWeight: 500 }}>
                  Synthesizing SEBI-grounded personalized advisory narrative from authoritative portfolio metrics
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ height: 14, width: '92%', borderRadius: 6, background: 'rgba(255,255,255,0.06)' }} />
              <div style={{ height: 14, width: '85%', borderRadius: 6, background: 'rgba(255,255,255,0.06)' }} />
              <div style={{ height: 14, width: '65%', borderRadius: 6, background: 'rgba(255,255,255,0.06)' }} />
            </div>
          </div>
        ) : null}

        {/* ═══════════════════════════════════════════════════════════
            SECTION 9: BROWSE BY INSTRUMENT TYPE / RISK LEVEL
            ═══════════════════════════════════════════════════════════ */}
        {recommendations && recommendations.length > 0 && (() => {
          const isEmergencyFund = (userProfile?.investment_goals || []).includes('Emergency Fund');

          if (isEmergencyFund) {
            const emergencyColor = '#14b8a6';
            return (
              <div style={{ marginTop: 40, marginBottom: 40 }}>
                <h2 style={{ fontSize: '1.3rem', fontWeight: 700, marginBottom: 8, color: '#fff', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <BarChart3 size={20} color="#94a3b8" /> Emergency-fund recommendations
                </h2>
                <p style={{ fontSize: '0.85rem', color: '#94a3b8', marginBottom: 20 }}>
                  Check each product’s current access, withdrawal, and lock-in terms before assigning emergency savings.
                </p>
                <div className="wg-risk-accordion-card" style={{ borderLeft: `3px solid ${emergencyColor}` }}>
                  <div style={{
                    width: '100%', padding: '14px 18px', color: '#fff', display: 'flex', alignItems: 'center', gap: 10,
                    fontSize: '0.88rem', fontWeight: 750
                  }}>
                    <Shield size={18} color={emergencyColor} />
                    <span>Recommendations</span>
                    <span style={{ marginLeft: 'auto', fontSize: '0.78rem', color: '#94a3b8', fontWeight: 600 }}>
                      {recommendations.length} instrument{recommendations.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                  <div style={{ padding: '4px 16px 16px' }}>
                    {recommendations.length === 0 ? (
                      <div style={{ color: '#94a3b8', fontSize: '0.82rem', padding: '10px 0' }}>
                        No eligible recommendations are available for this profile.
                      </div>
                    ) : recommendations.map(inv => (
                      <div key={inv.id} className="wg-risk-instrument-row">
                        <div>
                          <div style={{ fontWeight: 700, fontSize: '0.88rem', color: '#f8fafc' }}>{inv.abbr || inv.name}</div>
                          <div style={{ fontSize: '0.72rem', color: '#94a3b8', marginTop: 2 }}>
                            Model assumption (pre-tax): {nullableMarketNumber(inv.nominalReturn) !== null ? `${nullableMarketNumber(inv.nominalReturn).toFixed(1)}%` : 'Unavailable'}
                            {' '}&bull; <span style={{ color: RISK_COLORS[inv.riskLabel] || emergencyColor, fontWeight: 650 }}>{inv.riskLabel || 'Risk unavailable'}</span>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => scrollToCard(inv.id)}
                          className="wg-risk-view-btn"
                          style={{ background: `${emergencyColor}15`, borderColor: `${emergencyColor}35`, color: emergencyColor }}
                        >View Details</button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            );
          }
          // Default: Browse by Risk Level
          return (
          <div style={{ marginTop: 36, marginBottom: 36 }}>
            <div style={{display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20}}>
              <div style={{
                width: 36, height: 36, borderRadius: 12,
                background: 'linear-gradient(135deg, rgba(139, 92, 246, 0.12), rgba(99, 102, 241, 0.08))',
                border: '1px solid rgba(139, 92, 246, 0.2)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 4px 16px rgba(139, 92, 246, 0.1)'
              }}>
                <BarChart3 size={18} color="#8b5cf6" />
              </div>
              <div>
                <h2 style={{
                  fontSize: '1.15rem', fontWeight: 800, margin: 0, letterSpacing: '-0.4px',
                  background: 'linear-gradient(135deg, #e2e8f0, #94a3b8)',
                  WebkitBackgroundClip: 'text', backgroundClip: 'text', WebkitTextFillColor: 'transparent'
                }}>Browse by Risk Level</h2>
                <span style={{fontSize: '0.65rem', color: '#546178'}}>Explore backend-ranked recommendations grouped by risk</span>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
              {/* Low Risk Group */}
              <div className="wg-risk-accordion-card" style={{ borderLeft: '3px solid #14b8a6' }}>
                <button
                  type="button"
                  onClick={() => setRiskGroupOpen(prev => ({ ...prev, low: !prev.low }))}
                  className="wg-risk-accordion-btn"
                >
                  <Shield size={18} color="#14b8a6" />
                  <span>Low Risk</span>
                  <span style={{ marginLeft: 'auto', fontSize: '0.78rem', color: '#94a3b8', fontWeight: 600 }}>
                    {riskGroups.low.length} instruments
                  </span>
                  {riskGroupOpen.low ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>
                {riskGroupOpen.low && (
                  <div style={{ padding: '4px 16px 16px' }}>
                    {riskGroups.low.length === 0 ? (
                      <div style={{ color: '#94a3b8', fontSize: '0.82rem', padding: '10px 0' }}>No eligible low-risk instruments for your profile.</div>
                    ) : riskGroups.low.map(inv => (
                      <div key={inv.id} className="wg-risk-instrument-row">
                        <div>
                          <div style={{ fontWeight: 700, fontSize: '0.88rem', color: '#f8fafc' }}>{inv.abbr || inv.name}</div>
                          <div style={{ fontSize: '0.72rem', color: '#94a3b8', marginTop: 2 }}>
                            Model assumption (pre-tax): {nullableMarketNumber(inv.nominalReturn) !== null ? `${nullableMarketNumber(inv.nominalReturn).toFixed(1)}%` : 'N/A'} · <span style={{ color: RISK_COLORS[inv.riskLabel] || '#34d399', fontWeight: 650 }}>{inv.riskLabel}</span>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => scrollToCard(inv.id)}
                          className="wg-risk-view-btn"
                          style={{
                            background: 'rgba(20, 184, 166, 0.1)', borderColor: 'rgba(20, 184, 166, 0.28)',
                            color: '#2dd4bf'
                          }}
                        >View Details</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Medium Risk Group */}
              <div className="wg-risk-accordion-card" style={{ borderLeft: '3px solid #f97316' }}>
                <button
                  type="button"
                  onClick={() => setRiskGroupOpen(prev => ({ ...prev, medium: !prev.medium }))}
                  className="wg-risk-accordion-btn"
                >
                  <TrendingUp size={18} color="#f97316" />
                  <span>Medium Risk</span>
                  <span style={{ marginLeft: 'auto', fontSize: '0.78rem', color: '#94a3b8', fontWeight: 600 }}>
                    {riskGroups.medium.length} instruments
                  </span>
                  {riskGroupOpen.medium ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>
                {riskGroupOpen.medium && (
                  <div style={{ padding: '4px 16px 16px' }}>
                    {riskGroups.medium.length === 0 ? (
                      <div style={{ color: '#94a3b8', fontSize: '0.82rem', padding: '10px 0' }}>No eligible medium-risk instruments for your profile.</div>
                    ) : riskGroups.medium.map(inv => (
                      <div key={inv.id} className="wg-risk-instrument-row">
                        <div>
                          <div style={{ fontWeight: 700, fontSize: '0.88rem', color: '#f8fafc' }}>{inv.abbr || inv.name}</div>
                          <div style={{ fontSize: '0.72rem', color: '#94a3b8', marginTop: 2 }}>
                            Model assumption (pre-tax): {nullableMarketNumber(inv.nominalReturn) !== null ? `${nullableMarketNumber(inv.nominalReturn).toFixed(1)}%` : 'N/A'} · <span style={{ color: RISK_COLORS[inv.riskLabel] || '#fbbf24', fontWeight: 650 }}>{inv.riskLabel}</span>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => scrollToCard(inv.id)}
                          className="wg-risk-view-btn"
                          style={{
                            background: 'rgba(249, 115, 22, 0.1)', borderColor: 'rgba(249, 115, 22, 0.28)',
                            color: '#fb923c'
                          }}
                        >View Details</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* High Risk Group */}
              <div className="wg-risk-accordion-card" style={{ borderLeft: '3px solid #ef4444' }}>
                <button
                  type="button"
                  onClick={() => setRiskGroupOpen(prev => ({ ...prev, high: !prev.high }))}
                  className="wg-risk-accordion-btn"
                >
                  <Zap size={18} color="#ef4444" />
                  <span>High Risk</span>
                  <span style={{ marginLeft: 'auto', fontSize: '0.78rem', color: '#94a3b8', fontWeight: 600 }}>
                    {riskGroups.high.length} instruments
                  </span>
                  {riskGroupOpen.high ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>
                {riskGroupOpen.high && (
                  <div style={{ padding: '4px 16px 16px' }}>
                    {riskGroups.high.length === 0 ? (
                      <div style={{ color: '#94a3b8', fontSize: '0.82rem', padding: '10px 0' }}>No eligible high-risk instruments for your profile.</div>
                    ) : riskGroups.high.map(inv => (
                      <div key={inv.id} className="wg-risk-instrument-row">
                        <div>
                          <div style={{ fontWeight: 700, fontSize: '0.88rem', color: '#f8fafc' }}>{inv.abbr || inv.name}</div>
                          <div style={{ fontSize: '0.72rem', color: '#64748b', marginTop: 2 }}>
                            Model assumption (pre-tax): {nullableMarketNumber(inv.nominalReturn) !== null ? `${nullableMarketNumber(inv.nominalReturn).toFixed(1)}%` : 'N/A'} · <span style={{ color: RISK_COLORS[inv.riskLabel] || '#f87171', fontWeight: 650 }}>{inv.riskLabel}</span>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => scrollToCard(inv.id)}
                          className="wg-risk-view-btn"
                          style={{
                            background: 'rgba(239, 68, 68, 0.1)', borderColor: 'rgba(239, 68, 68, 0.28)',
                            color: '#f87171'
                          }}
                        >View Details</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
          );
        })()}

        <SebiDisclaimer />

        {/* First-Time Onboarding Modal (Fix 5) */}
        {showOnboarding && (
          <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 10000, padding: 20
          }}>
            <div style={{
              background: 'linear-gradient(160deg, rgba(15, 23, 42, 0.98), rgba(8, 13, 28, 0.99))',
              border: '1px solid rgba(56,189,248,0.15)', borderRadius: 20,
              padding: '32px 28px', maxWidth: 520, width: '100%',
              boxShadow: '0 24px 80px rgba(0,0,0,0.6)'
            }}>
              <div style={{textAlign: 'center', marginBottom: 20}}>
                <div style={{fontSize: '2rem', marginBottom: 8}}>&#x1F9DE;</div>
                <h2 style={{fontSize: '1.3rem', fontWeight: 800, color: '#e2e8f0', margin: '0 0 6px'}}>Welcome to WealthGenie</h2>
                <p style={{fontSize: '0.78rem', color: '#94a3b8', margin: 0, lineHeight: 1.5}}>We have built a personalised investment plan based on your profile. Here are three things to know:</p>
              </div>
              <div style={{display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 24}}>
                <div style={{display: 'flex', gap: 12, alignItems: 'flex-start'}}>
                  <span style={{fontSize: '1.2rem', lineHeight: 1}}>&#x1F4A1;</span>
                  <div>
                    <div style={{fontWeight: 700, color: '#e2e8f0', fontSize: '0.82rem', marginBottom: 2}}>Dashboard returns are pre-tax model assumptions</div>
                    <div style={{fontSize: '0.72rem', color: '#94a3b8', lineHeight: 1.5}}>Use Real Returns or Save on Taxes with explicit income, regime, income source, and fiscal year to obtain a separate server-calculated tax result.</div>
                  </div>
                </div>
                <div style={{display: 'flex', gap: 12, alignItems: 'flex-start'}}>
                  <span style={{fontSize: '1.2rem', lineHeight: 1}}>&#x1F512;</span>
                  <div>
                    <div style={{fontWeight: 700, color: '#e2e8f0', fontSize: '0.82rem', marginBottom: 2}}>Some investments have lock-in periods</div>
                    <div style={{fontSize: '0.72rem', color: '#94a3b8', lineHeight: 1.5}}>ELSS requires 3 years, NPS until age 60, PPF for 15 years. Tap the <span style={{color: '#38bdf8'}}>?</span> icon on any instrument to learn more.</div>
                  </div>
                </div>
                <div style={{display: 'flex', gap: 12, alignItems: 'flex-start'}}>
                  <span style={{fontSize: '1.2rem', lineHeight: 1}}>&#x1F4CA;</span>
                  <div>
                    <div style={{fontWeight: 700, color: '#e2e8f0', fontSize: '0.82rem', marginBottom: 2}}>Projections show a range, not a guarantee</div>
                    <div style={{fontSize: '0.72rem', color: '#94a3b8', lineHeight: 1.5}}>The Best, Average, and Conservative lines in your Wealth Trajectory chart show three possible futures. Markets are unpredictable — we show all three honestly.</div>
                  </div>
                </div>
              </div>
              <button onClick={() => { localStorage.setItem('wg_onboarded', 'true'); setShowOnboarding(false); }} style={{
                width: '100%', padding: '12px', borderRadius: 12,
                background: 'linear-gradient(135deg, #0369a1, #0284c7)', color: '#fff',
                border: '1px solid rgba(56,189,248,0.3)', fontWeight: 700, fontSize: '0.88rem',
                cursor: 'pointer', fontFamily: 'inherit',
                boxShadow: '0 4px 16px rgba(2,132,199,0.3)'
              }}>Show me my plan</button>
              <p style={{fontSize: '0.62rem', color: '#546178', textAlign: 'center', marginTop: 12, lineHeight: 1.5}}>
                WealthGenie is an educational tool, not a SEBI-registered investment adviser. Always consult a qualified adviser for personal financial decisions.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default RecommendationDashboard;
