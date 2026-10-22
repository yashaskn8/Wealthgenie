import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { getFinancialUniverse, getFinancialUniverseSummary } = vi.hoisted(() => ({
  getFinancialUniverse: vi.fn(), getFinancialUniverseSummary: vi.fn(),
}));
vi.mock('../services/api', () => ({ getFinancialUniverse, getFinancialUniverseSummary }));
import InvestmentUniverseBrowser from './InvestmentUniverseBrowser';

const catalog = Array.from({ length: 250 }, (_, index) => ({
  id: 'family_' + String(index + 1).padStart(3, '0'),
  name: 'Investment family ' + (index + 1),
  category: index < 155 ? 'Existing catalog' : 'Expanded family',
  subcategory: 'Reference',
  record_kind: 'ARCHETYPE',
  availability: 'UNVERIFIED',
  recommendation_eligible: false,
}));

beforeEach(() => {
  getFinancialUniverseSummary.mockResolvedValue({status:'DISCOVERY_ONLY',totalCount:250,
    discoveryFamilies:250,actualProducts:0,availableRecords:0,unverifiedRecords:250,qualificationFlagged:0});
  getFinancialUniverse.mockImplementation(({ cursor }) => {
    const offset = cursor ? Number(cursor.slice('after_'.length)) : 0;
    const items = catalog.slice(offset, offset + 100);
    const next = offset + 100 < catalog.length ? 'after_' + (offset + 100) : null;
    return Promise.resolve({ items, nextCursor: next });
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('investment universe browser', () => {
  it('loads all 250 PostgreSQL pages separately from recommendations', async () => {
    render(<InvestmentUniverseBrowser />);
    expect(getFinancialUniverse).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Browse all investment options' }));
    await waitFor(() => expect(screen.getByText('250 catalog entries loaded from PostgreSQL.')).toBeTruthy());
    expect(getFinancialUniverse).toHaveBeenCalledTimes(3);
    expect(getFinancialUniverseSummary).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Database total: 250/)).toBeTruthy();
    expect(screen.getByText(/250 matching catalog entries/)).toBeTruthy();
    expect(screen.getByText('Investment family 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Investment family 26')).toBeTruthy();
  });

  it('filters categories and never claims discovery entries are recommendations', async () => {
    render(<InvestmentUniverseBrowser />);
    fireEvent.click(screen.getByRole('button', { name: 'Browse all investment options' }));
    await waitFor(() => expect(screen.getByText('250 catalog entries loaded from PostgreSQL.')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Filter investment category'), { target: { value: 'Expanded family' } });
    expect(screen.getByText(/95 matching catalog entries/)).toBeTruthy();
    expect(screen.getAllByText('Discovery family').length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('Filter investment subcategory'), {target:{value:'Reference'}});
    expect(screen.getByText(/95 matching catalog entries/)).toBeTruthy();
  });

  it('detects a missing database page rather than claiming full catalog coverage', async () => {
    getFinancialUniverseSummary.mockResolvedValueOnce({totalCount:251});
    render(<InvestmentUniverseBrowser />);
    fireEvent.click(screen.getByRole('button', { name: 'Browse all investment options' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Unable to load'));
    expect(screen.queryByText('250 catalog entries loaded from PostgreSQL.')).toBeNull();
  });

  it('shows a visible service failure instead of fabricated 250 options', async () => {
    getFinancialUniverse.mockRejectedValueOnce(new Error('FINANCIAL_UNIVERSE_NOT_ENABLED'));
    render(<InvestmentUniverseBrowser />);
    fireEvent.click(screen.getByRole('button', { name: 'Browse all investment options' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Unable to load'));
    expect(screen.queryByText('250 catalog entries loaded from PostgreSQL.')).toBeNull();
  });
});
