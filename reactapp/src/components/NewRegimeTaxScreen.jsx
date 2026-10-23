import React, { useEffect, useRef, useState } from 'react';
import api from '../services/api';
import AdvancedNewRegimeTaxPanel from './AdvancedNewRegimeTaxPanel';
import VerifiedEquityGainsPanel from './VerifiedEquityGainsPanel';
import './NewRegimeTaxScreen.css';

const TAX_YEAR = '2026-27';
const POLICY_VERSION = 'verified-simple-new-regime-TY2026-27-v1';
const MONEY = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/;
function asPaise(value) {
  if (!MONEY.test(value)) return null;
  const [rupees, decimal = ''] = value.split('.');
  return BigInt(rupees) * 100n + BigInt(decimal.padEnd(2, '0') || '0');
}
const INITIAL = Object.freeze({
  taxYear: TAX_YEAR,
  incomeType: '',
  primaryIncome: '',
  otherOrdinaryIncome: '',
  residency: 'unknown',
  specialRateIncome: 'unknown',
  confirmedOrdinaryOnly: false,
});

function money(value) {
  if (value === null || value === undefined || !/^\d+(?:\.\d{1,4})?$/.test(String(value))) return 'Unavailable';
  const [integer, fraction = ''] = String(value).split('.');
  const cleanFraction = fraction.replace(/0+$/, '');
  return '₹' + BigInt(integer).toLocaleString('en-IN') + (cleanFraction ? '.' + cleanFraction : '');
}
const FOUR_DECIMAL_AMOUNT = /^\d+\.\d{4}$/;

function inputsMatch(resultInputs, request) {
  if (!resultInputs || typeof resultInputs !== 'object' || Array.isArray(resultInputs)) return false;
  const keys = Object.keys(request);
  return Object.keys(resultInputs).length === keys.length
    && keys.every(key => Object.hasOwn(resultInputs, key) && resultInputs[key] === request[key]);
}

function hasCalculationShape(result) {
  const amounts = [
    'grossPrimaryIncome', 'otherOrdinaryIncome', 'standardDeduction',
    'taxableIncomeBeforeRounding', 'taxBeforeRebate', 'rebate',
    'taxAfterRebate', 'surcharge', 'surchargeMarginalRelief',
    'cess', 'taxBeforeStatutoryRounding',
  ];
  return result.calculationClass === 'SIMPLE_ORDINARY_INCOME_ONLY'
    && /^\d+$/.test(result.finalTax)
    && /^\d+$/.test(result.taxableIncome)
    && amounts.every(key => typeof result[key] === 'string' && FOUR_DECIMAL_AMOUNT.test(result[key]))
    && Array.isArray(result.slabBreakdown)
    && result.slabBreakdown.every(row => row && typeof row === 'object' && !Array.isArray(row)
      && /^\d+$/.test(row.from)
      && (row.to === null || /^\d+$/.test(row.to))
      && Number.isInteger(row.percent) && row.percent >= 0 && row.percent <= 100
      && /^\d+$/.test(row.taxableInSlab)
      && typeof row.tax === 'string' && FOUR_DECIMAL_AMOUNT.test(row.tax));
}

function responseIsBound(result, request) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
      || request.taxYear !== TAX_YEAR
      || result.taxYear !== TAX_YEAR || result.policyVersion !== POLICY_VERSION
      || !['CALCULATED', 'UNAVAILABLE'].includes(result.status)
      || !inputsMatch(result.inputsUsed, request)) return false;
  if (result.status === 'CALCULATED') {
    // Keep unsupported contexts closed if the backend ever returns a numeric
    // result contrary to the request contract. Tax calculations stay server-side.
    if (!request.confirmedOrdinaryOnly || request.specialRateIncome !== 'no'
        || !['resident', 'non_resident'].includes(request.residency)
        || !['salary', 'pension', 'already_taxable'].includes(request.incomeType)
        || !Array.isArray(result.unavailableReasons)
        || result.unavailableReasons.length !== 0 || !hasCalculationShape(result)) return false;
    return true;
  }
  return result.finalTax === null
    && Array.isArray(result.unavailableReasons)
    && result.unavailableReasons.length > 0
    && result.unavailableReasons.every(reason => typeof reason === 'string' && reason.length > 0);
}

const ROWS = [
  ['Primary income', 'grossPrimaryIncome'],
  ['Other ordinary taxable income', 'otherOrdinaryIncome'],
  ['Standard deduction', 'standardDeduction'],
  ['Taxable income before statutory rounding', 'taxableIncomeBeforeRounding'],
  ['Taxable income after rounding', 'taxableIncome'],
  ['Tax calculated on slabs', 'taxBeforeRebate'],
  ['Resident individual rebate / rebate marginal relief', 'rebate'],
  ['Surcharge', 'surcharge'],
  ['Surcharge marginal relief', 'surchargeMarginalRelief'],
  ['Health and education cess (4%)', 'cess'],
  ['Liability before statutory rounding', 'taxBeforeStatutoryRounding'],
];

export default function NewRegimeTaxScreen() {
  const [form, setForm] = useState(INITIAL);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const abortRef = useRef(null);
  const sequenceRef = useRef(0);
  useEffect(() => () => { abortRef.current?.abort(); sequenceRef.current += 1; }, []);
  function change(field, value) {
    sequenceRef.current += 1;
    abortRef.current?.abort();
    setLoading(false);
    setResult(null);
    setError('');
    setForm(current => ({ ...current, [field]: value }));
  }
  async function calculate(event) {
    event.preventDefault();
    const request = { ...form };
    const primaryPaise = asPaise(request.primaryIncome);
    const additionalPaise = asPaise(request.otherOrdinaryIncome);
    const valid = ['salary', 'pension', 'already_taxable'].includes(request.incomeType)
      && primaryPaise !== null && additionalPaise !== null
      && primaryPaise + additionalPaise <= 100_000_000_000n;
    if (!valid) {
      setResult(null);
      setError('Choose an income category and enter both non-negative rupee amounts (enter 0 if none; maximum two decimal places; combined maximum ₹100 crore).');
      return;
    }
    // Refuse unsupported contexts before disclosing entered financial figures
    // to the API. The server independently enforces exactly the same gate.
    if (request.residency === 'unknown' || request.specialRateIncome !== 'no'
        || !request.confirmedOrdinaryOnly) {
      setResult(null);
      setError('Cannot calculate this simplified return. Confirm your residential status, that you have no special-rate income or dividends, and that no unmodelled tax adjustments apply. No income figures were submitted.');
      return;
    }
    sequenceRef.current += 1;
    const sequence = sequenceRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const answer = await api.computeVerifiedNewRegimeTax(request, { signal: controller.signal });
      if (sequence !== sequenceRef.current || controller.signal.aborted) return;
      if (!responseIsBound(answer, request)) {
        throw new Error('The tax service returned an unverified or mismatched calculation.');
      }
      setResult(answer);
    } catch (err) {
      if (sequence !== sequenceRef.current || controller.signal.aborted) return;
      setResult(null);
      setError('Calculation unavailable. ' + (err?.message || 'The tax service could not verify this result.'));
    } finally {
      if (sequence === sequenceRef.current) setLoading(false);
    }
  }
  return (
    <section className="wg-new-tax" aria-label="New regime income-tax calculator">
      <header className="wg-new-tax__header">
        <p className="wg-new-tax__eyebrow">NEW TAX REGIME · INCOME-TAX ACT, 2025</p>
        <h2>Income Tax Calculator</h2>
        <p>Tax Year 2026–27 (1 April 2026–31 March 2027). For eligible resident individuals,
          ordinary taxable income up to ₹12 lakh has no tax after the rebate. Salary taxed under the
          salaries head may qualify for a ₹75,000 standard deduction.</p>
      </header>
      <form onSubmit={calculate} className="wg-new-tax__form" noValidate>
        <label htmlFor="wg-tax-income-type">Income category</label>
        <select id="wg-tax-income-type" value={form.incomeType} onChange={e => change('incomeType', e.target.value)} required>
          <option value="">Choose explicitly — no income category assumed</option>
          <option value="salary">Taxable gross salary (not CTC)</option>
          <option value="pension">Own retirement pension taxed under Salaries</option>
          <option value="already_taxable">Ordinary income already calculated as taxable</option>
        </select>
        <label htmlFor="wg-tax-income">{
          form.incomeType === 'already_taxable' ? 'Ordinary taxable income (₹)' : 'Annual taxable gross salary / pension before standard deduction (₹)'
        }</label>
        <input id="wg-tax-income" inputMode="decimal" type="text" autoComplete="off"
          placeholder="e.g. 1275000.00" value={form.primaryIncome}
          onChange={e => change('primaryIncome', e.target.value)} required maxLength={13} />
        <label htmlFor="wg-tax-other">Additional ordinary-rate taxable income (₹)</label>
        <input id="wg-tax-other" inputMode="decimal" type="text" autoComplete="off"
          value={form.otherOrdinaryIncome} onChange={e => change('otherOrdinaryIncome', e.target.value)}
          maxLength={13} required />
        <p className="wg-new-tax__hint">Enter 0 if you have no additional ordinary income. Include taxable bank interest and similar ordinary-rate income. Do not enter CTC, investment principal, exempt income or capital gains. IMPORTANT: For salary/pension, enter the amount BEFORE the ₹75,000 standard deduction. If your figure ALREADY has that deduction taken out (for example, an income-after-deductions figure), select “Ordinary income already calculated as taxable” instead; otherwise the deduction would be counted twice. If that figure includes all ordinary taxable income, enter 0 for additional income so it is not counted twice.</p>
        <label htmlFor="wg-tax-residency">Residential status for Tax Year 2026–27</label>
        <select id="wg-tax-residency" value={form.residency} onChange={e => change('residency', e.target.value)}>
          <option value="unknown">Not sure (cannot calculate)</option>
          <option value="resident">Resident individual in India</option>
          <option value="non_resident">Non-resident individual</option>
        </select>
        <label htmlFor="wg-tax-special">Any special-rate income or dividends (which may have different surcharge rules)?</label>
        <select id="wg-tax-special" value={form.specialRateIncome} onChange={e => change('specialRateIncome', e.target.value)}>
          <option value="unknown">Not sure (cannot calculate)</option>
          <option value="yes">Yes (requires a full tax computation)</option>
          <option value="no">No</option>
        </select>
        <label className="wg-new-tax__confirm">
          <input type="checkbox" checked={form.confirmedOrdinaryOnly}
            onChange={e => change('confirmedOrdinaryOnly', e.target.checked)} />
          <span>I confirm this is a single-individual, ordinary-rate-income estimate for Tax Year 2026–27,
            with no unmodelled exemptions, deductions, business adjustments, brought-forward losses,
            foreign income or tax credits, salary arrears requiring special relief, or agricultural income
            requiring rate integration. I understand that capital gains, dividends and other special-rate
            income need a full tax computation.</span>
        </label>
        <button type="submit" disabled={loading}>{loading ? 'Verifying calculation…' : 'Calculate income tax'}</button>
      </form>
      {error && <p role="alert" className="wg-new-tax__alert">{error}</p>}
      {result?.status === 'UNAVAILABLE' && (
        <p role="status" className="wg-new-tax__alert">
          No tax figure shown: this simplified calculator cannot safely handle
          the selected residency, special-rate income or unconfirmed adjustments.
          Consult a qualified tax professional for a full return computation.
        </p>
      )}
      {result?.status === 'CALCULATED' && (
        <div className="wg-new-tax__result" role="status">
          <p>Estimated tax liability under the new regime (for the declared, limited circumstances)</p>
          <strong className="wg-new-tax__amount">{money(result.finalTax)}</strong>
          <p>Tax Year {result.taxYear} · Rounded under Section 516 · {result.policyVersion}</p>
          <details open>
            <summary>Exact calculation and reconciliation</summary>
            <table>
              <tbody>
                {ROWS.map(([label, key]) => (
                  <tr key={key}><th scope="row">{label}</th><td>{money(result[key])}</td></tr>
                ))}
                <tr><th scope="row">Final tax after statutory rounding</th><td><strong>{money(result.finalTax)}</strong></td></tr>
              </tbody>
            </table>
          </details>
          <details>
            <summary>Tax slab details</summary>
            <table>
              <thead><tr><th scope="col">Income range</th><th scope="col">Rate</th><th scope="col">Tax</th></tr></thead>
              <tbody>{result.slabBreakdown.map((slab, i) => (
                <tr key={i}>
                  <td>{money(slab.from)} to {slab.to === null ? 'above' : money(slab.to)}</td>
                  <td>{slab.percent}%</td><td>{money(slab.tax)}</td>
                </tr>
              ))}</tbody>
            </table>
          </details>
        </div>
      )}
      <p className="wg-new-tax__footnote">Scope: individual, ordinary-rate income, selected tax year only.
        This is not an ITR, TDS, advance-tax or refund calculation. Employer NPS, family pension,
        business adjustments, dividends, capital gains, and other special provisions are not
        automatically modeled. The server refuses unsupported inputs instead of guessing.</p>
      <details className="wg-new-tax__advanced">
        <summary>Have employer NPS, lottery winnings, or a house-property loss? Open the advanced calculator</summary>
        <AdvancedNewRegimeTaxPanel />
      </details>
      <details className="wg-new-tax__advanced">
        <summary>Have independently qualified equity capital gains? Open the restricted capital-gains calculator</summary>
        <VerifiedEquityGainsPanel />
      </details>
      <p className="wg-new-tax__sources">Government sources: <a href="https://www.incometaxindia.gov.in/w/tax-rates-and-computation" target="_blank" rel="noopener noreferrer">Income Tax Department rates and rebates</a>
        {' · '}<a href="https://www.incometaxindia.gov.in/w/section-19-199" target="_blank" rel="noopener noreferrer">Section 19</a>
        {' · '}<a href="https://www.incometaxindia.gov.in/w/section-156-84" target="_blank" rel="noopener noreferrer">Section 156 rebate</a>
        {' · '}<a href="https://www.incometaxindia.gov.in/w/section-516-3" target="_blank" rel="noopener noreferrer">Section 516 rounding</a>
      </p>
    </section>
  );
}
