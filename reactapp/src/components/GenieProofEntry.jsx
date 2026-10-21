import { useEffect, useState } from 'react';
import * as api from '../services/api';
import GenieProofPanel from './GenieProofPanel';
import GenieProofClaimPreview from './GenieProofClaimPreview';

const SETUP_GUIDANCE = Object.freeze({
  GENIEPROOF_LOCAL_RESEARCH_ONLY: 'Signed passports are restricted to a development or test backend. Production activation is blocked pending financial source-rights and verification approval; signing keys alone do not unlock it.',
  GENIEPROOF_FLAG_DISABLED: 'The local research workflow is disabled. Set GENIEPROOF_ENABLED=true in the backend environment and restart the backend.',
  GENIEPROOF_SIGNING_KEYS_MISSING: 'The local backend is missing GenieProof signing configuration. Supply GENIEPROOF_SIGNING_PRIVATE_KEY, GENIEPROOF_SIGNING_PUBLIC_KEY, and GENIEPROOF_SIGNING_KEY_ID to the backend process, then restart it.',
  GENIEPROOF_SIGNING_CONFIGURATION_INVALID: 'The local GenieProof signing configuration was rejected. Verify that the Ed25519 private/public keys match, the key ID is valid and not revoked, and any optional trusted-key JSON is valid. Never paste private keys into the browser.',
});

export default function GenieProofEntry() {
  const [revision, setRevision] = useState(0);
  const [availability, setAvailability] = useState({ state: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    api.getGenieProofCapabilities({ signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      const enabled = result?.interactiveEnabled === true
        && result?.mode === 'LOCAL_RESEARCH'
        && result?.productionVerified === false;
      setAvailability({
        state: enabled ? 'enabled' : 'unavailable',
        previewEnabled: result?.extractionPreviewEnabled === true,
        reasonCode: typeof result?.reasonCode === 'string' ? result.reasonCode : null,
      });
    }).catch(() => {
      if (!controller.signal.aborted) setAvailability({ state: 'error' });
    });
    return () => controller.abort();
  }, [revision]);

  if (availability.state === 'enabled') return <GenieProofPanel />;

  return (
    <section aria-labelledby="genieproof-availability-title" style={{
      maxWidth: 900, margin: '32px auto', padding: 24,
      border: '1px solid rgba(148, 163, 184, 0.3)', borderRadius: 12,
    }}>
      <h1 id="genieproof-availability-title">GenieProof</h1>
      {availability.state === 'loading' ? (
        <p role="status">Checking GenieProof availability…</p>
      ) : availability.state === 'error' ? (
        <>
          <p role="alert">GenieProof availability could not be checked. No claim has been verified.</p>
          <button type="button" onClick={() => {
            setAvailability({ state: 'loading' });
            setRevision(value => value + 1);
          }}>
            Retry availability check
          </button>
        </>
      ) : (
        <>
          <p role="status">Signed GenieProof passports and evidence-based verdicts are unavailable on this server.</p>
          <p>
            {SETUP_GUIDANCE[availability.reasonCode] ||
              'The signed workflow has not been authorized by this backend. No claim is verified or signed in this preview.'}
          </p>
          <p>
            You can still review unsaved candidate statements below. This does not check current rates,
            establish financial correctness, or create a signed passport.
          </p>
          {availability.previewEnabled && <GenieProofClaimPreview />}
        </>
      )}
    </section>
  );
}
