/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { useMarketContextMock } = vi.hoisted(() => ({ useMarketContextMock: vi.fn() }));
vi.mock('./state/useMarketContext', () => ({ useMarketContext: useMarketContextMock }));
import RecommendationDashboard from './RecommendationDashboard.jsx';

const profile = {
  profileId: '64b000000000000000000001', monthly_take_home: 100000,
  monthly_savings: 20000, risk_tolerance: 'Moderate', investment_horizon_years: 10,
};

beforeEach(() => {
  localStorage.removeItem('wg_onboarded');
  useMarketContextMock.mockReturnValue({
    marketContext: null,
    marketContextLoading: false,
    marketContextError: null,
    marketContextRefreshing: false,
  });
});
afterEach(cleanup);

describe('RecommendationDashboard authority boundary', () => {
  it('renders server weights even when rounded rupee amounts imply different proportions', () => {
    render(<RecommendationDashboard userProfile={profile} recommendations={[
      { id: 'fd', name: 'Server Deposit', cat: 'Debt', nominalReturn: 0, monthly_allocation: 1, allocation_pct: 50, score: 0, lockIn: 0 },
      { id: 'ppf', name: 'Server Saving', cat: 'Debt', nominalReturn: null, monthly_allocation: 2, allocation_pct: 50, lockIn: null },
    ]} recommendationMeta={{ dashboard_projection: { total_projected: null, wealth_multiple: null }, portfolio_return_assumption: null }} />);
    const deposit = within(screen.getByTestId('recommendation-row-fd'));
    expect(deposit.getByText('50.0%')).toBeVisible();
    expect(deposit.getByText('₹1')).toBeVisible();
    expect(deposit.getByText('0.0%')).toBeVisible();
    const saving = within(screen.getByTestId('recommendation-row-ppf'));
    expect(saving.getByText('50.0%')).toBeVisible();
    expect(saving.getByText('₹2')).toBeVisible();
    expect(saving.queryByText('0.0%')).toBeNull();
    expect(saving.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.queryByText('0.00x')).toBeNull();
    expect(within(document.getElementById('rec-card-fd')).getByText('None', { exact: true })).toBeVisible();
    expect(within(document.getElementById('rec-card-ppf')).getAllByText('Unavailable', { exact: true }).length).toBeGreaterThan(0);
  });
  it('shows no portfolio when the backend supplies no recommendations', () => {
    render(<RecommendationDashboard userProfile={profile} recommendations={[]} />);
    expect(screen.getByText(/No personalized recommendation is being shown/i)).toBeVisible();
    expect(screen.queryByText(/offline estimate/i)).toBeNull();
  });

  it('shows qualified observed market facts separately from modeled portfolio assumptions', () => {
    useMarketContextMock.mockReturnValue({
      marketContext: {
        status: 'MARKET_CONTEXT_AVAILABLE',
        marketSnapshot: {
          status: 'MARKET_CLOSED',
          observedAt: '2026-10-09T10:00:00.000Z',
          freshness: { status: 'FRESH' },
          marketSession: { status: 'MARKET_CLOSED' },
          observedFacts: [
            { key: 'nifty50Current', value: 22520.45, availabilityStatus: 'AVAILABLE', semanticClass: 'OBSERVED', source: { provider: 'NSE' } },
            { key: 'nifty50PreviousClose', value: 22231.8, availabilityStatus: 'AVAILABLE', semanticClass: 'OBSERVED', source: { provider: 'NSE' } },
            { key: 'indiaVixCurrent', value: 14.36, availabilityStatus: 'AVAILABLE', semanticClass: 'OBSERVED', source: { provider: 'NSE' } },
          ],
        },
      },
      marketContextLoading: false,
      marketContextError: null,
      marketContextRefreshing: false,
    });

    render(<RecommendationDashboard userProfile={profile} recommendations={[]} />);

    const overview = screen.getByTestId('home-market-overview');
    expect(within(overview).getByRole('heading', { name: 'Market overview' })).toBeVisible();
    expect(within(overview).getAllByText('Market closed')).toHaveLength(2);
    expect(within(overview).getByText('22,520.45')).toBeVisible();
    expect(within(overview).getByText('22,231.8')).toBeVisible();
    expect(within(overview).getByText('14.36')).toBeVisible();
    expect(within(overview).getByText(/Source: NSE · Freshness: FRESH/)).toBeVisible();
    expect(within(overview).getByText(/separate from modeled return assumptions/i)).toBeVisible();
  });

  it('renders only supplied server instruments and explains the property-proceeds invariant', () => {
    render(<RecommendationDashboard
      userProfile={profile}
      recommendations={[{
        id: 'index-mf', name: 'Index Mutual Fund', type: 'Equity_MF', riskLabel: 'Moderate',
        nominalReturn: 10, monthly_allocation: 20000, allocationWeight: 1, lockIn: 0,
        suitabilityReasons: ['Within risk ceiling'],
      }]}
      recommendationMeta={{ advisory_text: 'This allocation follows your saved profile.' }}
    />);
    expect(screen.getAllByText('Index Mutual Fund').length).toBeGreaterThan(0);
    expect(screen.getByText(/Sold-property proceeds are not treated as investable capital/i)).toBeVisible();
    expect(screen.getByText(/₹20,000 of ₹20,000 allocated/)).toBeVisible();
    expect(screen.getByText(/Backend-generated allocation and grounded explanation/i)).toBeVisible();
    expect(screen.getByText(/Dashboard returns are pre-tax model assumptions/i)).toBeVisible();
    expect(screen.queryByText(/AI-synthesized financial allocation/i)).toBeNull();
    expect(screen.queryByText(/Returns shown are after tax/i)).toBeNull();
  });
});
