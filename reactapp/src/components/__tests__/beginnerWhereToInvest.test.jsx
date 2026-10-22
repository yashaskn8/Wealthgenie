/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, render as rtlRender, screen, fireEvent, cleanup, within, waitFor } from '@testing-library/react';
import WhereToInvestTab from '../deepdive/WhereToInvestTab';
import UserDeclaredScenarioPanel from '../deepdive/UserDeclaredScenarioPanel';
import * as api from '../../services/api';

vi.mock('../../services/api', () => ({
  getCurrentMarketContext: vi.fn(),
  getPrivateMarketDemoData: vi.fn(() => new Promise(() => {})),
  rankInvestmentCandidates: vi.fn(),
  previewMarketContextAdjustment: vi.fn(),
  getTaxPolicyMetadata: vi.fn(async () => ({
    currentFiscalYear: 'FY2026-27',
    currentFiscalYearVerified: true,
    verifiedFiscalYears: ['FY2025-26', 'FY2026-27'],
  })),
  computeUserDeclaredPostTaxScenario: vi.fn(),
}));

const CURRENT_STATE_BINDING = {
  profileId: '64b000000000000000000001',
  profileVersion: 1,
  recommendationId: '64b000000000000000000002',
  allocationRevision: 1,
  allocationRevisionId: '64b000000000000000000003',
  portfolioFingerprint: 'a'.repeat(64),
  recommendationFingerprint: 'b'.repeat(64),
};
const CURRENT_RECOMMENDATION_META = {
  response_state: 'CURRENT',
  profileId: CURRENT_STATE_BINDING.profileId,
  recommendationId: CURRENT_STATE_BINDING.recommendationId,
  recommendation_id: CURRENT_STATE_BINDING.recommendationId,
  profile_version: CURRENT_STATE_BINDING.profileVersion,
  allocation_revision: CURRENT_STATE_BINDING.allocationRevision,
  allocation_revision_id: CURRENT_STATE_BINDING.allocationRevisionId,
  portfolio_fingerprint: CURRENT_STATE_BINDING.portfolioFingerprint,
  recommendation_fingerprint: CURRENT_STATE_BINDING.recommendationFingerprint,
  profile_input_hash: 'c'.repeat(64),
  recommendation_policy_version: 'recommendation-policy-test-1',
  regulatory_rule_version: 'tax-policy-test-1',
  return_assumption_version: 'return-assumption-test-1',
  return_assumption_hash: 'd'.repeat(64),
  return_assumption_source: 'MODEL_POLICY',
  current_allocation_source: 'INITIAL_ALLOCATION',
  calculation_freshness: {
    fresh: true,
    reasonCodes: [],
    expectedProfileHash: 'c'.repeat(64),
    observedProfileHash: 'c'.repeat(64),
    expectedProfileVersion: CURRENT_STATE_BINDING.profileVersion,
    observedProfileVersion: CURRENT_STATE_BINDING.profileVersion,
    allocationRevision: CURRENT_STATE_BINDING.allocationRevision,
    currentAllocationSource: 'INITIAL_ALLOCATION',
    observedRegulatoryVersion: 'tax-policy-test-1',
    currentRegulatoryVersion: 'tax-policy-test-1',
    policyVersion: 'recommendation-policy-test-1',
    observedRecommendationPolicyVersion: 'recommendation-policy-test-1',
    assumptionVersion: 'return-assumption-test-1',
    assumptionHash: 'd'.repeat(64),
    assumptionSource: 'MODEL_POLICY',
  },
  state_provenance: {
    status: 'PERSISTED_REVISION',
    stateId: '64b000000000000000000004',
    recommendationId: CURRENT_STATE_BINDING.recommendationId,
    allocationSource: 'INITIAL_ALLOCATION',
    allocationRevision: CURRENT_STATE_BINDING.allocationRevision,
    allocationRevisionId: CURRENT_STATE_BINDING.allocationRevisionId,
    profileVersion: CURRENT_STATE_BINDING.profileVersion,
    profileInputHash: 'c'.repeat(64),
    portfolioFingerprint: CURRENT_STATE_BINDING.portfolioFingerprint,
    recommendationFingerprint: CURRENT_STATE_BINDING.recommendationFingerprint,
    recommendationPolicyVersion: 'recommendation-policy-test-1',
    regulatoryRuleVersion: 'tax-policy-test-1',
    returnAssumptionVersion: 'return-assumption-test-1',
    returnAssumptionHash: 'd'.repeat(64),
    returnAssumptionSource: 'MODEL_POLICY',
    previousAllocationRevision: null,
    previousAllocationRevisionId: null,
  },
  instruments: [{ id: 'index_mf', name: 'Index Fund', allocation_pct: null }],
};

function prepareSbiInterestScenario(age = '35') {
  fireEvent.click(screen.getByText('Use your own transaction facts'));
  fireEvent.change(screen.getByLabelText('Fiscal year'), { target: { value: 'FY2025-26' } });
  fireEvent.change(screen.getByLabelText(/Your age on March 31/i), { target: { value: String(age) } });
  fireEvent.change(screen.getByLabelText(/Gross interest received in this fiscal year/i), { target: { value: '2500' } });
  fireEvent.change(screen.getByLabelText(/Annual tax income before this scenario/i), { target: { value: '1000000' } });
  fireEvent.change(screen.getByLabelText('Income source'), { target: { value: 'salary' } });
  fireEvent.change(screen.getByLabelText('Tax regime'), { target: { value: 'new' } });
  fireEvent.click(screen.getByLabelText(/I confirm these entered tax facts cover my scenario/i));
  return screen.getByRole('button', { name: /Calculate my scenario/i }).closest('form');
}

function declaredScenarioResponse(inputsUsed, overrides = {}) {
  const isEquity = inputsUsed.scenarioType === 'EQUITY_REALIZED_GAIN';
  const grossGain = isEquity
    ? inputsUsed.saleProceeds - inputsUsed.acquisitionCostBasis
    : inputsUsed.interestReceived;
  const productTaxClass = isEquity
    ? 'EQUITY_MF_SECTION_112A'
    : 'BANK_DEPOSIT_INTEREST';
  return {
    status: 'CALCULATED',
    calculationClass: 'TRANSACTION_TAX_ESTIMATE',
    dataClass: 'USER_DECLARED_TRANSACTION',
    inputBasis: 'USER_DECLARED_SCENARIO',
    canonicalInstrumentId: inputsUsed.canonicalInstrumentId,
    canonicalProductId: inputsUsed.canonicalProductId ?? null,
    taxClass: productTaxClass,
    taxClassificationMetadata: { sourceQualified: true, taxClass: productTaxClass },
    fiscalYear: inputsUsed.fiscalYear,
    policyVersion: 'tax-policy-test-1',
    inputsUsed,
    grossGain,
    taxableGain: grossGain,
    exemptionApplied: 0,
    incrementalTax: 0,
    cess: 0,
    surcharge: 0,
    netGain: grossGain,
    postTaxRatePct: null,
    transactionGainPct: null,
    holdingPeriod: null,
    unavailableReasons: [],
    sourceReferences: [],
    assumptions: [],
    disclosure: 'These values were entered by you and are not verified market facts.',
    ...overrides,
  };
}

function prepareNiftyBeesScenario({ costBasis = '100000', proceeds = '125000', sttConfirmed = false } = {}) {
  fireEvent.click(screen.getByText('Use your own transaction facts'));
  fireEvent.change(screen.getByLabelText(/Tax cost basis/i), { target: { value: costBasis } });
  fireEvent.change(screen.getByLabelText(/Sale consideration/i), { target: { value: proceeds } });
  fireEvent.change(screen.getByLabelText('Acquisition date'), { target: { value: '2024-05-01' } });
  fireEvent.change(screen.getByLabelText('Sale date'), { target: { value: '2025-05-01' } });
  fireEvent.change(screen.getByLabelText(/Section 112A exclusion already used/i), { target: { value: '0' } });
  if (sttConfirmed) fireEvent.click(screen.getByLabelText(/I assume the applicable STT condition/i));
  fireEvent.change(screen.getByLabelText(/Annual tax income before this scenario/i), { target: { value: '1000000' } });
  fireEvent.change(screen.getByLabelText('Income source'), { target: { value: 'salary' } });
  fireEvent.change(screen.getByLabelText('Tax regime'), { target: { value: 'new' } });
  fireEvent.change(screen.getByLabelText('Fiscal year'), { target: { value: 'FY2025-26' } });
  fireEvent.change(screen.getByLabelText(/Your age on March 31/i), { target: { value: '35' } });
  fireEvent.click(screen.getByLabelText(/I confirm these entered tax facts cover my scenario/i));
  return screen.getByRole('button', { name: /Calculate my scenario/i }).closest('form');
}

function declaredUnavailableEquityResponse(inputsUsed, overrides = {}) {
  const response = declaredScenarioResponse(inputsUsed);
  const unavailableResponse = { ...response };
  delete unavailableResponse.exemptionApplied;
  const grossGain = inputsUsed.saleProceeds - inputsUsed.acquisitionCostBasis;
  return {
    ...unavailableResponse,
    status: 'UNAVAILABLE',
    taxClass: 'EQUITY_MF_SECTION_112A',
    grossGain,
    taxableGain: null,
    incrementalTax: null,
    cess: null,
    surcharge: null,
    netGain: null,
    transactionGainPct: null,
    holdingPeriod: {
      acquisitionDate: inputsUsed.acquisitionDate,
      redemptionDate: inputsUsed.redemptionDate,
      holdingPeriodBasis: 'EXACT_TRANSACTION_DATES',
      basis: 'EXACT_USER_DECLARED_TRANSACTION_DATES',
      isLongTerm: false,
      thresholdMonths: 12,
      thresholdDate: '2025-05-01',
      holdingDays: 365,
    },
    unavailableReasons: ['EQUITY_TRANSFER_STT_CONDITION_NOT_ESTABLISHED'],
    ...overrides,
  };
}

function render(element, options) {
  if (element?.type === WhereToInvestTab) {
    element = React.cloneElement(element, {
      recommendationMeta: CURRENT_RECOMMENDATION_META,
      ...element.props,
    });
  }
  return rtlRender(element, options);
}

describe('Beginner-First Where-To-Invest UX', () => {
  it('keeps missing plan allocation unavailable while preserving an explicit zero', async () => {
    api.rankInvestmentCandidates.mockResolvedValueOnce({
      financialStateBinding: CURRENT_STATE_BINDING,
      products: [],
    });
    const profile = { profileId: CURRENT_STATE_BINDING.profileId, version: CURRENT_STATE_BINDING.profileVersion };
    const view = render(<WhereToInvestTab inv={{ id: 'index_mf', name: 'Index Fund', allocation_pct: null }} userProfile={profile} />);

    await waitFor(() => expect(api.rankInvestmentCandidates).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Plan allocation')).toBeNull();
    expect(screen.queryByText('0%')).toBeNull();

    view.rerender(<WhereToInvestTab
      inv={{ id: 'index_mf', name: 'Index Fund', allocation_pct: 0 }}
      userProfile={profile}
      recommendationMeta={{ ...CURRENT_RECOMMENDATION_META, instruments: [{ id: 'index_mf', name: 'Index Fund', allocation_pct: 0 }] }}
    />);
    expect(screen.getByText('Plan allocation')).toBeVisible();
    expect(screen.getByText('0%')).toBeVisible();
  });

  it('does not call a catalog alternative or another profile version a plan recommendation', async () => {
    const profile = { profileId: CURRENT_STATE_BINDING.profileId, version: CURRENT_STATE_BINDING.profileVersion };
    const view = render(<WhereToInvestTab
      inv={{ id: 'catalog_alternative', name: 'Catalog alternative', allocation_pct: 80 }}
      userProfile={profile}
      recommendationMeta={CURRENT_RECOMMENDATION_META}
    />);

    expect(screen.queryByText('YOUR PLAN RECOMMENDS')).toBeNull();
    expect(screen.queryByText('Plan allocation')).toBeNull();

    view.rerender(<WhereToInvestTab
      inv={{ id: 'index_mf', name: 'Index Fund', allocation_pct: 40 }}
      userProfile={{ ...profile, version: profile.version + 1 }}
      recommendationMeta={CURRENT_RECOMMENDATION_META}
    />);
    expect(screen.queryByText('YOUR PLAN RECOMMENDS')).toBeNull();
    expect(screen.queryByText('Plan allocation')).toBeNull();
  });

  it('uses the current recommendation metadata version when the profile response omits its version', () => {
    render(<WhereToInvestTab
      inv={{ id: 'index_mf', name: 'Index Fund', allocation_pct: null }}
      userProfile={{ profileId: CURRENT_STATE_BINDING.profileId }}
      recommendationMeta={{ ...CURRENT_RECOMMENDATION_META, instruments: [{ id: 'index_mf', name: 'Index Fund', allocation_pct: 40 }] }}
    />);

    expect(screen.getByText('YOUR PLAN RECOMMENDS')).toBeVisible();
  });

  it('excludes an obsolete product response after profile-version replacement even if abort is ignored', async () => {
    let resolveOld;
    api.rankInvestmentCandidates.mockReturnValueOnce(new Promise(done => { resolveOld = done; }));
    const inv = { id: 'ppf', name: 'PPF', riskScore: 1 };
    const profile = { profileId: '64b000000000000000000001', version: 1 };
    const view = render(<WhereToInvestTab inv={inv} userProfile={profile} />);
    const oldSignal = api.rankInvestmentCandidates.mock.calls[0][3].signal;
    view.rerender(<WhereToInvestTab inv={inv} userProfile={{ ...profile, version: 2 }} recommendationMeta={CURRENT_RECOMMENDATION_META} />);
    expect(await screen.findByTestId('wti-product-ppf:fact')).toBeVisible();
    expect(oldSignal.aborted).toBe(true);
    await act(async () => resolveOld({ financialStateBinding: CURRENT_STATE_BINDING, products: [{ id: 'obsolete', name: 'Obsolete product', officialRate: { value: 99 } }] }));
    expect(screen.queryByText('Obsolete product')).toBeNull();
    expect(screen.getAllByTestId('wti-product-ppf:fact')).toHaveLength(1);
  });

  it('keeps history, NAV, official rates and missing evidence distinct without expected-return substitution', async () => {
    const shared = { source: { provider: 'AMFI', url: 'javascript:alert(1)' }, presentationStatus: 'EVIDENCE_RANKED' };
    api.rankInvestmentCandidates.mockResolvedValueOnce({ financialStateBinding: CURRENT_STATE_BINDING, ranking: { status: 'EVIDENCE_RANKED' }, products: [
      { ...shared, id: 'history', name: 'Historical fund', historicalReturn: { valuePct: 0, startDate: '2025-09-01', endDate: '2026-09-01' }, nav: { value: 123.456, observedAt: '2026-09-01T10:00:00Z' } },
      { ...shared, id: 'nav', name: 'NAV fund', nav: { value: 123.456 } },
      { ...shared, id: 'unknown', name: 'Unknown fund', nominalReturn: 99, expectedReturn: 99, nav: { value: null } },
    ] });
    render(<WhereToInvestTab inv={{ id: 'index_mf', name: 'Index Fund' }} userProfile={{ profileId: '64b000000000000000000001' }} />);
    const history = within(await screen.findByTestId('wti-product-history'));
    expect(history.getByText('Historical 1Y return')).toBeVisible();
    expect(history.getByText('0.00% historical')).toBeVisible();
    expect(history.getByText(/Source: AMFI/, { selector: 'span' })).toBeVisible();
    expect(history.getByText(/As of: 1 Sept 2026/)).toBeVisible();
    expect(history.queryByRole('link')).toBeNull();
    const nav = within(screen.getByTestId('wti-product-nav'));
    expect(nav.getByText('Current NAV')).toBeVisible();
    expect(nav.getByText('₹123.456')).toBeVisible();
    const unavailable = within(screen.getByTestId('wti-product-unknown'));
    expect(unavailable.getAllByText('Unavailable').length).toBeGreaterThan(0);
    expect(unavailable.queryByText(/99/)).toBeNull();
  });

  it('renders exact ETF identity and NAV separately from unavailable market price and product facts', async () => {
    api.rankInvestmentCandidates.mockResolvedValueOnce({
      financialStateBinding: CURRENT_STATE_BINDING,
      ranking: { status: 'VERIFIED_COMPARABLE_OPTIONS' },
      products: [{
        id: 'etf:isin:INF204KB14I2',
        canonicalProductId: 'etf:isin:INF204KB14I2',
        name: 'Issuer scheme label',
        productType: 'ETF',
        cashflowIllustration: { status: 'NOT_APPLICABLE', reasonCode: 'MARKET_VALUATION_REQUIRES_NAV_OR_EXCHANGE_PRICE' },
        presentationStatus: 'VERIFIED_COMPARABLE_OPTION',
        provider: 'Nippon India Mutual Fund',
        exchange: 'NSE',
        ticker: 'NIFTYBEES',
        isin: 'INF204KB14I2',
        benchmark: {
          name: 'NIFTY 50',
          returnVariant: 'NIFTY 50 TRI',
          source: { url: 'https://mf.nipponindiaim.com/FundsAndPerformance/ProductNotes/NipponIndia-ETF-Nifty-50-BeES-Feb-2026.pdf' },
        },
        identityEvidence: [{
          authority: 'NSE',
          url: 'https://nsearchives.nseindia.com/trading_security/mf/pdf/scheme.pdf',
        }],
        source: { provider: 'AMFI', url: 'https://portal.amfiindia.com/spages/NAVAll.txt' },
        nav: { value: 250.25, unit: 'NAV_PER_UNIT', observedAt: '2026-10-01T09:55:00.000Z' },
        historicalReturn: {
          valuePct: 2.3,
          basis: 'HISTORICAL_NAV_RETURN',
          startDate: '2025-10-01',
          endDate: '2026-10-01',
        },
        marketPrice: { value: null, availabilityStatus: 'UNAVAILABLE' },
        productEligibility: { status: 'PARENT_SUITABILITY_PASSED_PRODUCT_ACCESS_FACTS_UNAVAILABLE' },
        riskEvidence: null,
        liquidityEvidence: null,
        postTaxAnalysis: {
          status: 'TAX_CLASSIFICATION_UNAVAILABLE',
          dataClass: 'UNAVAILABLE',
          requiredTaxInputs: [],
          unavailableReasons: ['TAX_CLASSIFICATION_UNAVAILABLE'],
        },
      }],
    });

    render(<WhereToInvestTab
      inv={{ id: 'nifty_etf', name: 'Nifty 50 ETF' }}
      userProfile={{ profileId: '64b000000000000000000001' }}
    />);
    const card = within(await screen.findByTestId('wti-product-etf:isin:INF204KB14I2'));
    expect(card.getByText('Issuer scheme label')).toBeVisible();
    expect(card.queryByTestId('wti-contractual-cashflow-unavailable')).toBeNull();
    expect(card.getByTestId('wti-contractual-cashflow-not-applicable')).toHaveTextContent('no contractual maturity amount');
    expect(card.queryByTestId('wti-gross-contract-illustration')).toBeNull();
    // Private quote and market-context panels are not mounted by this product view.
    expect(screen.queryByRole('button', { name: 'Load Upstox quotes' })).toBeNull();
    expect(screen.queryByTestId('wti-private-etf-quote')).toBeNull();
    expect(api.getPrivateMarketDemoData).not.toHaveBeenCalled();
    expect(api.getCurrentMarketContext).not.toHaveBeenCalled();
    expect(api.previewMarketContextAdjustment).not.toHaveBeenCalled();
    fireEvent.click(card.getByText('View technical details & provenance'));
    expect(card.getByText(/NIFTY 50 \(NIFTY 50 TRI\)/)).toBeVisible();
    expect(card.getByText('Exchange / ticker: NSE / NIFTYBEES')).toBeVisible();
    expect(card.getByText('ISIN: INF204KB14I2')).toBeVisible();
    expect(card.getByText('Exchange market price: Unavailable')).toBeVisible();
    expect(card.getByText('Fund NAV: ₹250.25')).toBeVisible();
    expect(card.getByText('Historical 1Y return')).toBeVisible();
    expect(card.getByText('2.30% historical')).toBeVisible();
    expect(card.getByText(/No defensible merit order is claimed for this comparable option/)).toBeVisible();
    expect(card.getByText(/A verified historical return is shown for context only\. Historical performance is not an expected return/)).toBeVisible();
    expect(card.getByText('Risk classification unavailable')).toBeVisible();
    expect(card.getByText('Access terms unavailable')).toBeVisible();
    expect(card.getByText('Tax treatment is not verified for this exact product.')).toBeVisible();
    expect(card.getByRole('link', { name: 'NSE evidence' })).toHaveAttribute('href', 'https://nsearchives.nseindia.com/trading_security/mf/pdf/scheme.pdf');
    expect(card.getByRole('link', { name: 'Benchmark evidence' })).toHaveAttribute('href', 'https://mf.nipponindiaim.com/FundsAndPerformance/ProductNotes/NipponIndia-ETF-Nifty-50-BeES-Feb-2026.pdf');
  });

  it('shows a product-provider failure without retaining a previous financial-state result', async () => {
    api.rankInvestmentCandidates.mockRejectedValueOnce(new Error('503'));
    render(<WhereToInvestTab inv={{ id: 'ppf', name: 'PPF' }} userProfile={{ profileId: '64b000000000000000000001' }} />);
    expect(await screen.findByText(/Authoritative product ranking is temporarily unavailable/i)).toBeVisible();
    expect(screen.queryByTestId('wti-product-ppf:fact')).toBeNull();
  });

  it.each([
    ['missing products', { financialStateBinding: CURRENT_STATE_BINDING }],
    ['null products', { financialStateBinding: CURRENT_STATE_BINDING, products: null }],
    ['non-array products', { financialStateBinding: CURRENT_STATE_BINDING, products: { id: 'not-a-list' } }],
  ])('treats a malformed successful ranking response with %s as unavailable', async (_label, response) => {
    api.rankInvestmentCandidates.mockResolvedValueOnce(response);
    render(<WhereToInvestTab inv={{ id: 'ppf', name: 'PPF' }} userProfile={{ profileId: CURRENT_STATE_BINDING.profileId, version: CURRENT_STATE_BINDING.profileVersion }} />);

    expect(await screen.findByText(/Authoritative product ranking is temporarily unavailable/i)).toBeVisible();
    expect(screen.queryByText(/No current source-qualified products are available/i)).toBeNull();
    expect(screen.queryByTestId('wti-product-ppf:fact')).toBeNull();
  });

  it('explains when production product data is unavailable because source reuse rights are not cleared', async () => {
    api.rankInvestmentCandidates.mockResolvedValueOnce({
      financialStateBinding: CURRENT_STATE_BINDING,
      products: [],
      ranking: { status: 'UNAVAILABLE', reasonCodes: ['SOURCE_RIGHTS_UNQUALIFIED'] },
      comparisonUniverse: {
        sourceRightsStatus: 'BLOCKED_REUSE_RIGHTS',
        productionSourceUseAllowed: false,
        disclosure: 'Source reuse permission is unqualified.',
      },
    });
    render(<WhereToInvestTab
      inv={{ id: 'index_mf', name: 'Index Fund' }}
      userProfile={{ profileId: '64b000000000000000000001' }}
    />);
    expect(await screen.findByText(/not cleared for WealthGenie production display/i)).toBeVisible();
    expect(screen.queryByText('BLOCKED_REUSE_RIGHTS')).toBeNull();
    expect(screen.queryByText(/static fallback values were inserted/i)).toBeNull();
  });

  it('submits explicitly entered SBI interest and tax facts as a user-declared scenario', async () => {
    api.computeUserDeclaredPostTaxScenario.mockImplementationOnce(async scenario => declaredScenarioResponse(scenario));
    render(<UserDeclaredScenarioPanel
      canonicalInstrumentId="sbi_fd"
      instrumentName="SBI fixed deposit"
      initialAge={35}
      taxPolicyMetadata={{ currentFiscalYear: 'FY2026-27', currentFiscalYearVerified: true, verifiedFiscalYears: ['FY2025-26', 'FY2026-27'] }}
    />);
    expect(screen.getByLabelText(/Your age on March 31/i)).toHaveValue(null);
    fireEvent.submit(prepareSbiInterestScenario());

    await waitFor(() => expect(api.computeUserDeclaredPostTaxScenario).toHaveBeenCalledTimes(1));
    expect(api.computeUserDeclaredPostTaxScenario).toHaveBeenCalledWith(expect.objectContaining({
      canonicalInstrumentId: 'sbi_fd',
      scenarioType: 'INTEREST_INCOME',
      interestReceived: 2500,
      annualGrossIncome: 1000000,
      incomeSource: 'salary',
      regime: 'new',
      fiscalYear: 'FY2025-26',
      userAge: 35,
    }));
    expect(await screen.findByText('Interest after tax')).toBeVisible();
    expect(screen.getAllByText(/not verified market facts/i)).toHaveLength(2);
    expect(screen.queryByText(/\d+(?:\.\d+)?%/)).toBeNull();
  });

  it.each([
    ['fiscal year', scenario => ({ ...scenario, fiscalYear: 'FY2026-27' })],
    ['age', scenario => ({ ...scenario, userAge: 36 })],
    ['income', scenario => ({ ...scenario, annualGrossIncome: scenario.annualGrossIncome + 1 })],
    ['income source', scenario => ({ ...scenario, incomeSource: 'business' })],
    ['interest', scenario => ({ ...scenario, interestReceived: scenario.interestReceived + 1 })],
  ])('rejects a user-declared result whose echoed %s differs from the submitted scenario', async (_field, alterEcho) => {
    api.computeUserDeclaredPostTaxScenario.mockImplementationOnce(async scenario => (
      declaredScenarioResponse(alterEcho(scenario))
    ));
    render(<UserDeclaredScenarioPanel
      canonicalInstrumentId="sbi_fd"
      instrumentName="SBI fixed deposit"
      taxPolicyMetadata={{ currentFiscalYear: 'FY2026-27', currentFiscalYearVerified: true, verifiedFiscalYears: ['FY2025-26', 'FY2026-27'] }}
    />);
    fireEvent.submit(prepareSbiInterestScenario());

    await waitFor(() => expect(api.computeUserDeclaredPostTaxScenario).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be calculated/i);
    expect(screen.queryByText('Interest after tax')).not.toBeInTheDocument();
  });

  it.each([
    ['fiscal year', { fiscalYear: 'FY2026-27' }],
    ['policy metadata', { policyVersion: null }],
    ['calculation class', { calculationClass: 'MODELLED_POST_TAX_PROJECTION' }],
    ['data class', { dataClass: 'MODEL_ASSUMPTION' }],
    ['input basis', { inputBasis: 'PROVIDER_VERIFIED' }],
    ['instrument identity', { canonicalInstrumentId: 'fd' }],
    ['tax class', { taxClass: 'UNQUALIFIED_TAX_CLASS' }],
    ['source qualification', { taxClassificationMetadata: { sourceQualified: false, taxClass: null } }],
    ['status', { status: 'PENDING' }],
    ['gross amount', { grossGain: Number.NaN }],
    ['tax amount', { incrementalTax: Number.POSITIVE_INFINITY }],
    ['net amount', { netGain: '2500' }],
  ])('rejects a user-declared response with corrupted %s metadata or amount', async (_field, overrides) => {
    api.computeUserDeclaredPostTaxScenario.mockImplementationOnce(async scenario => (
      declaredScenarioResponse(scenario, overrides)
    ));
    render(<UserDeclaredScenarioPanel
      canonicalInstrumentId="sbi_fd"
      instrumentName="SBI fixed deposit"
      taxPolicyMetadata={{ currentFiscalYear: 'FY2026-27', currentFiscalYearVerified: true, verifiedFiscalYears: ['FY2025-26', 'FY2026-27'] }}
    />);
    fireEvent.submit(prepareSbiInterestScenario());

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be calculated/i);
    expect(screen.queryByText('Interest after tax')).not.toBeInTheDocument();
  });

  it('preserves a valid explicitly unavailable equity result with null tax amounts', async () => {
    api.computeUserDeclaredPostTaxScenario.mockImplementationOnce(async scenario => (
      declaredUnavailableEquityResponse(scenario)
    ));
    render(<UserDeclaredScenarioPanel
      canonicalInstrumentId="nifty_etf"
      instrumentName="Nifty ETF"
      taxPolicyMetadata={{ currentFiscalYear: 'FY2026-27', currentFiscalYearVerified: true, verifiedFiscalYears: ['FY2025-26', 'FY2026-27'] }}
    />);
    fireEvent.submit(prepareNiftyBeesScenario());

    expect(await screen.findByText('No tax result calculated')).toBeVisible();
    expect(screen.getByText(/STT condition was not confirmed/i)).toBeVisible();
    expect(screen.queryByText('Incremental tax')).not.toBeInTheDocument();
  });

  it.each([
    ['fiscal year', { fiscalYear: 'FY2026-27' }],
    ['scenario amount', { taxableGain: Number.POSITIVE_INFINITY }],
    ['instrument metadata', { canonicalProductId: 'etf:isin:wrong' }],
    ['tax classification', { taxClassificationMetadata: { sourceQualified: true, taxClass: 'WRONG_CLASS' } }],
  ])('rejects corrupted unavailable equity %s while retaining null as a valid unavailable amount', async (_field, overrides) => {
    api.computeUserDeclaredPostTaxScenario.mockImplementationOnce(async scenario => (
      declaredUnavailableEquityResponse(scenario, overrides)
    ));
    render(<UserDeclaredScenarioPanel
      canonicalInstrumentId="nifty_etf"
      instrumentName="Nifty ETF"
      taxPolicyMetadata={{ currentFiscalYear: 'FY2026-27', currentFiscalYearVerified: true, verifiedFiscalYears: ['FY2025-26', 'FY2026-27'] }}
    />);
    fireEvent.submit(prepareNiftyBeesScenario());

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be calculated/i);
    expect(screen.queryByText('No tax result calculated')).not.toBeInTheDocument();
  });

  it('accepts the explicit unsupported-fiscal-year status only with null policy metadata and amounts', async () => {
    api.computeUserDeclaredPostTaxScenario.mockImplementationOnce(async scenario => (
      declaredScenarioResponse(scenario, {
        status: 'FISCAL_YEAR_UNSUPPORTED',
        fiscalYear: null,
        policyVersion: null,
        grossGain: null,
        taxableGain: null,
        incrementalTax: null,
        cess: null,
        surcharge: null,
        netGain: null,
        unavailableReasons: ['FISCAL_YEAR_UNSUPPORTED'],
      })
    ));
    render(<UserDeclaredScenarioPanel
      canonicalInstrumentId="sbi_fd"
      instrumentName="SBI fixed deposit"
      taxPolicyMetadata={{ currentFiscalYear: 'FY2026-27', currentFiscalYearVerified: true, verifiedFiscalYears: ['FY2025-26', 'FY2026-27'] }}
    />);
    fireEvent.submit(prepareSbiInterestScenario());

    expect(await screen.findByText('No tax result calculated')).toBeVisible();
    expect(screen.getByText(/Verified tax policy is unavailable for that fiscal year/i)).toBeVisible();
  });

  it.each([
    [17, false],
    [18, true],
    [120, true],
    [121, false],
    [18.5, false],
  ])('accepts only whole-number ages from 18 through 120 for declared scenarios (%s)', async (age, isValid) => {
    api.computeUserDeclaredPostTaxScenario.mockImplementation(async scenario => declaredScenarioResponse(scenario));
    render(<UserDeclaredScenarioPanel
      canonicalInstrumentId="sbi_fd"
      instrumentName="SBI fixed deposit"
      taxPolicyMetadata={{ currentFiscalYear: 'FY2026-27', currentFiscalYearVerified: true, verifiedFiscalYears: ['FY2025-26', 'FY2026-27'] }}
    />);
    const form = prepareSbiInterestScenario(age);
    const ageInput = screen.getByLabelText(/Your age on March 31/i);

    fireEvent.submit(form);

    if (isValid) {
      await waitFor(() => expect(api.computeUserDeclaredPostTaxScenario).toHaveBeenCalledTimes(1));
      expect(api.computeUserDeclaredPostTaxScenario.mock.calls[0][0].userAge).toBe(age);
      expect(await screen.findByText('Interest after tax')).toBeVisible();
    } else {
      expect(ageInput).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByRole('button', { name: /Calculate my scenario/i })).toBeDisabled();
      expect(api.computeUserDeclaredPostTaxScenario).not.toHaveBeenCalled();
      expect(screen.queryByText('Interest after tax')).not.toBeInTheDocument();
    }
  });

  it('hides a resolved scenario if its instrument context changes', async () => {
    api.computeUserDeclaredPostTaxScenario.mockImplementationOnce(async scenario => declaredScenarioResponse(scenario));
    const view = render(<UserDeclaredScenarioPanel
      canonicalInstrumentId="sbi_fd"
      instrumentName="SBI fixed deposit"
      taxPolicyMetadata={{ currentFiscalYear: 'FY2026-27', currentFiscalYearVerified: true, verifiedFiscalYears: ['FY2025-26', 'FY2026-27'] }}
    />);
    fireEvent.submit(prepareSbiInterestScenario());
    expect(await screen.findByText('Interest after tax')).toBeVisible();

    view.rerender(<UserDeclaredScenarioPanel
      canonicalInstrumentId="fd"
      instrumentName="Fixed deposit"
      taxPolicyMetadata={{ currentFiscalYear: 'FY2026-27', currentFiscalYearVerified: true, verifiedFiscalYears: ['FY2025-26', 'FY2026-27'] }}
    />);

    expect(screen.queryByText('Interest after tax')).not.toBeInTheDocument();
  });

  it('hides a resolved scenario as soon as the entered tax age changes', async () => {
    api.computeUserDeclaredPostTaxScenario.mockImplementationOnce(async scenario => declaredScenarioResponse(scenario));
    render(<UserDeclaredScenarioPanel
      canonicalInstrumentId="sbi_fd"
      instrumentName="SBI fixed deposit"
      taxPolicyMetadata={{ currentFiscalYear: 'FY2026-27', currentFiscalYearVerified: true, verifiedFiscalYears: ['FY2025-26', 'FY2026-27'] }}
    />);
    fireEvent.submit(prepareSbiInterestScenario());
    expect(await screen.findByText('Interest after tax')).toBeVisible();

    fireEvent.change(screen.getByLabelText(/Your age on March 31/i), { target: { value: '36' } });

    expect(screen.queryByText('Interest after tax')).not.toBeInTheDocument();
  });

  it('requires the response to echo optional deductions exactly', async () => {
    api.computeUserDeclaredPostTaxScenario.mockImplementationOnce(async scenario => (
      declaredScenarioResponse({
        ...scenario,
        deductions: { ...scenario.deductions, section80C: 9999 },
      })
    ));
    render(<UserDeclaredScenarioPanel
      canonicalInstrumentId="sbi_fd"
      instrumentName="SBI fixed deposit"
      taxPolicyMetadata={{ currentFiscalYear: 'FY2026-27', currentFiscalYearVerified: true, verifiedFiscalYears: ['FY2025-26', 'FY2026-27'] }}
    />);
    const form = prepareSbiInterestScenario();
    fireEvent.click(screen.getByText('Tax deductions (optional)'));
    fireEvent.change(screen.getByLabelText(/Section 80C investments/i), { target: { value: '10000' } });
    fireEvent.submit(form);

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be calculated/i);
    expect(screen.queryByText('Interest after tax')).not.toBeInTheDocument();
  });

  it('does not offer a user-entered tax result where product classification is unavailable', () => {
    render(<UserDeclaredScenarioPanel
      canonicalInstrumentId="physical_gold"
      instrumentName="Physical gold"
      taxPolicyMetadata={{ verifiedFiscalYears: [] }}
    />);
    fireEvent.click(screen.getByText('Use your own transaction facts'));
    expect(screen.getByText(/needs an exact product tax classification/i)).toBeVisible();
    expect(screen.queryByRole('button', { name: /Calculate my scenario/i })).toBeNull();
  });
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();

    api.rankInvestmentCandidates.mockImplementation(async (_profileId, _parentId, _taxContext, _options, financialStateBinding) => ({
      financialStateBinding,
      products: [
        {
          id: 'ppf:fact',
          name: 'Public Provident Fund',
          provider: 'Government of India',
          source: { provider: 'India Post' },
          productType: 'GOVERNMENT_SAVINGS',
          parentInstrumentId: 'ppf',
          officialRate: { value: 7.1 },
          presentationStatus: 'VERIFIED_COMPARABLE_OPTION',
          beginnerSuitability: {
            whyThisFitsYou: 'This product is shown under Public Provident Fund. Individual-product suitability, eligibility, risk rating, and redemption terms have not been established.',
            riskTier: 'Product-specific risk unavailable',
            accessToMoney: 'Product-specific access terms unavailable',
            verifiedFactLabel: 'Current official rate',
            verifiedFactValue: '7.10% p.a.',
            sourceProvider: 'India Post',
          },
          postTaxAnalysis: {
            status: 'TAX_CLASSIFICATION_REQUIRES_ACQUISITION_FACTS',
            dataClass: 'UNAVAILABLE',
            requiredTaxInputs: ['verifiedAccountEligibility', 'contributionHistory', 'withdrawalOrMaturityFacts'],
            unavailableReasons: ['PPF_SSY_EXCLUSION_ELIGIBILITY_NOT_ESTABLISHED'],
            taxClassification: 'PPF_ACCOUNT_EXCLUSION_CONDITIONAL',
            disclosure: 'No account-qualification or contribution/exit evidence is available to establish the statutory exclusion for this account. No tax-free result or after-tax rate is inferred from the product name or scheme category.',
            isHistoricalEstimate: false,
          },
        },
      ],
      ranking: { status: 'VERIFIED_COMPARABLE_OPTIONS' },
      comparisonUniverse: { disclosure: 'Comparison of verified products.' },
    }));
  });

  it('keeps hidden Live Market Today and Upstox surfaces from requesting data on mount', async () => {
    render(
      <WhereToInvestTab
        inv={{ id: 'ppf', name: 'Public Provident Fund', riskScore: 1 }}
        userProfile={{ profileId: CURRENT_STATE_BINDING.profileId, monthly_take_home: 100000 }}
      />
    );

    expect(await screen.findByTestId('wti-product-ppf:fact')).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Market conditions overview' })).toBeNull();
    expect(screen.queryByTestId('market-context-panel')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Refresh market data' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'See how this affects my plan' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Load Upstox quotes' })).toBeNull();
    expect(screen.queryByText(/Upstox market observations|Private Upstox last-traded ETF price/i)).toBeNull();
    expect(api.getCurrentMarketContext).not.toHaveBeenCalled();
    expect(api.getPrivateMarketDemoData).not.toHaveBeenCalled();
    expect(api.previewMarketContextAdjustment).not.toHaveBeenCalled();
  });

  it('renders a qualified backend list exactly as returned, up to the five-product contract', async () => {
    const products = Array.from({ length: 5 }, (_, index) => ({
      id: 'qualified:' + (index + 1),
      name: 'Qualified option ' + (index + 1),
      presentationStatus: 'VERIFIED_COMPARABLE_OPTION',
      source: { provider: 'AMFI' },
      nav: { value: 10 + index },
    }));
    api.rankInvestmentCandidates.mockResolvedValueOnce({
      financialStateBinding: CURRENT_STATE_BINDING,
      ranking: { status: 'VERIFIED_COMPARABLE_OPTIONS' },
      products,
    });

    render(<WhereToInvestTab
      inv={{ id: 'index_mf', name: 'Index Fund' }}
      userProfile={{ profileId: CURRENT_STATE_BINDING.profileId, version: CURRENT_STATE_BINDING.profileVersion }}
    />);

    expect(await screen.findByTestId('wti-product-qualified:1')).toBeVisible();
    expect(screen.getAllByTestId(/^wti-product-qualified:/)).toHaveLength(5);
    expect(screen.queryByTestId('wti-product-qualified:6')).toBeNull();
  });

  it.each([
    ['unqualified status', [{ id: 'unqualified', name: 'Unqualified response' }], { status: 'UNAVAILABLE' }],
    ['more than five products', Array.from({ length: 6 }, (_, index) => ({ id: 'overflow:' + index, name: 'Overflow ' + index })), { status: 'EVIDENCE_RANKED' }],
  ])('withholds a malformed qualified-list response with %s', async (_label, products, ranking) => {
    api.rankInvestmentCandidates.mockResolvedValueOnce({
      financialStateBinding: CURRENT_STATE_BINDING,
      ranking,
      products,
    });

    render(<WhereToInvestTab
      inv={{ id: 'index_mf', name: 'Index Fund' }}
      userProfile={{ profileId: CURRENT_STATE_BINDING.profileId, version: CURRENT_STATE_BINDING.profileVersion }}
    />);

    expect(await screen.findByText(/Authoritative product ranking is temporarily unavailable/i)).toBeVisible();
    expect(screen.queryByTestId('wti-product-unqualified')).toBeNull();
    expect(screen.queryByTestId(/^wti-product-overflow:/)).toBeNull();
  });
  it('renders plain-English Why this fits you, risk tier, and access to money', async () => {
    render(
      <WhereToInvestTab
        inv={{ id: 'ppf', name: 'Public Provident Fund', riskScore: 1 }}
        userProfile={{ profileId: '64b000000000000000000001', monthly_take_home: 100000 }}
      />
    );

    expect(await screen.findByText('Public Provident Fund')).toBeTruthy();

    // Product facts stay unavailable without qualified product-level evidence.
    const riskChips = screen.getAllByText('Product-specific risk unavailable');
    expect(riskChips.length).toBeGreaterThanOrEqual(1);

    const accessTexts = screen.getAllByText(/Product-specific access terms unavailable/i);
    expect(accessTexts.length).toBeGreaterThanOrEqual(1);

    const whyFitsLabels = screen.getAllByText(/Why this fits you/i);
    expect(whyFitsLabels.length).toBeGreaterThanOrEqual(1);

    expect(screen.getAllByText(/Individual-product suitability, eligibility, risk rating, and redemption terms have not been established/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/guaranteed|100% sovereign safety/i)).toBeNull();
  });

  it('does not turn a parent risk tier into capital guarantees or profile-match claims', async () => {
    render(
      <WhereToInvestTab
        inv={{ id: 'ppf', name: 'Public Provident Fund', riskScore: 1 }}
        userProfile={{ profileId: '64b000000000000000000001' }}
      />
    );

    await screen.findByText('Public Provident Fund');
    expect(screen.getByRole('meter', { name: 'Parent Category Risk: Low' })).toHaveAttribute('aria-valuenow', '1');
    expect(screen.queryByText(/Sovereign Backed|Zero to Minimal|Regulated Bank|Low & Predictable|Conservative & Beginner/i)).toBeNull();
    expect(screen.queryByText('Suitability Gate Passed')).toBeNull();
    expect(screen.queryByText('Financial Profile Match')).toBeNull();
  });

  it('keeps PPF tax treatment unavailable without account facts and retains only relevant principal controls', async () => {
    render(
      <WhereToInvestTab
        inv={{ id: 'ppf', name: 'Public Provident Fund', riskScore: 1 }}
        userProfile={{ profileId: '64b000000000000000000001', monthly_take_home: 100000 }}
      />
    );

    const ppf = within(await screen.findByTestId('wti-product-ppf:fact'));
    expect(ppf.getByText(/Additional product or account facts are needed before a tax result can be calculated./i)).toBeVisible();
    expect(ppf.getByText(/No tax-free result or after-tax rate is inferred/i)).toBeVisible();
    expect(ppf.queryByText('Defensible Post-Tax')).toBeNull();
    expect(screen.queryByRole('button', { name: /Exact-product tax illustration/i })).toBeNull();

    // Illustrative principal selector buttons
    expect(screen.getAllByText('₹5,000').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('₹10,000').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('₹25,000').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('₹50,000').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('₹1,00,000').length).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ['unknown', { status: 'FUTURE_TAX_STATUS', postTaxRatePct: 99 }],
    ['missing', undefined],
  ])('shows no tax amount when the product tax analysis is %s', async (_case, postTaxAnalysis) => {
    api.rankInvestmentCandidates.mockResolvedValueOnce({
      financialStateBinding: CURRENT_STATE_BINDING,
      ranking: { status: 'VERIFIED_COMPARABLE_OPTIONS' },
      products: [{
        id: 'tax-fallback',
        name: 'Tax fallback product',
        officialRate: { value: 7.1 },
        ...(postTaxAnalysis ? { postTaxAnalysis } : {}),
      }],
    });
    render(
      <WhereToInvestTab
        inv={{ id: 'ppf', name: 'Public Provident Fund', riskScore: 1 }}
        userProfile={{ profileId: '64b000000000000000000001' }}
      />
    );
    const card = within(await screen.findByTestId('wti-product-tax-fallback'));
    expect(card.getByText(postTaxAnalysis
      ? 'Tax status could not be verified. No tax amount is shown.'
      : 'No tax analysis was returned. No tax amount is shown.')).toBeVisible();
    expect(card.queryByText(/FUTURE_TAX_STATUS|99%/)).toBeNull();
  });

  it('prioritizes an official current rate over historical return in the product card', async () => {
    api.rankInvestmentCandidates.mockResolvedValueOnce({
      financialStateBinding: CURRENT_STATE_BINDING,
      products: [{
        id: 'fd:official',
        name: 'Verified Term Deposit',
        provider: 'Verified Bank',
        source: { provider: 'SBI' },
        officialRate: { value: 7.25, dataClass: 'OFFICIAL_BANK_PUBLISHED_RATE' },
        historicalReturn: { valuePct: 99 },
        presentationStatus: 'VERIFIED_COMPARABLE_OPTION',
        beginnerSuitability: { riskTier: 'Low Risk', accessToMoney: 'Source terms required' },
      }],
      ranking: { status: 'VERIFIED_COMPARABLE_OPTIONS' },
    });

    render(
      <WhereToInvestTab
        inv={{ id: 'fd', name: 'Verified Term Deposits', riskScore: 1 }}
        userProfile={{ profileId: '64b000000000000000000001' }}
      />
    );

    expect(await screen.findByText('Current official bank rate')).toBeTruthy();
    expect(screen.getByText('7.25% p.a.')).toBeTruthy();
    expect(screen.queryByText('99.00% historical')).toBeNull();
  });

  it('describes an RBI floating coupon with reset semantics instead of bank-rate wording', async () => {
    api.rankInvestmentCandidates.mockResolvedValueOnce({
      financialStateBinding: CURRENT_STATE_BINDING,
      products: [{
        id: 'rbi:frsb',
        name: 'RBI Floating Rate Savings Bonds',
        provider: 'RBI',
        source: { provider: 'RBI' },
        productType: 'GOVERNMENT_BOND',
        parentInstrumentId: 'rbi_bonds',
        officialRate: {
          value: 8.05,
          dataClass: 'OFFICIAL_RBI_FLOATING_COUPON_RATE',
          effectiveFrom: '2026-07-01',
          effectiveTo: '2026-12-31',
        },
        presentationStatus: 'VERIFIED_COMPARABLE_OPTION',
        beginnerSuitability: { riskTier: 'Very Low Risk', accessToMoney: '7-year maturity' },
      }],
      ranking: { status: 'VERIFIED_COMPARABLE_OPTIONS' },
    });

    render(
      <WhereToInvestTab
        inv={{ id: 'rbi_bonds', name: 'RBI Floating Rate Savings Bonds', riskScore: 1 }}
        userProfile={{ profileId: '64b000000000000000000001' }}
      />
    );

    expect(await screen.findByText(/Current RBI Floating Rate Savings Bond coupon effective 2026-07-01 to 2026-12-31/i)).toBeTruthy();
    expect(screen.getByText(/resets on January 1 and July 1/i)).toBeTruthy();
    expect(screen.getByText(/not a fixed 7-year guaranteed rate/i)).toBeTruthy();
    expect(screen.queryByText(/Official bank-published card rate/i)).toBeNull();
  });

  it('explains specified-mutual-fund date inputs under the selected fiscal-year provision', async () => {
    api.rankInvestmentCandidates.mockResolvedValueOnce({
      financialStateBinding: CURRENT_STATE_BINDING,
      products: [{
        id: 'debt-mf:qualified',
        name: 'Qualified debt fund',
        parentInstrumentId: 'debt_mf',
        postTaxAnalysis: {
          status: 'REQUIRES_TAX_INPUTS',
          requiredTaxInputs: ['annualGrossIncome', 'incomeSource', 'regime', 'fiscalYear', 'userAge', 'acquisitionDate', 'redemptionDate'],
        },
      }],
      ranking: { status: 'VERIFIED_COMPARABLE_OPTIONS' },
    });
    render(
      <WhereToInvestTab
        inv={{ id: 'debt_mf', name: 'Debt mutual fund', riskScore: 3 }}
        userProfile={{ profileId: CURRENT_STATE_BINDING.profileId, age: 40 }}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: /Exact-product tax illustration/i }));

    const fiscalYear = screen.getByLabelText('Fiscal Year');
    fireEvent.change(fiscalYear, { target: { value: 'FY2026-27' } });
    expect(screen.getByText(/For this specified-mutual-fund illustration, Section 76 applies the acquisition cutoff and the selected fiscal-year rule/i)).toBeVisible();
    fireEvent.change(fiscalYear, { target: { value: 'FY2025-26' } });
    expect(screen.getByText(/For this specified-mutual-fund illustration, Section 50AA applies the acquisition cutoff and the selected fiscal-year rule/i)).toBeVisible();
    expect(screen.getByLabelText('Acquisition date')).toBeVisible();
    expect(screen.getByLabelText('Redemption date')).toBeVisible();
    expect(screen.queryByLabelText(/Your holding period/i)).toBeNull();
  });

  it('renders each backend-declared supported tax input without silently defaulting blank facts', async () => {
    api.rankInvestmentCandidates.mockResolvedValueOnce({
      financialStateBinding: CURRENT_STATE_BINDING,
      products: [{
        id: 'deposit:tax', name: 'Source-qualified deposit', parentInstrumentId: 'fd',
        postTaxAnalysis: {
          status: 'REQUIRES_TAX_INPUTS',
          requiredTaxInputs: ['annualGrossIncome', 'incomeSource', 'regime', 'fiscalYear', 'userAge'],
        },
      }],
      ranking: { status: 'VERIFIED_COMPARABLE_OPTIONS' },
    });
    render(
      <WhereToInvestTab
        inv={{ id: 'fd', name: 'Term deposit', riskScore: 1 }}
        userProfile={{ profileId: '64b000000000000000000001', age: 30, monthly_take_home: 100000 }}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: /Exact-product tax illustration/i }));
    const income = screen.getByLabelText(/Annual Gross Income/i);
    expect(income).toHaveValue(null);
    expect(screen.getByLabelText(/Income source/i)).toBeVisible();
    expect(screen.getByLabelText(/Tax Regime/i)).toBeVisible();
    const fiscalYear = screen.getByLabelText('Fiscal Year');
    const age = screen.getByLabelText(/Your age on March 31/i);
    expect(age).toHaveValue(null);
    expect(screen.getByRole('button', { name: /Apply & Calculate/i })).toBeVisible();

    fireEvent.change(age, { target: { value: '30' } });
    fireEvent.change(fiscalYear, { target: { value: 'FY2025-26' } });
    expect(age).toHaveValue(null);
    fireEvent.change(age, { target: { value: '31' } });
    fireEvent.change(screen.getByLabelText(/Annual Gross Income/i), { target: { value: '1000000' } });
    fireEvent.change(screen.getByLabelText(/Income source/i), { target: { value: 'salary' } });
    fireEvent.change(screen.getByLabelText(/Tax Regime/i), { target: { value: 'new' } });
    fireEvent.click(screen.getByRole('button', { name: /Apply & Calculate/i }));
    await waitFor(() => expect(api.rankInvestmentCandidates).toHaveBeenCalledTimes(2));
    expect(api.rankInvestmentCandidates.mock.calls[1][2]).toMatchObject({
      fiscalYear: 'FY2025-26',
      userAge: 31,
    });
  });

  it('requires an explicit STT assumption and sends only user-entered tax context to the backend', async () => {
    const product = {
      id: 'etf:isin:INF204KB14I2',
      canonicalProductId: 'etf:isin:INF204KB14I2',
      name: 'Nifty 50 ETF',
      parentInstrumentId: 'nifty_etf',
      postTaxAnalysis: {
        status: 'REQUIRES_TAX_INPUTS',
        requiredTaxInputs: [
          'annualGrossIncome', 'incomeSource', 'regime', 'fiscalYear', 'userAge',
          'holdingPeriodMonths', 'section112AExemptionUsed', 'sttConditionAssumedSatisfied',
        ],
      },
    };
    api.rankInvestmentCandidates
      .mockResolvedValueOnce({ financialStateBinding: CURRENT_STATE_BINDING, ranking: { status: 'VERIFIED_COMPARABLE_OPTIONS' }, products: [product] })
      .mockResolvedValueOnce({
        financialStateBinding: CURRENT_STATE_BINDING,
        ranking: { status: 'VERIFIED_COMPARABLE_OPTIONS' },
        products: [{ ...product, postTaxAnalysis: { status: 'CALCULATED', postTaxRatePct: 8.2 } }],
      });

    render(
      <WhereToInvestTab
        inv={{ id: 'nifty_etf', name: 'Nifty 50 ETF', riskScore: 3 }}
        userProfile={{ profileId: CURRENT_STATE_BINDING.profileId, age: 31 }}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: /Exact-product tax illustration/i }));
    const sttAssumption = screen.getByRole('checkbox', {
      name: /Assume the applicable STT condition is satisfied for this hypothetical transfer/i,
    });
    expect(sttAssumption).not.toBeChecked();
    expect(screen.getByText(/does not verify that an actual transaction meets the condition/i)).toBeVisible();
    fireEvent.submit(screen.getByRole('button', { name: /Apply & Calculate/i }).closest('form'));
    expect(screen.getByText(/Confirm the explicit STT assumption/i)).toBeVisible();
    expect(api.rankInvestmentCandidates).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText(/Annual Gross Income/i), { target: { value: '7500000' } });
    fireEvent.change(screen.getByLabelText(/Income source/i), { target: { value: 'salary' } });
    fireEvent.change(screen.getByLabelText(/Tax Regime/i), { target: { value: 'new' } });
    fireEvent.change(screen.getByLabelText('Fiscal Year'), { target: { value: 'FY2026-27' } });
    fireEvent.change(screen.getByLabelText(/Your age/i), { target: { value: '31' } });
    fireEvent.change(screen.getByLabelText(/Your holding period/i), { target: { value: '18' } });
    fireEvent.change(screen.getByLabelText(/Annual equity long-term gains exclusion already used/i), { target: { value: '0' } });
    fireEvent.click(sttAssumption);
    fireEvent.click(screen.getByRole('button', { name: /Apply & Calculate/i }));

    await waitFor(() => expect(api.rankInvestmentCandidates).toHaveBeenCalledTimes(2));
    const requestContext = api.rankInvestmentCandidates.mock.calls[1][2];
    expect(requestContext).toMatchObject({
      illustrativePrincipal: 10000,
      annualGrossIncome: 7500000,
      incomeSource: 'salary',
      regime: 'new',
      fiscalYear: 'FY2026-27',
      userAge: 31,
      holdingPeriodMonths: 18,
      section112AExemptionUsed: 0,
      sttConditionAssumedSatisfied: true,
    });
    expect(requestContext).not.toHaveProperty('deductions');
  });
});
