/** @vitest-environment jsdom */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GoalPlanner from '../GoalPlanner';
import { GoalDetailPane } from '../GoalDetailPane';
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
    createGoal: vi.fn(),
    updateGoal: vi.fn(),
    deleteGoal: vi.fn(),
    simulateGoal: vi.fn(),
    getGoalBudget: vi.fn(),
    getGoalFundingPlan: vi.fn(),
    saveGoalBudget: vi.fn(),
    assessGoalVehiclePurchase: vi.fn(),
    projectGoalSavings: vi.fn(),
    getGoalSpecifications: vi.fn(),
    createGoalSpecification: vi.fn(),
    updateGoalSpecification: vi.fn(),
    deleteGoalSpecification: vi.fn(),
  },
}));

const id = number => `64b0000000000000000000${String(number).padStart(2, '0')}`;
const hash = character => character.repeat(64);
const ASYNC_UI_TIMEOUT_MS = 10_000;
const PARAMETERIZED_UPDATE_TIMEOUT_MS = 30_000;
const profile = { profileId: id(1), version: 1, monthly_savings: 30000 };
const financialState = (profileVersion = 1, revision = 3) => ({
  response_state: 'CURRENT',
  profileId: id(1),
  profile_version: profileVersion,
  recommendationId: id(2),
  recommendation_id: id(2),
  allocation_revision: revision,
  allocation_revision_id: id(revision + 10),
  previous_allocation_revision: revision - 1,
  previous_allocation_revision_id: id(revision + 9),
  profile_input_hash: hash('a'),
  portfolio_fingerprint: hash(revision === 3 ? 'b' : 'e'),
  recommendation_fingerprint: hash(revision === 3 ? 'c' : 'f'),
  recommendation_policy_version: 'policy-1',
  regulatory_rule_version: 'tax-policy-1',
  return_assumption_version: 'assumption-1',
  return_assumption_hash: hash('d'),
  return_assumption_source: 'MODEL_POLICY',
  current_allocation_source: 'USER_REBALANCED',
  calculation_freshness: {
    fresh: true,
    reasonCodes: [],
    modelVersion: 'model-v1',
    expectedProfileHash: hash('a'),
    observedProfileHash: hash('a'),
    expectedProfileVersion: profileVersion,
    observedProfileVersion: profileVersion,
    allocationRevision: revision,
    currentAllocationSource: 'USER_REBALANCED',
    observedRegulatoryVersion: 'tax-policy-1',
    currentRegulatoryVersion: 'tax-policy-1',
    policyVersion: 'policy-1',
    observedRecommendationPolicyVersion: 'policy-1',
    assumptionVersion: 'assumption-1',
    assumptionHash: hash('d'),
    assumptionSource: 'MODEL_POLICY',
  },
  state_provenance: {
    status: 'PERSISTED_REVISION',
    stateId: id(5),
    recommendationId: id(2),
    allocationSource: 'USER_REBALANCED',
    allocationRevision: revision,
    allocationRevisionId: id(revision + 10),
    profileVersion,
    profileInputHash: hash('a'),
    portfolioFingerprint: hash(revision === 3 ? 'b' : 'e'),
    recommendationFingerprint: hash(revision === 3 ? 'c' : 'f'),
    recommendationPolicyVersion: 'policy-1',
    regulatoryRuleVersion: 'tax-policy-1',
    returnAssumptionVersion: 'assumption-1',
    returnAssumptionHash: hash('d'),
    returnAssumptionSource: 'MODEL_POLICY',
    modelVersion: 'model-v1',
    previousAllocationRevision: revision - 1,
    previousAllocationRevisionId: id(revision + 9),
  },
});
const currentFinancialState = financialState();
const nextProfileFinancialState = financialState(2);
const nextAllocationFinancialState = financialState(1, 4);
const freshGoal = {
  _id: 'goal-1',
  version: 1,
  profileId: id(1),
  goal_name: 'Home Deposit',
  target_amount: 900000,
  current_savings: 100000,
  target_date: '2032-01-01',
  priority: 'High',
  years_remaining: 6,
  recommended_sip: 5000,
  simulated_monthly_contribution: 5000,
  probability_of_success: 0.82,
  gap_amount: 400000,
  inflation_adjusted_target: 1200000,
  status: 'at_risk',
  recommended_instrument: 'balanced_fund',
  monte_carlo_summary: { simulations_run: 1000 },
  calculation_freshness: { fresh: true, reasonCodes: [] },
  source_provenance: {
    profileVersion: 1,
    profileInputHash: hash('a'),
    recommendationId: id(2),
    allocationRevision: 3,
    allocationRevisionId: id(13),
    portfolioFingerprint: hash('b'),
    recommendationFingerprint: hash('c'),
    recommendationPolicyVersion: 'policy-1',
    regulatoryRuleVersion: 'tax-policy-1',
    returnAssumptionVersion: 'assumption-1',
    returnAssumptionHash: hash('d'),
    modelVersion: 'model-v1',
    goalCalculationInputFingerprint: hash('e'),
  },
  advisory_freshness: { fresh: true, reasonCodes: [] },
  gemini_advice: 'Fresh advice tied to this profile and portfolio.',
};

describe('GoalPlanner financial freshness boundary', () => {
  beforeEach(() => {
    [api.getGoals, api.createGoal, api.updateGoal, api.deleteGoal, api.simulateGoal,
      api.getGoalBudget, api.getGoalFundingPlan, api.saveGoalBudget,
      api.assessGoalVehiclePurchase, api.projectGoalSavings, api.getGoalSpecifications,
      api.createGoalSpecification, api.updateGoalSpecification, api.deleteGoalSpecification]
      .forEach(mock => mock.mockReset());
    api.getGoals.mockResolvedValue({ goals: [] });
    api.getGoalBudget.mockResolvedValue({
      budget: { month: '2026-10', version: 0, monthlyIncome: null,
        expensesComplete: false, protectedMonthlyContributions: 0, expenses: [] },
      summary: { budgetStatus: 'DATA_INSUFFICIENT', recurringExpenses: 0, oneOffExpenses: 0,
        recurringSurplus: null, actualMonthSurplus: null, missing: ['MONTHLY_INCOME_MISSING'] },
    });
    api.getGoalFundingPlan.mockResolvedValue({
      plan: { status: 'DATA_INSUFFICIENT', capacity: null, totalRequested: null, totalAllocated: null,
        allocations: [], warnings: ['GOAL_CALCULATION_OR_BUDGET_MISSING'] },
    });
    api.getGoalSpecifications.mockResolvedValue({ specifications: [] });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('seeds goal edit inputs from the selected goal without losing the first user edit', async () => {
    const props = {
      selectedGoal: freshGoal,
      simulatedSips: {},
      onChangeSimulatedSip: vi.fn(),
      onPriorityChange: vi.fn(),
      onSaveGoalUpdates: vi.fn(),
      getLiveProbability: () => 0.82,
      getSimulatedChartData: () => [],
      monthlySavingsCapacity: 30000,
      simulationLoading: false,
      simulationError: null,
      simulationResult: null,
      calculationFreshness: freshGoal.calculation_freshness,
    };
    render(<GoalDetailPane {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Modify Parameters' }));

    const [target, savings] = screen.getAllByRole('spinbutton');
    expect(target).toHaveValue(900000);
    expect(savings).toHaveValue(100000);
    fireEvent.change(target, { target: { value: '950000' } });
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByRole('button', { name: 'Save Target Changes' })).toBeInTheDocument();
    expect(screen.getAllByRole('spinbutton')[0]).toHaveValue(950000);
  });

  it('keeps an in-progress goal edit when equivalent goal data is refreshed', () => {
    const paneProps = {
      selectedGoal: freshGoal,
      simulatedSips: {},
      onChangeSimulatedSip: vi.fn(),
      onPriorityChange: vi.fn(),
      onSaveGoalUpdates: vi.fn(),
      getLiveProbability: () => 0.82,
      getSimulatedChartData: () => [],
      monthlySavingsCapacity: 30000,
      simulationLoading: false,
      simulationError: null,
      simulationResult: null,
      calculationFreshness: freshGoal.calculation_freshness,
    };
    const view = render(<GoalDetailPane {...paneProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Modify Parameters' }));
    fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '1000000' } });

    view.rerender(<GoalDetailPane {...paneProps} selectedGoal={{ ...freshGoal }} />);
    expect(screen.getByRole('button', { name: 'Save Target Changes' })).toBeInTheDocument();
    expect(screen.getAllByRole('spinbutton')[0]).toHaveValue(1000000);

    view.rerender(<GoalDetailPane {...paneProps} selectedGoal={{ ...freshGoal, version: 2, target_amount: 950000 }} />);
    expect(screen.getByRole('button', { name: 'Modify Parameters' })).toBeInTheDocument();
  });

  it('keeps a pending goal load distinct from a successfully empty goal list', async () => {
    let resolveGoals;
    api.getGoals.mockReturnValueOnce(new Promise(resolve => { resolveGoals = resolve; }));
    render(<GoalPlanner profile={profile} financialState={currentFinancialState} />);

    expect(screen.getByText('Loading saved goals…')).toBeTruthy();
    expect(screen.queryByText('No Active Goals Configured')).toBeNull();
    expect(screen.queryByRole('button', { name: /Initialize Target Goal/i })).toBeNull();
    expect(screen.getAllByRole('button', { name: /Create Target Goal/i })).toHaveLength(1);

    await act(async () => resolveGoals({ goals: [] }));
    expect(await screen.findByText('No Active Goals Configured')).toBeTruthy();
  });

  it('shows a recoverable load error instead of an empty-account message', async () => {
    api.getGoals.mockRejectedValueOnce(new Error('private server detail'));
    render(<GoalPlanner profile={profile} financialState={currentFinancialState} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Your goals could not be loaded. Retry to check again.');
    expect(screen.queryByText('private server detail')).toBeNull();
    expect(screen.queryByText('No Active Goals Configured')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No Active Goals Configured')).toBeTruthy();
    expect(api.getGoals).toHaveBeenCalledTimes(2);
  });

  it('treats a malformed successful goals response as a recoverable load error', async () => {
    api.getGoals
      .mockResolvedValueOnce({ unexpected: [] })
      .mockResolvedValueOnce({ goals: [] });
    render(<GoalPlanner profile={profile} financialState={currentFinancialState} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Your goals could not be loaded. Retry to check again.');
    expect(screen.queryByText('No Active Goals Configured')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No Active Goals Configured')).toBeTruthy();
    expect(api.getGoals).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['rejected', 'reject'],
    ['malformed', 'malformed'],
    ['older or missing committed goal', 'older'],
    ['missing version', 'missing-version'],
    ['invalid version', 'invalid-version'],
    ['string version', 'string-version'],
    ['boolean version', 'boolean-version'],
  ])('keeps a confirmed goal update visible when the follow-up refresh is %s', async (_label, failureKind) => {
    const committedGoal = {
      ...freshGoal,
      version: 2,
      target_amount: 1000000,
      source_provenance: { ...freshGoal.source_provenance, goalCalculationInputFingerprint: hash('f') },
    };
    const siblingGoal = { ...freshGoal, _id: 'goal-2', goal_name: 'Emergency Reserve' };
    api.getGoals.mockResolvedValueOnce({ goals: [freshGoal] });
    if (failureKind === 'reject') {
      api.getGoals.mockRejectedValueOnce(new Error('private refresh detail'));
    } else if (failureKind === 'malformed') {
      api.getGoals.mockResolvedValueOnce({ unexpected: [] });
    } else if (failureKind === 'missing-version') {
      api.getGoals.mockResolvedValueOnce({ goals: [{ ...freshGoal, version: undefined }] });
    } else if (failureKind === 'invalid-version') {
      api.getGoals.mockResolvedValueOnce({ goals: [{ ...freshGoal, version: 1.5 }] });
    } else if (failureKind === 'string-version') {
      api.getGoals.mockResolvedValueOnce({ goals: [{ ...freshGoal, version: '1' }] });
    } else if (failureKind === 'boolean-version') {
      api.getGoals.mockResolvedValueOnce({ goals: [{ ...freshGoal, version: true }] });
    } else {
      api.getGoals.mockResolvedValueOnce({ goals: [freshGoal] });
    }
    api.getGoals.mockResolvedValueOnce({ goals: [committedGoal, siblingGoal] });
    api.updateGoal.mockResolvedValueOnce({ success: true, goal: committedGoal });
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});

    render(<GoalPlanner profile={profile} financialState={currentFinancialState} />);
    await screen.findByText(freshGoal.gemini_advice, {}, { timeout: ASYNC_UI_TIMEOUT_MS });
    fireEvent.click(screen.getByRole('button', { name: 'Modify Parameters' }));
    await screen.findByRole('button', { name: 'Save Target Changes' }, { timeout: ASYNC_UI_TIMEOUT_MS });
    const [targetInput] = await screen.findAllByRole('spinbutton', {}, { timeout: ASYNC_UI_TIMEOUT_MS });
    fireEvent.change(targetInput, { target: { value: '1000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Target Changes' }));

    expect(await screen.findByRole('alert', {}, { timeout: ASYNC_UI_TIMEOUT_MS })).toHaveTextContent(
      'Your goal update was saved. The confirmed changes are shown, but the latest goal list could not be refreshed.',
    );
    expect(screen.getAllByText('₹10.0 L').length).toBeGreaterThan(0);
    expect(screen.queryByText('No Active Goals Configured')).toBeNull();
    expect(alert).not.toHaveBeenCalled();
    expect(api.getGoals).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: 'Retry goal refresh' }));
    expect(await screen.findByText('Emergency Reserve', {}, { timeout: ASYNC_UI_TIMEOUT_MS })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(api.getGoals).toHaveBeenCalledTimes(3);
  }, PARAMETERIZED_UPDATE_TIMEOUT_MS);

  it.each([
    ['wrong id', goal => ({ ...goal, _id: 'goal-other', version: 2 })],
    ['wrong profile', goal => ({ ...goal, profileId: id(2), version: 2 })],
    ['missing version', goal => ({ ...goal, version: undefined })],
    ['fractional version', goal => ({ ...goal, version: 1.5 })],
    ['string version', goal => ({ ...goal, version: '2' })],
    ['boolean version', goal => ({ ...goal, version: true })],
    ['unsafe version', goal => ({ ...goal, version: Number.MAX_SAFE_INTEGER + 1 })],
  ])('reconciles a committed-update response with %s before presenting it', async (_label, makeResponseGoal) => {
    const malformedResponseGoal = makeResponseGoal({
      ...freshGoal,
      target_amount: 1000000,
      source_provenance: { ...freshGoal.source_provenance, goalCalculationInputFingerprint: hash('f') },
    });
    api.getGoals
      .mockResolvedValueOnce({ goals: [freshGoal] })
      .mockResolvedValueOnce({ goals: [freshGoal] });
    api.updateGoal.mockResolvedValueOnce({ success: true, goal: malformedResponseGoal });
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});

    render(<GoalPlanner profile={profile} financialState={currentFinancialState} />);
    await screen.findByText(freshGoal.gemini_advice, {}, { timeout: ASYNC_UI_TIMEOUT_MS });
    fireEvent.click(screen.getByRole('button', { name: 'Modify Parameters' }));
    await screen.findByRole('button', { name: 'Save Target Changes' }, { timeout: ASYNC_UI_TIMEOUT_MS });
    fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '1000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Target Changes' }));

    await waitFor(() => expect(alert).toHaveBeenCalledWith(
      'The goal update could not be confirmed directly. Saved goals were reloaded; check the current values.',
    ), { timeout: ASYNC_UI_TIMEOUT_MS });
    expect(api.getGoals).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('No Active Goals Configured')).toBeNull();
    expect(screen.getAllByText('₹9.0 L').length).toBeGreaterThan(0);
    expect(screen.queryByText('₹10.0 L')).toBeNull();
  }, PARAMETERIZED_UPDATE_TIMEOUT_MS);

  it('removes prior-profile advice and calculated values when the refreshed goal is stale', async () => {
    api.getGoals
      .mockResolvedValueOnce({ goals: [freshGoal] })
      .mockResolvedValueOnce({
        goals: [{
          ...freshGoal,
          probability_of_success: 0.99,
          recommended_sip: 12345,
          // Even a server-provided `fresh` flag cannot override an older
          // profile binding in the source provenance.
          calculation_freshness: { fresh: true, reasonCodes: [] },
          advisory_freshness: { fresh: true, reasonCodes: [] },
        }],
      });

    const { rerender } = render(<GoalPlanner profile={profile} financialState={currentFinancialState} />);
    expect(await screen.findByText(freshGoal.gemini_advice)).toBeTruthy();
    expect(screen.getAllByText('82%').length).toBeGreaterThan(0);

    rerender(<GoalPlanner profile={{ ...profile, version: 2 }} financialState={nextProfileFinancialState} />);

    expect(await screen.findByText('RECALCULATE')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(freshGoal.gemini_advice)).toBeNull());
    expect(screen.queryByText('99%')).toBeNull();
    expect(screen.queryByText('₹12,345/mo')).toBeNull();
    expect(screen.getByText(/Calculation unavailable/)).toBeTruthy();
    expect(api.getGoals).toHaveBeenCalledTimes(2);
  });

  it('does not turn missing fresh calculation metrics into displayed zeroes', async () => {
    api.getGoals.mockResolvedValue({
      goals: [{
        ...freshGoal,
        years_remaining: null,
        recommended_sip: null,
        simulated_monthly_contribution: null,
        probability_of_success: null,
        gap_amount: null,
        inflation_adjusted_target: null,
        inflation_assumption: null,
        monte_carlo_summary: { simulations_run: null, p50: null },
      }],
    });

    render(<GoalPlanner profile={profile} financialState={currentFinancialState} />);

    await screen.findByRole('heading', { level: 3, name: freshGoal.goal_name }, { timeout: 5000 });
    expect(await screen.findByText('Horizon unavailable', {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.queryByText('0%')).toBeNull();
    expect(screen.queryByText('₹0/mo')).toBeNull();
    expect(screen.queryByText(/0 Yrs Horizon/)).toBeNull();
  });

  it('treats a goal calculation as stale when its allocation revision is superseded', async () => {
    api.getGoals.mockResolvedValue({ goals: [freshGoal] });
    const { rerender } = render(<GoalPlanner profile={profile} financialState={currentFinancialState} />);
    expect(await screen.findByText(freshGoal.gemini_advice)).toBeTruthy();

    rerender(<GoalPlanner profile={profile} financialState={nextAllocationFinancialState} />);

    expect(await screen.findByText('RECALCULATE')).toBeTruthy();
    expect(screen.queryByText(freshGoal.gemini_advice)).toBeNull();
    expect(screen.queryByText('82%')).toBeNull();
    expect(screen.queryByText('₹5,000/mo')).toBeNull();
  });

  it('ignores a goal create response that completes after the active profile changes', async () => {
    let resolveCreate;
    api.createGoal.mockImplementation(() => new Promise(resolve => { resolveCreate = resolve; }));
    api.getGoals.mockResolvedValue({ goals: [] });

    const { rerender } = render(<GoalPlanner profile={profile} financialState={currentFinancialState} />);
    fireEvent.click(screen.getByRole('button', { name: /Create Target Goal/i }));
    fireEvent.click(screen.getByRole('button', { name: /Emergency Fund/i }));
    fireEvent.change(screen.getByTestId('goal-target-amount'), { target: { value: '900000' } });
    fireEvent.change(screen.getByTestId('goal-target-date'), { target: { value: '2032-01-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next Step' }));
    fireEvent.change(screen.getByTestId('goal-current-savings'), { target: { value: '100000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Medium' }));
    fireEvent.click(screen.getByTestId('goal-submit'));

    await waitFor(() => expect(api.createGoal).toHaveBeenCalledTimes(1));
    rerender(<GoalPlanner profile={{ ...profile, version: 2 }} financialState={nextProfileFinancialState} />);
    await waitFor(() => expect(api.getGoals).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveCreate({ goal: { ...freshGoal, _id: 'late-goal-1' } });
    });

    expect(screen.queryByText('Home Deposit')).toBeNull();
    expect(screen.queryByText('82%')).toBeNull();
    expect(screen.queryByText('₹5,000/mo')).toBeNull();
  });

  it('submits the canonical profile_id alias when creating a goal', async () => {
    api.getGoals.mockResolvedValue({ goals: [] });
    api.createGoal.mockResolvedValueOnce({ goal: freshGoal });
    render(<GoalPlanner profile={{ profile_id: id(1), version: 1, monthly_savings: 30000 }} financialState={currentFinancialState} />);

    fireEvent.click(screen.getByRole('button', { name: /Create Target Goal/i }));
    fireEvent.click(screen.getByRole('button', { name: /Emergency Fund/i }));
    fireEvent.change(screen.getByTestId('goal-target-amount'), { target: { value: '900000' } });
    fireEvent.change(screen.getByTestId('goal-target-date'), { target: { value: '2032-01-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next Step' }));
    fireEvent.change(screen.getByTestId('goal-current-savings'), { target: { value: '100000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Medium' }));
    fireEvent.click(screen.getByTestId('goal-submit'));

    await waitFor(() => expect(api.createGoal).toHaveBeenCalledTimes(1));
    expect(api.createGoal).toHaveBeenCalledWith(expect.objectContaining({ profileId: id(1) }));
  });

  it('rejects a what-if result bound to another goal version', async () => {
    const versionedGoal = {
      ...freshGoal,
      version: 2,
      simulated_monthly_contribution: 5000,
      source_provenance: {
        ...freshGoal.source_provenance,
        goalCalculationInputFingerprint: hash('e'),
      },
    };
    api.getGoals.mockResolvedValue({ goals: [versionedGoal] });
    api.simulateGoal.mockResolvedValue({
      goal_version: 3,
      goal_calculation_input_fingerprint: hash('e'),
      probability_of_success: 0.99,
      chartData: [],
      monte_carlo_summary: { simulations_run: 1000 },
    });
    render(<GoalPlanner profile={profile} financialState={currentFinancialState} />);

    await screen.findByText('Fresh advice tied to this profile and portfolio.');
    fireEvent.click(screen.getByRole('button', { name: '+25%' }));

    await waitFor(() => expect(api.simulateGoal).toHaveBeenCalledTimes(1), { timeout: 2500 });
    expect(await screen.findByRole('alert')).toHaveTextContent(/goal changed while the what-if calculation was running/i);
    expect(screen.queryByText('99%')).toBeNull();
  });
});
