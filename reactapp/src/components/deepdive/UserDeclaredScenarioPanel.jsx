import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../../services/api';
import { formatINR } from '../../utils/recommendationPresentation';
import { assertUserDeclaredScenarioResponse } from '../../utils/taxResponseIntegrity';

const INTEREST_SCENARIO_PARENTS = new Set(['fd', 'sbi_fd', 'rbi_bonds', 'sgb']);
const NIFTYBEES_ID = 'etf:isin:INF204KB14I2';
const DEDUCTION_FIELDS = [
  ['section80C', 'Section 80C investments (₹)'],
  ['nps80CCD1B', 'NPS self-contribution under 80CCD(1B) (₹)'],
  ['nps80CCD2', 'Employer NPS contribution under 80CCD(2) (₹)'],
  ['section80D', 'Section 80D health-insurance deduction (₹)'],
  ['hra', 'Eligible HRA exemption amount (₹)'],
  ['homeLoanInterest', 'Eligible home-loan interest (₹)'],
  ['section80EEA', 'Eligible Section 80EEA amount (₹)'],
  ['savingsInterest', 'Savings interest eligible for 80TTA/80TTB (₹)'],
];

function unavailableMessage(result) {
  const reason = result?.unavailableReasons?.[0];
  if (result?.status === 'FISCAL_YEAR_UNSUPPORTED') return 'Verified tax policy is unavailable for that fiscal year.';
  if (reason === 'EQUITY_TRANSFER_STT_CONDITION_NOT_ESTABLISHED') return 'The applicable STT condition was not confirmed, so no transaction tax amount is shown.';
  if (reason === 'CAPITAL_LOSS_SET_OFF_CONTEXT_REQUIRED') return 'The entered values show a capital loss. Loss set-off and carry-forward need the complete taxpayer transaction and filing context.';
  if (reason === 'SPECIAL_RATE_HIGH_INCOME_REQUIRES_FULL_TAX_CONTEXT') return 'The backend needs a fuller taxpayer-wide tax context for this income level.';
  if (reason === 'TAX_RESIDENCY_REQUIRED_FOR_BASIC_EXEMPTION_INTERACTION') return 'Tax residency facts are needed before this capital-gains interaction can be calculated.';
  return 'A verified tax result is unavailable for this product and the facts entered.';
}

export default function UserDeclaredScenarioPanel({ canonicalInstrumentId, instrumentName, taxPolicyMetadata = null, taxPolicyError = null }) {
  const isInterest = INTEREST_SCENARIO_PARENTS.has(canonicalInstrumentId);
  const isNiftyBees = canonicalInstrumentId === 'nifty_etf';
  const supportsScenario = isInterest || isNiftyBees;
  const [taxFacts, setTaxFacts] = useState({
    annualGrossIncome: '', incomeSource: '', regime: 'new', fiscalYear: '',
    userAge: '',
  });
  const [deductionValues, setDeductionValues] = useState({});
  const [interestReceived, setInterestReceived] = useState('');
  const [acquisitionCostBasis, setAcquisitionCostBasis] = useState('');
  const [saleProceeds, setSaleProceeds] = useState('');
  const [acquisitionDate, setAcquisitionDate] = useState('');
  const [redemptionDate, setRedemptionDate] = useState('');
  const [section112AExemptionUsed, setSection112AExemptionUsed] = useState('');
  const [sttConfirmed, setSttConfirmed] = useState(false);
  const [taxContextConfirmed, setTaxContextConfirmed] = useState(false);
  const [result, setResult] = useState(null);
  const [requestFailed, setRequestFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const activeRequestKey = useRef(null);
  const scenarioInputIdentity = JSON.stringify([
    canonicalInstrumentId,
    taxFacts,
    deductionValues,
    interestReceived,
    acquisitionCostBasis,
    saleProceeds,
    acquisitionDate,
    redemptionDate,
    section112AExemptionUsed,
    sttConfirmed,
  ]);
  const scenarioInputIdentityRef = useRef(scenarioInputIdentity);
  scenarioInputIdentityRef.current = scenarioInputIdentity;
  const currentResult = result?.inputIdentity === scenarioInputIdentity ? result.data : null;
  const enteredAge = taxFacts.userAge.trim() === '' ? NaN : Number(taxFacts.userAge);
  const ageIsValid = Number.isInteger(enteredAge) && enteredAge >= 18 && enteredAge <= 120;

  useEffect(() => {
    setTaxFacts(current => ({
      ...current,
      fiscalYear: current.fiscalYear || (taxPolicyMetadata?.currentFiscalYearVerified ? taxPolicyMetadata.currentFiscalYear : ''),
    }));
  }, [taxPolicyMetadata]);

  useEffect(() => {
    activeRequestKey.current = null;
    setResult(null);
    setRequestFailed(false);
    setSubmitting(false);
    setTaxContextConfirmed(false);
  }, [canonicalInstrumentId]);


  const hasNpsEmployerContribution = Number(deductionValues.nps80CCD2) > 0;
  const verifiedFiscalYears = useMemo(() => taxPolicyMetadata?.verifiedFiscalYears || [], [taxPolicyMetadata]);

  function updateTaxFact(key, value) {
    setTaxFacts(current => ({ ...current, [key]: value }));
    activeRequestKey.current = null;
    setResult(null);
    setRequestFailed(false);
    setSubmitting(false);
    setTaxContextConfirmed(false);
  }

  function updateDeduction(key, value) {
    setDeductionValues(current => ({ ...current, [key]: value }));
    activeRequestKey.current = null;
    setResult(null);
    setRequestFailed(false);
    setSubmitting(false);
    setTaxContextConfirmed(false);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setResult(null);
    setRequestFailed(false);
    if (!ageIsValid) {
      setSubmitting(false);
      return;
    }
    const submittedInputIdentity = scenarioInputIdentity;
    setSubmitting(true);
    const deductions = Object.fromEntries(Object.entries(deductionValues)
      .filter(([, value]) => value !== '' && value !== null)
      .map(([key, value]) => [key, Number(value)]));
    if (hasNpsEmployerContribution) {
      deductions.basicSalary = Number(deductionValues.basicSalary);
      deductions.isGovtEmployee = deductionValues.isGovtEmployee === 'true';
    }
    const common = {
      canonicalInstrumentId,
      annualGrossIncome: Number(taxFacts.annualGrossIncome),
      incomeSource: taxFacts.incomeSource,
      regime: taxFacts.regime,
      fiscalYear: taxFacts.fiscalYear,
      userAge: enteredAge,
      ...(Object.keys(deductions).length > 0 ? { deductions } : {}),
    };
    const scenario = isInterest
      ? { ...common, scenarioType: 'INTEREST_INCOME', interestReceived: Number(interestReceived) }
      : {
        ...common,
        scenarioType: 'EQUITY_REALIZED_GAIN',
        canonicalProductId: NIFTYBEES_ID,
        acquisitionCostBasis: Number(acquisitionCostBasis),
        saleProceeds: Number(saleProceeds),
        acquisitionDate,
        redemptionDate,
        section112AExemptionUsed: Number(section112AExemptionUsed),
        sttConditionAssumedSatisfied: sttConfirmed,
      };
    const requestKey = JSON.stringify(scenario);
    activeRequestKey.current = requestKey;
    try {
      const response = await api.computeUserDeclaredPostTaxScenario(scenario);
      if (activeRequestKey.current === requestKey
          && scenarioInputIdentityRef.current === submittedInputIdentity) {
        assertUserDeclaredScenarioResponse(response, scenario);
        setResult({ inputIdentity: submittedInputIdentity, data: response });
      }
    } catch {
      if (activeRequestKey.current === requestKey
          && scenarioInputIdentityRef.current === submittedInputIdentity) setRequestFailed(true);
    } finally {
      if (activeRequestKey.current === requestKey
          && scenarioInputIdentityRef.current === submittedInputIdentity) setSubmitting(false);
    }
  }

  return (
    <details className="wti-user-scenario" data-testid="wti-user-declared-scenario">
      <summary>Use your own transaction facts</summary>
      {supportsScenario && (
        <>
          <p className="wti-user-scenario__notice" role="note">
            {isInterest
              ? 'Enter interest you actually received in the selected fiscal year. This calculates incremental tax on that amount; it does not estimate a current rate or investment return.'
              : `This scenario is limited to Nippon India ETF Nifty 50 BeES (${NIFTYBEES_ID}). Enter your own transaction cost basis and sale consideration.`}
            {' '}Your entries are not verified market facts, do not change your recommendation, and do not grant permission to retrieve or display third-party data.
          </p>
          <form onSubmit={handleSubmit} className="wti-user-scenario__form">
            {isInterest ? (
              <label className="wti-user-scenario__field">
                Gross interest received in this fiscal year (₹)
                <input
                  type="number" min="0" max="1000000000" step="0.01" required
                  value={interestReceived} onChange={event => { setInterestReceived(event.target.value); activeRequestKey.current = null; setResult(null); setRequestFailed(false); setSubmitting(false); setTaxContextConfirmed(false); }}
                  aria-label="Gross interest received in this fiscal year"
                />
              </label>
            ) : (
              <>
                <label className="wti-user-scenario__field">
                  Tax cost basis, including eligible costs (₹)
                  <input type="number" min="0.01" max="1000000000" step="0.01" required
                    value={acquisitionCostBasis} onChange={event => { setAcquisitionCostBasis(event.target.value); activeRequestKey.current = null; setResult(null); setRequestFailed(false); setSubmitting(false); setTaxContextConfirmed(false); }} />
                </label>
                <label className="wti-user-scenario__field">
                  Sale consideration after eligible transfer costs (₹)
                  <input type="number" min="0" max="1000000000" step="0.01" required
                    value={saleProceeds} onChange={event => { setSaleProceeds(event.target.value); activeRequestKey.current = null; setResult(null); setRequestFailed(false); setSubmitting(false); setTaxContextConfirmed(false); }} />
                </label>
                <label className="wti-user-scenario__field">
                  Acquisition date
                  <input type="date" required value={acquisitionDate} onChange={event => { setAcquisitionDate(event.target.value); activeRequestKey.current = null; setResult(null); setRequestFailed(false); setSubmitting(false); setTaxContextConfirmed(false); }} />
                </label>
                <label className="wti-user-scenario__field">
                  Sale date
                  <input type="date" required value={redemptionDate} onChange={event => { setRedemptionDate(event.target.value); activeRequestKey.current = null; setResult(null); setRequestFailed(false); setSubmitting(false); setTaxContextConfirmed(false); }} />
                </label>
                <label className="wti-user-scenario__field">
                  Section 112A exclusion already used this fiscal year (₹)
                  <input type="number" min="0" max="125000" step="1" required
                    value={section112AExemptionUsed} onChange={event => { setSection112AExemptionUsed(event.target.value); activeRequestKey.current = null; setResult(null); setRequestFailed(false); setSubmitting(false); setTaxContextConfirmed(false); }} />
                  <small>Enter 0 if none; leave blank only while you do not yet know.</small>
                </label>
                <label className="wti-user-scenario__checkbox">
                  <input type="checkbox" checked={sttConfirmed} onChange={event => { setSttConfirmed(event.target.checked); activeRequestKey.current = null; setResult(null); setRequestFailed(false); setSubmitting(false); setTaxContextConfirmed(false); }} />
                  I assume the applicable STT condition is satisfied for this transfer. WealthGenie does not verify it.
                </label>
              </>
            )}

            <div className="wti-user-scenario__grid">
              <label className="wti-user-scenario__field">
                Annual tax income before this scenario (₹)
                <input type="number" min="0" max="1000000000" step="1" required
                  value={taxFacts.annualGrossIncome} onChange={event => updateTaxFact('annualGrossIncome', event.target.value)} />
              </label>
              <label className="wti-user-scenario__field">
                Income source
                <select required value={taxFacts.incomeSource} onChange={event => updateTaxFact('incomeSource', event.target.value)}>
                  <option value="">Choose one</option>
                  <option value="salary">Salary</option>
                  <option value="pension">Pension</option>
                  <option value="family_pension">Family pension</option>
                  <option value="business">Business</option>
                  <option value="other">Other</option>
                </select>
              </label>
              <label className="wti-user-scenario__field">
                Tax regime
                <span role="status">New regime only</span>
              </label>
              <label className="wti-user-scenario__field">
                Fiscal year
                <select required value={taxFacts.fiscalYear} onChange={event => { setTaxFacts(current => ({ ...current, fiscalYear: event.target.value, userAge: '' })); activeRequestKey.current = null; setResult(null); setRequestFailed(false); setSubmitting(false); setTaxContextConfirmed(false); }} disabled={verifiedFiscalYears.length === 0}>
                  <option value="">Choose a verified year</option>
                  {verifiedFiscalYears.map(year => <option key={year} value={year}>{year}</option>)}
                </select>
              </label>
              <div className="wti-user-scenario__field">
                <label htmlFor="scenario-user-age">Your age on March 31</label>
                <input id="scenario-user-age" type="number" min="18" max="120" step="1" required aria-describedby="scenario-user-age-help"
                  aria-invalid={taxFacts.userAge !== '' && !ageIsValid}
                  value={taxFacts.userAge} onChange={event => updateTaxFact('userAge', event.target.value)} />
                <small id="scenario-user-age-help">
                  {taxFacts.userAge !== '' && !ageIsValid
                    ? 'Enter a whole-number age from 18 to 120.'
                    : 'Enter your age as of March 31 for the selected fiscal year.'}
                </small>
              </div>
            </div>

            <details className="wti-user-scenario__deductions">
              <summary>Tax deductions (optional)</summary>
              <p>Enter only supported amounts that apply to your selected fiscal year. Blank fields are treated as no claim.</p>
              <div className="wti-user-scenario__grid">
                {DEDUCTION_FIELDS.map(([key, label]) => (
                  <label key={key} className="wti-user-scenario__field">
                    {label}
                    <input type="number" min="0" step="1" value={deductionValues[key] || ''}
                      onChange={event => updateDeduction(key, event.target.value)} />
                  </label>
                ))}
                {hasNpsEmployerContribution && <>
                  <label className="wti-user-scenario__field">
                    Basic salary used for employer NPS limit (₹)
                    <input type="number" min="0" step="1" required value={deductionValues.basicSalary || ''}
                      onChange={event => updateDeduction('basicSalary', event.target.value)} />
                  </label>
                  <label className="wti-user-scenario__field">
                    Employer type
                    <select required value={deductionValues.isGovtEmployee ?? ''}
                      onChange={event => updateDeduction('isGovtEmployee', event.target.value)}>
                      <option value="">Choose one</option>
                      <option value="true">Government</option>
                      <option value="false">Non-government</option>
                    </select>
                  </label>
                </>}
              </div>
            </details>

            <label className="wti-user-scenario__checkbox">
              <input type="checkbox" checked={taxContextConfirmed} onChange={event => setTaxContextConfirmed(event.target.checked)} required />
              I confirm these entered tax facts cover my scenario; blank deduction fields mean I have no claim for them.
            </label>
            {taxPolicyError && <p role="status">Verified tax-policy metadata is unavailable. No calculation can be requested.</p>}
            {requestFailed && <p role="alert">The scenario could not be calculated right now. Your entries were not saved.</p>}
            <button type="submit" className="wti-calc-tax-btn"
              disabled={submitting || Boolean(taxPolicyError) || verifiedFiscalYears.length === 0 || !taxContextConfirmed || !ageIsValid}>
              {submitting ? 'Calculating…' : 'Calculate my scenario'}
            </button>
          </form>

          {currentResult && (
            <div className={`wti-user-scenario__result${currentResult.status === 'CALCULATED' ? ' wti-user-scenario__result--ready' : ''}`} role="status" aria-live="polite">
              <strong>{currentResult.status === 'CALCULATED' ? 'User-declared scenario' : 'No tax result calculated'}</strong>
              {currentResult.status === 'CALCULATED' ? (
                <dl>
                  <div><dt>{isInterest ? 'Interest entered' : 'Realized gain before tax'}</dt><dd>{formatINR(currentResult.grossGain)}</dd></div>
                  <div><dt>Incremental tax</dt><dd>{formatINR(currentResult.incrementalTax)}</dd></div>
                  <div><dt>{isInterest ? 'Interest after tax' : 'Gain after tax'}</dt><dd>{formatINR(currentResult.netGain)}</dd></div>
                  {!isInterest && <div><dt>Holding period</dt><dd>{currentResult.holdingPeriod?.isLongTerm ? 'Long term' : 'Short term'}</dd></div>}
                </dl>
              ) : <p>{unavailableMessage(currentResult)}</p>}
              <small>{currentResult.disclosure}</small>
            </div>
          )}
        </>
      )}
      {!supportsScenario && (
        <p className="wti-user-scenario__notice" role="note">
          {canonicalInstrumentId === 'ppf' || canonicalInstrumentId === 'sukanya'
            ? 'This scheme needs qualified account eligibility and contribution or payment evidence before its conditional tax treatment can be calculated.'
            : `${instrumentName || 'This investment'} needs an exact product tax classification before user-entered values can produce a tax result.`}
        </p>
      )}
    </details>
  );
}
