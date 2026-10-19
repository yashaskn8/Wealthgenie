import { useState } from 'react';
import { getPrivateMarketDemoData } from '../../services/api';
import { formatMarketTimestamp, nullableMarketNumber } from '../../utils/marketDataDisplay';
import './PrivateMarketDataDemo.css';

function quoteText(fact) {
  const value = nullableMarketNumber(fact?.value);
  if (fact?.availabilityStatus !== 'AVAILABLE' || value === null) return 'Unavailable';
  return value.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function quoteTime(fact) {
  return formatMarketTimestamp(fact?.quoteLastTradeAt
    || fact?.observedAt
    || fact?.providerResponseReceivedAt
    || fact?.fetchedAt) || 'Timestamp unavailable';
}

export default function PrivateMarketDataDemo() {
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function loadDemoData() {
    setLoading(true);
    setError(null);
    setSnapshot(null);
    try {
      setSnapshot(await getPrivateMarketDemoData());
    } catch (requestError) {
      setError(requestError?.code === 'PRIVATE_MARKET_DEMO_UNAVAILABLE'
        ? 'The local authenticated provider demo is disabled on this server.'
        : 'Provider data could not be loaded. Check local server and provider status.');
    } finally {
      setLoading(false);
    }
  }

  const quotes = snapshot?.upstox?.facts || [];
  const candles = snapshot?.tejHq?.candles || [];
  const latestClose = [...candles].reverse().find(candle => nullableMarketNumber(candle?.close) !== null);

  return (
    <section className="private-market-demo" aria-labelledby="private-market-demo-title" data-testid="private-market-demo">
      <div className="private-market-demo__heading">
        <div>
          <h4 id="private-market-demo-title">Local provider data check</h4>
          <p>Authenticated local educational demo. Data is fetched on demand and not saved.</p>
        </div>
        <button type="button" onClick={loadDemoData} disabled={loading}>
          {loading ? 'Fetching…' : snapshot ? 'Refresh providers' : 'Load provider data'}
        </button>
      </div>

      {error && <p className="private-market-demo__error" role="alert">{error}</p>}
      {snapshot && (
        <div className="private-market-demo__results" aria-live="polite">
          <div className="private-market-demo__provider">
            <div className="private-market-demo__provider-title">
              <strong>Upstox · live quote response</strong>
              <span>{snapshot.upstox?.status || 'UNAVAILABLE'}</span>
            </div>
            <div className="private-market-demo__quotes">
              {quotes.map(fact => (
                <div key={fact.canonicalProductId}>
                  <span>{fact.displayName}</span>
                  <strong>{quoteText(fact)} {fact.unit === 'INDEX_POINTS' ? 'pts' : fact.currency || ''}</strong>
                  <small>{quoteTime(fact)} · {fact.freshness?.status || 'UNKNOWN'}</small>
                </div>
              ))}
              {quotes.length === 0 && <span>No quote observations returned.</span>}
            </div>
          </div>

          <div className="private-market-demo__provider">
            <div className="private-market-demo__provider-title">
              <strong>TejHQ · historical EOD only</strong>
              <span>{snapshot.tejHq?.status || 'UNAVAILABLE'}</span>
            </div>
            {latestClose ? (
              <p>
                INFY latest returned close: <strong>{nullableMarketNumber(latestClose.close)?.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</strong>
                {' '}on {latestClose.date || latestClose.tradingDate || 'date unavailable'}.
              </p>
            ) : <p>No qualified EOD candle was returned.</p>}
            <small>
              Observed: {formatMarketTimestamp(snapshot.tejHq?.observedAt) || snapshot.tejHq?.observedDate || 'Unavailable'}
              {' '}· Fetched: {formatMarketTimestamp(snapshot.tejHq?.fetchedAt) || 'Unavailable'}
              {' '}· {snapshot.tejHq?.freshness?.status || 'UNKNOWN'}
            </small>
          </div>

          <p className="private-market-demo__provenance">
            Provider timestamps and freshness are preserved. This local demo does not update recommendations or imply commercial publication rights.
          </p>
        </div>
      )}
    </section>
  );
}
