import { useEffect, useState } from 'react';
import * as api from '../services/api';
import './CashCheck.css';

const ENTRY_TYPES = [
  ['EXPECTED_INCOME', 'Expected income (not guaranteed)'],
  ['ESSENTIAL_PAYMENT', 'Essential bill'],
  ['CONTRACTUAL_PAYMENT', 'Contractual payment / EMI'],
  ['VOLUNTARY_CONTRIBUTION', 'Confirmed voluntary contribution'],
  ['OTHER_PAYMENT', 'Other payment'],
];
const SOURCES = [
  ['USER_DECLARED_BANK_CASH', 'Accessible bank cash (self-reported)'],
  ['USER_DECLARED_WALLET_CASH', 'Accessible cash / wallet (self-reported)'],
  ['USER_DECLARED_OTHER_ACCESSIBLE_CASH', 'Other accessible cash (self-reported)'],
];
const INDIA_DATE = () => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const dict = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return dict.year + '-' + dict.month + '-' + dict.day;
};
const formatMoney = paise => Number.isSafeInteger(paise)
  ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(paise / 100)
  : 'Not available';
export function parseRupeeInput(value, { allowEmpty = false } = {}) {
  if (allowEmpty && value.trim() === '') return null;
  const match = /^(0|[1-9]\d{0,9})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error('Enter rupees with at most two decimal places (no commas).');
  const amount = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(amount) || amount > 1_000_000_000_000) {
    throw new Error('Amount exceeds the supported exact paise limit.');
  }
  return amount;
}
function rupees(paise) {
  return paise === null || paise === undefined ? '' : (paise / 100).toFixed(2);
}
let localCounter = 0;
const newEntry = () => ({
  id: 'cash_' + Date.now().toString(36) + '_' + (++localCounter).toString(36),
  type: 'ESSENTIAL_PAYMENT', label: '', amount: '', startDate: INDIA_DATE(), recurrence: 'ONCE',
});
const EMPTY = () => ({
  asOfDate: INDIA_DATE(), cashSource: 'USER_DECLARED_BANK_CASH',
  openingCash: '', completenessConfirmed: false, entries: [],
});
function toDraft(ledger) {
  return {
    asOfDate: ledger.asOfDate,
    cashSource: ledger.cashSource,
    openingCash: rupees(ledger.openingCashPaise),
    completenessConfirmed: ledger.completenessConfirmed,
    entries: ledger.entries.map(entry => ({
      ...entry, amount: rupees(entry.amountPaise),
    })),
  };
}
function toPayload(draft) {
  if (draft.entries.length > 100) throw new Error('Maximum 100 payment/income entries.');
  return {
    asOfDate: draft.asOfDate,
    openingCashPaise: parseRupeeInput(draft.openingCash, { allowEmpty: true }),
    cashSource: draft.cashSource,
    completenessConfirmed: draft.completenessConfirmed,
    entries: draft.entries.map(({ id, type, label, amount, startDate, recurrence }) => ({
      id, type, label, amountPaise: parseRupeeInput(amount), startDate, recurrence,
    })),
  };
}
function ResultView({ data, hypothetical = false }) {
  if (!data) return null;
  const baseline = data.baseline;
  return (
    <section className="cash-check-results" aria-label={hypothetical ? 'Hypothetical scenario' : 'Saved result'}>
      <h2>{hypothetical ? 'Hypothetical result (not saved)' : '90-day cash check'}</h2>
      <p className="cash-check-provenance">User-declared, not verified against bank records. Based only on the listed entries.</p>
      {data.status === 'CANNOT_CALCULATE' ? (
        <p role="status">Cannot calculate: {data.missingInputCodes.join(', ').replaceAll('_', ' ')}.</p>
      ) : (
        <>
          <p role="status">
            <strong>{data.status === 'SHORTFALL_IN_ENTERED_PLAN'
              ? 'Shortfall in the entries supplied'
              : 'No shortfall in the entries supplied for these dates'}</strong>
          </p>
          <div className="cash-check-metrics">
            <div><span>Lowest within-day balance</span><strong>{formatMoney(baseline.minWithinDayPaise)}</strong></div>
            <div><span>90-day closing balance</span><strong>{formatMoney(baseline.closingBalancePaise)}</strong></div>
            <div><span>Earliest listed shortfall</span><strong>{baseline.earliestShortfall?.date || 'None in listed entries'}</strong></div>
          </div>
          {baseline.earliestShortfall && (
            <p>On {baseline.earliestShortfall.date}, payments entered with IDs {baseline.earliestShortfall.dueOutflowEntryIds.join(', ')} contribute to a lowest balance of {formatMoney(baseline.earliestShortfall.lowestBalancePaise)}.</p>
          )}
          {data.noExpectedIncome && (
            <p>
              <strong>Expected income absent:</strong>{' '}
              {data.noExpectedIncome.earliestShortfall
                ? 'A listed shortfall appears on ' + data.noExpectedIncome.earliestShortfall.date
                  + ' (' + formatMoney(data.noExpectedIncome.earliestShortfall.lowestBalancePaise) + ').'
                : 'No shortfall in listed entries, even if expected income does not arrive.'}
            </p>
          )}
          <details>
            <summary>See 90-day dated balances</summary>
            <div className="cash-check-table-scroll">
              <table>
                <thead><tr><th>Date</th><th>Lowest during day</th><th>Closing balance</th></tr></thead>
                <tbody>{baseline.daily.map(day => (
                  <tr key={day.date}>
                    <td>{day.date}</td><td>{formatMoney(day.lowestBalancePaise)}</td>
                    <td>{formatMoney(day.closingBalancePaise)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </details>
        </>
      )}
      <small>These results are scenarios, not guarantees of affordability. Future income, omitted bills and bank settlement times are unknown. No investing or payment action is recommended.</small>
    </section>
  );
}

export default function CashCheck() {
  const [draft, setDraft] = useState(EMPTY);
  const [revision, setRevision] = useState(0);
  const [saved, setSaved] = useState(null);
  const [preview, setPreview] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [stale, setStale] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let active = true;
    api.getCoverageLedger().then(response => {
      if (!active) return;
      if (response.ledger) setDraft(toDraft(response.ledger));
      setRevision(response.revision);
      setSaved(response.latestResult?.result || null);
      setStale(Boolean(response.requiresCashReconfirmation));
      setLoaded(true);
    }).catch(err => { if (active) { setError(err.message || 'Unable to fetch cash entries.'); setLoaded(true); } });
    return () => { active = false; };
  }, []);

  const editDraft = updater => {
    setDraft(updater);
    setDirty(true);
    setPreview(null);
    setNotice('');
  };
  const updateEntry = (id, patch) => {
    editDraft(d => ({ ...d, entries: d.entries.map(e => e.id === id ? { ...e, ...patch } : e) }));
    setPreview(null);
    setNotice('');
  };
  const addEntry = () => {
    editDraft(d => ({ ...d, entries: d.entries.length >= 100 ? d.entries : [...d.entries, newEntry()] }));
    setPreview(null);
  };
  const save = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(''); setNotice(''); setPreview(null);
    try {
      const payload = toPayload(draft);
      const response = await api.saveCoverageLedger(payload, revision);
      setRevision(response.revision);
      setSaved(response.result);
      setDirty(false);
      setStale(draft.asOfDate !== INDIA_DATE());
      setNotice('Entries saved and recalculated. Revision ' + response.revision + '.');
    } catch (err) {
      setError(err.status === 409
        ? 'Your entries changed in another session. Your local edits remain here; reload and reconcile before saving.'
        : err.message || 'Could not save your entries.');
    } finally { setBusy(false); }
  };
  const previewPause = async () => {
    if (busy) return;
    setBusy(true); setError(''); setPreview(null);
    try {
      const ids = draft.entries.filter(e => e.type === 'VOLUNTARY_CONTRIBUTION').map(e => e.id);
      const response = await api.previewCoverageScenario(revision, ids);
      setPreview(response.result);
    } catch (err) { setError(err.message || 'Preview unavailable. Save and reload your entries first.'); }
    finally { setBusy(false); }
  };
  if (!loaded) return <main className="cash-check-workspace" role="status">Loading your cash entries…</main>;
  return (
    <main className="cash-check-workspace">
      <header>
        <p className="cash-check-eyebrow">OBLIGATION FIREWALL · PRIVATE CASH WORKSPACE</p>
        <h1>90-day cash check</h1>
        <p>Enter accessible cash, bills, EMIs, expected income and contributions you actually plan to pay. No bank access, investment holdings or API key is used.</p>
      </header>
      {error && <p className="cash-check-error" role="alert">{error}</p>}
      {notice && <p className="cash-check-notice" role="status">{notice}</p>}
      {stale && <p className="cash-check-error" role="alert">Your cash declaration may be stale. Check the accessible balance and update the date before saving again.</p>}
      <form onSubmit={save}>
        <section className="cash-check-panel">
          <h2>1. Declare accessible cash</h2>
          <p>Use money available for scheduled payments—not FD principal, mutual funds, locked balances or future salary.</p>
          <div className="cash-check-grid">
            <label>Cash as-of date <input type="date" required value={draft.asOfDate}
              onChange={e => editDraft(d => ({ ...d, asOfDate: e.target.value }))} /></label>
            <label>Accessible cash (₹, blank if unknown)
              <input inputMode="decimal" value={draft.openingCash} placeholder="50000.00"
                onChange={e => editDraft(d => ({ ...d, openingCash: e.target.value }))} />
            </label>
            <label>Self-reported cash source <select value={draft.cashSource}
              onChange={e => editDraft(d => ({ ...d, cashSource: e.target.value }))}>
              {SOURCES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select></label>
          </div>
        </section>
        <section className="cash-check-panel">
          <div className="cash-check-headline"><h2>2. Date your cash entries</h2>
            <button type="button" disabled={draft.entries.length >= 100} onClick={addEntry}>Add entry</button></div>
          <p>Only confirmed contributions count as payments. Expected income is uncertain. For same-day dates, every payment is counted before any income.</p>
          {draft.entries.map(entry => (
            <fieldset className="cash-check-entry" key={entry.id}>
              <legend>Entry · {entry.id}</legend>
              <div className="cash-check-grid">
                <label>Category<select value={entry.type} onChange={e => updateEntry(entry.id, { type: e.target.value })}>
                  {ENTRY_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select></label>
                <label>Description<input maxLength={80} required value={entry.label} onChange={e => updateEntry(entry.id, { label: e.target.value })} /></label>
                <label>Amount (₹)<input inputMode="decimal" required value={entry.amount} onChange={e => updateEntry(entry.id, { amount: e.target.value })} /></label>
                <label>First due date<input type="date" required value={entry.startDate} onChange={e => updateEntry(entry.id, { startDate: e.target.value })} /></label>
                <label>Repeat<select value={entry.recurrence} onChange={e => updateEntry(entry.id, { recurrence: e.target.value })}>
                  <option value="ONCE">Once</option><option value="WEEKLY">Weekly</option><option value="MONTHLY">Monthly (date clamped at month-end)</option>
                </select></label>
              </div>
              <button type="button" className="cash-check-remove" onClick={() => { editDraft(d => ({ ...d, entries: d.entries.filter(e => e.id !== entry.id) })); setPreview(null); }}>Remove entry</button>
            </fieldset>
          ))}
          {draft.entries.length === 0 && <p>No entries yet. Add each known obligation and uncertain future income separately.</p>}
        </section>
        <section className="cash-check-panel">
          <h2>3. Confirm entries</h2>
          <label className="cash-check-confirm"><input type="checkbox" checked={draft.completenessConfirmed}
            onChange={e => editDraft(d => ({ ...d, completenessConfirmed: e.target.checked }))} />
            I have entered the commitments I currently know about. I understand this does not verify that all bills are included.</label>
          <div className="cash-check-actions">
            <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save and calculate 90 days'}</button>
            <span>Revision {revision} · Numbers are calculated on the server.</span>
          </div>
        </section>
      </form>
      {saved && !dirty && <ResultView data={saved} />}
      {saved && dirty && <p role="status">Unsaved edits: the previous result is hidden until you save and recalculate.</p>}
      {saved && !dirty && !stale && draft.entries.some(e => e.type === 'VOLUNTARY_CONTRIBUTION') &&
        <section className="cash-check-panel">
          <h2>Optional hypothetical comparison</h2>
          <p>Compare removing all listed voluntary contributions from the saved ledger. This changes no saved entry and does not suggest skipping contractual bills.</p>
          <button type="button" disabled={busy} onClick={previewPause}>Preview excluding voluntary contributions</button>
          {preview && <ResultView data={preview} hypothetical />}
        </section>}
    </main>
  );
}
