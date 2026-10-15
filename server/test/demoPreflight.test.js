import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import {
  assessCurrentMarketContext,
  BACKEND_HTTP_HARD_TIMEOUT_MS,
  DASHBOARD_BROWSER_TIMEOUT_MS,
  checkBrowserAndFinancialFlow,
  createFrontendBuildEnvironment,
  EXPECTED_PREFLIGHT_CHECKS,
  hasAuthenticatedDashboard,
  hasCurrentFinancialBinding,
  isRedisRequired,
  isSafeDemoUrl,
  LOGIN_BROWSER_TIMEOUT_MS,
  MARKET_DEPENDENCY_PROBE_TIMEOUT_MS,
  makeReporter,
  matchesBuildSha,
  matchesRecommendationBinding,
  PROFILE_USER_FLOW_TIMEOUT_MS,
  readLocalBuildIdentity,
  readJson,
  REDIS_PROBE_TIMEOUT_MS,
  reportWtiProductChecks,
  qualifiesExactNiftyEtf,
  qualifiesWtiResponse,
  qualifiesCalculatedNiftyEtfTax,
  runDemoPreflight,
  verifyServedFrontendArtifacts,
  WTI_USER_FLOW_TIMEOUT_MS,
} from '../scripts/demoPreflight.js';
import { calculateProductPostTaxOutcome } from '../services/productPostTaxCalculator.js';
import { getProductTaxMetadata } from '../services/productTaxAuthority.js';
import { indiaClockParts, isoDateInIndia } from '../services/marketData/indiaMarketTime.js';
import { previousNseTradingDate } from '../services/marketData/nseTradingCalendar.js';
import {
  BUILD_PROVENANCE_SCHEMA,
  MAX_FRONTEND_ARTIFACT_BYTES,
  MAX_FRONTEND_ARTIFACT_COUNT,
  canonicalJson,
} from '../services/buildProvenance.js';

test('served frontend artifact verification physically bounds concurrent requests at eight', async () => {
  for (const count of [1, 8, 9, 100, MAX_FRONTEND_ARTIFACT_COUNT]) {
    let active = 0;
    let peak = 0;
    const artifacts = Array.from({ length: count }, (_, index) => {
      const bytes = Buffer.from('artifact-' + index);
      return {
        path: 'assets/' + String(index).padStart(4, '0') + '.js',
        sha256: createHash('sha256').update(bytes).digest('hex'),
        byteLength: bytes.byteLength,
        bytes,
      };
    });
    const artifactsByPath = new Map(artifacts.map(artifact => [artifact.path, artifact]));
    const fetcher = async (url, options) => {
      assert.equal(options.redirect, 'manual');
      assert.ok(options.signal instanceof AbortSignal);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active -= 1;
      const artifactPath = decodeURIComponent(new URL(url).pathname.slice(1));
      const artifact = artifactsByPath.get(artifactPath);
      return new Response(artifact?.bytes ?? null, { status: artifact ? 200 : 404 });
    };

    assert.equal(await verifyServedFrontendArtifacts(artifacts, fetcher, 'https://frontend.example'), true);
    assert.ok(peak <= 8, count + ' artifacts produced peak concurrency ' + peak);
    assert.equal(peak, Math.min(count, 8));
  }
});

test('served frontend artifact verification bounds streamed bytes and fails closed on encoding or redirects', async () => {
  const expectedBytes = Buffer.from('small');
  const artifact = {
    path: 'assets/small.js',
    sha256: createHash('sha256').update(expectedBytes).digest('hex'),
    byteLength: expectedBytes.byteLength,
  };
  let streamCancelled = false;
  const oversizedStreamFetcher = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from('small plus an unbounded tail'));
    },
    cancel() {
      streamCancelled = true;
    },
  }), { status: 200 });
  assert.equal(await verifyServedFrontendArtifacts([artifact], oversizedStreamFetcher, 'https://frontend.example'), false);
  assert.equal(streamCancelled, true, 'oversized response stream should be cancelled as soon as the expected byte budget is exceeded');

  const compressedFetcher = async () => new Response(expectedBytes, {
    status: 200,
    headers: { 'content-encoding': 'gzip', 'content-length': String(expectedBytes.byteLength) },
  });
  assert.equal(await verifyServedFrontendArtifacts([artifact], compressedFetcher, 'https://frontend.example'), false);

  const redirectedFetcher = async () => new Response(null, {
    status: 302,
    headers: { location: 'https://other.example/asset.js' },
  });
  assert.equal(await verifyServedFrontendArtifacts([artifact], redirectedFetcher, 'https://frontend.example'), false);

  let calls = 0;
  const oversizedInventory = [{ ...artifact, byteLength: MAX_FRONTEND_ARTIFACT_BYTES + 1 }];
  assert.equal(await verifyServedFrontendArtifacts(oversizedInventory, async () => {
    calls += 1;
    return new Response(expectedBytes);
  }, 'https://frontend.example'), false);
  assert.equal(calls, 0, 'invalid byte inventory should be rejected before network access');
});

test('served frontend artifact verification stops after a failed batch and fails closed on malformed requests', async () => {
  const artifacts = Array.from({ length: 17 }, (_, index) => {
    const bytes = Buffer.from('artifact-' + index);
    return {
      path: 'assets/' + String(index).padStart(2, '0') + '.js',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.byteLength,
      bytes,
    };
  });
  let calls = 0;
  const failedBatchFetcher = async url => {
    calls += 1;
    const artifact = artifacts.find(candidate => url.endsWith(candidate.path));
    return new Response(artifact?.bytes ?? null, { status: artifact?.path === 'assets/02.js' ? 503 : artifact ? 200 : 404 });
  };
  assert.equal(await verifyServedFrontendArtifacts(artifacts, failedBatchFetcher, 'https://frontend.example'), false);
  assert.equal(calls, 8, 'a failed first batch must not launch later artifact requests');

  const timeoutFetcher = async (_url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    throw Object.assign(new Error('request timeout'), { code: 'ETIMEDOUT' });
  };
  assert.equal(await verifyServedFrontendArtifacts(artifacts, timeoutFetcher, 'https://frontend.example'), false);

  const malformedFetcher = async () => new Response(null, { status: 200 });
  assert.equal(await verifyServedFrontendArtifacts(artifacts, malformedFetcher, 'https://frontend.example'), false);
});

function makeTestFrontendArtifacts(commitSha, overrides = {}) {
  const externalFontStylesheet = 'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=Outfit:wght@300;400;500;600;700;800;900&display=swap';
  const contents = new Map([
    ['index.html', Buffer.from(
      '<!doctype html><html data-build-sha="' + commitSha + '"><head>'
        + '<link rel="stylesheet" href="/assets/app.css">'
        + '<link rel="stylesheet" href="' + externalFontStylesheet + '"></head><body>'
        + '<script type="module" src="/assets/app.js"></script></body></html>'
        + (overrides.indexSuffix || '')
    )],
    ['assets/app.css', Buffer.from('body { color: #fff; }' + (overrides.cssSuffix || ''))],
    ['assets/app.js', Buffer.from(
      "const buildIdentity = '" + (overrides.scriptSha || commitSha) + "';"
        + (overrides.scriptSuffix || '')
    )],
  ]);
  const inventory = [...contents.entries()]
    .map(([artifactPath, bytes]) => ({
      path: artifactPath,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.byteLength,
    }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return { contents, inventory };
}

function artifactSetSha256(inventory) {
  return createHash('sha256').update(canonicalJson(inventory)).digest('hex');
}

function makeTestBuildManifest(commitSha, overrides = {}) {
  const frontendArtifacts = makeTestFrontendArtifacts(commitSha);
  const manifest = {
    schemaVersion: BUILD_PROVENANCE_SCHEMA,
    gitCommitSha: commitSha,
    gitTreeSha: 'f'.repeat(40),
    serverLockSha256: 'a'.repeat(64),
    frontendLockSha256: 'b'.repeat(64),
    mlRequirementsSha256: 'c'.repeat(64),
    frontendArtifactInventory: frontendArtifacts.inventory,
    frontendArtifactSetSha256: artifactSetSha256(frontendArtifacts.inventory),
    serverImageIdentity: 'sha256:' + '1'.repeat(64),
    frontendImageIdentity: 'sha256:' + '2'.repeat(64),
    mlImageIdentity: 'sha256:' + '3'.repeat(64),
    workflowRunId: null,
    workflowRunAttempt: null,
    buildTimestamp: null,
    ...overrides,
  };
  manifest.provenanceSha256 = createHash('sha256').update(canonicalJson(manifest)).digest('hex');
  return manifest;
}
function publishTestBuildManifest(manifest) {
  const { frontendArtifactInventory: _frontendArtifactInventory, ...publicSummary } = manifest;
  return { status: 'VERIFIED', ...publicSummary };
}

const currentBinding = () => ({
  profileId: '64b000000000000000000001',
  profile_version: 4,
  recommendationId: '64b000000000000000000002',
  allocation_revision: 3,
  allocation_revision_id: '64b000000000000000000003',
  portfolio_fingerprint: 'a'.repeat(64),
  recommendation_fingerprint: 'b'.repeat(64),
  response_state: 'CURRENT',
  calculation_freshness: { fresh: true },
});

function demoTaxContext(overrides = {}) {
  return {
    annualGrossIncome: 500000,
    incomeSource: 'salary',
    regime: 'new',
    fiscalYear: 'FY2026-27',
    userAge: 35,
    holdingPeriodMonths: 18,
    section112AExemptionUsed: 0,
    sttConditionAssumedSatisfied: true,
    illustrativePrincipal: 1000000,
    ...overrides,
  };
}

const qualifiedNiftyEtf = () => ({
  id: 'etf:isin:INF204KB14I2',
  canonicalProductId: 'etf:isin:INF204KB14I2',
  parentInstrumentId: 'nifty_etf',
  productType: 'ETF',
  isin: 'INF204KB14I2',
  exchange: 'NSE',
  ticker: 'NIFTYBEES',
  externalIds: [
    { source: 'ISIN', value: 'INF204KB14I2' },
    { source: 'AMFI_SCHEME_CODE', value: '140084' },
    { source: 'NSE_TRADING_SYMBOL', value: 'NIFTYBEES' },
  ],
  benchmark: {
    id: 'NIFTY_50',
    name: 'NIFTY 50',
    canonicalProductId: 'market:index:nifty-50',
    returnVariant: 'NIFTY 50 TRI',
    source: { url: 'https://mf.nipponindiaim.com/FundsAndPerformance/ProductNotes/NipponIndia-ETF-Nifty-50-BeES-Feb-2026.pdf' },
  },
  identityEvidence: [
    { authority: 'NSE', url: 'https://nsearchives.nseindia.com/trading_security/mf/pdf/Nippon_20032026171200_NipponMutualFund.pdf' },
    { authority: 'NSE Clearing', url: 'https://nsearchives.nseindia.com/content/circulars/CMPT74390.pdf' },
  ],
  source: { provider: 'AMFI', url: 'https://portal.amfiindia.com/spages/NAVAll.txt' },
  nav: { value: 245.67, unit: 'NAV_PER_UNIT', observedAt: '2026-10-01T09:30:00.000Z' },
  marketPrice: { value: null, availabilityStatus: 'UNAVAILABLE' },
  primaryFact: {
    kind: 'MUTUAL_FUND_NAV',
    canonicalProductId: 'mf:amfi:140084',
    source: { provider: 'AMFI', instrumentId: '140084', url: 'https://portal.amfiindia.com/spages/NAVAll.txt' },
    unit: 'NAV_PER_UNIT',
    availabilityStatus: 'AVAILABLE',
    value: 245.67,
    observedAt: '2026-10-01T09:30:00.000Z',
    freshness: { status: 'FRESH' },
  },
});

const qualifiedWtiResponse = (products = [qualifiedNiftyEtf()], recommendation = currentBinding()) => ({
  success: true,
  financialStateBinding: {
    profileId: recommendation.profileId,
    profileVersion: recommendation.profile_version,
    recommendationId: recommendation.recommendationId,
    allocationRevision: recommendation.allocation_revision,
    allocationRevisionId: recommendation.allocation_revision_id,
    portfolioFingerprint: recommendation.portfolio_fingerprint,
    recommendationFingerprint: recommendation.recommendation_fingerprint,
  },
  total: products.length,
  products,
  ranking: {
    version: 'nifty-etf-ranking-1.0.0',
    status: 'VERIFIED_COMPARABLE_OPTIONS',
    authority: 'OFFICIAL_SCHEME_IDENTITY_AND_AMFI_CURRENT_NAV',
    method: null,
    hasUniqueLeader: false,
  },
  comparisonUniverse: {
    parentInstrumentId: 'nifty_etf',
    sourceProvider: 'AMFI',
    verifiedIdentityCount: products.length,
    freshNavProductCount: products.length,
    returnedProductCount: products.length,
  },
});

function fakeHttpResponse(status, body, { malformed = false } = {}) {
  return {
    ok: () => status >= 200 && status < 300,
    status: () => status,
    json: async () => {
      if (malformed) throw new SyntaxError('body omitted from diagnostics');
      return body;
    },
  };
}

function browserFlowFixture(scenario = {}) {
  let currentUrl = 'http://127.0.0.1:5173/login';
  let requestListener = null;
  let responseListener = null;
  const recommendation = currentBinding();
  const rankBinding = {
    profileId: recommendation.profileId,
    profileVersion: recommendation.profile_version,
    recommendationId: recommendation.recommendationId,
    allocationRevision: recommendation.allocation_revision,
    allocationRevisionId: recommendation.allocation_revision_id,
    portfolioFingerprint: recommendation.portfolio_fingerprint,
    recommendationFingerprint: recommendation.recommendation_fingerprint,
  };
  const login = fakeHttpResponse(scenario.loginStatus ?? 200, {});
  let uiPrincipal = 10000;
  let uiTaxApplied = false;
  const uiTaxInputs = new Map();
  const queuedWtiResponses = [];
  const pendingWtiResponseWaiters = [];
  const buildSubmittedUiTaxContext = () => {
    const context = { illustrativePrincipal: uiPrincipal };
    const numericFields = new Set([
      'annualGrossIncome', 'userAge', 'holdingPeriodMonths', 'section112AExemptionUsed',
    ]);
    const selectors = {
      '#wti-annual-income': 'annualGrossIncome',
      '#wti-income-source': 'incomeSource',
      '#wti-tax-regime': 'regime',
      '#wti-fiscal-year': 'fiscalYear',
      '#wti-user-age': 'userAge',
      '#wti-holding-period': 'holdingPeriodMonths',
      '#wti-112a-exemption': 'section112AExemptionUsed',
      '#wti-acquisition-date': 'acquisitionDate',
      '#wti-redemption-date': 'redemptionDate',
    };
    for (const [selector, name] of Object.entries(selectors)) {
      if (uiTaxInputs.has(selector)) {
        const value = uiTaxInputs.get(selector);
        context[name] = numericFields.has(name) ? Number(value) : value;
      }
    }
    if (uiTaxInputs.get('#wti-stt-condition-assumed-satisfied') === true) {
      context.sttConditionAssumedSatisfied = true;
    }
    return context;
  };
  const createWtiUiResponse = () => {
    const taxCalculationContext = uiTaxApplied
      ? buildSubmittedUiTaxContext()
      : { illustrativePrincipal: uiPrincipal };
    const uiProduct = scenario.frontendWtiTaxUnavailable
      ? { ...qualifiedNiftyEtf(), postTaxAnalysis: { status: 'TAX_CLASSIFICATION_UNAVAILABLE' } }
      : qualifiedNiftyTaxProductFixture(taxCalculationContext);
    if (scenario.frontendWtiWrongProduct) uiProduct.canonicalProductId = 'etf:isin:OTHER';
    const uiWtiBody = qualifiedWtiResponse([uiProduct], recommendation);
    if (scenario.frontendWtiBindingMismatch) uiWtiBody.financialStateBinding.allocationRevision += 1;
    if (scenario.frontendWtiResponseMutation) scenario.frontendWtiResponseMutation(uiWtiBody);
    const requestBody = {
      profileId: recommendation.profileId,
      profileVersion: recommendation.profile_version + (scenario.frontendWtiRequestBindingMismatch ? 1 : 0),
      recommendationId: recommendation.recommendationId,
      expectedAllocationRevision: recommendation.allocation_revision,
      expectedAllocationRevisionId: recommendation.allocation_revision_id,
      expectedPortfolioFingerprint: recommendation.portfolio_fingerprint,
      expectedRecommendationFingerprint: recommendation.recommendation_fingerprint,
      parentInstrumentId: 'nifty_etf',
      taxCalculationContext,
    };
    return {
      ...fakeHttpResponse(200, uiWtiBody),
      url: () => 'http://127.0.0.1:5000/api/instruments/rank-wti',
      request: () => ({ method: () => 'POST', postDataJSON: () => requestBody }),
    };
  };
  const publishWtiUiResponse = () => {
    const response = createWtiUiResponse();
    const waiterIndex = pendingWtiResponseWaiters.findIndex(waiter => {
      try { return waiter.predicate(response); } catch { return false; }
    });
    if (waiterIndex >= 0) pendingWtiResponseWaiters.splice(waiterIndex, 1)[0].resolve(response);
    else queuedWtiResponses.push(response);
  };
  const page = {
    on(event, callback) {
      if (event === 'request') requestListener = callback;
      if (event === 'response') responseListener = callback;
    },
    async goto(url) {
      if (url.endsWith('/login')) {
        currentUrl = url;
        if (scenario.loginNavigationError) throw scenario.loginNavigationError;
        if (scenario.loginNavigationStatus) return fakeHttpResponse(scenario.loginNavigationStatus, {});
        const artifacts = makeTestFrontendArtifacts('c'.repeat(40), {
          indexSuffix: scenario.frontendIndexTampered || scenario.browserLoadedDocumentTampered ? '<!-- same build marker, changed document -->' : '',
        });
        const response = {
          ...fakeHttpResponse(200, {}),
          url: () => url,
          body: async () => artifacts.contents.get('index.html'),
        };
        responseListener?.(response);
        return response;
      }
      currentUrl = url;
      if (url.endsWith('/profile')) {
        if (scenario.dashboardRedirectLogin) currentUrl = 'http://127.0.0.1:5173/login';
        if (scenario.dashboardWrongPath) currentUrl = 'http://127.0.0.1:5173/';
        const providerUrl = typeof scenario.directProviderRequest === 'string'
          ? scenario.directProviderRequest
          : scenario.directProviderRequest
            ? 'https://portal.amfiindia.com/private?token=hidden'
            : null;
        if (providerUrl) requestListener?.({ url: () => providerUrl });
        if (scenario.providerRequestInspectionError) requestListener?.({ url: () => { throw new Error('uninspectable request'); } });
        if (scenario.profileNavigationStatus) return fakeHttpResponse(scenario.profileNavigationStatus, {});
      }
      if (scenario.dashboardError) throw Object.assign(new Error('secret browser detail'), { code: 'DASHBOARD_FAILED' });
      return fakeHttpResponse(200, {});
    },
    locator(selector) {
      const isWtiCategory = selector === '[data-testid="wti-category-nifty_etf"]';
      const isWtiProduct = selector === '[data-testid="wti-product-etf:isin:INF204KB14I2"]'
        || selector === '[data-testid="nav-investments"] [data-testid="wti-product-etf:isin:INF204KB14I2"]';
      const isUnavailableTax = selector.includes('wti-post-tax-cta-box');
      const isCalculatedTax = selector.includes('.wti-post-tax-box');
      return {
        async waitFor() {
          if (selector === 'aside.sidebar' && scenario.dashboardError) throw Object.assign(new Error('secret dashboard detail'), { code: 'DASHBOARD_FAILED' });
          if (selector === 'aside.sidebar' && scenario.sidebarMissing) throw Object.assign(new Error('sidebar missing'), { name: 'TimeoutError' });
          if (selector === '#login-form' && scenario.loginFormError) throw Object.assign(new Error('secret login detail'), { code: 'LOGIN_FORM_TIMEOUT' });
          if (selector !== '#login-form' && selector !== 'aside.sidebar' && scenario.loginControlError) throw Object.assign(new Error('secret login control detail'), { code: 'LOGIN_CONTROL_TIMEOUT' });
          if (isWtiCategory && scenario.frontendWtiMissing) throw Object.assign(new Error('category missing'), { name: 'TimeoutError' });
          if (isWtiProduct && (scenario.frontendWtiWrongProduct || scenario.frontendWtiBindingMismatch)) throw Object.assign(new Error('product unavailable'), { name: 'TimeoutError' });
          if (selector === '.wti-tax-drawer' && scenario.frontendWtiTaxDrawerMissing) throw Object.assign(new Error('tax drawer missing'), { name: 'TimeoutError' });
          if (isCalculatedTax && scenario.frontendWtiTaxHidden) throw Object.assign(new Error('calculated tax state missing'), { name: 'TimeoutError' });
          if (isUnavailableTax && scenario.frontendWtiTaxUnavailable) throw Object.assign(new Error('unavailable tax state unexpectedly rendered'), { name: 'TimeoutError' });
        },
        async fill(value) { uiTaxInputs.set(selector, String(value)); },
        async selectOption(value) { uiTaxInputs.set(selector, typeof value === 'string' ? value : value.value); },
        async check() { uiTaxInputs.set(selector, true); },
        async click() {
          if (selector === '[data-testid="wti-category-nifty_etf"]') {
            if (scenario.frontendWtiDirectProviderRequest) requestListener?.({ url: () => 'https://portal.amfiindia.com/spages/NAVAll.txt' });
            publishWtiUiResponse();
          } else if (selector.startsWith('.wti-amount-btn[title="Use ₹')) {
            const amountText = selector.match(/Use ₹([\d,]+) as the server calculation principal/)?.[1];
            if (amountText) {
              uiPrincipal = Number(amountText.replaceAll(',', ''));
              publishWtiUiResponse();
            }
          } else if (selector === '.wti-apply-tax-btn') {
            uiTaxApplied = true;
            publishWtiUiResponse();
          }
        },
        async isVisible() {
          if (selector === 'aside.sidebar') return !scenario.sidebarMissing;
          if (isWtiCategory) return !scenario.frontendWtiMissing;
          if (isWtiProduct) return !scenario.frontendWtiWrongProduct && !scenario.frontendWtiBindingMismatch;
          if (isUnavailableTax) return Boolean(scenario.frontendWtiTaxUnavailable);
          if (isCalculatedTax) return !scenario.frontendWtiTaxHidden && !scenario.frontendWtiTaxUnavailable;
          return true;
        },
        async innerText() {
          if (selector === '.wti-amount-btn--active') return `₹${uiPrincipal.toLocaleString('en-IN')}`;
          return isCalculatedTax
            ? 'Exact-product tax illustration HISTORICAL — NOT A FORECAST.'
            : 'Exact-product tax illustration: tax classification unavailable.';
        },
        locator(childSelector) { return page.locator(`${selector} ${childSelector}`); },
      };
    },
    async waitForResponse(predicate) {
      const loginResponse = {
        ...login,
        url: () => 'http://127.0.0.1:5000/api/auth/login',
        request: () => ({ method: () => 'POST' }),
      };
      if (predicate(loginResponse)) return loginResponse;
      const queuedIndex = queuedWtiResponses.findIndex(response => {
        try { return predicate(response); } catch { return false; }
      });
      if (queuedIndex >= 0) return queuedWtiResponses.splice(queuedIndex, 1)[0];
      return new Promise((resolve, reject) => {
        pendingWtiResponseWaiters.push({ predicate, resolve, reject });
      });
    },
    async evaluate() {
      const artifacts = makeTestFrontendArtifacts('c'.repeat(40), {
        scriptSha: scenario.frontendAssetShaMismatch ? 'd'.repeat(40) : 'c'.repeat(40),
        scriptSuffix: scenario.frontendAssetBytesTampered || scenario.browserLoadedScriptTampered ? ' window.extra = true;' : '',
        cssSuffix: scenario.frontendCssTampered || scenario.browserLoadedStylesheetTampered ? ' .tampered { display: block; }' : '',
      });
      for (const artifactPath of ['assets/app.js', 'assets/app.css']) {
        const assetUrl = 'http://127.0.0.1:5173/' + artifactPath;
        responseListener?.({
          ...fakeHttpResponse(200, {}),
          url: () => assetUrl,
          body: async () => artifacts.contents.get(artifactPath),
        });
      }
      return {
        buildSha: scenario.frontendBuildSha ?? 'c'.repeat(40),
        scripts: [
          'http://127.0.0.1:5173/assets/app.js',
          ...(scenario.frontendUnlistedScript ? ['http://127.0.0.1:5173/assets/unlisted.js'] : []),
          ...(scenario.frontendExternalScript ? ['https://untrusted.example/external.js'] : []),
        ],
        stylesheets: [
          'http://127.0.0.1:5173/assets/app.css',
          'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=Outfit:wght@300;400;500;600;700;800;900&display=swap',
        ],
      };
    },
    url: () => currentUrl,
    request: {
      async post(url) {
        if (url.endsWith('/profile/complete')) {
          return fakeHttpResponse(scenario.completionStatus ?? 200, { profile: { profileId: recommendation.profileId } });
        }
        if (url.endsWith('/instruments/rank-wti')) {
          if (scenario.wtiError) throw scenario.wtiError;
          if (scenario.wtiStatus) return fakeHttpResponse(scenario.wtiStatus, { code: scenario.wtiCode || 'UPSTREAM_UNAVAILABLE' });
          if (scenario.wtiMalformed) return fakeHttpResponse(200, null, { malformed: true });
          const products = scenario.products ?? [qualifiedNiftyTaxProductFixture(scenario.taxContext ?? demoTaxContext())];
          const body = qualifiedWtiResponse(products, recommendation);
          if (scenario.wtiMissingBinding) delete body.financialStateBinding;
          if (scenario.wtiBindingMismatch) body.financialStateBinding = { ...rankBinding, allocationRevision: 99 };
          if (scenario.wtiMetadataMutation) scenario.wtiMetadataMutation(body);
          return fakeHttpResponse(200, body);
        }
        throw new Error('unexpected fake POST endpoint');
      },
      async get(url) {
        if (url.endsWith('/profile/current')) return fakeHttpResponse(200, { profileId: recommendation.profileId });
        if (url.includes('/recommend/current?')) {
          if (scenario.recommendationError) throw Object.assign(new Error('secret recommendation URL'), { code: 'ECONNRESET' });
          if (scenario.recommendationStatus) return fakeHttpResponse(scenario.recommendationStatus, {});
          return fakeHttpResponse(200, recommendation);
        }
        throw new Error('unexpected fake GET endpoint');
      },
    },
  };
  const browser = {
    async newContext(options) {
      scenario.browserContextOptions = options;
      return {
        newPage: async () => page,
        ...(scenario.browserRouteMissing ? {} : { async route() {} }),
        request: {
          async get(url) {
            if (url.endsWith('/build-provenance/provenance.json')) {
              let manifest;
              if (scenario.frontendProvenanceMismatch) {
                const alternate = makeTestFrontendArtifacts('c'.repeat(40), { indexSuffix: '<!--different valid artifact set-->' });
                manifest = makeTestBuildManifest('c'.repeat(40), {
                  frontendArtifactInventory: alternate.inventory,
                  frontendArtifactSetSha256: artifactSetSha256(alternate.inventory),
                });
              } else {
                manifest = makeTestBuildManifest('c'.repeat(40));
              }
              return { ok: () => true, json: async () => manifest };
            }
            const artifacts = makeTestFrontendArtifacts('c'.repeat(40), {
              scriptSha: scenario.frontendAssetShaMismatch ? 'd'.repeat(40) : 'c'.repeat(40),
              scriptSuffix: scenario.frontendAssetBytesTampered ? ' window.extra = true;' : '',
              cssSuffix: scenario.frontendCssTampered ? ' .tampered { display: block; }' : '',
              indexSuffix: scenario.frontendIndexTampered ? '<!-- same build marker, changed document -->' : '',
            });
            const artifactPath = decodeURIComponent(new URL(url).pathname.replace(/^\/+/, ''));
            const resolvedPath = artifactPath === 'login' ? 'index.html' : artifactPath;
            const bytes = artifacts.contents.get(resolvedPath);
            const missing = scenario.frontendMissingArtifact && resolvedPath === 'assets/app.css';
            return {
              ok: () => Boolean(bytes) && !missing,
              body: async () => bytes || Buffer.alloc(0),
            };
          },
        },
        cookies: async () => scenario.missingCsrfCookie ? [] : [{ name: 'wg_csrf', value: 'fake-csrf-value' }],
      };
    },
    async close() {},
  };
  const fetcher = async url => {
    if (url.endsWith('/build-provenance/provenance.json')) {
      let manifest;
      if (scenario.frontendProvenanceMismatch) {
        const alternate = makeTestFrontendArtifacts('c'.repeat(40), { indexSuffix: '<!--different valid artifact set-->' });
        manifest = makeTestBuildManifest('c'.repeat(40), {
          frontendArtifactInventory: alternate.inventory,
          frontendArtifactSetSha256: artifactSetSha256(alternate.inventory),
        });
      } else {
        manifest = makeTestBuildManifest('c'.repeat(40));
      }
      return new Response(JSON.stringify(manifest), { status: 200 });
    }
    const artifacts = makeTestFrontendArtifacts('c'.repeat(40), {
      scriptSha: scenario.frontendAssetShaMismatch ? 'd'.repeat(40) : 'c'.repeat(40),
      scriptSuffix: scenario.frontendAssetBytesTampered ? ' window.extra = true;' : '',
      cssSuffix: scenario.frontendCssTampered ? ' .tampered { display: block; }' : '',
      indexSuffix: scenario.frontendIndexTampered ? '<!-- same build marker, changed document -->' : '',
    });
    const artifactPath = decodeURIComponent(new URL(url).pathname.replace(/^\/+/, ''));
    const resolvedPath = artifactPath === 'login' ? 'index.html' : artifactPath;
    const bytes = artifacts.contents.get(resolvedPath);
    const missing = scenario.frontendMissingArtifact && resolvedPath === 'assets/app.css';
    return new Response(bytes && !missing ? bytes : null, { status: bytes && !missing ? 200 : 404 });
  };
  return {
    browser,
    fetcher,
    launchBrowser: scenario.launchError ? async () => { throw scenario.launchError; } : async () => browser,
  };
}

async function runBrowserFlow(scenario = {}) {
  const lines = [];
  const reporter = makeReporter(line => lines.push(line));
  const fixture = browserFlowFixture(scenario);
  await checkBrowserAndFinancialFlow(reporter, {
    apiBase: 'http://127.0.0.1:5000/api',
    frontendUrl: 'http://127.0.0.1:5173',
    completionPayload: { profile: 'fixture only' },
    taxContext: scenario.taxContext ?? demoTaxContext({ illustrativePrincipal: 100000 }),
    email: 'demo@example.invalid',
    password: 'fixture-password',
    idempotencyKey: 'fixture-idempotency-key',
    parentInstrumentId: scenario.parentInstrumentId ?? 'nifty_etf',
    expectedBuildSha: 'c'.repeat(40),
    expectedGitTreeSha: 'f'.repeat(40),
    expectedProvenanceSha256: makeTestBuildManifest('c'.repeat(40)).provenanceSha256,
    expectedFrontendArtifactSetSha256: makeTestBuildManifest('c'.repeat(40)).frontendArtifactSetSha256,
  }, fixture);
  return { ...reporter.finish(), lines };
}

test('local build identity scopes Git safe.directory to this repository', () => {
  const calls = [];
  const result = readLocalBuildIdentity((command, args, options) => {
    calls.push({ command, args, options });
    return args.includes('HEAD')
      ? { status: 0, stdout: `${'a'.repeat(40)}\n` }
      : { status: 0, stdout: '' };
  });

  assert.equal(result.sha, 'a'.repeat(40));
  assert.equal(result.clean, true);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.command, 'git');
    assert.match(call.args[1], /^safe\.directory=/);
    assert.ok(call.args[1].includes('/'));
    assert.notEqual(call.args[1], 'safe.directory=*');
    assert.equal(call.options.cwd, calls[0].options.cwd);
  }
});

test('demo preflight only accepts a complete current financial-state binding', () => {
  assert.equal(hasCurrentFinancialBinding(currentBinding()), true);

  for (const mutation of [
    value => { value.response_state = 'HISTORICAL_GENERATION'; },
    value => { value.calculation_freshness.fresh = false; },
    value => { value.allocation_revision_id = ''; },
    value => { value.portfolio_fingerprint = 'not-a-fingerprint'; },
    value => { value.profile_version = 0; },
    value => { value.profile_version = '4'; },
  ]) {
    const staleOrIncomplete = currentBinding();
    mutation(staleOrIncomplete);
    assert.equal(hasCurrentFinancialBinding(staleOrIncomplete), false);
  }
});

test('demo preflight does not treat the login React root as an authenticated dashboard', () => {
  assert.equal(hasAuthenticatedDashboard({ pathname: '/profile', sidebarVisible: true }), true);
  assert.equal(hasAuthenticatedDashboard({ pathname: '/profile', sidebarVisible: false }), false);
  assert.equal(hasAuthenticatedDashboard({ pathname: '/login', sidebarVisible: true }), false);
  assert.equal(hasAuthenticatedDashboard({ pathname: '/profile/', sidebarVisible: true }), true);
});

test('demo preflight binds product-ranking results to the same recommendation state', () => {
  const recommendation = currentBinding();
  const rankBinding = {
    profileId: recommendation.profileId,
    profileVersion: recommendation.profile_version,
    recommendationId: recommendation.recommendationId,
    allocationRevision: recommendation.allocation_revision,
    allocationRevisionId: recommendation.allocation_revision_id,
    portfolioFingerprint: recommendation.portfolio_fingerprint,
    recommendationFingerprint: recommendation.recommendation_fingerprint,
  };
  assert.equal(matchesRecommendationBinding(rankBinding, recommendation), true);
  assert.equal(matchesRecommendationBinding({ ...rankBinding, allocationRevisionId: '64b000000000000000000004' }, recommendation), false);
  assert.equal(matchesRecommendationBinding(rankBinding, null), false);
});

test('demo preflight never allows optional Redis settings to weaken production readiness', () => {
  assert.equal(isRedisRequired({ NODE_ENV: 'production', DEMO_REQUIRE_REDIS: 'false', REQUIRE_REDIS: 'false' }), true);
  assert.equal(isRedisRequired({ NODE_ENV: 'test', REQUIRE_REDIS: 'true' }), true);
  assert.equal(isRedisRequired({ NODE_ENV: 'development' }), false);
});

test('demo preflight requires exact NIFTY 50 identity and fresh primary-fact provenance', () => {
  assert.equal(qualifiesExactNiftyEtf(qualifiedNiftyEtf()), true);

  const invalidProducts = [
    product => { product.parentInstrumentId = 'liquid_etf'; },
    product => { product.benchmark.canonicalProductId = 'market:index:sensex'; },
    product => { product.identityEvidence[0].url = 'https://nsearchives.nseindia.com/trading_security/mf/pdf/unrelated.pdf'; },
    product => { product.identityEvidence.pop(); },
    product => { product.benchmark.source.url = 'https://mf.nipponindiaim.com.evil.example/fake'; },
    product => { product.benchmark.source.url = 'https://mf.nipponindiaim.com/FundsAndPerformance/Pages/unrelated.aspx'; },
    product => { product.source.url = 'https://portal.amfiindia.com.evil.example/fake'; },
    product => { product.source.url = 'https://portal.amfiindia.com/spages/unrelated.txt'; },
    product => { product.primaryFact.source.instrumentId = '999999'; },
    product => { product.primaryFact.canonicalProductId = 'mf:amfi:140085'; },
    product => { product.primaryFact.freshness.status = 'STALE'; },
    product => { product.primaryFact.source.provider = 'OTHER_SOURCE'; },
    product => { product.primaryFact.source.url = 'http://unverified.example/nav'; },
    product => { product.nav.value = 99999; },
    product => { product.primaryFact.availabilityStatus = 'UNAVAILABLE'; },
    product => { product.primaryFact.observedAt = 'not-a-date'; },
    product => { product.canonicalProductId = ''; },
    product => { product.isin = 'INF204KB15I9'; },
    product => { product.externalIds[1].value = 'INF204KB15I9'; },
    product => { product.ticker = 'NIFTY50BEES'; },
    product => { product.externalIds[2].value = 'NIFTY50BEES'; },
    product => { product.productType = 'MUTUAL_FUND'; },
  ];

  for (const mutate of invalidProducts) {
    const product = qualifiedNiftyEtf();
    mutate(product);
    assert.equal(qualifiesExactNiftyEtf(product), false);
  }

  const renamedProduct = qualifiedNiftyEtf();
  renamedProduct.name = 'A totally different display name';
  assert.equal(qualifiesExactNiftyEtf(renamedProduct), true, 'stable source IDs, not the display name, establish identity');
  const differentExchangePrice = qualifiedNiftyEtf();
  differentExchangePrice.marketPrice.value = 99999;
  assert.equal(qualifiesExactNiftyEtf(differentExchangePrice), true, 'an exchange price is not substituted for the AMFI NAV fact');
});

const MARKET_FIXTURE_NOW = new Date('2026-10-05T04:30:00.000Z'); // 10:00 IST, weekday
const MARKET_FIXTURE_PRIOR_SESSION = '2026-10-02';

function marketFixtureTimestamp(isoDate, hour, minute, second = 0) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second) - (330 * 60 * 1000)).toISOString();
}

function qualifiedMarketContext({
  session = 'MARKET_OPEN',
  now = MARKET_FIXTURE_NOW,
  quoteDate = null,
  historyDate = MARKET_FIXTURE_PRIOR_SESSION,
  quoteTimestamp = null,
  sessionCheckedAt = null,
  snapshotStatus = null,
} = {}) {
  const currentDate = isoDateInIndia(now);
  const parts = indiaClockParts(now);
  const completedQuoteDate = quoteDate || (session === 'MARKET_HOLIDAY' ? MARKET_FIXTURE_PRIOR_SESSION : currentDate);
  const quoteTime = quoteTimestamp || (session === 'MARKET_HOLIDAY'
    ? marketFixtureTimestamp(completedQuoteDate, 15, 30)
    : session === 'MARKET_CLOSED'
      ? marketFixtureTimestamp(completedQuoteDate, 15, 59)
      : marketFixtureTimestamp(completedQuoteDate, parts.hour, Math.max(0, parts.minute - 1)));
  const checkedAt = sessionCheckedAt || new Date(now.getTime() - 30_000).toISOString();
  const fetchedAt = checkedAt;
  const calendar = {
    status: 'AVAILABLE',
    source: { provider: 'NSE', url: 'https://www.nseindia.com/api/holiday-master' },
    fetchedAt: new Date(now.getTime() - 60_000).toISOString(),
  };
  const quoteFreshness = { status: 'FRESH', marketSession: session, tradingDate: currentDate };
  const sources = [
    {
      provider: 'NSE', instrumentId: 'NIFTY 50', url: 'https://www.nseindia.com/api/allIndices',
      observedAt: quoteTime, providerTimestamp: quoteTime, fetchedAt, freshness: quoteFreshness,
      effectiveTradingDate: completedQuoteDate, dataClass: 'LIVE',
    },
    {
      provider: 'NSE', instrumentId: 'INDIA VIX', url: 'https://www.nseindia.com/api/allIndices',
      observedAt: quoteTime, providerTimestamp: quoteTime, fetchedAt, freshness: quoteFreshness,
      effectiveTradingDate: completedQuoteDate, dataClass: 'LIVE',
    },
    {
      provider: 'NSE', instrumentId: 'NIFTY 50', url: 'https://www.nseindia.com/api/historicalOR/indicesHistory',
      observedAt: marketFixtureTimestamp(historyDate, 15, 30),
      providerTimestamp: marketFixtureTimestamp(historyDate, 15, 30), fetchedAt,
      freshness: { status: 'FRESH' }, effectiveTradingDate: historyDate, dataClass: 'DAILY',
    },
  ];
  const snapshot = {
    status: snapshotStatus || (session === 'MARKET_OPEN' ? 'CURRENT' : 'MARKET_CLOSED'),
    availability: 'AVAILABLE',
    policyAvailability: 'AVAILABLE',
    policyOutput: { status: 'MARKET_CONTEXT_AVAILABLE' },
    recommendationUsability: { status: 'USABLE' },
    observedAt: quoteTime,
    evaluatedAt: now.toISOString(),
    marketSession: { status: session, tradingDate: currentDate, checkedAt },
    providerSelection: { selectedProvider: 'NSE' },
    providerStatus: {
      quotes: {
        provider: 'NSE', status: 'AVAILABLE',
        qualification: 'OFFICIAL_NSE_WEBSITE_ENDPOINT_UNDOCUMENTED_SCHEMA_VALIDATED',
        calendar,
      },
      history: {
        provider: 'NSE', status: 'AVAILABLE',
        qualification: 'OFFICIAL_NSE_WEBSITE_ENDPOINT_UNDOCUMENTED_SCHEMA_VALIDATED',
        calendar,
      },
    },
    provenance: {
      qualification: 'OFFICIAL_NSE_WEBSITE_ENDPOINT_UNDOCUMENTED_SCHEMA_VALIDATED',
      sources,
    },
    observedFacts: ['nifty50Current', 'indiaVixCurrent'].map((key, index) => ({
      key,
      value: index === 0 ? 24000 : 14,
      dataClass: 'LIVE',
      availabilityStatus: 'AVAILABLE',
      observedAt: quoteTime,
      freshness: quoteFreshness,
      source: {
        provider: 'NSE', instrumentId: index === 0 ? 'NIFTY 50' : 'INDIA VIX',
        url: 'https://www.nseindia.com/api/allIndices',
      },
    })),
    derivedFacts: [{ value: 0.25, availabilityStatus: 'AVAILABLE', freshness: { status: 'FRESH' } }],
  };
  return {
    response: { ok: true, status: 200 },
    body: {
      status: 'MARKET_CONTEXT_AVAILABLE',
      recommendationUsability: { status: 'USABLE' },
      marketSnapshot: snapshot,
    },
  };
}

test('preflight accepts source-qualified current MARKET_OPEN quotes only during the current IST session', () => {
  const result = qualifiedMarketContext();
  const assessment = assessCurrentMarketContext(result, { now: MARKET_FIXTURE_NOW });
  assert.equal(assessment.marketContextAvailable, true);
  assert.equal(assessment.sessionStatus, 'MARKET_OPEN');
  assert.match(assessment.sessionDetail, /intraday quotes/);
});

test('preflight respects the backend’s inclusive 09:15–15:30 IST MARKET_OPEN boundaries', () => {
  for (const [now, label] of [
    [new Date('2026-10-05T03:45:00.000Z'), '09:15 IST'],
    [new Date('2026-10-05T10:00:00.000Z'), '15:30 IST'],
  ]) {
    const result = qualifiedMarketContext({ now, quoteTimestamp: now.toISOString(), sessionCheckedAt: now.toISOString() });
    assert.equal(assessCurrentMarketContext(result, { now }).marketContextAvailable, true, label);
  }
  const afterClose = new Date('2026-10-05T10:01:00.000Z'); // 15:31 IST
  const staleOpenClassification = qualifiedMarketContext({ now: afterClose, quoteTimestamp: afterClose.toISOString() });
  assert.equal(assessCurrentMarketContext(staleOpenClassification, { now: afterClose }).marketContextAvailable, false);
});

test('preflight accepts a verified holiday only as the coherent latest completed session', () => {
  const now = new Date('2026-10-05T04:30:00.000Z');
  const result = qualifiedMarketContext({ session: 'MARKET_HOLIDAY', now });
  const before = structuredClone(result.body.marketSnapshot);
  const assessment = assessCurrentMarketContext(result, { now });
  assert.equal(assessment.marketContextAvailable, true);
  assert.equal(assessment.sessionStatus, 'MARKET_HOLIDAY');
  assert.match(assessment.sessionDetail, /latest-completed-session/);
  assert.match(assessment.sessionDetail, /does not assert an intraday quote/);
  assert.deepEqual(result.body.marketSnapshot, before, 'assessment does not rewrite quote values, timestamps, or freshness');

  const mismatchedHistory = qualifiedMarketContext({ session: 'MARKET_HOLIDAY', now });
  mismatchedHistory.body.marketSnapshot.provenance.sources[2].effectiveTradingDate = '2026-10-01';
  assert.equal(assessCurrentMarketContext(mismatchedHistory, { now }).marketContextAvailable, false);
});

test('preflight accepts weekday MARKET_CLOSED only after close with today’s close evidence', () => {
  const now = new Date('2026-10-05T10:30:00.000Z'); // 16:00 IST
  const result = qualifiedMarketContext({ session: 'MARKET_CLOSED', now });
  const assessment = assessCurrentMarketContext(result, { now });
  assert.equal(assessment.marketContextAvailable, true);
  assert.match(assessment.sessionDetail, /completed close/);
});

test('preflight accepts Saturday weekend evidence for the latest completed NSE session after a Friday holiday', () => {
  const now = new Date('2026-10-03T10:30:00.000Z'); // Saturday, 16:00 IST; Friday 2026-10-02 is an NSE holiday
  const result = qualifiedMarketContext({
    session: 'MARKET_CLOSED',
    now,
    quoteDate: '2026-10-01',
    historyDate: '2026-10-01',
  });
  const assessment = assessCurrentMarketContext(result, { now });

  assert.equal(assessment.marketContextAvailable, true);
  assert.equal(assessment.sessionStatus, 'MARKET_CLOSED');
  assert.match(assessment.sessionDetail, /MARKET_WEEKEND/);
  assert.match(assessment.sessionDetail, /latest-completed-session/);
  assert.match(assessment.sessionDetail, /no intraday quote is asserted/);
});

test('preflight rejects stale, unknown, incoherent, unsupported, or incomplete market-session evidence', () => {
  const cases = [
    ['Upstox lacks the NSE session/calendar proof', result => { result.body.marketSnapshot.providerSelection.selectedProvider = 'UPSTOX'; }],
    ['mixed providers', result => { result.body.marketSnapshot.providerStatus.history.provider = 'UPSTOX'; }],
    ['unknown session', result => { result.body.marketSnapshot.marketSession.status = 'UNKNOWN'; }],
    ['wrong session trading date', result => { result.body.marketSnapshot.marketSession.tradingDate = '2026-10-02'; }],
    ['stale session check', result => { result.body.marketSnapshot.marketSession.checkedAt = '2026-10-05T03:00:00.000Z'; }],
    ['future session check', result => { result.body.marketSnapshot.marketSession.checkedAt = '2026-10-05T04:31:00.000Z'; }],
    ['unavailable official calendar', result => { result.body.marketSnapshot.providerStatus.quotes.calendar.status = 'UNAVAILABLE'; }],
    ['calendar from an unqualified URL', result => { result.body.marketSnapshot.providerStatus.history.calendar.source.url = 'https://example.invalid/calendar'; }],
    ['stale official calendar', result => { result.body.marketSnapshot.providerStatus.quotes.calendar.fetchedAt = '2026-10-03T00:00:00.000Z'; }],
    ['missing history provenance', result => { result.body.marketSnapshot.provenance.sources.pop(); }],
    ['duplicate quote provenance', result => { result.body.marketSnapshot.provenance.sources.push(structuredClone(result.body.marketSnapshot.provenance.sources[0])); }],
    ['mismatched quote dates', result => { result.body.marketSnapshot.provenance.sources[1].effectiveTradingDate = '2026-10-01'; }],
    ['provider timestamp mismatch', result => { result.body.marketSnapshot.provenance.sources[0].providerTimestamp = '2026-10-05T04:00:00.000Z'; }],
    ['missing NIFTY', result => { result.body.marketSnapshot.observedFacts[0].availabilityStatus = 'UNAVAILABLE'; }],
    ['stale NIFTY', result => { result.body.marketSnapshot.observedFacts[0].freshness.status = 'STALE'; }],
    ['missing VIX', result => { result.body.marketSnapshot.observedFacts[1].availabilityStatus = 'UNAVAILABLE'; }],
    ['stale VIX', result => { result.body.marketSnapshot.observedFacts[1].freshness.status = 'STALE'; }],
    ['missing derived history', result => { result.body.marketSnapshot.derivedFacts = []; }],
    ['not usable for recommendations', result => { result.body.marketSnapshot.recommendationUsability.status = 'NOT_USABLE'; }],
    ['last-known-good display state', result => { result.body.marketSnapshot.status = 'LAST_AVAILABLE'; }],
    ['recovered last-known-good snapshot', result => { result.body.marketSnapshot.recoveredFromLastKnownGood = true; }],
  ];
  for (const [name, mutate] of cases) {
    const result = qualifiedMarketContext();
    mutate(result);
    assert.equal(assessCurrentMarketContext(result, { now: MARKET_FIXTURE_NOW }).marketContextAvailable, false, name);
  }
});

test('preflight rejects holiday evidence cached across the IST date rollover', () => {
  const cachedBeforeIstMidnight = new Date('2026-10-05T18:29:30.000Z'); // 23:59:30 IST
  const afterIstMidnight = new Date('2026-10-05T18:35:00.000Z'); // 00:05 IST next day
  const result = qualifiedMarketContext({ session: 'MARKET_HOLIDAY', now: cachedBeforeIstMidnight });
  assert.equal(assessCurrentMarketContext(result, { now: afterIstMidnight }).marketContextAvailable, false);
});

test('preflight keeps weekday pre-market and stale-open classifications failed while accepting a coherent weekend', () => {
  const preMarketNow = new Date('2026-10-05T03:30:00.000Z'); // 09:00 IST
  const preMarket = qualifiedMarketContext({
    session: 'MARKET_CLOSED', now: preMarketNow, quoteDate: MARKET_FIXTURE_PRIOR_SESSION,
    historyDate: '2026-10-01',
  });
  assert.equal(assessCurrentMarketContext(preMarket, { now: preMarketNow }).marketContextAvailable, false);

  const weekendNow = new Date('2026-10-03T10:30:00.000Z'); // Saturday, 16:00 IST
  const latestCompletedTradingDate = previousNseTradingDate('2026-10-03', ['2026-10-02']);
  assert.equal(latestCompletedTradingDate, '2026-10-01');
  const weekend = qualifiedMarketContext({
    session: 'MARKET_CLOSED', now: weekendNow, quoteDate: latestCompletedTradingDate,
    historyDate: latestCompletedTradingDate,
  });
  const weekendAssessment = assessCurrentMarketContext(weekend, { now: weekendNow });
  assert.equal(weekendAssessment.marketContextAvailable, true);
  assert.match(weekendAssessment.sessionDetail, /MARKET_WEEKEND/);

  const staleOpen = qualifiedMarketContext({ snapshotStatus: 'LAST_AVAILABLE' });
  assert.equal(assessCurrentMarketContext(staleOpen, { now: MARKET_FIXTURE_NOW }).marketContextAvailable, false);
});

test('preflight accepts Sunday and an ordinary Saturday using the calendar-derived latest completed session', () => {
  const cases = [
    {
      now: new Date('2026-10-04T10:30:00.000Z'),
      holidayDates: ['2026-10-02'],
      expectedLatest: '2026-10-01',
      label: 'Sunday after Friday NSE holiday',
    },
    {
      now: new Date('2026-10-10T10:30:00.000Z'),
      holidayDates: [],
      expectedLatest: '2026-10-09',
      label: 'Saturday after normal Friday trading',
    },
    {
      now: new Date('2026-10-11T10:30:00.000Z'),
      holidayDates: [],
      expectedLatest: '2026-10-09',
      label: 'Sunday after normal Friday trading',
    },
  ];

  for (const { now, holidayDates, expectedLatest, label } of cases) {
    const today = isoDateInIndia(now);
    const latestCompletedTradingDate = previousNseTradingDate(today, holidayDates);
    assert.equal(latestCompletedTradingDate, expectedLatest, label);
    const result = qualifiedMarketContext({
      session: 'MARKET_CLOSED', now, quoteDate: latestCompletedTradingDate,
      historyDate: latestCompletedTradingDate,
    });
    const assessment = assessCurrentMarketContext(result, { now });
    assert.equal(assessment.marketContextAvailable, true, label);
    assert.equal(assessment.sessionStatus, 'MARKET_CLOSED', 'weekend must not be relabeled as an exchange holiday');
    assert.match(assessment.sessionDetail, /MARKET_WEEKEND/);
    assert.match(assessment.sessionDetail, /no intraday quote is asserted/);
  }
});

test('preflight rejects stale, incoherent, recovered, or fabricated weekend quotes', () => {
  const now = new Date('2026-10-03T10:30:00.000Z');
  const latestCompletedTradingDate = previousNseTradingDate('2026-10-03', ['2026-10-02']);
  const cases = [
    ['stale weekend quote', result => {
      result.body.marketSnapshot.provenance.sources[0].freshness.status = 'STALE';
    }],
    ['stale weekend VIX', result => {
      result.body.marketSnapshot.provenance.sources[1].freshness.status = 'STALE';
      result.body.marketSnapshot.observedFacts[1].freshness.status = 'STALE';
    }],
    ['NIFTY and VIX date mismatch', result => {
      result.body.marketSnapshot.provenance.sources[1].effectiveTradingDate = '2026-09-30';
    }],
    ['history date mismatch', result => {
      result.body.marketSnapshot.provenance.sources[2].effectiveTradingDate = '2026-09-30';
    }],
    ['last-known-good recovery', result => {
      result.body.marketSnapshot.recoveredFromLastKnownGood = true;
    }],
    ['fabricated Saturday quote', result => {
      const saturdayTimestamp = marketFixtureTimestamp('2026-10-03', 15, 30);
      const snapshot = result.body.marketSnapshot;
      snapshot.provenance.sources.slice(0, 2).forEach(source => {
        source.observedAt = saturdayTimestamp;
        source.providerTimestamp = saturdayTimestamp;
        source.effectiveTradingDate = '2026-10-03';
      });
      snapshot.observedFacts.forEach(fact => { fact.observedAt = saturdayTimestamp; });
    }],
  ];

  for (const [name, mutate] of cases) {
    const result = qualifiedMarketContext({
      session: 'MARKET_CLOSED', now, quoteDate: latestCompletedTradingDate,
      historyDate: latestCompletedTradingDate,
    });
    mutate(result);
    assert.equal(assessCurrentMarketContext(result, { now }).marketContextAvailable, false, name);
  }
});

test('preflight reporter distinguishes failed from unevaluated checks and emits every required check once', () => {
  const lines = [];
  const reporter = makeReporter(line => lines.push(line));
  reporter.add('Backend', true, 'health verified');
  const result = reporter.finish();

  assert.deepEqual(result.checks.map(check => check.name), EXPECTED_PREFLIGHT_CHECKS);
  assert.equal(new Set(result.checks.map(check => check.name)).size, EXPECTED_PREFLIGHT_CHECKS.length);
  assert.equal(result.checks.find(check => check.name === 'Backend').passed, true);
  const skipped = result.checks.find(check => check.name === 'Product tax workflow');
  assert.equal(skipped.passed, false);
  assert.match(skipped.detail, /^NOT_EVALUATED/);
  assert.equal(result.failed, 0);
  assert.equal(result.notEvaluated, EXPECTED_PREFLIGHT_CHECKS.length - 1);
  assert.ok(lines.some(line => line.includes('NOT_EVALUATED Product tax workflow')));
});

test('preflight reporter rejects duplicate and unknown writes and protects finalized check accounting', () => {
  const attempts = [
    { initial: true, duplicate: false, expectedPassed: true },
    { initial: false, duplicate: true, expectedPassed: false },
    { initial: true, duplicate: true, expectedPassed: true },
    { initial: false, duplicate: false, expectedPassed: false },
  ];
  for (const { initial, duplicate, expectedPassed } of attempts) {
    const lines = [];
    const reporter = makeReporter(line => lines.push(line));
    reporter.add('Critical browser path', initial, 'first terminal outcome');
    assert.throws(
      () => reporter.add('Critical browser path', duplicate, 'attempted overwrite'),
      /already evaluated/i,
    );
    const result = reporter.finish();
    const check = result.checks.find(item => item.name === 'Critical browser path');
    assert.equal(check.passed, expectedPassed);
    assert.equal(check.state, expectedPassed ? 'PASS' : 'FAIL');
    assert.throws(() => reporter.add('Critical browser path', true, 'late write'), /finalization/i);
    assert.equal(reporter.finish().passed, result.passed);
    assert.equal(lines.length, EXPECTED_PREFLIGHT_CHECKS.length);
    assert.deepEqual(lines.map(line => line.match(/^(?:PASS|FAIL|NOT_EVALUATED) (.+?) —/)?.[1]), EXPECTED_PREFLIGHT_CHECKS);
  }

  const reporter = makeReporter(() => {});
  assert.throws(() => reporter.add('Not a real check', true, 'bad name'), /Unexpected preflight check/);
  reporter.add('Backend', true, 'safe terminal outcome');
  reporter.checks.find(check => check.name === 'Backend').passed = false;
  const result = reporter.finish();
  assert.equal(result.checks.find(check => check.name === 'Backend').passed, true);
  assert.equal(result.checks.length, EXPECTED_PREFLIGHT_CHECKS.length);
  assert.equal(new Set(result.checks.map(check => check.name)).size, EXPECTED_PREFLIGHT_CHECKS.length);
  assert.equal(result.passed + result.failed + result.notEvaluated, EXPECTED_PREFLIGHT_CHECKS.length);
  assert.ok(result.checks.every(check => ['PASS', 'FAIL', 'NOT_EVALUATED'].includes(check.state)));
  assert.ok(result.checks.filter(check => check.state === 'NOT_EVALUATED').every(check => !check.passed));
});

test('runDemoPreflight accepts injected environment and output while preserving terminal check accounting', async () => {
  const output = [];
  const result = await runDemoPreflight({
    environment: { DEMO_LIVE_PREFLIGHT: '0' },
    write: line => output.push(line),
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.checks.length, EXPECTED_PREFLIGHT_CHECKS.length);
  assert.equal(result.checks.filter(check => check.passed).length, 0);
  assert.equal(result.checks.filter(check => check.state === 'NOT_EVALUATED').length, EXPECTED_PREFLIGHT_CHECKS.length - 1);
  assert.equal(result.checks.find(check => check.name === 'Explicit live-demo mode').state, 'FAIL');
  assert.equal(output.length, EXPECTED_PREFLIGHT_CHECKS.length + 2);
  assert.match(output.at(-2), /Live-demo preflight: 0 PASS, 1 FAIL, 22 NOT_EVALUATED/);
});

test('frontend build environment forwards only required non-secret runtime inputs', () => {
  const environment = createFrontendBuildEnvironment({
    PATH: 'safe-path',
    SystemRoot: 'safe-system-root',
    DEMO_PASSWORD: 'must-not-forward',
    MONGODB_URI: 'must-not-forward',
    JWT_SECRET: 'must-not-forward',
    UPSTOX_ACCESS_TOKEN: 'must-not-forward',
    VITE_API_URL: 'https://api.example.invalid/api',
    VITE_ENABLE_BEARER_AUTH: 'false',
    VITE_API_TIMEOUT_MS: '12000',
    VITE_BUILD_SHA: 'attacker-value',
  }, 'a'.repeat(40), 'a'.repeat(40));

  assert.deepEqual(environment, {
    PATH: 'safe-path',
    SystemRoot: 'safe-system-root',
    NODE_ENV: 'production',
    VITE_BUILD_SHA: 'a'.repeat(40),
    VITE_API_URL: 'https://api.example.invalid/api',
    VITE_ENABLE_BEARER_AUTH: 'false',
    VITE_API_TIMEOUT_MS: '12000',
  });
  for (const name of ['DEMO_PASSWORD', 'MONGODB_URI', 'JWT_SECRET', 'UPSTOX_ACCESS_TOKEN']) {
    assert.equal(Object.hasOwn(environment, name), false, `${name} must not enter the Vite process`);
  }
  const mismatchedSource = createFrontendBuildEnvironment({}, 'a'.repeat(40), 'b'.repeat(40));
  assert.equal(mismatchedSource.VITE_BUILD_SHA, '');
  const credentialedUrl = createFrontendBuildEnvironment({ VITE_API_URL: 'https://user:secret@example.invalid/api' }, 'a'.repeat(40), 'a'.repeat(40));
  assert.equal(Object.hasOwn(credentialedUrl, 'VITE_API_URL'), false);
  const insecureRemoteUrl = createFrontendBuildEnvironment({ VITE_API_URL: 'http://api.example.invalid/api' }, 'a'.repeat(40), 'a'.repeat(40));
  assert.equal(Object.hasOwn(insecureRemoteUrl, 'VITE_API_URL'), false);
});

test('production frontend build uses and cleans an isolated output directory', async () => {
  let outputDirectory;
  let childEnvironment;
  const result = await runDemoPreflight({
    environment: {
      DEMO_LIVE_PREFLIGHT: '1',
      DEMO_API_BASE_URL: 'http://127.0.0.1:5000/api',
      DEMO_PROFILE_COMPLETION_FILE: 'injected-profile.json',
      DEMO_TAX_CONTEXT_FILE: 'injected-tax.json',
      DEMO_EXPECTED_MONGODB_DATABASE: 'wealthgenie_demo',
      DEMO_EXPECTED_MONGODB_HOST: '127.0.0.1',
      DEMO_EXPECTED_MONGODB_PORT: '27017',
      DEMO_EXPECTED_MONGODB_ENVIRONMENT_ID: '11111111-1111-4111-8111-111111111111',
      DEMO_EXPECTED_BUILD_SHA: 'b'.repeat(40),
      MONGODB_URI: 'must-not-forward',
      DEMO_PASSWORD: 'must-not-forward',
    },
    write() {},
    dependencies: {
      async loadJson(_filePath, label, reporter) {
        reporter.add(label, true, 'injected valid fixture');
        return {};
      },
      async readHttp() { return { response: { ok: false, status: 503 }, body: {} }; },
      spawnBuild(_command, args, options) {
        outputDirectory = args[3];
        childEnvironment = options.env;
        mkdirSync(path.join(outputDirectory, 'assets'), { recursive: true });
        writeFileSync(path.join(outputDirectory, 'assets', 'app.js'), `document.documentElement.dataset.buildSha='${options.env.VITE_BUILD_SHA}'`);
        return { status: 0 };
      },
      getSourceBuildIdentity: async () => ({ sha: 'b'.repeat(40), clean: true }),
    },
  });

  assert.equal(result.checks.find(check => check.name === 'Production frontend build').state, 'PASS');
  assert.ok(path.isAbsolute(outputDirectory));
  assert.notEqual(path.resolve(outputDirectory), path.resolve('../reactapp/dist'));
  assert.equal(Object.hasOwn(childEnvironment, 'MONGODB_URI'), false);
  assert.equal(Object.hasOwn(childEnvironment, 'DEMO_PASSWORD'), false);
  await assert.rejects(stat(outputDirectory), { code: 'ENOENT' });
});

test('remote demo URLs require exact HTTPS origin allowlisting', () => {
  assert.equal(isSafeDemoUrl('https://demo.example/api', { api: true }), false);
  assert.equal(isSafeDemoUrl('https://demo.example/api', { api: true, remoteOrigins: 'https://demo.example' }), true);
  assert.equal(isSafeDemoUrl('https://demo.example/login', { remoteOrigins: 'https://demo.example' }), true);
  assert.equal(isSafeDemoUrl('https://other.example/login', { remoteOrigins: 'https://demo.example' }), false);
  assert.equal(isSafeDemoUrl('https://demo.example/login?token=secret', { remoteOrigins: 'https://demo.example' }), false);
  assert.equal(isSafeDemoUrl('http://demo.example/api', { api: true, remoteOrigins: 'http://demo.example' }), false);
});

test('frontend build verifier exceptions are recorded as failures without exposing details', async () => {
  let outputDirectory;
  const output = [];
  const result = await runDemoPreflight({
    environment: {
      DEMO_LIVE_PREFLIGHT: '1',
      DEMO_API_BASE_URL: 'http://127.0.0.1:5000/api',
      DEMO_PROFILE_COMPLETION_FILE: 'injected-profile.json',
      DEMO_TAX_CONTEXT_FILE: 'injected-tax.json',
      DEMO_EXPECTED_MONGODB_DATABASE: 'wealthgenie_demo',
      DEMO_EXPECTED_MONGODB_HOST: '127.0.0.1',
      DEMO_EXPECTED_MONGODB_PORT: '27017',
      DEMO_EXPECTED_MONGODB_ENVIRONMENT_ID: '11111111-1111-4111-8111-111111111111',
      DEMO_EXPECTED_BUILD_SHA: 'c'.repeat(40),
    },
    write: line => output.push(line),
    dependencies: {
      async loadJson(_filePath, label, reporter) {
        reporter.add(label, true, 'injected valid fixture');
        return {};
      },
      async readHttp() { return { response: { ok: false, status: 503 }, body: {} }; },
      spawnBuild(_command, args) {
        outputDirectory = args[3];
        throw new Error('sensitive build configuration');
      },
      getSourceBuildIdentity: async () => ({ sha: 'c'.repeat(40), clean: true }),
    },
  });

  assert.equal(result.checks.find(check => check.name === 'Production frontend build').state, 'FAIL');
  assert.doesNotMatch(output.join('\n'), /sensitive build configuration/);
  await assert.rejects(stat(outputDirectory), { code: 'ENOENT' });
});

function injectedOrchestrationDependencies({
  marketStatus = 'CURRENT',
  marketNow = MARKET_FIXTURE_NOW,
  marketBodyOverride = null,
  backendSha = 'e'.repeat(40),
  userPathPass = false,
  qualifiedProductTax = false,
  taxContext = demoTaxContext(),
  failGate = null,
} = {}) {
  const expectedSha = 'e'.repeat(40);
  const expectedBuildManifest = makeTestBuildManifest(expectedSha);
  const runningBuildManifest = failGate === 'Build provenance'
    ? makeTestBuildManifest(expectedSha, { gitTreeSha: '0'.repeat(40) })
    : expectedBuildManifest;
  const publishedBuildManifest = publishTestBuildManifest(runningBuildManifest);
  const marketBody = structuredClone(marketBodyOverride || qualifiedMarketContext({
    snapshotStatus: failGate === 'Market context' ? 'LAST_AVAILABLE' : marketStatus,
  }).body);
  if (failGate === 'NIFTY quote') {
    marketBody.marketSnapshot.observedFacts.find(fact => fact.key === 'nifty50Current').availabilityStatus = 'UNAVAILABLE';
  } else if (failGate === 'VIX quote') {
    marketBody.marketSnapshot.observedFacts.find(fact => fact.key === 'indiaVixCurrent').availabilityStatus = 'UNAVAILABLE';
  } else if (failGate === 'Market history') {
    marketBody.marketSnapshot.derivedFacts = [];
  } else if (failGate === 'Provider token presence') {
    marketBody.marketSnapshot.providerSelection.selectedProvider = 'UPSTOX';
  }
  const response = (status, body) => ({ response: { ok: status >= 200 && status < 300, status }, body });
  const environment = {
    DEMO_LIVE_PREFLIGHT: '1',
    DEMO_API_BASE_URL: 'http://127.0.0.1:5000/api',
    DEMO_FRONTEND_URL: 'http://127.0.0.1:5173',
    DEMO_PROFILE_COMPLETION_FILE: 'fixture-profile.json',
    DEMO_TAX_CONTEXT_FILE: 'fixture-tax.json',
    DEMO_EMAIL: 'demo@example.invalid',
    DEMO_PASSWORD: 'fixture-only',
    DEMO_COMPLETION_IDEMPOTENCY_KEY: 'fixture-idempotency-key',
    DEMO_NIFTY_ETF_PARENT_ID: 'nifty_etf',
    DEMO_EXPECTED_BUILD_SHA: expectedSha,
    DEMO_EXPECTED_BUILD_TREE_SHA: expectedBuildManifest.gitTreeSha,
    DEMO_EXPECTED_BUILD_PROVENANCE_SHA256: expectedBuildManifest.provenanceSha256,
    DEMO_EXPECTED_FRONTEND_ARTIFACT_SET_SHA256: expectedBuildManifest.frontendArtifactSetSha256,
    DEMO_EXPECTED_MONGODB_DATABASE: 'wealthgenie_demo',
    DEMO_EXPECTED_MONGODB_HOST: '127.0.0.1',
    DEMO_EXPECTED_MONGODB_PORT: '27017',
    DEMO_EXPECTED_MONGODB_ENVIRONMENT_ID: '11111111-1111-4111-8111-111111111111',
    NODE_ENV: 'test',
  };
  if (failGate === 'Explicit live-demo mode') environment.DEMO_LIVE_PREFLIGHT = '0';
  if (failGate === 'Backend URL configuration') environment.DEMO_API_BASE_URL = 'not-a-url';
  if (failGate === 'Redis if required') environment.REQUIRE_REDIS = '1';
  const dependencies = {
    async getSourceBuildIdentity() { return { sha: expectedSha, clean: true }; },
    marketNow,
    async loadJson(filePath, label, reporter) {
      const failed = (failGate === 'Profile completion payload' && label === 'Profile completion payload')
        || (failGate === 'Tax input payload' && label === 'Tax input payload');
      reporter.add(label, !failed, failed ? 'fixture rejected by deterministic offline scenario' : 'fixture JSON validated');
      if (failed) return null;
      return label === 'Profile completion payload' ? { profile: true } : taxContext;
    },
    async readHttp(url, options = {}) {
      if (url.endsWith('/health/live')) return response(failGate === 'Backend' ? 503 : 200, {
        status: failGate === 'Backend' ? 'DOWN' : 'ALIVE',
        buildSha: backendSha,
        buildProvenance: publishedBuildManifest,
      });
      if (url.endsWith('/health/ready')) return response(failGate === 'Backend readiness' ? 503 : 200, { status: failGate === 'Backend readiness' ? 'NOT_READY' : 'READY' });
      if (url.endsWith('/health/verification')) {
        assert.equal(Object.hasOwn(options.headers || {}, 'X-Demo-Expected-Mongodb-Database'), true);
        assert.equal(options.headers['X-Demo-Expected-Mongodb-Database'], environment.DEMO_EXPECTED_MONGODB_DATABASE || '');
        assert.equal(options.headers['X-Demo-Expected-Mongodb-Host'], environment.DEMO_EXPECTED_MONGODB_HOST || '');
        assert.equal(options.headers['X-Demo-Expected-Mongodb-Port'], environment.DEMO_EXPECTED_MONGODB_PORT || '');
        assert.equal(options.headers['X-Demo-Expected-Mongodb-Environment-Id'], environment.DEMO_EXPECTED_MONGODB_ENVIRONMENT_ID || '');
        const databaseVerified = failGate !== 'Mongo/transaction support' && Boolean(environment.DEMO_EXPECTED_MONGODB_DATABASE && environment.DEMO_EXPECTED_MONGODB_HOST && environment.DEMO_EXPECTED_MONGODB_PORT && environment.DEMO_EXPECTED_MONGODB_ENVIRONMENT_ID);
        return response(databaseVerified ? 200 : 503, {
        status: databaseVerified ? 'DEMO_DATABASE_VERIFIED' : 'NOT_VERIFIED',
        buildSha: expectedSha,
        buildProvenance: publishedBuildManifest,
        mongo: { connected: true, transactionCapable: databaseVerified, databaseIdentityVerified: databaseVerified, environmentSentinelVerified: databaseVerified },
        redis: { required: failGate === 'Redis if required', connected: failGate !== 'Redis if required' },
        marketProvider: failGate === 'Market provider configuration' ? 'UNSUPPORTED' : 'NSE',
        marketProviderTokenPresent: true,
        });
      }
      if (url.endsWith('/health/deep')) return response(200, { services: {
        database: failGate === 'Market provider configuration' ? 'DOWN' : 'UP',
        redis: failGate === 'Redis if required' ? 'DOWN' : 'UP',
      } });
      if (url.endsWith('/regime/current')) return response(200, marketBody);
      if (url.endsWith('/tax/policies')) return response(200, {
        currentFiscalYearVerified: failGate !== 'Tax-policy metadata',
        currentFiscalYear: failGate === 'Tax-policy metadata' ? 'FY2025-26' : 'FY2026-27',
      });
      throw new Error('Unexpected injected HTTP probe');
    },
    async verifyBrowser(reporter, { taxContext, parentInstrumentId }) {
      reporter.add('Profile completion/auth', failGate !== 'Profile completion/auth', 'offline browser/auth scenario');
      reporter.add('Recommendation current-state binding', failGate !== 'Recommendation current-state binding', 'offline financial-binding scenario');
      if (failGate === 'Nifty ETF exact-product result') {
        reporter.add('ETF product source', true, 'synthetic source endpoint response verified');
        reporter.add('Nifty ETF exact-product result', false, 'synthetic exact-product identity did not qualify');
        reporter.notEvaluated('Product tax workflow', 'exact product did not qualify');
      } else {
      await reportWtiProductChecks(reporter, {
        requestWti: async () => failGate === 'ETF product source'
          ? fakeHttpResponse(503, { code: 'UPSTREAM_UNAVAILABLE' })
          : fakeHttpResponse(200, qualifiedWtiResponse([failGate === 'Product tax workflow'
            ? { ...qualifiedNiftyEtf(), postTaxAnalysis: { status: 'REQUIRES_TAX_INPUTS' } }
            : qualifiedProductTax ? qualifiedNiftyTaxProductFixture() : {
              ...qualifiedNiftyEtf(),
              postTaxAnalysis: { status: 'TAX_CLASSIFICATION_UNAVAILABLE' },
            }])),
        recommendation: currentBinding(),
        parentInstrumentId,
        taxContext,
      });
      }
      const browserPathPassed = userPathPass && failGate !== 'Critical browser path';
      reporter.add('Critical browser path', browserPathPassed, browserPathPassed ? 'fixture user flow verified' : 'fixture browser journey did not verify');
    },
    async verifyBuild() {
      return { passed: failGate !== 'Production frontend build', detail: 'offline isolated production-build verifier result' };
    },
  };
  return { environment, dependencies };
}

test('OFFLINE PREFLIGHT CONTRACT VERIFIED: a fully-qualified injected scenario passes all 23 gates', async () => {
  const fixture = injectedOrchestrationDependencies({ userPathPass: true, qualifiedProductTax: true });
  const result = await runDemoPreflight({ ...fixture, write: () => {} });

  assert.equal(result.checks.length, 23);
  assert.deepEqual(result.checks.map(check => check.name), EXPECTED_PREFLIGHT_CHECKS);
  assert.equal(result.passed, 23, JSON.stringify(result.checks.filter(check => !check.passed)));
  assert.equal(result.failed, 0);
  assert.equal(result.notEvaluated, 0);
  assert.equal(result.exitCode, 0);
});

test('tax-policy metadata fails when the verified current year differs from the supplied tax input', async () => {
  for (const taxContext of [demoTaxContext({ fiscalYear: 'FY2025-26' }), null]) {
    const fixture = injectedOrchestrationDependencies({ taxContext, userPathPass: true });
    const result = await runDemoPreflight({ ...fixture, write: () => {} });
    const check = result.checks.find(item => item.name === 'Tax-policy metadata');
    assert.equal(check.passed, false);
    assert.equal(check.state, 'FAIL');
  }
});

test('offline orchestration has a deterministic failure case for every named live gate', async () => {
  for (const gate of EXPECTED_PREFLIGHT_CHECKS) {
    const fixture = injectedOrchestrationDependencies({ failGate: gate, userPathPass: true });
    const result = await runDemoPreflight({ ...fixture, write: () => {} });
    const target = result.checks.find(check => check.name === gate);

    assert.equal(result.checks.length, 23, `${gate}: gate count`);
    assert.equal(target.state, 'FAIL', `${gate}: injected fault must fail its gate`);
    assert.equal(result.exitCode, 1, `${gate}: failure must produce non-zero exit`);
    assert.equal(result.passed + result.failed + result.notEvaluated, 23, `${gate}: terminal state accounting`);
  }
});

test('preflight never enters the browser mutation boundary before live prerequisites pass', async () => {
  for (const gate of [
    'Explicit live-demo mode',
    'Backend URL configuration',
    'Profile completion payload',
    'Tax input payload',
    'Backend',
    'Build provenance',
    'Backend readiness',
    'Mongo/transaction support',
    'Redis if required',
  ]) {
    const fixture = injectedOrchestrationDependencies({ failGate: gate, userPathPass: true });
    const visitedUrls = [];
    const readHttp = fixture.dependencies.readHttp;
    const verifyBrowser = fixture.dependencies.verifyBrowser;
    let browserMutationBoundaryCalls = 0;
    fixture.dependencies.readHttp = async (...args) => {
      visitedUrls.push(args[0]);
      return await readHttp(...args);
    };
    fixture.dependencies.verifyBrowser = async (...args) => {
      browserMutationBoundaryCalls += 1;
      return await verifyBrowser(...args);
    };

    await runDemoPreflight({ ...fixture, write: () => {} });
    assert.equal(browserMutationBoundaryCalls, 0, `${gate}: browser/auth/profile mutation boundary must remain unopened`);
    assert.equal(visitedUrls.some(url => url.endsWith('/regime/current')), false, `${gate}: provider probes must not run before prerequisites`);
  }
});

test('failed production frontend build prevents the authenticated browser mutation path', async () => {
  const fixture = injectedOrchestrationDependencies({ failGate: 'Production frontend build', userPathPass: true });
  let browserMutationBoundaryCalls = 0;
  fixture.dependencies.verifyBrowser = async () => { browserMutationBoundaryCalls += 1; };
  const result = await runDemoPreflight({ ...fixture, write: () => {} });
  assert.equal(result.checks.find(check => check.name === 'Production frontend build').state, 'FAIL');
  assert.equal(result.checks.find(check => check.name === 'Critical browser path').state, 'NOT_EVALUATED');
  assert.equal(result.checks.find(check => check.name === 'Profile completion/auth').state, 'NOT_EVALUATED');
  assert.equal(browserMutationBoundaryCalls, 0);
});

test('missing isolated database configuration sends an explicit identity failure signal and stops before provider or browser work', async () => {
  const fixture = injectedOrchestrationDependencies({ userPathPass: true, qualifiedProductTax: true });
  delete fixture.environment.DEMO_EXPECTED_MONGODB_DATABASE;
  const result = await runDemoPreflight({ ...fixture, write: () => {} });

  assert.equal(result.checks.find(check => check.name === 'Mongo/transaction support').state, 'FAIL');
  assert.equal(result.checks.find(check => check.name === 'NIFTY quote').state, 'NOT_EVALUATED');
  assert.equal(result.checks.find(check => check.name === 'Profile completion/auth').state, 'NOT_EVALUATED');
  assert.equal(result.checks.find(check => check.name === 'Critical browser path').state, 'NOT_EVALUATED');
  assert.equal(result.exitCode, 1);
});

test('preflight requires connected demo Mongo host identity as well as database name', async () => {
  const fixture = injectedOrchestrationDependencies({ userPathPass: true, qualifiedProductTax: true });
  delete fixture.environment.DEMO_EXPECTED_MONGODB_HOST;
  const result = await runDemoPreflight({ ...fixture, write: () => {} });
  assert.equal(result.checks.find(check => check.name === 'Mongo/transaction support').state, 'FAIL');
  assert.equal(result.checks.find(check => check.name === 'NIFTY quote').state, 'NOT_EVALUATED');
  assert.equal(result.checks.find(check => check.name === 'Critical browser path').state, 'NOT_EVALUATED');
});

test('preflight requires an exact expected Mongo port before treating a database as demo-verified', async () => {
  const fixture = injectedOrchestrationDependencies({ userPathPass: true, qualifiedProductTax: true });
  delete fixture.environment.DEMO_EXPECTED_MONGODB_PORT;
  const result = await runDemoPreflight({ ...fixture, write: () => {} });
  assert.equal(result.checks.find(check => check.name === 'Mongo/transaction support').state, 'FAIL');
  assert.equal(result.checks.find(check => check.name === 'NIFTY quote').state, 'NOT_EVALUATED');
  assert.equal(result.checks.find(check => check.name === 'Critical browser path').state, 'NOT_EVALUATED');
});

test('preflight refuses to call a database demo-verified without the out-of-band sentinel result', async () => {
  const fixture = injectedOrchestrationDependencies({ userPathPass: true, qualifiedProductTax: true });
  const originalReadHttp = fixture.dependencies.readHttp;
  fixture.dependencies.readHttp = async (url, options = {}) => {
    const result = await originalReadHttp(url, options);
    if (url.endsWith('/health/verification')) {
      result.body.mongo.environmentSentinelVerified = false;
    }
    return result;
  };
  const result = await runDemoPreflight({ ...fixture, write: () => {} });
  assert.equal(result.checks.find(check => check.name === 'Mongo/transaction support').state, 'FAIL');
  assert.equal(result.checks.find(check => check.name === 'NIFTY quote').state, 'NOT_EVALUATED');
  assert.equal(result.checks.find(check => check.name === 'Critical browser path').state, 'NOT_EVALUATED');
});

test('live orchestration retains all checks and successful probes cannot override market, tax, or user-flow failures', async () => {
  const output = [];
  const fixture = injectedOrchestrationDependencies({ marketStatus: 'LAST_AVAILABLE', userPathPass: false });
  const result = await runDemoPreflight({ ...fixture, write: line => output.push(line) });

  assert.equal(result.checks.length, 23);
  assert.deepEqual(result.checks.map(check => check.name), EXPECTED_PREFLIGHT_CHECKS);
  assert.equal(result.checks.filter(check => check.passed).length + result.failed + result.notEvaluated, 23);
  assert.equal(result.exitCode, 1);
  assert.equal(result.checks.find(check => check.name === 'Mongo/transaction support').passed, true);
  assert.equal(result.checks.find(check => check.name === 'Redis if required').passed, true);
  assert.equal(result.checks.find(check => check.name === 'Market context').passed, false);
  assert.equal(result.checks.find(check => check.name === 'Product tax workflow').passed, false);
  assert.match(result.checks.find(check => check.name === 'Product tax workflow').detail, /TAX_CLASSIFICATION_UNAVAILABLE/);
  assert.equal(result.checks.find(check => check.name === 'Critical browser path').passed, false);
  assert.equal(output.length, EXPECTED_PREFLIGHT_CHECKS.length + 2);
  assert.match(output.at(-2), /20 PASS, 3 FAIL/);
});

test('live orchestration rejects a backend process whose explicit SHA differs from the expected build', async () => {
  const fixture = injectedOrchestrationDependencies({ backendSha: 'f'.repeat(40), userPathPass: true });
  const result = await runDemoPreflight({ ...fixture, write: () => {} });
  assert.equal(result.checks.find(check => check.name === 'Backend').passed, false);
  assert.equal(result.exitCode, 1);
});

test('preflight can use the frontend same-origin API proxy and a separate loopback backend health origin', async () => {
  const fixture = injectedOrchestrationDependencies({ userPathPass: true, qualifiedProductTax: true });
  fixture.environment.DEMO_API_BASE_URL = 'http://127.0.0.1:8080/api';
  fixture.environment.DEMO_FRONTEND_URL = 'http://127.0.0.1:8080';
  fixture.environment.DEMO_BACKEND_HEALTH_URL = 'http://127.0.0.1:5000';
  const requestedUrls = [];
  const originalReadHttp = fixture.dependencies.readHttp;
  fixture.dependencies.readHttp = async (url, options) => {
    requestedUrls.push(new URL(url));
    return originalReadHttp(url, options);
  };

  const result = await runDemoPreflight({ ...fixture, write: () => {} });
  assert.equal(result.checks.find(check => check.name === 'Backend URL configuration').state, 'PASS');
  assert.equal(requestedUrls.filter(url => url.pathname.startsWith('/health/')).every(url => url.origin === 'http://127.0.0.1:5000'), true);
  assert.equal(requestedUrls.find(url => url.pathname === '/api/regime/current')?.origin, 'http://127.0.0.1:8080');
  assert.equal(requestedUrls.find(url => url.pathname === '/api/tax/policies')?.origin, 'http://127.0.0.1:8080');
  assert.equal(result.checks.find(check => check.name === 'Critical browser path').state, 'PASS');
  assert.equal(result.exitCode, 0);
});

test('preflight rejects an unsafe separate backend health origin before provider or browser work', async () => {
  const fixture = injectedOrchestrationDependencies({ userPathPass: true });
  fixture.environment.DEMO_BACKEND_HEALTH_URL = 'http://127.0.0.1:5000/health';
  let readCount = 0;
  let browserCalls = 0;
  const readHttp = fixture.dependencies.readHttp;
  fixture.dependencies.readHttp = async (...args) => { readCount += 1; return readHttp(...args); };
  fixture.dependencies.verifyBrowser = async () => { browserCalls += 1; };

  const result = await runDemoPreflight({ ...fixture, write: () => {} });
  assert.equal(result.checks.find(check => check.name === 'Backend URL configuration').state, 'FAIL');
  assert.equal(readCount, 0);
  assert.equal(browserCalls, 0);
  assert.equal(result.exitCode, 1);
});

test('weekend quote details identify the prior completed session without claiming a same-day close', async () => {
  const now = new Date('2026-10-03T10:30:00.000Z');
  const latestCompletedTradingDate = previousNseTradingDate('2026-10-03', ['2026-10-02']);
  const marketBody = qualifiedMarketContext({
    session: 'MARKET_CLOSED', now, quoteDate: latestCompletedTradingDate,
    historyDate: latestCompletedTradingDate,
  }).body;
  const fixture = injectedOrchestrationDependencies({ marketNow: now, marketBodyOverride: marketBody });
  const result = await runDemoPreflight({ ...fixture, write: () => {} });

  for (const name of ['NIFTY quote', 'VIX quote']) {
    const quoteCheck = result.checks.find(check => check.name === name);
    assert.equal(quoteCheck.passed, true);
    assert.match(quoteCheck.detail, /MARKET_WEEKEND/);
    assert.match(quoteCheck.detail, /latest-completed-session/);
    assert.match(quoteCheck.detail, /not an intraday quote/);
    assert.doesNotMatch(quoteCheck.detail, /same-day/);
  }

  const recoveredMarketBody = structuredClone(marketBody);
  recoveredMarketBody.marketSnapshot.recoveredFromLastKnownGood = true;
  const recoveredFixture = injectedOrchestrationDependencies({ marketNow: now, marketBodyOverride: recoveredMarketBody });
  const recoveredResult = await runDemoPreflight({ ...recoveredFixture, write: () => {} });
  const unverifiedQuoteDetail = recoveredResult.checks.find(check => check.name === 'NIFTY quote').detail;
  assert.equal(recoveredResult.checks.find(check => check.name === 'Market context').passed, false);
  assert.doesNotMatch(unverifiedQuoteDetail, /same-day/);
  assert.match(unverifiedQuoteDetail, /completed-session observation/);
});

test('market dependency probe tolerates a virtual 13-second response under its independent budget', async () => {
  let now = 0;
  const timers = new Map();
  let nextTimerId = 0;
  const timerOptions = {
    setTimeout(callback, delay) {
      const id = ++nextTimerId;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  const advanceBy = milliseconds => {
    now += milliseconds;
    for (const [id, timer] of timers) {
      if (timer.at <= now) {
        timers.delete(id);
        timer.callback();
      }
    }
  };
  let resolveFetch;
  const pendingFetch = new Promise(resolve => { resolveFetch = resolve; });
  const resultPromise = readJson('http://127.0.0.1:5000/api/regime/current', {
    timeoutMs: MARKET_DEPENDENCY_PROBE_TIMEOUT_MS,
    fetchImpl: async () => pendingFetch,
    createAbortSignal: () => undefined,
    timerOptions,
  });

  advanceBy(13_001);
  resolveFetch({ ok: true, status: 200, json: async () => ({ status: 'MARKET_CONTEXT_AVAILABLE' }) });
  const result = await resultPromise;
  assert.equal(result.body.status, 'MARKET_CONTEXT_AVAILABLE');
  assert.ok(MARKET_DEPENDENCY_PROBE_TIMEOUT_MS > 12_000);
  assert.ok(MARKET_DEPENDENCY_PROBE_TIMEOUT_MS < PROFILE_USER_FLOW_TIMEOUT_MS);
  assert.ok(WTI_USER_FLOW_TIMEOUT_MS <= 90_000);
  assert.ok(BACKEND_HTTP_HARD_TIMEOUT_MS < PROFILE_USER_FLOW_TIMEOUT_MS);
  assert.ok(LOGIN_BROWSER_TIMEOUT_MS < DASHBOARD_BROWSER_TIMEOUT_MS);
  assert.ok(REDIS_PROBE_TIMEOUT_MS > 0);
});

test('WTI verifier cannot certify a result after the shared frontend user-flow budget', async () => {
  let now = 0;
  const timers = new Map();
  let nextTimerId = 0;
  const timerOptions = {
    setTimeout(callback, delay) {
      const id = ++nextTimerId;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  const advanceBy = milliseconds => {
    now += milliseconds;
    for (const [id, timer] of timers) {
      if (timer.at <= now) {
        timers.delete(id);
        timer.callback();
      }
    }
  };
  let settled = false;
  const reporter = makeReporter(() => {});
  const checking = reportWtiProductChecks(reporter, {
    requestWti: () => new Promise(() => {}),
    recommendation: currentBinding(),
    parentInstrumentId: 'nifty_etf',
    taxContext: { fiscalYear: 'FY2026-27' },
    timerOptions,
  }).then(() => { settled = true; });

  advanceBy(WTI_USER_FLOW_TIMEOUT_MS + 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, true, 'the verifier must terminate at the user-flow deadline');
  await checking;
  const result = reporter.finish();
  assert.equal(result.checks.find(check => check.name === 'ETF product source').passed, false);
  assert.match(result.checks.find(check => check.name === 'ETF product source').detail, /timeout/i);
  assert.equal(WTI_USER_FLOW_TIMEOUT_MS, 90_000);
});

test('build SHA attestation requires exact explicit backend and frontend runtime identity', () => {
  const expected = 'a'.repeat(40);
  assert.equal(matchesBuildSha(expected, expected), true);
  assert.equal(matchesBuildSha(expected, 'A'.repeat(40)), true, 'hex SHA comparison is case-insensitive');
  assert.equal(matchesBuildSha(expected, 'b'.repeat(40)), false);
  assert.equal(matchesBuildSha(undefined, expected), false);
  assert.equal(matchesBuildSha(expected, undefined), false);
  assert.equal(matchesBuildSha('abc', 'abc'), false);
  assert.equal(matchesBuildSha(`${expected}a`, expected), false);
  assert.equal(matchesBuildSha(` ${expected}`, expected), false);
  assert.equal(matchesBuildSha(expected, `${expected}?build=${expected}`), false);
});

test('WTI verifier requires a coherent exact single-product route response', () => {
  const valid = qualifiedWtiResponse();
  assert.equal(qualifiesWtiResponse(valid, currentBinding(), 'nifty_etf'), true);

  const unrelated = { canonicalProductId: 'etf:isin:OTHER', parentInstrumentId: 'nifty_etf' };
  const mutations = [
    body => { body.products = [qualifiedNiftyEtf(), unrelated]; },
    body => { body.total = 2; },
    body => { body.comparisonUniverse.returnedProductCount = 0; },
    body => { body.comparisonUniverse.verifiedIdentityCount = 0; },
    body => { body.comparisonUniverse.freshNavProductCount = 0; },
    body => { body.comparisonUniverse.parentInstrumentId = 'liquid_etf'; },
    body => { body.comparisonUniverse.sourceProvider = 'OTHER'; },
    body => { body.ranking.status = 'UNAVAILABLE'; },
    body => { body.financialStateBinding.allocationRevision = 999; },
    body => { body.success = false; },
  ];
  for (const mutate of mutations) {
    const body = structuredClone(valid);
    mutate(body);
    assert.equal(qualifiesWtiResponse(body, currentBinding(), 'nifty_etf'), false);
  }
  assert.equal(qualifiesWtiResponse(valid, currentBinding(), 'liquid_etf'), false);
});

function qualifiedNiftyTaxProductFixture(taxCalculationContext = demoTaxContext()) {
  const product = qualifiedNiftyEtf();
  const startDate = '2025-10-01';
  const endDate = '2026-10-01';
  const elapsedDays = 365;
  const endNav = product.nav.value;
  const startNav = endNav / 1.124;
  product.source.instrumentId = '140084';
  product.availabilityStatus = 'AVAILABLE';
  product.freshness = { status: 'FRESH', ageSeconds: 60, maxAgeSeconds: 3600 };
  product.returnBasis = 'HISTORICAL_POINT_TO_POINT_NAV_RETURN_1Y';
  product.expectedReturn = null;
  product.historicalReturn = {
    valuePct: Number(((Math.pow(endNav / startNav, 365 / elapsedDays) - 1) * 100).toFixed(6)),
    basis: 'HISTORICAL_POINT_TO_POINT_NAV_RETURN_1Y',
    annualized: true,
    isExpectedReturn: false,
    startNav,
    startDate,
    endNav,
    endDate,
    elapsedDays,
    source: {
      provider: 'AMFI',
      startInstrumentId: '140084',
      endInstrumentId: '140084',
      historyTargetDate: startDate,
      startObservationUrl: 'https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx?frmdt=28-Sep-2025&todt=04-Oct-2025',
      endObservationUrl: product.source.url,
    },
  };
  product.taxMetadata = getProductTaxMetadata(product, 'nifty_etf');
  product.postTaxAnalysis = calculateProductPostTaxOutcome({
    product,
    taxCalculationContext,
  });
  return product;
}

test('NIFTY ETF tax verifier fails closed unless a calculated result has matching source-qualified provenance', () => {
  const taxContext = demoTaxContext();
  const validProduct = qualifiedNiftyTaxProductFixture();
  assert.equal(qualifiesCalculatedNiftyEtfTax(validProduct, taxContext), true);
  const shortTermContext = demoTaxContext({ holdingPeriodMonths: 12 });
  assert.equal(qualifiesCalculatedNiftyEtfTax(
    qualifiedNiftyTaxProductFixture(shortTermContext),
    shortTermContext,
  ), true);

  const mutations = [
    product => { delete product.taxMetadata; },
    product => { product.taxMetadata.sourceQualified = false; },
    product => { delete product.taxMetadata.taxClass; },
    product => { product.taxMetadata.taxClass = 'UNSUPPORTED_CLASS'; },
    product => { product.taxMetadata.sourceReferences = []; },
    product => { product.taxMetadata.sourceReferences = [{}]; },
    product => { product.taxMetadata.sourceReferences[0].url = 'http://mf.nipponindiaim.com/tampered.pdf'; },
    product => { product.taxMetadata.productEvidence.binding.isin = 'WRONG'; },
    product => { product.postTaxAnalysis.taxClassificationMetadata.productEvidence.documentDate = '2026-01-01'; },
    product => { product.postTaxAnalysis.taxRuleMetadata.currentRuleReferences = []; },
    product => {
      const reference = product.postTaxAnalysis.taxRuleMetadata.currentRuleReferences.find(item => item.reference === 'Section 198');
      product.postTaxAnalysis.taxRuleMetadata.currentRuleReferences = [{
        ...reference,
        ruleId: 'INCOME_TAX_ACT_2025_EQUITY_STCG_SPECIAL_RATE_POLICY',
        reference: 'Section 196',
      }];
    },
    product => { product.postTaxAnalysis.rulesApplied = product.postTaxAnalysis.rulesApplied.filter(rule => rule !== 'INCOME_TAX_ACT_2025_EQUITY_LTCG_SPECIAL_RATE_POLICY'); },
    product => { product.postTaxAnalysis.assumptions = product.postTaxAnalysis.assumptions.filter(item => !item.startsWith('STT_CONDITION_ASSUMED_SATISFIED')); },
    product => { product.postTaxAnalysis.sourceReferences = product.postTaxAnalysis.sourceReferences.filter(reference => reference.role !== 'TAX_POLICY'); },
    product => {
      const reference = product.postTaxAnalysis.sourceReferences.find(item => item.role === 'PRODUCT_FACT');
      reference.url = 'https://example.invalid/nav.txt';
    },
    product => {
      const reference = product.postTaxAnalysis.sourceReferences.find(item => item.role === 'PRODUCT_FACT');
      reference.unit = 'PERCENT_PER_ANNUM';
    },
    product => { delete product.postTaxAnalysis.policyVersion; },
    product => { product.postTaxAnalysis.fiscalYear = 'FY2025-26'; },
    product => { delete product.postTaxAnalysis.calculationClass; },
    product => { product.postTaxAnalysis.calculationClass = 'CURRENT_RATE_POST_TAX_ILLUSTRATION'; },
    product => { product.postTaxAnalysis.taxClass = 'BANK_DEPOSIT_INTEREST'; },
    product => { product.postTaxAnalysis.sourceReferences[0].url = 'https://mf.nipponindiaim.com/unrelated.pdf'; },
    product => { product.canonicalProductId = 'etf:isin:OTHER'; },
    product => { product.postTaxAnalysis.grossGain += 1; },
    product => { product.postTaxAnalysis.incrementalTax += 1; },
    product => { product.postTaxAnalysis.netGain += 1; },
    product => { product.postTaxAnalysis.postTaxRatePct += 0.01; },
    product => { product.postTaxAnalysis.principal += 1; },
    product => { product.postTaxAnalysis.illustrativePrincipal += 1; },
    product => { product.postTaxAnalysis.taxableGain += 1; },
  ];
  for (const mutate of mutations) {
    const product = qualifiedNiftyTaxProductFixture();
    mutate(product);
    assert.equal(qualifiesCalculatedNiftyEtfTax(product, taxContext), false);
  }
  assert.equal(qualifiesCalculatedNiftyEtfTax(validProduct, taxContext, { financialBindingValid: false }), false);
  assert.equal(qualifiesCalculatedNiftyEtfTax(validProduct, { ...taxContext, sttConditionAssumedSatisfied: false }), false);
  assert.equal(qualifiesCalculatedNiftyEtfTax(validProduct, { fiscalYear: 'FY2026-27' }), false);
  assert.equal(qualifiesCalculatedNiftyEtfTax(validProduct, demoTaxContext({ illustrativePrincipal: 999999 })), false);
  for (const changedTaxContext of [
    demoTaxContext({ annualGrossIncome: 25000000 }),
    demoTaxContext({ holdingPeriodMonths: 12 }),
    demoTaxContext({ section112AExemptionUsed: 100000 }),
  ]) {
    assert.equal(qualifiesCalculatedNiftyEtfTax(validProduct, changedTaxContext), false,
      'the calculated result must be reproduced from the supplied income, holding-period, and Section 112A exemption inputs');
  }
});

test('WTI HTTP failures stay under WTI checks and never become browser failures', async () => {
  for (const status of [409, 500]) {
    const lines = [];
    const timingEvents = [];
    const reporter = makeReporter(line => lines.push(line));
    await reportWtiProductChecks(reporter, {
      requestWti: async () => ({
        ok: false,
        status,
        json: async () => ({ code: status === 409 ? 'RECOMMENDATION_PARENT_MISMATCH' : 'UPSTREAM_UNAVAILABLE', message: 'must not print this response body' }),
      }),
      recommendation: currentBinding(),
      parentInstrumentId: 'nifty_etf',
      taxContext: { fiscalYear: 'FY2026-27' },
      onTiming: event => timingEvents.push(event),
    });
    const result = reporter.finish();

    assert.equal(result.checks.find(check => check.name === 'ETF product source').passed, false);
    assert.match(result.checks.find(check => check.name === 'ETF product source').detail, new RegExp(`HTTP ${status}`));
    assert.match(result.checks.find(check => check.name === 'ETF product source').detail, /RECOMMENDATION_PARENT_MISMATCH|UPSTREAM_UNAVAILABLE/);
    assert.match(result.checks.find(check => check.name === 'Nifty ETF exact-product result').detail, /^NOT_EVALUATED/);
    assert.match(result.checks.find(check => check.name === 'Product tax workflow').detail, /^NOT_EVALUATED/);
    assert.doesNotMatch(lines.join('\n'), /must not print this response body/);
    assert.doesNotMatch(lines.join('\n'), /Critical browser path.*HTTP/);
    assert.equal(timingEvents[0].stage, 'rank_wti_request');
    assert.equal(timingEvents[0].status, `HTTP_${status}`);
    assert.ok(Number.isInteger(timingEvents[0].elapsedMs) && timingEvents[0].elapsedMs >= 0);
  }
});

test('WTI timeout and network exceptions are attributed to WTI without exposing exception text', async () => {
  for (const error of [
    Object.assign(new Error('mongodb+srv://user:secret@host/db?token=hidden'), { name: 'TimeoutError', code: 'ETIMEDOUT' }),
    Object.assign(new Error('https://api.example/path?access_token=hidden'), { code: 'ECONNRESET' }),
  ]) {
    const lines = [];
    const reporter = makeReporter(line => lines.push(line));
    await reportWtiProductChecks(reporter, {
      requestWti: async () => { throw error; },
      recommendation: currentBinding(),
      parentInstrumentId: 'nifty_etf',
      taxContext: { fiscalYear: 'FY2026-27' },
    });
    const result = reporter.finish();

    assert.equal(result.checks.find(check => check.name === 'ETF product source').passed, false);
    assert.match(result.checks.find(check => check.name === 'ETF product source').detail, /WTI.*(timeout|network)/i);
    assert.match(result.checks.find(check => check.name === 'Nifty ETF exact-product result').detail, /^NOT_EVALUATED/);
    assert.match(result.checks.find(check => check.name === 'Product tax workflow').detail, /^NOT_EVALUATED/);
    assert.doesNotMatch(lines.join('\n'), /secret|access_token|mongodb\+srv|api\.example/);
    assert.doesNotMatch(lines.join('\n'), /Critical browser path.*WTI/);
  }
});

test('untrusted WTI error codes are omitted from timing while exception class remains useful', async () => {
  for (const code of ['lowercase-secret-token', { token: 'must-not-escape' }]) {
    const timingEvents = [];
    const reporter = makeReporter(() => {});
    await reportWtiProductChecks(reporter, {
      requestWti: async () => { throw Object.assign(new Error('private detail'), { code }); },
      recommendation: currentBinding(),
      parentInstrumentId: 'nifty_etf',
      taxContext: { fiscalYear: 'FY2026-27' },
      onTiming: event => timingEvents.push(event),
    });
    reporter.finish();

    assert.equal(timingEvents.length, 1);
    assert.equal(timingEvents[0].status, 'NETWORK_ERROR');
    assert.equal(Object.hasOwn(timingEvents[0], 'code'), false);
  }
});

test('malformed WTI JSON fails source qualification and leaves exact-product/tax checks explicit', async () => {
  const reporter = makeReporter(() => {});
  await reportWtiProductChecks(reporter, {
    requestWti: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('sensitive payload'); } }),
    recommendation: currentBinding(),
    parentInstrumentId: 'nifty_etf',
    taxContext: { fiscalYear: 'FY2026-27' },
  });
  const result = reporter.finish();
  assert.match(result.checks.find(check => check.name === 'ETF product source').detail, /malformed JSON/i);
  assert.match(result.checks.find(check => check.name === 'Nifty ETF exact-product result').detail, /^NOT_EVALUATED/);
  assert.match(result.checks.find(check => check.name === 'Product tax workflow').detail, /^NOT_EVALUATED/);
});

test('browser launch, login navigation, and login-control failures cannot pass the critical browser path', async () => {
  const launchFailure = await runBrowserFlow({ launchError: Object.assign(new Error('secret launch detail'), { code: 'BROWSER_MISSING' }) });
  assert.equal(launchFailure.checks.find(check => check.name === 'Critical browser path').passed, false);
  assert.match(launchFailure.checks.find(check => check.name === 'Critical browser path').detail, /browser launch\/navigation failed/);
  assert.match(launchFailure.checks.find(check => check.name === 'ETF product source').detail, /^NOT_EVALUATED/);
  assert.doesNotMatch(launchFailure.lines.join('\n'), /secret launch detail/);

  const navigationFailure = await runBrowserFlow({ loginNavigationStatus: 503 });
  assert.equal(navigationFailure.checks.find(check => check.name === 'Critical browser path').passed, false);
  assert.match(navigationFailure.checks.find(check => check.name === 'Critical browser path').detail, /browser launch\/navigation failed HTTP 503/);

  const tlsNavigationFailure = await runBrowserFlow({
    loginNavigationError: Object.assign(
      new Error('net::ERR_CERT_AUTHORITY_INVALID at https://127.0.0.1:8443/login?token=hidden'),
      { name: 'Error' },
    ),
  });
  const tlsFailureDetail = tlsNavigationFailure.checks.find(check => check.name === 'Critical browser path').detail;
  assert.match(tlsFailureDetail, /failed during navigate to login \(network\/stage error ERR_CERT_AUTHORITY_INVALID ERROR\)/);
  assert.equal(tlsNavigationFailure.checks.find(check => check.name === 'Profile completion/auth').state, 'NOT_EVALUATED');
  assert.doesNotMatch(tlsNavigationFailure.lines.join('\n'), /https:\/\/127\.0\.0\.1|token=hidden/);

  for (const scenario of [{ loginFormError: true }, { loginControlError: true }]) {
    const result = await runBrowserFlow(scenario);
    assert.equal(result.checks.find(check => check.name === 'Critical browser path').passed, false);
    assert.equal(result.checks.find(check => check.name === 'Profile completion/auth').passed, false);
    assert.match(result.checks.find(check => check.name === 'Recommendation current-state binding').detail, /^NOT_EVALUATED/);
    assert.match(result.checks.find(check => check.name === 'ETF product source').detail, /^NOT_EVALUATED/);
  }
});

test('login 401/500 fail the critical path and leave downstream financial checks unevaluated', async () => {
  for (const status of [401, 500]) {
    const result = await runBrowserFlow({ loginStatus: status });
    assert.equal(result.checks.find(check => check.name === 'Profile completion/auth').passed, false);
    assert.match(result.checks.find(check => check.name === 'Profile completion/auth').detail, new RegExp(`HTTP ${status}`));
    assert.equal(result.checks.find(check => check.name === 'Critical browser path').passed, false);
    assert.match(result.checks.find(check => check.name === 'Recommendation current-state binding').detail, /^NOT_EVALUATED/);
    assert.match(result.checks.find(check => check.name === 'ETF product source').detail, /^NOT_EVALUATED/);
    assert.match(result.checks.find(check => check.name === 'Nifty ETF exact-product result').detail, /^NOT_EVALUATED/);
    assert.match(result.checks.find(check => check.name === 'Product tax workflow').detail, /^NOT_EVALUATED/);
    assert.equal(result.lines.filter(line => line.startsWith('PASS Critical browser path')).length, 0);
    assert.equal(result.lines.filter(line => line.includes('Critical browser path')).length, 1);
  }
});

test('CSRF and profile-completion failures remain distinct from the authenticated browser path', async () => {
  const missingCsrf = await runBrowserFlow({ missingCsrfCookie: true });
  assert.equal(missingCsrf.checks.find(check => check.name === 'Profile completion/auth').passed, false);
  assert.match(missingCsrf.checks.find(check => check.name === 'Profile completion/auth').detail, /CSRF_COOKIE_MISSING/);
  assert.equal(missingCsrf.checks.find(check => check.name === 'Critical browser path').passed, true);
  assert.match(missingCsrf.checks.find(check => check.name === 'Critical browser path').detail, /frontend Where to Invest journey/);

  const missingCsrfAndDashboard = await runBrowserFlow({ missingCsrfCookie: true, dashboardError: true });
  assert.equal(missingCsrfAndDashboard.checks.find(check => check.name === 'Profile completion/auth').passed, false);
  assert.equal(missingCsrfAndDashboard.checks.find(check => check.name === 'Critical browser path').passed, false);

  const completionConflict = await runBrowserFlow({ completionStatus: 409 });
  assert.equal(completionConflict.checks.find(check => check.name === 'Profile completion/auth').passed, false);
  assert.equal(completionConflict.checks.find(check => check.name === 'Critical browser path').passed, true);
  assert.match(completionConflict.checks.find(check => check.name === 'Critical browser path').detail, /frontend Where to Invest journey/);
});

test('authenticated profile navigation must return successfully, remain on /profile, and render the sidebar', async () => {
  for (const scenario of [
    { profileNavigationStatus: 503 },
    { dashboardRedirectLogin: true },
    { dashboardWrongPath: true },
    { sidebarMissing: true },
  ]) {
    const result = await runBrowserFlow(scenario);
    assert.equal(result.checks.find(check => check.name === 'Critical browser path').passed, false);
  }
});

test('critical browser path requires the real frontend WTI request, exact ETF render, and calculated-tax state', async () => {
  const verified = await runBrowserFlow();
  assert.equal(verified.checks.find(check => check.name === 'Critical browser path').passed, true,
    verified.checks.find(check => check.name === 'Critical browser path').detail);
  assert.match(verified.checks.find(check => check.name === 'Critical browser path').detail, /frontend Where to Invest journey/i);
  assert.match(verified.checks.find(check => check.name === 'Critical browser path').detail, /calculated historical tax illustration/i);

  for (const scenario of [
    { frontendWtiMissing: true },
    { frontendWtiBindingMismatch: true },
    { frontendWtiWrongProduct: true },
    { frontendWtiTaxHidden: true },
    { frontendWtiTaxUnavailable: true },
    { frontendWtiRequestBindingMismatch: true },
    { frontendWtiDirectProviderRequest: true },
  ]) {
    const result = await runBrowserFlow(scenario);
    assert.equal(result.checks.find(check => check.name === 'Critical browser path').passed, false, JSON.stringify(scenario));
  }
});

test('critical browser path rejects a frontend runtime built from a different revision', async () => {
  const result = await runBrowserFlow({ frontendBuildSha: 'd'.repeat(40) });
  assert.equal(result.checks.find(check => check.name === 'Critical browser path').passed, false);
  assert.match(result.checks.find(check => check.name === 'Critical browser path').detail, /FRONTEND_BUILD_IDENTITY_MISMATCH/);
});

test('a mismatched served frontend asset is rejected before demo credentials are submitted', async () => {
  const result = await runBrowserFlow({ frontendAssetShaMismatch: true });
  assert.equal(result.checks.find(check => check.name === 'Critical browser path').passed, false);
  assert.match(result.checks.find(check => check.name === 'Critical browser path').detail, /FRONTEND_BUILD_IDENTITY_MISMATCH/);
  assert.equal(result.checks.find(check => check.name === 'Profile completion/auth').state, 'NOT_EVALUATED');
});

test('served frontend files that retain the build marker but change bytes are rejected before demo credentials are submitted', async () => {
  for (const scenario of [
    { frontendAssetBytesTampered: true },
    { frontendCssTampered: true },
    { frontendIndexTampered: true },
    { browserLoadedDocumentTampered: true },
    { browserLoadedScriptTampered: true },
    { browserLoadedStylesheetTampered: true },
    { frontendMissingArtifact: true },
    { frontendUnlistedScript: true },
    { frontendExternalScript: true },
  ]) {
    const result = await runBrowserFlow(scenario);
    assert.equal(result.checks.find(check => check.name === 'Critical browser path').passed, false, JSON.stringify(scenario));
    assert.equal(result.checks.find(check => check.name === 'Profile completion/auth').state, 'NOT_EVALUATED');
  }
});

test('a served frontend from a different valid provenance manifest is rejected before demo credentials are submitted', async () => {
  const result = await runBrowserFlow({ frontendProvenanceMismatch: true });
  assert.equal(result.checks.find(check => check.name === 'Critical browser path').passed, false);
  assert.match(result.checks.find(check => check.name === 'Critical browser path').detail, /FRONTEND_BUILD_IDENTITY_MISMATCH/);
  assert.equal(result.checks.find(check => check.name === 'Profile completion/auth').state, 'NOT_EVALUATED');
});

test('browser authentication fails closed when outbound-origin interception is unavailable', async () => {
  const result = await runBrowserFlow({ browserRouteMissing: true });
  assert.equal(result.checks.find(check => check.name === 'Critical browser path').passed, false);
  assert.match(result.checks.find(check => check.name === 'Critical browser path').detail, /BROWSER_ORIGIN_GUARD_UNAVAILABLE/);
  assert.equal(result.checks.find(check => check.name === 'Profile completion/auth').state, 'NOT_EVALUATED');
});

test('browser preflight blocks service workers before installing the outbound-origin guard', async () => {
  const scenario = {};
  await runBrowserFlow(scenario);
  assert.deepEqual(scenario.browserContextOptions, { serviceWorkers: 'block' });
});

test('profile and recommendation failures retain all dependent checks as NOT_EVALUATED', async () => {
  const profileFailure = await runBrowserFlow({ completionStatus: 503 });
  assert.match(profileFailure.checks.find(check => check.name === 'Profile completion/auth').detail, /profile completion HTTP 503/);

  const recommendationFailure = await runBrowserFlow({ recommendationStatus: 409 });
  assert.match(recommendationFailure.checks.find(check => check.name === 'Recommendation current-state binding').detail, /HTTP 409/);
  assert.match(recommendationFailure.checks.find(check => check.name === 'ETF product source').detail, /^NOT_EVALUATED/);
  assert.match(recommendationFailure.checks.find(check => check.name === 'Product tax workflow').detail, /^NOT_EVALUATED/);
});

test('WTI exceptions, 409, 500, and malformed JSON never fail the browser stage', async () => {
  const scenarios = [
    { wtiStatus: 409, wtiCode: 'RECOMMENDATION_PARENT_MISMATCH' },
    { wtiStatus: 500, wtiCode: 'UPSTREAM_UNAVAILABLE' },
    { wtiMalformed: true },
    { wtiError: Object.assign(new Error('https://private.invalid/?token=hidden'), { name: 'TimeoutError', code: 'ETIMEDOUT' }) },
    { wtiError: Object.assign(new Error('private provider details'), { code: 'ECONNRESET' }) },
  ];
  for (const scenario of scenarios) {
    const result = await runBrowserFlow(scenario);
    assert.equal(result.checks.find(check => check.name === 'Critical browser path').passed, true);
    assert.equal(result.checks.find(check => check.name === 'ETF product source').passed, false);
    assert.equal(result.checks.find(check => check.name === 'Nifty ETF exact-product result').passed, false);
    assert.equal(result.checks.find(check => check.name === 'Product tax workflow').passed, false);
    assert.doesNotMatch(result.lines.join('\n'), /private\.invalid|token=hidden|private provider details/);
  }
});

test('exact product and tax failures remain independently visible', async () => {
  const cases = [
    { products: [] },
    { products: { unexpected: 'not-an-array' } },
    { products: [qualifiedNiftyEtf(), qualifiedNiftyEtf()] },
    { products: [(() => { const product = qualifiedNiftyEtf(); product.externalIds[1].value = 'different'; return product; })()] },
    { products: [(() => { const product = qualifiedNiftyEtf(); product.primaryFact.canonicalProductId = 'mf:amfi:140085'; return product; })()] },
    { products: [(() => { const product = qualifiedNiftyEtf(); delete product.primaryFact.canonicalProductId; return product; })()] },
    { products: [(() => { const product = qualifiedNiftyEtf(); product.primaryFact.freshness.status = 'STALE'; return product; })()] },
    { products: [(() => { const product = qualifiedNiftyEtf(); product.primaryFact.source.provider = 'OTHER_SOURCE'; return product; })()] },
    { wtiBindingMismatch: true },
    { wtiMissingBinding: true },
    { parentInstrumentId: 'liquid_etf' },
  ];
  for (const scenario of cases) {
    const result = await runBrowserFlow(scenario);
    assert.equal(result.checks.find(check => check.name === 'Nifty ETF exact-product result').passed, false);
  }

  const taxUnavailable = await runBrowserFlow({
    taxContext: demoTaxContext({ sttConditionAssumedSatisfied: undefined }),
  });
  assert.equal(taxUnavailable.checks.find(check => check.name === 'ETF product source').passed, true);
  assert.equal(taxUnavailable.checks.find(check => check.name === 'Nifty ETF exact-product result').passed, true);
  assert.equal(taxUnavailable.checks.find(check => check.name === 'Product tax workflow').passed, false);
  assert.match(taxUnavailable.checks.find(check => check.name === 'Product tax workflow').detail, /REQUIRES_TAX_INPUTS/);

  const sttNotAssumed = await runBrowserFlow({
    taxContext: demoTaxContext({ sttConditionAssumedSatisfied: false }),
  });
  assert.equal(sttNotAssumed.checks.find(check => check.name === 'Nifty ETF exact-product result').passed, true);
  assert.equal(sttNotAssumed.checks.find(check => check.name === 'Product tax workflow').passed, false);
  assert.match(sttNotAssumed.checks.find(check => check.name === 'Product tax workflow').detail, /UNAVAILABLE/);

  const wrongTaxYear = await runBrowserFlow({ products: [{
    ...qualifiedNiftyEtf(), postTaxAnalysis: { status: 'CALCULATED', fiscalYear: 'FY2025-26' },
  }] });
  assert.equal(wrongTaxYear.checks.find(check => check.name === 'Nifty ETF exact-product result').passed, true);
  assert.equal(wrongTaxYear.checks.find(check => check.name === 'Product tax workflow').passed, false);
  const noExactButClaimedTax = await runBrowserFlow({ products: [{
    ...qualifiedNiftyEtf(), canonicalProductId: 'etf:isin:OTHER',
    postTaxAnalysis: { status: 'CALCULATED', fiscalYear: 'FY2026-27' },
  }] });
  assert.equal(noExactButClaimedTax.checks.find(check => check.name === 'Nifty ETF exact-product result').passed, false);
  assert.equal(noExactButClaimedTax.checks.find(check => check.name === 'Product tax workflow').state, 'NOT_EVALUATED');
});

test('dashboard and direct-provider failures affect only the critical browser check', async () => {
  const dashboardFailure = await runBrowserFlow({ dashboardError: true });
  assert.equal(dashboardFailure.checks.find(check => check.name === 'Critical browser path').passed, false);
  assert.equal(dashboardFailure.checks.find(check => check.name === 'ETF product source').passed, true);
  assert.equal(dashboardFailure.checks.find(check => check.name === 'Nifty ETF exact-product result').passed, true);

  const directProvider = await runBrowserFlow({ directProviderRequest: true });
  assert.equal(directProvider.checks.find(check => check.name === 'Critical browser path').passed, false);
  assert.match(directProvider.checks.find(check => check.name === 'Critical browser path').detail, /direct provider request/);

  const providerHosts = [
    'https://www.nseindia.com/market-data',
    'https://portal.amfiindia.com/spages/NAVAll.txt',
    'https://api.upstox.com/v2/market-quote',
    'https://sbi.bank/rates',
    'https://sbi.co.in/rates',
    'https://www.rbi.org.in/rates',
    'https://www.dea.gov.in/rates',
    'https://www.indiapost.gov.in/rates',
    'https://www.incometax.gov.in/iec/foportal',
    'https://www.incometaxindia.gov.in/rates',
  ];
  for (const directProviderRequest of providerHosts) {
    const result = await runBrowserFlow({ directProviderRequest });
    assert.equal(result.checks.find(check => check.name === 'Critical browser path').passed, false, directProviderRequest);
    assert.doesNotMatch(result.lines.join('\n'), /token=hidden/);
  }

  const spoofedHost = await runBrowserFlow({ directProviderRequest: 'https://amfiindia.com.attacker.invalid/not-provider' });
  assert.equal(spoofedHost.checks.find(check => check.name === 'Critical browser path').passed, true);

  const uninspectableRequest = await runBrowserFlow({ providerRequestInspectionError: true });
  assert.equal(uninspectableRequest.checks.find(check => check.name === 'Critical browser path').passed, false);
  assert.match(uninspectableRequest.checks.find(check => check.name === 'Critical browser path').detail, /request inspection failed/);
});
