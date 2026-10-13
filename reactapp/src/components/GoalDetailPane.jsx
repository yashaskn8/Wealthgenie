import React, { useState, useEffect } from 'react';
import { Target, TrendingUp, Calendar, DollarSign, Sliders, Sparkles, Save, AlertTriangle, ChevronRight, Info, Zap, Shield, Activity, Cpu, Umbrella, Home, GraduationCap, Car, Clock } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import ProjectionBand from './ProjectionBand';
import JargonTooltip from './JargonTooltip';
import { isAdvisoryFresh, isFinancialCalculationFresh } from '../utils/financialFreshness';
import { isPresentFiniteNumber } from '../utils/financialValues';

const getGoalIcon = (name = '') => {
  const lower = name.toLowerCase();
  if (lower.includes('retire')) return { Icon: Umbrella, color: '#f59e0b' };
  if (lower.includes('educat') || lower.includes('child') || lower.includes('school')) return { Icon: GraduationCap, color: '#8b5cf6' };
  if (lower.includes('home') || lower.includes('house') || lower.includes('property')) return { Icon: Home, color: '#38bdf8' };
  if (lower.includes('car') || lower.includes('vehicle') || lower.includes('auto')) return { Icon: Car, color: '#f43f5e' };
  if (lower.includes('emerg') || lower.includes('fund') || lower.includes('safe')) return { Icon: Shield, color: '#10b981' };
  return { Icon: Target, color: '#38bdf8' };
};

const PRIORITY_CONFIG = {
  Critical: { color: '#ef4444', bg: 'rgba(239, 68, 68, 0.15)', border: 'rgba(239, 68, 68, 0.4)', emoji: '🔴', glow: 'rgba(239, 68, 68, 0.3)' },
  High:     { color: '#f97316', bg: 'rgba(249, 115, 22, 0.15)', border: 'rgba(249, 115, 22, 0.4)', emoji: '🟠', glow: 'rgba(249, 115, 22, 0.3)' },
  Medium:   { color: '#0ea5e9', bg: 'rgba(14, 165, 233, 0.15)', border: 'rgba(14, 165, 233, 0.4)', emoji: '🔵', glow: 'rgba(14, 165, 233, 0.3)' },
  Low:      { color: '#64748b', bg: 'rgba(100, 116, 139, 0.15)', border: 'rgba(100, 116, 139, 0.4)', emoji: '⚪', glow: 'rgba(100, 116, 139, 0.2)' },
};

const formatINR = (value) => {
  if (!isPresentFiniteNumber(value)) return '—';
  value = Number(value);
  if (value >= 10000000) return `₹${(value / 10000000).toFixed(2)} Cr`;
  if (value >= 100000) return `₹${(value / 100000).toFixed(1)} L`;
  return `₹${Math.round(value).toLocaleString('en-IN')}`;
};

/* ─── Futuristic Cyber Arc Gauge ─────────────────────── */
const ProbabilityGauge = ({ probability }) => {
  const hasProbability = Number.isFinite(probability) && probability >= 0 && probability <= 1;
  const pct = hasProbability ? Math.round(probability * 100) : null;
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - (hasProbability ? probability : 0));
  const color = !hasProbability ? '#64748b' : pct >= 75 ? '#10b981' : pct >= 50 ? '#f59e0b' : '#f43f5e';
  const glowColor = !hasProbability ? 'rgba(100,116,139,0.3)' : pct >= 75 ? 'rgba(16,185,129,0.5)' : pct >= 50 ? 'rgba(245,158,11,0.5)' : 'rgba(244,63,94,0.5)';

  return (
    <div style={{ position: 'relative', width: 140, height: 140, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {/* Ambient background aura */}
      <motion.div
        animate={{ scale: [0.95, 1.05, 0.95], opacity: [0.3, 0.6, 0.3] }}
        transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
        style={{
          position: 'absolute', width: 110, height: 110, borderRadius: '50%',
          background: `radial-gradient(circle, ${glowColor} 0%, transparent 70%)`,
          pointerEvents: 'none'
        }}
      />
      
      <svg viewBox="0 0 130 130" style={{ width: '100%', height: '100%', filter: `drop-shadow(0 0 14px ${glowColor})` }}>
        {/* Outer dashed spinning ring */}
        <motion.circle
          cx="65" cy="65" r="61" fill="none" stroke="rgba(56, 189, 248, 0.15)" strokeWidth="1.5"
          strokeDasharray="4 8"
          animate={{ rotate: 360 }}
          transition={{ duration: 25, repeat: Infinity, ease: 'linear' }}
          style={{ transformOrigin: 'center' }}
        />
        {/* Inner track */}
        <circle cx="65" cy="65" r={radius} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="9" />
        {/* Progress Arc */}
        <motion.circle
          cx="65" cy="65" r={radius} fill="none" stroke={color} strokeWidth="9"
          strokeLinecap="round" strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: dashOffset }}
          transition={{ duration: 1.4, ease: [0.16, 1, 0.3, 1] }}
          style={{ transformOrigin: 'center', transform: 'rotate(-90deg)' }}
        />
      </svg>

      <div style={{
        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', zIndex: 2
      }}>
        <motion.span
          key={pct}
          initial={{ scale: 0.7, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 300, damping: 20 }}
          style={{
            fontSize: '1.9rem', fontWeight: 900, color, lineHeight: 1,
            letterSpacing: '-0.02em', textShadow: `0 0 15px ${glowColor}`
          }}
        >
          {hasProbability ? `${pct}%` : '—'}
        </motion.span>
        <span style={{
          fontSize: '0.58rem', color: '#94a3b8', textTransform: 'uppercase',
          letterSpacing: '1.2px', fontWeight: 800, marginTop: 4, display: 'flex', alignItems: 'center', gap: 3
        }}>
          <Activity size={10} color={color} /> {hasProbability ? 'SIMULATED' : 'UNAVAILABLE'}
        </span>
      </div>
    </div>
  );
};

/* ─── Futuristic HUD Metric Card ─────────────────────────── */
const MetricCard = ({ label, value, icon, accentColor = '#38bdf8' }) => (
  <motion.div
    whileHover={{ y: -3, scale: 1.02, boxShadow: `0 12px 30px rgba(0,0,0,0.4), 0 0 20px ${accentColor}20` }}
    transition={{ duration: 0.2, ease: 'easeOut' }}
    style={{
      background: 'linear-gradient(145deg, rgba(30, 41, 59, 0.5), rgba(15, 23, 42, 0.75))',
      backdropFilter: 'blur(16px)',
      borderRadius: 16, padding: '16px 18px',
      display: 'flex', gap: 14, alignItems: 'center', position: 'relative', overflow: 'hidden',
      border: '1px solid rgba(255, 255, 255, 0.07)',
      boxShadow: `inset 0 1px 1px rgba(255,255,255,0.05), 0 4px 20px rgba(0,0,0,0.25)`
    }}
  >
    {/* Colored left indicator strip */}
    <div style={{
      position: 'absolute', left: 0, top: 0, bottom: 0, width: 3,
      background: `linear-gradient(180deg, ${accentColor}, transparent)`, borderRadius: '16px 0 0 16px'
    }} />

    <div style={{
      color: accentColor, display: 'flex', width: 40, height: 40, borderRadius: 12,
      background: `radial-gradient(circle at center, ${accentColor}22, ${accentColor}06)`,
      alignItems: 'center', justifyContent: 'center',
      border: `1px solid ${accentColor}30`, flexShrink: 0,
      boxShadow: `0 0 12px ${accentColor}15`
    }}>
      {icon}
    </div>
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: '0.66rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.8px' }}>{label}</div>
      <div style={{ fontSize: '1.05rem', fontWeight: 800, color: '#f8fafc', marginTop: 2, letterSpacing: '-0.01em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
    </div>
  </motion.div>
);

/* ─── Main Component ──────────────────────────────────── */
export const GoalDetailPane = ({
  selectedGoal,
  simulatedSips,
  onChangeSimulatedSip,
  onPriorityChange,
  onSaveGoalUpdates,
  getLiveProbability,
  getSimulatedChartData,
  monthlySavingsCapacity,
  simulationLoading,
  simulationError,
  simulationResult,
  calculationFreshness,
}) => {
  const [isEditingSettings, setIsEditingSettings] = useState(false);
  const [editTarget, setEditTarget] = useState('');
  const [editSavings, setEditSavings] = useState('');
  const [showMonteCarlo, setShowMonteCarlo] = useState(false);

  useEffect(() => {
    if (selectedGoal) {
      const resetState = () => {
        setEditTarget(selectedGoal.target_amount ?? '');
        setEditSavings(selectedGoal.current_savings ?? '');
        setIsEditingSettings(false);
      };
      resetState();
    }
  }, [selectedGoal]);

  const handleSave = () => {
    onSaveGoalUpdates({
      targetAmount: Number(editTarget),
      currentSavings: Number(editSavings)
    });
    setIsEditingSettings(false);
  };

  const inputStyle = {
    width: '100%', padding: '12px 16px',
    background: 'rgba(15, 23, 42, 0.7)', border: '1px solid rgba(56, 189, 248, 0.25)',
    borderRadius: '12px', color: '#fff', fontSize: '0.9rem', outline: 'none',
    boxSizing: 'border-box', transition: 'all 0.2s', boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.3)'
  };

  const labelStyle = {
    display: 'block', fontSize: '0.72rem', fontWeight: 800,
    textTransform: 'uppercase', letterSpacing: '0.8px', color: '#94a3b8', marginBottom: '6px',
  };

  const goalId = selectedGoal?._id || selectedGoal?.goalId;
  const isCalculationFresh = isFinancialCalculationFresh(calculationFreshness);
  const currentSipSource = simulatedSips[goalId] ?? selectedGoal?.simulated_monthly_contribution;
  const currentSipCandidate = isCalculationFresh && isPresentFiniteNumber(currentSipSource)
    ? Number(currentSipSource)
    : NaN;
  const currentSip = Number.isFinite(currentSipCandidate) && currentSipCandidate >= 0 ? currentSipCandidate : null;
  const liveProbability = isCalculationFresh ? getLiveProbability(selectedGoal) : null;
  const recommendedSipCandidate = isCalculationFresh && isPresentFiniteNumber(selectedGoal.recommended_sip)
    ? Number(selectedGoal.recommended_sip)
    : NaN;
  const recommendedSip = Number.isFinite(recommendedSipCandidate) && recommendedSipCandidate >= 0 ? recommendedSipCandidate : null;
  const capacityCandidate = isPresentFiniteNumber(monthlySavingsCapacity) ? Number(monthlySavingsCapacity) : NaN;
  const sliderMax = Number.isFinite(capacityCandidate) && capacityCandidate > 0 ? capacityCandidate : 0;
  const hasSimulationInput = currentSip !== null && recommendedSip !== null && sliderMax > 0;
  const sliderMin = hasSimulationInput
    ? Math.min(sliderMax, Math.max(0, Math.round(recommendedSip * 0.2 / 500) * 500))
    : 0;
  const sliderStep = recommendedSip !== null && recommendedSip < 2000 ? 250 : 500;
  const hasProbability = Number.isFinite(liveProbability) && liveProbability >= 0 && liveProbability <= 1;
  const probPct = hasProbability ? Math.round(liveProbability * 100) : null;
  const simulationsRunCandidate = isCalculationFresh
    ? Number(simulationResult?.monte_carlo_summary?.simulations_run ?? selectedGoal.monte_carlo_summary?.simulations_run)
    : NaN;
  const simulationsRun = Number.isInteger(simulationsRunCandidate) && simulationsRunCandidate > 0 ? simulationsRunCandidate : null;
  const inflationAssumption = isCalculationFresh && isPresentFiniteNumber(selectedGoal.inflation_assumption)
    ? Number(selectedGoal.inflation_assumption)
    : NaN;
  const inflationLabel = Number.isFinite(inflationAssumption)
    ? `${(inflationAssumption * 100).toFixed(1).replace(/\.0$/, '')}%`
    : 'server-specified';

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={goalId}
        initial={{ opacity: 0, scale: 0.98, x: 20 }}
        animate={{ opacity: 1, scale: 1, x: 0 }}
        exit={{ opacity: 0, scale: 0.98, x: 20 }}
        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      >
        {/* Holographic Header Card */}
        <div style={{
          background: 'linear-gradient(145deg, rgba(30, 41, 59, 0.7), rgba(15, 23, 42, 0.95))', backdropFilter: 'blur(28px)',
          border: '1px solid rgba(56, 189, 248, 0.3)', borderTop: '1px solid rgba(255, 255, 255, 0.15)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.6), inset 0 1px 1px rgba(255,255,255,0.08), 0 0 30px rgba(6, 182, 212, 0.1)',
          borderRadius: 24, padding: '30px 34px', marginBottom: 20, position: 'relative', overflow: 'hidden'
        }}>
          {/* Animated corner grid background accent */}
          <div style={{
            position: 'absolute', inset: 0,
            backgroundImage: 'radial-gradient(rgba(56, 189, 248, 0.08) 1px, transparent 0)',
            backgroundSize: '24px 24px', pointerEvents: 'none'
          }} />

          {/* Glowing gradient blobs */}
          <motion.div
            animate={{ opacity: [0.4, 0.7, 0.4], scale: [1, 1.1, 1] }}
            transition={{ duration: 6, repeat: Infinity, ease: 'easeInOut' }}
            style={{
              position: 'absolute', top: '-40%', right: '-20%', width: '65%', height: '80%',
              background: 'radial-gradient(ellipse at center, rgba(6, 182, 212, 0.15), transparent 70%)',
              pointerEvents: 'none'
            }}
          />

          {/* Header Bar */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24, position: 'relative', zIndex: 1, gap: 16 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              {(() => {
                const { Icon: GoalIcon, color: iconColor } = getGoalIcon(selectedGoal.goal_name);
                return (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 12 }}>
                    <div style={{
                      width: 48, height: 48, borderRadius: 16, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      background: `radial-gradient(circle at center, ${iconColor}25, ${iconColor}05)`,
                      border: `1.5px solid ${iconColor}40`,
                      boxShadow: `0 0 20px ${iconColor}25`, flexShrink: 0
                    }}>
                      <GoalIcon size={24} color={iconColor} />
                    </div>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: '0.65rem', color: '#38bdf8', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '1.2px' }}>
                          GOAL TARGET OVERVIEW
                        </span>
                        <motion.span
                          animate={{ opacity: [0.3, 1, 0.3] }}
                          transition={{ duration: 2, repeat: Infinity }}
                          style={{ width: 6, height: 6, borderRadius: '50%', background: '#10b981', boxShadow: '0 0 8px #10b981' }}
                        />
                      </div>
                      <h3 style={{ fontSize: '1.6rem', fontWeight: 900, color: '#f8fafc', margin: 0, letterSpacing: '-0.02em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {selectedGoal.goal_name}
                      </h3>
                    </div>
                  </div>
                );
              })()}

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <motion.button
                  whileHover={{ scale: 1.04, boxShadow: '0 0 20px rgba(56, 189, 248, 0.3)' }}
                  whileTap={{ scale: 0.96 }}
                  onClick={() => {
                    if (isEditingSettings) handleSave();
                    else setIsEditingSettings(true);
                  }}
                  style={{
                    background: isEditingSettings ? 'linear-gradient(135deg, #10b981, #059669)' : 'rgba(56, 189, 248, 0.12)',
                    border: `1px solid ${isEditingSettings ? '#10b981' : 'rgba(56, 189, 248, 0.3)'}`,
                    padding: '7px 16px', borderRadius: 10, color: isEditingSettings ? '#fff' : '#38bdf8',
                    fontSize: '0.78rem', fontWeight: 800, cursor: 'pointer', display: 'flex',
                    alignItems: 'center', gap: 7, transition: 'all 0.2s', boxShadow: '0 4px 14px rgba(0,0,0,0.2)'
                  }}
                >
                  {isEditingSettings ? <><Save size={14} /> Save Target Changes</> : <><Sliders size={14} /> Modify Parameters</>}
                </motion.button>

                {/* Cyber HUD Badges */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px',
                  borderRadius: 8, background: 'rgba(15, 23, 42, 0.6)', border: '1px solid rgba(255, 255, 255, 0.08)',
                  fontSize: '0.7rem', color: '#94a3b8', fontWeight: 700
                }}>
                  <Clock size={11} color="#38bdf8" />
                  <span>{isCalculationFresh && isPresentFiniteNumber(selectedGoal.years_remaining) ? `${Number(selectedGoal.years_remaining)} Yrs Horizon` : 'Horizon unavailable'}</span>
                </div>

                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px',
                  borderRadius: 8, background: 'rgba(16, 185, 129, 0.1)', border: '1px solid rgba(16, 185, 129, 0.25)',
                  fontSize: '0.7rem', color: '#10b981', fontWeight: 800
                }}>
                  <Activity size={11} color="#10b981" />
                  <span>{simulationsRun ? `${simulationsRun.toLocaleString()} SIMS RUN` : 'SIMULATION COUNT UNAVAILABLE'}</span>
                </div>
              </div>
            </div>

            <ProbabilityGauge probability={liveProbability} />
          </div>

          {/* Edit Form / Metric HUD Grid */}
          {isEditingSettings ? (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, padding: 20, background: 'rgba(15,23,42,0.6)', borderRadius: 16, border: '1px solid rgba(56,189,248,0.2)' }}
            >
              <div>
                <label style={labelStyle}>Target Amount (₹)</label>
                <input type="number" value={editTarget} onChange={e => setEditTarget(e.target.value)} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Current Savings Allocated (₹)</label>
                <input type="number" value={editSavings} onChange={e => setEditSavings(e.target.value)} style={inputStyle} />
              </div>
            </motion.div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, position: 'relative', zIndex: 1 }}>
                <MetricCard label="Target Goal" value={formatINR(selectedGoal.target_amount)} icon={<Target size={18} />} accentColor="#38bdf8" />
                <MetricCard label="Recommended SIP" value={recommendedSip === null ? '—' : `${formatINR(recommendedSip)}/mo`} icon={<TrendingUp size={18} />} accentColor="#10b981" />
                <MetricCard label="Target Deadline" value={new Date(selectedGoal.target_date).toLocaleDateString('en-IN', { year: 'numeric', month: 'short' })} icon={<Calendar size={18} />} accentColor="#8b5cf6" />
                <MetricCard label="Allocated Instrument" value={isCalculationFresh ? (selectedGoal.recommended_instrument || 'Unavailable').replace('_', ' ') : 'Unavailable'} icon={<DollarSign size={18} />} accentColor="#f59e0b" />
              </div>

              {isCalculationFresh && selectedGoal.inflation_adjusted_target && selectedGoal.inflation_adjusted_target !== selectedGoal.target_amount && (
                <div style={{
                  marginTop: 14, padding: '10px 16px', borderRadius: 12,
                  background: 'rgba(139, 92, 246, 0.08)', border: '1px solid rgba(139, 92, 246, 0.2)',
                  fontSize: '0.76rem', color: '#c7d2fe', display: 'flex', alignItems: 'center', gap: 10,
                  boxShadow: 'inset 0 1px 1px rgba(255,255,255,0.05)'
                }}>
                  <Info size={14} color="#8b5cf6" style={{ flexShrink: 0 }} />
                  <span>Inflation-Adjusted Target: <strong style={{ color: '#fff' }}>{formatINR(selectedGoal.inflation_adjusted_target)}</strong> ({inflationLabel} annual inflation assumption over {isPresentFiniteNumber(selectedGoal.years_remaining) ? selectedGoal.years_remaining : '–'} yrs).</span>
                </div>
              )}
            </>
          )}

          {/* Cyber Priority Selector with Glowing Glass Cards */}
          <div style={{ marginTop: 22, position: 'relative', zIndex: 1 }}>
            <span style={{ ...labelStyle, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Shield size={13} color="#38bdf8" /> PRIORITY ALLOCATION
            </span>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
              {['Critical', 'High', 'Medium', 'Low'].map(p => {
                const isActive = selectedGoal.priority === p;
                const cfg = PRIORITY_CONFIG[p];
                return (
                  <motion.button
                    key={p}
                    whileHover={{ y: -2, scale: 1.03 }}
                    whileTap={{ scale: 0.97 }}
                    onClick={() => onPriorityChange(p)}
                    style={{
                      position: 'relative',
                      background: isActive
                        ? `linear-gradient(135deg, ${cfg.bg}, ${cfg.color}20)`
                        : 'rgba(15, 23, 42, 0.45)',
                      border: `1.5px solid ${isActive ? cfg.color : 'rgba(255, 255, 255, 0.08)'}`,
                      borderRadius: 14, padding: '12px 10px',
                      color: isActive ? '#fff' : '#94a3b8',
                      fontSize: '0.8rem', fontWeight: isActive ? 900 : 600, cursor: 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                      boxShadow: isActive ? `0 0 24px ${cfg.glow}, inset 0 1px 1px rgba(255,255,255,0.2)` : '0 4px 12px rgba(0,0,0,0.2)',
                      transition: 'all 0.2s ease', outline: 'none', backdropFilter: 'blur(12px)'
                    }}
                  >
                    {isActive && (
                      <motion.div
                        layoutId="active-priority-pill"
                        transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                        style={{
                          position: 'absolute', inset: -1.5, borderRadius: 14,
                          border: `2px solid ${cfg.color}`,
                          boxShadow: `0 0 25px ${cfg.glow}`,
                          pointerEvents: 'none', zIndex: 0
                        }}
                      />
                    )}
                    <motion.span
                      animate={isActive ? { scale: [1, 1.4, 1], opacity: [0.8, 1, 0.8] } : {}}
                      transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
                      style={{
                        width: 8, height: 8, borderRadius: '50%', background: cfg.color,
                        boxShadow: `0 0 10px ${cfg.color}`, flexShrink: 0
                      }}
                    />
                    <span style={{ color: isActive ? cfg.color : '#94a3b8', position: 'relative', zIndex: 1 }}>{p}</span>
                  </motion.button>
                );
              })}
            </div>
          </div>

          {/* Gap Warning */}
          {isCalculationFresh && selectedGoal.gap_amount > 0 && (
            <motion.div 
              initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}
              style={{
                marginTop: 18, padding: '14px 18px', borderRadius: 14,
                background: 'linear-gradient(90deg, rgba(244, 63, 94, 0.12), rgba(244, 63, 94, 0.04))',
                border: '1px solid rgba(244, 63, 94, 0.25)',
                fontSize: '0.84rem', color: '#fda4af', display: 'flex', alignItems: 'center', gap: 12,
                boxShadow: '0 4px 15px rgba(244, 63, 94, 0.1)'
              }}
            >
              <AlertTriangle size={18} color="#f43f5e" style={{ flexShrink: 0 }} />
              <span>Capital Deficit Detected: Increase monthly contribution by <strong style={{ color: '#fff', textDecoration: 'underline' }}>{formatINR(selectedGoal.gap_amount)}/mo</strong> to meet target.</span>
            </motion.div>
          )}
        </div>

        {/* ─── Interactive AI SIP Simulator ─────────────────────────── */}
        <motion.div
          initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}
          style={{
            padding: '26px 30px', borderRadius: 24, marginBottom: 20, position: 'relative', overflow: 'hidden',
            background: 'linear-gradient(145deg, rgba(30, 41, 59, 0.6), rgba(15, 23, 42, 0.9))',
            border: '1px solid rgba(56, 189, 248, 0.2)',
            boxShadow: '0 12px 40px rgba(0,0,0,0.4), inset 0 1px 1px rgba(255,255,255,0.05)',
            backdropFilter: 'blur(20px)'
          }}
        >
          <div style={{ position: 'absolute', top: 0, left: '20%', width: '60%', height: '1px', background: 'linear-gradient(90deg, transparent, rgba(56, 189, 248, 0.6), transparent)' }} />

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                width: 32, height: 32, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(56, 189, 248, 0.15)', border: '1px solid rgba(56, 189, 248, 0.3)',
                boxShadow: '0 0 10px rgba(56, 189, 248, 0.2)'
              }}>
                <Sliders size={16} color="#38bdf8" />
              </div>
              <div>
                <div style={{ fontSize: '0.85rem', color: '#f8fafc', fontWeight: 800 }}>QUANT SAVINGS SIMULATOR</div>
                <div style={{ fontSize: '0.68rem', color: '#64748b' }}>Simulate growth impact in real-time</div>
              </div>
            </div>

            <motion.div
              key={currentSip}
              initial={{ scale: 0.9 }}
              animate={{ scale: 1 }}
              style={{
                background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.15), rgba(16, 185, 129, 0.05))',
                border: '1px solid rgba(16, 185, 129, 0.35)',
                padding: '6px 16px', borderRadius: 12, boxShadow: '0 0 15px rgba(16, 185, 129, 0.15)'
              }}
            >
              <span style={{ color: '#10b981', fontWeight: 900, fontSize: '1.15rem' }}>{formatINR(currentSip)}</span>
              <span style={{ color: '#94a3b8', fontSize: '0.75rem', marginLeft: 3 }}>/mo</span>
            </motion.div>
          </div>

          {/* Interactive Range Slider */}
          <div style={{ position: 'relative', padding: '10px 0' }}>
            <input 
              type="range" 
              min={sliderMin} max={sliderMax} step={sliderStep}
              value={currentSip ?? 0}
              disabled={!hasSimulationInput}
              onChange={(e) => onChangeSimulatedSip(Number(e.target.value))}
              style={{
                width: '100%', cursor: 'pointer', accentColor: '#38bdf8',
                height: 7, borderRadius: 4, outline: 'none',
              }}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: '#475569', marginTop: 4, marginBottom: 14 }}>
            <span>MIN: {hasSimulationInput ? formatINR(sliderMin) : 'Unavailable'}</span>
            <span style={{ color: '#38bdf8', fontWeight: 700 }}>RECOMMENDED: {formatINR(recommendedSip)}</span>
            <span>MAX: {hasSimulationInput ? formatINR(sliderMax) : 'Unavailable'}</span>
          </div>

          {(simulationLoading || simulationError) && (
            <div role={simulationError ? 'alert' : 'status'} style={{ color: simulationError ? '#fda4af' : '#7dd3fc', fontSize: '0.7rem', marginBottom: 12 }}>
              {simulationError ? `Simulation unavailable: ${simulationError}. The persisted goal result remains displayed.` : `Running ${simulationsRun ? simulationsRun.toLocaleString() : 'backend'} Monte Carlo paths…`}
            </div>
          )}

          {/* Quick SIP Preset Chips */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            <span style={{ fontSize: '0.68rem', color: '#64748b', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 4 }}>
              QUICK PRESETS:
            </span>
            {[
              { label: 'Reset', val: hasSimulationInput && isCalculationFresh ? Number(selectedGoal.simulated_monthly_contribution) : null },
              { label: '+25%', val: hasSimulationInput ? Math.min(sliderMax, Math.round(recommendedSip * 1.25 / 250) * 250) : null },
              { label: '+50%', val: hasSimulationInput ? Math.min(sliderMax, Math.round(recommendedSip * 1.5 / 250) * 250) : null },
              { label: '2x Double', val: hasSimulationInput ? Math.min(sliderMax, recommendedSip * 2) : null },
            ].map(preset => (
              <motion.button
                key={preset.label}
                whileHover={{ scale: 1.05, y: -1 }}
                whileTap={{ scale: 0.95 }}
                disabled={!Number.isFinite(preset.val)}
                onClick={() => {
                  if (Number.isFinite(preset.val)) onChangeSimulatedSip(preset.val);
                }}
                style={{
                  background: hasSimulationInput && currentSip === preset.val ? 'rgba(56, 189, 248, 0.2)' : 'rgba(15, 23, 42, 0.6)',
                  border: `1px solid ${hasSimulationInput && currentSip === preset.val ? '#38bdf8' : 'rgba(255, 255, 255, 0.08)'}`,
                  borderRadius: 8, padding: '4px 10px', color: hasSimulationInput && currentSip === preset.val ? '#38bdf8' : '#94a3b8',
                  fontSize: '0.7rem', fontWeight: 700, cursor: hasSimulationInput ? 'pointer' : 'not-allowed', transition: 'all 0.2s'
                }}
              >
                {preset.label}
              </motion.button>
            ))}
          </div>

          {/* Dynamic Probability Bar */}
          <div style={{ marginTop: 18, padding: '14px 18px', borderRadius: 14, background: 'rgba(15, 23, 42, 0.5)', border: '1px solid rgba(255,255,255,0.05)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <span style={{ fontSize: '0.72rem', color: '#94a3b8', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.8px' }}>Simulated Goal Reach Rate</span>
              <motion.span
                key={probPct}
                initial={{ scale: 1.3 }}
                animate={{ scale: 1 }}
                style={{
                  fontSize: '1rem', fontWeight: 900,
                  color: !hasProbability ? '#64748b' : probPct >= 75 ? '#10b981' : probPct >= 50 ? '#f59e0b' : '#f43f5e',
                  textShadow: hasProbability ? `0 0 10px ${probPct >= 75 ? 'rgba(16,185,129,0.5)' : 'rgba(244,63,94,0.5)'}` : 'none'
                }}
              >
                {hasProbability ? `${probPct}%` : 'Unavailable'}
              </motion.span>
            </div>
            <div style={{ height: 10, background: 'rgba(255,255,255,0.05)', borderRadius: 5, overflow: 'hidden' }}>
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${hasProbability ? Math.min(100, probPct) : 0}%` }}
                transition={{ duration: 0.6, ease: 'easeOut' }}
                style={{
                  height: '100%', borderRadius: 5,
                  background: !hasProbability
                    ? '#64748b'
                    : probPct >= 75
                    ? 'linear-gradient(90deg, #059669, #10b981)'
                    : probPct >= 50
                      ? 'linear-gradient(90deg, #d97706, #f59e0b)'
                      : 'linear-gradient(90deg, #dc2626, #f43f5e)',
                  boxShadow: hasProbability ? `0 0 16px ${probPct >= 75 ? 'rgba(16,185,129,0.6)' : 'rgba(244,63,94,0.6)'}` : 'none',
                }}
              />
            </div>
          </div>
        </motion.div>

        {/* ─── Neural AI Insight Card ──────────────────────────────────── */}
        {selectedGoal.gemini_advice && isCalculationFresh && isAdvisoryFresh(selectedGoal.advisory_freshness) && (
          <motion.div 
            initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 }}
            style={{
              padding: '22px 26px', borderRadius: 20, marginBottom: 20, position: 'relative', overflow: 'hidden',
              background: 'linear-gradient(145deg, rgba(6, 182, 212, 0.08), rgba(139, 92, 246, 0.06))',
              border: '1px solid rgba(6, 182, 212, 0.25)',
              boxShadow: '0 8px 30px rgba(0,0,0,0.3)',
              backdropFilter: 'blur(16px)'
            }}
          >
            <div style={{ position: 'absolute', top: 0, left: '20%', width: '60%', height: '1px', background: 'linear-gradient(90deg, transparent, rgba(139, 92, 246, 0.5), transparent)' }} />
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
              <div style={{
                width: 38, height: 38, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                background: 'linear-gradient(135deg, rgba(6, 182, 212, 0.2), rgba(139, 92, 246, 0.2))',
                border: '1px solid rgba(6, 182, 212, 0.35)',
                boxShadow: '0 0 15px rgba(6, 182, 212, 0.3)'
              }}>
                <Cpu size={20} color="#38bdf8" />
              </div>
              <div>
                <div style={{ fontSize: '0.72rem', fontWeight: 800, color: '#38bdf8', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Sparkles size={12} color="#38bdf8" /> NEURAL AI ADVISORY
                </div>
                <div style={{ fontSize: '0.9rem', color: '#e2e8f0', lineHeight: 1.65, fontStyle: 'normal', fontWeight: 500 }}>
                  {selectedGoal.gemini_advice}
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {/* ─── Monte Carlo Engine Toggle Button ─────────────────────────── */}
        {selectedGoal.chartData && isCalculationFresh && (
          <motion.div initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>
            <motion.button
              whileHover={{ scale: 1.015, boxShadow: '0 10px 30px rgba(6, 182, 212, 0.25)' }}
              whileTap={{ scale: 0.985 }}
              onClick={() => setShowMonteCarlo(!showMonteCarlo)}
              style={{
                width: '100%',
                background: showMonteCarlo
                  ? 'linear-gradient(135deg, rgba(6, 182, 212, 0.18), rgba(139, 92, 246, 0.15))'
                  : 'rgba(30, 41, 59, 0.5)',
                border: '1px solid rgba(56, 189, 248, 0.3)',
                borderRadius: 16, padding: '16px 24px',
                color: '#38bdf8', fontSize: '0.9rem', fontWeight: 800,
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
                transition: 'all 0.2s', letterSpacing: '0.5px'
              }}
            >
              <Zap size={18} color="#38bdf8" />
              {showMonteCarlo ? 'Hide Monte Carlo Simulation' : `View Monte Carlo Growth Engine${simulationsRun ? ` (${simulationsRun.toLocaleString()} Iterations)` : ''}`}
              <ChevronRight size={18} style={{ transform: showMonteCarlo ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }} />
            </motion.button>

            <AnimatePresence>
              {showMonteCarlo && (
                <motion.div 
                  initial={{ opacity: 0, height: 0 }} 
                  animate={{ opacity: 1, height: 'auto' }} 
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.3 }}
                  style={{ marginTop: 18, overflow: 'hidden' }}
                >
                  <ProjectionBand
                    chartData={getSimulatedChartData(selectedGoal)}
                    targetAmount={isCalculationFresh ? selectedGoal.inflation_adjusted_target : null}
                    goalProbability={liveProbability}
                    instrumentName={isCalculationFresh ? (selectedGoal.recommended_instrument || '').replace('_', ' ') : ''}
                    simulationsRun={simulationsRun}
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </motion.div>
    </AnimatePresence>
  );
};
export default GoalDetailPane;
