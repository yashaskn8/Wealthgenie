import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import RebalancerScreen from '../RebalancerScreen';
import * as api from '../../services/api';
import { localToBackendInstrument } from '../../utils/instrumentTypeMap';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

describe('RebalancerScreen request binding', () => {
  it('keeps profile-version-unbound goals out of the investment journey', async () => {
    vi.spyOn(api, 'getGoals').mockResolvedValue({ goals: [{
      profileId: '64b000000000000000000001',
      sourceProfileVersion: 1,
      goal_name: 'Unbound private goal',
      years_remaining: 2,
      target_amount: 500000,
      calculation_freshness: { fresh: true },
    }] });
    vi.spyOn(api, 'getCustomPortfolioProjection').mockResolvedValue({
      performance_data: [{ year: 2, average: 1200000, invested: 480000, gains: 720000, wealth_multiple: 2.5 }],
    });
    vi.spyOn(api, 'runPortfolioMonteCarlo').mockResolvedValue({});

    render(<RebalancerScreen
      profile={{ profileId: '64b000000000000000000001', monthly_savings: 20000, investment_horizon_years: 5 }}
      recommendations={[{ id: 'fd', type: 'FD', name: 'Bank FD', allocationWeight: 1 }]}
    />);

    await waitFor(() => expect(api.getGoals).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Unbound private goal')).not.toBeInTheDocument();
    expect(screen.queryByText(/Linked to .* goal.* from your Goal Planner/)).not.toBeInTheDocument();
  });

  it('clears same-profile projections and refetches goals when canonical financial state advances with unchanged weights', async () => {
    const profile = { profileId: '64b000000000000000000001', version: 1, monthly_savings: 20000, investment_horizon_years: 5 };
    const freshGoal = name => ({
      profileId: profile.profileId,
      sourceProfileVersion: 1,
      goal_name: name,
      years_remaining: 2,
      target_amount: 500000,
      calculation_freshness: { fresh: true },
    });
    const nextGoals = deferred();
    const nextProjection = deferred();
    vi.spyOn(api, 'getGoals')
      .mockResolvedValueOnce({ goals: [freshGoal('Revision one goal')] })
      .mockReturnValueOnce(nextGoals.promise);
    const projection = vi.spyOn(api, 'getCustomPortfolioProjection')
      .mockResolvedValueOnce({
        performance_data: [{ year: 2, average: 1200000, invested: 480000, gains: 720000, wealth_multiple: 2.5 }],
        portfolio_risk_score: 4.5,
      })
      .mockReturnValueOnce(nextProjection.promise);
    vi.spyOn(api, 'runPortfolioMonteCarlo').mockResolvedValue({});
    const recommendations = [{ id: 'fd', type: 'FD', name: 'Bank FD', allocationWeight: 1 }];
    const { rerender } = render(
      <RebalancerScreen profile={profile} financialStateIdentity="canonical-state-revision-1" recommendations={recommendations} />,
    );

    expect(await screen.findByText('Revision one goal')).toBeInTheDocument();
    await waitFor(() => expect(projection).toHaveBeenCalledTimes(1));
    const riskCard = screen.getByText('Your Risk Profile').closest('.risk-thermometer-card');
    const projectionCard = screen.getByText('Future Wealth Projection').closest('.projection-card');
    await waitFor(() => expect(riskCard).toHaveTextContent('High Growth'));
    expect(within(projectionCard).getByText(/Estimated Value/)).toBeInTheDocument();

    rerender(
      <RebalancerScreen profile={profile} financialStateIdentity="canonical-state-revision-2" recommendations={recommendations} />,
    );

    expect(screen.queryByText('Revision one goal')).not.toBeInTheDocument();
    expect(riskCard).toHaveTextContent('Unavailable');
    expect(within(projectionCard).queryByText(/Estimated Value/)).not.toBeInTheDocument();
    await waitFor(() => expect(api.getGoals).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(projection).toHaveBeenCalledTimes(2));

    await act(async () => {
      nextGoals.resolve({ goals: [freshGoal('Revision two goal')] });
      nextProjection.resolve({
        performance_data: [{ year: 2, average: 1300000, invested: 480000, gains: 820000, wealth_multiple: 2.7 }],
        portfolio_risk_score: 2,
      });
    });
    expect(await screen.findByText('Revision two goal')).toBeInTheDocument();
    await waitFor(() => expect(riskCard).toHaveTextContent('Safe'));
    expect(within(projectionCard).getByText(/Estimated Value/)).toBeInTheDocument();
  });

  it('reloads and profile-binds fresh goal milestones when the active profile changes', async () => {
    const profileA = { profileId: '64b000000000000000000001', version: 1, monthly_savings: 20000, investment_horizon_years: 5 };
    const profileB = { profileId: '64b000000000000000000002', version: 1, monthly_savings: 20000, investment_horizon_years: 5 };
    const freshGoal = (profileId, goal_name) => ({
      profileId,
      sourceProfileVersion: 1,
      goal_name,
      years_remaining: 2,
      target_amount: 500000,
      calculation_freshness: { fresh: true },
    });
    const nextGoals = deferred();
    vi.spyOn(api, 'getGoals')
      .mockResolvedValueOnce({ goals: [
        freshGoal(profileA.profileId, 'Profile A target'),
        freshGoal('64b000000000000000000003', 'Historical target'),
        { ...freshGoal(profileA.profileId, 'Stale target'), calculation_freshness: { fresh: false } },
      ] })
      .mockReturnValueOnce(nextGoals.promise);
    vi.spyOn(api, 'getCustomPortfolioProjection').mockResolvedValue({
      performance_data: [{ year: 2, average: 1200000, invested: 480000, gains: 720000, wealth_multiple: 2.5 }],
    });
    vi.spyOn(api, 'runPortfolioMonteCarlo').mockResolvedValue({});
    const recommendations = [{ id: 'fd', type: 'FD', name: 'Bank FD', allocationWeight: 1 }];
    const { rerender } = render(<RebalancerScreen profile={profileA} recommendations={recommendations} />);

    expect(await screen.findByText('Profile A target')).toBeInTheDocument();
    expect(screen.getByText('Linked to 1 goal from your Goal Planner')).toBeInTheDocument();
    expect(screen.queryByText('Historical target')).not.toBeInTheDocument();
    expect(screen.queryByText('Stale target')).not.toBeInTheDocument();

    rerender(<RebalancerScreen profile={profileB} recommendations={recommendations} />);
    expect(screen.queryByText('Profile A target')).not.toBeInTheDocument();
    expect(screen.queryByText(/Linked to .* goal.* from your Goal Planner/)).not.toBeInTheDocument();
    await waitFor(() => expect(api.getGoals).toHaveBeenCalledTimes(2));

    await act(async () => nextGoals.resolve({ goals: [freshGoal(profileB.profileId, 'Profile B target')] }));
    expect(await screen.findByText('Profile B target')).toBeInTheDocument();
    expect(screen.queryByText('Profile A target')).not.toBeInTheDocument();
  });

  it('maps structured product types into category allocations for projections', async () => {
    const profileId = '64b000000000000000000001';
    vi.spyOn(api, 'getGoals').mockResolvedValue([]);
    const projection = vi.spyOn(api, 'getCustomPortfolioProjection').mockResolvedValue({});
    const monteCarlo = vi.spyOn(api, 'runPortfolioMonteCarlo').mockResolvedValue({});

    render(
      <RebalancerScreen
        profile={{ profileId, monthly_savings: 20000, investment_horizon_years: 5, risk_tolerance: 'Conservative', investment_goals: ['Wealth Growth'] }}
        recommendations={[
          { id: 'kotak_fd', type: 'FD', name: 'Kotak Mahindra FD', allocationWeight: 0.6, riskLabel: 'Very Low' },
          { id: 'hdfc_fd', type: 'FD', name: 'HDFC Bank FD', allocationWeight: 0.2, riskLabel: 'Very Low' },
          { id: 'debt_mf', type: 'Debt_MF', name: 'Debt Mutual Fund', allocationWeight: 0.2, riskLabel: 'Low' },
        ]}
      />,
    );

    await waitFor(() => expect(projection).toHaveBeenCalledTimes(1));
    expect(projection).toHaveBeenCalledWith(profileId, { FD: 0.8, Debt_MF: 0.2 }, 5);
    expect(monteCarlo).toHaveBeenCalledWith(profileId, { FD: 0.8, Debt_MF: 0.2 }, 5, null);
  });

  it('keeps category allocations within 100% after summing multiple product weights', async () => {
    vi.spyOn(api, 'getGoals').mockResolvedValue([]);
    const projection = vi.spyOn(api, 'getCustomPortfolioProjection').mockResolvedValue({});
    vi.spyOn(api, 'runPortfolioMonteCarlo').mockResolvedValue({});
    const fdRecommendations = [
      ['kotak_fd', 0.1267], ['axis_fd', 0.1265], ['hdfc_fd', 0.1265], ['icici_fd', 0.1262],
      ['bob_fd', 0.1258], ['pnb_fd', 0.1258], ['sbi_fd', 0.1258], ['mahindra_finance_fd', 0.1167],
    ].map(([id, allocationWeight]) => ({ id, type: 'FD', allocationWeight }));

    render(
      <RebalancerScreen
        profile={{ profileId: '64b000000000000000000001', monthly_savings: 20000, investment_horizon_years: 5, risk_tolerance: 'Conservative' }}
        recommendations={fdRecommendations}
      />,
    );

    await waitFor(() => expect(projection).toHaveBeenCalledTimes(1));
    const allocations = projection.mock.calls[0][1];
    expect(allocations.FD).toBeLessThanOrEqual(1);
    expect(allocations.FD).toBeCloseTo(1, 12);
  });

  it('optimizes canonical categories and redistributes each category weight proportionally', async () => {
    const profileId = '64b000000000000000000001';
    vi.spyOn(api, 'getGoals').mockResolvedValue([]);
    vi.spyOn(api, 'getCustomPortfolioProjection').mockResolvedValue({});
    vi.spyOn(api, 'runPortfolioMonteCarlo').mockResolvedValue({});
    const optimize = vi.spyOn(api, 'optimisePortfolio').mockResolvedValue({
      weights: { FD: 0.5, Debt_MF: 0.5 },
    });

    render(
      <RebalancerScreen
        profile={{ profileId, monthly_savings: 20000, investment_horizon_years: 5, risk_tolerance: 'Conservative', investment_goals: ['Wealth Growth'] }}
        recommendations={[
          { id: 'kotak_fd', type: 'FD', name: 'Kotak Mahindra FD', allocationWeight: 0.6, riskLabel: 'Very Low' },
          { id: 'hdfc_fd', type: 'FD', name: 'HDFC Bank FD', allocationWeight: 0.2, riskLabel: 'Very Low' },
          { id: 'debt_mf', type: 'Debt_MF', name: 'Debt Mutual Fund', allocationWeight: 0.2, riskLabel: 'Low' },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Safe' }));
    await waitFor(() => expect(optimize).toHaveBeenCalledWith(profileId, ['FD', 'Debt_MF'], 'min_variance'));
    await waitFor(() => {
      expect(screen.getByRole('slider', { name: 'Allocation percentage for Kotak Mahindra FD' })).toHaveValue('37.5');
      expect(screen.getByRole('slider', { name: 'Allocation percentage for HDFC Bank FD' })).toHaveValue('12.5');
      expect(screen.getByRole('slider', { name: 'Allocation percentage for Debt Mutual Fund' })).toHaveValue('50');
    });
  });

  it('rejects a conflicting structured type and mapped product identity before model calls', async () => {
    vi.spyOn(api, 'getGoals').mockResolvedValue([]);
    const projection = vi.spyOn(api, 'getCustomPortfolioProjection').mockResolvedValue({});
    const monteCarlo = vi.spyOn(api, 'runPortfolioMonteCarlo').mockResolvedValue({});
    const optimize = vi.spyOn(api, 'optimisePortfolio').mockResolvedValue({ weights: { PPF: 0.5, FD: 0.5 } });

    render(
      <RebalancerScreen
        profile={{ profileId: '64b000000000000000000001', monthly_savings: 20000, investment_horizon_years: 5, risk_tolerance: 'Conservative' }}
        recommendations={[
          { id: 'ppf', type: 'FD', name: 'Conflicting category', allocationWeight: 0.5 },
          { id: 'fd', type: 'FD', name: 'Fixed Deposit', allocationWeight: 0.5 },
        ]}
      />,
    );

    await waitFor(() => expect(screen.getAllByText(/verified model category is unavailable/i).length).toBeGreaterThan(0));
    expect(projection).not.toHaveBeenCalled();
    expect(monteCarlo).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Safe' }));
    expect(optimize).not.toHaveBeenCalled();
  });

  it('preserves exact provider product IDs when saving category-modeled allocations', async () => {
    vi.spyOn(api, 'getGoals').mockResolvedValue([]);
    vi.spyOn(api, 'getCustomPortfolioProjection').mockResolvedValue({});
    vi.spyOn(api, 'runPortfolioMonteCarlo').mockResolvedValue({});
    const onSave = vi.fn();
    const recommendations = [
      { id: 'hdfc_product_001', type: 'FD', name: 'HDFC Fixed Deposit', allocationWeight: 0.75 },
      { id: 'debt_fund_scheme_02', type: 'Debt_MF', name: 'Debt Mutual Fund', allocationWeight: 0.25 },
    ];

    render(
      <RebalancerScreen
        profile={{ profileId: '64b000000000000000000001', monthly_savings: 20000, investment_horizon_years: 5, risk_tolerance: 'Conservative' }}
        recommendations={recommendations}
        onSave={onSave}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save My Investment Mix' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    const [saved] = onSave.mock.calls[0];
    expect(saved.map(investment => investment.id)).toEqual(['hdfc_product_001', 'debt_fund_scheme_02']);
    expect(saved.map(investment => investment.allocationWeight)).toEqual([0.75, 0.25]);
  });

  it('refuses to save an empty allocation set that does not total 100 percent', () => {
    vi.spyOn(api, 'getGoals').mockResolvedValue([]);
    vi.spyOn(api, 'getCustomPortfolioProjection').mockResolvedValue({});
    vi.spyOn(api, 'runPortfolioMonteCarlo').mockResolvedValue({});
    const onSave = vi.fn();

    render(
      <RebalancerScreen
        profile={{ profileId: '64b000000000000000000001', monthly_savings: 20000, investment_horizon_years: 5 }}
        recommendations={[]}
        onSave={onSave}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save My Investment Mix' }));
    expect(screen.getByText(/Allocations must total exactly 100%/)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('does not let a late optimizer result overwrite a newer manual allocation edit', async () => {
    let finishOptimization;
    vi.spyOn(api, 'getGoals').mockResolvedValue([]);
    vi.spyOn(api, 'getCustomPortfolioProjection').mockResolvedValue({});
    vi.spyOn(api, 'runPortfolioMonteCarlo').mockResolvedValue({});
    vi.spyOn(api, 'optimisePortfolio').mockReturnValue(new Promise(resolve => {
      finishOptimization = resolve;
    }));

    render(
      <RebalancerScreen
        profile={{ profileId: '64b000000000000000000001', monthly_savings: 30000, investment_horizon_years: 10, risk_tolerance: 'Moderate', investment_goals: ['Wealth Growth'] }}
        recommendations={[
          { id: 'ppf', name: 'Public Provident Fund', allocationWeight: 0.6, riskLabel: 'Very Low' },
          { id: 'index_mf', name: 'Nifty 50 Index Fund', allocationWeight: 0.4, riskLabel: 'Moderate' },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Growth' }));
    await waitFor(() => expect(api.optimisePortfolio).toHaveBeenCalledTimes(1));
    const ppfSlider = screen.getByRole('slider', { name: 'Allocation percentage for Public Provident Fund' });
    fireEvent.change(ppfSlider, { target: { value: '70' } });
    expect(ppfSlider).toHaveValue('70');

    const ppfId = localToBackendInstrument('ppf');
    const indexId = localToBackendInstrument('index_mf');
    await act(async () => {
      finishOptimization({ weights: { [ppfId]: 0.2, [indexId]: 0.8 } });
    });

    expect(screen.getByRole('slider', { name: 'Allocation percentage for Public Provident Fund' })).toHaveValue('70');
  });

  it('hides projection and Monte Carlo results as soon as allocation inputs change', async () => {
    let finishProjection;
    let finishMonteCarlo;
    vi.spyOn(api, 'getGoals').mockResolvedValue([]);
    vi.spyOn(api, 'getCustomPortfolioProjection')
      .mockResolvedValueOnce({
        performance_data: [{ year: 10, average: 98765432, invested: 3600000, gains: 95165432, wealth_multiple: 2.7 }],
        portfolio_risk_score: 4.5,
      })
      .mockReturnValueOnce(new Promise(resolve => { finishProjection = resolve; }));
    vi.spyOn(api, 'runPortfolioMonteCarlo')
      .mockResolvedValueOnce({ percentile_summary: { p10: 91000000, p50: 98765432, p90: 99999999 } })
      .mockReturnValueOnce(new Promise(resolve => { finishMonteCarlo = resolve; }));

    render(
      <RebalancerScreen
        profile={{ profileId: '64b000000000000000000001', monthly_savings: 30000, investment_horizon_years: 10, risk_tolerance: 'Moderate', investment_goals: ['Wealth Growth'] }}
        recommendations={[
          { id: 'ppf', name: 'Public Provident Fund', allocationWeight: 0.6, riskLabel: 'Very Low' },
          { id: 'index_mf', name: 'Nifty 50 Index Fund', allocationWeight: 0.4, riskLabel: 'Moderate' },
        ]}
      />,
    );

    await waitFor(() => expect(api.getCustomPortfolioProjection).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.runPortfolioMonteCarlo).toHaveBeenCalledTimes(1));
    const riskCard = screen.getByText('Your Risk Profile').closest('.risk-thermometer-card');
    const projectionCard = screen.getByText('Future Wealth Projection').closest('.projection-card');
    const scenarioCard = screen.getByText(/Market Scenario Projections/i).closest('.scenarios-card');
    await waitFor(() => expect(riskCard).toHaveTextContent('High Growth'));
    expect(within(projectionCard).getByText(/Estimated Value/)).toBeInTheDocument();
    expect(within(scenarioCard).getByText('Simulated Median (P50)')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('slider', { name: 'Allocation percentage for Public Provident Fund' }), { target: { value: '70' } });

    expect(riskCard).toHaveTextContent('Unavailable');
    expect(within(projectionCard).queryByText(/Estimated Value/)).not.toBeInTheDocument();
    expect(within(scenarioCard).queryByText('Simulated Median (P50)')).not.toBeInTheDocument();

    await waitFor(() => expect(api.getCustomPortfolioProjection).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(api.runPortfolioMonteCarlo).toHaveBeenCalledTimes(2));
    await act(async () => {
      finishProjection({
        performance_data: [{ year: 10, average: 123456789, invested: 3600000, gains: 119856789, wealth_multiple: 3.4 }],
        portfolio_risk_score: 2,
      });
      finishMonteCarlo({ percentile_summary: { p10: 1100000, p50: 1234567, p90: 1400000 } });
    });
    await waitFor(() => expect(riskCard).toHaveTextContent('Safe'));
    expect(within(projectionCard).getByText(/Estimated Value/)).toBeInTheDocument();
    expect(within(scenarioCard).getByText('Simulated Median (P50)')).toBeInTheDocument();
  });

  it('keeps explicit null projection and Monte Carlo values unavailable instead of rendering zero', async () => {
    vi.spyOn(api, 'getGoals').mockResolvedValue([]);
    vi.spyOn(api, 'getCustomPortfolioProjection').mockResolvedValue({
      performance_data: [{ year: 10, average: null, invested: null, gains: null, wealth_multiple: null }],
      portfolio_risk_score: null,
    });
    vi.spyOn(api, 'runPortfolioMonteCarlo').mockResolvedValue({
      percentile_summary: { p10: null, p50: null, p90: null },
    });

    render(
      <RebalancerScreen
        profile={{ profileId: '64b000000000000000000001', monthly_savings: 30000, investment_horizon_years: 10, risk_tolerance: 'Moderate', investment_goals: ['Wealth Growth'] }}
        recommendations={[
          { id: 'ppf', name: 'Public Provident Fund', allocationWeight: 0.6, riskLabel: 'Very Low' },
          { id: 'index_mf', name: 'Nifty 50 Index Fund', allocationWeight: 0.4, riskLabel: 'Moderate' },
        ]}
      />,
    );

    await waitFor(() => expect(api.getCustomPortfolioProjection).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.runPortfolioMonteCarlo).toHaveBeenCalledTimes(1));

    const projectionCard = screen.getByText('Future Wealth Projection').closest('.projection-card');
    const scenarioCard = screen.getByText(/Market Scenario Projections/i).closest('.scenarios-card');
    expect(within(projectionCard).queryByText('₹0')).not.toBeInTheDocument();
    expect(within(projectionCard).getAllByText('—').length).toBeGreaterThan(0);
    expect(within(scenarioCard).queryByText('₹0')).not.toBeInTheDocument();
    expect(within(scenarioCard).getAllByText('—').length).toBeGreaterThan(0);
  });
});
