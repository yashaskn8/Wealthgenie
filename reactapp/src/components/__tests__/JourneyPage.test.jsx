import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import JourneyPage from '../JourneyPage';
import { NAV_PAGES } from '../../utils/navigationMap';
vi.mock('../FinancialIndicatorsPanel', () => ({ default: () => <div data-testid="indicators-view" /> }));
vi.mock('../GoalTracker', () => ({ default: ({ onNavigate }) => <button data-testid="goals-view" onClick={() => onNavigate('goal-planner')}>Plan</button> }));
vi.mock('../GoalPlanner', () => ({ default: ({ financialState }) => <div data-testid="plan-view">{financialState?.recommendationId}</div> }));
vi.mock('../StepUpPlanner', () => ({ default: () => <div data-testid="sip-view" /> }));
vi.mock('../RebalancerScreen', () => ({ default: ({ financialStateIdentity, onSave }) => <button data-testid="track-view" onClick={() => onSave?.()}>{financialStateIdentity}</button> }));
vi.mock('../ErrorBoundary', () => ({ default: ({ children }) => <>{children}</> }));
afterEach(cleanup);
describe('desktop Wealth Journey pages', () => {
  const pages = [
    [NAV_PAGES.FINANCIAL_INDICATORS, 'Financial Indicators', 'indicators-view'],
    [NAV_PAGES.MY_GOALS, 'My Goals', 'goals-view'],
    [NAV_PAGES.PLAN_A_GOAL, 'Plan a Goal', 'plan-view'],
    [NAV_PAGES.GROW_MY_SIP, 'Grow My SIP', 'sip-view'],
    [NAV_PAGES.KEEP_ON_TRACK, 'Keep on Track', 'track-view'],
  ];
  it.each(pages)('mounts only %s', (page, title, id) => {
    render(<JourneyPage page={page} profile={{ profileId: 'p1', version: 1 }} financialState={{ recommendationId: 'r1' }} financialStateIdentity="rev1" />);
    expect(screen.getByRole('heading', { level: 1, name: title })).toBeInTheDocument();
    expect(screen.getByTestId(id)).toBeInTheDocument();
    expect(screen.queryByRole('tablist', { name: 'Progress views' })).not.toBeInTheDocument();
    for (const [, , other] of pages.filter(p => p[0] !== page)) expect(screen.queryByTestId(other)).not.toBeInTheDocument();
  });
  it('preserves goal planning navigation', () => {
    const onNavigate = vi.fn();
    render(<JourneyPage page={NAV_PAGES.MY_GOALS} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByTestId('goals-view'));
    expect(onNavigate).toHaveBeenCalledWith(NAV_PAGES.PLAN_A_GOAL);
  });
  it('binds the rebalancer revision and save action', () => {
    const onSaveRebalance = vi.fn();
    const props = { page: NAV_PAGES.KEEP_ON_TRACK, profile: { profileId: 'p1', version: 1 },
      recommendations: [{ id: 'fd', allocationWeight: 1 }], onSaveRebalance };
    const { rerender } = render(<JourneyPage {...props} financialStateIdentity="rev1" />);
    fireEvent.click(screen.getByTestId('track-view'));
    expect(onSaveRebalance).toHaveBeenCalledTimes(1);
    rerender(<JourneyPage {...props} financialStateIdentity="rev2" />);
    expect(screen.getByTestId('track-view')).toHaveTextContent('rev2');
  });
});
