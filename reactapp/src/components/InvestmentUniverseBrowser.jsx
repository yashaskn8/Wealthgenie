import React, { useEffect, useMemo, useRef, useState } from 'react';
import { getFinancialUniverse, getFinancialUniverseSummary, getCurrentProfile, getQualifiedFamilyTopProducts } from '../services/api';

const PAGE_SIZE = 25;
const REQUEST_LIMIT = 100;
const MAX_REQUEST_PAGES = 30;

async function loadFinancialUniverse(signal) {
  const summary = await getFinancialUniverseSummary({ signal });
  if (!Number.isSafeInteger(summary?.totalCount) || summary.totalCount < 0) {
    throw new Error('FINANCIAL_UNIVERSE_SUMMARY_INVALID');
  }
  const rows = [];
  const seenIds = new Set();
  const seenCursors = new Set();
  let cursor = null;
  for (let pageNumber = 0; pageNumber < MAX_REQUEST_PAGES; pageNumber += 1) {
    const response = await getFinancialUniverse({ limit: REQUEST_LIMIT, ...(cursor ? { cursor } : {}) }, { signal });
    if (!response || !Array.isArray(response.items)) {
      throw new Error('FINANCIAL_UNIVERSE_INVALID_RESPONSE');
    }
    for (const item of response.items) {
      if (!item || typeof item.id !== 'string' || seenIds.has(item.id)) {
        throw new Error('FINANCIAL_UNIVERSE_DUPLICATE_OR_INVALID_ID');
      }
      seenIds.add(item.id);
      rows.push(item);
    }
    const nextCursor = response.nextCursor || null;
    if (!nextCursor) {
      if (rows.length !== summary.totalCount) throw new Error('FINANCIAL_UNIVERSE_COUNT_MISMATCH');
      return { rows, summary };
    }
    if (typeof nextCursor !== 'string' || seenCursors.has(nextCursor) || nextCursor === cursor) {
      throw new Error('FINANCIAL_UNIVERSE_INVALID_CURSOR');
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw new Error('FINANCIAL_UNIVERSE_PAGE_LIMIT_EXCEEDED');
}

/**
 * Read-only discovery view of PostgreSQL financial product families.
 * It is deliberately separate from personalized recommendation eligibility.
 */
export default function InvestmentUniverseBrowser() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState('idle');
  const [items, setItems] = useState([]);
  const [summary, setSummary] = useState(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [subcategory, setSubcategory] = useState('');
  const [pageIndex, setPageIndex] = useState(0);
  const [selectedFamilyId, setSelectedFamilyId] = useState(null);
  const [compareStatus, setCompareStatus] = useState('idle');
  const [compareResult, setCompareResult] = useState(null);
  const compareController = useRef(null);
  useEffect(() => () => compareController.current?.abort(), []);

  const compareFamily = async familyId => {
    compareController.current?.abort();
    const controller = new AbortController();
    compareController.current = controller;
    setSelectedFamilyId(familyId);
    setCompareResult(null);
    setCompareStatus('loading');
    try {
      const profile = await getCurrentProfile({ signal: controller.signal });
      const profileId = profile?.profileId;
      if (!/^[a-fA-F0-9]{24}$/.test(profileId || '')) {
        throw new Error('A complete current financial profile is required.');
      }
      const result = await getQualifiedFamilyTopProducts(familyId, profileId, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!result || !Array.isArray(result.products) || result.products.length > 3) {
        throw new Error('Invalid financial product comparison response.');
      }
      setCompareResult(result);
      setCompareStatus('loaded');
    } catch (error) {
      if (controller.signal.aborted) return;
      setCompareResult({ reasonCode: error?.code || 'COMPARISON_UNAVAILABLE' });
      setCompareStatus('error');
    }
  };


  useEffect(() => {
    if (!open || status !== 'loading') return undefined;
    const controller = new AbortController();
    let active = true;
    loadFinancialUniverse(controller.signal).then(result => {
      if (!active) return;
      setItems(result.rows);
      setSummary(result.summary);
      setStatus('loaded');
    }).catch(() => {
      if (!active || controller.signal.aborted) return;
      setStatus('error');
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [open, status]);

  const categories = useMemo(
    () => [...new Set(items.map(item => item.category).filter(Boolean))].sort(),
    [items],
  );
  const subcategories = useMemo(
    () => [...new Set(items.filter(item => !category || item.category === category)
      .map(item => item.subcategory).filter(Boolean))].sort(),
    [items, category],
  );
  const filtered = useMemo(() => {
    const lower = query.trim().toLowerCase();
    return items.filter(item => (
      (!category || item.category === category)
      && (!subcategory || item.subcategory === subcategory)
      && (!lower || [item.name, item.category, item.subcategory, item.id]
        .some(field => String(field || '').toLowerCase().includes(lower)))
    ));
  }, [items, query, category, subcategory]);

  const maxPage = Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1);
  const currentPage = Math.min(pageIndex, maxPage);
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  const toggle = () => {
    if (!open && status !== 'loaded') setStatus('loading');
    setOpen(value => !value);
  };
  const retry = () => {
    setItems([]);
    setSummary(null);
    setPageIndex(0);
    setStatus('loading');
  };

  return (
    <section aria-label="Complete investment universe" data-testid="investment-universe-browser"
      style={{ marginTop: 16, marginBottom: 12, padding: 16, border: '1px solid rgba(56,189,248,.22)', borderRadius: 14, background: 'rgba(3,16,31,.52)' }}>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div>
          <strong style={{ color: '#e0f2fe', fontSize: '0.9rem' }}>Explore the complete investment universe</strong>
          <p style={{ color: '#94a3b8', fontSize: '0.76rem', margin: '6px 0 0' }}>
            Browse PostgreSQL catalog entries across every risk and goal category, separately from your suitability-filtered shortlist.
          </p>
        </div>
        <button type="button" onClick={toggle} aria-expanded={open}
          style={{ cursor: 'pointer', padding: '9px 13px', borderRadius: 8, background: '#075985', border: '1px solid #38bdf8', color: '#f0f9ff', fontWeight: 700 }}>
          {open ? 'Hide full catalog' : 'Browse all investment options'}
        </button>
      </div>
      {open && (
        <div style={{ marginTop: 14 }}>
          {status === 'loading' && <p role="status" style={{ color: '#bae6fd' }}>Loading all pages from the financial-universe database...</p>}
          {status === 'error' && (
            <div role="alert" style={{ color: '#fbbf24' }}>
              <p>Unable to load the PostgreSQL investment universe. Verify FINANCIAL_POSTGRES_ENABLED, completed migrations, the 250-entry seed, and the backend connection. No catalog entries have been fabricated.</p>
              <button type="button" onClick={retry}>Retry catalog load</button>
            </div>
          )}
          {status === 'loaded' && (
            <>
              <p role="status" style={{ color: '#a7f3d0', fontWeight: 700, fontSize: '0.79rem' }}>
                {items.length} catalog entries loaded from PostgreSQL.
              </p>
              {summary && <p style={{ color: '#cbd5e1', fontSize: '0.75rem' }}>
                Database total: {summary.totalCount} · Discovery families: {summary.discoveryFamilies} · Actual products: {summary.actualProducts} · Availability verified: {summary.availableRecords} · Qualification-flagged: {summary.qualificationFlagged}. These flags do not establish suitability.
              </p>}
              {items.length < 250 && (
                <p role="alert" style={{ color: '#fbbf24' }}>
                  Only {items.length} entries were returned; the expected minimum is 250. Check the database seed and migrations.
                </p>
              )}
              <p style={{ color: '#cbd5e1', fontSize: '0.75rem', lineHeight: 1.5 }}>
                Discovery catalog only. A listed investment family is not necessarily an available purchasable product or a suitable recommendation. The additional 95 families have not been individually verified for investment, live prices, or post-tax outcomes.
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
                <label style={{ color: '#cbd5e1', fontSize: '0.78rem' }}>
                  Search
                  <input type="search" aria-label="Search all investment options" value={query}
                    onChange={event => { setQuery(event.target.value); setPageIndex(0); }}
                    placeholder="Name, category or product ID"
                    style={{ display: 'block', width: 250, maxWidth: '100%', color: '#f8fafc', background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: 9, marginTop: 4 }} />
                </label>
                <label style={{ color: '#cbd5e1', fontSize: '0.78rem' }}>
                  Category
                  <select aria-label="Filter investment category" value={category}
                    onChange={event => { setCategory(event.target.value); setSubcategory(''); setPageIndex(0); }}
                    style={{ display: 'block', width: 210, maxWidth: '100%', color: '#f8fafc', background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: 9, marginTop: 4 }}>
                    <option value="">All categories</option>
                    {categories.map(name => <option value={name} key={name}>{name}</option>)}
                  </select>
                </label>
                <label style={{ color: '#cbd5e1', fontSize: '0.78rem' }}>
                  Subcategory
                  <select aria-label="Filter investment subcategory" value={subcategory}
                    onChange={event => { setSubcategory(event.target.value); setPageIndex(0); }}
                    style={{ display: 'block', width: 210, maxWidth: '100%', color: '#f8fafc', background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: 9, marginTop: 4 }}>
                    <option value="">All subcategories</option>
                    {subcategories.map(name => <option value={name} key={name}>{name}</option>)}
                  </select>
                </label>
              </div>
              <p style={{ color: '#94a3b8', fontSize: '0.72rem' }}>{filtered.length} matching catalog entries · page {currentPage + 1} of {maxPage + 1}</p>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.78rem' }}>
                  <thead><tr style={{ color: '#7dd3fc' }}>
                    <th scope="col" style={{ padding: 9 }}>Investment option</th>
                    <th scope="col" style={{ padding: 9 }}>Category</th>
                    <th scope="col" style={{ padding: 9 }}>Record type</th>
                    <th scope="col" style={{ padding: 9 }}>Availability</th>
                    <th scope="col" style={{ padding: 9 }}>Verification</th>
                    <th scope="col" style={{ padding: 9 }}>Recommendation status</th>
                  </tr></thead>
                  <tbody>{visible.map(item => (
                    <tr key={item.id} style={{ borderTop: '1px solid rgba(148,163,184,.12)' }}>
                      <td style={{ padding: 9, color: '#e2e8f0' }}>{item.name || item.id}
                        <button type="button" onClick={() => compareFamily(item.id)}
                          aria-label={'Compare verified products for ' + (item.name || item.id)}
                          style={{ display: 'block', marginTop: 6, cursor: 'pointer' }}>
                          Compare up to 3 verified products
                        </button>
                      </td>
                      <td style={{ padding: 9, color: '#cbd5e1' }}>{item.category || 'Not classified'}{item.subcategory ? ' / ' + item.subcategory : ''}</td>
                      <td style={{ padding: 9, color: '#cbd5e1' }}>{item.record_kind === 'ACTUAL_PRODUCT' ? 'Actual product' : 'Discovery family'}</td>
                      <td style={{ padding: 9, color: '#cbd5e1' }}>{item.availability || 'Not established'}</td>
                      <td style={{ padding: 9, color: '#cbd5e1' }}>{item.verification_scope === 'REGULATORY_CATEGORY_OR_INDEX_ONLY'
                        ? 'Category/index reference only' : (item.verification_scope || 'Not established')}</td>
                      <td style={{ padding: 9, color: '#cbd5e1' }}>{item.recommendation_eligible === true
                        ? 'Further profile suitability required' : 'Discovery only / not qualified'}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              {selectedFamilyId && (
                <section aria-label="Verified product comparison"
                  style={{ marginTop: 14, padding: 12, border: '1px solid rgba(148,163,184,.3)', borderRadius: 8 }}>
                  <strong>Product comparison — {items.find(item => item.id === selectedFamilyId)?.name || selectedFamilyId}</strong>
                  {compareStatus === 'loading' && <p role="status">Checking current product, licence and suitability evidence...</p>}
                  {compareStatus === 'error' && <p role="alert">
                    This category cannot be compared yet. A current financial profile, PostgreSQL qualification,
                    permitted market data and verified advisory authorization are required.
                    {' '}{compareResult?.reasonCode || 'COMPARISON_UNAVAILABLE'}.
                  </p>}
                  {compareStatus === 'loaded' && compareResult?.products?.length === 0 && <p role="status">
                    No currently qualified products can be ranked for this profile. Reason: {compareResult.reasonCode || 'NONE_QUALIFIED'}.
                    No unverified alternatives are substituted.
                  </p>}
                  {compareStatus === 'loaded' && compareResult?.products?.length > 0 && (
                    <>
                      <p role="status">
                        {compareResult.products.length} of at most 3 suitably qualified products,
                        ordered by risk fit, verified charges and lock-in—not promised returns.
                      </p>
                      <ol>{compareResult.products.map(product => <li key={product.id}
                        style={{ padding: '8px 0', borderBottom: '1px solid rgba(148,163,184,.2)' }}>
                        <strong>{product.name}</strong> — fit {product.matchScore}/100,
                        risk {product.riskLevel}/5, min ₹{Number(product.minimumInvestmentInr).toLocaleString('en-IN')},
                        charges {product.annualFeeBps} bps/year, lock-in {product.lockInMonths} months.
                        <div style={{ fontSize: '0.74rem', color: '#94a3b8' }}>
                          {product.marketFact?.type}: {product.marketFact?.value} ({product.marketFact?.dataClass})
                          · observed {product.marketFact?.asOf ? new Date(product.marketFact.asOf).toLocaleString('en-IN') : 'date unavailable'}
                        </div>
                        <a href={product.evidence?.product} target="_blank" rel="noopener noreferrer">Issuer evidence</a>
                        {' · '}<a href={product.evidence?.terms} target="_blank" rel="noopener noreferrer">Product terms</a>
                      </li>)}</ol>
                    </>
                  )}
                  <p style={{ color: '#94a3b8', fontSize: '0.72rem' }}>
                    Comparison is not a trade instruction. Missing source rights or suitability evidence blocks display.
                  </p>
                </section>
              )}
              {filtered.length === 0 && <p>No catalog entries match your filters.</p>}
              {maxPage > 0 && <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 12 }}>
                <button type="button" disabled={currentPage === 0} onClick={() => setPageIndex(n => Math.max(0, n - 1))}>Previous</button>
                <button type="button" disabled={currentPage === maxPage} onClick={() => setPageIndex(n => Math.min(maxPage, n + 1))}>Next</button>
              </div>}
            </>
          )}
        </div>
      )}
    </section>
  );
}
