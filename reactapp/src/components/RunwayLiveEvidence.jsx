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

/**
 * Authoritative financial balances may not be hostage to auxiliary alert /
 * account-list APIs. Separate failure states are visible; failed core
 * financial reads MUST NOT silently leave previous values on the screen.
 */
async function fetchRunwayDashboard() {
  const [overview, statements, accounts, alerts] = await Promise.all([
    api.getRunwayLiveOverview(),
    api.listRunwayStatements(),
    api.getRunwayAccountObservations().then(value => ({ value }), () => ({ failed: true })),
    api.getRunwayAlerts().then(value => ({ value }), () => ({ failed: true })),
  ]);
  return {
    overview, statements,
    accounts: accounts.failed
      ? { status: 'ACCOUNT_OBSERVATIONS_UNAVAILABLE', items: [] } : accounts.value,
    alerts: alerts.failed
      ? { status: 'ALERT_CHECK_UNAVAILABLE', items: [] } : alerts.value,
  };
}
export default function RunwayLiveEvidence({ canImport, canSettle = false, onChooseCash, onSettlementApplied }) {
  const [overview, setOverview] = useState(null);
  const [imports, setImports] = useState([]);
  const [observations, setObservations] = useState(null);
  const [riskAlerts, setRiskAlerts] = useState(null);
  const [accountLabel, setAccountLabel] = useState('');
  const [csvFile, setCsvFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [pendingDelete, setPendingDelete] = useState('');
  const [matches, setMatches] = useState(null);
  const [selectedMatch, setSelectedMatch] = useState(null);
  const [confirmedCash, setConfirmedCash] = useState('');
  const [settlementChecked, setSettlementChecked] = useState(false);
  const settlementRetry = useRef(null);
  const cursor = useRef(null);
  const polling = useRef(false);
  const lastFullRefresh = useRef(0);

  const reload = useCallback(async () => {
    const result = await fetchRunwayDashboard();
    setOverview(result.overview);
    setImports(result.statements.items || []);
    setObservations(result.accounts);
    setRiskAlerts(result.alerts);
  }, []);
  useEffect(() => {
    let mounted = true;
    let stopped = false;
    // Do not expose private data in browser storage. The server remains
    // authoritative, and an event contains only the notification type.
    const refresh = async () => {
      try {
        const result = await fetchRunwayDashboard();
        if (mounted) {
          setOverview(result.overview); setImports(result.statements.items || []);
          setObservations(result.accounts); setRiskAlerts(result.alerts);
          setError('');
          lastFullRefresh.current = Date.now();
        }
      } catch {
        if (mounted) {
          setOverview(null); setObservations(null); setRiskAlerts(null); setImports([]);
          setError('Current financial evidence could not be verified. Values were cleared; retry when connected.');
        }
      }
    };
    const poll = async () => {
      if (polling.current || stopped || document.visibilityState === 'hidden') return;
      polling.current = true;
      try {
        const events = await api.getRunwayLiveEvents(cursor.current || '');
        if (!mounted) return;
        if (events.nextCursor) cursor.current = events.nextCursor;
        // A Mongo ObjectId event cursor is not a globally ordered transaction
        // commit log across writers/replicas. Full reconciliation every minute
        // guarantees recovery from a missed or expired event cursor.
        if (events.items?.length || Date.now() - lastFullRefresh.current > 60_000) await refresh();
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
      try { await reload(); } catch {
        setOverview(null); setObservations(null); setRiskAlerts(null); setImports([]);
        setError('Statement import committed, but the financial screen could not refresh. Reload before using figures.');
      }
    } catch (e) {
      setError(e.message || 'Import result could not be confirmed. Review existing evidence before retrying.');
    }
    finally { setBusy(false); }
  };
  const remove = async id => {
    if (pendingDelete !== id) { setPendingDelete(id); return; }
    setBusy(true); setError('');
    try {
      await api.deleteRunwayStatement(id);
      setPendingDelete('');
      setMessage('Imported evidence deleted from the primary database. Backups have separate retention.');
      try { await reload(); } catch {
        setOverview(null); setObservations(null); setRiskAlerts(null); setImports([]);
        setError('Evidence deletion committed, but refresh failed. Reload before trusting displayed figures.');
      }
    } catch (e) {
      setError(e.message || 'Deletion result could not be confirmed. Review evidence history before retrying.');
    }
    finally { setBusy(false); }
  };
  const loadMatches = async () => {
    setBusy(true); setError('');
    try {
      const result = await api.getRunwayReconciliationMatches();
      setMatches(result);
      if (selectedMatch && result.revision !== matches?.revision) {
        setSelectedMatch(null); setConfirmedCash(''); setSettlementChecked(false);
        settlementRetry.current = null;
      }
    } catch (e) { setError(e.message || 'Unable to load possible matches.'); }
    finally { setBusy(false); }
  };
  const settle = async () => {
    if (!selectedMatch || !canSettle || !settlementChecked) {
      setError('Select an exact unique match and explicitly confirm accessible household cash.');
      return;
    }
    setBusy(true); setError(''); setMessage('');
    try {
      const cash = confirmedCash.trim();
      if (!/^(0|[1-9][0-9]{0,12})(?:\.[0-9]{1,2})?$/.test(cash)) {
        throw new Error('Enter total household cash in rupees, with up to two decimal places.');
      }
      const [whole, fraction = ''] = cash.split('.');
      const amountPaise = (BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2))).toString();
      const input = {
        ledgerRevision: matches.revision,
        statementId: selectedMatch.statementId, rowIndex: selectedMatch.rowIndex,
        entryId: selectedMatch.entryId, openingCashPaise: amountPaise,
        confirmation: 'I_RECONFIRM_HOUSEHOLD_CASH_AFTER_TRANSACTION',
      };
      const fingerprint = JSON.stringify(input);
      if (settlementRetry.current?.fingerprint !== fingerprint) {
        const generator = globalThis.crypto;
        if (!generator?.getRandomValues) throw new Error('Secure request identity unavailable in this browser.');
        const key = 'rs_' + (generator.randomUUID?.() ||
          Array.from(generator.getRandomValues(new Uint8Array(16)),
            x => x.toString(16).padStart(2, '0')).join(''));
        settlementRetry.current = { fingerprint, key };
      }
      const saved = await api.confirmRunwaySettlement(input, {
        headers: { 'Idempotency-Key': settlementRetry.current.key },
      });
      settlementRetry.current = null;
      setSelectedMatch(null); setConfirmedCash(''); setSettlementChecked(false);
      setMessage('Settlement committed to revision ' + saved.revision
        + '. This was user-confirmed, not bank-verified.');
      try {
        await onSettlementApplied?.(saved);
        await reload();
        setMatches(await api.getRunwayReconciliationMatches());
      } catch {
        setOverview(null); setObservations(null); setRiskAlerts(null); setImports([]);
        setMatches(null);
        setMessage('Settlement committed to revision ' + saved.revision
          + ', but refreshing the screen failed. Reload the page before further edits.');
      }
    } catch (e) { setError(e.message || 'Could not confirm posted payment. Retry with the same inputs.'); }
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
      {riskAlerts?.status === 'ALERT_CHECK_UNAVAILABLE' && <p role="status">
        Risk alert verification unavailable. The saved cash-flow overview remains separate;
        do not assume that no shortfall alerts exist.
      </p>}
      {observations?.status === 'ACCOUNT_OBSERVATIONS_UNAVAILABLE' && <p role="status">
        Separate account observations are temporarily unavailable; no bank balances were verified.
      </p>}
      {riskAlerts?.status === 'HISTORICAL_ENGINE_RECONFIRM_REQUIRED' && <p role="alert">
        Saved risk alerts used an older calculation engine and are not presented as current.
        Reconfirm accessible household cash in a new ledger revision to refresh alerts.
      </p>}
      {riskAlerts?.status === 'CURRENT_USER_DECLARED_RISK'
        && riskAlerts.items?.map(alert => (
          <div className="runway-live-statement" role="status" key={alert.alertId}>
            <strong>Review listed-payment shortfall</strong>
            <p>Based only on declared accessible cash and listed obligations, a possible
              deficit of {money(alert.deficitPaise)} occurs on {alert.date}.
              This is an in-app financial warning, not a bank-confirmed prediction.</p>
          </div>
        ))}
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
      <details>
        <summary>Separate account observations ({observations?.items?.length || 0})</summary>
        <p>Account nicknames are provided by you, not verified bank account IDs.
          Each statement is shown separately; balances are never added together
          or silently used as confirmed household cash.</p>
        {observations?.potentiallyOverlappingNicknames?.length > 0 && (
          <p role="status">Repeated nicknames may represent overlapping statements.
            Verify which account each belongs to before using any amount.</p>
        )}
        {observations?.items?.length
          ? <ul>{observations.items.map(item => <li key={item.statementId}>
            <strong>{item.accountNickname}</strong> · {item.asOfDate}
            {' '}· {money(item.closingBalancePaise)} · {item.freshness}
            {' '}· Not bank verified
          </li>)}</ul>
          : <p>No account evidence imported.</p>}
      </details>
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
        <summary>Review possible posted payments or received salary</summary>
        <p>Only exact, same-day, one-time amount matches can be reviewed. Uploaded CSVs
          are not verified bank records; multiple possible matches are blocked. A settlement
          removes exactly one future modeled item and requires a new, independently confirmed
          total household cash balance after that transaction.</p>
        <button type="button" className="runway-minor" disabled={busy || !canSettle}
          onClick={loadMatches}>Find possible matches</button>
        {!canSettle && <p>Save today's confirmed ledger and discard unsaved edits first.</p>}
        {matches?.items?.length === 0 && <p>No eligible same-day one-time matches found.</p>}
        {matches?.items?.length > 0 && <ul>
          {matches.items.map(match => (
            <li key={match.statementId + '/' + match.rowIndex + '/' + match.entryId}>
              <strong>{match.entryLabel}</strong> · {match.date} · {money(match.amountPaise)}
              {' '}· {match.status === 'UNIQUE_POSSIBLE_MATCH'
                ? 'Potential match — owner review required' : 'Ambiguous — edit ledger manually'}
              {' '}{match.status === 'UNIQUE_POSSIBLE_MATCH' && (
                <button type="button" className="runway-minor" disabled={busy || !canSettle}
                  onClick={() => {
                    setSelectedMatch(match); setConfirmedCash(''); setSettlementChecked(false);
                    settlementRetry.current = null;
                  }}>Review this match</button>
              )}
            </li>
          ))}
        </ul>}
        {selectedMatch && <div className="runway-live-statement">
          <p>Review {selectedMatch.entryLabel} ({money(selectedMatch.amountPaise)}).
            Verify the transaction was posted and that your new total household cash
            already includes it. This cannot be established from the upload.</p>
          <label>Total available household cash after posting (₹)
            <input value={confirmedCash} disabled={busy}
              onChange={e => { setConfirmedCash(e.target.value); settlementRetry.current = null; }}
              placeholder="e.g. 35000.00" /></label>
          <label><input type="checkbox" checked={settlementChecked} disabled={busy}
            onChange={e => setSettlementChecked(e.target.checked)} />
            I verified this transaction and independently reconfirmed the accessible
            cash across my household after it posted.</label>
          <button type="button" disabled={busy || !canSettle || !settlementChecked || !confirmedCash.trim()}
            onClick={settle}>Confirm and update ledger</button>
          <button type="button" className="runway-minor" disabled={busy}
            onClick={() => { setSelectedMatch(null); settlementRetry.current = null; }}>
            Cancel review</button>
        </div>}
      </details>
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
