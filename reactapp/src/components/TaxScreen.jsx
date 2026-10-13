import React, { useState, useMemo, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { motion, AnimatePresence } from 'framer-motion';
import { formatINR, formatPercent } from '../utils/indianNumberFormat';
import { ShieldCheck, Calculator, Wallet, Receipt, Percent, PiggyBank, TrendingDown, Info, Sparkles, IndianRupee, HelpCircle, Layers, ArrowUpRight, CheckCircle2, Heart, ToggleLeft, ToggleRight, Landmark, Coins } from 'lucide-react';
import JargonTooltip from './JargonTooltip';
import api from '../services/api';
import { isPresentFiniteNumber } from '../utils/financialValues';
import './TaxScreen.css';

const TaxScreen = ({ profile, recommendations = [], onLearnMore }) => {
  const [annualIncome, setAnnualIncome] = useState(null);
  const [incomeSource, setIncomeSource] = useState('');
  const [fiscalYear, setFiscalYear] = useState('');
  const [regime, setRegime] = useState('');
  const [existing80C, setExisting80C] = useState('');
  const [existing80CCD, setExisting80CCD] = useState('');
  const [existingHRA, setExistingHRA] = useState('');
  const [existingHomeLoan, setExistingHomeLoan] = useState('');
  const [existing80DSelf, setExisting80DSelf] = useState('');
  const [existing80DParents, setExisting80DParents] = useState('');
  const [parentsSenior, setParentsSenior] = useState(null);
  const [showSlabBreakdown, setShowSlabBreakdown] = useState(false);

  // Server state tracking
  const taxInputKey = JSON.stringify([
    annualIncome, fiscalYear, incomeSource, existing80C, existing80CCD,
    existingHRA, existingHomeLoan, existing80DSelf, existing80DParents,
    parentsSenior, profile?.age,
  ]);
  const [serverTaxResult, setServerTaxResult] = useState(null);
  const serverTaxData = serverTaxResult?.inputKey === taxInputKey ? serverTaxResult.data : null;
  const [isLoading, setIsLoading] = useState(false);
  const [apiError, setApiError] = useState(null);
  const [taxPolicyMetadata, setTaxPolicyMetadata] = useState(null);
  const [taxPolicyStatus, setTaxPolicyStatus] = useState('loading');
  const [taxPolicyError, setTaxPolicyError] = useState(null);
  const [taxPolicyRetry, setTaxPolicyRetry] = useState(0);

  const normalizedAnnualIncome = isPresentFiniteNumber(annualIncome) ? Number(annualIncome) : null;
  const annualIncomeIsValid = normalizedAnnualIncome !== null
    && normalizedAnnualIncome >= 0
    && normalizedAnnualIncome <= 12000000;
  const ageValue = isPresentFiniteNumber(profile?.age) ? Number(profile.age) : null;
  const ageIsValid = Number.isInteger(ageValue) && ageValue >= 18 && ageValue <= 120;
  const verifiedFiscalYears = taxPolicyMetadata?.verifiedFiscalYears || [];
  const fiscalYearIsVerified = taxPolicyStatus === 'ready' && verifiedFiscalYears.includes(fiscalYear);

  useEffect(() => {
    if (typeof api.getTaxPolicyMetadata !== 'function') {
      setTaxPolicyStatus('failed');
      setTaxPolicyError('Verified tax-year information is unavailable.');
      return undefined;
    }
    const controller = new AbortController();
    setTaxPolicyStatus('loading');
    setTaxPolicyError(null);
    api.getTaxPolicyMetadata({ signal: controller.signal })
      .then(metadata => {
        if (controller.signal.aborted) return;
        if (!Array.isArray(metadata?.verifiedFiscalYears)) {
          throw new Error('Tax policy metadata did not contain verified fiscal years.');
        }
        setTaxPolicyMetadata(metadata);
        setTaxPolicyStatus('ready');
        setFiscalYear(current => metadata.verifiedFiscalYears.includes(current)
          ? current
          : (metadata.currentFiscalYearVerified && metadata.verifiedFiscalYears.includes(metadata.currentFiscalYear)
            ? metadata.currentFiscalYear
            : ''));
      })
      .catch(error => {
        if (controller.signal.aborted || error?.code === 'REQUEST_ABORTED') return;
        setTaxPolicyMetadata(null);
        setFiscalYear('');
        setTaxPolicyStatus('failed');
        setTaxPolicyError('Verified tax-year information could not be loaded.');
      });
    return () => controller.abort();
  }, [taxPolicyRetry]);

  // ── Debounced API Synchronisation ──
  useEffect(() => {
    if (!annualIncomeIsValid || !incomeSource || !fiscalYearIsVerified || !ageIsValid) {
      setIsLoading(false);
      setApiError(null);
      return undefined;
    }
    let active = true;
    const controller = new AbortController();
    setIsLoading(true);
    setApiError(null);

    const timer = setTimeout(async () => {
      try {
        const payload = {
          section80C: existing80C === '' ? 0 : Number(existing80C),
          nps80CCD1B: existing80CCD === '' ? 0 : Number(existing80CCD),
          hra: existingHRA === '' ? 0 : Number(existingHRA),
          homeLoanInterest: existingHomeLoan === '' ? 0 : Number(existingHomeLoan),
          section80D_self: existing80DSelf === '' ? 0 : Number(existing80DSelf),
          section80D_parents: existing80DParents === '' ? 0 : Number(existing80DParents),
          parents_senior: existing80DParents === '' ? undefined : parentsSenior,
          age: profile?.age,
          incomeSource,
          fiscalYear,
        };
        const response = await api.compareTax(normalizedAnnualIncome, payload, { signal: controller.signal });
        if (active) {
          setServerTaxResult({ inputKey: taxInputKey, data: response });
          setApiError(null);
        }
      } catch (err) {
        if (err?.code === 'REQUEST_ABORTED') return;
        console.error("Backend tax query failed; authoritative tax values are unavailable:", err);
        if (active) {
          setApiError(err.message || "Failed to synchronise with tax slabs server.");
        }
      } finally {
        if (active) {
          setIsLoading(false);
        }
      }
    }, 450); // Debounce delay prevents API throttling

    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [annualIncomeIsValid, ageIsValid, normalizedAnnualIncome, fiscalYearIsVerified, fiscalYear, incomeSource, existing80C, existing80CCD, existingHRA, existingHomeLoan, existing80DSelf, existing80DParents, parentsSenior, profile?.age, taxInputKey]);

  const section80CLimit = serverTaxData?.deduction_limits?.section80C ?? null;
  const section80CCDLimit = serverTaxData?.deduction_limits?.section80CCD1B ?? null;
  const self80DLimit = serverTaxData?.deduction_limits?.section80DSelf ?? null;
  const parents80DLimit = serverTaxData?.deduction_limits?.section80DParents ?? null;
  const remaining80C = serverTaxData?.remaining_deductions?.section80C ?? null;
  const remaining80CCD = serverTaxData?.remaining_deductions?.section80CCD1B ?? null;

  const taxSavingRecs = useMemo(() => {
    return recommendations
      .filter(item => item.goalTags?.includes('Tax Saving'))
      .map(item => {
        return {
          ...item,
          taxClassification: item.taxClassification?.dataClass === 'VERIFIED_PRODUCT_FACT'
            ? item.taxClassification
            : null,
          suggestedAmount: Number(item.monthly_allocation) * 12,
          expected_return_min: Number(item.nominalReturn),
          expected_return_max: Number(item.nominalReturn),
        };
      });
  }, [recommendations]);

  // Authoritative financial values always come from the backend.
  const totalTax = serverTaxData && regime
    ? (regime === 'new' ? serverTaxData.new_regime.tax : serverTaxData.old_regime.tax)
    : null;

  const taxableIncome = serverTaxData && regime
    ? (regime === 'new' ? serverTaxData.new_regime.taxable_income : serverTaxData.old_regime.taxable_income)
    : null;

  const effectiveRate = serverTaxData && regime
    ? (regime === 'new' ? serverTaxData.new_regime.effective_rate : serverTaxData.old_regime.effective_rate)
    : null;

  const standardDeduction = serverTaxData && regime
    ? (regime === 'new' ? serverTaxData.new_regime.standard_deduction : serverTaxData.old_regime.standard_deduction)
    : null;

  const potentialSaving = serverTaxData && regime
    ? (regime === 'old' ? serverTaxData.potential_tax_saving : 0)
    : null;

  const betterRegime = serverTaxData
    ? (serverTaxData.saving === 0 ? 'Either' : (serverTaxData.recommended_regime === 'new' ? 'New' : 'Old'))
    : 'Unavailable';

  const betterRegimeSavings = serverTaxData?.saving ?? null;

  // Breakdown lists for slabs tables
  const newRegimeSlabs = serverTaxData?.new_regime?.slab_breakdown ?? [];
  const oldRegimeSlabs = serverTaxData?.old_regime?.slab_breakdown ?? [];

  const activeSlabs = regime === 'new' ? newRegimeSlabs : regime === 'old' ? oldRegimeSlabs : [];

  // Crossover breakpoint
  const crossoverBreakpoint = serverTaxData?.crossover_breakpoint ?? null;
  const currentDeductions = (Number(existing80C) || 0) + (Number(existing80CCD) || 0);

  const taxOldVal = serverTaxData?.old_regime?.tax ?? null;
  const taxNewVal = serverTaxData?.new_regime?.tax ?? null;

  const regimeChartData = [
    { label: 'Old Regime', value: taxOldVal, fill: 'url(#colorOld)' },
    { label: 'New Regime', value: taxNewVal, fill: 'url(#colorNew)' },
  ];

  const optimizationChartData = [
    { label: 'Current Tax', value: totalTax, fill: 'url(#colorCurrent)' },
    { label: 'After Optimization', value: serverTaxData?.optimized_old_regime_tax ?? null, fill: 'url(#colorOpt)' },
  ];

  return (
    <div className="tax-page">
      {/* Visual Ambient Orbs */}
      <div className="tax-bg-orb tax-bg-orb--1" />
      <div className="tax-bg-orb tax-bg-orb--2" />

      <motion.header 
        className="tax-page-header"
        initial={{ opacity: 0, y: -15 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <div className="tax-page-badge">
          <ShieldCheck size={11} style={{ marginRight: 6 }} />
          Tax Optimizer
        </div>
        <h1 className="tax-page-title">Save Money on Taxes</h1>
        <p className="tax-page-subtitle">
          Find out how much tax you owe, which tax system saves you more, and discover easy ways to reduce your tax bill.
        </p>
        <div className="tax-header-divider" />
      </motion.header>

      {/* UNVERIFIED TAX DATA WARNING */}
      <AnimatePresence>
        {serverTaxData && (serverTaxData.verified === false || serverTaxData.warning) && (
          <motion.div 
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="tax-warning-banner"
          >
            <div className="tax-warning-icon-wrapper">
              <Info size={22} />
            </div>
            <div>
              <h2 className="tax-warning-title">UNVERIFIED TAX DATA</h2>
              <p className="tax-warning-text">
                {serverTaxData.warning || 'The tax slabs used for this calculation have not been confirmed against an official gazette source. Do not use this for actual tax filing.'}
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Verdict Banner */}
      <motion.div 
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        className="tax-verdict-banner"
      >
        <div className="tax-verdict-icon-wrapper">
          <Sparkles size={24} />
        </div>
        <div>
          <h2 className="tax-verdict-title">Our Recommendation</h2>
          <p className="tax-verdict-text">
            {taxPolicyStatus === 'loading' ? (
              <span>Loading verified tax-year information…</span>
            ) : taxPolicyStatus === 'failed' ? (
              <span>Verified tax-year information is unavailable. Retry the tax policy request below.</span>
            ) : !annualIncomeIsValid ? (
              <span>Enter your gross yearly income below before requesting a tax comparison.</span>
            ) : !incomeSource || !fiscalYearIsVerified ? (
              <span>Select your income source and a verified fiscal year below to run a server-verified tax comparison.</span>
            ) : !ageIsValid ? (
              <span>Your age is required to compare both tax regimes. Add a valid age to your Financial Profile.</span>
            ) : apiError ? (
              <span>Authoritative tax results are unavailable. No local fallback calculation is being shown.</span>
            ) : !serverTaxData ? (
              <span>The authoritative tax service is calculating your comparison.</span>
            ) : betterRegime !== 'Either' ? (
              <span>You'll pay less tax with the <strong>{betterRegime} Regime</strong> - saving <strong>{formatINR(betterRegimeSavings)}</strong> compared to the other option!</span>
            ) : (
              <span>Good news! Both tax systems cost you the same amount - so you can pick whichever you prefer.</span>
            )}
          </p>
        </div>
      </motion.div>

      {/* Sync / Loading Indicator */}
      <AnimatePresence>
        {isLoading && (
          <motion.div 
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="tax-sync-loader"
          >
            <div className="spinner-loader" />
            Calculating your taxes...
          </motion.div>
        )}
      </AnimatePresence>

      {/* Offline Mode Indicator */}
      <AnimatePresence>
        {apiError && !isLoading && (
          <motion.div 
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="tax-offline-notice"
          >
            <Info size={14} />
            <span>{apiError}. Authoritative tax values are unavailable; no local fallback is being used.</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Celebration Banner for Zero Tax */}
      <AnimatePresence>
        {serverTaxData && regime && totalTax === 0 && (
          <motion.div 
            className="tax-zero-banner"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
          >
            <CheckCircle2 size={28} className="tax-zero-icon-green" />
            <div>
              <div style={{ fontWeight: 800 }}>You Pay Zero Tax</div>
              <div style={{ fontSize: '0.85rem', color: '#a7f3d0', marginTop: 2 }}>
                Your income is below the tax-free limit. You do not need to pay any income tax under the {regime === 'new' ? 'New' : 'Old'} Regime.
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Inputs Section */}
      <motion.div 
        className="tax-controls"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
      >
        {/* Gross Income Slider Card */}
        <div className="tax-control-card">
          <div className="tax-control-card-header">
            <div className="tax-control-card-icon tax-control-card-icon--blue">
              <Wallet size={20} />
            </div>
            <label>Your Yearly Income (before tax)</label>
          </div>
          
          <input 
            type="range" 
            aria-label="Yearly gross income before tax"
            min="0" 
            max="12000000" 
            step="50000" 
            value={annualIncome ?? 0}
            onChange={(e) => setAnnualIncome(Number(e.target.value))}
            className="tax-slider"
            style={{ 
              '--val': `${((annualIncome ?? 0) / 12000000) * 100}%`
            }}
          />

          <label className="tax-input-label" htmlFor="tax-annual-income-input">Enter yearly income amount (₹)</label>
          <input
            id="tax-annual-income-input"
            className="tax-input"
            type="number"
            min="0"
            max="12000000"
            step="1"
            inputMode="numeric"
            value={annualIncome ?? ''}
            onChange={event => setAnnualIncome(event.target.value === '' ? null : Number(event.target.value))}
            aria-label="Enter yearly income amount"
          />
          <div className="tax-income-display">{annualIncomeIsValid ? formatINR(normalizedAnnualIncome) : 'Enter your yearly income'}</div>
          <div className="tax-income-sub">
            <span>Monthly equivalent: {annualIncomeIsValid ? formatINR(Math.round(normalizedAnnualIncome / 12)) : 'Not calculated'}</span>
            <span className="tax-income-badge">
              {serverTaxData?.fiscal_year ? `${serverTaxData.fiscal_year} · Verified Server Rules` : 'Select income source and fiscal year to calculate'}
            </span>
          </div>
          <label className="tax-input-label" htmlFor="tax-income-source" style={{ marginTop: 16 }}>
            Income source
          </label>
          <select
            id="tax-income-source"
            className="tax-input"
            value={incomeSource}
            onChange={(event) => {
              setIncomeSource(event.target.value);
              if (!event.target.value) setServerTaxResult(null);
            }}
            aria-label="Income source for tax calculation"
          >
            <option value="">Select income source</option>
            <option value="salary">Salary</option>
            <option value="pension">Pension</option>
            <option value="family_pension">Family pension</option>
            <option value="business">Business or profession</option>
            <option value="other">Other income</option>
          </select>
          <label className="tax-input-label" htmlFor="tax-fiscal-year" style={{ marginTop: 12 }}>
            Fiscal year
          </label>
          <select
            id="tax-fiscal-year"
            className="tax-input"
            value={fiscalYear}
            disabled={taxPolicyStatus !== 'ready'}
            onChange={(event) => {
              setFiscalYear(event.target.value);
              if (!event.target.value) setServerTaxResult(null);
            }}
            aria-label="Fiscal year for tax calculation"
          >
            <option value="">Select fiscal year</option>
            {verifiedFiscalYears.map(year => (
              <option key={year} value={year}>{year}</option>
            ))}
          </select>
          {taxPolicyStatus === 'loading' && <div role="status">Loading verified tax years…</div>}
          {taxPolicyError && (
            <div role="alert" className="tax-offline-notice">
              <Info size={14} />
              <span>{taxPolicyError}</span>
              <button type="button" onClick={() => setTaxPolicyRetry(value => value + 1)}>Retry tax policy loading</button>
            </div>
          )}
        </div>

        {/* Regime Switcher Card */}
        <div className="tax-control-card">
          <div className="tax-control-card-header">
            <div className="tax-control-card-icon tax-control-card-icon--purple">
              <Calculator size={20} />
            </div>
            <label>Choose Your Tax System</label>
          </div>
          <div className="tax-regime-toggle">
            <button 
              className={`regime-btn ${regime === 'old' ? 'regime-btn--active' : ''}`} 
              onClick={() => setRegime('old')}
            >
              Old Regime
            </button>
            <button 
              className={`regime-btn ${regime === 'new' ? 'regime-btn--active' : ''}`} 
              onClick={() => setRegime('new')}
            >
              New Regime
            </button>
          </div>
          {!regime ? (
            <div className="tax-better-badge tax-better-badge--info">
              <Info size={14} style={{ marginRight: 6, flexShrink: 0 }} />
              <span>Select a regime to view its calculation. The comparison itself evaluates both.</span>
            </div>
          ) : serverTaxData && betterRegime !== 'Either' ? (
            <div className="tax-better-badge">
              <CheckCircle2 size={14} style={{ marginRight: 6, flexShrink: 0 }} />
              <span><strong>Tip:</strong> The {betterRegime} Regime saves you <strong>{formatINR(betterRegimeSavings)}</strong></span>
            </div>
          ) : serverTaxData ? (
            <div className="tax-better-badge tax-better-badge--info">
              <Info size={14} style={{ marginRight: 6, flexShrink: 0 }} />
              <span>Both systems charge the same tax. You can pick either one.</span>
            </div>
          ) : null}
        </div>

        {/* Tax-Saving Deductions Panel (Old Regime Only) */}
        <AnimatePresence>
          {regime === 'old' && (
            <motion.div 
              className="tax-deductions-panel"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
            >
              {/* 80C Deduction */}
              <div className="tax-control-card tax-control-card--small">
                <label className="tax-input-label" htmlFor="tax-80c-input">
                  <JargonTooltip term="Eligible investment deductions">Eligible investment deductions</JargonTooltip>
                </label>
                <div className="tax-input-subtext">
                  Enter only deductions you have independently established as eligible.
                </div>
                <div className="tax-input-wrapper">
                  <span className="tax-input-prefix">₹</span>
                  <input 
                    id="tax-80c-input"
                    aria-label="Eligible investment deductions already claimed"
                    type="number" 
                    value={existing80C} 
                    onChange={e => setExisting80C(e.target.value)} 
                    max={section80CLimit ?? undefined} 
                    className="tax-input" 
                    placeholder="0"
                  />
                </div>
                <div className="tax-input-hint">Limit: {section80CLimit === null ? 'calculated by server' : `${formatINR(section80CLimit)} per year`}</div>
              </div>

              {/* NPS 80CCD */}
              <div className="tax-control-card tax-control-card--small">
                <label className="tax-input-label" htmlFor="tax-nps-input">
                  <JargonTooltip term="NPS">Pension (NPS) Savings</JargonTooltip>
                </label>
                <div className="tax-input-subtext">
                  Enter only a contribution eligible under the selected fiscal-year policy.
                </div>
                <div className="tax-input-wrapper">
                  <span className="tax-input-prefix">₹</span>
                  <input 
                    id="tax-nps-input"
                    aria-label="Qualifying NPS contributions already claimed"
                    type="number" 
                    value={existing80CCD} 
                    onChange={e => setExisting80CCD(e.target.value)} 
                    max={section80CCDLimit ?? undefined} 
                    className="tax-input" 
                    placeholder="0"
                  />
                </div>
                <div className="tax-input-hint">Limit: {section80CCDLimit === null ? 'calculated by server' : `${formatINR(section80CCDLimit)} per year`}</div>
              </div>

              {/* HRA Exemption */}
              <div className="tax-control-card tax-control-card--small">
                <label className="tax-input-label" htmlFor="tax-hra-input">
                  Rent Allowance (HRA)
                </label>
                <div className="tax-input-subtext">
                  Tax-free portion of your rent allowance from salary
                </div>
                <div className="tax-input-wrapper">
                  <span className="tax-input-prefix">₹</span>
                  <input 
                    id="tax-hra-input"
                    aria-label="House Rent Allowance HRA Exemption"
                    type="number" 
                    value={existingHRA} 
                    onChange={e => setExistingHRA(e.target.value === '' ? '' : Number(e.target.value))} 
                    className="tax-input" 
                    placeholder="0"
                  />
                </div>
                <div className="tax-input-hint">Enter the HRA exemption amount from your salary slip</div>
              </div>

              {/* Home Loan Interest (Sec 24b) */}
              <div className="tax-control-card tax-control-card--small">
                <label className="tax-input-label" htmlFor="tax-homeloan-input">
                  Home Loan Interest
                </label>
                <div className="tax-input-subtext" style={{ minHeight: '34px' }}>
                  Interest portion of EMI
                </div>
                <div className="tax-input-wrapper">
                  <span className="tax-input-prefix">₹</span>
                  <input 
                    id="tax-homeloan-input"
                    aria-label="Home loan interest"
                    type="number" 
                    value={existingHomeLoan} 
                    onChange={e => setExistingHomeLoan(e.target.value === '' ? '' : Math.min(200000, Number(e.target.value)))} 
                    max={200000} 
                    className="tax-input" 
                    placeholder="0"
                  />
                </div>
                <div className="tax-input-hint">The backend applies the selected fiscal-year policy limit.</div>
              </div>

              {/* Medical Insurance 80D - Self/Family */}
              <div className="tax-control-card tax-control-card--small">
                <label className="tax-input-label" htmlFor="tax-80d-self-input" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Heart size={13} /> Medical Insurance
                </label>
                <div className="tax-input-subtext" style={{ minHeight: '34px' }}>
                  Self, spouse, and children
                </div>
                <div className="tax-input-wrapper">
                  <span className="tax-input-prefix">₹</span>
                  <input
                    id="tax-80d-self-input"
                    aria-label="Medical insurance for self and family"
                    type="number"
                    value={existing80DSelf}
                    onChange={e => setExisting80DSelf(e.target.value)}
                    max={self80DLimit ?? undefined}
                    className="tax-input"
                    placeholder="0"
                  />
                </div>
                <div className="tax-input-hint">Limit: {self80DLimit === null ? 'calculated by server' : `${formatINR(self80DLimit)} per year`}</div>
              </div>

              {/* Medical Insurance 80D - Parents */}
              <div className="tax-control-card tax-control-card--small">
                <label className="tax-input-label" htmlFor="tax-80d-parents-input" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Heart size={13} /> Parent Insurance
                </label>
                <button
                  type="button"
                  onClick={() => setParentsSenior(prev => prev === null ? true : (prev ? false : null))}
                  className={`tax-toggle-senior-btn ${parentsSenior ? 'tax-toggle-senior-btn--active' : 'tax-toggle-senior-btn--inactive'}`}
                  aria-label="Toggle senior citizen parents for tax deduction limits"
                >
                  {parentsSenior === true ? <ToggleRight size={16} /> : <ToggleLeft size={16} />}
                  Senior citizen parents: {parentsSenior === null ? 'Not specified' : (parentsSenior ? 'Yes' : 'No')}
                </button>
                <div className="tax-input-wrapper">
                  <span className="tax-input-prefix">₹</span>
                  <input
                    id="tax-80d-parents-input"
                    aria-label="Medical insurance for parents"
                    type="number"
                    value={existing80DParents}
                    onChange={e => setExisting80DParents(e.target.value)}
                    max={parents80DLimit ?? undefined}
                    className="tax-input"
                    placeholder="0"
                  />
                </div>
                <div className="tax-input-hint">Limit: {parents80DLimit === null ? 'specify senior-citizen status to calculate' : `${formatINR(parents80DLimit)} per year`}</div>
              </div>

            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {/* Tax Summary KPIs Grid */}
      <motion.div 
        className="tax-summary-grid"
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ delay: 0.2 }}
      >
        <div className="tax-summary-card">
          <div className="tax-sum-icon"><Wallet size={20} /></div>
          <span className="tax-sum-label">Taxable Income (Salary after deductions)</span>
          <span className="tax-sum-value">{formatINR(taxableIncome)}</span>
        </div>
        <div className="tax-summary-card">
          <div className="tax-sum-icon"><Receipt size={20} /></div>
          <span className="tax-sum-label">Total Income Tax</span>
          <span className="tax-sum-value">{formatINR(totalTax)}</span>
        </div>
        <div className="tax-summary-card">
          <div className="tax-sum-icon"><Percent size={20} /></div>
          <span className="tax-sum-label">Average Tax Rate</span>
          <span className="tax-sum-value">{formatPercent(effectiveRate)}</span>
        </div>
        <div className="tax-summary-card">
          <div className="tax-sum-icon"><PiggyBank size={20} /></div>
          <span className="tax-sum-label">Potential Tax Savings</span>
          <span className="tax-sum-value">{formatINR(potentialSaving)}</span>
        </div>
      </motion.div>

      {/* Crossover Threshold Breakpoint Advisories */}
      {crossoverBreakpoint !== null && crossoverBreakpoint > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          className="tax-crossover-banner"
        >
          <div className="tax-crossover-icon-wrapper">
            <Sparkles size={24} />
          </div>
          <div>
            <h2 className="tax-crossover-title">When Should You Switch Regimes?</h2>
            <p className="tax-crossover-text">
              With your income of <strong>{formatINR(annualIncome)}</strong>, you need to invest at least <strong>{formatINR(crossoverBreakpoint)}</strong> in tax-saving options (like PF, home loan, or medical insurance) to make the Old Regime cheaper than the New Regime.
              {currentDeductions >= crossoverBreakpoint ? (
                <span> You have already declared <strong>{formatINR(currentDeductions)}</strong> in savings - which means the <strong>Old Regime is the cheaper option for you!</strong></span>
              ) : (
                <span> Currently, you have declared <strong>{formatINR(currentDeductions)}</strong> in savings. If you invest an extra <strong>{formatINR(crossoverBreakpoint - currentDeductions)}</strong> in tax-saving options, the <strong>Old Regime will become cheaper and save you money!</strong> Otherwise, the New Regime is better.</span>
              )}
            </p>
          </div>
        </motion.div>
      )}

      {/* Toggle Slab Details */}
      <div className="tax-toggle-breakdown-wrapper">
        <button
          onClick={() => setShowSlabBreakdown(!showSlabBreakdown)}
          className="tax-toggle-breakdown-btn"
        >
          {showSlabBreakdown ? 'Hide Detailed Breakdown' : 'Show Detailed Tax Breakdown & Charts'}
        </button>
      </div>

      {showSlabBreakdown && (
        <>
          {/* Slab Breakdown Details */}
          <div className="tax-slabs-grid">
            {/* Slabs table */}
            <div className="tax-slabs-container">
              <h2 className="tax-slabs-header">
                <Layers size={18} color="#38bdf8" />
                How Your Tax is Calculated ({regime === 'new' ? 'New' : 'Old'} Regime)
              </h2>
              <p className="tax-slabs-subtext">
                Your salary is split into ranges. Each range has a different tax rate. Only the income that falls in each range is taxed at that rate.
              </p>
              <table className="tax-slabs-table">
                <thead>
                  <tr>
                    <th>Income Range</th>
                    <th>Tax %</th>
                    <th>Your Income Here</th>
                    <th style={{ textAlign: 'right' }}>Tax You Pay</th>
                  </tr>
                </thead>
                <tbody>
                  {activeSlabs.map((s, idx) => {
                    const isRebate = s.isRebateRow;
                    const isTotal = s.isTotalRow;

                    if (isTotal) {
                      return (
                        <tr key={idx} className={`tax-slabs-row tax-slabs-row--total ${s.taxInSlab === 0 ? 'tax-slabs-row--total-zero' : 'tax-slabs-row--total-taxed'}`}>
                          <td colSpan={3}>
                            {s.taxInSlab === 0 ? 'Your Total Tax = ZERO' : 'Your Total Tax'}
                          </td>
                          <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                            {s.taxInSlab === 0 ? '₹0' : formatINR(s.taxInSlab)}
                          </td>
                        </tr>
                      );
                    }

                    if (isRebate) {
                      return (
                        <tr key={idx} className="tax-slabs-row tax-slabs-row--rebate">
                          <td colSpan={2}>{s.label}</td>
                          <td style={{ fontSize: '0.78rem' }}>
                            Government waives your tax
                          </td>
                          <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                            - {formatINR(Math.abs(s.taxInSlab))}
                          </td>
                        </tr>
                      );
                    }

                    // Regular slab row
                    return (
                      <tr key={idx} className={`tax-slabs-row ${s.taxableInSlab > 0 ? 'tax-slabs-row--active' : ''}`}>
                        <td style={{ fontWeight: 600 }}>
                          {s.label}
                          {s.rate === 0 && <span className="tax-slab-free-label">Tax free!</span>}
                        </td>
                        <td style={{ color: s.rate === 0 ? '#34d399' : '#cbd5e1' }}>
                          {s.rate === 0 ? 'FREE' : `${s.rate}%`}
                        </td>
                        <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                          {formatINR(s.taxableInSlab)}
                        </td>
                        <td style={{
                          textAlign: 'right',
                          fontWeight: 700,
                          fontVariantNumeric: 'tabular-nums',
                          color: s.taxInSlab > 0 ? '#f59e0b' : '#34d399'
                        }}>
                          {s.taxInSlab > 0 ? formatINR(s.taxInSlab) : '₹0'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {/* Beginner-friendly rebate explanation */}
              {activeSlabs.some(s => s.isRebateRow) && (
                <div className="tax-rebate-explainer">
                  <strong style={{ color: '#34d399' }}>What does this mean?</strong><br/>
                  The selected server policy applied a <strong>tax rebate</strong> to this explicit taxable-income result.
                  The threshold and value shown in the table come from the versioned backend calculation for {fiscalYear}.
                </div>
              )}
            </div>

            {/* Smart Insights Panel */}
            <div className="tax-insights-panel">
              <h2 className="tax-insights-header">
                <Sparkles size={18} color="#fbbf24" />
                Helpful Insights
              </h2>
              <div className="tax-insight-items">
                <div className="tax-insight-item">
                  <div className="tax-insight-icon tax-insight-icon-blue"><IndianRupee size={16} /></div>
                  <div>
                    <div className="tax-insight-title">Monthly Equivalent of Estimated Tax</div>
                    <div className="tax-insight-desc">
                      About {formatINR(totalTax === null ? null : Math.round(totalTax / 12))}/month when the annual server estimate is divided by 12. This is not a prediction of payroll <JargonTooltip term="TDS">TDS</JargonTooltip>.
                    </div>
                  </div>
                </div>

                <div className="tax-insight-item">
                  <div className="tax-insight-icon tax-insight-icon-purple"><TrendingDown size={16} /></div>
                  <div>
                    <div className="tax-insight-title">Income Net of Estimated Tax Only</div>
                    <div className="tax-insight-desc">
                      About {formatINR(totalTax === null ? null : Math.round((annualIncome - totalTax) / 12))}/month after estimated tax only; payroll deductions and other cash flows are not modeled.
                    </div>
                  </div>
                </div>

                <div className="tax-insight-item">
                  <div className="tax-insight-icon tax-insight-icon-green"><Info size={16} /></div>
                  <div>
                    <div className="tax-insight-title">Extra Charges on Tax</div>
                    <div className="tax-insight-desc">
                      {serverTaxData?.new_regime.marginal_relief_applied || serverTaxData?.old_regime.marginal_relief_applied 
                        ? `Marginal relief has been dynamically applied by server: ${formatINR(serverTaxData?.new_regime.marginal_relief_applied ? serverTaxData.new_regime.marginal_relief_amount : serverTaxData.old_regime.marginal_relief_amount)} saved.`
                        : 'The selected server policy includes applicable surcharge and cess in the displayed total.'}
                    </div>
                  </div>
                </div>

                <div className="tax-insight-item">
                  <div className="tax-insight-icon tax-insight-icon-yellow"><HelpCircle size={16} /></div>
                  <div>
                    <div className="tax-insight-title">Server-Applied Standard Deduction</div>
                    <div className="tax-insight-desc">
                      The versioned server policy applied <strong>{formatINR(standardDeduction)}</strong> for the supplied income source and regime.
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Two-Column Layout: Chart + Recommendations */}
          <div className="tax-two-col">
            {/* Old vs New Regime Comparison Chart */}
            <motion.div 
              className="tax-chart-wrapper"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3 }}
            >
              <h2>Old vs New Regime - Which Costs Less?</h2>
              <div className="tax-bar-chart-container tax-bar-chart-glow">
                <ResponsiveContainer initialDimension={{ width: 1, height: 1 }}>
                  <BarChart data={regimeChartData} margin={{ top: 20, right: 30, left: 20, bottom: 10 }}>
                    <defs>
                      <linearGradient id="colorOld" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#f97316" stopOpacity={1}/>
                        <stop offset="100%" stopColor="#ea580c" stopOpacity={0.8}/>
                      </linearGradient>
                      <linearGradient id="colorNew" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#0ea5e9" stopOpacity={1}/>
                        <stop offset="100%" stopColor="#0369a1" stopOpacity={0.8}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                    <XAxis dataKey="label" stroke="#94a3b8" tick={{ fill: '#94a3b8', fontSize: 13 }} axisLine={false} />
                    <YAxis tickFormatter={(v) => formatINR(v)} stroke="#64748b" tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} />
                    <Tooltip formatter={(v) => formatINR(v)} cursor={{ fill: 'rgba(255,255,255,0.04)' }} contentStyle={{ background: 'rgba(15,23,42,0.9)', backdropFilter: 'blur(10px)', border: '1px solid rgba(14, 165, 233, 0.4)', borderRadius: '12px', color: '#f8fafc', boxShadow: '0 10px 25px rgba(0,0,0,0.5)' }} />
                    <Bar dataKey="value" name="Tax Payable" radius={[10, 10, 0, 0]} barSize={80}>
                      {regimeChartData.map((entry, idx) => (
                        <Cell key={idx} fill={entry.fill} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </motion.div>

            {/* Slabs optimization chart (only Old regime) */}
            <div className="tax-chart-wrapper">
              <h2>Before vs After Tax-Saving Investments</h2>
              {totalTax > 0 && regime === 'old' && potentialSaving > 0 ? (
                <div className="tax-bar-chart-container tax-bar-chart-glow">
                  <ResponsiveContainer initialDimension={{ width: 1, height: 1 }}>
                    <BarChart data={optimizationChartData} margin={{ top: 20, right: 30, left: 20, bottom: 10 }}>
                      <defs>
                        <linearGradient id="colorCurrent" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#ef4444" stopOpacity={1}/>
                          <stop offset="100%" stopColor="#b91c1c" stopOpacity={0.8}/>
                        </linearGradient>
                        <linearGradient id="colorOpt" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#22c55e" stopOpacity={1}/>
                          <stop offset="100%" stopColor="#15803d" stopOpacity={0.8}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                      <XAxis dataKey="label" stroke="#94a3b8" tick={{ fill: '#94a3b8' }} axisLine={false} />
                      <YAxis tickFormatter={(v) => formatINR(v)} stroke="#64748b" tick={{ fill: '#64748b', fontSize: 11 }} axisLine={false} />
                      <Tooltip formatter={(v) => formatINR(v)} cursor={{ fill: 'rgba(255,255,255,0.04)' }} contentStyle={{ background: 'rgba(15,23,42,0.9)', backdropFilter: 'blur(10px)', border: '1px solid rgba(14, 165, 233, 0.4)', borderRadius: '12px', color: '#f8fafc', boxShadow: '0 10px 25px rgba(0,0,0,0.5)' }} />
                      <Bar dataKey="value" name="Tax Payable" radius={[10, 10, 0, 0]} barSize={80}>
                        {optimizationChartData.map((entry, idx) => (
                          <Cell key={idx} fill={entry.fill} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="tax-chart-placeholder">
                  <div className="tax-chart-placeholder-content">
                    <Info size={36} color="#475569" />
                    Tax-saving deductions only apply in the Old Regime. In the New Regime, you get lower tax rates instead - no need to make special investments.
                  </div>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* Slabs Limits Progress (Only for Old Regime) */}
      {regime === 'old' && (
        <div className="tax-limits-row">
          <div className="tax-limit-card">
            <div className="tax-limit-header"><JargonTooltip term="Eligible investment deductions">Eligible investment deductions</JargonTooltip> - How Much You've Used</div>
            <div className="tax-limit-bar-track">
              <div className="tax-limit-bar-fill" style={{ width: `${section80CLimit && remaining80C !== null ? ((section80CLimit - remaining80C) / section80CLimit) * 100 : 0}%` }} />
            </div>
            <div className="tax-limit-info">
              Deductions Claimed: {formatINR(section80CLimit && remaining80C !== null ? section80CLimit - remaining80C : null)} / {formatINR(section80CLimit)}
              <span>Remaining: {formatINR(remaining80C)}</span>
            </div>
          </div>
          <div className="tax-limit-card">
            <div className="tax-limit-header"><JargonTooltip term="Qualifying NPS contributions">Qualifying NPS contributions</JargonTooltip> - How Much You've Used</div>
            <div className="tax-limit-bar-track">
              <div className="tax-limit-bar-fill tax-limit-bar-fill--purple" style={{ width: `${section80CCDLimit && remaining80CCD !== null ? ((section80CCDLimit - remaining80CCD) / section80CCDLimit) * 100 : 0}%` }} />
            </div>
            <div className="tax-limit-info">
              Deductions Claimed: {formatINR(section80CCDLimit && remaining80CCD !== null ? section80CCDLimit - remaining80CCD : null)} / {formatINR(section80CCDLimit)}
              <span>Remaining: {formatINR(remaining80CCD)}</span>
            </div>
          </div>
        </div>
      )}

      {/* Tax-saving Instruments Suggestions */}
      {regime === 'old' && taxSavingRecs.length > 0 && (
        <motion.div 
          className="tax-recs-section"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5 }}
          style={{ marginTop: 32 }}
        >
          <h2 style={{ fontSize: '1.25rem', fontWeight: 800, color: '#fff', marginBottom: 24, display: 'flex', alignItems: 'center', gap: 8 }}>
            <PiggyBank size={22} color="#34d399" />
            Recommended Allocations — Tax Classification Required
          </h2>
          <div className="tax-recs-grid">
            {taxSavingRecs.map((rec, i) => {
              const getInstrumentIcon = (name) => {
                const n = name.toLowerCase();
                if (n.includes('bond')) return <Landmark size={18} />;
                if (n.includes('provident') || n.includes('epf') || n.includes('vpf')) return <PiggyBank size={18} />;
                if (n.includes('insurance') || n.includes('ulip') || n.includes('linked') || n.includes('endowment')) return <Heart size={18} />;
                if (n.includes('elss') || n.includes('saver') || n.includes('mutual')) return <Coins size={18} />;
                if (n.includes('pension') || n.includes('nps')) return <ShieldCheck size={18} />;
                return <Wallet size={18} />;
              };

              return (
                <motion.div 
                  key={rec.id}
                  className="tax-rec-card"
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: 0.5 + (i * 0.05) }}
                  whileHover={{ y: -6, scale: 1.01 }}
                  onClick={() => onLearnMore && onLearnMore(rec)}
                  style={{ cursor: onLearnMore ? 'pointer' : 'default' }}
                >
                  <div className="tax-rec-card-glow" />
                  <div className="tax-rec-card-header">
                    <div className="tax-rec-icon-wrapper">
                      {getInstrumentIcon(rec.name)}
                    </div>
                    <span className="tax-rec-badge">
                      {rec.taxClassification?.section
                        ? `Verified ${rec.taxClassification.section}`
                        : 'TAX CLASSIFICATION UNAVAILABLE'}
                    </span>
                  </div>
                  
                  <h3 className="tax-rec-name">{rec.name}</h3>
                  
                  <div className="tax-rec-stats">
                    <div className="tax-rec-stat">
                      <span className="tax-rec-stat-label">Current Plan / Year</span>
                      <span className="tax-rec-stat-value">{formatINR(rec.suggestedAmount)}</span>
                    </div>
                    <div className="tax-rec-stat">
                      <span className="tax-rec-stat-label">Pre-tax Nominal Assumption</span>
                      <span className="tax-rec-stat-value text-green">
                        {Number(rec.expected_return_min).toFixed(1)}% pre-tax nominal
                      </span>
                    </div>
                  </div>

                  <div className="tax-rec-footer">
                    <span className="tax-rec-explore-btn">
                      Explore Details <ArrowUpRight size={14} style={{ transition: 'transform 0.2s ease' }} />
                    </span>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </motion.div>
      )}
    </div>
  );
};

export default TaxScreen;
