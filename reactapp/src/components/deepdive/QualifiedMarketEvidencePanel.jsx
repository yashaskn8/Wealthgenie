import React, { useEffect, useRef, useState } from 'react';
import { getStoredBenchmarkMarketFacts, getStoredEquityHistory } from '../../services/api';

const panelStyle = { border: '1px solid var(--ddm-border, #64748b55)',
  borderRadius: 12, padding: 16, marginBlock: 12 };
const price = value => typeof value === 'number' && Number.isFinite(value)
  ? value.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : 'Unavailable';
function when(value) {
  if (typeof value !== 'string' && !(value instanceof Date)) return 'Unavailable';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short',
  }) : 'Unavailable';
}
function todayMinus(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}
export default function QualifiedMarketEvidencePanel() {
  const [expanded, setExpanded] = useState(false);
  const [quotes, setQuotes] = useState(null);
  const [quoteError, setQuoteError] = useState(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [query, setQuery] = useState({
    exchange: 'NSE', symbol: 'RELIANCE', isin: 'INE002A01018',
    fromDate: todayMinus(30), toDate: todayMinus(2), basis: 'RAW',
  });
  const [history, setHistory] = useState(null);
  const [historyError, setHistoryError] = useState(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const historyController = useRef(null);
  useEffect(() => {
    if (!expanded) return undefined;
    const controller = new AbortController();
    setQuotes(null);
    setQuoteError(null);
    setQuoteLoading(true);
    getStoredBenchmarkMarketFacts({ signal: controller.signal, retries: 0 })
      .then(value => { if (!controller.signal.aborted) setQuotes(value); })
      .catch(() => { if (!controller.signal.aborted) setQuoteError('Stored market observations could not be read.'); })
      .finally(() => { if (!controller.signal.aborted) setQuoteLoading(false); });
    return () => controller.abort();
  }, [expanded]);
  useEffect(() => () => historyController.current?.abort(), []);
  async function loadHistory(event) {
    event.preventDefault();
    historyController.current?.abort();
    const controller = new AbortController();
    historyController.current = controller;
    setHistoryLoading(true);
    setHistoryError(null);
    setHistory(null);
    try {
      const result = await getStoredEquityHistory(query, { signal: controller.signal, retries: 0 });
      if (!controller.signal.aborted) setHistory(result);
    } catch {
      if (!controller.signal.aborted) setHistoryError('Qualified stored history is unavailable.');
    } finally {
      if (historyController.current === controller) {
        historyController.current = null;
        if (!controller.signal.aborted) setHistoryLoading(false);
      }
    }
  }
  const facts = Array.isArray(quotes?.facts) ? quotes.facts.filter(fact => (
    ['market:index:nifty-50', 'market:index:india-vix'].includes(fact.canonicalProductId)
  )) : [];
  const bars = Array.isArray(history?.bars) ? history.bars : [];
  const change = (field, value) => setQuery(current => ({ ...current, [field]: value }));
  return (
    <section style={panelStyle} aria-label="Verified market data evidence"
      data-testid="qualified-market-evidence">
      <button type="button" onClick={() => setExpanded(value => !value)}
        aria-expanded={expanded} aria-controls="market-evidence-content">
        {expanded ? 'Hide' : 'View'} stored prices and history
      </button>
      <p style={{ fontSize: '0.82rem', opacity: 0.8 }}>
        Authorized stored provider observations only. No invented prices or portfolio changes.
      </p>
      {expanded && (
        <div id="market-evidence-content">
          <h4>NIFTY 50 and India VIX — stored observations</h4>
          {quoteLoading && <p role="status">Loading stored market observations…</p>}
          {quoteError && <p role="status">{quoteError}</p>}
          {!quoteLoading && quotes && quotes.status !== 'AVAILABLE' && quotes.status !== 'PARTIAL' && (
            <p>No authorized stored benchmark observations are available.</p>
          )}
          {quotes?.status === 'PARTIAL' && <p role="status">Only some stored benchmark observations are available.</p>}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
            {facts.map(fact => (
              <div key={fact.canonicalProductId} style={{ ...panelStyle, flex: '1 1 150px', margin: 0 }}>
                <strong>{fact.canonicalProductId.endsWith('india-vix') ? 'India VIX' : 'NIFTY 50'}</strong>
                <div>{fact.availabilityStatus === 'AVAILABLE' ? price(fact.value) : 'Unavailable'}</div>
                <small>Source: {fact.source?.provider || quotes.provider || 'Unknown'}</small>
                <div><small>Provider observed: {when(fact.observedAt)}</small></div>
                <div><small>Fetched: {when(fact.fetchedAt)}</small></div>
                <div><small>Freshness: {fact.freshness?.status || 'UNKNOWN'}</small></div>
              </div>
            ))}
          </div>
          <h4>Stored qualified daily equity history</h4>
          <p style={{ fontSize: '0.82rem' }}>Records appear only when retained with applicable
            provider permissions. Adjusted close and raw OHLC are distinct.</p>
          <form onSubmit={loadHistory} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
            <label>Exchange
              <select value={query.exchange} onChange={e => change('exchange', e.target.value)}>
                <option value="NSE">NSE</option><option value="BSE">BSE</option>
              </select>
            </label>
            <label>Symbol
              <input aria-label="Trading symbol" value={query.symbol}
                onChange={e => change('symbol', e.target.value.toUpperCase())} maxLength={30} required />
            </label>
            <label>ISIN
              <input aria-label="Equity ISIN" value={query.isin}
                onChange={e => change('isin', e.target.value.toUpperCase())} maxLength={12} required />
            </label>
            <label>From
              <input aria-label="History from date" type="date" value={query.fromDate}
                onChange={e => change('fromDate', e.target.value)} required />
            </label>
            <label>To
              <input aria-label="History to date" type="date" value={query.toDate}
                onChange={e => change('toDate', e.target.value)} required />
            </label>
            <label>Price basis
              <select aria-label="Price basis" value={query.basis}
                onChange={e => change('basis', e.target.value)}>
                <option value="RAW">Raw / provider-native</option>
                <option value="ADJUSTED">Adjusted close</option>
              </select>
            </label>
            <button type="submit" disabled={historyLoading}>
              {historyLoading ? 'Loading…' : 'Read stored history'}
            </button>
          </form>
          {historyError && <p role="status">{historyError}</p>}
          {history && <div role="status">
            <p>{history.status === 'AVAILABLE'
              ? String(history.barCount) + ' qualified observations'
              : 'No qualified retained history: ' + (history.code || 'UNAVAILABLE')}</p>
            {bars.length > 0 && <div style={{ overflowX: 'auto', maxHeight: 230, overflowY: 'auto' }}>
              <table style={{ minWidth: 590, width: '100%', textAlign: 'left' }}>
                <thead><tr><th>Trading date</th><th>Provider</th><th>Basis</th><th>Open</th>
                  <th>High</th><th>Low</th><th>Raw close</th><th>Adjusted close</th>
                  <th>Volume</th><th>Provider observed</th><th>Fetched</th></tr></thead>
                <tbody>{bars.slice(-50).reverse().map(bar => (
                  <tr key={[bar.tradingDate, bar.provider, bar.priceBasis].join(':')}>
                    <td>{bar.tradingDate}</td><td>{bar.provider}</td><td>{bar.priceBasis}</td>
                    <td>{price(bar.open)}</td><td>{price(bar.high)}</td><td>{price(bar.low)}</td>
                    <td>{price(bar.close)}</td><td>{price(bar.adjustedClose)}</td>
                    <td>{price(bar.volume)}</td><td>{when(bar.providerObservedAt)}</td>
                    <td>{when(bar.fetchedAt)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>}
          </div>}
        </div>
      )}
    </section>
  );
}
