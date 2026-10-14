import { test, expect, type Locator, type Page, type Response, type TestInfo } from '@playwright/test';
import { expectCurrentFinancialBinding } from './financial-state-assertions';

declare const process: { env: { VITE_API_URL?: string } };

// Services and transaction-capable Mongo are supplied by the caller. This spec
// observes real responses and never installs routes, fixtures, or auth shortcuts.
// Match the API path for both Vite's same-origin proxy and an absolute API URL.
const API_BASE_PATH = new URL(process.env.VITE_API_URL || '/api', 'http://localhost').pathname.replace(/\/+$/, '');
const RESPONSE_TIMEOUT = 120_000;
const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
];
type JsonObject = Record<string, unknown>;

function object(value: unknown, field: string): JsonObject {
  expect(value, `${field} must be an object`).not.toBeNull();
  expect(typeof value, field).toBe('object');
  expect(Array.isArray(value), field).toBe(false);
  return value as JsonObject;
}

function array(value: unknown, field: string): unknown[] {
  expect(Array.isArray(value), `${field} must be an array`).toBe(true);
  return value as unknown[];
}

function string(value: unknown, field: string): string {
  expect(typeof value, `${field} must be a nonempty string`).toBe('string');
  expect((value as string).trim().length, field).toBeGreaterThan(0);
  return value as string;
}

function number(value: unknown, field: string): number {
  expect(typeof value, `${field} must be a JSON number, never a coerced null`).toBe('number');
  expect(Number.isFinite(value), field).toBe(true);
  return value as number;
}

function timestamp(value: unknown, field: string, nullable = false): string | null {
  if (nullable && value === null) return null;
  const text = string(value, field);
  expect(Number.isFinite(Date.parse(text)), `${field} must be a valid timestamp`).toBe(true);
  return text;
}

function apiResponse(method: string, path: string, parentInstrumentId?: string) {
  const expectedPath = `${API_BASE_PATH}${path}`;
  return (response: Response) => {
    const url = new URL(response.url());
    return response.request().method() === method
      && url.pathname === expectedPath
      && (parentInstrumentId === undefined
        || response.request().postDataJSON()?.parentInstrumentId === parentInstrumentId);
  };
}

async function json(response: Response, status = 200): Promise<JsonObject> {
  expect(response.status(), `${response.request().method()} ${new URL(response.url()).pathname}`).toBe(status);
  expect(response.headers()['content-type']).toContain('application/json');
  return object(await response.json(), 'response');
}

const inr = (value: number) => `₹${Math.round(value).toLocaleString('en-IN')}`;
const percent = (value: number) => `${value.toFixed(1)}%`;
const signedPercent = (value: number) => `${value > 0 ? '+' : ''}${percent(value)}`;
const ist = (value: string) => new Date(value).toLocaleString('en-IN', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata',
});
const SOURCE_LABELS: Record<string, string> = {
  GOVERNMENT_OF_INDIA: 'Government of India', INDIA_POST: 'India Post',
  VERIFIED_COMPARABLE_OPTION: 'Verified comparable option', EVIDENCE_RANKED: 'Evidence ranked',
};
const sourceLabel = (value: string) => SOURCE_LABELS[value] || value.replace(/_/g, ' ');

async function screenshots(page: Page, info: TestInfo, name: string, assertRendered: () => Promise<void>) {
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await assertRendered();
    const overflow = await page.locator('.ddm-content, .ddm-sticky-header, .ddm-scroll-container, .wti-beginner-market-card, .pta-root, .pta-table-scroll').evaluateAll(elements => elements
      .filter(element => element.scrollWidth > element.clientWidth + 2)
      .map(element => ({ className: element.className, width: element.clientWidth, content: element.scrollWidth })));
    expect(overflow, 'critical demo containers must not clip horizontally').toEqual([]);
    await page.screenshot({ path: info.outputPath(`${name}-${viewport.width}x${viewport.height}.png`), fullPage: false });
  }
  await page.setViewportSize(VIEWPORTS[0]);
}

async function noSensitiveStorage(page: Page, email: string, password: string) {
  // Return offending key names only, so a failing assertion cannot print secrets.
  const violations = await page.evaluate(({ email, password }) => {
    const sensitive = /wg_(?:token|user|profile)|wealthgenie_user_profile|"token"\s*:|access.?token|refresh.?token|authorization|jwt|password|api.?key|secret|monthly[_]?income|monthly[_]?take[_]?home|monthly[_]?savings|monthly[_]?allocation|liquid[_]?savings|annual[_]?(?:gross[_]?)?income|grossAnnualIncome|deductions|taxCalculationContext|financial[_]?profile|profile[_]?id|recommendation|portfolio[_]?fingerprint/i;
    return [['local', localStorage], ['session', sessionStorage]].flatMap(([area, storage]) =>
      Object.entries(storage as Storage).filter(([key, value]) => sensitive.test(key)
        || sensitive.test(value) || value.includes(email) || value.includes(password)
        || /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(value)
      ).map(([key]) => `${area}.${key}`),
    );
  }, { email, password });
  expect(violations, 'financial facts and credentials must stay out of browser storage').toEqual([]);
}

async function dashboard(page: Page, recommendation: JsonObject) {
  const instruments = array(recommendation.instruments, 'instruments').map((item, i) => object(item, `instruments[${i}]`));
  expect(instruments.length).toBeGreaterThan(0);
  const projection = object(recommendation.dashboard_projection, 'dashboard_projection');
  const allocations = object(projection.instrument_monthly_allocations, 'instrument_monthly_allocations');
  const ids = instruments.map(instrument => string(instrument.id, 'instrument.id'));
  expect(new Set(ids).size).toBe(ids.length);
  expect(Object.keys(allocations).sort()).toEqual([...ids].sort());
  const rows = page.locator('[data-testid^="recommendation-row-"]');
  await expect(rows).toHaveCount(instruments.length);
  expect((await rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-testid')))).sort())
    .toEqual(ids.map(id => `recommendation-row-${id}`).sort());
  for (const instrument of instruments) {
    const id = string(instrument.id, 'instrument.id');
    const row = page.getByTestId(`recommendation-row-${id}`);
    await expect(row).toBeVisible();
    const name = string(instrument.name, `${id}.name`);
    await expect(row.locator('.wg-inst-name-text')).toHaveText(name);
    const weight = number(instrument.allocationWeight, `${id}.allocationWeight`);
    const allocationPct = number(instrument.allocation_pct, `${id}.allocation_pct`);
    expect(weight).toBeGreaterThan(0);
    expect(weight).toBeLessThanOrEqual(1);
    expect(allocationPct).toBeCloseTo(weight * 100, 2);
    await expect(row.locator('.col-weight')).toHaveText(percent(allocationPct));
    const monthly = number(allocations[id], `${id}.monthly allocation`);
    expect(monthly).toBeGreaterThan(0);
    await expect(row.locator('td').nth(6)).toHaveText(inr(monthly));
    await expect(row.locator('.col-exp-return')).toHaveText(percent(number(instrument.nominalReturn, `${id}.model assumption`)));
    await expect(row.locator('.col-risk-level')).toHaveText(string(instrument.riskLevel, `${id}.riskLevel`));
    const card = page.locator(`[id="rec-card-${id}"]`);
    await expect(card.locator('.stat-box').filter({ has: page.getByText('Risk Level', { exact: true }) })).toContainText(string(instrument.riskLevel, 'riskLevel'));
    const lockIn = instrument.lockIn;
    await expect(card.locator('.stat-box').filter({ has: page.getByText(/^Lock-in$/i) }))
      .toContainText(lockIn === null ? 'Unavailable' : number(lockIn, 'lockIn') === 0 ? 'None' : `${lockIn}Y`);
  }
  return instruments;
}

async function products(dialog: Locator, result: JsonObject, parentId: string) {
  expect(result.success).toBe(true);
  const entries = array(result.products, 'products').map((item, i) => object(item, `products[${i}]`));
  expect(number(result.total, 'total')).toBe(entries.length);
  expect(entries.length).toBeLessThanOrEqual(5);
  const ranking = object(result.ranking, 'ranking');
  expect(['EVIDENCE_RANKED', 'VERIFIED_COMPARABLE_OPTIONS', 'UNAVAILABLE']).toContain(ranking.status);
  const cards = dialog.locator('[data-testid^="wti-product-"]');
  if (ranking.status === 'UNAVAILABLE') {
    expect(entries).toEqual([]);
    expect(array(ranking.reasonCodes, 'ranking.reasonCodes').length).toBeGreaterThan(0);
    await expect(dialog.getByRole('status'))
      .toContainText('No current source-qualified products are available for this category. No static fallback values were inserted.');
    await expect(cards).toHaveCount(0);
    return;
  }
  expect(entries.length, 'an available ranking must contain actual products').toBeGreaterThan(0);
  const ids = entries.map(entry => string(entry.id, 'product.id'));
  expect(new Set(ids).size).toBe(ids.length);
  await expect(cards).toHaveCount(entries.length);
  expect((await cards.evaluateAll(elements => elements.map(element => element.getAttribute('data-testid')))).sort())
    .toEqual(ids.map(id => `wti-product-${id}`).sort());
  for (const product of entries) {
    const id = string(product.id, 'product.id');
    const card = dialog.getByTestId(`wti-product-${id}`);
    expect(product.parentInstrumentId).toBe(parentId);
    expect(product.expectedReturn).toBeNull();
    expect(product.nominalReturn).toBeNull();
    expect(product.postTaxReturn).toBeNull();
    expect(product.availabilityStatus).toBe('AVAILABLE');
    const source = object(product.source, `${id}.source`);
    const provider = product.provider === null ? 'Unavailable' : sourceLabel(string(product.provider, `${id}.provider`));
    const authority = string(source.provider, `${id}.source.provider`);
    await expect(card.locator('.wti-name')).toHaveText(string(product.name, `${id}.name`));
    await expect(card.locator('.wti-badge').first()).toHaveText(sourceLabel(string(product.presentationStatus, 'presentationStatus')));
    await expect(card.locator('.wti-rank')).toHaveText(ranking.status === 'EVIDENCE_RANKED' ? String(number(product.rank, 'rank')) : '=');
    const suitability = object(product.beginnerSuitability, 'beginnerSuitability');
    await expect(card.locator('.wti-risk-chip')).toHaveText(suitability.riskTier === null ? 'Risk classification unavailable' : string(suitability.riskTier, 'riskTier'));
    await expect(card.locator('.wti-access-chip')).toHaveText(suitability.accessToMoney === null ? 'Access terms unavailable' : string(suitability.accessToMoney, 'accessToMoney'));
    if (suitability.whyThisFitsYou === null) await expect(card.locator('.wti-why-fits-text')).toHaveCount(0);
    else await expect(card.locator('.wti-why-fits-text')).toHaveText(string(suitability.whyThisFitsYou, 'whyThisFitsYou'));
    await expect(card.locator('.wti-provider')).toHaveText(`${provider} · ${sourceLabel(authority)}`);
    await expect(card.locator('.wti-card-evidence-row')).toContainText(`Source: ${sourceLabel(authority)}`);
    const details = card.locator('details.wti-card-tech-details');
    await details.locator('summary').click();
    await expect(details).toHaveAttribute('open', '');
    await expect(details).toContainText(`Product type: ${sourceLabel(string(product.productType, 'productType'))}`);
    await expect(details).toContainText(`Source: ${sourceLabel(authority)}`);
    if (source.url !== null) {
      const url = new URL(string(source.url, `${id}.source.url`));
      expect(['http:', 'https:']).toContain(url.protocol);
      expect(url.username + url.password).toBe('');
      await expect(card.getByRole('link').filter({ hasText: /source/i })).toHaveAttribute('href', url.href);
    } else {
      await expect(card.getByRole('link').filter({ hasText: /source/i })).toHaveCount(0);
    }

    // Absence of officialRate is expected for fund/ETF evidence DTOs; ETFs
    // still use verified NAV/history facts but must retain their ETF identity.
    const official = product.officialRate === undefined || product.officialRate === null
      ? null : object(product.officialRate, `${id}.officialRate`);
    const nav = product.nav === null ? null : object(product.nav, `${id}.nav`);
    const history = product.historicalReturn === null ? null : object(product.historicalReturn, `${id}.historicalReturn`);
    if (!official) {
      expect(product.productType).toBe(parentId === 'nifty_etf' ? 'ETF' : 'MUTUAL_FUND');
    }
    if (nav) {
      expect(number(nav.value, `${id}.nav.value`)).toBeGreaterThan(0);
      await expect(details).toContainText(`NAV: ₹${number(nav.value, `${id}.nav.value`).toLocaleString('en-IN')}`);
      await expect(details).toContainText(`Valuation: ${string(product.valuationDate, `${id}.valuationDate`)}`);
    }
    if (history) {
      number(history.valuePct, `${id}.historicalReturn.valuePct`);
      expect(string(history.basis, `${id}.historicalReturn.basis`)).toMatch(/HISTORICAL/);
      timestamp(history.startDate, `${id}.history.startDate`);
      timestamp(history.endDate, `${id}.history.endDate`);
      await expect(details).toContainText(`History: ${history.startDate} → ${history.endDate}`);
      await expect(card.locator('.wti-highlights')).toContainText('Historical performance is not an expected return');
    }
    if (official) {
      expect(nav).toBeNull();
      expect(history).toBeNull();
      const rate = number(official.value, `${id}.officialRate.value`);
      const dataClass = string(official.dataClass, `${id}.officialRate.dataClass`);
      const label = dataClass === 'OFFICIAL_RBI_FLOATING_COUPON_RATE'
        ? 'Current RBI bond coupon' : dataClass === 'OFFICIAL_BANK_PUBLISHED_RATE'
          ? 'Current official bank rate' : 'Current official rate';
      await expect(card.locator('.wti-card-metric-label')).toHaveText(label);
      await expect(card.locator('.wti-rate-chip')).toHaveText(`${rate.toFixed(2)}% p.a.`);
      timestamp(official.effectiveFrom, `${id}.officialRate.effectiveFrom`);
      timestamp(official.effectiveTo, `${id}.officialRate.effectiveTo`, true);
      await expect(details).toContainText(`Effective: ${official.effectiveFrom} → ${official.effectiveTo || 'until revised'}`);
      if (dataClass === 'OFFICIAL_RBI_FLOATING_COUPON_RATE') {
        await expect(card.locator('.wti-highlights')).toContainText('coupon resets on January 1 and July 1');
        await expect(card.locator('.wti-highlights')).toContainText('not a fixed 7-year guaranteed rate');
      } else if (dataClass === 'QUARTERLY_OFFICIAL_RATE') {
        await expect(card.locator('.wti-highlights')).toContainText('not a live market price or expected return');
      }
    } else if (history) {
      expect(nav, 'historical NAV return requires current NAV evidence').not.toBeNull();
      await expect(card.locator('.wti-card-metric-label')).toHaveText('Historical 1Y return');
      await expect(card.locator('.wti-rate-chip')).toHaveText(`${number(history.valuePct, 'historical return').toFixed(2)}% historical`);
    } else {
      expect(nav, 'a returned qualified MF must have a current NAV').not.toBeNull();
      await expect(card.locator('.wti-card-metric-label')).toHaveText('Current NAV');
      await expect(card.locator('.wti-rate-chip')).toHaveText(`₹${number(nav!.value, 'NAV').toLocaleString('en-IN')}`);
    }
    const observed = official?.observedAt ?? nav?.observedAt ?? product.valuationDate ?? history?.endDate;
    await expect(card.locator('.wti-card-evidence-row')).toContainText(`As of: ${ist(timestamp(observed, `${id}.observedAt`)!)}`);
    await details.locator('summary').click();
  }
}

const SIGNAL_LABELS: Record<string, string> = {
  nifty50Current: 'NIFTY 50', nifty50PreviousClose: 'Previous close', indiaVixCurrent: 'India VIX',
  return1DayPct: '1-day return', return5DayPct: '5-day return', return20DayPct: '20-day return',
  drawdownFromRecentHighPct: 'Drawdown from recent high', movingAverage50Day: '50-day moving average',
  movingAverage200Day: '200-day moving average', priceVsMovingAverage50Pct: 'vs. 50-day average',
  priceVsMovingAverage200Pct: 'vs. 200-day average', realizedVolatility20DayAnnualizedPct: '20-day realized volatility',
};
const MARKET_LABELS: Record<string, string> = {
  CURRENT: 'Current verified data', MARKET_CLOSED: 'Market closed', LAST_AVAILABLE: 'Last available data',
  STALE: 'Stale market data', PARTIAL_DATA: 'Partial market data', UNAVAILABLE: 'Market data unavailable',
};

async function market(dialog: Locator, body: JsonObject) {
  expect(['MARKET_CONTEXT_AVAILABLE', 'MARKET_CONTEXT_UNAVAILABLE']).toContain(body.status);
  const available = body.status === 'MARKET_CONTEXT_AVAILABLE';
  expect(body.confidence, 'deterministic market policy has no ML confidence').toBeNull();
  const snapshot = object(body.marketSnapshot, 'marketSnapshot');
  const displayStatus = string(snapshot.status, 'marketSnapshot.status');
  expect(Object.keys(MARKET_LABELS)).toContain(displayStatus);
  const sources = array(body.sources, 'market.sources').map((item, i) => object(item, `sources[${i}]`));
  const signals = object(body.signals, 'market.signals');
  const reasons = array(body.reasonCodes, 'market.reasonCodes').map((item, i) => string(item, `reasonCodes[${i}]`));
  const observed = timestamp(body.observedAt, 'market.observedAt', !available);
  timestamp(body.evaluatedAt, 'market.evaluatedAt');
  const snapshotObserved = timestamp(snapshot.observedAt, 'marketSnapshot.observedAt', !available);
  if (available) {
    expect(['NORMAL', 'CAUTIOUS', 'HIGH_VOLATILITY', 'RISK_OFF']).toContain(body.context);
    expect(body.classification).toBe('DETERMINISTIC_POLICY_HEURISTIC');
    string(body.policyVersion, 'market.policyVersion');
    expect(sources.length).toBeGreaterThan(0);
    for (const key of Object.keys(SIGNAL_LABELS)) object(signals[key], `signals.${key}`);
  } else {
    expect(body.context).toBeNull();
    expect(reasons.length).toBeGreaterThan(0);
  }
  const region = dialog.getByRole('region', { name: 'Market conditions overview' });
  await expect(region).toBeVisible();
  await expect(region.locator('.wti-beginner-market-badge')).toHaveText(available ? string(body.context, 'context').replace(/_/g, ' ') : MARKET_LABELS[displayStatus]);
  await expect(region.getByTestId('market-data-status')).toContainText(MARKET_LABELS[displayStatus]);
  const providerStatus = object(snapshot.providerStatus, 'marketSnapshot.providerStatus');
  const quotes = object(providerStatus.quotes, 'marketSnapshot.providerStatus.quotes');
  const observedFacts = Array.isArray(snapshot.observedFacts)
    ? snapshot.observedFacts.map((item, index) => object(item, `marketSnapshot.observedFacts[${index}]`))
    : [];
  const verifiedProviders = [...new Set(observedFacts
    .filter(fact => fact.availabilityStatus === 'AVAILABLE')
    .map(fact => fact.source && object(fact.source, 'observed fact source').provider)
    .filter((provider): provider is string => typeof provider === 'string' && provider.trim().length > 0))];
  const displaySource = verifiedProviders.length ? verifiedProviders.join(', ') : 'Unavailable';
  const providerSelectionValue = body.liveProviderSelection ?? snapshot.providerSelection;
  const providerSelection = providerSelectionValue && typeof providerSelectionValue === 'object' && !Array.isArray(providerSelectionValue)
    ? object(providerSelectionValue, 'liveProviderSelection')
    : null;
  const selectedAttempts = Array.isArray(providerSelection?.attemptedProviders)
    ? providerSelection.attemptedProviders.filter((provider): provider is string => typeof provider === 'string' && provider.trim().length > 0)
    : [];
  const historyStatus = providerStatus.history && typeof providerStatus.history === 'object' && !Array.isArray(providerStatus.history)
    ? object(providerStatus.history, 'marketSnapshot.providerStatus.history')
    : null;
  const fallbackAttempts = [quotes.provider, historyStatus?.provider, ...(
    Array.isArray(providerStatus.attemptedProviders) ? providerStatus.attemptedProviders : []
  )].filter((provider): provider is string => typeof provider === 'string' && provider.trim().length > 0);
  const attemptedProviders = [...new Set(selectedAttempts.length ? selectedAttempts : fallbackAttempts)];
  const displayAttemptedProvider = attemptedProviders.length ? attemptedProviders.join(', ') : 'Unavailable';
  const marketStatus = region.getByTestId('market-data-status');
  await expect(marketStatus).toContainText(`As of: ${snapshotObserved ? ist(snapshotObserved) : 'Unavailable'}`);
  await expect(marketStatus).toContainText(displaySource);
  const toggle = region.getByRole('button', { name: 'Technical details', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const panel = region.getByTestId('market-context-panel');
  await expect(panel).toBeVisible();
  const freshness = body.freshness === null ? null : object(body.freshness, 'market.freshness');
  await expect(panel).toContainText(`Observed: ${observed || 'UNAVAILABLE'} · Evaluated: ${body.evaluatedAt} · Freshness: ${freshness ? string(freshness.status, 'freshness.status') : 'UNAVAILABLE'}`);
  for (const source of sources) {
    await expect(panel).toContainText(`${sourceLabel(string(source.provider, 'source.provider'))} (${string(source.instrumentId, 'source.instrumentId')} · ${string(source.dataClass, 'source.dataClass')})`);
  }
  await expect(panel).toContainText(`Provider attempts: ${displayAttemptedProvider}`);
  if (sources.length === 0) await expect(panel).toContainText('Sources: UNAVAILABLE');
  await expect(panel).toContainText(`Reason codes: ${reasons.length ? reasons.join(', ') : 'UNAVAILABLE'}`);
  const tiles = panel.locator('.wti-tech-metric-tile');
  await expect(tiles).toHaveCount(Object.keys(signals).length);
  for (const [key, raw] of Object.entries(signals)) {
    const signal = object(raw, `signals.${key}`);
    expect(typeof signal.available, `signals.${key}.available`).toBe('boolean');
    const label = SIGNAL_LABELS[key] || key.replace(/([A-Z])/g, ' $1').trim();
    const tile = tiles.filter({ has: panel.page().getByText(label, { exact: true }) });
    await expect(tile).toHaveCount(1);
    if (signal.available === true) {
      const value = number(signal.value, `signals.${key}.value`).toLocaleString('en-IN', { maximumFractionDigits: 2 });
      const unit = string(signal.unit, `signals.${key}.unit`);
      await expect(tile.locator('.wti-tech-metric-value')).toHaveText(unit === 'PERCENT' ? `${value}%` : value);
    } else {
      expect(signal.value, `unavailable ${key} must not contain zero or an invented number`).toBeNull();
      await expect(tile.locator('.wti-tech-metric-value')).toHaveText('UNAVAILABLE');
    }
  }
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
}

const UNAVAILABLE_TAX_STATUSES = [
  'REQUIRES_TAX_INPUTS', 'TAX_CLASSIFICATION_REQUIRES_ACQUISITION_FACTS',
  'MODEL_TAX_CLASS_UNAVAILABLE', 'MODELLED_POST_TAX_PROJECTION_UNAVAILABLE',
];

async function taxTable(panel: Locator, body: JsonObject, instruments: JsonObject[]) {
  const results = array(body.results, 'post-tax.results').map((item, i) => object(item, `results[${i}]`));
  expect(results).toHaveLength(instruments.length);
  expect(['COMPLETE', 'PARTIAL', 'UNAVAILABLE']).toContain(body.portfolioStatus);
  const rows = panel.locator('[data-testid^="post-tax-row-"]');
  await expect(rows).toHaveCount(results.length);
  expect((await rows.evaluateAll(elements => elements.map(element => element.getAttribute('data-testid')))).sort())
    .toEqual(instruments.map(instrument => `post-tax-row-${string(instrument.id, 'id')}`).sort());
  const metrics: Array<[string, string, (value: number) => string]> = [
    ['nominal-return', 'nominalReturnPercent', percent], ['post-tax-return', 'postTaxReturnPercent', percent],
    ['real-return', 'realReturnPercent', signedPercent], ['post-tax-gain', 'postTaxGain', inr],
    ['total-invested', 'totalInvested', inr], ['effective-tax', 'effectiveTaxPercent', percent],
    ['tax-drag-wealth', 'taxDragWealth', inr], ['tax-drag-cagr', 'taxDragCAGR', value => `${(value * 100).toFixed(2)}%`],
  ];
  for (const [index, result] of results.entries()) {
    const instrument = instruments[index];
    const row = panel.getByTestId(`post-tax-row-${string(instrument.id, 'id')}`);
    expect(result.instrumentType).toBe(instrument.type);
    expect(result.calculationClass).toBe('MODELLED_POST_TAX_PROJECTION');
    expect(result.dataClass).toBe('MODEL_ASSUMPTION');
    expect(['CALCULATED', ...UNAVAILABLE_TAX_STATUSES]).toContain(result.status);
    await expect(row.locator('.pta-asset-name')).toHaveText(string(instrument.name, 'name'));
    if (result.status === 'CALCULATED') {
      await expect(row.locator('.pta-badge')).toHaveText(string(result.taxType, 'taxType'));
    } else {
      expect(array(result.unavailableReasons, 'unavailableReasons').length).toBeGreaterThan(0);
      for (const field of ['postTaxReturnPercent', 'realReturnPercent', 'postTaxGain', 'effectiveTaxPercent', 'taxDragWealth', 'taxDragCAGR']) {
        expect(result[field], `${field} must remain null for ${result.status}`).toBeNull();
      }
      await expect(row.locator('.pta-badge')).toHaveText('Unavailable — tax class or inputs required');
      await expect(row).toContainText('No zero substituted');
    }
    for (const [testId, field, format] of metrics) {
      await expect(row.getByTestId(testId)).toBeVisible();
      const value = result[field];
      if (value === null) {
        expect(result.status, `${field} cannot be null in a calculated result`).not.toBe('CALCULATED');
        await expect(row.getByTestId(testId)).toHaveText('—');
      } else {
        await expect(row.getByTestId(testId)).toHaveText(format(number(value, `results[${index}].${field}`)));
      }
    }
  }
  const calculated = results.filter(result => result.status === 'CALCULATED').length;
  expect(body.portfolioStatus).toBe(calculated === 0 ? 'UNAVAILABLE' : calculated === results.length ? 'COMPLETE' : 'PARTIAL');
  const summary = object(body.summary, 'summary');
  expect(summary.status).toBe(body.portfolioStatus);
  await expect(panel.getByRole('status')).toContainText(`Portfolio status: ${body.portfolioStatus}`);
  const kpi = (label: string) => panel.locator('.pta-kpi-card').filter({ has: panel.page().getByText(label, { exact: true }) }).locator('.pta-kpi-value');
  const summaryFields = ['totalTaxDrag', 'maxTaxRate', 'keptPerThousand', 'erodedPerThousand', 'retentionEfficiencyPercent'];
  if (body.portfolioStatus === 'UNAVAILABLE') {
    for (const field of summaryFields) expect(summary[field], `unavailable summary.${field}`).toBeNull();
    await expect(kpi('Total Tax Drag')).toHaveText('Unavailable');
    await expect(kpi('Max Tax Bracket')).toHaveText('Not calculated');
    await expect(panel.getByRole('heading', { name: 'Profit retention unavailable' })).toBeVisible();
    await expect(panel.locator('.pta-donut-pct')).toHaveCount(0);
  } else {
    for (const field of summaryFields) number(summary[field], `summary.${field}`);
    await expect(kpi('Total Tax Drag')).toHaveText(inr(number(summary.totalTaxDrag, 'totalTaxDrag')));
    await expect(kpi('Max Tax Bracket')).toHaveText(`${(number(summary.maxTaxRate, 'maxTaxRate') * 100).toFixed(0)}%`);
    await expect(panel.locator('.pta-donut-pct')).toHaveText(percent(number(summary.retentionEfficiencyPercent, 'retentionEfficiencyPercent')));
    await expect(panel.locator('.pta-metric-pill--green .pta-metric-value')).toHaveText(inr(number(summary.keptPerThousand, 'keptPerThousand')));
    await expect(panel.locator('.pta-metric-pill--rose .pta-metric-value')).toHaveText(inr(number(summary.erodedPerThousand, 'erodedPerThousand')));
    if (body.portfolioStatus === 'PARTIAL') await expect(panel.getByRole('status')).toContainText(`${calculated} of ${results.length} instruments are included`);
  }
  await expect(kpi('Inflation Rate')).toHaveText(percent(number(object(body.assumptions, 'assumptions').inflationRate, 'inflationRate') * 100));
  await expect(panel).toContainText(`Estimated under ${string(body.fiscalYear, 'fiscalYear')} policy (${string(body.policyVersion, 'policyVersion')})`);
}

test('real backend financial facts match the dashboard, product details, tax what-if, and Market Today', async ({ page, context }, info) => {
  test.setTimeout(600_000);
  await page.setViewportSize(VIEWPORTS[0]);
  const prohibitedRequests: string[] = [];
  const pageErrors: string[] = [];
  const providerDomains = [
    'nseindia.com', 'amfiindia.com', 'indiapost.gov.in', 'rbi.org.in', 'sbi.bank', 'bank.sbi',
    'dea.gov.in', 'finmin.gov.in', 'upstox.com', 'nvidia.com', 'groq.com',
    'generativelanguage.googleapis.com', 'aiplatform.googleapis.com', 'api.openai.com', 'api.anthropic.com',
  ];
  context.on('request', request => {
    const url = new URL(request.url());
    if (providerDomains.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) {
      prohibitedRequests.push(url.origin);
    }
  });
  page.on('pageerror', error => pageErrors.push(error.message));
  const unique = crypto.randomUUID();
  const user = { name: `Financial Demo ${unique}`, email: `financial-demo-${unique}@example.com`, mobile: '9876543210', password: 'Valid@Pass2026!' };

  await test.step('register through the browser and save explicit profile facts', async () => {
    await page.goto('/login');
    await page.locator('#login-view a', { hasText: 'Register' }).click();
    for (const [id, value] of Object.entries({ 'reg-name': user.name, 'reg-email': user.email, 'reg-mobile': user.mobile, 'reg-password': user.password, 'reg-confirm-password': user.password })) {
      await page.locator(`#${id}`).fill(value);
    }
    const registered = page.waitForResponse(apiResponse('POST', '/auth/register'));
    await page.locator('#register-form button[type="submit"]').click();
    await json(await registered, 201);
    await expect(page.getByRole('heading', { name: 'Registration Successful!' })).toBeVisible();
    await page.locator('.popup-card').getByRole('button', { name: 'OK', exact: true }).click();
    await expect(page).toHaveURL(/\/profile$/);
    for (const [field, value] of Object.entries({
      monthly_take_home: '90000', monthly_savings: '25000', age: '34',
    })) await page.getByTestId(`profile-input-${field}`).fill(value);
    for (const [label, value] of Object.entries({
      'Sold Property Proceeds (₹)': '0', 'Liquid Savings (₹)': '540000',
      'Monthly EMI Burden (%)': '0', 'Financial Dependents': '0', 'Emergency Fund (Months)': '6',
    })) await page.locator('.pf-field').filter({ has: page.locator('label', { hasText: label }) }).locator('input').fill(value);
    await page.getByRole('button', { name: 'No', exact: true }).click();
    await page.getByRole('button', { name: 'Moderate', exact: true }).click();
    await page.locator('label.goal-checkbox', { hasText: 'Wealth Growth' }).click();
    await expect(page.getByLabel('Wealth Growth', { exact: true })).toBeChecked();
    const horizon = page.getByTestId('profile-input-investment_horizon_years');
    await horizon.focus();
    await horizon.press('Home');
    for (let year = 1; year < 15; year += 1) await horizon.press('ArrowRight');
    await expect(horizon).toHaveValue('15');
  });

  const completed = page.waitForResponse(apiResponse('POST', '/profile/complete'), { timeout: RESPONSE_TIMEOUT });
  await page.getByTestId('profile-save').click();
  const completion = await json(await completed);
  const savedProfile = object(completion.profile, 'completion.profile');
  const profileId = string(savedProfile.profileId, 'profileId');
  expect(profileId).toMatch(/^[a-f\d]{24}$/i);
  const profileVersion = number(savedProfile.version, 'profile.version');
  expectCurrentFinancialBinding(object(completion.recommendation, 'completion.recommendation'), { profileId, profileVersion });
  await expect(page.locator('aside.sidebar')).toBeVisible();
  // A fresh browser session must complete the real first-time welcome UI.
  await page.getByRole('button', { name: 'Show me my plan', exact: true }).click();
  await noSensitiveStorage(page, user.email, user.password);

  // Reload makes the rendered oracle the exact authenticated GET responses,
  // rather than assuming the completion response remains the current revision.
  const profileResponse = page.waitForResponse(apiResponse('GET', '/profile/current'), { timeout: RESPONSE_TIMEOUT });
  const recommendationResponse = page.waitForResponse(apiResponse('GET', '/recommend/current'), { timeout: RESPONSE_TIMEOUT });
  await page.reload();
  const profile = await json(await profileResponse);
  expect(profile).toMatchObject({
    profileId, version: profileVersion, monthly_take_home: 90000, monthly_savings: 25000,
    age: 34, investment_horizon_years: 15, risk_tolerance: 'Moderate', investment_goals: ['Wealth Growth'],
    liquid_savings: 540000, emi_burden_pct: 0, financial_dependents: 0, emergency_fund_months: 6,
  });
  const currentResponse = await recommendationResponse;
  expect(new URL(currentResponse.url()).searchParams.get('profileId')).toBe(profileId);
  const recommendation = await json(currentResponse);
  expectCurrentFinancialBinding(recommendation, { profileId, profileVersion });
  expect(recommendation.return_data_class).toBe('MODEL_ASSUMPTION');
  expect(recommendation.provider_forecast).toBe(false);
  await page.getByTestId('nav-home').click();
  const instruments = await dashboard(page, recommendation);
  await screenshots(page, info, 'dashboard', async () => {
    await dashboard(page, recommendation);
    await page.locator('[data-testid^="recommendation-row-"]').first().scrollIntoViewIfNeeded();
  });

  await test.step('real market adjustment is a bounded preview and does not change canonical allocation', async () => {
    const csrf = (await context.cookies()).find(cookie => cookie.name === 'wg_csrf');
    expect(csrf?.value).toBeTruthy();
    const previewResponse = await page.request.post(new URL(`${API_BASE_PATH}/regime/adjust`, process.env.VITE_API_URL || page.url()).href, {
      data: { profileId }, headers: { 'X-CSRF-Token': csrf!.value, 'Idempotency-Key': crypto.randomUUID(), Origin: new URL(page.url()).origin },
      timeout: RESPONSE_TIMEOUT,
    });
    expect(previewResponse.status()).toBe(200);
    const preview = object(await previewResponse.json(), 'preview');
    expect(preview.introducedInstrumentIds).toEqual([]);
    expect(preview.suitabilityRevalidated).toBe(true);
    expect(preview.concentrationCapsRevalidated).toBe(true);
    expect(number(preview.actualTotalTiltPct, 'actualTotalTiltPct')).toBeLessThanOrEqual(number(preview.maxTotalTiltPct, 'maxTotalTiltPct'));
    expect(Object.keys(object(preview.adjustedWeights, 'adjustedWeights')).sort()).toEqual(instruments.map(instrument => string(instrument.id, 'id')).sort());
    const restoredResponse = await page.request.get(new URL(`${API_BASE_PATH}/recommend/current?profileId=${profileId}`, process.env.VITE_API_URL || page.url()).href);
    expect(restoredResponse.status()).toBe(200);
    const restored = object(await restoredResponse.json(), 'restored');
    expect(restored.recommendationId).toBe(recommendation.recommendationId);
    expect(restored.allocation_revision_id).toBe(recommendation.allocation_revision_id);
    expect(restored.portfolio_fingerprint).toBe(recommendation.portfolio_fingerprint);
  });

  for (const [index, instrument] of instruments.entries()) {
    const id = string(instrument.id, 'id');
    await test.step(`compare actual qualified products for ${id}`, async () => {
      const card = page.locator(`[id="rec-card-${id}"]`);
      await card.getByRole('button', { name: 'Learn More — Full Deep Dive', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: string(instrument.name, 'name'), exact: true });
      await expect(dialog).toBeVisible();
      const ranked = page.waitForResponse(apiResponse('POST', '/instruments/rank-wti', id), { timeout: RESPONSE_TIMEOUT });
      await dialog.getByRole('tab', { name: 'Where to Invest', exact: true }).click();
      const rankedResponse = await ranked;
      expect(rankedResponse.request().postDataJSON()).toMatchObject({ profileId, parentInstrumentId: id });
      await products(dialog, await json(rankedResponse), id);
      if (index === 0) {
        const refreshButton = dialog.getByRole('button', { name: 'Refresh market data', exact: true });
        await expect(refreshButton).toBeEnabled();
        // Assert the exact response returned by an explicit refresh. The
        // shared market context may be loaded or cached before this tab opens.
        const refreshed = page.waitForResponse(apiResponse('GET', '/regime/current'), { timeout: RESPONSE_TIMEOUT });
        await refreshButton.click();
        const refreshedBody = await json(await refreshed);
        await expect(refreshButton).toBeEnabled();
        await market(dialog, refreshedBody);
        await screenshots(page, info, 'products-market', async () => { await market(dialog, refreshedBody); });
      }
      await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
      await expect(dialog).toHaveCount(0);
    });
  }
  await noSensitiveStorage(page, user.email, user.password);

  await test.step('compare every post-tax metric and portfolio total to the explicit server what-if', async () => {
    await page.getByTestId('nav-taxes').click();
    const policyResponse = page.waitForResponse(apiResponse('GET', '/tax/policies'));
    await page.getByRole('tab', { name: 'Real Returns on Investments', exact: true }).click();
    const policies = await json(await policyResponse);
    expect(array(policies.verifiedFiscalYears, 'verifiedFiscalYears')).toContain('FY2026-27');
    const panel = page.getByTestId('panel-real-returns');
    await expect(panel).toBeVisible();
    await panel.getByLabel('Gross annual income before allowed deductions', { exact: true }).fill('1800000');
    await panel.getByLabel('Income source', { exact: true }).selectOption('salary');
    await panel.getByLabel('Tax regime', { exact: true }).selectOption('new');
    await panel.getByLabel('Fiscal year', { exact: true }).selectOption('FY2026-27');
    await panel.getByLabel('Inflation assumption', { exact: true }).fill('6');
    const calculated = page.waitForResponse(apiResponse('POST', '/tax/post-tax-return/batch'), { timeout: RESPONSE_TIMEOUT });
    await panel.getByRole('button', { name: 'Calculate explicit tax what-if', exact: true }).click();
    const response = await calculated;
    const request = object(response.request().postDataJSON(), 'tax request');
    const explicitInputs = { annualIncome: 1800000, incomeSource: 'salary', regime: 'new', userAge: 34, fiscalYear: 'FY2026-27', inflationRate: 0.06 };
    const allocations = object(object(recommendation.dashboard_projection, 'dashboard_projection').instrument_monthly_allocations, 'allocations');
    const expectedInputs = instruments.map(instrument => ({
      instrumentType: instrument.type, nominalRate: number(instrument.nominalReturn, 'nominalReturn') / 100,
      holdingYears: 15, monthlySIP: number(allocations[string(instrument.id, 'id')], 'monthlySIP'),
    }));
    expect(request).toMatchObject(explicitInputs);
    expect(request.instruments).toEqual(expectedInputs);
    const body = await json(response);
    expect(body.calculation_classification).toBe('SEPARATE_TAX_WHAT_IF');
    expect(body.assumptions).toMatchObject({ ...explicitInputs, calculationClass: 'MODELLED_POST_TAX_PROJECTION', dataClass: 'MODEL_ASSUMPTION' });
    expect(body.inputsUsed).toMatchObject(explicitInputs);
    expect(object(body.inputsUsed, 'inputsUsed').instruments).toEqual(expectedInputs);
    await expect(panel.locator('[data-testid^="post-tax-row-"]')).toHaveCount(instruments.length);
    for (const instrument of instruments) {
      await panel.getByTestId(`post-tax-row-${string(instrument.id, 'id')}`).locator('details > summary').click();
    }
    await taxTable(panel, body, instruments);
    await screenshots(page, info, 'post-tax-chart', async () => {
      await panel.getByRole('heading', { name: 'Return Drag Comparison', exact: true }).scrollIntoViewIfNeeded();
      await expect(panel.locator('.recharts-xAxis .recharts-cartesian-axis-tick')).toHaveCount(instruments.length);
    });
    await screenshots(page, info, 'post-tax', async () => {
      for (const instrument of instruments) {
        const details = panel.getByTestId(`post-tax-row-${string(instrument.id, 'id')}`).locator('details');
        if (await details.getAttribute('open') === null) await details.locator('summary').click();
      }
      await taxTable(panel, body, instruments);
      for (const instrument of instruments) await panel.getByTestId(`post-tax-row-${string(instrument.id, 'id')}`).locator('details > summary').click();
      await panel.locator('.pta-table-header').scrollIntoViewIfNeeded();
    });
  });

  await test.step('profile edit replaces canonical state and cannot retain old tax calculations', async () => {
    await page.getByTestId('nav-profile').click();
    await page.getByTestId('profile-edit').click();
    await page.getByTestId('profile-input-monthly_savings').fill('27000');
    const updateResponse = page.waitForResponse(apiResponse('PUT', `/profile/${profileId}`), { timeout: RESPONSE_TIMEOUT });
    await page.getByTestId('profile-save').click();
    const update = await json(await updateResponse);
    const updatedProfile = object(update.profile, 'updated profile');
    expect(updatedProfile.profileId).toBe(profileId);
    expect(updatedProfile.version).toBe(profileVersion + 1);
    expect(updatedProfile.monthly_savings).toBe(27000);
    const updatedRecommendation = object(update.recommendation, 'updated recommendation');
    expectCurrentFinancialBinding(updatedRecommendation, { profileId, profileVersion: profileVersion + 1 });
    expect(updatedRecommendation.recommendationId).not.toBe(recommendation.recommendationId);
    await page.getByTestId('nav-home').click();
    await dashboard(page, updatedRecommendation);
    await page.getByTestId('nav-taxes').click();
    await page.getByRole('tab', { name: 'Real Returns on Investments', exact: true }).click();
    await expect(page.getByTestId('panel-real-returns').locator('[data-testid^="post-tax-row-"]')).toHaveCount(0);
    await expect(page.getByText('Enter your tax inputs and calculate to view return estimates.', { exact: true })).toBeVisible();
  });
  await noSensitiveStorage(page, user.email, user.password);
  expect((await context.cookies()).some(cookie => cookie.name === 'wg_session' && cookie.httpOnly)).toBe(true);
  expect(prohibitedRequests, 'only the backend may access financial providers and LLM hosts').toEqual([]);
  expect(pageErrors, 'no runtime exceptions may be hidden by conditional assertions').toEqual([]);
});
