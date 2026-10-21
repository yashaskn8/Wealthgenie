import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import JourneyPage from '../JourneyPage';
import { NAV_PAGES } from '../../utils/navigationMap';
vi.mock('../GoalPlanner', () => ({ default: ({ financialState }) => (
  <section data-testid="goals-view"><h1>My Goal Planner</h1>{financialState?.recommendationId}</section>
) }));
vi.mock('../StepUpPlanner', () => ({ default: () => <div data-testid="sip-view" /> }));
vi.mock('../RebalancerScreen', () => ({ default: ({ financialStateIdentity, onSave }) => (
  <button data-testid="track-view" onClick={() => onSave?.()}>{financialStateIdentity}</button>
) }));
vi.mock('../ErrorBoundary', () => ({ default: ({ children }) => <>{children}</> }));
afterEach(cleanup);
describe('desktop Wealth Journey destinations', () => {
  const pages = [
    [NAV_PAGES.GOALS, 'goals-view'],
    [NAV_PAGES.GROW_MY_SIP, 'sip-view'],
    [NAV_PAGES.KEEP_ON_TRACK, 'track-view'],
  ];
  it.each(pages)('mounts only %s', (page, id) => {
    render(<JourneyPage page={page} profile={{ profileId: 'p1', version: 1 }}
      financialState={{ recommendationId: 'r1' }} financialStateIdentity="rev1" />);
    expect(screen.getByTestId(`journey-page-${page}`)).toBeInTheDocument();
    expect(screen.getByTestId(id)).toBeInTheDocument();
    expect(screen.queryByRole('tablist', { name: 'Progress views' })).not.toBeInTheDocument();
    for (const [, other] of pages.filter(item => item[0] !== page)) expect(screen.queryByTestId(other)).not.toBeInTheDocument();
  });
  it('does not render two goal page headers', () => {
    render(<JourneyPage page={NAV_PAGES.GOALS} profile={{ profileId: 'p1' }} />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'My Goal Planner' })).toBeInTheDocument();
  });
  it('keeps the canonical rebalancer identity and save action', () => {
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
