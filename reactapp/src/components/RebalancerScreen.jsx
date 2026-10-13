import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { Scale, HelpCircle, ShieldCheck, CheckCircle2, Check, TrendingUp, Calendar, Sparkles, ArrowRight, Shield, Wallet, PieChart } from 'lucide-react';
import { formatINR } from '../utils/indianNumberFormat';
import { isPresentFiniteNumber } from '../utils/financialValues';
import JargonTooltip from './JargonTooltip';
import * as api from '../services/api';
import { localToBackendInstrument } from '../utils/instrumentTypeMap';
import './RebalancerScreen.css';

const RISK_COLORS = {
  1: '#10b981', 2: '#34d399', 3: '#f59e0b', 4: '#ef4444', 5: '#dc2626',
  'Very Low': '#10b981', 'Low': '#34d399', 'Low-Medium': '#a3e635', 'Medium-Low': '#fbbf24',
  'Medium': '#f59e0b', 'High': '#ef4444', 'Very High': '#dc2626'
};

const getRiskLabelString = (inv) => {
  if (!inv) return 'Unavailable';
  if (inv.riskLabel) return inv.riskLabel;
  if (inv.risk_level) return inv.risk_level;
  if (typeof inv.risk === 'string') return inv.risk;
  const numToLabel = { 1: 'Very Low', 2: 'Low', 3: 'Medium', 4: 'High', 5: 'Very High' };
  return numToLabel[inv.risk] || 'Unavailable';
};

const AnimatedNumber = ({ value, duration = 800 }) => {
  const [displayValue, setDisplayValue] = useState(0);
  const hasValue = isPresentFiniteNumber(value);

  useEffect(() => {
    const end = hasValue ? parseInt(value) : 0;
    const startTime = performance.now();
    const startVal = 0;

    if (startVal === end) return;

    const animate = (currentTime) => {
      const elapsed = currentTime - startTime;
      if (elapsed >= duration) {
        setDisplayValue(end);
      } else {
        const progress = elapsed / duration;
        const easeProgress = progress * (2 - progress);
        setDisplayValue(Math.round(startVal + (end - startVal) * easeProgress));
        requestAnimationFrame(animate);
      }
    };

    const raf = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(raf);
  }, [duration, hasValue, value]);

  return <>{hasValue ? displayValue : '—'}</>;
};

const AnimatedCurrency = ({ value, duration = 800 }) => {
  const [displayValue, setDisplayValue] = useState(0);
  const hasValue = isPresentFiniteNumber(value);

  useEffect(() => {
    const start = 0;
    const end = hasValue ? parseInt(value) : 0;
    if (start === end) return;

    const startTime = performance.now();
    let raf;

    const animate = (currentTime) => {
      const elapsedTime = currentTime - startTime;
      if (elapsedTime >= duration) {
        setDisplayValue(end);
      } else {
        const progress = elapsedTime / duration;
        const easeProgress = progress * (2 - progress);
        const currentVal = Math.round(start + (end - start) * easeProgress);
        setDisplayValue(currentVal);
        raf = requestAnimationFrame(animate);
      }
    };

    raf = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(raf);
  }, [value, duration, hasValue]);

  return <>{hasValue ? formatINR(displayValue) : '—'}</>;
};


/**
 * Build display allocation percentages from the validated recommendation list.
 */
const buildAllocations = (recs) => {
  const allocs = {};
  const safeRecs = recs || [];

  safeRecs.forEach(inv => {
    if (!inv || !inv.id) return;
    const hasWeight = isPresentFiniteNumber(inv.allocationWeight);
    const pctCandidate = hasWeight
      ? Number(inv.allocationWeight) * 100
      : (isPresentFiniteNumber(inv.allocation_pct) ? Number(inv.allocation_pct) : null);
    if (!isPresentFiniteNumber(pctCandidate)) return;
    const pct = Number(pctCandidate);
    allocs[inv.id] = pct;
  });
  return allocs;
};

const toBackendAllocations = allocations => {
  const result = {};
  for (const [localId, percentage] of Object.entries(allocations)) {
    const key = localToBackendInstrument(localId);
    if (!key || percentage <= 0) continue;
    result[key] = (result[key] || 0) + (percentage / 100);
  }
  return result;
};

const buildCalculationBinding = ({ profile, recommendations, allocations, horizon, totalSavings }) => JSON.stringify({
  profile: profile ?? null,
  recommendations: recommendations ?? [],
  allocations: Object.entries(allocations || {}).sort(([left], [right]) => left.localeCompare(right)),
  horizon,
  totalSavings,
});

const RebalancerScreen = ({ profile, recommendations, onSave }) => {
  const totalSavingsCandidate = Number(profile?.monthly_savings);
  const totalSavings = Number.isFinite(totalSavingsCandidate) && totalSavingsCandidate > 0 ? totalSavingsCandidate : null;
  const horizonCandidate = Number(profile?.investment_horizon_years);
  const horizon = Number.isInteger(horizonCandidate) && horizonCandidate > 0 ? horizonCandidate : null;
  const projectionDisplayYear = horizon === null ? null : Math.min(10, horizon);
  const recs = useMemo(() => recommendations || [], [recommendations]);

  const [allocations, setAllocations] = useState(() => buildAllocations(recs));
  const calculationBinding = buildCalculationBinding({ profile, recommendations: recs, allocations, horizon, totalSavings });
  const allocationEditRevision = useRef(0);
  const optimizerRequestId = useRef(0);
  const projectionRequestId = useRef(0);
  const monteCarloRequestId = useRef(0);
  const [preset, setPreset] = useState('AI Recommended');
  const [prevRecs, setPrevRecs] = useState(recommendations);

  // The original recommended allocations — used to compute balance score
  const originalAllocations = useMemo(() => buildAllocations(recs), [recs]);

  // Sync allocations when recommendations change during render
  if (recommendations !== prevRecs) {
    setPrevRecs(recommendations);
    allocationEditRevision.current += 1;
    optimizerRequestId.current += 1;
    const newAllocs = buildAllocations(recommendations || []);
    setAllocations(newAllocs);
    setPreset('AI Recommended');
  }

  const [loadingProjection, setLoadingProjection] = useState(false);
  const [projectionState, setProjectionState] = useState({ binding: null, data: null, error: null });
  const projectionStateIsCurrent = projectionState.binding === calculationBinding;
  const projectionData = projectionStateIsCurrent ? projectionState.data : null;
  const projectionError = projectionStateIsCurrent ? projectionState.error : null;
  const projectionPending = loadingProjection || !projectionStateIsCurrent;
  const setProjectionError = useCallback(error => {
    setProjectionState({ binding: calculationBinding, data: null, error });
  }, [calculationBinding]);

  const fetchProjections = useCallback(async (currentAllocs, binding) => {
    const requestId = ++projectionRequestId.current;
    const isCurrent = () => requestId === projectionRequestId.current;
    try {
      setLoadingProjection(true);
      
      const profileId = profile?.profileId;
      if (!profileId) {
        throw new Error("No profile ID available");
      }

      if (!horizon || !totalSavings) throw new Error('Complete Financial Profile data is required');
      const response = await api.getCustomPortfolioProjection(
        profileId,
        toBackendAllocations(currentAllocs),
        horizon,
      );
      if (isCurrent()) setProjectionState({ binding, data: response, error: null });
    } catch (err) {
      if (isCurrent()) {
        setProjectionState({ binding, data: null, error: err.message });
      }
    } finally {
      if (isCurrent()) setLoadingProjection(false);
    }
  }, [profile?.profileId, horizon, totalSavings]);

  const [loadingMC, setLoadingMC] = useState(false);
  const [monteCarloState, setMonteCarloState] = useState({ binding: null, data: null, error: null });
  const monteCarloStateIsCurrent = monteCarloState.binding === calculationBinding;
  const mcData = monteCarloStateIsCurrent ? monteCarloState.data : null;
  const mcError = monteCarloStateIsCurrent ? monteCarloState.error : null;
  const monteCarloPending = loadingMC || !monteCarloStateIsCurrent;

  const fetchMonteCarlo = useCallback(async (currentAllocs, binding) => {
    const requestId = ++monteCarloRequestId.current;
    const isCurrent = () => requestId === monteCarloRequestId.current;
    try {
      setLoadingMC(true);
      
      const profileId = profile?.profileId;
      if (!profileId) {
        throw new Error("No profile ID available");
      }

      if (!projectionDisplayYear || !totalSavings) throw new Error('Complete Financial Profile data is required');
      const result = await api.runPortfolioMonteCarlo(
        profileId,
        toBackendAllocations(currentAllocs),
        projectionDisplayYear,
        null,
      );
      if (isCurrent()) setMonteCarloState({ binding, data: result, error: null });
    } catch (err) {
      if (isCurrent()) {
        setMonteCarloState({ binding, data: null, error: err.message });
      }
    } finally {
      if (isCurrent()) setLoadingMC(false);
    }
  }, [profile?.profileId, projectionDisplayYear, totalSavings]);

  // Debounce backend requests
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      if (!active) return;
      fetchProjections(allocations, calculationBinding);
      fetchMonteCarlo(allocations, calculationBinding);
    }, 300);

    return () => {
      active = false;
      clearTimeout(timer);
      projectionRequestId.current += 1;
      monteCarloRequestId.current += 1;
    };
  }, [allocations, calculationBinding, fetchProjections, fetchMonteCarlo]);

  const projectionResults = useMemo(() => {
    const point = projectionData?.performance_data?.find(item => item.year === projectionDisplayYear);
    return {
      wealth10y: isPresentFiniteNumber(point?.average) ? Number(point.average) : null,
      totalInvested10y: isPresentFiniteNumber(point?.invested) ? Number(point.invested) : null,
      estReturns: isPresentFiniteNumber(point?.gains) ? Number(point.gains) : null,
      wealthMultiple: isPresentFiniteNumber(point?.wealth_multiple) ? Number(point.wealth_multiple) : null,
    };
  }, [projectionData, projectionDisplayYear]);

  const thermometerRisk = useMemo(() => {
    const avgRisk = projectionData?.portfolio_risk_score;
    if (!Number.isFinite(avgRisk)) {
      return { avgRisk: null, positionPct: 0, label: 'Unavailable', color: '#64748b', desc: 'Waiting for the authoritative portfolio analysis.' };
    }
    const positionPct = ((avgRisk - 1) / 4) * 100;

    let label = 'Balanced';
    let color = '#34d399';
    let desc = 'A balanced approach with moderate fluctuations for steady growth.';
    if (avgRisk < 1.8) {
      label = 'Very Safe';
      color = '#10b981';
      desc = 'Expect steady, slow growth with minimum volatility.';
    } else if (avgRisk < 2.5) {
      label = 'Safe';
      color = '#34d399';
      desc = 'Expect stable returns with minor ups and downs.';
    } else if (avgRisk < 3.2) {
      label = 'Balanced';
      color = '#f59e0b';
      desc = 'A balanced approach with moderate fluctuations for steady growth.';
    } else if (avgRisk < 4.0) {
      label = 'Growth';
      color = '#f97316';
      desc = 'Focused on higher growth with noticeable ups and downs.';
    } else {
      label = 'High Growth';
      color = '#ef4444';
      desc = 'Expect larger ups and downs, but higher long-term growth.';
    }

    return { avgRisk, positionPct, label, color, desc };
  }, [projectionData]);

  const scenarioResults = useMemo(() => {
    return {
      p10: isPresentFiniteNumber(mcData?.percentile_summary?.p10) ? Number(mcData.percentile_summary.p10) : null,
      p50: isPresentFiniteNumber(mcData?.percentile_summary?.p50) ? Number(mcData.percentile_summary.p50) : null,
      p90: isPresentFiniteNumber(mcData?.percentile_summary?.p90) ? Number(mcData.percentile_summary.p90) : null,
    };
  }, [mcData]);

  const showEmergencyWarning = projectionData?.liquidity_warning === true;

  const summaryAllocation = projectionData?.asset_class_allocation || {};
  const monthlyInstrumentAllocations = projectionData?.monthly_instrument_allocations || {};

  const whyMixReasons = useMemo(() => {
    const goals = profile?.investment_goals || [];
    return [
      profile?.risk_tolerance
        ? `This mix was checked against your ${profile.risk_tolerance} Financial Profile suitability boundary.`
        : 'Financial Profile suitability is unavailable.',
      totalSavings === null
        ? 'Declared monthly investment capacity is unavailable.'
        : `The projection uses your declared monthly investment capacity of ${formatINR(totalSavings)}.`,
      horizon === null
        ? 'Financial Profile investment horizon is unavailable.'
        : `The calculation is limited to your ${horizon}-year profile horizon${goals.length ? ` and ${goals.join(', ')} goal${goals.length > 1 ? 's' : ''}` : ''}.`,
      `Backend suitability result: ${projectionData?.final_suitability_risk || 'awaiting analysis'}.`,
    ];
  }, [profile, totalSavings, horizon, projectionData]);

  // ─── Goals Integration for Investment Journey ──────────────────
  const [userGoals, setUserGoals] = useState([]);

  useEffect(() => {
    const fetchGoals = async () => {
      try {
        const goals = await api.getGoals();
        if (Array.isArray(goals)) setUserGoals(goals);
        else if (goals?.goals) setUserGoals(goals.goals);
      } catch {
        setUserGoals([]);
      }
    };
    fetchGoals();
  }, []);

  const weightedReturnRate = projectionData?.portfolio_nominal_return ?? null;

  const journeyMilestones = useMemo(() => {
    const performance = projectionData?.performance_data || [];
    const valueAt = year => performance.find(point => point.year === year)?.average ?? null;
    const milestones = [];

    // If user has real goals, map them into journey milestones
    if (userGoals.length > 0) {
      userGoals.forEach(g => {
        const yrs = Number(g.years_remaining);
        const amount = valueAt(yrs);
        if (!Number.isInteger(yrs) || yrs < 1 || yrs > horizon || amount === null) return;
        milestones.push({
          year: yrs,
          amount,
          label: g.goal_name || 'Your Goal',
          isGoal: true,
          targetAmount: Number(g.inflation_adjusted_target ?? g.target_amount),
        });
      });
    }

    const defaultYears = [...new Set([1, 3, 5, projectionDisplayYear, horizon])]
      .filter(year => year >= 1 && year <= horizon);
    const defaultMilestones = defaultYears.map(year => ({
      year,
      amount: valueAt(year),
      label: year === projectionDisplayYear ? 'Current projection' : `Projected value at year ${year}`,
      highlight: year === projectionDisplayYear,
    })).filter(milestone => isPresentFiniteNumber(milestone.amount));

    // If we have real goals, merge with defaults to fill gaps
    if (milestones.length > 0) {
      // Add any default milestones that don't overlap with goal years
      const goalYears = new Set(milestones.map(m => m.year));
      defaultMilestones.forEach(dm => {
        if (!goalYears.has(dm.year)) {
          milestones.push(dm);
        }
      });
      milestones.sort((a, b) => a.year - b.year);
      return milestones.slice(0, 5); // Cap at 5 milestones
    }

    return defaultMilestones;
  }, [projectionData, userGoals, horizon, projectionDisplayYear]);

  const readScore = (value) => {
    const scoreValue = Number(value);
    return Number.isFinite(scoreValue) && scoreValue >= 0 && scoreValue <= 100 ? scoreValue : null;
  };
  const score = readScore(projectionData?.allocation_match_pct);
  const riskScore = readScore(projectionData?.risk_match_pct);
  const goalScore = readScore(projectionData?.goal_horizon_match_pct);
  const affordabilityScore = readScore(projectionData?.affordability_match_pct);
  const recommendationMatch = readScore(projectionData?.recommendation_match_pct);
  const matchColor = recommendationMatch === null ? '#64748b' : recommendationMatch >= 90 ? '#10b981' : recommendationMatch >= 75 ? '#f59e0b' : '#ef4444';

  /**
   * Slider change handler - redistributes remaining % proportionally
   * among other instruments so total stays at 100%.
   */
  const handleSliderChange = useCallback((id, newPct) => {
    allocationEditRevision.current += 1;
    optimizerRequestId.current += 1;
    setPreset('Custom');
    setAllocations(prev => {
      const oldPct = prev[id] || 0;
      const diff = newPct - oldPct;
      const otherIds = Object.keys(prev).filter(k => k !== String(id));
      const otherTotal = otherIds.reduce((s, k) => s + (prev[k] || 0), 0);

      const newAllocs = { ...prev, [id]: newPct };

      if (otherTotal > 0) {
        otherIds.forEach(k => {
          const proportion = prev[k] / otherTotal;
          newAllocs[k] = Math.max(0, prev[k] - diff * proportion);
        });
      } else if (diff < 0 && otherIds.length > 0) {
        const split = Math.abs(diff) / otherIds.length;
        otherIds.forEach(k => {
          newAllocs[k] = split;
        });
      }

      // Re-normalize
      const total = Object.values(newAllocs).reduce((a, b) => a + b, 0);
      if (total > 0 && Math.abs(total - 100) > 0.01) {
        Object.keys(newAllocs).forEach(k => {
          newAllocs[k] = (newAllocs[k] / total) * 100;
        });
      }

      return newAllocs;
    });
  }, []);

  const handlePresetClick = useCallback(async (presetName) => {
    const strategyByPreset = {
      Safe: 'min_variance',
      Balanced: 'risk_parity',
      Growth: 'max_sharpe',
      'High Growth': 'max_return',
    };
    const profileId = profile?.profileId;
    if (!profileId) {
      setProjectionError('No Financial Profile ID is available');
      return;
    }
    const requestId = ++optimizerRequestId.current;
    const startingEditRevision = allocationEditRevision.current;
    const isCurrent = () => requestId === optimizerRequestId.current
      && startingEditRevision === allocationEditRevision.current;
    try {
      setLoadingProjection(true);
      setProjectionError(null);
      const assets = [...new Set(recs.map(inv => localToBackendInstrument(inv.id)))];
      const result = await api.optimisePortfolio(profileId, assets, strategyByPreset[presetName]);
      const next = {};
      recs.forEach(inv => {
        const weight = Number(result.weights?.[localToBackendInstrument(inv.id)]);
        if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
          throw new Error(`Optimizer returned an invalid weight for ${inv.name}`);
        }
        next[inv.id] = weight * 100;
      });
      if (!isCurrent()) return;
      allocationEditRevision.current += 1;
      setAllocations(next);
      setPreset(presetName);
    } catch (error) {
      if (isCurrent()) setProjectionError(error.message);
    } finally {
      if (requestId === optimizerRequestId.current) setLoadingProjection(false);
    }
  }, [profile?.profileId, recs, setProjectionError]);

  const handleSave = () => {
    const percentages = recs.map(inv => Number(allocations[inv.id]));
    if (percentages.some(pct => !Number.isFinite(pct) || pct < 0 || pct > 100)) {
      setProjectionError('Every allocation must be a valid percentage from 0 to 100.');
      return;
    }
    const totalPercentage = percentages.reduce((sum, pct) => sum + pct, 0);
    if (Math.abs(totalPercentage - 100) > 0.01) {
      setProjectionError(`Allocations must total exactly 100%; current total is ${totalPercentage.toFixed(2)}%.`);
      return;
    }
    const updated = recs.map((inv, index) => {
      const allocationWeight = Number((percentages[index] / 100).toFixed(6));
      return {
        ...inv,
        allocationWeight,
        allocation_pct: Number((allocationWeight * 100).toFixed(2)),
      };
    });
    if (onSave) onSave(updated);
  };

  return (
    <div className="rebalancer-page" style={{ maxWidth: '1200px', margin: '0 auto', padding: '24px 20px' }}>
      <div className="ambient-background">
        <div className="ambient-orb orb-1" />
        <div className="ambient-orb orb-2" />
        <div className="ambient-orb orb-3" />
      </div>

      {/* ─── Header ─── */}
      <motion.div
        className="page-header"
        initial={{ y: -24, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.1, type: "spring", stiffness: 100 }}
        style={{ marginBottom: '24px' }}
      >
        <div className="page-header-badge">
          <Scale size={12} />
          <span>Investment Mix</span>
        </div>
        <h1 className="page-title">
          Customize Your <span className="title-gradient">Investment Mix</span>
        </h1>
        <p className="page-subtitle">
          Decide how your monthly savings are split across different investments. Adjust the sliders below to match your comfort level.
        </p>
      </motion.div>

      {/* Two-Column Grid */}
      <div className="rebalancer-grid">
        
        <motion.div
          className="ai-recs-hero-card premium-glass"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <div className="ai-recs-header">
            <div className="ai-recs-title-row">
              <div className="ai-recs-sparkle-bg">
                <Sparkles className="ai-recs-sparkle-icon" size={18} />
              </div>
              <div>
                <h2 className="ai-recs-title">AI Recommended Mix</h2>
                <p className="ai-recs-subtitle">Server-evaluated portfolio proposal</p>
              </div>
            </div>
            <span className="ai-recs-badge">Target Match</span>
          </div>

          <div className="ai-recs-body">
            {recs.map(inv => {
              const origPct = originalAllocations[inv.id] || 0;
              if (origPct <= 0) return null;
              const riskLabel = getRiskLabelString(inv);
              const color = RISK_COLORS[riskLabel] || RISK_COLORS[inv.risk] || '#818cf8';
              return (
                <div key={inv.id} className="ai-rec-item">
                  <div className="ai-rec-item-info">
                    <div className="ai-rec-item-left">
                      <span className="ai-rec-item-name">{inv.name}</span>
                      <span 
                        className="ai-rec-item-risk-tag"
                        style={{ color: color, background: `${color}15`, borderColor: `${color}25` }}
                      >
                        {riskLabel} Risk
                      </span>
                    </div>
                    <span className="ai-rec-item-pct" style={{ color: color }}>{origPct.toFixed(0)}%</span>
                  </div>
                  <div className="ai-rec-progress-track">
                    <div 
                      className="ai-rec-progress-bar" 
                      style={{ width: `${origPct}%`, background: `linear-gradient(90deg, ${color}cc, ${color})` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          <div className="ai-recs-footer-container">
            <button
              type="button"
              onClick={() => {
                allocationEditRevision.current += 1;
                optimizerRequestId.current += 1;
                const targetAllocs = buildAllocations(recs);
                setAllocations(targetAllocs);
                setPreset('AI Recommended');
              }}
              className="btn-ai-recommendation-premium"
            >
              <span>Apply AI Recommended Mix</span>
              <ArrowRight size={16} className="btn-ai-arrow" />
            </button>
            <div className="ai-recs-caption">
              ⚡ Instantly overwrites the current sliders with the recommended split.
            </div>
          </div>
        </motion.div>

          <motion.div
            className="rebal-sliders-container premium-glass"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.28 }}
          >
            <div className="sliders-summary-header" style={{ marginBottom: 20 }}>
              <div className="sliders-header-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="sliders-header-label" style={{ fontSize: '1.1rem', fontWeight: 700, color: '#f8fafc' }}>
                  <JargonTooltip term="Asset Allocation">Your Investment Split</JargonTooltip>
                </span>
                <span className="sliders-total-badge" style={{ background: 'rgba(56, 189, 248, 0.1)', border: '1px solid rgba(56, 189, 248, 0.2)', padding: '4px 12px', borderRadius: '12px', fontSize: '0.82rem', color: '#38bdf8', fontWeight: 700 }}>
                  Total: 100%
                </span>
              </div>
              <p className="sliders-hint" style={{ fontSize: '0.85rem', color: '#94a3b8', marginTop: 6, marginBottom: 0 }}>
                Drag any slider to change how much of your savings goes into each investment. The rest will adjust automatically to keep the total at 100%.
              </p>
            </div>

            <div className="preset-selector-row">
              {['Safe', 'Balanced', 'Growth', 'High Growth'].map(name => {
                const isActive = preset === name;
                return (
                  <button
                    key={name}
                    type="button"
                    className={`preset-btn ${isActive ? 'active' : ''}`}
                    onClick={() => handlePresetClick(name)}
                  >
                    {name}
                  </button>
                );
              })}
            </div>
            {preset === 'Custom' && (
              <div className="custom-mix-badge-row">
                <span className="custom-mix-badge">
                  ⚠️ Custom Mix
                </span>
                <button
                  type="button"
                  onClick={() => {
                    allocationEditRevision.current += 1;
                    optimizerRequestId.current += 1;
                    setAllocations(originalAllocations);
                    setPreset('AI Recommended');
                  }}
                  className="btn-reset-ai"
                >
                  Reset to AI Mix
                </button>
              </div>
            )}

            {showEmergencyWarning && (
              <div className="emergency-warning-card">
                <span style={{ fontSize: '1.2rem', lineHeight: '1' }}>⚠️</span>
                <div>
                  <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#fca5a5', marginBottom: '2px' }}>Low Safe Assets Warning</div>
                  <div style={{ fontSize: '0.78rem', color: '#94a3b8', lineHeight: '1.4' }}>
                    Your safe allocation (Debt/Liquid/FD) is below 15%. Consider keeping 3–6 months of expenses in a Liquid Fund or Fixed Deposit for emergencies before investing aggressively in equity.
                  </div>
                </div>
              </div>
            )}

            {/* ─── Monthly Money Breakdown ─── */}
            <div className="rupee-summary-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '8px' }}>
                <span style={{ color: '#94a3b8', fontSize: '0.85rem', fontWeight: 600 }}>Monthly Money Breakdown</span>
                <span style={{ color: '#f8fafc', fontSize: '0.9rem', fontWeight: 700 }}>Total: {formatINR(totalSavings)}/month</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {recs.map(inv => {
                  const pct = Number(allocations[inv.id]) || 0;
                  const amountCandidate = Number(monthlyInstrumentAllocations[localToBackendInstrument(inv.id)]);
                  const amt = Number.isFinite(amountCandidate) ? amountCandidate : null;
                  if (pct <= 0) return null;
                  const riskLabel = getRiskLabelString(inv);
                  const color = RISK_COLORS[riskLabel] || '#64748b';
                  return (
                     <div key={inv.id} style={{ display: 'flex', alignItems: 'center', gap: '12px', fontSize: '0.9rem' }}>
                       <div style={{ width: '80px', height: '6px', borderRadius: '3px', background: 'rgba(255,255,255,0.05)', overflow: 'hidden', flexShrink: 0 }}>
                        <div style={{ width: `${pct}%`, height: '100%', borderRadius: '3px', background: color, transition: 'width 0.3s ease' }} />
                      </div>
                      <span style={{ color: '#e2e8f0', fontWeight: 600, flex: 1 }}>
                        {inv.name}
                      </span>
                      <span style={{ color: '#f8fafc', fontWeight: 700, minWidth: '70px', textAlign: 'right' }}>{formatINR(amt)}</span>
                      <span style={{ color: '#64748b', fontSize: '0.78rem', fontWeight: 600, minWidth: '36px', textAlign: 'right' }}>({pct.toFixed(0)}%)</span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="rebal-sliders" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {recs.map(inv => {
                const pct = Number(allocations[inv.id]) || 0;
                const amountCandidate = Number(monthlyInstrumentAllocations[localToBackendInstrument(inv.id)]);
                const amt = Number.isFinite(amountCandidate) ? amountCandidate : null;
                const riskLabel = getRiskLabelString(inv);
                const color = RISK_COLORS[riskLabel] || '#64748b';
                const isAllocated = pct > 0;

                return (
                  <div
                    key={inv.id}
                    className={`rebal-slider-row ${isAllocated ? 'allocated' : 'unallocated'}`}
                  >
                    <div className="slider-info-col" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <span className="slider-instrument-name" style={{ fontWeight: 600, color: isAllocated ? '#f1f5f9' : '#94a3b8', fontSize: '0.9rem' }}>{inv.name}</span>
                      <span className="slider-instrument-risk" style={{ color: isAllocated ? color : '#64748b', fontSize: '0.75rem', fontWeight: 600 }}>
                        {riskLabel} Risk
                      </span>
                    </div>
                    <div className="slider-range-col">
                      <input
                        type="range"
                        className="rebal-range"
                        aria-label={`Allocation percentage for ${inv.name}`}
                        min="0" max="100" step="0.5"
                        value={pct}
                        onChange={e => handleSliderChange(inv.id, Number(e.target.value))}
                        style={{
                          '--slider-color': isAllocated ? color : '#475569',
                          '--slider-pct': `${pct}%`
                        }}
                      />
                    </div>
                    <span className="slider-pct-value" style={{ color: isAllocated ? color : '#64748b', fontWeight: 700, fontSize: '0.9rem', textAlign: 'right' }}>
                      {pct.toFixed(0)}%
                    </span>
                    <span className={`slider-amount-value ${isAllocated ? 'allocated-label' : 'unallocated-label'}`} style={{ textAlign: 'right', fontWeight: 700, fontSize: '0.9rem', color: isAllocated ? '#f8fafc' : '#475569' }}>
                      {isAllocated ? formatINR(amt) : '₹0'}
                    </span>
                  </div>
                );
              })}
            </div>
          </motion.div>

          {/* Investment Journey Timeline Card */}
          <motion.div
            className="investment-journey-card premium-glass"
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.35 }}
          >
            <h3 className="journey-title">
              Your Investment Journey
            </h3>
            <p className="journey-subtitle">
              Where your {formatINR(totalSavings)}/mo SIP could take you
            </p>

            <div className="journey-timeline">
              {journeyMilestones.map((m, idx) => {
                return (
                  <div key={idx} className={`journey-milestone ${m.highlight ? 'highlight' : ''} ${m.isGoal ? 'is-goal' : ''}`}>
                    <div className="milestone-dot" />
                    <div className="milestone-content-row">
                      <span className="milestone-year">Year {m.year}</span>
                      <span className="milestone-amount">
                        <AnimatedCurrency value={m.amount} />
                      </span>
                      <span className="milestone-label">
                        {m.isGoal && <span className="milestone-goal-badge">Goal</span>}
                        {m.label}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            {userGoals.length > 0 && (
              <div className="journey-goals-note">
                Linked to {userGoals.length} goal{userGoals.length > 1 ? 's' : ''} from your Goal Planner
              </div>
            )}

            {/* Insight stats footer to fill empty space */}
            <div className="journey-insight-footer">
              <div className="journey-insight-stat">
                <div className="insight-value">
                  {formatINR(projectionResults.totalInvested10y)}
                </div>
                <div className="insight-label">Total Invested ({projectionDisplayYear}Y)</div>
              </div>
              <div className="journey-insight-stat">
                <div className="insight-value">
                  {weightedReturnRate === null ? '—' : weightedReturnRate.toFixed(1)}
                  <span className="insight-suffix">%</span>
                </div>
                <div className="insight-label">Nominal Return Assumption</div>
              </div>
              <div className="journey-insight-stat">
                <div className="insight-value">
                  {projectionResults.wealthMultiple ?? '—'}
                  <span className="insight-suffix">x</span>
                </div>
                <div className="insight-label">Wealth Multiplier</div>
              </div>
            </div>
          </motion.div>
          
          {/* Recommendation Match Card */}
          <motion.div
            className="recommendation-match-card premium-glass"
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.25 }}
          >
            <div className="match-card-header">
              <div className="match-header-info">
                <span className="match-title">Recommendation Match</span>
                <p className="match-subtitle">
                  How closely this custom plan matches your recommended advisor profile.
                </p>
              </div>

              <div 
                className="match-badge-premium" 
                style={{ color: matchColor, background: `${matchColor}12`, borderColor: `${matchColor}25` }}
              >
                <span className="match-badge-value">{recommendationMatch === null ? '—' : `${recommendationMatch}%`}</span>
                <span className="match-badge-label">
                  {recommendationMatch === null ? 'Unavailable' : recommendationMatch >= 90 ? 'Perfect' : recommendationMatch >= 75 ? 'Good' : recommendationMatch >= 50 ? 'Fair' : 'Poor'}
                </span>
              </div>
            </div>

            <div className="match-metrics-grid">
              <div className="match-metric-tile">
                <div className="match-metric-icon-wrap" style={{ '--icon-color': score === null ? '#64748b' : score >= 80 ? '#10b981' : '#f59e0b' }}>
                  <PieChart size={16} />
                </div>
                <div className="match-metric-details">
                  <span className="match-metric-label">Asset Allocation</span>
                  <span className="match-metric-value">{score === null ? 'Unavailable' : `${score}% Match`}</span>
                </div>
                <div className="match-metric-status" style={{ color: score === null ? '#64748b' : score >= 80 ? '#10b981' : '#f59e0b' }}>{score === null ? '—' : '✓'}</div>
              </div>

              <div className="match-metric-tile">
                <div className="match-metric-icon-wrap" style={{ '--icon-color': riskScore === null ? '#64748b' : riskScore >= 80 ? '#10b981' : '#f59e0b' }}>
                  <Shield size={16} />
                </div>
                <div className="match-metric-details">
                  <span className="match-metric-label">Risk Profile</span>
                  <span className="match-metric-value">{profile?.risk_tolerance || 'Unavailable'}</span>
                </div>
                <div className="match-metric-status" style={{ color: riskScore === null ? '#64748b' : riskScore >= 80 ? '#10b981' : '#f59e0b' }}>{riskScore === null ? '—' : '✓'}</div>
              </div>

              <div className="match-metric-tile">
                <div className="match-metric-icon-wrap" style={{ '--icon-color': goalScore === null ? '#64748b' : goalScore >= 80 ? '#10b981' : '#f59e0b' }}>
                  <Calendar size={16} />
                </div>
                <div className="match-metric-details">
                  <span className="match-metric-label">Goal Horizon</span>
                  <span className="match-metric-value">{horizon === null ? 'Unavailable' : `${horizon} Years`}</span>
                </div>
                <div className="match-metric-status" style={{ color: goalScore === null ? '#64748b' : goalScore >= 80 ? '#10b981' : '#f59e0b' }}>{goalScore === null ? '—' : '✓'}</div>
              </div>

              <div className="match-metric-tile">
                <div className="match-metric-icon-wrap" style={{ '--icon-color': affordabilityScore === null ? '#64748b' : affordabilityScore >= 80 ? '#10b981' : '#f59e0b' }}>
                  <Wallet size={16} />
                </div>
                <div className="match-metric-details">
                  <span className="match-metric-label">Monthly SIP</span>
                  <span className="match-metric-value">{formatINR(totalSavings)}</span>
                </div>
                <div className="match-metric-status" style={{ color: affordabilityScore === null ? '#64748b' : affordabilityScore >= 80 ? '#10b981' : '#f59e0b' }}>{affordabilityScore === null ? '—' : '✓'}</div>
              </div>
            </div>
          </motion.div>

          {/* Future Wealth Projection Card */}
          <motion.div
            className="projection-card premium-glass"
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
          >
            <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#f8fafc', marginBottom: '16px', marginTop: 0 }}>
              Future Wealth Projection
            </h2>

            {projectionPending ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div style={{ height: '20px', width: '60%', borderRadius: '4px', background: 'rgba(255,255,255,0.05)', animation: 'pulse 1.5s infinite ease-in-out' }} />
                <div style={{ height: '60px', width: '100%', borderRadius: '8px', background: 'rgba(255,255,255,0.05)', animation: 'pulse 1.5s infinite ease-in-out' }} />
                <div style={{ height: '20px', width: '80%', borderRadius: '4px', background: 'rgba(255,255,255,0.05)', animation: 'pulse 1.5s infinite ease-in-out' }} />
              </div>
            ) : projectionError ? (
              <div role="alert" style={{ color: '#fda4af', padding: '16px', borderRadius: 12, background: 'rgba(244,63,94,.06)', border: '1px solid rgba(244,63,94,.18)', fontSize: '0.8rem' }}>
                Projection unavailable: {projectionError}. No offline estimate is shown.
              </div>
            ) : (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
                  <span style={{ fontSize: '0.88rem', color: '#94a3b8' }}>Monthly Investment</span>
                  <span style={{ fontSize: '1rem', fontWeight: 700, color: '#f8fafc' }}>{formatINR(totalSavings)}/mo</span>
                </div>
                
                <div style={{ background: 'rgba(56, 189, 248, 0.05)', border: '1px solid rgba(56, 189, 248, 0.1)', borderRadius: '12px', padding: '16px', marginBottom: '16px', textAlign: 'center' }}>
                  <div style={{ fontSize: '0.8rem', color: '#38bdf8', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1px', marginBottom: '4px' }}>Estimated Value ({projectionDisplayYear} Years)</div>
                  <div style={{ fontSize: '2rem', fontWeight: 800, color: '#f8fafc' }}><AnimatedCurrency value={projectionResults.wealth10y} /></div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.88rem' }}>
                  <span style={{ color: '#94a3b8' }}>Estimated Returns</span>
                  <span style={{ fontWeight: 700, color: isPresentFiniteNumber(projectionResults.estReturns) && projectionResults.estReturns < 0 ? '#f87171' : '#10b981' }}>
                    {isPresentFiniteNumber(projectionResults.estReturns) && projectionResults.estReturns >= 0 ? '+' : ''}<AnimatedCurrency value={projectionResults.estReturns} />
                  </span>
                </div>

              </div>
            )}
          </motion.div>

          {/* Risk Thermometer Card */}
          <motion.div
            className="risk-thermometer-card premium-glass"
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.32 }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <span style={{ fontSize: '1.1rem', fontWeight: 700, color: '#f8fafc' }}>Your Risk Profile</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ height: '8px', width: '8px', borderRadius: '50%', background: thermometerRisk.color }} />
                <span style={{ fontSize: '0.88rem', fontWeight: 700, color: thermometerRisk.color }}>
                  {thermometerRisk.label}
                </span>
              </div>
            </div>

            <div className="thermometer-wrapper">
              {/* Thermometer track */}
              <div className="thermometer-track" />
              {/* Indicator dot */}
              {thermometerRisk.avgRisk !== null && (
                <div
                  className="thermometer-indicator"
                  style={{
                    '--risk-color': thermometerRisk.color,
                    left: `${thermometerRisk.positionPct}%`
                  }}
                />
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: '#64748b', fontWeight: 600 }}>
              <span>Safe</span>
              <span>Balanced</span>
              <span>High Growth</span>
            </div>
          </motion.div>

          {/* Market Scenarios Card */}
          <motion.div
            className="scenarios-card premium-glass"
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.34 }}
          >
            <h2 style={{ fontSize: '1.1rem', fontWeight: 700, color: '#f8fafc', marginBottom: '16px', marginTop: 0 }}>
              Market Scenario Projections ({projectionDisplayYear} Years)
            </h2>

            {monteCarloPending ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ height: '48px', width: '100%', borderRadius: '8px', background: 'rgba(255,255,255,0.05)', animation: 'pulse 1.5s infinite ease-in-out' }} />
                <div style={{ height: '48px', width: '100%', borderRadius: '8px', background: 'rgba(255,255,255,0.05)', animation: 'pulse 1.5s infinite ease-in-out' }} />
                <div style={{ height: '48px', width: '100%', borderRadius: '8px', background: 'rgba(255,255,255,0.05)', animation: 'pulse 1.5s infinite ease-in-out' }} />
              </div>
            ) : mcError ? (
              <div role="alert" style={{ color: '#fda4af', padding: '14px', borderRadius: 10, background: 'rgba(244,63,94,.06)', border: '1px solid rgba(244,63,94,.18)', fontSize: '0.78rem' }}>
                Monte Carlo simulation unavailable: {mcError}. No local percentile fallback is shown.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                
                {/* Simulated 10th percentile */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(239, 68, 68, 0.03)', border: '1px solid rgba(239, 68, 68, 0.08)', borderRadius: '12px', padding: '12px 16px' }}>
                  <div>
                    <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#fca5a5' }}>
                      <JargonTooltip term="P10">Simulated 10th Percentile (P10)</JargonTooltip>
                    </div>
                    <div style={{ fontSize: '0.72rem', color: '#94a3b8', marginTop: '2px' }}>90% of modeled paths ended above this value</div>
                  </div>
                  <div style={{ fontSize: '1.1rem', fontWeight: 800, color: '#f8fafc' }}><AnimatedCurrency value={scenarioResults.p10} /></div>
                </div>

                {/* Simulated median */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(56, 189, 248, 0.03)', border: '1px solid rgba(56, 189, 248, 0.08)', borderRadius: '12px', padding: '12px 16px' }}>
                  <div>
                    <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#38bdf8' }}>
                      <JargonTooltip term="P50">Simulated Median (P50)</JargonTooltip>
                    </div>
                    <div style={{ fontSize: '0.72rem', color: '#94a3b8', marginTop: '2px' }}>50% of modeled paths ended above this value</div>
                  </div>
                  <div style={{ fontSize: '1.1rem', fontWeight: 800, color: '#f8fafc' }}><AnimatedCurrency value={scenarioResults.p50} /></div>
                </div>

                {/* Simulated 90th percentile */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(16, 185, 129, 0.03)', border: '1px solid rgba(16, 185, 129, 0.08)', borderRadius: '12px', padding: '12px 16px' }}>
                  <div>
                    <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#6ee7b7' }}>
                      <JargonTooltip term="P90">Simulated 90th Percentile (P90)</JargonTooltip>
                    </div>
                    <div style={{ fontSize: '0.72rem', color: '#94a3b8', marginTop: '2px' }}>10% of modeled paths ended above this value</div>
                  </div>
                  <div style={{ fontSize: '1.1rem', fontWeight: 800, color: '#f8fafc' }}><AnimatedCurrency value={scenarioResults.p90} /></div>
                </div>

              </div>
            )}
          </motion.div>

          {/* Why This Mix Card */}
          <motion.div
            className="why-mix-details-card premium-glass"
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.36 }}
          >
            <h2 className="journey-title">
              Why This Mix Fits You
            </h2>
            <p className="journey-subtitle" style={{ marginBottom: '20px' }}>
              Personalised to your financial profile
            </p>
            
            <div className="why-mix-reasons-list">
              {whyMixReasons.map((reason, idx) => {
                let title = 'Investment Benefit';
                if (idx === 0) title = 'Suitability Boundary';
                else if (idx === 1) title = 'Declared SIP Capacity';
                else if (idx === 2) title = 'Goal-Aligned Timeline';
                else if (idx === 3) title = 'Backend Risk Review';

                return (
                  <div key={idx} className="why-mix-reason-item">
                    <div className="why-mix-check">
                      <Check size={13} strokeWidth={3} />
                    </div>
                    <div>
                      <div className="why-mix-reason-title">{title}</div>
                      <div className="why-mix-reason-desc">
                        {reason}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="why-mix-footer">
              <div className="why-mix-footer-dot" />
              Analysis based on your profile, goals & risk appetite
            </div>
          </motion.div>
          {/* Investment Summary (Save section) */}
          <motion.div
            className="confirmation-summary-card premium-glass"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
            style={{ marginTop: '12px' }}
          >
            <h2 style={{ fontSize: '1.2rem', fontWeight: 800, color: '#f8fafc', margin: '0 0 20px 0', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <ShieldCheck size={20} color="#818cf8" /> Investment Summary
            </h2>
            
            <div className="summary-stats-grid">
              
              {/* Stat 1: Monthly SIP */}
              <div className="summary-stat-card">
                <div className="summary-stat-label">Monthly SIP</div>
                <div className="summary-stat-value">
                  {formatINR(totalSavings)}
                </div>
              </div>

              {/* Stat 2: Allocation Overview */}
              <div className="summary-stat-card">
                <div className="summary-stat-label">Allocation</div>
                
                <div className="mini-allocation-track">
                  {summaryAllocation.equity > 0 && (
                    <div className="track-segment segment-equity" style={{ width: `${summaryAllocation.equity}%` }} />
                  )}
                  {summaryAllocation.etf > 0 && (
                    <div className="track-segment segment-etf" style={{ width: `${summaryAllocation.etf}%` }} />
                  )}
                  {summaryAllocation.debt > 0 && (
                    <div className="track-segment segment-debt" style={{ width: `${summaryAllocation.debt}%` }} />
                  )}
                </div>

                <div className="mini-allocation-tags">
                  {summaryAllocation.equity > 0 && (
                    <span className="allocation-tag">
                      <span className="tag-dot dot-equity" />
                      {summaryAllocation.equity}% Equity
                    </span>
                  )}
                  {summaryAllocation.etf > 0 && (
                    <span className="allocation-tag">
                      <span className="tag-dot dot-etf" />
                      {summaryAllocation.etf}% ETF
                    </span>
                  )}
                  {summaryAllocation.debt > 0 && (
                    <span className="allocation-tag">
                      <span className="tag-dot dot-debt" />
                      {summaryAllocation.debt}% Debt
                    </span>
                  )}
                </div>
              </div>

              {/* Stat 3: Expected Value */}
              <div className="summary-stat-card">
                <div className="summary-stat-label">Expected Value ({projectionDisplayYear}Y)</div>
                <div className="summary-stat-value value-blue">
                  {projectionPending ? (
                    <span style={{ fontSize: '1rem', color: '#64748b' }}>Calculating...</span>
                  ) : (
                    <>{Number.isFinite(projectionResults.wealth10y) ? formatINR(projectionResults.wealth10y) : '—'}</>
                  )}
                </div>
              </div>

              {/* Stat 4: Recommendation Match */}
              <div className="summary-stat-card">
                <div className="summary-stat-label">Recommendation Match</div>
                <div className="summary-stat-value value-green" style={{ color: matchColor }}>
                  {recommendationMatch === null ? '—' : <><AnimatedNumber value={recommendationMatch} />%</>}
                </div>
              </div>

            </div>

            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
              <button 
                type="button"
                className="btn-primary-glow" 
                onClick={handleSave}
                style={{ width: '100%', maxWidth: '380px', padding: '14px 28px', fontSize: '1rem', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px' }}
              >
                <ShieldCheck size={20} />
                Save My Investment Mix
              </button>
              <p className="cta-helper-text">
                This will save your chosen investment split and update all your projections
              </p>
            </div>
          </motion.div>

      </div>
    </div>
  );
};

export default RebalancerScreen;
