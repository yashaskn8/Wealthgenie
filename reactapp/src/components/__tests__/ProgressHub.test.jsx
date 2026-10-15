import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import ProgressHub from '../ProgressHub';

vi.mock('../GoalTracker', () => ({ default: () => <div data-testid="goal-tracker-view" /> }));
vi.mock('../GoalPlanner', () => ({ default: () => <div data-testid="goal-planner-view" /> }));
vi.mock('../StepUpPlanner', () => ({ default: () => <div data-testid="step-up-view" /> }));
vi.mock('../FinancialIndicatorsPanel', () => ({ default: () => <div data-testid="financial-indicators-view" /> }));
vi.mock('../RebalancerScreen', () => ({
  default: ({ financialStateIdentity }) => <div data-testid="rebalancer-view">{financialStateIdentity}</div>,
}));

afterEach(() => cleanup());

function ControlledProgressHub({ initialTab = 'goals' }) {
  const [activeTab, setActiveTab] = useState(initialTab);
  return <ProgressHub activeTab={activeTab} onTabChange={setActiveTab} profile={{ profileId: 'profile-1', version: 1 }} />;
}

describe('ProgressHub tab flow', () => {
  it('wires all five accessible tabs to their matching active-only panel', () => {
    const cases = [
      ['indicators', 'Financial Indicators', 'panel-indicators', 'financial-indicators-view'],
      ['goals', 'My Goals', 'panel-goals', 'goal-tracker-view'],
      ['plan-goal', 'Plan a Goal', 'panel-plan-goal', 'goal-planner-view'],
      ['grow-sip', 'Grow My SIP', 'panel-grow-sip', 'step-up-view'],
      ['rebalancer', 'Keep on Track', 'panel-rebalancer', 'rebalancer-view'],
    ];

    const { rerender } = render(<ProgressHub activeTab="goals" profile={{ profileId: 'profile-1', version: 1 }} />);
    for (const [value, label, panelId, viewId] of cases) {
      rerender(<ProgressHub activeTab={value} profile={{ profileId: 'profile-1', version: 1 }} />);
      const tab = screen.getByRole('tab', { name: label });
      expect(tab).toHaveAttribute('aria-selected', 'true');
      const panel = document.getElementById(panelId);
      expect(panel).not.toHaveAttribute('hidden');
      expect(within(panel).getByTestId(viewId)).toBeInTheDocument();
      for (const [, , otherPanelId, otherViewId] of cases.filter(item => item[0] !== value)) {
        const otherPanel = document.getElementById(otherPanelId);
        expect(otherPanel).toHaveAttribute('hidden');
        expect(within(otherPanel).queryByTestId(otherViewId)).not.toBeInTheDocument();
      }
    }
  });

  it('supports roving keyboard navigation with Home, End, and arrow keys', () => {
    render(<ControlledProgressHub />);
    const tablist = screen.getByRole('tablist', { name: 'Progress views' });

    fireEvent.keyDown(tablist, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Plan a Goal' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tablist, { key: 'End' });
    expect(screen.getByRole('tab', { name: 'Keep on Track' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tablist, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Financial Indicators' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tablist, { key: 'Home' });
    expect(screen.getByRole('tab', { name: 'Financial Indicators' })).toHaveAttribute('aria-selected', 'true');
  });

  it('passes canonical financial-state identity into the Keep on Track view', () => {
    const props = {
      activeTab: 'rebalancer',
      profile: { profileId: 'profile-1', version: 1 },
      recommendations: [{ id: 'fd', allocationWeight: 1 }],
    };
    const { rerender } = render(<ProgressHub {...props} financialStateIdentity="state-revision-1" />);
    expect(screen.getByTestId('rebalancer-view')).toHaveTextContent('state-revision-1');

    rerender(<ProgressHub {...props} financialStateIdentity="state-revision-2" />);
    expect(screen.getByTestId('rebalancer-view')).toHaveTextContent('state-revision-2');
  });
});
