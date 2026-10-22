import React, { useEffect, useRef, useState } from 'react';
import api from '../services/api';

const initial = {
  taxYear: '2026-27',
  incomeType: 'salary',
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
  ['Total gross ordinary income', 'grossOrdinaryIncome'],
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

const min = (a, b) => a < b ? a : b;
const max = (a, b) => a > b ? a : b;
const U = 10000n;

// Independent, read-only legal policy verification for displayed totals.
// This is a defensive browser check; the backend remains the calculation authority.
function slabTaxUnits(income) {
  let from = 0n;
  let tax = 0n;
  for (const [to, rate] of [[400000n, 0n], [800000n, 5n], [1200000n, 10n],
    [1600000n, 15n], [2000000n, 20n], [2400000n, 25n], [income, 30n]]) {
    if (min(income, to) > from) tax += (min(income, to) - from) * U * rate / 100n;
    from = to;
  }
  return tax;
}
function surchargePercent(income) {
  return income > 20000000n ? 25n : income > 10000000n ? 15n
    : income > 5000000n ? 10n : 0n;
}
function responseIsBound(data, request) {
  if (!data || typeof data !== 'object' || data.taxYear !== '2026-27'
      || data.policyVersion !== 'advanced-new-regime-TY2026-27-v1'
      || !['CALCULATED', 'UNAVAILABLE'].includes(data.status)
      || !data.inputsUsed || typeof data.inputsUsed !== 'object'
      || Object.keys(data.inputsUsed).length !== Object.keys(request).length
      || Object.keys(request).some(k => data.inputsUsed[k] !== request[k])) return false;
  if (data.status === 'UNAVAILABLE') return data.finalTax === null
    && Array.isArray(data.unavailableReasons) && data.unavailableReasons.length > 0;
  if (!request.confirmedNoOtherTaxAdjustments
      || !['resident', 'non_resident'].includes(request.residency)
      || !['salary', 'pension', 'already_taxable'].includes(request.incomeType)
      || !Array.isArray(data.unavailableReasons) || data.unavailableReasons.length !== 0
      || !/^\d+$/.test(data.finalTax) || BigInt(data.finalTax) % 10n !== 0n
      || !/^\d+$/.test(data.ordinaryTaxableIncome)
      || !/^\d+$/.test(data.specialIncomeTaxable)
      || !/^\d+$/.test(data.totalTaxableIncome)
      || fields.some(([, key]) => !(/^\d+$/.test(String(data[key])) || FOUR.test(String(data[key]))))
      || !Array.isArray(data.notes)) return false;
  const p = Object.fromEntries(
    ['primaryIncome', 'otherOrdinaryIncome', 'lotteryWinnings', 'housePropertyLoss',
      'employerNpsContribution', 'npsEligibleSalary'].map(k => [k, paise(request[k])])
  );
  if (Object.values(p).some(v => v === null || v > MAX_PAISE)) return false;
  const { primaryIncome: primary, otherOrdinaryIncome: other, lotteryWinnings: lottery,
    housePropertyLoss: loss, employerNpsContribution: nps, npsEligibleSalary: basic } = p;
  if (primary + other + lottery > MAX_PAISE) return false;
  if (nps > 0n && (request.incomeType !== 'salary'
      || !request.confirmedNpsIncludedInSalary || basic === 0n
      || basic > primary || nps > primary)) return false;
  if (nps === 0n && (basic !== 0n || request.confirmedNpsIncludedInSalary)) return false;
  const expectedStandard = request.incomeType === 'already_taxable' ? 0n : min(primary, 7500000n);
  const expectedNps = min(nps, basic * 14n / 100n);
  const taxablePaise = primary + other - expectedStandard - expectedNps;
  if (taxablePaise < 0n) return false;
  const ordinary = ((taxablePaise / 100n + 5n) / 10n) * 10n;
  const u = key => BigInt(String(data[key]).replace('.', ''));
  if (u('grossOrdinaryIncome') !== (primary + other) * 100n
      || u('standardDeduction') !== expectedStandard * 100n
      || u('employerNpsDeduction') !== expectedNps * 100n
      || u('excessNpsNotDeducted') !== (nps - expectedNps) * 100n
      || u('housePropertyLossNotSetOff') !== loss * 100n
      || BigInt(data.ordinaryTaxableIncome) !== ordinary
      || BigInt(data.specialIncomeTaxable) !== lottery / 100n
      || BigInt(data.totalTaxableIncome) !== ordinary + lottery / 100n) return false;
  // Mixed special-rate cases are limited to income strictly below the first
  // surcharge threshold and amounts for which component rounding is unambiguous.
  if (lottery > 0n && (taxablePaise % 1000n !== 0n
      || lottery % 1000n !== 0n || taxablePaise + lottery > 5000000n * 100n)) return false;

  const totalIncome = ordinary + lottery / 100n;
  const ordinaryTax = slabTaxUnits(ordinary);
  const specialTax = lottery * 30n;
  let rebate = 0n;
  if (request.residency === 'resident') {
    if (totalIncome <= 1200000n) rebate = min(ordinaryTax, 60000n * U);
    else rebate = min(ordinaryTax, max(0n,
      ordinaryTax + specialTax - (totalIncome - 1200000n) * U));
  }
  const afterRebate = ordinaryTax + specialTax - rebate;
  const surcharge = lottery > 0n ? 0n : afterRebate * surchargePercent(ordinary) / 100n;
  let relief = 0n;
  if (lottery === 0n && ordinary > 5000000n) {
    const threshold = ordinary > 20000000n ? 20000000n
      : ordinary > 10000000n ? 10000000n : 5000000n;
    const permitted = slabTaxUnits(threshold) * (100n + surchargePercent(threshold)) / 100n
      + (ordinary - threshold) * U;
    relief = max(0n, afterRebate + surcharge - permitted);
  }
  const cess = (afterRebate + surcharge - relief) * 4n / 100n;
  const finalBeforeRounding = afterRebate + surcharge - relief + cess;
  return u('ordinaryTaxBeforeRebate') === ordinaryTax
    && u('specialIncomeTax') === specialTax
    && u('rebate') === rebate
    && u('surcharge') === surcharge
    && u('surchargeMarginalRelief') === relief
    && u('cess') === cess
    && u('taxBeforeStatutoryRounding') === finalBeforeRounding
    && BigInt(data.finalTax) === ((finalBeforeRounding / U + 5n) / 10n) * 10n;
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
    const values = ['primaryIncome', 'otherOrdinaryIncome', 'employerNpsContribution',
      'npsEligibleSalary', 'lotteryWinnings', 'housePropertyLoss'].map(k => paise(form[k]));
    if (values.some(x => x === null) || values[0] + values[1] + values[4] > MAX_PAISE) {
      setError('Enter nonnegative amounts with at most two decimal places. Combined income maximum is ₹100 crore.');
      setResult(null);
      return;
    }
    const [primary, other, nps, eligibleSalary, lottery] = values;
    if (nps > 0n && (form.incomeType !== 'salary'
      || eligibleSalary === 0n || eligibleSalary > primary || nps > primary
      || !form.confirmedNpsIncludedInSalary)) {
      setError('Employer NPS requires salaried income, verified qualifying basic pay, DA and turnover-linked commission, and confirmation that employer NPS is already included in gross taxable salary. Nothing was submitted.');
      setResult(null);
      return;
    }
    if (nps === 0n && (eligibleSalary !== 0n || form.confirmedNpsIncludedInSalary)) {
      setError('With no employer NPS contribution, leave eligible NPS salary at 0 and the related confirmation unchecked. Nothing was submitted.');
      setResult(null);
      return;
    }
    // Reject unsupported mixed-income rounding and surcharge BEFORE sending.
    const standard = form.incomeType === 'already_taxable' ? 0n : min(primary, 7500000n);
    const eligibleNps = min(nps, eligibleSalary * 14n / 100n);
    const ordinaryPaise = primary + other - standard - eligibleNps;
    if (lottery > 0n && (ordinaryPaise < 0n || ordinaryPaise % 1000n !== 0n
      || lottery % 1000n !== 0n || ordinaryPaise + lottery > 500000000n)) {
      setError('Mixed special-rate cases with surcharge, ambiguous rounding or an unqualified deduction need a full tax return. No income was submitted.');
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
      if (!responseIsBound(r, form)) throw new Error('Server calculation failed input binding or financial reconciliation.');
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
        and non-online lottery/game winnings. Ordinary-only calculations also cover surcharge above ₹50 lakh.
        Other capital gains and carry-forward losses require separate verification.</p>
      <form className="wg-new-tax__form" onSubmit={submit}>
        <label htmlFor="wga-type">Ordinary income category</label>
        <select id="wga-type" value={form.incomeType} onChange={e => set('incomeType', e.target.value)}>
          <option value="salary">Gross taxable salary including employer NPS contribution (not CTC)</option>
          <option value="pension">Own pension taxed as salary</option>
          <option value="already_taxable">Already-computed ordinary taxable income (no salary deduction)</option>
        </select>
        <label htmlFor="wga-primary">Primary annual income (₹)</label>
        <input id="wga-primary" type="text" inputMode="decimal" maxLength={13} value={form.primaryIncome}
          onChange={e => set('primaryIncome', e.target.value)} required />
        <label htmlFor="wga-other">Additional ordinary taxable income (₹; exclude dividends and gains)</label>
        <input id="wga-other" type="text" inputMode="decimal" maxLength={13} value={form.otherOrdinaryIncome}
          onChange={e => set('otherOrdinaryIncome', e.target.value)} required />
        <label htmlFor="wga-nps">Employer contribution to notified NPS already included in gross salary (₹)</label>
        <input id="wga-nps" type="text" inputMode="decimal" maxLength={13} value={form.employerNpsContribution}
          onChange={e => set('employerNpsContribution', e.target.value)} required />
        <label htmlFor="wga-nps-base">NPS eligible basic salary + qualifying DA + eligible turnover-linked commission (not CTC) (₹)</label>
        <input id="wga-nps-base" type="text" inputMode="decimal" maxLength={13} value={form.npsEligibleSalary}
          onChange={e => set('npsEligibleSalary', e.target.value)} required />
        <label className="wg-new-tax__confirm">
          <input type="checkbox" checked={form.confirmedNpsIncludedInSalary}
            onChange={e => set('confirmedNpsIncludedInSalary', e.target.checked)} />
          <span>Employer NPS is included in the declared taxable gross salary; the salary basis includes basic pay, qualifying DA, and eligible commission as a fixed percentage of turnover only.
            Leave unchecked with both NPS fields at zero if not applicable.</span>
        </label>
        <label htmlFor="wga-special">Gross non-online lottery / game winnings BEFORE any TDS, taxable at 30% (₹)</label>
        <input id="wga-special" type="text" inputMode="decimal" maxLength={13} value={form.lotteryWinnings}
          onChange={e => set('lotteryWinnings', e.target.value)} required />
        <label htmlFor="wga-property">Already-computed net house-property LOSS only, not offset under new regime (₹)</label>
        <input id="wga-property" type="text" inputMode="decimal" maxLength={13} value={form.housePropertyLoss}
          onChange={e => set('housePropertyLoss', e.target.value)} required />
        <p className="wg-new-tax__hint">Lottery winnings must be the gross taxable amount before TDS, not take-home cash.\n          Positive taxable house-property income, if any, belongs in additional ordinary income;\n          the separate loss field is for an independently computed net loss that cannot be offset against salary or other heads.\n          No loss carry-forward or TDS refund is calculated here.</p>
        <label htmlFor="wga-residency">Residency in India during Tax Year 2026–27</label>
        <select id="wga-residency" value={form.residency} onChange={e => set('residency', e.target.value)}>
          <option value="unknown">Not sure (cannot calculate)</option>
          <option value="resident">Resident individual</option>
          <option value="non_resident">Non-resident individual</option>
        </select>
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
        <p role="alert">No tax payable shown. The entered combination requires a full return calculation:
          {' '}{result.unavailableReasons.join(', ')}</p>
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
