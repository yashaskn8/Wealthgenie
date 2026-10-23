import React, { useEffect, useRef, useState } from 'react';
import api from '../services/api';

const initial = {
  taxYear: '2026-27',
  incomeType: '',
  primaryIncome: '',
  otherOrdinaryIncome: '0',
  residency: 'unknown',
  employerNpsContribution: '0',
  npsEligibleSalary: '0',
  lotteryWinnings: '0',
  housePropertyLoss: '0',
  confirmedNpsIncludedInSalary: false,
  confirmedNoOtherTaxAdjustments: false,
};
const DECIMAL = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/;
const FOUR = /^\d+\.\d{4}$/;
const MAX_PAISE = 100000000000n;
const paise = s => {
  if (typeof s !== 'string' || !DECIMAL.test(s)) return null;
  const [rupees, fract = ''] = s.split('.');
  return BigInt(rupees) * 100n + BigInt(fract.padEnd(2, '0') || '0');
};
const amount = s => {
  if (!/^\d+(?:\.\d{1,4})?$/.test(String(s))) return 'Unavailable';
  const [integer, fraction = ''] = String(s).split('.');
  return '₹' + BigInt(integer).toLocaleString('en-IN') + (fraction.replace(/0+$/, '') ? '.' + fraction.replace(/0+$/, '') : '');
};
const fields = [
  ['Total primary and additional ordinary income entered', 'grossOrdinaryIncome'],
  ['Salary standard deduction', 'standardDeduction'],
  ['Allowed employer NPS deduction', 'employerNpsDeduction'],
  ['Employer NPS not eligible for deduction', 'excessNpsNotDeducted'],
  ['House-property loss NOT offset', 'housePropertyLossNotSetOff'],
  ['Ordinary taxable income', 'ordinaryTaxableIncome'],
  ['Special winnings taxable', 'specialIncomeTaxable'],
  ['Ordinary tax before rebate', 'ordinaryTaxBeforeRebate'],
  ['30% tax on eligible winnings', 'specialIncomeTax'],
  ['Section 156 rebate', 'rebate'],
  ['Surcharge', 'surcharge'],
  ['Surcharge marginal relief', 'surchargeMarginalRelief'],
  ['4% health and education cess', 'cess'],
  ['Tax before statutory rounding', 'taxBeforeStatutoryRounding'],
];
const integerOutputFields = ['ordinaryTaxableIncome', 'specialIncomeTaxable', 'totalTaxableIncome'];
const decimalOutputFields = fields.map(([, key]) => key).filter(key => !integerOutputFields.includes(key));

const unavailableReasonMessages = Object.freeze({
  RESIDENCY_UNKNOWN: 'Confirm your residential status before calculating tax.',
  RETURN_CONTEXT_UNCONFIRMED: 'Confirm the limited tax assumptions before calculating.',
  NPS_14_PERCENT_CAP_REQUIRES_SUB_PAISE_PRECISION: 'The employer NPS limit for these figures falls between paise. A full tax return calculation is needed.',
  NPS_DEDUCTION_EXCEEDS_QUALIFIED_ORDINARY_INCOME: 'The eligible employer NPS deduction exceeds the ordinary income supported by this calculator. A full tax return calculation is needed.',
  MIXED_SPECIAL_RATE_SURCHARGE_NEEDS_FULL_RETURN: 'This combination of lottery or game winnings and other income needs surcharge rules not covered by this calculator.',
  MIXED_INCOME_COMPONENT_ROUNDING_NEEDS_FULL_RETURN: 'These ordinary-income and winnings amounts do not meet the calculator’s supported ₹10 rounding requirements.',
});

function describeUnavailableReason(reason) {
  return Object.hasOwn(unavailableReasonMessages, reason)
    ? unavailableReasonMessages[reason]
    : 'This scenario is outside the calculator’s verified scope. A full tax return calculation is needed.';
}

function responseIsBound(data, request) {
  if (!data || typeof data !== 'object' || data.taxYear !== '2026-27'
      || data.policyVersion !== 'advanced-new-regime-TY2026-27-v1'
      || !['CALCULATED', 'UNAVAILABLE'].includes(data.status)
      || !data.inputsUsed || typeof data.inputsUsed !== 'object' || Array.isArray(data.inputsUsed)
      || Object.keys(data.inputsUsed).length !== Object.keys(request).length
      || Object.keys(request).some(k => data.inputsUsed[k] !== request[k])) return false;
  if (data.status === 'UNAVAILABLE') return data.finalTax === null
    && Array.isArray(data.unavailableReasons) && data.unavailableReasons.length > 0
    && data.unavailableReasons.every(reason => typeof reason === 'string')
    && data.calculationClass === 'ADVANCED_QUALIFIED_INCOME_ONLY';
  if (!request.confirmedNoOtherTaxAdjustments
      || !['resident', 'non_resident'].includes(request.residency)
      || !['salary', 'pension', 'already_taxable'].includes(request.incomeType)
      || data.calculationClass !== 'ADVANCED_QUALIFIED_INCOME_ONLY'
      || !Array.isArray(data.unavailableReasons) || data.unavailableReasons.length !== 0
      || typeof data.finalTax !== 'string' || !/^\d+$/.test(data.finalTax)
      || integerOutputFields.some(key => typeof data[key] !== 'string' || !/^\d+$/.test(data[key]))
      || decimalOutputFields.some(key => typeof data[key] !== 'string' || !FOUR.test(data[key]))
      || !Array.isArray(data.notes) || !data.notes.every(note => typeof note === 'string')) return false;
  return true;
}

export default function AdvancedNewRegimeTaxPanel() {
  const [form, setForm] = useState(initial);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const abort = useRef(null);
  useEffect(() => () => { seq.current += 1; abort.current?.abort(); }, []);
  function set(field, value) {
    seq.current += 1;
    abort.current?.abort();
    setLoading(false);
    setResult(null);
    setError('');
    setForm(old => ({ ...old, [field]: value }));
  }
  async function submit(e) {
    e.preventDefault();
    if (!['salary', 'pension', 'already_taxable'].includes(form.incomeType)) {
      setError('Choose an income category before calculating. No income figures were submitted.');
      setResult(null);
      return;
    }
    const values = ['primaryIncome', 'otherOrdinaryIncome', 'employerNpsContribution',
      'npsEligibleSalary', 'lotteryWinnings', 'housePropertyLoss'].map(k => paise(form[k]));
    if (values.some(x => x === null || x > MAX_PAISE)) {
      setError('Enter nonnegative amounts with at most two decimal places. Each amount must be at most ₹100 crore.');
      setResult(null);
      return;
    }
    if (values[2] > 0n && !form.confirmedNpsIncludedInSalary) {
      setError('Confirm employer NPS is included in declared taxable gross salary before calculating. No income figures were submitted.');
      setResult(null);
      return;
    }
    // Never transmit income figures while residence or tax context is unverified.
    if (form.residency === 'unknown' || !form.confirmedNoOtherTaxAdjustments) {
      setError('Confirm residency and the restricted tax context before calculating. No income figures were submitted.');
      setResult(null);
      return;
    }
    abort.current?.abort();
    const mySeq = ++seq.current;
    const controller = new AbortController();
    abort.current = controller;
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const r = await api.computeAdvancedNewRegimeTax({ ...form }, { signal: controller.signal });
      if (controller.signal.aborted || seq.current !== mySeq) return;
      if (!responseIsBound(r, form)) throw new Error('Server calculation failed input binding or response validation.');
      setResult(r);
    } catch (err) {
      if (controller.signal.aborted || seq.current !== mySeq) return;
      setResult(null);
      setError('Unable to calculate safely. ' + (err.message || 'Please check the entered facts.'));
    } finally {
      if (seq.current === mySeq) setLoading(false);
    }
  }
  return (
    <section className="wg-new-tax" aria-label="Advanced qualified income tax scenarios">
      <h3>Additional verified tax situations</h3>
      <p>Supports qualifying employer NPS, net house-property losses that CANNOT offset other income,
        and non-online lottery/game winnings. The server determines whether the entered combination
        is supported; other capital gains and carry-forward losses require separate verification.</p>
      <form className="wg-new-tax__form" onSubmit={submit}>
        <div className="wg-new-tax__fields-grid">
          <div className="wg-new-tax__field">
            <label htmlFor="wga-type">Ordinary income category</label>
            <select id="wga-type" value={form.incomeType} onChange={e => set('incomeType', e.target.value)}>
              <option value="">Choose an income category</option>
              <option value="salary">Gross taxable salary including employer NPS contribution (not CTC)</option>
              <option value="pension">Own pension taxed as salary</option>
              <option value="already_taxable">Already-computed ordinary taxable income (no salary deduction)</option>
            </select>
          </div>
          <div className="wg-new-tax__field">
            <label htmlFor="wga-residency">Residency in India during Tax Year 2026–27</label>
            <select id="wga-residency" value={form.residency} onChange={e => set('residency', e.target.value)}>
              <option value="unknown">Not sure (cannot calculate)</option>
              <option value="resident">Resident individual</option>
              <option value="non_resident">Non-resident individual</option>
            </select>
          </div>
          <div className="wg-new-tax__field">
            <label htmlFor="wga-primary">Primary annual income (₹)</label>
            <input id="wga-primary" type="text" inputMode="decimal" maxLength={13} value={form.primaryIncome}
              onChange={e => set('primaryIncome', e.target.value)} required />
          </div>
          <div className="wg-new-tax__field">
            <label htmlFor="wga-other">Additional ordinary taxable income (₹; exclude dividends and gains)</label>
            <input id="wga-other" type="text" inputMode="decimal" maxLength={13} value={form.otherOrdinaryIncome}
              onChange={e => set('otherOrdinaryIncome', e.target.value)} required />
          </div>
          <div className="wg-new-tax__field">
            <label htmlFor="wga-nps">Employer contribution to notified NPS already included in gross salary (₹)</label>
            <input id="wga-nps" type="text" inputMode="decimal" maxLength={13} value={form.employerNpsContribution}
              onChange={e => set('employerNpsContribution', e.target.value)} required />
          </div>
          <div className="wg-new-tax__field">
            <label htmlFor="wga-nps-base">NPS eligible basic salary + qualifying DA + eligible turnover-linked commission (not CTC) (₹)</label>
            <input id="wga-nps-base" type="text" inputMode="decimal" maxLength={13} value={form.npsEligibleSalary}
              onChange={e => set('npsEligibleSalary', e.target.value)} required />
          </div>
        </div>
        <label className="wg-new-tax__confirm">
          <input type="checkbox" checked={form.confirmedNpsIncludedInSalary}
            onChange={e => set('confirmedNpsIncludedInSalary', e.target.checked)} />
          <span>Employer NPS is included in the declared taxable gross salary; the salary basis includes basic pay, qualifying DA, and eligible commission as a fixed percentage of turnover only.
            Leave unchecked with both NPS fields at zero if not applicable.</span>
        </label>
        <div className="wg-new-tax__fields-grid">
          <div className="wg-new-tax__field">
            <label htmlFor="wga-special">Gross non-online lottery / game winnings BEFORE any TDS, taxable at 30% (₹)</label>
            <input id="wga-special" type="text" inputMode="decimal" maxLength={13} value={form.lotteryWinnings}
              onChange={e => set('lotteryWinnings', e.target.value)} required />
          </div>
          <div className="wg-new-tax__field">
            <label htmlFor="wga-property">Already-computed net house-property LOSS only, not offset under new regime (₹)</label>
            <input id="wga-property" type="text" inputMode="decimal" maxLength={13} value={form.housePropertyLoss}
              onChange={e => set('housePropertyLoss', e.target.value)} required />
          </div>
        </div>
        <p className="wg-new-tax__hint">Lottery winnings must be the gross taxable amount before TDS, not take-home cash.
          Positive taxable house-property income, if any, belongs in additional ordinary income;
          the separate loss field is for an independently computed net loss that cannot be offset against salary or other heads.
          No loss carry-forward or TDS refund is calculated here.</p>
        <label className="wg-new-tax__confirm">
          <input type="checkbox" checked={form.confirmedNoOtherTaxAdjustments}
            onChange={e => set('confirmedNoOtherTaxAdjustments', e.target.checked)} />
          <span>I confirm this tax context excludes ALL dividends (ordinary-rate dividends can trigger a separate surcharge cap), other special-rate income,
            capital gains or loss schedules, other deductions, business income/loss, carried-forward losses,
            foreign income, agricultural-income rate integration, and other unmodelled adjustments.
            These figures are a restricted estimate, not a complete ITR.</span>
        </label>
        <button type="submit" disabled={loading}>{loading ? 'Verifying advanced tax…' : 'Calculate advanced tax case'}</button>
      </form>
      {error && <p role="alert">{error}</p>}
      {result?.status === 'UNAVAILABLE' && (
        <div role="status">
          <p>No tax figure is available. This combination needs a full tax return calculation:</p>
          <ul>{result.unavailableReasons.map((reason, index) => (
            <li key={`${reason}-${index}`}>{describeUnavailableReason(reason)}</li>
          ))}</ul>
        </div>
      )}
      {result?.status === 'CALCULATED' && (
        <div className="wg-new-tax__result" role="status">
          <p>Tax for the specifically declared and qualified scenario</p>
          <strong className="wg-new-tax__amount">{amount(result.finalTax)}</strong>
          <details open>
            <summary>Calculation ledger and restrictions</summary>
            <table><tbody>
              {fields.map(([label, key]) => (
                <tr key={key}><th scope="row">{label}</th><td>{amount(result[key])}</td></tr>
              ))}
              <tr><th scope="row">Final tax after rounding</th><td><strong>{amount(result.finalTax)}</strong></td></tr>
            </tbody></table>
            {result.notes.map(note => <p key={note}>{note}</p>)}
          </details>
        </div>
      )}
      <p>Source provisions: <a href="https://www.incometaxindia.gov.in/w/section-124-94" target="_blank" rel="noopener noreferrer">Section 124 — employer NPS</a>
        {' · '}<a href="https://www.incometaxindia.gov.in/w/section-194-78" target="_blank" rel="noopener noreferrer">Section 194 — certain winnings</a>
        {' · '}<a href="https://www.incometaxindia.gov.in/w/section-202-78" target="_blank" rel="noopener noreferrer">Section 202 — new regime and loss restriction</a></p>
    </section>
  );
}
