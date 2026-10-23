import React from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cwd } from 'node:process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import GenieChat from '../GenieChat';
import NewRegimeTaxScreen from '../NewRegimeTaxScreen';
import * as api from '../../services/api';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const chatSource = () => readFileSync(resolve(cwd(), 'src/components/GenieChat.jsx'), 'utf8');

describe('GenieChat tax-mode retirement safety', () => {
  it('does not contain old-vs-new tax calculation or recommendation code', () => {
    const source = chatSource();
    for (const oldOfNew of [
      'api.compareTax(', 'Old Tax System', 'taxComparison',
      'optimized_old_regime_tax', 'oldRegimeDeductions', 'setTaxComparison',
    ]) {
      expect(source).not.toContain(oldOfNew);
    }
    expect(source).toContain("'/tax': 'taxes'");
    expect(source).toContain("'/tax-optimizer': 'taxes'");
    expect(source).not.toContain("['rebalancer', 'sip-planner', 'taxes'].includes(page)");
  });

  it('renders the assistant without activating the retired tax comparison provider', () => {
    const compare = vi.spyOn(api, 'compareTax').mockRejectedValue(new Error('Retired'));
    const policy = vi.spyOn(api, 'getTaxPolicyMetadata').mockResolvedValue({});
    render(<GenieChat onNavigate={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Genie AI' })).toBeInTheDocument();
    expect(compare).not.toHaveBeenCalled();
    expect(policy).not.toHaveBeenCalled();
    expect(screen.queryByText(/old tax system/i)).not.toBeInTheDocument();
  });

  it('opens a chat without exposing retired old-regime controls or comparison tables', () => {
    const compare = vi.spyOn(api, 'compareTax').mockRejectedValue(new Error('Retired'));
    render(<GenieChat onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Genie AI' }));
    expect(screen.queryByRole('button', { name: /old regime/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Old Tax System')).not.toBeInTheDocument();
    expect(compare).not.toHaveBeenCalled();
  });

  it('verified Taxes calculator requires user facts and never shows an old-regime choice', () => {
    const compare = vi.spyOn(api, 'compareTax').mockRejectedValue(new Error('Retired'));
    const verified = vi.spyOn(api, 'computeVerifiedNewRegimeTax').mockResolvedValue({});
    render(<NewRegimeTaxScreen />);
    expect(screen.getByRole('heading', { name: 'Income Tax Calculator' })).toBeInTheDocument();
    expect(screen.queryByText('Old Regime')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Old Regime/i })).not.toBeInTheDocument();
    expect(verified).not.toHaveBeenCalled();
    expect(compare).not.toHaveBeenCalled();
  });
});
