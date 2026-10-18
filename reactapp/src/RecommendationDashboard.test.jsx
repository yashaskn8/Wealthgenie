/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import RecommendationDashboard from './RecommendationDashboard.jsx';

const profile = {
  profileId: '64b000000000000000000001', monthly_take_home: 100000,
  monthly_savings: 20000, risk_tolerance: 'Moderate', investment_horizon_years: 10,
};

beforeEach(() => {
  localStorage.removeItem('wg_onboarded');
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

  it('does not render market overview data on the dashboard', () => {
    render(<RecommendationDashboard userProfile={profile} recommendations={[]} />);

    expect(screen.queryByTestId('home-market-overview')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Market overview' })).toBeNull();
  });

  it('shows the plan with a truthful delayed state after bounded advisory retries', () => {
    render(<RecommendationDashboard
      userProfile={profile}
      recommendations={[{ id: 'fd', name: 'Server Deposit', cat: 'Debt', allocation_pct: 100, monthly_allocation: 20000 }]}
      recommendationMeta={{ advisory_text: null, advisory_explanation: { status: 'DELAYED' } }}
    />);
    expect(screen.getByTestId('recommendation-row-fd')).toBeInTheDocument();
    expect(screen.getByTestId('advisory-delayed')).toHaveTextContent('Refresh this page later');
    expect(screen.queryByTestId('advisory-loading-skeleton')).toBeNull();
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
  it('labels rule-based fallback plans accurately instead of suggesting trained AI made the allocation', () => {
    render(<RecommendationDashboard
      userProfile={profile}
      recommendations={[{ id: 'fd', name: 'Server Deposit', cat: 'Debt', allocation_pct: 100, monthly_allocation: 20000 }]}
      recommendationMeta={{ ml_fallback: true }}
    />);
    expect(screen.getByTestId('recommendation-rule-fallback-note')).toHaveTextContent(
      'A trained ML prediction was not used for this recommendation.',
    );
    expect(screen.getByText('PERSONALIZED NEXT STEP')).toBeVisible();
    expect(screen.queryByText('AI RECOMMENDED ACTION')).toBeNull();
  });

  it('does not infer product terms from names or IDs for emergency-fund recommendations', () => {
    render(<RecommendationDashboard
      userProfile={{ ...profile, investment_goals: ['Emergency Fund'] }}
      recommendations={[{
        id: 'rbi_bonds', name: 'RBI gilt reference', type: 'RBI_Bond', assetClass: 'Debt',
        nominalReturn: 0, monthly_allocation: 20000, allocation_pct: 100, riskLabel: 'Low', lockIn: null,
      }]}
    />);

    expect(screen.getByRole('heading', { name: 'Emergency-fund recommendations' })).toBeVisible();
    expect(screen.getByText(/Check each product’s current access, withdrawal, and lock-in terms/i)).toBeVisible();
    expect(screen.queryByText(/T\+1 Redemption|1–7 days|zero lock-in|instant access|Sovereign Guarantee|Zero Credit Risk/i)).toBeNull();
    expect(screen.queryByText(/2\.5% Coupon|15Y Tax-Free|Daily Access/i)).toBeNull();
  });
});
