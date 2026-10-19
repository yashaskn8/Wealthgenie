import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  Globe,
  Activity,
  Sparkles,
  ChevronDown,
  ChevronUp,
  Calculator,
  IndianRupee,
  ArrowUpRight,
  RefreshCw,
} from 'lucide-react';
import * as api from '../../services/api';
import SebiDisclaimer from '../SebiDisclaimer';
import '../DeepDiveModal.css';
import {
  formatMarketTimestamp,
  getMarketAttemptedProvider,
  getMarketDisplayState,
  getMarketEvidenceSource,
  nullableMarketNumber,
  readableSource,
  safeSourceUrl,
} from '../../utils/marketDataDisplay';
import { formatINR } from '../../utils/recommendationPresentation';
import { isPresentFiniteNumber, toOptionalNumber } from '../../utils/financialValues';
import { getCurrentRecommendedInstrument } from '../../utils/financialStateBinding';
import { useMarketContext } from '../../state/useMarketContext';
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

const MARKET_CONTEXT_COPY = {
  NORMAL: {
    headline: 'Market conditions look steady.',
    explanation: 'Your plan maintains standard allocations within investments that fit your profile.',
  },
  CAUTIOUS: {
    headline: 'Markets have been weaker recently.',
    explanation: 'Your plan is being slightly more careful while staying within investments that already fit your profile.',
  },
  HIGH_VOLATILITY: {
    headline: 'Markets are moving more sharply than usual.',
    explanation: 'Your plan stays focused on profile-suitable investments with cautious risk management.',
  },
  RISK_OFF: {
    headline: 'Market risk is elevated right now.',
    explanation: 'Your plan applies the strongest allowed risk reduction while staying within your suitability limits.',
  },
  UNAVAILABLE: {
    headline: 'Verified market information is temporarily unavailable.',
    explanation: 'Your personal suitability rules remain fully active.',
  },
};

function marketSnapshotFingerprint(snapshot, marketContext = null) {
  const revision = snapshot?.contentRevision;
  if (!revision || revision.version !== 'market-snapshot-content-1.1.0'
      || !/^[a-f0-9]{64}$/i.test(revision.digest || '')) return null;
  const usability = marketContext?.recommendationUsability || snapshot.recommendationUsability;
  const usabilityStatus = usability?.status || 'UNKNOWN';
  const usabilityReasons = Array.isArray(usability?.reasonCodes) ? [...usability.reasonCodes].sort() : [];
  return `${revision.version}:${revision.digest}|${snapshot.status}|${usabilityStatus}|${usabilityReasons.join(',')}`;
}

const PREVIEW_MAX_TILT_PCT = Object.freeze({ NORMAL: 0, CAUTIOUS: 2, HIGH_VOLATILITY: 4, RISK_OFF: 5 });

function validatePreviewResponse(result, binding) {
  const responseBindingMatches = result?.profileId === binding.profileId
    && Number(result?.profile_version) === binding.profileVersion
    && result?.recommendationId === binding.recommendationId
    && Number(result?.allocation_revision) === binding.allocationRevision
    && result?.allocation_revision_id === binding.allocationRevisionId
    && result?.portfolio_fingerprint === binding.portfolioFingerprint
    && result?.recommendation_fingerprint === binding.recommendationFingerprint;
  if (!responseBindingMatches) {
    const error = new Error('Your saved plan changed while the preview was running. Refresh the plan and try again.');
    error.code = 'FINANCIAL_STATE_CHANGED';
    throw error;
  }
  if (result.persisted !== false) throw new Error('The server could not confirm that this preview leaves your saved plan unchanged.');

  const snapshot = result.marketContext?.marketSnapshot;
  if (!marketSnapshotFingerprint(snapshot, result.marketContext)) {
    throw new Error('The server did not return a verified market snapshot for this preview. Refresh market data and try again.');
  }

  const baseWeights = result.baseWeights;
  const adjustedWeights = result.adjustedWeights;
  const instruments = result.adjustedInstruments;
  if (!baseWeights || !adjustedWeights || !Array.isArray(instruments) || instruments.length === 0) {
    throw new Error('The server returned an incomplete allocation comparison. Please try again.');
  }
  const baseIds = Object.keys(baseWeights).sort();
  const adjustedIds = Object.keys(adjustedWeights).sort();
  const instrumentIds = instruments.map(item => item?.id).sort();
  if (baseIds.length !== adjustedIds.length
      || baseIds.some((id, index) => id !== adjustedIds[index])
      || baseIds.length !== instrumentIds.length
      || baseIds.some((id, index) => id !== instrumentIds[index])) {
    throw new Error('The server returned an allocation comparison that does not match your current holdings.');
  }
  const sumWeights = (weights) => Object.values(weights).reduce((sum, weight) => sum + Number(weight), 0);
  if (baseIds.some(id => !Number.isFinite(baseWeights[id]) || baseWeights[id] < 0 || baseWeights[id] > 1
      || !Number.isFinite(adjustedWeights[id]) || adjustedWeights[id] < 0 || adjustedWeights[id] > 1)
      || Math.abs(sumWeights(baseWeights) - 1) > 0.001
      || Math.abs(sumWeights(adjustedWeights) - 1) > 0.001
      || instruments.some(item => Math.abs(Number(item.allocationWeight) - adjustedWeights[item.id]) > 0.000001)) {
    throw new Error('The server returned invalid allocation weights. The preview has been withheld.');
  }
  const context = result.marketContext?.context;
  const expectedMaxTilt = PREVIEW_MAX_TILT_PCT[context] ?? 0;
  if (!Number.isFinite(result.maxTotalTiltPct) || result.maxTotalTiltPct !== expectedMaxTilt
      || !Number.isFinite(result.actualTotalTiltPct) || result.actualTotalTiltPct < 0
      || result.actualTotalTiltPct > result.maxTotalTiltPct + 0.000001
      || (result.applied === true && result.marketContext?.recommendationUsability?.status !== 'USABLE')) {
    throw new Error('The server returned a preview outside the verified market or adjustment limits.');
  }
  return result;
}

const PREVIEW_REASON_COPY = {
  NORMAL_CONTEXT_NO_TACTICAL_ADJUSTMENT: 'Market conditions are steady, so no allocation shift is proposed.',
  NO_LOWER_RISK_ELIGIBLE_TRANSFER_PATH: 'There is no lower-risk investment in your current suitable plan to receive a transfer.',
  CONCENTRATION_CAPS_PREVENT_LOWER_RISK_TRANSFER: 'Your existing concentration limits prevent a further allocation shift.',
  MARKET_CONTEXT_UNAVAILABLE_NO_ADJUSTMENT: 'Verified market information is unavailable, so no adjustment was calculated.',
  MARKET_CONTEXT_NOT_USABLE_FOR_RECOMMENDATION: 'The latest market information is not fresh enough for a plan adjustment.',
};

function previewReasonText(reasonCode) {
  if (PREVIEW_REASON_COPY[reasonCode]) return PREVIEW_REASON_COPY[reasonCode];
  if (reasonCode === 'BOUNDED_REDUCTION_FROM_HIGHER_RISK_ELIGIBLE_INSTRUMENT') {
    return 'A limited amount is moved away from a higher-risk investment already in your plan.';
  }
  if (reasonCode === 'BOUNDED_TRANSFER_TO_LOWEST_RISK_ALREADY_ELIGIBLE_INSTRUMENT') {
    return 'The amount is moved to a lower-risk investment already in your suitable plan.';
  }
  return 'No additional change is permitted within your current plan constraints.';
}

function previewErrorCopy(error) {
  if (error?.code === 'STALE_RECOMMENDATION_PROFILE' || error?.code === 'RECOMMENDATION_STALE'
      || error?.code === 'FINANCIAL_STATE_CHANGED') {
    return 'Your saved plan has changed since recommendations were created. Refresh or regenerate the plan, then try again.';
  }
  if (error?.code === 'MARKET_CONTEXT_CHANGED') {
    return 'Verified market information changed while this preview was running. Refresh market data and run the preview again.';
  }
  if (error?.code === 'AUTH_REQUIRED' || error?.status === 401) {
    return 'Your session has expired. Sign in again to preview your plan.';
  }
  if (error?.code === 'REQUEST_TIMEOUT' || error?.status === 408 || error?.status === 504) {
    return 'The preview took too long to load. Check your connection and try again.';
  }
  return error?.message || 'The plan preview is unavailable. Refresh market data and try again.';
}

function formatAllocationPercent(weight) {
  return `${(Number(weight) * 100).toFixed(2)}%`;
}

function formatAllocationDelta(deltaPct) {
  const rounded = Math.abs(deltaPct) < 0.005 ? 0 : deltaPct;
  if (rounded === 0) return '0.00 pp';
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded).toFixed(2)} pp`;
}

const SIGNAL_DEFINITIONS = [
  { key: 'nifty50Current', label: 'NIFTY 50', group: 'market' },
  { key: 'nifty50PreviousClose', label: 'Previous close', group: 'market' },
  { key: 'indiaVixCurrent', label: 'India VIX', group: 'market' },
  { key: 'return1DayPct', label: '1-day return', group: 'market' },
  { key: 'return5DayPct', label: '5-day return', group: 'market' },
  { key: 'return20DayPct', label: '20-day return', group: 'market' },
  { key: 'drawdownFromRecentHighPct', label: 'Drawdown from recent high', group: 'trend' },
  { key: 'movingAverage50Day', label: '50-day moving average', group: 'trend' },
  { key: 'movingAverage200Day', label: '200-day moving average', group: 'trend' },
  { key: 'priceVsMovingAverage50Pct', label: 'vs. 50-day average', group: 'trend' },
  { key: 'priceVsMovingAverage200Pct', label: 'vs. 200-day average', group: 'trend' },
  { key: 'realizedVolatility20DayAnnualizedPct', label: '20-day realized volatility', group: 'volatility' },
];

function getRiskTierColor(tier) {
  switch (tier) {
    case 'Very Low Risk': return { color: '#22c55e', bg: 'rgba(34, 197, 94, 0.1)', border: 'rgba(34, 197, 94, 0.3)' };
    case 'Low Risk': return { color: '#84cc16', bg: 'rgba(132, 204, 22, 0.1)', border: 'rgba(132, 204, 22, 0.3)' };
    case 'Moderate Risk': return { color: '#eab308', bg: 'rgba(234, 179, 8, 0.1)', border: 'rgba(234, 179, 8, 0.3)' };
    case 'High Risk': return { color: '#ef4444', bg: 'rgba(239, 68, 68, 0.1)', border: 'rgba(239, 68, 68, 0.3)' };
    default: return { color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.1)', border: 'rgba(56, 189, 248, 0.3)' };
  }
}

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

const WhereToInvestTab = ({ inv, userProfile, recommendationMeta = null }) => {
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
  const previewBindingKey = JSON.stringify(financialStateBinding);

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

  const [contextPreview, setContextPreview] = useState(null);
  const [contextPreviewVisible, setContextPreviewVisible] = useState(false);
  const [contextPreviewError, setContextPreviewError] = useState(null);
  const [contextPreviewLoading, setContextPreviewLoading] = useState(false);
  const previewController = useRef(null);
  const previewRequestGeneration = useRef(0);
  const {
    marketContext,
    marketContextError,
    marketContextLoading,
    marketContextRefreshing,
    marketContextTransport,
    marketContextRevision,
    refreshMarketContext,
    acceptMarketContext,
  } = useMarketContext();
  const [sortBy, setSortBy] = useState('score');
  const [isTechExpanded, setIsTechExpanded] = useState(false);

  // Illustrative principal & tax context state
  const [illustrativePrincipal, setIllustrativePrincipal] = useState(10000);
  const [showTaxDrawer, setShowTaxDrawer] = useState(false);
  const [taxAnnualIncome, setTaxAnnualIncome] = useState('');
  const [taxIncomeSource, setTaxIncomeSource] = useState('');
  const [taxRegime, setTaxRegime] = useState('');
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

  useEffect(() => {
    setActiveTaxContext(null);
    setShowTaxDrawer(false);
    setTaxAnnualIncome('');
    setTaxIncomeSource('');
    setTaxRegime('');
    setTaxFiscalYear('');
    setTaxUserAge('');
    setHoldingPeriodMonths('');
    setUseExactTransactionDates(false);
    setAcquisitionDate('');
    setRedemptionDate('');
    setSection112AExemptionUsed('');
    setTaxSection80C('');
    setTaxNps80CCD1B('');
    setTaxAdvancedDeductions({});
    setSttConditionAssumedSatisfied(false);
    setTaxFormError('');
  }, [financialKey, userProfile?.age]);

  useEffect(() => {
    previewRequestGeneration.current += 1;
    previewController.current?.abort();
    previewController.current = null;
    setContextPreview(null);
    setContextPreviewVisible(false);
    setContextPreviewError(null);
    setContextPreviewLoading(false);
    return () => {
      previewRequestGeneration.current += 1;
      previewController.current?.abort();
      previewController.current = null;
    };
  }, [previewBindingKey]);


  const currentMarketSnapshot = marketContext?.marketSnapshot || null;
  const currentSnapshotFingerprint = marketSnapshotFingerprint(currentMarketSnapshot, marketContext);
  const currentSnapshotFingerprintRef = useRef(currentSnapshotFingerprint);
  const marketContextRevisionRef = useRef(marketContextRevision);
  currentSnapshotFingerprintRef.current = currentSnapshotFingerprint;
  marketContextRevisionRef.current = marketContextRevision;
  useEffect(() => {
    if (contextPreview && currentSnapshotFingerprint
        && contextPreview.__marketSnapshotFingerprint !== currentSnapshotFingerprint) {
      setContextPreview(null);
      setContextPreviewVisible(false);
      setContextPreviewError('This preview is stale because the verified market snapshot changed. Run it again.');
    }
  }, [currentSnapshotFingerprint, contextPreview]);

  const toggleContextPreview = async () => {
    if (contextPreview && contextPreview.__financialBindingKey === previewBindingKey
        && contextPreview.__marketSnapshotFingerprint === currentSnapshotFingerprint) {
      setContextPreviewVisible(visible => !visible);
      return;
    }
    if (marketContext?.status !== 'MARKET_CONTEXT_AVAILABLE' || !profileId) {
      setContextPreviewError('A live market context and saved Financial Profile are required.');
      return;
    }
    const controller = new AbortController();
    const requestId = ++previewRequestGeneration.current;
    const requestMarketRevision = marketContextRevisionRef.current;
    const requestSnapshotFingerprint = currentSnapshotFingerprintRef.current;
    previewController.current = controller;
    try {
      setContextPreviewLoading(true);
      setContextPreviewError(null);
      setContextPreview(null);
      setContextPreviewVisible(false);
      const result = await api.previewMarketContextAdjustment(profileId, { signal: controller.signal });
      if (controller.signal.aborted || requestId !== previewRequestGeneration.current) return;
      const validatedResult = validatePreviewResponse(result, financialStateBinding);
      const responseFingerprint = marketSnapshotFingerprint(
        validatedResult.marketContext.marketSnapshot,
        validatedResult.marketContext,
      );
      if (marketContextRevisionRef.current > requestMarketRevision
          && currentSnapshotFingerprintRef.current
          && responseFingerprint !== currentSnapshotFingerprintRef.current) {
        const changed = new Error('Verified market information changed while this preview was running. Refresh market data and run the preview again.');
        changed.code = 'MARKET_CONTEXT_CHANGED';
        throw changed;
      }
      acceptMarketContext(validatedResult.marketContext);
      setContextPreview({
        ...validatedResult,
        __financialBindingKey: previewBindingKey,
        __marketSnapshotFingerprint: responseFingerprint,
        __marketWasRefreshed: Boolean(requestSnapshotFingerprint && requestSnapshotFingerprint !== responseFingerprint),
      });
      setContextPreviewVisible(true);
    } catch (error) {
      if (controller.signal.aborted || requestId !== previewRequestGeneration.current) return;
      setContextPreview(null);
      setContextPreviewVisible(false);
      setContextPreviewError(previewErrorCopy(error));
    } finally {
      if (!controller.signal.aborted && requestId === previewRequestGeneration.current) {
        setContextPreviewLoading(false);
        if (previewController.current === controller) previewController.current = null;
      }
    }
  };

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
  const products = rankingStatus === 'ready' ? rankingResult.products : [];
  const isEvidenceRanked = rankingResult.ranking?.status === 'EVIDENCE_RANKED';
  const isComparableSet = rankingResult.ranking?.status === 'VERIFIED_COMPARABLE_OPTIONS';

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

  const contextAvailable = marketContext?.status === 'MARKET_CONTEXT_AVAILABLE';
  const contextRawState = contextAvailable ? marketContext.context : 'MARKET_CONTEXT_UNAVAILABLE';
  const beginnerMarketState = contextAvailable ? marketContext.context : 'UNAVAILABLE';
  const contextCopy = MARKET_CONTEXT_COPY[beginnerMarketState] || MARKET_CONTEXT_COPY.UNAVAILABLE;
  const marketSnapshot = marketContext?.marketSnapshot || null;
  const providerSelection = marketContext?.liveProviderSelection || marketSnapshot?.providerSelection || null;
  const marketDisplay = getMarketDisplayState(marketContext, {
    loading: marketContextLoading && marketContext === null && !marketContextError,
    refreshFailed: marketContextTransport?.revalidationStatus === 'FAILED',
  });
  const marketEvidenceSource = getMarketEvidenceSource(marketContext);
  const marketAttemptedProvider = getMarketAttemptedProvider(marketContext);
  const marketObservedAt = formatMarketTimestamp(marketSnapshot?.observedAt || marketContext?.observedAt);
  const currentAllocationSource = recommendationMeta?.current_allocation_source
    || recommendationMeta?.currentAllocationSource
    || 'ORIGINAL_RECOMMENDATION';
  const generationAdjustment = recommendationMeta?.generation_market_adjustment
    || recommendationMeta?.market_adjustment
    || null;
  const adjustmentExplanation = currentAllocationSource === 'USER_REBALANCED'
    ? 'Your current allocation was manually rebalanced. The market context below is current evidence; it is not proof that your saved weights were changed by the market policy.'
    : currentAllocationSource === 'MARKET_CONTEXT_ADJUSTED' && generationAdjustment?.applied === true
      ? 'The saved recommendation includes a bounded market-context adjustment inside your suitability limits.'
      : 'The market context below is current evidence. Your saved recommendation remains profile-led unless the recommendation metadata says a bounded adjustment was applied.';

  let marketBadgeColor = '#38bdf8';
  let marketBadgeBg = 'rgba(56, 189, 248, 0.12)';
  let marketBadgeBorder = 'rgba(56, 189, 248, 0.25)';
  if (beginnerMarketState === 'NORMAL') {
    marketBadgeColor = '#22c55e';
    marketBadgeBg = 'rgba(34, 197, 94, 0.12)';
    marketBadgeBorder = 'rgba(34, 197, 94, 0.25)';
  } else if (beginnerMarketState === 'CAUTIOUS') {
    marketBadgeColor = '#f59e0b';
    marketBadgeBg = 'rgba(245, 158, 11, 0.12)';
    marketBadgeBorder = 'rgba(245, 158, 11, 0.25)';
  } else if (beginnerMarketState === 'HIGH_VOLATILITY' || beginnerMarketState === 'RISK_OFF') {
    marketBadgeColor = '#ef4444';
    marketBadgeBg = 'rgba(239, 68, 68, 0.12)';
    marketBadgeBorder = 'rgba(239, 68, 68, 0.25)';
  }

  const signalMap = marketContext?.signals || {};
  const definedSignalKeys = new Set(SIGNAL_DEFINITIONS.map(d => d.key));
  const marketSignals = SIGNAL_DEFINITIONS.filter(d => d.group === 'market' && signalMap[d.key]);
  const trendAndVolatilitySignals = SIGNAL_DEFINITIONS.filter(d => ['trend', 'volatility'].includes(d.group) && signalMap[d.key]);
  const otherSignals = Object.keys(signalMap)
    .filter(k => !definedSignalKeys.has(k))
    .map(k => ({ key: k, label: k.replace(/([A-Z])/g, ' $1').trim() }));

  const contextReasonCodes = marketContext?.reasonCodes || (marketContextError ? ['MARKET_CONTEXT_REQUEST_FAILED'] : []);

  const semanticFacts = marketSnapshot
    ? `${marketSnapshot.observedFacts?.length || 0} observed · ${marketSnapshot.derivedFacts?.length || 0} derived · 1 policy output`
    : 'Observed, derived, and policy output are separated by the backend contract.';

  const previewMarketSnapshot = contextPreview?.marketContext?.marketSnapshot;
  const previewUsable = contextPreview?.marketContext?.recommendationUsability?.status === 'USABLE';
  const previewRows = (contextPreview?.adjustedInstruments || []).map(instrument => {
    const currentWeight = Number(contextPreview.baseWeights[instrument.id]);
    const proposedWeight = Number(contextPreview.adjustedWeights[instrument.id]);
    const changePct = (proposedWeight - currentWeight) * 100;
    const explanation = contextPreview.explanations?.find(item => item.instrumentId === instrument.id);
    return {
      id: instrument.id,
      name: instrument.name || instrument.id,
      currentWeight,
      proposedWeight,
      changePct,
      reason: explanation ? previewReasonText(explanation.reasonCode) : null,
    };
  });
  const previewNoOpReason = !previewUsable
    ? 'Verified market information is not fresh or complete enough to calculate an adjustment.'
    : !contextPreview?.applied
      ? previewReasonText(contextPreview?.reasonCodes?.[0])
      : null;

  const formatSignal = (item) => {
    if (!item?.available || !Number.isFinite(item.value)) return 'UNAVAILABLE';
    const value = Number(item.value).toLocaleString('en-IN', { maximumFractionDigits: 2 });
    return item.unit === 'PERCENT' ? `${value}%` : value;
  };

  const signalSemanticClass = (key) => signalMap[key]?.semanticClass || signalMap[key]?.dataClass
    || (['nifty50Current', 'nifty50PreviousClose', 'indiaVixCurrent'].includes(key) ? 'OBSERVED' : 'DERIVED');

  return (
    <div className="tab-fade-in">
      {/* ─── Beginner-First Market Summary Card ─── */}
      <section
        className="wti-beginner-market-card"
        aria-label="Market conditions overview"
        style={{ '--market-accent': marketBadgeColor }}
      >
        <div className="wti-beginner-market-header">
          <div className="wti-header-title-group">
            <Globe size={16} className="wti-header-globe-icon" style={{ color: marketBadgeColor }} />
            <h3 className="wti-header-title">Market today</h3>
          </div>
          <span
            className="wti-beginner-market-badge"
            style={{
              color: marketBadgeColor,
              background: marketBadgeBg,
              borderColor: marketBadgeBorder,
            }}
          >
            {contextAvailable ? contextRawState.replaceAll('_', ' ') : marketDisplay.label}
          </span>
        </div>

        <div className="wti-beginner-market-body">
          <p className="wti-beginner-market-headline">{contextCopy.headline}</p>
          <p className="wti-beginner-meaning">
            <span className="wti-meaning-lead">What this means for you:</span> {adjustmentExplanation}
          </p>
          <div className="wti-market-evidence-summary" data-testid="market-data-status">
            <div className="wti-market-status-copy">
              <span className="wti-market-data-status">{marketDisplay.label}</span>
              <span>{marketDisplay.detail}</span>
            </div>
            {marketContextTransport?.revalidationStatus === 'FAILED' && (
              <span className="wti-market-refresh-notice" role="status">Refresh failed; showing the last verified snapshot.</span>
            )}
            <span className="wti-market-data-asof">
              As of: {marketObservedAt || 'Unavailable'} · Verified source: {marketEvidenceSource || 'Unavailable'}
            </span>
            <button
              type="button"
              className="wti-market-refresh-btn"
              onClick={() => refreshMarketContext()}
              disabled={marketContextRefreshing || marketContextLoading}
              aria-label="Refresh market data"
            >
              <RefreshCw size={13} className={marketContextRefreshing ? 'wti-refresh-spin' : ''} />
              <span>{marketContextRefreshing ? 'Refreshing…' : 'Refresh'}</span>
            </button>
          </div>
        </div>

        <div className="wti-beginner-market-footer">
          <button
            type="button"
            className="wti-preview-plan-btn"
            onClick={toggleContextPreview}
            disabled={contextPreviewLoading || !contextAvailable || !profileId}
            aria-label={contextPreview ? `${contextPreviewVisible ? 'Hide' : 'Show'} allocation preview` : 'See how this affects my plan'}
          >
            <ArrowUpRight size={14} />
            <span>
              {contextPreviewLoading
                ? 'Running Server Preview…'
                : contextPreview
                ? `${contextPreviewVisible ? 'Hide' : 'Show'} allocation preview`
                : 'See how this affects my plan'}
            </span>
          </button>

          <button
            type="button"
            className="wti-tech-toggle-btn"
            onClick={() => setIsTechExpanded(prev => !prev)}
            aria-expanded={isTechExpanded}
            aria-controls="market-context-panel"
          >
            <span>Technical details</span>
            <ChevronDown
              size={14}
              className={`wti-chevron-icon ${isTechExpanded ? 'wti-chevron-rotated' : ''}`}
            />
          </button>
        </div>

        {contextPreview && contextPreviewVisible && (
          <section className="wti-preview-panel" aria-label="Hypothetical plan allocation preview" aria-live="polite" data-testid="market-adjustment-preview">
            <div className="wti-preview-panel-heading">
              <h4>Hypothetical allocation preview</h4>
              <span>{contextPreview.applied ? 'Proposed change' : 'No allocation change'}</span>
            </div>
            <dl className="wti-preview-context-grid">
              <div>
                <dt>Market condition used</dt>
                <dd>{contextPreview.marketContext?.context
                  ? contextPreview.marketContext.context.replaceAll('_', ' ').toLowerCase().replace(/^./, char => char.toUpperCase())
                  : 'Unavailable'}</dd>
              </div>
              <div>
                <dt>Evidence observed</dt>
                <dd>{formatMarketTimestamp(previewMarketSnapshot?.observedAt) || 'Unavailable'}</dd>
              </div>
              <div>
                <dt>Proposed total shift</dt>
                <dd>{previewUsable ? `${Number(contextPreview.actualTotalTiltPct).toFixed(2)}%` : 'Not calculated'}</dd>
              </div>
              <div>
                <dt>Policy version</dt>
                <dd>{previewMarketSnapshot?.policyOutput?.policyVersion || 'Unavailable'}</dd>
              </div>
            </dl>

            {contextPreview.__marketWasRefreshed && (
              <p className="wti-preview-refresh-note" role="status">
                The server refreshed verified market information for this preview. The comparison below uses that exact snapshot.
              </p>
            )}

            {!previewUsable && (
              <p className="wti-preview-noop" role="status">{previewNoOpReason} No allocation change was calculated.</p>
            )}
            {previewUsable && !contextPreview.applied && (
              <p className="wti-preview-noop" role="status">{previewNoOpReason}</p>
            )}

            {previewUsable && (
              <div className="wti-preview-table-wrap" tabIndex="0" aria-label="Scrollable before and after allocation comparison">
                <table className="wti-preview-table">
                  <caption>Current and proposed allocation percentages</caption>
                  <thead>
                    <tr>
                      <th scope="col">Investment</th>
                      <th scope="col">Current</th>
                      <th scope="col">Preview</th>
                      <th scope="col">Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.map(row => (
                      <tr key={row.id} data-testid={`preview-row-${row.id}`}>
                        <th scope="row">
                          <span>{row.name}</span>
                          {row.reason && <small>{row.reason}</small>}
                        </th>
                        <td>{formatAllocationPercent(row.currentWeight)}</td>
                        <td>{formatAllocationPercent(row.proposedWeight)}</td>
                        <td>
                          <span className={`wti-preview-delta ${row.changePct > 0.005 ? 'wti-preview-delta--increase' : row.changePct < -0.005 ? 'wti-preview-delta--reduce' : ''}`}>
                            {row.changePct > 0.005 ? 'Increase ' : row.changePct < -0.005 ? 'Reduce ' : 'Unchanged '}
                            {formatAllocationDelta(row.changePct)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p className="wti-preview-disclaimer">
              This is a hypothetical comparison within your suitability limits. Your saved plan has not changed; nothing has been bought or sold. It is not a guarantee of improved returns.
            </p>
          </section>
        )}
        {contextPreviewError && (
          <p role="alert" className="wti-preview-error">{contextPreviewError}</p>
        )}

        {/* Technical Details Panel — Collapsed by Default */}
        <div
          id="market-context-panel"
          data-testid="market-context-panel"
          className={`wti-tech-panel ${isTechExpanded ? 'wti-tech-panel--expanded' : 'wti-tech-panel--collapsed'}`}
          hidden={!isTechExpanded}
        >
          <div className="wti-tech-panel-inner">
            {/* Metric Signal Groups */}
            <div data-testid="market-context-signals" className="wti-tech-signals-container">
              {marketSignals.length > 0 && (
                <div className="wti-tech-group">
                  <h4 className="wti-tech-group-title">Market & Benchmark Indicators</h4>
                  <div className="wti-tech-metric-grid">
                    {marketSignals.map(sig => {
                      const valStr = String(formatSignal(signalMap[sig.key]));
                      const isNegative = valStr.startsWith('-') || valStr.startsWith('−');
                      const isPositivePct = valStr.endsWith('%') && Number(signalMap[sig.key]?.value) > 0;
                      return (
                        <div key={sig.key} className="wti-tech-metric-tile" data-signal-key={sig.key}>
                          <div className="wti-tech-metric-top">
                            <span className="wti-tech-metric-label">{sig.label}</span>
                            <span className={`wti-tech-metric-class wti-class-${String(signalSemanticClass(sig.key)).toLowerCase()}`}>
                              {signalSemanticClass(sig.key)}
                            </span>
                          </div>
                          <span
                            className="wti-tech-metric-value"
                            style={{
                              color: !signalMap[sig.key]?.available
                                ? '#fbbf24'
                                : isNegative
                                ? '#f87171'
                                : isPositivePct
                                ? '#34d399'
                                : '#f8fafc',
                            }}
                          >
                            {formatSignal(signalMap[sig.key])}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {trendAndVolatilitySignals.length > 0 && (
                <div className="wti-tech-group">
                  <h4 className="wti-tech-group-title">Trend, Moving Averages & Volatility</h4>
                  <div className="wti-tech-metric-grid">
                    {trendAndVolatilitySignals.map(sig => {
                      const valStr = String(formatSignal(signalMap[sig.key]));
                      const isNegative = valStr.startsWith('-') || valStr.startsWith('−');
                      const isPositivePct = valStr.endsWith('%') && Number(signalMap[sig.key]?.value) > 0;
                      return (
                        <div key={sig.key} className="wti-tech-metric-tile" data-signal-key={sig.key}>
                          <div className="wti-tech-metric-top">
                            <span className="wti-tech-metric-label">{sig.label}</span>
                            <span className={`wti-tech-metric-class wti-class-${String(signalSemanticClass(sig.key)).toLowerCase()}`}>
                              {signalSemanticClass(sig.key)}
                            </span>
                          </div>
                          <span
                            className="wti-tech-metric-value"
                            style={{
                              color: !signalMap[sig.key]?.available
                                ? '#fbbf24'
                                : isNegative
                                ? '#f87171'
                                : isPositivePct
                                ? '#34d399'
                                : '#f8fafc',
                            }}
                          >
                            {formatSignal(signalMap[sig.key])}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {otherSignals.length > 0 && (
                <div className="wti-tech-group wti-tech-group--other">
                  <h4 className="wti-tech-group-title">Other Telemetry Signals</h4>
                  <div className="wti-tech-metric-grid">
                    {otherSignals.map(sig => (
                      <div key={sig.key} className="wti-tech-metric-tile" data-signal-key={sig.key}>
                        <div className="wti-tech-metric-top">
                          <span className="wti-tech-metric-label">{sig.label}</span>
                          <span className={`wti-tech-metric-class wti-class-${String(signalSemanticClass(sig.key)).toLowerCase()}`}>
                            {signalSemanticClass(sig.key)}
                          </span>
                        </div>
                        <span
                          className="wti-tech-metric-value"
                          style={{ color: signalMap[sig.key]?.available ? '#f8fafc' : '#fbbf24' }}
                        >
                          {formatSignal(signalMap[sig.key])}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Evidence & Provenance Section */}
            <div className="wti-tech-evidence-section">
              <div className="wti-tech-evidence-header">
                <div className="wti-tech-evidence-title-group">
                  <Shield size={16} />
                  <h4 className="wti-tech-group-title">Evidence & Policy Provenance</h4>
                </div>
                <div className="wti-semantic-legend" data-testid="market-semantic-legend">
                  <span className="wti-legend-chip wti-chip-observed"><span className="wti-chip-dot"></span> Observed facts: provider values</span>
                  <span className="wti-legend-chip wti-chip-derived"><span className="wti-chip-dot"></span> Derived facts: deterministic calculations</span>
                  <span className="wti-legend-chip wti-chip-policy"><span className="wti-chip-dot"></span> Policy output: market-context classification</span>
                </div>
              </div>

              <div className="wti-tech-policy-dock">
                <div className="wti-tech-policy-badge">
                  {contextAvailable
                    ? `${marketContext.classification} · ${marketContext.policyVersion} · confidence: unavailable (deterministic policy, not ML)`
                    : marketContextError || 'No usable live context is published unless NIFTY 50, India VIX, and sufficient fresh history are all verified.'}
                </div>
                <div className="wti-tech-dataplane-badge">Data plane: {semanticFacts}</div>
              </div>

              <div className="wti-tech-provenance-grid">
                <div className="wti-provenance-card">
                  <span className="wti-provenance-kicker">Observation Timestamps</span>
                  <div className="wti-provenance-val">
                    <span>Observed: {marketContext?.observedAt || 'UNAVAILABLE'}</span>
                    <span>Evaluated: {marketContext?.evaluatedAt || 'UNAVAILABLE'}</span>
                    <span className="wti-freshness-pill">Freshness: {marketContext?.freshness?.status || 'UNAVAILABLE'}</span>
                  </div>
                </div>
                <div className="wti-provenance-card">
                  <span className="wti-provenance-kicker">Verified Data Sources</span>
                  <div className="wti-provenance-val">
                    {marketContext?.sources?.length
                      ? marketContext.sources.map(source => `${source.provider || 'UNAVAILABLE'} (${source.instrumentId || 'benchmark history'} · ${source.dataClass || 'UNAVAILABLE'})`).join(', ')
                      : 'UNAVAILABLE'}
                  </div>
                </div>
                <div className="wti-provenance-card">
                  <span className="wti-provenance-kicker">Provider Selection & Routing</span>
                  <div className="wti-provenance-val">
                    Provider attempts: {marketAttemptedProvider || 'UNAVAILABLE'} · Selected: {providerSelection?.selectedProvider || 'none'} · Fallback used: {providerSelection?.fallbackUsed ? 'yes' : 'no'}
                    {providerSelection?.providerFailures?.length > 0 && ` · Failed attempts: ${providerSelection.providerFailures.map(failure => `${failure.provider} [${failure.reasonCodes.join(', ')}]`).join('; ')}`}
                  </div>
                </div>
                <div className="wti-provenance-card wti-provenance-card--reasons">
                  <span className="wti-provenance-kicker">Active Policy Reason Codes</span>
                  <div className="wti-provenance-reasons">
                    {contextReasonCodes.length
                      ? contextReasonCodes.map(code => (
                          <span key={code} className="wti-reason-chip">{code}</span>
                        ))
                      : 'UNAVAILABLE'}
                  </div>
                </div>
              </div>

              <p className="wti-tech-safety-note">
                Context can only reduce risk within the already eligible recommendation. It cannot add products, override suitability, or execute trades.
              </p>
            </div>
          </div>
        </div>
      </section>

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
            {rankingResult.comparisonUniverse?.productionSourceUseAllowed === false
              ? 'This source is not cleared for WealthGenie production display. Product data and post-tax amounts remain unavailable until its reuse permissions are verified.'
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
            <label htmlFor="wti-tax-regime">Tax Regime</label>
            <select
              id="wti-tax-regime"
              className="wti-tax-input"
              value={taxRegime}
              onChange={(e) => setTaxRegime(e.target.value)}
              required
            >
              <option value="">Select regime</option>
              <option value="new">New Tax Regime</option>
              <option value="old">Old Tax Regime</option>
            </select>
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

      {wtiData.note && (
        <div className="wti-note-banner">
          <Info size={14} style={{ flexShrink: 0, marginTop: 2 }} />
          <p><strong>REFERENCE METADATA:</strong> {wtiData.note}</p>
        </div>
      )}

      {rankingResult.comparisonUniverse && (
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

      {rankingResult.ranking?.warning && (
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

export default WhereToInvestTab;
