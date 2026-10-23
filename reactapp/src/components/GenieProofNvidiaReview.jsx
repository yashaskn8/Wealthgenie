import { useEffect, useRef, useState } from 'react';
import * as api from '../services/api';

const STEPS = Object.freeze({
  VERIFY_ISSUER: 'Check the issuer or provider directly using its official website or customer support.',
  CHECK_RATE_DATE: 'Check the rate or amount against an official publication for the correct effective date.',
  CHECK_PRODUCT_TERMS: 'Confirm the exact product, term, eligibility, fees and applicable conditions in the written offer.',
  VERIFY_GUARANTEE: 'Ask for the written guarantee terms and independently check who legally backs the promise.',
  VERIFY_REGULATOR: 'Verify any claimed approval or registration in the relevant regulator’s official register.',
  CHECK_TAX_TREATMENT: 'Confirm the tax rules for your own income and holding period before relying on a post-tax figure.',
  GET_WRITTEN_QUOTE: 'Request a dated, written illustration showing all assumptions and charges.',
  AVOID_RUSH: 'Do not pay or share financial credentials because of a limited-time claim.',
});

function validReview(value, claim) {
  if (!value || value.claimId !== claim.claimId || value.onlineSearchPerformedByNvidia !== false
      || value.verificationChanged !== false || !Array.isArray(value.nextSteps)) return false;
  if (value.status === 'UNAVAILABLE') {
    return typeof value.reasonCode === 'string' && value.nextSteps.length === 0;
  }
  return value.status === 'GUIDANCE_AVAILABLE' && value.provider === 'NVIDIA_NIM'
    && value.assessedVerdict === claim.verdict
    && typeof value.model === 'string' && value.model.length <= 100
    && value.nextSteps.length >= 1 && value.nextSteps.length <= 3
    && new Set(value.nextSteps.map(step => step.id)).size === value.nextSteps.length
    && value.nextSteps.every(step => step && Object.hasOwn(STEPS, step.id)
      && step.text === STEPS[step.id]);
}

export default function GenieProofNvidiaReview({ offerText, claim }) {
  const [consent, setConsent] = useState(false);
  const [review, setReview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const controllerRef = useRef(null);

  useEffect(() => () => controllerRef.current?.abort(), []);

  async function submit() {
    if (!consent || busy || review?.status === 'GUIDANCE_AVAILABLE') return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(true);
    setReview(null);
    setError('');
    try {
      const next = await api.reviewGenieProofWithNvidia(offerText, claim.claimId, { signal: controller.signal });
      if (controller.signal.aborted || controllerRef.current !== controller) return;
      if (!validReview(next, claim)) throw new Error('INVALID_AI_REVIEW');
      setReview(next);
    } catch {
      if (!controller.signal.aborted && controllerRef.current === controller) {
        setError('AI guidance is unavailable. The financial evidence result above is unchanged.');
      }
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setBusy(false);
      }
    }
  }

  return (
    <aside style={{ marginTop: 12, padding: 14, border: '1px solid rgba(148,163,184,.25)', borderRadius: 10 }}>
      <h4 style={{ margin: '0 0 8px' }}>Optional NVIDIA guidance</h4>
      <p style={{ fontSize: '.9rem', lineHeight: 1.55 }}>
        NVIDIA can help decide what to investigate next. It does not browse live websites,
        provide independent evidence or change the verification result.
      </p>
      <label style={{ display: 'flex', gap: 9, fontSize: '.9rem', alignItems: 'flex-start' }}>
        <input type="checkbox" checked={consent} disabled={busy} onChange={e => setConsent(e.target.checked)} />
        I agree to send only this displayed financial statement and its check summary to NVIDIA for AI guidance.
      </label>
      <button type="button" disabled={!consent || busy || review?.status === 'GUIDANCE_AVAILABLE'}
        onClick={submit} style={{ marginTop: 10, padding: '9px 14px', borderRadius: 8 }}>
        {busy ? 'Getting guidance…' : 'Get NVIDIA guidance'}
      </button>
      {error && <p role="alert">{error}</p>}
      {review?.status === 'UNAVAILABLE' && (
        <p role="status">NVIDIA guidance is not available right now. No new evidence was checked.</p>
      )}
      {review?.status === 'GUIDANCE_AVAILABLE' && (
        <div aria-live="polite">
          <p><strong>What to check next</strong> <small>(AI-prioritized steps; not a fact-check)</small></p>
          <ul>{review.nextSteps.map(step => <li key={step.id}>{step.text}</li>)}</ul>
          <p style={{ fontSize: '.83rem' }}>
            NVIDIA did not check the internet. The evidence-based claim status above has not changed.
          </p>
        </div>
      )}
    </aside>
  );
}
