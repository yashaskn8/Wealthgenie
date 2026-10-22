import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FileSearch, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import * as api from '../services/api';

const cardStyle = {
  background: 'rgba(15, 23, 42, 0.7)',
  border: '1px solid rgba(56, 189, 248, 0.2)',
  borderRadius: 16,
  padding: 24,
  color: '#e2e8f0',
};
const inputStyle = {
  width: '100%',
  boxSizing: 'border-box',
  background: 'rgba(2, 6, 23, 0.7)',
  border: '1px solid rgba(148, 163, 184, 0.3)',
  borderRadius: 10,
  padding: '11px 13px',
  color: '#f8fafc',
  font: 'inherit',
};
const buttonStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  border: '1px solid rgba(56, 189, 248, 0.35)',
  borderRadius: 10,
  background: 'rgba(14, 165, 233, 0.14)',
  color: '#e0f2fe',
  padding: '10px 14px',
  font: 'inherit',
  fontWeight: 650,
  cursor: 'pointer',
};
const CURRENT_CLAIM_VERIFIER_VERSION = 'genieproof-evidence-bound/0.6.0';

function messageOf(error) {
  return error?.message || 'The request could not be completed.';
}

async function loadConsistentLatestPassport(caseId, options = {}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const saved = await api.getGenieProofCase(caseId, options);
    if (options.signal?.aborted) return null;
    const verification = await api.verifyGenieProofCase(caseId, options);
    if (options.signal?.aborted) return null;
    const passport = saved?.passport;
    if (passport?.manifest?.caseId === caseId
        && passport.manifest.revision === verification?.revision
        && passport.manifestHash === verification?.manifestHash) {
      return {
        passport,
        verification,
        currentEvidenceStatus: verification.currentEvidenceStatus ?? saved.currentEvidenceStatus ?? null,
      };
    }
  }
  throw new Error('The Passport changed while it was opening. Open it again to load the latest revision.');
}

function findingLabel(value) {
  return ({
    SUPPORTED: 'The signed report marked this claim as supported at the time of assessment',
    CONTRADICTED: 'The signed report marked this claim as contradicted at the time of assessment',
    NOT_VERIFIABLE: 'Not checked against qualified source evidence',
    INSUFFICIENT_INPUTS: 'More product details are needed',
    OUTDATED_EVIDENCE: 'The available evidence is out of date',
    OUT_OF_SCOPE: 'This claim is outside the current check',
  })[value] || 'The claim could not be checked';
}

function findingPresentationLabel(finding, manifest) {
  if (manifest?.verifierVersion !== CURRENT_CLAIM_VERIFIER_VERSION) {
    if (finding?.finding === 'SUPPORTED' || finding?.finding === 'CONTRADICTED') {
      return `Historical finding: ${findingLabel(finding.finding)}`;
    }
    return 'Historical verifier output; not reassessed under current claim rules';
  }
  if (finding?.finding === 'SUPPORTED' || finding?.finding === 'CONTRADICTED') {
    return findingLabel(finding.finding);
  }
  return findingLabel(finding?.finding);
}

const rejectedSignatureCodes = new Set([
  'PASSPORT_SIGNATURE_INVALID',
  'PASSPORT_SIGNING_KEY_REVOKED',
  'PASSPORT_SIGNING_KEY_UNTRUSTED',
  'PASSPORT_KEY_FINGERPRINT_MISMATCH',
  'PASSPORT_SIGNATURE_MALFORMED',
  'PASSPORT_MANIFEST_HASH_MISMATCH',
  'PASSPORT_MANIFEST_INVALID',
]);

function hasTrustedSignature(result) {
  return result?.integrity === 'VALID'
    && result?.signature === 'VERIFIED'
    && result?.trustedIssuer === true
    && !rejectedSignatureCodes.has(result?.code);
}

function integrityLabel(result) {
  if (result?.code === 'PASSPORT_SIGNATURE_INVALID') {
    return 'A trusted signing key was found, but the document signature is invalid. Its findings are hidden.';
  }
  if (result?.code === 'PASSPORT_SIGNING_KEY_REVOKED') {
    return 'The report was signed by a revoked key. Its findings are hidden.';
  }
  if (hasTrustedSignature(result)) return 'The report signature and case binding match a trusted key.';
  if (result?.integrity === 'INVALID') return 'The report integrity or case binding check failed.';
  if (result?.code === 'PASSPORT_SIGNING_KEY_UNTRUSTED' || result?.code === 'PASSPORT_KEY_FINGERPRINT_MISMATCH') {
    return 'The report contents match their fingerprint, but the signing key is not trusted.';
  }
  return 'The report signature could not be verified with a trusted key. Its findings are hidden.';
}

function integrityFailureLabel(result) {
  if (result?.code === 'PASSPORT_SIGNATURE_INVALID') {
    return 'The report has a trusted signing key, but its document signature is invalid. Its findings are hidden.';
  }
  if (result?.code === 'PASSPORT_SIGNING_KEY_UNTRUSTED' || result?.code === 'PASSPORT_KEY_FINGERPRINT_MISMATCH') {
    return 'The passport signing key is not trusted. Its findings are hidden.';
  }
  if (result?.code === 'PASSPORT_SIGNING_KEY_REVOKED') {
    return 'The passport signing key has been revoked. Its findings are hidden.';
  }
  return 'Passport signature could not be verified by a trusted key. Its findings are hidden.';
}

function proofBreakClaimStatusLabel(status, sourceReasonCode = null, sourceStatus = 'AVAILABLE') {
  if (sourceStatus !== 'AVAILABLE') {
    return ({
      RIGHTS_BLOCKED: sourceReasonCode === 'GENIEPROOF_SOURCE_REVOKED'
        ? 'Source reuse approval was revoked'
        : 'Source reuse approval is not recorded',
      TECHNICALLY_BLOCKED: 'Source is not technically qualified',
      WAITING: 'Waiting for a qualified source',
    })[sourceStatus] || 'Monitoring availability is unknown';
  }
  return ({
    AVAILABLE: 'Supported by an approved monitoring source',
    SOURCE_RIGHTS_BLOCKED: sourceReasonCode === 'GENIEPROOF_SOURCE_REVOKED'
      ? 'Source reuse approval was revoked'
      : 'Source reuse approval is not recorded',
    SOURCE_TECHNICALLY_BLOCKED: 'Source is not technically qualified',
    WAITING_FOR_QUALIFIED_SOURCE: 'Waiting for a qualified source',
    NOT_SUPPORTED: 'Outside the current monitoring scope',
  })[status] || 'Monitoring availability is unknown';
}

function currentEvidenceStatusLabel(status) {
  return ({
    NO_CURRENT_QUALIFIED_SOURCE: 'No currently qualified source is available.',
    SOURCE_DEFINITION_INVALID: 'The current source definition failed integrity checks.',
    SOURCE_REVOKED: 'The source qualification or reuse approval was revoked.',
    SOURCE_TECHNICALLY_BLOCKED: 'The source is blocked by technical qualification checks.',
    SOURCE_REUSE_NOT_APPROVED: 'Current source reuse approval is not recorded.',
    SOURCE_REVIEW_UNQUALIFIED: 'The current source review is incomplete.',
    SOURCE_PARSER_SUPERSEDED: 'The source parser or claim rule changed since this assessment.',
    SOURCE_DEFINITION_SUPERSEDED: 'The source definition changed since this assessment.',
    EVIDENCE_PERIOD_ENDED: 'The evidence period recorded in this assessment has ended.',
    CURRENT_SOURCE_EVIDENCE_UNAVAILABLE: 'Current evidence from the source is unavailable.',
    CURRENT_SOURCE_REASSESSMENT_REQUIRED: 'The source is currently qualified; a new assessment is needed to check current evidence.',
  })[status] || 'Current source qualification status cannot be determined.';
}

function currentEvidenceAsOfLabel(asOf) {
  if (!asOf) return 'Check time unavailable';
  const date = new Date(asOf);
  return Number.isNaN(date.getTime()) ? 'Check time unavailable' : `Checked ${date.toLocaleString()}`;
}

function CurrentEvidenceClaimStatus({ currentEvidenceStatus, claimId }) {
  const claimStatus = currentEvidenceStatus?.byClaimId?.[claimId];
  if (!claimStatus) {
    return <div style={{ color: '#fbbf24', fontSize: '0.88rem', marginTop: 6 }}>
      Current source status: unavailable for this claim.
    </div>;
  }

  const sourceRevisions = Array.isArray(claimStatus.currentSourceRevisions)
    ? claimStatus.currentSourceRevisions
    : [];
  return <div style={{ color: '#bae6fd', fontSize: '0.88rem', marginTop: 6 }}>
    <span><strong>Current source status:</strong> {currentEvidenceStatusLabel(claimStatus.status)} {currentEvidenceAsOfLabel(currentEvidenceStatus.asOf)}.</span>
    {sourceRevisions.length > 0 && <details style={{ marginTop: 4, color: '#94a3b8' }}>
      <summary>Source revision details</summary>
      <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
        {sourceRevisions.map((source, index) => <li key={`${source.sourceId || 'source'}-${index}`}>
          {source.sourceId || 'Source not identified'}: {currentEvidenceStatusLabel(source.status)} Current source revision {source.currentSourceRevision ?? 'unavailable'}; assessment used revision {source.recordedSourceRevision ?? 'not recorded'}.
        </li>)}
      </ul>
    </details>}
  </div>;
}

function CurrentEvidenceManifestStatus({ currentEvidenceStatus, manifest }) {
  const claimIds = [...new Set((manifest?.findings || []).map(finding => finding.claimId))];
  if (claimIds.length === 0) {
    return <div style={{ color: '#fbbf24', fontSize: '0.88rem' }}>Current source status is unavailable because this revision has no claim findings.</div>;
  }
  return <div style={{ display: 'grid', gap: 4 }}>
    {claimIds.map(claimId => <CurrentEvidenceClaimStatus
      key={claimId}
      currentEvidenceStatus={currentEvidenceStatus}
      claimId={claimId}
    />)}
  </div>;
}

function proofBreakEventLabel(eventType) {
  return ({
    EVIDENCE_CHANGED: 'A qualified financial fact changed',
    EVIDENCE_EXPIRED: 'The evidence period ended',
    FINDING_CHANGED: 'The claim finding changed',
    CONDITIONS_CHANGED: 'Evidence conditions changed',
    SOURCE_UNAVAILABLE: 'The source could not be reached or checked',
    PROCESSING_FAILED: 'A background check could not be completed',
    POLICY_REVIEW_REQUIRED: 'Source policy review is required',
    RECHECK_UNCHANGED: 'The scheduled check found no change',
  })[eventType] || 'A ProofBreak check was recorded';
}

function proofBreakTimelineStatusLabel(status) {
  return ({
    PENDING: 'being published',
    DELIVERED: 'published in this account',
    NOT_REQUIRED: 'not needed for an unchanged check',
    FAILED: 'could not be published',
    CANCELLED: 'cancelled',
  })[status] || 'status unknown';
}

function isTerminalProofWatch(watch) {
  return ['CANCELLED', 'DISABLED', 'EXPIRED'].includes(String(watch?.status || '').toUpperCase());
}

function selectCurrentProofWatch(watches) {
  const records = Array.isArray(watches) ? watches : [];
  return records.find(watch => !isTerminalProofWatch(watch)) || records[0] || null;
}

function prepareClaim(candidate) {
  return {
    claimId: candidate.claimId,
    statement: candidate.originalSpan,
    claimType: candidate.claimType === 'CURRENT_NOMINAL_RATE' ? candidate.claimType : 'UNSUPPORTED',
    productId: candidate.productId,
    value: Number.isFinite(candidate.value) ? candidate.value : null,
    unit: candidate.unit === 'PERCENT_PER_ANNUM' ? candidate.unit : 'UNKNOWN',
  };
}

function downloadPassport(signedPassport) {
  const caseId = signedPassport?.manifest?.caseId;
  const revision = signedPassport?.manifest?.revision;
  if (!caseId || !Number.isInteger(revision)) return false;
  const file = new Blob([JSON.stringify(signedPassport, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = `wealthgenie-genieproof-${caseId}-r${revision}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return true;
}

function stableMutationKey(requestRef, payload) {
  const requestFingerprint = JSON.stringify(payload);
  if (!requestRef.current || requestRef.current.requestFingerprint !== requestFingerprint) {
    requestRef.current = {
      requestFingerprint,
      key: crypto.randomUUID(),
    };
  }
  return requestRef.current.key;
}

export default function GenieProofPanel() {
  const [offerText, setOfferText] = useState('');
  const [extraction, setExtraction] = useState(null);
  const [claims, setClaims] = useState([]);
  const [confirmed, setConfirmed] = useState(false);
  const [savingConsent, setSavingConsent] = useState(false);
  const [savedCases, setSavedCases] = useState([]);
  const [selected, setSelected] = useState(null);
  const [selectedCurrentEvidenceStatus, setSelectedCurrentEvidenceStatus] = useState(null);
  const [revisionHistory, setRevisionHistory] = useState(null);
  const [comparison, setComparison] = useState(null);
  const [integrityByCase, setIntegrityByCase] = useState({});
  const [pendingDeleteCaseId, setPendingDeleteCaseId] = useState(null);
  const [proofBreakByCase, setProofBreakByCase] = useState({});
  const [watchConsentByCase, setWatchConsentByCase] = useState({});
  const [reassessmentConsent, setReassessmentConsent] = useState(false);
  const [pendingConsentWithdrawalCaseId, setPendingConsentWithdrawalCaseId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setErrorMessage] = useState('');
  const [status, setStatus] = useState('');
  const mountedRef = useRef(false);
  const viewGenerationRef = useRef(0);
  const activeViewRequestRef = useRef(null);
  const caseListRequestRef = useRef(null);
  const proofBreakRequestByCaseRef = useRef(new Map());
  const createCaseMutationRef = useRef(null);
  const reassessMutationRef = useRef(null);
  const errorSourceRef = useRef(null);

  const setError = useCallback(message => {
    errorSourceRef.current = message ? 'operation' : null;
    setErrorMessage(message);
  }, []);
  const setListError = useCallback(message => {
    if (errorSourceRef.current === 'operation') return;
    errorSourceRef.current = 'list';
    setErrorMessage(message);
  }, []);
  const clearListError = useCallback(() => {
    if (errorSourceRef.current !== 'list') return;
    errorSourceRef.current = null;
    setErrorMessage('');
  }, []);

  const beginViewRequest = ({ allowNavigation = false } = {}) => {
    activeViewRequestRef.current?.controller.abort();
    const request = { controller: new AbortController(), allowNavigation };
    activeViewRequestRef.current = request;
    viewGenerationRef.current += 1;
    return request;
  };
  const isViewRequestCurrent = request => mountedRef.current && activeViewRequestRef.current === request
    && !request.controller.signal.aborted;
  const finishViewRequest = request => {
    if (!isViewRequestCurrent(request)) return false;
    activeViewRequestRef.current = null;
    return true;
  };
  const invalidateViewRequest = () => {
    activeViewRequestRef.current?.controller.abort();
    activeViewRequestRef.current = null;
    viewGenerationRef.current += 1;
  };
  const beginProofBreakRequest = caseId => {
    proofBreakRequestByCaseRef.current.get(caseId)?.controller.abort();
    const request = { controller: new AbortController() };
    proofBreakRequestByCaseRef.current.set(caseId, request);
    return request;
  };
  const isProofBreakRequestCurrent = (caseId, request) => mountedRef.current
    && proofBreakRequestByCaseRef.current.get(caseId) === request
    && !request.controller.signal.aborted;

  const reloadCases = useCallback(async () => {
    caseListRequestRef.current?.controller.abort();
    const request = { controller: new AbortController() };
    caseListRequestRef.current = request;
    clearListError();
    try {
      const result = await api.listGenieProofCases({ signal: request.controller.signal });
      if (!mountedRef.current || caseListRequestRef.current !== request || request.controller.signal.aborted) return;
      setSavedCases(result.cases || []);
      clearListError();
    } catch (loadError) {
      if (mountedRef.current && caseListRequestRef.current === request && !request.controller.signal.aborted) {
        setListError(messageOf(loadError));
      }
    }
  }, [clearListError, setListError]);

  const loadProofBreak = async (caseId, { append = false } = {}) => {
    const request = beginProofBreakRequest(caseId);
    setProofBreakByCase(current => ({ ...current, [caseId]: { ...current[caseId], loading: true, error: '' } }));
    const cursor = append ? proofBreakByCase[caseId]?.nextCursor : null;
    const [availabilityResult, watchResult, timeline] = await Promise.allSettled([
      api.getProofWatchAvailability(caseId, { signal: request.controller.signal }),
      api.listProofWatches({ caseId, limit: 10 }, { signal: request.controller.signal }),
      api.listProofBreakEvents(caseId, { limit: 10, cursor }, { signal: request.controller.signal }),
    ]);
    if (!isProofBreakRequestCurrent(caseId, request)) return false;
    const watchSucceeded = watchResult.status === 'fulfilled';
    const timelineSucceeded = timeline.status === 'fulfilled';
    const consentWithdrawnByServer = availabilityResult.status === 'rejected'
      && availabilityResult.reason?.code === 'GENIEPROOF_CONSENT_WITHDRAWN';
    if (consentWithdrawnByServer) {
      setPendingConsentWithdrawalCaseId(current => current === caseId ? null : current);
      setWatchConsentByCase(consent => ({ ...consent, [caseId]: false }));
    }
    const currentWatch = watchSucceeded ? selectCurrentProofWatch(watchResult.value.watches) : null;
    if (watchSucceeded && isTerminalProofWatch(currentWatch)) {
      setWatchConsentByCase(consent => ({ ...consent, [caseId]: false }));
    }
    setProofBreakByCase(current => {
      const previous = current[caseId] || {};
      const watch = watchSucceeded ? currentWatch : previous.watch || null;
      const consentWithdrawn = consentWithdrawnByServer
        || (availabilityResult.status === 'rejected' && previous.consentWithdrawn === true);
      const newEvents = timelineSucceeded ? timeline.value.events || [] : [];
      const events = append
        ? [...(previous.events || []), ...newEvents.filter(event => !(previous.events || []).some(existing => existing.eventId === event.eventId))]
        : timelineSucceeded ? newEvents : previous.events || [];
      const dataError = [watchResult, timeline].find(result => result.status === 'rejected');
      return {
        ...current,
        [caseId]: {
          ...previous,
          loading: false,
          error: dataError ? messageOf(dataError.reason) : '',
          availability: availabilityResult.status === 'fulfilled' ? availabilityResult.value : null,
          availabilityNotice: consentWithdrawn
            ? 'Private processing consent is withdrawn. Future monitoring checks are off.'
            : availabilityResult.status === 'rejected'
              ? 'Current monitoring availability cannot be shown; saved watch history remains available.'
              : '',
          consentWithdrawn,
          watch,
          events,
          nextCursor: timelineSucceeded ? timeline.value.nextCursor || null : previous.nextCursor || null,
        },
      };
    });
    return true;
  };

  const enableProofBreak = async caseId => {
    const availability = proofBreakByCase[caseId]?.availability;
    if (proofBreakByCase[caseId]?.consentWithdrawn
        || !watchConsentByCase[caseId]
        || availability?.sourceStatus !== 'AVAILABLE'
        || !availability.canEnable) return;
    const viewGeneration = viewGenerationRef.current;
    const request = beginProofBreakRequest(caseId);
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const result = await api.createProofWatch(caseId, { signal: request.controller.signal });
      if (!isProofBreakRequestCurrent(caseId, request)) return;
      const refreshed = await loadProofBreak(caseId);
      if (!refreshed || !mountedRef.current || viewGenerationRef.current !== viewGeneration) return;
      setStatus(result.watch?.status === 'ACTIVE'
        ? 'ProofBreak watch enabled for the supported claims shown above.'
        : `ProofBreak watch saved with status ${result.watch?.status || 'unavailable'}.`);
      setWatchConsentByCase(current => ({ ...current, [caseId]: false }));
      setProofBreakByCase(current => ({
        ...current,
        [caseId]: { ...current[caseId], consentWithdrawn: false },
      }));
    } catch (watchError) {
      if (isProofBreakRequestCurrent(caseId, request) && viewGenerationRef.current === viewGeneration) setError(messageOf(watchError));
    } finally {
      if (mountedRef.current && viewGenerationRef.current === viewGeneration) setBusy(false);
    }
  };

  const updateProofBreak = async (caseId, watchId, action) => {
    const viewGeneration = viewGenerationRef.current;
    const request = beginProofBreakRequest(caseId);
    setBusy(true);
    setError('');
    try {
      await api.updateProofWatch(watchId, action, { signal: request.controller.signal });
      if (!isProofBreakRequestCurrent(caseId, request)) return;
      const refreshed = await loadProofBreak(caseId);
      if (!refreshed || !mountedRef.current || viewGenerationRef.current !== viewGeneration) return;
      setStatus(action === 'pause' ? 'ProofBreak checks paused.' : action === 'resume' ? 'ProofBreak watch status refreshed.' : 'ProofBreak checks disabled.');
      if (action === 'disable') setWatchConsentByCase(current => ({ ...current, [caseId]: false }));
    } catch (watchError) {
      if (isProofBreakRequestCurrent(caseId, request) && viewGenerationRef.current === viewGeneration) setError(messageOf(watchError));
    } finally {
      if (mountedRef.current && viewGenerationRef.current === viewGeneration) setBusy(false);
    }
  };

  const removeProofBreak = async (caseId, watchId) => {
    const viewGeneration = viewGenerationRef.current;
    const request = beginProofBreakRequest(caseId);
    setBusy(true);
    setError('');
    try {
      await api.deleteProofWatch(watchId, { signal: request.controller.signal });
      if (!isProofBreakRequestCurrent(caseId, request)) return;
      const refreshed = await loadProofBreak(caseId);
      if (!refreshed || !mountedRef.current || viewGenerationRef.current !== viewGeneration) return;
      setStatus('ProofBreak watch and its timeline were deleted.');
    } catch (watchError) {
      if (isProofBreakRequestCurrent(caseId, request) && viewGenerationRef.current === viewGeneration) setError(messageOf(watchError));
    } finally {
      if (mountedRef.current && viewGenerationRef.current === viewGeneration) setBusy(false);
    }
  };

  const acknowledgeProofBreak = async (caseId, eventId) => {
    const viewGeneration = viewGenerationRef.current;
    const request = beginProofBreakRequest(caseId);
    setBusy(true);
    setError('');
    try {
      await api.acknowledgeProofBreakEvent(eventId, { signal: request.controller.signal });
      if (!isProofBreakRequestCurrent(caseId, request)) return;
      const refreshed = await loadProofBreak(caseId);
      if (!refreshed || !mountedRef.current || viewGenerationRef.current !== viewGeneration) return;
    } catch (ackError) {
      if (isProofBreakRequestCurrent(caseId, request) && viewGenerationRef.current === viewGeneration) setError(messageOf(ackError));
    } finally {
      if (mountedRef.current && viewGenerationRef.current === viewGeneration) setBusy(false);
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    const proofBreakRequests = proofBreakRequestByCaseRef.current;
    void reloadCases();
    return () => {
      mountedRef.current = false;
      activeViewRequestRef.current?.controller.abort();
      caseListRequestRef.current?.controller.abort();
      proofBreakRequests.forEach(request => request.controller.abort());
    };
  }, [reloadCases]);

  const extract = async () => {
    const request = beginViewRequest({ allowNavigation: true });
    setBusy(true);
    setError('');
    setStatus('');
    setExtraction(null);
    setClaims([]);
    setConfirmed(false);
    setSavingConsent(false);
    setSelected(null);
    setSelectedCurrentEvidenceStatus(null);
    setRevisionHistory(null);
    setComparison(null);
    setIntegrityByCase({});
    setPendingDeleteCaseId(null);
    try {
      const result = await api.extractGenieProofClaims(offerText, { signal: request.controller.signal });
      if (!isViewRequestCurrent(request)) return;
      setExtraction(result);
      setClaims((result.claims || []).map(prepareClaim));
      setStatus('Review each extracted statement and interpretation before saving a private passport.');
    } catch (extractError) {
      if (isViewRequestCurrent(request)) setError(messageOf(extractError));
    } finally {
      if (finishViewRequest(request)) setBusy(false);
    }
  };

  const loadRevisionHistory = async caseId => {
    const request = beginViewRequest({ allowNavigation: true });
    setBusy(true);
    setError('');
    setStatus('');
    setSelected(null);
    setSelectedCurrentEvidenceStatus(null);
    setReassessmentConsent(false);
    setRevisionHistory(null);
    setComparison(null);
    try {
      const history = await api.listGenieProofRevisions(caseId, { signal: request.controller.signal });
      if (!isViewRequestCurrent(request)) return;
      setRevisionHistory(history);
    } catch (historyError) {
      if (isViewRequestCurrent(request)) setError(messageOf(historyError));
    } finally {
      if (finishViewRequest(request)) setBusy(false);
    }
  };

  const openRevision = revision => {
    invalidateViewRequest();
    setBusy(false);
    setReassessmentConsent(false);
    const verification = revision.verification;
    if (!hasTrustedSignature(verification)) {
      setError(`Revision ${revision.revision} failed trusted signature or case-binding verification. Its findings are hidden.`);
      setSelected(null);
      setSelectedCurrentEvidenceStatus(null);
      setComparison(null);
      setStatus('');
      return;
    }
    setError('');
    setSelected(revision.passport);
    setSelectedCurrentEvidenceStatus(revision.currentEvidenceStatus ?? null);
    setComparison(null);
    setStatus('');
    setStatus(`Revision ${revision.revision} has a verified document signature. Financial correctness is not established by that signature.`);
  };

  const compareRevisions = (older, newer) => {
    invalidateViewRequest();
    setBusy(false);
    const isTrusted = revision => hasTrustedSignature(revision?.verification);
    if (!isTrusted(older) || !isTrusted(newer)) {
      setComparison(null);
      setError('Both report signatures and case bindings must verify with a trusted key before comparing findings.');
      return;
    }
    setError('');
    setStatus('');
    setComparison({ older, newer });
  };

  const removeClaim = claimId => {
    invalidateViewRequest();
    setBusy(false);
    setConfirmed(false);
    setSavingConsent(false);
    setClaims(current => current.filter(claim => claim.claimId !== claimId));
  };

  const savePassport = async () => {
    if (!extraction || extraction.claimsTruncated || !confirmed || !savingConsent || claims.length === 0) return;
    const request = beginViewRequest();
    const payload = {
      offerText,
      submissionHash: extraction.inputHash,
      savingConsent: true,
      confirmedClaims: claims,
    };
    const idempotencyKey = stableMutationKey(createCaseMutationRef, payload);
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await api.createGenieProofCase(payload, {
        signal: request.controller.signal,
        headers: { 'Idempotency-Key': idempotencyKey },
      });
      createCaseMutationRef.current = null;
      if (!isViewRequestCurrent(request)) return;
      setSelected(null);
      setSelectedCurrentEvidenceStatus(null);
      setOfferText('');
      setExtraction(null);
      setClaims([]);
      setConfirmed(false);
      setSavingConsent(false);
      setStatus('Private claim record saved. Verify its trusted signature before viewing findings; a signature does not establish financial correctness.');
      await reloadCases();
    } catch (saveError) {
      if (isViewRequestCurrent(request)) setError(messageOf(saveError));
    } finally {
      if (finishViewRequest(request)) setBusy(false);
    }
  };

  const openCase = async caseId => {
    const request = beginViewRequest({ allowNavigation: true });
    setBusy(true);
    setError('');
    setStatus('');
    setSelected(null);
    setSelectedCurrentEvidenceStatus(null);
    setReassessmentConsent(false);
    setRevisionHistory(null);
    setComparison(null);
    try {
      const opened = await loadConsistentLatestPassport(caseId, { signal: request.controller.signal });
      if (!isViewRequestCurrent(request) || !opened) return;
      const { passport, verification, currentEvidenceStatus } = opened;
      setIntegrityByCase(current => ({ ...current, [caseId]: verification }));
      if (!hasTrustedSignature(verification)) {
        setError(integrityFailureLabel(verification));
        return;
      }
      setSelected(passport);
      setSelectedCurrentEvidenceStatus(currentEvidenceStatus);
      setRevisionHistory(null);
      setStatus('The stored report signature is verified. This does not establish financial correctness.');
    } catch (openError) {
      if (isViewRequestCurrent(request)) setError(messageOf(openError));
    } finally {
      if (finishViewRequest(request)) setBusy(false);
    }
  };

  const checkIntegrity = async caseId => {
    const request = beginViewRequest({ allowNavigation: true });
    setBusy(true);
    setError('');
    setStatus('');
    setIntegrityByCase(current => {
      const next = { ...current };
      delete next[caseId];
      return next;
    });
    try {
      const result = await api.verifyGenieProofCase(caseId, { signal: request.controller.signal });
      if (!isViewRequestCurrent(request)) return;
      setIntegrityByCase(current => ({ ...current, [caseId]: result }));
      if (selected?.manifest?.caseId === caseId && selected.manifest.revision === result.revision && result.currentEvidenceStatus) {
        setSelectedCurrentEvidenceStatus(result.currentEvidenceStatus);
      }
    } catch (verifyError) {
      if (isViewRequestCurrent(request)) setError(messageOf(verifyError));
    } finally {
      if (finishViewRequest(request)) setBusy(false);
    }
  };

  const reassessSelectedCase = async () => {
    const caseId = selected?.manifest?.caseId;
    if (!caseId || !reassessmentConsent) return;
    const request = beginViewRequest();
    const payload = {
      caseId,
      expectedRevision: selected.manifest.revision,
      expectedManifestHash: selected.manifestHash,
      reassessmentConsent: true,
    };
    const idempotencyKey = stableMutationKey(reassessMutationRef, payload);
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const result = await api.reassessGenieProofCase(payload, {
        signal: request.controller.signal,
        headers: { 'Idempotency-Key': idempotencyKey },
      });
      if (!isViewRequestCurrent(request)) return;
      const [verified, history, caseResult] = await Promise.all([
        loadConsistentLatestPassport(caseId, { signal: request.controller.signal }),
        api.listGenieProofRevisions(caseId, { signal: request.controller.signal }),
        api.listGenieProofCases({ signal: request.controller.signal }),
      ]);
      if (!isViewRequestCurrent(request)) return;
      const { passport, verification, currentEvidenceStatus } = verified;
      setSavedCases(caseResult.cases || []);
      setRevisionHistory(history);
      setIntegrityByCase(current => ({ ...current, [caseId]: verification }));
      if (hasTrustedSignature(verification)) {
        setSelected(passport);
        setSelectedCurrentEvidenceStatus(currentEvidenceStatus);
        const revisionMessage = result.revision === passport.manifest.revision
          ? `Private assessment revision ${result.revision} was saved.`
          : `Private assessment revision ${result.revision} was saved; showing newer verified revision ${passport.manifest.revision}.`;
        setStatus(`${revisionMessage} Its signature does not establish financial correctness.`);
      } else {
        setSelected(null);
        setSelectedCurrentEvidenceStatus(null);
        setError('The new revision was saved, but its trusted signature could not be verified. Its findings are hidden.');
      }
      setReassessmentConsent(false);
    } catch (reassessError) {
      if (isViewRequestCurrent(request)) setError(messageOf(reassessError));
    } finally {
      if (finishViewRequest(request)) setBusy(false);
    }
  };

  const withdrawConsent = async caseId => {
    const request = beginViewRequest();
    proofBreakRequestByCaseRef.current.get(caseId)?.controller.abort();
    proofBreakRequestByCaseRef.current.set(caseId, request);
    setBusy(true);
    setError('');
    try {
      await api.withdrawGenieProofConsent(caseId, { signal: request.controller.signal });
      if (!isViewRequestCurrent(request)) return;
      setPendingConsentWithdrawalCaseId(null);
      setWatchConsentByCase(current => ({ ...current, [caseId]: false }));
      setProofBreakByCase(current => {
        const previous = current[caseId] || {};
        return {
          ...current,
          [caseId]: {
            ...previous,
            availability: null,
            availabilityNotice: 'Private processing consent is withdrawn. Future monitoring checks are off.',
            consentWithdrawn: true,
            watch: previous.watch ? { ...previous.watch, status: 'CANCELLED', nextCheckAt: null } : null,
          },
        };
      });
      setStatus('Private processing consent was withdrawn. Future reassessments and monitoring checks were cancelled. Delete the case separately to remove it from active storage.');
      const [watchResult, timeline] = await Promise.allSettled([
        api.listProofWatches({ caseId, limit: 10 }, { signal: request.controller.signal }),
        api.listProofBreakEvents(caseId, { limit: 10 }, { signal: request.controller.signal }),
      ]);
      if (!isViewRequestCurrent(request) || !isProofBreakRequestCurrent(caseId, request)) return;
      setProofBreakByCase(current => {
        const previous = current[caseId] || {};
        const watchReadFailed = watchResult.status === 'rejected';
        const timelineReadFailed = timeline.status === 'rejected';
        const refreshedWatch = watchReadFailed ? null : selectCurrentProofWatch(watchResult.value.watches);
        const withdrawnWatch = refreshedWatch || previous.watch;
        return {
          ...current,
          [caseId]: {
            ...previous,
            availability: null,
            availabilityNotice: watchReadFailed || timelineReadFailed
              ? `Consent is withdrawn and future checks are off. ${[
                watchReadFailed ? 'The latest watch status could not be refreshed.' : '',
                timelineReadFailed ? 'The saved event history could not be refreshed.' : '',
              ].filter(Boolean).join(' ')}`
              : 'Private processing consent is withdrawn. Future monitoring checks are off.',
            consentWithdrawn: true,
            watch: withdrawnWatch ? { ...withdrawnWatch, status: 'CANCELLED', nextCheckAt: null } : null,
            events: timelineReadFailed ? previous.events || [] : timeline.value.events || [],
            nextCursor: timelineReadFailed ? previous.nextCursor || null : timeline.value.nextCursor || null,
          },
        };
      });
    } catch (withdrawError) {
      if (isViewRequestCurrent(request)) setError(messageOf(withdrawError));
    } finally {
      if (finishViewRequest(request)) setBusy(false);
    }
  };

  const deleteCase = async caseId => {
    const request = beginViewRequest();
    setBusy(true);
    setError('');
    try {
      await api.deleteGenieProofCase(caseId, { signal: request.controller.signal });
      if (!isViewRequestCurrent(request)) return;
      if (selected?.manifest?.caseId === caseId) {
        setSelected(null);
        setSelectedCurrentEvidenceStatus(null);
      }
      if (revisionHistory?.caseId === caseId) setRevisionHistory(null);
      if (comparison?.older?.passport?.manifest?.caseId === caseId
          || comparison?.newer?.passport?.manifest?.caseId === caseId) setComparison(null);
      setIntegrityByCase(current => {
        const next = { ...current };
        delete next[caseId];
        return next;
      });
      setPendingDeleteCaseId(null);
      setPendingConsentWithdrawalCaseId(null);
      setProofBreakByCase(current => {
        const next = { ...current };
        delete next[caseId];
        return next;
      });
      await reloadCases();
      if (!isViewRequestCurrent(request)) return;
      setStatus('The case and its passport revisions were deleted from active app storage. Backups may follow separate retention schedules.');
    } catch (deleteError) {
      if (isViewRequestCurrent(request)) setError(messageOf(deleteError));
    } finally {
      if (finishViewRequest(request)) setBusy(false);
    }
  };

  const offerBytes = new Blob([offerText]).size;
  const byteLimitMessage = offerBytes > 16000
    ? 'The offer exceeds the 16,000-byte extraction limit. Shorten the text before extracting claims.'
    : '';

  return (
    <div data-testid="genieproof-panel" style={{ maxWidth: 1000, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
      <section style={cardStyle} aria-labelledby="genieproof-intro-title">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <ShieldCheck size={21} color="#38bdf8" aria-hidden="true" />
          <h2 id="genieproof-intro-title" style={{ fontSize: '1.2rem', fontWeight: 700, margin: 0, color: '#f8fafc' }}>GenieProof claim inspection</h2>
        </div>
        <p style={{ margin: '0 0 10px', color: '#cbd5e1', lineHeight: 1.6 }}>
          Review candidate statements and keep a signed, private record. Source availability is checked for each supported claim; when qualified evidence is unavailable, GenieProof records an abstention bound to the verifier version.
        </p>
        <p style={{ margin: 0, color: '#94a3b8', lineHeight: 1.55, fontSize: '0.88rem' }}>
          Claim extraction is bounded and may miss statements. Compare the candidates with the full offer; an empty list does not mean the offer contains no financial claims. A signed report does not establish offer legitimacy, investment safety, or suitability. Monitoring is off until a supported source and worker are available and you give separate consent.
        </p>
      </section>

      <section style={cardStyle} aria-labelledby="genieproof-submit-title">
        <h2 id="genieproof-submit-title" style={{ fontSize: '1.05rem', margin: '0 0 12px', color: '#f8fafc' }}>Review an offer</h2>
        <label htmlFor="genieproof-offer" style={{ display: 'block', marginBottom: 8, color: '#cbd5e1' }}>Paste the offer text</label>
        <textarea
          id="genieproof-offer"
          value={offerText}
          disabled={busy}
          onChange={event => {
            invalidateViewRequest();
            setBusy(false);
            setOfferText(event.target.value);
            setExtraction(null);
            setClaims([]);
            setConfirmed(false);
            setSavingConsent(false);
            setSelected(null);
            setSelectedCurrentEvidenceStatus(null);
            setReassessmentConsent(false);
            setRevisionHistory(null);
            setComparison(null);
            setIntegrityByCase({});
            setError('');
            setStatus('');
          }}
          aria-describedby="genieproof-offer-guidance genieproof-byte-count genieproof-byte-status"
          rows={5}
          style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5 }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginTop: 10, flexWrap: 'wrap' }}>
          <span id="genieproof-offer-guidance" style={{ color: '#94a3b8', fontSize: '0.83rem' }}>The full offer is processed but not persisted. Saved cases are limited to 25 per account and expire 90 days after saving. Database cleanup may happen shortly after expiry; backups may follow separate retention schedules.</span>
          <span id="genieproof-byte-count" style={{ color: '#94a3b8', fontSize: '0.83rem' }}>{offerBytes.toLocaleString()} / 16,000 UTF-8 bytes.</span>
          <span id="genieproof-byte-status" role="status" aria-live="polite" aria-atomic="true" style={{ color: '#fbbf24', fontSize: '0.83rem' }}>{byteLimitMessage}</span>
          <button type="button" style={buttonStyle} onClick={() => void extract()} disabled={busy || !offerText.trim() || offerBytes > 16000} aria-describedby="genieproof-byte-count genieproof-byte-status">
            <FileSearch size={16} aria-hidden="true" /> {busy ? 'Working…' : 'Extract claims'}
          </button>
        </div>
      </section>

      {extraction && (
        <section style={cardStyle} aria-labelledby="genieproof-confirm-title">
          <h2 id="genieproof-confirm-title" style={{ fontSize: '1.05rem', margin: '0 0 8px', color: '#f8fafc' }}>Confirm the exact claims</h2>
          <p style={{ margin: '0 0 14px', color: '#94a3b8', lineHeight: 1.5 }}>
            Review the exact extracted wording and remove any statement that does not match the offer. Edit the offer above and extract again to correct it. Nothing is assessed until you confirm this review.
          </p>
          {extraction.claimsTruncated && <p role="alert" style={{ color: '#fbbf24' }}>This offer contains {extraction.omittedClaimCount} additional claim statement(s) beyond the review limit. Shorten the text and extract again before saving so no claims are hidden.</p>}
          {claims.length === 0 && <p role="status" style={{ color: '#fbbf24' }}>No claim candidate was extracted. Nothing will be assessed.</p>}
          {claims.map((claim, index) => (
            <fieldset key={claim.claimId} style={{ border: '1px solid rgba(148, 163, 184, 0.22)', borderRadius: 12, padding: 14, margin: '12px 0', minWidth: 0 }}>
              <legend style={{ padding: '0 6px', color: '#bae6fd' }}>Statement {index + 1}</legend>
              <label htmlFor={`genieproof-statement-${claim.claimId}`} style={{ display: 'block', marginBottom: 6, color: '#cbd5e1' }}>Claim wording</label>
              <textarea
                id={`genieproof-statement-${claim.claimId}`}
                value={claim.statement}
                readOnly
                maxLength={500}
                rows={2}
                style={{ ...inputStyle, resize: 'vertical' }}
              />
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginTop: 10 }}>
                <label style={{ color: '#cbd5e1', fontSize: '0.9rem' }}>Interpretation
                  <select value={claim.claimType} disabled style={{ ...inputStyle, display: 'block', marginTop: 6 }}>
                    <option value="UNSUPPORTED">Unsupported / unclear</option>
                    <option value="CURRENT_NOMINAL_RATE">Current nominal annual rate</option>
                  </select>
                </label>
                <label style={{ color: '#cbd5e1', fontSize: '0.9rem' }}>Product identity
                  <select value={claim.productId || ''} disabled style={{ ...inputStyle, display: 'block', marginTop: 6 }}>
                    <option value="">Not established</option>
                    <option value="government:india-post:ppf">Public Provident Fund (PPF)</option>
                  </select>
                </label>
                <label style={{ color: '#cbd5e1', fontSize: '0.9rem' }}>Rate value (%)
                  <input type="number" min="0" max="100" step="0.0001" value={claim.value ?? ''} disabled style={{ ...inputStyle, display: 'block', marginTop: 6 }} />
                </label>
              </div>
              <button type="button" onClick={() => removeClaim(claim.claimId)} disabled={busy} style={{ ...buttonStyle, marginTop: 10, color: '#fecaca', borderColor: 'rgba(248,113,113,.35)', background: 'rgba(127,29,29,.18)' }}>Remove claim</button>
            </fieldset>
          ))}
          {claims.length > 0 && (
            <>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, margin: '14px 0', color: '#cbd5e1', lineHeight: 1.45 }}>
                <input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />
                I reviewed the exact wording and interpretation above.
              </label>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 9, margin: '14px 0', color: '#cbd5e1', lineHeight: 1.45 }}>
                <input type="checkbox" checked={savingConsent} disabled={busy} onChange={event => setSavingConsent(event.target.checked)} />
                I consent to save the confirmed claim wording and fingerprint in this private account for up to 90 days or until I delete the case. I understand backup copies may follow separate retention schedules.
              </label>
              <button type="button" style={buttonStyle} onClick={() => void savePassport()} disabled={busy || extraction.claimsTruncated || !confirmed || !savingConsent}>
                <ShieldCheck size={16} aria-hidden="true" /> Save private passport
              </button>
            </>
          )}
        </section>
      )}

      <section style={cardStyle} aria-labelledby="genieproof-saved-title">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <h2 id="genieproof-saved-title" style={{ fontSize: '1.05rem', margin: 0, color: '#f8fafc' }}>Your saved passports</h2>
          <button type="button" style={buttonStyle} onClick={() => void reloadCases()} disabled={busy}><RefreshCw size={15} aria-hidden="true" /> Refresh</button>
        </div>
        {savedCases.length === 0
          ? <p style={{ color: '#94a3b8', marginBottom: 0 }}>No saved cases yet.</p>
          : <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0', display: 'grid', gap: 10 }}>
            {savedCases.map(saved => (
              <li key={saved.caseId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', borderTop: '1px solid rgba(148, 163, 184, 0.16)', paddingTop: 12 }}>
                <span style={{ minWidth: 180 }}>
                  Revision {saved.revision} · {saved.claimCount} claim{saved.claimCount === 1 ? '' : 's'}
                  {saved.expiresAt && <small style={{ display: 'block', color: '#94a3b8' }}>Expires {new Date(saved.expiresAt).toLocaleDateString()}</small>}
                  <small style={{ display: 'block', color: '#94a3b8', overflowWrap: 'anywhere' }}>{saved.manifestHash}</small>
                </span>
                <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button type="button" style={buttonStyle} onClick={() => void openCase(saved.caseId)} disabled={busy && !activeViewRequestRef.current?.allowNavigation}>Open</button>
                  <button type="button" style={buttonStyle} onClick={() => void loadRevisionHistory(saved.caseId)} disabled={busy && !activeViewRequestRef.current?.allowNavigation}>Assessment history</button>
                  <button type="button" style={buttonStyle} onClick={() => void checkIntegrity(saved.caseId)} disabled={busy && !activeViewRequestRef.current?.allowNavigation}>Verify integrity</button>
                  <button type="button" style={buttonStyle} onClick={() => void loadProofBreak(saved.caseId)} disabled={busy}>ProofBreak status &amp; timeline</button>
                  <button type="button" style={{ ...buttonStyle, color: '#fecaca', borderColor: 'rgba(248,113,113,.35)' }} onClick={() => setPendingDeleteCaseId(saved.caseId)} disabled={busy} aria-label={`Delete passport revision ${saved.revision}`}><Trash2 size={15} aria-hidden="true" /> Delete</button>
                </span>
                {proofBreakByCase[saved.caseId] && <div role="region" aria-label={`ProofBreak status and timeline for revision ${saved.revision}`} style={{ flexBasis: '100%', display: 'grid', gap: 10, padding: 14, border: '1px solid rgba(56,189,248,.18)', borderRadius: 12, color: '#cbd5e1' }}>
                  <strong style={{ color: '#f8fafc' }}>ProofBreak status and timeline</strong>
                  {proofBreakByCase[saved.caseId].loading && <span role="status">Loading current source, worker, and timeline status…</span>}
                  {proofBreakByCase[saved.caseId].error && <span role="alert">{proofBreakByCase[saved.caseId].error}</span>}
                  {proofBreakByCase[saved.caseId].availabilityNotice && <span role="status">{proofBreakByCase[saved.caseId].availabilityNotice}</span>}
                  {proofBreakByCase[saved.caseId].availability && <>
                    <p style={{ margin: 0 }}>{proofBreakByCase[saved.caseId].availability.sourceStatus === 'RIGHTS_BLOCKED'
                      ? proofBreakByCase[saved.caseId].availability.sourceReasonCode === 'GENIEPROOF_SOURCE_REVOKED'
                        ? 'The official source reuse approval was revoked, so financial claims cannot currently be monitored.'
                        : 'The official source reuse approval is not recorded, so financial claims cannot currently be monitored.'
                      : proofBreakByCase[saved.caseId].availability.sourceStatus === 'TECHNICALLY_BLOCKED'
                        ? 'The source is blocked by technical qualification checks.'
                      : proofBreakByCase[saved.caseId].availability.sourceStatus === 'WAITING'
                          ? 'No qualified source is currently available for these claims.'
                          : proofBreakByCase[saved.caseId].availability.sourceStatus === 'AVAILABLE'
                            ? 'A source is qualified for the supported claims.'
                            : 'Source qualification is unknown, so monitoring cannot be enabled.'}</p>
                    <p style={{ margin: 0 }}>Monitoring worker: {proofBreakByCase[saved.caseId].availability.workerStatus === 'AVAILABLE' ? 'recently available' : 'unavailable or without a recent heartbeat'}.</p>
                    <p style={{ margin: 0, color: '#94a3b8' }}>{proofBreakByCase[saved.caseId].availability.monitoringScope}</p>
                    <ul style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 4 }}>
                      {(proofBreakByCase[saved.caseId].availability.claims || []).map(claim => <li key={claim.claimId}>{proofBreakClaimStatusLabel(claim.status, proofBreakByCase[saved.caseId].availability.sourceReasonCode, proofBreakByCase[saved.caseId].availability.sourceStatus)}</li>)}
                    </ul>
                    {(!proofBreakByCase[saved.caseId].watch || isTerminalProofWatch(proofBreakByCase[saved.caseId].watch))
                      && !proofBreakByCase[saved.caseId].consentWithdrawn
                      && proofBreakByCase[saved.caseId].availability.sourceStatus === 'AVAILABLE'
                      && proofBreakByCase[saved.caseId].availability.canEnable && <>
                      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                        <input
                          type="checkbox"
                          checked={Boolean(watchConsentByCase[saved.caseId])}
                          onChange={event => setWatchConsentByCase(current => ({ ...current, [saved.caseId]: event.target.checked }))}
                          disabled={busy}
                        />
                        <span>I consent to periodic checks of these supported claims. A changed finding may create a new signed assessment revision and timeline entry. Checks continue until I pause or disable the watch, delete the case, or the case expires.</span>
                      </label>
                      <button type="button" style={buttonStyle} onClick={() => void enableProofBreak(saved.caseId)} disabled={busy || !watchConsentByCase[saved.caseId]}>Enable ProofBreak checks</button>
                    </>}
                  </>}
                  {proofBreakByCase[saved.caseId].watch && <>
                    <span>Watch status: {String(proofBreakByCase[saved.caseId].watch.status || 'unknown').replaceAll('_', ' ').toLowerCase()}.</span>
                    {proofBreakByCase[saved.caseId].watch.lastSuccessfulCheckAt && <span>Last successful check: {new Date(proofBreakByCase[saved.caseId].watch.lastSuccessfulCheckAt).toLocaleString()}.</span>}
                    {proofBreakByCase[saved.caseId].watch.nextCheckAt && <span>Next eligible check: {new Date(proofBreakByCase[saved.caseId].watch.nextCheckAt).toLocaleString()}.</span>}
                    <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {proofBreakByCase[saved.caseId].watch.status === 'ACTIVE' && <button type="button" style={buttonStyle} onClick={() => void updateProofBreak(saved.caseId, proofBreakByCase[saved.caseId].watch.watchId, 'pause')} disabled={busy}>Pause checks</button>}
                      {proofBreakByCase[saved.caseId].watch.status === 'PAUSED' && <button type="button" style={buttonStyle} onClick={() => void updateProofBreak(saved.caseId, proofBreakByCase[saved.caseId].watch.watchId, 'resume')} disabled={busy}>Resume checks</button>}
                      {!isTerminalProofWatch(proofBreakByCase[saved.caseId].watch) && <button type="button" style={buttonStyle} onClick={() => void updateProofBreak(saved.caseId, proofBreakByCase[saved.caseId].watch.watchId, 'disable')} disabled={busy}>Disable checks</button>}
                      <button type="button" style={{ ...buttonStyle, color: '#fecaca' }} onClick={() => void removeProofBreak(saved.caseId, proofBreakByCase[saved.caseId].watch.watchId)} disabled={busy}>Delete watch and timeline</button>
                    </span>
                  </>}
                  <div>
                    <strong>Recent checks</strong>
                    {!proofBreakByCase[saved.caseId].loading && (proofBreakByCase[saved.caseId].events || []).length === 0 && <p style={{ margin: '5px 0 0', color: '#94a3b8' }}>No persisted checks or events are available for this case.</p>}
                    <ul style={{ margin: '6px 0 0', paddingLeft: 20, display: 'grid', gap: 9 }}>
                      {(proofBreakByCase[saved.caseId].events || []).map(event => <li key={event.eventId}>
                        <span>{proofBreakEventLabel(event.eventType)} · {new Date(event.detectedAt).toLocaleString()}</span>
                        <small style={{ display: 'block', color: '#94a3b8' }}>Timeline update: {proofBreakTimelineStatusLabel(event.notificationStatus)}.</small>
                        {event.retrievalReceiptIds?.length > 0 && <details style={{ marginTop: 4, color: '#94a3b8' }}>
                          <summary>Source retrieval receipts</summary>
                          <span style={{ display: 'block', overflowWrap: 'anywhere' }}>{event.retrievalReceiptIds.join(', ')}</span>
                        </details>}
                        {event.newAssessmentId && <button type="button" style={{ ...buttonStyle, marginTop: 5 }} onClick={() => void openCase(saved.caseId)} disabled={busy}>Open latest assessment</button>}
                        {!event.acknowledgedAt && <button type="button" style={{ ...buttonStyle, marginTop: 5, marginLeft: 6 }} onClick={() => void acknowledgeProofBreak(saved.caseId, event.eventId)} disabled={busy}>Mark reviewed</button>}
                      </li>)}
                    </ul>
                    {proofBreakByCase[saved.caseId].nextCursor && <button type="button" style={{ ...buttonStyle, marginTop: 8 }} onClick={() => void loadProofBreak(saved.caseId, { append: true })} disabled={busy || proofBreakByCase[saved.caseId].loading}>Load older checks</button>}
                  </div>
                  {proofBreakByCase[saved.caseId].consentWithdrawn && <span role="status">Processing consent is withdrawn. Future checks are off.</span>}
                  {!proofBreakByCase[saved.caseId].consentWithdrawn && <div>
                    {pendingConsentWithdrawalCaseId === saved.caseId
                      ? <span role="group" aria-label="Confirm consent withdrawal" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', color: '#fecaca' }}>
                        Withdraw private processing consent and cancel future reassessments?
                        <button type="button" style={buttonStyle} onClick={() => void withdrawConsent(saved.caseId)} disabled={busy}>Confirm withdrawal</button>
                        <button type="button" style={buttonStyle} onClick={() => setPendingConsentWithdrawalCaseId(null)} disabled={busy}>Cancel</button>
                      </span>
                      : <button type="button" style={{ ...buttonStyle, color: '#fecaca' }} onClick={() => setPendingConsentWithdrawalCaseId(saved.caseId)} disabled={busy}>Withdraw private processing consent</button>}
                  </div>}
                </div>}
                {integrityByCase[saved.caseId] && <span role="status" style={{ flexBasis: '100%', color: '#fbbf24' }}>
                  {integrityLabel(integrityByCase[saved.caseId])} A signature does not prove the financial claim is correct.
                  <details style={{ marginTop: 4, color: '#94a3b8' }}>
                    <summary>Technical integrity details</summary>
                    Integrity: {integrityByCase[saved.caseId].integrity}; signature: {integrityByCase[saved.caseId].signature}; trusted report-signing key: {String(integrityByCase[saved.caseId].trustedIssuer)}; financial correctness: {integrityByCase[saved.caseId].financialCorrectness}.
                  </details>
                </span>}
                {revisionHistory?.caseId === saved.caseId && <div role="group" aria-label="Assessment history" style={{ flexBasis: '100%', display: 'grid', gap: 8, color: '#cbd5e1' }}>
                  <strong>Assessment history</strong>
                  <span style={{ color: '#94a3b8' }}>Each signed finding remains as recorded at assessment. Current source qualification is shown separately.</span>
                  {revisionHistory.revisions.length < 2 && <span>Only the original assessment is available. Reassessment is currently disabled.</span>}
                  {revisionHistory.revisions.length === 0 && <span>No unexpired assessment revisions are available.</span>}
                  {revisionHistory.revisions.map(revision => <div key={revision.revision}>
                    <button type="button" style={buttonStyle} onClick={() => openRevision(revision)} disabled={busy}>
                      Open revision {revision.revision} · {hasTrustedSignature(revision.verification) ? 'signature verified' : 'verification needs review'}
                    </button>
                    {hasTrustedSignature(revision.verification)
                      ? <CurrentEvidenceManifestStatus currentEvidenceStatus={revision.currentEvidenceStatus} manifest={revision.passport?.manifest} />
                      : <div style={{ color: '#fbbf24', fontSize: '0.88rem' }}>Current source status is hidden until this revision verifies with a trusted signature.</div>}
                  </div>)}
                  {revisionHistory.revisions.length > 1 && revisionHistory.revisions
                    .filter(revision => revision.revision < Math.max(...revisionHistory.revisions.map(item => item.revision)))
                    .map(revision => {
                      const latest = revisionHistory.revisions.reduce((current, item) => item.revision > current.revision ? item : current);
                      return <button key={`compare-${revision.revision}`} type="button" style={buttonStyle} onClick={() => compareRevisions(revision, latest)} disabled={busy}>
                        Compare revision {revision.revision} with revision {latest.revision}
                      </button>;
                    })}
                </div>}
                {pendingDeleteCaseId === saved.caseId && <span role="group" aria-label="Confirm passport deletion" style={{ flexBasis: '100%', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', color: '#fecaca' }}>
                  Delete this passport and all revisions?
                  <button type="button" style={{ ...buttonStyle, color: '#fecaca', borderColor: 'rgba(248,113,113,.45)' }} onClick={() => void deleteCase(saved.caseId)} disabled={busy}>Delete case and revisions</button>
                  <button type="button" style={buttonStyle} onClick={() => setPendingDeleteCaseId(null)} disabled={busy}>Cancel</button>
                </span>}
              </li>
            ))}
          </ul>}
      </section>

      {comparison && (
        <section style={cardStyle} aria-labelledby="genieproof-comparison-title">
          <h2 id="genieproof-comparison-title" style={{ fontSize: '1.05rem', margin: '0 0 8px', color: '#f8fafc' }}>Signed assessment comparison</h2>
          <p style={{ color: '#94a3b8', marginTop: 0 }}>Both report signatures and case bindings were verified. Findings remain as recorded at assessment; current source qualification is shown separately and does not establish financial correctness.</p>
          {(() => {
            const oldManifest = comparison.older.passport.manifest;
            const newManifest = comparison.newer.passport.manifest;
            const oldClaims = new Map((oldManifest.confirmedClaims || []).map(claim => [claim.claimId, claim]));
            const newClaims = new Map((newManifest.confirmedClaims || []).map(claim => [claim.claimId, claim]));
            const oldFindings = new Map((oldManifest.findings || []).map(finding => [finding.claimId, finding]));
            const newFindings = new Map((newManifest.findings || []).map(finding => [finding.claimId, finding]));
            const claimIds = [...new Set([...oldClaims.keys(), ...newClaims.keys()])];
            return claimIds.length === 0
              ? <p>No claim findings are available in these revisions.</p>
              : <ul style={{ paddingLeft: 20, display: 'grid', gap: 12 }}>
                {claimIds.map(claimId => {
                  const claim = newClaims.get(claimId) || oldClaims.get(claimId);
                  const oldFinding = oldFindings.get(claimId);
                  const newFinding = newFindings.get(claimId);
                  return <li key={claimId}>
                    <strong>{claim?.statement || 'Claim wording unavailable'}</strong>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10, marginTop: 8 }}>
                      <div>
                        <span>Revision {oldManifest.revision}: {oldFinding ? findingPresentationLabel(oldFinding, oldManifest) : 'No finding recorded'}</span>
                        <CurrentEvidenceClaimStatus currentEvidenceStatus={comparison.older.currentEvidenceStatus} claimId={claimId} />
                      </div>
                      <div>
                        <span>Revision {newManifest.revision}: {newFinding ? findingPresentationLabel(newFinding, newManifest) : 'No finding recorded'}</span>
                        <CurrentEvidenceClaimStatus currentEvidenceStatus={comparison.newer.currentEvidenceStatus} claimId={claimId} />
                      </div>
                    </div>
                  </li>;
                })}
              </ul>;
          })()}
        </section>
      )}

      {selected && (
        <section style={cardStyle} aria-labelledby="genieproof-passport-title">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <h2 id="genieproof-passport-title" style={{ fontSize: '1.05rem', margin: 0, color: '#f8fafc' }}>Signed claim record · revision {selected.manifest.revision}</h2>
            <button type="button" style={buttonStyle} onClick={() => downloadPassport(selected)}>Download signed claim record</button>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flex: '1 1 320px' }}>
              <input type="checkbox" checked={reassessmentConsent} onChange={event => setReassessmentConsent(event.target.checked)} disabled={busy} />
              <span>I consent to a new private assessment of this passport using evidence currently qualified for the claim.</span>
            </label>
            <button type="button" style={buttonStyle} onClick={() => void reassessSelectedCase()} disabled={busy || !reassessmentConsent}>Create new assessment</button>
          </div>
          <p style={{ color: '#94a3b8', overflowWrap: 'anywhere' }}>Manifest SHA-256: {selected.manifestHash}</p>
          <p style={{ color: '#94a3b8' }}>Signed findings below remain as recorded at assessment. Current source qualification is checked separately and does not rewrite this record.</p>
          {selected.manifest.verifierVersion !== CURRENT_CLAIM_VERIFIER_VERSION && <p role="note" style={{ color: '#fbbf24' }}>
            Historical verifier output — not reassessed under current claim rules. This signed result is not a current financial finding; the original signed JSON is preserved and its signature establishes integrity, not correctness.
          </p>}
          <ul style={{ paddingLeft: 20, display: 'grid', gap: 12 }}>
            {selected.manifest.findings.map(finding => {
              const claim = selected.manifest.confirmedClaims.find(item => item.claimId === finding.claimId);
              return <li key={finding.claimId}>
                <strong>{findingPresentationLabel(finding, selected.manifest)}</strong>: {claim?.statement || 'Claim text unavailable'}
                <span style={{ display: 'block', color: '#cbd5e1', marginTop: 4 }}>{finding.explanation}</span>
                <CurrentEvidenceClaimStatus currentEvidenceStatus={selectedCurrentEvidenceStatus} claimId={finding.claimId} />
                <details style={{ marginTop: 5, color: '#94a3b8' }}>
                  <summary>Technical verification details</summary>
                  <span style={{ display: 'block', marginTop: 4 }}>{selected.manifest.verifierVersion === CURRENT_CLAIM_VERIFIER_VERSION ? 'Finding code' : 'Recorded historical finding code (not a current claim verdict)'}: {finding.finding}; reason codes: {finding.reasonCodes.join(', ') || 'none'}.</span>
                </details>
              </li>;
            })}
          </ul>
        </section>
      )}

      {(error || status) && <p role={error ? 'alert' : 'status'} style={{ ...cardStyle, margin: 0, borderColor: error ? 'rgba(248,113,113,.45)' : 'rgba(56,189,248,.2)', color: error ? '#fecaca' : '#bae6fd' }}>{error || status}</p>}
      <p style={{ margin: 0, fontSize: '0.82rem', color: '#94a3b8' }}>ProofBreak availability is checked for each saved case. It stays off until a supported source has documented reuse approval, a worker is recently available, and you give separate consent.</p>
    </div>
  );
}
