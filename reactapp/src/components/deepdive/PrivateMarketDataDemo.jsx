import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getPrivateMarketDemoData } from '../../services/api';
import { formatMarketTimestamp, nullableMarketNumber } from '../../utils/marketDataDisplay';
import { findPrivateQuoteForProduct, getPrivateMarketObservationRows } from '../../utils/privateMarketQuote';
import './PrivateMarketDataDemo.css';

const PRIVATE_PROVIDER_FAILURES = Object.freeze({
  PROVIDER_NOT_CONFIGURED: 'Upstox token is missing on the local backend. Configure the server-only read-only token, then retry.',
  UPSTOX_AUTHENTICATION_FAILED: 'Upstox rejected the server token. Check its expiry and refresh the backend credential.',
  UPSTOX_PERMISSION_DENIED: 'Upstox denied this read-only quote endpoint for the configured account.',
  UPSTOX_RATE_LIMITED: 'Upstox rate-limited this request. Wait before retrying.',
  UPSTOX_TIMEOUT: 'The Upstox quote request timed out. Check the connection before retrying.',
  UPSTOX_NETWORK_ERROR: 'The backend could not reach Upstox. Check internet connectivity.',
  UPSTOX_RESPONSE_INVALID: 'Upstox returned a response the server could not safely verify.',
  UPSTOX_INSTRUMENT_UNAVAILABLE: 'Upstox did not return the requested market instrument.',
  UPSTOX_PROVIDER_UNAVAILABLE: 'The Upstox quote service is temporarily unavailable.',
  UPSTOX_FETCH_FAILED: 'The Upstox quote request failed. Check the backend provider diagnostics.',
  MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED: 'Source permissions do not allow this quote request. Nothing was fetched.',
});

function providerStatusExplanation(snapshot) {
  const provider = snapshot?.upstox;
  if (!provider || typeof provider !== 'object') return 'The server returned an invalid market response.';
  const code = provider.error?.code;
  if (typeof code === 'string'
      && Object.prototype.hasOwnProperty.call(PRIVATE_PROVIDER_FAILURES, code)) {
    return PRIVATE_PROVIDER_FAILURES[code];
  }
  if (provider.status === 'PARTIAL') return 'Only some Upstox instruments returned verified observations; unavailable prices remain blank.';
  if (provider.status !== 'AVAILABLE') return 'No qualified Upstox observations were returned. Review the backend provider status.';
  return null;
}

function quoteText(fact, providerStatus) {
  const value = typeof fact?.value === 'number' ? nullableMarketNumber(fact.value) : null;
  if (!['AVAILABLE', 'PARTIAL'].includes(providerStatus)
      || fact?.availabilityStatus !== 'AVAILABLE'
      || value === null || value <= 0) return null;
  const text = value.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const unit = fact.unit === 'INDEX_POINTS' ? 'pts' : fact.currency || '';
  return unit ? `${text} ${unit}` : text;
}

export default function PrivateMarketDataDemo({ autoLoad = false, canonicalProductIds = [], onSnapshot }) {
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const requestRevision = useRef(0);
  const canonicalProductIdsKey = Array.isArray(canonicalProductIds) ? canonicalProductIds.join(',') : '';
  const requestedProductIds = useMemo(
    () => canonicalProductIdsKey ? canonicalProductIdsKey.split(',') : [],
    [canonicalProductIdsKey],
  );

  const loadDemoData = useCallback(async (signal) => {
    if (requestedProductIds.length === 0) {
      setSnapshot(null);
      setError(null);
      setLoading(false);
      onSnapshot?.(null, requestedProductIds);
      return;
    }
    const revision = ++requestRevision.current;
    setLoading(true);
    setError(null);
    setSnapshot(null);
    onSnapshot?.(null, requestedProductIds);
    try {
      const data = await getPrivateMarketDemoData(requestedProductIds, { signal });
      if (!data || typeof data !== 'object' || Array.isArray(data)
          || !data.upstox || typeof data.upstox !== 'object' || Array.isArray(data.upstox)) {
        throw new TypeError('Invalid private market-data response');
      }
      if (requestRevision.current === revision && !signal?.aborted) {
        const facts = requestedProductIds
          .map(id => findPrivateQuoteForProduct(data, id))
          .filter(Boolean);
        const scopedData = { ...data, upstox: { ...data.upstox, facts } };
        setSnapshot(scopedData);
        onSnapshot?.(scopedData, requestedProductIds);
      }
    } catch (requestError) {
      if (requestRevision.current === revision && !signal?.aborted) {
        onSnapshot?.(null, requestedProductIds);
        setError(requestError?.code === 'PRIVATE_MARKET_DEMO_UNAVAILABLE'
          ? 'The local authenticated provider demo is disabled on this server.'
          : 'Provider data could not be loaded. Check local server and provider status.');
      }
    } finally {
      if (requestRevision.current === revision && !signal?.aborted) setLoading(false);
    }
  }, [onSnapshot, requestedProductIds]);

  useEffect(() => {
    if (!autoLoad) return undefined;
    if (requestedProductIds.length === 0) {
      loadDemoData();
      return undefined;
    }
    const controller = new AbortController();
    // StrictMode's development remount cancels the first timer before a
    // provider request is sent, preserving the small private-demo budget.
    const timer = window.setTimeout(() => loadDemoData(controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      requestRevision.current += 1;
    };
  }, [autoLoad, loadDemoData, requestedProductIds.length]);

  const quotes = getPrivateMarketObservationRows(snapshot, requestedProductIds);
  const providerExplanation = snapshot ? providerStatusExplanation(snapshot) : null;

  return (
    <section className="private-market-demo" aria-labelledby="private-market-demo-title" data-testid="private-market-demo">
      <div className="private-market-demo__heading">
        <div>
          <h4 id="private-market-demo-title">Upstox quotes for this category</h4>
          <p>Only exact, registered product matches are requested. These private observations do not change your plan.</p>
        </div>
        <button type="button" onClick={() => loadDemoData()} disabled={loading || requestedProductIds.length === 0}>
          {loading ? 'Fetching…' : snapshot ? 'Refresh matched quote' : 'Load matched quote'}
        </button>
      </div>

      {requestedProductIds.length === 0 && (
        <p className="private-market-demo__provider-note" role="status">
          No exact Upstox instrument is registered for a product in this category. Quotes from other products and market indices are hidden.
        </p>
      )}

      {error && <p className="private-market-demo__error" role="alert">{error}</p>}
      {snapshot && (
        <div className="private-market-demo__results" aria-live="polite">
          <div className="private-market-demo__provider">
            <div className="private-market-demo__provider-title">
              <strong>Upstox · exact product quote response</strong>
              <span>{snapshot.upstox?.status || 'UNAVAILABLE'}</span>
            </div>
            {providerExplanation && <p className="private-market-demo__provider-note" role="status">{providerExplanation}</p>}
            <div className="private-market-demo__quotes">
              {quotes.map(row => (
                <div key={row.canonicalProductId} data-testid={`private-quote-${row.canonicalProductId}`}>
                  <span>{row.name}</span>
                  <strong>{row.formattedValue || quoteText(
                    snapshot.upstox.facts.find(fact => fact.canonicalProductId === row.canonicalProductId),
                    snapshot?.upstox?.status,
                  ) || 'Unavailable'}</strong>
                  <small>Last trade: {formatMarketTimestamp(row.lastTradeAt) || 'Unavailable'}</small>
                  <small>Provider response: {formatMarketTimestamp(row.responseGeneratedAt) || 'Unavailable'}</small>
                  <small>Fetched: {formatMarketTimestamp(row.fetchedAt) || 'Unavailable'}</small>
                  <small>{row.freshness}{Number.isFinite(row.ageSeconds) ? ` · ${row.ageSeconds}s since trade` : ''}</small>
                  {row.freshness !== 'FRESH' && <small>Last-traded observation only — not a current live quote.</small>}
                </div>
              ))}
              {quotes.length === 0 && <span>No usable quote was returned for the exact product in this category.</span>}
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
