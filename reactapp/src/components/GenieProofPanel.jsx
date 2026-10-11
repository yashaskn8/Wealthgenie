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

function messageOf(error) {
  return error?.message || 'The request could not be completed.';
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

function integrityLabel(result) {
  if (result?.integrity === 'VALID' && result?.signature === 'VERIFIED' && result?.trustedIssuer === true) {
    return 'The report signature and case binding match a trusted key.';
  }
  if (result?.integrity === 'INVALID') return 'The report integrity or case binding check failed.';
  return 'The report contents match their fingerprint, but the signing key is not trusted.';
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
    setRevisionHistory(null);
    setComparison(null);
    try {
      const saved = await api.getGenieProofCase(caseId);
      const verification = await api.verifyGenieProofCase(caseId);
      setIntegrityByCase(current => ({ ...current, [caseId]: verification }));
      if (verification.integrity !== 'VALID' || verification.signature !== 'VERIFIED' || verification.trustedIssuer !== true) {
        setError('Passport signature could not be verified by a trusted key. Its findings are hidden.');
        return;
      }
      setSelected(saved.passport);
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
          Review candidate statements and keep a signed, private record. Source facts are not checked: every in-scope PPF rate claim currently remains unverified.
        </p>
        <p style={{ margin: 0, color: '#94a3b8', lineHeight: 1.55, fontSize: '0.88rem' }}>
          Claim extraction is bounded and may miss statements. Compare the candidates with the full offer; an empty list does not mean the offer contains no financial claims. A signed report does not establish offer legitimacy, investment safety, or suitability. No source monitoring or investment action is enabled.
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
                  <button type="button" style={{ ...buttonStyle, color: '#fecaca', borderColor: 'rgba(248,113,113,.35)' }} onClick={() => setPendingDeleteCaseId(saved.caseId)} disabled={busy} aria-label={`Delete passport revision ${saved.revision}`}><Trash2 size={15} aria-hidden="true" /> Delete</button>
                </span>
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
                      <span>Revision {oldManifest.revision}: {oldFinding ? findingLabel(oldFinding.finding) : 'No finding recorded'}</span>
                      <span>Revision {newManifest.revision}: {newFinding ? findingLabel(newFinding.finding) : 'No finding recorded'}</span>
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
          <p style={{ color: '#94a3b8', overflowWrap: 'anywhere' }}>Manifest SHA-256: {selected.manifestHash}</p>
          <ul style={{ paddingLeft: 20, display: 'grid', gap: 12 }}>
            {selected.manifest.findings.map(finding => {
              const claim = selected.manifest.confirmedClaims.find(item => item.claimId === finding.claimId);
              return <li key={finding.claimId}>
                <strong>{findingLabel(finding.finding)}</strong>: {claim?.statement || 'Claim text unavailable'}
                <span style={{ display: 'block', color: '#cbd5e1', marginTop: 4 }}>{finding.explanation}</span>
                <details style={{ marginTop: 5, color: '#94a3b8' }}>
                  <summary>Technical verification details</summary>
                  <span style={{ display: 'block', marginTop: 4 }}>Finding code: {finding.finding}; reason codes: {finding.reasonCodes.join(', ') || 'none'}.</span>
                </details>
              </li>;
            })}
          </ul>
        </section>
      )}

      {(error || status) && <p role={error ? 'alert' : 'status'} style={{ ...cardStyle, margin: 0, borderColor: error ? 'rgba(248,113,113,.45)' : 'rgba(56,189,248,.2)', color: error ? '#fecaca' : '#bae6fd' }}>{error || status}</p>}
      <p style={{ margin: 0, fontSize: '0.82rem', color: '#94a3b8' }}>ProofBreak monitoring is disabled until a reviewed source contract, permitted reuse, and durable revalidation worker are qualified.</p>
    </div>
  );
}
