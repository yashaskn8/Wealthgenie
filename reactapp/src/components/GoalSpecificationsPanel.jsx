import { useEffect, useRef, useState } from 'react';
import api, { generateUUID } from '../services/api';

const kinds = [
  ['vehicle','Vehicle purchase'], ['home','Home purchase'], ['education','Education'],
  ['retirement','Retirement'], ['emergency','Emergency fund'], ['debt_repayment','Debt repayment'],
  ['wedding','Wedding'], ['travel','Travel'], ['gold_education','Gold learning goal'], ['general','Other goal'],
];
const blank = () => ({
  kind: 'vehicle', name: '', targetAmount: '', currentSavings: '0',
  targetDate: '', priority: 'Medium', annualPriceInflationPct: '', notes: '',
});
const rupees = value => value == null ? '—' : new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', maximumFractionDigits: 2,
}).format(value);
const parseAmount = (value, name) => {
  if (value === '') throw new Error(`Enter ${name}.`);
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000_000
    || Number(n.toFixed(2)) !== n) throw new Error(`Invalid ${name}.`);
  return n;
};
const label = { kind:'Goal type', name:'Your goal name', targetAmount:'Target cost (₹)',
  currentSavings:'Savings already reserved for this goal (₹)',
  targetDate:'Desired date', priority:'Priority', annualPriceInflationPct:'Annual price rise assumption (%)',
  notes:'Notes (optional)' };
const descriptions = {
  vehicle: 'The stated purchase price must cover your chosen model; also compare EMI, insurance, running costs and emergency savings in the vehicle tab.',
  home: 'Consider down payment, registration, property taxes, maintenance, furnishing and long-term mortgage obligations.',
  education: 'Account for fees, living costs, travel, scholarships and the changing cost of the course.',
  retirement: 'Do not mistake this cash-saving baseline for a retirement income or inflation/tax forecast.',
  emergency: 'Prioritize liquidity and near-term access instead of relying on simulated market returns.',
  debt_repayment: 'Compare loan APR, penalties and scheduled payments separately before deciding repayment priority.',
  wedding: 'Keep event estimates and contingency spending distinct from monthly necessities.',
  travel: 'Include transport, accommodation, insurance, currency risk and seasonal costs.',
  gold_education: 'This is an educational planning target, not a recommendation to invest in gold.',
  general: 'Provide an independently researched target price and document important extra costs.',
};
function Field({ field, value, onChange }) {
  if (field === 'kind') return <label className="wg-goal-field"><span>{label[field]}</span>
    <select value={value} onChange={e => onChange(e.target.value)}>
      {kinds.map(([key, title]) => <option key={key} value={key}>{title}</option>)}
    </select></label>;
  if (field === 'priority') return <label className="wg-goal-field"><span>{label[field]}</span>
    <select value={value} onChange={e => onChange(e.target.value)}>
      {['Critical','High','Medium','Low'].map(p => <option key={p}>{p}</option>)}
    </select></label>;
  if (field === 'notes') return <label className="wg-goal-field"><span>{label[field]}</span>
    <textarea value={value} maxLength={800} rows={2} onChange={e => onChange(e.target.value)}/></label>;
  return <label className="wg-goal-field"><span>{label[field]}</span>
    <input value={value} onChange={e => onChange(e.target.value)}
      type={field === 'targetDate' ? 'date' : ['name'].includes(field) ? 'text' : 'number'}
      maxLength={field === 'name' ? 100 : undefined}
      min={field === 'targetAmount' ? '1000' : field === 'targetDate' ? undefined : '0'}
      max={field === 'annualPriceInflationPct' ? '30' : undefined}
      step={['name','targetDate'].includes(field) ? undefined : '0.01'} />
  </label>;
}
export default function GoalSpecificationsPanel({ onChanged }) {
  const [specs, setSpecs] = useState([]);
  const [draft, setDraft] = useState(blank);
  const [editing, setEditing] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const createRetryRef = useRef(null);
  useEffect(() => {
    let canceled = false;
    api.getGoalSpecifications().then(data => {
      if (!canceled) { setSpecs(data.specifications || []); setLoading(false); }
    }).catch(() => { if (!canceled) { setError('Saved goal specifications could not be loaded.'); setLoading(false); } });
    return () => { canceled = true; };
  }, []);
  const reload = async () => {
    const response = await api.getGoalSpecifications();
    setSpecs(response.specifications || []);
  };
  const submit = async event => {
    event.preventDefault(); setError(null); setNotice(null); setBusy(true);
    try {
      const payload = {
        ...draft,
        name: draft.name.trim(), targetAmount: parseAmount(draft.targetAmount, 'target cost'),
        currentSavings: parseAmount(draft.currentSavings, 'current savings'),
        annualPriceInflationPct: parseAmount(draft.annualPriceInflationPct, 'annual price rise'),
      };
      if (payload.targetAmount < 1000 || payload.annualPriceInflationPct > 30) throw new Error('Target must be at least ₹1,000 and annual price rise must be 0–30%.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.targetDate)) throw new Error('Choose a valid target date.');
      if (!draft.name.trim()) throw new Error('Name this goal.');
      if (editing) await api.updateGoalSpecification(editing.id, { ...payload, expectedVersion: editing.version });
      else {
        const fingerprint = JSON.stringify(payload);
        if (createRetryRef.current?.fingerprint !== fingerprint) {
          createRetryRef.current = { fingerprint, key: generateUUID() };
        }
        await api.createGoalSpecification(payload, createRetryRef.current.key);
      }
      createRetryRef.current = null;
      await reload(); setDraft(blank()); setEditing(null);
      onChanged?.();
      setNotice('Goal specification saved. Its cash-funding baseline is separate from investment forecasts.');
    } catch (e) { setError(e.message || 'Could not save goal specification.'); }
    finally { setBusy(false); }
  };
  const remove = async item => {
    if (!window.confirm(`Delete the plan "${item.name}"?`)) return;
    setBusy(true); setError(null); setNotice(null);
    try { await api.deleteGoalSpecification(item.id, item.version); await reload(); onChanged?.(); setNotice('Plan removed.'); }
    catch (e) { setError(e.message || 'Unable to remove plan; reload and retry.'); }
    finally { setBusy(false); }
  };
  return <div className="wg-goal-panel">
    <h3>Goal-specific planning</h3>
    <p>Create separately typed savings targets without stock tips or needing an investment portfolio.
      The baseline assumes <b>zero investment growth</b>; your own annual cost-increase percentage changes the target, not returns.</p>
    {loading && <p>Loading your saved goal specifications…</p>}
    {error && <p role="alert" className="wg-goal-notice wg-goal-notice--error">{error}</p>}
    {notice && <p role="status" className="wg-goal-notice">{notice}</p>}
    {!loading && <><form onSubmit={submit}>
      <h4>{editing ? 'Edit goal specification' : 'New goal specification'}</h4>
      <div className="wg-goal-input-grid">{Object.entries(draft).filter(([key]) => key !== 'notes')
        .map(([key, value]) => <Field key={key} field={key} value={value}
          onChange={next => setDraft(old => ({ ...old, [key]: next }))}/>)}</div>
      <p className="wg-goal-notice">{descriptions[draft.kind]}</p>
      <Field field="notes" value={draft.notes} onChange={next => setDraft(old => ({ ...old, notes: next }))}/>
      <button className="wg-goal-action" type="submit" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Save goal specification'}</button>
      {editing && <button className="wg-goal-subtle" type="button" disabled={busy}
        onClick={() => { createRetryRef.current = null; setEditing(null); setDraft(blank()); }}>Cancel edit</button>}
    </form>
    <h4>Saved goal specifications</h4>
    {specs.length === 0 ? <p>No additional typed goals have been saved.</p> : <ul className="wg-goal-spec-list">
      {specs.map(item => <li key={item.id}>
        <strong>{item.name}</strong> · {kinds.find(([key]) => key === item.kind)?.[1]} · {item.priority}
        <div className="wg-goal-metrics">
          <p><b>Target date</b><span>{item.targetDate}</span></p>
          <p><b>Future target (hypothetical price growth)</b><span>{rupees(item.plan.futureTargetAmount)}</span></p>
          <p><b>Reserved savings (self-reported)</b><span>{rupees(item.currentSavings)}</span></p>
          <p><b>Monthly saving needed, zero growth</b><span>{rupees(item.plan.monthlyNeededWithoutReturns)}</span></p>
        </div>
        <p>Calculation: {item.plan.status.replaceAll('_',' ')}. No tax calculation, income verification or assumed interest income.</p>
        <div className="wg-goal-spec-actions">
          <button type="button" className="wg-goal-subtle" disabled={busy}
            onClick={() => { createRetryRef.current = null; setEditing(item); setDraft({
              kind: item.kind, name: item.name, targetAmount: String(item.targetAmount),
              currentSavings: String(item.currentSavings), targetDate: item.targetDate,
              priority: item.priority, annualPriceInflationPct: String(item.annualPriceInflationPct), notes: item.notes || '',
            }); }}>Edit</button>
          <button type="button" className="wg-goal-subtle" disabled={busy}
            onClick={() => void remove(item)}>Delete</button>
        </div>
      </li>)}
    </ul>}
    <p className="wg-goal-notice wg-goal-notice--warning">Typed goals are added to the shared funding view. If you also created the same real-world goal in the original Goal Tracker, it can be counted twice until you remove one copy. Do not reuse the same saved balance across multiple goals.</p>
    </>}
  </div>;
}
