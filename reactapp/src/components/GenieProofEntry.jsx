import { useEffect, useRef, useState } from 'react';
import * as api from '../services/api';

const MAX_BYTES = 16000;
const OFFICIAL_PPF_SOURCE = 'https://www.indiapost.gov.in/banking-services/savings';
const layout = {
  maxWidth: 880, margin: '28px auto', padding: 24, color: '#e2e8f0',
};
const panel = {
  background: 'rgba(15,23,42,.7)', border: '1px solid rgba(148,163,184,.25)',
  padding: 22, borderRadius: 16, marginBottom: 18,
};
const button = {
  border: '1px solid rgba(56,189,248,.5)', background: '#0369a1',
  color: '#fff', borderRadius: 10, padding: '11px 18px',
  font: 'inherit', fontWeight: 650, cursor: 'pointer',
};
const verdicts = {
  SUPPORTED: { label: 'Supported by evidence', color: '#86efac' },
  CONTRADICTED: { label: 'Contradicted by evidence', color: '#fca5a5' },
  NOT_VERIFIED: { label: 'Not verified', color: '#fcd34d' },
};

function validCheckResponse(value) {
  if (value?.ok !== true || value?.mode !== 'READ_ONLY_FINANCIAL_CLAIM_CHECK'
      || value.saved !== false || value.allExtractedCandidatesProcessed !== true
      || value.verificationScope !== 'DETECTED_CLAIMS_ONLY'
      || !Array.isArray(value.claims) || value.claims.length > 10
      || !Number.isFinite(Date.parse(value.checkedAt))) return false;
  return value.claims.every(claim => {
    if (!claim || typeof claim.claimId !== 'string'
        || typeof claim.statement !== 'string'
        || !Object.hasOwn(verdicts, claim.verdict)
        || typeof claim.explanation !== 'string'
        || !Array.isArray(claim.warningSignals)
        || claim.warningSignals.some(item => typeof item !== 'string')) return false;
    if (claim.verdict === 'NOT_VERIFIED') return claim.source === null;
    return claim.source?.url === OFFICIAL_PPF_SOURCE
      && Number.isFinite(claim.source.observedRatePercentPerAnnum)
      && Number.isFinite(Date.parse(claim.source.retrievedAt));
  });
}

export default function GenieProofEntry() {
  const [statement, setStatement] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const requestRef = useRef(null);
  const bytes = new TextEncoder().encode(statement).length;
  const tooLarge = bytes > MAX_BYTES;

  useEffect(() => () => requestRef.current?.abort(), []);

  function edit(value) {
    requestRef.current?.abort();
    requestRef.current = null;
    setStatement(value);
    setResult(null);
    setError('');
    setChecking(false);
  }

  async function check(event) {
    event.preventDefault();
    if (!statement.trim() || tooLarge || checking) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setChecking(true);
    setResult(null);
    setError('');
    try {
      const next = await api.checkGenieProofClaims(statement, { signal: controller.signal });
      if (controller.signal.aborted || requestRef.current !== controller) return;
      if (!validCheckResponse(next)) throw new Error('Unexpected verification result');
      setResult(next);
    } catch {
      if (!controller.signal.aborted && requestRef.current === controller) {
        setError('The claim could not be checked right now. No financial conclusion was reached.');
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setChecking(false);
      }
    }
  }

  return (
    <main style={layout}>
      <section style={panel} aria-labelledby="genieproof-title">
        <h1 id="genieproof-title" style={{ marginTop: 0, color: '#f8fafc' }}>GenieProof · Check a financial claim</h1>
        <p style={{ lineHeight: 1.65 }}>
          Seen an interest-rate, investment-return or safety claim? Paste the actual statement.
          We'll compare supported claims with qualified official evidence when available.
          If we cannot verify it, we'll say so rather than guess.
        </p>
        <form onSubmit={check}>
          <label htmlFor="genieproof-claim" style={{ display: 'block', marginBottom: 8, fontWeight: 600 }}>
            Financial statement to check
          </label>
          <textarea
            id="genieproof-claim"
            value={statement}
            onChange={event => edit(event.target.value)}
            rows={5}
            aria-describedby="genieproof-privacy genieproof-size"
            aria-invalid={tooLarge || undefined}
            placeholder="Paste a claim exactly as written by the provider, message or advert."
            style={{
              width: '100%', boxSizing: 'border-box', padding: 12, borderRadius: 10,
              color: '#f8fafc', background: '#0f172a',
              border: '1px solid rgba(148,163,184,.5)', font: 'inherit',
            }}
          />
          <p id="genieproof-privacy" style={{ fontSize: '.9rem', color: '#cbd5e1' }}>
            GenieProof does not create a saved claim or account record in this check. Avoid entering PAN,
            Aadhaar, account numbers or other personal details.
          </p>
          <p id="genieproof-size" style={{ color: tooLarge ? '#fca5a5' : '#94a3b8', fontSize: '.85rem' }}>
            {bytes.toLocaleString('en-IN')} / {MAX_BYTES.toLocaleString('en-IN')} bytes
            {tooLarge ? ' — shorten the statement before checking.' : ''}
          </p>
          <button type="submit" style={{ ...button, opacity: checking || !statement.trim() || tooLarge ? .55 : 1 }}
            disabled={checking || !statement.trim() || tooLarge}>
            {checking ? 'Checking…' : 'Check claim'}
          </button>
        </form>
        {error && <p role="alert" style={{ color: '#fca5a5' }}>{error}</p>}
      </section>

      {result && (
        <section style={panel} aria-labelledby="genieproof-results-title" aria-live="polite">
          <h2 id="genieproof-results-title" style={{ marginTop: 0 }}>Claim check results</h2>
          <p style={{ color: '#cbd5e1', fontSize: '.9rem' }}>
            Checked {new Date(result.checkedAt).toLocaleString('en-IN')}.
            Only the statements detected below were assessed. Other text may contain unchecked claims.
            This is not a product recommendation, authenticity check or safety certification.
          </p>
          {result.claims.length === 0 ? (
            <p role="status">
              No checkable financial statement was found in that text. This does not establish
              that an offer is authentic or safe.
            </p>
          ) : result.claims.map((claim, index) => (
            <article key={claim.claimId} style={{ borderTop: '1px solid rgba(148,163,184,.25)', paddingTop: 14, marginTop: 18 }}>
              <h3 style={{ fontSize: '1rem', marginBottom: 9 }}>Statement {index + 1}</h3>
              <blockquote style={{ margin: '0 0 12px', paddingLeft: 14, borderLeft: '3px solid #64748b', overflowWrap: 'anywhere' }}>
                {claim.statement}
              </blockquote>
              <strong style={{ color: verdicts[claim.verdict].color }}>{verdicts[claim.verdict].label}</strong>
              <p style={{ lineHeight: 1.55 }}>{claim.explanation}</p>
              {claim.source && (
                <div style={{ color: '#cbd5e1', fontSize: '.92rem' }}>
                  <p style={{ margin: '4px 0' }}>
                    Source: <a href={OFFICIAL_PPF_SOURCE} target="_blank" rel="noopener noreferrer"
                      style={{ color: '#7dd3fc' }}>India Post — official savings information</a>
                  </p>
                  <p style={{ margin: '4px 0' }}>
                    Evidence rate: {claim.source.observedRatePercentPerAnnum}% per annum.
                    Retrieved {new Date(claim.source.retrievedAt).toLocaleDateString('en-IN')}.
                    {claim.source.effectiveFrom && ' Effective from ' + new Date(claim.source.effectiveFrom).toLocaleDateString('en-IN') + '.'}
                    {claim.source.effectiveTo && ' Effective until ' + new Date(claim.source.effectiveTo).toLocaleDateString('en-IN') + '.'}
                  </p>
                </div>
              )}
              {claim.warningSignals.length > 0 && (
                <div>
                  <strong style={{ fontSize: '.9rem', color: '#fcd34d' }}>Words worth checking (not proof of a scam)</strong>
                  <ul>{claim.warningSignals.map(signal => <li key={signal}>{signal}</li>)}</ul>
                </div>
              )}
            </article>
          ))}
          <p style={{ fontSize: '.85rem', color: '#94a3b8', marginBottom: 0 }}>
            “Not verified” means available approved evidence did not establish the claim.
            It does not by itself mean the claim is false.
          </p>
        </section>
      )}
    </main>
  );
}
