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
import chatRoutes from '../routes/chatRoutes.js';
import recommendRoutes from '../routes/recommend.js';
import goalsRoutes from '../routes/goals.js';
import marketRoutes from '../routes/market.js';
import marketQuotesRoutes from '../routes/marketQuotes.js';
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
import { buildRecommendationProfile, toProfilePersistence } from '../services/recommendationProfile.js';
import { assessSuitabilityRisk } from '../services/riskProfiler.js';
import { runOpenApiHttpCase } from './helpers/openapiRuntimeContract.js';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appSource = fs.readFileSync(path.join(serverRoot, 'app.js'), 'utf8');
const contract = parse(fs.readFileSync(path.join(serverRoot, 'openapi.yaml'), 'utf8'));
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

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

// Only externally supported route modules belong in the public contract.
// metricsRoutes and mcpRoutes are deliberately private operational protocols.
const publicMounts = [
  ['auth.js', '/api/auth'],
  ['profile.js', '/api/profile'],
  ['recommend.js', '/api/recommend'],
  ['agentRoutes.js', '/api/agent'],
  ['genieProofRoutes.js', '/api/genieproof'],
  ['instruments.js', '/api/instruments'],
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
      authenticated: /\b(?:verifyJWT|verifyJWTWithRevocationAvailability|authenticate)\b/.test(declaration.slice(0, 300)),
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

function buildContractTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  app.use('/api/profile', profileRoutes);
  app.use('/api/tax', taxRoutes);
  app.use('/api/instruments', instrumentRoutes);
  app.use('/api/chat', chatRoutes);
  app.use('/api/recommend', recommendRoutes);
  app.use('/api/market', marketRoutes);
  app.use('/api/market-data', marketQuotesRoutes);
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
  { operation: 'GET /api/tax/compare', method: 'GET', path: '/api/tax/compare', url: '/api/tax/compare?income=1200000&incomeSource=salary&fiscalYear=FY2026-27&age=30', expectedStatus: 200 },
  { operation: 'GET /api/tax/compute', method: 'GET', path: '/api/tax/compute', url: '/api/tax/compute?income=1200000&incomeSource=salary&fiscalYear=FY2026-27&age=30&regime=new', expectedStatus: 200 },
  { operation: 'GET /api/tax/policies', method: 'GET', path: '/api/tax/policies', url: '/api/tax/policies', expectedStatus: 200 },
  { operation: 'POST /api/tax/post-tax-scenario', method: 'POST', path: '/api/tax/post-tax-scenario', url: '/api/tax/post-tax-scenario', expectedStatus: 200, body: { canonicalInstrumentId: 'sbi_fd', scenarioType: 'INTEREST_INCOME', interestReceived: 2500, annualGrossIncome: 1000000, incomeSource: 'salary', regime: 'new', fiscalYear: 'FY2026-27', userAge: 35 } },
  { operation: 'GET /api/instruments', method: 'GET', path: '/api/instruments', url: '/api/instruments?page=1&limit=10', expectedStatus: 200 },
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
  { operation: 'POST /api/montecarlo/montecarlo', method: 'POST', path: '/api/montecarlo/montecarlo', url: '/api/montecarlo/montecarlo', expectedStatus: 200, body: { profileId: '65b000000000000000000002', instrument: 'FD', monthly_investment: 5000, years: 2 } },
  { operation: 'POST /api/montecarlo/portfolio', method: 'POST', path: '/api/montecarlo/portfolio', url: '/api/montecarlo/portfolio', expectedStatus: 200, body: { profileId: '65b000000000000000000002', allocations: { FD: 1 }, years: 2 } },
  { operation: 'GET /api/tax/compare', method: 'GET', path: '/api/tax/compare', url: '/api/tax/compare?income=bad&incomeSource=salary&fiscalYear=FY2026-27&age=30', expectedStatus: 400 },
  { operation: 'GET /api/tax/compare', method: 'GET', path: '/api/tax/compare', url: '/api/tax/compare?income=1200000&incomeSource=salary&fiscalYear=FY2099-00&age=30', expectedStatus: 422 },
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
  'GET /api/tax/compare': { file: 'openapiContract.test.js', anchor: 'GET /api/tax/compare' },
  'GET /api/tax/compute': { file: 'openapiContract.test.js', anchor: 'GET /api/tax/compute' },
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
}).concat(extractRoutes(appSource, 'app'));

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
  ]);
  const operations = new Map(contractOperations().map((entry) => [operationKey(entry), entry.operation]));

  for (const [key, requiredFields] of expected) {
    const schema = requestSchema(operations.get(key));
    assert.ok(schema, `${key} has no JSON request schema`);
    assert.deepEqual(new Set(schema.required ?? []), new Set(requiredFields), `${key} required fields drifted`);
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
    await withServer(buildContractTestApp(), async baseUrl => {
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
    });
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
  app.locals.genieProofRuntime = { enabled: true };
  const userId = '65b000000000000000000001';
  const token = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const url = '/api/genieproof/cases/00000000-0000-4000-8000-000000000001/watch';

  try {
    await withServer(app, async baseUrl => {
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
    });
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
