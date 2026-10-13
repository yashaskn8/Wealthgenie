/**
 * DeepDiveModal — Tax Tab
 * Extracted from DeepDiveModal.jsx for maintainability.
 */
import React from 'react';
import { X, Shield, Info, Zap, ShieldCheck, Briefcase, History as HistoryIcon } from 'lucide-react';
import JargonTooltip from '../JargonTooltip';
import api from '../../services/api';
import { describeTaxUnavailableResponse, isTaxResponseValid } from './financialResponseIntegrity';

/** Never promote legacy catalog tax tags into current tax-law facts. */
function getTaxInfo() {
  return {
    section: 'UNAVAILABLE',
    taxBenefit: null,
    taxFreeInterest: null,
    maxDeduction: 'UNAVAILABLE',
    ltcg: 'TAX_CLASSIFICATION_UNAVAILABLE. A source-qualified product tax classification and explicit holding period are required.',
    stcg: 'TAX_CLASSIFICATION_UNAVAILABLE. A source-qualified product tax classification and explicit holding period are required.',
    specialNote: 'Legacy catalog tax tags are reference metadata only. Use the server what-if below with an explicit fiscal year, regime, income source and income.',
  };
}

const TaxTab = ({ inv, calcAmount, calcYears, userProfile, profileStateKey = null, recommendationMeta = null }) => {
  const taxInfo = getTaxInfo();
  const taxBenefitKnown = typeof taxInfo.taxBenefit === 'boolean';
  const taxInterestKnown = typeof taxInfo.taxFreeInterest === 'boolean';

  return (
    <div className="tab-fade-in">
      <div className="ddm-section-header">Reference Tax Metadata</div>
      <div className="ddm-pc-grid" style={{ marginBottom: 32 }}>
        <div className="tax-card-premium" style={{ borderTop: `1px solid ${taxBenefitKnown ? (taxInfo.taxBenefit ? 'rgba(34, 197, 94, 0.6)' : 'rgba(244, 63, 94, 0.6)') : 'rgba(148, 163, 184, 0.45)'}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
            <span className="metric-label" style={{ color: '#94a3b8', fontSize: '0.85rem', letterSpacing: '1.5px', fontWeight: 700 }}><JargonTooltip term="Eligible investment deductions">TAX DEDUCTION ELIGIBILITY</JargonTooltip></span>
            <Shield size={20} color={taxBenefitKnown ? (taxInfo.taxBenefit ? '#22c55e' : '#f43f5e') : '#94a3b8'} opacity={0.6} />
          </div>
          <div style={{ margin: '16px 0', flexGrow: 1 }}>
            <span className={`tax-status-chip ${taxBenefitKnown ? (taxInfo.taxBenefit ? 'tax-status-chip--eligible' : 'tax-status-chip--not-eligible') : ''}`} style={{ fontSize: '1.1rem', padding: '12px 20px', borderRadius: '12px', boxShadow: `0 0 24px ${taxBenefitKnown ? (taxInfo.taxBenefit ? 'rgba(34, 197, 94, 0.2)' : 'rgba(244, 63, 94, 0.2)') : 'rgba(148, 163, 184, 0.12)'}` }}>
              {taxBenefitKnown ? (taxInfo.taxBenefit ? <><ShieldCheck size={20} /> QUALIFIED</> : <><X size={20} /> NOT ELIGIBLE</>) : <><Info size={20} /> UNAVAILABLE</>}
            </span>
          </div>
          <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 20, marginTop: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: '#64748b', fontSize: '0.9rem', fontWeight: 600 }}>Deduction limit</span>
            <strong style={{ color: '#f8fafc', fontSize: '1.1rem', fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.5px' }}>{taxInfo.maxDeduction}</strong>
          </div>
        </div>
        <div className="tax-card-premium" style={{ borderTop: '1px solid rgba(56, 189, 248, 0.6)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
            <span className="metric-label" style={{ color: '#94a3b8', fontSize: '0.85rem', letterSpacing: '1.5px', fontWeight: 700 }}>TAXABILITY OF INTEREST</span>
            <Briefcase size={20} color="#38bdf8" opacity={0.6} />
          </div>
          <div style={{ fontSize: '2.2rem', fontWeight: 800, margin: '12px 0', color: '#f8fafc', letterSpacing: '-0.03em', flexGrow: 1, textShadow: '0 4px 24px rgba(0,0,0,0.5)' }}>
            {!taxInterestKnown ? <span style={{ color: '#94a3b8' }}>UNAVAILABLE</span> : taxInfo.taxFreeInterest ? <span style={{ color: '#38bdf8', textShadow: '0 0 24px rgba(56,189,248,0.5)' }}><JargonTooltip term="EEE">Tax-Free (EEE)</JargonTooltip></span> : <span style={{ color: '#f8fafc' }}>Fully Taxable</span>}
          </div>
          <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 20, marginTop: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: '#64748b', fontSize: '0.9rem', fontWeight: 600 }}>Current rule reference</span>
            <strong style={{ color: '#cbd5e1', fontSize: '1.1rem', fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.5px' }}>{taxInfo.section}</strong>
          </div>
        </div>
      </div>

      <div className="ddm-section-header">Capital Gains (Market Linked)</div>
      <div className="ddm-pc-grid">
        <div className="tax-cg-card" style={{ borderTop: '1px solid rgba(245, 158, 11, 0.6)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '20px', marginBottom: '24px' }}>
            <div style={{ padding: '16px', background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.2), rgba(245, 158, 11, 0.05))', borderRadius: '16px', border: '1px solid rgba(245, 158, 11, 0.3)', boxShadow: '0 12px 24px -8px rgba(245, 158, 11, 0.2)' }}>
               <HistoryIcon size={28} color="#fcd34d" />
            </div>
            <div>
              <div style={{ color: '#fbbf24', fontSize: '0.8rem', fontWeight: 800, letterSpacing: '1.5px', textTransform: 'uppercase', marginBottom: '6px' }}>Holding Period</div>
              <div style={{ color: '#f8fafc', fontSize: '1.4rem', fontWeight: 800, letterSpacing: '-0.02em', textShadow: '0 2px 12px rgba(0,0,0,0.5)' }}>
                <JargonTooltip term="LTCG">Long-Term (LTCG)</JargonTooltip>
              </div>
            </div>
          </div>
          <div style={{ padding: '24px', background: 'rgba(15, 23, 42, 0.6)', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.05)', boxShadow: 'inset 0 2px 10px rgba(0,0,0,0.5)' }}>
            <p style={{ color: '#e2e8f0', fontSize: '1.1rem', lineHeight: 1.8, margin: 0, fontWeight: 500 }}>{taxInfo.ltcg}</p>
          </div>
        </div>
        <div className="tax-cg-card" style={{ borderTop: '1px solid rgba(244, 63, 94, 0.6)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '20px', marginBottom: '24px' }}>
            <div style={{ padding: '16px', background: 'linear-gradient(135deg, rgba(244, 63, 94, 0.2), rgba(244, 63, 94, 0.05))', borderRadius: '16px', border: '1px solid rgba(244, 63, 94, 0.3)', boxShadow: '0 12px 24px -8px rgba(244, 63, 94, 0.2)' }}>
               <Zap size={28} color="#fda4af" />
            </div>
            <div>
              <div style={{ color: '#fb7185', fontSize: '0.8rem', fontWeight: 800, letterSpacing: '1.5px', textTransform: 'uppercase', marginBottom: '6px' }}>Holding Period</div>
              <div style={{ color: '#f8fafc', fontSize: '1.4rem', fontWeight: 800, letterSpacing: '-0.02em', textShadow: '0 2px 12px rgba(0,0,0,0.5)' }}>
                <JargonTooltip term="STCG">Short-Term (STCG)</JargonTooltip>
              </div>
            </div>
          </div>
          <div style={{ padding: '24px', background: 'rgba(15, 23, 42, 0.6)', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.05)', boxShadow: 'inset 0 2px 10px rgba(0,0,0,0.5)' }}>
            <p style={{ color: '#e2e8f0', fontSize: '1.1rem', lineHeight: 1.8, margin: 0, fontWeight: 500 }}>{taxInfo.stcg}</p>
          </div>
        </div>
      </div>

      {taxInfo.specialNote && (
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 12,
          padding: '16px 20px', borderRadius: 14, marginTop: 20,
          background: 'linear-gradient(135deg, rgba(56, 189, 248, 0.05), rgba(139, 92, 246, 0.04))',
          border: '1px solid rgba(56, 189, 248, 0.12)',
        }}>
          <Info size={16} style={{ flexShrink: 0, marginTop: 2, color: '#38bdf8' }} />
          <div>
            <div style={{ fontSize: '0.72rem', fontWeight: 800, color: '#38bdf8', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.8px' }}>Tax Data Boundary</div>
            <p style={{ color: '#cbd5e1', fontSize: '0.82rem', lineHeight: 1.6, margin: 0 }}>{taxInfo.specialNote}</p>
          </div>
        </div>
      )}

      {/* Interactive Post-Tax Net Yield Simulator */}
      <InteractiveTaxSimulator inv={inv} calcAmount={calcAmount} calcYears={calcYears} userProfile={userProfile} profileStateKey={profileStateKey} recommendationMeta={recommendationMeta} />
    </div>
  );
};

const parseFiniteNumber = value => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '' || value.trim() !== value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const formatTaxAmount = value => '₹' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(value);

const InteractiveTaxSimulator = ({ inv, calcAmount, calcYears, userProfile, profileStateKey, recommendationMeta }) => {
  const [annualIncome, setAnnualIncome] = React.useState('');
  const [regime, setRegime] = React.useState('');
  const [incomeSource, setIncomeSource] = React.useState('');
  const [fiscalYear, setFiscalYear] = React.useState('');
  const [section112AExemptionUsed, setSection112AExemptionUsed] = React.useState('');
  const [section112ARequirementKey, setSection112ARequirementKey] = React.useState(null);
  const [resultState, setResultState] = React.useState(null);
  const [policyMetadata, setPolicyMetadata] = React.useState(null);
  const [policyError, setPolicyError] = React.useState(null);
  const taxRequestKeyRef = React.useRef(null);
  const taxRequestGenerationRef = React.useRef(0);

  const annualIncomeValue = annualIncome === '' ? null : parseFiniteNumber(annualIncome);
  const nominalReturn = parseFiniteNumber(inv?.nominalReturn);
  const userAge = parseFiniteNumber(userProfile?.age);
  const sectionIsBlank = section112AExemptionUsed === '';
  const section112AValue = sectionIsBlank ? null : parseFiniteNumber(section112AExemptionUsed);
  const verifiedFiscalYears = Array.isArray(policyMetadata?.verifiedFiscalYears) ? policyMetadata.verifiedFiscalYears : [];
  const expectedInputs = React.useMemo(() => ({
    instrumentType: inv?.type,
    nominalRate: nominalReturn === null ? null : nominalReturn / 100,
    annualIncome: annualIncomeValue,
    holdingYears: calcYears,
    regime,
    monthlySIP: calcAmount,
    userAge,
    incomeSource,
    fiscalYear,
    section112AExemptionUsed: section112AValue,
  }), [inv?.type, nominalReturn, annualIncomeValue, calcYears, regime, calcAmount, userAge, incomeSource, fiscalYear, section112AValue]);

  const recommendationKey = JSON.stringify({
    profileId: recommendationMeta?.profileId || recommendationMeta?.profile_id || null,
    profileVersion: recommendationMeta?.profile_version ?? null,
    recommendationId: recommendationMeta?.recommendationId || recommendationMeta?.recommendation_id || null,
    allocationRevision: recommendationMeta?.allocation_revision ?? null,
    allocationRevisionId: recommendationMeta?.allocation_revision_id || null,
    portfolioFingerprint: recommendationMeta?.portfolio_fingerprint || null,
    recommendationFingerprint: recommendationMeta?.recommendation_fingerprint || null,
    profileInputHash: recommendationMeta?.profile_input_hash || null,
  });
  const sectionRequirementKey = JSON.stringify({
    investmentId: inv?.id || null,
    investmentType: inv?.type || null,
    nominalReturn,
    calcAmount,
    calcYears,
    annualIncome,
    regime,
    incomeSource,
    fiscalYear,
    userAge,
    profileStateKey,
    recommendationKey,
    policyVersion: policyMetadata?.policyVersion || null,
  });
  const inputKey = JSON.stringify({
    investmentId: inv?.id || null,
    investmentType: inv?.type || null,
    nominalReturn,
    calcAmount,
    calcYears,
    annualIncome,
    regime,
    incomeSource,
    fiscalYear,
    userAge,
    section112AExemptionUsed,
    profileStateKey,
    recommendationKey,
    policyVersion: policyMetadata?.policyVersion || null,
  });
  React.useLayoutEffect(() => {
    taxRequestKeyRef.current = inputKey;
  }, [inputKey]);

  const sectionIsValid = sectionIsBlank
    || (section112AValue !== null && section112AValue >= 0 && section112AValue <= 125000);
  const annualIsValid = annualIncomeValue !== null && annualIncomeValue >= 0 && annualIncomeValue <= 1000000000;
  const isReady = Boolean(
    typeof inv?.type === 'string' && inv.type.trim()
    && nominalReturn !== null && nominalReturn >= 0 && nominalReturn <= 100
    && annualIsValid
    && regime && incomeSource
    && verifiedFiscalYears.includes(fiscalYear)
    && Number.isInteger(userAge) && userAge >= 18 && userAge <= 120
    && Number.isFinite(calcYears) && calcYears >= 0.01 && calcYears <= 100
    && Number.isFinite(calcAmount) && calcAmount >= 0 && calcAmount <= 100000000
    && sectionIsValid
  );

  React.useEffect(() => {
    let cancelled = false;
    api.getTaxPolicyMetadata()
      .then(metadata => {
        if (cancelled) return;
        setPolicyMetadata(metadata);
        if (metadata?.currentFiscalYearVerified && metadata.currentFiscalYear) {
          setFiscalYear(current => current || metadata.currentFiscalYear);
        }
      })
      .catch(() => {
        if (!cancelled) setPolicyError('Verified tax policy metadata is unavailable.');
      });
    return () => { cancelled = true; };
  }, []);

  React.useEffect(() => {
    if (!isReady) return undefined;
    let cancelled = false;
    const controller = new AbortController();
    const requestKey = inputKey;
    const requestInputs = expectedInputs;
    const generation = ++taxRequestGenerationRef.current;
    const timer = setTimeout(() => {
      setResultState({ inputKey: requestKey, status: 'loading', result: null, error: null });
      const body = requestInputs.section112AExemptionUsed === null
        ? {}
        : { section112AExemptionUsed: requestInputs.section112AExemptionUsed };
      api.computePostTaxReturn(
        requestInputs.instrumentType,
        requestInputs.nominalRate,
        requestInputs.annualIncome,
        requestInputs.holdingYears,
        requestInputs.regime,
        requestInputs.monthlySIP,
        requestInputs.userAge,
        requestInputs.incomeSource,
        requestInputs.fiscalYear,
        { signal: controller.signal, body },
      ).then(response => {
        if (cancelled || generation !== taxRequestGenerationRef.current
          || taxRequestKeyRef.current !== requestKey) return;
        if (!isTaxResponseValid(response, requestInputs)) {
          setResultState({
            inputKey: requestKey,
            status: 'error',
            result: null,
            error: 'The tax response could not be verified against the current inputs.',
          });
          return;
        }
        setSection112ARequirementKey(response.unavailableReasons.includes('section112AExemptionUsed')
          ? sectionRequirementKey
          : null);
        setResultState({ inputKey: requestKey, status: 'ready', result: response, error: null });
      }).catch(requestError => {
        if (!cancelled && generation === taxRequestGenerationRef.current
          && taxRequestKeyRef.current === requestKey && requestError?.code !== 'REQUEST_ABORTED') {
          setResultState({
            inputKey: requestKey,
            status: 'error',
            result: null,
            error: 'A verified tax calculation could not be obtained. Please try again.',
          });
        }
      });
    }, 250);
    return () => {
      cancelled = true;
      taxRequestGenerationRef.current += 1;
      clearTimeout(timer);
      controller.abort();
    };
  }, [inputKey, isReady, expectedInputs, sectionRequirementKey]);

  const currentState = resultState?.inputKey === inputKey ? resultState : null;
  const result = currentState?.status === 'ready' ? currentState.result : null;
  const loading = Boolean(isReady && (!currentState || currentState.status === 'loading'));
  const error = currentState?.status === 'error' ? currentState.error : null;
  const calculated = result?.status === 'CALCULATED';
  const requiresSection112A = section112ARequirementKey === sectionRequirementKey
    || Boolean(result && !calculated && result.unavailableReasons.includes('section112AExemptionUsed'));
  const unavailableMessage = result && !calculated ? describeTaxUnavailableResponse(result) : null;

  return (
    <div style={{
      marginTop: '2rem',
      padding: '20px',
      background: 'rgba(15, 23, 42, 0.8)',
      border: '1px solid rgba(139, 92, 246, 0.3)',
      borderRadius: '16px',
      boxShadow: '0 8px 32px rgba(0,0,0,0.3)'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Zap size={20} color="#a855f7" />
          <h4 style={{ margin: 0, color: '#f8fafc', fontSize: '1rem', fontWeight: 800 }}>
            Modelled Investor What-If
          </h4>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: '0.78rem', color: '#94a3b8', fontWeight: 600 }}>Tax Regime:</span>
          {['new', 'old'].map(option => (
            <button
              key={option}
              type="button"
              onClick={() => setRegime(option)}
              aria-pressed={regime === option}
              style={{
                padding: '4px 10px',
                borderRadius: '6px',
                border: regime === option ? '1px solid #a855f7' : '1px solid rgba(255,255,255,0.1)',
                background: regime === option ? 'rgba(168, 85, 247, 0.2)' : 'rgba(255,255,255,0.04)',
                color: regime === option ? '#e9d5ff' : '#94a3b8',
                fontSize: '0.75rem',
                fontWeight: 700,
                cursor: 'pointer'
              }}
            >
              {option === 'new' ? 'New' : 'Old'}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 }}>
        <label style={{ color: '#94a3b8', fontSize: '0.75rem', fontWeight: 600 }}>
          Gross annual income before allowed deductions (₹)
          <input type="number" min="0" max="1000000000" value={annualIncome} onChange={event => setAnnualIncome(event.target.value)} placeholder="Enter gross income" style={{ width: '100%', marginTop: 6, padding: '9px 10px', borderRadius: 8, color: '#f8fafc', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)' }} />
        </label>
        <label style={{ color: '#94a3b8', fontSize: '0.75rem', fontWeight: 600 }}>
          Income source
          <select value={incomeSource} onChange={event => setIncomeSource(event.target.value)} style={{ width: '100%', marginTop: 6, padding: '9px 10px', borderRadius: 8, color: '#f8fafc', background: '#111827', border: '1px solid rgba(255,255,255,0.1)' }}>
            <option value="">Select source</option>
            <option value="salary">Salary</option>
            <option value="pension">Pension</option>
            <option value="family_pension">Family pension</option>
            <option value="business">Business</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label style={{ color: '#94a3b8', fontSize: '0.75rem', fontWeight: 600 }}>
          Fiscal year
          <select value={fiscalYear} onChange={event => setFiscalYear(event.target.value)} style={{ width: '100%', marginTop: 6, padding: '9px 10px', borderRadius: 8, color: '#f8fafc', background: '#111827', border: '1px solid rgba(255,255,255,0.1)' }}>
            <option value="">Select fiscal year</option>
            {verifiedFiscalYears.map(year => (
              <option key={year} value={year}>{year}</option>
            ))}
          </select>
        </label>
      </div>

      {requiresSection112A && (
        <label style={{ display: 'block', color: '#cbd5e1', fontSize: '0.78rem', fontWeight: 600, marginTop: 14 }}>
          Section 112A exemption already used this financial year (₹)
          <input
            type="number"
            min="0"
            max="125000"
            step="1"
            value={section112AExemptionUsed}
            onChange={event => setSection112AExemptionUsed(event.target.value)}
            aria-label="Section 112A exemption already used this financial year"
            placeholder="Enter amount; use 0 if none"
            style={{ width: '100%', maxWidth: 360, display: 'block', marginTop: 6, padding: '9px 10px', borderRadius: 8, color: '#f8fafc', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)' }}
          />
          <span style={{ display: 'block', color: '#94a3b8', fontWeight: 400, marginTop: 6 }}>
            Leave blank only while you are checking your records. Enter 0 explicitly if none was used.
          </span>
        </label>
      )}

      {!annualIsValid && annualIncome !== '' && <p role="alert" style={{ color: '#fda4af', fontSize: '0.75rem', margin: '10px 0 0' }}>Enter gross annual income from ₹0 to ₹1,00,00,00,000.</p>}
      {!sectionIsValid && <p role="alert" style={{ color: '#fda4af', fontSize: '0.75rem', margin: '10px 0 0' }}>Enter a Section 112A amount from ₹0 to ₹1,25,000.</p>}
      {!isReady && <p style={{ color: '#94a3b8', fontSize: '0.75rem', margin: '10px 0 0' }}>Enter the separate tax facts above to run this server calculation. It uses the supplied nominal rate as a model assumption and is not an actual transaction tax estimate.</p>}
      {policyError && <p role="alert" style={{ color: '#fbbf24', fontSize: '0.75rem', margin: '10px 0 0' }}>{policyError}</p>}
      {error && <p role="alert" style={{ color: '#f87171', fontSize: '0.75rem', margin: '10px 0 0' }}>{error}</p>}
      {loading && <p role="status" style={{ color: '#7dd3fc', fontSize: '0.75rem', margin: '10px 0 0' }}>Calculating with the current inputs…</p>}
      {unavailableMessage && <p role="status" style={{ color: '#fbbf24', fontSize: '0.78rem', margin: '12px 0 0' }}>{unavailableMessage}</p>}

      <div style={{ marginTop: 14, padding: '12px 14px', borderRadius: 10, background: 'rgba(56, 189, 248, 0.06)', border: '1px solid rgba(56, 189, 248, 0.16)' }}>
        <strong style={{ color: '#7dd3fc', fontSize: '0.78rem' }}>Fixed ₹1,00,000 what-if principal</strong>
        <p style={{ color: '#cbd5e1', fontSize: '0.74rem', lineHeight: 1.55, margin: '5px 0 0' }}>
          The figures below use this fixed principal. The selected monthly SIP and holding period are tax-context inputs; these figures are not your SIP account balance or actual tax liability.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginTop: 16 }}>
        <div style={{ padding: '14px', background: 'rgba(255,255,255,0.03)', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.05)' }}>
          <span style={{ fontSize: '0.75rem', color: '#94a3b8', fontWeight: 600 }}>Gross growth on fixed principal</span>
          <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#f8fafc', marginTop: 4 }}>
            {calculated ? formatTaxAmount(result.what_if_nominal_gain) + ' (' + (nominalReturn).toFixed(2) + '%)' : loading ? 'Calculating…' : '—'}
          </div>
        </div>
        <div style={{ padding: '14px', background: 'rgba(255,255,255,0.03)', borderRadius: '10px', border: '1px solid rgba(239, 68, 68, 0.15)' }}>
          <span style={{ fontSize: '0.75rem', color: '#f87171', fontWeight: 600 }}>Modelled tax on fixed principal</span>
          <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#f87171', marginTop: 4 }}>
            {calculated ? '- ' + formatTaxAmount(result.what_if_estimated_tax) + ' (' + (result.taxRate * 100).toFixed(2) + '%)' : loading ? 'Calculating…' : '—'}
          </div>
        </div>
        <div style={{ padding: '14px', background: 'rgba(34, 197, 94, 0.08)', borderRadius: '10px', border: '1px solid rgba(34, 197, 94, 0.3)' }}>
          <span style={{ fontSize: '0.75rem', color: '#4ade80', fontWeight: 700 }}>Net growth on fixed principal</span>
          <div style={{ fontSize: '1.25rem', fontWeight: 800, color: '#4ade80', marginTop: 4 }}>
            {calculated ? formatTaxAmount(result.what_if_net_gain) + ' (' + result.effectiveYield.toFixed(2) + '% modelled net)' : loading ? 'Calculating…' : '—'}
          </div>
        </div>
      </div>
    </div>
  );
};
export default TaxTab;
