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
const min = (a, b) => a < b ? a : b;
function parsePaise(s) {
  if (typeof s !== 'string' || !DECIMAL.test(s)) return null;
  const [whole, fractional = ''] = s.split('.');
  const value = BigInt(whole) * 100n + BigInt(fractional.padEnd(2, '0') || '0');
  return value <= MAX_PAISE ? value : null;
}
function toRupees(paise) {
  return paise === null || paise % 100n !== 0n ? null : paise / 100n;
}
function slabTax(income) {
  let from = 0n;
  let tax = 0n;
  for (const [to, rate] of [[400000n, 0n], [800000n, 5n], [1200000n, 10n],
    [1600000n, 15n], [2000000n, 20n], [2400000n, 25n], [income, 30n]]) {
    tax += (min(income, to) > from ? min(income, to) - from : 0n) * rate * 10n;
    from = to;
  }
  return tax;
}
function bound(response, request) {
  if (!response || response.taxYear !== YEAR || response.policyVersion !== POLICY
    || !response.inputsUsed || Object.keys(response.inputsUsed).length !== Object.keys(request).length
    || Object.keys(request).some(key => response.inputsUsed[key] !== request[key])) return false;
  if (response.status === 'UNAVAILABLE') {
    return response.finalTax === null && Array.isArray(response.unavailableReasons)
      && response.unavailableReasons.length > 0;
  }
  if (response.status !== 'CALCULATED' || response.calculationClass !== 'VERIFIED_RESIDENT_EQUITY_GAINS_ABOVE_REBATE_BELOW_SURCHARGE'
    || !Array.isArray(response.unavailableReasons) || response.unavailableReasons.length !== 0
    || request.residency !== 'resident' || !request.completeYearGainsConfirmed
    || !request.sttAndClassificationConfirmed || !request.noOtherTaxSituationsConfirmed
    || !AMOUNT.test(response.finalTax) || BigInt(response.finalTax) % 10n !== 0n) return false;
  const p = ['primaryIncome', 'otherOrdinaryIncome', 'stcg196', 'ltcg198'].map(k => parsePaise(request[k]));
  if (p.some(x => x === null || x % 1000n !== 0n)) return false;
  const [primary, other, stcg, ltcg] = p.map(toRupees);
  const deduction = request.incomeType === 'already_taxable' ? 0n : min(primary, 75000n);
  const ordinary = primary + other - deduction;
  const total = ordinary + stcg + ltcg;
  if (ordinary < 1300000n || total > 5000000n || stcg + ltcg === 0n) return false;
  for (const [key, expected] of [
    ['ordinaryTaxableIncome', ordinary], ['shortTermGains', stcg], ['longTermGains', ltcg],
    ['grossTotalIncome', total], ['standardDeduction', deduction],
    ['section198ExemptLongTermGain', min(ltcg, 125000n)],
  ]) if (!AMOUNT.test(response[key] || '') || BigInt(response[key]) !== expected) return false;
  for (const key of ['ordinarySlabTax', 'section196Tax', 'section198Tax', 'rebate',
    'surcharge', 'cess', 'taxBeforeStatutoryRounding']) if (!THREE.test(response[key] || '')) return false;
  const u = key => BigInt(response[key].replace('.', ''));
  const ordinaryTax = slabTax(ordinary);
  const shortTax = stcg * 200n;
  const longTax = (ltcg - min(ltcg, 125000n)) * 125n;
  const cess = (ordinaryTax + shortTax + longTax) * 4n / 100n;
  const beforeRounding = ordinaryTax + shortTax + longTax + cess;
  return u('ordinarySlabTax') === ordinaryTax && u('section196Tax') === shortTax
    && u('section198Tax') === longTax && u('rebate') === 0n && u('surcharge') === 0n
    && u('cess') === cess && u('taxBeforeStatutoryRounding') === beforeRounding
    && BigInt(response.finalTax) === ((beforeRounding / 1000n + 5n) / 10n) * 10n;
}
const money = s => /^\d+(?:\.\d{1,3})?$/.test(String(s))
  ? '₹' + Number(String(s).split('.')[0]).toLocaleString('en-IN') + (String(s).includes('.') ? '.' + s.split('.')[1] : '')
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
    const [primary, other, stcg, ltcg] = parts.map(toRupees);
    const ordinary = primary + other - (form.incomeType === 'already_taxable' ? 0n : min(primary, 75000n));
    if (ordinary < 1300000n || ordinary + stcg + ltcg > 5000000n || stcg + ltcg === 0n) {
      setError('This narrow verified path requires ordinary taxable income of at least ₹13 lakh, total income up to ₹50 lakh, and positive qualified equity gains. Complex rebate, basic-exemption, and surcharge cases require a full return.');
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
        <p role="alert">No tax figure can be verified for these circumstances: {result.unavailableReasons.join(', ')}</p>
      )}
      {result?.status === 'CALCULATED' && (
        <div className="wg-new-tax__result" role="status">
          <p>Verified restricted-scope tax liability for your declared figures</p>
          <strong className="wg-new-tax__amount">{money(result.finalTax)}</strong>
          <details open>
            <summary>Reconciliation and special-rate tax</summary>
            <table><tbody>
              {[
                ['Ordinary taxable income', 'ordinaryTaxableIncome'],
                ['Qualified STCG', 'shortTermGains'],
                ['Qualified LTCG before annual threshold', 'longTermGains'],
                ['LTCG threshold applied once per year', 'section198ExemptLongTermGain'],
                ['New-regime ordinary slab tax', 'ordinarySlabTax'],
                ['Section 196 tax (20%)', 'section196Tax'],
                ['Section 198 tax (12.5%)', 'section198Tax'],
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
