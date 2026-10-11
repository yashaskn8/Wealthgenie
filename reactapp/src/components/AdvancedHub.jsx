import React from 'react';
import ComparisonTableModal from '../ComparisonTableModal';
import InsightsScreen from '../InsightsScreen';
import ErrorBoundary from './ErrorBoundary';
import { investmentDatabase } from '../investmentDatabase';
import { Layers, Lightbulb, ShieldCheck, Database, FileSearch } from 'lucide-react';
import GenieProofPanel from './GenieProofPanel';
import './HubStyles.css';

/**
 * AdvancedHub
 * Technical depth & engineering evidence hub:
 * - Tab 1: Compare All Options (Full investmentDatabase side-by-side)
 * - Tab 2: Insights & Signals (InsightsScreen)
 * - Tab 3: Diagnostics & Policy (Audit provenance, market context policy state)
 *
 * Reuses existing recommendationMeta state; NEVER triggers duplicate NSE/market requests.
 * Enforces active-tab-only mounting.
 */
const AdvancedHub = ({
  activeTab = 'comparison',
  onTabChange,
  profile,
  recommendations,
  recommendationMeta,
  onNavigateHome,
  genieProofEnabled = false,
}) => {
  const allowedTabs = genieProofEnabled
    ? ['comparison', 'insights', 'diagnostics', 'genieproof']
    : ['comparison', 'insights', 'diagnostics'];
  const currentTab = allowedTabs.includes(activeTab) ? activeTab : 'comparison';

  return (
    <div className="hub-container">
      {/* Hub Header */}
      <div className="hub-header">
        <div className="hub-eyebrow">PROFESSIONAL & ENGINEERING DEPTH</div>
        <h1 className="hub-title">Advanced Research & Evidence</h1>
        <p className="hub-subtitle">
          Explore the entire qualified investment catalog, algorithmic insights, suitability policies, and verified market provenance.
        </p>

        {/* Tab Navigation */}
        <div role="tablist" aria-label="Advanced views" className="hub-tabs-list">
          <button
            role="tab"
            id="tab-comparison"
            aria-selected={currentTab === 'comparison'}
            aria-controls="panel-comparison"
            data-testid="tab-comparison"
            className={`hub-tab-btn ${currentTab === 'comparison' ? 'hub-tab-btn--active' : ''}`}
            onClick={() => onTabChange('comparison')}
          >
            <Layers size={15} />
            <span>Compare All Options</span>
          </button>
          <button
            role="tab"
            id="tab-insights"
            aria-selected={currentTab === 'insights'}
            aria-controls="panel-insights"
            data-testid="tab-insights"
            className={`hub-tab-btn ${currentTab === 'insights' ? 'hub-tab-btn--active' : ''}`}
            onClick={() => onTabChange('insights')}
          >
            <Lightbulb size={15} />
            <span>Insights & Signals</span>
          </button>
          <button
            role="tab"
            id="tab-diagnostics"
            aria-selected={currentTab === 'diagnostics'}
            aria-controls="panel-diagnostics"
            data-testid="tab-diagnostics"
            className={`hub-tab-btn ${currentTab === 'diagnostics' ? 'hub-tab-btn--active' : ''}`}
            onClick={() => onTabChange('diagnostics')}
          >
            <Database size={15} />
            <span>Policy & Diagnostics</span>
          </button>
          {genieProofEnabled && (
            <button
              role="tab"
              id="tab-genieproof"
              aria-selected={currentTab === 'genieproof'}
              aria-controls="panel-genieproof"
              data-testid="tab-genieproof"
              className={`hub-tab-btn ${currentTab === 'genieproof' ? 'hub-tab-btn--active' : ''}`}
              onClick={() => onTabChange('genieproof')}
            >
              <FileSearch size={15} />
              <span>GenieProof</span>
            </button>
          )}
        </div>
      </div>

      {/* Active Tab Panel — ONLY ACTIVE COMPONENT IS MOUNTED */}
      <div className="hub-panel-content">
        {currentTab === 'comparison' && (
          <div
            role="tabpanel"
            id="panel-comparison"
            aria-labelledby="tab-comparison"
            data-testid="panel-comparison"
          >
            <ErrorBoundary>
              <div style={{ position: 'relative' }}>
                <ComparisonTableModal
                  isOpen={true}
                  onClose={onNavigateHome}
                  allInvestments={investmentDatabase}
                  embedded={true}
                  profile={profile}
                  recommendations={recommendations}
                />
              </div>
            </ErrorBoundary>
          </div>
        )}

        {currentTab === 'insights' && (
          <div
            role="tabpanel"
            id="panel-insights"
            aria-labelledby="tab-insights"
            data-testid="panel-insights"
          >
            <ErrorBoundary>
              <InsightsScreen
                profile={profile}
                recommendations={recommendations}
                recommendationMeta={recommendationMeta}
              />
            </ErrorBoundary>
          </div>
        )}

        {currentTab === 'diagnostics' && (
          <div
            role="tabpanel"
            id="panel-diagnostics"
            aria-labelledby="tab-diagnostics"
            data-testid="panel-diagnostics"
          >
            <ErrorBoundary>
              <div style={{ maxWidth: 1000, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 }}>
                {/* Policy Lineage Card */}
                <div style={{
                  background: 'rgba(15, 23, 42, 0.7)',
                  border: '1px solid rgba(56, 189, 248, 0.2)',
                  borderRadius: 16,
                  padding: 24,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                    <ShieldCheck size={20} color="#38bdf8" />
                    <h2 style={{ fontSize: '1.2rem', fontWeight: 700, margin: 0, color: '#f8fafc' }}>
                      Deterministic Recommendation Engine Policy
                    </h2>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
                    <div style={{ background: 'rgba(2, 6, 23, 0.5)', padding: '12px 16px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.06)' }}>
                      <div style={{ fontSize: '0.72rem', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '1px' }}>Policy Lineage</div>
                      <div style={{ fontSize: '0.95rem', fontWeight: 700, color: '#e2e8f0', marginTop: 4 }}>
                        {recommendationMeta?.policy_lineage || 'market-context-policy-1.0.0'}
                      </div>
                    </div>
                    <div style={{ background: 'rgba(2, 6, 23, 0.5)', padding: '12px 16px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.06)' }}>
                      <div style={{ fontSize: '0.72rem', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '1px' }}>Suitability Engine</div>
                      <div style={{ fontSize: '0.95rem', fontWeight: 700, color: '#4ade80', marginTop: 4 }}>
                        Hard Suitability Gate Active
                      </div>
                    </div>
                    <div style={{ background: 'rgba(2, 6, 23, 0.5)', padding: '12px 16px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.06)' }}>
                      <div style={{ fontSize: '0.72rem', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '1px' }}>Market Context State</div>
                      <div style={{ fontSize: '0.95rem', fontWeight: 700, color: '#38bdf8', marginTop: 4 }}>
                        {recommendationMeta?.market_context?.regime || recommendationMeta?.market_state || 'NORMAL'}
                      </div>
                    </div>
                    <div style={{ background: 'rgba(2, 6, 23, 0.5)', padding: '12px 16px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.06)' }}>
                      <div style={{ fontSize: '0.72rem', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '1px' }}>HMM Shadow Diagnostics</div>
                      <div style={{ fontSize: '0.95rem', fontWeight: 700, color: '#a78bfa', marginTop: 4 }}>
                        Shadow Model (Non-authoritative)
                      </div>
                    </div>
                  </div>
                </div>

                {/* Audit & Provider Transparency */}
                <div style={{
                  background: 'rgba(15, 23, 42, 0.7)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  borderRadius: 16,
                  padding: 24,
                }}>
                  <h3 style={{ fontSize: '1.05rem', fontWeight: 700, color: '#f8fafc', marginBottom: 12 }}>
                    Provider Provenance & Verification
                  </h3>
                  <div style={{ fontSize: '0.85rem', color: '#94a3b8', lineHeight: 1.6 }}>
                    <p style={{ margin: '0 0 10px 0' }}>
                      WealthGenie adheres to the non-negotiable financial invariants defined in the WealthGenie Constitution:
                    </p>
                    <ul style={{ paddingLeft: 20, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <li><strong>AMFI:</strong> Direct plan, Growth option NAV and trailing 1-year performance verification.</li>
                      <li><strong>NSE:</strong> Live official market indices (NIFTY 50, India VIX) for deterministic macro risk adjustment.</li>
                      <li><strong>SBI:</strong> Retail domestic term-deposit published card rates for FD comparison.</li>
                      <li><strong>India Post / DEA:</strong> Official quarterly small-savings scheme rates (PPF, Sukanya Samriddhi, NSC).</li>
                      <li><strong>RBI:</strong> Floating Rate Savings Bond linked semiannually to NSC reference rate + 35 bps.</li>
                      <li><strong>Tax Engine:</strong> Incremental fiscal-year calculations using statute-versioned rules and verified product classifications.</li>
                    </ul>
                  </div>
                </div>
              </div>
            </ErrorBoundary>
          </div>
        )}

        {genieProofEnabled && currentTab === 'genieproof' && (
          <div
            role="tabpanel"
            id="panel-genieproof"
            aria-labelledby="tab-genieproof"
            data-testid="panel-genieproof"
          >
            <ErrorBoundary>
              <GenieProofPanel />
            </ErrorBoundary>
          </div>
        )}
      </div>
    </div>
  );
};

export default AdvancedHub;
