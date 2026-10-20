import { useEffect, useRef, useState } from 'react';
import * as api from '../services/api';

const MAX_SUBMISSION_CHARS = 16000;

export default function GenieProofClaimPreview() {
  const [offerText, setOfferText] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(null);

  useEffect(() => () => pending.current?.abort(), []);

  const changeText = value => {
    pending.current?.abort();
    pending.current = null;
    setOfferText(value);
    setResult(null);
    setError('');
    setBusy(false);
  };

  const submit = async event => {
    event.preventDefault();
    if (!offerText.trim() || busy) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setResult(null);
    setError('');
    try {
      const next = await api.previewGenieProofClaims(offerText, { signal: controller.signal });
      if (controller.signal.aborted || pending.current !== controller) return;
      if (next?.previewOnly !== true || next?.status !== 'CANDIDATES_ONLY'
          || next?.sourceEvidenceChecked !== false || next?.signedPassportCreated !== false
          || !Array.isArray(next.claims) || next.claims.length > 10) {
        throw new Error('Unexpected claim-preview response.');
      }
      setResult(next);
    } catch {
      if (!controller.signal.aborted && pending.current === controller) {
        setError('The claim preview could not be completed. No claim has been checked or saved.');
      }
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  };

  return (
    <div>
      <h2>Review claim candidates</h2>
      <p>
        Paste financial offer text to identify possible claims for your own review.
        This only highlights statements; it does not check current interest rates,
        verify a provider, offer investment advice, or create a signed passport.
        The text is sent to the authenticated server only when you select Review claims.
      </p>
      <form onSubmit={submit}>
        <label htmlFor="genieproof-preview-offer">Financial offer or statement</label>
        <textarea
          id="genieproof-preview-offer"
          value={offerText}
          maxLength={MAX_SUBMISSION_CHARS}
          onChange={event => changeText(event.target.value)}
          rows={5}
          style={{ width: '100%', display: 'block', margin: '8px 0 12px', padding: 12 }}
        />
        <button type="submit" disabled={busy || !offerText.trim()}>
          {busy ? 'Reviewing…' : 'Review claims'}
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {result && (
        <section aria-labelledby="genieproof-candidates-heading">
          <h3 id="genieproof-candidates-heading">Candidate statements — not verified</h3>
          {result.claims.length === 0 ? (
            <p>No financial claim candidates were identified. This does not establish that the offer is safe.</p>
          ) : (
            <ul>
              {result.claims.map(candidate => (
                <li key={candidate.claimId} style={{ marginBottom: 12 }}>
                  <blockquote>{candidate.originalSpan}</blockquote>
                  <p>
                    {candidate.claimType === 'CURRENT_NOMINAL_RATE'
                      ? 'Recognized as a current PPF-rate claim candidate, not verified.'
                      : 'Outside the supported verification scope; no verdict is available.'}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {result.claimsTruncated && (
            <p role="status">Only the first ten candidate claims were shown. Additional candidates were omitted.</p>
          )}
          <p role="status">No financial evidence was checked; no signed passport was created. No offer text was saved by this operation.</p>
        </section>
      )}
    </div>
  );
}
