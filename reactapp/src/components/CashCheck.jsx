import { useEffect, useRef, useState } from 'react';
import * as api from '../services/api';
import { inspectCashStatementCsv, MAX_CASH_CSV_BYTES } from '../utils/cashStatementImport';
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
// Never divide exact paise into a floating rupee value: at large but safe
// aggregate balances, binary floats can display the WRONG final paisa.
const rupeeIntegerFormatter = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
function formatMoney(paise) {
  if (!Number.isSafeInteger(paise)) return 'Not available';
  const integerPaise = Math.abs(paise);
  const whole = Math.floor(integerPaise / 100);
  const cents = String(integerPaise % 100).padStart(2, '0');
  return (paise < 0 ? '-' : '') + '₹' + rupeeIntegerFormatter.format(whole) + '.' + cents;
}
function parseRupeeInput(value, { allowEmpty = false } = {}) {
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
  if (paise === null || paise === undefined) return '';
  if (!Number.isSafeInteger(paise) || paise < 0) return '';
  return String(Math.floor(paise / 100)) + '.' + String(paise % 100).padStart(2, '0');
}
let localCounter = 0;
const newEntry = () => ({
  id: 'cash_' + Date.now().toString(36) + '_' + (++localCounter).toString(36),
  type: 'ESSENTIAL_PAYMENT', label: '', amount: '', startDate: INDIA_DATE(), recurrence: 'ONCE',
});
function signalCashRevisionChanged() {
  // No balances, identities, narration, or other financial data cross tabs.
  if (typeof BroadcastChannel === 'undefined') return;
  try {
    const channel = new BroadcastChannel('wealthgenie-cash-revision');
    channel.postMessage({ type: 'revision-updated' });
    channel.close();
  } catch {
    // A browser messaging failure must never turn an already committed save
    // into an apparent transaction failure.
  }
}
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
function ResultView({ data, entries = [], hypothetical = false }) {
  if (!data) return null;
  const baseline = data.baseline;
  const entryLabels = new Map(entries.map(entry => [entry.id, entry.label]));
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
            <p>On {baseline.earliestShortfall.date}, listed payments {baseline.earliestShortfall.dueOutflowEntryIds.map(id => entryLabels.get(id) || id).join(', ')} contribute to a lowest balance of {formatMoney(baseline.earliestShortfall.lowestBalancePaise)}.</p>
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
  const pendingSave = useRef(null);
  const pendingDelete = useRef(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [indiaDate, setIndiaDate] = useState(INDIA_DATE);
  const [revision, setRevision] = useState(0);
  const [saved, setSaved] = useState(null);
  const [lastCalculatedAt, setLastCalculatedAt] = useState(null);
  const [serverInputHash, setServerInputHash] = useState(null);
  const [serverPolicyStale, setServerPolicyStale] = useState(false);
  const [verificationFailed, setVerificationFailed] = useState(false);
  const [preview, setPreview] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [stale, setStale] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [hasStoredLedger, setHasStoredLedger] = useState(false);
  const [conflictState, setConflictState] = useState(null);
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [csvReview, setCsvReview] = useState(null);
  const [csvError, setCsvError] = useState('');
  const [csvReading, setCsvReading] = useState(false);
  const [candidateTypes, setCandidateTypes] = useState({});

  useEffect(() => {
    const timer = setInterval(() => setIndiaDate(INDIA_DATE()), 60_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let active = true;
    setLoaded(false);
    setLoadFailed(false);
    api.getCoverageLedger().then(response => {
      if (!active) return;
      if (response.ledger) setDraft(toDraft(response.ledger));
      setHasStoredLedger(Boolean(response.ledger));
      setRevision(response.revision);
      setSaved(response.latestResult?.result || null);
      setLastCalculatedAt(response.latestResult?.calculatedAt || null);
      setServerInputHash(response.latestResult?.inputHash || null);
      setServerPolicyStale(Boolean(response.requiresPolicyReconfirmation));
      setVerificationFailed(false);
      setStale(Boolean(response.requiresCashReconfirmation || response.requiresPolicyReconfirmation));
      setLoaded(true);
    }).catch(err => { if (active) { setLoadFailed(true); setError(err.message || 'Unable to fetch cash entries.'); setLoaded(true); } });
    return () => { active = false; };
  }, [loadAttempt]);

  useEffect(() => {
    if (!loaded || loadFailed) return undefined;
    let active = true;
    let inFlight = false;
    const checkForChanges = async () => {
      if (busy || conflictState || inFlight || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
      inFlight = true;
      try {
        const latest = await api.getCoverageLedger();
        if (!active) return;
        const latestHash = latest.latestResult?.inputHash || null;
        // A different authenticated account may have the SAME revision
        // number. Also detect an in-place policy change without a new save.
        const differentSnapshot = latestHash !== serverInputHash;
        const policyChanged = Boolean(latest.requiresPolicyReconfirmation) !== serverPolicyStale;
        if (latest.revision === revision && !differentSnapshot && !policyChanged
            && !verificationFailed) return;
        // Never overwrite local unsaved amounts with a poll or a tab signal.
        if (dirty) {
          setConflictState(latest);
          setConfirmOverwrite(false);
          setError('Another session changed your cash plan. Review both versions before saving.');
        } else {
          setRevision(latest.revision);
          setDraft(latest.ledger ? toDraft(latest.ledger) : EMPTY());
          setSaved(latest.latestResult?.result || null);
          setLastCalculatedAt(latest.latestResult?.calculatedAt || null);
          setServerInputHash(latestHash);
          setServerPolicyStale(Boolean(latest.requiresPolicyReconfirmation));
          setVerificationFailed(false);
          if (differentSnapshot) {
            // Imported statements are not owner-bound. On an unseen source
            // identity change, discard any unsaved import-review material.
            setCsvReview(null);
            setCandidateTypes({});
          }
          setHasStoredLedger(Boolean(latest.ledger));
          setStale(Boolean(latest.requiresCashReconfirmation || latest.requiresPolicyReconfirmation));
          setPreview(null);
          setNotice(latest.latestResult?.result?.status === 'SHORTFALL_IN_ENTERED_PLAN'
            ? 'New saved revision shows a shortfall in your entered cash plan. Review the dated payments.'
            : 'Cash plan refreshed from a newer saved revision. Bank balances are not streamed.');
        }
      } catch (err) {
        if (!active) return;
        if (err.status === 401 || err.status === 403) {
          // An expired session must not leave sensitive prior-account data on screen.
          setDraft(EMPTY());
          setSaved(null);
          setLastCalculatedAt(null);
          setServerInputHash(null);
          setServerPolicyStale(false);
          setVerificationFailed(false);
          setCsvReview(null);
          setCandidateTypes({});
          setPreview(null);
          setHasStoredLedger(false);
          setLoadFailed(true);
          setError('Your session is no longer authorised. Sign in and retry loading your own cash plan.');
        } else {
          setVerificationFailed(true);
          setStale(true);
          setNotice('The latest cash revision could not be verified. Saved results are hidden until data can be reconfirmed.');
        }
      } finally { inFlight = false; }
    };
    const interval = setInterval(checkForChanges, 45_000);
    const onVisibilityChange = () => { if (document.visibilityState === 'visible') void checkForChanges(); };
    document.addEventListener('visibilitychange', onVisibilityChange);
    let channel = null;
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        channel = new BroadcastChannel('wealthgenie-cash-revision');
        channel.onmessage = event => {
          if (event.data?.type === 'revision-updated') void checkForChanges();
        };
      }
    } catch {
      // Browser policy or private mode may block BroadcastChannel. The
      // authenticated visibility/interval refresh remains authoritative.
      channel = null;
    }
    return () => {
      active = false;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (channel) channel.close();
    };
  }, [loaded, loadFailed, busy, dirty, conflictState, revision,
    serverInputHash, serverPolicyStale, verificationFailed]);

  const importStatement = async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || csvReading || busy) return;
    setCsvError('');
    setCsvReview(null);
    if (!file.name.toLowerCase().endsWith('.csv') || file.size > MAX_CASH_CSV_BYTES || file.size === 0) {
      setCsvError('Choose a nonempty .csv statement of at most 512 KB. PDF, Excel and bank-login links are not accepted.');
      return;
    }
    setCsvReading(true);
    try {
      // Sensitive transaction descriptions never leave the browser during
      // import, and full rows are not copied into app state, logs or storage.
      const result = inspectCashStatementCsv(await file.text());
      setCsvReview({ ...result, reviewedOn: INDIA_DATE() });
      setCandidateTypes({});
    } catch (err) {
      setCsvError(err.message || 'Statement could not be parsed; nothing was saved.');
    } finally { setCsvReading(false); }
  };
  const acceptStatementSuggestion = candidate => {
    if (busy || !csvReview) return;
    if (csvReview.reviewedOn !== INDIA_DATE()) {
      setCsvError('This statement review crossed an India calendar day. Import it again before confirming a future due date.');
      return;
    }
    const type = candidateTypes[candidate.id];
    if (!['ESSENTIAL_PAYMENT', 'CONTRACTUAL_PAYMENT', 'VOLUNTARY_CONTRIBUTION', 'OTHER_PAYMENT'].includes(type)) {
      setCsvError('Explicitly classify this future payment before adding it.');
      return;
    }
    if (draft.entries.length >= 100) {
      setCsvError('The 100-commitment limit is reached; remove an entry before importing.');
      return;
    }
    if (draft.entries.some(e => e.label.trim().toLowerCase() === candidate.label.trim().toLowerCase()
      && e.amount === rupees(candidate.amountPaise)
      && e.recurrence === candidate.recurrence)) {
      setCsvError('A similar future commitment already exists. Resolve possible duplicates manually.');
      return;
    }
    editDraft(d => ({
      ...d,
      completenessConfirmed: false,
      entries: [...d.entries, {
        ...newEntry(), type,
        label: candidate.label,
        amount: rupees(candidate.amountPaise),
        startDate: candidate.firstDueDate,
        recurrence: candidate.recurrence,
      }],
    }));
    setCsvReview(current => current && ({
      ...current, proposals: current.proposals.filter(p => p.id !== candidate.id),
    }));
    setCsvError('');
    setNotice('Proposed payment added to your unsaved draft. Reconfirm obligations before saving; no bank statement was uploaded.');
  };

  const editDraft = updater => {
    // A response must never publish an old calculation over a later local edit.
    if (busy) return;
    setDraft(updater);
    pendingSave.current = null;
    setDirty(true);
    setConfirmOverwrite(false);
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
    if (conflictState) {
      setError('Review the saved plan and resolve the revision conflict before another save.');
      return;
    }
    setBusy(true); setError(''); setNotice(''); setPreview(null);
    try {
      const payload = toPayload(draft);
      const requestIdentity = JSON.stringify({ revision, payload });
      if (pendingSave.current?.requestIdentity !== requestIdentity) {
        pendingSave.current = { requestIdentity, key: api.generateUUID() };
      }
      // A network timeout must not turn the same mutation into a second revision.
      const response = await api.saveCoverageLedger(payload, revision, {
        headers: { 'Idempotency-Key': pendingSave.current.key },
      });
      if (response.superseded) {
        // Do not display a valid but obsolete financial calculation as current.
        setSaved(null);
        setPreview(null);
        setDirty(true);
        setError('An earlier save was replayed after another session changed the cash plan. Review the newer revision.');
        const current = await api.getCoverageLedger();
        setConflictState(current);
        setConfirmOverwrite(false);
        pendingSave.current = null;
        return;
      }
      pendingSave.current = null;
      setRevision(response.revision);
      setSaved(response.result);
      setLastCalculatedAt(response.calculatedAt || null);
      setServerInputHash(response.inputHash || null);
      setServerPolicyStale(false);
      setVerificationFailed(false);
      setConflictState(null);
      setHasStoredLedger(true);
      setDirty(false);
      setStale(draft.asOfDate !== INDIA_DATE());
      setNotice('Entries saved and recalculated. Revision ' + response.revision + '.');
      signalCashRevisionChanged();
    } catch (err) {
      if (err.status === 409 && err.code === 'COVERAGE_REVISION_CONFLICT') {
        // This lookup is read-only; never silently overwrite another device's
        // changes or resurrect a plan that was deliberately deleted.
        try {
          const latest = await api.getCoverageLedger();
          setConflictState(latest);
          setConfirmOverwrite(false);
          setError('Your saved plan changed in another session. Review both versions below.');
        } catch {
          setError('Saved plan changed, but its latest revision could not be loaded. Your local edits remain here; retry after service recovery.');
        }
      } else {
        setError(err.message || 'Could not save your entries.');
      }
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
  const downloadSavedHistory = async () => {
    if (busy || !hasStoredLedger) return;
    setBusy(true); setError('');
    try {
      const expectedRevision = revision;
      const initial = await api.getCoverageLedger();
      if (!initial.ledger || initial.revision !== expectedRevision) {
        throw new Error('Cash plan changed in another session. Reload before exporting.');
      }
      let afterRevision = 0;
      const records = [];
      let completed = false;
      for (let pageNumber = 0; pageNumber < 16; pageNumber += 1) {
        const page = await api.exportCoverageHistoryPage(afterRevision);
        if (!Array.isArray(page.records)) throw new Error('Invalid export response.');
        records.push(...page.records);
        if (page.nextAfterRevision === null) { completed = true; break; }
        if (!Number.isSafeInteger(page.nextAfterRevision)
            || page.nextAfterRevision <= afterRevision) throw new Error('Non-advancing export cursor.');
        afterRevision = page.nextAfterRevision;
      }
      if (!completed) throw new Error('Export page limit exceeded.');
      const final = await api.getCoverageLedger();
      if (!final.ledger || final.revision !== expectedRevision) {
        throw new Error('Cash plan changed while exporting. Export cancelled to prevent a mixed history.');
      }
      const serialized = JSON.stringify({
        format: 'wealthgenie-cash-history-v1',
        provenance: 'USER_DECLARED_NOT_BANK_VERIFIED',
        exportedAt: new Date().toISOString(), records,
      }, null, 2);
      const file = new Blob([serialized], { type: 'application/json' });
      const url = URL.createObjectURL(file);
      const link = document.createElement('a');
      link.href = url; link.download = 'wealthgenie-cash-history.json';
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice('Saved cash-history export prepared. Store the file securely; it contains private household data.');
    } catch (error) { setError(error.message || 'History export failed.'); }
    finally { setBusy(false); }
  };
  const deleteSavedPlan = async () => {
    if (busy || !confirmDelete || revision < 1) return;
    setBusy(true); setError(''); setNotice('');
    try {
      if (pendingDelete.current?.revision !== revision) {
        pendingDelete.current = { revision, key: api.generateUUID() };
      }
      const response = await api.deleteCoverageLedger(revision, {
        headers: { 'Idempotency-Key': pendingDelete.current.key },
      });
      pendingDelete.current = null;
      // The anonymous tombstone revision prevents a stale tab from resurrecting data.
      setRevision(response.nextRevision);
      pendingSave.current = null;
      pendingDelete.current = null;
      setDraft(EMPTY());
      setSaved(null);
      setLastCalculatedAt(null);
      setServerInputHash(null);
      setServerPolicyStale(false);
      setVerificationFailed(false);
      setHasStoredLedger(false);
      setConflictState(null);
      setConfirmOverwrite(false);
      setPreview(null);
      setDirty(false);
      setStale(false);
      setConfirmDelete(false);
      setCsvReview(null);
      setNotice('Saved cash entries and calculations deleted. A minimal deletion receipt remains for retry safety.');
      signalCashRevisionChanged();
    } catch (err) {
      setError(err.status === 409 && err.code === 'COVERAGE_REVISION_CONFLICT'
        ? 'Deletion blocked: the saved revision changed. Reload and reconcile first.'
        : err.message || 'Could not delete cash entries.');
    } finally { setBusy(false); }
  };
  const acceptLatestConflict = () => {
    if (!conflictState || busy) return;
    setRevision(conflictState.revision);
    setDraft(conflictState.ledger ? toDraft(conflictState.ledger) : EMPTY());
    setSaved(conflictState.latestResult?.result || null);
    setLastCalculatedAt(conflictState.latestResult?.calculatedAt || null);
    setServerInputHash(conflictState.latestResult?.inputHash || null);
    setServerPolicyStale(Boolean(conflictState.requiresPolicyReconfirmation));
    setVerificationFailed(false);
    setHasStoredLedger(Boolean(conflictState.ledger));
    setStale(Boolean(conflictState.requiresCashReconfirmation || conflictState.requiresPolicyReconfirmation));
    setDirty(false);
    setPreview(null);
    pendingSave.current = null;
    setConflictState(null);
    setConfirmOverwrite(false);
    setError('');
    setNotice('Current saved revision loaded. Earlier unsaved edits were discarded by your choice.');
  };
  const keepReviewedLocalEdits = () => {
    if (!conflictState?.ledger || !confirmOverwrite || busy) return;
    setRevision(conflictState.revision);
    setSaved(null);
    setPreview(null);
    pendingSave.current = null;
    setConflictState(null);
    setConfirmOverwrite(false);
    setDirty(true);
    setError('');
    setNotice('Your local draft is ready for a new revision. Review the amounts and save explicitly.');
  };
  const needsReconfirmation = stale || (hasStoredLedger && draft.asOfDate !== indiaDate);
  if (!loaded) return <section className="cash-check-workspace" role="status">Loading your cash entries…</section>;
  if (loadFailed) return (
    <section className="cash-check-workspace">
      <h1>90-day cash check</h1>
      <p role="alert">Your saved cash records could not be loaded. Editing is blocked to protect existing data. {error}</p>
      <button type="button" onClick={() => { setError(''); setLoadAttempt(n => n + 1); }}>Retry loading saved records</button>
    </section>
  );
  return (
    <section className="cash-check-workspace">
      <header>
        <p className="cash-check-eyebrow">OBLIGATION FIREWALL · PRIVATE CASH WORKSPACE</p>
        <h1>90-day cash check</h1>
        <p>Enter accessible cash, bills, EMIs, expected income and contributions you actually plan to pay. No bank access, investment holdings or API key is used.</p>
      </header>
      {error && <p className="cash-check-error" role="alert">{error}</p>}
      {notice && <p className="cash-check-notice" role="status">{notice}</p>}
      <section className="cash-check-panel" aria-label="Cash data freshness">
        <h2>Data freshness and saved state</h2>
        <p>Saved revision: <strong>{revision}</strong>. Source: <strong>user-declared cash and commitments</strong>; this feature does not stream actual bank transactions.</p>
        <p>Last backend calculation: {lastCalculatedAt && !Number.isNaN(Date.parse(lastCalculatedAt))
          ? new Date(lastCalculatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
          : 'No verified calculation timestamp yet'}.</p>
        <p>Open WealthGenie tabs check for saved changes after a revision notification, approximately every 45 seconds, and on returning to the page. Updates depend on your connection and are not guaranteed instant.</p>
      </section>
      {conflictState && (
        <section className="cash-check-panel" role="region" aria-label="Resolve cash plan conflict">
          <h2>Review cash-plan conflict</h2>
          <p>Your unsaved draft was based on revision {revision}. The server is at revision {conflictState.revision}. No entries were overwritten.</p>
          {conflictState.ledger ? (
            <>
              <p>Latest saved opening cash: {formatMoney(conflictState.ledger.openingCashPaise)} ({conflictState.ledger.asOfDate}). Your local draft: {draft.openingCash || 'unknown'} rupees ({draft.asOfDate}).</p>
              <details>
                <summary>Compare saved obligations ({conflictState.ledger.entries.length}) with local edits ({draft.entries.length})</summary>
                <ul>{conflictState.ledger.entries.map(item => (
                  <li key={item.id}>{item.label}: {formatMoney(item.amountPaise)} — {item.startDate} ({item.recurrence})</li>
                ))}</ul>
                <p>Unsaved local entries:</p>
                <ul>{draft.entries.map(item => (
                  <li key={item.id}>{item.label || 'Unlabelled'}: ₹{item.amount || 'unknown'} — {item.startDate} ({item.recurrence})</li>
                ))}</ul>
              </details>
              <label className="cash-check-confirm">
                <input type="checkbox" checked={confirmOverwrite} onChange={e => setConfirmOverwrite(e.target.checked)} />
                I reviewed both versions. I want to save my local cash entries as a new revision, replacing the currently saved entries.
              </label>
              <button type="button" disabled={!confirmOverwrite || busy} onClick={keepReviewedLocalEdits}>Use reviewed local draft for next save</button>
            </>
          ) : (
            <p role="alert">The saved plan was deleted on another device. Overwrite is blocked. Loading the deleted state lets you start a new declaration explicitly.</p>
          )}
          <button type="button" disabled={busy} onClick={acceptLatestConflict}>Discard local edits and load current server state</button>
        </section>
      )}
      {needsReconfirmation && <p className="cash-check-error" role="alert">This saved calculation is no longer current. Reconfirm today's accessible balance, review the commitments and save a new calculation. Earlier model-policy results must not be treated as current.</p>}
      <form onSubmit={save} aria-busy={busy}>
        <fieldset className="cash-check-form-fields" disabled={busy}>
          <legend className="cash-check-hidden-legend">Cash amounts and commitments</legend>
        <section className="cash-check-panel">
          <h2>1. Declare accessible cash</h2>
          <p>Enter cash available immediately <strong>before</strong> any payments scheduled for the as-of date. Exclude FD principal, mutual funds, locked balances and future salary. Do not list bills already deducted from this opening balance.</p>
          <div className="cash-check-grid">
            <label>Cash as-of date (today in India) <input type="date" required min={INDIA_DATE()} max={INDIA_DATE()} value={draft.asOfDate}
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
        <section className="cash-check-panel" aria-label="Local bank statement assistant">
          <h2>Optional: review a bank-statement CSV locally</h2>
          <p>Private, browser-only CSV review. Nothing is sent to a bank, WealthGenie API, AI model, or cloud storage until you explicitly choose a draft commitment and save it. This is <strong>not</strong> a live bank connection or balance verification.</p>
          <p>Accepts Date, Description/Narration, Debit, Credit and optional Balance columns; ISO dates or India day-first dates. Up to 512 KB / 1,500 rows. PDF and XLSX are not accepted.</p>
          <label>Choose a CSV statement
            <input type="file" accept=".csv,text/csv" disabled={busy || csvReading} onChange={importStatement} aria-label="Choose bank statement CSV" />
          </label>
          {csvReading && <p role="status">Reviewing local statement…</p>}
          {csvError && <p className="cash-check-error" role="alert">{csvError}</p>}
          {csvReview && (
            <div className="cash-check-statement-review" role="region" aria-label="Statement review">
              <p><strong>Unverified local statement:</strong> {csvReview.rowsInspected} completed transactions, {csvReview.firstTransactionDate} to {csvReview.lastTransactionDate}. {csvReview.freshness === 'DATED_TODAY_NOT_VERIFIED' ? 'File contains a transaction dated today; balance is not bank-verified.' : 'Historical file; it is not a live bank feed.'}</p>
              {csvReview.lastReportedBalancePaise !== null ? (
                <p>File-reported balance (unverified): <strong>{formatMoney(csvReview.lastReportedBalancePaise)}</strong> on {csvReview.lastReportedBalanceDate}. This number is shown only after internal CSV transaction arithmetic reconciles, or for a single row. Reconfirm today's accessible cash yourself.</p>
              ) : (
                <p role="status">File balance unavailable: missing balance data, inconsistent arithmetic, or ambiguous row order. No bank balance was inferred.</p>
              )}
              <p>Possible recurring debits require your confirmation. Past settled debits are never added as future bills, and transfers may resemble recurring payments.</p>
              {csvReview.settledToday.length > 0 && (
                <div role="region" aria-label="Review transactions already settled today">
                  <h3>Check for today's payments already included in your opening cash</h3>
                  <p>These debits appear as settled in the uploaded file dated today. If your declared opening cash already reflects them, do not also include them as due today. Check the actual balance/timing manually.</p>
                  <ul>{csvReview.settledToday.map((item, i) => (
                    <li key={i}>{item.description}: {formatMoney(item.amountPaise)}
                      {draft.entries.some(entry => entry.startDate === item.date && entry.amount === rupees(item.amountPaise))
                        ? ' — possible match to an existing scheduled entry; review for double counting.'
                        : ' — review whether already included in accessible cash.'}
                    </li>
                  ))}</ul>
                  {csvReview.settledTodayTruncated && <p>More than 20 same-day debits. Review the full statement before confirming cash.</p>}
                </div>
              )}
              {csvReview.proposals.length === 0 && <p>No confident recurring-payment patterns found. You can still enter future bills manually.</p>}
              {csvReview.proposals.map(candidate => (
                <fieldset className="cash-check-entry" key={candidate.id}>
                  <legend>Unverified recurring-payment suggestion</legend>
                  <p><strong>{candidate.label}</strong> — {formatMoney(candidate.amountPaise)}, {candidate.recurrence.toLowerCase()}, next possible due {candidate.firstDueDate}. Historical dates: {candidate.supportingDates.join(', ')}.</p>
                  <label>Confirm payment type
                    <select value={candidateTypes[candidate.id] || ''} onChange={e => setCandidateTypes(old => ({ ...old, [candidate.id]: e.target.value }))}>
                      <option value="">Choose explicitly</option>
                      {ENTRY_TYPES.filter(([value]) => value !== 'EXPECTED_INCOME').map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </label>
                  <button type="button" disabled={busy || draft.entries.length >= 100 || !candidateTypes[candidate.id]}
                    onClick={() => acceptStatementSuggestion(candidate)}>Add reviewed payment to unsaved draft</button>
                </fieldset>
              ))}
              <button type="button" onClick={() => { setCsvReview(null); setCsvError(''); }} disabled={busy}>Discard statement review</button>
              <small>Raw CSV rows remain on this device only during parsing. Review summaries disappear when you discard them or leave this page. The upload does not authorize banking access.</small>
            </div>
          )}
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
        </fieldset>
      </form>
      {saved && !dirty && !needsReconfirmation && <ResultView data={saved} entries={draft.entries} />}
      {saved && needsReconfirmation && !dirty && <p role="alert">Saved cash entries are out of date. Reconfirm today's accessible cash and save again before viewing a result.</p>}
      {saved && dirty && <p role="status">Unsaved edits: the previous result is hidden until you save and recalculate.</p>}
      {saved && !dirty && !needsReconfirmation && draft.entries.some(e => e.type === 'VOLUNTARY_CONTRIBUTION') &&
        <section className="cash-check-panel">
          <h2>Optional hypothetical comparison</h2>
          <p>Compare removing all listed voluntary contributions from the saved ledger. This changes no saved entry and does not suggest skipping contractual bills.</p>
          <button type="button" disabled={busy} onClick={previewPause}>Preview excluding voluntary contributions</button>
          {preview && <ResultView data={preview} entries={draft.entries} hypothetical />}
        </section>}
      {hasStoredLedger && (
        <section className="cash-check-panel" aria-label="Export saved cash history">
          <h2>Download saved cash records</h2>
          <p>The JSON export contains your saved cash entries and dated results (not unsaved edits). Store it privately.</p>
          <button type="button" disabled={busy} onClick={downloadSavedHistory}>Download saved history</button>
        </section>
      )}
      {hasStoredLedger && (
        <section className="cash-check-panel" aria-label="Delete cash records">
          <h2>Remove saved cash records</h2>
          <p>Delete all saved ledgers and results. This action cannot be undone. A minimal non-financial deletion receipt and operation hashes are retained to block unsafe replay.</p>
          <label className="cash-check-confirm">
            <input type="checkbox" checked={confirmDelete} onChange={e => setConfirmDelete(e.target.checked)} />
            I understand this permanently removes my saved cash entries and calculations.
          </label>
          <button type="button" disabled={!confirmDelete || busy || dirty}
            className="cash-check-remove" onClick={deleteSavedPlan}>Delete my saved cash records</button>
          {dirty && <p>Save or reload and reconcile unsaved changes before deletion.</p>}
        </section>
      )}
    </section>
  );
}
