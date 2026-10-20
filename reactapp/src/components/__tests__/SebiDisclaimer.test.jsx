/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { render, screen, within, cleanup } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import SebiDisclaimer from '../SebiDisclaimer';
import WhereToInvestTab from '../deepdive/WhereToInvestTab';
import * as api from '../../services/api';
import { resetMarketContextStoreForTest } from '../../state/useMarketContext';

const { CURRENT_STATE_BINDING, CURRENT_RECOMMENDATION_META } = vi.hoisted(() => {
  const binding = {
    profileId: '64b000000000000000000001', profileVersion: 4,
    recommendationId: '64b000000000000000000002', allocationRevision: 3,
    allocationRevisionId: '64b000000000000000000003',
    portfolioFingerprint: 'a'.repeat(64), recommendationFingerprint: 'b'.repeat(64),
  };
  return {
    CURRENT_STATE_BINDING: binding,
    CURRENT_RECOMMENDATION_META: {
      recommendationId: binding.recommendationId,
      profile_version: binding.profileVersion,
      allocation_revision: binding.allocationRevision,
      allocation_revision_id: binding.allocationRevisionId,
      portfolio_fingerprint: binding.portfolioFingerprint,
      recommendation_fingerprint: binding.recommendationFingerprint,
    },
  };
});

vi.mock('../../services/api', () => ({
  getPrivateMarketDemoData: vi.fn(() => new Promise(() => {})),
  rankInvestmentCandidates: vi.fn(async (_profileId, _parentId, _taxContext, _options, financialStateBinding) => ({
    financialStateBinding,
    products: Array.from({ length: 2 }, (_, index) => ({
      id: `mf:amfi:${index + 1}`,
      name: `Verified Fund ${index + 1}`,
      productType: 'MUTUAL_FUND',
      provider: `Verified AMC ${index + 1}`,
      source: { provider: 'AMFI', instrumentId: String(index + 1) },
      nav: { value: 12.34 + index },
      valuationDate: '2026-09-07',
      freshness: { status: 'FRESH' },
      plan: index === 0 ? 'Direct Plan' : null,
      option: 'Growth Option',
      presentationStatus: 'VERIFIED_COMPARABLE_OPTION',
      nominalReturn: null,
      riskLevel: null,
    })),
    catalog: { dataClass: 'REFERENCE_METADATA', note: 'Reference text only.' },
    ranking: { status: 'VERIFIED_COMPARABLE_OPTIONS', authority: 'VERIFIED_AMFI_CURRENT_NAV_ONLY', warning: 'Display order is not a ranking.' },
    comparisonUniverse: {
      disclosure: 'Verified AMFI category products.',
      verifiedCategoryProductCount: 8,
      freshNavProductCount: 7,
      sourceEstablishedDirectPlanProductCount: 2,
      historicalEvidenceProductCount: 0,
    },
  })),
  getCurrentMarketContext: vi.fn(async () => ({
    status: 'MARKET_CONTEXT_UNAVAILABLE',
    context: null,
    classification: 'DETERMINISTIC_POLICY_HEURISTIC',
    policyVersion: 'market-context-policy-1.0.0',
    confidence: null,
    reasonCodes: ['PROVIDER_NOT_CONFIGURED'],
    signals: {},
    sources: [],
  })),
  previewMarketContextAdjustment: vi.fn(async () => ({ applied: false, explanations: [] })),
  getTaxPolicyMetadata: vi.fn(async () => ({
    currentFiscalYear: 'FY2026-27',
    currentFiscalYearVerified: true,
    verifiedFiscalYears: ['FY2025-26', 'FY2026-27'],
  })),
}));

function renderWti(element) {
  return render(React.cloneElement(element, {
    recommendationMeta: CURRENT_RECOMMENDATION_META,
    ...element.props,
  }));
}

describe('SebiDisclaimer Component', () => {
  afterEach(() => {
    cleanup();
    resetMarketContextStoreForTest();
  });

  it('renders regulatory disclaimer text', () => {
    render(<SebiDisclaimer />);
    const matches = screen.getAllByText(/Not SEBI-registered investment advice/i);
    expect(matches.length).toBeGreaterThan(0);
    expect(screen.getByText(/Mutual fund investments are subject to market risk/i)).toBeTruthy();
  });

  it('renders verified comparable options without presenting their display order as a ranking', async () => {
    const mockInv = { id: 'mid_cap_stocks', name: 'Mid Cap Growth Stocks', riskLevel: 5 };
    renderWti(<WhereToInvestTab inv={mockInv} userProfile={{ profileId: '64b000000000000000000001' }} />);
    const matches = screen.getAllByText(/Not SEBI-registered investment advice/i);
    expect(matches.length).toBeGreaterThan(0);
    expect(await screen.findByText(/Verified Products \(2 Comparable Options\)/i)).toBeTruthy();
    expect(await screen.findByText('Verified Fund 2')).toBeTruthy();
    expect((await screen.findAllByText('Verified comparable option')).length).toBe(2);
    expect(screen.getByText('Plan: UNAVAILABLE')).toBeTruthy();
    expect(screen.getByTestId('wti-comparison-universe')).toBeTruthy();
    expect(screen.queryByText('Top Pick')).toBeNull();
    expect(await screen.findByText('Market data unavailable', { selector: '.wti-beginner-market-badge' })).toBeTruthy();
    expect(screen.getByTestId('market-data-status')).toHaveTextContent(/Market data unavailable/i);
    expect(screen.getByText(/PROVIDER_NOT_CONFIGURED/)).toBeTruthy();
  });

  it('renders normalized NSE provenance, update class, timestamp, and freshness from the backend', async () => {
    api.getCurrentMarketContext.mockResolvedValueOnce({
      status: 'MARKET_CONTEXT_AVAILABLE',
      context: 'NORMAL',
      classification: 'DETERMINISTIC_POLICY_HEURISTIC',
      policyVersion: 'market-context-policy-1.0.0',
      confidence: null,
      observedAt: '2026-09-08T10:00:00.000Z',
      evaluatedAt: '2026-09-08T10:01:00.000Z',
      freshness: { status: 'FRESH' },
      reasonCodes: ['NO_CAUTION_OR_RISK_OFF_POLICY_THRESHOLD_MET'],
      signals: {
        nifty50Current: { value: 23635.1, unit: 'INDEX_POINTS', available: true },
      },
      sources: [{
        provider: 'NSE', instrumentId: 'NIFTY 50', dataClass: 'LIVE',
        observedAt: '2026-09-08T10:00:00.000Z',
        fetchedAt: '2026-09-08T10:00:30.000Z',
        freshness: { status: 'FRESH' },
      }],
    });
    renderWti(<WhereToInvestTab inv={{ id: 'mid_cap_stocks', name: 'Mid Cap Growth Stocks', riskLevel: 5 }} userProfile={{ profileId: '64b000000000000000000001' }} />);
    expect(await screen.findByText('NORMAL')).toBeTruthy();
    const sourceEvidence = screen.getByText(/NSE \(NIFTY 50 · LIVE\)/);
    expect(sourceEvidence).toBeTruthy();
    expect(screen.getByText(/Observed: 2026-09-08T10:00:00.000Z/)).toBeTruthy();
    const contextPanel = sourceEvidence.closest('[data-testid="market-context-panel"]');
    expect(contextPanel).toBeTruthy();
    expect(within(contextPanel).getByText(/Freshness: FRESH/)).toBeTruthy();
  });

  it('labels the unique historical-return leader precisely without calling it a Top Pick', async () => {
    api.rankInvestmentCandidates.mockResolvedValueOnce({
      financialStateBinding: CURRENT_STATE_BINDING,
      products: [
        {
          id: 'mf:amfi:101', name: 'Evidence Leader', provider: 'Verified AMC',
          source: { provider: 'AMFI', instrumentId: '101' }, nav: { value: 25 },
          valuationDate: '2026-09-07', freshness: { status: 'FRESH' },
          plan: 'Direct Plan', option: 'Growth Option',
          presentationStatus: 'VERIFIED_RANKED_PRODUCT', rank: 1, tiedRank: false,
          historicalReturn: { valuePct: 18.25 },
        },
        {
          id: 'mf:amfi:102', name: 'Evidence Runner Up', provider: 'Verified AMC',
          source: { provider: 'AMFI', instrumentId: '102' }, nav: { value: 20 },
          valuationDate: '2026-09-07', freshness: { status: 'FRESH' },
          plan: 'Direct Plan', option: 'Growth Option',
          presentationStatus: 'VERIFIED_RANKED_PRODUCT', rank: 2, tiedRank: false,
          historicalReturn: { valuePct: 12.5 },
        },
      ],
      ranking: { status: 'EVIDENCE_RANKED', hasUniqueLeader: true, warning: 'Historical return is not expected return.' },
      comparisonUniverse: {
        disclosure: 'Ranked within exact AMFI category.',
        verifiedCategoryProductCount: 2,
        freshNavProductCount: 2,
        sourceEstablishedDirectPlanProductCount: 2,
        historicalEvidenceProductCount: 2,
      },
    });
    renderWti(<WhereToInvestTab inv={{ id: 'large_cap_mf', riskLevel: 3 }} userProfile={{ profileId: '64b000000000000000000001' }} />);
    expect(await screen.findByText(/Verified Products \(2 Ranked Options\)/i)).toBeTruthy();
    expect((await screen.findAllByText('VERIFIED RANKED PRODUCT')).length).toBe(2);
    expect(screen.getByText('18.25% historical')).toBeTruthy();
    expect(screen.getByText('Rank #1 by 1Y Historical NAV Return')).toBeTruthy();
    expect(screen.queryByText(/Top Pick/i)).toBeNull();
  });
});
