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

describe('RebalancerScreen request binding', () => {
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
          { id: 'index-fund', name: 'Nifty 50 Index Fund', allocationWeight: 0.4, riskLabel: 'Moderate' },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Growth' }));
    await waitFor(() => expect(api.optimisePortfolio).toHaveBeenCalledTimes(1));
    const ppfSlider = screen.getByRole('slider', { name: 'Allocation percentage for Public Provident Fund' });
    fireEvent.change(ppfSlider, { target: { value: '70' } });
    expect(ppfSlider).toHaveValue('70');

    const ppfId = localToBackendInstrument('ppf');
    const indexId = localToBackendInstrument('index-fund');
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
          { id: 'index-fund', name: 'Nifty 50 Index Fund', allocationWeight: 0.4, riskLabel: 'Moderate' },
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
          { id: 'index-fund', name: 'Nifty 50 Index Fund', allocationWeight: 0.4, riskLabel: 'Moderate' },
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
