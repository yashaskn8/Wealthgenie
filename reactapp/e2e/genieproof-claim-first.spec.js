import { test, expect } from '@playwright/test';

const routePath = '**/api/genieproof/check';
const now = '2026-10-23T01:00:00.000Z';
const checkResponse = claims => ({
  ok: true,
  mode: 'READ_ONLY_FINANCIAL_CLAIM_CHECK',
  checkedAt: now,
  saved: false,
  completeInputExamined: true,
  claims,
});

test.describe('GenieProof claim-first browser workflow', () => {
  test('checks user-provided wording without presenting passport or saving controls', async ({ page }) => {
    const requests = [];
    await page.route(routePath, route => {
      requests.push(route.request().postDataJSON());
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(checkResponse([{
          claimId: 'a'.repeat(32),
          statement: 'Guaranteed 25% profit.',
          verdict: 'NOT_VERIFIED',
          explanation: 'No qualified evidence is available for this claim.',
          reasonCode: 'CLAIM_NOT_SUPPORTED',
          source: null,
          warningSignals: ['Guarantee or risk-free wording needs independently checked product terms.'],
        }])),
      });
    });
    await page.goto('/e2e/fixtures/genieproof-claim-harness.html');
    await expect(page.getByRole('heading', { name: /GenieProof.*Check a financial claim/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check claim' })).toBeDisabled();
    await expect(page.getByText(/passport|signing key|save private/i)).toHaveCount(0);
    await page.getByLabel('Financial statement to check').fill('Guaranteed 25% profit.');
    await page.getByRole('button', { name: 'Check claim' }).click();
    await expect(page.getByText('Not verified', { exact: true })).toBeVisible();
    await expect(page.getByText(/not proof of a scam/i)).toBeVisible();
    expect(requests).toEqual([{ offerText: 'Guaranteed 25% profit.' }]);
    await page.getByLabel('Financial statement to check').fill('Different wording');
    await expect(page.getByText('Not verified', { exact: true })).toHaveCount(0);
  });

  test('shows evidence provenance only for structurally sound server findings', async ({ page }) => {
    await page.route(routePath, route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(checkResponse([{
        claimId: 'b'.repeat(32),
        statement: 'The current official PPF interest rate is 7.1% p.a.',
        verdict: 'CONTRADICTED',
        explanation: 'The stated rate differs from qualified evidence.',
        reasonCode: 'EXACT_RATE_MISMATCH',
        warningSignals: [],
        source: {
          url: 'https://www.indiapost.gov.in/banking-services/savings',
          observedRatePercentPerAnnum: 6.8,
          retrievedAt: now,
          effectiveFrom: '2026-10-01T00:00:00.000Z',
          effectiveTo: '2026-12-31T18:29:59.999Z',
        },
      }])),
    }));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/e2e/fixtures/genieproof-claim-harness.html');
    await page.getByLabel('Financial statement to check').fill('The current official PPF interest rate is 7.1% p.a.');
    await page.getByRole('button', { name: 'Check claim' }).click();
    await expect(page.getByText('Contradicted by evidence')).toBeVisible();
    await expect(page.getByRole('link', { name: /India Post/ }))
      .toHaveAttribute('href', 'https://www.indiapost.gov.in/banking-services/savings');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    expect(overflow).toBe(false);
  });

  test('rejects oversized Unicode submissions and never calls the server', async ({ page }) => {
    const requests = [];
    await page.route(routePath, route => { requests.push(route.request().postDataJSON()); return route.abort(); });
    await page.goto('/e2e/fixtures/genieproof-claim-harness.html');
    await page.getByLabel('Financial statement to check').fill('₹'.repeat(6000));
    await expect(page.getByRole('button', { name: 'Check claim' })).toBeDisabled();
    expect(requests).toEqual([]);
  });
});
