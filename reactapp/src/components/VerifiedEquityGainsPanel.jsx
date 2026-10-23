import React, { useEffect, useRef, useState } from 'react';
import api from '../services/api';

const POLICY = 'verified-capital-gains-TY2026-27-v1';
const YEAR = '2026-27';
const INITIAL = Object.freeze({
  taxYear: YEAR,
  residency: 'unknown',
  incomeType: '',
  primaryIncome: '',
  otherOrdinaryIncome: '',
  stcg196: '',
  ltcg198: '',
  completeYearGainsConfirmed: false,
  sttAndClassificationConfirmed: false,
  noOtherTaxSituationsConfirmed: false,
});
const DECIMAL = /^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,2})?$/;
const AMOUNT = /^\d+$/;
const THREE = /^\d+\.\d{3}$/;
const MAX_PAISE = 100000000000n;
const INTEGER_FIELDS = [
  'ordinaryTaxableIncome', 'shortTermGains', 'longTermGains', 'grossTotalIncome',
  'standardDeduction', 'section198ExemptLongTermGain',
];
const DECIMAL_FIELDS = [
  'ordinarySlabTax', 'section196Tax', 'section198Tax', 'rebate',
  'surcharge', 'cess', 'taxBeforeStatutoryRounding',
];
const UNAVAILABLE_COPY = Object.freeze({
  RESIDENT_INDIVIDUAL_ONLY: 'This limited calculation supports resident individuals only.',
  YEAR_WIDE_NET_GAINS_UNVERIFIED: 'Confirm all gains and eligible loss netting for the full tax year.',
  SPECIAL_RATE_ELIGIBILITY_UNVERIFIED: 'Confirm the capital-gains classifications and required tax conditions.',
  OTHER_TAX_FACTS_UNCONFIRMED: 'Other tax facts need review before a supported calculation is available.',
  NO_SPECIAL_RATE_GAINS: 'Enter positive qualifying equity capital gains for this calculation.',
  BASIC_EXEMPTION_OR_87A_REBATE_REQUIRES_FULL_RETURN: 'This income range requires a full tax return calculation.',
  SURCHARGE_REQUIRES_FULL_RETURN: 'This income range requires surcharge handling in a full tax return calculation.',
  INCOME_OVER_SUPPORTED_LIMIT: 'This income is outside the calculator’s supported range.',
});

function parsePaise(s) {
  if (typeof s !== 'string' || !DECIMAL.test(s)) return null;
  const [whole, fractional = ''] = s.split('.');
  const value = BigInt(whole) * 100n + BigInt(fractional.padEnd(2, '0') || '0');
  return value <= MAX_PAISE ? value : null;
}

function inputsMatch(responseInputs, request) {
  if (!responseInputs || typeof responseInputs !== 'object' || Array.isArray(responseInputs)) return false;
  const keys = Object.keys(request);
  return Object.keys(responseInputs).length === keys.length
    && keys.every(key => Object.hasOwn(responseInputs, key) && responseInputs[key] === request[key]);
}

function bound(response, request) {
  if (!response || typeof response !== 'object' || Array.isArray(response)
    || request.taxYear !== YEAR
    || response.taxYear !== YEAR || response.taxYear !== request.taxYear
    || response.policyVersion !== POLICY
    || !inputsMatch(response.inputsUsed, request)) return false;
  if (response.status === 'UNAVAILABLE') {
    return response.finalTax === null && Array.isArray(response.unavailableReasons)
      && response.unavailableReasons.length > 0
      && response.unavailableReasons.every(reason => typeof reason === 'string' && reason.length > 0);
  }
  if (response.status !== 'CALCULATED' || response.calculationClass !== 'VERIFIED_RESIDENT_EQUITY_GAINS_ABOVE_REBATE_BELOW_SURCHARGE'
    || !Array.isArray(response.unavailableReasons) || response.unavailableReasons.length !== 0
    || !AMOUNT.test(response.finalTax || '')
    || INTEGER_FIELDS.some(key => !AMOUNT.test(response[key] || ''))
    || DECIMAL_FIELDS.some(key => !THREE.test(response[key] || ''))) return false;
  return true;
}

function unavailableReasonText(code) {
  return Object.hasOwn(UNAVAILABLE_COPY, code)
    ? UNAVAILABLE_COPY[code]
    : 'This scenario is outside the calculator’s supported scope. No tax amount is shown.';
}
const money = s => /^\d+(?:\.\d{1,3})?$/.test(String(s))
  ? '₹' + BigInt(String(s).split('.')[0]).toLocaleString('en-IN') + (String(s).includes('.') ? '.' + s.split('.')[1] : '')
  : 'Unavailable';

export default function VerifiedEquityGainsPanel() {
  const [form, setForm] = useState(INITIAL);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  const abort = useRef(null);
  useEffect(() => () => { ++sequence.current; abort.current?.abort(); }, []);
  function change(key, value) {
    ++sequence.current;
    abort.current?.abort();
    setLoading(false);
    setError('');
    setResult(null);
    setForm(old => ({ ...old, [key]: value }));
  }
  async function calculate(event) {
    event.preventDefault();
    const parts = ['primaryIncome', 'otherOrdinaryIncome', 'stcg196', 'ltcg198'].map(k => parsePaise(form[k]));
    if (!['salary', 'pension', 'already_taxable'].includes(form.incomeType)
      || parts.some(x => x === null || x % 1000n !== 0n)) {
      setError('Select an income category and enter each amount in whole multiples of ₹10 (no negative values).');
      return;
    }
    if (form.residency !== 'resident' || !form.completeYearGainsConfirmed
      || !form.sttAndClassificationConfirmed || !form.noOtherTaxSituationsConfirmed) {
      setError('Resident status, annual gains, STT eligibility, and all confirmations are required. No financial amounts were submitted.');
      return;
    }
    ++sequence.current;
    const number = sequence.current;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const answer = await api.computeVerifiedComplexCapitalGainsTax({ ...form }, { signal: controller.signal });
      if (controller.signal.aborted || sequence.current !== number) return;
      if (!bound(answer, form)) throw new Error('Calculation failed financial reconciliation.');
      setResult(answer);
    } catch (reason) {
      if (controller.signal.aborted || sequence.current !== number) return;
      setError('No verified tax result: ' + (reason?.message || 'Check the inputs.'));
    } finally {
      if (sequence.current === number) setLoading(false);
    }
  }
  return (
    <section className="wg-new-tax" aria-label="Verified resident equity capital-gains tax">
      <h3>Equity capital gains — qualified calculation</h3>
      <p>New regime, Tax Year 2026–27. For resident individuals with pre-computed, net, whole-year
        Section 196 short-term and Section 198 long-term equity gains. This mode applies 20% short-term tax,
        12.5% on annual long-term gains above ₹1.25 lakh, and 4% cess, without a rebate or surcharge.</p>
      <p>Not a trade-level gains calculator. Validate purchase/sale dates, STT eligibility, cost basis,
        loss netting, grandfathering and the annual exemption BEFORE using the totals.
        Income below ₹13 lakh ordinary taxable or above ₹50 lakh total is not supported by this mode.</p>
      <form className="wg-new-tax__form" onSubmit={calculate} noValidate>
        <label htmlFor="wg-gains-type">Ordinary income category</label>
        <select id="wg-gains-type" value={form.incomeType} onChange={e => change('incomeType', e.target.value)}>
          <option value="">Choose an income category</option>
          <option value="salary">Gross taxable salary before ₹75,000 standard deduction, not CTC</option>
          <option value="pension">Own pension taxed under Salaries</option>
          <option value="already_taxable">Ordinary income already calculated as taxable</option>
        </select>
        {[
          ['primaryIncome', 'Primary ordinary annual income (₹)'],
          ['otherOrdinaryIncome', 'Additional ordinary taxable income, excluding gains and dividends (₹)'],
          ['stcg196', 'Net annual qualified STCG — Section 196 (₹)'],
          ['ltcg198', 'Net annual qualified LTCG — Section 198 BEFORE ₹1.25 lakh threshold (₹)'],
        ].map(([key, label]) => (
          <React.Fragment key={key}>
            <label htmlFor={'wg-gains-' + key}>{label}</label>
            <input id={'wg-gains-' + key} inputMode="decimal" type="text" maxLength={13}
              autoComplete="off" value={form[key]} onChange={e => change(key, e.target.value)}
              placeholder={key === 'primaryIncome' ? '1500000' : '0'} required />
          </React.Fragment>
        ))}
        <label htmlFor="wg-gains-residency">Residency for Tax Year 2026–27</label>
        <select id="wg-gains-residency" value={form.residency} onChange={e => change('residency', e.target.value)}>
          <option value="unknown">Not verified</option>
          <option value="resident">Resident individual in India</option>
          <option value="non_resident">Non-resident (not supported here)</option>
        </select>
        {[
          ['completeYearGainsConfirmed', 'I have included all Section 196/198 gains for this year, after correctly netting eligible current-year gains and losses.'],
          ['sttAndClassificationConfirmed', 'I verified capital-asset classification, transfer dates, STT conditions, acquisition costs and any required grandfathering.'],
          ['noOtherTaxSituationsConfirmed', 'No dividends, other capital gains, business adjustments, carried-forward losses, other deductions or special-rate income, agricultural rate integration, foreign income/credits, or other unmodelled provisions apply.'],
        ].map(([key, label]) => (
          <label className="wg-new-tax__confirm" key={key}>
            <input type="checkbox" checked={form[key]} onChange={e => change(key, e.target.checked)} />
            <span>{label}</span>
          </label>
        ))}
        <button type="submit" disabled={loading}>
          {loading ? 'Verifying equity gains…' : 'Calculate qualified equity-gains tax'}
        </button>
      </form>
      {error && <p role="alert" className="wg-new-tax__alert">{error}</p>}
      {result?.status === 'UNAVAILABLE' && (
        <div role="alert">
          <p>No tax figure can be verified for these circumstances.</p>
          <ul>{result.unavailableReasons.map((reason, index) => (
            <li key={`${reason}-${index}`}>{unavailableReasonText(reason)}</li>
          ))}</ul>
        </div>
      )}
      {result?.status === 'CALCULATED' && (
        <div className="wg-new-tax__result" role="status">
          <p>Verified restricted-scope tax liability for your declared figures</p>
          <strong className="wg-new-tax__amount">{money(result.finalTax)}</strong>
          <details open>
            <summary>Reconciliation and special-rate tax</summary>
            <table><tbody>
              {[
                ['Gross total income', 'grossTotalIncome'],
                ['Ordinary taxable income', 'ordinaryTaxableIncome'],
                ['Standard deduction', 'standardDeduction'],
                ['Qualified STCG', 'shortTermGains'],
                ['Qualified LTCG before annual threshold', 'longTermGains'],
                ['LTCG threshold applied once per year', 'section198ExemptLongTermGain'],
                ['New-regime ordinary slab tax', 'ordinarySlabTax'],
                ['Section 196 tax (20%)', 'section196Tax'],
                ['Section 198 tax (12.5%)', 'section198Tax'],
                ['Rebate', 'rebate'],
                ['Surcharge', 'surcharge'],
                ['Cess (4%)', 'cess'],
                ['Tax before rounding', 'taxBeforeStatutoryRounding'],
                ['Final liability rounded to ₹10', 'finalTax'],
              ].map(([title, key]) => <tr key={key}><th scope="row">{title}</th><td>{money(result[key])}</td></tr>)}
            </tbody></table>
          </details>
        </div>
      )}
      <p className="wg-new-tax__footnote">This is not an ITR, a transaction tax-lot engine or a refund/TDS calculator.
        No market API keys are required. Unsupported cases are blocked, not estimated.</p>
    </section>
  );
}
