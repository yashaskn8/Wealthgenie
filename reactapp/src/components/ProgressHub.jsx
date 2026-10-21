import React from 'react';
import GoalPlanner from './GoalPlanner';
import StepUpPlanner from './StepUpPlanner';
import RebalancerScreen from './RebalancerScreen';
import ErrorBoundary from './ErrorBoundary';
import { Target, TrendingUp, ArrowLeftRight } from 'lucide-react';
import './HubStyles.css';

const TABS = [
  { id: 'goals', label: 'Goals', Icon: Target },
  { id: 'grow-sip', label: 'Grow My SIP', Icon: TrendingUp },
  { id: 'rebalancer', label: 'Keep on Track', Icon: ArrowLeftRight },
];

export default function ProgressHub({
  activeTab = 'goals', onTabChange, profile, financialState,
  financialStateIdentity = null, recommendations, onSaveRebalance,
}) {
  const currentTab = TABS.some(tab => tab.id === activeTab) ? activeTab : 'goals';
  const handleKeyDown = e => {
    const index = TABS.findIndex(tab => tab.id === currentTab);
    const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : null;
    const nextIndex = e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1
      : delta === null ? null : (index + delta + TABS.length) % TABS.length;
    if (nextIndex === null) return;
    e.preventDefault();
    const tab = TABS[nextIndex].id;
    onTabChange?.(tab);
    e.currentTarget.querySelector(`[data-tab-value="${tab}"]`)?.focus();
  };
  return (
    <div className="hub-container">
      <div className="hub-header">
        <div className="hub-eyebrow">YOUR MILESTONES & DISCIPLINE</div>
        <h1 className="hub-title">Your Wealth Journey</h1>
        <p className="hub-subtitle">Plan goals, grow monthly savings and keep your portfolio aligned.</p>
        <div role="tablist" aria-label="Progress views" aria-orientation="horizontal"
          className="hub-tabs-list" onKeyDown={handleKeyDown}>
          {TABS.map(({ id, label, Icon }) => (
            <button key={id} role="tab" id={`tab-${id}`}
              aria-selected={currentTab === id} aria-controls={`panel-${id}`}
              data-testid={`tab-${id}`} data-tab-value={id}
              tabIndex={currentTab === id ? 0 : -1}
              className={`hub-tab-btn ${currentTab === id ? 'hub-tab-btn--active' : ''}`}
              onClick={() => onTabChange?.(id)}>
              <Icon size={15} /><span>{label}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="hub-panel-content">
        <div role="tabpanel" id="panel-goals" aria-labelledby="tab-goals" data-testid="panel-goals" hidden={currentTab !== 'goals'}>
          {currentTab === 'goals' && <ErrorBoundary><GoalPlanner profile={profile} financialState={financialState} /></ErrorBoundary>}
        </div>
        <div role="tabpanel" id="panel-grow-sip" aria-labelledby="tab-grow-sip" data-testid="panel-grow-sip" hidden={currentTab !== 'grow-sip'}>
          {currentTab === 'grow-sip' && (
            <ErrorBoundary>
              <StepUpPlanner key={`${profile?.profileId || profile?.profile_id || profile?._id || 'unavailable'}:${profile?.version ?? 'unknown'}`} profile={profile} />
            </ErrorBoundary>
          )}
        </div>
        <div role="tabpanel" id="panel-rebalancer" aria-labelledby="tab-rebalancer" data-testid="panel-rebalancer" hidden={currentTab !== 'rebalancer'}>
          {currentTab === 'rebalancer' && (
            <ErrorBoundary>
              <RebalancerScreen key={`${profile?.profileId || profile?.profile_id || profile?._id || 'unavailable'}:${profile?.version ?? 'unknown'}:${financialStateIdentity || 'unavailable'}:${(recommendations || []).map(item => `${item.id}:${item.allocationWeight}`).join('|')}`}
                profile={profile} financialStateIdentity={financialStateIdentity}
                recommendations={recommendations} onSave={onSaveRebalance} />
            </ErrorBoundary>
          )}
        </div>
      </div>
    </div>
  );
}
