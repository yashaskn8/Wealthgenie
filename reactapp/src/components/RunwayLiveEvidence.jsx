import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../services/api.js';

const todayIndia = () => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = type => parts.find(x => x.type === type)?.value;
  return get('year') + '-' + get('month') + '-' + get('day');
};
const money = value => {
  if (value == null) return 'Unknown';
  const n = BigInt(value), sign = n < 0n ? '-' : '';
  const abs = n < 0n ? -n : n;
  return sign + '₹' + (abs / 100n).toLocaleString('en-IN') + '.'
    + String(abs % 100n).padStart(2, '0');
};

export default function RunwayLiveEvidence({ canImport, onChooseCash }) {
  const [overview, setOverview] = useState(null);
  const [imports, setImports] = useState([]);
  const [accountLabel, setAccountLabel] = useState('');
  const [csvFile, setCsvFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [pendingDelete, setPendingDelete] = useState('');
  const cursor = useRef(null);
  const polling = useRef(false);

  const reload = useCallback(async () => {
    const [next, data] = await Promise.all([api.getRunwayLiveOverview(), api.listRunwayStatements()]);
    setOverview(next);
    setImports(data.items || []);
  }, []);
  useEffect(() => {
    let mounted = true;
    let stopped = false;
    // Do not expose private data in browser storage. The server remains
    // authoritative, and an event contains only the notification type.
    const refresh = async () => {
      try {
        const [next, data] = await Promise.all([api.getRunwayLiveOverview(), api.listRunwayStatements()]);
        if (mounted) { setOverview(next); setImports(data.items || []); }
      } catch (e) { if (mounted) setError(e.message || 'Unable to refresh evidence.'); }
    };
    const poll = async () => {
      if (polling.current || stopped || document.visibilityState === 'hidden') return;
      polling.current = true;
      try {
        const events = await api.getRunwayLiveEvents(cursor.current || '');
        if (!mounted) return;
        if (events.nextCursor) cursor.current = events.nextCursor;
        if (events.items?.length) await refresh();
        // Catch up on bursts by fetching the remaining 30-item windows on
        // later polls; do not trust event content as financial evidence.
      } catch (e) { if (mounted) setError(e.message || 'Change polling unavailable.'); }
      finally { polling.current = false; }
    };
    void refresh();
    const interval = window.setInterval(() => { void poll(); }, 6000);
    const focus = () => { void refresh(); void poll(); };
    window.addEventListener('focus', focus);
    return () => {
      mounted = false; stopped = true;
      window.clearInterval(interval);
      window.removeEventListener('focus', focus);
    };
  }, []);

  const upload = async () => {
    if (!canImport || !csvFile) { setError('Save a confirmed cash ledger and choose a CSV file first.'); return; }
    setBusy(true); setError(''); setMessage('');
    try {
      if (csvFile.size < 1 || csvFile.size > 48 * 1024) {
        throw new Error('Choose a CSV smaller than 48 KiB.');
      }
      const text = await csvFile.text();
      const imported = await api.importRunwayStatement(accountLabel, text);
      setMessage(imported.replayed ? 'That evidence was already imported; no duplicate was created.'
        : 'Statement imported and every running balance reconciled. This is not bank-verified data.');
      setCsvFile(null);
      await reload();
    } catch (e) { setError(e.message || 'Statement import was rejected.'); }
    finally { setBusy(false); }
  };
  const remove = async id => {
    if (pendingDelete !== id) { setPendingDelete(id); return; }
    setBusy(true); setError('');
    try {
      await api.deleteRunwayStatement(id);
      setPendingDelete('');
      setMessage('Imported evidence deleted from the primary database. Backups have separate retention.');
      await reload();
    } catch (e) { setError(e.message || 'Could not delete imported evidence.'); }
    finally { setBusy(false); }
  };
  const observed = overview?.observedStatement;
  const track = overview?.modeled?.baseline?.cashAlreadyAvailable;
  const conditional = overview?.modeled?.baseline?.ifExpectedIncomeArrives;
  const canChoose = canImport && observed?.periodEnd === todayIndia()
    && observed?.closingBalancePaise && !observed.closingBalancePaise.startsWith('-');

  return (
    <section className="runway-panel" aria-label="Imported financial evidence">
      <h2>Optional: Statement evidence and automatic updates</h2>
      <p>This free mode updates when your WealthGenie ledger or uploaded statements change.
        It is <strong>not connected to a bank</strong>; balances are not independently verified.</p>
      {error && <p className="runway-error" role="alert">{error}</p>}
      {message && <p className="runway-message" role="status">{message}</p>}
      <div className="runway-live-grid">
        <div><span>Imported balance</span>
          <strong>{observed ? money(observed.closingBalancePaise) : 'Not supplied'}</strong>
          <span className="runway-live-subtitle">{observed
            ? observed.accountLabel + ' · last transaction ' + observed.periodEnd
            : 'No statement imported'}</span></div>
        <div><span>Automatically recalculated cash-flow projection</span>
          <strong>{track ? money(track.endBalancePaise) : overview?.modeled?.status || 'Loading'}</strong>
          <span className="runway-live-subtitle">No future income counted. Based on saved cash ledger, not imported balance.</span></div>
        <div><span>If expected income arrives</span>
          <strong>{conditional ? money(conditional.endBalancePaise) : 'Unknown'}</strong>
          <span className="runway-live-subtitle">Conditional scenario, never guaranteed.</span></div>
      </div>
      <p className="runway-live-subtitle">
        Evidence status: {overview?.freshness || 'Loading'} · Source: user-uploaded CSV
        · Polls for authenticated changes approximately every six seconds while visible.
      </p>
      {overview?.modeled?.possibleOverlaps?.length > 0 && (
        <div role="status">
          <strong>Review possible double counting:</strong>
          <ul>{overview.modeled.possibleOverlaps.map(x => (
            <li key={x.entryId}>{x.label} ({x.date}): possible statement transaction with the same amount.
              This does not confirm settlement; review your listed obligations manually.</li>
          ))}</ul>
        </div>
      )}
      {track?.firstCertainShortfall && <p role="status">Listed cash shortfall:
        {' '}{track.firstCertainShortfall.date} · {money(track.firstCertainShortfall.deficitPaise)} deficit,
        based only on previously confirmed cash and listed payments.</p>}
      <details>
        <summary>Import a bank statement CSV (free, no account connection)</summary>
        <p>Use exactly these columns in order: <code>date,description,debit,credit,balance,reference</code>.
          Dates must be YYYY-MM-DD, debits or credits are rupee amounts, and balances must reconcile row by row.
          Keep rows in ascending order. Max 250 rows and 48 KiB; no passwords or full account numbers.</p>
        <label>Account nickname (not account number)
          <input value={accountLabel} maxLength={40} disabled={busy}
            onChange={e => setAccountLabel(e.target.value)} placeholder="e.g. Salary account" /></label>
        <label>Statement CSV
          <input className="runway-live-csv" type="file" accept=".csv,text/csv" disabled={busy}
            onChange={e => setCsvFile(e.target.files?.[0] || null)} /></label>
        <button type="button" disabled={busy || !canImport || !accountLabel.trim() || !csvFile} onClick={upload}>
          Import and validate statement</button>
        {!canImport && <p>Save your confirmed cash ledger first.</p>}
      </details>
      {canChoose && <div>
        <p>Today's uploaded statement shows {money(observed.closingBalancePaise)}.
          This amount has not been independently verified; it may exclude later payments, pending transactions
          and other accounts. Using it does not settle planned expenses.</p>
        <button type="button" className="runway-minor" disabled={busy}
          onClick={() => {
            onChooseCash(observed.closingBalancePaise);
            setMessage('Imported figure copied into the cash editor. Review posted payments and reconfirm cash before saving.');
          }}>Copy today's observed balance to cash editor (requires reconfirmation)</button>
      </div>}
      <details>
        <summary>Manage imported statement evidence ({imports.length})</summary>
        {imports.length === 0 ? <p>No imported evidence.</p> : imports.map(item => (
          <div className="runway-live-statement" key={item.statementId}>
            <strong>{item.accountLabel}</strong> · {item.periodStart} through {item.periodEnd}
            {' '}· {item.transactionCount} transactions · closing {money(item.closingBalancePaise)}
            <button type="button" className="runway-minor" disabled={busy}
              onClick={() => remove(item.statementId)}>
              {pendingDelete === item.statementId ? 'Confirm delete evidence' : 'Delete evidence'}</button>
          </div>
        ))}
      </details>
    </section>
  );
}
