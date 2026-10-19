import React, { useEffect, useState } from 'react';
import * as api from '../../services/api';

function numberText(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('en-IN', { maximumFractionDigits: 2 })
    : 'Unavailable';
}
function whenText(value) {
  const date = typeof value === 'string' ? new Date(value) : null;
  return date && Number.isFinite(date.getTime())
    ? date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })
    : 'Unverified';
}

const card = {
  border: '1px solid var(--ddm-border, #64748b44)',
  borderRadius: '12px', padding: '12px', flex: '1 1 160px',
};
const muted = { fontSize: '0.8rem', opacity: 0.8 };

/**
 * Independent educational quote view. Its data are NOT market-context
 * authority and can NEVER modify allocations or deterministic recommendations.
 */
export default function PrivateMarketDemoPanel() {
  const local = import.meta.env.DEV && import.meta.env.MODE !== 'test'
    && typeof window !== 'undefined'
    && ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(local);
  const [error, setError] = useState(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!local || typeof api.getPrivateMarketDemo !== 'function') return undefined;
    const controller = new AbortController();
    api.getPrivateMarketDemo({ signal: controller.signal, retries: 0 })
      .then(data => {
        if (!controller.signal.aborted) setSnapshot(data);
      })
      .catch(err => {
        if (!controller.signal.aborted) {
          setSnapshot(null);
          setError(err?.status === 404
            ? 'Private API preview is disabled on this backend.'
            : err?.status === 401 ? 'Sign in to view your private market preview.'
              : 'Could not retrieve the private market preview.');
        }
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [local, revision]);

  const refresh = () => {
    setLoading(true);
    setError(null);
    setRevision(n => n + 1);
  };

  if (!local) return null;

  const quotes = snapshot?.quotes?.facts || [];
  const candles = snapshot?.eod?.candles || [];
  const latest = candles.at(-1) || null;

  return (
    <section aria-label="Private provider integration preview" data-testid="private-market-demo"
      style={{ ...card, marginBlock: '12px', background: 'var(--ddm-card-bg, transparent)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <strong>Read-only market API verification</strong>
          <div style={muted}>Private local development only — separate from investment recommendations</div>
        </div>
        <button type="button" onClick={refresh} disabled={loading}
          aria-label="Refresh private market API evidence">
          {loading ? 'Checking…' : 'Refresh observations'}
        </button>
      </div>
      {error && <p role="status">{error}</p>}
      {snapshot && <>
        <p style={muted}>
          Status: {snapshot.status} · Storage: {snapshot.storedIn}
          {' · '}Checked: {whenText(snapshot.checkedAt)}
          {' · '}Cache: {snapshot.cache?.quoteHit ? 'reused' : 'refreshed'}
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {quotes.map(quote => (
            <div key={quote.canonicalProductId} style={card} data-testid={'private-quote-' + quote.canonicalProductId}>
              <div style={muted}>{quote.name} · {quote.provider}</div>
              <div style={{ fontSize: '1.35rem', fontWeight: 700 }}>
                {quote.status === 'AVAILABLE' ? numberText(quote.price) : 'Unavailable'}
              </div>
              <div style={muted}>Last trade: {whenText(quote.observedAt)}</div>
              <div style={muted}>Fetched: {whenText(quote.receivedAt)}</div>
              <div style={muted}>Observation: {quote.freshness?.status || 'UNKNOWN'}
                {quote.freshness?.ageSeconds != null ? ` · ${quote.freshness.ageSeconds}s since trade` : ''}
              </div>
            </div>
          ))}
        </div>
        <div style={{ ...card, marginTop: 10 }}>
          <strong>TejHQ historical EOD — NSE RELIANCE</strong>
          <p style={muted}>Raw daily closes, not real-time quotes. No forecast or trading recommendation.</p>
          <div role="status">
            {snapshot.eod?.status === 'AVAILABLE' && latest
              ? 'Last EOD close: ' + numberText(latest.close) + ' (' + latest.tradingDate + ')'
              : 'Historical data unavailable: ' + (snapshot.eod?.code || snapshot.eod?.reasonCode || 'UNKNOWN')}
          </div>
          {candles.length > 0 && (
            <div style={{ overflowX: 'auto', maxHeight: '160px', overflowY: 'auto' }}>
              <table style={{ width: '100%', textAlign: 'left', fontSize: '0.85rem' }}>
                <thead><tr><th>Trading date</th><th>Open</th><th>High</th><th>Low</th><th>Close</th></tr></thead>
                <tbody>{candles.slice(-7).reverse().map(row => (
                  <tr key={row.tradingDate}>
                    <td>{row.tradingDate}</td><td>{numberText(row.open)}</td>
                    <td>{numberText(row.high)}</td><td>{numberText(row.low)}</td><td>{numberText(row.close)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </div>
      </>}
      <p style={muted}>
        This screen shows temporary provider-backed observations only. Public/commercial
        data publication remains disabled; nothing from this panel changes your plan.
      </p>
    </section>
  );
}
