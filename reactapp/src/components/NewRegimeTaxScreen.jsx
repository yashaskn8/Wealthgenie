import React, { useEffect, useRef, useState } from 'react';
import api from '../services/api';
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
  incomeType: 'salary',
  primaryIncome: '',
  otherOrdinaryIncome: '0',
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
// Defense in depth: do not show a detailed slab table that contradicts the returned
// taxable income or base tax. The server remains the authority for tax policy.
function slabsReconcile(rows, taxableString, baseTaxString) {
  if (!Array.isArray(rows) || !/^\d+$/.test(taxableString)
      || !/^\d+\.\d{4}$/.test(baseTaxString)) return false;
  const taxable = BigInt(taxableString);
  const bounds = [
    [0n, 400000n, 0], [400000n, 800000n, 5],
    [800000n, 1200000n, 10], [1200000n, 1600000n, 15],
    [1600000n, 2000000n, 20], [2000000n, 2400000n, 25],
    [2400000n, null, 30],
  ];
  let rowIndex = 0;
  let sumTaxUnits = 0n;
  let sumIncome = 0n;
  for (const [lower, upper, percent] of bounds) {
    if (taxable <= lower) break;
    const span = (upper === null || taxable < upper ? taxable : upper) - lower;
    const row = rows[rowIndex++];
    if (!row || typeof row !== 'object'
        || row.from !== lower.toString()
        || row.to !== (upper === null ? null : upper.toString())
        || row.percent !== percent
        || row.taxableInSlab !== span.toString()
        || !/^\d+\.\d{4}$/.test(row.tax || '')) return false;
    const rowTaxUnits = BigInt(row.tax.replace('.', ''));
    if (rowTaxUnits !== span * BigInt(percent) * 100n) return false;
    sumTaxUnits += rowTaxUnits;
    sumIncome += span;
  }
  return rows.length === rowIndex && sumIncome === taxable
    && sumTaxUnits === BigInt(baseTaxString.replace('.', ''));
}

function responseIsBound(result, request) {
  if (!result || result.taxYear !== TAX_YEAR || result.policyVersion !== POLICY_VERSION
      || !['CALCULATED', 'UNAVAILABLE'].includes(result.status)
      || !result.inputsUsed || typeof result.inputsUsed !== 'object') return false;
  const keys = Object.keys(request);
  if (Object.keys(result.inputsUsed).length !== keys.length
      || keys.some(key => result.inputsUsed[key] !== request[key])) return false;
  if (result.status === 'CALCULATED') {
    const amounts = [
      'grossPrimaryIncome', 'otherOrdinaryIncome', 'standardDeduction',
      'taxableIncomeBeforeRounding', 'taxBeforeRebate', 'rebate',
      'taxAfterRebate', 'surcharge', 'surchargeMarginalRelief',
      'cess', 'taxBeforeStatutoryRounding',
    ];
    if (result.calculationClass !== 'SIMPLE_ORDINARY_INCOME_ONLY'
        || !/^\d+$/.test(result.finalTax) || !/^\d+$/.test(result.taxableIncome)
        || !slabsReconcile(result.slabBreakdown, result.taxableIncome, result.taxBeforeRebate)
        || !amounts.every(key => /^\d+\.\d{4}$/.test(result[key]))) return false;
    const units = key => BigInt(result[key].replace('.', ''));
    const beforeRounding = units('taxBeforeRebate') - units('rebate')
      + units('surcharge') - units('surchargeMarginalRelief') + units('cess');
    const roundedPayable = ((beforeRounding / 10000n + 5n) / 10n) * 10n;
    const unroundedRupees = units('taxableIncomeBeforeRounding') / 10000n;
    const roundedIncome = ((unroundedRupees + 5n) / 10n) * 10n;
    return units('grossPrimaryIncome') + units('otherOrdinaryIncome')
          - units('standardDeduction') === units('taxableIncomeBeforeRounding')
      && units('taxAfterRebate') === units('taxBeforeRebate') - units('rebate')
      && beforeRounding >= 0n
      && beforeRounding === units('taxBeforeStatutoryRounding')
      && BigInt(result.finalTax) === roundedPayable
      && BigInt(result.taxableIncome) === roundedIncome;
  }
  return result.finalTax === null
    && Array.isArray(result.unavailableReasons)
    && result.unavailableReasons.length > 0;
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
    const valid = primaryPaise !== null && additionalPaise !== null
      && primaryPaise + additionalPaise <= 100_000_000_000n;
    if (!valid) {
      setResult(null);
      setError('Enter valid non-negative rupee amounts (maximum two decimal places; combined maximum ₹100 crore).');
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
        <select id="wg-tax-income-type" value={form.incomeType} onChange={e => change('incomeType', e.target.value)}>
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
        <p className="wg-new-tax__hint">Include taxable bank interest and similar ordinary-rate income. Do not put CTC, investment principal, exempt income or capital gains into these fields.</p>
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
          <span>I confirm these amounts represent ordinary-rate income only, with no unmodelled exemptions,
            deductions, losses or adjustments. All amounts belong to Tax Year 2026–27.</span>
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
      <p className="wg-new-tax__sources">Government sources: <a href="https://www.incometaxindia.gov.in/w/tax-rates-and-computation" target="_blank" rel="noopener noreferrer">Income Tax Department rates and rebates</a>
        {' · '}<a href="https://wmstatic-prd.incometaxindia.gov.in/web/guest/w/section-19-199" target="_blank" rel="noopener noreferrer">Section 19</a>
        {' · '}<a href="https://www.incometaxindia.gov.in/w/section-156-84" target="_blank" rel="noopener noreferrer">Section 156 rebate</a>
        {' · '}<a href="https://www.incometaxindia.gov.in/w/section-516-3" target="_blank" rel="noopener noreferrer">Section 516 rounding</a>
      </p>
    </section>
  );
}
