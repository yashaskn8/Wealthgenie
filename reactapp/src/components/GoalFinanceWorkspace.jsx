import { useEffect, useState } from 'react';
import api from '../services/api';
import './GoalFinanceWorkspace.css';

const CATEGORIES = [
  'housing', 'groceries', 'utilities', 'transport', 'healthcare', 'education',
  'insurance', 'existing_emi', 'subscriptions', 'taxes', 'family', 'other',
];
const moneyLabel = amount => typeof amount === 'number' && Number.isFinite(amount)
  ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(amount)
  : 'Unavailable';
const thisMonth = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
};
const emptyExpense = () => ({ category: 'groceries', frequency: 'recurring', amount: '' });
const emptyBudget = () => ({
  version: 0, monthlyIncome: '', expensesComplete: false,
  protectedMonthlyContributions: 0, expenses: [emptyExpense()],
});
const vehicleDefaults = {
  price: '', downPayment: '', upfrontFees: '0', monthlyOwnershipCost: '0',
  annualInterestRate: '', tenureMonths: '60', emergencyCash: '', emergencyFloor: '',
};
const projectionDefaults = {
  currentSavings: '0', monthlyContribution: '', years: '5',
  annualReturnAssumption: '0', annualInflationAssumption: '5',
};
function amount(value, field, { optional = false } = {}) {
  if ((value === '' || value === null || value === undefined) && optional) return null;
  if (value === '' || value === null || value === undefined) throw new Error(`Enter ${field}.`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1_000_000_000
    || Math.round(parsed * 100) !== parsed * 100) throw new Error(`Invalid ${field}; use a non-negative INR amount.`);
  return parsed;
}
function NumberEntry({ label, value, onChange, min = '0', max, step = '0.01', hint }) {
  return <label className="wg-goal-field">
    <span>{label}</span>
    <input type="number" inputMode="decimal" value={value ?? ''} min={min} max={max} step={step}
      onChange={event => onChange(event.target.value)} />
    {hint && <small>{hint}</small>}
  </label>;
}
function Notice({ children, kind = 'info' }) {
  return <p className={`wg-goal-notice wg-goal-notice--${kind}`} role={kind === 'error' ? 'alert' : undefined}>{children}</p>;
}
function MonthBudget({ budget, setBudget, onSave, saving }) {
  const modify = (key, value) => setBudget(old => ({ ...old, [key]: value }));
  const changeExpense = (index, field, value) => setBudget(old => ({
    ...old, expenses: old.expenses.map((expense, i) => i === index ? { ...expense, [field]: value } : expense),
  }));
  return <form className="wg-goal-panel" onSubmit={event => { event.preventDefault(); void onSave(); }}>
    <h3>Monthly income and expense tracking</h3>
    <p>Enter your actual monthly expenses. One-time expenses reduce this month's cash, not recurring affordability.</p>
    <div className="wg-goal-input-grid">
      <NumberEntry label="Monthly take-home income (₹)" value={budget.monthlyIncome}
        onChange={v => modify('monthlyIncome', v)} />
      <NumberEntry label="Already protected monthly savings (₹)" value={budget.protectedMonthlyContributions}
        onChange={v => modify('protectedMonthlyContributions', v)}
        hint="Existing savings or emergency-fund contributions that cannot be used twice."/>
    </div>
    <h4>Expenses</h4>
    {budget.expenses.map((row, index) => <div className="wg-goal-expense-row" key={index}>
      <label><span>Category</span><select value={row.category} onChange={e => changeExpense(index, 'category', e.target.value)}>
        {CATEGORIES.map(category => <option key={category} value={category}>{category.replace('_', ' ')}</option>)}
      </select></label>
      <label><span>Frequency</span><select value={row.frequency} onChange={e => changeExpense(index, 'frequency', e.target.value)}>
        <option value="recurring">Monthly recurring</option><option value="one_off">One-off this month</option>
      </select></label>
      <NumberEntry label="Amount (₹)" value={row.amount} onChange={v => changeExpense(index, 'amount', v)} />
      <button type="button" className="wg-goal-subtle" aria-label={`Remove expense ${index + 1}`}
        onClick={() => modify('expenses', budget.expenses.filter((_, i) => i !== index))}>Remove</button>
    </div>)}
    <button type="button" className="wg-goal-subtle"
      onClick={() => modify('expenses', [...budget.expenses, emptyExpense()])}
      disabled={budget.expenses.length >= 100}>+ Add expense</button>
    <label className="wg-goal-checkbox"><input type="checkbox" checked={budget.expensesComplete}
      onChange={e => modify('expensesComplete', e.target.checked)}/>
      I have entered all known regular obligations and expenses for this month.
    </label>
    <div><button className="wg-goal-action" type="submit" disabled={saving}>
      {saving ? 'Saving…' : 'Save month and recalculate'}
    </button></div>
    <small>Budget figures are self-reported, not verified bank transactions. Unknown expenses should not be entered as zero.</small>
  </form>;
}
function VehicleForm({ month, onResult }) {
  const [values, setValues] = useState(vehicleDefaults);
  const [alternatives, setAlternatives] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const set = (name, value) => setValues(old => ({ ...old, [name]: value }));
  const fields = [
    ['price', 'Vehicle purchase price (₹)'],
    ['downPayment', 'Cash down payment (₹)'],
    ['upfrontFees', 'Registration, taxes, insurance and fees upfront (₹)'],
    ['monthlyOwnershipCost', 'Fuel, servicing, parking and insurance renewals / month (₹)'],
    ['annualInterestRate', 'Loan annual nominal interest rate (%)'],
    ['tenureMonths', 'Loan duration (months)'],
    ['emergencyCash', 'Available cash reserve before buying (₹)'],
    ['emergencyFloor', 'Cash reserve to protect after buying (₹)'],
  ];
  const analyze = async event => {
    event.preventDefault(); setLoading(true); setError(null); setResult(null);
    try {
      const numeric = Object.fromEntries(Object.entries(values).map(([key, value]) => [
        key, ['emergencyCash', 'emergencyFloor'].includes(key)
          ? amount(value, key, { optional: true })
          : amount(value, key),
      ]));
      if (!Number.isInteger(numeric.tenureMonths)) throw new Error('Loan duration must be a whole number of months.');
      const more = alternatives.map(alt => ({
        label: alt.label.trim(),
        price: amount(alt.price, 'alternative price'),
        downPayment: amount(alt.downPayment, 'alternative down payment'),
        upfrontFees: amount(alt.upfrontFees, 'alternative upfront fees'),
        monthlyOwnershipCost: amount(alt.monthlyOwnershipCost, 'alternative monthly costs'),
      }));
      if (more.some(alt => !alt.label)) throw new Error('Name each alternative vehicle.');
      const response = await api.assessGoalVehiclePurchase(month, { ...numeric, alternatives: more });
      setResult(response); onResult?.(response);
    } catch (e) { setError(e.message || 'Unable to assess this purchase.'); }
    finally { setLoading(false); }
  };
  return <div className="wg-goal-panel">
    <h3>Can I afford this vehicle?</h3>
    <p>Use your own dealer quotes. We calculate EMI and ongoing affordability; we do not obtain a live price or determine bank loan approval.</p>
    <form onSubmit={analyze}>
      <div className="wg-goal-input-grid">{fields.map(([key, label]) =>
        <NumberEntry key={key} label={label} value={values[key]} onChange={v => set(key, v)}
          max={key === 'tenureMonths' ? '360' : undefined}
          step={key === 'tenureMonths' ? '1' : '0.01'}/>)}
      </div>
      <h4>Cheaper alternatives (optional)</h4>
      {alternatives.map((alt, i) => <div className="wg-goal-alternative" key={i}>
        <label className="wg-goal-field"><span>Vehicle / variant</span>
          <input value={alt.label} maxLength={100}
            onChange={e => setAlternatives(old => old.map((x, j) => i === j ? { ...x, label: e.target.value } : x))} />
        </label>
        {['price', 'downPayment', 'upfrontFees', 'monthlyOwnershipCost'].map(key =>
          <NumberEntry key={key} label={key.replace(/([A-Z])/g, ' $1')} value={alt[key]}
            onChange={v => setAlternatives(old => old.map((x, j) => i === j ? { ...x, [key]: v } : x))}/>)}
        <button className="wg-goal-subtle" type="button" onClick={() => setAlternatives(old => old.filter((_, j) => i !== j))}>Remove alternative</button>
      </div>)}
      <button type="button" className="wg-goal-subtle" disabled={alternatives.length >= 8}
        onClick={() => setAlternatives(old => [...old, { label: '', price: '', downPayment: '0', upfrontFees: '0', monthlyOwnershipCost: '0' }])}>+ Compare another vehicle</button>
      <div><button className="wg-goal-action" disabled={loading} type="submit">
        {loading ? 'Calculating…' : 'Analyze purchase and alternatives'}</button></div>
    </form>
    {error && <Notice kind="error">{error}</Notice>}
    {result && <div aria-live="polite" className="wg-goal-result">
      <h4>Assessment: {result.primary.status.replaceAll('_', ' ')}</h4>
      <div className="wg-goal-metrics">
        <p><b>Monthly EMI</b><span>{moneyLabel(result.primary.loan.monthlyEmi)}</span></p>
        <p><b>Loan interest</b><span>{moneyLabel(result.primary.loan.totalInterest)}</span></p>
        <p><b>Monthly cost including upkeep</b><span>{moneyLabel(result.primary.additionalMonthlyCommitment)}</span></p>
        <p><b>Monthly surplus after purchase</b><span>{moneyLabel(result.primary.monthlySurplusAfterPurchase)}</span></p>
        <p><b>Cash reserve after upfront cost</b><span>{moneyLabel(result.primary.emergencyCashAfterPurchase)}</span></p>
        <p><b>Estimated nominal total during loan</b><span>{moneyLabel(result.primary.totalNominalCostDuringLoan)}</span></p>
      </div>
      {result.primary.reasons.length > 0 && <Notice kind="warning">Reasons: {result.primary.reasons.join(', ').replaceAll('_', ' ')}</Notice>}
      {result.alternatives.length > 0 && <div>
        <h4>Alternatives ranked by total stated costs</h4>
        <ul>{result.alternatives.map((option, i) => <li key={i}>
          {option.label}: {moneyLabel(option.assessment.totalNominalCostDuringLoan)} · EMI {moneyLabel(option.assessment.loan.monthlyEmi)} · {option.assessment.status.replaceAll('_', ' ')}
        </li>)}</ul>
      </div>}
      <Notice>Prices are manually supplied and not live-verified. Results exclude unknown costs and are not a loan approval or guaranteed financial recommendation.</Notice>
    </div>}
  </div>;
}
function SavingsProjection() {
  const [values, setValues] = useState(projectionDefaults);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const run = async event => {
    event.preventDefault(); setError(null); setLoading(true); setResult(null);
    try {
      const payload = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, amount(v, k)]));
      if (!Number.isInteger(payload.years)) throw new Error('Years must be whole numbers');
      setResult((await api.projectGoalSavings(payload)).projection);
    } catch (e) { setError(e.message || 'Projection failed'); }
    finally { setLoading(false); }
  };
  return <div className="wg-goal-panel">
    <h3>How much can I save?</h3>
    <p>Explore hypothetical return assumptions for educational planning, not actual investment product returns.</p>
    <form onSubmit={run}>
      <div className="wg-goal-input-grid">
        {Object.entries(values).map(([k, v]) => <NumberEntry key={k} label={k.replace(/([A-Z])/g, ' $1')}
          value={v} onChange={s => setValues(old => ({ ...old, [k]: s }))}
          step={k === 'years' ? '1' : '0.01'}/>)}
      </div>
      <button type="submit" className="wg-goal-action" disabled={loading}>{loading ? 'Calculating…' : 'Calculate savings scenario'}</button>
    </form>
    {error && <Notice kind="error">{error}</Notice>}
    {result && <div className="wg-goal-metrics" aria-live="polite">
      <p><b>Nominal future value</b><span>{moneyLabel(result.futureNominal)}</span></p>
      <p><b>Inflation-adjusted purchasing power</b><span>{moneyLabel(result.futurePurchasingPower)}</span></p>
      <p><b>Total contributed</b><span>{moneyLabel(result.totalContributed)}</span></p>
      <Notice>Pre-tax hypothetical scenario, not a forecast or specific investment advice. Taxes and fees are not calculated.</Notice>
    </div>}
  </div>;
}
export default function GoalFinanceWorkspace({ refreshToken = '' }) {
  const [month, setMonth] = useState(thisMonth);
  const [budget, setBudget] = useState(emptyBudget);
  const [summary, setSummary] = useState(null);
  const [funding, setFunding] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('budget');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true); setError(null); setSummary(null); setFunding(null);
      const [budgetResponse, fundingResponse] = await Promise.allSettled([
        api.getGoalBudget(month), api.getGoalFundingPlan(month),
      ]);
      if (cancelled) return;
      if (budgetResponse.status === 'fulfilled') {
        const next = budgetResponse.value;
        setBudget({ ...next.budget,
          monthlyIncome: next.budget.monthlyIncome ?? '',
          expenses: next.budget.expenses.length ? next.budget.expenses : [emptyExpense()] });
        setSummary(next.summary);
      } else {
        setBudget(emptyBudget());
        setError('Monthly budget is unavailable. Changes cannot be saved until it loads.');
      }
      if (fundingResponse.status === 'fulfilled') setFunding(fundingResponse.value);
      else setError(previous => previous || 'Shared goal allocation is currently unavailable.');
      setLoading(false);
    };
    void load();
    return () => { cancelled = true; };
  }, [month, refreshToken]);

  const save = async () => {
    setSaving(true); setError(null);
    try {
      const payload = {
        expectedVersion: budget.version,
        monthlyIncome: amount(budget.monthlyIncome, 'monthly income', { optional: true }),
        expensesComplete: budget.expensesComplete,
        protectedMonthlyContributions: amount(budget.protectedMonthlyContributions, 'protected contributions'),
        expenses: budget.expenses.filter(e => e.amount !== '' && e.amount !== null).map(e => ({
          category: e.category, frequency: e.frequency, amount: amount(e.amount, 'expense'),
        })),
      };
      if (budget.expenses.some(e => e.amount === '' || e.amount === null))
        throw new Error('Enter an amount for each expense or remove blank rows.');
      const result = await api.saveGoalBudget(month, payload);
      setBudget(old => ({ ...old, ...result.budget, monthlyIncome: result.budget.monthlyIncome ?? '',
        expenses: result.budget.expenses.length ? result.budget.expenses : [emptyExpense()] }));
      setSummary(result.summary);
      try { setFunding(await api.getGoalFundingPlan(month)); }
      catch { setFunding(null); setError('Saved budget, but goal allocation could not be refreshed.'); }
    } catch (e) {
      setError(e.message || 'Unable to save this monthly budget. Reload before retrying.');
    } finally { setSaving(false); }
  };
  const tabs = [
    ['budget', 'Budget & expenses'], ['funding', 'Shared goal funding'],
    ['vehicle', 'EMI & vehicles'], ['projection', 'Savings forecast'],
    ['learn', 'Finance & gold basics'],
  ];
  return <section className="wg-goal-workspace" aria-label="Goals financial planning tools">
    <div className="wg-goal-workspace-head">
      <div><h2>Financial Life Planner</h2>
        <p>Budget, debt, savings and purchase decisions — no extra API key or stock tips.</p></div>
      <label className="wg-goal-field"><span>Budget month</span>
        <input type="month" value={month} onChange={e => { if (e.target.value) setMonth(e.target.value); }} />
      </label>
    </div>
    <div role="tablist" aria-label="Goals planning sections" className="wg-goal-tabs">
      {tabs.map(([id, title]) => <button key={id} type="button" role="tab"
        aria-selected={activeTab === id} className={activeTab === id ? 'wg-goal-tab-active' : ''}
        onClick={() => setActiveTab(id)}>{title}</button>)}
    </div>
    {loading && <Notice>Loading your private monthly budget and goal plan…</Notice>}
    {error && <Notice kind="error">{error}</Notice>}
    {!loading && activeTab === 'budget' && <>
      <MonthBudget budget={budget} setBudget={setBudget} onSave={save} saving={saving || Boolean(error && !summary)}/>
      {summary && <div className="wg-goal-panel wg-goal-metrics" aria-live="polite">
        <h3>Monthly cash flow — {summary.budgetStatus.replaceAll('_', ' ')}</h3>
        <p><b>Recurring costs</b><span>{moneyLabel(summary.recurringExpenses)}</span></p>
        <p><b>One-time expenses</b><span>{moneyLabel(summary.oneOffExpenses)}</span></p>
        <p><b>Monthly recurring surplus</b><span>{moneyLabel(summary.recurringSurplus)}</span></p>
        <p><b>Surplus this month after one-offs</b><span>{moneyLabel(summary.actualMonthSurplus)}</span></p>
        {summary.missing.length > 0 && <Notice kind="warning">Missing: {summary.missing.join(', ').replaceAll('_', ' ')}</Notice>}
      </div>}
    </>}
    {!loading && activeTab === 'funding' && <div className="wg-goal-panel">
      <h3>Allocate one shared savings budget</h3>
      <p>All goals compete for the same monthly surplus. A goal's previously entered savings cannot be proven distinct from savings used by another goal.</p>
      {funding ? <><h4>Status: {funding.plan.status.replaceAll('_', ' ')}</h4>
        <div className="wg-goal-metrics">
          <p><b>Available for goals</b><span>{moneyLabel(funding.plan.capacity)}</span></p>
          <p><b>Combined required contributions</b><span>{moneyLabel(funding.plan.totalRequested)}</span></p>
          <p><b>Allocated without duplication</b><span>{moneyLabel(funding.plan.totalAllocated)}</span></p>
        </div>
        {funding.plan.allocations.length ? <ul>{funding.plan.allocations.map(item => <li key={item.goalId}>
          <strong>{item.name}</strong> ({item.priority}): required {moneyLabel(item.requiredMonthly)},
          allocated {moneyLabel(item.allocatedMonthly)}, shortfall {moneyLabel(item.shortfallMonthly)}
        </li>)}</ul> : <p>Create a goal above to include it in the shared plan.</p>}
        <Notice kind="warning">{funding.plan.warnings.join('; ').replaceAll('_', ' ')}</Notice>
      </> : <Notice kind="error">Funding plan unavailable. No amount is assumed affordable.</Notice>}
    </div>}
    {!loading && activeTab === 'vehicle' && <VehicleForm key={month} month={month}/>}
    {!loading && activeTab === 'projection' && <SavingsProjection/>}
    {!loading && activeTab === 'learn' && <div className="wg-goal-panel">
      <h3>Financial decisions explained</h3>
      <details><summary>What is an EMI?</summary><p>An equated monthly instalment pays interest and principal over a loan term. Longer terms can reduce payments but increase total interest. Compare all mandatory charges and lender conditions, not just EMI.</p></details>
      <details><summary>Why might a vehicle be unaffordable?</summary><p>Income after essential spending and existing loans may be insufficient for the new loan, insurance, fuel, maintenance and protected savings. A down payment can also deplete emergency reserves.</p></details>
      <details><summary>Should I invest in gold?</summary><p>Gold can diversify exposures but prices fluctuate and it produces no guaranteed regular income. Physical gold adds purity, custody, resale spreads and making-charge considerations. ETFs and other forms have different fees and taxation. Suitability depends on liquidity and overall goals; this page does not tell you to buy gold.</p></details>
      <details><summary>What is an emergency fund?</summary><p>A liquid cash buffer helps handle job loss, medical expenses and unexpected repairs without taking risky debt or selling investments under pressure. Choose an appropriate reserve floor based on your own obligations and income stability.</p></details>
      <details><summary>Are projection rates guaranteed?</summary><p>No. Hypothetical planning returns are not current provider rates, historical returns, post-tax estimates, or guarantees. Match the time horizon and liquidity need before exploring any investment category.</p></details>
      <p>Independent learning: <a href="https://investor.sebi.gov.in/" target="_blank" rel="noopener noreferrer">SEBI Investor Education</a>.</p>
    </div>}
  </section>;
}
