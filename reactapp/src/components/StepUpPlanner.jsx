import React, { useState, useEffect } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { motion } from 'framer-motion';
import { TrendingUp, Rocket, PiggyBank, ArrowUpRight, Wallet, Calendar, Target, Sparkles, ChevronDown, ChevronUp } from 'lucide-react';
import { formatINR, formatCompactINR } from '../utils/indianNumberFormat';
import { isPresentFiniteNumber } from '../utils/financialValues';
import api from '../services/api';
import JargonTooltip from './JargonTooltip';
import './StepUpPlanner.css';

const CustomTooltip = ({ active, payload, label }) => {
  if (active && payload && payload.length) {
    return (
      <div className="sup-tooltip">
        <p className="sup-tooltip-label">{label}</p>
        {payload.map((p, i) => (
          <p key={i} style={{ color: p.color, fontWeight: 700, margin: '6px 0', fontSize: '0.85rem' }}>
            {p.name}: {formatINR(p.value)}
          </p>
        ))}
      </div>
    );
  }
  return null;
};

const StepUpPlanner = ({ profile }) => {
  const [baseSIP, setBaseSIP] = useState(profile?.monthly_savings ?? 1000);
  const [stepUpPercent, setStepUpPercent] = useState(10);
  const [years, setYears] = useState(profile?.investment_horizon_years ?? 1);
  const [returnRate, setReturnRate] = useState(12);
  const [showDetails, setShowDetails] = useState(false);
  const projectionBinding = JSON.stringify([baseSIP, stepUpPercent, years, returnRate]);
  const [projectionState, setProjectionState] = useState({ binding: null, status: 'idle', data: null, error: null });
  const projectionIsCurrent = projectionState.binding === projectionBinding;

  // Safe numerical fallback during manual typing states
  const safeBaseSIP = Number(baseSIP) || 0;
  const safeReturnRate = Number(returnRate) || 0;
  const safeYears = Number(years) || 0;
  const safeStepUpPercent = Number(stepUpPercent) || 0;
  const projectionInputsValid = baseSIP !== '' && stepUpPercent !== '' && years !== '' && returnRate !== ''
    && Number.isFinite(safeBaseSIP) && safeBaseSIP > 0
    && Number.isFinite(safeReturnRate) && safeReturnRate > -100
    && Number.isFinite(safeYears) && safeYears > 0
    && Number.isFinite(safeStepUpPercent) && safeStepUpPercent >= 0;
  const projection = projectionIsCurrent && projectionState.status === 'ready' ? projectionState.data : null;
  const projectionError = projectionIsCurrent && projectionState.status === 'error' ? projectionState.error : null;
  const isCalculating = projectionInputsValid && !projectionIsCurrent;

  // Compute dynamic percentage fills for track bars
  const baseSipPct = Math.min(100, Math.max(0, ((Math.min(100000, Math.max(1000, safeBaseSIP)) - 1000) / 99000) * 100));
  const stepUpPct = Math.min(100, Math.max(0, (Math.min(50, Math.max(0, safeStepUpPercent)) / 50) * 100));
  const yearsPct = Math.min(100, Math.max(0, ((Math.min(40, Math.max(1, safeYears)) - 1) / 39) * 100));
  const cagrPct = Math.min(100, Math.max(0, ((Math.min(30, Math.max(1, safeReturnRate)) - 1) / 29) * 100));

  useEffect(() => {
    if (!projectionInputsValid) return undefined;
    const controller = new AbortController();
    let cancelled = false;
    const timer = setTimeout(() => {
      api.calculateStepUpProjection(
        safeBaseSIP,
        safeReturnRate / 100,
        safeYears,
        safeStepUpPercent / 100,
        { signal: controller.signal },
      ).then(result => {
        if (!cancelled) setProjectionState({ binding: projectionBinding, status: 'ready', data: result, error: null });
      }).catch(error => {
        if (!cancelled && error?.code === 'REQUEST_ABORTED') {
          setProjectionState({ binding: projectionBinding, status: 'cancelled', data: null, error: null });
        } else if (!cancelled) {
          setProjectionState({
            binding: projectionBinding,
            status: 'error',
            data: null,
            error: error.message || 'Projection service is unavailable.',
          });
        }
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    baseSIP,
    returnRate,
    safeBaseSIP,
    safeReturnRate,
    safeStepUpPercent,
    safeYears,
    stepUpPercent,
    years,
    projectionBinding,
    projectionInputsValid,
  ]);

  const flatFinal = projection?.flatFinal ?? null;
  const stepUpFinal = projection?.stepUpFinal ?? null;
  const flatInvested = projection?.flatInvested ?? null;
  const stepUpInvested = projection?.stepUpInvested ?? null;
  const additionalCorpus = projection?.additionalCorpus ?? null;
  const additionalPercent = isPresentFiniteNumber(projection?.additionalPercent)
    ? Math.round(Number(projection.additionalPercent))
    : null;
  const chartData = projection?.chartData ?? [];

  return (
    <div className="stepup-page">
      {/* Floating Ambient Orbs */}
      <div className="sup-bg-orb sup-bg-orb--1"></div>
      <div className="sup-bg-orb sup-bg-orb--2"></div>

      {/* Page Header */}
      <motion.div
        className="sup-header-center"
        initial={{ opacity: 0, y: -15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        <div className="sup-page-badge">
          <TrendingUp size={12} />
          <span>BOOSTER SAVINGS PLANNER</span>
        </div>
        <h1 className="sup-page-title">
          Grow Your Monthly Savings <span className="title-gradient">(Step-Up SIP)</span>
        </h1>
        <p className="sup-page-subtitle">
          Explore how an explicit annual increase changes a long-term SIP projection.
        </p>
      </motion.div>

      {/* Explanation Banner */}
      <motion.div 
        className="sup-onboarding-card"
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
      >
        <div className="onboard-icon-badge">
          <Sparkles size={20} />
        </div>
        <div className="onboard-text">
          <h4>How Step-Up SIP Multiplies Your Wealth</h4>
          <p>
            A <strong>Step-Up SIP</strong> models a monthly contribution that you choose to increase each year. The calculation does not assume that your salary or savings capacity will rise.
          </p>
        </div>
      </motion.div>

      {(isCalculating || projectionError) && (
        <div className="sup-onboarding-card" role="status">
          <div className="onboard-icon-badge"><Sparkles size={18} /></div>
          <div className="onboard-text">
            <h4>{projectionError ? 'Projection unavailable' : 'Updating projection'}</h4>
            <p>{projectionError || 'The authoritative backend is recalculating the chart and result cards.'}</p>
          </div>
        </div>
      )}

      {/* SPACIOUS 2x2 CONTROL CARDS GRID */}
      <motion.div
        className="sup-controls-grid"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
      >
        {/* Card 1: Base SIP */}
        <div className="sup-control-card card-sky">
          <div className="sup-card-header">
            <div className="sup-icon-box box-sky">
              <Wallet size={18} />
            </div>
            <div>
              <h3 className="sup-card-title">Starting Monthly Savings</h3>
              <p className="sup-card-desc">Initial amount saved every month</p>
            </div>
          </div>
          
          <div className="sup-value-hero">
            <span className="unit-symbol text-sky">₹</span>
            <input 
              type="number"
              value={baseSIP}
              onChange={e => {
                const val = e.target.value === '' ? '' : Math.min(1000000, Number(e.target.value));
                setBaseSIP(val);
              }}
              onBlur={() => {
                if (baseSIP === '' || Number(baseSIP) < 500) setBaseSIP(500);
              }}
              className="sup-num-input text-sky"
            />
          </div>

          <div className="sup-slider-wrap">
            <input
              type="range" 
              value={Number(baseSIP) || 0} 
              onChange={e => setBaseSIP(Number(e.target.value))}
              min="1000" 
              max="100000" 
              step="1000" 
              className="sup-slider slider-sky"
              style={{
                background: `linear-gradient(to right, #38bdf8 0%, #0ea5e9 ${baseSipPct}%, rgba(255, 255, 255, 0.08) ${baseSipPct}%, rgba(255, 255, 255, 0.08) 100%)`
              }}
            />
            <div className="sup-range-labels">
              <span>₹1,000</span>
              <span>₹1,00,000</span>
            </div>
          </div>
        </div>

        {/* Card 2: Annual Step-Up % */}
        <div className="sup-control-card card-purple">
          <div className="sup-card-header">
            <div className="sup-icon-box box-purple">
              <TrendingUp size={18} />
            </div>
            <div>
              <h3 className="sup-card-title">Yearly Step-Up Increase</h3>
              <p className="sup-card-desc">Annual percentage increase in savings</p>
            </div>
          </div>
          
          <div className="sup-value-hero">
            <input 
              type="number"
              value={stepUpPercent}
              onChange={e => {
                const val = e.target.value === '' ? '' : Math.min(50, Number(e.target.value));
                setStepUpPercent(val);
              }}
              onBlur={() => {
                if (stepUpPercent === '' || Number(stepUpPercent) < 0) setStepUpPercent(0);
              }}
              className="sup-num-input text-purple"
            />
            <span className="unit-symbol text-purple">%</span>
          </div>

          <div className="sup-slider-wrap">
            <input
              type="range" 
              value={Number(stepUpPercent) || 0} 
              onChange={e => setStepUpPercent(Number(e.target.value))}
              min="0" 
              max="50" 
              step="1" 
              className="sup-slider slider-purple"
              style={{
                background: `linear-gradient(to right, #c084fc 0%, #a855f7 ${stepUpPct}%, rgba(255, 255, 255, 0.08) ${stepUpPct}%, rgba(255, 255, 255, 0.08) 100%)`
              }}
            />
            <div className="sup-range-labels">
              <span>0% (Flat)</span>
              <span>50%</span>
            </div>
          </div>

          {/* Quick Presets */}
          <div className="sup-presets-row">
            {[
              { label: 'Flat (0%)', val: 0 },
              { label: '5% Increase', val: 5 },
              { label: 'Recommended 10%', val: 10 }
            ].map(preset => (
              <button
                key={preset.val}
                type="button"
                onClick={() => setStepUpPercent(preset.val)}
                className={`preset-btn ${stepUpPercent === preset.val ? 'active' : ''}`}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>

        {/* Card 3: Horizon */}
        <div className="sup-control-card card-sky">
          <div className="sup-card-header">
            <div className="sup-icon-box box-sky">
              <Calendar size={18} />
            </div>
            <div>
              <h3 className="sup-card-title">Investment Period</h3>
              <p className="sup-card-desc">Years you plan to stay invested</p>
            </div>
          </div>
          
          <div className="sup-value-hero">
            <input 
              type="number"
              value={years}
              onChange={e => {
                const val = e.target.value === '' ? '' : Math.min(50, Number(e.target.value));
                setYears(val);
              }}
              onBlur={() => {
                if (years === '' || Number(years) < 1) setYears(1);
              }}
              className="sup-num-input text-sky"
            />
            <span className="unit-symbol text-sky">Years</span>
          </div>

          <div className="sup-slider-wrap">
            <input
              type="range" 
              value={Number(years) || 0} 
              onChange={e => setYears(Number(e.target.value))}
              min="1" 
              max="40" 
              step="1" 
              className="sup-slider slider-sky"
              style={{
                background: `linear-gradient(to right, #38bdf8 0%, #0ea5e9 ${yearsPct}%, rgba(255, 255, 255, 0.08) ${yearsPct}%, rgba(255, 255, 255, 0.08) 100%)`
              }}
            />
            <div className="sup-range-labels">
              <span>1 Year</span>
              <span>40 Years</span>
            </div>
          </div>
        </div>

        {/* Card 4: Explicit return assumption */}
        <div className="sup-control-card card-purple">
          <div className="sup-card-header">
            <div className="sup-icon-box box-purple">
              <Target size={18} />
            </div>
            <div>
              <h3 className="sup-card-title">Assumed Growth Rate (CAGR)</h3>
              <p className="sup-card-desc">Your pre-tax yearly return input</p>
            </div>
          </div>
          
          <div className="sup-value-hero">
            <input 
              type="number"
              step="0.5"
              value={returnRate}
              onChange={e => {
                const val = e.target.value === '' ? '' : Math.min(50, Number(e.target.value));
                setReturnRate(val);
              }}
              onBlur={() => {
                if (returnRate === '' || Number(returnRate) < 1) setReturnRate(1);
              }}
              className="sup-num-input text-purple"
            />
            <span className="unit-symbol text-purple">% p.a.</span>
          </div>

          <div className="sup-slider-wrap">
            <input
              type="range" 
              value={Number(returnRate) || 0} 
              onChange={e => setReturnRate(Number(e.target.value))}
              min="1" 
              max="30" 
              step="0.5" 
              className="sup-slider slider-purple"
              style={{
                background: `linear-gradient(to right, #c084fc 0%, #a855f7 ${cagrPct}%, rgba(255, 255, 255, 0.08) ${cagrPct}%, rgba(255, 255, 255, 0.08) 100%)`
              }}
            />
            <div className="sup-range-labels">
              <span>1%</span>
              <span>30%</span>
            </div>
          </div>
        </div>
      </motion.div>

      {/* KEY COMPOUNDING RESULT CARDS */}
      <div className="sup-results-grid">
        <motion.div 
          className="result-card" 
          initial={{ opacity: 0, y: 20 }} 
          animate={{ opacity: 1, y: 0 }} 
          transition={{ delay: 0.25 }}
        >
          <div className="result-icon icon-grey">
            <PiggyBank size={20} />
          </div>
          <span className="result-label">Regular Savings (Flat SIP)</span>
          <span className="result-value text-white">{formatCompactINR(flatFinal)}</span>
          <span className="result-sub">Invested: {formatCompactINR(flatInvested)}</span>
        </motion.div>

        <motion.div 
          className="result-card result-card--booster" 
          initial={{ opacity: 0, y: 20 }} 
          animate={{ opacity: 1, y: 0 }} 
          transition={{ delay: 0.35 }}
        >
          <div className="result-icon icon-purple">
            <Rocket size={20} />
          </div>
          <span className="result-label">Booster Savings (Step-Up SIP)</span>
          <span className="result-value text-purple">{formatCompactINR(stepUpFinal)}</span>
          <span className="result-sub">Invested: {formatCompactINR(stepUpInvested)}</span>
        </motion.div>

        <motion.div 
          className="result-card result-card--gain" 
          initial={{ opacity: 0, y: 20 }} 
          animate={{ opacity: 1, y: 0 }} 
          transition={{ delay: 0.45 }}
        >
          <div className="result-icon icon-green">
            <ArrowUpRight size={20} />
          </div>
          <span className="result-label">Extra projected corpus</span>
          <span className="result-value text-green">+ {formatCompactINR(additionalCorpus)}</span>
          <span className="result-sub text-green-bold">{additionalPercent === null ? 'Projection unavailable' : `${additionalPercent}% more projected corpus`}</span>
        </motion.div>
      </div>

      {/* Details Toggle Button */}
      <div className="chart-toggle-wrap">
        <button
          onClick={() => setShowDetails(!showDetails)}
          className="chart-toggle-btn"
        >
          <span>{showDetails ? 'Hide Growth Chart' : 'Show Growth Chart'}</span>
          {showDetails ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
      </div>

      {showDetails && (
        <motion.div
          className="sup-chart-wrapper"
          initial={{ opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.4 }}
        >
          <h3>Regular Savings vs. Booster Step-Up SIP Growth Comparison</h3>
          <div style={{ width: '100%', height: 420 }}>
            <ResponsiveContainer initialDimension={{ width: 1, height: 1 }}>
              <AreaChart data={chartData} margin={{ top: 20, right: 30, left: 16, bottom: 20 }}>
                <defs>
                  <linearGradient id="flatGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#0ea5e9" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#0ea5e9" stopOpacity={0.0} />
                  </linearGradient>
                  <linearGradient id="stepGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#a78bfa" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="#a78bfa" stopOpacity={0.0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
                <XAxis dataKey="year" stroke="#94a3b8" tick={{ fill: '#64748b', fontSize: 12, fontWeight: 600 }} axisLine={false} tickLine={false} minTickGap={20} />
                <YAxis tickFormatter={formatCompactINR} stroke="#94a3b8" tick={{ fill: '#64748b', fontSize: 12, fontWeight: 600 }} axisLine={false} tickLine={false} />
                <Tooltip content={<CustomTooltip />} />
                <Legend wrapperStyle={{ paddingTop: 20, fontWeight: 700, fontSize: '0.85rem' }} />
                <Area type="monotone" dataKey="flatSIP" name="Regular Savings (Flat SIP)" stroke="#0ea5e9" fill="url(#flatGrad)" strokeWidth={2.5} dot={false} activeDot={{ r: 6, fill: '#0ea5e9', stroke: '#fff', strokeWidth: 2 }} />
                <Area type="monotone" dataKey="stepUpSIP" name="Booster Savings (Step-Up SIP)" stroke="#a78bfa" fill="url(#stepGrad)" strokeWidth={3.5} dot={false} activeDot={{ r: 7, fill: '#a78bfa', stroke: '#fff', strokeWidth: 2 }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </motion.div>
      )}
    </div>
  );
};

export default StepUpPlanner;
