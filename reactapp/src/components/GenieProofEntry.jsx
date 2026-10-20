import { useEffect, useState } from 'react';
import * as api from '../services/api';
import GenieProofPanel from './GenieProofPanel';
import GenieProofClaimPreview from './GenieProofClaimPreview';

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
            The full workflow requires a deliberately configured research backend, trusted signing keys,
            and approved evidence sources. No claim is verified or signed in this preview.
          </p>
          {availability.previewEnabled && <GenieProofClaimPreview />}
        </>
      )}
    </section>
  );
}
