import React, { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import TaxesHub from '../TaxesHub';

vi.mock('../NewRegimeTaxScreen', () => ({
  default: () => <div>Tax regime controls</div>,
}));
vi.mock('../VerifiedCapitalGainsTaxScreen', () => ({
  default: () => <div>Advanced equity-gains controls</div>,
}));
vi.mock('../../PostTaxAnalysis', () => ({
  default: () => <div>After-tax return controls</div>,
}));

function ControlledTaxesHub() {
  const [activeTab, setActiveTab] = useState('regime-savings');
  return <TaxesHub activeTab={activeTab} onTabChange={setActiveTab} />;
}

describe('TaxesHub accessible keyboard navigation', () => {
  it('uses a single reachable tab and arrow keys focus and activate the correct panel', () => {
    render(<ControlledTaxesHub />);
    const tabs = within(screen.getByRole('tablist', { name: 'Tax views' }));
    const regime = tabs.getByRole('tab', { name: /New Regime Tax/i });
    const returns = tabs.getByRole('tab', { name: /Real Returns on Investments/i });
    expect(regime).toHaveAttribute('tabindex', '0');
    expect(returns).toHaveAttribute('tabindex', '-1');
    expect(screen.getByText('Tax regime controls')).toBeInTheDocument();
    expect(screen.queryByText('After-tax return controls')).not.toBeInTheDocument();

    regime.focus();
    fireEvent.keyDown(regime, { key: 'ArrowRight' });
    expect(returns).toHaveFocus();
    expect(returns).toHaveAttribute('aria-selected', 'true');
    expect(returns).toHaveAttribute('tabindex', '0');
    expect(screen.getByText('After-tax return controls')).toBeInTheDocument();
    expect(screen.queryByText('Tax regime controls')).not.toBeInTheDocument();

    fireEvent.keyDown(returns, { key: 'Home' });
    expect(regime).toHaveFocus();
    expect(regime).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(regime, { key: 'End' });
    expect(returns).toHaveFocus();
    fireEvent.keyDown(returns, { key: 'ArrowRight' });
    expect(regime).toHaveFocus();
  });
});

describe('TaxesHub complex tax mode safety', () => {
  it('preserves default ordinary calculator and exposes advanced gains only on user selection', () => {
    render(<ControlledTaxesHub />);
    expect(screen.getByText('Tax regime controls')).toBeInTheDocument();
    expect(screen.queryByText('Advanced equity-gains controls')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Advanced Equity Capital Gains' }));
    expect(screen.queryByText('Tax regime controls')).not.toBeInTheDocument();
    expect(screen.getByText('Advanced equity-gains controls')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Simple Ordinary Income' }));
    expect(screen.getByText('Tax regime controls')).toBeInTheDocument();
    expect(screen.queryByText('Advanced equity-gains controls')).not.toBeInTheDocument();
  });
});
