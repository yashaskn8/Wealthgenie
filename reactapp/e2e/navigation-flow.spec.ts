import { test, expect } from '@playwright/test';
import {
  currentFinancialState,
  installUnexpectedApiGuard,
  mockTaxPolicyCatalog,
  mockUnavailableSimulation,
} from './fixtures/currentFinancialState.js';

const MARKET_CONTEXT_MOCK = {
  status: 'MARKET_CONTEXT_AVAILABLE',
  context: 'CAUTIOUS',
  classification: 'DETERMINISTIC_POLICY_HEURISTIC',
  policyVersion: 'market-context-policy-1.0.0',
  observedAt: '2026-09-09T10:00:00.000Z',
  evaluatedAt: '2026-09-09T14:46:01.694Z',
  freshness: { status: 'FRESH' },
  reasonCodes: [
    'DRAWDOWN_AT_OR_BELOW_CAUTIOUS_THRESHOLD',
    'PRICE_BELOW_MA50',
  ],
  signals: {
    nifty50Current: { value: 23431.5, unit: 'INDEX_POINTS', available: true },
    nifty50PreviousClose: { value: 23635.1, unit: 'INDEX_POINTS', available: true },
    indiaVixCurrent: { value: 11.94, unit: 'INDEX_POINTS', available: true },
    return1DayPct: { value: -0.86, unit: 'PERCENT', available: true },
    return5DayPct: { value: -2.02, unit: 'PERCENT', available: true },
    return20DayPct: { value: -4.11, unit: 'PERCENT', available: true },
    drawdownFromRecentHighPct: { value: -11.15, unit: 'PERCENT', available: true },
    movingAverage50Day: { value: 24196.32, unit: 'INDEX_POINTS', available: true },
    movingAverage200Day: { value: 24583.9, unit: 'INDEX_POINTS', available: true },
    priceVsMovingAverage50Pct: { value: -3.16, unit: 'PERCENT', available: true },
    priceVsMovingAverage200Pct: { value: -4.69, unit: 'PERCENT', available: true },
    realizedVolatility20DayAnnualizedPct: { value: 5.67, unit: 'PERCENT', available: true },
  },
  sources: [
    { provider: 'NSE', instrumentId: 'NIFTY 50', dataClass: 'LIVE' },
  ],
  marketSnapshot: {
    schemaVersion: 'market-snapshot-1.0.0',
    status: 'CURRENT',
    availability: 'AVAILABLE',
    providerStatus: {
      quotes: { provider: 'NSE', status: 'AVAILABLE' },
      history: { provider: 'NSE', status: 'AVAILABLE' },
    },
    observedFacts: [],
    derivedFacts: [],
    policyOutput: {
      semanticClass: 'POLICY_OUTPUT',
      dataClass: 'POLICY_OUTPUT',
      status: 'MARKET_CONTEXT_AVAILABLE',
      reasonCodes: [],
      policyVersion: 'market-context-policy-1.0.0',
    },
    provenance: { sources: [{ provider: 'NSE', instrumentId: 'NIFTY 50', dataClass: 'LIVE' }] },
    observedAt: '2026-09-09T10:00:00.000Z',
    evaluatedAt: '2026-09-09T14:46:01.694Z',
    marketSession: { status: 'MARKET_OPEN', tradingDate: '2026-09-09' },
  },
};

let unexpectedApiRequests: string[] = [];
const NAV_INSTRUMENTS = [
  {
    id: 'ppf',
    name: 'Public Provident Fund (PPF)',
    type: 'PPF',
    assetClass: 'Sovereign',
    riskLevel: 'Low',
    allocationWeight: 0.6,
    allocation_pct: 60,
    nominalReturn: 7.1,
    effectiveYield: 7.1,
    riskScore: 1,
    lockIn: 15,
    expenseRatio: 0,
    score: 88,
    tags: ['Government', 'Sovereign'],
    returnBasis: 'PRE_TAX_NOMINAL',
    postTaxReturn: null,
    scoreFactors: { goalFit: 90, liquidity: 30 },
  },
  {
    id: 'index_mf',
    name: 'Nifty 50 Index Fund',
    type: 'Index_MF',
    assetClass: 'Equity',
    riskLevel: 'Medium',
    allocationWeight: 0.4,
    allocation_pct: 40,
    nominalReturn: 12,
    effectiveYield: 12,
    riskScore: 3,
    lockIn: 0,
    expenseRatio: 0.002,
    score: 82,
    tags: ['Large Cap', 'Equity'],
    returnBasis: 'PRE_TAX_NOMINAL',
    postTaxReturn: null,
    scoreFactors: { goalFit: 85, liquidity: 90 },
  },
];
const NAV_CURRENT_STATE = currentFinancialState({
  profileId: '64b000000000000000000002',
  profileVersion: 1,
  recommendationId: '64b0000000000000000000b2',
  instruments: NAV_INSTRUMENTS,
  monthlyAllocations: { ppf: 15000, index_mf: 10000 },
});

test.describe('Beginner-First Navigation Architecture E2E Journey', () => {
  test.beforeEach(async ({ page }) => {
    unexpectedApiRequests = await installUnexpectedApiGuard(page);
    await mockTaxPolicyCatalog(page);
    // Financial Indicators is opened by the tablet-tab journey. Mock its
    // exact owned-profile endpoint with a contract-shaped synthetic response,
    // rather than weakening the unexpected-API guard for arbitrary requests.
    await page.route('**/api/profile/64b000000000000000000002/health-score', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          calculation_classification: 'PROFILE_GROUNDED_FINANCIAL_HEALTH',
          methodology_version: 'financial-health-1.0.0',
          score: 60,
          grade: 'Good',
          sub_scores: [
            { label: 'Savings Capacity', value: 70, weight: 30, extra: 'Synthetic savings fixture' },
            { label: 'Emergency Safety Net', value: 100, weight: 25, extra: 'Synthetic emergency-fund fixture' },
            { label: 'Investment Variety', value: 67, weight: 20, extra: 'Synthetic diversity fixture' },
            { label: 'Tax Efficiency', value: null, weight: 0, extra: 'No income tax score in Financial Profile' },
            { label: 'Goal Coverage', value: 100, weight: 15, extra: 'Synthetic goal-coverage fixture' },
            { label: 'Risk-Timeline Match', value: 50, weight: 10, extra: 'Synthetic suitability fixture' },
          ],
          peer_comparison: null,
        }),
      });
    });
    await page.route('**/api/goals', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ goals: [] }),
      });
    });
    await mockUnavailableSimulation(page, 'projection/custom-portfolio');
    await mockUnavailableSimulation(page, 'montecarlo/portfolio');
    // 0. Disable onboarding modal so it does not intercept clicks
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem('wg_onboarded', 'true');
      } catch {
        // ignore
      }
    });

    // 1. Auth session
    await page.route('**/api/auth/session', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'usr_test_nav', name: 'Aarav Patel', email: 'aarav@example.com' },
          csrfToken: 'test-csrf-token-nav',
        }),
      });
    });

    // 2. Profile
    await page.route('**/api/profile/current', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          profileId: '64b000000000000000000002',
          age: 30,
          monthly_take_home: 90000,
          monthly_savings: 25000,
          investment_goals: ['Wealth Growth'],
          investment_horizon_years: 7,
          liquid_savings: 400000,
          emi_burden_pct: 0,
          financial_dependents: 1,
          emergency_fund_months: 6,
          risk_tolerance: 'Moderate',
          version: 1,
        }),
      });
    });

    // Dashboard restore uses GET current; this navigation suite does not
    // perform a recommendation generation.
    await page.route('**/api/recommend/current**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(NAV_CURRENT_STATE),
      });
    });

    // 4. Market context
    await page.route('**/api/regime/current', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MARKET_CONTEXT_MOCK),
      });
    });

    // 5. WTI rank
    await page.route('**/api/instruments/rank-wti', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          total: 1,
          excluded: [],
          suitability: { status: 'SUITABLE', riskReconciliation: { final_risk_tier: 'MEDIUM' } },
          catalog: {
            dataClass: 'REFERENCE_METADATA',
            title: 'Where to invest in Public Provident Fund (PPF)',
            note: 'Only the qualified provider response supplies current product facts.',
            howToStart: 'Open a PPF account through a qualified government channel.',
            riskLevel: 1,
            providerCoverage: {
              parentInstrumentId: 'ppf',
              parentName: 'Public Provident Fund (PPF)',
              canBeRecommended: true,
              qualifiedWtiProvider: 'GOVERNMENT_OF_INDIA',
              productOptionsAvailable: true,
              status: 'QUALIFIED_PROVIDER_PATH',
              currentFailureMode: 'QUALIFIED_PROVIDER_RESPONSE_REQUIRED',
              productSubstitutionAllowed: false,
            },
          },
          ranking: {
            status: 'VERIFIED_COMPARABLE_OPTIONS',
            authority: 'GOVERNMENT_OF_INDIA',
            reasonCodes: ['OFFICIAL_SOURCE_FACT_VERIFIED', 'SINGLE_CANONICAL_PRODUCT', 'MERIT_RANKING_NOT_CLAIMED'],
          },
          comparisonUniverse: { verifiedProductCount: 1, disclosure: 'One qualified government product is available.' },
          products: [
            {
              id: 'government:india-post:ppf',
              canonicalProductId: 'government:india-post:ppf',
              parentInstrumentId: 'ppf',
              productType: 'SMALL_SAVINGS',
              presentationStatus: 'VERIFIED_COMPARABLE_OPTION',
              rank: 1,
              tiedRank: 1,
              name: 'Public Provident Fund',
              provider: 'Government of India / India Post',
              source: { provider: 'GOVERNMENT_OF_INDIA', instrumentId: 'ppf', url: 'https://www.indiapost.gov.in/' },
              officialRate: {
                value: 7.1,
                unit: 'PERCENT_PER_ANNUM',
                basis: 'OFFICIAL_NOMINAL_RATE_PER_ANNUM',
                dataClass: 'QUARTERLY_OFFICIAL_RATE',
              },
              expectedReturn: null,
              nominalReturn: null,
              effectiveYield: null,
              postTaxReturn: null,
              risk: { level: 'Very Low Risk' },
              beginnerSuitability: {
                whyThisFitsYou: 'Fits the verified low-risk government savings category.',
                riskTier: 'Very Low Risk',
                accessToMoney: '15-year lock-in with partial withdrawals',
                verifiedFactLabel: 'Current official rate',
                verifiedFactValue: '7.10% p.a.',
                sourceProvider: 'Government of India / India Post',
              },
            },
          ],
        }),
      });
    });
  });

  test.afterEach(() => {
    expect(unexpectedApiRequests).toEqual([]);
  });

  test('full beginner journey: Home → Where to Invest → Taxes → Progress → Home comparison with browser history', async ({ page }) => {
    // 1. Visit /profile
    await page.goto('http://127.0.0.1:5173/profile');
    await page.waitForLoadState('networkidle');

    // Verify URL normalized to page=home
    await expect(page).toHaveURL(/page=home/);

    // Verify Home first-viewport plan overview card and CTA
    const heroCard = page.getByTestId('beginner-home-hero');
    await expect(heroCard).toBeVisible();
    await expect(heroCard).toContainText('Plan Overview');
    await expect(heroCard).toContainText('₹25,000/mo');

    const whereToInvestCTA = page.getByTestId('home-cta-where-to-invest');
    await expect(whereToInvestCTA).toBeVisible();

    // 2. Click "See Where to Invest" CTA
    await whereToInvestCTA.click();
    await expect(page).toHaveURL(/page=investments/);
    await expect(page.getByRole('heading', { name: 'Your recommended categories' })).toBeVisible();

    // Verify category selector is in exact backend recommendation order
    const categorySelector = page.getByRole('tablist', { name: 'Recommended investment categories' });
    await expect(categorySelector).toBeVisible();
    await expect(page.getByTestId('wti-category-ppf')).toBeVisible();
    await expect(page.getByTestId('wti-category-index_mf')).toBeVisible();

    // 3. Navigate to Taxes via Sidebar
    await page.getByTestId('nav-taxes').click();
    await expect(page).toHaveURL(/page=taxes&tab=regime-savings/);
    await expect(page.getByTestId('panel-regime-savings')).toBeVisible();
    await expect(page.getByTestId('panel-real-returns')).not.toBeVisible();

    // Switch to Real Returns sub-tab
    await page.getByTestId('tab-real-returns').click();
    await expect(page).toHaveURL(/page=taxes&tab=real-returns/);
    await expect(page.getByTestId('panel-real-returns')).toBeVisible();
    await expect(page.getByTestId('panel-regime-savings')).not.toBeVisible();

    // 4. Navigate to Progress via Sidebar
    await page.getByTestId('nav-progress').click();
    await expect(page).toHaveURL(/page=progress&tab=goals/);
    await expect(page.getByTestId('panel-goals')).toBeVisible();

    // Switch to Keep on Track (Rebalancer) sub-tab
    await page.getByTestId('tab-rebalancer').click();
    await expect(page).toHaveURL(/page=progress&tab=rebalancer/);
    await expect(page.getByTestId('panel-rebalancer')).toBeVisible();
    await expect(page.getByTestId('panel-goals')).not.toBeVisible();

    // 5. Compare investments from Home after retiring the standalone Advanced Hub.
    await page.getByTestId('nav-home').click();
    await expect(page).toHaveURL(/page=home/);
    await page.getByRole('button', { name: /Compare Scenarios/i }).click();
    await expect(page.getByRole('heading', { name: 'Compare Investments' })).toBeVisible();
    await page.locator('.modal-close-btn').click();

    // 6. Test browser Back and Forward
    await page.goBack();
    await expect(page).toHaveURL(/page=progress&tab=rebalancer/);
    await expect(page.getByTestId('panel-rebalancer')).toBeVisible();

    await page.goForward();
    await expect(page).toHaveURL(/page=home/);
    await expect(page.getByTestId('beginner-home-hero')).toBeVisible();
  });

  test('retired Advanced URLs normalize to Home and no Advanced customer navigation remains', async ({ page }) => {
    await page.goto('http://127.0.0.1:5173/profile?page=advanced&tab=diagnostics');
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/page=home/);
    await expect(page.getByTestId('nav-advanced')).toHaveCount(0);
    await expect(page.getByTestId('beginner-home-hero')).toBeVisible();
  });

  test('GenieChat comparison action opens the retained Home comparison flow', async ({ page }) => {
    await page.route('**/api/chat/history**', async route => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: [] }) });
    });
    await page.route('**/api/chat/message', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          response: 'Compare the suitable choices.\n<<<ACTION_CARD>>>\n{"title":"Investment comparison","subtitle":"Open the existing comparison tool.","severity":"info","type":"rebalance","actions":[{"label":"Compare investments","target":"/compare"}]}\n<<<END_ACTION_CARD>>>',
          rate_limit_remaining: 29,
          rate_limit_total: 30,
          grounded: true,
          citations: [],
        }),
      });
    });

    await page.goto('http://127.0.0.1:5173/profile?page=home');
    await page.waitForLoadState('networkidle');
    await page.locator('.genie-fab').click();
    await page.getByRole('textbox', { name: 'Ask Genie a financial question' }).fill('Compare investments');
    await page.getByRole('textbox', { name: 'Ask Genie a financial question' }).press('Enter');
    await page.getByRole('button', { name: 'Compare investments' }).click();

    await expect(page).toHaveURL(/page=home/);
    await expect(page.getByRole('heading', { name: 'Compare Investments' })).toBeVisible();
  });

  test('authenticated mobile navigation opens gated GenieProof and announces the UTF-8 limit', async ({ page }) => {
    await page.route('**/api/genieproof/cases', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ cases: [] }),
      });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('http://127.0.0.1:5173/profile?page=home');
    await page.waitForLoadState('networkidle');

    await page.getByTestId('mobile-nav-more').click();
    const drawer = page.getByRole('dialog', { name: 'More navigation options' });
    await expect(drawer.getByRole('button', { name: /GenieProof/i })).toBeVisible();
    await drawer.getByRole('button', { name: /GenieProof/i }).click();
    await expect(page).toHaveURL(/page=genieproof/);
    await expect(page.getByRole('heading', { name: 'GenieProof claim inspection' })).toBeVisible();
    await expect(page.getByText(/when qualified evidence is unavailable, GenieProof records an abstention/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Enable ProofBreak checks/i })).toHaveCount(0);

    const offer = page.getByLabel('Paste the offer text');
    await offer.fill('₹'.repeat(6000));
    const byteStatus = page.locator('#genieproof-byte-status');
    await expect(byteStatus).toContainText('exceeds the 16,000-byte extraction limit');
    await expect(byteStatus).toHaveAttribute('aria-live', 'polite');
    await expect(page.locator('#genieproof-byte-count')).toContainText('18,000 / 16,000 UTF-8 bytes');
    const extractButton = page.getByRole('button', { name: /extract claims/i });
    await expect(extractButton).toBeDisabled();
    await expect(extractButton).toHaveAttribute('aria-describedby', /genieproof-byte-count genieproof-byte-status/);
    await offer.fill('a'.repeat(16001));
    await expect(offer).toHaveValue('a'.repeat(16001));
    await expect(offer).toHaveJSProperty('maxLength', -1);
    await expect(page.locator('#genieproof-byte-count')).toContainText('16,001 / 16,000 UTF-8 bytes');
    await expect(extractButton).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('tablet viewport (721px): all Progress and Taxes tabs are reachable without clipping', async ({ page }) => {
    await page.setViewportSize({ width: 721, height: 900 });
    await page.goto('http://127.0.0.1:5173/profile?page=progress&tab=goals');
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('mobile-nav-progress')).toBeVisible();

    for (const tab of ['indicators', 'goals', 'plan-goal', 'grow-sip', 'rebalancer']) {
      const button = page.getByTestId(`tab-${tab}`);
      await expect(button).toBeVisible();
      await button.click();
      await expect(page).toHaveURL(new RegExp(`page=progress&tab=${tab}`));
      await expect(page.getByTestId(`panel-${tab}`)).toBeVisible();
      if (tab === 'indicators') {
        await expect(page.locator('.financial-indicators-panel').getByText('Synthetic savings fixture')).toBeVisible();
      }
    }

    await page.getByTestId('mobile-nav-taxes').click();
    await expect(page).toHaveURL(/page=taxes&tab=regime-savings/);
    for (const tab of ['real-returns', 'regime-savings']) {
      const button = page.getByTestId(`tab-${tab}`);
      await expect(button).toBeVisible();
      await button.click();
      await expect(page.getByTestId(`panel-${tab}`)).toBeVisible();
    }
    const tabLists = page.locator('.hub-tabs-list');
    expect(await tabLists.evaluateAll(elements => elements.every(element => {
      const viewportWidth = document.documentElement.clientWidth;
      const bounds = element.getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= viewportWidth
        && [...element.querySelectorAll('button')].every(button => {
          const rect = button.getBoundingClientRect();
          return rect.left >= 0 && rect.right <= viewportWidth;
        });
    }))).toBe(true);
  });

  test('mobile viewport (390px): bottom tab bar, More drawer, focus trap, and Escape handling', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('http://127.0.0.1:5173/profile?page=home');
    await page.waitForLoadState('networkidle');

    // Bottom tab bar has 5 primary items + More
    await expect(page.getByTestId('mobile-nav-home')).toBeVisible();
    await expect(page.getByTestId('mobile-nav-plan')).toBeVisible();
    await expect(page.getByTestId('mobile-nav-investments')).toBeVisible();
    await expect(page.getByTestId('mobile-nav-taxes')).toBeVisible();
    await expect(page.getByTestId('mobile-nav-progress')).toBeVisible();
    const moreBtn = page.getByTestId('mobile-nav-more');
    await expect(moreBtn).toBeVisible();

    // Open More sheet
    await moreBtn.click();
    const drawer = page.getByRole('dialog', { name: 'More navigation options' });
    await expect(drawer).toBeVisible();

    // Press Escape to close and verify focus returns to More button
    await page.keyboard.press('Escape');
    await expect(drawer).not.toBeVisible();
    await expect(moreBtn).toBeFocused();

    // Open More sheet again; retired Advanced navigation is absent.
    await moreBtn.click();
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('button', { name: /Advanced/i })).toHaveCount(0);
    await drawer.getByRole('button', { name: /My Profile & Preferences/i }).click();
    await expect(page).toHaveURL(/page=account/);
    await expect(drawer).not.toBeVisible();
  });
});
