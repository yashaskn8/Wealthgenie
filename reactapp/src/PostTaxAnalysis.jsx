import React, { useEffect, useMemo, useRef, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Cell } from 'recharts';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertCircle, TrendingUp, TrendingDown, ShieldCheck, Layers, Award, ChevronDown, Zap, ArrowRight, Sparkles, Target } from 'lucide-react';
import { formatINR } from './utils/recommendationPresentation';
import { isPresentFiniteNumber, toOptionalNumber } from './utils/financialValues';
import { assertPostTaxBatchResponse, assertPostTaxBatchSummary } from './utils/taxResponseIntegrity';
import * as api from './services/api';
import './PostTaxAnalysis.css';

const TAX_INPUT_LABELS = Object.freeze({
  annualGrossIncome: 'gross annual income',
  incomeSource: 'income source',
  regime: 'tax regime',
  fiscalYear: 'fiscal year',
  userAge: 'age on March 31 of the selected fiscal year',
  holdingPeriod: 'holding period or exact transaction dates',
  holdingPeriodMonths: 'holding period or exact transaction dates',
  acquisitionDate: 'acquisition date',
  redemptionDate: 'redemption date',
  section112AExemptionUsed: 'Section 112A exemption already used',
  sttConditionAssumedSatisfied: 'the explicit STT condition assumption',
  couponRate: 'coupon rate',
  redemptionChannel: 'redemption channel',
  annuityFraction: 'annuity fraction',
  retirementTiming: 'retirement timing',
  acquiredAtOriginalIssue: 'whether the bond was acquired at original issue',
  heldContinuously: 'whether the bond was held continuously to maturity',
});

const TAX_UNAVAILABLE_REASON_COPY = Object.freeze({
  MODEL_TAX_CLASS_UNAVAILABLE_FOR_GENERIC_INSTRUMENT_TYPE: 'No source-qualified tax treatment is established for this investment type.',
  PPF_SSY_EXCLUSION_ELIGIBILITY_NOT_ESTABLISHED: 'Account eligibility and contribution or payment evidence are needed before an exclusion can be applied.',
  VERIFIED_ACCOUNT_AND_PAYMENT_FACTS_REQUIRED: 'Verified account and payment facts are needed before this result can be calculated.',
  SGB_MATURITY_EXEMPTION_NOT_ESTABLISHED: 'Original-issue acquisition and continuous-holding facts are needed to establish the maturity treatment.',
  SGB_PREMATURE_REDEMPTION_TAX_CLASSIFICATION_REQUIRES_FACTS: 'The tax treatment for this redemption path is not established by the supplied facts.',
  TAX_RESIDENCY_REQUIRED_FOR_BASIC_EXEMPTION_INTERACTION: 'Residency status is required to determine whether unused basic-exemption headroom can apply to these gains.',
  SECTION_112A_PORTFOLIO_ALLOCATION_INCOMPLETE: 'All relevant qualifying equity gains must be available before the shared exemption can be allocated.',
  FISCAL_YEAR_UNSUPPORTED: 'A verified tax policy is not available for the selected fiscal year.',
});
const SIP_RETURN_METRIC_BASIS = 'MODELLED_MONTHLY_SIP_MONEY_WEIGHTED_EQUIVALENT_ANNUAL_RATE';
const SIP_RETURN_METRIC_FIELDS = Object.freeze([
  'preTaxAnnualizedReturnPercent', 'postTaxAnnualizedReturnPercent',
  'realPostTaxAnnualizedReturnPercent', 'taxDragAnnualizedPercentagePoints',
]);
const SIP_RETURN_UNAVAILABLE_REASONS = Object.freeze([
  'NO_MONTHLY_CONTRIBUTIONS', 'PROJECTION_UNAVAILABLE', 'RETURN_SOLVER_UNAVAILABLE',
]);

function hasValidSipReturnMetrics(metrics) {
  if (metrics?.basis !== SIP_RETURN_METRIC_BASIS) return false;
  if (metrics.status === 'CALCULATED') {
    return metrics.unavailableReason === null
      && SIP_RETURN_METRIC_FIELDS.every(field => isPresentFiniteNumber(metrics[field]));
  }
  return metrics.status === 'UNAVAILABLE'
    && SIP_RETURN_UNAVAILABLE_REASONS.includes(metrics.unavailableReason)
    && SIP_RETURN_METRIC_FIELDS.every(field => metrics[field] === null);
}

function describeUnavailableSipReturn(metrics) {
  if (metrics?.unavailableReason === 'NO_MONTHLY_CONTRIBUTIONS') {
    return 'No monthly contributions were supplied, so no annualized SIP return is calculated.';
  }
  if (metrics?.unavailableReason === 'PROJECTION_UNAVAILABLE') {
    return 'Annualized SIP return is unavailable because the post-tax projection could not be calculated.';
  }
  return 'Annualized SIP return is unavailable because the contribution cash flows could not be solved.';
}

function describeUnavailableResult(result) {
  const reasons = Array.isArray(result?.unavailableReasons) ? result.unavailableReasons : [];
  const requiredFacts = [...new Set(reasons.map(reason => TAX_INPUT_LABELS[reason]).filter(Boolean))];
  if (requiredFacts.length > 0) return `Required facts: ${requiredFacts.join(', ')}.`;
  const explanations = [...new Set(reasons.map(reason => TAX_UNAVAILABLE_REASON_COPY[reason]).filter(Boolean))];
  if (explanations.length > 0) return explanations.join(' ');
  return 'The backend could not establish a qualified tax class or all required product facts. No after-tax figure is shown.';
}

const PostTaxAnalysis = ({ profile, recommendations, recommendationMeta }) => {
  const [showBreakdown, setShowBreakdown] = useState(true);
  const [grossAnnualIncome, setGrossAnnualIncome] = useState('');
  const [incomeSource, setIncomeSource] = useState('');
  const [regime, setRegime] = useState('');
  const [fiscalYear, setFiscalYear] = useState('');
  const [taxYearAge, setTaxYearAge] = useState('');
  const [inflationRate, setInflationRate] = useState('');
  const [section80C, setSection80C] = useState('');
  const [nps80CCD1B, setNps80CCD1B] = useState('');
  const [section112AExemptionUsed, setSection112AExemptionUsed] = useState('');
  const [advancedDeductions, setAdvancedDeductions] = useState({});
  const [savedAnalysis, setSavedAnalysis] = useState(null);
  const [taxPolicyMetadata, setTaxPolicyMetadata] = useState(null);
  const [taxPolicyError, setTaxPolicyError] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestController = useRef(null);
  // This is a display/request identity, not a financial calculation or authority.
  const inputKey = JSON.stringify({
    profileId: profile?.profileId, version: profile?.version,
    age: profile?.age, horizon: profile?.investment_horizon_years,
    recommendationId: recommendationMeta?.recommendationId,
    allocationRevision: recommendationMeta?.allocation_revision_id,
    portfolioFingerprint: recommendationMeta?.portfolio_fingerprint,
    instruments: (recommendations || []).map(({ id, type, nominalReturn, monthly_allocation }) => (
      { id, type, nominalReturn, monthly_allocation }
    )),
    grossAnnualIncome, incomeSource, regime, fiscalYear, taxYearAge, inflationRate,
    section80C, nps80CCD1B, section112AExemptionUsed, advancedDeductions,
  });
  const backendPostTaxData = savedAnalysis?.inputKey === inputKey ? savedAnalysis.data : null;

  useEffect(() => {
    setTaxYearAge('');
  }, [profile?.profileId, profile?._id, profile?.version, profile?.age]);

  useEffect(() => {
    requestController.current?.abort();
    setLoading(false);
    setError('');
    return () => requestController.current?.abort();
  }, [inputKey]);

  useEffect(() => {
    if (typeof api.getTaxPolicyMetadata !== 'function') return undefined;
    let cancelled = false;
    api.getTaxPolicyMetadata()
      .then(metadata => {
        if (cancelled) return;
        setTaxPolicyMetadata(metadata);
        if (metadata?.currentFiscalYearVerified && metadata.currentFiscalYear) {
          setFiscalYear(current => current || metadata.currentFiscalYear);
        }
      })
      .catch(requestError => {
        if (!cancelled) setTaxPolicyError(requestError?.message || 'Verified tax policy metadata is unavailable.');
      });
    return () => { cancelled = true; };
  }, []);

  const calculate = async event => {
    event.preventDefault();
    setError('');
    setSavedAnalysis(null);
    const annualIncome = Number(grossAnnualIncome);
    const explicitInflationRate = Number(inflationRate);
    const horizon = Number(profile?.investment_horizon_years);
    const age = Number(taxYearAge);
    if (!isPresentFiniteNumber(grossAnnualIncome) || annualIncome < 0 || !incomeSource || !regime || !fiscalYear) {
      setError('Enter gross annual income before allowed deductions, income source, tax regime, and fiscal year explicitly.');
      return;
    }
    if (!Number.isFinite(explicitInflationRate) || inflationRate === '' || explicitInflationRate < 0 || explicitInflationRate > 100) {
      setError('Enter an explicit inflation rate from 0% to 100%.');
      return;
    }
    if (!Number.isInteger(age) || age < 18 || age > 120 || !Number.isFinite(horizon) || horizon <= 0) {
      setError('Enter a valid age for the selected fiscal year and provide an investment horizon before this analysis can run.');
      return;
    }
    if (recommendations.some(instrument => !isPresentFiniteNumber(instrument.nominalReturn)
        || !isPresentFiniteNumber(instrument.monthly_allocation))) {
      setError('The backend recommendation is missing required return or allocation facts.');
      return;
    }
    const instruments = recommendations.map(instrument => ({
      instrumentType: instrument.type,
      nominalRate: Number(instrument.nominalReturn) / 100,
      holdingYears: horizon,
      monthlySIP: Number(instrument.monthly_allocation),
    }));
    if (instruments.some(item => !item.instrumentType || !Number.isFinite(item.nominalRate)
        || !Number.isFinite(item.monthlySIP) || item.monthlySIP < 0)) {
      setError('The backend recommendation is missing required return or allocation facts.');
      return;
    }
    const controller = new AbortController();
    requestController.current?.abort();
    requestController.current = controller;
    try {
      setLoading(true);
      const deductions = Object.fromEntries(Object.entries({
        section80C: toOptionalNumber(section80C),
        nps80CCD1B: toOptionalNumber(nps80CCD1B),
        nps80CCD2: toOptionalNumber(advancedDeductions.nps80CCD2),
        basicSalary: toOptionalNumber(advancedDeductions.basicSalary),
        isGovtEmployee: advancedDeductions.isGovtEmployee === undefined || advancedDeductions.isGovtEmployee === ''
          ? undefined : advancedDeductions.isGovtEmployee === 'true',
        section80D_self: toOptionalNumber(advancedDeductions.section80D_self),
        section80D_parents: toOptionalNumber(advancedDeductions.section80D_parents),
        parents_senior: advancedDeductions.parents_senior === undefined || advancedDeductions.parents_senior === ''
          ? undefined : advancedDeductions.parents_senior === 'true',
        hra: toOptionalNumber(advancedDeductions.hra),
        homeLoanInterest: toOptionalNumber(advancedDeductions.homeLoanInterest),
        section80TTA: toOptionalNumber(advancedDeductions.section80TTA),
        section80TTB: toOptionalNumber(advancedDeductions.section80TTB),
      }).filter(([, value]) => value !== undefined));
      const explicitSection112AExemptionUsed = toOptionalNumber(section112AExemptionUsed);
      const data = await api.computePostTaxReturnBatch(
        instruments,
        annualIncome,
        regime,
        age,
        incomeSource,
        explicitInflationRate / 100,
        fiscalYear,
        { signal: controller.signal, body: {
          deductions,
          ...(explicitSection112AExemptionUsed !== undefined
            ? { section112AExemptionUsed: explicitSection112AExemptionUsed }
            : {}),
        } },
      );
      if (controller.signal.aborted) return;
      assertPostTaxBatchResponse(data, {
        annualIncome, incomeSource, regime, userAge: age,
        inflationRate: explicitInflationRate / 100, fiscalYear, deductions,
        section112AExemptionUsed: explicitSection112AExemptionUsed,
        instruments,
      });
      const requiredResultFields = [
        'effectiveTaxPercent', 'postTaxGain', 'taxDragWealth', 'taxDragCAGR',
        'totalInvested', 'nominalReturnPercent', 'postTaxReturnPercent', 'realReturnPercent',
      ];
      const unavailableResultFields = ['effectiveTaxPercent', 'postTaxGain', 'taxDragWealth', 'taxDragCAGR', 'postTaxReturnPercent', 'realReturnPercent'];
      if (!Array.isArray(data?.results) || data.results.length !== recommendations.length
          || data.results.some((result, index) => !result?.status || result.instrumentIndex !== index
            || result.instrumentType !== instruments[index].instrumentType
            || !hasValidSipReturnMetrics(result.sipReturnMetrics)
            || (result.status !== 'CALCULATED' && result.sipReturnMetrics.status !== 'UNAVAILABLE')
            || (result.status !== 'CALCULATED' && unavailableResultFields.some(field => result[field] != null))
            || (result.status === 'CALCULATED' && (!result.taxType || requiredResultFields.some(
              field => !Number.isFinite(result[field]),
            ))))) {
        throw new TypeError('The tax service returned an incomplete instrument analysis.');
      }
      const requiredSummaryFields = [
        'totalTaxDrag', 'keptPerThousand', 'erodedPerThousand',
        'retentionEfficiencyPercent', 'maxTaxRate',
      ];
      const portfolioStatus = data?.portfolioStatus ?? data?.summary?.status;
      if (!['COMPLETE', 'PARTIAL', 'UNAVAILABLE'].includes(portfolioStatus)) {
        throw new TypeError('The tax service returned no truthful portfolio status.');
      }
      const calculatedResultCount = data.results.filter(result => result.status === 'CALCULATED').length;
      const expectedPortfolioStatus = data.results.length > 0 && calculatedResultCount === data.results.length
        ? 'COMPLETE'
        : calculatedResultCount > 0 ? 'PARTIAL' : 'UNAVAILABLE';
      if (portfolioStatus !== expectedPortfolioStatus
          || (data?.portfolioStatus != null && data?.summary?.status != null
            && data.portfolioStatus !== data.summary.status)) {
        throw new TypeError('The tax service returned a contradictory portfolio status.');
      }
      if (portfolioStatus !== 'UNAVAILABLE' && requiredSummaryFields.some(field => !isPresentFiniteNumber(data?.summary?.[field]))) {
        throw new TypeError('The tax service returned an incomplete portfolio summary.');
      }
      if (portfolioStatus === 'UNAVAILABLE' && requiredSummaryFields.some(field => data?.summary?.[field] !== null)) {
        throw new TypeError('Unavailable tax summaries must remain null.');
      }
      assertPostTaxBatchSummary(data);
      if (!isPresentFiniteNumber(data?.assumptions?.inflationRate)) {
        throw new TypeError('The tax service returned no inflation assumption.');
      }
      setSavedAnalysis({ inputKey, data });
    } catch (requestError) {
      if (!controller.signal.aborted) setError(requestError?.message || 'Authoritative post-tax analysis is unavailable.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };

  const postTaxData = useMemo(() => {
    if (!backendPostTaxData?.results) return [];
    return recommendations.map((inv, idx) => {
      const result = backendPostTaxData.results[idx];
      return {
        ...inv,
        taxDetails: {
          status: result.status,
          taxType: result.taxType,
          calculationClass: result.calculationClass,
          taxRatePercent: result.effectiveTaxPercent,
          postTaxGain: result.postTaxGain,
          taxDragWealth: result.taxDragWealth,
          taxDragAnnualized: result.sipReturnMetrics.status === 'CALCULATED'
            ? result.sipReturnMetrics.taxDragAnnualizedPercentagePoints : null,
          unavailableExplanation: describeUnavailableResult(result),
          sipReturnUnavailableExplanation: result.sipReturnMetrics.status === 'UNAVAILABLE'
            ? describeUnavailableSipReturn(result.sipReturnMetrics) : null,
        },
        totalInvested: result.totalInvested,
        wealthGained: isPresentFiniteNumber(result.postTaxGain) ? Number(result.postTaxGain) : null,
        nominalReturn: result.nominalReturnPercent,
        preTaxSipAnnualizedReturn: result.sipReturnMetrics.status === 'CALCULATED'
          ? result.sipReturnMetrics.preTaxAnnualizedReturnPercent : null,
        postTaxReturn: result.sipReturnMetrics.status === 'CALCULATED'
          ? result.sipReturnMetrics.postTaxAnnualizedReturnPercent : null,
        realReturn: result.sipReturnMetrics.status === 'CALCULATED'
          ? result.sipReturnMetrics.realPostTaxAnnualizedReturnPercent : null,
        resultStatus: result.status,
        sipReturnMetricStatus: result.sipReturnMetrics.status,
      };
    });
  }, [recommendations, backendPostTaxData]);

  const readNumeric = value => (isPresentFiniteNumber(value) ? Number(value) : null);
  const totalTaxDragRupees = readNumeric(backendPostTaxData?.summary?.totalTaxDrag);
  const keptAmount = readNumeric(backendPostTaxData?.summary?.keptPerThousand);
  const erodedAmount = readNumeric(backendPostTaxData?.summary?.erodedPerThousand);
  const efficiencyPercent = readNumeric(backendPostTaxData?.summary?.retentionEfficiencyPercent);
  const marginalRate = readNumeric(backendPostTaxData?.summary?.maxTaxRate);
  const portfolioStatus = backendPostTaxData?.portfolioStatus || backendPostTaxData?.summary?.status || null;
  const calculatedCount = backendPostTaxData?.results?.filter(result => result.status === 'CALCULATED').length || 0;
  const displayedAssetCount = backendPostTaxData ? postTaxData.length : recommendations.length;
  const displayedAssetCountLabel = `${displayedAssetCount} ${displayedAssetCount === 1 ? 'asset' : 'assets'}`;

  const strokeDashoffset = useMemo(() => {
    return efficiencyPercent === null ? 251.2 : 251.2 - (251.2 * efficiencyPercent) / 100;
  }, [efficiencyPercent]);

  const actionableInsights = (backendPostTaxData?.insights || []).map(insight => ({
    ...insight,
    icon: insight.icon === 'trend' ? <TrendingDown size={18} /> : <ShieldCheck size={18} />,
  }));

  if (!profile || !recommendations || !Array.isArray(recommendations) || recommendations.length === 0) {
    return (
      <div className="pta-empty-state">
        <div className="pta-empty-icon"><Target size={48} /></div>
        <h3>No Recommendations Yet</h3>
        <p>Set up your financial profile to run an estimated tax and inflation what-if.</p>
      </div>
    );
  }

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: { staggerChildren: 0.06, delayChildren: 0.04 }
    }
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 20 },
    visible: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 100, damping: 16 } }
  };

  const getTaxBadgeClass = (taxType) => {
    const t = String(taxType || '').toLowerCase();
    if (t.includes('eee') || t.includes('free')) return 'pta-badge--green';
    if (t.includes('slab')) return 'pta-badge--red';
    if (t.includes('equity') || t.includes('elss') || t.includes('gains') || t.includes('capital')) return 'pta-badge--purple';
    if (t.includes('retirement') || t.includes('nps')) return 'pta-badge--blue';
    if (t.includes('gold') || t.includes('sgb')) return 'pta-badge--amber';
    return 'pta-badge--default';
  };

  const barColors = ['#38bdf8', '#c084fc', '#34d399', '#fbbf24', '#fb7185', '#f472b6'];

  return (
    <motion.div
      className="pta-root"
      initial="hidden"
      animate="visible"
      variants={containerVariants}
    >
      {/* Ambient background */}
      <div className="pta-bg-glow pta-bg-glow--1" />
      <div className="pta-bg-glow pta-bg-glow--2" />
      <div className="pta-bg-glow pta-bg-glow--3" />

      {/* ═══════ HEADER ═══════ */}
      <motion.header className="pta-header" variants={itemVariants}>
        <div className="pta-header-badge">
          <Sparkles size={13} />
          Tax & Inflation Engine
        </div>
        <h1 className="pta-header-title">
          Modeled Post-Tax Returns Summary
        </h1>
        <p className="pta-header-subtitle">
          Estimated growth under a versioned tax policy and your explicit inflation assumption
        </p>
      </motion.header>

      <motion.form
        onSubmit={calculate}
        className="pta-card"
        variants={itemVariants}
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
          gap: 14,
          marginBottom: 20,
          alignItems: 'end',
        }}
      >
        <label style={{ display: 'grid', gap: 7, color: '#cbd5e1', fontSize: '0.8rem', fontWeight: 700 }}>
          Gross annual income before allowed deductions (₹)
          <input
            aria-label="Gross annual income before allowed deductions"
            type="number"
            min="0"
            value={grossAnnualIncome}
            onChange={event => setGrossAnnualIncome(event.target.value)}
            placeholder="Enter gross income"
            className="tax-input"
          />
        </label>
        <label style={{ display: 'grid', gap: 7, color: '#cbd5e1', fontSize: '0.8rem', fontWeight: 700 }}>
          Income source
          <select aria-label="Income source" value={incomeSource} onChange={event => setIncomeSource(event.target.value)} className="tax-input">
            <option value="">Choose explicitly</option>
            <option value="salary">Salary</option>
            <option value="pension">Pension</option>
            <option value="family_pension">Family pension</option>
            <option value="business">Business</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label style={{ display: 'grid', gap: 7, color: '#cbd5e1', fontSize: '0.8rem', fontWeight: 700 }}>
          Tax regime
          <select aria-label="Tax regime" value={regime} onChange={event => setRegime(event.target.value)} className="tax-input">
            <option value="">Choose explicitly</option>
            <option value="new">New regime</option>
            <option value="old">Old regime</option>
          </select>
        </label>
        <label style={{ display: 'grid', gap: 7, color: '#cbd5e1', fontSize: '0.8rem', fontWeight: 700 }}>
          Fiscal year
          <select aria-label="Fiscal year" value={fiscalYear} onChange={event => { setFiscalYear(event.target.value); setTaxYearAge(""); }} className="tax-input">
            <option value="">Choose explicitly</option>
            {(taxPolicyMetadata?.verifiedFiscalYears || []).map(year => (
              <option key={year} value={year}>{year}</option>
            ))}
          </select>
        </label>
        <div style={{ display: 'grid', gap: 7, color: '#cbd5e1', fontSize: '0.8rem', fontWeight: 700 }}>
          <label htmlFor="post-tax-age">Your age on March 31</label>
          <input
            id="post-tax-age"
            aria-label="Your age on March 31"
            aria-describedby="post-tax-age-help"
            type="number"
            min="18"
            max="120"
            step="1"
            value={taxYearAge}
            onChange={event => setTaxYearAge(event.target.value)}
            placeholder="Enter age for this year"
            className="tax-input"
          />
          <small id="post-tax-age-help" style={{ color: '#94a3b8', fontSize: '0.75rem', fontWeight: 400 }}>
            Enter your age on March 31 of the selected fiscal year. The saved profile age is not substituted.
          </small>
        </div>
        <label style={{ display: 'grid', gap: 7, color: '#cbd5e1', fontSize: '0.8rem', fontWeight: 700 }}>
          Inflation assumption (%)
          <input
            aria-label="Inflation assumption"
            type="number"
            min="0"
            max="100"
            step="0.1"
            value={inflationRate}
            onChange={event => setInflationRate(event.target.value)}
            placeholder="Enter inflation"
            className="tax-input"
          />
        </label>
        <label style={{ display: 'grid', gap: 7, color: '#cbd5e1', fontSize: '0.8rem', fontWeight: 700 }}>
          Eligible investment deductions already claimed (₹)
          <input
            aria-label="Eligible investment deductions already claimed"
            type="number"
            min="0"
            max="150000"
            value={section80C}
            onChange={event => setSection80C(event.target.value)}
            className="tax-input"
            placeholder="Leave blank if none…"
          />
        </label>
        <label style={{ display: 'grid', gap: 7, color: '#cbd5e1', fontSize: '0.8rem', fontWeight: 700 }}>
          Qualifying NPS contributions already counted (₹)
          <input
            aria-label="Qualifying NPS contributions already counted"
            type="number"
            min="0"
            max="50000"
            value={nps80CCD1B}
            onChange={event => setNps80CCD1B(event.target.value)}
            className="tax-input"
            placeholder="Leave blank if none…"
          />
        </label>
        <label style={{ display: 'grid', gap: 7, color: '#cbd5e1', fontSize: '0.8rem', fontWeight: 700 }}>
          Section 112A exemption already used this financial year (₹)
          <input
            aria-label="Section 112A exemption already used this financial year"
            type="number"
            min="0"
            max="125000"
            value={section112AExemptionUsed}
            onChange={event => setSection112AExemptionUsed(event.target.value)}
            className="tax-input"
            placeholder="Enter 0 if none was used"
          />
          <small style={{ color: '#94a3b8', fontSize: '0.75rem', fontWeight: 400 }}>
            This is taxpayer-wide usage for the selected financial year. Enter 0 if none was used; leave blank only if unknown. Equity calculation stays unavailable until you enter an amount.
          </small>
        </label>
        <details style={{ gridColumn: '1 / -1', borderTop: '1px solid rgba(148,163,184,0.16)', paddingTop: 10 }}>
          <summary style={{ cursor: 'pointer', color: '#cbd5e1', fontWeight: 700 }}>Advanced deductions (optional)</summary>
          <p style={{ color: '#64748b', fontSize: '0.78rem', margin: '8px 0 12px' }}>
            Leave a field blank when you are not claiming it. The backend rejects deductions that need supporting facts.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12, marginTop: 10 }}>
            {[
              ['nps80CCD2', 'Employer NPS contribution (₹)', '100000000'],
              ['basicSalary', 'Basic salary for employer NPS limit (₹)', '1000000000'],
              ['section80D_self', 'Eligible health-insurance payments for self / family (₹)', '50000'],
              ['section80D_parents', 'Eligible health-insurance payments for parents (₹)', '50000'],
              ['hra', 'Eligible rent-related deduction (₹)', '100000000'],
              ['homeLoanInterest', 'Home-loan interest (₹)', '200000'],
              ['section80TTA', 'Eligible savings-interest deduction (₹)', '10000'],
              ['section80TTB', 'Eligible senior-citizen savings-interest deduction (₹)', '50000'],
            ].map(([key, label, max]) => (
              <label key={key} style={{ display: 'grid', gap: 6, color: '#94a3b8', fontSize: '0.76rem', fontWeight: 700 }}>
                {label}
                <input
                  aria-label={label}
                  type="number"
                  min="0"
                  max={max}
                  value={advancedDeductions[key] || ''}
                  onChange={event => setAdvancedDeductions(current => ({ ...current, [key]: event.target.value }))}
                  className="tax-input"
                  placeholder="Leave blank…"
                />
              </label>
            ))}
            <label style={{ display: 'grid', gap: 6, color: '#94a3b8', fontSize: '0.76rem', fontWeight: 700 }}>
              Government employee for employer NPS limit?
              <select
                aria-label="Government employee for employer NPS limit?"
                value={advancedDeductions.isGovtEmployee || ''}
                onChange={event => setAdvancedDeductions(current => ({ ...current, isGovtEmployee: event.target.value }))}
                className="tax-input"
              >
                <option value="">Not supplied</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            </label>
            <label style={{ display: 'grid', gap: 6, color: '#94a3b8', fontSize: '0.76rem', fontWeight: 700 }}>
              Are the parents senior citizens?
              <select
                aria-label="Are the parents senior citizens?"
                value={advancedDeductions.parents_senior || ''}
                onChange={event => setAdvancedDeductions(current => ({ ...current, parents_senior: event.target.value }))}
                className="tax-input"
              >
                <option value="">Not supplied</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            </label>
          </div>
        </details>
        <button type="submit" className="hud-profile-btn" disabled={loading} style={{ minHeight: 42 }}>
          {loading ? 'Calculating…' : 'Calculate explicit tax what-if'}
        </button>
        <small style={{ gridColumn: '1 / -1', color: '#64748b', lineHeight: 1.5 }}>
           MODELLED_POST_TAX_PROJECTION: gross cash flows are projected first, then backend tax events are applied. Generic product classes remain unavailable unless qualified.
         </small>
        {savedAnalysis && !backendPostTaxData && (
          <small role="status" style={{ gridColumn: '1 / -1', color: '#fbbf24' }}>
            Your financial profile, portfolio or tax inputs changed. Recalculate this result before using it.
          </small>
        )}
         {taxPolicyError && <small role="alert" style={{ gridColumn: '1 / -1', color: '#fbbf24' }}>{taxPolicyError}</small>}
        {backendPostTaxData?.policyVersion && (
          <small style={{ gridColumn: '1 / -1', color: '#94a3b8', lineHeight: 1.5 }}>
            Estimated under {backendPostTaxData.fiscalYear} policy ({backendPostTaxData.policyVersion}) using only the supplied tax inputs.
            {' '}
            {(backendPostTaxData.sourceReferences || []).map((source, index) => (
              <React.Fragment key={source.url}>
                {index > 0 ? ' · ' : ''}
                <a href={source.url} target="_blank" rel="noreferrer" style={{ color: '#38bdf8' }}>{source.authority}</a>
              </React.Fragment>
            ))}
          </small>
        )}
        {error && <p role="alert" style={{ gridColumn: '1 / -1', color: '#fda4af', margin: 0 }}>{error}</p>}
        {backendPostTaxData && (
          <small role="status" style={{ gridColumn: '1 / -1', color: portfolioStatus === 'COMPLETE' ? '#86efac' : '#fbbf24', lineHeight: 1.5 }}>
            Portfolio status: {portfolioStatus}. {portfolioStatus === 'PARTIAL'
              ? `${calculatedCount} of ${backendPostTaxData.results.length} instruments are included; unavailable instruments are excluded from totals.`
              : portfolioStatus === 'UNAVAILABLE'
                ? 'No summary number or zero has been substituted.'
                : 'All selected instruments have complete qualified projections.'}
          </small>
        )}
      </motion.form>

      {/* ═══════ HERO KPI STRIP ═══════ */}
      <motion.div className="pta-kpi-strip" variants={itemVariants}>
        <div className="pta-kpi-card pta-kpi-card--regime">
          <div className="pta-kpi-icon-wrap pta-kpi-icon--blue">
            <Layers size={18} />
          </div>
          <div className="pta-kpi-content">
            <span className="pta-kpi-label">Tax Regime</span>
            <span className="pta-kpi-value">{regime ? (regime === 'new' ? 'New System' : 'Old System') : 'Not selected'}</span>
          </div>
        </div>

        <div className="pta-kpi-divider" />

        <div className="pta-kpi-card pta-kpi-card--bracket">
          <div className="pta-kpi-icon-wrap pta-kpi-icon--purple">
            <Award size={18} />
          </div>
          <div className="pta-kpi-content">
            <span className="pta-kpi-label">Max Tax Bracket</span>
            <span className="pta-kpi-value">{!isPresentFiniteNumber(marginalRate) ? 'Not calculated' : `${(marginalRate * 100).toFixed(0)}%`}</span>
          </div>
        </div>

        <div className="pta-kpi-divider" />

        <div className="pta-kpi-card pta-kpi-card--inflation">
          <div className="pta-kpi-icon-wrap pta-kpi-icon--amber">
            <TrendingDown size={18} />
          </div>
          <div className="pta-kpi-content">
            <span className="pta-kpi-label">Inflation Rate</span>
            <span className="pta-kpi-value">{backendPostTaxData ? `${Number(backendPostTaxData.assumptions.inflationRate * 100).toFixed(1)}%` : 'Not calculated'}</span>
          </div>
        </div>

        <div className="pta-kpi-divider" />

        <div className="pta-kpi-card pta-kpi-card--erosion">
          <div className="pta-kpi-icon-wrap pta-kpi-icon--rose">
            <AlertCircle size={18} />
          </div>
          <div className="pta-kpi-content">
            <span className="pta-kpi-label">Total Tax Drag</span>
          <span className="pta-kpi-value pta-kpi-value--rose">
            {totalTaxDragRupees === null ? (backendPostTaxData ? 'Unavailable' : 'Not calculated') : formatINR(totalTaxDragRupees)}
          </span>
          </div>
        </div>
      </motion.div>

      {/* ═══════ MAIN GRID ═══════ */}
      <div className="pta-main-grid">
        {/* ─── LEFT COLUMN ─── */}
        <div className="pta-col">
          {/* Chart Card */}
          <motion.div className="pta-card" variants={itemVariants}>
            <div className="pta-card-header">
              <div>
                <h3 className="pta-card-title">Return Drag Comparison</h3>
                <p className="pta-card-subtitle">Compares the entered rate with modeled monthly SIP results after tax and inflation. These are model outputs, not forecasts.</p>
              </div>
            </div>

            <div className="pta-chart-wrap">
              {!backendPostTaxData ? <p role="status">{loading ? 'Calculating backend tax estimates…' : 'Enter your tax inputs and calculate to view return estimates.'}</p> :
              <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 1, height: 1 }}>
                <BarChart data={postTaxData} margin={{ top: 10, right: 10, left: -20, bottom: 5 }}>
                  <defs>
                    <linearGradient id="gradNominal" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.95}/>
                      <stop offset="100%" stopColor="#0284c7" stopOpacity={0.6}/>
                    </linearGradient>
                    <linearGradient id="gradPostTax" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#c084fc" stopOpacity={0.95}/>
                      <stop offset="100%" stopColor="#7c3aed" stopOpacity={0.6}/>
                    </linearGradient>
                    <linearGradient id="gradSipPreTax" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#fbbf24" stopOpacity={0.95}/>
                      <stop offset="100%" stopColor="#d97706" stopOpacity={0.6}/>
                    </linearGradient>
                    <linearGradient id="gradReal" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#34d399" stopOpacity={0.95}/>
                      <stop offset="100%" stopColor="#059669" stopOpacity={0.6}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
                  <XAxis dataKey="name" tick={{ fill: '#64748b', fontSize: 10, fontWeight: 600 }} axisLine={false} tickLine={false}
                    interval={0} angle={-35} textAnchor="end" height={70}
                    tickFormatter={name => name.length > 12 ? `${name.slice(0, 11)}…` : name} />
                  <YAxis tick={{ fill: '#475569', fontSize: 11, fontWeight: 500 }} tickFormatter={(val) => `${val}%`} axisLine={false} tickLine={false} />
                  <Tooltip
                    cursor={{ fill: 'rgba(255,255,255,0.03)', radius: 6 }}
                    contentStyle={{ background: 'rgba(2, 6, 18, 0.96)', backdropFilter: 'blur(16px)', border: '1px solid rgba(255, 255, 255, 0.1)', borderRadius: 14, color: '#f8fafc', fontSize: '0.82rem', fontWeight: 600, padding: '12px 16px', boxShadow: '0 16px 48px rgba(0,0,0,0.5)' }}
                    formatter={(value, name) => [`${Number(value).toFixed(1)}%`, name]}
                  />
                  <Legend verticalAlign="top" height={40} iconType="circle" iconSize={8} wrapperStyle={{ fontSize: '0.72rem', fontWeight: 700, color: '#94a3b8', letterSpacing: '0.3px' }}/>
                  <Bar dataKey="nominalReturn" name="Model assumption (pre-tax)" fill="url(#gradNominal)" radius={[6,6,0,0]} barSize={22} />
                  <Bar dataKey="preTaxSipAnnualizedReturn" name="Modeled SIP annualized (pre-tax)" fill="url(#gradSipPreTax)" radius={[6,6,0,0]} barSize={22} />
                  <Bar dataKey="postTaxReturn" name="Modeled SIP annualized (after tax)" fill="url(#gradPostTax)" radius={[6,6,0,0]} barSize={22} />
                  <Bar dataKey="realReturn" name="Real after-tax SIP annualized" fill="url(#gradReal)" radius={[6,6,0,0]} barSize={22} />
                </BarChart>
              </ResponsiveContainer>}
            </div>
          </motion.div>

          {/* Detailed Rates Table */}
          <motion.div className="pta-card pta-card--flush" variants={itemVariants}>
            <div className="pta-table-header" onClick={() => setShowBreakdown(!showBreakdown)} role="button" tabIndex={0}
              aria-expanded={showBreakdown} onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setShowBreakdown(value => !value); }
              }}>
              <div className="pta-table-header-left">
                <h3 className="pta-card-title">Detailed Breakdown</h3>
                <span className="pta-table-count" data-testid="post-tax-asset-count">{displayedAssetCountLabel}</span>
              </div>
              <div className="pta-table-header-right">
                <span className="pta-inflation-chip">
                  <TrendingDown size={12} /> {backendPostTaxData ? `${Number(backendPostTaxData.assumptions.inflationRate * 100).toFixed(1)}% inflation` : 'Awaiting inputs'}
                </span>
                <motion.div
                  animate={{ rotate: showBreakdown ? 180 : 0 }}
                  transition={{ duration: 0.2 }}
                  className="pta-chevron-wrap"
                >
                  <ChevronDown size={18} />
                </motion.div>
              </div>
            </div>

            <AnimatePresence>
              {showBreakdown && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                  style={{ overflow: 'hidden' }}
                >
                  <div className="pta-table-scroll" role="region" aria-label="Post-tax instrument calculations" tabIndex={0}>
                    <table className="pta-table">
                      <thead>
                        <tr>
                          <th className="pta-th--left">Asset</th>
                          <th className="pta-th--left">Tax Treatment</th>
                          <th className="pta-th--center">Model assumption (pre-tax)</th>
                          <th className="pta-th--center">Modeled SIP annualized (pre-tax)</th>
                          <th className="pta-th--center">Modeled SIP annualized (after tax)</th>
                          <th className="pta-th--center">Real after-tax SIP annualized</th>
                          <th className="pta-th--right">Post-tax gain</th>
                        </tr>
                      </thead>
                      <tbody>
                        {!backendPostTaxData && (
                          <tr>
                            <td colSpan={7} style={{ padding: '18px 14px', color: '#94a3b8', textAlign: 'center' }}>
                              After-tax estimates have not been calculated for {displayedAssetCountLabel}. Enter explicit tax inputs above and calculate to view them.
                            </td>
                          </tr>
                        )}
                        {postTaxData.map((data, i) => (
                          <tr key={data.id} className="pta-table-row" data-testid={`post-tax-row-${data.id}`}>
                            <td className="pta-td--asset">
                              <div className="pta-asset-color" style={{ background: barColors[i % barColors.length] }} />
                              <div>
                                <span className="pta-asset-name">{data.name}</span>
                                <span className="pta-asset-cat">{data.category}</span>
                              </div>
                            </td>
                            <td>
                          <span className={`pta-badge ${getTaxBadgeClass(data.taxDetails.taxType)}`}>
                                {data.resultStatus === 'CALCULATED'
                                  ? data.taxDetails.taxType
                                  : 'Unavailable — tax class or inputs required'}
                              </span>
                              {data.resultStatus !== 'CALCULATED' && (
                                <span className="pta-asset-cat" data-testid="post-tax-unavailable-explanation">
                                  {data.taxDetails.unavailableExplanation} No zero substituted.
                                </span>
                              )}
                            </td>
                            <td data-testid="nominal-return" className="pta-td--mono pta-td--center pta-td--dim">
                              {Number.isFinite(data.nominalReturn) ? `${data.nominalReturn.toFixed(1)}%` : '—'}
                            </td>
                            <td data-testid="pre-tax-sip-return" className="pta-td--mono pta-td--center pta-td--dim">
                              {Number.isFinite(data.preTaxSipAnnualizedReturn) ? `${data.preTaxSipAnnualizedReturn.toFixed(1)}%` : '—'}
                            </td>
                            <td data-testid="post-tax-return" className="pta-td--mono pta-td--center pta-td--purple">
                              {Number.isFinite(data.postTaxReturn) ? `${data.postTaxReturn.toFixed(1)}%` : '—'}
                              {data.sipReturnMetricStatus === 'UNAVAILABLE' && (
                                <span className="pta-asset-cat" data-testid="sip-return-unavailable-explanation">
                                  {data.taxDetails.sipReturnUnavailableExplanation}
                                </span>
                              )}
                            </td>
                            <td data-testid="real-return" className={`pta-td--mono pta-td--center ${data.realReturn > 0 ? 'pta-td--green' : data.realReturn < 0 ? 'pta-td--rose' : 'pta-td--dim'}`}>
                              <span className="pta-real-cell">
                                {Number.isFinite(data.realReturn) && (data.realReturn > 0
                                  ? <TrendingUp size={12} />
                                  : data.realReturn < 0 ? <TrendingDown size={12} /> : null)}
                                {Number.isFinite(data.realReturn) ? `${data.realReturn > 0 ? '+' : ''}${data.realReturn.toFixed(1)}%` : '—'}
                              </span>
                            </td>
                            <td className="pta-td--mono pta-td--right pta-td--blue pta-td--bold">
                              <span data-testid="post-tax-gain">{formatINR(data.wealthGained)}</span>
                              <details className="pta-calculation-details">
                                <summary>Calculation details</summary>
                                <dl>
                                  <dt>Total invested</dt><dd data-testid="total-invested">{formatINR(data.totalInvested)}</dd>
                                  <dt>Effective tax</dt><dd data-testid="effective-tax">{isPresentFiniteNumber(data.taxDetails.taxRatePercent) ? `${Number(data.taxDetails.taxRatePercent).toFixed(1)}%` : '—'}</dd>
                                  <dt>Tax drag (wealth)</dt><dd data-testid="tax-drag-wealth">{formatINR(data.taxDetails.taxDragWealth)}</dd>
                                  <dt>Tax drag (annualized percentage points)</dt><dd data-testid="tax-drag-cagr">{isPresentFiniteNumber(data.taxDetails.taxDragAnnualized) ? `${data.taxDetails.taxDragAnnualized.toFixed(2)} pp` : '—'}</dd>
                                  <dt>Return metric basis</dt><dd>Modeled monthly SIP money-weighted equivalent annual rate</dd>
                                  <dt>Calculation status</dt><dd>{data.resultStatus}</dd>
                                </dl>
                              </details>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </div>

        {/* ─── RIGHT COLUMN ─── */}
        <div className="pta-col">
          {/* Profit Retention Efficiency - Hero Widget */}
          {!backendPostTaxData || portfolioStatus === 'UNAVAILABLE' ? (
            <motion.div className="pta-card pta-retention-hero" variants={itemVariants}>
              <h3 className="pta-retention-label">{backendPostTaxData ? 'Profit retention unavailable' : 'Profit retention not calculated'}</h3>
              <p className="pta-retention-footnote">{backendPostTaxData ? 'The selected instruments do not have complete qualified tax projections.' : 'Calculate with explicit tax inputs to view this estimate.'} No gauge or zero value is shown.</p>
            </motion.div>
          ) : <motion.div className="pta-card pta-retention-hero" variants={itemVariants}>
            <h3 className="pta-retention-label">Profit Retention Efficiency</h3>

            <div className="pta-donut-container">
              <svg className="pta-donut-svg" viewBox="0 0 100 100">
                <defs>
                  <linearGradient id="ptaProgressGrad" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stopColor="#10b981" />
                    <stop offset="100%" stopColor="#34d399" />
                  </linearGradient>
                </defs>
                {/* Background track */}
                <circle cx="50" cy="50" r="40" className="pta-donut-track" />
                {/* Eroded portion (red) */}
                <circle cx="50" cy="50" r="40"
                  className="pta-donut-eroded"
                  strokeDasharray="251.2"
                  strokeDashoffset="0"
                  transform="rotate(-90 50 50)"
                />
                {/* Retained portion (green) */}
                <circle cx="50" cy="50" r="40"
                  className="pta-donut-fill"
                  strokeDasharray="251.2"
                  strokeDashoffset={strokeDashoffset}
                  transform="rotate(-90 50 50)"
                />
              </svg>

              <div className="pta-donut-center">
                <span className="pta-donut-pct">{efficiencyPercent === null ? '—' : `${efficiencyPercent.toFixed(1)}%`}</span>
                <span className="pta-donut-sub">RETAINED</span>
              </div>

              {/* Outer glow ring */}
              <div className="pta-donut-glow" />
            </div>

            <div className="pta-retention-metrics">
              <div className="pta-metric-pill pta-metric-pill--green">
                <span className="pta-metric-label">You Keep</span>
                <span className="pta-metric-value">{keptAmount === null ? '—' : formatINR(keptAmount)}</span>
              </div>
              <div className="pta-metric-pill pta-metric-pill--rose">
                <span className="pta-metric-label">Eroded</span>
                <span className="pta-metric-value">{erodedAmount === null ? '—' : formatINR(erodedAmount)}</span>
              </div>
            </div>
            <p className="pta-retention-footnote">Per ₹1,000 of gross profits</p>
          </motion.div>}

          {/* Tax Erosion Warning */}
          {totalTaxDragRupees > 0 && (
            <motion.div className="pta-card pta-erosion-card" variants={itemVariants}>
              <div className="pta-erosion-icon-wrap">
                <AlertCircle size={20} />
              </div>
              <div className="pta-erosion-content">
                <h4 className="pta-erosion-title">Projected Tax Erosion</h4>
                <p className="pta-erosion-text">
                  The explicit tax model estimates a reduction of roughly <strong>{formatINR(totalTaxDragRupees)}</strong> in projected gains over this horizon.
                </p>
              </div>
            </motion.div>
          )}

          {/* Advisory Actions */}
          <motion.div className="pta-card pta-advisory-card" variants={itemVariants}>
            <h3 className="pta-advisory-header">
              <Zap size={15} className="pta-advisory-icon" />
              Advisory Actions
            </h3>
            <div className="pta-advisory-list">
              {actionableInsights.map((insight, idx) => (
                <motion.div
                  key={idx}
                  className={`pta-advisory-item pta-advisory-item--${insight.color}`}
                  whileHover={{ x: 4, scale: 1.005 }}
                  transition={{ type: 'spring', stiffness: 300, damping: 20 }}
                >
                  <div className={`pta-advisory-item-icon pta-advisory-item-icon--${insight.color}`}>
                    {insight.icon}
                  </div>
                  <div className="pta-advisory-item-body">
                    <h4 className="pta-advisory-item-title">{insight.title}</h4>
                    <p className="pta-advisory-item-desc">{insight.body}</p>
                  </div>
                  <ArrowRight size={14} className="pta-advisory-arrow" />
                </motion.div>
              ))}
            </div>
          </motion.div>
        </div>
      </div>
    </motion.div>
  );
};

export default PostTaxAnalysis;
