/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import axe from 'axe-core';

import TaxScreen from '../components/TaxScreen';
import NewRegimeTaxScreen from '../components/NewRegimeTaxScreen';
import AllocationPlanner from '../components/AllocationPlanner';
import RebalancerScreen from '../components/RebalancerScreen';
import GenieChat from '../components/GenieChat';
import DeepDiveModal from '../components/DeepDiveModal';

afterEach(() => {
  cleanup();
});

const mockProfile = {
  age: 30,
  monthly_take_home: 100000,
  monthly_savings: 30000,
  risk_tolerance: 'Moderate',
  sold_property_proceeds: 0,
  has_lump_sum: false,
  lump_sum_amount: 0,
  liquid_savings: 200000,
  emi_burden_pct: 10,
  financial_dependents: 1,
  emergency_fund_months: 6,
  investment_goals: ['Emergency Fund', 'Wealth Growth', 'Retirement'],
  investment_horizon_years: 15,
};

const mockRecs = [
  {
    id: '1', name: 'Nifty 50 Index Fund', assetClass: 'Equity', type: 'Index_MF',
    nominalReturn: 12, monthly_allocation: 15000, allocationWeight: 0.5,
    riskLabel: 'Medium', returnBasis: 'PRE_TAX_NOMINAL', description: 'Large cap equity index',
  },
  {
    id: '2', name: 'HDFC Liquid Fund', assetClass: 'Debt', type: 'Liquid_MF',
    nominalReturn: 6.5, monthly_allocation: 15000, allocationWeight: 0.5,
    riskLabel: 'Low', returnBasis: 'PRE_TAX_NOMINAL', description: 'Liquid debt fund',
  },
];

describe('Automated Accessibility (a11y) Verification Suite with axe-core', () => {
  it('checks TaxScreen for accessibility violations', async () => {
    const { container } = render(<TaxScreen profile={mockProfile} recommendations={mockRecs} />);
    const results = await axe.run(container, {
      rules: {
        // In JSDOM, color-contrast calculations are incomplete due to lack of real layout engine
        'color-contrast': { enabled: false }
      }
    });
    console.warn(`[A11Y AUDIT] TaxScreen violations: ${results.violations.length}`);
    if (results.violations.length > 0) {
      console.warn(JSON.stringify(results.violations.map(v => ({ id: v.id, impact: v.impact, description: v.description, help: v.help })), null, 2));
    }
    expect(results.violations).toEqual([]);
  });

  it('checks the mounted new-regime calculator for accessibility violations', async () => {
    const { container } = render(<NewRegimeTaxScreen />);
    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(results.violations.map(violation => ({
      id: violation.id, description: violation.description,
    }))).toEqual([]);
  });

  it('checks AllocationPlanner for accessibility violations', async () => {
    const { container } = render(<AllocationPlanner profile={mockProfile} recommendations={mockRecs} />);
    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } }
    });
    console.warn(`[A11Y AUDIT] AllocationPlanner violations: ${results.violations.length}`);
    if (results.violations.length > 0) {
      console.warn(JSON.stringify(results.violations.map(v => ({ id: v.id, impact: v.impact, description: v.description, help: v.help })), null, 2));
    }
    expect(results.violations).toEqual([]);
  });

  it('checks RebalancerScreen for accessibility violations', async () => {
    const { container } = render(<RebalancerScreen profile={mockProfile} recommendations={mockRecs} />);
    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } }
    });
    console.warn(`[A11Y AUDIT] RebalancerScreen violations: ${results.violations.length}`);
    if (results.violations.length > 0) {
      console.warn(JSON.stringify(results.violations.map(v => ({ id: v.id, impact: v.impact, description: v.description, help: v.help })), null, 2));
    }
    expect(results.violations).toEqual([]);
  });

  it('checks GenieChat for accessibility violations', async () => {
    const { container } = render(<GenieChat profile={mockProfile} />);
    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } }
    });
    console.warn(`[A11Y AUDIT] GenieChat violations: ${results.violations.length}`);
    if (results.violations.length > 0) {
      console.warn(JSON.stringify(results.violations.map(v => ({ id: v.id, impact: v.impact, description: v.description, help: v.help })), null, 2));
    }
    expect(results.violations).toEqual([]);
  });

  it('checks DeepDiveModal for accessibility violations', async () => {
    const { container } = render(
      <DeepDiveModal
        isOpen={true}
        onClose={() => {}}
        investment={mockRecs[0]}
        allRecommendations={mockRecs}
        horizon={15}
        userProfile={mockProfile}
      />
    );
    const results = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } }
    });
    console.warn(`[A11Y AUDIT] DeepDiveModal violations: ${results.violations.length}`);
    if (results.violations.length > 0) {
      console.warn(JSON.stringify(results.violations.map(v => ({ id: v.id, impact: v.impact, description: v.description, help: v.help })), null, 2));
    }
    expect(results.violations).toEqual([]);
  });
});
