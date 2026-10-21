import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cwd } from 'node:process';
import TaxesHub from '../TaxesHub';
import ProgressHub from '../ProgressHub';
import WhereToInvestScreen from '../WhereToInvestScreen';
import DeepDiveModal from '../DeepDiveModal';
import Sidebar from '../Sidebar';
import {
  NAV_PAGES,
  resolveNavigation,
} from '../../utils/navigationMap';

afterEach(cleanup);

const mockProfile = {
  profileId: '64b000000000000000000001',
  age: 30,
  monthly_take_home: 100000,
  monthly_savings: 30000,
  investment_goals: ['Emergency Fund', 'Wealth Growth'],
  investment_horizon_years: 10,
  liquid_savings: 500000,
  emi_burden_pct: 10,
  financial_dependents: 1,
  emergency_fund_months: 6,
  risk_tolerance: 'Moderate',
  version: 1,
};

const mockRecommendations = [
  {
    id: 'ppf',
    name: 'Public Provident Fund',
    type: 'PPF',
    category: 'Government',
    allocationWeight: 0.6,
    allocation_pct: 60,
    monthly_allocation: 18000,
    nominalReturn: 7.1,
    effectiveYield: 7.1,
    color: '#06b6d4',
  },
  {
    id: 'index_mf',
    name: 'Nifty 50 Index Fund',
    type: 'Index_MF',
    category: 'Equity',
    allocationWeight: 0.4,
    allocation_pct: 40,
    monthly_allocation: 12000,
    nominalReturn: 12.0,
    effectiveYield: 12.0,
    color: '#6366f1',
  },
];

describe('Feature Preservation: Zero-Feature-Loss Audit', () => {
  describe('1. Legacy Navigation Mappings', () => {
    const expectedMappings = [
      { legacy: 'dashboard', page: NAV_PAGES.HOME, tab: null },
      { legacy: 'allocation', page: NAV_PAGES.PLAN, tab: null },
      { legacy: 'where-to-invest', page: NAV_PAGES.INVESTMENTS, tab: null },
      { legacy: 'tax-optimizer', page: NAV_PAGES.TAXES, tab: 'regime-savings' },
      { legacy: 'taxes', page: NAV_PAGES.TAXES, tab: 'regime-savings' },
      { legacy: 'post-tax', page: NAV_PAGES.TAXES, tab: 'real-returns' },
      { legacy: 'goals', page: NAV_PAGES.GOALS, tab: null },
      { legacy: 'goal-planner', page: NAV_PAGES.GOALS, tab: null },
      { legacy: 'sip-planner', page: NAV_PAGES.GROW_MY_SIP, tab: null },
      { legacy: 'health', page: NAV_PAGES.HOME, tab: null },
      { legacy: 'rebalancer', page: NAV_PAGES.PROGRESS, tab: 'rebalancer' },
      { legacy: 'compare', page: NAV_PAGES.HOME, tab: null },
      { legacy: 'insights', page: NAV_PAGES.HOME, tab: null },
      { legacy: 'diagnostics', page: NAV_PAGES.HOME, tab: null },
      { legacy: 'profile', page: NAV_PAGES.ACCOUNT, tab: null },
      { legacy: 'account', page: NAV_PAGES.ACCOUNT, tab: null },
      { legacy: 'help', page: NAV_PAGES.HELP, tab: null },
    ];

    expectedMappings.forEach(({ legacy, page, tab }) => {
      it(`maps legacy identifier "${legacy}" to page="${page}" and tab="${tab}"`, () => {
        const resolved = resolveNavigation(legacy);
        expect(resolved).toEqual({ page, tab });
      });
    });
  });

  describe('2. TaxesHub preserves TaxScreen and PostTaxAnalysis', () => {
    it('mounts TaxScreen under regime-savings tab with required props', () => {
      const onLearnMore = vi.fn();
      render(
        <TaxesHub
          activeTab="regime-savings"
          onTabChange={vi.fn()}
          profile={mockProfile}
          recommendations={mockRecommendations}
          onLearnMore={onLearnMore}
        />
      );

      expect(screen.getByTestId('panel-regime-savings')).toBeInTheDocument();
      expect(screen.queryByTestId('panel-real-returns')).not.toBeInTheDocument();
    });

    it('mounts PostTaxAnalysis under real-returns tab', () => {
      render(
        <TaxesHub
          activeTab="real-returns"
          onTabChange={vi.fn()}
          profile={mockProfile}
          recommendations={mockRecommendations}
        />
      );

      expect(screen.getByTestId('panel-real-returns')).toBeInTheDocument();
      expect(screen.queryByTestId('panel-regime-savings')).not.toBeInTheDocument();
    });
  });

  describe('3. One Goals workflow and three retained Progress tabs', () => {
    it('has one Goals tab plus Grow My SIP and Keep on Track', () => {
      render(<ProgressHub activeTab="goals" profile={mockProfile}
        financialState={null} recommendations={mockRecommendations} />);
      expect(screen.getAllByRole('tab')).toHaveLength(3);
      expect(screen.getByRole('tab', { name: 'Goals' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByTestId('panel-goals')).toBeInTheDocument();
      expect(screen.queryByTestId('panel-plan-goal')).toBeNull();
      expect(screen.queryByTestId('panel-indicators')).toBeNull();
    });
    it('preserves active-only rendering with existing rebalancer and SIP features', () => {
      const { rerender } = render(<ProgressHub activeTab="grow-sip" profile={mockProfile}
        recommendations={mockRecommendations} />);
      expect(screen.getByTestId('panel-grow-sip')).not.toHaveAttribute('hidden');
      expect(screen.getByTestId('panel-goals')).toHaveAttribute('hidden');
      rerender(<ProgressHub activeTab="rebalancer" profile={mockProfile} recommendations={mockRecommendations} />);
      expect(screen.getByTestId('panel-rebalancer')).not.toHaveAttribute('hidden');
      expect(screen.getByTestId('panel-goals')).toHaveAttribute('hidden');
    });
    it('retains wrapped keyboard-friendly Progress tabs', () => {
      const source = readFileSync(resolve(cwd(), 'src/components/HubStyles.css'), 'utf8');
      const rule = source.match(/\.hub-tabs-list\s*\{([^}]+)\}/)?.[1] || '';
      expect(rule).toMatch(/flex-wrap:\s*wrap/);
    });
  });

  describe('4. WhereToInvestScreen integrates Deep Dive', () => {
    it('renders category selector in exact backend recommendation order', () => {
      render(
        <WhereToInvestScreen
          recommendations={mockRecommendations}
          userProfile={mockProfile}
          onLearnMore={vi.fn()}
        />
      );

      expect(screen.getByTestId('wti-category-ppf')).toBeInTheDocument();
      expect(screen.getByTestId('wti-category-index_mf')).toBeInTheDocument();
    });

    it('describes the selected parent as a suitable category, not verified product execution', () => {
      render(
        <WhereToInvestScreen
          recommendations={mockRecommendations}
          userProfile={mockProfile}
          onLearnMore={vi.fn()}
        />
      );

      expect(screen.getByText('PROFILE-SUITABLE CATEGORIES · PRODUCTS VERIFIED SEPARATELY')).toBeInTheDocument();
      expect(screen.queryByText(/VERIFIED EXECUTION/i)).toBeNull();
    });

    it('exposes Deep Dive action bar and triggers onLearnMore with activeParent', () => {
      const onLearnMore = vi.fn();
      render(
        <WhereToInvestScreen
          recommendations={mockRecommendations}
          userProfile={mockProfile}
          onLearnMore={onLearnMore}
        />
      );

      expect(screen.getByTestId('wti-deep-dive-bar')).toBeInTheDocument();

      // Click "Full Deep Dive"
      fireEvent.click(screen.getByTestId('wti-open-deep-dive'));
      expect(onLearnMore).toHaveBeenCalledWith(mockRecommendations[0], 'Overview');

      // Click "Calculator"
      fireEvent.click(screen.getByTestId('wti-open-calc'));
      expect(onLearnMore).toHaveBeenCalledWith(mockRecommendations[0], 'Calculator');

      // Click "Tax Rules"
      fireEvent.click(screen.getByTestId('wti-open-tax'));
      expect(onLearnMore).toHaveBeenCalledWith(mockRecommendations[0], 'Tax');

      // Click "History"
      fireEvent.click(screen.getByTestId('wti-open-history'));
      expect(onLearnMore).toHaveBeenCalledWith(mockRecommendations[0], 'History');
    });
  });

  describe('5. DeepDiveModal preserves the six supported tabs and supports initialTab', () => {
    it('renders the supported tabs, omits the retired stress UI, and respects initialTab="Calculator"', () => {
      render(
        <DeepDiveModal
          isOpen={true}
          onClose={vi.fn()}
          investment={mockRecommendations[0]}
          onSelectInvestment={vi.fn()}
          allRecommendations={mockRecommendations}
          horizon={10}
          userProfile={mockProfile}
          initialTab="Calculator"
        />
      );

      const calcTab = screen.getByRole('tab', { name: /^calculator$/i });
      expect(calcTab).toBeInTheDocument();
      expect(calcTab.className).toContain('ddm-tab-btn--active');
      expect(screen.getByRole('tab', { name: /^overview$/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /^where to invest$/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /^tax$/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /^history$/i })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: /^why invest$/i })).toBeInTheDocument();
      expect(screen.queryByRole('tab', { name: /^stress test$/i })).not.toBeInTheDocument();
    });
  });

  describe('6. Sidebar exposes primary navigation and the GenieProof preview', () => {
    it('exposes primary and utility destinations without retired Advanced navigation', () => {
      render(
        <Sidebar
          activePage="home"
          onNavigate={vi.fn()}
          onLogout={vi.fn()}
        />
      );

      // Primary navigation items
      expect(screen.getByTestId('nav-home')).toBeInTheDocument();
      expect(screen.getByTestId('nav-plan')).toBeInTheDocument();
      expect(screen.getByTestId('nav-investments')).toBeInTheDocument();
      expect(screen.getByTestId('nav-taxes')).toBeInTheDocument();
      expect(screen.queryByTestId('nav-progress')).not.toBeInTheDocument();
      expect(screen.getByTestId('mobile-nav-progress')).toBeInTheDocument();
      for (const id of ['nav-my-goals', 'nav-grow-my-sip', 'nav-keep-on-track']) {
        expect(screen.getByTestId(id)).toBeInTheDocument();
      }
      expect(screen.getByText('WEALTH JOURNEY')).toBeInTheDocument();
      expect(screen.getByTestId('nav-profile')).toBeInTheDocument();
      expect(screen.getByTestId('nav-help')).toBeInTheDocument();
      expect(screen.queryByTestId('nav-advanced')).not.toBeInTheDocument();
      expect(screen.getByTestId('nav-genieproof')).toBeInTheDocument();
      expect(screen.getByTestId('nav-sign-out')).toBeInTheDocument();

      // Legacy test-ids
      expect(screen.getByTestId('nav-allocation')).toBeInTheDocument();
      expect(screen.getByTestId('nav-where-to-invest')).toBeInTheDocument();
      expect(screen.getByTestId('nav-tax-optimizer')).toBeInTheDocument();
      expect(screen.getByTestId('nav-post-tax')).toBeInTheDocument();
      expect(screen.getByTestId('nav-goal-planner')).toBeInTheDocument();
      expect(screen.getByTestId('nav-goals')).toBeInTheDocument();
      expect(screen.getByTestId('nav-rebalancer')).toBeInTheDocument();
      expect(screen.getByTestId('nav-sip-planner')).toBeInTheDocument();
      expect(screen.queryByTestId('nav-health')).not.toBeInTheDocument();
      expect(screen.getByTestId('nav-dashboard')).toBeInTheDocument();
    });

    it('navigates to each standalone desktop Wealth Journey page', () => {
      const onNavigate = vi.fn();
      const { rerender } = render(<Sidebar activePage={NAV_PAGES.GOALS} onNavigate={onNavigate} />);
      for (const [id, page] of [
        ['nav-my-goals', NAV_PAGES.GOALS],
        ['nav-grow-my-sip', NAV_PAGES.GROW_MY_SIP],
        ['nav-keep-on-track', NAV_PAGES.KEEP_ON_TRACK],
      ]) {
        fireEvent.click(screen.getByTestId(id));
        expect(onNavigate).toHaveBeenLastCalledWith(page);
        rerender(<Sidebar activePage={page} onNavigate={onNavigate} />);
        expect(screen.getByTestId(id)).toHaveAttribute('aria-current', 'page');
      }
    });
    it('navigates to visible GenieProof by default and preserves explicit opt-out', () => {
      const onNavigate = vi.fn();
      const { rerender } = render(<Sidebar activePage={NAV_PAGES.HOME} onNavigate={onNavigate} />);
      fireEvent.click(screen.getByTestId('nav-genieproof'));
      expect(onNavigate).toHaveBeenCalledWith(NAV_PAGES.GENIEPROOF);
      rerender(<Sidebar activePage={NAV_PAGES.HOME} onNavigate={onNavigate} genieProofEnabled={false} />);
      expect(screen.queryByTestId('nav-genieproof')).not.toBeInTheDocument();
    });

    it('keeps the user in the app and exposes retry when sign-out is not confirmed', async () => {
      const onLogout = vi.fn()
        .mockRejectedValueOnce(new Error('TOKEN_REVOCATION_UNAVAILABLE'))
        .mockResolvedValueOnce({ message: 'Logout successful.' });
      render(<Sidebar activePage={NAV_PAGES.HOME} onNavigate={vi.fn()} onLogout={onLogout} />);

      fireEvent.click(screen.getByTestId('nav-sign-out'));
      expect(await screen.findByRole('alert')).toHaveTextContent(/session may still be active/i);
      expect(screen.getByRole('button', { name: 'Retry sign-out' })).toBeInTheDocument();
      expect(screen.getByTestId('nav-home')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Retry sign-out' }));
      await waitFor(() => expect(onLogout).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    });
  });
});
