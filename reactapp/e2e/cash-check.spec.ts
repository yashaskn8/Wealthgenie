import { expect, test, type Page } from '@playwright/test';

const indiaDate = () => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.filter(p => p.type !== 'literal')
    .map(p => [p.type, p.value]));
  return values.year + '-' + values.month + '-' + values.day;
};

function result({ shortfall = false } = {}) {
  const day = indiaDate();
  return {
    status: shortfall ? 'SHORTFALL_IN_ENTERED_PLAN' : 'NO_SHORTFALL_IN_ENTERED_PLAN',
    missingInputCodes: [], cashProvenance: 'USER_DECLARED_NOT_BANK_VERIFIED',
    baseline: {
      minWithinDayPaise: shortfall ? -100 : 100000,
      closingBalancePaise: shortfall ? -100 : 100000,
      earliestShortfall: shortfall
        ? { date: day, lowestBalancePaise: -100, dueOutflowEntryIds: ['emergency'] }
        : null,
      daily: [{ date: day, lowestBalancePaise: shortfall ? -100 : 100000,
        closingBalancePaise: shortfall ? -100 : 100000 }],
    },
    noExpectedIncome: { earliestShortfall: null },
  };
}

async function installCashApi(page: Page) {
  let revision = 0;
  let ledger: Record<string, unknown> | null = null;
  let calculation: ReturnType<typeof result> | null = null;
  let saveCount = 0;
  let previewCount = 0;
  let deleteCount = 0;
  const failures: string[] = [];
  await page.route(/\/api\/coverage(?:\/|$)/, async route => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    const cors = {
      'access-control-allow-origin': new URL(page.url()).origin,
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET, PUT, POST, DELETE, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type, x-csrf-token, idempotency-key, if-match, x-correlation-id',
      'cache-control': 'no-store',
    };
    const fulfill = async (status: number, json: unknown) => route.fulfill({
      status, headers: cors, contentType: 'application/json', body: JSON.stringify(json),
    });
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (path.endsWith('/ledger') && method === 'GET') {
      return fulfill(200, ledger ? {
        revision, ledger, latestResult: {
          revision, result: calculation, policyVersion: 'cash-coverage-90d-v1',
        }, requiresCashReconfirmation: false, requiresPolicyReconfirmation: false,
      } : { revision, ledger: null, latestResult: null, deleted: revision > 0 });
    }
    if (path.endsWith('/ledger') && method === 'PUT') {
      const payload = req.postDataJSON();
      if (req.headers()['if-match'] !== '"' + revision + '"') {
        failures.push('missing or stale If-Match');
        return fulfill(409, { code: 'COVERAGE_REVISION_CONFLICT' });
      }
      if (!req.headers()['idempotency-key']) failures.push('missing idempotency header');
      if (payload.openingCashPaise !== 100001 || payload.entries[0]?.amountPaise !== 40025) {
        failures.push('incorrect paise conversion');
      }
      ledger = payload;
      revision += 1;
      saveCount += 1;
      calculation = result();
      return fulfill(200, { revision, result: calculation });
    }
    if (path.endsWith('/scenarios/preview') && method === 'POST') {
      const body = req.postDataJSON();
      if (body.revision !== revision || !Array.isArray(body.excludedVoluntaryEntryIds)) {
        failures.push('incorrect what-if payload');
      }
      previewCount += 1;
      return fulfill(200, { revision, hypothetical: true, result: result() });
    }
    if (path.endsWith('/export') && method === 'GET') {
      return fulfill(200, {
        records: ledger ? [{ revision, input: ledger,
          policyVersion: 'cash-coverage-90d-v1', result: calculation }] : [],
        nextAfterRevision: null, userDeclaredOnly: true,
      });
    }
    if (path.endsWith('/ledger') && method === 'DELETE') {
      if (req.headers()['if-match'] !== '"' + revision + '"'
        || !req.headers()['idempotency-key']) failures.push('unfenced deletion');
      const deletedRevision = revision;
      revision += 1;
      ledger = null;
      calculation = null;
      deleteCount += 1;
      return fulfill(200, {
        deleted: true, deletedRevision, nextRevision: revision, deletedAt: new Date().toISOString(),
      });
    }
    failures.push('unexpected ' + method + ' ' + path);
    return fulfill(404, { error: 'Unsupported test API call' });
  });
  return { counters: () => ({ saveCount, previewCount, deleteCount }), failures };
}

for (const viewport of [
  { label: 'desktop', width: 1440, height: 900 },
  { label: 'mobile', width: 360, height: 740 },
]) {
  test('cash check complete browser lifecycle: ' + viewport.label, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const api = await installCashApi(page);
    await page.goto('/e2e/cash-check-harness.html');
    await expect(page.getByRole('heading', { name: '90-day cash check', level: 1 })).toBeVisible();
    // An entire statement stays in Chromium; suggestions do not touch the API
    // unless explicitly classified and saved by the user.
    const current = new Date(indiaDate() + 'T00:00:00Z');
    const anchorDay = Math.min(current.getUTCDate(), 15);
    const statements = [2, 1, 0].map(monthOffset =>
      new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - monthOffset, anchorDay))
        .toISOString().slice(0, 10));
    const csv = 'Date,Description,Debit,Credit,Balance\n'
      + statements.map((day, i) => day + ',Recurring home bill,200.25,,' + (50000 - i * 200))
        .join('\n');
    await page.evaluate(csvData => {
      const input = document.querySelector('input[aria-label="Choose bank statement CSV"]');
      if (!(input instanceof HTMLInputElement)) throw new Error('CSV file picker missing');
      const transfer = new DataTransfer();
      transfer.items.add(new File([csvData], 'private-statement.csv', { type: 'text/csv' }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, csv);
    const review = page.getByRole('region', { name: 'Statement review' });
    await expect(review).toBeVisible();
    await expect(review).toContainText('Unverified local statement');
    await expect(review).toContainText('Recurring home bill');
    expect(api.counters().saveCount).toBe(0);
    await page.getByLabel('Confirm payment type').selectOption('ESSENTIAL_PAYMENT');
    await page.getByRole('button', { name: 'Add reviewed payment to unsaved draft' }).click();
    await expect(page.getByLabel('Description')).toHaveValue('Recurring home bill');
    await expect(page.getByLabel('Amount (₹)')).toHaveValue('200.25');
    expect(api.counters().saveCount).toBe(0);
    await page.getByRole('button', { name: 'Remove entry' }).click();
    await page.getByPlaceholder('50000.00').fill('1000.01');
    await page.getByRole('button', { name: 'Add entry' }).click();
    await page.getByLabel('Description').fill('Scheduled EMI');
    await page.getByLabel('Amount (₹)').fill('400.25');
    await page.getByLabel(/I have entered the commitments/).check();
    await page.getByRole('button', { name: 'Save and calculate 90 days' }).click();
    await expect(page.getByText(/Entries saved and recalculated/)).toBeVisible();
    await expect(page.getByText('No shortfall in the entries supplied for these dates')).toBeVisible();
    await page.getByPlaceholder('50000.00').fill('1000.02');
    await expect(page.getByText(/Unsaved edits: the previous result is hidden/)).toBeVisible();
    await expect(page.getByText('No shortfall in the entries supplied for these dates')).toHaveCount(0);
    await page.getByPlaceholder('50000.00').fill('1000.01');
    // Restore the original exact input; an explicit Save is required before the
    // old result reappears, even when the numbers were edited back.
    await page.getByRole('button', { name: 'Save and calculate 90 days' }).click();
    await expect(page.getByText('No shortfall in the entries supplied for these dates')).toBeVisible();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download saved history' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('wealthgenie-cash-history.json');
    await page.getByLabel(/I understand this permanently removes/).check();
    await page.getByRole('button', { name: 'Delete my saved cash records' }).click();
    await expect(page.getByText(/Saved cash entries and calculations deleted/)).toBeVisible();
    await expect(page.getByText('No shortfall in the entries supplied for these dates')).toHaveCount(0);
    expect(api.counters()).toEqual({ saveCount: 2, previewCount: 0, deleteCount: 1 });
    expect(api.failures).toEqual([]);
    const layout = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth, visible: window.innerWidth,
    }));
    expect(layout.width).toBeLessThanOrEqual(layout.visible + 2);
  });
}
