import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip as RechartsTooltip } from 'recharts';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import {
  ArrowUpRight,
  AlertTriangle,
  Briefcase,
  CheckCircle2,
  Clock3,
  FileSearch,
  Info,
  Landmark,
  LoaderCircle,
  Layers,
  PieChart as PieChartIcon,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingUp,
  Wallet,
  RefreshCw,
} from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Tooltip from '@radix-ui/react-tooltip';
import { toast } from 'sonner';
import { RISK_COLORS } from '../investmentDatabase';
import * as api from '../services/api';
import { formatCurrency, getCategoryDescription } from '../utils/allocationPlannerPresentation';
import { isPresentFiniteNumber, toOptionalNumber } from '../utils/financialValues';
import ResearchStatusCard from './agent/ResearchStatusCard';
import PlanReviewAuthorization from './agent/PlanReviewAuthorization';
import './AllocationPlanner.css';

const SLICE_GRADIENTS = [
  { id: 'grad-sky', primary: '#38bdf8', stop1: '#0ea5e9', stop2: '#38bdf8', glow: 'rgba(56, 189, 248, 0.35)' },
  { id: 'grad-emerald', primary: '#34d399', stop1: '#059669', stop2: '#34d399', glow: 'rgba(52, 211, 153, 0.35)' },
  { id: 'grad-purple', primary: '#c084fc', stop1: '#7c3aed', stop2: '#c084fc', glow: 'rgba(192, 132, 252, 0.35)' },
  { id: 'grad-amber', primary: '#fbbf24', stop1: '#d97706', stop2: '#fbbf24', glow: 'rgba(251, 191, 36, 0.35)' },
  { id: 'grad-pink', primary: '#f472b6', stop1: '#db2777', stop2: '#f472b6', glow: 'rgba(244, 114, 182, 0.35)' },
  { id: 'grad-cyan', primary: '#22d3ee', stop1: '#0891b2', stop2: '#22d3ee', glow: 'rgba(34, 211, 238, 0.35)' },
];

const RISK_PRESETS = [
  { id: 'Safe & Stable', label: 'Safe & Stable' },
  { id: 'Balanced Growth', label: 'Balanced Growth' },
  { id: 'Aggressive Growth', label: 'Aggressive Growth' },
];

const getCategoryIcon = (category) => {
  const value = String(category || '').toLowerCase();
  if (value === 'equity' || value.includes('stock')) {
    return <TrendingUp size={19} aria-hidden="true" />;
  }
  if (['debt', 'government', 'sovereign', 'cash'].includes(value)) {
    return <Landmark size={19} aria-hidden="true" />;
  }
  if (['gold', 'commodity', 'alternative'].includes(value)) {
    return <Briefcase size={19} aria-hidden="true" />;
  }
  return <Wallet size={19} aria-hidden="true" />;
};

const normalizeRationaleForDisplay = (text) => text
  .replace(/\s*\[[A-Z0-9_:-]+\]/g, '')
  .replace(/\s{2,}/g, ' ')
  .trim();

const formatSubtype = (val) => String(val || '').replace(/_/g, ' ').trim();

const PlanState = ({ kind, title, message }) => (
  <div className={`ap-state ap-state-${kind}`} role="status" aria-live="polite">
    <div className="ap-state-icon" aria-hidden="true">
      {kind === 'loading' ? <Sparkles size={22} /> : <PieChartIcon size={22} />}
    </div>
    <span className="ap-eyebrow">YOUR PLAN</span>
    <h1>{title}</h1>
    <p>{message}</p>
  </div>
);

const PlanTerm = ({ term, explanation, label }) => (
  <span className="ap-term">
    <span>{label || term}</span>
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button type="button" className="ap-tooltip-trigger" aria-label={`More information about ${term}`}>
          <Info size={12} aria-hidden="true" />
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="ap-tooltip-content" side="top" sideOffset={7}>
          {explanation}
          <Tooltip.Arrow className="ap-tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  </span>
);

const AllocationChartTooltip = ({ active, payload }) => {
  if (!active || !payload?.[0]?.payload) return null;
  const item = payload[0].payload;
  return (
    <div className="ap-chart-tooltip" role="status">
      <strong>{item.name}</strong>
      <span>{item.allocationPct.toFixed(1)}% · {formatCurrency(item.monthlyAmount)}/month</span>
    </div>
  );
};

const PLAN_REVIEW_STAGES = [
  'Checking your profile',
  'Checking recommendation freshness',
  'Collecting plan evidence',
  'Preparing a grounded review',
];

const PlanReviewPanel = ({ profile, profileId, financialStateKey, onRecomputePlan }) => {
  const prefersReducedMotion = useReducedMotion();
  const [status, setStatus] = useState('idle');
  const [run, setRun] = useState(null);
  const [review, setReview] = useState(null);
  const [error, setError] = useState(null);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const reviewRequestSequence = useRef(0);
  const bindingKey = `${profileId || ''}:${financialStateKey || ''}`;
  const [stateBindingKey, setStateBindingKey] = useState(bindingKey);
  const bindingIsCurrent = stateBindingKey === bindingKey;
  const visibleStatus = bindingIsCurrent ? status : 'idle';
  const visibleRun = bindingIsCurrent ? run : null;
  const visibleReview = bindingIsCurrent ? review : null;
  const visibleError = bindingIsCurrent ? error : null;

  useLayoutEffect(() => {
    reviewRequestSequence.current += 1;
  }, [profileId, financialStateKey]);

  useEffect(() => {
    if (!profileId) return undefined;
    let cancelled = false;
    api.getCurrentPlanReviewRun(profileId, { timeoutMs: 1500 }).then(current => {
      if (cancelled || !current) return;
      setStateBindingKey(bindingKey);
      if (current.currentStateMatch !== true || current.status === 'SUPERSEDED') {
        setStatus('error');
        setError('This plan review no longer matches your current saved plan. Run it again.');
        return;
      }
      setRun(current);
      if (current.result) setReview(current.result);
      if (current.status === 'COMPLETED' || current.status === 'WAITING_FOR_APPROVAL') setStatus('completed');
      else if (['QUEUED', 'RUNNING'].includes(current.status)) setStatus('running');
      else if (['FAILED', 'CANCELLED', 'BUDGET_EXCEEDED', 'SUPERSEDED'].includes(current.status)) {
        setStatus('error');
        setError(current.status === 'SUPERSEDED'
          ? 'This plan review no longer matches your current saved plan. Run it again.'
          : current.status === 'CANCELLED'
            ? 'This plan review was cancelled.'
            : current.failure?.message || 'The plan review did not complete.');
      }
    }).catch(() => {
      // A missing run is the normal initial state; it is not a panel error.
    });
    return () => { cancelled = true; };
  }, [profileId, financialStateKey, bindingKey]);

  useEffect(() => {
    if (!visibleRun?.runId || visibleStatus !== 'running') return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const current = await api.getPlanReviewRun(visibleRun.runId);
        if (cancelled) return;
        if (current.currentStateMatch !== true || current.status === 'SUPERSEDED') {
          setRun(null);
          setReview(null);
          setStatus('error');
          setError('Your saved plan changed while this review was running. Run it again.');
          return;
        }
        setRun(current);
        if (current.result) setReview(current.result);
        if (current.status === 'COMPLETED' || current.status === 'WAITING_FOR_APPROVAL') {
          setStatus('completed');
          toast.success('Plan review ready', { description: 'No plan changes were made.' });
        } else if (['FAILED', 'CANCELLED', 'BUDGET_EXCEEDED', 'SUPERSEDED'].includes(current.status)) {
          setStatus('error');
          setError(current.status === 'SUPERSEDED'
            ? 'Your saved plan changed while this review was running. Run it again.'
            : current.failure?.message || 'The plan review did not complete.');
        }
      } catch (err) {
        if (!cancelled && err?.status && err.status >= 400 && err.status < 500) {
          setStatus('error');
          setError(err.message || 'Plan review is unavailable.');
        }
      }
    };
    void poll();
    const timer = window.setInterval(poll, 1000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [visibleRun?.runId, visibleStatus]);

  const runReview = async () => {
    if (!profileId || (bindingIsCurrent && status === 'running')) return;
    const requestId = ++reviewRequestSequence.current;
    setStateBindingKey(bindingKey);
    setStatus('running');
    setRun(null);
    setReview(null);
    setError(null);
    try {
      const queued = await api.runPlanReview(profileId);
      if (requestId !== reviewRequestSequence.current) return;
      if (queued.currentStateMatch !== true || queued.status === 'SUPERSEDED') {
        setRun(null);
        setReview(null);
        setStatus('error');
        setError('Your saved plan changed before the review could be bound. Refresh your recommendation and try again.');
        return;
      }
      setRun(queued);
      if (queued.result) setReview(queued.result);
      if (queued.status === 'COMPLETED' && queued.recommendedAction === 'RECOMPUTE_PLAN') {
        setStatus('error');
        setError('The review recommended a recompute but is not awaiting authorization. Refresh the review before continuing.');
        return;
      }
      if (queued.status === 'COMPLETED' || queued.status === 'WAITING_FOR_APPROVAL') {
        setReview(queued.result || queued);
        setStatus('completed');
        toast.success('Plan review ready', { description: 'No plan changes were made.' });
      }
    } catch (err) {
      if (requestId !== reviewRequestSequence.current) return;
      setStatus('error');
      setError(err?.message || 'Plan review is temporarily unavailable.');
      toast.error('Plan review unavailable', { description: err?.message || 'Try again later.' });
    }
  };

  const evidenceEntries = visibleReview?.evidence?.entries || [];
  const actionNeedsRecompute = visibleReview?.recommendedAction === 'RECOMPUTE_PLAN';
  const progressPercent = visibleRun?.progress?.percent ?? 0;
  const progressLabel = visibleRun?.progress?.label || PLAN_REVIEW_STAGES[0];

  return (
    <motion.section
      className="ap-section ap-review-section"
      aria-labelledby="plan-review-title"
      initial={prefersReducedMotion ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <div className="ap-review-orbit" aria-hidden="true" />
      <div className="ap-section-heading ap-review-heading">
        <div>
          <span className="ap-eyebrow"><Sparkles size={12} aria-hidden="true" /> PLAN HEALTH</span>
          <h2 id="plan-review-title">Review my plan</h2>
        </div>
        <span className="ap-section-note">Read-only · evidence-grounded</span>
      </div>
      <div className="ap-review-body">
        <div className="ap-review-copy">
          <div className="ap-review-icon" aria-hidden="true"><FileSearch size={21} /></div>
          <div>
            <h3>Is your saved plan still aligned?</h3>
            <p>The review checks your current profile, recommendation freshness, goals, and available evidence. It cannot change allocations or save a new plan.</p>
          </div>
        </div>
        {visibleStatus === 'idle' && (
          <button type="button" className="ap-review-primary" onClick={runReview} disabled={!profileId}>
            <Sparkles size={17} aria-hidden="true" />
            {profileId ? 'Run plan review' : 'Profile required'}
          </button>
        )}
        {visibleStatus === 'running' && (
          <div className="ap-review-progress" role="status" aria-live="polite">
            <div className="ap-review-progress-label"><LoaderCircle className="ap-spin" size={17} aria-hidden="true" /><span>{progressLabel}…</span><strong>{progressPercent}%</strong></div>
            <div className="ap-review-progress-track"><span style={{ width: `${progressPercent}%` }} /></div>
          </div>
        )}
        {visibleStatus === 'error' && (
          <div className="ap-review-result ap-review-error" role="alert">
            <AlertTriangle size={17} aria-hidden="true" />
            <span>{visibleError}</span>
            <button type="button" className="ap-review-link-button" onClick={runReview}>Try again</button>
          </div>
        )}
        {visibleStatus === 'completed' && visibleReview && (
          <div className="ap-review-result">
            <div className="ap-review-result-head">
              <div className="ap-review-ready"><CheckCircle2 size={17} aria-hidden="true" /><span>Review complete</span></div>
              <span className={`ap-review-action ap-review-action-${visibleReview.recommendedAction.toLowerCase()}`}>{visibleReview.recommendedAction.replaceAll('_', ' ')}</span>
            </div>
            <p className="ap-review-summary">{visibleReview.summary}</p>
            <div className="ap-review-findings">
              {(visibleReview.findings || []).slice(0, 3).map(finding => (
                <div className={`ap-review-finding ap-review-finding-${finding.severity.toLowerCase()}`} key={finding.code}>
                  <span>{finding.title}</span><small>{finding.detail}</small>
                </div>
              ))}
            </div>
            <ResearchStatusCard evidenceEntries={evidenceEntries} />
            <div className="ap-review-actions">
              <Dialog.Root open={evidenceOpen} onOpenChange={setEvidenceOpen}>
                <Dialog.Trigger asChild>
                  <button type="button" className="ap-review-secondary"><FileSearch size={16} aria-hidden="true" /> View evidence</button>
                </Dialog.Trigger>
                <Dialog.Portal>
                  <Dialog.Overlay className="ap-dialog-overlay" />
                  <Dialog.Content className="ap-dialog-content ap-evidence-dialog">
                    <div className="ap-dialog-kicker">AUDITABLE CONTEXT</div>
                    <Dialog.Title className="ap-dialog-title">Evidence used for this review</Dialog.Title>
                    <Dialog.Description className="ap-dialog-description">These are read-only facts and metadata returned by the backend. The agent cannot edit your profile or recommendation.</Dialog.Description>
                    <div className="ap-evidence-list">
                      {evidenceEntries.length === 0 ? <p className="ap-evidence-empty">No verified evidence is available for this run.</p> : evidenceEntries.map(entry => (
                        <article className="ap-evidence-item" key={entry.id}>
                          <div className="ap-evidence-item-top"><strong>{entry.id}</strong><span>{entry.dataClass || 'Backend evidence'}</span></div>
                          <p>{entry.displayValue || String(entry.value ?? 'Unavailable')}</p>
                          <small>{entry.source?.provider || entry.authority || 'WealthGenie backend'}{entry.observedAt ? ` · Observed ${new Date(entry.observedAt).toLocaleDateString('en-IN')}` : ''}</small>
                        </article>
                      ))}
                    </div>
                    <Dialog.Close asChild><button type="button" className="ap-dialog-close">Close</button></Dialog.Close>
                  </Dialog.Content>
                </Dialog.Portal>
              </Dialog.Root>
              {actionNeedsRecompute && run?.status === 'WAITING_FOR_APPROVAL' && typeof onRecomputePlan === 'function' && (
                <PlanReviewAuthorization
                  run={visibleRun}
                  onAuthorizationUnavailable={() => onRecomputePlan(profile, null)}
                  onExecutionComplete={response => onRecomputePlan(profile, response)}
                />
              )}
              <button type="button" className="ap-review-icon-button" onClick={runReview} aria-label="Run plan review again"><RefreshCw size={16} aria-hidden="true" /></button>
            </div>
          </div>
        )}
      </div>
    </motion.section>
  );
};

const AllocationPlanner = ({ profile, recommendations = [], recommendationMeta, onRecomputePlan }) => {
  const prefersReducedMotion = useReducedMotion();
  const [hoveredSlice, setHoveredSlice] = useState(null);
  const [methodologyOpen, setMethodologyOpen] = useState(false);
  const savings = toOptionalNumber(profile?.monthly_savings);
  const riskLabel = recommendationMeta?.final_risk_tier || profile?.risk_tolerance || 'Unavailable';

  // Only convert backend-authoritative weights into chart presentation fields.
  // Keep the incoming recommendation order and values unchanged.
  const allocation = useMemo(() => (Array.isArray(recommendations) ? recommendations : [])
    .map((item, idx) => {
      const grad = SLICE_GRADIENTS[idx % SLICE_GRADIENTS.length];
      const allocationWeight = toOptionalNumber(item?.allocationWeight);
      const monthlyAmount = toOptionalNumber(item?.monthly_allocation);
      const nominalRate = toOptionalNumber(item?.nominalReturn);
      if (allocationWeight === undefined || monthlyAmount === undefined
          || allocationWeight < 0 || allocationWeight > 1 || monthlyAmount < 0) {
        throw new TypeError(`Authoritative allocation fields are missing for ${item?.id || item?.name || 'an investment'}`);
      }
      return {
        ...item,
        allocationPct: allocationWeight * 100,
        monthlyAmount,
        nominalRate,
        cat: item.assetClass || item.cat || item.category || 'Other',
        riskLabel: item.riskLabel || item.riskLevel || 'Unavailable',
        gradId: grad.id,
        themeColor: grad.primary,
        glowColor: grad.glow,
      };
    })
    .filter(item => item.monthlyAmount > 0), [recommendations]);

  const blendedReturn = toOptionalNumber(recommendationMeta?.portfolio_return_assumption);
  const allocatedMonthlyTotal = allocation.reduce((sum, item) => sum + item.monthlyAmount, 0);
  const allocationPctTotal = allocation.reduce((sum, item) => sum + item.allocationPct, 0);

  const categoryBreakdown = useMemo(() => {
    const groups = {};
    for (const item of allocation) {
      const groupKey = String(item.cat || 'Other').trim().toLowerCase();
      const groupLabel = formatSubtype(item.cat) || 'Other';
      const groupColor = item.themeColor || '#38bdf8';

      if (!groups[groupKey]) {
        groups[groupKey] = {
          key: groupKey,
          label: groupLabel,
          color: groupColor,
          pct: 0,
          amount: 0,
          count: 0,
        };
      }
      groups[groupKey].pct += item.allocationPct;
      groups[groupKey].amount += item.monthlyAmount;
      groups[groupKey].count += 1;
    }
    return Object.values(groups).sort((a, b) => b.pct - a.pct);
  }, [allocation]);

  const rationaleText = recommendationMeta?.advisory_text
    || (['PENDING', 'GENERATING'].includes(recommendationMeta?.advisory_explanation?.status)
      ? 'Generating grounded explanation…'
      : 'The recommendation service did not return an advisory explanation.');
  const rationaleBullets = useMemo(() => normalizeRationaleForDisplay(rationaleText)
    .split(/\n+|(?<=[.!?])\s+/)
    .map(item => item.trim())
    .filter(Boolean), [rationaleText]);
  const assetClassCount = new Set(allocation.map(item => item.cat)).size;
  const horizonYears = Number(profile?.investment_horizon_years);
  const goals = Array.isArray(profile?.investment_goals) ? profile.investment_goals.filter(Boolean) : [];
  const isLoading = recommendationMeta?.loading === true || recommendationMeta?.status === 'LOADING';
  const hasError = Boolean(recommendationMeta?.error || recommendationMeta?.status === 'ERROR');
  const financialStateKey = [
    profile?.profileId || recommendationMeta?.profileId || '',
    profile?.version ?? profile?.profile_version ?? recommendationMeta?.profile_version ?? '',
    recommendationMeta?.recommendationId ?? recommendationMeta?.recommendation_id ?? '',
    recommendationMeta?.recommendation_generation ?? recommendationMeta?.generation_revision ?? '',
    recommendationMeta?.allocation_revision ?? '',
    recommendationMeta?.allocation_revision_id ?? '',
    recommendationMeta?.portfolio_fingerprint ?? '',
    recommendationMeta?.recommendation_fingerprint ?? '',
  ].map(value => String(value)).join(':');
  const methodologyRows = [
    ['Allocation source', recommendationMeta?.current_allocation_source || 'Backend recommendation'],
    ['Return basis', recommendationMeta?.return_basis || 'Model assumption'],
    ['Assumption version', recommendationMeta?.return_assumption_version || 'Unavailable'],
    ['Policy lineage', recommendationMeta?.policy_lineage || 'Unavailable'],
  ];

  if (isLoading) {
    return (
      <Tooltip.Provider delayDuration={220} skipDelayDuration={120}>
        <motion.div className="ap-page ap-state-page" initial={prefersReducedMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }}>
          <PlanState kind="loading" title="Preparing your plan" message="Your profile is being matched with the recommendation engine." />
        </motion.div>
      </Tooltip.Provider>
    );
  }

  if (hasError) {
    return (
      <Tooltip.Provider delayDuration={220} skipDelayDuration={120}>
        <motion.div className="ap-page ap-state-page" initial={prefersReducedMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }}>
          <PlanState kind="error" title="We couldn't load your plan" message="The recommendation service did not return a usable plan. Your saved profile is unchanged; please try again from the profile screen." />
        </motion.div>
      </Tooltip.Provider>
    );
  }

  if (savings === undefined || savings <= 0 || allocation.length === 0) {
    return (
      <Tooltip.Provider delayDuration={220} skipDelayDuration={120}>
        <motion.div className="ap-page ap-state-page" initial={prefersReducedMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }}>
          <PlanState kind="empty" title="No allocation available" message="Complete or update your financial profile to unlock personalized investment options." />
        </motion.div>
      </Tooltip.Provider>
    );
  }

  return (
    <Tooltip.Provider delayDuration={220} skipDelayDuration={120}>
      <div className="ap-page">
        <motion.header
          className="ap-hero"
          initial={prefersReducedMotion ? false : { opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45 }}
        >
          <div className="ap-page-badge"><Sparkles size={13} aria-hidden="true" /><span>PERSONALISED PLAN</span></div>
          <div className="ap-hero-row">
            <div>
              <p className="ap-eyebrow">MY PLAN</p>
              <h1 className="ap-page-title">Where to <span className="title-gradient">invest your money</span></h1>
              <p className="ap-page-subtitle">
                A clear monthly plan for your <strong>{formatCurrency(savings)}</strong> savings, shaped around your profile.
              </p>
            </div>
            <div className="ap-plan-status" aria-label={`Current profile risk: ${riskLabel}`}>
              <CheckCircle2 size={16} aria-hidden="true" />
              <span>{riskLabel}</span>
            </div>
          </div>
          <div className="ap-summary-metrics" aria-label="Plan summary">
            <div className="ap-summary-metric ap-summary-metric-primary">
              <span className="ap-metric-label">Monthly investment</span>
              <strong>{formatCurrency(savings)}</strong>
              <span className="ap-metric-help">Your current monthly savings</span>
            </div>
            <div className="ap-summary-metric"><span className="ap-metric-label">Investments</span><strong>{allocation.length}</strong><span className="ap-metric-help">Across your plan</span></div>
            <div className="ap-summary-metric"><span className="ap-metric-label">Allocation share</span><strong>{isPresentFiniteNumber(allocationPctTotal) ? `${allocationPctTotal.toFixed(1)}%` : 'Unavailable'}</strong><span className="ap-metric-help">From the backend recommendation</span></div>
            <div className="ap-summary-metric"><span className="ap-metric-label">Risk profile</span><strong>{riskLabel}</strong><span className="ap-metric-help">Suitability context</span></div>
          </div>
          <div className="ap-context-strip" aria-label="Plan context">
            <div className="ap-context-item"><Clock3 size={16} aria-hidden="true" /><span>Investment horizon</span><strong>{Number.isFinite(horizonYears) && horizonYears > 0 ? `${horizonYears} years` : 'Not provided'}</strong></div>
            <div className="ap-context-item"><Target size={16} aria-hidden="true" /><span>Goals in profile</span><strong>{goals.length > 0 ? goals.join(' · ') : 'Not provided'}</strong></div>
          </div>
        </motion.header>

        <PlanReviewPanel
          key={financialStateKey || 'no-financial-state'}
          profile={profile}
          profileId={profile?.profileId || recommendationMeta?.profileId}
          financialStateKey={financialStateKey}
          onRecomputePlan={onRecomputePlan}
        />

        <section className="ap-section ap-overview-section" aria-labelledby="portfolio-overview-title">
          <div className="ap-section-heading">
            <div><span className="ap-eyebrow">AT A GLANCE</span><h2 id="portfolio-overview-title">Portfolio overview</h2></div>
            <span className="ap-section-note">{assetClassCount} asset {assetClassCount === 1 ? 'class' : 'classes'}</span>
          </div>
          <div className="ap-overview-grid">
            <div className="ap-chart-panel">
              <div className="ap-chart-heading"><div><Layers size={16} aria-hidden="true" /><span>Allocation mix</span></div><span className="ap-muted-label">Monthly plan</span></div>
              <div className="ap-chart-wrap" role="region" aria-label="Investment allocation breakdown donut chart" aria-describedby="allocation-chart-description">
                <p id="allocation-chart-description" className="ap-sr-only">The chart shows the percentage and monthly amount assigned to each investment in the same order as the recommendation.</p>
                <div className="ap-donut-aura" aria-hidden="true" />
                <ResponsiveContainer width="100%" height={350} initialDimension={{ width: 1, height: 1 }}>
                  <PieChart>
                    <defs>
                      {SLICE_GRADIENTS.map(gradient => (
                        <linearGradient key={gradient.id} id={gradient.id} x1="0" y1="0" x2="1" y2="1">
                          <stop offset="0%" stopColor={gradient.stop1} />
                          <stop offset="100%" stopColor={gradient.stop2} />
                        </linearGradient>
                      ))}
                    </defs>
                    <Pie
                      data={allocation}
                      dataKey="allocationPct"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      innerRadius={104}
                      outerRadius={148}
                      paddingAngle={4}
                      cornerRadius={7}
                      stroke="#0b1220"
                      strokeWidth={3}
                      isAnimationActive={!prefersReducedMotion}
                      onMouseEnter={(_, index) => setHoveredSlice(allocation[index])}
                      onMouseLeave={() => setHoveredSlice(null)}
                    >
                      {allocation.map(item => (
                        <Cell
                          key={item.id}
                          fill={`url(#${item.gradId})`}
                          style={{
                            filter: `drop-shadow(0 5px 12px ${item.glowColor})`,
                            cursor: 'pointer',
                            transform: hoveredSlice?.id === item.id ? 'scale(1.035)' : 'scale(1)',
                            transformOrigin: 'center center',
                            transition: 'transform 180ms ease, filter 180ms ease',
                          }}
                        />
                      ))}
                    </Pie>
                    <RechartsTooltip content={<AllocationChartTooltip />} cursor={false} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="ap-donut-center" aria-hidden={Boolean(hoveredSlice)}>
                  <AnimatePresence mode="wait">
                    {hoveredSlice ? (
                      <motion.div key="hovered" className="ap-center-content" initial={prefersReducedMotion ? false : { opacity: 0, scale: 0.94 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
                        <span className="ap-center-kicker">{hoveredSlice.cat || 'Asset'}</span>
                        <strong>{hoveredSlice.allocationPct.toFixed(1)}%</strong>
                        <span>{formatCurrency(hoveredSlice.monthlyAmount)}/month</span>
                      </motion.div>
                    ) : (
                      <motion.div key="default" className="ap-center-content" initial={prefersReducedMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                        <span className="ap-center-kicker">MONTHLY ALLOCATION</span>
                        <strong>{formatCurrency(allocatedMonthlyTotal)}</strong>
                        <span>PER MONTH</span>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
              <div className="ap-legend-grid" aria-label="Allocation legend">
                {allocation.map(item => {
                  const isActive = hoveredSlice?.id === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`ap-legend-item ${isActive ? 'active' : ''}`}
                      style={{ '--legend-color': item.themeColor }}
                      aria-pressed={isActive}
                      onMouseEnter={() => setHoveredSlice(item)}
                      onMouseLeave={() => setHoveredSlice(null)}
                      onFocus={() => setHoveredSlice(item)}
                      onBlur={() => setHoveredSlice(null)}
                    >
                      <span className="ap-legend-dot" aria-hidden="true" />
                      <span className="ap-legend-name">{item.abbr || item.name}</span>
                      <strong>{item.allocationPct.toFixed(1)}%</strong>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="ap-overview-stats">
              <div className="ap-chart-heading">
                <div><PieChartIcon size={16} aria-hidden="true" /><span>Portfolio Structure</span></div>
                <span className="ap-muted-label">Asset breakdown</span>
              </div>

              <div className="ap-stat-lead">
                <div className="ap-stat-lead-top">
                  <span className="ap-eyebrow">MONTHLY ALLOCATION</span>
                  <span className="ap-lead-badge">
                    <Target size={11} aria-hidden="true" />
                    <span>{isPresentFiniteNumber(allocationPctTotal) ? `${allocationPctTotal.toFixed(1)}% allocated` : 'Allocation unavailable'}</span>
                  </span>
                </div>
                <strong>{formatCurrency(allocatedMonthlyTotal)}</strong>
                <div className="ap-stat-lead-sub">
                  <span>Allocated across <strong>{allocation.length} investment{allocation.length === 1 ? '' : 's'}</strong> in <strong>{categoryBreakdown.length} asset {categoryBreakdown.length === 1 ? 'class' : 'classes'}</strong></span>
                </div>
              </div>

              <div className="ap-stat-list" aria-label="Asset class breakdown">
                {categoryBreakdown.map(cat => (
                  <div key={cat.key} className="ap-stat-breakdown-row">
                    <div className="ap-stat-row-top">
                      <div className="ap-stat-row-label">
                        <span className="ap-stat-dot" style={{ backgroundColor: cat.color, boxShadow: `0 0 8px ${cat.color}` }} aria-hidden="true" />
                        <span className="ap-stat-name">{cat.label}</span>
                        <span className="ap-stat-count-pill">{cat.count} {cat.count === 1 ? 'holding' : 'holdings'}</span>
                      </div>
                      <div className="ap-stat-row-values">
                        <span className="ap-stat-amount">{formatCurrency(cat.amount)}/mo</span>
                        <strong className="ap-stat-pct" style={{ color: cat.color }}>{cat.pct.toFixed(1)}%</strong>
                      </div>
                    </div>
                    <div className="ap-stat-progress-track" role="progressbar" aria-label={`${cat.label}: ${cat.pct.toFixed(1)} percent`} aria-valuemin="0" aria-valuemax="100" aria-valuenow={cat.pct}>
                      <span
                        className="ap-stat-progress-fill"
                        style={{
                          width: `${Math.max(0, Math.min(100, cat.pct))}%`,
                          backgroundColor: cat.color,
                          boxShadow: `0 0 8px ${cat.color}66`
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>

              <div className="ap-stat-highlights" aria-label="Portfolio highlights">
                <div className="ap-stat-pill">
                  <ShieldCheck size={13} aria-hidden="true" />
                  <span>{riskLabel}</span>
                </div>
                <div className="ap-stat-pill">
                  <Layers size={13} aria-hidden="true" />
                  <span>{categoryBreakdown.length} Asset Classes</span>
                </div>
              </div>

              <div className="ap-overview-note">
                <ShieldCheck size={16} aria-hidden="true" />
                <span>Your allocation is presented in the recommendation order returned for your profile.</span>
              </div>
            </div>
          </div>
        </section>

        <section className="ap-section" aria-labelledby="investment-plan-title">
          <div className="ap-section-heading"><div><span className="ap-eyebrow">DETAILS</span><h2 id="investment-plan-title">Your investment plan</h2></div><span className="ap-section-note">Monthly contributions</span></div>
          <div className="ap-plan-grid">
            {allocation.map((item, index) => {
              const isActive = hoveredSlice?.id === item.id;
              const itemRiskColor = RISK_COLORS[item.riskLabel] || '#fbbf24';
              const displayType = formatSubtype(item.type || item.cat || item.category || 'Investment');
              const categoryDesc = getCategoryDescription(item);
              return (
                <motion.article
                  key={item.id}
                  className={`ap-plan-card ${isActive ? 'active-card' : ''}`}
                  style={{ '--card-accent': item.themeColor, '--card-glow': item.glowColor }}
                  initial={prefersReducedMotion ? false : { opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: prefersReducedMotion ? 0 : 0.08 + index * 0.05 }}
                  onMouseEnter={() => setHoveredSlice(item)}
                  onMouseLeave={() => setHoveredSlice(null)}
                >
                  <div className="ap-card-shimmer" aria-hidden="true" />
                  <div className="ap-plan-card-head">
                    <div className="ap-plan-card-identity">
                      <span className="ap-plan-icon">{getCategoryIcon(item.cat)}</span>
                      <div className="ap-plan-title-col">
                        <h3>{item.name}</h3>
                        <span className="ap-plan-type-tag">{displayType}</span>
                      </div>
                    </div>
                    <div className="ap-plan-percent-badge">
                      <span className="ap-plan-percent-dot" aria-hidden="true" />
                      <strong className="ap-plan-percent">{item.allocationPct.toFixed(1)}%</strong>
                    </div>
                  </div>
                  <div className="ap-plan-card-category-row">
                    <span className="ap-category-pill">
                      <span className="ap-cat-beacon" style={{ backgroundColor: item.themeColor }} />
                      <span className="ap-cat-text">{categoryDesc}</span>
                    </span>
                    <span className="ap-cat-target-label">Target share</span>
                  </div>
                  <div className="ap-progress-track" role="progressbar" aria-label={`${item.name}: ${item.allocationPct.toFixed(1)} percent allocation`} aria-valuemin="0" aria-valuemax="100" aria-valuenow={item.allocationPct}><span style={{ width: `${Math.max(0, Math.min(100, item.allocationPct))}%` }} /></div>
                  <div className="ap-plan-card-metrics">
                    <div className="ap-metric-cell">
                      <div className="ap-metric-cell-header">
                        <span className="ap-metric-cell-label">Monthly</span>
                      </div>
                      <strong className="ap-metric-cell-val ap-monthly-val">{formatCurrency(item.monthlyAmount)}</strong>
                    </div>
                    <div className="ap-metric-cell">
                      <div className="ap-metric-cell-header">
                        <PlanTerm term="Model return assumption" label="Model return" explanation="A versioned model input for planning. It is not a live rate, provider forecast, or guarantee." />
                      </div>
                      <strong className="ap-metric-cell-val ap-return-val">{isPresentFiniteNumber(item.nominalRate) ? `${Number(item.nominalRate)}%/yr` : 'Unavailable'}</strong>
                    </div>
                    <div className="ap-metric-cell">
                      <div className="ap-metric-cell-header">
                        <PlanTerm term="Risk" explanation="The risk classification supplied with this recommendation. It is shown as context, not a promise about future performance." />
                      </div>
                      <div className="ap-risk-value ap-metric-cell-val">
                        <strong className="ap-risk-pill" style={{ '--risk-tint': itemRiskColor, color: itemRiskColor }}>
                          <span className="ap-risk-dot" style={{ backgroundColor: itemRiskColor }} aria-hidden="true" />
                          {item.riskLabel}
                        </strong>
                      </div>
                    </div>
                  </div>
                  {item.concentrationBadge && <div className="ap-concentration"><Info size={14} aria-hidden="true" />{item.concentrationBadge}</div>}
                </motion.article>
              );
            })}
          </div>
        </section>

        <section className="ap-section ap-rationale-section" aria-labelledby="plan-fit-title">
          <div className="ap-section-heading"><div><span className="ap-eyebrow">THE WHY</span><h2 id="plan-fit-title">Why this plan fits</h2></div><Dialog.Root open={methodologyOpen} onOpenChange={setMethodologyOpen}><Dialog.Trigger asChild><button type="button" className="ap-text-button">View methodology <ArrowUpRight size={15} aria-hidden="true" /></button></Dialog.Trigger><Dialog.Portal><Dialog.Overlay className="ap-dialog-overlay" /><Dialog.Content className="ap-dialog-content"><div className="ap-dialog-kicker">PLAN CONTEXT</div><Dialog.Title className="ap-dialog-title">How this plan is built</Dialog.Title><Dialog.Description className="ap-dialog-description">These are the existing recommendation inputs made visible for clarity. They do not change the recommendation or calculate a new result.</Dialog.Description><dl className="ap-methodology-list">{methodologyRows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><div className="ap-dialog-advisory"><span>Technical advisory detail</span><p>{rationaleText}</p></div><Dialog.Close asChild><button type="button" className="ap-dialog-close">Close</button></Dialog.Close></Dialog.Content></Dialog.Portal></Dialog.Root></div>
          <div className="ap-rationale-box"><div className="ap-rationale-mark"><ShieldCheck size={18} aria-hidden="true" /></div><div><div className="ap-rationale-heading">Built around your profile</div><ul className="ap-rationale-list">{rationaleBullets.map((bullet, index) => <li key={`${bullet}-${index}`}>{bullet}</li>)}</ul></div></div>
        </section>

        <section className="ap-section ap-assumptions-section" aria-labelledby="plan-assumptions-title">
          <div className="ap-section-heading"><div><span className="ap-eyebrow">TRANSPARENCY</span><h2 id="plan-assumptions-title">Plan assumptions</h2></div><span className="ap-section-note">For context, not a promise</span></div>
          <div className="ap-assumptions-grid">
            <div className="ap-assumption-main"><div className="ap-assumption-label"><PlanTerm term="Portfolio model return assumption" explanation="A backend-weighted, pre-tax nominal model input used for planning. It is not a provider forecast or guaranteed outcome." /></div><strong>{Number.isFinite(blendedReturn) ? `${blendedReturn.toFixed(1)}%` : 'Unavailable'} <small>per year</small></strong><p>Backend-weighted, pre-tax nominal model assumption. Tax is calculated separately with explicit tax inputs.</p></div>
            <div className="ap-assumption-facts"><div><span>Allocation model</span><strong>Profile-based</strong></div><div><span>Risk context</span><strong>{riskLabel}</strong></div><div><span>Allocation share</span><strong>{isPresentFiniteNumber(allocationPctTotal) ? `${allocationPctTotal.toFixed(1)}%` : 'Unavailable'}</strong></div></div>
          </div>
        </section>
      </div>
    </Tooltip.Provider>
  );
};

export default AllocationPlanner;
