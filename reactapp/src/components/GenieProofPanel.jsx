import React, { useCallback, useEffect, useState } from 'react';
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
const CURRENT_CLAIM_VERIFIER_VERSION = 'genieproof-evidence-bound/0.5.0';

function messageOf(error) {
  return error?.message || 'The request could not be completed.';
}

async function loadConsistentLatestPassport(caseId) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const saved = await api.getGenieProofCase(caseId);
    const verification = await api.verifyGenieProofCase(caseId);
    const passport = saved?.passport;
    if (passport?.manifest?.caseId === caseId
        && passport.manifest.revision === verification?.revision
        && passport.manifestHash === verification?.manifestHash) {
      return { passport, verification };
    }
  }
  throw new Error('The Passport changed while it was opening. Open it again to load the latest revision.');
}

function findingLabel(value) {
  return ({
    SUPPORTED: 'The available qualified evidence supports this claim',
    CONTRADICTED: 'The available qualified evidence conflicts with this claim',
    NOT_VERIFIABLE: 'Not checked against qualified source evidence',
    INSUFFICIENT_INPUTS: 'More product details are needed',
    OUTDATED_EVIDENCE: 'The available evidence is out of date',
    OUT_OF_SCOPE: 'This claim is outside the current check',
  })[value] || 'The claim could not be checked';
}

function findingPresentationLabel(finding, manifest) {
  if (manifest?.verifierVersion !== CURRENT_CLAIM_VERIFIER_VERSION) {
    return 'Historical verifier output; not reassessed under current claim rules';
  }
  return findingLabel(finding?.finding);
}

function integrityLabel(result) {
  if (result?.integrity === 'VALID' && result?.signature === 'VERIFIED' && result?.trustedIssuer === true) {
    return 'The report signature and case binding match a trusted key.';
  }
  if (result?.integrity === 'INVALID') return 'The report integrity or case binding check failed.';
  return 'The report contents match their fingerprint, but the signing key is not trusted.';
}

function proofBreakClaimStatusLabel(status) {
  return ({
    AVAILABLE: 'Supported by an approved monitoring source',
    SOURCE_RIGHTS_BLOCKED: 'Source reuse approval is not recorded',
    SOURCE_TECHNICALLY_BLOCKED: 'Source is not technically qualified',
    WAITING_FOR_QUALIFIED_SOURCE: 'Waiting for a qualified source',
    NOT_SUPPORTED: 'Outside the current monitoring scope',
  })[status] || 'Monitoring availability is unknown';
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

export default function GenieProofPanel() {
  const [offerText, setOfferText] = useState('');
  const [extraction, setExtraction] = useState(null);
  const [claims, setClaims] = useState([]);
  const [confirmed, setConfirmed] = useState(false);
  const [savingConsent, setSavingConsent] = useState(false);
  const [savedCases, setSavedCases] = useState([]);
  const [selected, setSelected] = useState(null);
  const [revisionHistory, setRevisionHistory] = useState(null);
  const [comparison, setComparison] = useState(null);
  const [integrityByCase, setIntegrityByCase] = useState({});
  const [pendingDeleteCaseId, setPendingDeleteCaseId] = useState(null);
  const [proofBreakByCase, setProofBreakByCase] = useState({});
  const [watchConsentByCase, setWatchConsentByCase] = useState({});
  const [reassessmentConsent, setReassessmentConsent] = useState(false);
  const [pendingConsentWithdrawalCaseId, setPendingConsentWithdrawalCaseId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const reloadCases = useCallback(async () => {
    try {
      const result = await api.listGenieProofCases();
      setSavedCases(result.cases || []);
    } catch (loadError) {
      setError(messageOf(loadError));
    }
  }, []);

  const loadProofBreak = async (caseId, { append = false } = {}) => {
    setProofBreakByCase(current => ({ ...current, [caseId]: { ...current[caseId], loading: true, error: '' } }));
    const cursor = append ? proofBreakByCase[caseId]?.nextCursor : null;
    const [availabilityResult, watchResult, timeline] = await Promise.allSettled([
      api.getProofWatchAvailability(caseId),
      api.listProofWatches({ caseId, limit: 10 }),
      api.listProofBreakEvents(caseId, { limit: 10, cursor }),
    ]);
    setProofBreakByCase(current => {
      const previous = current[caseId] || {};
      const watchSucceeded = watchResult.status === 'fulfilled';
      const timelineSucceeded = timeline.status === 'fulfilled';
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
          availabilityNotice: availabilityResult.status === 'rejected'
            ? 'Current monitoring availability cannot be shown; saved watch history remains available.'
            : '',
          watch: watchSucceeded ? (watchResult.value.watches || [])[0] || null : previous.watch || null,
          events,
          nextCursor: timelineSucceeded ? timeline.value.nextCursor || null : previous.nextCursor || null,
        },
      };
    });
  };

  const enableProofBreak = async caseId => {
    if (!watchConsentByCase[caseId] || !proofBreakByCase[caseId]?.availability?.canEnable) return;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const result = await api.createProofWatch(caseId);
      await loadProofBreak(caseId);
      setStatus(result.watch?.status === 'ACTIVE'
        ? 'ProofBreak watch enabled for the supported claims shown above.'
        : `ProofBreak watch saved with status ${result.watch?.status || 'unavailable'}.`);
      setWatchConsentByCase(current => ({ ...current, [caseId]: false }));
    } catch (watchError) {
      setError(messageOf(watchError));
    } finally {
      setBusy(false);
    }
  };

  const updateProofBreak = async (caseId, watchId, action) => {
    setBusy(true);
    setError('');
    try {
      await api.updateProofWatch(watchId, action);
      await loadProofBreak(caseId);
      setStatus(action === 'pause' ? 'ProofBreak checks paused.' : action === 'resume' ? 'ProofBreak watch status refreshed.' : 'ProofBreak checks disabled.');
    } catch (watchError) {
      setError(messageOf(watchError));
    } finally {
      setBusy(false);
    }
  };

  const removeProofBreak = async (caseId, watchId) => {
    setBusy(true);
    setError('');
    try {
      await api.deleteProofWatch(watchId);
      await loadProofBreak(caseId);
      setStatus('ProofBreak watch and its timeline were deleted.');
    } catch (watchError) {
      setError(messageOf(watchError));
    } finally {
      setBusy(false);
    }
  };

  const acknowledgeProofBreak = async (caseId, eventId) => {
    setBusy(true);
    setError('');
    try {
      await api.acknowledgeProofBreakEvent(eventId);
      await loadProofBreak(caseId);
    } catch (ackError) {
      setError(messageOf(ackError));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { void reloadCases(); }, [reloadCases]);

  const extract = async () => {
    setBusy(true);
    setError('');
    setStatus('');
    setExtraction(null);
    setClaims([]);
    setConfirmed(false);
    setSavingConsent(false);
    setSelected(null);
    setRevisionHistory(null);
    setComparison(null);
    setIntegrityByCase({});
    setPendingDeleteCaseId(null);
    try {
      const result = await api.extractGenieProofClaims(offerText);
      setExtraction(result);
      setClaims((result.claims || []).map(prepareClaim));
      setStatus('Review each extracted statement and interpretation before saving a private passport.');
    } catch (extractError) {
      setError(messageOf(extractError));
    } finally {
      setBusy(false);
    }
  };

  const loadRevisionHistory = async caseId => {
    setBusy(true);
    setError('');
    setStatus('');
    setSelected(null);
    setReassessmentConsent(false);
    setRevisionHistory(null);
    setComparison(null);
    try {
      setRevisionHistory(await api.listGenieProofRevisions(caseId));
    } catch (historyError) {
      setError(messageOf(historyError));
    } finally {
      setBusy(false);
    }
  };

  const openRevision = revision => {
    setReassessmentConsent(false);
    const verification = revision.verification;
    if (verification.integrity !== 'VALID' || verification.signature !== 'VERIFIED' || verification.trustedIssuer !== true) {
      setError(`Revision ${revision.revision} failed trusted signature or case-binding verification. Its findings are hidden.`);
      setSelected(null);
      setComparison(null);
      setStatus('');
      return;
    }
    setError('');
    setSelected(revision.passport);
    setComparison(null);
    setStatus('');
    setStatus(`Revision ${revision.revision} has a verified document signature. Financial correctness is not established by that signature.`);
  };

  const compareRevisions = (older, newer) => {
    const isTrusted = revision => revision?.verification?.integrity === 'VALID'
      && revision.verification.signature === 'VERIFIED'
      && revision.verification.trustedIssuer === true;
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
    setConfirmed(false);
    setSavingConsent(false);
    setClaims(current => current.filter(claim => claim.claimId !== claimId));
  };

  const savePassport = async () => {
    if (!extraction || extraction.claimsTruncated || !confirmed || !savingConsent || claims.length === 0) return;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await api.createGenieProofCase({
        offerText,
        submissionHash: extraction.inputHash,
        savingConsent: true,
        confirmedClaims: claims,
      });
      setSelected(null);
      setOfferText('');
      setExtraction(null);
      setClaims([]);
      setConfirmed(false);
      setSavingConsent(false);
      setStatus('Private claim record saved. Verify its trusted signature before viewing findings; a signature does not establish financial correctness.');
      await reloadCases();
    } catch (saveError) {
      setError(messageOf(saveError));
    } finally {
      setBusy(false);
    }
  };

  const openCase = async caseId => {
    setBusy(true);
    setError('');
    setStatus('');
    setSelected(null);
    setReassessmentConsent(false);
    setRevisionHistory(null);
    setComparison(null);
    try {
      const { passport, verification } = await loadConsistentLatestPassport(caseId);
      setIntegrityByCase(current => ({ ...current, [caseId]: verification }));
      if (verification.integrity !== 'VALID' || verification.signature !== 'VERIFIED' || verification.trustedIssuer !== true) {
        setError('Passport signature could not be verified by a trusted key. Its findings are hidden.');
        return;
      }
      setSelected(passport);
      setRevisionHistory(null);
      setStatus('The stored report signature is verified. This does not establish financial correctness.');
    } catch (openError) {
      setError(messageOf(openError));
    } finally {
      setBusy(false);
    }
  };

  const checkIntegrity = async caseId => {
    setBusy(true);
    setError('');
    setStatus('');
    setIntegrityByCase(current => {
      const next = { ...current };
      delete next[caseId];
      return next;
    });
    try {
      const result = await api.verifyGenieProofCase(caseId);
      setIntegrityByCase(current => ({ ...current, [caseId]: result }));
    } catch (verifyError) {
      setError(messageOf(verifyError));
    } finally {
      setBusy(false);
    }
  };

  const reassessSelectedCase = async () => {
    const caseId = selected?.manifest?.caseId;
    if (!caseId || !reassessmentConsent) return;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const result = await api.reassessGenieProofCase({
        caseId,
        expectedRevision: selected.manifest.revision,
        expectedManifestHash: selected.manifestHash,
        reassessmentConsent: true,
      });
      const [verified, history, caseResult] = await Promise.all([
        loadConsistentLatestPassport(caseId),
        api.listGenieProofRevisions(caseId),
        api.listGenieProofCases(),
      ]);
      const { passport, verification } = verified;
      setSavedCases(caseResult.cases || []);
      setRevisionHistory(history);
      setIntegrityByCase(current => ({ ...current, [caseId]: verification }));
      if (verification.integrity === 'VALID' && verification.signature === 'VERIFIED' && verification.trustedIssuer === true) {
        setSelected(passport);
        const revisionMessage = result.revision === passport.manifest.revision
          ? `Private assessment revision ${result.revision} was saved.`
          : `Private assessment revision ${result.revision} was saved; showing newer verified revision ${passport.manifest.revision}.`;
        setStatus(`${revisionMessage} Its signature does not establish financial correctness.`);
      } else {
        setSelected(null);
        setError('The new revision was saved, but its trusted signature could not be verified. Its findings are hidden.');
      }
      setReassessmentConsent(false);
    } catch (reassessError) {
      setError(messageOf(reassessError));
    } finally {
      setBusy(false);
    }
  };

  const withdrawConsent = async caseId => {
    setBusy(true);
    setError('');
    try {
      await api.withdrawGenieProofConsent(caseId);
      setPendingConsentWithdrawalCaseId(null);
      const [watchResult, timeline] = await Promise.all([
        api.listProofWatches({ caseId, limit: 10 }),
        api.listProofBreakEvents(caseId, { limit: 10 }),
      ]);
      setProofBreakByCase(current => ({
        ...current,
        [caseId]: { ...current[caseId], availability: null, watch: (watchResult.watches || [])[0] || null, events: timeline.events || [], nextCursor: timeline.nextCursor || null },
      }));
      setStatus('Private processing consent was withdrawn. Future reassessments and monitoring checks were cancelled. Delete the case separately to remove it from active storage.');
    } catch (withdrawError) {
      setError(messageOf(withdrawError));
    } finally {
      setBusy(false);
    }
  };

  const deleteCase = async caseId => {
    setBusy(true);
    setError('');
    try {
      await api.deleteGenieProofCase(caseId);
      if (selected?.manifest?.caseId === caseId) setSelected(null);
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
      setStatus('The case and its passport revisions were deleted from active app storage. Backups may follow separate retention schedules.');
    } catch (deleteError) {
      setError(messageOf(deleteError));
    } finally {
      setBusy(false);
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
            setOfferText(event.target.value);
            setExtraction(null);
            setClaims([]);
            setConfirmed(false);
            setSavingConsent(false);
            setSelected(null);
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
                  <button type="button" style={buttonStyle} onClick={() => void openCase(saved.caseId)} disabled={busy}>Open</button>
                  <button type="button" style={buttonStyle} onClick={() => void loadRevisionHistory(saved.caseId)} disabled={busy}>Assessment history</button>
                  <button type="button" style={buttonStyle} onClick={() => void checkIntegrity(saved.caseId)} disabled={busy}>Verify integrity</button>
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
                      ? 'The official source reuse approval is not recorded, so financial claims cannot currently be monitored.'
                      : proofBreakByCase[saved.caseId].availability.sourceStatus === 'TECHNICALLY_BLOCKED'
                        ? 'The source is blocked by technical qualification checks.'
                        : proofBreakByCase[saved.caseId].availability.sourceStatus === 'WAITING'
                          ? 'No qualified source is currently available for these claims.'
                          : 'A source is qualified for the supported claims.'}</p>
                    <p style={{ margin: 0 }}>Monitoring worker: {proofBreakByCase[saved.caseId].availability.workerStatus === 'AVAILABLE' ? 'recently available' : 'unavailable or without a recent heartbeat'}.</p>
                    <p style={{ margin: 0, color: '#94a3b8' }}>{proofBreakByCase[saved.caseId].availability.monitoringScope}</p>
                    <ul style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 4 }}>
                      {proofBreakByCase[saved.caseId].availability.claims.map(claim => <li key={claim.claimId}>{proofBreakClaimStatusLabel(claim.status)}</li>)}
                    </ul>
                    {!proofBreakByCase[saved.caseId].watch && proofBreakByCase[saved.caseId].availability.canEnable && <>
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
                    <span>Watch status: {proofBreakByCase[saved.caseId].watch.status.replaceAll('_', ' ').toLowerCase()}.</span>
                    {proofBreakByCase[saved.caseId].watch.lastSuccessfulCheckAt && <span>Last successful check: {new Date(proofBreakByCase[saved.caseId].watch.lastSuccessfulCheckAt).toLocaleString()}.</span>}
                    {proofBreakByCase[saved.caseId].watch.nextCheckAt && <span>Next eligible check: {new Date(proofBreakByCase[saved.caseId].watch.nextCheckAt).toLocaleString()}.</span>}
                    <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {proofBreakByCase[saved.caseId].watch.status === 'ACTIVE' && <button type="button" style={buttonStyle} onClick={() => void updateProofBreak(saved.caseId, proofBreakByCase[saved.caseId].watch.watchId, 'pause')} disabled={busy}>Pause checks</button>}
                      {proofBreakByCase[saved.caseId].watch.status === 'PAUSED' && <button type="button" style={buttonStyle} onClick={() => void updateProofBreak(saved.caseId, proofBreakByCase[saved.caseId].watch.watchId, 'resume')} disabled={busy}>Resume checks</button>}
                      {!['CANCELLED', 'EXPIRED'].includes(proofBreakByCase[saved.caseId].watch.status) && <button type="button" style={buttonStyle} onClick={() => void updateProofBreak(saved.caseId, proofBreakByCase[saved.caseId].watch.watchId, 'disable')} disabled={busy}>Disable checks</button>}
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
                  {proofBreakByCase[saved.caseId].availability && <div>
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
                {revisionHistory?.caseId === saved.caseId && <span role="group" aria-label="Assessment history" style={{ flexBasis: '100%', display: 'grid', gap: 8, color: '#cbd5e1' }}>
                  <strong>Assessment history</strong>
                  {revisionHistory.revisions.length < 2 && <span>Only the original assessment is available. Reassessment is currently disabled.</span>}
                  {revisionHistory.revisions.length === 0 && <span>No unexpired assessment revisions are available.</span>}
                  {revisionHistory.revisions.map(revision => <button key={revision.revision} type="button" style={buttonStyle} onClick={() => openRevision(revision)} disabled={busy}>
                    Open revision {revision.revision} · {revision.verification.integrity === 'VALID' ? 'signature verified' : 'verification needs review'}
                  </button>)}
                  {revisionHistory.revisions.length > 1 && revisionHistory.revisions
                    .filter(revision => revision.revision < Math.max(...revisionHistory.revisions.map(item => item.revision)))
                    .map(revision => {
                      const latest = revisionHistory.revisions.reduce((current, item) => item.revision > current.revision ? item : current);
                      return <button key={`compare-${revision.revision}`} type="button" style={buttonStyle} onClick={() => compareRevisions(revision, latest)} disabled={busy}>
                        Compare revision {revision.revision} with revision {latest.revision}
                      </button>;
                    })}
                </span>}
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
          <p style={{ color: '#94a3b8', marginTop: 0 }}>Both report signatures and case bindings were verified. This comparison describes signed report contents; it does not establish financial correctness.</p>
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
                      <span>Revision {oldManifest.revision}: {oldFinding ? findingPresentationLabel(oldFinding, oldManifest) : 'No finding recorded'}</span>
                      <span>Revision {newManifest.revision}: {newFinding ? findingPresentationLabel(newFinding, newManifest) : 'No finding recorded'}</span>
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
          {selected.manifest.verifierVersion !== CURRENT_CLAIM_VERIFIER_VERSION && <p role="note" style={{ color: '#fbbf24' }}>
            Historical verifier output — not reassessed under current claim rules. This signed result is not a current financial finding; the original signed JSON is preserved and its signature establishes integrity, not correctness.
          </p>}
          <ul style={{ paddingLeft: 20, display: 'grid', gap: 12 }}>
            {selected.manifest.findings.map(finding => {
              const claim = selected.manifest.confirmedClaims.find(item => item.claimId === finding.claimId);
              return <li key={finding.claimId}>
                <strong>{findingPresentationLabel(finding, selected.manifest)}</strong>: {claim?.statement || 'Claim text unavailable'}
                <span style={{ display: 'block', color: '#cbd5e1', marginTop: 4 }}>{finding.explanation}</span>
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
