import React from 'react';
import GoalTracker from './GoalTracker';
import GoalPlanner from './GoalPlanner';
import StepUpPlanner from './StepUpPlanner';
import FinancialIndicatorsPanel from './FinancialIndicatorsPanel';
import RebalancerScreen from './RebalancerScreen';
import ErrorBoundary from './ErrorBoundary';
import { Target, Crosshair, TrendingUp, Activity, ArrowLeftRight } from 'lucide-react';
import './HubStyles.css';

/**
 * ProgressHub
 * Consolidated tracking & milestone hub for beginner users:
 * - Tab 1: My Goals (GoalTracker)
 * - Tab 2: Plan a Goal (GoalPlanner)
 * - Tab 3: Grow My SIP (StepUpPlanner)
 * - Tab 4: Financial Indicators (individual profile facts; no composite grade)
 * - Tab 5: Keep on Track (RebalancerScreen)
 *
 * Strictly enforces active-tab-only mounting so inactive tabs do not mount or run API calls.
 */
const ProgressHub = ({
  activeTab = 'goals',
  onTabChange,
  profile,
  financialState,
  recommendations,
  onNavigate,
  onSaveRebalance,
}) => {
  const allowedTabs = ['goals', 'plan-goal', 'grow-sip', 'indicators', 'rebalancer'];
  const currentTab = allowedTabs.includes(activeTab) ? activeTab : 'goals';

  return (
    <div className="hub-container">
      {/* Hub Header */}
      <div className="hub-header">
        <div className="hub-eyebrow">YOUR MILESTONES & DISCIPLINE</div>
        <h1 className="hub-title">Track Your Progress</h1>
        <p className="hub-subtitle">
          Monitor your goals, plan future milestones, step up your monthly savings, and keep your portfolio aligned with your target mix.
        </p>

        {/* Tab Navigation */}
        <div role="tablist" aria-label="Progress views" className="hub-tabs-list">
          <button
            role="tab"
            id="tab-indicators"
            aria-selected={currentTab === 'indicators'}
            aria-controls="panel-indicators"
            data-testid="tab-indicators"
            className={`hub-tab-btn ${currentTab === 'indicators' ? 'hub-tab-btn--active' : ''}`}
            onClick={() => onTabChange('indicators')}
          >
            <Activity size={15} />
            <span>Financial Indicators</span>
          </button>
          <button
            role="tab"
            id="tab-goals"
            aria-selected={currentTab === 'goals'}
            aria-controls="panel-goals"
            data-testid="tab-goals"
            className={`hub-tab-btn ${currentTab === 'goals' ? 'hub-tab-btn--active' : ''}`}
            onClick={() => onTabChange('goals')}
          >
            <Target size={15} />
            <span>My Goals</span>
          </button>
          <button
            role="tab"
            id="tab-plan-goal"
            aria-selected={currentTab === 'plan-goal'}
            aria-controls="panel-plan-goal"
            data-testid="tab-plan-goal"
            className={`hub-tab-btn ${currentTab === 'plan-goal' ? 'hub-tab-btn--active' : ''}`}
            onClick={() => onTabChange('plan-goal')}
          >
            <Crosshair size={15} />
            <span>Plan a Goal</span>
          </button>
          <button
            role="tab"
            id="tab-grow-sip"
            aria-selected={currentTab === 'grow-sip'}
            aria-controls="panel-grow-sip"
            data-testid="tab-grow-sip"
            className={`hub-tab-btn ${currentTab === 'grow-sip' ? 'hub-tab-btn--active' : ''}`}
            onClick={() => onTabChange('grow-sip')}
          >
            <TrendingUp size={15} />
            <span>Grow My SIP</span>
          </button>
          <button
            role="tab"
            id="tab-rebalancer"
            aria-selected={currentTab === 'rebalancer'}
            aria-controls="panel-rebalancer"
            data-testid="tab-rebalancer"
            className={`hub-tab-btn ${currentTab === 'rebalancer' ? 'hub-tab-btn--active' : ''}`}
            onClick={() => onTabChange('rebalancer')}
          >
            <ArrowLeftRight size={15} />
            <span>Keep on Track</span>
          </button>
        </div>
      </div>

      {/* Active Tab Panel — ONLY ACTIVE COMPONENT IS MOUNTED */}
      <div className="hub-panel-content">
        {currentTab === 'goals' && (
          <div
            role="tabpanel"
            id="panel-goals"
            aria-labelledby="tab-goals"
            data-testid="panel-goals"
          >
            <ErrorBoundary>
              <GoalTracker profile={profile} onNavigate={onNavigate} />
            </ErrorBoundary>
          </div>
        )}

        {currentTab === 'plan-goal' && (
          <div
            role="tabpanel"
            id="panel-plan-goal"
            aria-labelledby="tab-plan-goal"
            data-testid="panel-plan-goal"
          >
            <ErrorBoundary>
              <GoalPlanner profile={profile} financialState={financialState} />
            </ErrorBoundary>
          </div>
        )}

        {currentTab === 'grow-sip' && (
          <div
            role="tabpanel"
            id="panel-grow-sip"
            aria-labelledby="tab-grow-sip"
            data-testid="panel-grow-sip"
          >
            <ErrorBoundary>
              <StepUpPlanner
                key={`${profile.profileId}:${profile.version}`}
                profile={profile}
              />
            </ErrorBoundary>
          </div>
        )}

        {currentTab === 'indicators' && (
          <div
            role="tabpanel"
            id="panel-indicators"
            aria-labelledby="tab-indicators"
            data-testid="panel-indicators"
          >
            <ErrorBoundary>
              <FinancialIndicatorsPanel profile={profile} />
            </ErrorBoundary>
          </div>
        )}

        {currentTab === 'rebalancer' && (
          <div
            role="tabpanel"
            id="panel-rebalancer"
            aria-labelledby="tab-rebalancer"
            data-testid="panel-rebalancer"
          >
            <ErrorBoundary>
              <RebalancerScreen
                key={recommendations.map(item => `${item.id}:${item.allocationWeight}`).join('|')}
                profile={profile}
                recommendations={recommendations}
                onSave={onSaveRebalance}
              />
            </ErrorBoundary>
          </div>
        )}
      </div>
    </div>
  );
};

export default ProgressHub;
