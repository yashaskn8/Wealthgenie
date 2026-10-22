import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  getCurrentProfile,
  getFinancialUniverse,
  getFinancialUniverseSummary,
  getQualifiedFamilyTopProducts,
  getThreeProductReadyFamilies,
} from '../services/api';

const FINANCIAL_CATALOG_UI_ENABLED = import.meta.env.VITE_FINANCIAL_POSTGRES_ENABLED === 'true';
const CATALOG_SIZE = 250;
const PAGE_SIZE = 100;
const MAX_PAGES = 4;

function isFamilyId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9:_-]{1,160}$/.test(id);
}

function permittedEvidenceUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** Discovery and personalized comparison are separate authorities. */
export async function loadFinancialDirectory(signal) {
  const [summary, ready] = await Promise.all([
    getFinancialUniverseSummary({ signal }),
    getThreeProductReadyFamilies({ signal }),
  ]);
  if (summary?.totalCount !== CATALOG_SIZE) {
    throw new Error('FINANCIAL_UNIVERSE_250_CATALOG_NOT_READY');
  }
  if (ready?.status !== 'THREE_SOURCE_QUALIFIED_CANDIDATES'
      || !Array.isArray(ready.familyIds) || !Number.isSafeInteger(ready.count)
      || ready.count !== ready.familyIds.length || ready.count > CATALOG_SIZE
      || ready.familyIds.some(id => !isFamilyId(id))
      || new Set(ready.familyIds).size !== ready.familyIds.length) {
    throw new Error('FINANCIAL_UNIVERSE_TOP_THREE_EVIDENCE_INVALID');
  }

  const all = [];
  const ids = new Set();
  const cursors = new Set();
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await getFinancialUniverse({
      limit: PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    }, { signal });
    if (!Array.isArray(response?.items) || response.items.length > PAGE_SIZE) {
      throw new Error('FINANCIAL_UNIVERSE_PAGE_INVALID');
    }
    for (const item of response.items) {
      if (!item || !isFamilyId(item.id) || ids.has(item.id)
          || item.record_kind !== 'ARCHETYPE') {
        throw new Error('FINANCIAL_UNIVERSE_DUPLICATE_OR_INVALID_FAMILY');
      }
      ids.add(item.id);
      all.push(item);
    }
    const nextCursor = response.nextCursor ?? null;
    if (nextCursor === null) {
      if (all.length !== CATALOG_SIZE || ready.familyIds.some(id => !ids.has(id))) {
        throw new Error('FINANCIAL_UNIVERSE_INCOMPLETE');
      }
      return { items: all, summary, readyFamilyIds: ready.familyIds };
    }
    if (!isFamilyId(nextCursor) || nextCursor === cursor || cursors.has(nextCursor)
        || response.items.length === 0) {
      throw new Error('FINANCIAL_UNIVERSE_CURSOR_INVALID');
    }
    cursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw new Error('FINANCIAL_UNIVERSE_PAGE_LIMIT_EXCEEDED');
}

function validThreeProductResponse(response) {
  return response?.status === 'AVAILABLE'
    && Array.isArray(response.products)
    && response.products.length === 3
    && new Set(response.products.map(product => product?.id)).size === 3
    && response.products.every(product => isFamilyId(product?.id)
      && typeof product.name === 'string' && product.name.trim()
      && product.marketFact?.sourceId && product.marketFact?.observationId
      && Number.isFinite(Number(product.marketFact?.value))
      && permittedEvidenceUrl(product.evidence?.product));
}

/**
 * The full 250-family directory belongs on Where to Invest, not inside a
 * portfolio shortlist. Each family's candidate comparison remains
 * profile-bound and fails closed until three real products qualify.
 */
export default function InvestmentUniverseExplorer() {
  const [open, setOpen] = useState(true);
  const [status, setStatus] = useState('NOT_REQUESTED');
  const [data, setData] = useState(null);
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [selectedFamily, setSelectedFamily] = useState(null);
  const [comparison, setComparison] = useState(null);
  const compareAbort = useRef(null);

  useEffect(() => () => compareAbort.current?.abort(), []);

  useEffect(() => {
    if (!FINANCIAL_CATALOG_UI_ENABLED || !open) return undefined;
    const controller = new AbortController();
    setStatus('LOADING');
    loadFinancialDirectory(controller.signal)
      .then(result => {
        if (controller.signal.aborted) return;
        setData(result);
        setStatus('AVAILABLE');
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setData(null);
          setStatus('UNAVAILABLE');
        }
      });
    return () => controller.abort();
  }, [open]);

  const items = data?.items || [];
  const readyIds = data?.readyFamilyIds || [];
  const readySet = useMemo(() => new Set(readyIds), [readyIds]);
  const categories = useMemo(() => [...new Set(items.map(item => item.category).filter(Boolean))].sort(), [items]);
  const filtered = useMemo(() => {
    const phrase = search.trim().toLowerCase();
    return items.filter(item => (!category || item.category === category)
      && (!phrase || [item.id, item.name, item.category, item.subcategory]
        .some(field => String(field || '').toLowerCase().includes(phrase))));
  }, [items, category, search]);

  const inspectFamily = async family => {
    compareAbort.current?.abort();
    const controller = new AbortController();
    compareAbort.current = controller;
    setSelectedFamily(family);
    if (!readySet.has(family.id)) {
      setComparison({ status: 'UNAVAILABLE', reasonCode: 'FEWER_THAN_THREE_SOURCE_QUALIFIED_PRODUCTS' });
      return;
    }
    setComparison({ status: 'LOADING' });
    try {
      const profile = await getCurrentProfile({ signal: controller.signal });
      const profileId = profile?.profileId;
      if (typeof profileId !== 'string' || !/^[a-fA-F0-9]{24}$/.test(profileId)) {
        throw new Error('CURRENT_FINANCIAL_PROFILE_REQUIRED');
      }
      const result = await getQualifiedFamilyTopProducts(family.id, profileId, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (result?.status === 'AVAILABLE') {
        if (!validThreeProductResponse(result)) throw new Error('TOP_THREE_RESPONSE_INVALID');
        setComparison({ status: 'AVAILABLE', products: result.products });
      } else if (result?.status === 'INSUFFICIENT_VERIFIED_PRODUCTS'
          || result?.status === 'NO_QUALIFIED_PRODUCTS') {
        if (!Array.isArray(result.products) || result.products.length !== 0) {
          throw new Error('TOP_THREE_RESPONSE_INVALID');
        }
        setComparison({ status: 'UNAVAILABLE', reasonCode: result.reasonCode });
      } else {
        throw new Error('TOP_THREE_RESPONSE_INVALID');
      }
    } catch {
      if (!controller.signal.aborted) setComparison({
        status: 'ERROR',
        reasonCode: 'CURRENT_PROFILE_OR_QUALIFIED_COMPARISON_UNAVAILABLE',
      });
    }
  };

  if (!FINANCIAL_CATALOG_UI_ENABLED) return null;
  return (
    <section className="wti-universe" aria-label="All 250 Indian investment options and tailored product comparison">
      <button type="button" className="wti-universe-toggle" aria-expanded={open}
        onClick={() => setOpen(value => !value)}>
        {open ? 'Hide all 250 investment options' : 'Explore all 250 investment options'}
      </button>
      {open && (
        <div className="wti-universe-content">
          <h2>All 250 investment options</h2>
          <p>
            Select any investment family to check for three distinct, current products
            suitable for your financial profile. The directory is educational;
            only verified issuer products can enter a personalized comparison.
          </p>
          {status === 'LOADING' && <p role="status">Loading the complete PostgreSQL investment directory...</p>}
          {status === 'UNAVAILABLE' && (
            <p role="alert">
              The complete 250-family PostgreSQL directory is unavailable.
              Check database connectivity, migrations and the catalog seed.
              No placeholder investments were substituted.
            </p>
          )}
          {status === 'AVAILABLE' && (
            <>
              <p role="status">
                {items.length} investment options loaded from PostgreSQL; {readyIds.length} families
                currently have at least three preliminarily verified products.
              </p>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <label>
                  Search investments
                  <input aria-label="Search all 250 investment options" type="search"
                    value={search} onChange={event => setSearch(event.target.value)}
                    placeholder="Name or investment type" />
                </label>
                <label>
                  Category
                  <select aria-label="Filter all investment categories" value={category}
                    onChange={event => setCategory(event.target.value)}>
                    <option value="">All categories</option>
                    {categories.map(name => <option key={name} value={name}>{name}</option>)}
                  </select>
                </label>
              </div>
              <p>{filtered.length} matching options</p>
              <ul className="wti-universe-list">
                {filtered.map(item => (
                  <li key={item.id}>
                    <div>
                      <strong>{item.name}</strong>
                      <small>{item.category}{item.subcategory ? ' · ' + item.subcategory : ''}</small>
                    </div>
                    <span className="wti-universe-status">
                      {readySet.has(item.id) ? 'Three source-qualified candidates; suitability pending'
                        : 'Three verified products not yet available'}
                    </span>
                    <button type="button" className="wti-universe-more"
                      onClick={() => inspectFamily(item)}
                      aria-label={'Check tailored top 3 for ' + item.name}>
                      Check tailored top 3
                    </button>
                  </li>
                ))}
              </ul>
              {!filtered.length && <p>No matching investment categories.</p>}
              {selectedFamily && (
                <section aria-label="Selected investment tailored top three"
                  style={{ borderTop: '1px solid rgba(148,163,184,.25)', paddingTop: 16 }}>
                  <h3>{selectedFamily.name}: tailored top three</h3>
                  {comparison?.status === 'LOADING' && <p role="status">Revalidating your profile and product evidence...</p>}
                  {comparison?.status === 'UNAVAILABLE' && (
                    <p role="status">
                      Three distinct, current, suitable products cannot yet be verified
                      for this category. {comparison.reasonCode || 'INSUFFICIENT_VERIFIED_PRODUCTS'}.
                      No duplicate issuers, assumed rates or invented returns are shown.
                    </p>
                  )}
                  {comparison?.status === 'ERROR' && (
                    <p role="alert">
                      A current profile and authorized, source-qualified comparison are required.
                      {comparison.reasonCode}.
                    </p>
                  )}
                  {comparison?.status === 'AVAILABLE' && (
                    <>
                      <p>Three independently checked products, ranked by verified risk fit,
                        charges and lock-in. This ranking is not a return guarantee.</p>
                      <ol>
                        {comparison.products.map(product => (
                          <li key={product.id}>
                            <strong>{product.name}</strong>
                            <div>
                              Risk: {product.riskLevel}/5 · Match: {product.matchScore}/100
                              · Charges: {product.annualFeeBps} basis points per year
                              · Lock-in: {product.lockInMonths} months
                            </div>
                            <div>
                              Observed {product.marketFact?.type}: {product.marketFact?.value}
                              {' '}{product.marketFact?.unit || ''}
                              {' '}({product.marketFact?.dataClass || 'classification unavailable'})
                              · Source: {product.marketFact?.sourceId}
                            </div>
                            <div>Tax class: {product.verifiedTaxClass || 'Not established'}.
                              Personalized post-tax return: not calculated by this comparison.
                            </div>
                            <a href={permittedEvidenceUrl(product.evidence?.product)}
                              target="_blank" rel="noopener noreferrer">Issuer evidence</a>
                          </li>
                        ))}
                      </ol>
                    </>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
