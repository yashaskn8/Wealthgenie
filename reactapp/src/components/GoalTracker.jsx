import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Target, Palmtree, Diamond, FileText, Shield, TrendingUp, AlertTriangle, CheckCircle, Clock, IndianRupee, Lightbulb, Wallet, Save, Sparkles, RefreshCw, Layers, Trash2, Umbrella, Home, GraduationCap, Car } from 'lucide-react';
import { formatINR } from '../utils/indianNumberFormat';
import api from '../services/api';
import './GoalTracker.css';
import { getGoalTypeByLabel, hexToRgb } from '../config/goalCatalog';
import { isAdvisoryFresh, isFinancialCalculationFresh } from '../utils/financialFreshness';
import { isPresentFiniteNumber } from '../utils/financialValues';

const ICON_MAP = {
  Umbrella,
  Home,
  GraduationCap,
  Shield,
  Car,
  Sparkles,
  TrendingUp,
  FileText,
  Palmtree,
  Diamond,
  Target,
};

/* Presentation metadata only. Target, SIP, status, horizon, and projection values
 * remain server-owned custom-goal outputs. */
function getDisplayDefaults(goal) {
  const catalog = getGoalTypeByLabel(goal?.goal_name);
  const color = catalog?.color || '#0ea5e9';
  return {
    icon: ICON_MAP[catalog?.Icon] || Target,
    themeColor: color,
    themeColorRGB: catalog?.themeColorRGB || hexToRgb(color),
    description: `Custom goal ending ${new Date(goal.target_date).toLocaleDateString('en-IN')}`,
    tip: '',
    priority: goal.priority || 'Unspecified',
  };
}

function formatShort(val) {
  if (!isPresentFiniteNumber(val)) return '—';
  const numericValue = Number(val);
  if (numericValue >= 10000000) return `₹${(numericValue / 10000000).toFixed(2)} Cr`;
  if (numericValue >= 100000) return `₹${(numericValue / 100000).toFixed(1)}L`;
  if (numericValue >= 1000) return `₹${(numericValue / 1000).toFixed(0)}K`;
  return `₹${numericValue}`;
}

const PRIORITY_CONFIG = {
  Critical: { color: '#ef4444', bg: 'rgba(239, 68, 68, 0.15)', border: 'rgba(239, 68, 68, 0.3)' },
  High:     { color: '#f97316', bg: 'rgba(249, 115, 22, 0.15)', border: 'rgba(249, 115, 22, 0.3)' },
  Medium:   { color: '#0ea5e9', bg: 'rgba(14, 165, 233, 0.15)', border: 'rgba(14, 165, 233, 0.3)' },
  Low:      { color: '#64748b', bg: 'rgba(100, 116, 139, 0.15)', border: 'rgba(100, 116, 139, 0.3)' },
};

const MAX_TARGET = 1000000000;
const MAX_SAVED = 500000000;
const MILLISECONDS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;
const MAX_GOAL_HORIZON_YEARS = 30;

function getGoalRecalculationHorizonStatus(targetDate, now = new Date()) {
  const parsedTargetDate = targetDate ? new Date(targetDate) : null;
  if (!parsedTargetDate || Number.isNaN(parsedTargetDate.getTime())) return 'invalid';
  if (parsedTargetDate <= now) return 'past';
  const maximumSupportedTargetDate = new Date(now);
  maximumSupportedTargetDate.setFullYear(maximumSupportedTargetDate.getFullYear() + MAX_GOAL_HORIZON_YEARS);
  if (parsedTargetDate > maximumSupportedTargetDate) return 'beyond-maximum';
  const modeledMonths = Math.round(((parsedTargetDate - now) / MILLISECONDS_PER_YEAR) * 12);
  return modeledMonths >= 1 ? 'supported' : 'below-minimum';
}

function clampValue(val, min = 0, max = MAX_TARGET) {
  if (val === '') return '';
  const num = Number(val);
  if (isNaN(num) || !isFinite(num)) return min;
  return Math.max(min, Math.min(max, Math.round(num)));
}

/* ─── Goal Card ───────────────────────────────────────────────────── */
const GoalCard = ({ 
  goalName, 
  defaults, 
  goalObj, 
  onSaveUpdates, 
  onRecalculate,
  onDeleteGoal,
  profileScopeLabel,
  isEditable,
  monthlyAllocation, 
  horizon, 
  index, 
  totalSavings 
}) => {
  // Target facts are editable; every computed value is read from the stored backend goal.
  const isDbGoal = !!goalObj;
  const isCalculationFresh = isFinancialCalculationFresh(goalObj?.calculation_freshness);
  const recalculationHorizonStatus = getGoalRecalculationHorizonStatus(goalObj?.target_date);
  const initialTarget = isDbGoal ? goalObj.target_amount : defaults.target;
  const initialSaved = isDbGoal ? goalObj.current_savings : defaults.currentSaved;

  const [target, setTarget] = useState(initialTarget);
  const [currentSaved, setCurrentSaved] = useState(initialSaved);
  const [isUpdating, setIsUpdating] = useState(false);
  const syncedGoalFacts = useRef({ target: initialTarget, currentSaved: initialSaved });

  // State is initialized from these facts on mount. Only a later authoritative
  // prop change should reset the edit buffer; a no-op mount effect must not
  // overwrite a user edit that happens before passive effects are flushed.
  useEffect(() => {
    const previous = syncedGoalFacts.current;
    const targetChanged = !Object.is(previous.target, initialTarget);
    const savingsChanged = !Object.is(previous.currentSaved, initialSaved);
    if (!targetChanged && !savingsChanged) return;
    syncedGoalFacts.current = { target: initialTarget, currentSaved: initialSaved };
    setTarget(initialTarget);
    setCurrentSaved(initialSaved);
  }, [initialTarget, initialSaved]);

  const actualTarget = isPresentFiniteNumber(target) && Number(target) > 0 ? Number(target) : null;
  const actualSaved = isPresentFiniteNumber(currentSaved) && Number(currentSaved) >= 0 ? Number(currentSaved) : null;
  const projectedCandidate = isCalculationFresh && isPresentFiniteNumber(goalObj?.monte_carlo_summary?.p50)
    ? Number(goalObj.monte_carlo_summary.p50)
    : NaN;
  const hasProjection = Number.isFinite(projectedCandidate) && projectedCandidate >= 0;
  const projectedValue = hasProjection ? projectedCandidate : null;

  // MC projections target the inflation-adjusted amount, so compare against that
  const comparisonTargetCandidate = isCalculationFresh && isPresentFiniteNumber(goalObj?.inflation_adjusted_target)
    ? Number(goalObj.inflation_adjusted_target)
    : NaN;
  const hasComparisonTarget = Number.isFinite(comparisonTargetCandidate) && comparisonTargetCandidate > 0;
  const comparisonTarget = hasComparisonTarget ? comparisonTargetCandidate : null;

  const progressPercent = actualSaved !== null && actualTarget !== null
    ? Math.min((actualSaved / actualTarget) * 100, 100)
    : null;
  const projectedPercent = hasProjection && hasComparisonTarget
    ? Math.min((projectedValue / comparisonTarget) * 100, 100)
    : 0;

  const isFullyFunded = isCalculationFresh && goalObj?.status === 'on_track';
  const gapCandidate = isCalculationFresh && isPresentFiniteNumber(goalObj?.gap_amount)
    ? Number(goalObj.gap_amount)
    : NaN;
  const hasGap = Number.isFinite(gapCandidate) && gapCandidate >= 0;
  const gap = hasGap ? gapCandidate : null;
  const gapPositive = !isFullyFunded && hasGap && gap > 0;

  const completionPct = hasProjection && hasComparisonTarget
    ? Math.min(Math.round((projectedValue / comparisonTarget) * 100), 999)
    : null;

  let status, statusClass, StatusIcon;
  if (isCalculationFresh && goalObj?.status === 'on_track') {
    status = 'On Track (Highly Likely)'; statusClass = 'status--ontrack'; StatusIcon = CheckCircle;
  } else if (isDbGoal && isCalculationFresh) {
    if (goalObj.status === 'at_risk') {
      status = 'Slightly Behind (Needs Boost)'; statusClass = 'status--almost'; StatusIcon = TrendingUp;
    } else if (goalObj.status === 'off_track') {
      status = 'Off Track (Action Required)'; statusClass = 'status--behind'; StatusIcon = AlertTriangle;
    } else {
      status = 'Projection Unavailable'; statusClass = 'status--behind'; StatusIcon = Clock;
    }
  } else if (isDbGoal) {
    status = 'Recalculation Required'; statusClass = 'status--warning'; StatusIcon = AlertTriangle;
  } else { status = 'Awaiting Backend Plan'; statusClass = 'status--behind'; StatusIcon = AlertTriangle; }

  const IconComponent = defaults.icon || Target;
  const priority = isDbGoal ? goalObj.priority || 'Unspecified' : defaults.priority || 'Unspecified';

  const initialTargetValue = isPresentFiniteNumber(initialTarget) && Number(initialTarget) > 0 ? Number(initialTarget) : null;
  const initialSavedValue = isPresentFiniteNumber(initialSaved) && Number(initialSaved) >= 0 ? Number(initialSaved) : null;
  const hasValidEditableFacts = actualTarget !== null && actualSaved !== null;
  const hasChanged = hasValidEditableFacts && (
    (initialTargetValue === null ? actualTarget !== null : actualTarget !== initialTargetValue)
    || (initialSavedValue === null ? actualSaved !== null : actualSaved !== initialSavedValue)
  );

  const handleCommitUpdates = async () => {
    if (!isDbGoal || !isEditable) return;
    setIsUpdating(true);
    try {
      await onSaveUpdates(goalObj._id || goalObj.goalId, {
        expectedVersion: goalObj.version ?? 1,
        target_amount: actualTarget,
        current_savings: actualSaved,
      });
    } catch (e) {
      console.error(e);
    } finally {
      setIsUpdating(false);
    }
  };

  const handleRecalculate = async () => {
    if (!isDbGoal || !isEditable || !hasValidEditableFacts || hasChanged) return;
    setIsUpdating(true);
    try {
      // Explicitly re-use the persisted facts. This PATCH triggers the
      // authoritative calculation without asking the user to edit an amount.
      await onRecalculate(goalObj._id || goalObj.goalId, {
        expectedVersion: goalObj.version ?? 1,
        target_amount: initialTargetValue,
        current_savings: initialSavedValue,
      });
    } catch (e) {
      console.error(e);
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <motion.div
      className="goal-card-item premium-glass"
      style={{
        '--theme-color': defaults.themeColor || '#6366f1',
        '--theme-color-rgb': defaults.themeColorRGB || '99, 102, 241'
      }}
      initial={{ opacity: 0, y: 30 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.1 + (index * 0.05), type: 'spring', stiffness: 100, damping: 20 }}
      whileHover={{ y: -4, transition: { duration: 0.2 } }}
    >
      <div className="card-glow-bg"></div>

      {/* Header */}
      <div className="goal-card-header">
        <div className="goal-card-icon-wrapper" style={{ boxShadow: `0 0 20px rgba(${defaults.themeColorRGB || '99,102,241'}, 0.2)` }}>
          <IconComponent size={20} color={defaults.themeColor || '#6366f1'} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h3 className="goal-card-title">{goalName}</h3>
            <span className={`goal-priority-badge badge-glow-${priority === 'Critical' ? 'rose' : priority === 'High' ? 'amber' : priority === 'Medium' ? 'cyan' : 'emerald'}`} style={{
              fontSize: '0.65rem', padding: '2px 8px', borderRadius: 6, fontWeight: 800,
              textTransform: 'uppercase', letterSpacing: '0.6px'
            }}>
              {priority}
            </span>
            <span className="goal-profile-scope" style={{
              fontSize: '0.62rem', padding: '2px 7px', borderRadius: 6, fontWeight: 700,
              color: profileScopeLabel === 'Current profile' ? '#67e8f9' : '#cbd5e1',
              background: profileScopeLabel === 'Current profile' ? 'rgba(6, 182, 212, 0.12)' : 'rgba(148, 163, 184, 0.12)',
              border: '1px solid rgba(148, 163, 184, 0.24)',
            }}>{profileScopeLabel}</span>
          </div>
          <p className="goal-card-desc">{isDbGoal && isCalculationFresh && goalObj.recommended_instrument ? `Saving through ${goalObj.recommended_instrument.replace('_', ' ')}` : defaults.description}</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto', flexShrink: 0 }}>
          <span className={`goal-status-badge ${statusClass}`} style={{ margin: 0 }}>
            <StatusIcon size={12} style={{ marginRight: 4 }} /> {status}
          </span>
          {isDbGoal && (
            <button
              onClick={() => onDeleteGoal(goalObj._id || goalObj.goalId)}
              className="goal-delete-btn"
              title="Delete Goal"
              style={{
                background: 'rgba(244, 63, 94, 0.1)',
                border: '1px solid rgba(244, 63, 94, 0.2)',
                borderRadius: '50%',
                width: 32,
                height: 32,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#f43f5e',
                cursor: 'pointer',
                transition: 'all 0.2s',
                padding: 0,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(244, 63, 94, 0.2)';
                e.currentTarget.style.boxShadow = '0 0 10px rgba(244, 63, 94, 0.3)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(244, 63, 94, 0.1)';
                e.currentTarget.style.boxShadow = 'none';
              }}
            >
              <Trash2 size={15} />
            </button>
          )}
        </div>
      </div>

      {/* Inputs */}
      <div className="goal-inputs-row">
        <div className="goal-input-group">
          <div className="goal-input-label-row">
            <label><Target size={12} style={{marginRight:4, color:'#38bdf8'}} /> Goal Target</label>
            <span className="goal-input-hint-badge">{formatShort(actualTarget)}</span>
          </div>
          <div className="goal-input-wrapper">
            <span className="goal-input-prefix">₹</span>
            <input
              type="number"
              value={target ?? ''}
              placeholder="0"
              min={1000}
              max={MAX_TARGET}
              disabled={!isEditable}
              onChange={e => setTarget(clampValue(e.target.value, 1000, MAX_TARGET))}
              className="goal-amount-input"
            />
          </div>
        </div>
        <div className="goal-input-group">
          <div className="goal-input-label-row">
            <label><Wallet size={12} style={{marginRight:4, color:'#10b981'}} /> Current Savings</label>
            <span className="goal-input-hint-badge">{formatShort(actualSaved)}</span>
          </div>
          <div className="goal-input-wrapper">
            <span className="goal-input-prefix">₹</span>
            <input
              type="number"
              value={currentSaved ?? ''}
              placeholder="0"
              min={0}
              max={MAX_SAVED}
              disabled={!isEditable}
              onChange={e => setCurrentSaved(clampValue(e.target.value, 0, MAX_SAVED))}
              className="goal-amount-input"
            />
          </div>
        </div>
      </div>

      {/* Save Button for DB Goal changes */}
      {isEditable && hasChanged && (
        <motion.button
          initial={{ opacity: 0, y: -5 }}
          animate={{ opacity: 1, y: 0 }}
          onClick={handleCommitUpdates}
          disabled={isUpdating}
          style={{
            background: 'linear-gradient(135deg, #0ea5e9, #10b981)', border: 'none',
            borderRadius: 10, padding: '8px 16px', color: '#fff', fontWeight: 700,
            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
            fontSize: '0.8rem', width: '100%', justifyContent: 'center', marginBottom: 20,
            boxShadow: '0 4px 15px rgba(16, 185, 129, 0.3)'
          }}
        >
          {isUpdating ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />}
          Save Changes & Update Projections
        </motion.button>
      )}

      {isEditable && isDbGoal && !isCalculationFresh && hasValidEditableFacts
        && recalculationHorizonStatus === 'supported' && (
        <motion.button
          initial={{ opacity: 0, y: -5 }}
          animate={{ opacity: 1, y: 0 }}
          onClick={handleRecalculate}
          disabled={isUpdating || hasChanged}
          aria-label="Recalculate goal using saved amounts"
          title={hasChanged ? 'Save or discard your amount edits before recalculating.' : undefined}
          style={{
            background: 'rgba(14, 165, 233, 0.12)', border: '1px solid rgba(56, 189, 248, 0.35)',
            borderRadius: 10, padding: '8px 16px', color: '#bae6fd', fontWeight: 700,
            cursor: isUpdating || hasChanged ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 6,
            fontSize: '0.8rem', width: '100%', justifyContent: 'center', marginBottom: 20,
            opacity: isUpdating || hasChanged ? 0.6 : 1,
          }}
        >
          {isUpdating ? <RefreshCw size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Recalculate with saved amounts
        </motion.button>
      )}

      {isEditable && isDbGoal && !isCalculationFresh && recalculationHorizonStatus !== 'supported' && (
        <p role="note" style={{ color: '#fcd34d', fontSize: '0.78rem', margin: '0 0 20px' }}>
          {recalculationHorizonStatus === 'below-minimum'
            ? 'This target is too close for a supported projection. Recalculation needs at least one modeled month remaining.'
            : recalculationHorizonStatus === 'past'
              ? 'This target date has passed, so its projection cannot be recalculated.'
              : recalculationHorizonStatus === 'beyond-maximum'
                ? 'This target is more than 30 years away, beyond the supported projection horizon. Recalculation is available only within 30 years.'
              : 'A valid future target date is needed before this projection can be recalculated.'}
        </p>
      )}

      {/* Visual Progress */}
      <div className="goal-progress-section">
        <div className="goal-progress-labels">
          <div className="progress-label-left">
            <span className="label-title">Saved So Far</span>
            <span className="label-value">{formatShort(actualSaved)}</span>
          </div>
          <div className="progress-label-right">
            <span className="label-title">Goal Target</span>
            <span className="label-value" style={{ color: defaults.themeColor || '#6366f1' }}>{formatShort(actualTarget)}</span>
          </div>
        </div>
        
        <div className="goal-progress-track">
          <div 
            className="goal-progress-fill goal-progress-fill--projected" 
            style={{ 
              width: `${Math.min(projectedPercent, 100)}%`,
              background: `linear-gradient(90deg, rgba(${defaults.themeColorRGB || '99,102,241'}, 0.2), rgba(${defaults.themeColorRGB || '99,102,241'}, 0.5))`
            }} 
          />
          <div 
            className="goal-progress-fill goal-progress-fill--current" 
            style={{ 
              display: progressPercent === null ? 'none' : undefined,
              width: progressPercent === null ? undefined : `${progressPercent}%`,
              background: `linear-gradient(90deg, ${defaults.themeColor || '#6366f1'}, #fff)`,
              boxShadow: `0 0 10px rgba(${defaults.themeColorRGB || '99,102,241'}, 0.5)`
            }} 
          />
        </div>
        
        <div className="goal-progress-legend">
          <div className="legend-item">
            <span className="legend-dot" style={{ background: defaults.themeColor || '#6366f1', boxShadow: `0 0 6px rgba(${defaults.themeColorRGB || '99,102,241'}, 0.8)` }}></span>
            Saved <span className="legend-pct">({progressPercent === null ? 'Unavailable' : `${progressPercent.toFixed(0)}% of Target`})</span>
          </div>
          <div className="legend-item">
            <span className="legend-dot" style={{ background: defaults.themeColor || '#6366f1', opacity: 0.5 }}></span>
            Projected <span className="legend-pct">({completionPct === null ? 'Unavailable' : `${completionPct}% of Target`})</span>
          </div>
        </div>
      </div>

      {/* Key Metrics Grid */}
      <div className="goal-card-footer">
        <div className="goal-metric">
          <span className="goal-metric-label"><IndianRupee size={12} /> Target Monthly SIP</span>
          <span className="goal-metric-value">{Number.isFinite(monthlyAllocation) ? formatINR(monthlyAllocation) : '—'}</span>
          <span className="goal-metric-sub">
            {Number.isFinite(monthlyAllocation) && totalSavings > 0
              ? monthlyAllocation <= totalSavings 
                ? `${Math.round((monthlyAllocation / totalSavings) * 100)}% of your monthly savings`
                : `Target SIP (${formatShort(monthlyAllocation)})`
              : 'Awaiting backend calculation'}
          </span>
        </div>
        <div className="goal-metric">
          <span className="goal-metric-label"><Clock size={12} /> Time Remaining</span>
          <span className="goal-metric-value">{Number.isFinite(horizon) ? `${horizon}y` : '—'}</span>
          <span className="goal-metric-sub">Backend Monte Carlo horizon</span>
        </div>
        <div className="goal-metric">
          <span className="goal-metric-label"><TrendingUp size={12} /> Projected Median Value</span>
          <span className="goal-metric-value" style={{ color: defaults.themeColor || '#6366f1' }}>{formatShort(projectedValue)}</span>
          <span className="goal-metric-sub">{isFullyFunded ? 'Goal Fully Covered!' : completionPct === null ? 'Awaiting projection' : `${completionPct}% of Target`}</span>
        </div>
        <div className="goal-metric">
          <span className="goal-metric-label">{isFullyFunded ? 'Fund Status' : 'Still Need (Gap)'}</span>
          <span className="goal-metric-value" style={{ color: isFullyFunded ? '#10b981' : '#f43f5e' }}>
            {isFullyFunded ? '₹0 Gap' : formatShort(gap)}
          </span>
          <span className="goal-metric-sub">{isFullyFunded ? 'Fully on track to target' : hasGap ? 'Save more to reach target' : 'Awaiting backend calculation'}</span>
        </div>
      </div>

      {/* Actionable Insight */}
      <div className="goal-action-container">
        {isDbGoal && isCalculationFresh && goalObj.gemini_advice && isAdvisoryFresh(goalObj.advisory_freshness) ? (
          <motion.div className="goal-action-card">
            <div className="action-card-highlight" style={{ background: gapPositive ? '#eab308' : '#10b981' }}></div>
            <Sparkles size={16} color={gapPositive ? '#eab308' : '#10b981'} style={{ flexShrink: 0, marginTop: 2, zIndex: 1 }} />
            <div style={{ zIndex: 1, fontSize: '0.8rem' }}>
              <strong>Your Adviser Says:</strong>
              {goalObj.gemini_advice}
            </div>
          </motion.div>
        ) : defaults.tip ? (
          <div className="goal-tip" style={{ borderLeftColor: defaults.themeColor || '#6366f1' }}>
            <Lightbulb size={14} color={defaults.themeColor || '#6366f1'} style={{ flexShrink: 0, marginRight: 4 }} /> {defaults.tip}
          </div>
        ) : null}
      </div>
    </motion.div>
  );
};

/* ─── Main Component ──────────────────────────────────────────────── */
const GoalTracker = ({ profile, onNavigate }) => {
  const [dbGoals, setDbGoals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isInitializing, setIsInitializing] = useState(false);
  const [bootstrapResult, setBootstrapResult] = useState(null);
  const goalsFetchGeneration = useRef(0);

  const totalSavings = isPresentFiniteNumber(profile?.monthly_savings) ? Number(profile.monthly_savings) : NaN;
  const currentProfileId = profile?.profileId || profile?.profile_id || profile?._id || null;

  const fetchActiveGoals = useCallback(async ({ clearCurrent = false } = {}) => {
    const generation = ++goalsFetchGeneration.current;
    if (clearCurrent) setDbGoals([]);
    try {
      setLoading(true);
      setBootstrapResult(null);
      const res = await api.getGoals();
      if (generation !== goalsFetchGeneration.current) return;
      setDbGoals(Array.isArray(res?.goals) ? res.goals : []);
    } catch (e) {
      console.error("Failed to load goals for tracker:", e);
      if (generation !== goalsFetchGeneration.current) return;
      setDbGoals([]);
      setBootstrapResult({
        type: 'error',
        message: e?.message || 'Your saved goals could not be loaded. Please try again.',
      });
    } finally {
      if (generation === goalsFetchGeneration.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // A changed financial profile invalidates the freshness proof held by the
    // previously loaded DTO until the backend re-resolves the source state.
    void fetchActiveGoals({ clearCurrent: true });
    return () => { goalsFetchGeneration.current += 1; };
  }, [fetchActiveGoals, profile]);

  const handleInitializeDefaults = async () => {
    setIsInitializing(true);
    setBootstrapResult(null);
    if (onNavigate) {
      onNavigate('goal-planner');
    } else {
      setBootstrapResult({
        type: 'error',
        message: 'The Goal Planner is unavailable from this view. Please open it from the navigation menu.',
      });
    }
    setIsInitializing(false);
  };

  const handleGoalCardUpdate = async (goalId, patchData) => {
    // Fence any list read that started before this mutation. Once the
    // authoritative mutation settles, a new fenced read becomes the sole
    // writer of the visible list.
    goalsFetchGeneration.current += 1;
    try {
      const res = await api.updateGoal(goalId, patchData);
      if (!res?.success) throw new Error('The goal update was not confirmed by the server.');
    } catch (err) {
      alert("Failed to save changes: " + (err.message || "Unknown error"));
    } finally {
      // Even a lost/ambiguous mutation response must reconcile from the
      // backend. Clearing first prevents old projections/advice from being
      // presented as current while the authoritative DTO is fetched.
      await fetchActiveGoals({ clearCurrent: true });
    }
  };

  const handleDeleteGoal = async (goalId) => {
    if (!window.confirm("Are you sure you want to delete this goal? This will permanently remove it from your tracker.")) return;
    goalsFetchGeneration.current += 1;
    try {
      const goal = dbGoals.find(item => String(item._id || item.goalId) === String(goalId));
      const res = await api.deleteGoal(goalId, goal?.version ?? 1);
      if (!res?.deleted) throw new Error('The goal deletion was not confirmed by the server.');
    } catch (err) {
      alert("Failed to delete goal: " + (err.message || "Unknown error"));
    } finally {
      await fetchActiveGoals({ clearCurrent: true });
    }
  };

  // Custom goals remain separate from the four canonical Financial Profile goals.
  const showDbGoals = dbGoals.length > 0;

  // Goals list to map in UI
  const mappedGoals = useMemo(() => {
    return dbGoals.map(g => ({
      name: g.goal_name,
      isDb: true,
      obj: g,
      key: g._id || g.goalId,
      isCurrentProfile: Boolean(currentProfileId) && String(g.profileId || '') === String(currentProfileId),
      profileScopeLabel: Boolean(currentProfileId) && String(g.profileId || '') === String(currentProfileId)
        ? 'Current profile'
        : currentProfileId ? 'Earlier profile' : 'Profile not matched',
      horizon: isFinancialCalculationFresh(g.calculation_freshness) && isPresentFiniteNumber(g.years_remaining)
        ? Number(g.years_remaining)
        : NaN,
      defaults: getDisplayDefaults(g),
    }));
  }, [dbGoals, currentProfileId]);

  const currentProfileGoals = useMemo(() => mappedGoals.filter(goal => goal.isCurrentProfile), [mappedGoals]);
  const historicalGoals = useMemo(() => mappedGoals.filter(goal => !goal.isCurrentProfile), [mappedGoals]);

  // Compute total monthly allocations per goal
  const goalAllocations = useMemo(() => {
    const allocs = {};

    currentProfileGoals.forEach(g => {
      const value = isFinancialCalculationFresh(g.obj?.calculation_freshness) && isPresentFiniteNumber(g.obj?.recommended_sip)
        ? Number(g.obj.recommended_sip)
        : NaN;
      allocs[g.name] = Number.isFinite(value) && value >= 0 ? value : null;
    });
    return allocs;
  }, [currentProfileGoals]);

  // Combined calculations for the HUD
  const totalTarget = useMemo(() => {
    const values = currentProfileGoals.map(goal => isPresentFiniteNumber(goal.obj.target_amount) ? Number(goal.obj.target_amount) : NaN);
    return values.length > 0 && values.every(value => Number.isFinite(value) && value > 0)
      ? values.reduce((sum, value) => sum + value, 0)
      : null;
  }, [currentProfileGoals]);

  const totalCurrent = useMemo(() => {
    const values = currentProfileGoals.map(goal => isPresentFiniteNumber(goal.obj.current_savings) ? Number(goal.obj.current_savings) : NaN);
    return values.length > 0 && values.every(value => Number.isFinite(value) && value >= 0)
      ? values.reduce((sum, value) => sum + value, 0)
      : null;
  }, [currentProfileGoals]);

  const totalProjected = useMemo(() => {
    const values = currentProfileGoals.map(g => isFinancialCalculationFresh(g.obj?.calculation_freshness)
      && isPresentFiniteNumber(g.obj?.monte_carlo_summary?.p50)
      ? Number(g.obj?.monte_carlo_summary?.p50)
      : NaN);
    return values.length > 0 && values.every(value => Number.isFinite(value) && value >= 0)
      ? values.reduce((sum, value) => sum + value, 0)
      : null;
  }, [currentProfileGoals]);

  const totalMonthlySIP = useMemo(() => {
    const values = currentProfileGoals.map(g => isFinancialCalculationFresh(g.obj.calculation_freshness) && isPresentFiniteNumber(g.obj.recommended_sip)
      ? Number(g.obj.recommended_sip)
      : NaN);
    return values.length > 0 && values.every(value => Number.isFinite(value) && value >= 0)
      ? values.reduce((sum, value) => sum + value, 0)
      : null;
  }, [currentProfileGoals]);

  // MC projections target inflation-adjusted amounts, so use those for health calculation
  const totalInflationAdjustedTarget = useMemo(() => {
    const values = currentProfileGoals.map(g => isFinancialCalculationFresh(g.obj.calculation_freshness) && isPresentFiniteNumber(g.obj.inflation_adjusted_target)
      ? Number(g.obj.inflation_adjusted_target)
      : NaN);
    return values.length > 0 && values.every(value => Number.isFinite(value) && value > 0)
      ? values.reduce((sum, value) => sum + value, 0)
      : null;
  }, [currentProfileGoals]);

  const overallHealth = Number.isFinite(totalProjected) && Number.isFinite(totalInflationAdjustedTarget) && totalInflationAdjustedTarget > 0
    ? Math.min(Math.round((totalProjected / totalInflationAdjustedTarget) * 100), 100)
    : null;
  const monthlySavingsSummary = currentProfileGoals.length > 0
    ? (Number.isFinite(totalMonthlySIP) ? `₹${Math.round(totalMonthlySIP).toLocaleString('en-IN')}/mo` : 'Awaiting calculation')
    : showDbGoals ? 'No active-profile calculation'
      : Number.isFinite(totalSavings) ? `₹${Math.round(totalSavings).toLocaleString('en-IN')}/mo` : 'Unavailable';
  const renderGoalCard = (g, index) => (
    <GoalCard
      key={g.key}
      index={index}
      goalName={g.name}
      defaults={g.defaults}
      goalObj={g.obj}
      onSaveUpdates={handleGoalCardUpdate}
      onRecalculate={handleGoalCardUpdate}
      onDeleteGoal={handleDeleteGoal}
      profileScopeLabel={g.profileScopeLabel}
      isEditable={g.isCurrentProfile}
      monthlyAllocation={goalAllocations[g.name]}
      horizon={g.horizon}
      totalSavings={totalSavings}
    />
  );

  if (loading) {
    return (
      <div style={{ display: 'flex', minHeight: '60vh', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 16 }}>
        <RefreshCw size={44} color="#06b6d4" className="animate-spin" />
        <span style={{ fontSize: '1rem', color: '#94a3b8', fontWeight: 600 }}>Loading your goals...</span>
      </div>
    );
  }

  return (
    <motion.div
      className="goal-tracker-page"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.6 }}
    >
      <div className="ambient-background">
        <div className="ambient-orb orb-1"></div>
        <div className="ambient-orb orb-2"></div>
      </div>

      <motion.div
        className="page-header"
        style={{ textAlign: 'center', marginBottom: 8 }}
        initial={{ y: -15, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.1, duration: 0.5 }}
      >
        <div className="gt-page-badge">
          <Target size={11} />
          {showDbGoals ? 'Your Saved Goals' : 'No Custom Goals Yet'}
        </div>
        <h1 className="gt-page-title">My Financial Goals</h1>
        <p className="gt-page-subtitle">
          Plan custom goals separately from your Financial Profile using {Number.isFinite(totalSavings) ? `₹${totalSavings.toLocaleString('en-IN')}/mo` : 'your declared'} savings capacity
        </p>
        <div className="gt-header-divider" />
      </motion.div>

      {/* Partial / Total Bootstrap Result Banner */}
      {bootstrapResult && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          className="gt-bootstrap-result-banner"
          style={{
            background: bootstrapResult.type === 'partial' 
              ? 'rgba(245, 158, 11, 0.15)' 
              : 'rgba(239, 68, 68, 0.15)',
            border: `1px solid ${bootstrapResult.type === 'partial' ? 'rgba(245, 158, 11, 0.4)' : 'rgba(239, 68, 68, 0.4)'}`,
            borderRadius: 16,
            padding: '16px 20px',
            marginBottom: 24,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            boxShadow: '0 4px 20px rgba(0, 0, 0, 0.2)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1 }}>
            <AlertTriangle 
              size={20} 
              color={bootstrapResult.type === 'partial' ? '#f59e0b' : '#ef4444'} 
              style={{ flexShrink: 0 }} 
            />
            <span style={{ 
              color: '#f8fafc', 
              fontSize: '0.9rem', 
              fontWeight: 600, 
              lineHeight: 1.4 
            }}>
              {bootstrapResult.message}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setBootstrapResult(null)}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#94a3b8',
              cursor: 'pointer',
              fontSize: '1.2rem',
              fontWeight: 700,
              padding: '4px 8px',
              borderRadius: 8,
              lineHeight: 1,
            }}
            title="Dismiss notification"
          >
            ✕
          </button>
        </motion.div>
      )}

      {/* Bootstrap Defaults Banner */}
      {!showDbGoals && (
        <motion.div
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          style={{
            background: 'linear-gradient(135deg, rgba(6, 182, 212, 0.15) 0%, rgba(139, 92, 246, 0.15) 100%)',
            border: '1px solid rgba(6, 182, 212, 0.3)',
            borderRadius: 20, padding: 24, marginBottom: 32, display: 'flex',
            alignItems: 'center', justifySelf: 'center', gap: 20, flexWrap: 'wrap',
            boxShadow: '0 8px 32px rgba(6, 182, 212, 0.05)'
          }}
        >
          <div style={{ background: 'rgba(6, 182, 212, 0.1)', padding: 12, borderRadius: 12, display: 'flex' }}>
            <Layers size={28} color="#38bdf8" />
          </div>
          <div style={{ flex: 1, minWidth: 260 }}>
            <h4 style={{ color: '#fff', margin: '0 0 6px 0', fontSize: '1.05rem', fontWeight: 800 }}>Welcome to your Goals Dashboard</h4>
            <p style={{ color: '#cbd5e1', margin: 0, fontSize: '0.88rem', lineHeight: 1.4 }}>
              No custom goal has been saved. Open the Goal Planner to enter a target, date, and current savings explicitly.
            </p>
          </div>
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            disabled={isInitializing}
            onClick={handleInitializeDefaults}
            style={{
              background: 'linear-gradient(135deg, #0ea5e9, #8b5cf6)', border: 'none',
              padding: '12px 24px', borderRadius: 12, color: '#fff', fontWeight: 700,
              cursor: isInitializing ? 'not-allowed' : 'pointer', fontSize: '0.88rem',
              display: 'flex', alignItems: 'center', gap: 8, boxShadow: '0 4px 15px rgba(6, 182, 212, 0.2)'
            }}
          >
            {isInitializing ? <RefreshCw size={16} className="animate-spin" /> : <Sparkles size={16} />}
            {isInitializing ? 'Opening Planner...' : 'Create Custom Goal'}
          </motion.button>
        </motion.div>
      )}

      {/* ── Overview Card ────────────────────────────────── */}
      <motion.div
        className="goal-overview-card premium-glass"
        initial={{ scale: 0.98, opacity: 0, y: 20 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        transition={{ delay: 0.15, type: 'spring', stiffness: 120, damping: 20 }}
      >
        <div className="overview-glow-line"></div>
        
        <div className="goal-overview-stat">
          <span className="goal-overview-label">What You're Saving For</span>
          <span className="goal-overview-value text-gradient-primary">{formatShort(totalTarget)}</span>
          <span className="goal-overview-sub">{currentProfileGoals.length > 0
            ? `Across ${currentProfileGoals.length} current-profile goals`
            : 'No goals linked to the active profile'}</span>
        </div>
        
        <div className="goal-overview-divider"></div>
        
        <div className="goal-overview-stat">
          <span className="goal-overview-label">Already Saved</span>
          <span className="goal-overview-value">{formatShort(totalCurrent)}</span>
          <span className="goal-overview-sub">{Number.isFinite(totalTarget) && totalTarget > 0 && Number.isFinite(totalCurrent)
            ? `${Math.round((totalCurrent / totalTarget) * 100)}% of target`
            : ''}</span>
        </div>
        
        <div className="goal-overview-divider"></div>
        
        <div className="goal-overview-stat">
          <span className="goal-overview-label">Projected Median Value</span>
          <span className="goal-overview-value">{formatShort(totalProjected)}</span>
          <span className="goal-overview-sub">Monthly Savings Needed: {monthlySavingsSummary}</span>
        </div>
        
        <div className="goal-overview-divider"></div>
        
        <div className="goal-overview-stat">
          <span className="goal-overview-label">Overall Progress</span>
          <span className="goal-overview-value health-value" style={{
            color: overallHealth === null ? '#64748b' : overallHealth >= 80 ? '#10b981' : overallHealth >= 50 ? '#f59e0b' : '#ef4444',
            textShadow: overallHealth === null ? 'none' : `0 0 20px ${overallHealth >= 80 ? 'rgba(16,185,129,0.4)' : overallHealth >= 50 ? 'rgba(245,158,11,0.4)' : 'rgba(239,68,68,0.4)'}`
          }}>
            {overallHealth === null ? '—' : `${overallHealth}%`}
          </span>
          <span className="goal-overview-sub" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            <span className="health-dot" style={{ 
              backgroundColor: overallHealth === null ? '#64748b' : overallHealth >= 80 ? '#10b981' : overallHealth >= 50 ? '#f59e0b' : '#ef4444',
              boxShadow: overallHealth === null ? 'none' : `0 0 10px ${overallHealth >= 80 ? '#10b981' : overallHealth >= 50 ? '#f59e0b' : '#ef4444'}`
            }} />
            {overallHealth === null ? 'Awaiting Projection' : overallHealth >= 80 ? 'On Track' : overallHealth >= 50 ? 'Could Use a Boost' : 'Needs Attention'}
          </span>
        </div>
      </motion.div>

      {/* ── Goal Cards ────────────────────────────────────── */}
      {showDbGoals && (
        <section aria-label="Current profile goals">
          <h2 style={{ color: '#e2e8f0', fontSize: '1.05rem', margin: '28px 0 14px' }}>Current profile goals</h2>
          {currentProfileGoals.length === 0 ? (
            <p style={{ color: '#94a3b8', margin: '0 0 18px' }}>No saved goals are linked to the active profile.</p>
          ) : (
            <div className="goal-cards-grid">
              <AnimatePresence>
                {currentProfileGoals.map(renderGoalCard)}
              </AnimatePresence>
            </div>
          )}
        </section>
      )}

      {historicalGoals.length > 0 && (
        <section aria-label={currentProfileId ? 'Earlier profile goals' : 'Unmatched profile goals'}>
          <h2 style={{ color: '#cbd5e1', fontSize: '1.05rem', margin: '28px 0 8px' }}>
            {currentProfileId ? 'Earlier profile goals' : 'Goals not matched to the active profile'}
          </h2>
          <p style={{ color: '#94a3b8', margin: '0 0 14px', fontSize: '0.85rem' }}>
            These saved records are kept for reference and are excluded from current-profile totals and projections.
          </p>
          <div className="goal-cards-grid">
            <AnimatePresence>
              {historicalGoals.map((goal, index) => renderGoalCard(goal, currentProfileGoals.length + index))}
            </AnimatePresence>
          </div>
        </section>
      )}
    </motion.div>
  );
};

export default GoalTracker;
