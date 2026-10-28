import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  getCurrentProfile,
  getFinancialDiscoveryDirectory,
  getQualifiedFamilyTopProducts,
  getThreeProductReadyFamilies,
} from '../services/api';

const FINANCIAL_CATALOG_UI_ENABLED = import.meta.env.VITE_FINANCIAL_POSTGRES_ENABLED === 'true';
const CATALOG_SIZE = 250;
const PAGE_SIZE = 100;
const MAX_PAGES = 4;
const EMPTY_LIST = Object.freeze([]);

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
async function loadFinancialDirectory(signal) {
  // Browse the public, source-backed educational catalog even when Postgres,
  // source entitlements or personalized comparison are not enabled.
  const directory = await getFinancialDiscoveryDirectory({ signal });
  if (directory?.status !== 'DISCOVERY_ONLY'
      || directory.totalCount !== CATALOG_SIZE
      || !Array.isArray(directory.items)
      || directory.items.length !== CATALOG_SIZE
      || directory.source !== 'WEALTHGENIE_CATALOG_155_PLUS_95') {
    throw new Error('FINANCIAL_DISCOVERY_250_SOURCE_INVALID');
  }
  const ids = new Set();
  const names = new Set();
  for (const item of directory.items) {
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    const normalizedName = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!isFamilyId(item?.id) || ids.has(item.id) || !normalizedName
      || names.has(normalizedName) || !item?.category
      || item.record_kind !== 'ARCHETYPE' || item.recommendationEligible !== false
      || item.productAvailability !== 'NOT_VERIFIED'
      || item.dataRights !== 'NOT_VERIFIED'
      || !item.productData || Object.values(item.productData).some(value => value !== null)) {
      throw new Error('FINANCIAL_DISCOVERY_UNVERIFIED_FAMILY_INVALID');
    }
    ids.add(item.id);
    names.add(normalizedName);
  }
  if (directory.items.filter(item => item.origin === 'LEGACY_155').length !== 155
      || directory.items.filter(item => item.origin === 'EXTENDED_95').length !== 95) {
    throw new Error('FINANCIAL_DISCOVERY_SOURCE_COUNTS_INVALID');
  }

  // A failed or disabled comparison API does not prevent educational browsing.
  // Its status must never be interpreted as zero qualified products.
  if (!FINANCIAL_CATALOG_UI_ENABLED) {
    return { items: directory.items, readyFamilyIds: [], comparisonEvidence: 'UNAVAILABLE' };
  }
  try {
    const ready = await getThreeProductReadyFamilies({ signal });
    if (ready?.status !== 'TWO_OR_MORE_SOURCE_QUALIFIED_CANDIDATES'
      || !Array.isArray(ready.familyIds) || !Number.isSafeInteger(ready.count)
      || ready.count !== ready.familyIds.length
      || ready.count > CATALOG_SIZE
      || new Set(ready.familyIds).size !== ready.familyIds.length
      || ready.familyIds.some(id => !ids.has(id))) {
      throw new Error('FINANCIAL_PRODUCT_QUALIFICATION_RESPONSE_INVALID');
    }
    return { items: directory.items, readyFamilyIds: ready.familyIds,
      comparisonEvidence: 'AVAILABLE' };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { items: directory.items, readyFamilyIds: [], comparisonEvidence: 'UNAVAILABLE' };
  }
}

function validProductComparisonResponse(response, familyId, profileId, now = Date.now()) {
  const timestamp = value => typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
  const numeric = value => typeof value === 'number' && Number.isFinite(value)
    ? value : typeof value === 'string' && value.trim() && Number.isFinite(Number(value))
      ? Number(value) : null;
  if (response?.status !== 'AVAILABLE' || response.familyId !== familyId
    || response.source?.profileId !== profileId
    || !Array.isArray(response.products) || ![2, 3].includes(response.products.length)) {
    return false;
  }
  const productIds = new Set(), observationKeys = new Set();
  return response.products.every(product => {
    const fact = product?.marketFact, evidence = product?.evidence;
    const value = numeric(fact?.value);
    const observedAt = Date.parse(fact?.asOf);
    const reviewedAt = Date.parse(evidence?.reviewedAt);
    const expiresAt = Date.parse(evidence?.expiresAt);
    const observationKey = fact?.sourceId + ':' + fact?.observationId;
    if (!isFamilyId(product?.id) || product.familyId !== familyId
      || productIds.has(product.id)
      || typeof product.name !== 'string' || !product.name.trim()
      || !Number.isInteger(product.riskLevel) || product.riskLevel < 1 || product.riskLevel > 5
      || !Number.isInteger(product.annualFeeBps) || product.annualFeeBps < 0
      || product.annualFeeBps > 10000
      || !Number.isInteger(product.lockInMonths) || product.lockInMonths < 0
      || typeof product.verifiedTaxClass !== 'string'
      || !product.verifiedTaxClass.trim()
      || ['UNVERIFIED', 'OTHER_UNSUPPORTED'].includes(product.verifiedTaxClass)
      || !isFamilyId(fact?.sourceId)
      || typeof fact?.observationId !== 'string' || !fact.observationId.trim()
      || observationKeys.has(observationKey)
      || !['PRICE', 'NAV', 'PUBLISHED_RATE', 'YIELD', 'VOLUME'].includes(fact.type)
      || !['LIVE', 'DELAYED', 'END_OF_DAY', 'PUBLISHED_RATE'].includes(fact.dataClass)
      || (fact.type === 'PUBLISHED_RATE') !== (fact.dataClass === 'PUBLISHED_RATE')
      || (fact.type === 'NAV' && fact.dataClass !== 'END_OF_DAY')
      || typeof fact.unit !== 'string' || !fact.unit.trim()
      || value === null || value < 0 || (fact.type !== 'PUBLISHED_RATE' && value === 0)
      || !timestamp(fact.asOf) || observedAt > now + 5 * 60 * 1000
      || (fact.dataClass === 'LIVE' && observedAt < now - 5 * 60 * 1000)
      || (fact.dataClass === 'DELAYED' && observedAt < now - 24 * 60 * 60 * 1000)
      || (fact.dataClass === 'END_OF_DAY' && observedAt < now - 7 * 24 * 60 * 60 * 1000)
      || !permittedEvidenceUrl(evidence?.product)
      || !permittedEvidenceUrl(evidence?.terms)
      || !permittedEvidenceUrl(evidence?.risk)
      || !timestamp(evidence?.reviewedAt) || !timestamp(evidence?.expiresAt)
      || reviewedAt > now + 5 * 60 * 1000 || expiresAt <= now
      || expiresAt <= reviewedAt) return false;
    productIds.add(product.id);
    observationKeys.add(observationKey);
    return true;
  });
}
/**
 * The full 250-family directory belongs on Where to Invest, not inside a
 * portfolio shortlist. Each family's candidate comparison remains
 * profile-bound and fails closed until two real products qualify.
 */
export default function InvestmentUniverseExplorer({ profileShortlist = EMPTY_LIST, profileRankedCategories = EMPTY_LIST }) {
  const [open, setOpen] = useState(true);
  const [status, setStatus] = useState('NOT_REQUESTED');
  const [data, setData] = useState(null);
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [selectedFamily, setSelectedFamily] = useState(null);
  const [comparison, setComparison] = useState(null);
  const compareAbort = useRef(null);

  useEffect(() => () => compareAbort.current?.abort(), []);

  const toggleDirectory = () => {
    compareAbort.current?.abort();
    setSelectedFamily(null);
    setComparison(null);
    setData(null);
    setStatus(open ? 'NOT_REQUESTED' : 'LOADING');
    setOpen(value => !value);
  };

  useEffect(() => {
    if (!open) return undefined;
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

  const items = data?.items || EMPTY_LIST;
  const readyIds = data?.readyFamilyIds || EMPTY_LIST;
  const readySet = useMemo(() => new Set(readyIds), [readyIds]);
  // Existing backend-authored profile shortlist, preserved in its exact order.
  // It is NOT a new risk model and does NOT claim to rank all 250 products.
  const profileMatches = useMemo(() => {
    const byId = new Map(items.map(item => [item.id, item]));
    if (Array.isArray(profileRankedCategories) && profileRankedCategories.length > 0) {
      const ranks = profileRankedCategories.slice(0,3);
      if (ranks.some(row => !byId.has(row?.id) || typeof row.rankScore !== 'number'
        || !Number.isFinite(row.rankScore))) return [];
      if (new Set(ranks.map(row => row.id)).size !== ranks.length) return [];
      return ranks.map(row => ({
        ...byId.get(row.id),
        rankScore: row.rankScore,
        riskGroup: row.riskGroup,
        matchOrigin: 'PROFILE_POLICY_RANKED',
      }));
    }
    if (!Array.isArray(profileShortlist)) return [];
    const seen = new Set();
    return profileShortlist.reduce((matches, candidate) => {
      const id = candidate?.id;
      if (matches.length < 3 && typeof id === 'string' && !seen.has(id) && byId.has(id)) {
        seen.add(id);
        matches.push({...byId.get(id),matchOrigin:'CURRENT_SAVED_PLAN'});
      }
      return matches;
    }, []);
  }, [items, profileShortlist, profileRankedCategories]);
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
    if (data?.comparisonEvidence !== 'AVAILABLE') {
      setComparison({ status: 'UNAVAILABLE',
        reasonCode: 'CURRENT_PRODUCT_COMPARISON_SOURCE_UNAVAILABLE' });
      return;
    }
    if (!readySet.has(family.id)) {
      setComparison({ status: 'UNAVAILABLE', reasonCode: 'FEWER_THAN_TWO_SOURCE_QUALIFIED_PRODUCTS' });
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
        if (!validProductComparisonResponse(result, family.id, profileId)) throw new Error('TOP_THREE_RESPONSE_INVALID');
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

  return (
    <section className="wti-universe" aria-label="All 250 Indian investment options and tailored product comparison">
      <button type="button" className="wti-universe-toggle" aria-expanded={open}
        onClick={toggleDirectory}>
        {open ? 'Hide all 250 investment options' : 'Explore all 250 investment options'}
      </button>
      {open && (
        <div className="wti-universe-content">
          <h2>All 250 investment categories — browse details</h2>
          <p>
            Select any investment family to check for two or three distinct, current products
            suitable for your financial profile. The directory is educational;
            only verified issuer products can enter a personalized comparison.
          </p>
          {status === 'LOADING' && <p role="status">Loading all 250 educational investment categories...</p>}
          {status === 'UNAVAILABLE' && (
            <p role="alert">
              The source-backed 250-family directory could not be loaded.
              No placeholder investments or unverified market facts were substituted.
            </p>
          )}
          {status === 'AVAILABLE' && (
            <>
              <p role="status">
                {items.length} educational investment categories loaded from the WealthGenie source catalog
                (155 existing and 95 extended categories).
              </p>
              <p role="status">
                {data.comparisonEvidence === 'AVAILABLE'
                  ? `${readyIds.length} families have at least two source-qualified candidates; profile suitability still applies.`
                  : 'Personalized product comparisons are not currently available. All educational category details remain visible.'}
              </p>
              <p>Catalog details are educational references, not current prices, investment rates,
                live availability, tax calculations or product recommendations.</p>
              {profileMatches.length>0 && (
                <section aria-label="Existing profile shortlist category matches" className="wti-universe-profile-matches">
                  <h3>{profileMatches[0]?.matchOrigin === 'PROFILE_POLICY_RANKED'
                    ? 'Top 3 profile-matched investment categories'
                    : 'Categories in your current financial plan'}</h3>
                  <p>{profileMatches[0]?.matchOrigin === 'PROFILE_POLICY_RANKED'
                    ? 'Selected from 155 modeled legacy categories by the existing backend suitability ranking. The 95 newer discovery categories are not yet ranked.'
                    : 'Shown in the order of your current saved plan. No new product ranking has been calculated.'}
                    {' '}These are category-level educational matches, not verified investment products,
                    current returns, or advice to purchase.</p>
                  <ol>
                    {profileMatches.map(item => (
                      <li key={item.id}>
                        <strong>{item.name}</strong> · {item.category}
                        {item.matchOrigin === 'PROFILE_POLICY_RANKED'
                          && <small> · {item.riskGroup.toLowerCase()} risk group · backend policy score {item.rankScore.toFixed(1)} (not a projected return)</small>}
                        {' '}<button type="button" onClick={() => inspectFamily(item)}
                          aria-label={'Explore profile-shortlisted category ' + item.name}>
                          View category evidence
                        </button>
                      </li>
                    ))}
                  </ol>
                </section>
              )}
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
                  <li key={item.id} className={selectedFamily?.id === item.id ? 'wti-universe-selected' : undefined}>
                    <div>
                      <strong>{item.name}</strong>
                      <small>{item.category}{item.subcategory ? ' · ' + item.subcategory : ''}</small>
                    </div>
                    <span className="wti-universe-status">
                      {readySet.has(item.id) ? 'Source-qualified candidates; suitability pending'
                        : 'Discovery category — current product data not verified'}
                    </span>
                    <button type="button" className="wti-universe-more"
                      onClick={() => inspectFamily(item)}
                      aria-expanded={selectedFamily?.id === item.id}
                      aria-controls={'wti-top-three-' + item.id}
                      aria-label={'Check tailored top 3 for ' + item.name}>
                      Check tailored top 3
                    </button>
              {selectedFamily?.id === item.id && (
                <section id={'wti-top-three-' + item.id}
                  className="wti-universe-detail"
                  aria-label={'Tailored top three for ' + item.name}
                  aria-live="polite">
                  <h3>{selectedFamily.name}: catalog details</h3>
                  <dl className="wti-universe-facts">
                    <dt>Catalog category</dt>
                    <dd>{selectedFamily.category}{selectedFamily.subcategory ? ' / ' + selectedFamily.subcategory : ''}</dd>
                    <dt>Record type</dt>
                    <dd>Educational investment family (not an individually verified product)</dd>
                    {selectedFamily.instrumentForm && <>
                      <dt>Instrument type</dt><dd>{selectedFamily.instrumentForm.replaceAll('_', ' ')}</dd>
                    </>}
                    {selectedFamily.description && <>
                      <dt>Legacy catalog description</dt>
                      <dd>{selectedFamily.description} (educational reference, not validated current terms)</dd>
                    </>}
                    {selectedFamily.studyNotes?.provenance === 'UNVERIFIED_LEGACY_EDUCATIONAL_CATALOG'
                      && ['possibleBenefits','keyTradeoffs','goalThemes'].some(
                        key => selectedFamily.studyNotes[key]?.length > 0) && <>
                        <dt>Different educational characteristics from legacy catalog</dt>
                        <dd>
                          <p>These notes are unverified historical descriptions, not
                            current financial terms, guaranteed advantages or suitability advice.</p>
                          {selectedFamily.studyNotes.possibleBenefits?.length>0 && <>
                            <strong>Catalog-listed possible benefits</strong>
                            <ul>{selectedFamily.studyNotes.possibleBenefits.map((point,index) =>
                              <li key={'benefit-'+index}>{point}</li>)}</ul>
                          </>}
                          {selectedFamily.studyNotes.keyTradeoffs?.length>0 && <>
                            <strong>Catalog-listed trade-offs</strong>
                            <ul>{selectedFamily.studyNotes.keyTradeoffs.map((point,index) =>
                              <li key={'tradeoff-'+index}>{point}</li>)}</ul>
                          </>}
                          {selectedFamily.studyNotes.goalThemes?.length>0 && <>
                            <strong>Related catalog goal themes</strong>
                            <ul>{selectedFamily.studyNotes.goalThemes.map((goal,index) =>
                              <li key={'theme-'+index}>{goal}</li>)}</ul>
                          </>}
                        </dd>
                      </>}
                    {selectedFamily.educationalRiskLabel && <>
                      <dt>Legacy risk label</dt>
                      <dd>{selectedFamily.educationalRiskLabel} (unverified catalog assumption)</dd>
                    </>}
                    <dt>Current market price / NAV / interest rate</dt>
                    <dd>Unavailable — no authorized, fresh product observation</dd>
                    <dt>Minimum investment and fees</dt><dd>Not verified for an actual product</dd>
                    <dt>Tax and post-tax returns</dt><dd>Not calculated; requires verified product and tax context</dd>
                    <dt>Availability and data permissions</dt><dd>Not verified</dd>
                    {Array.isArray(selectedFamily.publicIssuerReferences)
                      && selectedFamily.publicIssuerReferences.length > 0 && <>
                        <dt>Public issuer offering references (research links only)</dt>
                        <dd>
                          <ul>
                            {selectedFamily.publicIssuerReferences.map(reference => (
                              <li key={reference.issuerName}>
                                <a href={permittedEvidenceUrl(reference.officialProductUrl)}
                                  target="_blank" rel="noopener noreferrer">
                                  {reference.issuerName} — official issuer page
                                </a>
                                {' · '}Research checked {reference.reviewedOn || 'date not supplied'}.
                                No live rate, licensed data feed or personal suitability is established.
                                {reference.providerRightsReview ===
                                  'PUBLIC_TERMS_RESTRICT_COMMERCIAL_REPRODUCTION_STORAGE_AND_REDISTRIBUTION'
                                  ? ' Official website terms restrict commercial reuse without separate permission.'
                                  : ' Independent commercial reuse permission has not been established.'}
                                {permittedEvidenceUrl(reference.providerTermsUrl) && <>
                                  {' '}<a href={permittedEvidenceUrl(reference.providerTermsUrl)}
                                    target="_blank" rel="noopener noreferrer">
                                    Website usage terms
                                  </a>
                                </>}
                              </li>
                            ))}
                          </ul>
                        </dd>
                      </>}
                    {selectedFamily.referenceUrl && <>
                      <dt>Category or regulatory reference</dt>
                      <dd><a href={permittedEvidenceUrl(selectedFamily.referenceUrl)}
                        target="_blank" rel="noopener noreferrer">View public category reference</a>
                        {selectedFamily.referenceCheckedAsOf
                          ? ' · reference checked ' + selectedFamily.referenceCheckedAsOf : ''}
                      </dd>
                    </>}
                  </dl>
                  <h4>Personalized product comparison</h4>
                  {comparison?.status === 'LOADING' && <p role="status">Revalidating your profile and product evidence...</p>}
                  {comparison?.status === 'UNAVAILABLE' && (
                    <p role="status">
                      Two distinct, current, suitable products cannot yet be verified
                      for this category. {comparison.reasonCode || 'INSUFFICIENT_VERIFIED_PRODUCTS'}.
                      No duplicate product identities, assumed rates or invented returns are shown.
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
                      <p>{comparison.products.length} independently checked products, ordered by lower verified risk,
                        then charges, then lock-in. This is not a return ranking or guarantee.</p>
                      <ol>
                        {comparison.products.map(product => (
                          <li key={product.id}>
                            <strong>{product.name}</strong>
                            <div>
                              Risk: {product.riskLevel}/5
                              · Charges: {product.annualFeeBps} basis points per year
                              · Lock-in: {product.lockInMonths} months
                            </div>
                            <div>
                              Observed {product.marketFact?.type}: {product.marketFact?.value}
                              {' '}{product.marketFact?.unit || ''}
                              {' '}({product.marketFact?.dataClass || 'classification unavailable'})
                              · Source: {product.marketFact?.sourceId}
                              · Observation ID: {product.marketFact?.observationId}
                            </div>
                            <div>
                              Observation as-of: {product.marketFact?.asOf
                                ? new Date(product.marketFact.asOf).toLocaleString('en-IN', {timeZone:'Asia/Kolkata'})
                                : 'Not provided'}
                              · Source classification: {product.marketFact?.dataClass || 'Unavailable'}
                            </div>
                            <div>Tax class: {product.verifiedTaxClass || 'Not established'}.
                              Personalized post-tax return: not calculated by this comparison.
                            </div>
                            <div>
                              Reviewed: {product.evidence?.reviewedAt
                                ? new Date(product.evidence.reviewedAt).toLocaleDateString('en-IN', {timeZone:'Asia/Kolkata'})
                                : 'Not provided'}
                              · Review expires: {product.evidence?.expiresAt
                                ? new Date(product.evidence.expiresAt).toLocaleDateString('en-IN', {timeZone:'Asia/Kolkata'})
                                : 'Not provided'}
                            </div>
                            <a href={permittedEvidenceUrl(product.evidence?.product)}
                              target="_blank" rel="noopener noreferrer">Issuer evidence</a>
                            {' · '}
                            {permittedEvidenceUrl(product.evidence?.terms) && (
                              <a href={permittedEvidenceUrl(product.evidence.terms)}
                                target="_blank" rel="noopener noreferrer">Terms</a>
                            )}
                            {' · '}
                            {permittedEvidenceUrl(product.evidence?.risk) && (
                              <a href={permittedEvidenceUrl(product.evidence.risk)}
                                target="_blank" rel="noopener noreferrer">Risk evidence</a>
                            )}
                          </li>
                        ))}
                      </ol>
                    </>
                  )}
                </section>
              )}
                  </li>
                ))}
              </ul>
              {!filtered.length && <p>No matching investment categories.</p>}

            </>
          )}
        </div>
      )}
    </section>
  );
}
