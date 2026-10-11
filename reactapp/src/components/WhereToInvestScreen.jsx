import React, { useState, useMemo, useRef, useCallback } from 'react';
import WhereToInvestTab from './deepdive/WhereToInvestTab';
import {
  AlertCircle,
  Sparkles,
  Calculator,
  Shield,
  History as HistoryIcon,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import './WhereToInvestScreen.css';

/**
 * WhereToInvestScreen
 * Top-level screen for beginner investment selection.
 * - Reuses the authoritative WhereToInvestTab directly.
 * - Displays category selector tabs derived STRICTLY from backend recommendations
 *   in their exact backend-authoritative order (no local re-ranking).
 * - Defaults to recommendations[0] unless explicitly selected by the user.
 * - Integrates the retained Deep Dive capabilities (Calculator, Tax, History, Overview).
 */
const WhereToInvestScreen = ({
  recommendations = [],
  userProfile,
  onLearnMore,
  onSelectInvestment,
  recommendationsLoading = false,
  recommendationsError = null,
  recommendationMeta = null,
}) => {
  // Recommendations in exact backend order
  const recommendedParents = useMemo(() => recommendations || [], [recommendations]);

  // Selected parent instrument id - defaults to first backend recommendation
  const [selectedId, setSelectedId] = useState(null);

  // Scroll ref for category rail
  const railRef = useRef(null);

  const activeParent = useMemo(() => {
    if (recommendedParents.length === 0) return null;
    if (selectedId) {
      const match = recommendedParents.find(r => r.id === selectedId);
      if (match) return match;
    }
    return recommendedParents[0];
  }, [recommendedParents, selectedId]);

  const handleScrollRail = useCallback((direction) => {
    if (railRef.current) {
      const scrollOffset = direction === 'left' ? -260 : 260;
      railRef.current.scrollBy({ left: scrollOffset, behavior: 'smooth' });
    }
  }, []);

  const handleOpenDeepDive = (tab = 'Overview') => {
    if (activeParent) {
      if (typeof onSelectInvestment === 'function') {
        onSelectInvestment(activeParent);
      }
      if (typeof onLearnMore === 'function') {
        onLearnMore(activeParent, tab);
      }
    }
  };

  if (!recommendedParents || recommendedParents.length === 0) {
    return (
      <div className="wti-screen-container">
        <div className="wti-loading-card">
          <AlertCircle size={24} className="wti-loading-icon" aria-hidden="true" />
          <div>
            <div className="wti-loading-title">
              {recommendationsLoading
                ? 'Loading personalized recommendations...'
                : recommendationsError
                  ? 'Personalized recommendations unavailable'
                  : 'No personalized recommendations available'}
            </div>
            <div className="wti-loading-subtitle">
              {recommendationsError
                ? 'The recommendation service did not publish a safe result. No fallback products are shown.'
                : 'Your suitable options will appear here once your financial profile evaluation is complete.'}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="wti-screen-container">
      {/* ─── Hero Header & Context ─── */}
      <header className="wti-screen-header">
        <div className="wti-eyebrow">
          <span className="wti-eyebrow-dot" />
          <span>SUITABILITY MATCHED · VERIFIED EXECUTION</span>
        </div>
        <h1 className="wti-title">
          Your recommended categories
        </h1>
        <p className="wti-subtitle">
          Start with the categories selected by your Financial Profile, then inspect source-verified products inside each one.
        </p>
      </header>

      {/* ─── Recommended Category Segmented Rail (Strictly in exact backend recommendation order) ─── */}
      <nav className="wti-category-nav" aria-label="Investment category selector">
        <div className="wti-category-nav-header">
          <div className="wti-category-nav-meta">
            <span className="wti-category-nav-label">RECOMMENDED PORTFOLIO MIX</span>
            <span className="wti-category-nav-count">({recommendedParents.length} categories)</span>
          </div>
          <span className="wti-category-nav-hint">Select a category to view verified choices</span>
        </div>

        <div className="wti-category-rail-wrapper">
          <button
            type="button"
            className="wti-rail-scroll-btn wti-rail-scroll-btn--left"
            onClick={() => handleScrollRail('left')}
            aria-label="Scroll categories left"
            title="Scroll left"
          >
            <ChevronLeft size={15} />
          </button>

          <div
            ref={railRef}
            role="tablist"
            aria-label="Recommended investment categories"
            className="wti-category-rail"
          >
            {recommendedParents.map((rec) => {
              const isSelected = activeParent?.id === rec.id;
              return (
                <button
                  key={rec.id}
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  data-testid={`wti-category-${rec.id}`}
                  onClick={() => setSelectedId(rec.id)}
                  className={`wti-category-tab ${isSelected ? 'wti-category-tab--active' : ''}`}
                  style={{
                    '--cat-accent': rec.color || '#38bdf8'
                  }}
                >
                  <span
                    className="wti-category-tab-dot"
                    style={{ backgroundColor: rec.color || '#38bdf8' }}
                  />
                  <span className="wti-category-tab-name">{rec.name}</span>
                  {Number.isFinite(rec.allocation_pct) && (
                    <span className="wti-category-tab-alloc">
                      {rec.allocation_pct}%
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            className="wti-rail-scroll-btn wti-rail-scroll-btn--right"
            onClick={() => handleScrollRail('right')}
            aria-label="Scroll categories right"
            title="Scroll right"
          >
            <ChevronRight size={15} />
          </button>
        </div>
      </nav>

      {/* ─── Compact Deep Dive Action Strip for Active Instrument ─── */}
      {activeParent && onLearnMore && (
        <aside
          data-testid="wti-deep-dive-bar"
          className="wti-deep-dive-bar"
          aria-label={`Deep dive analysis tools for ${activeParent.name}`}
        >
          <div className="wti-deep-dive-info">
            <div className="wti-deep-dive-sparkle-box">
              <Sparkles size={14} className="wti-deep-dive-sparkle" />
            </div>
            <div className="wti-deep-dive-text-col">
              <div className="wti-deep-dive-heading-row">
                <span className="wti-deep-dive-heading">
                  Deep Dive Tools:
                </span>
                <span className="wti-deep-dive-instrument-tag">
                  {activeParent.name}
                </span>
              </div>
              <span className="wti-deep-dive-subheading">
                SIP projections, tax analysis, and 10Y NAV history
              </span>
            </div>
          </div>

          <div className="wti-deep-dive-actions">
            <button
              type="button"
              data-testid="wti-open-calc"
              onClick={() => handleOpenDeepDive('Calculator')}
              className="wti-deep-dive-action-btn"
              title="SIP & Growth Calculator"
            >
              <Calculator size={13} />
              <span>Calculator</span>
            </button>
            <button
              type="button"
              data-testid="wti-open-tax"
              onClick={() => handleOpenDeepDive('Tax')}
              className="wti-deep-dive-action-btn"
              title="Tax Treatment & Slabs"
            >
              <Shield size={13} />
              <span>Tax Rules</span>
            </button>
            <button
              type="button"
              data-testid="wti-open-history"
              onClick={() => handleOpenDeepDive('History')}
              className="wti-deep-dive-action-btn"
              title="Historical NAV and Drawdowns"
            >
              <HistoryIcon size={13} />
              <span>History</span>
            </button>
            <button
              type="button"
              data-testid="wti-open-deep-dive"
              onClick={() => handleOpenDeepDive('Overview')}
              className="wti-deep-dive-action-btn wti-deep-dive-action-btn--primary"
              title="Full 7-tab Deep Dive Modal"
            >
              <span>Full Deep Dive</span>
              <ArrowUpRight size={13} />
            </button>
          </div>
        </aside>
      )}

      {/* ─── Authoritative WhereToInvestTab ─── */}
      {activeParent && (
        <main className="wti-main-content">
          <WhereToInvestTab
            key={activeParent.id}
            inv={activeParent}
            userProfile={userProfile}
            recommendationMeta={recommendationMeta}
          />
        </main>
      )}
    </div>
  );
};

export default WhereToInvestScreen;
