import { test, expect } from '@playwright/test';
import {
  currentFinancialState,
  installUnexpectedApiGuard,
  mockTaxPolicyCatalog,
  mockUnavailableSimulation,
} from './fixtures/currentFinancialState.js';

const ARTIFACT_DIR = 'test-results';

/**
 * Market context mock — matches GET /api/regime/current
 * (WhereToInvestTab calls api.getCurrentMarketContext → request('GET', '/regime/current'))
 */
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
    'RETURN_20D_AT_OR_BELOW_CAUTIOUS_THRESHOLD',
    'PRICE_BELOW_MA50',
    'HYSTERESIS_CONTEXT_CONFIRMED',
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
    { provider: 'NSE', instrumentId: 'INDIA VIX', dataClass: 'LIVE' },
    { provider: 'NSE', instrumentId: 'NIFTY 50', dataClass: 'DAILY' },
  ],
  marketSnapshot: {
    schemaVersion: 'market-snapshot-1.0.0',
    status: 'CURRENT',
    availability: 'AVAILABLE',
    providerStatus: {
      quotes: { provider: 'NSE', status: 'AVAILABLE' },
      history: { provider: 'NSE', status: 'AVAILABLE' },
    },
    observedFacts: [
      { key: 'nifty50Current', value: 23431.5, dataClass: 'OBSERVED' },
      { key: 'nifty50PreviousClose', value: 23635.1, dataClass: 'OBSERVED' },
      { key: 'indiaVixCurrent', value: 11.94, dataClass: 'OBSERVED' },
    ],
    derivedFacts: [{ key: 'return20DayPct', value: -4.11, dataClass: 'DERIVED' }],
    policyOutput: {
      semanticClass: 'POLICY_OUTPUT',
      dataClass: 'POLICY_OUTPUT',
      status: 'MARKET_CONTEXT_AVAILABLE',
      context: 'CAUTIOUS',
      policyVersion: 'market-context-policy-1.0.0',
      reasonCodes: ['DRAWDOWN_AT_OR_BELOW_CAUTIOUS_THRESHOLD'],
    },
    observedAt: '2026-09-09T10:00:00.000Z',
    evaluatedAt: '2026-09-09T14:46:01.694Z',
    provenance: { sources: [{ provider: 'NSE', instrumentId: 'NIFTY 50', dataClass: 'LIVE' }] },
    marketSession: { status: 'MARKET_OPEN', tradingDate: '2026-09-09' },
    recommendationUsability: { status: 'USABLE', reasonCodes: [], maxAgeSeconds: 900 },
    evidenceRevision: 'd'.repeat(64),
    contentRevision: { version: 'market-snapshot-content-1.1.0', digest: 'c'.repeat(64) },
  },
  recommendationUsability: { status: 'USABLE', reasonCodes: [], maxAgeSeconds: 900 },
};

let unexpectedApiRequests: string[] = [];
const VISUAL_INSTRUMENTS = [{
  id: 'ppf',
  name: 'Public Provident Fund (PPF)',
  type: 'PPF',
  assetClass: 'Sovereign',
  riskLevel: 'Low',
  allocationWeight: 1,
  allocation_pct: 100,
  nominalReturn: 7.1,
  effectiveYield: 7.1,
  riskScore: 1,
  lockIn: 15,
  expenseRatio: 0,
  score: 85,
  tags: ['Government', 'Sovereign'],
  returnBasis: 'PRE_TAX_NOMINAL',
  postTaxReturn: null,
  scoreFactors: { goalFit: 90, liquidity: 30 },
}];
const VISUAL_CURRENT_STATE = currentFinancialState({
  profileId: '64b000000000000000000001',
  profileVersion: 1,
  recommendationId: '64b0000000000000000000b1',
  instruments: VISUAL_INSTRUMENTS,
  monthlyAllocations: { ppf: 30000 },
});
const VISUAL_WTI_BINDING = {
  profileId: VISUAL_CURRENT_STATE.profileId,
  profileVersion: VISUAL_CURRENT_STATE.profile_version,
  recommendationId: VISUAL_CURRENT_STATE.recommendationId,
  allocationRevision: VISUAL_CURRENT_STATE.allocation_revision,
  allocationRevisionId: VISUAL_CURRENT_STATE.allocation_revision_id,
  portfolioFingerprint: VISUAL_CURRENT_STATE.portfolio_fingerprint,
  recommendationFingerprint: VISUAL_CURRENT_STATE.recommendation_fingerprint,
};

test.describe('Market Today Card Visual & Responsive Review', () => {
  test.beforeEach(async ({ page }) => {
    unexpectedApiRequests = await installUnexpectedApiGuard(page);
    await mockTaxPolicyCatalog(page);
    await mockUnavailableSimulation(page, 'projection/compare');
    page.on('console', msg => console.log('BROWSER CONSOLE:', msg.text()));
    page.on('pageerror', err => console.log('BROWSER PAGEERROR:', err.message));

    // ── 0. Set onboarding complete in localStorage so the first-time modal does not block clicks ──
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem('wg_onboarded', 'true');
      } catch {
        // ignore
      }
    });

    // ── 1. Auth session: GET /api/auth/session ──
    await page.route('**/api/auth/session', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'usr_test_1', name: 'Priya Sharma', email: 'priya@example.com' },
          csrfToken: 'test-csrf-token-12345',
        }),
      });
    });

    // ── 2. Current profile: GET /api/profile/current ──
    await page.route('**/api/profile/current', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          profileId: '64b000000000000000000001',
          age: 28,
          monthly_take_home: 100000,
          monthly_savings: 30000,
          investment_goals: ['Wealth Growth'],
          investment_horizon_years: 10,
          liquid_savings: 500000,
          emi_burden_pct: 0,
          financial_dependents: 0,
          emergency_fund_months: 6,
          risk_tolerance: 'Moderate',
          version: 1,
        }),
      });
    });

    // The dashboard restores the current canonical state; these visual-only
    // tests do not exercise a recommendation-generation POST.
    await page.route('**/api/recommend/current**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(VISUAL_CURRENT_STATE),
      });
    });

    // ── 3b. Deferred advisory endpoint ──
    await page.route('**/api/recommend/**/advisory', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...VISUAL_CURRENT_STATE,
          advisory_text: 'Your portfolio is well-suited for your profile.',
          advisory_explanation: { status: 'READY' },
        }),
      });
    });

    // ── 4. Market context: GET /api/regime/current ──
    // WhereToInvestTab calls api.getCurrentMarketContext → request('GET', '/regime/current')
    await page.route('**/api/regime/current', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MARKET_CONTEXT_MOCK),
      });
    });

    // ── 4b. Market adjustment preview: POST /api/regime/adjust ──
    await page.route('**/api/regime/adjust', async route => {
      const request = route.request().postDataJSON();
      expect(request).toEqual({ profileId: VISUAL_WTI_BINDING.profileId });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          applied: false,
          maxTotalTiltPct: 2,
          actualTotalTiltPct: 0,
          baseWeights: { ppf: 1 },
          adjustedWeights: { ppf: 1 },
          adjustedInstruments: VISUAL_INSTRUMENTS,
          reasonCodes: ['NO_LOWER_RISK_ELIGIBLE_TRANSFER_PATH'],
          explanations: [],
          marketContext: MARKET_CONTEXT_MOCK,
          profileId: VISUAL_WTI_BINDING.profileId,
          profile_version: VISUAL_WTI_BINDING.profileVersion,
          recommendationId: VISUAL_WTI_BINDING.recommendationId,
          allocation_revision: VISUAL_WTI_BINDING.allocationRevision,
          allocation_revision_id: VISUAL_WTI_BINDING.allocationRevisionId,
          portfolio_fingerprint: VISUAL_WTI_BINDING.portfolioFingerprint,
          recommendation_fingerprint: VISUAL_WTI_BINDING.recommendationFingerprint,
          persisted: false,
        }),
      });
    });

    // ── 5. WTI product ranking: POST /api/instruments/rank-wti ──
    // WhereToInvestTab calls api.rankInvestmentCandidates → request('POST', '/instruments/rank-wti')
    await page.route('**/api/instruments/rank-wti', async route => {
      const rankingRequest = route.request().postDataJSON();
      expect(rankingRequest).toMatchObject({
        profileId: VISUAL_WTI_BINDING.profileId,
        profileVersion: VISUAL_WTI_BINDING.profileVersion,
        recommendationId: VISUAL_WTI_BINDING.recommendationId,
        expectedAllocationRevision: VISUAL_WTI_BINDING.allocationRevision,
        expectedAllocationRevisionId: VISUAL_WTI_BINDING.allocationRevisionId,
        expectedPortfolioFingerprint: VISUAL_WTI_BINDING.portfolioFingerprint,
        expectedRecommendationFingerprint: VISUAL_WTI_BINDING.recommendationFingerprint,
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          financialStateBinding: VISUAL_WTI_BINDING,
          total: 1,
          excluded: [],
          suitability: { status: 'SUITABLE', riskReconciliation: { final_risk_tier: 'MEDIUM' } },
          catalog: {
            dataClass: 'REFERENCE_METADATA',
            title: 'Where to invest in Public Provident Fund (PPF)',
            note: 'Only the qualified provider response supplies current product facts.',
            howToStart: 'Use a qualified government channel.',
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
            provider: 'GOVERNMENT_OF_INDIA',
            hasUniqueLeader: false,
            reasonCodes: ['OFFICIAL_SOURCE_FACT_VERIFIED', 'SINGLE_CANONICAL_PRODUCT', 'MERIT_RANKING_NOT_CLAIMED'],
          },
          comparisonUniverse: { eligibleProductCount: 1, disclosure: 'One qualified government product is available.' },
          products: [
            {
              id: 'government:india-post:ppf',
              canonicalProductId: 'government:india-post:ppf',
              parentInstrumentId: 'ppf',
              productType: 'SMALL_SAVINGS',
              presentationStatus: 'VERIFIED_COMPARABLE_OPTION',
              rank: 1,
              tiedRank: false,
              name: 'Public Provident Fund',
              provider: 'Government of India / India Post',
              source: { provider: 'GOVERNMENT_OF_INDIA', instrumentId: 'ppf', url: 'https://www.indiapost.gov.in/' },
              officialRate: {
                value: 7.1,
                unit: 'PERCENT_PER_ANNUM',
                basis: 'OFFICIAL_NOMINAL_RATE_PER_ANNUM',
                dataClass: 'QUARTERLY_OFFICIAL_RATE',
                effectiveFrom: '2026-07-01',
                effectiveTo: '2026-09-30',
              },
              nav: null,
              historicalReturn: null,
              expectedReturn: null,
              nominalReturn: null,
              effectiveYield: null,
              postTaxReturn: null,
              riskLevel: null,
              riskScore: null,
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

  test('visual appearance, compactness, and expand/collapse at desktop 1440px', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/profile');

    // Dismiss onboarding modal if present
    const showPlanBtn = page.locator('button:has-text("Show me my plan")');
    if (await showPlanBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await showPlanBtn.click();
    }

    // Wait for recommendation card to render, then click Learn More to open Deep Dive
    const learnMoreBtn = page.locator('button:has-text("Deep Dive"), button:has-text("Learn More")').first();
    await expect(learnMoreBtn).toBeVisible({ timeout: 20000 });
    await learnMoreBtn.scrollIntoViewIfNeeded();
    await learnMoreBtn.click({ force: true });

    // In modal, click "Where to Invest" tab
    const wtiTab = page.locator('.ddm-tab-btn', { hasText: /Where to Invest/i });
    await expect(wtiTab).toBeVisible({ timeout: 10000 });
    const rankingResponse = page.waitForResponse(response => response.url().includes('/api/instruments/rank-wti'));
    await wtiTab.click({ force: true });
    expect((await rankingResponse).status()).toBe(200);

    // Verify "Market today" card renders
    const marketCard = page.locator('.wti-beginner-market-card');
    await expect(marketCard).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.wti-status-banner--error')).toHaveCount(0);

    // Verify CAUTIOUS badge
    await expect(marketCard.locator('.wti-beginner-market-badge')).toHaveText('CAUTIOUS');

    // Verify Beginner summary text
    await expect(marketCard.locator('.wti-beginner-market-headline')).toHaveText('Markets have been weaker recently.');
    await expect(marketCard.locator('.wti-beginner-meaning')).toContainText('What this means for you:');

    // Verify Action buttons
    await expect(marketCard.locator('.wti-preview-plan-btn')).toContainText('See how this affects my plan');
    const techToggle = marketCard.locator('.wti-tech-toggle-btn');
    await expect(techToggle).toBeVisible();
    await expect(techToggle).toHaveAttribute('aria-expanded', 'false');

    // Verify collapsed card height (must be compact ~120-230px)
    const collapsedBox = await marketCard.boundingBox();
    expect(collapsedBox).not.toBeNull();
    console.log(`[DESKTOP 1440px] Collapsed card height: ${collapsedBox?.height}px`);
    expect(collapsedBox!.height).toBeGreaterThanOrEqual(120);
    expect(collapsedBox!.height).toBeLessThanOrEqual(230);

    // Capture screenshot of default collapsed card
    await page.screenshot({
      path: `${ARTIFACT_DIR}/market_today_desktop_collapsed.png`,
      fullPage: false,
    });

    // Click "Technical details" to expand
    await techToggle.click();
    await expect(techToggle).toHaveAttribute('aria-expanded', 'true');
    const techPanel = page.locator('[data-testid="market-context-panel"]');
    await expect(techPanel).toBeVisible();

    // Verify grouped technical metrics
    await expect(page.locator('.wti-tech-group-title', { hasText: 'Market & Benchmark Indicators' })).toBeVisible();
    await expect(page.locator('.wti-tech-group-title', { hasText: 'Trend, Moving Averages & Volatility' })).toBeVisible();
    await expect(page.locator('.wti-tech-group-title', { hasText: 'Evidence & Policy Provenance' })).toBeVisible();

    // Verify humanized labels
    await expect(page.locator('.wti-tech-metric-label', { hasText: 'NIFTY 50' })).toBeVisible();
    await expect(page.locator('.wti-tech-metric-label', { hasText: 'Previous close' })).toBeVisible();
    await expect(page.locator('.wti-tech-metric-label', { hasText: 'India VIX' })).toBeVisible();
    await expect(page.locator('.wti-tech-metric-label', { hasText: '50-day moving average' })).toBeVisible();
    await expect(page.locator('.wti-tech-metric-label', { hasText: '200-day moving average' })).toBeVisible();
    await expect(page.locator('.wti-tech-metric-label', { hasText: 'Drawdown from recent high' })).toBeVisible();

    // Capture screenshot of expanded card
    await page.screenshot({
      path: `${ARTIFACT_DIR}/market_today_desktop_expanded.png`,
      fullPage: false,
    });

    // Collapse again
    await techToggle.click();
    await expect(techToggle).toHaveAttribute('aria-expanded', 'false');
  });

  test('responsive behavior at tablet (768px) and mobile (390px)', async ({ page }) => {
    // 768px Tablet
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.goto('/profile');

    // Dismiss onboarding modal if present
    const showPlanBtn = page.locator('button:has-text("Show me my plan")');
    if (await showPlanBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await showPlanBtn.click();
    }

    const learnMoreBtn = page.locator('button:has-text("Deep Dive"), button:has-text("Learn More")').first();
    await expect(learnMoreBtn).toBeVisible({ timeout: 20000 });
    await learnMoreBtn.scrollIntoViewIfNeeded();
    await learnMoreBtn.click({ force: true });

    const wtiTab = page.locator('.ddm-tab-btn', { hasText: /Where to Invest/i });
    await expect(wtiTab).toBeVisible({ timeout: 10000 });
    await wtiTab.click({ force: true });

    const marketCard = page.locator('.wti-beginner-market-card');
    await expect(marketCard).toBeVisible({ timeout: 10000 });

    const tabletBox = await marketCard.boundingBox();
    console.log(`[TABLET 768px] Collapsed card height: ${tabletBox?.height}px`);
    expect(tabletBox!.height).toBeLessThanOrEqual(260);

    await page.screenshot({
      path: `${ARTIFACT_DIR}/market_today_tablet_768px.png`,
      fullPage: false,
    });

    // 390px Mobile
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileBox = await marketCard.boundingBox();
    console.log(`[MOBILE 390px] Collapsed card height: ${mobileBox?.height}px`);
    expect(mobileBox!.height).toBeLessThanOrEqual(300);

    await page.screenshot({
      path: `${ARTIFACT_DIR}/market_today_mobile_390px.png`,
      fullPage: false,
    });
  });

  test('renders a server-bound before-and-after allocation preview without saving or trading', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/profile');
    const showPlanButton = page.locator('button:has-text("Show me my plan")');
    if (await showPlanButton.isVisible({ timeout: 2000 }).catch(() => false)) await showPlanButton.click();

    const deepDiveButton = page.locator('button:has-text("Deep Dive"), button:has-text("Learn More")').first();
    await expect(deepDiveButton).toBeVisible({ timeout: 20000 });
    await deepDiveButton.scrollIntoViewIfNeeded();
    await deepDiveButton.click({ force: true });
    const wtiTab = page.locator('.ddm-tab-btn', { hasText: /Where to Invest/i });
    await expect(wtiTab).toBeVisible();
    await wtiTab.click({ force: true });

    const previewRequest = page.waitForRequest(request => request.url().includes('/api/regime/adjust') && request.method() === 'POST');
    await page.getByRole('button', { name: 'See how this affects my plan' }).click();
    expect((await previewRequest).postDataJSON()).toEqual({ profileId: VISUAL_WTI_BINDING.profileId });

    const preview = page.getByRole('region', { name: 'Hypothetical plan allocation preview' });
    await expect(preview).toBeVisible();
    await expect(preview.getByText('Cautious')).toBeVisible();
    await expect(preview.getByRole('table')).toContainText('100.00%');
    await expect(preview).toContainText('There is no lower-risk investment in your current suitable plan');
    await expect(preview).toContainText('Your saved plan has not changed; nothing has been bought or sold.');

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(preview).toBeVisible();
    const tableScroller = preview.locator('.wti-preview-table-wrap');
    await expect(tableScroller).toBeVisible();
    await expect(preview.getByRole('table')).toBeVisible();
    await page.screenshot({ path: `${ARTIFACT_DIR}/market_plan_preview_mobile.png`, fullPage: true });
  });
});
