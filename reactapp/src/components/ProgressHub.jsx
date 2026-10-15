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
  const allowedTabs = ['indicators', 'goals', 'plan-goal', 'grow-sip', 'rebalancer'];
  const currentTab = allowedTabs.includes(activeTab) ? activeTab : 'goals';
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
        <div className="hub-eyebrow">YOUR MILESTONES & DISCIPLINE</div>
        <h1 className="hub-title">Track Your Progress</h1>
        <p className="hub-subtitle">
          Monitor your goals, plan future milestones, step up your monthly savings, and keep your portfolio aligned with your target mix.
        </p>

        {/* Tab Navigation */}
        <div role="tablist" aria-label="Progress views" aria-orientation="horizontal" className="hub-tabs-list" onKeyDown={handleTabListKeyDown}>
          <button
            role="tab"
            id="tab-indicators"
            aria-selected={currentTab === 'indicators'}
            aria-controls="panel-indicators"
            data-testid="tab-indicators"
            data-tab-value="indicators"
            tabIndex={currentTab === 'indicators' ? 0 : -1}
            className={`hub-tab-btn ${currentTab === 'indicators' ? 'hub-tab-btn--active' : ''}`}
            onClick={() => onTabChange?.('indicators')}
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
            data-tab-value="goals"
            tabIndex={currentTab === 'goals' ? 0 : -1}
            className={`hub-tab-btn ${currentTab === 'goals' ? 'hub-tab-btn--active' : ''}`}
            onClick={() => onTabChange?.('goals')}
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
            data-tab-value="plan-goal"
            tabIndex={currentTab === 'plan-goal' ? 0 : -1}
            className={`hub-tab-btn ${currentTab === 'plan-goal' ? 'hub-tab-btn--active' : ''}`}
            onClick={() => onTabChange?.('plan-goal')}
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
            data-tab-value="grow-sip"
            tabIndex={currentTab === 'grow-sip' ? 0 : -1}
            className={`hub-tab-btn ${currentTab === 'grow-sip' ? 'hub-tab-btn--active' : ''}`}
            onClick={() => onTabChange?.('grow-sip')}
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
            data-tab-value="rebalancer"
            tabIndex={currentTab === 'rebalancer' ? 0 : -1}
            className={`hub-tab-btn ${currentTab === 'rebalancer' ? 'hub-tab-btn--active' : ''}`}
            onClick={() => onTabChange?.('rebalancer')}
          >
            <ArrowLeftRight size={15} />
            <span>Keep on Track</span>
          </button>
        </div>
      </div>

      {/* Keep every tab target in the accessibility tree; only the active view mounts. */}
      <div className="hub-panel-content">
        <div role="tabpanel" id="panel-indicators" aria-labelledby="tab-indicators" data-testid="panel-indicators" hidden={currentTab !== 'indicators'}>
          {currentTab === 'indicators' && <ErrorBoundary><FinancialIndicatorsPanel profile={profile} /></ErrorBoundary>}
        </div>
        <div role="tabpanel" id="panel-goals" aria-labelledby="tab-goals" data-testid="panel-goals" hidden={currentTab !== 'goals'}>
          {currentTab === 'goals' && <ErrorBoundary><GoalTracker profile={profile} onNavigate={onNavigate} /></ErrorBoundary>}
        </div>
        <div role="tabpanel" id="panel-plan-goal" aria-labelledby="tab-plan-goal" data-testid="panel-plan-goal" hidden={currentTab !== 'plan-goal'}>
          {currentTab === 'plan-goal' && <ErrorBoundary><GoalPlanner profile={profile} financialState={financialState} /></ErrorBoundary>}
        </div>
        <div role="tabpanel" id="panel-grow-sip" aria-labelledby="tab-grow-sip" data-testid="panel-grow-sip" hidden={currentTab !== 'grow-sip'}>
          {currentTab === 'grow-sip' && (
            <ErrorBoundary>
              <StepUpPlanner key={`${profile.profileId}:${profile.version}`} profile={profile} />
            </ErrorBoundary>
          )}
        </div>
        <div role="tabpanel" id="panel-rebalancer" aria-labelledby="tab-rebalancer" data-testid="panel-rebalancer" hidden={currentTab !== 'rebalancer'}>
          {currentTab === 'rebalancer' && (
            <ErrorBoundary>
              <RebalancerScreen
                key={recommendations.map(item => `${item.id}:${item.allocationWeight}`).join('|')}
                profile={profile}
                recommendations={recommendations}
                onSave={onSaveRebalance}
              />
            </ErrorBoundary>
          )}
        </div>
      </div>
    </div>
  );
};

export default ProgressHub;
