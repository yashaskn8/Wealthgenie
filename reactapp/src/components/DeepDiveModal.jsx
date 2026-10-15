/**
 * WealthGenie — Deep Dive Modal (Refactored Shell)
 * ─────────────────────────────────────────────────
 * Each tab panel is extracted into its own component under ./deepdive/
 * for maintainability. This file handles modal state, layout, and tab routing.
 */
import React, { useState, useMemo } from 'react';
import { X, MapPin, Info, Shield, History as HistoryIcon, IndianRupee, Calculator as CalcIcon, AlertTriangle } from 'lucide-react';
import { investmentDatabase } from '../investmentDatabase';
import api from '../services/api';
import { isPresentFiniteNumber } from '../utils/financialValues';
import JargonTooltip from './JargonTooltip';
import './DeepDiveModal.css';

// ── Tab Panel Components ────────────────────────────────────────
import { OverviewTab, WhereToInvestTab, CalculatorTab, TaxTab, HistoryTab, WhyInvestTab } from './deepdive';
import { isProjectionInputValid, isProjectionResponseValid } from './deepdive/financialResponseIntegrity';

const TABS = [
  { id: 'Overview', icon: <Info size={16} /> },
  { id: 'Where to Invest', icon: <MapPin size={16} /> },
  { id: 'Calculator', icon: <CalcIcon size={16} /> },
  { id: 'Tax', icon: <Shield size={16} /> },
  { id: 'History', icon: <HistoryIcon size={16} /> },
  { id: 'Why Invest', icon: <IndianRupee size={16} /> }
];

const DeepDiveModal = ({ isOpen, onClose, investment, onSelectInvestment, allRecommendations, horizon, userProfile, recommendationMeta = null, initialTab = 'Overview' }) => {
  const [activeTab, setActiveTab] = useState(initialTab || 'Overview');

  React.useEffect(() => {
    if (isOpen && initialTab) {
      setActiveTab(initialTab);
    }
  }, [isOpen, initialTab, investment?.id]);
  const calcMode = 'SIP';
  const [calcAmount, setCalcAmount] = useState(5000);
  const [calcYears, setCalcYears] = useState(15);
  const [calcReturn, setCalcReturn] = useState(10);
  const [inflationRate, setInflationRate] = useState(6);
  const [benchmarkRate, setBenchmarkRate] = useState(2.7);
  const [projectionState, setProjectionState] = useState(null);
  const projectionRequestKeyRef = React.useRef(null);
  const projectionRequestGenerationRef = React.useRef(0);

  const modalRef = React.useRef(null);
  const previouslyFocusedElementRef = React.useRef(null);

  React.useEffect(() => {
    if (isOpen) {
      previouslyFocusedElementRef.current = document.activeElement;
      if (modalRef.current) {
        modalRef.current.focus();
      }

      const handleKeyDown = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        } else if (e.key === 'Tab' && modalRef.current) {
          const focusableElements = modalRef.current.querySelectorAll(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
          );
          if (focusableElements.length === 0) return;
          const first = focusableElements[0];
          const last = focusableElements[focusableElements.length - 1];

          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      };

      document.addEventListener('keydown', handleKeyDown);
      return () => {
        document.removeEventListener('keydown', handleKeyDown);
        if (previouslyFocusedElementRef.current && previouslyFocusedElementRef.current.focus) {
          previouslyFocusedElementRef.current.focus();
        }
      };
    }
  }, [isOpen, onClose]);

  // ─── Instrument-Aware Calculator Bounds ───
  const calcBounds = useMemo(() => {
    const numberOrNull = value => isPresentFiniteNumber(value) ? Number(value) : null;
    const exactReturn = numberOrNull(investment?.nominalReturn);
    const retMin = numberOrNull(investment?.expected_return_min ?? investment?.returnRange?.min) ?? exactReturn;
    const retMax = numberOrNull(investment?.expected_return_max ?? investment?.returnRange?.max) ?? exactReturn;
    const clampReturn = value => Math.max(1, Math.min(30, value));
    const modelMin = retMin === null ? 1 : clampReturn(Math.floor(retMin - 2));
    const modelMax = retMax === null ? 30 : clampReturn(Math.ceil(retMax + 2));
    const declaredMin = Number(investment?.calculatorConstraints?.minYears);
    const declaredMax = Number(investment?.calculatorConstraints?.maxYears);
    const hasDeclaredYearBounds = Number.isSafeInteger(declaredMin) && declaredMin > 0
      && Number.isSafeInteger(declaredMax) && declaredMax >= declaredMin;
    return {
      returnMin: modelMin,
      returnMax: Math.max(modelMin, modelMax),
      returnBoundsBasis: retMin === null || retMax === null ? 'GENERIC_WHAT_IF' : 'MODEL_ASSUMPTION_RANGE',
      yearMin: hasDeclaredYearBounds ? declaredMin : 1,
      yearMax: hasDeclaredYearBounds ? declaredMax : 40,
      yearBoundsBasis: hasDeclaredYearBounds
        ? investment?.calculatorConstraints?.basis || 'SERVER_DECLARED'
        : 'GENERIC_WHAT_IF',
    };
  }, [
    investment?.nominalReturn,
    investment?.expected_return_min,
    investment?.expected_return_max,
    investment?.returnRange?.min,
    investment?.returnRange?.max,
    investment?.calculatorConstraints?.minYears,
    investment?.calculatorConstraints?.maxYears,
    investment?.calculatorConstraints?.basis,
  ]);

  const calculatorStateKey = JSON.stringify({
    investmentId: investment?.id || null,
    returnMin: investment?.expected_return_min ?? investment?.returnRange?.min ?? investment?.nominalReturn ?? null,
    returnMax: investment?.expected_return_max ?? investment?.returnRange?.max ?? investment?.nominalReturn ?? null,
    constraints: investment?.calculatorConstraints || null,
    horizon: horizon ?? null,
    profileId: recommendationMeta?.profileId || recommendationMeta?.profile_id || null,
    profileVersion: recommendationMeta?.profile_version ?? userProfile?.version ?? userProfile?.profileVersion ?? null,
    userProfileId: userProfile?.profileId || userProfile?.profile_id || null,
    userProfileUpdatedAt: userProfile?.updatedAt || userProfile?.updated_at || null,
    recommendationId: recommendationMeta?.recommendationId || recommendationMeta?.recommendation_id || null,
    allocationRevision: recommendationMeta?.allocation_revision ?? null,
    allocationRevisionId: recommendationMeta?.allocation_revision_id || null,
    portfolioFingerprint: recommendationMeta?.portfolio_fingerprint || null,
    recommendationFingerprint: recommendationMeta?.recommendation_fingerprint || null,
    profileInputHash: recommendationMeta?.profile_input_hash || null,
    isOpen,
    initialTab: initialTab || null,
  });
  const hasInvestment = Boolean(investment);
  const projectionAssumptions = useMemo(() => ({
    monthlyInvestment: calcAmount,
    annualReturnRate: calcReturn / 100,
    benchmarkRate: benchmarkRate / 100,
    inflationRate: inflationRate / 100,
    years: calcYears,
  }), [calcAmount, calcReturn, benchmarkRate, inflationRate, calcYears]);
  const projectionInputKey = JSON.stringify({
    investmentId: investment?.id || null,
    investmentType: investment?.type || null,
    calculatorStateKey,
    assumptions: projectionAssumptions,
  });
  React.useLayoutEffect(() => {
    projectionRequestKeyRef.current = projectionInputKey;
  }, [projectionInputKey]);

  React.useEffect(() => {
    if (!hasInvestment) {
      setProjectionState(null);
      return;
    }
    const defaultYears = horizon === null || horizon === undefined || horizon === '' ? null : Number(horizon);
    const boundedYears = defaultYears !== null && Number.isFinite(defaultYears)
      ? Math.max(calcBounds.yearMin, Math.min(defaultYears, calcBounds.yearMax))
      : calcBounds.yearMin;
    setCalcReturn(Number(((calcBounds.returnMin + calcBounds.returnMax) / 2).toFixed(1)));
    setCalcYears(boundedYears);
    setCalcAmount(5000);
    setProjectionState(null);
    setActiveTab(initialTab || 'Overview');
  }, [calculatorStateKey, calcBounds, horizon, hasInvestment, initialTab]);

  // Normalize fields
  const inv = useMemo(() => {
    if (!investment) return {};
    const hasCanonicalLockIn = Object.prototype.hasOwnProperty.call(investment, 'lock_in_years')
      && investment.lock_in_years !== undefined;
    const lockInCandidate = hasCanonicalLockIn ? investment.lock_in_years : investment.lockIn;
    const lockInYears = typeof lockInCandidate === 'number'
      && Number.isFinite(lockInCandidate)
      && lockInCandidate >= 0
      ? lockInCandidate
      : null;
    return {
      ...investment,
      expected_return_min: investment.expected_return_min ?? investment.returnRange?.min ?? investment.nominalReturn,
      expected_return_max: investment.expected_return_max ?? investment.returnRange?.max ?? investment.nominalReturn,
      category: investment.category || investment.cat,
      risk_level: investment.risk_level || investment.riskLabel,
      lock_in_years: lockInYears,
      tax_benefit: investment.tax_benefit ?? null,
      tax_section: investment.tax_section || 'N/A',
      tax_free_interest: investment.tax_free_interest ?? null,
      liquidity: investment.liquidity || 'Unavailable',
      description: investment.description || investment.desc,
      name: investment.name || investment.abbr,
    };
  }, [investment]);
  const returnMin = Number(inv.expected_return_min);
  const returnMax = Number(inv.expected_return_max);
  const hasReturnRange = Number.isFinite(returnMin) && Number.isFinite(returnMax);
  const riskLevel = typeof inv.risk_level === 'string' ? inv.risk_level : '';

  React.useEffect(() => {
    if (!isOpen || !hasInvestment || !isProjectionInputValid(projectionAssumptions)) return undefined;
    let cancelled = false;
    const controller = new AbortController();
    const requestKey = projectionInputKey;
    const requestAssumptions = projectionAssumptions;
    const generation = ++projectionRequestGenerationRef.current;
    const timer = setTimeout(() => {
      setProjectionState({ inputKey: requestKey, status: 'loading', result: null, error: null });
      api.compareInvestmentProjection(
        requestAssumptions.monthlyInvestment,
        requestAssumptions.annualReturnRate,
        requestAssumptions.benchmarkRate,
        requestAssumptions.inflationRate,
        requestAssumptions.years,
        { signal: controller.signal },
      ).then(result => {
        if (cancelled || generation !== projectionRequestGenerationRef.current
          || projectionRequestKeyRef.current !== requestKey) return;
        if (!isProjectionResponseValid(result, requestAssumptions)) {
          setProjectionState({
            inputKey: requestKey,
            status: 'error',
            result: null,
            error: 'The server response did not match the current projection assumptions.',
          });
          return;
        }
        setProjectionState({ inputKey: requestKey, status: 'ready', result, error: null });
      }).catch(error => {
        if (!cancelled && generation === projectionRequestGenerationRef.current
          && projectionRequestKeyRef.current === requestKey && error?.code !== 'REQUEST_ABORTED') {
          setProjectionState({
            inputKey: requestKey,
            status: 'error',
            result: null,
            error: error?.message || 'Comparison is unavailable.',
          });
        }
      });
    }, 250);
    return () => {
      cancelled = true;
      projectionRequestGenerationRef.current += 1;
      clearTimeout(timer);
      controller.abort();
    };
  }, [isOpen, hasInvestment, calculatorStateKey, projectionInputKey, projectionAssumptions]);

  const currentProjectionState = projectionState?.inputKey === projectionInputKey ? projectionState : null;
  const projection = currentProjectionState?.status === 'ready' ? currentProjectionState.result : null;
  const projectionError = currentProjectionState?.status === 'error' ? currentProjectionState.error : null;
  const projectionLoading = Boolean(isOpen && hasInvestment && isProjectionInputValid(projectionAssumptions)
    && (!currentProjectionState || currentProjectionState.status === 'loading'));

  const historicalData = useMemo(() => (projection?.normalizedChart || []).map(point => ({
    ...point,
    fd: point.benchmark,
  })), [projection]);

  if (!isOpen || !investment) return null;

  // ─── Runtime Safety: Missing Catalog ID Fallback ───
  const catalogMatch = investmentDatabase.find(x => x.id === investment?.id);
  if (!catalogMatch) {
    console.warn(`[WealthGenie Diagnostics] Investment ID "${investment?.id}" not found in master catalog.`);
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="ddm-content" onClick={e => e.stopPropagation()} style={{ minHeight: '320px', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', padding: '48px 32px' }}>
          <button className="modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
          <div style={{ textAlign: 'center', color: '#94a3b8' }}>
            <div style={{ display: 'inline-flex', padding: '18px', borderRadius: '50%', background: 'rgba(251, 191, 36, 0.1)', color: '#fbbf24', marginBottom: '20px' }}>
              <AlertTriangle size={36} />
            </div>
            <h3 style={{ color: '#f8fafc', fontSize: '1.2rem', marginBottom: '8px' }}>Investment Details Unavailable</h3>
            <p style={{ fontSize: '0.9rem', maxWidth: '340px', margin: '0 auto 24px auto', lineHeight: '1.6', color: '#94a3b8' }}>
              The profile for <strong style={{ color: '#e2e8f0' }}>"{investment?.name || investment?.id || 'Unknown'}"</strong> is temporarily unavailable or undergoing maintenance.
            </p>
            <button onClick={onClose} style={{ background: 'linear-gradient(135deg, #38bdf8, #818cf8)', color: '#0f172a', border: 'none', borderRadius: '10px', padding: '10px 24px', fontWeight: 700, cursor: 'pointer', fontSize: '0.9rem' }}>
              Return to Dashboard
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Comparison data
  const comparisonData = (allRecommendations || []).slice(0, 8).map(r => ({
    name: (r.name || r.abbr || '').length > 10 ? (r.name || r.abbr || '').substring(0, 10) + '..' : (r.name || r.abbr || ''),
    returnMax: r.expected_return_max ?? r.nominalReturn,
    isThis: r.id === inv.id
  }));

  // The backend owns every displayed projection. Tax is intentionally not
  // inferred here because this modal does not collect a complete tax context.
  const calcProps = {
    inv,
    calcAmount,
    calcReturn,
    calcYears,
    calcMode,
    calcBounds,
    inflationRate,
    benchmarkRate,
    projection,
    projectionError,
    projectionLoading,
    projectionAssumptions,
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <style>{`
        /* Scoped overrides for Deep Dive Modal calculator range sliders */
        .calc-field input[type="range"] {
          -webkit-appearance: none !important;
          appearance: none !important;
          width: 100% !important;
          height: 20px !important;
          background: transparent !important;
          outline: none !important;
          margin: 0 !important;
          padding: 0 !important;
          border: none !important;
          box-sizing: border-box !important;
          cursor: pointer !important;
        }

        .calc-field input[type="range"]::-webkit-slider-runnable-track {
          width: 100% !important;
          height: 4px !important;
          border-radius: 3px !important;
          border: none !important;
          box-sizing: border-box !important;
          background: linear-gradient(to right, #38bdf8 0%, #38bdf8 var(--slider-pct, 0%), rgba(255,255,255,0.08) var(--slider-pct, 0%), rgba(255,255,255,0.08) 100%) !important;
        }

        .calc-field input[type="range"]::-webkit-slider-thumb {
          -webkit-appearance: none !important;
          appearance: none !important;
          height: 16px !important;
          width: 16px !important;
          border-radius: 50% !important;
          background: #ffffff !important;
          border: 3px solid #38bdf8 !important;
          cursor: pointer !important;
          box-shadow: 0 0 10px rgba(56, 189, 248, 0.5), 0 2px 6px rgba(0, 0, 0, 0.4) !important;
          transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.2s ease !important;
          margin-top: -6px !important;
          box-sizing: border-box !important;
        }

        .calc-field input[type="range"]::-webkit-slider-thumb:hover {
          transform: scale(1.15) !important;
          box-shadow: 0 0 14px rgba(56, 189, 248, 0.7), 0 2px 8px rgba(0, 0, 0, 0.5) !important;
        }

        .calc-field input[type="range"]::-moz-range-track {
          width: 100% !important;
          height: 4px !important;
          border-radius: 3px !important;
          border: none !important;
          box-sizing: border-box !important;
          background: linear-gradient(to right, #38bdf8 0%, #38bdf8 var(--slider-pct, 0%), rgba(255,255,255,0.08) var(--slider-pct, 0%), rgba(255,255,255,0.08) 100%) !important;
        }

        .calc-field input[type="range"]::-moz-range-thumb {
          height: 16px !important;
          width: 16px !important;
          border-radius: 50% !important;
          background: #ffffff !important;
          border: 3px solid #38bdf8 !important;
          cursor: pointer !important;
          box-shadow: 0 0 10px rgba(56, 189, 248, 0.5), 0 2px 6px rgba(0, 0, 0, 0.4) !important;
          transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.2s ease !important;
          box-sizing: border-box !important;
        }

        .calc-field input[type="range"]::-moz-range-thumb:hover {
          transform: scale(1.15) !important;
          box-shadow: 0 0 14px rgba(56, 189, 248, 0.7), 0 2px 8px rgba(0, 0, 0, 0.5) !important;
        }
      `}</style>
      <div className="ddm-content" ref={modalRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="deepdive-modal-title" onClick={e => e.stopPropagation()}>
        
        {/* Sticky Header */}
        <div className="ddm-sticky-header">
          <button className="modal-close" onClick={onClose} aria-label="Close dialog"><X size={18} /></button>
          
          <div className="ddm-header-top">
            <span className="premium-badge">{inv.category}</span>
            <h2 id="deepdive-modal-title" className="ddm-title">{inv.name}</h2>
            <span className="ddm-data-note">
              {inv.returnDataClass || 'MODEL_ASSUMPTION'} · {inv.returnAssumptionVersion || 'wealthgenie-projection-assumptions-1.0.0'} · not an observed market fact or provider forecast
            </span>
          </div>

          <div className="ddm-quick-metrics">
            <div className="metric-item">
              <span className="metric-label"><JargonTooltip term="Risk Profile">Risk Profile</JargonTooltip></span>
              <span className="metric-value" style={{ color: !riskLevel ? '#64748b' : riskLevel.includes('High') ? '#f43f5e' : riskLevel.includes('Medium') ? '#f59e0b' : '#22c55e' }}>
                {riskLevel || 'Unavailable'}
              </span>
            </div>
            <div className="metric-item">
              <span className="metric-label"><JargonTooltip term="Return Potential">Model Return Assumption</JargonTooltip></span>
              <span className="metric-value" style={{ color: '#22c55e' }}>
                {hasReturnRange
                  ? returnMin === returnMax
                    ? `${returnMin.toFixed(1).replace(/\.0$/, '')}% p.a.`
                    : `${returnMin.toFixed(1).replace(/\.0$/, '')}% – ${returnMax.toFixed(1).replace(/\.0$/, '')}%`
                  : 'Unavailable'}
              </span>
            </div>
            <div className="metric-item">
              <span className="metric-label"><JargonTooltip term="Lock-in Period">Lock-in Period</JargonTooltip></span>
              <span className="metric-value">{inv.lock_in_years === null ? 'Unavailable' : inv.lock_in_years > 0 ? `${inv.lock_in_years} Years` : 'None'}</span>
            </div>
            <div className="metric-item">
              <span className="metric-label"><JargonTooltip term="Tax Benefit">Reference Tax Tag</JargonTooltip></span>
              <span className="metric-value">Unavailable · use Tax tab</span>
            </div>
          </div>

          <div className="ddm-tabs-nav" role="tablist" aria-label="Investment detail sections">
            {TABS.map(tab => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.id}
                className={`ddm-tab-btn ${activeTab === tab.id ? 'ddm-tab-btn--active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                <span className="ddm-tab-btn-content">{tab.icon} {tab.id}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Scrollable Content Area */}
        <div className="ddm-scroll-container">
          {activeTab === 'Overview' && <OverviewTab inv={inv} comparisonData={comparisonData} onSelectInvestment={onSelectInvestment} />}
          {activeTab === 'Where to Invest' && <WhereToInvestTab inv={inv} userProfile={userProfile} recommendationMeta={recommendationMeta} />}
          {activeTab === 'Calculator' && <CalculatorTab {...calcProps} setCalcAmount={setCalcAmount} setCalcYears={setCalcYears} setCalcReturn={setCalcReturn} setInflationRate={setInflationRate} />}
          {activeTab === 'Tax' && <TaxTab inv={inv} calcAmount={calcAmount} calcYears={calcYears} userProfile={userProfile} profileStateKey={calculatorStateKey} recommendationMeta={recommendationMeta} />}
          {activeTab === 'History' && <HistoryTab inv={inv} historicalData={historicalData} benchmarkRate={benchmarkRate} inflationRate={inflationRate} projectionError={projectionError} projectionLoading={projectionLoading} />}
          {activeTab === 'Why Invest' && <WhyInvestTab {...calcProps} setActiveTab={setActiveTab} setInflationRate={setInflationRate} setBenchmarkRate={setBenchmarkRate} />}
        </div>
      </div>
    </div>
  );
};

export default DeepDiveModal;
