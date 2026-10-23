import { useEffect, useRef, useState } from 'react';
import * as api from '../services/api';
import './HouseholdRunway.css';

const todayIndia = () => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric',
  }).formatToParts(new Date());
  const part = type => parts.find(x => x.type === type).value;
  return part('year') + '-' + part('month') + '-' + part('day');
};
const newId = () => {
  const generator = globalThis.crypto;
  if (!generator?.getRandomValues) throw new Error('Secure random identifiers are unavailable in this browser.');
  return 'e_' + (generator.randomUUID?.() ||
    Array.from(generator.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''));
};
const newEntry = () => ({ id: newId(), label: '', kind: 'OBLIGATION', rupees: '',
  date: todayIndia(), recurrence: 'NONE', untilDate: todayIndia(), monthEndRule: 'CLAMP' });
function toPaise(rupees, { allowZero = false } = {}) {
  const raw = String(rupees).trim();
  if (!/^(0|[1-9]\d{0,12})(?:\.(\d{1,2}))?$/.test(raw)) throw new Error('Enter an amount in rupees with at most two decimal places.');
  const [units, fraction = ''] = raw.split('.');
  const value = BigInt(units) * 100n + BigInt((fraction + '00').slice(0, 2));
  if (value > 1000000000000000n || (!allowZero && value === 0n)) throw new Error('Amount exceeds the supported range or is zero.');
  return String(value);
}
function toRupees(paise) {
  const n = BigInt(paise);
  return String(n / 100n) + '.' + String(n % 100n).padStart(2, '0');
}
function displayPaise(value) {
  if (value == null) return 'Unknown';
  const amount = BigInt(value);
  const negative = amount < 0n;
  const positive = negative ? -amount : amount;
  return (negative ? '−' : '') + '₹' + (positive / 100n).toLocaleString('en-IN') + '.' +
    String(positive % 100n).padStart(2, '0');
}
function translateEntry(e) {
  const recurring = e.recurrence === 'MONTHLY';
  return {
    id: e.id, label: e.label.trim(), kind: e.kind, amountPaise: toPaise(e.rupees),
    date: e.date, recurrence: e.recurrence,
    ...(recurring ? { untilDate: e.untilDate, monthEndRule: e.monthEndRule } : {}),
  };
}
function fromStored(e) {
  return { id: e.id, label: e.label, kind: e.kind, rupees: toRupees(e.amountPaise),
    date: e.date, recurrence: e.recurrence, untilDate: e.untilDate || e.date,
    monthEndRule: e.monthEndRule || 'CLAMP' };
}
function Track({ title, data }) {
  const definite = data?.firstCertainShortfall;
  const possible = data?.firstPossibleShortfall;
  return (
    <article className="runway-track">
      <h4>{title}</h4>
      <div className="runway-amount">{displayPaise(data?.endBalancePaise)}</div>
      <p>Modeled balance after listed events; not a bank balance.</p>
      {definite && <p role="status"><strong>Listed shortfall even if same-day income arrives:</strong>
        {' '}{definite.label} on {definite.date}, deficit {displayPaise(definite.deficitPaise)}.</p>}
      {possible && (!definite || possible.date !== definite.date
        || possible.deficitPaise !== definite.deficitPaise) && <p role="status">
        <strong>Debit-first shortfall possible:</strong> {possible.label} on {possible.date},
        deficit {displayPaise(possible.deficitPaise)} if listed same-day payments settle before income.</p>}
      {!definite && !possible && <p>No listed payment becomes uncovered under this track. Unlisted costs are unknown.</p>}
      {data?.timingAmbiguities?.length > 0 && <p>Same-day receipt/payment timing, including the size of any deficit, is unverified on:
        {' '}{data.timingAmbiguities.map(x => x.date).join(', ')}.</p>}
    </article>
  );
}
export default function HouseholdRunway() {
  const [opening, setOpening] = useState('');
  const [cashConfirmed, setCashConfirmed] = useState(false);
  const ledgerRetry = useRef(null);
  const snapshotRetry = useRef(null);
  const editVersion = useRef(0);
  const [entries, setEntries] = useState([newEntry()]);
  const [revision, setRevision] = useState(0);
  const [confirmedDate, setConfirmedDate] = useState(todayIndia());
  const [dirty, setDirty] = useState(true);
  const [horizon, setHorizon] = useState(90);
  const [shock, setShock] = useState('NONE');
  const [shockReceipt, setShockReceipt] = useState('');
  const [shockFrom, setShockFrom] = useState(todayIndia());
  const [shockThrough, setShockThrough] = useState(todayIndia());
  const [shockAmount, setShockAmount] = useState('');
  const [shockDate, setShockDate] = useState(todayIndia());
  const [result, setResult] = useState(null);
  const [lastRequest, setLastRequest] = useState(null);
  const [snapshot, setSnapshot] = useState('');
  const [history, setHistory] = useState([]);
  const [historyPage, setHistoryPage] = useState(0);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyDeleteId, setHistoryDeleteId] = useState('');
  const [explanation, setExplanation] = useState(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    api.listRunwaySnapshots(0).then(data => {
      if (!active) return;
      setHistory(data.items || []); setHistoryHasMore(data.hasMore); setHistoryPage(0);
    }).catch(err => {
      if (active && err.status !== 404) setError(err.message || 'Unable to load saved results.');
    });
    api.getRunwayCurrent().then(saved => {
      if (!active) return;
      setRevision(saved.revision);
      setEntries(saved.ledger.entries.map(fromStored));
      if (saved.ledger.asOfDate === todayIndia()) {
        setOpening(toRupees(saved.ledger.openingCashPaise));
        setCashConfirmed(true);
        setConfirmedDate(saved.ledger.asOfDate);
        setDirty(false);
      } else {
        setOpening('');
        setCashConfirmed(false);
        setConfirmedDate(todayIndia());
        setMessage('Your saved ledger is historical. Confirm today’s accessible cash and update past event dates.');
      }
    }).catch(err => {
      if (active && err.status !== 404) setError(err.message || 'Unable to load the ledger.');
    });
    return () => { active = false; };
  }, []);
  const edited = callback => {
    editVersion.current += 1;
    ledgerRetry.current = null;
    snapshotRetry.current = null;
    callback();
    setDirty(true);
    setResult(null);
    setLastRequest(null);
    setSnapshot('');
    setExplanation(null);
    setMessage('');
    setError('');
  };
  const changeEntry = (id, key, value) => edited(() =>
    setEntries(current => current.map(e => e.id === id ? { ...e, [key]: value } : e)));
  const save = async () => {
    setBusy(true); setError('');
    try {
      if (opening === '' || !cashConfirmed) throw new Error('Confirm that today’s cash is accessible and not double counted.');
      const beforeSave = editVersion.current;
      const ledger = {
        asOfDate: todayIndia(), confirmationDate: todayIndia(),
        openingCashPaise: toPaise(opening, { allowZero: true }),
        entries: entries.map(translateEntry),
      };
      const fingerprint = JSON.stringify({ revision, ledger });
      if (ledgerRetry.current?.fingerprint !== fingerprint) {
        ledgerRetry.current = { fingerprint, key: newId() };
      }
      const saved = await api.saveRunwayLedger(ledger, revision, {
        headers: { 'Idempotency-Key': ledgerRetry.current.key },
      });
      ledgerRetry.current = null;
      setRevision(saved.revision);
      setConfirmedDate(saved.ledger.asOfDate);
      setDirty(editVersion.current !== beforeSave);
      setResult(null); setLastRequest(null);
      setMessage('Ledger revision ' + saved.revision + ' saved. Amounts are self-reported, not verified balances.');
    } catch (err) { setError(err.message || 'Could not save.'); }
    finally { setBusy(false); }
  };
  const makeRequest = () => {
    const h = Number(horizon);
    if (!Number.isSafeInteger(h) || h < 1 || h > 395) throw new Error('Horizon must be between 1 and 395 days.');
    const scenarios = [];
    if (shock === 'SKIP_RECEIPTS') {
      if (!shockReceipt) throw new Error('Choose a future expected income entry to remove.');
      scenarios.push({ id: 'salary_loss', type: 'SKIP_RECEIPTS', receiptIds: [shockReceipt],
        fromDate: shockFrom, throughDate: shockThrough });
    } else if (shock === 'EXTRA_EXPENSE') {
      scenarios.push({ id: 'extra_cost', type: 'EXTRA_EXPENSE', amountPaise: toPaise(shockAmount),
        date: shockDate, label: 'User-declared additional expense' });
    }
    return { ledgerRevision: revision, horizonDays: h, scenarios };
  };
  const simulate = async () => {
    setBusy(true); setError(''); setResult(null); setLastRequest(null); setExplanation(null);
    const atStart = editVersion.current;
    try {
      if (dirty || !revision || confirmedDate !== todayIndia()) {
        throw new Error('Confirm today’s accessible cash and save the latest ledger before calculating.');
      }
      const request = makeRequest();
      const outcome = await api.simulateHouseholdRunway(request);
      if (editVersion.current !== atStart) return;
      snapshotRetry.current = null;
      setResult(outcome); setLastRequest(request); setSnapshot('');
      if (outcome.status === 'INSUFFICIENT_INPUT') setMessage('Add at least one dated payment to calculate a runway.');
      else setMessage('Conditional results calculated from your listed entries.');
    } catch (err) { setError(err.message || 'Could not simulate.'); }
    finally { setBusy(false); }
  };
  const saveSnapshot = async () => {
    setBusy(true); setError('');
    try {
      if (!lastRequest || dirty) throw new Error('Simulate the current saved ledger before storing a snapshot.');
      const fingerprint = JSON.stringify(lastRequest);
      if (snapshotRetry.current?.fingerprint !== fingerprint) {
        snapshotRetry.current = { fingerprint, key: newId() };
      }
      const saved = await api.saveRunwaySnapshot(lastRequest, {
        headers: { 'Idempotency-Key': snapshotRetry.current.key },
      });
      setSnapshot(saved.snapshotId);
      const data = await api.listRunwaySnapshots(0).catch(() => null);
      if (data) { setHistory(data.items || []); setHistoryPage(0); setHistoryHasMore(Boolean(data.hasMore)); }
      setMessage('Snapshot saved against ledger revision ' + saved.ledgerRevision + '.');
      try {
        const text = await api.explainRunwaySnapshot(saved.snapshotId);
        setExplanation(text);
      } catch {
        setExplanation(null);
        setMessage('Snapshot saved. Its optional explanation is temporarily unavailable.');
      }
    } catch (err) { setError(err.message || 'Could not save the snapshot.'); }
    finally { setBusy(false); }
  };
  const openHistory = async id => {
    setBusy(true); setError('');
    try {
      const saved = await api.getRunwaySnapshot(id);
      setResult(saved.result);
      setSnapshot(id);
      setLastRequest(null);
      setExplanation(null);
      setMessage(saved.engineStatus === 'HISTORICAL_ENGINE'
        ? 'Viewing an older engine result checked against its saved hash, NOT independently recalculated with the current engine.'
        : saved.status === 'HISTORICAL'
          ? 'Viewing a historical saved result. Reconfirm today’s cash for new calculations.'
          : 'Viewing a server-recalculated result for the current ledger.');
    } catch (err) { setError(err.message || 'Could not open saved result.'); }
    finally { setBusy(false); }
  };
  const loadHistory = async page => {
    setBusy(true); setError('');
    try {
      const data = await api.listRunwaySnapshots(page);
      setHistory(data.items || []); setHistoryHasMore(Boolean(data.hasMore)); setHistoryPage(page);
    } catch (err) { setError(err.message || 'Could not load saved results.'); }
    finally { setBusy(false); }
  };
  const deleteHistory = async id => {
    if (historyDeleteId !== id) { setHistoryDeleteId(id); return; }
    setBusy(true); setError('');
    try {
      await api.deleteRunwaySnapshot(id);
      setHistoryDeleteId('');
      if (snapshot === id) { setSnapshot(''); setResult(null); setExplanation(null); }
      const data = await api.listRunwaySnapshots(historyPage);
      setHistory(data.items || []); setHistoryHasMore(Boolean(data.hasMore));
      setMessage('The selected saved result was deleted from the primary database.');
    } catch (err) { setError(err.message || 'Could not delete this result.'); }
    finally { setBusy(false); }
  };
  const clear = async () => {
    if (deleteConfirmation !== 'DELETE_RUNWAY_DATA') return;
    setBusy(true); setError('');
    try {
      await api.deleteRunwayData();
      ledgerRetry.current = null; snapshotRetry.current = null;
      setRevision(0); setOpening(''); setCashConfirmed(false); setEntries([newEntry()]); setDirty(true);
      setResult(null); setLastRequest(null); setExplanation(null); setSnapshot('');
      setHistory([]); setHistoryPage(0); setHistoryHasMore(false); setHistoryDeleteId('');
      setDeleteConfirmation('');
      setMessage('Runway data removed from the primary database. Backup expiry is not verified.');
    } catch (err) { setError(err.message || 'Deletion unavailable. Sign in again if required.'); }
    finally { setBusy(false); }
  };
  const incomeEntries = entries.filter(e => e.kind === 'EXPECTED_INCOME');
  return (
    <section className="runway" aria-label="Household Runway">
      <header><p className="runway-eyebrow">PRIVATE CASH-FLOW REHEARSAL</p>
        <h1>Household Runway</h1>
        <p>Check whether a <strong>listed payment</strong> might become uncovered. This is not a bank connection,
          investment recommendation, or guarantee that every household expense is included.</p>
      </header>
      {message && <p role="status" className="runway-message">{message}</p>}
      {error && <p role="alert" className="runway-error">{error}</p>}
      <div className="runway-panel">
        <h2>1. Confirm cash you can access now</h2>
        <p>Do not add locked FDs, mutual funds, future salary, or money already counted elsewhere.</p>
        <label>Available cash (₹)
          <input inputMode="decimal" value={opening} placeholder="e.g. 25000.00" disabled={busy}
            onChange={e => edited(() => { setOpening(e.target.value); setCashConfirmed(false); })} />
        </label>
        <label className="runway-check"><input type="checkbox" checked={cashConfirmed} disabled={busy}
          onChange={e => edited(() => setCashConfirmed(e.target.checked))} />
          I confirmed this amount is accessible today, is not future income, and has not been double counted.
        </label>
        <p>Confirmation date (India): <strong>{confirmedDate}</strong> · Current revision: <strong>{revision || 'Not saved'}</strong></p>
      </div>
      <div className="runway-panel">
        <h2>2. List the payments and expected income you know</h2>
        <p>Expected income is never treated as cash already received. Leave unconfirmed future amounts out rather than guessing.</p>
        {entries.map((entry, index) => (
          <fieldset key={entry.id} className="runway-entry" disabled={busy}>
            <legend>Event {index + 1}</legend>
            <label>Payment or income
              <select value={entry.kind} onChange={e => changeEntry(entry.id, 'kind', e.target.value)}>
                <option value="OBLIGATION">Payment / bill</option>
                <option value="EXPECTED_INCOME">Expected income (not received)</option>
              </select>
            </label>
            <label>Description
              <input value={entry.label} maxLength={80} onChange={e => changeEntry(entry.id, 'label', e.target.value)} placeholder="e.g. Rent, salary" />
            </label>
            <label>Amount (₹)
              <input inputMode="decimal" value={entry.rupees} onChange={e => changeEntry(entry.id, 'rupees', e.target.value)} />
            </label>
            <label>First date
              <input type="date" value={entry.date} onChange={e => changeEntry(entry.id, 'date', e.target.value)} />
            </label>
            <label>Frequency
              <select value={entry.recurrence} onChange={e => changeEntry(entry.id, 'recurrence', e.target.value)}>
                <option value="NONE">One time</option><option value="MONTHLY">Monthly</option>
              </select>
            </label>
            {entry.recurrence === 'MONTHLY' && <>
              <label>Repeat through
                <input type="date" value={entry.untilDate} onChange={e => changeEntry(entry.id, 'untilDate', e.target.value)} />
              </label>
              <label>When the day does not exist (e.g. February 31)
                <select value={entry.monthEndRule} onChange={e => changeEntry(entry.id, 'monthEndRule', e.target.value)}>
                  <option value="CLAMP">Use last day of month</option><option value="SKIP">Skip that month</option>
                </select>
              </label>
            </>}
            <button type="button" className="runway-minor" onClick={() => edited(() =>
              setEntries(current => current.filter(e => e.id !== entry.id)))}>Remove event</button>
          </fieldset>
        ))}
        <button type="button" className="runway-minor" disabled={busy || entries.length >= 256}
          onClick={() => edited(() => setEntries(current => [...current, newEntry()]))}>+ Add event</button>
        <button type="button" disabled={busy || !cashConfirmed || (!dirty && confirmedDate === todayIndia())}
          onClick={save}>Save confirmed ledger</button>
      </div>
      <fieldset className="runway-panel runway-options" disabled={busy}>
        <legend><strong>3. Rehearse a change</strong></legend>
        <label>Horizon (days, 1–395)
          <input type="number" min={1} max={395} value={horizon} onChange={e => { setHorizon(e.target.value); setResult(null); setLastRequest(null); }} />
        </label>
        <label>What changes?
          <select value={shock} onChange={e => { setShock(e.target.value); setResult(null); setLastRequest(null); }}>
            <option value="NONE">Nothing — baseline only</option>
            <option value="SKIP_RECEIPTS">Expected income does not arrive</option>
            <option value="EXTRA_EXPENSE">Extra expense</option>
          </select>
        </label>
        {shock === 'SKIP_RECEIPTS' && <>
          <label>Expected income to omit
            <select value={shockReceipt} onChange={e => { setShockReceipt(e.target.value); setResult(null); setLastRequest(null); }}>
              <option value="">Choose income entry</option>
              {incomeEntries.map(x => <option key={x.id} value={x.id}>{x.label || x.id}</option>)}
            </select>
          </label>
          <label>From date<input type="date" value={shockFrom} onChange={e => { setShockFrom(e.target.value); setResult(null); setLastRequest(null); }} /></label>
          <label>Through date<input type="date" value={shockThrough} onChange={e => { setShockThrough(e.target.value); setResult(null); setLastRequest(null); }} /></label>
        </>}
        {shock === 'EXTRA_EXPENSE' && <>
          <label>Added expense (₹)<input inputMode="decimal" value={shockAmount}
            onChange={e => { setShockAmount(e.target.value); setResult(null); setLastRequest(null); }} /></label>
          <label>Date<input type="date" value={shockDate}
            onChange={e => { setShockDate(e.target.value); setResult(null); setLastRequest(null); }} /></label>
        </>}
        <button type="button" disabled={busy || dirty || !revision} onClick={simulate}>Compare cash-flow views</button>
        {dirty && <p>Save your changed ledger before simulating.</p>}
      </fieldset>
      {result?.status === 'READY' && <div className="runway-panel">
        <h2>4. Conditional results — not verified affordability</h2>
        <p>Figures are based on cash confirmed {result.asOfDate} and your listed transactions. They exclude unlisted spending,
          bank holds, settlement delays, and errors in your declarations.</p>
        {result.scenarios.map(s => <section key={s.scenarioId}>
          <h3>{s.scenarioId === 'baseline' ? 'Your original schedule' : 'With your chosen shock'}</h3>
          <div className="runway-tracks">
            <Track title="Cash already available (no future income)" data={s.cashAlreadyAvailable} />
            <Track title="If expected income arrives" data={s.ifExpectedIncomeArrives} />
          </div>
        </section>)}
        <button type="button" disabled={busy || !lastRequest} onClick={saveSnapshot}>Save this versioned result</button>
        {snapshot && <p>Saved snapshot: <code>{snapshot}</code></p>}
        {explanation?.messages?.map(x => <p key={x.scenarioId}>{x.scenarioId}: {x.text}</p>)}
      </div>}
      <div className="runway-panel">
        <h2>5. Your saved results</h2>
        <p>Only you can view these saved calculations. Historical means the cash ledger has been revised,
          not that bank records have been verified.</p>
        {history.length === 0 ? <p>No saved results on this page.</p> : (
          <ul className="runway-history">
            {history.map(item => <li key={item.snapshotId}>
              <div><strong>{item.status === 'CURRENT' ? 'Current ledger' : 'Historical ledger'}</strong>
                {' '}· Revision {item.ledgerRevision}
                {' '}· {new Date(item.createdAt).toLocaleString('en-IN')}
              </div>
              <div className="runway-history-actions">
                <button type="button" className="runway-minor" disabled={busy}
                  onClick={() => openHistory(item.snapshotId)}>View result</button>
                <button type="button" className="runway-minor" disabled={busy}
                  onClick={() => deleteHistory(item.snapshotId)}>
                  {historyDeleteId === item.snapshotId ? 'Confirm delete' : 'Delete result'}
                </button>
              </div>
            </li>)}
          </ul>
        )}
        <div>
          <button type="button" className="runway-minor" disabled={busy || historyPage === 0}
            onClick={() => loadHistory(historyPage - 1)}>Previous saved results</button>
          <span>Page {historyPage + 1}</span>
          <button type="button" className="runway-minor" disabled={busy || !historyHasMore}
            onClick={() => loadHistory(historyPage + 1)}>Next saved results</button>
        </div>
      </div>
      <details className="runway-panel"><summary>Delete my Household Runway data</summary>
        <p>This deletes the current ledger, historical revisions, and saved results in the primary database. Backup expiry is not verified.
          You must have signed in recently.</p>
        <label>Type DELETE_RUNWAY_DATA
          <input value={deleteConfirmation} onChange={e => setDeleteConfirmation(e.target.value)} />
        </label>
        <button type="button" disabled={busy || deleteConfirmation !== 'DELETE_RUNWAY_DATA'} onClick={clear}>Delete Runway records</button>
      </details>
    </section>
  );
}
