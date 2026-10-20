import { useEffect, useState } from 'react';
import * as api from '../services/api';
import GenieProofPanel from './GenieProofPanel';

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
      setAvailability({ state: enabled ? 'enabled' : 'unavailable' });
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
          <p role="status">GenieProof is available as a research preview, but interactive operations are disabled on this server.</p>
          <p>
            The signed-passport workflow requires a deliberately enabled local research backend
            and trusted signing keys. Production financial claims remain unverified until their
            evidence sources and reuse permissions are independently qualified.
          </p>
        </>
      )}
    </section>
  );
}
