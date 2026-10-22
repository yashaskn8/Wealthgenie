import React, { useState, useEffect } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { motion } from 'framer-motion';
import { TrendingUp, Rocket, PiggyBank, ArrowUpRight, Wallet, Calendar, Target, Sparkles, ChevronDown, ChevronUp } from 'lucide-react';
import { isPresentFiniteNumber } from '../utils/financialValues';
import api from '../services/api';
import JargonTooltip from './JargonTooltip';
import './StepUpPlanner.css';

const formatSipINR = value => isPresentFiniteNumber(value)
  ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(Number(value))
  : '—';

const withinPaise = value => Math.abs(value * 100 - Math.round(value * 100)) < 0.000001;
const validOptionalMoney = (value, cap) => value === '' || (
  Number.isFinite(Number(value)) && Number(value) >= 0
  && Number(value) <= cap && withinPaise(Number(value))
);

const CustomTooltip = ({ active, payload, label }) => {
  if (active && payload && payload.length) {
    return (
      <div className="sup-tooltip">
        <p className="sup-tooltip-label">{label}</p>
        {payload.map((p, i) => (
          <p key={i} style={{ color: p.color, fontWeight: 700, margin: '6px 0', fontSize: '0.85rem' }}>
            {p.name}: {formatSipINR(p.value)}
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
  const [returnRate, setReturnRate] = useState(8);
  const [inflationRate, setInflationRate] = useState(6);
  const [downsideRate, setDownsideRate] = useState(0);
  const [monthlyIncome, setMonthlyIncome] = useState(profile?.monthly_take_home ?? '');
  const [monthlyExpenses, setMonthlyExpenses] = useState('');
  const [monthlyEmi, setMonthlyEmi] = useState('');
  const [emergencySavings, setEmergencySavings] = useState(profile?.liquid_savings ?? '');
  const [incomeGrowth, setIncomeGrowth] = useState(0);
  const [expenseGrowth, setExpenseGrowth] = useState(6);
  const [showDetails, setShowDetails] = useState(false);
  const projectionBinding = JSON.stringify([
    baseSIP, stepUpPercent, years, returnRate, inflationRate, downsideRate,
    monthlyIncome, monthlyExpenses, monthlyEmi, emergencySavings, incomeGrowth, expenseGrowth,
  ]);
  const [projectionState, setProjectionState] = useState({ binding: null, status: 'idle', data: null, error: null });
  const projectionIsCurrent = projectionState.binding === projectionBinding;

  // Distinguish an explicit zero from an empty or malformed value. Invalid
  // inputs must not silently become a flat SIP or a zero-return assumption.
  const strictNumber = value => value === '' || value === null || value === undefined
    ? NaN : Number(value);
  const safeBaseSIP = strictNumber(baseSIP);
  const safeReturnRate = strictNumber(returnRate);
  const safeYears = strictNumber(years);
  const safeStepUpPercent = strictNumber(stepUpPercent);
  const projectionInputsValid = baseSIP !== '' && stepUpPercent !== '' && years !== '' && returnRate !== ''
    && Number.isFinite(safeBaseSIP) && safeBaseSIP > 0 && safeBaseSIP <= 10000000 && withinPaise(safeBaseSIP)
    && Number.isFinite(safeReturnRate) && safeReturnRate > -100 && safeReturnRate <= 100
    && Number.isInteger(safeYears) && safeYears > 0 && safeYears <= 50
    && Number.isFinite(safeStepUpPercent) && safeStepUpPercent >= 0 && safeStepUpPercent <= 100
    && [inflationRate, downsideRate, incomeGrowth, expenseGrowth].every(value => value !== '' && Number.isFinite(Number(value)))
    && Number(inflationRate) >= 0 && Number(inflationRate) <= 100
    && Number(downsideRate) > -100 && Number(downsideRate) <= safeReturnRate
    && Number(incomeGrowth) >= 0 && Number(incomeGrowth) <= 100
    && Number(expenseGrowth) >= 0 && Number(expenseGrowth) <= 100
    && validOptionalMoney(monthlyIncome, 100000000)
    && validOptionalMoney(monthlyExpenses, 100000000)
    && validOptionalMoney(monthlyEmi, 10000000)
    && validOptionalMoney(emergencySavings, 100000000);
  const projection = projectionIsCurrent && projectionState.status === 'ready' ? projectionState.data : null;
  const projectionError = projectionIsCurrent && projectionState.status === 'error' ? projectionState.error : null;
  const isCalculating = projectionInputsValid && !projectionIsCurrent;

  // Compute dynamic percentage fills for track bars
  const baseSipPct = Number.isFinite(safeBaseSIP) ? Math.min(100, Math.max(0, ((Math.min(100000, Math.max(1000, safeBaseSIP)) - 1000) / 99000) * 100)) : 0;
  const stepUpPct = Number.isFinite(safeStepUpPercent) ? Math.min(100, Math.max(0, (Math.min(50, Math.max(0, safeStepUpPercent)) / 50) * 100)) : 0;
  const yearsPct = Number.isFinite(safeYears) ? Math.min(100, Math.max(0, ((Math.min(40, Math.max(1, safeYears)) - 1) / 39) * 100)) : 0;
  const cagrPct = Number.isFinite(safeReturnRate) ? Math.min(100, Math.max(0, ((Math.min(30, Math.max(1, safeReturnRate)) - 1) / 29) * 100)) : 0;

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
        {
          signal: controller.signal,
          body: {
            inflationRate: Number(inflationRate) / 100,
            downsideAnnualReturnRate: Number(downsideRate) / 100,
            annualIncomeGrowthRate: Number(incomeGrowth) / 100,
            annualExpenseGrowthRate: Number(expenseGrowth) / 100,
            ...(monthlyIncome === '' ? {} : { monthlyIncome: Number(monthlyIncome) }),
            ...(monthlyExpenses === '' ? {} : { monthlyExpenses: Number(monthlyExpenses) }),
            ...(monthlyEmi === '' ? {} : { monthlyEmi: Number(monthlyEmi) }),
            ...(emergencySavings === '' ? {} : { emergencySavings: Number(emergencySavings) }),
          },
        },
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
    inflationRate, downsideRate, monthlyIncome, monthlyExpenses, monthlyEmi,
    emergencySavings, incomeGrowth, expenseGrowth,
  ]);

  const flatFinal = projection?.flatFinal ?? null;
  const stepUpFinal = projection?.stepUpFinal ?? null;
  const flatInvested = projection?.flatInvested ?? null;
  const stepUpInvested = projection?.stepUpInvested ?? null;
  const additionalCorpus = projection?.additionalCorpus ?? null;
  const additionalPercent = isPresentFiniteNumber(projection?.additionalPercent)
    ? Number(projection.additionalPercent).toFixed(2)
    : null;
  const chartData = projection?.chartData ?? [];
  const affordability = projection?.affordability;
  const emergency = projection?.emergency_buffer;
  const isOverBudget = affordability?.status === 'OVER_DECLARED_BUDGET';

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
          <h4>Compare savings increases without relying on live-market APIs</h4>
          <p>
            An illustrative <strong>step-up SIP</strong> increases your monthly contribution annually. Enter income, expenses and EMI below to assess whether that future contribution fits your declared budget. Returns are assumptions, never guaranteed.
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
              { label: 'Try 10%', val: 10 }
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
              <h3 className="sup-card-title">Assumed Annual Return (Nominal APR)</h3>
              <p className="sup-card-desc">Illustrative pre-tax assumption; monthly rate = APR / 12</p>
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
                if (returnRate === '' || Number(returnRate) <= -100) setReturnRate(0);
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

      <section className="sup-planning-panel" aria-label="SIP affordability and scenario inputs">
        <h3>Can you sustain this SIP?</h3>
        <p>All figures are editable. Expenses exclude EMI. Income is take-home pay. Empty amounts mean “not assessed”, not zero. Enter ₹0 when you have no EMI.</p>
        <div className="sup-planning-fields">
          {[
            ['Monthly take-home (₹)', monthlyIncome, setMonthlyIncome],
            ['Monthly living expenses excluding EMI (₹)', monthlyExpenses, setMonthlyExpenses],
            ['Monthly EMI / debt payments (₹; enter 0 if none)', monthlyEmi, setMonthlyEmi],
            ['Liquid emergency savings (₹)', emergencySavings, setEmergencySavings],
          ].map(([label, value, setValue]) => (
            <label className="sup-planning-field" key={label}>
              <span>{label}</span>
              <input type="number" min="0" step="0.01" value={value}
                placeholder="Not provided" onChange={event => setValue(event.target.value)} />
            </label>
          ))}
        </div>
        <h3>Stress-test assumptions</h3>
        <div className="sup-planning-fields">
          {[
            ['Annual inflation (%)', inflationRate, setInflationRate],
            ['Downside annual return (%)', downsideRate, setDownsideRate],
            ['Annual income growth (%)', incomeGrowth, setIncomeGrowth],
            ['Annual expense growth (%)', expenseGrowth, setExpenseGrowth],
          ].map(([label, value, setValue]) => (
            <label className="sup-planning-field" key={label}>
              <span>{label}</span>
              <input type="number" step="0.5" value={value}
                onChange={event => setValue(event.target.value)} />
            </label>
          ))}
        </div>
        <p className="sup-planning-note">All percentage defaults are illustrative inputs, not observed market facts. Leave a required rate blank to stop calculation. The downside return cannot exceed the base return. This is a constant-return what-if, not a probability forecast. EMI is held fixed. Income and expenses change once each year. The model assumes start-of-month SIPs; contributions retain paise, projected corpuses are rounded to the nearest rupee, and returns are before taxes and fees.</p>
      </section>

      <section className="sup-safety-panel" aria-live="polite">
        <h3>Financial reality checks</h3>
        {!projection && <p>{projectionInputsValid ? 'Calculating with your inputs…' : 'Enter valid numbers; the downside return must not exceed the base return.'}</p>}
        {projection && (
          <>
            <p className={isOverBudget ? 'sup-warning' : ''}>
              <strong>Budget:</strong> {affordability?.status === 'NOT_ASSESSED'
                ? 'Not assessed — enter take-home income, living expenses and EMI (0 if none).'
                : isOverBudget
                  ? `Not sustainable under entered assumptions: first shortfall in month ${affordability.firstUnaffordableMonth}; largest monthly shortfall ${formatSipINR(affordability.maxMonthlyShortfall)}.`
                  : 'Every planned instalment fits the declared monthly cash surplus across the selected horizon (not a guarantee).'}
            </p>
            <p><strong>Emergency reserve:</strong> {emergency?.status === 'DECLARED_BUFFER_SHORT'
              ? `Below the illustrative six-month buffer of ${formatSipINR(emergency.requiredAmount)}.`
              : emergency?.status === 'DECLARED_BUFFER_MET'
                ? `Your declared savings meet the illustrative six-month expense-plus-EMI buffer of ${formatSipINR(emergency.requiredAmount)}.`
                : 'Not assessed — enter living expenses, EMI and emergency savings.'}</p>
            <p><strong>Final-year monthly SIP:</strong> {formatSipINR(projection.finalMonthlySip)}. <strong>Extra money contributed:</strong> {formatSipINR(projection.additionalContributions)}. <strong>Extra projected investment growth:</strong> {formatSipINR(projection.additionalProjectedGrowth)}.</p>
            <p><strong>Downside scenario corpus:</strong> {formatSipINR(projection.downsideFinal)}. <strong>Step-up corpus in today’s purchasing power:</strong> {formatSipINR(projection.inflationAdjustedStepUpFinal)}.</p>
          </>
        )}
      </section>

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
          <span className="result-label">Projected flat SIP corpus (nearest ₹1)</span>
          <span className="result-value text-white">{formatSipINR(flatFinal)}</span>
          <span className="result-sub">Invested: {formatSipINR(flatInvested)}</span>
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
          <span className="result-label">Projected step-up corpus (nearest ₹1)</span>
          <span className="result-value text-purple">{formatSipINR(stepUpFinal)}</span>
          <span className="result-sub">Invested: {formatSipINR(stepUpInvested)}</span>
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
          <span className="result-label">Extra projected corpus (nearest ₹1)</span>
          <span className="result-value text-green">+ {formatSipINR(additionalCorpus)}</span>
          <span className="result-sub text-green-bold">{additionalPercent === null ? 'Projection unavailable' : `≈ ${additionalPercent}% more projected corpus (includes extra contributions)`}</span>
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
                <YAxis tickFormatter={formatSipINR} width={125} stroke="#94a3b8" tick={{ fill: '#64748b', fontSize: 12, fontWeight: 600 }} axisLine={false} tickLine={false} />
                <Tooltip content={<CustomTooltip />} />
                <Legend wrapperStyle={{ paddingTop: 20, fontWeight: 700, fontSize: '0.85rem' }} />
                <Area type="monotone" dataKey="flatSIP" name="Regular Savings (Flat SIP)" stroke="#0ea5e9" fill="url(#flatGrad)" strokeWidth={2.5} dot={false} activeDot={{ r: 6, fill: '#0ea5e9', stroke: '#fff', strokeWidth: 2 }} />
                <Area type="monotone" dataKey="stepUpSIP" name="Step-up (base assumption)" stroke="#a78bfa" fill="url(#stepGrad)" strokeWidth={3.5} dot={false} activeDot={{ r: 7, fill: '#a78bfa', stroke: '#fff', strokeWidth: 2 }} />
                <Area type="monotone" dataKey="downsideStepUp" name="Step-up (downside what-if)" stroke="#f97316" fillOpacity={0} dot={false} strokeWidth={2} />
                <Area type="monotone" dataKey="inflationAdjustedStepUp" name="Step-up (today's rupees)" stroke="#22c55e" fillOpacity={0} dot={false} strokeDasharray="4 4" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </motion.div>
      )}
    </div>
  );
};

export default StepUpPlanner;
