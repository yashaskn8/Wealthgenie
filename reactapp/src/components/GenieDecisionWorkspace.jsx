import { useCallback, useEffect, useState } from 'react';
import {
  getDecisionAvailability, listDecisionScenarios, getDecisionScenario,
  createDecisionScenario, updateDecisionScenario, evaluateDecisionScenario,
  getDecisionRun, deleteDecisionScenario,
} from '../services/api';
import './GenieDecisionWorkspace.css';

const TYPES = [
  { key: 'INCOME_INTERRUPTION', label: 'Income interruption',
    description: 'See when cash would run short during a temporary loss of income.' },
  { key: 'HOUSE_VS_RENT', label: 'Buy or rent',
    description: 'Compare liquid cash, fees and monthly obligations without guessing property appreciation.' },
  { key: 'MAJOR_EXPENSE', label: 'Major purchase',
    description: 'Compare paying cash and using a user-specified financing plan.' },
  { key: 'DEBT_VS_INVEST', label: 'Debt versus investing',
    description: 'Compare repaying a known loan with retaining contributions. Investment returns are not projected.' },
];
const PARAMETERS = {
  INCOME_INTERRUPTION: [
    ['startMonth', 'Interruption starts in month', 'integer'],
    ['durationMonths', 'Duration in months', 'integer'],
    ['incomeLossPerMonth', 'Monthly income lost (₹)'],
  ],
  HOUSE_VS_RENT: [
    ['purchasePrice', 'Property purchase price (₹)'], ['downPayment', 'Down payment (₹)'],
    ['upfrontFees', 'Purchase taxes and fees (₹)'], ['loanAprBps', 'Loan annual rate (basis points)', 'integer'],
    ['loanTermMonths', 'Loan term (months)', 'integer'],
    ['monthlyOwnerCosts', 'Owner recurring costs excluding loan EMI (₹)'],
    ['monthlyRent', 'Monthly rent (₹)'], ['rentalUpfrontCash', 'Rent advance/deposit paid upfront (₹)'],
    ['housingCostAlreadyInExpenses', 'Housing spending already in baseline expenses (₹)'],
  ],
  MAJOR_EXPENSE: [
    ['purchaseCost', 'Total purchase cost (₹)'], ['financePrincipal', 'Amount financed (₹)'],
    ['financeFees', 'Financing fees paid upfront (₹)'],
    ['financeAprBps', 'Annual loan rate in basis points', 'integer'],
    ['financeTermMonths', 'Loan term (months)', 'integer'],
    ['monthlyMaintenance', 'Extra monthly running cost (₹)'],
  ],
  DEBT_VS_INVEST: [
    ['loanPrincipal', 'Outstanding debt principal (₹)'],
    ['loanAprBps', 'Current debt annual rate (basis points)', 'integer'],
    ['loanTermMonths', 'Remaining loan term (months)', 'integer'],
    ['existingLoanPayment', 'Existing EMI included in baseline debt payments (₹)'],
    ['extraMonthlyBudget', 'Unreserved investment contribution available to redirect (₹)'],
  ],
};

const DEFAULT_BASE = { monthlyLivingExpenses: '', monthlyDebtPayments: '', monthlyInvestments: '' };
const label = value => TYPES.find(x => x.key === value)?.label || value;
const errorMessage = err => err?.message || 'The financial analysis could not be completed.';
const prettyMoney = value => typeof value === 'string' && /^-?\d+\.\d{2}$/.test(value)
  ? `${value.startsWith('-') ? '-' : ''}₹${Number(value.replace('-', '')).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  : 'Not available';
const shortDate = text => text ? new Date(text).toLocaleDateString('en-IN') : '';

function Field({ name, labelText, value, onChange, integer = false, help }) {
  return <label className="gd-field"><span>{labelText}</span>
    <input type="number" min="0" step={integer ? '1' : '0.01'} inputMode={integer ? 'numeric' : 'decimal'}
      name={name} value={value ?? ''} onChange={event => onChange(event.target.value)} required />
    {help && <small>{help}</small>}
  </label>;
}
function Report({ report }) {
  if (!report) return null;
  const record = report.run || report;
  const result = record.result;
  if (!result) return null;
  return <section className="gd-panel gd-report" aria-label="Decision results">
    <div className="gd-heading"><div><h3>Decision comparison</h3><p>As of {shortDate(record.asOf)} · {label(result.scenarioType)}</p></div>
      <span className="gd-status">{record.status}</span></div>
    {record.status === 'HISTORICAL' && <p className="gd-warning" role="alert">
      Your financial profile has changed. This report is historical. Create a fresh scenario to compare current finances.
    </p>}
    <div className="gd-alternatives">
      {(result.alternatives || []).map(alt => <article key={alt.name} className="gd-alternative">
        <h4>{alt.name}</h4>
        <p className="gd-money">{prettyMoney(alt.endingProjectedLiquidCash)}</p>
        <p className="gd-muted">Projected liquid cash at the end of the comparison</p>
        {alt.firstCashShortfallMonth !== null && alt.firstCashShortfallMonth !== undefined
          ? <p className="gd-warning">Cash shortfall from month {alt.firstCashShortfallMonth === 0 ? '0 (upfront)' : alt.firstCashShortfallMonth}</p>
          : <p className="gd-positive">No modeled cash shortfall</p>}
        {alt.remainingLoanBalance !== null && alt.remainingLoanBalance !== undefined &&
          <p>Outstanding loan: <strong>{prettyMoney(alt.remainingLoanBalance)}</strong></p>}
        {alt.loanInterestPaid !== null && alt.loanInterestPaid !== undefined &&
          <p>Modeled loan interest: <strong>{prettyMoney(alt.loanInterestPaid)}</strong></p>}
        <details><summary>Month-by-month cash ledger</summary>
          <div className="gd-table-scroll"><table>
            <thead><tr><th scope="col">Month</th><th scope="col">Income</th><th scope="col">Expenses</th>
              <th scope="col">Debt</th><th scope="col">Investments</th><th scope="col">Liquid cash</th></tr></thead>
            <tbody>{(alt.rows || []).map(row => <tr key={row.month}><th scope="row">{row.month}</th>
              <td>{prettyMoney(row.income)}</td><td>{prettyMoney(row.livingExpenses)}</td>
              <td>{prettyMoney(row.debtPayments)}</td><td>{prettyMoney(row.investments)}</td>
              <td>{prettyMoney(row.projectedLiquidCash)}</td></tr>)}</tbody></table></div>
        </details>
      </article>)}
    </div>
    <p className="gd-delta">Alternative B minus A — projected liquid cash: <strong>{prettyMoney(result.alternativeBLiquidCashMinusA)}</strong></p>
    <p className="gd-muted">More liquid cash does not necessarily mean greater total wealth. Loan balances, property value, recoverable deposits, market returns and tax outcomes may be excluded.</p>
    <h4>Unknowns and limits</h4>
    <ul>{(result.unmodeled || []).map(item => <li key={item}>{item}</li>)}</ul>
    <p className="gd-footnote">This is an illustrative scenario using user-declared financial assumptions, not a verified quote or personalized regulated investment recommendation.</p>
  </section>;
}

export default function GenieDecisionWorkspace() {
  const [availability, setAvailability] = useState(null);
  const [history, setHistory] = useState([]);
  const [active, setActive] = useState(null);
  const [type, setType] = useState('INCOME_INTERRUPTION');
  const [title, setTitle] = useState('My income interruption plan');
  const [horizon, setHorizon] = useState('12');
  const [baseline, setBaseline] = useState(DEFAULT_BASE);
  const [details, setDetails] = useState({});
  const [goalReservations, setGoalReservations] = useState([]);
  const [report, setReport] = useState(null);
  const [pending, setPending] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const refresh = useCallback(async ({ signal } = {}) => {
    const [availabilityResponse, historyResponse] = await Promise.all([
      getDecisionAvailability({ signal }), listDecisionScenarios({ signal }),
    ]);
    setAvailability(availabilityResponse);
    setHistory(historyResponse.scenarios || []);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    refresh({ signal: controller.signal })
      .catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)); })
      .finally(() => { if (!controller.signal.aborted) setInitialLoading(false); });
    return () => controller.abort();
  }, [refresh]);

  const newScenario = () => {
    setActive(null);
    setType('INCOME_INTERRUPTION');
    setTitle('My income interruption plan');
    setHorizon('12');
    setBaseline(DEFAULT_BASE);
    setDetails({});
    setGoalReservations([]);
    setReport(null);
    setError('');
    setSuccess('');
  };

  const openScenario = async scenario => {
    setPending(true); setError(''); setSuccess(''); setReport(null);
    try {
      const saved = await getDecisionScenario(scenario.id);
      setActive(saved.scenario);
      setType(saved.scenario.scenarioType);
      setTitle(saved.payload.title);
      setHorizon(String(saved.payload.horizonMonths));
      setBaseline(saved.payload.baseline);
      setGoalReservations(saved.payload.goalReservations);
      setDetails(saved.payload.details);
      if (saved.scenario.lastRunId) setReport(await getDecisionRun(saved.scenario.lastRunId));
    } catch (err) { setError(errorMessage(err)); }
    finally { setPending(false); }
  };

  const payload = () => {
    const required = PARAMETERS[type];
    const monthlyPattern = /^(?:0|[1-9]\d{0,10})(?:\.\d{1,2})?$/;
    const moneyFields = [...Object.values(baseline),
      ...required.filter(([, , kind]) => kind !== 'integer').map(([key]) => details[key]),
      ...goalReservations.map(goal => goal.monthlyAllocation)];
    if (moneyFields.some(v => !monthlyPattern.test(String(v ?? '')))) {
      throw new Error('Enter non-negative amounts in rupees, with no more than two decimal places.');
    }
    const typedDetails = Object.fromEntries(required.map(([key, , kind]) => {
      if (kind !== 'integer') return [key, String(details[key])];
      const value = String(details[key] ?? '');
      if (!/^\d+$/.test(value)) throw new Error('Enter valid whole-number months and annual basis-point rates.');
      return [key, Number(value)];
    }));
    const parsedHorizon = Number(horizon);
    if (!Number.isInteger(parsedHorizon) || parsedHorizon < 1 || parsedHorizon > 360) {
      throw new Error('Comparison horizon must be between 1 and 360 months.');
    }
    for (const goal of goalReservations) {
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(goal.goalId)) {
        throw new Error('Goal IDs must be 1–80 letters, numbers, dashes or underscores.');
      }
    }
    return {
      title: title.trim(), baseline: { ...baseline }, horizonMonths: parsedHorizon,
      scenarioType: type, goalReservations: [...goalReservations], details: typedDetails,
    };
  };

  const save = async event => {
    event.preventDefault();
    setPending(true); setError(''); setSuccess('');
    try {
      if (!availability?.available || !availability?.profileId) throw new Error('Complete and refresh your financial profile first.');
      const values = payload();
      let result;
      if (active) {
        result = await updateDecisionScenario(active.id, {
          expectedRevision: active.revision, title: values.title, baseline: values.baseline,
          horizonMonths: values.horizonMonths,
          goalReservations: values.goalReservations, details: values.details,
        });
      } else {
        result = await createDecisionScenario({
          ...values, profileId: availability.profileId,
          expectedProfileStateRevision: availability.profileStateRevision,
        });
      }
      setActive(result.scenario);
      setReport(null);
      setSuccess('Scenario saved. Choose Evaluate to calculate an immutable decision report.');
      await refresh();
    } catch (err) { setError(errorMessage(err)); }
    finally { setPending(false); }
  };

  const evaluate = async () => {
    if (!active) return;
    setPending(true); setError(''); setSuccess('');
    try {
      const result = await evaluateDecisionScenario(active.id, active.revision);
      setReport(result);
      setSuccess('A versioned report was published without changing your investments or profile.');
      await refresh();
    } catch (err) { setError(errorMessage(err)); }
    finally { setPending(false); }
  };

  const remove = async () => {
    if (!active || !window.confirm('Permanently delete this scenario and all of its decision reports?')) return;
    setPending(true); setError('');
    try {
      await deleteDecisionScenario(active.id, active.revision);
      newScenario();
      await refresh();
      setSuccess('Scenario and associated reports deleted.');
    } catch (err) { setError(errorMessage(err)); }
    finally { setPending(false); }
  };

  return <div className="gd-workspace">
    <header className="gd-intro"><span className="gd-eyebrow">GENIEDECISION · FINANCIAL DIGITAL TWIN</span>
      <h1>Understand what a big decision changes.</h1>
      <p>Four evidence-labeled scenarios. One shared household budget. No AI-generated rates, imaginary returns, or automatic transactions.</p>
    </header>
    {initialLoading && <p role="status">Loading your private decision workspace…</p>}
    {error && <p className="gd-warning" role="alert">{error}</p>}
    {success && <p className="gd-success" role="status">{success}</p>}
    {availability && !availability.available && <p className="gd-warning" role="alert">
      A current financial profile is required. Complete your profile before saving a decision.
    </p>}
    {availability?.available && !availability.openingLiquidCashAvailable && <p className="gd-warning">
      Your financial profile has no verified liquid-savings amount. Set it explicitly; unknown will not be treated as zero.
    </p>}
    <div className="gd-layout">
      <aside className="gd-panel gd-history" aria-label="Saved decision scenarios">
        <div className="gd-heading"><h2>My scenarios</h2><button type="button" disabled={pending} onClick={newScenario}>New</button></div>
        {history.length === 0 && <p className="gd-muted">Your saved decisions will appear here.</p>}
        <ul>{history.map(item => <li key={item.id}><button type="button"
          aria-current={active?.id === item.id ? 'true' : undefined} disabled={pending}
          onClick={() => void openScenario(item)}><strong>{item.title}</strong><small>{label(item.scenarioType)} · Revision {item.revision}</small></button></li>)}</ul>
      </aside>
      <div className="gd-content">
        <form onSubmit={save} className="gd-panel gd-form">
          <div className="gd-heading"><h2>{active ? 'Edit scenario' : 'New scenario'}</h2>
            <span className="gd-status">{active ? `Revision ${active.revision}` : 'DRAFT'}</span></div>
          <label className="gd-field"><span>What decision are you considering?</span>
            <select value={type} disabled={Boolean(active)} onChange={event => {
              const selected = event.target.value;
              setType(selected);
              setDetails({});
              setTitle(`My ${label(selected).toLowerCase()} plan`);
              setReport(null);
            }}>{TYPES.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select>
          </label>
          <p className="gd-muted">{TYPES.find(item => item.key === type)?.description}</p>
          <label className="gd-field"><span>Scenario name</span>
            <input value={title} minLength={3} maxLength={100} onChange={event => setTitle(event.target.value)} required />
          </label>
          <Field name="horizon" labelText="Comparison period (months)" integer value={horizon} onChange={setHorizon}/>
          <h3>Shared monthly budget</h3>
          <p className="gd-muted">Income and declared savings come from your canonical profile. Enter living expenses, existing EMI payments and investment transfers without double-counting.</p>
          <div className="gd-field-grid">
            {[
              ['monthlyLivingExpenses', 'Monthly living expenses (₹)'],
              ['monthlyDebtPayments', 'Existing total monthly EMI (₹)'],
              ['monthlyInvestments', 'Total monthly investments (₹)'],
            ].map(([key, name]) => <Field key={key} name={key} labelText={name}
              value={baseline[key]} onChange={value => setBaseline(old => ({ ...old, [key]: value }))}/>)}
          </div>
          <h3>Monthly goal reservations</h3>
          <p className="gd-muted">Split your investments among goals. These are allocations within total investments, never extra spending.</p>
          {goalReservations.map((row, index) => <div className="gd-goal-row" key={index}>
            <label>Goal ID <input value={row.goalId} aria-label={`Goal ${index + 1} ID`}
              onChange={event => setGoalReservations(old => old.map((item, i) => i === index
                ? { ...item, goalId: event.target.value } : item))} required /></label>
            <label>Monthly amount (₹) <input type="number" min="0" step=".01"
              aria-label={`Goal ${index + 1} monthly amount`} value={row.monthlyAllocation}
              onChange={event => setGoalReservations(old => old.map((item, i) => i === index
                ? { ...item, monthlyAllocation: event.target.value } : item))} required /></label>
            <button type="button" onClick={() => setGoalReservations(old => old.filter((_, i) => i !== index))}
              aria-label={`Remove goal ${index + 1}`}>Remove</button>
          </div>)}
          {goalReservations.length < 30 && <button type="button" className="gd-subtle"
            onClick={() => setGoalReservations(old => [...old, { goalId: '', monthlyAllocation: '' }])}>Add goal reservation</button>}
          <h3>Decision-specific facts</h3>
          <div className="gd-field-grid">{PARAMETERS[type].map(([key, name, kind]) =>
            <Field key={key} name={key} labelText={name} value={details[key] ?? ''} integer={kind === 'integer'}
              help={key.toLowerCase().includes('bps') ? '100 basis points = 1% annually. Enter an actual contract rate, not a guessed market quote.' : undefined}
              onChange={value => setDetails(old => ({ ...old, [key]: value }))}/>)}</div>
          <div className="gd-actions"><button type="submit" disabled={pending || !availability?.available}>
            {pending ? 'Working…' : active ? 'Save revision' : 'Save draft'}</button>
            {active && <button type="button" onClick={() => void evaluate()} disabled={pending}>Evaluate saved revision</button>}
            {active && <button type="button" className="gd-danger" onClick={() => void remove()} disabled={pending}>Delete scenario</button>}
          </div>
        </form>
        <Report report={report}/>
      </div>
    </div>
  </div>;
}
