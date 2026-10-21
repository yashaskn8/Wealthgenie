import React from 'react';
import FinancialIndicatorsPanel from './FinancialIndicatorsPanel';
import GoalTracker from './GoalTracker';
import GoalPlanner from './GoalPlanner';
import StepUpPlanner from './StepUpPlanner';
import RebalancerScreen from './RebalancerScreen';
import ErrorBoundary from './ErrorBoundary';
import { NAV_PAGES } from '../utils/navigationMap';
import './HubStyles.css';

const PAGE_COPY = Object.freeze({
  [NAV_PAGES.FINANCIAL_INDICATORS]: ['Financial Indicators', 'Review individual financial indicators and their profile evidence.'],
  [NAV_PAGES.MY_GOALS]: ['My Goals', 'Track financial goals and savings milestones.'],
  [NAV_PAGES.PLAN_A_GOAL]: ['Plan a Goal', 'Plan your next savings milestone using your profile.'],
  [NAV_PAGES.GROW_MY_SIP]: ['Grow My SIP', 'Explore the impact of monthly savings increases.'],
  [NAV_PAGES.KEEP_ON_TRACK]: ['Keep on Track', 'Review your investment mix and suitable adjustments.'],
});
export default function JourneyPage({
  page, profile, financialState, financialStateIdentity = null,
  recommendations, onNavigate, onSaveRebalance,
}) {
  const copy = PAGE_COPY[page];
  if (!copy) return null;
  const profileKey = `${profile?.profileId || profile?.profile_id || profile?._id || 'unavailable'}:${profile?.version ?? 'unknown'}`;
  return (
    <div className="hub-container" data-testid={`journey-page-${page}`}>
      <header className="hub-header">
        <div className="hub-eyebrow">YOUR WEALTH JOURNEY</div>
        <h1 className="hub-title">{copy[0]}</h1>
        <p className="hub-subtitle">{copy[1]}</p>
      </header>
      <section className="hub-panel-content" aria-label={copy[0]}>
        <ErrorBoundary>
          {page === NAV_PAGES.FINANCIAL_INDICATORS && <FinancialIndicatorsPanel profile={profile} />}
          {page === NAV_PAGES.MY_GOALS && (
            <GoalTracker profile={profile}
              onNavigate={target => onNavigate?.(target === 'goal-planner' ? NAV_PAGES.PLAN_A_GOAL : target)} />
          )}
          {page === NAV_PAGES.PLAN_A_GOAL && <GoalPlanner profile={profile} financialState={financialState} />}
          {page === NAV_PAGES.GROW_MY_SIP && <StepUpPlanner key={profileKey} profile={profile} />}
          {page === NAV_PAGES.KEEP_ON_TRACK && (
            <RebalancerScreen
              key={`${profileKey}:${financialStateIdentity || 'unavailable'}:${(recommendations || []).map(item => `${item.id}:${item.allocationWeight}`).join('|')}`}
              profile={profile}
              financialStateIdentity={financialStateIdentity}
              recommendations={recommendations}
              onSave={onSaveRebalance}
            />
          )}
        </ErrorBoundary>
      </section>
    </div>
  );
}
