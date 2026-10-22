import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, ChevronLeft, ChevronRight, Search, ShieldCheck } from 'lucide-react';
import * as api from '../services/api';
import { safeSourceUrl } from '../utils/marketDataDisplay';
import TopInvestmentsScreen from './TopInvestmentsScreen';
import './InvestmentExplorerScreen.css';

const PAGE_SIZE = 24;

function availabilityLabel(fact) {
  if (fact?.status === 'NOT_VERIFIED') return 'Not verified';
  if (fact?.status === 'AVAILABLE') return 'Verified fact loaded';
  return 'Not loaded';
}

function familyStatus(product) {
  if (product?.lifecycleStatus !== 'VERIFIED') return 'Product terms not verified';
  if (product?.classificationStatus !== 'VERIFIED') return 'Classification not verified';
  return 'Product family';
}

export default function InvestmentExplorerScreen({
  recommendations = [],
  recommendationsLoading = false,
  recommendationsError = null,
  recommendationMeta = null,
  onLearnMore,
}) {
  const [taxonomy, setTaxonomy] = useState(null);
  const [taxonomyError, setTaxonomyError] = useState(null);
  const [catalogResult, setCatalogResult] = useState({ requestKey: null, data: null });
  const [catalogFailure, setCatalogFailure] = useState(null);
  const [queryInput, setQueryInput] = useState('');
  const [query, setQuery] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [subcategoryId, setSubcategoryId] = useState('');
  const [page, setPage] = useState(1);
  const requestKey = JSON.stringify({ query, categoryId, subcategoryId, page });

  useEffect(() => {
    const controller = new AbortController();
    api.getInvestmentExplorerTaxonomy({ signal: controller.signal })
      .then(result => setTaxonomy(result))
      .catch(error => {
        if (error?.name !== 'AbortError' && error?.code !== 'REQUEST_ABORTED') {
          setTaxonomyError('Investment categories are temporarily unavailable.');
        }
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    api.getInvestmentExplorerCatalog({
      q: query,
      categoryId,
      subcategoryId,
      page,
      limit: PAGE_SIZE,
    }, { signal: controller.signal })
      .then(result => {
        if (controller.signal.aborted) return;
        setCatalogResult({ requestKey, data: result });
        setCatalogFailure(null);
      })
      .catch(error => {
        if (!controller.signal.aborted && error?.name !== 'AbortError' && error?.code !== 'REQUEST_ABORTED') {
          setCatalogFailure({ requestKey, message: 'Investment option families are temporarily unavailable.' });
        }
      });
    return () => controller.abort();
  }, [query, categoryId, subcategoryId, page, requestKey]);

  const categories = useMemo(
    () => (Array.isArray(taxonomy?.categories) ? taxonomy.categories : []),
    [taxonomy],
  );
  const totalSubcategories = useMemo(() => categories.reduce(
    (total, category) => total + (Array.isArray(category.subcategories) ? category.subcategories.length : 0),
  0), [categories]);
  const catalog = catalogResult.requestKey === requestKey ? catalogResult.data : null;
  const catalogError = catalogFailure?.requestKey === requestKey ? catalogFailure.message : null;
  const loading = !catalog && !catalogError;
  const products = Array.isArray(catalog?.products) ? catalog.products : [];
  const pagination = catalog?.pagination || { page: 1, pages: 1, total: 0 };

  const submitSearch = (event) => {
    event.preventDefault();
    setPage(1);
    setQuery(queryInput.trim());
  };

  const selectSubcategory = (category, subcategory) => {
    setCategoryId(category.id);
    setSubcategoryId(subcategory.id);
    setPage(1);
  };

  const clearFilters = () => {
    setCategoryId('');
    setSubcategoryId('');
    setQuery('');
    setQueryInput('');
    setPage(1);
  };

  return (
    <main className="investment-explorer" data-testid="investment-explorer-screen">
      <TopInvestmentsScreen
        recommendations={recommendations}
        recommendationsLoading={recommendationsLoading}
        recommendationsError={recommendationsError}
        recommendationMeta={recommendationMeta}
        onLearnMore={onLearnMore}
      />

      <header className="investment-explorer__header">
        <p className="investment-explorer__eyebrow">PRODUCT FAMILIES · NOT PERSONALIZED RECOMMENDATIONS</p>
        <h1>Browse every investment option</h1>
        <p>
          Explore the product families WealthGenie can classify. This catalogue is separate from the profile-based
          recommendation above; names here do not establish that a product is currently available or suitable.
        </p>
        <div className="investment-explorer__summary" aria-label="Catalog coverage">
          <strong>{categories.length}</strong> categories
          <span className="investment-explorer__summary-divider" aria-hidden="true" />
          <strong>{totalSubcategories}</strong> options
          <span className="investment-explorer__summary-divider" aria-hidden="true" />
          <span>{catalog?.catalog?.totalFamilyRecords ?? '—'} family records</span>
        </div>
      </header>

      <section className="investment-explorer__notice" aria-label="Catalog limitations">
        <ShieldCheck size={20} aria-hidden="true" />
        <p>
          Current rates, NAVs, returns, eligibility, liquidity and tax facts remain unavailable until an exact product
          and its source permissions are qualified. This catalogue does not change your saved plan.
        </p>
      </section>

      <section className="investment-explorer__universe" aria-labelledby="investment-universe-heading">
        <div className="investment-explorer__universe-heading">
          <div>
            <p className="investment-explorer__eyebrow">INVESTMENT UNIVERSE</p>
            <h2 id="investment-universe-heading">Categories and named options</h2>
          </div>
          <span>{totalSubcategories} options</span>
        </div>

        {taxonomyError && <p className="investment-explorer__error" role="alert">{taxonomyError}</p>}
        {!taxonomyError && categories.length === 0 && (
          <p className="investment-explorer__loading" role="status">Loading investment categories…</p>
        )}
        {categories.length > 0 && (
          <div className="investment-explorer__universe-grid">
            {categories.map(category => (
              <details className="investment-explorer__universe-category" key={category.id} data-testid="investment-universe-category">
                <summary>
                  <span>{category.name}</span>
                  <span>{category.subcategories?.length || 0} options</span>
                </summary>
                {category.coverageNote && <p>{category.coverageNote}</p>}
                <div className="investment-explorer__option-list">
                  {(category.subcategories || []).map(subcategory => (
                    <button
                      key={subcategory.id}
                      type="button"
                      className={subcategoryId === subcategory.id ? 'is-active' : ''}
                      aria-pressed={subcategoryId === subcategory.id}
                      onClick={() => selectSubcategory(category, subcategory)}
                    >
                      {subcategory.name}
                    </button>
                  ))}
                </div>
                {Array.isArray(category.sourceLinks) && category.sourceLinks.length > 0 && (
                  <div className="investment-explorer__source-links">
                    <strong>Reference sources</strong>
                    {category.sourceLinks.map((source, index) => {
                      const sourceUrl = safeSourceUrl(source.url);
                      return sourceUrl && (
                        <a key={`${source.name}-${index}`} href={sourceUrl} target="_blank" rel="noreferrer">
                          {source.name}
                          {source.rightsStatus && <span>{source.rightsStatus.replaceAll('_', ' ').toLowerCase()}</span>}
                        </a>
                      );
                    })}
                  </div>
                )}
              </details>
            ))}
          </div>
        )}
      </section>

      <section className="investment-explorer__results" aria-labelledby="investment-family-results-heading">
        <div className="investment-explorer__results-heading">
          <div>
            <h2 id="investment-family-results-heading">Catalogued product families</h2>
            <p>Family names help you browse; they are not verified offers or rankings.</p>
          </div>
          <span>{pagination.total} families</span>
        </div>

        <form className="investment-explorer__search" onSubmit={submitSearch} role="search">
          <Search size={17} aria-hidden="true" />
          <label className="sr-only" htmlFor="investment-explorer-search">Search product families</label>
          <input
            id="investment-explorer-search"
            type="search"
            value={queryInput}
            onChange={event => setQueryInput(event.target.value)}
            placeholder="Search a product family"
          />
          <button type="submit">Search</button>
          {(query || categoryId || subcategoryId) && (
            <button type="button" onClick={clearFilters}>Clear filters</button>
          )}
        </form>

        {catalogError && <p className="investment-explorer__error" role="alert">{catalogError}</p>}
        {loading && <p className="investment-explorer__loading" role="status">Loading catalogued product families…</p>}
        {!loading && !catalogError && products.length === 0 && (
          <div className="investment-explorer__empty" role="status">
            <AlertCircle size={20} aria-hidden="true" />
            <div><strong>No matching product families</strong><p>Clear a filter or search for a broader category.</p></div>
          </div>
        )}
        {!loading && !catalogError && products.length > 0 && (
          <div className="investment-explorer__grid">
            {products.map(product => (
              <article className="investment-explorer__product" key={product.id} data-testid="investment-family-card">
                <div className="investment-explorer__product-topline">
                  <span>PRODUCT FAMILY</span>
                  <span>{familyStatus(product)}</span>
                </div>
                <h3>{product.name}</h3>
                <p className="investment-explorer__product-category">
                  {[product.subcategoryName, product.assetClassLabel, product.legacyCategory].filter(Boolean).join(' · ')}
                </p>
                <div className="investment-explorer__product-coverage">
                  <span>Current facts</span>
                  <strong>{availabilityLabel(product.currentFacts?.price)}</strong>
                </div>
                <p className="investment-explorer__product-note">
                  Rates, NAVs, returns, fees, eligibility, liquidity and tax treatment are not verified for this family.
                </p>
              </article>
            ))}
          </div>
        )}

        {!loading && pagination.pages > 1 && (
          <nav className="investment-explorer__pagination" aria-label="Catalog pages">
            <button type="button" disabled={pagination.page <= 1} onClick={() => setPage(current => Math.max(1, current - 1))}>
              <ChevronLeft size={16} aria-hidden="true" /> Previous
            </button>
            <span>Page {pagination.page} of {pagination.pages}</span>
            <button type="button" disabled={pagination.page >= pagination.pages} onClick={() => setPage(current => Math.min(pagination.pages, current + 1))}>
              Next <ChevronRight size={16} aria-hidden="true" />
            </button>
          </nav>
        )}
      </section>
    </main>
  );
}
