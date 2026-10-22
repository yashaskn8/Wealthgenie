import React, { useState } from 'react';
import TaxScreen from './NewRegimeTaxScreen';
import VerifiedCapitalGainsTaxScreen from './VerifiedCapitalGainsTaxScreen';
import PostTaxAnalysis from '../PostTaxAnalysis';
import ErrorBoundary from './ErrorBoundary';
import { ShieldCheck, Percent } from 'lucide-react';
import './HubStyles.css';

/**
 * TaxesHub
 * Consolidated beginner taxes hub:
 * - Tab 1: New-regime-only ordinary income tax calculator
 * - Tab 2: Real Returns (PostTaxAnalysis: Authoritative post-tax yield comparison)
 *
 * Strictly enforces active-tab-only mounting so inactive tabs do not run effects or API calls.
 */
const TaxesHub = ({
  activeTab = 'regime-savings',
  onTabChange,
  profile,
  recommendations,
  recommendationMeta,
  onLearnMore,
}) => {
  const [advancedCapitalGains, setAdvancedCapitalGains] = useState(false);
  const currentTab = activeTab === 'real-returns' ? 'real-returns' : 'regime-savings';
  const allowedTabs = ['regime-savings', 'real-returns'];
  const handleTabListKeyDown = event => {
    const currentIndex = allowedTabs.indexOf(currentTab);
    let nextIndex = currentIndex;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % allowedTabs.length;
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + allowedTabs.length) % allowedTabs.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = allowedTabs.length - 1;
    else return;
    event.preventDefault();
    const nextTab = allowedTabs[nextIndex];
    onTabChange?.(nextTab);
    event.currentTarget.querySelector(`[data-tab-value="${nextTab}"]`)?.focus();
  };

  return (
    <div className="hub-container">
      {/* Hub Header */}
      <div className="hub-header">
        <div className="hub-eyebrow">TAXES & TAKE-HOME</div>
        <h1 className="hub-title">What You Keep After Tax</h1>
        <p className="hub-subtitle">
          Calculate income tax for supported new-regime situations and review after-tax investment analysis separately.
        </p>

        {/* Tab Navigation */}
        <div role="tablist" aria-label="Tax views" className="hub-tabs-list" onKeyDown={handleTabListKeyDown}>
          <button
            role="tab"
            id="tab-regime-savings"
            aria-selected={currentTab === 'regime-savings'}
            aria-controls="panel-regime-savings"
            data-testid="tab-regime-savings"
            data-tab-value="regime-savings"
            tabIndex={currentTab === 'regime-savings' ? 0 : -1}
            className={`hub-tab-btn ${currentTab === 'regime-savings' ? 'hub-tab-btn--active' : ''}`}
            onClick={() => onTabChange?.('regime-savings')}
          >
            <ShieldCheck size={16} />
            <span>New Regime Tax</span>
          </button>
          <button
            role="tab"
            id="tab-real-returns"
            aria-selected={currentTab === 'real-returns'}
            aria-controls="panel-real-returns"
            data-testid="tab-real-returns"
            data-tab-value="real-returns"
            tabIndex={currentTab === 'real-returns' ? 0 : -1}
            className={`hub-tab-btn ${currentTab === 'real-returns' ? 'hub-tab-btn--active' : ''}`}
            onClick={() => onTabChange?.('real-returns')}
          >
            <Percent size={16} />
            <span>Real Returns on Investments</span>
          </button>
        </div>
      </div>

      {/* Active Tab Panel — ONLY ACTIVE COMPONENT IS MOUNTED */}
      <div className="hub-panel-content">
        {currentTab === 'regime-savings' && (
          <div
            role="tabpanel"
            id="panel-regime-savings"
            aria-labelledby="tab-regime-savings"
            data-testid="panel-regime-savings"
          >
            <div role="group" aria-label="Income tax calculator mode" className="hub-tabs-list">
              <button type="button" aria-pressed={!advancedCapitalGains}
                className={`hub-tab-btn ${!advancedCapitalGains ? 'hub-tab-btn--active' : ''}`}
                onClick={() => setAdvancedCapitalGains(false)}>
                Simple Ordinary Income
              </button>
              <button type="button" aria-pressed={advancedCapitalGains}
                className={`hub-tab-btn ${advancedCapitalGains ? 'hub-tab-btn--active' : ''}`}
                onClick={() => setAdvancedCapitalGains(true)}>
                Advanced Equity Capital Gains
              </button>
            </div>
            <ErrorBoundary>
              {advancedCapitalGains ? (
                <VerifiedCapitalGainsTaxScreen />
              ) : (
                <TaxScreen
                  profile={profile}
                  recommendations={recommendations}
                  onLearnMore={onLearnMore}
                />
              )}
            </ErrorBoundary>
          </div>
        )}

        {currentTab === 'real-returns' && (
          <div
            role="tabpanel"
            id="panel-real-returns"
            aria-labelledby="tab-real-returns"
            data-testid="panel-real-returns"
          >
            <ErrorBoundary>
              <PostTaxAnalysis
                profile={profile}
                recommendations={recommendations}
                recommendationMeta={recommendationMeta}
              />
            </ErrorBoundary>
          </div>
        )}
      </div>
    </div>
  );
};

export default TaxesHub;
