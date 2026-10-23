import React, { useEffect, useMemo, useState } from 'react';
import {
  Building2,
  Shield,
  ShieldCheck,
  CheckCircle2,
  Target,
  Star,
  Info,
  Wallet,
  Zap,
  History as HistoryIcon,
  TrendingUp,
  AlertTriangle,
  Activity,
  Sparkles,
  ChevronDown,
  ChevronUp,
  Calculator,
  IndianRupee,
} from 'lucide-react';
import * as api from '../../services/api';
import SebiDisclaimer from '../SebiDisclaimer';
import '../DeepDiveModal.css';
import {
  formatMarketTimestamp,
  nullableMarketNumber,
  readableSource,
  safeSourceUrl,
} from '../../utils/marketDataDisplay';
import { formatINR } from '../../utils/recommendationPresentation';
import { mayDisplayContractualProceeds } from '../../utils/cashflowResultGuard';
import { isPresentFiniteNumber, toOptionalNumber } from '../../utils/financialValues';
import { getCurrentRecommendedInstrument } from '../../utils/financialStateBinding';
import UserDeclaredScenarioPanel from './UserDeclaredScenarioPanel';

const RISK_LEVELS = [
  { label: 'Low', color: '#22c55e', desc: 'Lower relative risk. Any guarantee or insurance depends on the specific product terms.' },
  { label: 'Low to Moderate', color: '#84cc16', desc: 'Limited price fluctuation may occur; review the product-specific liquidity and credit terms.' },
  { label: 'Moderate', color: '#eab308', desc: 'Market-price volatility is present and capital value can decline.' },
  { label: 'Moderately High', color: '#f97316', desc: 'Meaningful short-term volatility and loss risk are possible.' },
  { label: 'High', color: '#ef4444', desc: 'Substantial market risk and drawdowns are possible; suitability is profile-dependent.' },
  { label: 'Very High', color: '#dc2626', desc: 'The highest catalog risk tier; large and prolonged losses are possible.' },
];

const SUB_TAB_LABELS = {
  sovereign_gsec: 'Sovereign G-Sec',
  aaa_corporate: 'AAA Corporate',
  section_54ec: 'Section 54EC',
  tax_free_bonds: 'Tax-Free Bonds',
  psu_bonds: 'PSU Bonds',
  broad_market: 'Broad Market',
  sectoral_thematic: 'Sectoral & Thematic',
  smart_beta: 'Smart Beta & Factor',
  commodity: 'Commodity ETFs',
  international: 'International ETFs',
  physical_gold_etf: 'Physical Gold ETF',
  silver_etf: 'Silver ETF',
  sgb_secondary: 'SGB Secondary',
  largecap_index: 'LargeCap Index',
  next50_midcap: 'Next50 & MidCap',
  smart_beta_factor: 'Smart Beta Factor',
  large_cap: 'Large Cap',
  mid_cap: 'Mid Cap',
  small_cap: 'Small Cap',
  flexi_multi: 'Flexi & Multi Cap',
  sector_thematic: 'Sector & Thematic',
  value_contra: 'Value & Contra',
  growth_bluechip: 'Growth & Bluechip',
  momentum_quant: 'Momentum & Quant',
  dividend_yield: 'Dividend Yield',
  pharma_healthcare: 'Pharma & Healthcare',
  banking_financial: 'Banking & Financial',
  it_technology: 'IT & Technology',
  infrastructure: 'Infrastructure',
  defence_manufacturing: 'Defence & Mfg',
  energy_metals: 'Energy & Metals',
  consumption_fmcg: 'Consumption & FMCG',
  growth_momentum: 'Growth & Momentum',
  diversified_core: 'Diversified Core',
  value_quality: 'Value & Quality',
  aggressive_alpha: 'Aggressive Alpha',
  diversified_broad: 'Diversified Broad',
  quality_defensive: 'Quality Defensive',
  energy_industrial: 'Energy & Industrial',
  fmcg_consumer: 'FMCG & Consumer',
  office_reits: 'Office REITs',
  retail_reits: 'Retail REITs',
  infrastructure_invits: 'Infrastructure InvITs',
};

const ILLUSTRATIVE_PRINCIPALS = [5000, 10000, 25000, 50000, 100000];

function getRiskTierColor(tier) {
  switch (tier) {
    case 'Very Low Risk': return { color: '#22c55e', bg: 'rgba(34, 197, 94, 0.1)', border: 'rgba(34, 197, 94, 0.3)' };
    case 'Low Risk': return { color: '#84cc16', bg: 'rgba(132, 204, 22, 0.1)', border: 'rgba(132, 204, 22, 0.3)' };
    case 'Moderate Risk': return { color: '#eab308', bg: 'rgba(234, 179, 8, 0.1)', border: 'rgba(234, 179, 8, 0.3)' };
    case 'High Risk': return { color: '#ef4444', bg: 'rgba(239, 68, 68, 0.1)', border: 'rgba(239, 68, 68, 0.3)' };
    default: return { color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.1)', border: 'rgba(56, 189, 248, 0.3)' };
  }
}

const MAX_WTI_PRODUCTS = 5;
const QUALIFIED_WTI_RANKING_STATUSES = new Set(['EVIDENCE_RANKED', 'VERIFIED_COMPARABLE_OPTIONS']);

const WTI_SUPPORTED_TAX_CONTROLS = new Set([
  'annualGrossIncome', 'incomeSource', 'regime', 'fiscalYear', 'userAge',
  'holdingPeriodMonths', 'section112AExemptionUsed', 'acquisitionDate', 'redemptionDate',
  'sttConditionAssumedSatisfied',
]);

function hasCompleteWtiStateBinding(binding) {
  return Boolean(binding?.profileId)
    && Number.isSafeInteger(binding?.profileVersion) && binding.profileVersion > 0
    && Boolean(binding?.recommendationId)
    && Number.isSafeInteger(binding?.allocationRevision) && binding.allocationRevision > 0
    && Boolean(binding?.allocationRevisionId)
    && /^[a-f0-9]{64}$/i.test(binding?.portfolioFingerprint || '')
    && /^[a-f0-9]{64}$/i.test(binding?.recommendationFingerprint || '');
}

function sameWtiStateBinding(left, right) {
  return hasCompleteWtiStateBinding(left) && hasCompleteWtiStateBinding(right)
    && left.profileId === right.profileId
    && left.profileVersion === right.profileVersion
    && left.recommendationId === right.recommendationId
    && left.allocationRevision === right.allocationRevision
    && left.allocationRevisionId === right.allocationRevisionId
    && left.portfolioFingerprint === right.portfolioFingerprint
    && left.recommendationFingerprint === right.recommendationFingerprint;
}

const WhereToInvestContent = ({ inv, userProfile, recommendationMeta = null }) => {
  const profileId = userProfile?.profileId;
  const parentInstrumentId = inv?.id;
  const recommendationProfile = userProfile && userProfile.version == null && userProfile.profileVersion == null
    ? { ...userProfile, version: recommendationMeta?.profile_version }
    : userProfile;
  const currentRecommendation = getCurrentRecommendedInstrument(recommendationMeta, parentInstrumentId, recommendationProfile);
  const financialStateBinding = useMemo(() => ({
    profileId,
    profileVersion: Number(userProfile?.version ?? recommendationMeta?.profile_version),
    recommendationId: recommendationMeta?.recommendationId || recommendationMeta?.recommendation_id,
    allocationRevision: Number(recommendationMeta?.allocation_revision),
    allocationRevisionId: recommendationMeta?.allocation_revision_id,
    portfolioFingerprint: recommendationMeta?.portfolio_fingerprint,
    recommendationFingerprint: recommendationMeta?.recommendation_fingerprint,
  }), [
    profileId,
    userProfile?.version,
    recommendationMeta?.profile_version,
    recommendationMeta?.recommendationId,
    recommendationMeta?.recommendation_id,
    recommendationMeta?.allocation_revision,
    recommendationMeta?.allocation_revision_id,
    recommendationMeta?.portfolio_fingerprint,
    recommendationMeta?.recommendation_fingerprint,
  ]);
  const financialKey = JSON.stringify({
    ...financialStateBinding,
    parentInstrumentId,
    revisionId: recommendationMeta?.allocation_revision_id,
  });

  const [rankingResult, setRankingResult] = useState({
    requestKey: null,
    products: [],
    catalog: null,
    suitability: null,
    ranking: null,
    comparisonUniverse: null,
    error: null,
  });

  const wtiData = useMemo(() => (rankingResult.financialKey === financialKey && rankingResult.catalog) || ({
    riskLevel: inv?.riskScore ?? inv?.risk ?? null,
    note: null,
    howToStart: null,
  }), [inv, rankingResult, financialKey]);

  const subCategoryMap = wtiData?.sectors || wtiData?.subCategories || null;
  const subKeys = subCategoryMap ? Object.keys(subCategoryMap) : [];

  const [sortBy, setSortBy] = useState('score');

  // Illustrative principal & tax context state
  const [illustrativePrincipal, setIllustrativePrincipal] = useState(10000);
  const [showTaxDrawer, setShowTaxDrawer] = useState(false);
  const [taxAnnualIncome, setTaxAnnualIncome] = useState('');
  const [taxIncomeSource, setTaxIncomeSource] = useState('');
  const taxRegime = 'new';
  const [taxFiscalYear, setTaxFiscalYear] = useState('');
  const [taxUserAge, setTaxUserAge] = useState('');
  const [holdingPeriodMonths, setHoldingPeriodMonths] = useState('');
  const [useExactTransactionDates, setUseExactTransactionDates] = useState(false);
  const [acquisitionDate, setAcquisitionDate] = useState('');
  const [redemptionDate, setRedemptionDate] = useState('');
  const [section112AExemptionUsed, setSection112AExemptionUsed] = useState('');
  const [taxSection80C, setTaxSection80C] = useState('');
  const [taxNps80CCD1B, setTaxNps80CCD1B] = useState('');
  const [taxAdvancedDeductions, setTaxAdvancedDeductions] = useState({});
  const [sttConditionAssumedSatisfied, setSttConditionAssumedSatisfied] = useState(false);
  const [taxFormError, setTaxFormError] = useState('');
  const [taxPolicyMetadata, setTaxPolicyMetadata] = useState(null);
  const [taxPolicyError, setTaxPolicyError] = useState(null);
  const [activeTaxContext, setActiveTaxContext] = useState(null);
  const requestKey = JSON.stringify({ financialKey, activeTaxContext, illustrativePrincipal });

  useEffect(() => {
    if (typeof api.getTaxPolicyMetadata !== 'function') return undefined;
    let cancelled = false;
    api.getTaxPolicyMetadata()
      .then((metadata) => {
        if (cancelled) return;
        setTaxPolicyMetadata(metadata);
        if (metadata?.currentFiscalYearVerified && metadata.currentFiscalYear) {
          setTaxFiscalYear(current => current || metadata.currentFiscalYear);
        }
      })
      .catch((error) => {
        if (!cancelled) setTaxPolicyError(error?.message || 'Verified tax policy metadata is unavailable.');
      });
    return () => { cancelled = true; };
  }, []);

  // Fetch products whenever instrument, profile, or activeTaxContext changes
  useEffect(() => {
    const controller = new AbortController();
    if (!profileId || !parentInstrumentId || !hasCompleteWtiStateBinding(financialStateBinding)) {
      return () => controller.abort();
    }

    const currentTaxContext = activeTaxContext ? {
      ...activeTaxContext,
      illustrativePrincipal,
    } : {
      illustrativePrincipal,
    };

    api.rankInvestmentCandidates(profileId, parentInstrumentId, currentTaxContext, { signal: controller.signal }, financialStateBinding)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (!sameWtiStateBinding(result?.financialStateBinding, financialStateBinding)) {
          const stateError = new Error('The financial state changed while products were being ranked. Refresh the current plan and try again.');
          stateError.code = 'FINANCIAL_STATE_CHANGED';
          throw stateError;
        }
        if (!Array.isArray(result?.products)) {
          const responseError = new Error('The product ranking response did not match the expected shape.');
          responseError.code = 'PRODUCT_RANKING_RESPONSE_INVALID';
          throw responseError;
        }
        const ranked = result.products;
        if (ranked.length > MAX_WTI_PRODUCTS
            || (ranked.length > 0 && !QUALIFIED_WTI_RANKING_STATUSES.has(result?.ranking?.status))) {
          const responseError = new Error('The product ranking response did not meet the qualified display contract.');
          responseError.code = 'PRODUCT_RANKING_RESPONSE_INVALID';
          throw responseError;
        }
        setRankingResult({
          requestKey,
          financialKey,
          products: ranked.map((product) => {
            const historicalReturn = nullableMarketNumber(product.historicalReturn?.valuePct);
            const nav = nullableMarketNumber(product.nav?.value);
            const officialRate = nullableMarketNumber(product.officialRate?.value);
            const isRbiFloatingCoupon = product.officialRate?.dataClass === 'OFFICIAL_RBI_FLOATING_COUPON_RATE'
              || product.parentInstrumentId === 'rbi_bonds';
            const officialRateLabel = isRbiFloatingCoupon
              ? 'Current RBI bond coupon'
              : product.officialRate?.dataClass === 'OFFICIAL_BANK_PUBLISHED_RATE'
                ? 'Current official bank rate'
                : 'Current official rate';

            return {
              ...product,
              displayMetricLabel: Number.isFinite(officialRate)
                ? officialRateLabel
                : Number.isFinite(historicalReturn) ? 'Historical 1Y return' : 'Current NAV',
              displayMetric: Number.isFinite(officialRate)
                ? `${officialRate.toFixed(2)}% p.a.`
                : Number.isFinite(historicalReturn) ? `${historicalReturn.toFixed(2)}% historical`
                  : Number.isFinite(nav) ? `₹${nav.toLocaleString('en-IN')}` : 'Unavailable',
            };
          }),
          catalog: result?.catalog || null,
          suitability: result?.suitability || null,
          ranking: result?.ranking || null,
          comparisonUniverse: result?.comparisonUniverse || null,
          error: null,
        });
      })
      .catch((error) => {
        if (controller.signal.aborted || error?.code === 'REQUEST_ABORTED') return;
        setRankingResult({
          requestKey,
          financialKey,
          products: [],
          catalog: null,
          suitability: null,
          ranking: null,
          comparisonUniverse: null,
          error: error?.code === 'FINANCIAL_STATE_CHANGED'
            ? error.message
            : 'Authoritative product ranking is temporarily unavailable. No personalized ranking has been generated.',
        });
      });

    return () => controller.abort();
  }, [parentInstrumentId, profileId, financialKey, requestKey, activeTaxContext, illustrativePrincipal, financialStateBinding]);

  const requiredTaxInputs = useMemo(() => (
    [...new Set((rankingResult.products || [])
      .filter(product => ['CALCULATED', 'REQUIRES_TAX_INPUTS'].includes(product.postTaxAnalysis?.status))
      .flatMap(product => product.postTaxAnalysis?.requiredTaxInputs || [])
      .filter(key => WTI_SUPPORTED_TAX_CONTROLS.has(key)))]
  ), [rankingResult.products]);

  const unsupportedTaxFactRequirements = useMemo(() => (
    [...new Set((rankingResult.products || [])
      .filter(product => !['CALCULATED', 'REQUIRES_TAX_INPUTS'].includes(product.postTaxAnalysis?.status)
        || (product.postTaxAnalysis?.requiredTaxInputs || []).some(key => !WTI_SUPPORTED_TAX_CONTROLS.has(key)))
      .flatMap(product => product.postTaxAnalysis?.requiredTaxInputs || []))]
  ), [rankingResult.products]);

  const handleApplyTaxInputs = (e) => {
    e.preventDefault();
    setTaxFormError('');
    if (requiredTaxInputs.includes('sttConditionAssumedSatisfied') && !sttConditionAssumedSatisfied) {
      setTaxFormError('Confirm the explicit STT assumption for this hypothetical transfer, or leave the tax result unavailable.');
      return;
    }
    const incomeNum = Number(taxAnnualIncome);
    const ageNum = Number(taxUserAge);
    const requiredFieldMissing = (
      (requiredTaxInputs.includes('annualGrossIncome') && (taxAnnualIncome === '' || !Number.isFinite(incomeNum) || incomeNum < 0))
      || (requiredTaxInputs.includes('userAge') && (!Number.isInteger(ageNum) || ageNum < 18 || ageNum > 120))
      || (requiredTaxInputs.includes('incomeSource') && !taxIncomeSource)
      || (requiredTaxInputs.includes('regime') && !taxRegime)
      || (requiredTaxInputs.includes('fiscalYear') && !taxFiscalYear)
      || (requiredTaxInputs.includes('section112AExemptionUsed') && section112AExemptionUsed === '')
      || (requiredTaxInputs.includes('acquisitionDate') && !acquisitionDate)
      || (requiredTaxInputs.includes('redemptionDate') && !redemptionDate)
    );
    if (requiredFieldMissing) {
      setTaxFormError('Complete each required tax input shown for this calculation.');
      return;
    }
    const exactDatesRequired = requiredTaxInputs.includes('acquisitionDate') || requiredTaxInputs.includes('redemptionDate');
    if ((useExactTransactionDates || exactDatesRequired)
      && (!acquisitionDate || !redemptionDate || redemptionDate < acquisitionDate)) {
      setTaxFormError('Enter both exact transaction dates, with redemption on or after acquisition.');
      return;
    }
    if (!useExactTransactionDates && !exactDatesRequired
      && requiredTaxInputs.includes('holdingPeriodMonths') && holdingPeriodMonths === '') {
      setTaxFormError('Enter a holding period in months, or switch on exact transaction dates.');
      return;
    }
    const deductions = Object.fromEntries(Object.entries({
      section80C: toOptionalNumber(taxSection80C),
      nps80CCD1B: toOptionalNumber(taxNps80CCD1B),
      nps80CCD2: toOptionalNumber(taxAdvancedDeductions.nps80CCD2),
      basicSalary: toOptionalNumber(taxAdvancedDeductions.basicSalary),
      isGovtEmployee: taxAdvancedDeductions.isGovtEmployee === undefined || taxAdvancedDeductions.isGovtEmployee === ''
        ? undefined : taxAdvancedDeductions.isGovtEmployee === 'true',
      section80D_self: toOptionalNumber(taxAdvancedDeductions.section80D_self),
      section80D_parents: toOptionalNumber(taxAdvancedDeductions.section80D_parents),
      parents_senior: taxAdvancedDeductions.parents_senior === undefined || taxAdvancedDeductions.parents_senior === ''
        ? undefined : taxAdvancedDeductions.parents_senior === 'true',
      hra: toOptionalNumber(taxAdvancedDeductions.hra),
      homeLoanInterest: toOptionalNumber(taxAdvancedDeductions.homeLoanInterest),
      section80TTA: toOptionalNumber(taxAdvancedDeductions.section80TTA),
      section80TTB: toOptionalNumber(taxAdvancedDeductions.section80TTB),
    }).filter(([, value]) => value !== undefined));
    const nextContext = { illustrativePrincipal };
    if (Object.keys(deductions).length > 0) nextContext.deductions = deductions;
    if (taxAnnualIncome !== '') nextContext.annualGrossIncome = incomeNum;
    if (taxRegime) nextContext.regime = taxRegime;
    if (taxFiscalYear) nextContext.fiscalYear = taxFiscalYear;
    if (taxIncomeSource) nextContext.incomeSource = taxIncomeSource;
    if (taxUserAge !== '' && Number.isFinite(ageNum)) nextContext.userAge = ageNum;
    if (useExactTransactionDates || exactDatesRequired) {
      nextContext.acquisitionDate = acquisitionDate;
      nextContext.redemptionDate = redemptionDate;
    } else if (holdingPeriodMonths !== '') {
      nextContext.holdingPeriodMonths = Number(holdingPeriodMonths);
    }
    if (section112AExemptionUsed !== '') nextContext.section112AExemptionUsed = Number(section112AExemptionUsed);
    if (requiredTaxInputs.includes('sttConditionAssumedSatisfied') && sttConditionAssumedSatisfied) {
      nextContext.sttConditionAssumedSatisfied = true;
    }
    setActiveTaxContext(nextContext);
  };

  const riskLevel = nullableMarketNumber(wtiData?.riskLevel);
  const level = Number.isFinite(riskLevel) ? Math.max(0, Math.min(5, riskLevel - 1)) : null;
  const risk = level === null
    ? { label: 'Not available', color: '#64748b', desc: 'The backend did not provide a parent-category suitability risk classification.' }
    : { ...RISK_LEVELS[level], desc: `${RISK_LEVELS[level].desc} This is the parent-category suitability tier, not a verified product Risk-o-Meter.` };
  const riskBaseDesc = level !== null ? RISK_LEVELS[level].desc : risk.desc;

  if (!wtiData) {
    return (
      <div style={{ textAlign: 'center', padding: '80px 0' }}>
        <Building2 size={48} color="var(--ddm-text-muted)" />
        <p style={{ color: 'var(--ddm-text-muted)', marginTop: 16, fontSize: '0.9rem' }}>
          No product data available for this instrument.
        </p>
      </div>
    );
  }

  const CX = 140, CY = 125, R = 90, r2 = 62;
  const totalAngle = Math.PI;
  const segGap = 0.025;

  const missingRankingInput = !profileId || !parentInstrumentId || !hasCompleteWtiStateBinding(financialStateBinding);
  const rankingStatus = missingRankingInput
    ? 'error'
    : rankingResult.requestKey === requestKey
    ? (rankingResult.error ? 'error' : 'ready')
    : 'loading';
  const hasQualifiedRanking = QUALIFIED_WTI_RANKING_STATUSES.has(rankingResult.ranking?.status);
  const products = rankingStatus === 'ready' && hasQualifiedRanking ? rankingResult.products : [];
  const isEvidenceRanked = rankingResult.ranking?.status === 'EVIDENCE_RANKED';
  const isComparableSet = rankingResult.ranking?.status === 'VERIFIED_COMPARABLE_OPTIONS';
  const sourceUseRestricted = rankingResult.comparisonUniverse?.productionSourceUseAllowed === false;

  const rankingError = missingRankingInput
    ? 'A saved Financial Profile and complete current recommendation binding are required. Refresh the current plan before comparing products.'
    : rankingStatus === 'error' ? rankingResult.error : null;

  const headerLabel = rankingStatus === 'loading'
    ? 'Loading Verified Product Data…'
    : isEvidenceRanked
      ? `Verified Products (${products.length} Ranked Option${products.length === 1 ? '' : 's'})`
      : isComparableSet
        ? `Verified Products (${products.length} Comparable Option${products.length === 1 ? '' : 's'})`
        : 'Verified Products Unavailable';

  return (
    <div className="tab-fade-in">
      {/* ─── Illustrative Investment & Tax Controls Bar ─── */}
      {rankingStatus === 'ready' && products.length > 0 && (
        <div className="wti-controls-bar">
          <div className="wti-illustrative-group">
            <span className="wti-illustrative-label">Illustrative principal:</span>
            {ILLUSTRATIVE_PRINCIPALS.map((amount) => (
              <button
                key={amount}
                type="button"
                className={`wti-amount-btn ${illustrativePrincipal === amount ? 'wti-amount-btn--active' : ''}`}
                onClick={() => setIllustrativePrincipal(amount)}
                title={`Use ₹${amount.toLocaleString('en-IN')} as the server calculation principal`}
              >
                ₹{amount.toLocaleString('en-IN')}
              </button>
            ))}
          </div>

          {requiredTaxInputs.length > 0 && (
            <button
              type="button"
              className="wti-tax-toggle-btn"
              onClick={() => setShowTaxDrawer(!showTaxDrawer)}
              title="Enter tax facts required by the backend calculation contract"
            >
              <Calculator size={14} />
              <span>{activeTaxContext ? 'Update tax inputs' : 'Exact-product tax illustration'}</span>
              {showTaxDrawer ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          )}
        </div>
      )}

      {rankingStatus === 'ready' && products.length === 0 && (
        <div role="status" className="wti-status-banner wti-status-banner--unavailable">
          <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
          <div>
            {sourceUseRestricted
              ? 'Verified products unavailable: this source is not cleared for WealthGenie production display. Product data and post-tax amounts are not shown.'
              : 'No current source-qualified products are available for this category. No static fallback values were inserted.'}
          </div>
        </div>
      )}

      {/* ─── Expandable Tax Inputs Drawer ─── */}
      {showTaxDrawer && rankingStatus === 'ready' && products.length > 0 && requiredTaxInputs.length > 0 && (
        <form className="wti-tax-drawer" onSubmit={handleApplyTaxInputs}>
          <h4>Exact-product tax illustration</h4>
          {requiredTaxInputs.includes('acquisitionDate') && <p role="note">
            For this specified-mutual-fund illustration, {taxFiscalYear === 'FY2026-27' ? 'Section 76' : 'Section 50AA'} applies the acquisition cutoff and the selected fiscal-year rule. The exact redemption date binds the result to that year; elapsed holding time alone does not determine the tax treatment.
          </p>}
          {unsupportedTaxFactRequirements.length > 0 && <p role="note">
            Some listed products need product or account facts that are not available as user-entered tax controls. Their exact-product tax result remains unavailable; no tax treatment is inferred.
          </p>}
          {requiredTaxInputs.includes('annualGrossIncome') && <div className="wti-tax-input-group">
            <label htmlFor="wti-annual-income">Annual Gross Income (₹)</label>
            <input
              id="wti-annual-income"
              type="number"
              min="0"
              max="1000000000"
              step="10000"
              className="wti-tax-input"
              placeholder="e.g. 1200000"
              value={taxAnnualIncome}
              onChange={(e) => setTaxAnnualIncome(e.target.value)}
              required
            />
          </div>}

          {requiredTaxInputs.includes('incomeSource') && <div className="wti-tax-input-group">
            <label htmlFor="wti-income-source">Income source</label>
            <select
              id="wti-income-source"
              className="wti-tax-input"
              value={taxIncomeSource}
              onChange={(e) => setTaxIncomeSource(e.target.value)}
              required
            >
              <option value="">Select income source</option>
              <option value="salary">Salary</option>
              <option value="pension">Pension</option>
              <option value="family_pension">Family pension</option>
              <option value="business">Business or profession</option>
              <option value="other">Other</option>
            </select>
          </div>}

          {requiredTaxInputs.includes('regime') && <div className="wti-tax-input-group">
            <span id="wti-tax-regime-label">Tax Regime</span>
            <span id="wti-tax-regime" role="status" aria-labelledby="wti-tax-regime-label">New tax regime only</span>
          </div>}

          {requiredTaxInputs.includes('fiscalYear') && <div className="wti-tax-input-group">
            <label htmlFor="wti-fiscal-year">Fiscal Year</label>
            <select
              id="wti-fiscal-year"
              className="wti-tax-input"
              value={taxFiscalYear}
              onChange={(e) => { setTaxFiscalYear(e.target.value); setTaxUserAge(''); setActiveTaxContext(null); }}
              required
            >
              <option value="">Select verified fiscal year</option>
              {(taxPolicyMetadata?.verifiedFiscalYears || []).map(year => (
                <option key={year} value={year}>{year.replace('FY', 'FY ')}</option>
              ))}
            </select>
          </div>}

          {requiredTaxInputs.includes('userAge') && (
            <div className="wti-tax-input-group">
              <label htmlFor="wti-user-age">Your age on March 31</label>
              <input
                id="wti-user-age"
                type="number"
                min="18"
                max="120"
                step="1"
                className="wti-tax-input"
                aria-describedby="wti-user-age-help"
                value={taxUserAge}
                onChange={(e) => { setTaxUserAge(e.target.value); setActiveTaxContext(null); }}
                required
              />
              <small id="wti-user-age-help">Enter your age as of March 31 for the selected fiscal year.</small>
            </div>
          )}

          {(requiredTaxInputs.includes('holdingPeriodMonths') || requiredTaxInputs.includes('acquisitionDate') || requiredTaxInputs.includes('redemptionDate')) && (
            <>
            {requiredTaxInputs.includes('holdingPeriodMonths') && !requiredTaxInputs.includes('acquisitionDate') && !requiredTaxInputs.includes('redemptionDate') && <div className="wti-tax-input-group">
              <label htmlFor="wti-exact-dates">
                <input
                  id="wti-exact-dates"
                  type="checkbox"
                  checked={useExactTransactionDates}
                  onChange={(e) => setUseExactTransactionDates(e.target.checked)}
                />{' '}
                Use exact transaction dates
              </label>
              <small>Use this when the tax result depends on the actual acquisition and redemption dates.</small>
            </div>}
            {useExactTransactionDates || requiredTaxInputs.includes('acquisitionDate') || requiredTaxInputs.includes('redemptionDate') ? (
              <>
                <div className="wti-tax-input-group">
                  <label htmlFor="wti-acquisition-date">Acquisition date</label>
                  <input
                    id="wti-acquisition-date"
                    type="date"
                    className="wti-tax-input"
                    value={acquisitionDate}
                    onChange={(e) => setAcquisitionDate(e.target.value)}
                    required
                  />
                </div>
                <div className="wti-tax-input-group">
                  <label htmlFor="wti-redemption-date">Redemption date</label>
                  <input
                    id="wti-redemption-date"
                    type="date"
                    className="wti-tax-input"
                    value={redemptionDate}
                    min={acquisitionDate || undefined}
                    onChange={(e) => setRedemptionDate(e.target.value)}
                    required
                  />
                </div>
              </>
            ) : (
            <div className="wti-tax-input-group">
              <label htmlFor="wti-holding-period">Your holding period (months)</label>
              <input
                id="wti-holding-period"
                type="number"
                min="0"
                max="1200"
                step="1"
                className="wti-tax-input"
                value={holdingPeriodMonths}
                onChange={(e) => setHoldingPeriodMonths(e.target.value)}
                required
              />
            </div>
            )}
            </>
          )}

          {requiredTaxInputs.includes('section112AExemptionUsed') && (
            <div className="wti-tax-input-group">
              <label htmlFor="wti-112a-exemption">Annual equity long-term gains exclusion already used (₹)</label>
              <input
                id="wti-112a-exemption"
                type="number"
                min="0"
                max="125000"
                step="1000"
                className="wti-tax-input"
                value={section112AExemptionUsed}
                onChange={(e) => setSection112AExemptionUsed(e.target.value)}
                required
              />
              <small>Share the amount already used across your other qualifying equity gains; it is not reset for each product.</small>
            </div>
          )}

          {requiredTaxInputs.includes('sttConditionAssumedSatisfied') && (
            <div className="wti-tax-input-group">
              <label htmlFor="wti-stt-condition-assumed-satisfied">
                <input
                  id="wti-stt-condition-assumed-satisfied"
                  type="checkbox"
                  checked={sttConditionAssumedSatisfied}
                  onChange={(e) => setSttConditionAssumedSatisfied(e.target.checked)}
                  required
                />{' '}
                Assume the applicable STT condition is satisfied for this hypothetical transfer
              </label>
              <small>This is an explicit assumption for a historical illustration. It does not verify that an actual transaction meets the condition.</small>
            </div>
          )}

          <div className="wti-tax-input-group">
            <label htmlFor="wti-80c-used">Eligible investment deductions already claimed (₹)</label>
            <input
              id="wti-80c-used"
              type="number"
              min="0"
              max="150000"
              step="1000"
              className="wti-tax-input"
              value={taxSection80C}
              onChange={(e) => setTaxSection80C(e.target.value)}
            />
          </div>

          <div className="wti-tax-input-group">
            <label htmlFor="wti-nps-80ccd1b-used">Qualifying NPS contributions already counted (₹)</label>
            <input
              id="wti-nps-80ccd1b-used"
              type="number"
              min="0"
              max="50000"
              step="1000"
              className="wti-tax-input"
              value={taxNps80CCD1B}
              onChange={(e) => setTaxNps80CCD1B(e.target.value)}
            />
          </div>

          <details className="wti-tax-input-group">
            <summary style={{ cursor: 'pointer' }}>Advanced deductions (optional)</summary>
            <small>Leave blank when not claimed. Supporting facts are required for dependency-sensitive deductions.</small>
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
              <label key={key} htmlFor={`wti-${key}`}>
                {label}
                <input
                  id={`wti-${key}`}
                  type="number"
                  min="0"
                  max={max}
                  className="wti-tax-input"
                  value={taxAdvancedDeductions[key] || ''}
                  onChange={(e) => setTaxAdvancedDeductions(current => ({ ...current, [key]: e.target.value }))}
                  placeholder="Leave blank…"
                />
              </label>
            ))}
            <label htmlFor="wti-govt-employee">
              Government employee for employer NPS limit?
              <select
                id="wti-govt-employee"
                className="wti-tax-input"
                value={taxAdvancedDeductions.isGovtEmployee || ''}
                onChange={(e) => setTaxAdvancedDeductions(current => ({ ...current, isGovtEmployee: e.target.value }))}
              >
                <option value="">Not supplied</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            </label>
            <label htmlFor="wti-parents-senior">
              Parents senior citizen for 80D?
              <select
                id="wti-parents-senior"
                className="wti-tax-input"
                value={taxAdvancedDeductions.parents_senior || ''}
                onChange={(e) => setTaxAdvancedDeductions(current => ({ ...current, parents_senior: e.target.value }))}
              >
                <option value="">Not supplied</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            </label>
          </details>

          {taxPolicyError && <p role="alert" className="wti-preview-error">{taxPolicyError}</p>}
          {taxFormError && <p role="alert" className="wti-preview-error">{taxFormError}</p>}

          {requiredTaxInputs.length > 0
            ? <button type="submit" className="wti-apply-tax-btn">Apply & Calculate</button>
            : <p className="wti-preview-error">No tax inputs are required for the currently qualified product data.</p>}
        </form>
      )}

      {currentRecommendation && (
        <section className="wti-parent-recommendation" aria-labelledby="wti-parent-recommendation-title">
          <div className="wti-parent-recommendation-label">YOUR PLAN RECOMMENDS</div>
          <div className="wti-parent-recommendation-content">
            <div>
              <h3 id="wti-parent-recommendation-title">{currentRecommendation.name || inv?.name || 'Selected investment category'}</h3>
              <p>
                This category passed the backend Financial Profile suitability check. The verified options below are a deeper product view inside it.
              </p>
            </div>
            {isPresentFiniteNumber(currentRecommendation.allocation_pct) && (
              <div className="wti-parent-recommendation-allocation">
                <span>Plan allocation</span>
                <strong>{currentRecommendation.allocation_pct}%</strong>
              </div>
            )}
          </div>
        </section>
      )}

      {/* ─── Section Header & Sorting ─── */}
      <div className="wti-section-header-row">
        <div>
          <h3 className="wti-section-title">Verified options inside this category</h3>
          <p className="wti-section-subtitle">
            {isEvidenceRanked
              ? 'Up to 5 source-verified Direct-plan options ranked using verified historical NAV evidence.'
              : isComparableSet
                ? 'Source-verified options in this suitable category. Display order is not a merit ranking.'
                : 'No source-qualified product facts are available for this category.'}{' '}
            <span className="wti-status-label">({headerLabel})</span>
          </p>
        </div>

        {/* Sorting Controls */}
        {products.length > 0 && <div className="wti-sort-controls">
          <span className="wti-sort-label">Display order:</span>
          {[{ id: 'score', label: isEvidenceRanked ? 'Historical evidence' : 'Comparable set' }].map(mode => (
            <button
              key={mode.id}
              type="button"
              disabled={mode.id !== 'score'}
              title={mode.id === 'score'
                ? (isEvidenceRanked ? 'Server order among explicitly sourced Direct Growth options by one-year historical NAV return' : 'Stable display order only; not a ranking')
                : 'Unavailable without established provider-specific data'}
              onClick={() => mode.id === 'score' && setSortBy(mode.id)}
              className={`wti-sort-btn ${sortBy === mode.id ? 'wti-sort-btn--active' : ''}`}
            >
              {mode.label}
            </button>
          ))}
        </div>}
      </div>

      {!sourceUseRestricted && wtiData.note && (
        <div className="wti-note-banner">
          <Info size={14} style={{ flexShrink: 0, marginTop: 2 }} />
          <p><strong>REFERENCE METADATA:</strong> {wtiData.note}</p>
        </div>
      )}

      {!sourceUseRestricted && rankingResult.comparisonUniverse && (
        <div className="wti-note-banner" data-testid="wti-comparison-universe">
          <TrendingUp size={14} style={{ flexShrink: 0, marginTop: 2 }} />
          <p>
            <strong>{isEvidenceRanked ? 'VERIFIED RANKING UNIVERSE' : 'VERIFIED COMPARISON UNIVERSE'}:</strong>{' '}
            {rankingResult.comparisonUniverse.disclosure}{' '}
            {(rankingResult.comparisonUniverse.provider === 'AMFI' || rankingResult.comparisonUniverse.sourceProvider === 'AMFI') && (
              <>Source-qualified: {rankingResult.comparisonUniverse.verifiedCategoryProductCount ?? 0}; fresh NAVs: {rankingResult.comparisonUniverse.freshNavProductCount ?? 0}; explicit Direct plans: {rankingResult.comparisonUniverse.sourceEstablishedDirectPlanProductCount ?? 0}; historical evidence: {rankingResult.comparisonUniverse.historicalEvidenceProductCount ?? 0}.</>
            )}
          </p>
        </div>
      )}

      {!sourceUseRestricted && rankingResult.ranking?.warning && (
        <div className="wti-note-banner">
          <Info size={14} style={{ flexShrink: 0, marginTop: 2 }} />
          <p>{rankingResult.ranking.warning}</p>
        </div>
      )}

      {rankingStatus === 'ready' && products.length === 0 && (
        <UserDeclaredScenarioPanel
          key={`${parentInstrumentId || 'unknown'}|${financialKey}`}
          canonicalInstrumentId={parentInstrumentId}
          instrumentName={inv?.name}
          taxPolicyMetadata={taxPolicyMetadata}
          taxPolicyError={taxPolicyError}
        />
      )}

      {/* Sub-Category Sector/Theme Drill-Down Tabs */}
      {subKeys.length > 0 && (
        <div className="wti-sub-pills">
          <span className="wti-sub-pills-label">Category context</span>
          {subKeys.map(key => (
            <span
              key={key}
              className="wti-sub-pill wti-sub-pill--context"
            >
              {SUB_TAB_LABELS[key] || key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
            </span>
          ))}
        </div>
      )}

      {rankingError && (
        <div className="wti-status-banner wti-status-banner--error">
          <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2, color: '#ef4444' }} />
          <div>{rankingError}</div>
        </div>
      )}

      {/* Parent-Category Suitability Gauge */}
      <div className="risk-meter-container" style={{ '--risk-color': risk.color }}>
        <div className="risk-card-shimmer" aria-hidden="true" />

        {/* Left Column: Precision Instrument Dial */}
        <div className="risk-meter-visual-col">
          <div className="risk-meter-gauge-wrap">
            <div className="risk-meter-ambient-glow" style={{ '--glow-color': risk.color }} aria-hidden="true" />
            <div className="risk-meter-gauge">
              <svg viewBox="0 0 280 155" className="risk-meter-svg">
                <defs>
                  <filter id="rmGlow">
                    <feGaussianBlur stdDeviation="4" result="blur" />
                    <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
                  </filter>
                  <filter id="rmNeedleShadow">
                    <feDropShadow dx="0" dy="1" stdDeviation="3" floodColor={risk.color} floodOpacity="0.6" />
                  </filter>
                  <linearGradient id="rmNeedleGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#ffffff" />
                    <stop offset="100%" stopColor={risk.color} />
                  </linearGradient>
                  <radialGradient id="rmHubGrad">
                    <stop offset="0%" stopColor="rgba(30,41,59,1)" />
                    <stop offset="100%" stopColor="rgba(15,23,42,1)" />
                  </radialGradient>
                </defs>

                {/* Outer Framing Arc */}
                <path
                  d={`M ${CX + (R + 8) * Math.cos(Math.PI)} ${CY - (R + 8) * Math.sin(Math.PI)} A ${R + 8} ${R + 8} 0 0 1 ${CX + (R + 8) * Math.cos(0)} ${CY - (R + 8) * Math.sin(0)}`}
                  fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="1"
                />

                {/* Color-Coded Tiers */}
                {RISK_LEVELS.map((r, i) => {
                  const a1 = Math.PI - (i / 6) * totalAngle + segGap;
                  const a2 = Math.PI - ((i + 1) / 6) * totalAngle - segGap;
                  const ox1 = CX + R * Math.cos(a1), oy1 = CY - R * Math.sin(a1);
                  const ox2 = CX + R * Math.cos(a2), oy2 = CY - R * Math.sin(a2);
                  const ix2 = CX + r2 * Math.cos(a2), iy2 = CY - r2 * Math.sin(a2);
                  const ix1 = CX + r2 * Math.cos(a1), iy1 = CY - r2 * Math.sin(a1);
                  const isActive = i === level;
                  return (
                    <path
                      key={i}
                      d={`M ${ox1} ${oy1} A ${R} ${R} 0 0 1 ${ox2} ${oy2} L ${ix2} ${iy2} A ${r2} ${r2} 0 0 0 ${ix1} ${iy1} Z`}
                      fill={r.color}
                      opacity={isActive ? 1 : 0.22}
                      filter={isActive ? 'url(#rmGlow)' : 'none'}
                      style={{ transition: 'opacity 0.6s ease' }}
                    />
                  );
                })}

                {/* Boundary Scale Labels */}
                <text x="36" y="145" textAnchor="middle" fill="#64748b" fontSize="8.5" fontWeight="600" fontFamily="Inter, sans-serif">Low</text>
                <text x="244" y="145" textAnchor="middle" fill="#64748b" fontSize="8.5" fontWeight="600" fontFamily="Inter, sans-serif">Very High</text>

                {/* Outer Tick Notches */}
                {[0, 1, 2, 3, 4, 5, 6].map(i => {
                  const a = Math.PI - (i / 6) * totalAngle;
                  const t1 = CX + (R + 1) * Math.cos(a), u1 = CY - (R + 1) * Math.sin(a);
                  const t2 = CX + (R + 6) * Math.cos(a), u2 = CY - (R + 6) * Math.sin(a);
                  return <line key={i} x1={t1} y1={u1} x2={t2} y2={u2} stroke="rgba(255,255,255,0.18)" strokeWidth="1" />;
                })}

                {/* Precision Needle Indicator */}
                {level !== null && (() => {
                  const needleAngle = Math.PI - ((level + 0.5) / 6) * totalAngle;
                  const needleLen = r2 - 5;
                  const tipX = CX + needleLen * Math.cos(needleAngle);
                  const tipY = CY - needleLen * Math.sin(needleAngle);
                  const basePerp = Math.PI / 2;
                  const bx1 = CX + 4 * Math.cos(needleAngle + basePerp);
                  const by1 = CY - 4 * Math.sin(needleAngle + basePerp);
                  const bx2 = CX + 4 * Math.cos(needleAngle - basePerp);
                  const by2 = CY - 4 * Math.sin(needleAngle - basePerp);
                  return (
                    <g filter="url(#rmNeedleShadow)">
                      <polygon
                        points={`${bx1},${by1} ${bx2},${by2} ${tipX},${tipY}`}
                        fill="url(#rmNeedleGrad)"
                      />
                      <circle cx={tipX} cy={tipY} r="2.2" fill="#ffffff" />
                    </g>
                  );
                })()}

                {/* Pivot Hub */}
                <circle cx={CX} cy={CY} r="13" fill="url(#rmHubGrad)" stroke="rgba(255,255,255,0.18)" strokeWidth="1.5" />
                <circle cx={CX} cy={CY} r="5.5" fill={risk.color} opacity="0.95" />
                <circle cx={CX} cy={CY} r="2.5" fill="#020617" />
                <line x1={CX - R - 4} y1={CY + 1} x2={CX + R + 4} y2={CY + 1} stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
              </svg>
            </div>
          </div>

          {/* Telemetry Badge Under Gauge */}
          <div className="risk-gauge-readout" style={{ '--risk-color': risk.color }}>
            <span className="risk-gauge-readout-pill">{risk.label} Risk</span>
            <span className="risk-gauge-readout-tier">Tier {level !== null ? level + 1 : '—'} of 6</span>
          </div>

          {/* 6-Tier Interactive Spectrum Bar */}
          <div
            className="risk-meter-spectrum-bar"
            role={level !== null ? 'meter' : 'img'}
            aria-label={`Parent Category Risk: ${risk.label}`}
            aria-valuemin={level !== null ? '1' : undefined}
            aria-valuemax={level !== null ? '6' : undefined}
            aria-valuenow={level !== null ? level + 1 : undefined}
          >
            <div className="risk-meter-spectrum-segments">
              {RISK_LEVELS.map((r, i) => {
                const isActive = i === level;
                return (
                  <div
                    key={i}
                    className={`risk-meter-segment ${isActive ? 'active' : ''}`}
                    style={{ '--seg-color': r.color }}
                    title={`${r.label} (Tier ${i + 1} of 6)`}
                  >
                    <span className="risk-meter-seg-bar" />
                    {isActive && <span className="risk-meter-seg-glow" />}
                  </div>
                );
              })}
            </div>
            <div className="risk-meter-spectrum-labels">
              <span>Lowest Risk</span>
              <span>Highest Risk</span>
            </div>
          </div>
        </div>

        {/* Right Column: Institutional Suitability Intelligence */}
        <div className="risk-meter-details-col">
          <div className="risk-card-eyebrow">
            <div className="risk-card-eyebrow-left">
              <Shield size={16} style={{ color: risk.color }} aria-hidden="true" />
              <span>Parent Category Suitability</span>
            </div>
          </div>

          <div className="risk-summary-text">
            <p>{riskBaseDesc}</p>
          </div>

          <footer className="risk-compliance-footer">
            <Info size={13} className="risk-compliance-icon" aria-hidden="true" />
            <span>Parent-category suitability tier, not a verified product Risk-o-Meter. Individual product rankings below evaluate verified scheme evidence.</span>
          </footer>
        </div>
      </div>

      {/* ─── Beginner Product Comparison Cards Grid ─── */}
      <div className="wti-grid">
        {products.map((product) => {
          const riskStyle = getRiskTierColor(product.beginnerSuitability?.riskTier);
          const postTax = product.postTaxAnalysis;
          const productObservedAt = formatMarketTimestamp(
            product.officialRate?.observedAt
              || product.nav?.observedAt
              || product.valuationDate
              || product.historicalReturn?.endDate,
          );

          return (
            <div
              key={product.id}
              data-testid={`wti-product-${product.id}`}
              className={`wti-item ${isEvidenceRanked && product.rank === 1 && rankingResult.ranking?.hasUniqueLeader ? 'wti-item--featured' : ''}`}
            >
              <div
                className="wti-rank"
                title={isEvidenceRanked ? `Evidence rank ${product.rank}` : 'Comparable option; display position is not a rank'}
              >
                {isEvidenceRanked ? product.rank : '='}
              </div>

              <div className="wti-card-body">
                {/* Card Top: Product Name, Chips, Metric */}
                <div className="wti-card-top">
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="wti-card-title-row">
                      <h4 className="wti-name">{product.name}</h4>
                      <span
                        className="wti-badge"
                        style={{
                          background: isEvidenceRanked ? 'rgba(34, 197, 94, 0.12)' : 'rgba(56, 189, 248, 0.08)',
                          color: isEvidenceRanked ? '#4ade80' : '#38bdf8',
                          borderColor: isEvidenceRanked ? 'rgba(34, 197, 94, 0.3)' : 'rgba(56, 189, 248, 0.25)',
                        }}
                      >
                        {readableSource(product.presentationStatus)}
                      </span>
                      {product.tiedRank && <span className="wti-badge">TIED RANK</span>}
                    </div>

                    <div className="wti-card-evidence-row">
                      <span className="wti-provider">
                        {readableSource(product.provider)} · {readableSource(product.source?.provider)}
                      </span>
                      <span className="wti-bullet">·</span>
                      <span>Source: {readableSource(product.source?.provider)}</span>
                      <span className="wti-bullet">·</span>
                      <span>As of: {productObservedAt || 'Unavailable'}</span>
                    </div>

                    {/* Risk & Access Chips */}
                    <div className="wti-card-chips">
                      <span
                        className="wti-risk-chip"
                        style={{
                          color: riskStyle.color,
                          background: riskStyle.bg,
                          borderColor: riskStyle.border,
                        }}
                      >
                        {product.beginnerSuitability?.riskTier || 'Risk classification unavailable'}
                      </span>
                      <span className="wti-access-chip">
                        {product.beginnerSuitability?.accessToMoney || 'Access terms unavailable'}
                      </span>
                    </div>
                  </div>

                  {/* Fact Metric Display */}
                  <div className="wti-card-metric-col">
                    <span className="wti-card-metric-label">
                      {product.displayMetricLabel}
                    </span>
                    <div className="wti-rate-chip">{product.displayMetric}</div>
                    {mayDisplayContractualProceeds(product) && (
                      <div data-testid="wti-gross-contract-illustration" className="wti-private-quote">
                        <strong>{product.cashflowIllustration.cashflowType === 'ANNUAL_PAYOUT' ? 'Total gross receipts (including annual interest): ' : 'Illustrative gross maturity: '}₹{product.cashflowIllustration.grossTotalProceeds.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</strong>
                        <small>Principal ₹{product.cashflowIllustration.principal.toLocaleString('en-IN')} · {product.cashflowIllustration.tenureMonths} months · Before tax</small>
                        {product.cashflowIllustration.cashflowType === 'ANNUAL_PAYOUT' && (
                          <small>Interest is paid annually; total receipts include earlier payouts and assume no reinvestment.</small>
                        )}
                        <small>Conditional on opening at the stated official rate. Not a live price or future-rate forecast.</small>
                      </div>
                    )}
                    {product.cashflowIllustration?.status === 'CALCULATED'
                      && !mayDisplayContractualProceeds(product) && (
                      <small data-testid="wti-contractual-cashflow-integrity-block">
                        Contract calculation withheld: the amount and payment ledger do not reconcile.
                      </small>
                    )}
                    {product.cashflowIllustration?.status === 'NOT_APPLICABLE' && (
                      <small data-testid="wti-contractual-cashflow-not-applicable">
                        Market-priced product: no contractual maturity amount. Use a qualified NAV or exchange quote for present valuation.
                      </small>
                    )}
                    {product.cashflowIllustration?.status === 'UNAVAILABLE' && (
                      <small data-testid="wti-contractual-cashflow-unavailable">
                        Gross contract calculation unavailable: additional verified product terms, current rates, or approved source rights are required.
                      </small>
                    )}
                  </div>
                </div>

                {/* Plain-English "Why This Fits You" */}
                {product.beginnerSuitability?.whyThisFitsYou && (
                  <div className="wti-why-fits">
                    <span className="wti-why-fits-label">
                      <Sparkles size={11} />
                      Why this fits you:
                    </span>
                    <p className="wti-why-fits-text">{product.beginnerSuitability.whyThisFitsYou}</p>
                  </div>
                )}

                {/* Defensible Post-Tax Calculation & Illustrative Outcome Box */}
                {postTax && postTax.status === 'CALCULATED' && (
                  <div className="wti-post-tax-box">
                    <div className="wti-post-tax-header">
                      <span className="wti-post-tax-title">
                        {postTax.metricLabel}:{' '}
                        <strong>{Number.isFinite(postTax.postTaxRatePct) ? `${postTax.postTaxRatePct}%` : 'Unavailable'}</strong>
                      </span>
                      <span className="wti-badge" style={{ background: 'rgba(52, 211, 153, 0.1)', color: '#34d399', borderColor: 'rgba(52, 211, 153, 0.2)' }}>
                        Exact-product tax illustration
                      </span>
                    </div>

                    <div className="wti-illustrative-grid">
                      <div>
                        <span>You invest</span>
                        <strong>{formatINR(postTax.illustrativePrincipal)}</strong>
                      </div>
                      <div>
                        <span>Gross return</span>
                        <strong>{formatINR(postTax.grossGain)}</strong>
                      </div>
                      <div>
                        <span>Tax on gain</span>
                        <strong>{formatINR(postTax.incrementalTax)}</strong>
                      </div>
                      <div className="wti-keep-highlight">
                        <span>You keep</span>
                        <strong>{formatINR(postTax.netGain)}</strong>
                      </div>
                    </div>

                    <div className="wti-post-tax-disclosure">
                      {postTax.disclosure}
                      {postTax.calculationClass === 'HISTORICAL_RETURN_POST_TAX_ILLUSTRATION' && (
                        <p>
                          Historical performance window: {Number.isFinite(postTax.historicalObservationWindowMonths) ? `${postTax.historicalObservationWindowMonths} months` : 'Unavailable'}.
                          {' '}Tax holding-period basis: {postTax.holdingPeriodBasis || 'Unavailable'}. This is an illustration; those periods may differ.
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {/* If Post-Tax Requires Inputs */}
                {postTax && postTax.status === 'REQUIRES_TAX_INPUTS' && (
                  <div className="wti-post-tax-cta-box">
                    {(postTax.requiredTaxInputs || []).some(key => !WTI_SUPPORTED_TAX_CONTROLS.has(key))
                      ? <span>Exact-product tax illustration is unavailable because one or more required product or account facts cannot be established here.</span>
                      : <>
                        <span>Exact-product tax illustration: required tax facts were not supplied.</span>
                        <button
                          type="button"
                          onClick={() => setShowTaxDrawer(true)}
                          className="wti-calc-tax-btn"
                        >
                          Enter required facts
                        </button>
                      </>}
                  </div>
                )}

                {(!postTax || !['CALCULATED', 'REQUIRES_TAX_INPUTS'].includes(postTax.status)) && (
                  <div className="wti-post-tax-cta-box">
                    <span>
                      {postTax?.status === 'TAX_CLASSIFICATION_UNAVAILABLE'
                        ? 'Tax treatment is not verified for this exact product.'
                        : postTax?.status === 'SOURCE_RIGHTS_UNQUALIFIED'
                          ? 'This data source is not cleared for production display or post-tax calculations.'
                        : postTax?.status === 'TAX_CLASSIFICATION_REQUIRES_ACQUISITION_FACTS'
                          ? 'Additional product or account facts are needed before a tax result can be calculated.'
                          : postTax?.status === 'FISCAL_YEAR_UNSUPPORTED'
                            ? 'Tax rules for the selected financial year are not available.'
                            : postTax?.status === 'PRODUCT_FACTS_UNAVAILABLE'
                              ? 'Verified product facts needed for this calculation are unavailable.'
                              : postTax?.status === 'UNAVAILABLE'
                                ? 'A tax result could not be established from the available facts.'
                                : postTax?.status
                                  ? 'Tax status could not be verified. No tax amount is shown.'
                                  : 'No tax analysis was returned. No tax amount is shown.'}
                    </span>
                    {postTax?.disclosure && <small>{postTax.disclosure}</small>}
                  </div>
                )}

                {/* Existing Highlights & Warnings */}
                <p className="wti-highlights">
                  {product.officialRate
                    ? product.officialRate.dataClass === 'OFFICIAL_RBI_FLOATING_COUPON_RATE' || product.parentInstrumentId === 'rbi_bonds'
                      ? `Current RBI Floating Rate Savings Bond coupon effective ${product.officialRate.effectiveFrom || 'UNAVAILABLE'}${product.officialRate.effectiveTo ? ` to ${product.officialRate.effectiveTo}` : ''}. Interest is paid semiannually and the coupon resets on January 1 and July 1; this is not a fixed 7-year guaranteed rate.`
                      : product.officialRate.dataClass === 'QUARTERLY_OFFICIAL_RATE'
                      ? `Official Government of India rate effective ${product.officialRate.effectiveFrom || 'UNAVAILABLE'} to ${product.officialRate.effectiveTo || 'UNAVAILABLE'}. This is an official interval fact, not a live market price or expected return.`
                      : `Official bank-published card rate effective from ${product.officialRate.effectiveFrom || 'UNAVAILABLE'} for ${product.tenure?.label || 'the source-established tenure'} and ${product.depositorType?.replaceAll('_', ' ') || 'the source-established depositor class'}. No best-FD claim is made.`
                    : isEvidenceRanked
                    ? 'Ranked only among explicitly sourced Direct Growth options in the exact AMFI category by verified one-year historical NAV return. Historical performance is not an expected return.'
                    : 'Verified AMFI category and fresh NAV. No defensible merit order is claimed for this comparable option.'}
                  {!isEvidenceRanked && Number.isFinite(nullableMarketNumber(product.historicalReturn?.valuePct))
                    ? ' A verified historical return is shown for context only. Historical performance is not an expected return.'
                    : ''}
                </p>

                {product.taxSavingsNote && (
                  <div style={{ fontSize: '0.75rem', color: product.taxSavingsNote.startsWith('⚠') ? '#f59e0b' : '#4ade80', fontWeight: 600, margin: '6px 0 4px 0', display: 'flex', alignItems: 'center', gap: 6, background: product.taxSavingsNote.startsWith('⚠') ? 'rgba(245, 158, 11, 0.08)' : 'rgba(34, 197, 94, 0.08)', padding: '4px 8px', borderRadius: '6px', border: `1px solid ${product.taxSavingsNote.startsWith('⚠') ? 'rgba(245, 158, 11, 0.2)' : 'rgba(34, 197, 94, 0.2)'}` }}>
                    <Zap size={12} style={{ color: product.taxSavingsNote.startsWith('⚠') ? '#f59e0b' : '#4ade80', flexShrink: 0 }} />
                    <span>{product.taxSavingsNote}</span>
                  </div>
                )}

                {product.realReturnWarning && (
                  <div style={{ fontSize: '0.72rem', color: product.realReturnVal < 0 ? '#ef4444' : '#f59e0b', fontWeight: 600, margin: '4px 0 8px 0', display: 'flex', alignItems: 'center', gap: 6, background: product.realReturnVal < 0 ? 'rgba(239, 68, 68, 0.08)' : 'rgba(245, 158, 11, 0.08)', padding: '4px 8px', borderRadius: '6px', border: `1px solid ${product.realReturnVal < 0 ? 'rgba(239, 68, 68, 0.2)' : 'rgba(245, 158, 11, 0.2)'}` }}>
                    <AlertTriangle size={11} style={{ color: product.realReturnVal < 0 ? '#ef4444' : '#f59e0b', flexShrink: 0 }} />
                    <span>{product.realReturnWarning}</span>
                  </div>
                )}

                {/* Progressive Disclosure: Technical Details & Provenance */}
                <details className="wti-card-tech-details">
                  <summary className="wti-tech-summary">
                    <Info size={12} />
                    <span>View technical details & provenance</span>
                  </summary>

                  <div className="wti-meta-footer">
                    <div className="meta-box"><Building2 size={12} /> Source: {readableSource(product.source?.provider)}</div>
                    <div className="meta-box">Product type: {readableSource(product.productType)}</div>
                    {safeSourceUrl(product.source?.url) && <a href={safeSourceUrl(product.source.url)} target="_blank" rel="noreferrer">Official source</a>}
                    {product.nav && <div className="meta-box"><Wallet size={12} /> NAV: {Number.isFinite(nullableMarketNumber(product.nav?.value)) ? `₹${nullableMarketNumber(product.nav.value).toLocaleString('en-IN')}` : 'UNAVAILABLE'}</div>}
                    {product.nav && <div className="meta-box"><HistoryIcon size={12} /> Valuation: {product.valuationDate || 'UNAVAILABLE'}</div>}
                    {product.officialRate && <div className="meta-box"><Wallet size={12} /> Rate class: {readableSource(product.officialRate.dataClass)}</div>}
                    {product.officialRate && <div className="meta-box"><HistoryIcon size={12} /> Effective: {product.officialRate.effectiveFrom || 'UNAVAILABLE'} → {product.officialRate.effectiveTo || 'until revised'}</div>}
                    <div className="meta-box"><Activity size={12} /> Freshness: {product.freshness?.status || 'UNAVAILABLE'}</div>
                    <div className="meta-box">Eligibility: {product.productEligibility?.status?.replaceAll('_', ' ') || 'UNAVAILABLE'}</div>
                    {product.productType === 'MUTUAL_FUND' && <div className="meta-box">Plan: {product.plan || 'UNAVAILABLE'}</div>}
                    {product.productType === 'MUTUAL_FUND' && <div className="meta-box">Option: {product.option || 'UNAVAILABLE'}</div>}
                    {product.productType === 'ETF' && <>
                      <div className="meta-box">Benchmark: {product.benchmark?.name || 'UNAVAILABLE'}{product.benchmark?.returnVariant ? ` (${product.benchmark.returnVariant})` : ''}</div>
                      <div className="meta-box">Exchange / ticker: {product.exchange || 'UNAVAILABLE'} / {product.ticker || 'UNAVAILABLE'}</div>
                      <div className="meta-box">ISIN: {product.isin || 'UNAVAILABLE'}</div>
                      <div className="meta-box">Exchange market price: {Number.isFinite(nullableMarketNumber(product.marketPrice?.value)) ? `₹${nullableMarketNumber(product.marketPrice.value).toLocaleString('en-IN')}` : 'Unavailable'}</div>
                      <div className="meta-box">Fund NAV: {Number.isFinite(nullableMarketNumber(product.nav?.value)) ? `₹${nullableMarketNumber(product.nav.value).toLocaleString('en-IN')}` : 'Unavailable'}</div>
                      {(product.identityEvidence || []).map(evidence => safeSourceUrl(evidence?.url) && (
                        <a key={`${evidence.authority}-${evidence.url}`} href={safeSourceUrl(evidence.url)} target="_blank" rel="noreferrer">
                          {evidence.authority || 'Official product identity'} evidence
                        </a>
                      ))}
                      {safeSourceUrl(product.benchmark?.source?.url) && (
                        <a href={safeSourceUrl(product.benchmark.source.url)} target="_blank" rel="noreferrer">Benchmark evidence</a>
                      )}
                    </>}
                    {product.historicalReturn && <div className="meta-box"><HistoryIcon size={12} /> History: {product.historicalReturn.startDate} → {product.historicalReturn.endDate}</div>}
                    {isEvidenceRanked && product.rank === 1 && rankingResult.ranking?.hasUniqueLeader && (
                      <div className="meta-box meta-box--pick"><Star size={12} /> Rank #1 by 1Y Historical NAV Return</div>
                    )}
                  </div>
                </details>
              </div>
            </div>
          );
        })}
      </div>

      {wtiData.howToStart && (
        <div className="wti-howto">
          <Zap size={14} style={{ flexShrink: 0, color: '#22c55e' }} />
          <div>
            <span className="wti-howto-label">How to get started</span>
            <p>{wtiData.howToStart}</p>
          </div>
        </div>
      )}

      {/* Mandatory SEBI Disclaimer Component */}
      <SebiDisclaimer />
    </div>
  );
};

const WhereToInvestTab = ({ inv, userProfile, recommendationMeta = null }) => {
  // A keyed subtree resets tax and ranking state when financial authority changes,
  // rather than cascading synchronous state updates from an effect.
  const financialContextKey = JSON.stringify({
    profileId: userProfile?.profileId,
    profileVersion: Number(userProfile?.version ?? recommendationMeta?.profile_version),
    recommendationId: recommendationMeta?.recommendationId || recommendationMeta?.recommendation_id,
    allocationRevision: Number(recommendationMeta?.allocation_revision),
    allocationRevisionId: recommendationMeta?.allocation_revision_id,
    portfolioFingerprint: recommendationMeta?.portfolio_fingerprint,
    recommendationFingerprint: recommendationMeta?.recommendation_fingerprint,
    parentInstrumentId: inv?.id,
    revisionId: recommendationMeta?.allocation_revision_id,
    age: userProfile?.age,
  });
  return <WhereToInvestContent
    key={financialContextKey}
    inv={inv}
    userProfile={userProfile}
    recommendationMeta={recommendationMeta}
  />;
};

export default WhereToInvestTab;
