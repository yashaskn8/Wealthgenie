import React, { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import WhereToInvestTab from './deepdive/WhereToInvestTab';
import InvestmentUniverseExplorer from './InvestmentUniverseExplorer';
import { getRiskShortlist, saveRiskShortlist } from '../services/api';
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
  const [riskShortlist, setRiskShortlist] = useState(null);
  const [shortlistState, setShortlistState] = useState('LOADING');
  const [shortlistSaving, setShortlistSaving] = useState(false);
  const [shortlistSaved, setShortlistSaved] = useState(false);
  const profileId = userProfile?.profileId || userProfile?._id || null;
  const profileVersion = userProfile?.version || null;
  const recommendationIds = recommendedParents.map(entry => entry?.id).join('|');

  useEffect(() => {
    if (!profileId || !recommendedParents.length) {
      setRiskShortlist(null);
      setShortlistState('UNAVAILABLE');
      return undefined;
    }
    const controller = new AbortController();
    setRiskShortlist(null);
    setShortlistSaved(false);
    setShortlistState('LOADING');
    getRiskShortlist(profileId, { signal:controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      if (result?.status !== 'PROFILE_ELIGIBLE_PARENT_CATEGORIES' || !result.groups) {
        setShortlistState('UNAVAILABLE');
        return;
      }
      setRiskShortlist(result);
      setShortlistState('AVAILABLE');
    }).catch(() => {
      if (!controller.signal.aborted) setShortlistState('UNAVAILABLE');
    });
    return () => controller.abort();
  }, [profileId, profileVersion, recommendationIds, recommendedParents.length]);

  const handleSaveRiskShortlist = useCallback(async () => {
    if (!profileId || !riskShortlist || shortlistSaving) return;
    setShortlistSaving(true);
    try {
      const saved = await saveRiskShortlist(profileId);
      if (saved?.status !== 'SAVED') throw new Error('Shortlist save was not acknowledged.');
      setShortlistSaved(true);
    } catch {
      setShortlistSaved(false);
      setShortlistState('SAVE_FAILED');
    } finally {
      setShortlistSaving(false);
    }
  }, [profileId, riskShortlist, shortlistSaving]);

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
  const hasActiveParent = Boolean(activeParent);

  // Ensure active category tab smoothly scrolls into view when selection changes
  useEffect(() => {
    if (hasActiveParent && railRef.current) {
      const activeEl = railRef.current.querySelector('[aria-selected="true"]');
      if (activeEl) {
        const rail = railRef.current;
        const railRect = rail.getBoundingClientRect();
        const elRect = activeEl.getBoundingClientRect();
        if (elRect.left < railRect.left || elRect.right > railRect.right) {
          activeEl.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
        }
      }
    }
  }, [activeParent?.id, hasActiveParent]);

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
          <span className="wti-eyebrow-status-ring" aria-hidden="true">
            <span className="wti-eyebrow-dot" />
          </span>
          <span>PROFILE-SUITABLE CATEGORIES · PRODUCTS VERIFIED SEPARATELY</span>
        </div>
        <h1 className="wti-title">
          Your recommended categories
        </h1>
        <p className="wti-subtitle">
          Start with the categories selected by your Financial Profile, then inspect source-verified products inside each one.
        </p>
      </header>

      {riskShortlist && (
        <section className="wti-risk-groups" aria-label="Profile-eligible Top 5 investment categories">
          <div className="wti-risk-groups-heading">
            <div>
              <h2>Up to 5 suitable categories per risk group</h2>
              <p>Ranked by WealthGenie’s backend suitability policy. This is not approval of specific funds or bonds; no market price or post-tax return is implied.</p>
            </div>
            <button type="button" onClick={handleSaveRiskShortlist}
              disabled={shortlistSaving || shortlistSaved}
              className="wti-risk-save" aria-label="Save current profile-eligible category shortlist">
              {shortlistSaved ? 'Saved to your profile' : shortlistSaving ? 'Saving…' : 'Save shortlist'}
            </button>
          </div>
          {shortlistState === 'SAVE_FAILED' && (
            <p role="alert">The shortlist could not be saved. Your recommendations were not changed.</p>
          )}
          <div className="wti-risk-grid">
            {[
              ['LOW', 'Beginner-friendly / lower risk'],
              ['MODERATE', 'Moderate risk'],
              ['AGGRESSIVE', 'Higher risk'],
            ].map(([code, title]) => (
              <div className="wti-risk-column" key={code}>
                <h3>{title}</h3>
                {(riskShortlist.groups[code] || []).length === 0 ? (
                  <p className="wti-risk-empty">No suitable categories qualified for this profile.</p>
                ) : (
                  <ol>
                    {(riskShortlist.groups[code] || []).map(pick => (
                      <li key={pick.canonicalParentId}>
                        <span>{pick.name}</span>
                        <small>{pick.shortlistSource === 'CURRENT_SAVED_ALLOCATION'
                          ? 'In saved allocation' : 'Additional suitable candidate'}</small>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            ))}
          </div>
          <p className="wti-risk-footer">New discovery-only investments are excluded until product identity, risk, eligibility, tax treatment and market-data evidence are qualified.</p>
        </section>
      )}

      <InvestmentUniverseExplorer />

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
            <ChevronLeft size={16} />
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
                    <span
                      className="wti-category-tab-alloc"
                      title="Target portfolio allocation percentage (not an investment return)"
                      aria-label={`${rec.allocation_pct}% portfolio allocation`}
                    >
                      {rec.allocation_pct}% alloc
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
            <ChevronRight size={16} />
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
              <Sparkles size={15} className="wti-deep-dive-sparkle" />
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
              <Calculator size={14} />
              <span>Calculator</span>
            </button>
            <button
              type="button"
              data-testid="wti-open-tax"
              onClick={() => handleOpenDeepDive('Tax')}
              className="wti-deep-dive-action-btn"
              title="Tax Treatment & Slabs"
            >
              <Shield size={14} />
              <span>Tax Rules</span>
            </button>
            <button
              type="button"
              data-testid="wti-open-history"
              onClick={() => handleOpenDeepDive('History')}
              className="wti-deep-dive-action-btn"
              title="Historical NAV and Drawdowns"
            >
              <HistoryIcon size={14} />
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
              <ArrowUpRight size={14} />
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
