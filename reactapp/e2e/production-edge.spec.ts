import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { expectCurrentFinancialBinding } from './financial-state-assertions';

function csrfHeaders(context: BrowserContext, origin: string) {
  return context.cookies().then(cookies => {
    const csrf = cookies.find(cookie => cookie.name === 'wg_csrf')?.value;
    if (!csrf) throw new Error('The local HTTP integration stack did not issue a CSRF cookie.');
    return {
      'X-CSRF-Token': csrf,
      'Idempotency-Key': `edge-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      Origin: origin,
    };
  });
}

async function register(page: Page, unique: string) {
  const browserErrors: string[] = [];
  const assetFailures: string[] = [];
  page.on('pageerror', error => browserErrors.push(String(error.name || 'Error') + ': ' + String(error.message || '').slice(0, 300)));
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push('console: ' + message.text().slice(0, 300));
  });
  page.on('response', response => {
    const url = new URL(response.url());
    if (response.status() >= 400 && (url.pathname.startsWith('/assets/') || url.pathname === '/login')) {
      assetFailures.push(url.pathname + ': HTTP ' + response.status());
    }
  });
  const navigation = await page.goto('/login');
  const registerLink = page.locator('#login-view a', { hasText: 'Register' });
  try {
    await expect(registerLink, 'Login page must render before any account mutation').toBeVisible({ timeout: 10000 });
  } catch {
    // Log only scrubbed error categories and same-origin asset paths; never
    // dump browser cookies, document HTML, access tokens or request headers.
    throw new Error(JSON.stringify({
      code: 'PRODUCTION_LOGIN_RENDER_FAILED',
      navigationStatus: navigation?.status() ?? null,
      path: new URL(page.url()).pathname,
      browserErrors: browserErrors.slice(0, 8),
      assetFailures: assetFailures.slice(0, 8),
      loginFormCount: await page.locator('#login-view').count(),
      rootChildCount: await page.locator('#root > *').count(),
    }));
  }
  await registerLink.click();
  await page.locator('#reg-name').fill(`Edge E2E ${unique}`);
  await page.locator('#reg-email').fill(`edge-${unique}@example.com`);
  await page.locator('#reg-mobile').fill('9876543210');
  await page.locator('#reg-password').fill('Valid@Pass2026!');
  await page.locator('#reg-confirm-password').fill('Valid@Pass2026!');
  const registration = page.waitForResponse(response => (
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/auth/register'
  ));
  await page.locator('#register-form button[type="submit"]').click();
  expect((await registration).status()).toBe(201);
  await page.locator('.popup-card button', { hasText: 'OK' }).click();
  await expect(page).toHaveURL(/\/profile$/);
}

test('production Nginx edge preserves browser auth and API lifecycle @production-edge', async ({ page, context }) => {
  test.setTimeout(180_000);
  const unique = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  await register(page, unique);

  const origin = new URL(page.url()).origin;
  const session = await page.request.get('/api/auth/session');
  expect(session.status()).toBe(200);
  expect((await session.json()).user).toBeTruthy();

  const completion = await page.request.post('/api/profile/complete', {
    data: {
      monthly_take_home: 100000,
      monthly_savings: 20000,
      age: 35,
      risk_tolerance: 'Moderate',
      sold_property_proceeds: 0,
      has_lump_sum: false,
      lump_sum_amount: 0,
      liquid_savings: 300000,
      emi_burden_pct: 10,
      financial_dependents: 1,
      emergency_fund_months: 6,
      investment_goals: ['Wealth Growth'],
      investment_horizon_years: 10,
    },
    headers: await csrfHeaders(context, origin),
    timeout: 120_000,
  });
  expect(completion.status()).toBe(200);
  const completionBody = await completion.json();
  const profileId = completionBody.profile?.profileId;
  expect(profileId).toMatch(/^[0-9a-f]{24}$/i);
  expectCurrentFinancialBinding(completionBody.recommendation, {
    profileId,
    profileVersion: Number(completionBody.profile.version),
  });

  const currentRecommendation = await page.request.get(`/api/recommend/current?profileId=${profileId}`);
  expect(currentRecommendation.status()).toBe(200);
  expectCurrentFinancialBinding(await currentRecommendation.json(), {
    profileId,
    profileVersion: Number(completionBody.profile.version),
  });

  await page.reload();
  await expect(page.getByTestId('nav-profile')).toBeVisible();

  const logout = await page.request.post('/api/auth/logout', {
    data: {},
    headers: await csrfHeaders(context, origin),
  });
  expect(logout.status()).toBe(200);
  const afterLogout = await page.request.get('/api/auth/session');
  expect(afterLogout.status()).toBe(401);
});
