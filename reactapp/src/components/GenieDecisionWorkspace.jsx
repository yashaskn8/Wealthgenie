import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getDecisionAvailability, listDecisionScenarios, getDecisionScenario,
  createDecisionScenario, updateDecisionScenario, evaluateDecisionScenario,
  getDecisionRun, listDecisionRuns, deleteDecisionScenario, generateUUID,
  subscribeDecisionEvents, simulateDecisionScenario, subscribeAuth, getAuthSnapshot,
  getDecisionMonitor, setDecisionMonitor,
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
const prettyMoney = value => {
  if (typeof value !== 'string' || !/^-?\d+\.\d{2}$/.test(value)) return 'Not available';
  // Never convert a full ledger aggregate through IEEE-754.
  const negative = value.startsWith('-');
  const [integer, paise] = (negative ? value.slice(1) : value).split('.');
  const finalThree = integer.slice(-3);
  const firstGroups = integer.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}₹${firstGroups ? `${firstGroups},` : ''}${finalThree}.${paise}`;
};
const shortDate = text => text ? new Date(text).toLocaleDateString('en-IN') : '';
// Never create a fresh idempotency key for an identical retry after a lost
// response: the server may already have committed the first submission.
const retryKey = (reference, operation, payload) => {
  const signature = JSON.stringify({ operation, payload });
  if (reference.current?.signature !== signature) {
    reference.current = { signature, key: generateUUID() };
  }
  return reference.current.key;
};

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
    <div className="gd-heading"><div><h3>{record.previewOnly ? 'Unsaved live estimate' : 'Decision comparison'}</h3><p>{record.previewOnly ? 'Based on current declared inputs · ' : `As of ${shortDate(record.asOf)} · `}{label(result.scenarioType)}</p></div>
      <span className="gd-status">{record.status}</span></div>
    {record.previewOnly && <p className="gd-muted">This draft is not saved or signed. Save and explicitly evaluate a revision to publish an immutable report.</p>}
    {record.status === 'HISTORICAL' && <p className="gd-warning" role="alert">
      The financial profile, saved scenario, or calculation rules have changed. This report is historical; re-evaluate a current scenario before using its figures.
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
  const [monitor, setMonitor] = useState(null);
  const [assessments, setAssessments] = useState([]);
  const [selectedAssessment, setSelectedAssessment] = useState(null);
  const [draftPreview, setDraftPreview] = useState(null);
  const [previewState, setPreviewState] = useState('waiting');
  const [runs, setRuns] = useState([]);
  const loadGeneration = useRef(0);
  const createRequestRef = useRef(null);
  const evaluationRequestRef = useRef(null);
  const [savedFingerprint, setSavedFingerprint] = useState(null);
  const [pending, setPending] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [liveState, setLiveState] = useState('connecting');
  const [authGeneration, setAuthGeneration] = useState(getAuthSnapshot);
  const [liveNotice, setLiveNotice] = useState('');
  const activeRef = useRef(null);
  const currentReportRef = useRef(null);
  activeRef.current = active;
  currentReportRef.current = report;

  const visibleFingerprint = JSON.stringify({ title, type, horizon, baseline, details, goalReservations });
  const hasUnsavedChanges = Boolean(active && savedFingerprint !== visibleFingerprint);

  const refresh = useCallback(async ({ signal } = {}) => {
    // Historical reports remain browsable even if the canonical profile
    // pointer is unavailable. Never infer a usable profile from that failure.
    const [availabilityResult, historyResult] = await Promise.allSettled([
      getDecisionAvailability({ signal }), listDecisionScenarios({ signal }),
    ]);
    if (signal?.aborted) return;
    if (historyResult.status === 'fulfilled') {
      setHistory(historyResult.value.scenarios || []);
    }
    if (availabilityResult.status === 'fulfilled') {
      setAvailability(availabilityResult.value);
    } else {
      setAvailability(null);
    }
    if (historyResult.status === 'rejected') throw historyResult.reason;
    if (availabilityResult.status === 'rejected') {
      setError('Current financial profile readiness is unavailable. You may inspect saved scenarios, but creating or evaluating decisions is blocked.');
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    refresh({ signal: controller.signal })
      .catch(err => { if (!controller.signal.aborted) setError(errorMessage(err)); })
      .finally(() => { if (!controller.signal.aborted) setInitialLoading(false); });
    return () => { controller.abort(); loadGeneration.current += 1; };
  }, [refresh]);

  useEffect(() => subscribeAuth(() => setAuthGeneration(getAuthSnapshot())), []);

  useEffect(() => {
    const controller = new AbortController();
    subscribeDecisionEvents({
      signal: controller.signal,
      onStatus: state => {
        if (controller.signal.aborted) return;
        setLiveState(state);
        if (state !== 'connected') return;
        // A profile may have changed while offline. Reconcile on EVERY
        // reconnect; a new SSE handshake is not proof that cached UI is fresh.
        refresh({ signal: controller.signal }).catch(err => {
          if (!controller.signal.aborted) setLiveNotice(`Reconnection refresh failed: ${errorMessage(err)}`);
        });
        const openReportId = currentReportRef.current?.run?.id;
        if (openReportId) {
          getDecisionRun(openReportId, { signal: controller.signal })
            .then(updated => {
              if (controller.signal.aborted) return;
              setReport(previous => previous?.run?.id === updated?.run?.id ? updated : previous);
            }).catch(() => {
              if (!controller.signal.aborted) {
                setLiveNotice('Could not verify the saved report after reconnecting. Reopen the scenario before relying on it.');
                setReport(previous => previous?.run
                  ? { ...previous, run: { ...previous.run, status: 'HISTORICAL' } }
                  : previous);
              }
            });
        }
      },
      onEvent: event => {
        if (controller.signal.aborted) return;
        // Source snapshots must be re-fetched after events, not served from
        // a locally cached assessment that may have become historical.
        setSelectedAssessment(null);
        // Never rewrite a form being edited. Notify the user to re-open a
        // changed scenario rather than silently destroying uncommitted input.
        if (event.type === 'profile-changed') {
          setLiveNotice('Your financial profile changed. Review current inputs before evaluating again.');
          setReport(previous => previous
            ? { ...previous, run: { ...previous.run, status: 'HISTORICAL' } }
            : previous);
        } else if (event.type === 'reset') {
          setLiveNotice('Updates were missed while disconnected. Financial state has been refreshed; reopen any active scenario.');
        } else if (event.scenarioId === activeRef.current?.id) {
          setLiveNotice('A committed change is available for this scenario. Review the latest monitoring status or reopen the revision.');
          getDecisionMonitor(event.scenarioId, { signal: controller.signal })
            .then(result => {
              if (!controller.signal.aborted && activeRef.current?.id === event.scenarioId) {
                setMonitor(result.monitor);
                setAssessments(result.assessments || []);
              }
            }).catch(() => {
              if (!controller.signal.aborted) setLiveNotice('Monitoring updates could not be verified. Reopen this scenario.');
            });
        }
        refresh({ signal: controller.signal }).catch(err => {
          if (!controller.signal.aborted) setLiveNotice(`Live refresh failed: ${errorMessage(err)}`);
        });
      },
    }).catch(() => {
      if (!controller.signal.aborted) setLiveState('reconnecting');
    });
    return () => controller.abort();
  }, [refresh, authGeneration]);

  const newScenario = () => {
    loadGeneration.current += 1;
    createRequestRef.current = null;
    evaluationRequestRef.current = null;
    setPending(false);
    setActive(null);
    setType('INCOME_INTERRUPTION');
    setTitle('My income interruption plan');
    setHorizon('12');
    setBaseline(DEFAULT_BASE);
    setDetails({});
    setGoalReservations([]);
    setReport(null);
    setMonitor(null);
    setAssessments([]);
    setSelectedAssessment(null);
    setRuns([]);
    setSavedFingerprint(null);
    setError('');
    setSuccess('');
  };

  const openScenario = async scenario => {
    const generation = ++loadGeneration.current;
    setPending(true); setError(''); setSuccess(''); setReport(null); setRuns([]);
    setMonitor(null); setAssessments([]); setSelectedAssessment(null);
    try {
      const [saved, reportHistory, watching] = await Promise.all([
        getDecisionScenario(scenario.id), listDecisionRuns(scenario.id), getDecisionMonitor(scenario.id),
      ]);
      if (generation !== loadGeneration.current) return;
      setRuns(reportHistory.runs || []);
      setMonitor(watching.monitor);
      setAssessments(watching.assessments || []);
      setActive(saved.scenario);
      setType(saved.scenario.scenarioType);
      setTitle(saved.payload.title);
      setHorizon(String(saved.payload.horizonMonths));
      setBaseline(saved.payload.baseline);
      setGoalReservations(saved.payload.goalReservations);
      setDetails(saved.payload.details);
      createRequestRef.current = null;
      evaluationRequestRef.current = null;
      setSavedFingerprint(JSON.stringify({
        title: saved.payload.title, type: saved.scenario.scenarioType,
        horizon: String(saved.payload.horizonMonths),
        baseline: saved.payload.baseline, details: saved.payload.details,
        goalReservations: saved.payload.goalReservations,
      }));
      if (saved.scenario.lastRunId) {
        const loaded = await getDecisionRun(saved.scenario.lastRunId);
        if (generation === loadGeneration.current) setReport(loaded);
      }
    } catch (err) { if (generation === loadGeneration.current) setError(errorMessage(err)); }
    finally { if (generation === loadGeneration.current) setPending(false); }
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

  useEffect(() => {
    const controller = new AbortController();
    const dataReady = Boolean(availability?.available && availability?.profileId);
    if (!dataReady) {
      setDraftPreview(null);
      setPreviewState('waiting');
      return () => controller.abort();
    }
    let hypothetical;
    try {
      hypothetical = payload();
    } catch {
      // An incomplete or unreconciled form is not an invitation to invent
      // defaults or submit continuous invalid financial queries.
      setDraftPreview(null);
      setPreviewState('waiting');
      return () => controller.abort();
    }
    setDraftPreview(null);
    setPreviewState('calculating');
    const timer = setTimeout(() => {
      simulateDecisionScenario({
        ...hypothetical, profileId: availability.profileId,
        expectedProfileStateRevision: availability.profileStateRevision,
      }, { signal: controller.signal }).then(result => {
        if (controller.signal.aborted) return;
        setDraftPreview(result);
        setPreviewState('ready');
      }).catch(error => {
        if (controller.signal.aborted) return;
        setDraftPreview(null);
        setPreviewState(errorMessage(error));
      });
    }, 650);
    return () => { clearTimeout(timer); controller.abort(); };
    // Input objects are React state, and profile fields are the only
    // authoritative numbers: never loop on locally-derived preview results.
  }, [availability?.available, availability?.profileId, availability?.profileStateRevision,
    title, type, horizon, baseline, details, goalReservations]);

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
        const createInput = {
          ...values, profileId: availability.profileId,
          expectedProfileStateRevision: availability.profileStateRevision,
        };
        const key = retryKey(createRequestRef, 'decision.create', createInput);
        result = await createDecisionScenario(createInput, { headers: { 'Idempotency-Key': key } });
      }
      createRequestRef.current = null;
      evaluationRequestRef.current = null;
      setActive(result.scenario);
      setSavedFingerprint(JSON.stringify({
        title: values.title, type: values.scenarioType,
        horizon: String(values.horizonMonths), baseline: values.baseline,
        details: values.details, goalReservations: values.goalReservations,
      }));
      setReport(null);
      setRuns([]);
      setSuccess('Scenario saved. Choose Evaluate to calculate an immutable decision report.');
      await refresh();
    } catch (err) { setError(errorMessage(err)); }
    finally { setPending(false); }
  };

  const evaluate = async () => {
    if (!active) return;
    if (hasUnsavedChanges) {
      setError('Save your latest changes before evaluating this revision.');
      return;
    }
    setPending(true); setError(''); setSuccess('');
    try {
      const key = retryKey(evaluationRequestRef,
        `decision.evaluate:${active.id}`, { expectedRevision: active.revision });
      const result = await evaluateDecisionScenario(active.id, active.revision,
        { headers: { 'Idempotency-Key': key } });
      setReport(result);
      evaluationRequestRef.current = null;
      // Evaluation already committed: a secondary history failure must not
      // invite an accidental second publication.
      try {
        setRuns((await listDecisionRuns(active.id)).runs || []);
      } catch {
        setError('Report saved, but history could not be refreshed. Open this scenario again to retry loading history.');
      }
      setSuccess('A versioned report was published without changing your investments or profile.');
      await refresh();
    } catch (err) { setError(errorMessage(err)); }
    finally { setPending(false); }
  };

  const toggleMonitoring = async () => {
    if (!active || !monitor || pending || hasUnsavedChanges) return;
    setPending(true); setError(''); setSuccess('');
    try {
      const response = await setDecisionMonitor(active.id, !monitor.enabled, active.revision);
      setMonitor(response.monitor);
      setSuccess(response.monitor.enabled
        ? 'Continuous monitoring enabled. Revised financial facts will generate a signed candidate assessment, never an automatic trade.'
        : 'Continuous monitoring disabled. Existing assessments remain available for review.');
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
      <p className="gd-muted" role="status">Live updates: {liveState === 'connected' ? 'Connected' : liveState === 'unauthorized' ? 'Sign in required' : 'Reconnecting'}. Profile and scenario changes are refreshed automatically; reports are not silently recalculated.</p>
    </header>
    {initialLoading && <p role="status">Loading your private decision workspace…</p>}
    {error && <p className="gd-warning" role="alert">{error}</p>}
    {success && <p className="gd-success" role="status">{success}</p>}
    {liveNotice && <p className="gd-warning" role="status">{liveNotice}</p>}
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
          {availability?.profileFacts && <div className="gd-profile-facts" aria-label="Current profile income and savings">
            <p><strong>Verified profile inputs (user-declared, not bank-verified):</strong></p>
            <p>Monthly take-home: <strong>{prettyMoney(availability.profileFacts.monthlyTakeHome)}</strong>
              {' · '}Declared savings: <strong>{prettyMoney(availability.profileFacts.declaredMonthlySavings)}</strong>
              {' · '}Opening liquid savings: <strong>{prettyMoney(availability.profileFacts.openingLiquidCash)}</strong></p>
            <p className="gd-muted">For the scenario to reconcile, monthly living expenses + existing debt payments must equal take-home minus declared savings. Monthly investments must fit within those declared savings.</p>
          </div>}
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
          {hasUnsavedChanges && <p className="gd-warning" role="status">
            Unsaved changes detected. Save this revision before evaluating.
          </p>}
          <div className="gd-actions"><button type="submit" disabled={pending || !availability?.available}>
            {pending ? 'Working…' : active ? 'Save revision' : 'Save draft'}</button>
            {active && <button type="button" onClick={() => void evaluate()}
              disabled={pending || hasUnsavedChanges}>Evaluate saved revision</button>}
            {active && <button type="button" className="gd-danger" onClick={() => void remove()} disabled={pending}>Delete scenario</button>}
          </div>
        </form>
        {active && <section className="gd-panel" aria-label="Continuous decision monitoring">
          <h3>Continuous decision monitoring</h3>
          <p className="gd-muted">Opt in to an automatic check when your canonical financial facts change. The original signed report is never replaced. No brokerage trades, invented rates or product recommendations occur.</p>
          {monitor ? <>
            <p role="status">Monitor: {monitor.enabled ? 'Enabled' : 'Disabled'}
              {monitor.workerConfigured ? '' : ' · Background worker not configured on this deployment'}</p>
            <button type="button" disabled={pending || hasUnsavedChanges || (!monitor.workerConfigured && !monitor.enabled)}
              onClick={() => void toggleMonitoring()}>
              {monitor.enabled ? 'Disable monitoring' : 'Enable monitoring'}
            </button>
            <p className="gd-muted">New financial facts can invalidate old monthly expense assumptions. When they cannot reconcile, we ask you to review instead of manufacturing an answer.</p>
            {assessments.length > 0 && <ul>{assessments.map(item => <li key={item.id}>
              <button type="button" disabled={pending} onClick={() => setSelectedAssessment(item)}>
                {shortDate(item.asOf)} · {item.originalStatus === 'NEEDS_REVIEW' ? 'Needs review' : 'Reassessed'}
                {item.isCurrent ? ' · Current source' : ' · Historical'}
              </button>
            </li>)}</ul>}
            {selectedAssessment && <div>
              <h4>Source facts used in this reassessment</h4>
              <p className="gd-muted">An authenticated calculation is not independent verification of the data. User-declared facts have not been checked against a bank, broker or employer.</p>
              {selectedAssessment.source?.facts?.length > 0 && <ul aria-label="Financial source evidence">
                {selectedAssessment.source.facts.map(fact => <li key={fact.field}>
                  <strong>{fact.field}</strong>: ₹{fact.value} · {fact.verificationStatus}
                  {' · '}{fact.sourceType === 'USER_DECLARED' ? 'Entered by user' : fact.sourceType}
                  {' · '}{fact.rightsDecision === 'FIRST_PARTY_USER_INPUT' ? 'First-party data' : fact.rightsDecision}
                </li>)}
              </ul>}
              {selectedAssessment.originalStatus === 'NEEDS_REVIEW' && <p role="alert" className="gd-warning">
                Your newer financial facts no longer reconcile with this scenario's saved assumptions. Open a new decision scenario using your current budget.
              </p>}
              {!selectedAssessment.isCurrent && <p role="alert" className="gd-warning">
                This automatic reassessment is historical. Refresh the source facts before relying on any displayed numbers.
              </p>}
              {selectedAssessment.result && <Report report={{ run: {
                result: selectedAssessment.result, asOf: selectedAssessment.asOf,
                status: selectedAssessment.status,
              } }}/>}
            </div>}
          </> : <p className="gd-muted">Monitoring status is available after the scenario loads.</p>}
        </section>}
        {active && runs.length > 0 && <section className="gd-panel" aria-label="Past reports">
          <h3>Saved decision reports</h3>
          <p className="gd-muted">Select a report to review its immutable calculation snapshot. Older scenarios are labeled historical.</p>
          <ul>{runs.map(item => <li key={item.id}>
            <button type="button" disabled={pending} onClick={() => {
              setPending(true);
              getDecisionRun(item.id).then(result => setReport(result))
                .catch(err => setError(errorMessage(err))).finally(() => setPending(false));
            }}>Report from {shortDate(item.asOf)} · Revision {item.scenarioRevision} · {item.status}</button>
          </li>)}</ul>
        </section>}
        {(hasUnsavedChanges || !report) && previewState === 'calculating'
          && <p className="gd-muted" role="status">Recalculating an unsaved decision estimate…</p>}
        {(hasUnsavedChanges || !report) && previewState !== 'waiting'
          && previewState !== 'calculating' && previewState !== 'ready'
          && <p className="gd-muted" role="status">Live estimate unavailable: {previewState}</p>}
        <Report report={hasUnsavedChanges ? draftPreview : (report || draftPreview)}/>
      </div>
    </div>
  </div>;
}
