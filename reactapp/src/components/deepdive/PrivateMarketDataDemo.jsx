import { useCallback, useEffect, useRef, useState } from 'react';
import { getPrivateMarketDemoData } from '../../services/api';
import { formatMarketTimestamp, nullableMarketNumber } from '../../utils/marketDataDisplay';
import './PrivateMarketDataDemo.css';

function quoteText(fact, providerStatus) {
  const value = nullableMarketNumber(fact?.value);
  if (!['AVAILABLE', 'PARTIAL'].includes(providerStatus)
      || fact?.availabilityStatus !== 'AVAILABLE'
      || value === null || value <= 0) return null;
  const text = value.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const unit = fact.unit === 'INDEX_POINTS' ? 'pts' : fact.currency || '';
  return unit ? `${text} ${unit}` : text;
}

function quoteName(fact) {
  const names = {
    'market:index:nifty-50': 'NIFTY 50',
    'market:index:india-vix': 'India VIX',
    'etf:isin:INF204KB14I2': 'Nippon India ETF Nifty 50 BeES',
  };
  return names[fact?.canonicalProductId]
    || fact?.source?.instrumentId?.split('|').at(-1)
    || 'Market instrument';
}

export default function PrivateMarketDataDemo({ autoLoad = false, onSnapshot }) {
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const requestRevision = useRef(0);

  const loadDemoData = useCallback(async (signal) => {
    const revision = ++requestRevision.current;
    setLoading(true);
    setError(null);
    setSnapshot(null);
    onSnapshot?.(null);
    try {
      const data = await getPrivateMarketDemoData({ signal });
      if (requestRevision.current === revision && !signal?.aborted) {
        setSnapshot(data);
        onSnapshot?.(data);
      }
    } catch (requestError) {
      if (requestRevision.current === revision && !signal?.aborted) {
        setError(requestError?.code === 'PRIVATE_MARKET_DEMO_UNAVAILABLE'
          ? 'The local authenticated provider demo is disabled on this server.'
          : 'Provider data could not be loaded. Check local server and provider status.');
      }
    } finally {
      if (requestRevision.current === revision && !signal?.aborted) setLoading(false);
    }
  }, [onSnapshot]);

  useEffect(() => {
    if (!autoLoad) return undefined;
    const controller = new AbortController();
    // StrictMode's development remount cancels the first timer before a
    // provider request is sent, preserving the small private-demo budget.
    const timer = window.setTimeout(() => loadDemoData(controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      requestRevision.current += 1;
    };
  }, [autoLoad, loadDemoData]);

  const quotes = snapshot?.upstox?.facts || [];

  return (
    <section className="private-market-demo" aria-labelledby="private-market-demo-title" data-testid="private-market-demo">
      <div className="private-market-demo__heading">
        <div>
          <h4 id="private-market-demo-title">Upstox market observations</h4>
          <p>Authenticated local educational demo. Quotes are fetched from Upstox and not saved.</p>
        </div>
        <button type="button" onClick={() => loadDemoData()} disabled={loading}>
          {loading ? 'Fetching…' : snapshot ? 'Refresh quotes' : 'Load Upstox quotes'}
        </button>
      </div>

      {error && <p className="private-market-demo__error" role="alert">{error}</p>}
      {snapshot && (
        <div className="private-market-demo__results" aria-live="polite">
          <div className="private-market-demo__provider">
            <div className="private-market-demo__provider-title">
              <strong>Upstox · market quote response</strong>
              <span>{snapshot.upstox?.status || 'UNAVAILABLE'}</span>
            </div>
            <div className="private-market-demo__quotes">
              {quotes.map(fact => (
                <div key={fact.canonicalProductId} data-testid={`private-quote-${fact.canonicalProductId}`}>
                  <span>{quoteName(fact)}</span>
                  <strong>{quoteText(fact, snapshot?.upstox?.status) ?? 'Unavailable'}</strong>
                  <small>Last trade: {formatMarketTimestamp(fact.quoteLastTradeAt || fact.observedAt) || 'Unavailable'}</small>
                  <small>Provider response: {formatMarketTimestamp(fact.quoteResponseGeneratedAt) || 'Unavailable'}</small>
                  <small>Fetched: {formatMarketTimestamp(fact.providerResponseReceivedAt || fact.fetchedAt) || 'Unavailable'}</small>
                  <small>{fact.freshness?.status || 'UNKNOWN'}
                    {Number.isFinite(fact.freshness?.ageSeconds) ? ` · ${fact.freshness.ageSeconds}s since trade` : ''}</small>
                </div>
              ))}
              {quotes.length === 0 && <span>No quote observations returned.</span>}
            </div>
          </div>

          <p className="private-market-demo__provenance">
            Last trade, provider response, fetched time, and freshness are shown separately. Storage: {snapshot.persistence || 'Unverified'}. This local demo does not update recommendations or imply commercial publication rights.
          </p>
        </div>
      )}
    </section>
  );
}
