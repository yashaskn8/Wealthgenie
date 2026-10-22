import { test, expect, type Page, type Request, type Response } from '@playwright/test';
import { expectCurrentFinancialBinding } from './financial-state-assertions';

declare const process: { env: { VITE_API_URL?: string } };

const API_BASE_URL = (process.env.VITE_API_URL || 'http://127.0.0.1:5000/api').replace(/\/$/, '');
const apiUrl = (pathname: string) => `${API_BASE_URL}${pathname}`;

function apiResponse(method: string, pathname: string) {
  return (response: Response) => {
    const url = new URL(response.url());
    return response.request().method() === method && url.pathname === pathname;
  };
}

async function assertNoSensitiveBrowserStorage(page: Page) {
  const storage = await page.evaluate(() => ({
    local: Object.fromEntries(Object.entries(localStorage)),
    session: Object.fromEntries(Object.entries(sessionStorage)),
  }));
  const serialized = JSON.stringify(storage);
  expect(serialized).not.toMatch(/wg_token|wg_user|wg_profile|wealthgenie_user_profile/i);
  expect(serialized).not.toMatch(/"token"\s*:|monthly_income|monthly_savings|liquid_savings/i);
}

test.describe('real WealthGenie dependency lifecycle', () => {
  test('signup, profile, recommendation, products, market, simulations, tax, grounded chat, session, and logout', async ({ page, context }) => {
    test.setTimeout(360_000);
    const consoleErrors: string[] = [];
    const prohibitedBrowserProviderRequests: string[] = [];
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', error => consoleErrors.push(error.message));
    page.on('request', request => {
      if (/(?:nseindia\.com|amfiindia\.com|sbi\.bank|indiapost\.gov\.in|integrate\.api\.nvidia\.com|api\.groq\.com|generativelanguage\.googleapis\.com)/i.test(request.url())) {
        prohibitedBrowserProviderRequests.push(request.url());
      }
    });
    const unique = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const user = {
      name: `E2E User ${unique}`,
      // Joi validates public DNS TLDs; example.com is the reserved, valid
      // documentation domain for non-deliverable automated identities.
      email: `e2e-${unique}@example.com`,
      mobile: '9876543210',
      password: 'Valid@Pass2026!',
    };

    await page.goto('/login');
    await page.locator('#login-view a', { hasText: 'Register' }).click();
    await page.locator('#reg-name').fill(user.name);
    await page.locator('#reg-email').fill(user.email);
    await page.locator('#reg-mobile').fill(user.mobile);
    await page.locator('#reg-password').fill(user.password);
    await page.locator('#reg-confirm-password').fill(user.password);

    const registrationPromise = page.waitForResponse(apiResponse('POST', '/api/auth/register'));
    await page.locator('#register-form button[type="submit"]').click();
    const registration = await registrationPromise;
    expect(registration.status()).toBe(201);
    await expect(page.getByRole('heading', { name: 'Registration Successful!' })).toBeVisible();
    await page.locator('.popup-card button', { hasText: 'OK' }).click();
    await expect(page).toHaveURL(/\/profile$/);

    const profileScrollRegion = page.getByTestId('profile-scroll-region');
    const scrollMetrics = await profileScrollRegion.evaluate(element => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: getComputedStyle(element).overflowY,
    }));
    expect(scrollMetrics.overflowY).toBe('auto');
    expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
    await profileScrollRegion.evaluate(element => element.scrollTo(0, element.scrollHeight));
    await expect(page.getByTestId('profile-save')).toBeVisible();

    await page.getByTestId('profile-input-monthly_take_home').fill('90000');
    await page.getByTestId('profile-input-monthly_savings').fill('25000');
    await page.getByTestId('profile-input-age').fill('34');
    const horizonInput = page.getByTestId('profile-input-investment_horizon_years');
    await horizonInput.focus();
    await horizonInput.press('Home');
    for (let year = 1; year < 12; year += 1) {
      await horizonInput.press('ArrowRight');
    }
    await page.getByRole('button', { name: 'Moderate', exact: true }).click();
    // The restored main-branch design intentionally hides the native checkbox
    // and makes the enclosing pill label the visible interaction target.
    await page.locator('label.goal-checkbox', { hasText: 'Wealth Growth' }).click();
    await expect(page.getByLabel('Wealth Growth', { exact: true })).toBeChecked();

    const precomputeResponses: Response[] = [];
    const initialRecommendationPosts: string[] = [];
    const lifecycleResponseListener = (response: Response) => {
      const url = new URL(response.url());
      if (response.request().method() === 'POST' && url.pathname === '/api/profile/precompute') {
        precomputeResponses.push(response);
      }
    };
    const lifecycleRequestListener = (request: Request) => {
      const url = new URL(request.url());
      if (request.method() === 'POST' && url.pathname === '/api/recommend') {
        initialRecommendationPosts.push(request.url());
      }
    };
    page.on('response', lifecycleResponseListener);
    page.on('request', lifecycleRequestListener);
    const completionPromise = page.waitForResponse(apiResponse('POST', '/api/profile/complete'), { timeout: 120_000 });
    await page.getByTestId('profile-save').click();

    const completionResponse = await completionPromise;
    expect(completionResponse.status()).toBe(200);
    const completionBody = await completionResponse.json();
    expect(completionBody).toMatchObject({
      profile: expect.any(Object),
      recommendation: expect.any(Object),
      completion: expect.any(Object),
    });
    expect(completionBody.profile.profileId).toMatch(/^[0-9a-f]{24}$/i);
    expect(completionBody.completion.candidateHit).toEqual(expect.any(Boolean));
    expect(completionBody.completion.recomputed).toEqual(expect.any(Boolean));
    const profile = completionBody.profile;
    expect(profile).toMatchObject({
      sold_property_proceeds: null,
      has_lump_sum: null,
      lump_sum_amount: null,
      liquid_savings: null,
      emi_burden_pct: null,
      financial_dependents: null,
      emergency_fund_months: null,
      final_suitability_risk: 'Conservative',
    });

    const precomputeResponse = precomputeResponses[0];
    if (precomputeResponse) {
      expect([200, 503]).toContain(precomputeResponse.status());
      const precomputeBody = await precomputeResponse.json();
      if (precomputeResponse.status() === 200) {
        expect(precomputeBody.candidateId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      } else {
        expect(precomputeBody.code).toBe('PROFILE_PRECOMPUTE_UNAVAILABLE');
      }
    }

    const advisory = completionBody.recommendation;
    expectCurrentFinancialBinding(advisory, {
      profileId: profile.profileId,
      profileVersion: Number(profile.version),
    });
    expect(String(advisory.recommendationId)).toMatch(/^[0-9a-f]{24}$/i);
    expect(String(advisory.audit_id)).toMatch(/^[0-9a-f]{24}$/i);
    expect(advisory.instruments.length).toBeGreaterThan(0);
    expect(advisory.instruments.reduce((sum: number, item: { allocationWeight: number }) => sum + Number(item.allocationWeight), 0)).toBeCloseTo(1, 6);
    expect(advisory.return_data_class).toBe('MODEL_ASSUMPTION');
    expect(advisory.provider_forecast).toBe(false);
    expect(advisory.ml_fallback).toBe(true);
    expect(advisory.optional_profile_fields_unknown).toEqual([
      'soldPropertyProceeds', 'hasLumpSum', 'lumpSumAmount', 'liquidSavings', 'emiBurdenPct',
      'financialDependents', 'emergencyFundMonths',
    ]);
    expect(advisory.ml_input_fields_unknown).toEqual([
      'hasLumpSum', 'liquidSavings', 'emiBurdenPct', 'financialDependents', 'emergencyFundMonths',
    ]);
    expect(initialRecommendationPosts).toEqual([]);
    await expect(page.locator('aside.sidebar')).toBeVisible();
    page.off('response', lifecycleResponseListener);
    page.off('request', lifecycleRequestListener);

    await page.getByTestId('nav-profile').click();
    await page.getByTestId('profile-edit').click();
    await page.getByTestId('profile-input-monthly_savings').fill('27000');
    const profileUpdatePromise = page.waitForResponse(apiResponse('PUT', `/api/profile/${profile.profileId}`));
    await page.getByTestId('profile-save').click();
    const profileUpdate = await profileUpdatePromise;
    expect(profileUpdate.status()).toBe(200);
    const profileUpdateBody = await profileUpdate.json();
    expect(profileUpdateBody).toMatchObject({
      profile: expect.any(Object),
      recommendation: expect.any(Object),
    });
    const updatedProfile = profileUpdateBody.profile;
    expect(updatedProfile.monthly_savings).toBe(27000);
    expect(profileUpdateBody.recommendation.profile_version).toBe(updatedProfile.version);
    expect(profileUpdateBody.recommendation.response_state).toBe('CURRENT');
    await expect(page.getByTestId('profile-edit')).toBeVisible();
    expect(String(profileUpdateBody.recommendation.recommendationId)).toMatch(/^[0-9a-f]{24}$/i);
    expectCurrentFinancialBinding(profileUpdateBody.recommendation, {
      profileId: profile.profileId,
      profileVersion: Number(updatedProfile.version),
    });

    const csrfCookie = (await context.cookies()).find(cookie => cookie.name === 'wg_csrf');
    expect(csrfCookie?.value).toBeTruthy();
    const writeHeaders = () => ({
      'X-CSRF-Token': csrfCookie!.value,
      'Idempotency-Key': crypto.randomUUID(),
      Origin: new URL(page.url()).origin,
    });

    const wtiResponse = await page.request.post(apiUrl('/instruments/rank-wti'), {
      data: {
        profileId: profile.profileId,
        profileVersion: Number(profileUpdateBody.recommendation.profile_version),
        recommendationId: profileUpdateBody.recommendation.recommendationId,
        expectedAllocationRevision: Number(profileUpdateBody.recommendation.allocation_revision),
        expectedAllocationRevisionId: profileUpdateBody.recommendation.allocation_revision_id,
        expectedPortfolioFingerprint: profileUpdateBody.recommendation.portfolio_fingerprint,
        expectedRecommendationFingerprint: profileUpdateBody.recommendation.recommendation_fingerprint,
        parentInstrumentId: 'liquid_mf',
      },
      headers: writeHeaders(),
      timeout: 120_000,
    });
    expect(wtiResponse.status()).toBe(200);
    const wti = await wtiResponse.json();
    expect(wti.total).toBeGreaterThanOrEqual(0);
    expect(wti.total).toBeLessThanOrEqual(5);
    expect(wti.products).toHaveLength(wti.total);
    for (const product of wti.products) {
      expect(typeof product.provider).toBe('string');
      expect(product.provider.trim().length).toBeGreaterThan(0);
      expect(product.expectedReturn).toBeNull();
      expect(product.nominalReturn).toBeNull();
      expect(product.source?.provider).toBe('AMFI');
    }

    const marketResponse = await page.request.get(apiUrl('/regime/current'), { timeout: 120_000 });
    expect(marketResponse.status()).toBe(200);
    const market = await marketResponse.json();
    expect(['MARKET_CONTEXT_AVAILABLE', 'MARKET_CONTEXT_UNAVAILABLE']).toContain(market.status);
    if (market.status === 'MARKET_CONTEXT_AVAILABLE') {
      expect(['NORMAL', 'CAUTIOUS', 'HIGH_VOLATILITY', 'RISK_OFF']).toContain(market.context);
      expect(market.sources.some((source: { provider?: string }) => source.provider === 'NSE')).toBe(true);
      expect(market.observedAt).toBeTruthy();
      expect(market.freshness).toBeTruthy();
    } else {
      expect(market.context).toBeNull();
      expect(market.reasonCodes.length).toBeGreaterThan(0);
    }

    const adjustmentResponse = await page.request.post(apiUrl('/regime/adjust'), {
      data: { profileId: profile.profileId },
      headers: writeHeaders(),
      timeout: 120_000,
    });
    expect(adjustmentResponse.status()).toBe(200);
    const adjustment = await adjustmentResponse.json();
    expect(adjustment.introducedInstrumentIds).toEqual([]);
    expect(adjustment.suitabilityRevalidated).toBe(true);
    expect(adjustment.concentrationCapsRevalidated).toBe(true);
    expect(adjustment.actualTotalTiltPct).toBeLessThanOrEqual(adjustment.maxTotalTiltPct);
    expect(Object.keys(adjustment.adjustedWeights).sort()).toEqual(
      profileUpdateBody.recommendation.instruments.map((item: { id: string }) => item.id).sort(),
    );

    const supportedInstrumentIds = [
      ...new Set(profileUpdateBody.recommendation.instruments.map((item: { id: string }) => item.id)),
    ];
    const projectionResponse = await page.request.post(apiUrl('/projection'), {
      data: {
        profileId: profile.profileId,
        instruments: supportedInstrumentIds.slice(0, 5),
        monthly_investment: 20000,
        years: [5, 12],
      },
      headers: writeHeaders(),
    });
    expect(projectionResponse.status()).toBe(200);
    const projection = await projectionResponse.json();
    expect(projection.return_data_class).toBe('MODEL_ASSUMPTION');
    expect(projection.return_assumption_source).toBe('WEALTHGENIE_MODEL_POLICY');
    expect(projection.observed_market_fact).toBe(false);
    expect(projection.provider_forecast).toBe(false);

    const monteCarloResponse = await page.request.post(apiUrl('/montecarlo/montecarlo'), {
      data: {
        profileId: profile.profileId,
        instrument: supportedInstrumentIds[0],
        monthly_investment: 20000,
        years: 5,
        target_amount: 1500000,
      },
      headers: writeHeaders(),
    });
    expect(monteCarloResponse.status()).toBe(200);
    const monteCarlo = await monteCarloResponse.json();
    expect(monteCarlo.return_data_class).toBe('MODEL_ASSUMPTION');
    expect(monteCarlo.provider_forecast).toBe(false);
    expect(monteCarlo.simulations_run).toBeGreaterThan(0);
    expect(monteCarlo.percentile_labels.p50).toBe('Simulated median');

    await page.getByTestId('nav-allocation').click();
    await expect(page.getByRole('heading', { name: /Where to Invest Your Money/i })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Investment allocation breakdown donut chart' })).toBeVisible();

    const planReviewQueuedPromise = page.waitForResponse(apiResponse('POST', '/api/agent/plan-review'), { timeout: 30_000 });
    await page.getByRole('button', { name: 'Run plan review' }).click();
    const planReviewQueuedResponse = await planReviewQueuedPromise;
    expect(planReviewQueuedResponse.status()).toBe(202);
    const queuedPlanReview = await planReviewQueuedResponse.json();
    expect(queuedPlanReview).toMatchObject({
      status: 'QUEUED',
      currentStateMatch: true,
      profileId: profile.profileId,
    });
    expect(queuedPlanReview.planReviewSnapshotHash).toMatch(/^[a-f0-9]{64}$/i);
    expect(queuedPlanReview.runId).toBeTruthy();
    await expect(page.getByText('Review complete', { exact: true })).toBeVisible({ timeout: 120_000 });

    const completedPlanReviewResponse = await page.request.get(
      apiUrl(`/agent/plan-review/${encodeURIComponent(queuedPlanReview.runId)}`),
    );
    expect(completedPlanReviewResponse.status()).toBe(200);
    const completedPlanReview = await completedPlanReviewResponse.json();
    expect(['COMPLETED', 'WAITING_FOR_APPROVAL']).toContain(completedPlanReview.status);
    expect(completedPlanReview).toMatchObject({
      runId: queuedPlanReview.runId,
      currentStateMatch: true,
      profileId: profile.profileId,
      recommendationId: queuedPlanReview.recommendationId,
      planReviewSnapshotHash: queuedPlanReview.planReviewSnapshotHash,
    });

    const currentRecommendationResponse = await page.request.get(
      apiUrl(`/recommend/current?profileId=${encodeURIComponent(profile.profileId)}`),
    );
    expect(currentRecommendationResponse.status()).toBe(200);
    const currentRecommendation = await currentRecommendationResponse.json();
    expectCurrentFinancialBinding(currentRecommendation, {
      profileId: profile.profileId,
      profileVersion: Number(updatedProfile.version),
    });
    expect(currentRecommendation.recommendation_fingerprint).toBe(profileUpdateBody.recommendation.recommendation_fingerprint);
    expect(currentRecommendation.portfolio_fingerprint).toBe(profileUpdateBody.recommendation.portfolio_fingerprint);
    expect(currentRecommendation.allocation_revision_id).toBe(profileUpdateBody.recommendation.allocation_revision_id);

    await page.getByTestId('nav-goal-planner').click();
    await page.getByRole('button', { name: 'Create Target Goal' }).click();
    await expect(page.getByTestId('goal-form')).toBeVisible();
    await page.getByRole('button', { name: /Emergency Fund/ }).click();
    await page.getByTestId('goal-target-amount').fill('600000');
    const targetYear = new Date().getUTCFullYear() + 4;
    await page.getByTestId('goal-target-date').fill(`${targetYear}-12-31`);
    await page.getByRole('button', { name: 'Next Step' }).click();
    await page.getByTestId('goal-current-savings').fill('100000');
    await page.getByRole('button', { name: 'Medium', exact: true }).click();

    const goalCreatePromise = page.waitForResponse(apiResponse('POST', '/api/goals/create'), { timeout: 90_000 });
    await page.getByTestId('goal-submit').click();
    const goalCreate = await goalCreatePromise;
    expect(goalCreate.status()).toBe(201);
    const goal = await goalCreate.json();
    expect(String(goal.goal.goalId)).toMatch(/^[0-9a-f]{24}$/i);
    await expect(page.getByText('Emergency Fund').first()).toBeVisible();

    await page.getByTestId('nav-tax-optimizer').click();
    await expect(page.getByRole('heading', { name: 'Income Tax Calculator' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Old Regime' })).toHaveCount(0);
    await page.getByLabel('Income category').selectOption('salary');
    await page.getByLabel('Additional ordinary-rate taxable income (₹)').fill('0');
    await page.getByLabel(/Annual taxable gross salary.*before standard deduction/i).fill('1275000.00');
    await page.getByLabel(/Residential status for Tax Year 2026/i).selectOption('resident');
    await page.getByLabel(/Any special-rate income or dividends/i).selectOption('no');
    await page.locator('.wg-new-tax__form').first().locator('.wg-new-tax__confirm input').check();
    const taxPromise = page.waitForResponse(apiResponse('POST', '/api/tax/new-regime-verified'));
    await page.getByRole('button', { name: 'Calculate income tax' }).click();
    const taxResponse = await taxPromise;
    expect(taxResponse.status()).toBe(200);
    const taxRequest = taxResponse.request();
    expect(new URL(taxRequest.url()).search).toBe('');
    expect(JSON.parse(taxRequest.postData() || '{}')).toMatchObject({
      taxYear: '2026-27',
      incomeType: 'salary',
      primaryIncome: '1275000.00',
      otherOrdinaryIncome: '0',
      residency: 'resident',
      specialRateIncome: 'no',
      confirmedOrdinaryOnly: true,
    });
    const tax = await taxResponse.json();
    expect(tax.status).toBe('CALCULATED');
    expect(tax.taxableIncome).toBe('1200000');
    expect(tax.standardDeduction).toBe('75000.0000');
    expect(tax.taxBeforeRebate).toBe('60000.0000');
    expect(tax.rebate).toBe('60000.0000');
    expect(tax.finalTax).toBe('0');
    await expect(page.getByText(/Estimated tax liability under the new regime/i)).toBeVisible();
    await expect(page.getByText(/Rounded under Section 516/i)).toBeVisible();

    // Red-team the exact visible complex calculator, its API and independent tax ledger.
    await page.locator('.wg-new-tax__advanced').nth(1).locator('summary').click();
    const gainsPanel = page.locator('section[aria-label="Verified resident equity capital-gains tax"]');
    await expect(gainsPanel.getByRole('heading', { name: 'Equity capital gains — qualified calculation' })).toBeVisible();
    await gainsPanel.getByLabel('Ordinary income category').selectOption('already_taxable');
    await gainsPanel.getByLabel('Primary ordinary annual income (₹)').fill('1500000');
    await gainsPanel.getByLabel(/Additional ordinary taxable income, excluding gains/).fill('0');
    await gainsPanel.getByLabel(/Net annual qualified STCG/).fill('200000');
    await gainsPanel.getByLabel(/Net annual qualified LTCG/).fill('225000');
    await gainsPanel.getByLabel(/Residency for Tax Year/).selectOption('resident');
    const capitalChecks = gainsPanel.locator('input[type="checkbox"]');
    await expect(capitalChecks).toHaveCount(3);
    for (let i = 0; i < 3; i += 1) await capitalChecks.nth(i).check();
    const capitalPromise = page.waitForResponse(apiResponse('POST', '/api/tax/new-regime-verified-complex'));
    await gainsPanel.getByRole('button', { name: 'Calculate qualified equity-gains tax' }).click();
    const capitalResponse = await capitalPromise;
    expect(capitalResponse.status()).toBe(200);
    const capitalResult = await capitalResponse.json();
    expect(capitalResult.status).toBe('CALCULATED');
    expect(capitalResult.section196Tax).toBe('40000.000');
    expect(capitalResult.section198Tax).toBe('12500.000');
    expect(capitalResult.section198ExemptLongTermGain).toBe('125000');
    expect(capitalResult.finalTax).toBe('163800');
    await expect(gainsPanel.getByText(/Verified restricted-scope tax liability/i)).toBeVisible();
    await expect(gainsPanel.getByText('₹1,63,800').first()).toBeVisible();



    const chatResponsePromise = page.waitForResponse(apiResponse('POST', '/api/chat/message'), { timeout: 90_000 });
    await page.getByRole('button', { name: 'Genie AI' }).click();
    await page.getByLabel('Ask Genie a financial question').fill('Explain why this recommendation fits my saved profile.');
    await page.getByRole('button', { name: 'Send message' }).click();
    const chatResponse = await chatResponsePromise;
    expect(chatResponse.status()).toBe(200);
    const chat = await chatResponse.json();
    expect(chat.grounded).toBe(true);
    expect(chat.validation_status).toBe('PASS');
    expect(chat.evidence_ids_used.length).toBeGreaterThan(0);
    expect(chat.citations.length).toBeGreaterThan(0);
    await expect(page.getByText('Answer evidence and provenance').last()).toBeVisible();
    await page.getByText('Answer evidence and provenance').last().click();
    await expect(page.getByText(/Provider: (DETERMINISTIC_TEMPLATE|NVIDIA_NIM|GEMINI|GROQ)/).last()).toBeVisible();

    const cookies = await context.cookies();
    expect(cookies.find(cookie => cookie.name === 'wg_session')).toMatchObject({ httpOnly: true });
    await assertNoSensitiveBrowserStorage(page);

    const restoreRecommendationPosts: string[] = [];
    const restoreRequestListener = (request: Request) => {
      const url = new URL(request.url());
      if (request.method() === 'POST' && url.pathname === '/api/recommend') restoreRecommendationPosts.push(request.url());
    };
    page.on('request', restoreRequestListener);
    const sessionRestorePromise = page.waitForResponse(apiResponse('GET', '/api/auth/session'));
    const recommendationRestorePromise = page.waitForResponse(apiResponse('GET', '/api/recommend/current'), { timeout: 45_000 });
    await page.reload();
    const restored = await sessionRestorePromise;
    expect(restored.status()).toBe(200);
    const restoredRecommendation = await recommendationRestorePromise;
    expect(restoredRecommendation.status()).toBe(200);
    expectCurrentFinancialBinding(await restoredRecommendation.json(), {
      profileId: profile.profileId,
      profileVersion: Number(updatedProfile.version),
    });
    await expect(page.locator('aside.sidebar')).toBeVisible({ timeout: 45_000 });
    expect(restoreRecommendationPosts).toEqual([]);
    page.off('request', restoreRequestListener);
    await assertNoSensitiveBrowserStorage(page);

    const firstLogoutPromise = page.waitForResponse(apiResponse('POST', '/api/auth/logout'));
    await page.getByTestId('nav-sign-out').click();
    expect((await firstLogoutPromise).status()).toBe(200);
    await expect(page).toHaveURL(/\/login$/);

    await page.locator('#login-email').fill(user.email);
    await page.locator('#login-password').fill(user.password);
    const loginPromise = page.waitForResponse(apiResponse('POST', '/api/auth/login'));
    const loginRecommendationPosts: string[] = [];
    const loginRequestListener = (request: Request) => {
      const url = new URL(request.url());
      if (request.method() === 'POST' && url.pathname === '/api/recommend') loginRecommendationPosts.push(request.url());
    };
    page.on('request', loginRequestListener);
    const loginRecommendationRestorePromise = page.waitForResponse(apiResponse('GET', '/api/recommend/current'), { timeout: 45_000 });
    await page.locator('#login-form button[type="submit"]').click();
    expect((await loginPromise).status()).toBe(200);
    const loginRestoredRecommendation = await loginRecommendationRestorePromise;
    expect(loginRestoredRecommendation.status()).toBe(200);
    expectCurrentFinancialBinding(await loginRestoredRecommendation.json(), {
      profileId: profile.profileId,
      profileVersion: Number(updatedProfile.version),
    });
    await expect(page.locator('aside.sidebar')).toBeVisible({ timeout: 45_000 });
    expect(loginRecommendationPosts).toEqual([]);
    page.off('request', loginRequestListener);

    const finalLogoutPromise = page.waitForResponse(apiResponse('POST', '/api/auth/logout'));
    await page.getByTestId('nav-sign-out').click();
    expect((await finalLogoutPromise).status()).toBe(200);
    await expect(page).toHaveURL(/\/login$/);
    expect((await context.cookies()).some(cookie => cookie.name === 'wg_session')).toBe(false);
    await assertNoSensitiveBrowserStorage(page);
    expect(prohibitedBrowserProviderRequests).toEqual([]);
    // Chromium reports intentionally handled 401/404 probes and blocked
    // decorative remote media as generic resource-load console errors. Keep
    // page exceptions and actual application console errors authoritative.
    expect(consoleErrors.filter(message => !message.startsWith('Failed to load resource:'))).toEqual([]);
  });
});
