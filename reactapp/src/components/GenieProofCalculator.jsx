import { useEffect, useRef, useState } from 'react';
import { calculateGenieProofScenario } from '../services/api';

const amountPattern = /^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/;
const claimPattern = /^(?:0|[1-9]\d{0,17})(?:\.\d{1,2})?$/;
const percentPattern = /^(?:0|[1-9]\d{0,2})(?:\.\d{1,4})?$/;
const moneyPattern = /^\d+\.\d{2}$/;
const kinds = {
  LUMPSUM: 'One-time deposit growth',
  SIP: 'Monthly SIP illustration',
  EMI: 'Loan EMI calculation',
};

function readableMoney(value) {
  if (!moneyPattern.test(value || '')) return 'Invalid amount';
  const [rupees, paisa] = value.split('.');
  return '₹' + new Intl.NumberFormat('en-IN').format(BigInt(rupees)) + '.' + paisa;
}

function canonicalMoney(value) {
  if (!claimPattern.test(value || '')) return null;
  const parts = value.split('.');
  return String(BigInt(parts[0])) + '.' + (parts[1] || '').padEnd(2, '0');
}

function validResult(result, values) {
  if (!result || result.ok !== true || result.mode !== 'USER_INPUT_MATH_CHECK'
      || result.saved !== false || result.type !== values.type
      || result.months !== Number(values.months)
      || result.assumptionRatePercent !== values.annualRatePercent
      || result.amountRupees !== values.amountRupees
      || result.assumptionSource !== 'USER_SUPPLIED_NOT_VERIFIED'
      || result.metric !== (values.type === 'EMI' ? 'MONTHLY_EMI' : 'FUTURE_VALUE')
      || result.stepUpPercent !== (values.type === 'SIP' ? (values.stepUpPercent || '0') : null)
      || !moneyPattern.test(result.resultRupees || '')
      || !moneyPattern.test(result.totalInterestRupees || '')
      || !moneyPattern.test(result.totalPaidOrContributedRupees || '')
      || result.claimedResultRupees !== (values.claimedResultRupees
        ? canonicalMoney(values.claimedResultRupees) : null)
      || !Array.isArray(result.exclusions)
      || !['CALCULATED_ONLY', 'MATCHES_ASSUMPTIONS_WITHIN_ONE_PAISE', 'DIFFERS_FROM_ASSUMPTIONS'].includes(result.arithmeticFinding)
      || typeof result.convention !== 'string' || typeof result.caveat !== 'string') return false;
  return true;
}

const fieldStyle = {
  width: '100%', boxSizing: 'border-box', padding: 11, borderRadius: 9,
  color: '#f8fafc', background: '#0f172a', border: '1px solid #64748b', font: 'inherit',
};

export default function GenieProofCalculator() {
  const [type, setType] = useState('SIP');
  const [amountRupees, setAmount] = useState('');
  const [annualRatePercent, setRate] = useState('');
  const [months, setMonths] = useState('');
  const [stepUpPercent, setStepUp] = useState('0');
  const [claimedResultRupees, setClaim] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const controller = useRef(null);
  useEffect(() => () => controller.current?.abort(), []);

  function change(setter, value) {
    controller.current?.abort();
    controller.current = null;
    setter(value);
    setResult(null);
    setError('');
    setWorking(false);
  }

  const valid = amountPattern.test(amountRupees) && Number(amountRupees) > 0 && Number(amountRupees) <= 1_000_000_000
    && percentPattern.test(annualRatePercent) && Number(annualRatePercent) <= 100
    && /^\d{1,3}$/.test(months) && Number(months) >= 1 && Number(months) <= 600
    && (type !== 'SIP' || (percentPattern.test(stepUpPercent) && Number(stepUpPercent) <= 25))
    && (!claimedResultRupees || claimPattern.test(claimedResultRupees));

  async function submit(event) {
    event.preventDefault();
    if (!valid || working) return;
    const inputs = { type, amountRupees, annualRatePercent, months: Number(months) };
    if (type === 'SIP') inputs.stepUpPercent = stepUpPercent;
    if (claimedResultRupees) inputs.claimedResultRupees = claimedResultRupees;
    controller.current?.abort();
    const active = new AbortController();
    controller.current = active;
    setWorking(true);
    setResult(null);
    setError('');
    try {
      const response = await calculateGenieProofScenario(inputs, { signal: active.signal });
      if (active.signal.aborted || controller.current !== active) return;
      if (!validResult(response, { ...inputs, months: String(inputs.months) })) {
        throw new Error('Unexpected calculation response');
      }
      setResult(response);
    } catch {
      if (!active.signal.aborted && controller.current === active) {
        setError('Calculation unavailable or invalid. No result was accepted.');
      }
    } finally {
      if (controller.current === active) {
        controller.current = null;
        setWorking(false);
      }
    }
  }

  return (
    <section aria-labelledby="genieproof-calc-title"
      style={{ background: 'rgba(15,23,42,.7)', border: '1px solid rgba(148,163,184,.25)', borderRadius: 16, padding: 22 }}>
      <h2 id="genieproof-calc-title" style={{ marginTop: 0 }}>Check a calculation</h2>
      <p>Enter the assumptions from a claim or offer. This checks the mathematics only—not whether the quoted rate, scheme, or promised returns are genuine.</p>
      <form onSubmit={submit} aria-label="Financial calculation">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: 14 }}>
          <label>Calculation type
            <select style={fieldStyle} value={type} onChange={e => change(setType, e.target.value)}>
              {Object.entries(kinds).map(([key, name]) => <option key={key} value={key}>{name}</option>)}
            </select>
          </label>
          <label>{type === 'EMI' ? 'Loan principal (₹)' : type === 'SIP' ? 'Monthly SIP (₹)' : 'Starting amount (₹)'}
            <input style={fieldStyle} inputMode="decimal" value={amountRupees}
              onChange={e => change(setAmount, e.target.value)} placeholder="10000.00" required />
          </label>
          <label>Assumed annual nominal rate (%)
            <input style={fieldStyle} inputMode="decimal" value={annualRatePercent}
              onChange={e => change(setRate, e.target.value)} placeholder="12" required />
          </label>
          <label>Duration in months
            <input style={fieldStyle} inputMode="numeric" value={months}
              onChange={e => change(setMonths, e.target.value)} placeholder="120" required />
          </label>
          {type === 'SIP' && <label>Annual SIP step-up (%) (optional)
            <input style={fieldStyle} inputMode="decimal" value={stepUpPercent}
              onChange={e => change(setStepUp, e.target.value)} placeholder="0" />
          </label>}
          <label>Claimed {type === 'EMI' ? 'monthly EMI' : 'future value'} (₹) (optional)
            <input style={fieldStyle} inputMode="decimal" value={claimedResultRupees}
              onChange={e => change(setClaim, e.target.value)} placeholder="Compare an advertised amount" />
          </label>
        </div>
        <p style={{ color: '#94a3b8', fontSize: '.86rem' }}>
          Rate and amounts come from you. Monthly compounding, end-of-month payments, and paise rounding are specified in the result. Taxes, charges, inflation and changing rates are excluded.
        </p>
        <button type="submit" disabled={!valid || working}
          style={{ padding: '11px 18px', borderRadius: 10, color: '#fff', background: '#0369a1', border: '1px solid #38bdf8', opacity: !valid || working ? .55 : 1, cursor: 'pointer' }}>
          {working ? 'Calculating…' : 'Calculate and compare'}
        </button>
        {error && <p role="alert" style={{ color: '#fca5a5' }}>{error}</p>}
      </form>
      {result && <div aria-live="polite" style={{ borderTop: '1px solid #64748b', marginTop: 22, paddingTop: 14 }}>
        <h3>{result.metric === 'MONTHLY_EMI' ? 'Calculated monthly EMI' : 'Illustrated future value'}</h3>
        <p style={{ fontSize: '1.8rem', fontWeight: 700, margin: '8px 0' }}>{readableMoney(result.resultRupees)}</p>
        <p>{result.metric === 'MONTHLY_EMI' ? 'Total paid' : 'Amount contributed'}: {readableMoney(result.totalPaidOrContributedRupees)}</p>
        <p>{result.metric === 'MONTHLY_EMI' ? 'Total loan interest' : 'Illustrated interest/growth'}: {readableMoney(result.totalInterestRupees)}</p>
        {result.lastInstallmentRupees && <p>Final instalment: {readableMoney(result.lastInstallmentRupees)}</p>}
        {result.arithmeticFinding !== 'CALCULATED_ONLY' && <p>
          <strong>{result.arithmeticFinding === 'MATCHES_ASSUMPTIONS_WITHIN_ONE_PAISE'
            ? 'Claimed arithmetic matches the entered assumptions (within ₹0.01).'
            : 'Claimed amount differs from the entered assumptions.'}</strong>
          {result.absoluteDifferenceRupees && ' Difference: ' + readableMoney(result.absoluteDifferenceRupees)}
        </p>}
        <p><strong>Calculation convention:</strong> {result.convention}</p>
        <p style={{ color: '#fcd34d' }}>{result.caveat}</p>
      </div>}
    </section>
  );
}
