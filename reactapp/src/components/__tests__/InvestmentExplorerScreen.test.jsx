import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import InvestmentExplorerScreen from '../InvestmentExplorerScreen';

const { getInvestmentExplorerCatalog, getInvestmentExplorerTaxonomy } = vi.hoisted(() => ({
  getInvestmentExplorerCatalog: vi.fn(),
  getInvestmentExplorerTaxonomy: vi.fn(),
}));

vi.mock('../../services/api', () => ({
  getInvestmentExplorerCatalog,
  getInvestmentExplorerTaxonomy,
}));

const taxonomyFixture = {
  categories: [
    {
      id: 'bank-savings-and-deposits',
      name: 'Bank deposits and savings',
      currentProductFamilyCount: 1,
      coverageNote: 'Issuer and current terms are unverified.',
      sourceLinks: [{ name: 'Issuer terms', url: 'https://example.test/terms', rightsStatus: 'DISPLAY_PERMISSION_UNVERIFIED' }],
      subcategories: [
        { id: 'fixed-deposits-cumulative', name: 'Fixed deposits — cumulative' },
        { id: 'fixed-deposits-non-cumulative', name: 'Fixed deposits — non-cumulative' },
      ],
    },
    {
      id: 'government-and-post-office-savings',
      name: 'Government and post-office savings',
      currentProductFamilyCount: 1,
      coverageNote: 'Open and closed schemes are not yet qualified.',
      sourceLinks: [{ name: 'Government source', url: 'https://example.test/government', rightsStatus: 'REUSE_PERMISSION_UNVERIFIED' }],
      subcategories: [
        { id: 'post-office-recurring-deposit', name: 'Post Office Recurring Deposit' },
        { id: 'public-provident-fund-ppf', name: 'Public Provident Fund (PPF)' },
      ],
    },
  ],
};

const familyFixture = {
  id: 'legacy-family:po_rd',
  legacyCatalogId: 'po_rd',
  name: 'Post Office Recurring Deposit',
  legacyCategory: 'Government',
  assetClassLabel: 'Cash',
  catalogLevel: 'PRODUCT_FAMILY',
  categoryId: 'government-and-post-office-savings',
  subcategoryId: 'post-office-recurring-deposit',
  subcategoryName: 'Post Office Recurring Deposit',
  classificationStatus: 'FAMILY_CLASSIFICATION_ONLY',
  lifecycleStatus: 'NOT_VERIFIED',
  source: { provider: 'WEALTHGENIE_LEGACY_FAMILY_CATALOG', catalogVersion: '1.1.0', lastCatalogGenerationAt: '2026-08-06T18:31:00.008Z' },
  currentFacts: {
    price: { status: 'NOT_LOADED', value: null },
    nav: { status: 'NOT_LOADED', value: null },
    rate: { status: 'NOT_LOADED', value: null },
    historicalPerformance: { status: 'NOT_LOADED', value: null },
    fees: { status: 'NOT_LOADED', value: null },
    taxTreatment: { status: 'NOT_VERIFIED', value: null },
    eligibility: { status: 'NOT_VERIFIED', value: null },
    liquidity: { status: 'NOT_VERIFIED', value: null },
  },
};

const catalogFixture = products => ({
  catalog: { totalFamilyRecords: 2 },
  pagination: { page: 1, pageSize: 24, total: products.length, pages: 1 },
  products,
});

afterEach(cleanup);

describe('InvestmentExplorerScreen', () => {
  beforeEach(() => {
    getInvestmentExplorerTaxonomy.mockReset().mockResolvedValue(taxonomyFixture);
    getInvestmentExplorerCatalog.mockReset().mockResolvedValue(catalogFixture([familyFixture]));
  });

  it('shows all categories and named options separately from the recommendation screen', async () => {
    render(<InvestmentExplorerScreen />);

    expect(await screen.findByRole('heading', { name: 'Browse every investment option' })).toBeInTheDocument();
    expect(screen.getAllByTestId('investment-universe-category')).toHaveLength(2);
    expect(screen.getByText('4 options')).toBeInTheDocument();
    expect(screen.getByText(/separate from the profile-based/i)).toBeInTheDocument();
    expect(screen.getByText(/remain unavailable until an exact product and its source permissions are qualified/i)).toBeInTheDocument();
  });

  it('selects a named option and requests only its explicitly mapped family', async () => {
    getInvestmentExplorerCatalog.mockImplementation(async filters => (
      filters.subcategoryId === 'post-office-recurring-deposit'
        ? catalogFixture([familyFixture])
        : catalogFixture([])
    ));
    render(<InvestmentExplorerScreen />);

    await screen.findByRole('heading', { name: 'Browse every investment option' });
    const summary = screen.getByText('Government and post-office savings').closest('summary');
    fireEvent.click(summary);
    fireEvent.click(screen.getByRole('button', { name: 'Post Office Recurring Deposit' }));

    await waitFor(() => expect(getInvestmentExplorerCatalog).toHaveBeenLastCalledWith(
      expect.objectContaining({
        categoryId: 'government-and-post-office-savings',
        subcategoryId: 'post-office-recurring-deposit',
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
    expect(await screen.findByTestId('investment-family-card')).toHaveTextContent('Post Office Recurring Deposit');
    expect(screen.getByText('Not loaded')).toBeInTheDocument();
  });

  it('shows at most five current plan options per risk group in backend order without padding', async () => {
    const recommendations = Array.from({ length: 6 }, (_, index) => ({
      id: `saved-option-${index + 1}`,
      name: `Saved option ${index + 1}`,
      risk: 2,
      riskLabel: 'Low Risk',
      allocation_pct: 10,
    }));
    render(<InvestmentExplorerScreen
      recommendations={recommendations}
      recommendationMeta={{ recommendationId: 'current-recommendation' }}
    />);

    const recommendationsPanel = screen.getByTestId('top-investments-screen');
    await screen.findByText('Saved option 1');
    expect(within(recommendationsPanel).getAllByRole('article')).toHaveLength(5);
    expect(within(recommendationsPanel).getByText('Saved option 1')).toBeInTheDocument();
    expect(within(recommendationsPanel).getByText('Saved option 5')).toBeInTheDocument();
    expect(within(recommendationsPanel).queryByText('Saved option 6')).toBeNull();
  });
});
