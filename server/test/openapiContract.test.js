import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import express from 'express';
import jwt from 'jsonwebtoken';
import authRoutes from '../routes/auth.js';
import profileRoutes from '../routes/profile.js';
import taxRoutes from '../routes/tax.js';
import instrumentRoutes from '../routes/instruments.js';
import financialUniverseRoutes from '../routes/financialUniverse.js';
import chatRoutes from '../routes/chatRoutes.js';
import recommendRoutes from '../routes/recommend.js';
import goalsRoutes from '../routes/goals.js';
import marketRoutes from '../routes/market.js';
import { createMarketQuotesRouter } from '../routes/marketQuotes.js';
import marketDataAdminRoutes from '../routes/marketDataAdmin.js';
import agentRoutes from '../routes/agentRoutes.js';
import genieProofRoutes from '../routes/genieProofRoutes.js';
import projectionRoutes from '../routes/projection.js';
import montecarloRoutes from '../routes/montecarlo.js';
import portfolioRoutes from '../routes/portfolio.js';
import regimeRoutes from '../routes/regime.js';
import { errorHandler, sendError } from '../middleware/errorHandler.js';
import Instrument from '../models/Instrument.js';
import FinancialProfile from '../models/FinancialProfile.js';
import Recommendation from '../models/Recommendation.js';
import RecommendationState from '../models/RecommendationState.js';
import RecommendationAllocationRevision from '../models/RecommendationAllocationRevision.js';
import FinancialProfileState from '../models/FinancialProfileState.js';
import { withServer, rawRequest } from '../test-utils/httpTestUtils.js';
import { canonicalProfilePayload } from './helpers/canonicalProfile.js';
import { withMockAuthAccountState } from './helpers/mockAuthAccountState.js';
import { buildRecommendationProfile, toProfilePersistence } from '../services/recommendationProfile.js';
import { assessSuitabilityRisk } from '../services/riskProfiler.js';
import { runOpenApiHttpCase } from './helpers/openapiRuntimeContract.js';
import { createMarketDataTestFixtureRightsCapability } from '../services/marketData/marketDataTestFixtures.js';
import { taxDeductionSchema } from '../validation/taxSchemas.js';
import { postTaxReturnSchema } from '../validation/schemas.js';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appSource = fs.readFileSync(path.join(serverRoot, 'app.js'), 'utf8');
const contract = parse(fs.readFileSync(path.join(serverRoot, 'openapi.yaml'), 'utf8'));
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const marketDataTestEnv = { NODE_ENV: 'test' };
const marketDataFixtureRightsCapability = createMarketDataTestFixtureRightsCapability({
  env: marketDataTestEnv,
  transport: { get: async () => ({ data: null }) },
});

test('goal simulation chart contract requires complete nonnegative percentile points', () => {
  const pointSchema = contract.components.schemas.GoalSimulationChartPoint;
  const responseSchema = contract.components.schemas.GoalSimulationResponse;
  const validatePoint = new Ajv2020({ allErrors: true, strict: false }).compile(pointSchema);

  assert.deepEqual(pointSchema.required, ['year', 'p10', 'p25', 'p50', 'p75', 'p90']);
  assert.equal(pointSchema.additionalProperties, false);
  assert.equal(responseSchema.properties.chartData.minItems, 1);
  assert.equal(responseSchema.properties.chartData.items.$ref, '#/components/schemas/GoalSimulationChartPoint');
  assert.equal(validatePoint({ year: 1, p10: 10, p25: 15, p50: 20, p75: 25, p90: 30 }), true);
  for (const malformed of [
    {},
    { year: 1, p10: 10, p25: 15, p50: 20, p75: 25 },
    { year: 1, p10: 10, p25: null, p50: 20, p75: 25, p90: 30 },
    { year: 1, p10: -1, p25: 15, p50: 20, p75: 25, p90: 30 },
    { year: 0, p10: 10, p25: 15, p50: 20, p75: 25, p90: 30 },
    { year: 31, p10: 10, p25: 15, p50: 20, p75: 25, p90: 30 },
    { year: 1, p10: 10, p25: 15, p50: 20, p75: 25, p90: 30, extra: true },
  ]) {
    assert.equal(validatePoint(malformed), false);
  }
});

test('GenieProof offer text OpenAPI schemas document the shared UTF-8 byte limit', () => {
  for (const schemaName of ['GenieProofExtractRequest', 'GenieProofCreateRequest']) {
    const offerText = contract.components.schemas[schemaName].properties.offerText;
    assert.equal(offerText.maxLength, 16_000);
    assert.equal(offerText['x-max-utf8-bytes'], 16_000);
    assert.match(offerText.description, /UTF-8 bytes/);
  }
  const candidate = contract.components.schemas.GenieProofCandidate.properties;
  assert.match(candidate.startOffset.description, /UTF-16 code-unit offset into the exact submitted offerText/);
  assert.match(candidate.endOffset.description, /Exclusive zero-based UTF-16 code-unit offset/);
});

test('post-tax batch documents legacy principal-based fields and the SIP MWR replacements', () => {
  const responseSchema = contract.components.schemas.PostTaxReturnBatchResponse;
  const itemProperties = responseSchema
    .properties.results.items.properties;
  const replacements = {
    nominalCAGR: 'sipReturnMetrics.preTaxAnnualizedReturnPercent',
    postTaxCAGR: 'sipReturnMetrics.postTaxAnnualizedReturnPercent',
    postTaxReturnPercent: 'sipReturnMetrics.postTaxAnnualizedReturnPercent',
    realReturnPercent: 'sipReturnMetrics.realPostTaxAnnualizedReturnPercent',
    taxDragCAGR: 'sipReturnMetrics.taxDragAnnualizedPercentagePoints',
  };

  for (const [field, replacement] of Object.entries(replacements)) {
    const schema = itemProperties[field];
    assert.deepEqual(schema.type, ['number', 'null'], `${field} remains nullable numeric compatibility data`);
    assert.equal(schema.deprecated, true, `${field} is documented as legacy`);
    assert.ok(schema.description.includes(replacement), `${field} points clients to ${replacement}`);
    assert.match(schema.description, /does not account for monthly contribution timing/);
  }
  assert.match(itemProperties.taxDragCAGR.description, /decimal fraction/);
  assert.match(itemProperties.postTaxCAGR.description, /decimal fraction/);
  assert.match(itemProperties.postTaxReturnPercent.description, /percentage-valued/);

  for (const field of [
    'calculation_classification', 'verified', 'fiscalYear', 'policyVersion', 'inputsUsed',
    'assumptions', 'results', 'portfolioStatus', 'excludedInstruments', 'summary',
  ]) {
    assert.ok(responseSchema.required.includes(field), `batch response requires ${field}`);
  }
  assert.equal(responseSchema.properties.calculation_classification.const, 'SEPARATE_TAX_WHAT_IF');
  assert.equal(responseSchema.properties.verified.const, true);
  assert.ok(responseSchema.properties.inputsUsed.required.includes('deductions'),
    'the effective validated deduction context is always echoed');
  assert.equal(responseSchema.properties.inputsUsed.properties.instruments.items.$ref, '#/components/schemas/PostTaxInstrument');
  assert.ok(responseSchema.properties.assumptions.required.includes('deductions'));
  assert.deepEqual(responseSchema.properties.results.items.required,
    ['instrumentIndex', 'instrumentInput', 'instrumentType', 'status', 'sipReturnMetrics']);
  assert.equal(itemProperties.instrumentIndex.minimum, 0);
  assert.equal(itemProperties.instrumentInput.$ref, '#/components/schemas/PostTaxInstrument');
  assert.match(itemProperties.instrumentInput.description, /Section 112A recalculation/);
  assert.ok(itemProperties.status.enum.includes('REQUIRES_TAX_INPUTS'));
  assert.ok(itemProperties.status.enum.includes('MODELLED_POST_TAX_PROJECTION_UNAVAILABLE'));
  for (const field of ['postTaxReturn', 'postTaxFutureValue', 'realFutureValue', 'postTaxGain', 'taxDragWealth', 'postTaxReturnPercent', 'realReturnPercent', 'effectiveTaxPercent']) {
    assert.ok(itemProperties[field].type.includes('null'), `${field} remains nullable when a calculation is unavailable`);
  }
  const summary = responseSchema.properties.summary;
  assert.deepEqual(summary.required, ['status', 'totalTaxDrag', 'keptPerThousand', 'erodedPerThousand', 'retentionEfficiencyPercent', 'maxTaxRate']);
  for (const field of ['totalTaxDrag', 'keptPerThousand', 'erodedPerThousand', 'retentionEfficiencyPercent', 'maxTaxRate']) {
    assert.ok(summary.properties[field].type.includes('null'), `${field} remains null when no instrument is calculable`);
  }
});

test('user-declared post-tax scenario documents an exact validated-input echo and nullable result values', () => {
  const operation = contract.paths['/api/tax/post-tax-scenario'].post;
  const responseRef = operation.responses['200'].content['application/json'].schema.$ref;
  assert.equal(responseRef, '#/components/schemas/UserDeclaredPostTaxScenarioResponse');
  const responseSchema = contract.components.schemas.UserDeclaredPostTaxScenarioResponse;
  assert.ok(responseSchema.required.includes('inputsUsed'));
  assert.equal(responseSchema.properties.inputsUsed.$ref, '#/components/schemas/UserDeclaredPostTaxScenarioRequest');
  assert.match(responseSchema.properties.inputsUsed.description, /scenario type, age, and fiscal year/);
  for (const field of ['taxableGain', 'incrementalTax', 'cess', 'surcharge', 'netGain', 'fiscalYear', 'policyVersion']) {
    assert.ok(responseSchema.properties[field].type.includes('null'), `${field} may be unavailable and must remain null`);
  }
});

// Only externally supported route modules belong in the public contract.
// metricsRoutes and mcpRoutes are deliberately private operational protocols.
const publicMounts = [
  ['auth.js', '/api/auth'],
  ['profile.js', '/api/profile'],
  ['recommend.js', '/api/recommend'],
  ['agentRoutes.js', '/api/agent'],
  ['genieProofRoutes.js', '/api/genieproof'],
  ['instruments.js', '/api/instruments'],
  ['financialUniverse.js', '/api/financial-universe'],
  ['projection.js', '/api/projection'],
  ['montecarlo.js', '/api/montecarlo'],
  ['goals.js', '/api/goals'],
  ['market.js', '/api/market'],
  ['marketQuotes.js', '/api/market-data'],
  ['marketDataAdmin.js', '/api/market-data'],
  ['tax.js', '/api/tax'],
  ['chatRoutes.js', '/api/chat'],
  ['portfolio.js', '/api/portfolio'],
  ['regime.js', '/api/regime'],
  ['health.js', '/health'],
];

function normalizePath(value) {
  const normalized = value.replace(/:([A-Za-z0-9_]+)/g, '{$1}').replace(/\/+$/, '');
  return normalized || '/';
}

function extractRoutes(source, receiver, prefix = '') {
  const pattern = new RegExp(`${receiver}\\s*\\.\\s*(get|post|put|patch|delete)\\s*\\(\\s*['\"]([^'\"]+)['\"]`, 'g');
  const matches = [...source.matchAll(pattern)];
  return matches.map((match, index) => {
    const end = matches[index + 1]?.index ?? source.length;
    const declaration = source.slice(match.index, end);
    return {
      method: match[1].toLowerCase(),
      path: normalizePath(`${prefix}${match[2] === '/' ? '' : match[2]}`),
      // Authentication middleware appears in the route's argument preamble.
      // Limit the scan so a later route cannot make a long handler look protected.
      authenticated: /\b(?:verifyJWT|verifyJWTWithRevocationAvailability|verifySession|authenticate)\b/.test(declaration.slice(0, 300)),
    };
  });
}

function operationKey({ method, path: routePath }) {
  return `${method.toUpperCase()} ${routePath}`;
}

function contractOperations() {
  const operations = [];
  for (const [routePath, pathItem] of Object.entries(contract.paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (HTTP_METHODS.has(method)) operations.push({ method, path: routePath, operation });
    }
  }
  return operations;
}

function resolveLocalRef(ref) {
  assert.match(ref, /^#\//, `Only local OpenAPI references are supported: ${ref}`);
  return ref.slice(2).split('/').reduce((value, key) => value[key], contract);
}

function inlineLocalRefs(value, activeRefs = new Set()) {
  if (Array.isArray(value)) return value.map(item => inlineLocalRefs(item, activeRefs));
  if (!value || typeof value !== 'object') return value;
  if (typeof value.$ref === 'string') {
    assert.equal(value.$ref.startsWith('#/'), true, `Only local refs are supported: ${value.$ref}`);
    assert.equal(activeRefs.has(value.$ref), false, `Recursive response schema is not supported by this response validator: ${value.$ref}`);
    const nextRefs = new Set(activeRefs);
    nextRefs.add(value.$ref);
    return inlineLocalRefs(resolveLocalRef(value.$ref), nextRefs);
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, inlineLocalRefs(child, activeRefs)]));
}

const responseAjv = new Ajv2020({ allErrors: true, strict: false });
addFormats(responseAjv);

function assertRuntimeResponseMatchesContract({ method, path: routePath, status, contentType, body }) {
  const operation = contract.paths[routePath]?.[method.toLowerCase()];
  assert.ok(operation, `OpenAPI operation missing: ${method} ${routePath}`);
  const response = operation.responses[String(status)];
  assert.ok(response, `Undocumented runtime status ${status}: ${method} ${routePath}`);
  const resolvedResponse = inlineLocalRefs(response);
  const jsonMedia = resolvedResponse.content?.['application/json'];
  assert.ok(jsonMedia?.schema, `No application/json schema for ${method} ${routePath} ${status}`);
  assert.match(contentType || '', /^application\/json\b/i, `${method} ${routePath} did not return JSON`);
  const validateBody = responseAjv.compile(inlineLocalRefs(jsonMedia.schema));
  assert.equal(validateBody(body), true, `${method} ${routePath} ${status} violates OpenAPI: ${JSON.stringify(validateBody.errors)}`);
}

function assertResponseMatchesSchemaRef(schemaRef, body, context) {
  const validateBody = responseAjv.compile(inlineLocalRefs({ $ref: schemaRef }));
  assert.equal(validateBody(body), true, `${context} violates OpenAPI: ${JSON.stringify(validateBody.errors)}`);
}

test('auth session documents the typed token revocation outage response', () => {
  const response = contract.paths['/api/auth/session'].get.responses['503'];
  assert.ok(response, 'Session restore must document the revocation availability response');
  const schema = inlineLocalRefs(response.content['application/json'].schema);
  const validateBody = responseAjv.compile(schema);
  const outage = {
    error: 'Service Unavailable',
    message: 'Authentication session status is temporarily unavailable.',
    code: 'TOKEN_REVOCATION_UNAVAILABLE',
    request_id: 'request-123',
  };

  assert.equal(validateBody(outage), true, JSON.stringify(validateBody.errors));
  assert.equal(validateBody({ ...outage, code: 'SERVICE_UNAVAILABLE' }), false);
});

function buildContractTestApp() {
  const app = express();
  const marketQuotesTestRouter = createMarketQuotesRouter({
    env: marketDataTestEnv,
    marketDataTestFixtureRightsCapability: marketDataFixtureRightsCapability,
    limiter: (_req, _res, next) => next(),
    fetchQuotes: async () => ({ provider: 'UPSTOX', status: 'UNAVAILABLE', facts: [] }),
  });
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  app.use('/api/profile', profileRoutes);
  app.use('/api/tax', taxRoutes);
  app.use('/api/instruments', instrumentRoutes);
  app.use('/api/financial-universe', financialUniverseRoutes);
  app.use('/api/chat', chatRoutes);
  app.use('/api/recommend', recommendRoutes);
  app.use('/api/market', marketRoutes);
  app.use('/api/market-data', marketQuotesTestRouter);
  app.use('/api/market-data', marketDataAdminRoutes);
  app.use('/api/agent', agentRoutes);
  app.use('/api/genieproof', genieProofRoutes);
  app.use('/api/projection', projectionRoutes);
  app.use('/api/montecarlo', montecarloRoutes);
  app.use('/api/portfolio', portfolioRoutes);
  app.use('/api/goals', goalsRoutes);
  app.use('/api/regime', regimeRoutes);
  app.use((req, res) => sendError(req, res, 404, 'Route not found.', 'ROUTE_NOT_FOUND'));
  app.use(errorHandler);
  return app;
}

// These are actual requests against mounted Express routers. Keep case identity
// separate from the URL so templated OpenAPI paths remain explicit in reviews.
export const LIVE_CONTRACT_CASES = Object.freeze([
  { operation: 'POST /api/tax/compare', method: 'POST', path: '/api/tax/compare', url: '/api/tax/compare', body: { income: 1200000, incomeSource: 'salary', fiscalYear: 'FY2026-27', age: 30 }, expectedStatus: 200 },
  { operation: 'POST /api/tax/compute', method: 'POST', path: '/api/tax/compute', url: '/api/tax/compute', body: { income: 1200000, incomeSource: 'salary', fiscalYear: 'FY2026-27', age: 30, regime: 'new' }, expectedStatus: 200 },
  { operation: 'GET /api/tax/policies', method: 'GET', path: '/api/tax/policies', url: '/api/tax/policies', expectedStatus: 200 },
  { operation: 'POST /api/tax/post-tax-scenario', method: 'POST', path: '/api/tax/post-tax-scenario', url: '/api/tax/post-tax-scenario', expectedStatus: 200, body: { canonicalInstrumentId: 'sbi_fd', scenarioType: 'INTEREST_INCOME', interestReceived: 2500, annualGrossIncome: 1000000, incomeSource: 'salary', regime: 'new', fiscalYear: 'FY2026-27', userAge: 35 } },
  { operation: 'GET /api/instruments', method: 'GET', path: '/api/instruments', url: '/api/instruments?page=1&limit=10', expectedStatus: 200 },
  { operation: 'GET /api/financial-universe', method: 'GET', path: '/api/financial-universe', url: '/api/financial-universe?limit=10', expectedStatus: 503 },
  { operation: 'GET /api/financial-universe/summary', method: 'GET', path: '/api/financial-universe/summary', url: '/api/financial-universe/summary', expectedStatus: 503 },
  { operation: 'GET /api/financial-universe/categories', method: 'GET', path: '/api/financial-universe/categories', url: '/api/financial-universe/categories', expectedStatus: 503 },
  { operation: 'GET /api/financial-universe/three-product-families', method: 'GET', path: '/api/financial-universe/three-product-families', url: '/api/financial-universe/three-product-families', expectedStatus: 503 },
  { operation: 'GET /api/financial-universe/{productId}/observation', method: 'GET', path: '/api/financial-universe/{productId}/observation', url: '/api/financial-universe/fixture-product/observation?kind=PRICE', expectedStatus: 503 },

  { operation: 'GET /api/market/params', method: 'GET', path: '/api/market/params', url: '/api/market/params', expectedStatus: 200 },
  { operation: 'GET /api/market-data/quotes', method: 'GET', path: '/api/market-data/quotes', url: '/api/market-data/quotes?ids=market:index:nifty-50', expectedStatus: 200 },
  { operation: 'POST /api/projection/compare', method: 'POST', path: '/api/projection/compare', url: '/api/projection/compare', expectedStatus: 200, body: { monthlyInvestment: 5000, annualReturnRate: 0.08, benchmarkRate: 0.06, inflationRate: 0.05, years: 5 } },
  { operation: 'POST /api/projection/allocation-split', method: 'POST', path: '/api/projection/allocation-split', url: '/api/projection/allocation-split', expectedStatus: 200, body: { monthlyInvestment: 5000, equityPct: 50 } },
  { operation: 'POST /api/projection/step-up', method: 'POST', path: '/api/projection/step-up', url: '/api/projection/step-up', expectedStatus: 200, body: { monthlyInvestment: 5000, annualReturnRate: 0.08, years: 5, annualStepUpRate: 0.05 } },
  { operation: 'POST /api/projection/xirr', method: 'POST', path: '/api/projection/xirr', url: '/api/projection/xirr', expectedStatus: 200, body: { monthlySIP: 5000, months: 24, currentValue: 130000 } },
  { operation: 'POST /api/projection', method: 'POST', path: '/api/projection', url: '/api/projection', expectedStatus: 200, body: { profileId: '65b000000000000000000002', instruments: ['FD'], monthly_investment: 5000, years: [1, 3] } },
  { operation: 'POST /api/projection/custom-portfolio', method: 'POST', path: '/api/projection/custom-portfolio', url: '/api/projection/custom-portfolio', expectedStatus: 200, body: { profileId: '65b000000000000000000002', allocations: { FD: 1 }, years: 3 } },
  { operation: 'POST /api/portfolio/optimise', method: 'POST', path: '/api/portfolio/optimise', url: '/api/portfolio/optimise', expectedStatus: 200, body: { profileId: '65b000000000000000000002', assets: ['FD', 'Debt_MF'], strategy: 'min_variance' } },
  { operation: 'POST /api/portfolio/rebalance', method: 'POST', path: '/api/portfolio/rebalance', url: '/api/portfolio/rebalance', expectedStatus: 200, body: { profileId: '65b000000000000000000002', current_allocation: { FD: 50, Debt_MF: 50 }, target_allocation: { FD: 50, Debt_MF: 50 }, threshold: 5, partial_ratio: 0.5, holding_months: 12 } },
  { operation: 'POST /api/montecarlo/montecarlo', method: 'POST', path: '/api/montecarlo/montecarlo', url: '/api/montecarlo/montecarlo', expectedStatus: 422, body: { profileId: '65b000000000000000000002', instrument: 'FD', monthly_investment: 5000, years: 2 } },
  { operation: 'POST /api/montecarlo/portfolio', method: 'POST', path: '/api/montecarlo/portfolio', url: '/api/montecarlo/portfolio', expectedStatus: 422, body: { profileId: '65b000000000000000000002', allocations: { FD: 1 }, years: 2 } },
  { operation: 'POST /api/tax/compare', method: 'POST', path: '/api/tax/compare', url: '/api/tax/compare', body: { income: 'bad', incomeSource: 'salary', fiscalYear: 'FY2026-27', age: 30 }, expectedStatus: 400 },
  { operation: 'POST /api/tax/compare', method: 'POST', path: '/api/tax/compare', url: '/api/tax/compare', body: { income: 1200000, incomeSource: 'salary', fiscalYear: 'FY2099-00', age: 30 }, expectedStatus: 422 },
  { operation: 'GET /api/chat/history', method: 'GET', path: '/api/chat/history', url: '/api/chat/history', expectedStatus: 401 },
  { operation: 'GET /api/instruments', method: 'GET', path: '/api/instruments', url: '/api/instruments?notAFilter=x', expectedStatus: 400 },
  { operation: 'GET /api/recommend/audit', method: 'GET', path: '/api/recommend/audit', url: '/api/recommend/audit?profileId=garbage', expectedStatus: 400, authenticated: true },
  { operation: 'GET /api/chat/history', method: 'GET', path: '/api/chat/history', url: '/api/chat/history?limit=20garbage', expectedStatus: 400, authenticated: true },
  { operation: 'GET /api/agent/plan-health', method: 'GET', path: '/api/agent/plan-health', url: '/api/agent/plan-health?profileId=garbage', expectedStatus: 400, authenticated: true },
  { operation: 'GET /api/agent/plan-review/current', method: 'GET', path: '/api/agent/plan-review/current', url: '/api/agent/plan-review/current?profileId=garbage', expectedStatus: 400, authenticated: true },
  { operation: 'POST /api/agent/plan-review/{runId}/action', method: 'POST', path: '/api/agent/plan-review/{runId}/action', url: '/api/agent/plan-review/65b00000-0000-4000-8000-000000000099/action', expectedStatus: 400, authenticated: true, body: { action: 'UNSAFE_ACTION' } },
  { operation: 'POST /api/agent/plan-review/{runId}/action', method: 'POST', path: '/api/agent/plan-review/{runId}/action', url: '/api/agent/plan-review/65b00000-0000-4000-8000-000000000099/action', expectedStatus: 404, authenticated: true, body: { action: 'OPEN_PROFILE' } },
  { operation: 'GET /api/market/mutual-funds/nav', method: 'GET', path: '/api/market/mutual-funds/nav', url: '/api/market/mutual-funds/nav?schemeCodes=1001&extra=unexpected', expectedStatus: 400 },
  { operation: 'POST /api/genieproof/extract', method: 'POST', path: '/api/genieproof/extract', url: '/api/genieproof/extract', expectedStatus: 404, body: { offerText: 'The current PPF interest rate is 7.1% p.a.' } },
  { operation: 'POST /api/genieproof/cases', method: 'POST', path: '/api/genieproof/cases', url: '/api/genieproof/cases', expectedStatus: 404, body: { offerText: 'The current PPF interest rate is 7.1% p.a.', submissionHash: 'a'.repeat(64), savingConsent: true, confirmedClaims: [{ claimId: 'a'.repeat(32), statement: 'The current PPF interest rate is 7.1% p.a.', claimType: 'CURRENT_NOMINAL_RATE', productId: 'government:india-post:ppf', value: 7.1, unit: 'PERCENT_PER_ANNUM' }] } },
  { operation: 'GET /api/genieproof/cases', method: 'GET', path: '/api/genieproof/cases', url: '/api/genieproof/cases', expectedStatus: 401 },
  { operation: 'GET /api/genieproof/cases/{caseId}', method: 'GET', path: '/api/genieproof/cases/{caseId}', url: '/api/genieproof/cases/00000000-0000-4000-8000-000000000001', expectedStatus: 401 },
  { operation: 'GET /api/genieproof/cases/{caseId}/verify', method: 'GET', path: '/api/genieproof/cases/{caseId}/verify', url: '/api/genieproof/cases/00000000-0000-4000-8000-000000000001/verify', expectedStatus: 401 },
  { operation: 'GET /api/genieproof/cases/{caseId}/revisions', method: 'GET', path: '/api/genieproof/cases/{caseId}/revisions', url: '/api/genieproof/cases/00000000-0000-4000-8000-000000000001/revisions', expectedStatus: 401 },
  { operation: 'DELETE /api/genieproof/cases/{caseId}', method: 'DELETE', path: '/api/genieproof/cases/{caseId}', url: '/api/genieproof/cases/00000000-0000-4000-8000-000000000001', expectedStatus: 404 },
]);

// Critical success responses validated by neighboring real-HTTP suites. The
// source and route anchors are checked below so a proof cannot silently point
// at a deleted/renamed suite or a test that stopped using the OpenAPI validator.
const LIVE_SUCCESS_PROOFS = Object.freeze({
  'POST /api/auth/register': { file: 'authCookieSession.test.js', anchor: '/api/auth/register' },
  'POST /api/auth/login': { file: 'authCookieSession.test.js', anchor: '/api/auth/login' },
  'GET /api/auth/session': { file: 'authCookieSession.test.js', anchor: '/api/auth/session' },
  'POST /api/auth/logout': { file: 'authCookieSession.test.js', anchor: '/api/auth/logout' },
  'POST /api/profile/build': { file: 'concurrency.test.js', anchor: '/api/profile/build' },
  'POST /api/profile/complete': { file: 'profileCompletion.integration.test.js', anchor: '/api/profile/complete' },
  'GET /api/profile/current': { file: 'concurrency.test.js', anchor: '/api/profile/current' },
  'PUT /api/profile/{profileId}': { file: 'concurrency.test.js', anchor: '/api/profile/{profileId}' },
  'POST /api/recommend': { file: 'deferredAdvisory.test.js', anchor: '/api/recommend' },
  'GET /api/recommend/current': { file: 'recommendRestore.test.js', anchor: '/api/recommend/current' },
  'POST /api/recommend/weights': { file: 'recommendRestore.test.js', anchor: '/api/recommend/weights' },
  'POST /api/recommend/{recommendationId}/advisory': { file: 'deferredAdvisory.test.js', anchor: '/api/recommend/{recommendationId}/advisory' },
  'GET /api/recommend/audit': { file: 'auditTrail.test.js', anchor: '/api/recommend/audit' },
  'GET /api/recommend/audit/verify': { file: 'auditTrail.test.js', anchor: '/api/recommend/audit/verify' },
  'POST /api/goals/create': { file: 'goalUpdateRecompute.test.js', anchor: '/api/goals/create' },
  'GET /api/goals': { file: 'goalsReadOnly.test.js', anchor: '/api/goals' },
  'PATCH /api/goals/{goalId}': { file: 'goalUpdateRecompute.test.js', anchor: '/api/goals/{goalId}' },
  'DELETE /api/goals/{goalId}': { file: 'recommendRestore.test.js', anchor: '/api/goals/{goalId}' },
  'PATCH /api/goals/{goalId}/refresh-advice': { file: 'recommendRestore.test.js', anchor: '/api/goals/{goalId}/refresh-advice' },
  'POST /api/goals/{goalId}/simulate': { file: 'goalUpdateRecompute.test.js', anchor: '/api/goals/{goalId}/simulate' },
  'POST /api/portfolio/optimise': { file: 'openapiContract.test.js', anchor: 'POST /api/portfolio/optimise' },
  'POST /api/portfolio/rebalance': { file: 'openapiContract.test.js', anchor: 'POST /api/portfolio/rebalance' },
  'POST /api/projection': { file: 'openapiContract.test.js', anchor: 'POST /api/projection' },
  'POST /api/projection/stress-test': { file: 'recommendRestore.test.js', anchor: '/api/projection/stress-test' },
  'POST /api/projection/custom-portfolio': { file: 'openapiContract.test.js', anchor: 'POST /api/projection/custom-portfolio' },
  'POST /api/projection/allocation-split': { file: 'openapiContract.test.js', anchor: 'POST /api/projection/allocation-split' },
  'POST /api/projection/step-up': { file: 'openapiContract.test.js', anchor: 'POST /api/projection/step-up' },
  'POST /api/projection/compare': { file: 'openapiContract.test.js', anchor: 'POST /api/projection/compare' },
  'POST /api/projection/xirr': { file: 'openapiContract.test.js', anchor: 'POST /api/projection/xirr' },
  'POST /api/montecarlo/montecarlo': { file: 'openapiContract.test.js', anchor: 'POST /api/montecarlo/montecarlo' },
  'POST /api/montecarlo/portfolio': { file: 'openapiContract.test.js', anchor: 'POST /api/montecarlo/portfolio' },
  'POST /api/chat/message': { file: 'chatSessionStore.integration.test.js', anchor: '/api/chat/message' },
  'GET /api/chat/history': { file: 'chatRoutes.test.js', anchor: '/api/chat/history' },
  'DELETE /api/chat/session/{sessionId}': { file: 'chatRoutes.test.js', anchor: '/api/chat/session/{sessionId}' },
  'GET /api/instruments': { file: 'openapiContract.test.js', anchor: 'GET /api/instruments' },
  'POST /api/instruments/rank-wti': { file: 'security.test.js', anchor: '/api/instruments/rank-wti' },
  'POST /api/tax/compare': { file: 'openapiContract.test.js', anchor: 'POST /api/tax/compare' },
  'POST /api/tax/compute': { file: 'openapiContract.test.js', anchor: 'POST /api/tax/compute' },
  'GET /api/tax/policies': { file: 'openapiContract.test.js', anchor: 'GET /api/tax/policies' },
  'POST /api/tax/post-tax-return': { file: 'taxPostTaxReturnRoute.test.js', anchor: '/api/tax/post-tax-return' },
  'POST /api/tax/post-tax-return/batch': { file: 'taxPostTaxReturnRoute.test.js', anchor: '/api/tax/post-tax-return/batch' },
  'GET /api/market/params': { file: 'openapiContract.test.js', anchor: 'GET /api/market/params' },
});

// Every non-covered operation is an explicit, endpoint-specific exclusion.
// Do not replace these with a wildcard/external-dependency bucket.
const LIVE_CONTRACT_EXCLUSIONS = Object.freeze([
  { operation: 'GET /api/market/benchmarks', category: 'external-provider', owner: 'market-data', reason: 'Response is built from live NSE benchmark observations.', justification: 'The route currently has no fixture injection seam; source-provider parsers and freshness are qualified separately, and deterministic public market coverage is supplied by /api/market/params.' },
  { operation: 'GET /api/market/fixed-deposits/sbi', category: 'external-provider', owner: 'market-data', reason: 'Response depends on the currently published SBI retail deposit table.', justification: 'No route-level provider fixture seam exists; provider qualification tests own source freshness and malformed-document behavior.' },
  { operation: 'GET /api/market/government-schemes', category: 'external-provider', owner: 'market-data', reason: 'Response depends on current official government small-savings publications.', justification: 'No route-level provider fixture seam exists; provider qualification tests validate source parsing and authority.' },
  { operation: 'GET /api/market/rates', category: 'external-provider', owner: 'market-data', reason: 'Response aggregates live external financial providers.', justification: 'Its response changes with provider availability and publication time; provider-specific suites validate normalized contracts, while /api/market/params is the deterministic public success case.' },
  { operation: 'GET /api/regime/current', category: 'external-provider', owner: 'market-context', reason: 'Current regime derives from live benchmark observations and observation freshness.', justification: 'A stable route-level fixture seam is not present; deterministic policy boundary and provider suites validate the constituent behavior.' },
  { operation: 'GET /api/health', category: 'health', owner: 'platform-health', reason: 'Operational dependency status is intentionally not the canonical user API envelope.', justification: 'Health output varies with process lifecycle and configured dependency readiness.' },
  { operation: 'GET /health', category: 'health', owner: 'platform-health', reason: 'Liveness output is an infrastructure protocol, not the canonical user API envelope.', justification: 'The timestamp and process uptime are runtime-derived; endpoint behavior is covered by app architecture tests.' },
  { operation: 'GET /health/deep', category: 'health', owner: 'platform-health', reason: 'Deep readiness reports live database, Redis, worker, and provider state.', justification: 'Its status is environment-dependent and is separately exercised by observability integration tests.' },
  { operation: 'GET /health/live', category: 'health', owner: 'platform-health', reason: 'Liveness output is an infrastructure protocol, not the canonical user API envelope.', justification: 'The timestamp and process uptime are runtime-derived; endpoint behavior is covered by app architecture tests.' },
  { operation: 'GET /health/ready', category: 'health', owner: 'platform-health', reason: 'Readiness output is an infrastructure protocol, not the canonical user API envelope.', justification: 'Readiness depends on live dependency/index/lifecycle state and is covered by readiness tests.' },
  { operation: 'GET /health/verification', category: 'health', owner: 'platform-health', reason: 'Runtime dependency capability verification is an infrastructure protocol, not a user financial API.', justification: 'Its strict safe response is covered by healthVerification tests for the running process and dependency probes.' },
  { operation: 'GET /healthz', category: 'health', owner: 'platform-health', reason: 'Legacy liveness alias is an infrastructure protocol, not the canonical user API envelope.', justification: 'Its output is process-derived and is explicitly exercised in app architecture tests.' },
  { operation: 'GET /ready', category: 'health', owner: 'platform-health', reason: 'Redirect alias for readiness is an infrastructure protocol, not the canonical user API envelope.', justification: 'The target readiness status is environment-dependent and is covered by readiness tests.' },
  { operation: 'GET /live', category: 'health', owner: 'platform-health', reason: 'Redirect alias for liveness is an infrastructure protocol, not the canonical user API envelope.', justification: 'The target liveness output is process-derived and is covered by app architecture tests.' },
  { operation: 'GET /readyz', category: 'health', owner: 'platform-health', reason: 'Legacy readiness alias is an infrastructure protocol, not the canonical user API envelope.', justification: 'Its target readiness status is environment-dependent and is covered by readiness tests.' },
]);

const REQUIRED_LIVE_SUCCESS_OPERATIONS = Object.freeze(Object.keys(LIVE_SUCCESS_PROOFS));

function requestSchema(operation) {
  let body = operation.requestBody;
  if (body?.$ref) body = resolveLocalRef(body.$ref);
  const schema = body?.content?.['application/json']?.schema;
  const collectRequired = (current, visited = new Set()) => {
    if (!current) return [];
    if (current.$ref) {
      assert.equal(visited.has(current.$ref), false, `Recursive request schema reference: ${current.$ref}`);
      const nextVisited = new Set(visited);
      nextVisited.add(current.$ref);
      return collectRequired(resolveLocalRef(current.$ref), nextVisited);
    }
    return [
      ...(current.required || []),
      ...(current.allOf || []).flatMap(child => collectRequired(child, visited)),
    ];
  };
  return schema && { ...schema, required: [...new Set(collectRequired(schema))] };
}

const sourceOperations = publicMounts.flatMap(([filename, prefix]) => {
  const moduleSource = fs.readFileSync(path.join(serverRoot, 'routes', filename), 'utf8');
  return extractRoutes(moduleSource, 'router', prefix);
}).concat(extractRoutes(appSource, 'app').filter((route) => {
  // This app-level PUT registration installs only a provider gate and calls
  // through to the authenticated profile router. It is middleware, not a
  // second public endpoint whose security should be inferred from app.js.
  return !(route.method === 'put' && route.path === '/api/profile/{profileId}');
}));

test('live contract coverage manifest accounts for public routes and required success families', () => {
  const inventory = new Set(sourceOperations.map(operationKey));
  const liveCaseKeys = new Set(LIVE_CONTRACT_CASES.map(item => operationKey({
    method: item.method,
    path: item.path,
  })));
  const protectedKeys = new Set(sourceOperations.filter(route => route.authenticated).map(operationKey));
  const exclusions = new Map(LIVE_CONTRACT_EXCLUSIONS.map(item => [item.operation, item]));
  const successProofKeys = new Set(Object.keys(LIVE_SUCCESS_PROOFS));

  assert.equal(exclusions.size, LIVE_CONTRACT_EXCLUSIONS.length, 'exclusion operations must be unique');
  for (const [key, proof] of Object.entries(LIVE_SUCCESS_PROOFS)) {
    assert.ok(inventory.has(key), `Success proof does not match a public route: ${key}`);
    assert.ok(contract.paths[key.split(' ')[1]]?.[key.split(' ')[0].toLowerCase()], `Success proof is undocumented: ${key}`);
    const proofSource = fs.readFileSync(path.join(serverRoot, 'test', proof.file), 'utf8');
    assert.ok(proofSource.includes(proof.anchor), `${key} proof no longer refers to its route in ${proof.file}`);
    assert.match(proofSource, /assertFetchResponseMatchesOpenApi|assertRuntimeResponseMatchesContract|runOpenApiHttpCase/,
      `${key} proof must use the shared runtime OpenAPI validator in ${proof.file}`);
    if (proof.file === 'openapiContract.test.js') {
      assert.ok(liveCaseKeys.has(key), `${key} must have an executable LIVE_CONTRACT_CASES entry`);
    }
  }

  for (const operation of LIVE_CONTRACT_EXCLUSIONS) {
    assert.ok(inventory.has(operation.operation), `Exclusion is not a current public route: ${operation.operation}`);
    assert.ok(['health', 'external-provider'].includes(operation.category), `${operation.operation} has a disallowed exclusion category`);
    for (const field of ['owner', 'reason', 'justification']) {
      assert.equal(typeof operation[field], 'string');
      assert.ok(operation[field].trim().length >= (field === 'owner' ? 3 : 20), `${operation.operation} requires a specific ${field}`);
    }
    assert.equal(successProofKeys.has(operation.operation), false, `${operation.operation} cannot be both excluded and success-covered`);
  }

  const covered = new Set([...liveCaseKeys, ...protectedKeys, ...successProofKeys, ...exclusions.keys()]);
  assert.deepEqual([...covered].sort(), [...inventory].sort(),
    'Every public operation needs a live case, authenticated error case, success proof, or explicit endpoint-specific exclusion.');

  for (const key of REQUIRED_LIVE_SUCCESS_OPERATIONS) {
    assert.ok(successProofKeys.has(key) || liveCaseKeys.has(key), `Critical operation lacks live success schema validation: ${key}`);
  }
});

test('canonical OpenAPI exactly matches intended public Express methods and paths', () => {
  for (const [filename, prefix] of publicMounts.filter(([name]) => name !== 'health.js')) {
    const importName = filename === 'chatRoutes.js' ? 'chatRoutes'
      : filename === 'metricsRoutes.js' ? 'metricsRoutes'
        : filename.replace(/\.js$/, '').replace('montecarlo', 'montecarlo') + 'Routes';
    assert.match(appSource, new RegExp(`app\\.use\\(['\"]${prefix.replaceAll('/', '\\/')}['\"]`), `${filename} mount changed without updating the contract inventory`);
    void importName;
  }

  const sourceKeys = new Set(sourceOperations.map(operationKey));
  const contractKeys = new Set(contractOperations().map(operationKey));
  assert.deepEqual([...contractKeys].sort(), [...sourceKeys].sort());
  assert.equal([...contractKeys].some((key) => key.includes('/api/metrics')), false);
  assert.equal([...contractKeys].some((key) => key.includes('/api/mcp')), false);
});

test('OpenAPI authentication and cookie-session CSRF metadata match Express routes', () => {
  const operations = new Map(contractOperations().map((entry) => [operationKey(entry), entry.operation]));
  for (const route of sourceOperations) {
    const operation = operations.get(operationKey(route));
    assert.ok(operation, `Missing ${operationKey(route)}`);
    const hasAuth = Array.isArray(operation.security) && operation.security.length > 0;
    assert.equal(hasAuth, route.authenticated, `${operationKey(route)} authentication drifted`);

    if (route.path.startsWith('/api/') && ['post', 'put', 'patch', 'delete'].includes(route.method)) {
      assert.equal(operation['x-csrf-protection'], 'cookie-session', `${operationKey(route)} must document cookie-session CSRF behavior`);
    }
  }
});

test('every authenticated public operation emits a documented live unauthenticated error envelope', async () => {
  const oldSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'openapi-unauthenticated-contract-secret-at-least-32';
  const protectedOperations = sourceOperations.filter(route => route.authenticated);
  assert.ok(protectedOperations.length > 0, 'route inventory must include protected public operations');

  try {
    await withServer(buildContractTestApp(), async baseUrl => {
      for (const route of protectedOperations) {
        const routePath = route.path.replace(/\{[^}]+\}/g, '65b000000000000000000099');
        const response = await fetch(`${baseUrl}${routePath}`, {
          method: route.method.toUpperCase(),
          headers: ['get', 'delete'].includes(route.method) ? {} : { 'Content-Type': 'application/json' },
          ...(['get', 'delete'].includes(route.method) ? {} : { body: JSON.stringify({}) }),
        });
        const body = await response.json();
        assert.ok(response.status >= 400, `${operationKey(route)} unexpectedly succeeded without authentication`);
        assertRuntimeResponseMatchesContract({
          method: route.method,
          path: route.path,
          status: response.status,
          contentType: response.headers.get('content-type'),
          body,
        });
      }
    });
  } finally {
    if (oldSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldSecret;
  }
});

test('OpenAPI preserves major runtime-required request fields', () => {
  const expected = new Map([
    ['POST /api/auth/register', ['name', 'email', 'password']],
    ['POST /api/auth/login', ['email', 'password']],
    ['POST /api/profile/build', [
      'monthly_take_home', 'monthly_savings', 'age', 'risk_tolerance',
      'investment_goals', 'investment_horizon_years',
    ]],
    ['POST /api/recommend', ['profileId']],
    ['POST /api/projection/stress-test', ['profileId', 'instrumentId', 'principal']],
    ['POST /api/projection/allocation-split', ['monthlyInvestment', 'equityPct']],
    ['POST /api/goals/create', ['goal_name', 'target_amount', 'target_date', 'current_savings', 'profileId', 'priority']],
    ['POST /api/montecarlo/montecarlo', ['profileId', 'instrument', 'monthly_investment', 'years']],
    ['POST /api/portfolio/rebalance', [
      'profileId', 'current_allocation', 'target_allocation', 'threshold', 'partial_ratio', 'holding_months',
    ]],
    ['POST /api/chat/message', ['message']],
    ['POST /api/tax/compute', ['income', 'incomeSource', 'fiscalYear', 'regime']],
    ['POST /api/tax/compare', ['income', 'incomeSource', 'fiscalYear', 'age']],
  ]);
  const operations = new Map(contractOperations().map((entry) => [operationKey(entry), entry.operation]));

  for (const [key, requiredFields] of expected) {
    const schema = requestSchema(operations.get(key));
    assert.ok(schema, `${key} has no JSON request schema`);
    assert.deepEqual(new Set(schema.required ?? []), new Set(requiredFields), `${key} required fields drifted`);
  }
});

test('tax calculation OpenAPI moves sensitive inputs to strict POST bodies', () => {
  const contracts = [
    ['/api/tax/compute', 'TaxComputeRequest', {
      income: 1_000_000_000,
      incomeSource: 'salary',
      fiscalYear: 'FY2026-27',
      regime: 'new',
    }],
    ['/api/tax/compare', 'TaxCompareRequest', {
      income: 1_000_000_000,
      incomeSource: 'salary',
      fiscalYear: 'FY2026-27',
      age: 35,
    }],
  ];

  for (const [routePath, schemaName, validBody] of contracts) {
    const pathItem = contract.paths[routePath];
    assert.equal(pathItem.get, undefined, `${routePath} must not expose sensitive GET inputs`);
    assert.deepEqual(pathItem.post.parameters || [], [], `${routePath} must keep tax inputs out of query parameters`);
    const requestBody = resolveLocalRef(pathItem.post.requestBody.$ref);
    assert.equal(requestBody.content['application/json'].schema.$ref, `#/components/schemas/${schemaName}`);

    const validateBody = responseAjv.compile(inlineLocalRefs({ $ref: `#/components/schemas/${schemaName}` }));
    assert.equal(validateBody(validBody), true, JSON.stringify(validateBody.errors));
    assert.equal(validateBody({ ...validBody, income: 1_000_000_001 }), false);
    assert.equal(validateBody({ ...validBody, sensitiveExtra: true }), false);
    assert.equal(validateBody({ ...validBody, section80D: 50000, section80D_self: 0 }), false);
  }
});

test('OpenAPI nested tax deductions include the supported legacy alias and reject mixed 80D forms', () => {
  const deductionSchema = inlineLocalRefs(resolveLocalRef('#/components/schemas/TaxDeductionInputs'));
  const validateDeductions = responseAjv.compile(deductionSchema);
  assert.equal(validateDeductions({ section80CCD: 50000 }), true, JSON.stringify(validateDeductions.errors));
  assert.equal(validateDeductions({ section80D: 50000 }), true, JSON.stringify(validateDeductions.errors));
  assert.equal(validateDeductions({ section80D_self: 25000 }), true, JSON.stringify(validateDeductions.errors));
  assert.equal(validateDeductions({ section80D: 50000, section80D_self: 0 }), false);
  assert.equal(validateDeductions({ unknownDeduction: 0 }), false);
});

test('OpenAPI nested deduction maxima match the runtime Joi schema at and above each boundary', () => {
  const validateDeductions = responseAjv.compile(
    inlineLocalRefs(resolveLocalRef('#/components/schemas/TaxDeductionInputs')),
  );
  const maxima = {
    section80C: 150_000,
    nps80CCD1B: 50_000,
    section80CCD: 50_000,
    nps80CCD2: 100_000_000,
    basicSalary: 1_000_000_000,
    section80D: 100_000,
    section80D_self: 50_000,
    section80D_parents: 50_000,
    hra: 100_000_000,
    homeLoanInterest: 200_000,
    section80EEA: 150_000,
    savingsInterest: 100_000_000,
    section80TTA: 10_000,
    section80TTB: 50_000,
    age: 120,
    other: 0,
  };

  for (const [field, maximum] of Object.entries(maxima)) {
    const dependencyFacts = field === 'nps80CCD2'
      ? { basicSalary: 0, isGovtEmployee: false }
      : field === 'section80D_parents'
        ? { parents_senior: false }
        : {};
    const atMaximum = { ...dependencyFacts, [field]: maximum };
    const aboveMaximum = { ...dependencyFacts, [field]: maximum + 1 };
    assert.equal(taxDeductionSchema.validate(atMaximum).error, undefined, `${field} Joi maximum`);
    assert.equal(validateDeductions(atMaximum), true, `${field} OpenAPI maximum: ${JSON.stringify(validateDeductions.errors)}`);
    assert.ok(taxDeductionSchema.validate(aboveMaximum).error, `${field} rejects above Joi maximum`);
    assert.equal(validateDeductions(aboveMaximum), false, `${field} rejects above OpenAPI maximum`);
  }
});

test('post-tax OpenAPI compositions accept valid bodies, stay strict, and document date chronology', () => {
  const validateRequest = responseAjv.compile(
    inlineLocalRefs({ $ref: '#/components/schemas/PostTaxReturnRequestV2' }),
  );
  const base = {
    instrumentType: 'FD', nominalRate: 0.07, holdingYears: 1, monthlySIP: 0,
    annualIncome: 1_000_000, regime: 'new', userAge: 35, incomeSource: 'salary', fiscalYear: 'FY2026-27',
  };
  assert.equal(validateRequest(base), true, JSON.stringify(validateRequest.errors));
  assert.equal(validateRequest({ ...base, instrumentTaxOverride: true }), false);
  assert.equal(validateRequest({ ...base, acquisitionDate: '2026-01-01' }), false, 'dates must be paired');
  assert.equal(validateRequest({ ...base, acquisitionDate: '2026-02-30', redemptionDate: '2026-03-01' }), false,
    'date format rejects an impossible calendar date');
  assert.match(
    contract.components.schemas.PostTaxReturnRequestV2['x-runtime-validation'].transactionDates,
    /redemptionDate must be on or after acquisitionDate/,
  );
  assert.match(
    contract.components.schemas.PostTaxInstrumentFields['x-runtime-validation'].transactionDates,
    /redemptionDate must be on or after acquisitionDate/,
  );

  const validateInstrument = responseAjv.compile(
    inlineLocalRefs({ $ref: '#/components/schemas/PostTaxInstrument' }),
  );
  const instrument = {
    instrumentType: 'FD', nominalRate: 0.07, holdingYears: 1, monthlySIP: 0,
  };
  assert.equal(validateInstrument(instrument), true, JSON.stringify(validateInstrument.errors));
  assert.equal(validateInstrument({ ...instrument, instrumentType: '' }), false);
  assert.equal(validateInstrument({ ...instrument, instrumentType: '   ' }), false);
  assert.equal(validateInstrument({ ...instrument, retirementTiming: '  ' }), false);
  assert.equal(validateInstrument({ ...instrument, unexpected: 1 }), false);
  assert.equal(validateInstrument({ ...instrument, redemptionDate: '2026-01-01' }), false);
  assert.match(
    contract.components.schemas.PostTaxInstrumentFields['x-runtime-validation'].trimmedText,
    /trimmed before the server enforces their length constraints/,
  );

  const normalizedTextBoundaries = [
    [{ instrumentType: `${'x'.repeat(50)} ` }, true],
    [{ instrumentType: 'x'.repeat(51) }, false],
    [{ retirementTiming: ' x ' }, false],
    [{ retirementTiming: `${'ab'}${' '.repeat(99)}` }, true],
    [{ retirementTiming: 'x'.repeat(100) }, true],
    [{ retirementTiming: 'x'.repeat(101) }, false],
  ];
  for (const [textOverride, expectedValid] of normalizedTextBoundaries) {
    const request = { ...base, ...textOverride };
    assert.equal(postTaxReturnSchema.validate(request).error === undefined, expectedValid,
      `Joi trimmed text boundary: ${JSON.stringify(textOverride)}`);
    assert.equal(validateRequest(request), expectedValid,
      `OpenAPI trimmed text boundary ${JSON.stringify(textOverride)}: ${JSON.stringify(validateRequest.errors)}`);
  }

  const validateLegacyRequest = responseAjv.compile(
    inlineLocalRefs({ $ref: '#/components/schemas/PostTaxReturnRequest' }),
  );
  const legacyBase = { ...base };
  delete legacyBase.section112AExemptionUsed;
  delete legacyBase.deductions;
  assert.equal(validateLegacyRequest(legacyBase), true, JSON.stringify(validateLegacyRequest.errors));
  assert.equal(validateLegacyRequest({ ...legacyBase, unexpected: true }), false);

  const batchBase = {
    instruments: [instrument], annualIncome: 1_000_000, regime: 'new', userAge: 35,
    incomeSource: 'salary', inflationRate: 0.02, fiscalYear: 'FY2026-27',
  };
  for (const schemaName of ['PostTaxReturnBatchRequestV2', 'PostTaxReturnBatchRequest']) {
    const validateBatch = responseAjv.compile(inlineLocalRefs({ $ref: `#/components/schemas/${schemaName}` }));
    assert.equal(validateBatch(batchBase), true, `${schemaName}: ${JSON.stringify(validateBatch.errors)}`);
    assert.equal(validateBatch({ ...batchBase, unknownTaxInput: 1 }), false, `${schemaName} rejects unknown fields`);
  }
});

test('user-declared scenario OpenAPI conditions match the two supported scenario contracts', () => {
  const validateScenario = responseAjv.compile(
    inlineLocalRefs({ $ref: '#/components/schemas/UserDeclaredPostTaxScenarioRequest' }),
  );
  const common = {
    annualGrossIncome: 1_000_000, incomeSource: 'salary', regime: 'new', fiscalYear: 'FY2026-27', userAge: 35,
  };
  const interest = {
    ...common, canonicalInstrumentId: 'sbi_fd', scenarioType: 'INTEREST_INCOME', interestReceived: 0,
  };
  assert.equal(validateScenario(interest), true, JSON.stringify(validateScenario.errors));
  const interestWithoutAmount = { ...interest };
  delete interestWithoutAmount.interestReceived;
  assert.equal(validateScenario(interestWithoutAmount), false);
  assert.equal(validateScenario({ ...interest, canonicalInstrumentId: 'nifty_etf' }), false);
  assert.equal(validateScenario({ ...interest, canonicalProductId: 'etf:isin:INF204KB14I2' }), false);
  assert.equal(validateScenario({ ...interest, acquisitionCostBasis: 1 }), false);

  const equity = {
    ...common,
    annualGrossIncome: 3_000_000,
    canonicalInstrumentId: 'nifty_etf',
    canonicalProductId: 'etf:isin:INF204KB14I2',
    scenarioType: 'EQUITY_REALIZED_GAIN',
    acquisitionCostBasis: 100_000,
    saleProceeds: 110_000,
    acquisitionDate: '2026-01-01',
    redemptionDate: '2026-12-31',
    section112AExemptionUsed: 0,
    sttConditionAssumedSatisfied: true,
  };
  assert.equal(validateScenario(equity), true, JSON.stringify(validateScenario.errors));
  const equityWithoutCostBasis = { ...equity };
  delete equityWithoutCostBasis.acquisitionCostBasis;
  assert.equal(validateScenario(equityWithoutCostBasis), false);
  assert.equal(validateScenario({ ...equity, canonicalInstrumentId: 'fd' }), false);
  assert.equal(validateScenario({ ...equity, canonicalProductId: 'etf:isin:OTHER' }), false);
  assert.equal(validateScenario({ ...equity, interestReceived: 0 }), false);
  const equityWithoutRedemptionDate = { ...equity };
  delete equityWithoutRedemptionDate.redemptionDate;
  assert.equal(validateScenario(equityWithoutRedemptionDate), false);
  assert.equal(validateScenario({ ...equity, acquisitionDate: '2026-02-30' }), false);
  assert.match(
    contract.components.schemas.UserDeclaredPostTaxScenarioRequest['x-runtime-validation'].transactionDates,
    /redemptionDate must fall within the supplied fiscalYear/,
  );
});
test('tax OpenAPI age inputs are explicit and bounded for the supplied fiscal year', () => {
  const propertiesFor = (schemaName, allOfIndex) => {
    const schema = contract.components.schemas[schemaName];
    return allOfIndex === undefined ? schema.properties : schema.allOf[allOfIndex].properties;
  };
  const taxAgeProperties = [
    propertiesFor('TaxCommonRequestInputs'),
    propertiesFor('TaxCompareRequest', 1),
    propertiesFor('TaxDeductionInputs'),
    propertiesFor('TaxCalculationContext'),
    propertiesFor('TaxCalculationContextV2'),
    propertiesFor('PostTaxReturnRequestV2', 1),
    propertiesFor('PostTaxReturnBatchRequestV2'),
    propertiesFor('UserDeclaredPostTaxScenarioRequest'),
    propertiesFor('PostTaxReturnRequest', 1),
    propertiesFor('PostTaxReturnBatchRequest'),
  ];
  for (const properties of taxAgeProperties) {
    const age = properties.age || properties.userAge;
    assert.match(age.description, /age on March 31 of the supplied fiscalYear/i);
    assert.match(age.description, /never inferred from profile age/i);
    assert.equal(age.type, 'integer');
    assert.equal(age.minimum, 18);
    assert.equal(age.maximum, 120);
  }

  const nestedAgeDescription = propertiesFor('TaxDeductionInputs').age.description;
  assert.match(nestedAgeDescription, /when top-level userAge is also supplied, both values must match/i);
  assert.match(nestedAgeDescription, /server rejects unequal values/i);
  const topLevelUserAgeProperties = [
    propertiesFor('TaxCalculationContext').userAge,
    propertiesFor('TaxCalculationContextV2').userAge,
    propertiesFor('PostTaxReturnRequestV2', 1).userAge,
    propertiesFor('PostTaxReturnBatchRequestV2').userAge,
    propertiesFor('UserDeclaredPostTaxScenarioRequest').userAge,
  ];
  for (const userAge of topLevelUserAgeProperties) {
    assert.match(userAge.description, /if deductions\.age is also supplied, the server rejects unequal values/i);
  }

  const commonInputs = propertiesFor('TaxCommonRequestInputs');
  assert.match(commonInputs.section80CCD.description, /server rejects unequal amounts/i);
  assert.match(commonInputs.nps80CCD1B.description, /server requires both amounts to match/i);
  const deductionProperties = propertiesFor('TaxDeductionInputs');
  assert.match(deductionProperties.section80CCD.description, /server rejects unequal amounts/i);
  assert.match(deductionProperties.nps80CCD1B.description, /server requires both amounts to match/i);

  const deductionsSchema = inlineLocalRefs(resolveLocalRef('#/components/schemas/TaxDeductionInputs'));
  const validateDeductions = responseAjv.compile(deductionsSchema);
  for (const age of [18, 120]) assert.equal(validateDeductions({ age }), true);
  for (const age of [17, 121, 18.5]) assert.equal(validateDeductions({ age }), false);
  assert.equal(validateDeductions({ age: 35, unexpected: 1 }), false);
  assert.equal(validateDeductions({ age: 35, section80CCD: 0, other: 0 }), true);
  assert.equal(validateDeductions({ age: 35, other: 1 }), false);
});

test('tax OpenAPI mirrors Joi conditional age requirements and compare compatibility', () => {
  const validateSchema = schemaName => responseAjv.compile(
    inlineLocalRefs({ $ref: `#/components/schemas/${schemaName}` }),
  );
  const taxInputs = { income: 1_000_000, incomeSource: 'salary', fiscalYear: 'FY2026-27' };
  const validateCompute = validateSchema('TaxComputeRequest');
  assert.equal(validateCompute({ ...taxInputs, regime: 'new' }), true);
  assert.equal(validateCompute({ ...taxInputs, regime: 'old' }), false);
  assert.equal(validateCompute({ ...taxInputs, regime: 'old', age: 45 }), true);
  assert.equal(validateCompute({ ...taxInputs, regime: 'new', section80D: 1 }), false);
  assert.equal(validateCompute({ ...taxInputs, regime: 'new', section80D: 1, age: 45 }), true);
  assert.equal(validateCompute({ ...taxInputs, regime: 'new', section80D_self: 1 }), false);
  assert.equal(validateCompute({ ...taxInputs, regime: 'new', section80D_parents: 1, age: 45 }), false, 'parents Section 80D requires explicit senior status');
  assert.equal(validateCompute({ ...taxInputs, regime: 'new', section80D_parents: 1, age: 45, parents_senior: false }), true);
  assert.equal(validateCompute({ ...taxInputs, regime: 'new', nps80CCD2: 1 }), false, 'employer NPS deduction requires salary and employment facts');
  assert.equal(validateCompute({
    ...taxInputs, regime: 'new', nps80CCD2: 1, basicSalary: 500_000, isGovtEmployee: false,
  }), true);
  assert.equal(validateCompute({ ...taxInputs, regime: 'new', section80D: 0 }), true);
  for (const field of ['savingsInterest', 'section80TTA', 'section80TTB']) {
    assert.equal(validateCompute({ ...taxInputs, regime: 'new', [field]: 1 }), false, `${field} requires age`);
    assert.equal(validateCompute({ ...taxInputs, regime: 'new', [field]: 1, age: 45 }), true);
    assert.equal(validateCompute({ ...taxInputs, regime: 'new', [field]: 0 }), true);
  }

  const validateCompare = validateSchema('TaxCompareRequest');
  assert.equal(validateCompare({ ...taxInputs }), false);
  assert.equal(validateCompare({ ...taxInputs, age: 18 }), true);
  assert.equal(validateCompare({ ...taxInputs, age: 121 }), false);
  assert.equal(validateCompare({ ...taxInputs, age: 45, section80D: 1, section80D_self: 0 }), false);
  assert.equal(validateCompare({ ...taxInputs, age: 45, section80D_parents: 1 }), false);
  assert.equal(validateCompare({ ...taxInputs, age: 45, section80D_parents: 1, parents_senior: false }), true);
  assert.equal(validateCompare({ ...taxInputs, age: 45, nps80CCD2: 1 }), false);
  assert.equal(validateCompare({
    ...taxInputs, age: 45, nps80CCD2: 1, basicSalary: 500_000, isGovtEmployee: false,
  }), true);

  const context = {
    annualGrossIncome: 1_000_000,
    incomeSource: 'salary',
    regime: 'new',
    fiscalYear: 'FY2026-27',
  };
  const validateLegacyContext = validateSchema('TaxCalculationContext');
  assert.equal(validateLegacyContext(context), true);
  assert.equal(validateLegacyContext({ ...context, regime: 'old' }), false);
  assert.equal(validateLegacyContext({ ...context, regime: 'old', userAge: 45 }), true);
  assert.equal(validateLegacyContext({ ...context, deductions: { section80D: 1 } }), false);
  assert.equal(validateLegacyContext({ ...context, deductions: { section80D: 1 }, userAge: 45 }), true);
  assert.equal(validateLegacyContext({ ...context, deductions: { section80D: 0 } }), true);
  for (const field of ['savingsInterest', 'section80TTA', 'section80TTB']) {
    assert.equal(validateLegacyContext({ ...context, deductions: { [field]: 1 } }), false, `${field} requires userAge`);
    assert.equal(validateLegacyContext({ ...context, deductions: { [field]: 1 }, userAge: 45 }), true);
    assert.equal(validateLegacyContext({ ...context, deductions: { [field]: 0 } }), true);
  }

  const validateContext = validateSchema('TaxCalculationContextV2');
  assert.equal(validateContext({}), true, 'empty optional context is accepted by the runtime Joi schema');
  assert.equal(validateContext({ illustrativePrincipal: 10_000 }), true, 'product-only context does not require tax inputs');
  assert.equal(validateContext({ acquisitionDate: '2026-01-01', redemptionDate: '2026-01-01' }), true);
  assert.equal(validateContext({ annualGrossIncome: 1 }), false, 'any tax-context input requires all four core tax fields');
  assert.equal(validateContext(context), true);
  const rankRequestBase = {
    profileId: '507f1f77bcf86cd799439011',
    profileVersion: 1,
    recommendationId: '507f1f77bcf86cd799439012',
    expectedAllocationRevision: 1,
    expectedAllocationRevisionId: '507f1f77bcf86cd799439013',
    expectedPortfolioFingerprint: 'a'.repeat(64),
    expectedRecommendationFingerprint: 'b'.repeat(64),
    parentInstrumentId: 'large_cap_mf',
  };
  const validateRankWti = validateSchema('RankInstrumentsRequest');
  assert.equal(validateRankWti({
    ...rankRequestBase,
    taxCalculationContext: { illustrativePrincipal: 10_000 },
  }), true, 'the ranking endpoint accepts a product-only context');
  assert.equal(validateRankWti({
    ...rankRequestBase,
    taxCalculationContext: { acquisitionDate: '2026-01-01', redemptionDate: '2026-01-01' },
  }), true, 'the ranking endpoint accepts a valid date-only context');
  assert.equal(validateRankWti({
    ...rankRequestBase,
    taxCalculationContext: { annualGrossIncome: 1 },
  }), false, 'the ranking endpoint rejects incomplete tax context');
  assert.equal(validateContext({ ...context, acquisitionDate: '2026-01-01' }), false);
  assert.equal(validateContext({ ...context, redemptionDate: '2026-01-02' }), false);
  assert.equal(validateContext({
    ...context,
    acquisitionDate: '2026-01-01',
    redemptionDate: '2026-01-02',
  }), true);
  assert.equal(validateContext({
    ...context,
    acquisitionDate: '2026-02-30',
    redemptionDate: '2026-03-01',
  }), false, 'date format rejects impossible calendar dates');
  const contextV2Schema = contract.components.schemas.TaxCalculationContextV2;
  assert.match(contextV2Schema['x-runtime-validation'].transactionDates, /redemptionDate must be on or after acquisitionDate/);
  assert.match(contextV2Schema.properties.redemptionDate.description, /cannot precede it/);
  assert.equal(validateContext({ ...context, regime: 'old' }), false);
  assert.equal(validateContext({ ...context, regime: 'old', userAge: 45 }), true);
  assert.equal(validateContext({ ...context, deductions: { section80D: 1 } }), false);
  assert.equal(validateContext({ ...context, deductions: { section80D: 1 }, userAge: 45 }), true);
  assert.equal(validateContext({ ...context, deductions: { section80D: 0 } }), true);
  assert.equal(validateContext({ ...context, deductions: { nps80CCD2: 1 } }), false);
  assert.equal(validateContext({
    ...context,
    deductions: { nps80CCD2: 1, basicSalary: 500_000, isGovtEmployee: false },
  }), true);
  assert.equal(validateContext({
    ...context,
    userAge: 45,
    deductions: { section80D_parents: 1 },
  }), false);
  assert.equal(validateContext({
    ...context,
    userAge: 45,
    deductions: { section80D_parents: 1, parents_senior: false },
  }), true);
  for (const field of ['savingsInterest', 'section80TTA', 'section80TTB']) {
    assert.equal(validateContext({ ...context, deductions: { [field]: 1 } }), false, `${field} requires userAge`);
    assert.equal(validateContext({ ...context, deductions: { [field]: 1 }, userAge: 45 }), true);
    assert.equal(validateContext({ ...context, deductions: { [field]: 0 } }), true);
  }
});

test('OpenAPI documents the explicit equity-fund STT scenario input and tax provenance output', () => {
  const taxContextSchema = inlineLocalRefs(resolveLocalRef('#/components/schemas/TaxCalculationContextV2'));
  const validateTaxContext = responseAjv.compile(taxContextSchema);
  const requiredContext = {
    annualGrossIncome: 500000,
    incomeSource: 'salary',
    regime: 'new',
    fiscalYear: 'FY2026-27',
  };
  assert.equal(validateTaxContext(requiredContext), true, JSON.stringify(validateTaxContext.errors));
  assert.equal(validateTaxContext({ ...requiredContext, sttConditionAssumedSatisfied: true }), true);
  assert.equal(validateTaxContext({ ...requiredContext, sttConditionAssumedSatisfied: false }), true);
  assert.equal(validateTaxContext({ ...requiredContext, sttConditionAssumedSatisfied: 'true' }), false);
  assert.equal(validateTaxContext({ ...requiredContext, unknownTaxAssumption: true }), false);

  const productTaxResult = {
    status: 'CALCULATED',
    calculationClass: 'HISTORICAL_RETURN_POST_TAX_ILLUSTRATION',
    taxClass: 'EQUITY_MF_SECTION_112A',
    taxClassification: 'EQUITY_MF_SECTION_112A',
    taxClassificationMetadata: { productEvidence: { officialSourceUrl: 'https://mf.nipponindiaim.com/InvestorServices/SIDETF/NipponIndia-ETF-Nifty-50-BeES.pdf' } },
    taxRuleMetadata: { currentRuleReferences: [{ statute: 'INCOME_TAX_ACT_2025', reference: 'Section 198' }] },
    fiscalYear: 'FY2026-27',
    policyVersion: 'tax-policy-FY2026-27-v2',
    inputBasis: 'HISTORICAL_PROVIDER_FACT_PLUS_EXPLICIT_TAX_INPUTS',
    dataClass: 'HISTORICAL_PROVIDER_FACT',
  };
  assertResponseMatchesSchemaRef(
    '#/components/schemas/ProductPostTaxAnalysis',
    productTaxResult,
    'Product post-tax analysis with product and statutory provenance',
  );
  assert.equal(responseAjv.compile(inlineLocalRefs({ $ref: '#/components/schemas/ProductPostTaxAnalysis' }))({
    ...productTaxResult,
    uncontractedTaxFact: 'must not be silently accepted',
  }), false);
});

test('advisory idempotency is required and profile/goal idempotency is documented', () => {
  const operations = new Map(contractOperations().map((entry) => [operationKey(entry), entry.operation]));
  assert.equal(operations.get('POST /api/recommend')['x-idempotency-key'], 'required');
  assert.equal(operations.get('POST /api/profile/build')['x-idempotency-key'], 'required');
  assert.equal(operations.get('POST /api/goals/create')['x-idempotency-key'], 'required');
  assert.equal(operations.get('POST /api/profile/build').responses['503'].$ref, '#/components/responses/Unavailable');
  assert.equal(operations.get('POST /api/goals/create').responses['503'].$ref, '#/components/responses/Unavailable');
});

test('goal-advice reconciliation contract distinguishes committed operation from current goal state', () => {
  const operation = contract.paths['/api/goals/{goalId}/refresh-advice'].patch;
  const response = resolveLocalRef(operation.responses['200'].$ref);
  const responseSchema = response.content['application/json'].schema;
  const schema = responseSchema.$ref ? resolveLocalRef(responseSchema.$ref) : responseSchema;
  assert.ok(schema.required.includes('operation_result'));
  assert.deepEqual(schema.properties.operation_result.required, ['committed', 'goal_version', 'response_state']);
  assert.ok(['CURRENT', 'STALE'].every(value => schema.properties.operation_result.properties.response_state.enum.includes(value)));
  assert.ok(operation.responses['503'], 'committed-but-unreconciled responses must be documented');
});

test('OpenAPI runtime contracts exercise real HTTP success and canonical error responses', async () => {
  const oldSecret = process.env.JWT_SECRET;
  const oldNodeEnv = process.env.NODE_ENV;
  const oldFind = Instrument.find;
  const oldCountDocuments = Instrument.countDocuments;
  const oldProfileFindOne = FinancialProfile.findOne;
  const oldProfileExists = FinancialProfile.exists;
  const oldProfileStateFindOne = FinancialProfileState.findOne;
  const oldRecommendationFindOne = Recommendation.findOne;
  const oldStateFindOne = RecommendationState.findOne;
  const oldRevisionFindOne = RecommendationAllocationRevision.findOne;
  const userId = '65b000000000000000000001';
  const profileId = '65b000000000000000000002';
  const recommendationProfile = buildRecommendationProfile(canonicalProfilePayload());
  const profileFixture = {
    _id: profileId,
    userId,
    version: 1,
    ...toProfilePersistence(recommendationProfile, assessSuitabilityRisk(recommendationProfile)),
  };
  const emptyQuery = value => ({
    select() { return this; },
    sort() { return this; },
    lean: async () => value,
  });
  process.env.JWT_SECRET = 'openapi-runtime-contract-test-secret-at-least-32';
  process.env.NODE_ENV = 'test';
  Instrument.find = () => ({
    sort() { return this; },
    skip() { return this; },
    limit() { return this; },
    lean: async () => [{
      id: 'catalog:fd:contract', name: 'Contract Bank Deposit', type: 'FD', interestRate: 6.5,
      internalPersistenceFlag: 'must-not-escape',
    }],
  });
  Instrument.countDocuments = async () => 1;
  FinancialProfile.findOne = () => emptyQuery(profileFixture);
  FinancialProfile.exists = async filter => (String(filter?._id) === profileId && String(filter?.userId) === userId ? { _id: profileId } : null);
  FinancialProfileState.findOne = () => emptyQuery({
    userId,
    currentProfileId: profileId,
    revision: 1,
    promotionFence: 0,
    resolutionStatus: 'CURRENT',
  });
  Recommendation.findOne = () => emptyQuery(null);
  RecommendationState.findOne = () => emptyQuery(null);
  RecommendationAllocationRevision.findOne = () => emptyQuery(null);

  try {
    await withMockAuthAccountState(() => withServer(buildContractTestApp(), async baseUrl => {
      const authToken = jwt.sign({ userId, jti: 'openapi-contract-jti' }, process.env.JWT_SECRET, { expiresIn: '5m' });
      const authorization = { Authorization: `Bearer ${authToken}` };
      for (const item of LIVE_CONTRACT_CASES) {
        const headers = {
          ...(item.authenticated || item.method !== 'GET' ? authorization : {}),
        };
        await runOpenApiHttpCase({
          baseUrl,
          ...item,
          headers,
        });
      }

      const missingRoute = await rawRequest(`${baseUrl}/api/not-a-public-route`);
      assert.equal(missingRoute.status, 404);
      assert.match(missingRoute.headers.get('content-type') || '', /^application\/json\b/i);
      assertResponseMatchesSchemaRef(
        '#/components/schemas/Error',
        await missingRoute.json(),
        'Canonical 404 error envelope',
      );

      const priorFind = Instrument.find;
      Instrument.find = () => ({
        sort() { return this; },
        skip() { return this; },
        limit() { return this; },
        lean: async () => [{ name: 'Broken catalog row', type: 'FD' }],
      });
      try {
        const unavailable = await rawRequest(`${baseUrl}/api/instruments`);
        assert.equal(unavailable.status, 503);
        assertRuntimeResponseMatchesContract({
          method: 'GET', path: '/api/instruments', status: unavailable.status,
          contentType: unavailable.headers.get('content-type'), body: await unavailable.json(),
        });
      } finally {
        Instrument.find = priorFind;
      }
    }));
  } finally {
    Instrument.find = oldFind;
    Instrument.countDocuments = oldCountDocuments;
    FinancialProfile.findOne = oldProfileFindOne;
    FinancialProfile.exists = oldProfileExists;
    FinancialProfileState.findOne = oldProfileStateFindOne;
    Recommendation.findOne = oldRecommendationFindOne;
    RecommendationState.findOne = oldStateFindOne;
    RecommendationAllocationRevision.findOne = oldRevisionFindOne;
    if (oldSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldSecret;
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = oldNodeEnv;
  }
});

test('enabled GenieProof routes reject invalid consent and unknown fields over authenticated HTTP', async () => {
  const oldSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'genieproof-enabled-route-test-secret-at-least-32';
  const app = buildContractTestApp();
  app.locals.genieProofRuntime = { enabled: true, productionActivationAllowed: false };
  const userId = '65b000000000000000000001';
  const token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const url = '/api/genieproof/cases/00000000-0000-4000-8000-000000000001/watch';

  try {
    await withMockAuthAccountState(() => withServer(app, async baseUrl => {
      for (const body of [{ watchConsent: false }, { watchConsent: true, userId }]) {
        const response = await rawRequest(`${baseUrl}${url}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        assert.equal(response.status, 400);
        assert.equal((await response.json()).code, 'VALIDATION_ERROR');
      }

      const missingIdempotency = await rawRequest(`${baseUrl}${url}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ watchConsent: true }),
      });
      assert.equal(missingIdempotency.status, 400, 'valid consent proceeds to the route-level idempotency check without reaching persistence');
      assert.equal((await missingIdempotency.json()).code, 'GENIEPROOF_IDEMPOTENCY_KEY_REQUIRED');
    }));
  } finally {
    if (oldSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldSecret;
  }
});

test('deferred advisory success contract requires exact allocation provenance', () => {
  const operation = contractOperations().find(entry => operationKey(entry) === 'POST /api/recommend/{recommendationId}/advisory')?.operation;
  assert.ok(operation);
  const response = resolveLocalRef(operation.responses['200'].$ref);
  const schema = resolveLocalRef(response.content['application/json'].schema.$ref);
  assert.ok(['recommendationId', 'allocation_revision', 'allocation_revision_id', 'portfolio_fingerprint', 'advisory_text', 'advisory_explanation']
    .every(field => schema.required.includes(field)));
  const explanation = schema.properties.advisory_explanation;
  assert.ok(['recommendationId', 'allocation_revision', 'allocation_revision_id', 'portfolio_fingerprint']
    .every(field => explanation.required.includes(field)));
});

test('all authoritative recommendation mutations and reads require the canonical current-state schema', () => {
  const operations = new Map(contractOperations().map((entry) => [operationKey(entry), entry.operation]));
  const canonicalFields = [
    'recommendationId',
    'allocation_revision',
    'allocation_revision_id',
    'portfolio_fingerprint',
    'calculation_freshness',
    'state_provenance',
  ];
  for (const key of [
    'POST /api/recommend',
    'GET /api/recommend/current',
    'POST /api/recommend/weights',
  ]) {
    const responseRef = operations.get(key)?.responses?.['200']?.$ref;
    assert.ok(responseRef, `${key} must document its successful response`);
    const response = resolveLocalRef(responseRef);
    const schemaRef = response.content?.['application/json']?.schema?.$ref;
    assert.ok(schemaRef, `${key} must reference a response schema`);
    const schema = resolveLocalRef(schemaRef);
    assert.ok(canonicalFields.every(field => schema.required.includes(field)), `${key} must require the complete binding`);
    assert.equal(schema.properties.response_state.const, 'CURRENT');
  }
});

test('profile completion nests the same strict authoritative recommendation schema', () => {
  const response = resolveLocalRef(contract.paths['/api/profile/complete'].post.responses['200'].$ref);
  const schema = resolveLocalRef(response.content['application/json'].schema.$ref);
  const nestedRef = schema.properties.recommendation.$ref;
  assert.equal(nestedRef, '#/components/schemas/RecommendationResponse');
  const recommendation = resolveLocalRef(nestedRef);
  assert.ok([
    'recommendationId', 'allocation_revision', 'allocation_revision_id',
    'portfolio_fingerprint', 'calculation_freshness', 'state_provenance',
  ].every(field => recommendation.required.includes(field)));
});

test('committed superseded operations document their result separately from current financial state', () => {
  const recommendationOperation = contract.paths['/api/recommend'].post;
  assert.ok(recommendationOperation.responses['503'], 'post-commit reconciliation integrity failure uses a documented service-unavailable response');
  const recommendationResponse = resolveLocalRef('#/components/schemas/RecommendationResponse');
  assert.equal(recommendationResponse.properties.operation_result.$ref, '#/components/schemas/CommittedOperationResult');
  const completionResponse = resolveLocalRef('#/components/schemas/ProfileCompletion');
  assert.equal(completionResponse.properties.operation_result.$ref, '#/components/schemas/CommittedOperationResult');

  const operationResult = resolveLocalRef('#/components/schemas/CommittedOperationResult');
  assert.equal(operationResult.oneOf.length, 2);
  const recommendationResult = operationResult.oneOf.find(schema => schema.required.includes('generated_recommendation_id')
    && !schema.required.includes('generated_allocation_revision'));
  const allocationResult = operationResult.oneOf.find(schema => schema.required.includes('generated_allocation_revision'));
  assert.deepEqual(recommendationResult.required, ['committed', 'generated_recommendation_id', 'superseded_before_response']);
  assert.equal(recommendationResult.properties.committed.const, true);
  assert.equal(recommendationResult.properties.superseded_before_response.const, true);
  assert.deepEqual(allocationResult.required, ['committed', 'generated_recommendation_id', 'generated_allocation_revision', 'generated_allocation_revision_id', 'superseded_before_response']);
  assert.equal(allocationResult.properties.superseded_before_response.type, 'boolean');
});
