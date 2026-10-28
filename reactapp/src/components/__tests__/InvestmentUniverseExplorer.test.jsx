import React from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getCurrentProfile: vi.fn(),
  getFinancialUniverse: vi.fn(),
  getFinancialUniverseSummary: vi.fn(),
  getQualifiedFamilyTopProducts: vi.fn(),
  getThreeProductReadyFamilies: vi.fn(),
}));
vi.mock('../../services/api', () => api);

const families = Array.from({ length: 250 }, (_, index) => ({
  id: 'family_' + String(index + 1).padStart(3, '0'),
  name: 'Investment family ' + (index + 1),
  record_kind: 'ARCHETYPE',
  category: index < 155 ? 'Legacy category' : 'Expanded category',
  subcategory: 'Reference',
  availability: 'UNVERIFIED',
}));

let InvestmentUniverseExplorer;
beforeAll(async () => {
  vi.stubEnv('VITE_FINANCIAL_POSTGRES_ENABLED', 'true');
  ({ default: InvestmentUniverseExplorer } = await import('../InvestmentUniverseExplorer.jsx'));
});
afterAll(() => vi.unstubAllEnvs());
beforeEach(() => {
  api.getFinancialUniverseSummary.mockResolvedValue({ status: 'DISCOVERY_ONLY', totalCount: 250 });
  api.getThreeProductReadyFamilies.mockResolvedValue({
    status: 'TWO_OR_MORE_SOURCE_QUALIFIED_CANDIDATES', familyIds: ['family_001'], count: 1,
  });
  api.getCurrentProfile.mockResolvedValue({ profileId: '0123456789abcdef01234567' });
  api.getFinancialUniverse.mockImplementation(({ cursor }) => {
    const index = cursor ? Number(cursor.slice('family_'.length)) : 0;
    const items = families.slice(index, index + 100);
    return Promise.resolve({
      items,
      nextCursor: index + 100 < families.length ? items[items.length - 1].id : null,
    });
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('250-family Where to Invest directory', () => {
  it('loads every PostgreSQL family, including 95 unqualified discovery extensions', async () => {
    render(<InvestmentUniverseExplorer />);
    await waitFor(() => expect(screen.getByText(/250 investment options loaded from PostgreSQL/)).toBeTruthy());
    expect(api.getFinancialUniverse).toHaveBeenCalledTimes(3);
    expect(screen.getByText('Investment family 250')).toBeTruthy();
    expect(screen.getByText('Investment family 1')).toBeTruthy();
    expect(screen.getByText('250 matching options')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search all 250 investment options'), {
      target: { value: 'Investment family 250' },
    });
    expect(screen.getByText('1 matching options')).toBeTruthy();
    expect(screen.getByText('Investment family 250')).toBeTruthy();
  });

  it('does not invent three products when source-qualification is missing', async () => {
    render(<InvestmentUniverseExplorer />);
    await waitFor(() => expect(screen.getByText('Investment family 2')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Check tailored top 3 for Investment family 2' }));
    expect(screen.getByText(/Two distinct, current, suitable products cannot yet be verified/)).toBeTruthy();
    expect(api.getQualifiedFamilyTopProducts).not.toHaveBeenCalled();
    expect(api.getCurrentProfile).not.toHaveBeenCalled();
    const familyRow = screen.getByText('Investment family 2').closest('li');
    expect(within(familyRow).getByRole('region', { name: 'Tailored top three for Investment family 2' })).toBeTruthy();
    expect(within(familyRow).getByRole('button', { name: 'Check tailored top 3 for Investment family 2' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('loads exactly three individually source-qualified products for the current profile', async () => {
    api.getQualifiedFamilyTopProducts.mockResolvedValue({
      status: 'AVAILABLE',
      products: Array.from({ length: 3 }, (_, index) => ({
        id: 'product_' + index,
        name: 'Issuer ' + (index + 1),
        riskLevel: 1, annualFeeBps: index,
        lockInMonths: 0, verifiedTaxClass: 'ORDINARY_INTEREST',
        marketFact: {
          type: 'PUBLISHED_RATE', value: String(6.5 - index / 10),
          unit: 'PCT_PER_ANNUM', dataClass: 'PUBLISHED_RATE',
          sourceId: 'verified_source', observationId: String(index + 1),
        },
        evidence: { product: 'https://issuer.example/evidence/' + index },
      })),
    });
    render(<InvestmentUniverseExplorer />);
    await waitFor(() => expect(screen.getByText('Investment family 1')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Check tailored top 3 for Investment family 1' }));
    await waitFor(() => expect(screen.getByText('Issuer 1')).toBeTruthy());
    expect(api.getQualifiedFamilyTopProducts).toHaveBeenCalledWith(
      'family_001', '0123456789abcdef01234567', expect.any(Object),
    );
    const familyRow = screen.getByText('Investment family 1').closest('li');
    const comparisonPanel = within(familyRow).getByRole('region', { name: 'Tailored top three for Investment family 1' });
    expect(within(comparisonPanel).getAllByRole('link', { name: 'Issuer evidence' })).toHaveLength(3);
    expect(screen.getAllByRole('link', { name: 'Issuer evidence' })).toHaveLength(3);
    expect(screen.getAllByText(/Personalized post-tax return: not calculated by this comparison/)).toHaveLength(3);
    expect(comparisonPanel.textContent).not.toContain('Match:');
  });

  it('renders two verified products without inventing a third', async () => {
    api.getQualifiedFamilyTopProducts.mockResolvedValue({
      status: 'AVAILABLE',
      products: [1, 2].map(index => ({
        id: 'bond_' + index, name: 'Verified bond ' + index,
        riskLevel: 2, annualFeeBps: 0, lockInMonths: 0,
        verifiedTaxClass: 'ORDINARY_INTEREST',
        marketFact: { type: 'PRICE', value: 100 + index,
          unit: 'INR', dataClass: 'END_OF_DAY',
          sourceId: 'verified_source', observationId: String(index) },
        evidence: { product: 'https://issuer.example/bond/' + index },
      })),
    });
    render(<InvestmentUniverseExplorer />);
    await waitFor(() => expect(screen.getByText('Investment family 1')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Check tailored top 3 for Investment family 1' }));
    await waitFor(() => expect(screen.getByText('Verified bond 1')).toBeTruthy());
    expect(screen.getAllByRole('link', { name: 'Issuer evidence' })).toHaveLength(2);
    expect(screen.getByText(/2 independently checked products/)).toBeTruthy();
  });

  it('rejects partial product lists instead of padding the comparison', async () => {
    api.getQualifiedFamilyTopProducts.mockResolvedValue({
      status: 'AVAILABLE', products: [{ id: 'product_1', name: 'Unverified comparison entry' }],
    });
    render(<InvestmentUniverseExplorer />);
    await waitFor(() => expect(screen.getByText('Investment family 1')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Check tailored top 3 for Investment family 1' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent)
      .toContain('CURRENT_PROFILE_OR_QUALIFIED_COMPARISON_UNAVAILABLE'));
    expect(screen.queryByText('Unverified comparison entry')).toBeNull();
  });

  it('rejects a missing market value instead of rendering it as zero', async () => {
    api.getQualifiedFamilyTopProducts.mockResolvedValue({
      status: 'AVAILABLE',
      products: Array.from({ length: 3 }, (_, index) => ({
        id: 'product_' + index,
        name: 'Issuer ' + (index + 1),
        marketFact: {
          sourceId: 'verified_source', observationId: String(index + 1),
          value: index === 0 ? null : '6.5',
        },
        evidence: { product: 'https://issuer.example/evidence/' + index },
      })),
    });
    render(<InvestmentUniverseExplorer />);
    await waitFor(() => expect(screen.getByText('Investment family 1')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Check tailored top 3 for Investment family 1' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent)
      .toContain('CURRENT_PROFILE_OR_QUALIFIED_COMPARISON_UNAVAILABLE'));
    expect(screen.queryByText('Issuer 1')).toBeNull();
  });

  it('clears a prior personalized comparison when the directory is closed', async () => {
    api.getQualifiedFamilyTopProducts.mockResolvedValue({
      status: 'AVAILABLE',
      products: Array.from({ length: 3 }, (_, index) => ({
        id: 'product_' + index,
        name: 'Issuer ' + (index + 1),
        marketFact: { sourceId: 'verified_source', observationId: String(index + 1), value: 1 },
        evidence: { product: 'https://issuer.example/evidence/' + index },
      })),
    });
    render(<InvestmentUniverseExplorer />);
    await waitFor(() => expect(screen.getByText('Investment family 1')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Check tailored top 3 for Investment family 1' }));
    await waitFor(() => expect(screen.getByText('Issuer 1')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Hide all 250 investment options' }));
    expect(screen.queryByText('Issuer 1')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Explore all 250 investment options' }));
    await waitFor(() => expect(screen.getByText('Investment family 1')).toBeTruthy());
    expect(screen.queryByText('Issuer 1')).toBeNull();
  });

  it('fails closed for inconsistent catalog totals rather than showing fewer than 250 as complete', async () => {
    api.getFinancialUniverseSummary.mockResolvedValueOnce({ totalCount: 249 });
    render(<InvestmentUniverseExplorer />);
    await waitFor(() => expect(screen.getByRole('alert').textContent)
      .toContain('complete 250-family PostgreSQL directory is unavailable'));
    expect(screen.queryByText('Investment family 1')).toBeNull();
  });
});
