import React, { useEffect, useState } from 'react';
import * as api from '../services/api';

const INDICATOR_LABELS = new Set([
  'Savings Capacity',
  'Emergency Safety Net',
  'Investment Variety',
  'Goal Coverage',
]);

const FinancialIndicatorsPanel = ({ profile }) => {
  const profileId = profile?.profileId || null;
  const requestKey = JSON.stringify([profileId, profile?.version ?? profile?.profile_version ?? null]);
  const [retryKey, setRetryKey] = useState(0);
  const [request, setRequest] = useState({ profileId: null, indicators: null, error: null });

  useEffect(() => {
    if (!profileId) return undefined;
    const controller = new AbortController();
    api.getFinancialHealthScore(profileId, { signal: controller.signal })
      .then(data => {
        if (!Array.isArray(data?.sub_scores)) {
          throw new TypeError('The financial indicator service returned an incomplete response.');
        }
        const indicators = data.sub_scores
          .filter(metric => INDICATOR_LABELS.has(metric?.label) && typeof metric?.extra === 'string')
          .map(({ label, extra }) => ({ label, detail: extra }));
        setRequest({ profileId: requestKey, indicators, error: null });
      })
      .catch(error => {
        if (error?.code !== 'REQUEST_ABORTED' && error?.name !== 'AbortError') {
          setRequest({ profileId: requestKey, indicators: null, error: error?.message || 'Financial indicators are unavailable.' });
        }
      });
    return () => controller.abort();
  }, [profileId, requestKey, retryKey]);

  const currentRequest = request.profileId === requestKey ? request : null;

  return (
    <section className="financial-indicators-panel" aria-labelledby="financial-indicators-title">
      <header className="hub-header">
        <div className="hub-eyebrow">PROFILE-BASED INFORMATION</div>
        <h2 id="financial-indicators-title" className="hub-title">Financial Indicators</h2>
        <p className="hub-subtitle">
          Useful details from your saved profile and current recommendation. These indicators are shown individually, without an overall grade.
        </p>
      </header>

      {!profileId ? (
        <p role="status">Save your Financial Profile to view its indicators.</p>
      ) : !currentRequest ? (
        <p role="status">Loading financial indicators…</p>
      ) : currentRequest.error ? (
        <div role="alert">
          <p>{currentRequest.error}</p>
          <button type="button" onClick={() => setRetryKey(value => value + 1)}>
            Retry
          </button>
        </div>
      ) : currentRequest.indicators.length === 0 ? (
        <p role="status">No financial indicators are available for this profile yet.</p>
      ) : (
        <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
          {currentRequest.indicators.map(indicator => (
            <div key={indicator.label} style={{ padding: 18, borderRadius: 12, border: '1px solid rgba(148, 163, 184, 0.2)', background: 'rgba(15, 23, 42, 0.6)' }}>
              <dt style={{ color: '#bae6fd', fontWeight: 700, marginBottom: 8 }}>{indicator.label}</dt>
              <dd style={{ color: '#cbd5e1', margin: 0, lineHeight: 1.55 }}>{indicator.detail}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
};

export default FinancialIndicatorsPanel;
