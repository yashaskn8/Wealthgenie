import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import ProgressHub from '../ProgressHub';
vi.mock('../GoalPlanner', () => ({ default: () => <div data-testid="goal-planner-view" /> }));
vi.mock('../StepUpPlanner', () => ({ default: () => <div data-testid="step-up-view" /> }));
vi.mock('../RebalancerScreen', () => ({ default: ({ financialStateIdentity }) => <div data-testid="rebalancer-view">{financialStateIdentity}</div> }));
afterEach(cleanup);
function ControlledProgressHub({ initialTab = 'goals' }) {
  const [activeTab, setActiveTab] = useState(initialTab);
  return <ProgressHub activeTab={activeTab} onTabChange={setActiveTab} profile={{ profileId: 'profile-1', version: 1 }} />;
}
describe('single Goals destination in retained mobile Progress hub', () => {
  const cases = [
    ['goals', 'Goals', 'panel-goals', 'goal-planner-view'],
    ['grow-sip', 'Grow My SIP', 'panel-grow-sip', 'step-up-view'],
    ['rebalancer', 'Keep on Track', 'panel-rebalancer', 'rebalancer-view'],
  ];
  it('mounts one active feature at a time with no retired tabs', () => {
    const { rerender } = render(<ProgressHub activeTab="goals" profile={{ profileId: 'p1' }} />);
    for (const [tabId, label, panelId, viewId] of cases) {
      rerender(<ProgressHub activeTab={tabId} profile={{ profileId: 'p1' }} />);
      expect(screen.getByRole('tab', { name: label })).toHaveAttribute('aria-selected', 'true');
      expect(within(screen.getByTestId(panelId)).getByTestId(viewId)).toBeInTheDocument();
      for (const other of cases.filter(item => item[0] !== tabId)) {
        expect(screen.getByTestId(other[2])).toHaveAttribute('hidden');
        expect(within(screen.getByTestId(other[2])).queryByTestId(other[3])).not.toBeInTheDocument();
      }
    }
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(screen.queryByText('Financial Indicators')).toBeNull();
    expect(screen.queryByText('Plan a Goal')).toBeNull();
  });
  it('keyboard navigation cycles through the three remaining tabs', () => {
    render(<ControlledProgressHub />);
    const tabs = screen.getByRole('tablist', { name: 'Progress views' });
    fireEvent.keyDown(tabs, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Grow My SIP' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tabs, { key: 'End' });
    expect(screen.getByRole('tab', { name: 'Keep on Track' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tabs, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Goals' })).toHaveAttribute('aria-selected', 'true');
  });
  it('rejects obsolete tab inputs, and retains canonical rebalancer state', () => {
    const props = { profile: { profileId: 'p1', version: 1 }, recommendations: [{ id: 'fd', allocationWeight: 1 }] };
    const { rerender } = render(<ProgressHub {...props} activeTab="indicators" />);
    expect(screen.getByRole('tab', { name: 'Goals' })).toHaveAttribute('aria-selected', 'true');
    rerender(<ProgressHub {...props} activeTab="plan-goal" />);
    expect(screen.getByRole('tab', { name: 'Goals' })).toHaveAttribute('aria-selected', 'true');
    rerender(<ProgressHub {...props} activeTab="rebalancer" financialStateIdentity="revision-1" />);
    expect(screen.getByTestId('rebalancer-view')).toHaveTextContent('revision-1');
    rerender(<ProgressHub {...props} activeTab="rebalancer" financialStateIdentity="revision-2" />);
    expect(screen.getByTestId('rebalancer-view')).toHaveTextContent('revision-2');
  });
});
