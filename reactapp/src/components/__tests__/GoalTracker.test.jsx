/** @vitest-environment jsdom */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GoalTracker from '../GoalTracker';
import api from '../../services/api';

vi.mock('framer-motion', async () => {
  const ReactModule = await import('react');
  const components = new Map();
  const motion = new Proxy({}, {
    get(_target, tag) {
      if (!components.has(tag)) {
        components.set(tag, ReactModule.forwardRef((props, ref) => {
          const motionOnlyProps = new Set([
            'initial', 'animate', 'exit', 'transition', 'whileHover', 'whileTap',
            'layout', 'layoutId',
          ]);
          const domProps = Object.fromEntries(Object.entries(props)
            .filter(([key]) => key !== 'children' && !motionOnlyProps.has(key)));
          return ReactModule.createElement(tag, { ...domProps, ref }, props.children);
        }));
      }
      return components.get(tag);
    },
  });
  return { motion, AnimatePresence: ({ children }) => children };
});

vi.mock('../../services/api', () => ({
  default: {
    getGoals: vi.fn(),
    updateGoal: vi.fn(),
    deleteGoal: vi.fn(),
  },
}));

const profile = {
  profileId: '64b000000000000000000001',
  version: 1,
  monthly_savings: 35000,
  investment_horizon_years: 16,
};

const savedGoal = {
  _id: 'goal-1',
  profileId: profile.profileId,
  version: 1,
  sourceProfileVersion: 1,
  goal_name: 'Dream Studio',
  target_amount: 500000,
  current_savings: 50000,
  target_date: '2030-01-01',
  priority: 'High',
  years_remaining: 4,
  inflation_adjusted_target: 600000,
  recommended_sip: 5000,
  gap_amount: 350000,
  status: 'at_risk',
  recommended_instrument: 'balanced_fund',
  monte_carlo_summary: { p50: 250000 },
  calculation_freshness: { fresh: true, reasonCodes: [] },
  advisory_freshness: { fresh: true, reasonCodes: [] },
  gemini_advice: 'Increase the goal contribution when cash flow allows.',
};

const createDeferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const secondGoal = {
  ...savedGoal,
  _id: 'goal-2',
  goal_name: 'Emergency Reserve',
};

describe('GoalTracker custom-goal boundary', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    // clearAllMocks preserves mockResolvedValueOnce queues. A failed test can
    // otherwise leak a queued HTTP response into a later test in the file.
    vi.resetAllMocks();
    api.getGoals.mockResolvedValue({ goals: [] });
    api.updateGoal.mockResolvedValue({ success: true });
    api.deleteGoal.mockResolvedValue({ deleted: true });
  });

  it('preserves the full dashboard empty state and routes to the explicit Goal Planner', async () => {
    const onNavigate = vi.fn();
    render(<GoalTracker profile={profile} onNavigate={onNavigate} />);

    expect(await screen.findByText('No Custom Goals Yet')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'My Financial Goals' })).toBeTruthy();
    expect(screen.getByText('Welcome to your Goals Dashboard')).toBeTruthy();
    expect(screen.getByText("What You're Saving For")).toBeTruthy();
    expect(screen.getByText('Already Saved')).toBeTruthy();
    expect(screen.getByText('Projected Median Value')).toBeTruthy();
    expect(screen.getByText('Overall Progress')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /create custom goal/i }));
    expect(onNavigate).toHaveBeenCalledWith('goal-planner');
    expect(api.getGoals).toHaveBeenCalledTimes(1);
    expect(api.updateGoal).not.toHaveBeenCalled();
    expect(api.deleteGoal).not.toHaveBeenCalled();
  });

  it('shows a retryable unavailable state without exposing service details or claiming there are no goals', async () => {
    api.getGoals
      .mockRejectedValueOnce(new Error('private database detail'))
      .mockResolvedValueOnce({ goals: [savedGoal] });
    render(<GoalTracker profile={profile} onNavigate={vi.fn()} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Your saved goals could not be loaded. Please try again.');
    expect(screen.queryByText('private database detail')).toBeNull();
    expect(screen.queryByText('No Custom Goals Yet')).toBeNull();
    expect(screen.queryByText('No goals linked to the active profile')).toBeNull();
    expect(screen.queryByText('Welcome to your Goals Dashboard')).toBeNull();
    expect(screen.queryByTitle('Dismiss notification')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Dream Studio')).toBeTruthy();
    expect(api.getGoals).toHaveBeenCalledTimes(2);
  });

  it('treats a malformed successful goals response as unavailable instead of empty', async () => {
    api.getGoals
      .mockResolvedValueOnce({ unexpected: [] })
      .mockResolvedValueOnce({ goals: [] });
    render(<GoalTracker profile={profile} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Your saved goals could not be loaded. Please try again.');
    expect(screen.queryByText('No Custom Goals Yet')).toBeNull();
    expect(screen.queryByText('No goals linked to the active profile')).toBeNull();
    expect(screen.queryByText('No Active Goals Configured')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No Custom Goals Yet')).toBeTruthy();
    expect(api.getGoals).toHaveBeenCalledTimes(2);
  });

  it('renders backend-owned goal projections in the complete premium goal card', async () => {
    api.getGoals.mockResolvedValue({ goals: [savedGoal] });
    render(<GoalTracker profile={profile} />);

    expect(await screen.findByText('Dream Studio')).toBeTruthy();
    expect(screen.getByText('Slightly Behind (Needs Boost)')).toBeTruthy();
    expect(screen.getByText('Backend Monte Carlo horizon')).toBeTruthy();
    expect(screen.getByText('Increase the goal contribution when cash flow allows.')).toBeTruthy();
    expect(screen.getAllByText('₹2.5L')).toHaveLength(2);
    expect(screen.getByText('₹3.5L')).toBeTruthy();
  });

  it('hides a fresh-looking projection immediately when the active profile version advances', async () => {
    const refreshedGoals = createDeferred();
    api.getGoals
      .mockResolvedValueOnce({ goals: [savedGoal] })
      .mockImplementationOnce(() => refreshedGoals.promise);
    const view = render(<GoalTracker profile={profile} />);

    expect(await screen.findByText('Dream Studio')).toBeTruthy();
    expect(screen.getAllByText('₹2.5L')).toHaveLength(2);

    view.rerender(<GoalTracker profile={{ ...profile, version: 2 }} />);

    await waitFor(() => expect(api.getGoals).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Slightly Behind (Needs Boost)')).toBeNull();
    expect(screen.queryByText('Increase the goal contribution when cash flow allows.')).toBeNull();
    expect(screen.queryByText('₹2.5L')).toBeNull();
    expect(screen.getByText(/loading your goals/i)).toBeInTheDocument();
  });

  it('retains earlier-profile goals but labels and excludes them from current totals', async () => {
    const earlierGoal = {
      ...savedGoal,
      _id: 'goal-previous-profile',
      profileId: 'previous-profile-id',
      goal_name: 'Earlier Education Goal',
      target_amount: 9000000,
      current_savings: 8000000,
      calculation_freshness: { fresh: false, reasonCodes: ['STALE_PROFILE'] },
      advisory_freshness: { fresh: false, reasonCodes: ['STALE_PROFILE'] },
    };
    api.getGoals.mockResolvedValue({ goals: [savedGoal, earlierGoal] });
    render(<GoalTracker profile={profile} />);

    expect(await screen.findByText('Dream Studio')).toBeTruthy();
    expect(screen.getByText('Earlier Education Goal')).toBeTruthy();
    expect(screen.getByText('Current profile goals')).toBeTruthy();
    expect(screen.getByText('Earlier profile goals')).toBeTruthy();
    expect(screen.getAllByText('Current profile')).toHaveLength(1);
    expect(screen.getAllByText('Earlier profile')).toHaveLength(1);
    expect(screen.getByText(/excluded from current-profile totals and projections/i)).toBeTruthy();

    const overview = screen.getByText("What You're Saving For").closest('.goal-overview-card');
    expect(within(overview).getByText('Across 1 current-profile goals')).toBeTruthy();
    expect(within(overview).getByText('₹5.0L')).toBeTruthy();
    expect(within(overview).getByText('₹50K')).toBeTruthy();
    expect(within(overview).getByText('₹2.5L')).toBeTruthy();
    expect(within(overview).getByText('Monthly Savings Needed: ₹5,000/mo')).toBeTruthy();
    expect(within(overview).getByText('42%')).toBeTruthy();
    expect(within(overview).queryByText('₹95.0L')).toBeNull();
    expect(within(overview).queryByText('₹80.5L')).toBeNull();

    const earlierCard = screen.getByText('Earlier Education Goal').closest('.goal-card-item');
    const earlierCardContent = within(earlierCard);
    const earlierInputs = earlierCardContent.getAllByRole('spinbutton');
    expect(earlierInputs).toHaveLength(2);
    expect(earlierInputs.every(input => input.disabled)).toBe(true);
    fireEvent.change(earlierInputs[0], { target: { value: '10000000' } });
    expect(earlierCardContent.queryByRole('button', { name: /save changes & update projections/i })).toBeNull();
    expect(earlierCardContent.getByTitle('Delete Goal')).toBeTruthy();
    expect(api.updateGoal).not.toHaveBeenCalled();
  });

  it('does not render derived values or advice when freshness proof is missing', async () => {
    api.getGoals.mockResolvedValue({ goals: [{ ...savedGoal, calculation_freshness: undefined, advisory_freshness: undefined }] });
    render(<GoalTracker profile={profile} />);

    expect(await screen.findByText('Dream Studio')).toBeTruthy();
    expect(screen.getAllByText('Awaiting backend calculation').length).toBeGreaterThan(0);
    expect(screen.queryByText('Increase the goal contribution when cash flow allows.')).toBeNull();
  });

  it('keeps a missing target unavailable and does not offer save until both amount facts are valid', async () => {
    const missingTarget = { ...savedGoal };
    delete missingTarget.target_amount;
    api.getGoals.mockResolvedValue({ goals: [missingTarget] });
    render(<GoalTracker profile={profile} />);

    await screen.findByText('Dream Studio');
    const card = screen.getByText('Dream Studio').closest('.goal-card-item');
    expect(card.querySelector('.goal-progress-legend').textContent).toContain('Saved (Unavailable)');
    expect(card.querySelector('.goal-progress-legend').textContent).not.toContain('0% of Target');
    expect(within(card).queryByRole('button', { name: /save changes & update projections/i })).toBeNull();

    const [targetInput] = within(card).getAllByRole('spinbutton');
    fireEvent.change(targetInput, { target: { value: '600000' } });
    fireEvent.click(await within(card).findByRole('button', { name: /save changes & update projections/i }));

    await waitFor(() => expect(api.updateGoal).toHaveBeenCalledWith('goal-1', {
      expectedVersion: 1,
      target_amount: 600000,
      current_savings: 50000,
    }));
  });

  it('keeps missing savings unavailable, then treats an explicitly repaired zero as a real amount', async () => {
    const missingSavings = { ...savedGoal };
    delete missingSavings.current_savings;
    api.getGoals.mockResolvedValue({ goals: [missingSavings] });
    render(<GoalTracker profile={profile} />);

    await screen.findByText('Dream Studio');
    const card = screen.getByText('Dream Studio').closest('.goal-card-item');
    expect(card.querySelector('.goal-progress-legend').textContent).toContain('Saved (Unavailable)');
    expect(card.querySelector('.goal-progress-legend').textContent).not.toContain('0% of Target');
    expect(within(card).queryByRole('button', { name: /save changes & update projections/i })).toBeNull();

    const [, savingsInput] = within(card).getAllByRole('spinbutton');
    fireEvent.change(savingsInput, { target: { value: '0' } });
    expect(card.querySelector('.goal-progress-legend').textContent).toContain('Saved (0% of Target)');
    fireEvent.click(await within(card).findByRole('button', { name: /save changes & update projections/i }));

    await waitFor(() => expect(api.updateGoal).toHaveBeenCalledWith('goal-1', {
      expectedVersion: 1,
      target_amount: 500000,
      current_savings: 0,
    }));
  });

  it.each([
    ['false', { fresh: false }],
    ['missing', {}],
    ['undefined', undefined],
    ['null', null],
    ['numeric false-like', { fresh: 0 }],
    ['string true-like', { fresh: 'true' }],
    ['numeric true-like', { fresh: 1 }],
  ])('blocks derived goal data when calculation freshness is %s', async (_label, freshness) => {
    const goal = { ...savedGoal, calculation_freshness: freshness };
    if (_label === 'missing') delete goal.calculation_freshness;
    api.getGoals.mockResolvedValue({ goals: [goal] });
    render(<GoalTracker profile={profile} />);

    expect(await screen.findByText('Dream Studio')).toBeTruthy();
    expect(screen.getByText('Recalculation Required')).toBeTruthy();
    expect(screen.queryByText('Slightly Behind (Needs Boost)')).toBeNull();
    expect(screen.queryByText('₹2.5L')).toBeNull();
    expect(screen.queryByText('₹3.5L')).toBeNull();
    expect(screen.queryByText('₹5,000')).toBeNull();
    expect(screen.queryByText('₹0')).toBeNull();
  });

  it.each([
    ['false', { fresh: false }],
    ['missing', undefined],
    ['malformed', { fresh: 'true' }],
  ])('hides advice unless advisory freshness is literal true (%s)', async (_label, freshness) => {
    api.getGoals.mockResolvedValue({ goals: [{
      ...savedGoal,
      advisory_freshness: freshness,
    }] });
    render(<GoalTracker profile={profile} />);

    expect(await screen.findByText('Dream Studio')).toBeTruthy();
    expect(screen.queryByText('Increase the goal contribution when cash flow allows.')).toBeNull();
    expect(screen.getAllByText('₹2.5L')).toHaveLength(2);
  });

  it('replaces previously fresh goal data after a stale refresh instead of retaining old values or advice', async () => {
    api.getGoals
      .mockResolvedValueOnce({ goals: [savedGoal] })
      .mockResolvedValueOnce({ goals: [{
        ...savedGoal,
        calculation_freshness: { fresh: false, reasonCodes: ['STALE_ALLOCATION'] },
        advisory_freshness: { fresh: false, reasonCodes: ['STALE_ALLOCATION'] },
      }] });
    render(<GoalTracker profile={profile} />);

    await screen.findByText('Dream Studio');
    const targetInput = screen.getAllByRole('spinbutton')[0];
    await act(async () => {
      fireEvent.change(targetInput, { target: { value: '550000' } });
    });
    expect(targetInput).toHaveValue(550000);
    fireEvent.click(await screen.findByRole('button', { name: /save changes & update projections/i }));

    await waitFor(() => expect(api.getGoals).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Recalculation Required')).toBeTruthy();
    expect(screen.queryByText('Slightly Behind (Needs Boost)')).toBeNull();
    expect(screen.queryByText('Increase the goal contribution when cash flow allows.')).toBeNull();
    expect(screen.queryByText('₹2.5L')).toBeNull();
    expect(screen.queryByText('₹3.5L')).toBeNull();
    expect(screen.queryByText('₹0')).toBeNull();
  });

  it('updates only explicit target facts and then refreshes server calculations', async () => {
    api.getGoals
      .mockResolvedValueOnce({ goals: [savedGoal] })
      .mockResolvedValueOnce({ goals: [{ ...savedGoal, target_amount: 550000 }] });
    render(<GoalTracker profile={profile} />);

    await screen.findByText('Dream Studio');
    const [targetInput] = screen.getAllByRole('spinbutton');
    await act(async () => {
      fireEvent.change(targetInput, { target: { value: '550000' } });
    });
    expect(targetInput).toHaveValue(550000);
    fireEvent.click(await screen.findByRole('button', { name: /save changes & update projections/i }));

    await waitFor(() => expect(api.updateGoal).toHaveBeenCalledWith('goal-1', {
      expectedVersion: 1,
      target_amount: 550000,
      current_savings: 50000,
    }));
    await waitFor(() => expect(api.getGoals).toHaveBeenCalledTimes(2));
  });

  it.each([
    ['missing', { goals: [] }],
    ['older', { goals: [savedGoal] }],
  ])('retains a confirmed goal update across a %s retry response', async (_label, retryResponse) => {
    const committedGoal = { ...savedGoal, version: 2, target_amount: 550000 };
    api.getGoals
      .mockResolvedValueOnce({ goals: [savedGoal] })
      .mockRejectedValueOnce(new Error('private refresh detail'))
      .mockResolvedValueOnce(retryResponse)
      .mockResolvedValueOnce({ goals: [committedGoal] });
    api.updateGoal.mockResolvedValueOnce({ success: true, goal: committedGoal });
    render(<GoalTracker profile={profile} />);

    await screen.findByText('Dream Studio');
    const [targetInput] = screen.getAllByRole('spinbutton');
    fireEvent.change(targetInput, { target: { value: '550000' } });
    fireEvent.click(await screen.findByRole('button', { name: /save changes & update projections/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your saved goals could not be loaded. Please try again.',
    );
    expect(screen.queryByText('private refresh detail')).toBeNull();
    expect(screen.queryByText('No Custom Goals Yet')).toBeNull();
    expect(screen.queryByText('No goals linked to the active profile')).toBeNull();
    expect(screen.getAllByRole('spinbutton')[0]).toHaveValue(550000);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your saved goals could not be loaded. Please try again.',
    );
    expect(screen.getAllByRole('spinbutton')[0]).toHaveValue(550000);
    expect(screen.queryByText('No Custom Goals Yet')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.getGoals).toHaveBeenCalledTimes(4));
    expect(await screen.findByText('Dream Studio')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getAllByRole('spinbutton')[0]).toHaveValue(550000);
  });

  it('allows a confirmed deletion after retaining a committed goal through a failed refresh', async () => {
    const committedGoal = { ...savedGoal, version: 2, target_amount: 550000 };
    api.getGoals
      .mockResolvedValueOnce({ goals: [savedGoal] })
      .mockRejectedValueOnce(new Error('private refresh detail'))
      .mockResolvedValueOnce({ goals: [] });
    api.updateGoal.mockResolvedValueOnce({ success: true, goal: committedGoal });
    api.deleteGoal.mockResolvedValueOnce({ deleted: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<GoalTracker profile={profile} />);

    await screen.findByText('Dream Studio');
    fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '550000' } });
    fireEvent.click(await screen.findByRole('button', { name: /save changes & update projections/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your saved goals could not be loaded. Please try again.');

    fireEvent.click(screen.getByTitle('Delete Goal'));
    await waitFor(() => expect(api.deleteGoal).toHaveBeenCalledWith('goal-1', 2));
    expect(await screen.findByText('No Custom Goals Yet')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(api.getGoals).toHaveBeenCalledTimes(3);
  });

  it('reconciles an ambiguous delete from the authoritative list after a retained goal update', async () => {
    const committedGoal = { ...savedGoal, version: 2, target_amount: 550000 };
    api.getGoals
      .mockResolvedValueOnce({ goals: [savedGoal] })
      .mockRejectedValueOnce(new Error('private refresh detail'))
      .mockResolvedValueOnce({ goals: [] });
    api.updateGoal.mockResolvedValueOnce({ success: true, goal: committedGoal });
    api.deleteGoal.mockRejectedValueOnce(new Error('private timeout detail'));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    render(<GoalTracker profile={profile} />);

    await screen.findByText('Dream Studio');
    fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '550000' } });
    fireEvent.click(await screen.findByRole('button', { name: /save changes & update projections/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your saved goals could not be loaded. Please try again.');

    fireEvent.click(screen.getByTitle('Delete Goal'));
    await waitFor(() => expect(api.deleteGoal).toHaveBeenCalledWith('goal-1', 2));
    expect(await screen.findByText('No Custom Goals Yet')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(alert).not.toHaveBeenCalled();
    expect(api.getGoals).toHaveBeenCalledTimes(3);
  });

  it('keeps a pending updated goal when an ambiguous delete is not reflected in the list', async () => {
    const committedGoal = { ...savedGoal, version: 2, target_amount: 550000 };
    api.getGoals
      .mockResolvedValueOnce({ goals: [savedGoal] })
      .mockRejectedValueOnce(new Error('private refresh detail'))
      .mockResolvedValueOnce({ goals: [committedGoal] });
    api.updateGoal.mockResolvedValueOnce({ success: true, goal: committedGoal });
    api.deleteGoal.mockRejectedValueOnce(new Error('private timeout detail'));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    render(<GoalTracker profile={profile} />);

    await screen.findByText('Dream Studio');
    fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '550000' } });
    fireEvent.click(await screen.findByRole('button', { name: /save changes & update projections/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your saved goals could not be loaded. Please try again.');

    fireEvent.click(screen.getByTitle('Delete Goal'));
    await waitFor(() => expect(api.deleteGoal).toHaveBeenCalledWith('goal-1', 2));
    await waitFor(() => expect(alert).toHaveBeenCalledWith(
      'The goal could not be deleted. It remains saved in your tracker.',
    ));
    expect(await screen.findByText('Dream Studio')).toBeTruthy();
    expect(screen.getAllByRole('spinbutton')[0]).toHaveValue(550000);
    expect(screen.queryByText('No Custom Goals Yet')).toBeNull();
  });

  it('recalculates a stale current-profile goal from saved amounts without edits', async () => {
    api.getGoals
      .mockResolvedValueOnce({ goals: [{
        ...savedGoal,
        calculation_freshness: { fresh: false, reasonCodes: ['STALE_GOAL_HORIZON'] },
        advisory_freshness: { fresh: false, reasonCodes: ['STALE_GOAL_HORIZON'] },
      }] })
      .mockResolvedValueOnce({ goals: [savedGoal] });
    render(<GoalTracker profile={profile} />);

    await screen.findByText('Dream Studio');
    expect(screen.getByRole('button', { name: 'Recalculate goal using saved amounts' })).toBeTruthy();
    expect(api.updateGoal).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Recalculate goal using saved amounts' }));

    await waitFor(() => expect(api.updateGoal).toHaveBeenCalledWith('goal-1', {
      expectedVersion: 1,
      target_amount: 500000,
      current_savings: 50000,
    }));
    await waitFor(() => expect(api.getGoals).toHaveBeenCalledTimes(2));
  });

  it('does not offer stale-plan recalculation for historical-profile goals', async () => {
    api.getGoals.mockResolvedValue({ goals: [{
      ...savedGoal,
      profileId: 'previous-profile-id',
      calculation_freshness: { fresh: false, reasonCodes: ['STALE_PROFILE'] },
    }] });
    render(<GoalTracker profile={profile} />);

    await screen.findByText('Dream Studio');
    expect(screen.queryByRole('button', { name: 'Recalculate goal using saved amounts' })).toBeNull();
    expect(api.updateGoal).not.toHaveBeenCalled();
  });

  it('keeps the stale status but explains and blocks recalculation below the one-month horizon', async () => {
    api.getGoals.mockResolvedValue({ goals: [{
      ...savedGoal,
      target_date: new Date(Date.now() + (14 * 24 * 60 * 60 * 1000)).toISOString(),
      calculation_freshness: { fresh: false, reasonCodes: ['STALE_GOAL_HORIZON'] },
      advisory_freshness: { fresh: false, reasonCodes: ['STALE_GOAL_HORIZON'] },
    }] });
    render(<GoalTracker profile={profile} />);

    await screen.findByText('Dream Studio');
    expect(screen.getByText('Recalculation Required')).toBeTruthy();
    expect(screen.getByRole('note').textContent).toMatch(/too close.*at least one modeled month remaining/i);
    expect(screen.queryByRole('button', { name: 'Recalculate goal using saved amounts' })).toBeNull();
    expect(api.updateGoal).not.toHaveBeenCalled();
  });

  it('keeps the stale status but blocks recalculation beyond the 30-year horizon', async () => {
    const targetDate = new Date();
    targetDate.setFullYear(targetDate.getFullYear() + 31);
    api.getGoals.mockResolvedValue({ goals: [{
      ...savedGoal,
      target_date: targetDate.toISOString(),
      calculation_freshness: { fresh: false, reasonCodes: ['STALE_GOAL_HORIZON'] },
      advisory_freshness: { fresh: false, reasonCodes: ['STALE_GOAL_HORIZON'] },
    }] });
    render(<GoalTracker profile={profile} />);

    await screen.findByText('Dream Studio');
    expect(screen.getByText('Recalculation Required')).toBeTruthy();
    expect(screen.getByRole('note').textContent).toMatch(/more than 30 years away.*within 30 years/i);
    expect(screen.queryByRole('button', { name: 'Recalculate goal using saved amounts' })).toBeNull();
    expect(api.updateGoal).not.toHaveBeenCalled();
  });

  it('keeps recalculation available at the supported 30-year horizon', async () => {
    const targetDate = new Date();
    targetDate.setFullYear(targetDate.getFullYear() + 30);
    api.getGoals.mockResolvedValue({ goals: [{
      ...savedGoal,
      target_date: targetDate.toISOString(),
      calculation_freshness: { fresh: false, reasonCodes: ['STALE_GOAL_HORIZON'] },
      advisory_freshness: { fresh: false, reasonCodes: ['STALE_GOAL_HORIZON'] },
    }] });
    render(<GoalTracker profile={profile} />);

    await screen.findByText('Dream Studio');
    expect(screen.getByRole('button', { name: 'Recalculate goal using saved amounts' })).toBeTruthy();
    expect(screen.queryByRole('note')).toBeNull();
    expect(api.updateGoal).not.toHaveBeenCalled();
  });

  it('deletes only the selected custom goal after confirmation', async () => {
    api.getGoals
      .mockResolvedValueOnce({ goals: [savedGoal, secondGoal] })
      .mockResolvedValueOnce({ goals: [secondGoal] });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<GoalTracker profile={profile} />);

    await screen.findByText('Dream Studio');
    expect(screen.getByText('Emergency Reserve')).toBeTruthy();
    fireEvent.click(screen.getAllByTitle('Delete Goal')[0]);
    await waitFor(() => expect(api.deleteGoal).toHaveBeenCalledWith('goal-1', 1));
    await waitFor(() => expect(screen.queryByText('Dream Studio')).toBeNull());
    expect(await screen.findByText('Emergency Reserve')).toBeTruthy();
  });

  it('does not let an older delete refresh resurrect a goal after a newer delete refresh', async () => {
    const earlierRefresh = createDeferred();
    const laterRefresh = createDeferred();
    const firstDelete = createDeferred();
    const secondDelete = createDeferred();
    api.getGoals
      .mockResolvedValueOnce({ goals: [savedGoal, secondGoal] })
      .mockImplementationOnce(() => earlierRefresh.promise)
      .mockImplementationOnce(() => laterRefresh.promise);
    api.deleteGoal
      .mockImplementationOnce(() => firstDelete.promise)
      .mockImplementationOnce(() => secondDelete.promise);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<GoalTracker profile={profile} />);

    await screen.findByText('Dream Studio');
    const deleteButtons = screen.getAllByTitle('Delete Goal');
    fireEvent.click(deleteButtons[0]);
    fireEvent.click(deleteButtons[1]);
    await waitFor(() => expect(api.deleteGoal).toHaveBeenCalledTimes(2));

    await act(async () => { firstDelete.resolve({ deleted: true }); });
    await waitFor(() => expect(api.getGoals).toHaveBeenCalledTimes(2));
    await act(async () => { secondDelete.resolve({ deleted: true }); });
    await waitFor(() => expect(api.getGoals).toHaveBeenCalledTimes(3));

    await act(async () => { laterRefresh.resolve({ goals: [] }); });
    expect(await screen.findByText('No Custom Goals Yet')).toBeTruthy();

    await act(async () => {
      earlierRefresh.resolve({ goals: [secondGoal] });
      await earlierRefresh.promise;
    });
    expect(screen.queryByText('Emergency Reserve')).toBeNull();
    expect(screen.getByText('No Custom Goals Yet')).toBeTruthy();
  });

  it('keeps the newest update refresh when update responses complete out of order', async () => {
    const earlierRefresh = createDeferred();
    const laterRefresh = createDeferred();
    const firstUpdate = createDeferred();
    const secondUpdate = createDeferred();
    api.getGoals
      .mockResolvedValueOnce({ goals: [savedGoal, secondGoal] })
      .mockImplementationOnce(() => earlierRefresh.promise)
      .mockImplementationOnce(() => laterRefresh.promise);
    api.updateGoal
      .mockImplementationOnce(() => firstUpdate.promise)
      .mockImplementationOnce(() => secondUpdate.promise);
    render(<GoalTracker profile={profile} />);

    await screen.findByText('Dream Studio');
    const targetInputs = screen.getAllByRole('spinbutton').filter((_, index) => index % 2 === 0);
    await act(async () => {
      fireEvent.change(targetInputs[0], { target: { value: '550000' } });
      fireEvent.change(targetInputs[1], { target: { value: '650000' } });
    });
    const saveButtons = screen.getAllByRole('button', { name: /save changes & update projections/i });
    fireEvent.click(saveButtons[0]);
    fireEvent.click(saveButtons[1]);
    await waitFor(() => expect(api.updateGoal).toHaveBeenCalledTimes(2));

    await act(async () => { firstUpdate.resolve({ success: true }); });
    await waitFor(() => expect(api.getGoals).toHaveBeenCalledTimes(2));
    await act(async () => { secondUpdate.resolve({ success: true }); });
    await waitFor(() => expect(api.getGoals).toHaveBeenCalledTimes(3));

    const newestGoals = [
      { ...savedGoal, target_amount: 650000 },
      { ...secondGoal, target_amount: 750000 },
    ];
    await act(async () => { laterRefresh.resolve({ goals: newestGoals }); });
    await screen.findAllByText('₹6.5L');

    await act(async () => {
      earlierRefresh.resolve({ goals: [savedGoal, secondGoal] });
      await earlierRefresh.promise;
    });
    const finalTargetInputs = screen.getAllByRole('spinbutton').filter((_, index) => index % 2 === 0);
    expect(finalTargetInputs.map(input => Number(input.value))).toEqual([650000, 750000]);
  });
});
