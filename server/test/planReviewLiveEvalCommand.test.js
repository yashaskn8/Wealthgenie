import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runLivePlanReviewEvaluations, selectLivePlanReviewCases } from '../agents/evals/livePlanReviewEvals.js';
import { loadPlanReviewDataset } from '../agents/evals/planReviewEvals.js';
import { runIsolatedPlanReviewCase } from '../agents/evals/isolatedPlanReviewRunner.js';
import { estimatePlanReviewInputTokens } from '../agents/planReview/planReviewTokenBudget.js';

function createLiveEvalCase(overrides = {}) {
  return {
    id: 'synthetic-plan-review',
    profile: 'fixtures/profile-current.json',
    expectedTools: [],
    forbiddenTools: [],
    expectedAction: 'NONE',
    requiredReasonCodes: [],
    maxSteps: 6,
    maxToolCalls: 8,
    groundingRequired: true,
    liveModelRequired: false,
    ...overrides,
  };
}

function createActualResult(overrides = {}) {
  return {
    result: {
      review: {
        recommendedAction: 'NONE',
        freshness: { reasonCodes: [] },
        evidence: { status: 'AVAILABLE' },
      },
      validation: { valid: true },
      evidenceVerification: { valid: true },
      explanation: { validation: { status: 'PASS' } },
      policy: { allowed: true },
      stepCount: 0,
      toolCallCount: 0,
      planner: { checks: [] },
    },
    trajectory: [],
    latencyMs: 2,
    providerUsage: {
      provider: 'fixture-provider',
      model: 'fixture-model',
      providerCalls: 0,
      tokensUsed: 0,
      tokenUsageAvailable: true,
      plannerFallback: false,
      explanationFallback: false,
    },
    ...overrides,
  };
}

function createFixtureProvider({ plannerTokens = 10, explanationTokens = 15, name = 'fixture-provider', onGenerate = null } = {}) {
  return {
    name,
    configuredModel: () => 'fixture-model',
    isConfigured: () => true,
    async generate(args) {
      onGenerate?.(args);
      if (args.systemPrompt.includes('bounded routing planner')) {
        return {
          text: '{"checks":["get_current_profile_context"]}',
          tokensUsed: plannerTokens,
          provider: 'fixture-provider',
          model: 'fixture-model',
        };
      }
      const summary = 'The current recommendation matches the current profile and regulatory policy [E_RECOMMENDATION_FRESHNESS].';
      return {
        text: JSON.stringify({
          text: summary,
          evidenceIdsUsed: ['E_RECOMMENDATION_FRESHNESS'],
          claims: [{
            text: summary,
            evidenceIds: ['E_RECOMMENDATION_FRESHNESS'],
          }],
          financialClaims: [],
          unavailableFacts: [],
        }),
        tokensUsed: explanationTokens,
        provider: 'fixture-provider',
        model: 'fixture-model',
      };
    },
  };
}

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('live PlanReview evaluation rejects a missing isolated graph runner before any provider call', async () => {
  await assert.rejects(
    runLivePlanReviewEvaluations({ dataset: [createLiveEvalCase()] }),
    error => error.code === 'LIVE_EVAL_RUNNER_REQUIRED',
  );
});

test('targeted live case selection is exact and rejects missing or duplicate identifiers', () => {
  const target = createLiveEvalCase({ id: 'fresh-read-only-plan' });
  const other = createLiveEvalCase({ id: 'missing-recommendation' });
  const dataset = [target, other];
  assert.strictEqual(selectLivePlanReviewCases(dataset), dataset, 'default evaluation selection remains unchanged');
  assert.deepEqual(selectLivePlanReviewCases(dataset, 'fresh-read-only-plan'), [target]);
  assert.throws(() => selectLivePlanReviewCases(dataset, 'unknown-case'), error => error.code === 'LIVE_EVAL_CASE_NOT_FOUND');
  assert.throws(() => selectLivePlanReviewCases([target, target], 'fresh-read-only-plan'), error => error.code === 'LIVE_EVAL_CASE_NOT_FOUND');
});

test('live evaluation surfaces only a bounded reasoning-token count from provider diagnostics', async () => {
  const report = await runLivePlanReviewEvaluations({
    dataset: [createLiveEvalCase()],
    runner: async () => createActualResult({
      providerUsage: {
        provider: 'fixture-provider', model: 'fixture-model', providerCalls: 0,
        tokensUsed: 0, tokenUsageAvailable: true, plannerFallback: false, explanationFallback: false,
        attempts: [
          { diagnostics: { providerCompletionTokens: 45, providerReasoningTokens: 12 } },
          { diagnostics: { providerCompletionTokens: 45, providerReasoningTokens: 46 } },
        ],
      },
    }),
  });

  assert.equal(report.passed, true);
  assert.equal(report.cases[0].providerAttempts[0].completionTokens, 45);
  assert.equal(report.cases[0].providerAttempts[0].reasoningTokens, 12);
  assert.equal(report.cases[0].providerAttempts[1].reasoningTokens, null, 'reasoning subtotals cannot exceed provider completion usage');
});

test('explicit live-eval CLI request fails closed before provider calls when no key is configured', () => {
  const scriptPath = path.join(serverRoot, 'scripts', 'run-live-plan-review-evals.js');
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: serverRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      RUN_AGENT_LIVE_EVALS: 'true',
      LLM_PRIMARY_PROVIDER: 'GROQ',
      NVIDIA_API_KEY: '',
      GROQ_API_KEY: '',
      GEMINI_API_KEY: '',
    },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /LIVE_EVAL_PROVIDER_NOT_CONFIGURED/);
  assert.doesNotMatch(result.stderr, /NVIDIA_API_KEY|Bearer|token/i);
});

test('live evaluator executes one actual isolated PlanReview graph and scores its real trajectory', async () => {
  const dataset = await loadPlanReviewDataset();
  const freshCase = dataset.find(item => item.id === 'fresh-read-only-plan');
  const providerCalls = [];
  const report = await runLivePlanReviewEvaluations({
    dataset: [{ ...freshCase, liveModelRequired: true }],
    runner: ({ caseDefinition }) => runIsolatedPlanReviewCase({
      caseDefinition,
      provider: createFixtureProvider({ name: 'groq', onGenerate: args => providerCalls.push(args) }),
    }),
  });

  assert.equal(report.passed, true);
  assert.equal(report.cases[0].finalAction, 'NONE');
  assert.equal(report.cases[0].providerCalls, 2);
  assert.equal(report.cases[0].tokens, 25);
  assert.deepEqual(report.cases[0].modelsUsed, ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b']);
  assert.deepEqual(report.cases[0].providerAttempts.map(attempt => attempt.role), ['PLANNER', 'EXPLAINER']);
  assert.deepEqual(report.cases[0].providerAttempts.map(attempt => attempt.model), ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b']);
  assert.deepEqual(report.cases[0].executedTools, freshCase.expectedTools);
  assert.equal(report.cases[0].caseScorecard.passed, true);
  assert.equal(providerCalls.length, 2);
  assert.equal(providerCalls[0].outputContract, 'PLAN_REVIEW_PLANNER_V1');
  assert.equal(providerCalls[0].planReviewRole, 'PLANNER');
  assert.equal(Object.hasOwn(providerCalls[0], 'providerOutputMode'), false);
  assert.equal(providerCalls[1].outputContract, 'GROUNDED_EXPLANATION_V1');
  assert.equal(providerCalls[1].planReviewRole, 'EXPLAINER');
  assert.equal(providerCalls[1].providerOutputMode, 'GROQ_JSON_OBJECT');
  assert.equal(providerCalls[1].maxTokens, 512, 'the live explanation retains its fixed output ceiling');
  assert.match(providerCalls[1].systemPrompt, /JSON keys \(all required\): text:s, evidenceIdsUsed:s\[\], claims:/);
  assert.match(providerCalls[1].systemPrompt, /effectivePeriod:null\|\{from:s,to:s\|null\}/);
  const explanationUserText = providerCalls[1].recentHistory[0].parts[0].text;
  const explanationInputBytes = Buffer.byteLength(`${providerCalls[1].systemPrompt}\nuser\n${explanationUserText}`, 'utf8');
  const reservedExplanationInput = estimatePlanReviewInputTokens(explanationInputBytes);
  assert.ok(reservedExplanationInput + 512 + 461 <= 2300,
    `optimized prompt reservation should leave >=200 tokens of case headroom (reserved=${reservedExplanationInput})`);
  const modelEvidence = JSON.parse(explanationUserText).EVIDENCE_PACKET;
  const restoredEntries = modelEvidence.entries.map(row => Object.fromEntries(
    modelEvidence.entryFields.map((field, index) => [field, row[index]]),
  ));
  const requiredEntryIds = [
    'E_RECOMMENDATION_FRESHNESS', 'E_REGULATORY_NOTICE',
  ];
  assert.ok(requiredEntryIds.every(id => restoredEntries.some(entry => entry.id === id)),
    'plan review sends only the decision evidence and regulatory notice needed for the review');
  const freshnessEntry = restoredEntries.find(entry => entry.id === 'E_RECOMMENDATION_FRESHNESS');
  assert.deepEqual(Object.keys(freshnessEntry.value).sort(), ['fresh', 'reasonCodes']);
  assert.doesNotMatch(explanationUserText, /observedProfileHash|expectedProfileHash|profileInputHash/,
    'profile-derived hashes are not disclosed to the external explanation provider');
  assert.ok(!restoredEntries.some(entry => ['E_PROFILE_AGE', 'E_PROFILE_SAVINGS', 'E_PROFILE_GOALS', 'E_SUITABILITY_REASONS'].includes(entry.id)),
    'raw profile attributes are not sent in the Plan Review evidence packet');
});

test('offline evaluator runs every real graph fixture without a provider or persistence', () => {
  const scriptPath = path.join(serverRoot, 'scripts', 'run-eval.js');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wealthgenie-offline-eval-'));
  const tracePath = path.join(tempDir, 'traces.jsonl');
  try {
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: serverRoot,
      encoding: 'utf8',
      env: { ...process.env, TRACE_LOG_PATH: tracePath },
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout.trim());
    assert.equal(report.mode, 'DETERMINISTIC_SYNTHETIC_PRODUCTION_GRAPH');
    assert.equal(report.persisted, false);
    assert.equal(report.externalProviderCalls, 0);
    assert.equal(report.summary.cases, 3);
    assert.ok(report.cases.every(item => item.passed));
    assert.doesNotMatch(result.stdout, /64b0000000000000000000/);
    assert.equal(fs.existsSync(tracePath), false, 'isolated runs must not emit to the filesystem-backed trace exporter');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('live evaluation rejects an expected-action mismatch from the actual graph result', async () => {
  await assert.rejects(
    runLivePlanReviewEvaluations({
      dataset: [createLiveEvalCase({ expectedAction: 'REVIEW_PROFILE' })],
      runner: async () => createActualResult(),
    }),
    error => error.code === 'LIVE_EVAL_GATE_FAILED'
      && error.caseFailures[0].scorecard.action === false,
  );
});

test('live evaluation rejects forbidden tool attempts present in the actual trajectory', async () => {
  await assert.rejects(
    runLivePlanReviewEvaluations({
      dataset: [createLiveEvalCase({ forbiddenTools: ['execute_trade'] })],
      runner: async () => createActualResult({
        trajectory: [{ type: 'TOOL_SELECTED', tool: 'execute_trade' }],
      }),
    }),
    error => error.code === 'LIVE_EVAL_GATE_FAILED'
      && error.aggregate.forbiddenToolRate === 1,
  );
});

test('live evaluation rejects ungrounded and invalid claim-validation results', async () => {
  await assert.rejects(
    runLivePlanReviewEvaluations({
      dataset: [createLiveEvalCase()],
      runner: async () => createActualResult({
        result: {
          ...createActualResult().result,
          review: { ...createActualResult().result.review, evidence: { status: 'UNAVAILABLE' } },
          validation: { valid: false },
        },
      }),
    }),
    error => error.code === 'LIVE_EVAL_GATE_FAILED'
      && error.aggregate.groundingFailureRate === 1
      && error.aggregate.unsupportedNumericalClaimRate === 1,
  );
});

test('live evaluation rejects an empty dataset instead of passing zero-valued rates', async () => {
  await assert.rejects(
    runLivePlanReviewEvaluations({ dataset: [], runner: async () => createActualResult() }),
    error => error.code === 'LIVE_EVAL_DATASET_EMPTY',
  );
});

test('live evaluation rejects datasets that would be silently truncated', async () => {
  await assert.rejects(
    runLivePlanReviewEvaluations({
      dataset: [createLiveEvalCase(), createLiveEvalCase({ id: 'case-2' }), createLiveEvalCase({ id: 'case-3' }), createLiveEvalCase({ id: 'case-4' })],
      runner: async () => createActualResult(),
    }),
    error => error.code === 'LIVE_EVAL_CASE_LIMIT_EXCEEDED'
      && error.datasetCaseCount === 4
      && error.caseLimit === 3,
  );
});

test('actual PlanReview graph enforces aggregate model token budget before an over-budget second call', async () => {
  const dataset = await loadPlanReviewDataset();
  const freshCase = dataset.find(item => item.id === 'fresh-read-only-plan');
  const provider = createFixtureProvider({ plannerTokens: 1400, explanationTokens: 1400 });
  let providerCalls = 0;
  const generate = provider.generate;
  provider.generate = async args => {
    providerCalls += 1;
    return generate(args);
  };
  await assert.rejects(
    runIsolatedPlanReviewCase({ caseDefinition: freshCase, provider }),
    error => error.code === 'AGENT_BUDGET_EXCEEDED' && error.reason === 'TOTAL_TOKENS',
  );
  assert.equal(providerCalls, 1, 'the graph must reject before the second provider request');
});

test('live evaluation rejects reported provider usage above the per-case token budget', async () => {
  await assert.rejects(
    runLivePlanReviewEvaluations({
      dataset: [createLiveEvalCase()],
      runner: async () => createActualResult({ providerUsage: { tokensUsed: 2501, tokenUsageAvailable: true } }),
    }),
    error => error.code === 'LIVE_EVAL_GATE_FAILED'
      && error.cases[0].tokens === 2501
      && error.cases[0].withinTokenBudget === false
      && error.cases[0].errorClassification === 'LIVE_EVAL_TOKEN_BUDGET_EXCEEDED',
  );
});

test('live-model-required cases fail when provider call accounting is missing', async () => {
  await assert.rejects(
    runLivePlanReviewEvaluations({
      dataset: [createLiveEvalCase({ liveModelRequired: true })],
      runner: async () => createActualResult({
        providerUsage: { ...createActualResult().providerUsage, providerCalls: undefined },
      }),
    }),
    error => error.code === 'LIVE_EVAL_GATE_FAILED'
      && error.aggregate.providerExecutionFailureRate === 1
      && error.cases[0].providerCallBudgetCompliant === false,
  );
});

test('live evaluation records sanitized failures and continues through every supplied case', async () => {
  const cases = [
    createLiveEvalCase({ id: 'first', liveModelRequired: true }),
    createLiveEvalCase({ id: 'second' }),
    createLiveEvalCase({ id: 'third' }),
  ];
  let calls = 0;
  await assert.rejects(
    runLivePlanReviewEvaluations({
      dataset: cases,
      runner: async () => {
        calls += 1;
        if (calls === 1) {
          const error = Object.assign(new Error('do not serialize this'), { code: 'EVOLUTION_PLANNER_REQUIRED' });
          error.livePlanReviewEvidence = {
            latencyMs: 9,
            providerUsage: {
              provider: 'groq',
              model: 'openai/gpt-oss-120b',
              providerCalls: 1,
              tokensUsed: 8,
              tokenUsageAvailable: true,
              attempts: [{ diagnostics: {
                configuredModel: 'openai/gpt-oss-120b',
                endpointHostname: 'api.groq.com',
                httpStatus: 200,
                latencyMs: 4,
                completionReason: 'stop',
                providerReportedTokens: 8,
                jsonSyntaxValid: false,
                jsonSchemaValid: null,
                financialGroundingValid: null,
                groundingReasonCodes: ['UNSUPPORTED_FINANCIAL_NUMBER', 'PRIVATE_PROFILE_VALUE', 'raw candidate narrative'],
                errorClassification: 'MALFORMED_PLANNER_JSON',
                rawResponse: 'never expose this secret',
              } }],
            },
          };
          throw error;
        }
        return createActualResult();
      },
    }),
    error => {
      assert.equal(error.code, 'LIVE_EVAL_GATE_FAILED');
      assert.equal(calls, 3);
      assert.deepEqual(error.caseCounts, { executed: 3, passed: 2, failed: 1, notEvaluated: 0 });
      assert.equal(error.cases[0].errorClassification, 'EVOLUTION_PLANNER_REQUIRED');
      assert.equal(error.cases[0].providerAttempts[0].errorClassification, 'MALFORMED_PLANNER_JSON');
      assert.deepEqual(error.cases[0].providerAttempts[0].groundingReasonCodes, ['UNSUPPORTED_FINANCIAL_NUMBER']);
      assert.equal(error.cases[0].providerAttempts[0].endpointHostname, 'api.groq.com');
      assert.equal(JSON.stringify(error.cases).includes('never expose this secret'), false);
      assert.equal(JSON.stringify(error.cases).includes('do not serialize this'), false);
      assert.equal(JSON.stringify(error.cases).includes('PRIVATE_PROFILE_VALUE'), false);
      assert.equal(JSON.stringify(error.cases).includes('raw candidate narrative'), false);
      return true;
    },
  );
});

test('isolated live evaluation exposes only allowlisted financial-grounding rejection codes', async () => {
  const dataset = await loadPlanReviewDataset();
  const freshCase = dataset.find(item => item.id === 'fresh-read-only-plan');
  let diagnostics = null;
  const provider = {
    name: 'groq',
    configuredModel: () => 'openai/gpt-oss-120b',
    isConfigured: () => true,
    get lastResponseDiagnostics() { return diagnostics; },
    recordOutputValidation(details) { if (diagnostics) Object.assign(diagnostics, details); },
    async generate(args) {
      diagnostics = {
        provider: 'groq', configuredModel: 'openai/gpt-oss-120b', returnedModel: 'openai/gpt-oss-120b',
        endpointHostname: 'api.groq.com', httpStatus: 200, latencyMs: 3, completionReason: 'stop',
        providerReportedTokens: 10, providerPromptTokens: 7, providerCompletionTokens: 3,
      };
      if (args.outputContract === 'PLAN_REVIEW_PLANNER_V1') {
        return {
          text: '{"checks":["get_current_profile_context"]}', tokensUsed: 10,
          provider: 'groq', model: 'openai/gpt-oss-120b', wasCompleted: true,
        };
      }
      const text = 'The recommendation has a 999999% annual rate [E_RECOMMENDATION_FRESHNESS].';
      return {
        text: JSON.stringify({
          text,
          evidenceIdsUsed: ['E_RECOMMENDATION_FRESHNESS'],
          claims: [{ text, evidenceIds: ['E_RECOMMENDATION_FRESHNESS'] }],
          financialClaims: [],
          unavailableFacts: [],
        }),
        tokensUsed: 10, provider: 'groq', model: 'openai/gpt-oss-120b', wasCompleted: true,
      };
    },
  };

  await assert.rejects(
    runLivePlanReviewEvaluations({
      dataset: [{ ...freshCase, liveModelRequired: true }],
      runner: ({ caseDefinition }) => runIsolatedPlanReviewCase({ caseDefinition, provider }),
    }),
    error => {
      const attempts = error.cases[0].providerAttempts;
      assert.equal(attempts.length, 2);
      assert.equal(attempts[1].financialGroundingValid, false);
      assert.ok(attempts[1].groundingReasonCodes.includes('UNSUPPORTED_FINANCIAL_NUMBER'));
      assert.ok(attempts[1].groundingReasonCodes.includes('UNBOUND_FINANCIAL_NUMBER'));
      assert.equal(JSON.stringify(attempts).includes('999999'), false);
      assert.equal(JSON.stringify(attempts).includes('annual rate'), false);
      return error.code === 'LIVE_EVAL_GATE_FAILED';
    },
  );
});

test('isolated live failure reports endpoint classification and unknown token usage without printing response data', async () => {
  const dataset = await loadPlanReviewDataset();
  const freshCase = dataset.find(item => item.id === 'fresh-read-only-plan');
  let providerCalls = 0;
  const provider = {
    name: 'groq',
    configuredModel: () => 'openai/gpt-oss-120b',
    isConfigured: () => true,
    lastFailureReason: 'PROVIDER_NETWORK_ERROR',
    lastResponseDiagnostics: {
      provider: 'groq',
      configuredModel: 'openai/gpt-oss-120b',
      returnedModel: null,
      endpointHostname: 'api.groq.com',
      httpStatus: null,
      latencyMs: 15,
      completionReason: null,
      providerReportedTokens: null,
      effectiveOutputTokenCeiling: 240,
      errorClassification: 'PROVIDER_NETWORK_ERROR',
    },
    async generate() {
      providerCalls += 1;
      throw Object.assign(new Error('sensitive provider response body'), { code: 'PROVIDER_NETWORK_ERROR' });
    },
  };
  await assert.rejects(
    runLivePlanReviewEvaluations({
      dataset: [{ ...freshCase, liveModelRequired: true }],
      runner: ({ caseDefinition }) => runIsolatedPlanReviewCase({ caseDefinition, provider }),
    }),
    error => {
      const item = error.cases[0];
      assert.equal(providerCalls, 1);
      assert.equal(item.providerCalls, 1);
      assert.equal(item.tokenUsageAvailable, false);
      assert.equal(item.tokens, null);
      assert.equal(error.reportedTokensComplete, false);
      assert.equal(item.providerAttempts[0].model, 'openai/gpt-oss-120b');
      assert.equal(item.providerAttempts[0].endpointHostname, 'api.groq.com');
      assert.equal(item.providerAttempts[0].errorClassification, 'PROVIDER_NETWORK_ERROR');
      assert.equal(JSON.stringify(error.cases).includes('sensitive provider response body'), false);
      return error.code === 'LIVE_EVAL_GATE_FAILED';
    },
  );
});

test('live evidence preserves known partial tokens and sanitized HTTP failure details', async () => {
  const dataset = await loadPlanReviewDataset();
  const freshCase = dataset.find(item => item.id === 'fresh-read-only-plan');
  let lastFailureReason = null;
  let lastResponseDiagnostics = null;
  const provider = {
    name: 'groq',
    configuredModel: () => 'openai/gpt-oss-120b',
    isConfigured: () => true,
    get lastFailureReason() { return lastFailureReason; },
    get lastResponseDiagnostics() { return lastResponseDiagnostics; },
    async generate(args) {
      if (args.outputContract === 'PLAN_REVIEW_PLANNER_V1') {
        lastFailureReason = null;
        lastResponseDiagnostics = {
          provider: 'groq', configuredModel: 'openai/gpt-oss-120b', returnedModel: 'openai/gpt-oss-120b',
          endpointHostname: 'api.groq.com', httpStatus: 200, latencyMs: 5, completionReason: 'stop',
          outputBytes: 42, providerRequestId: 'req_plan-001', providerPromptTokens: 3,
          providerCompletionTokens: 1, providerReportedTokens: 4, effectiveOutputTokenCeiling: 240,
        };
        return {
          text: '{"checks":["get_current_profile_context"]}', tokensUsed: 4,
          provider: 'groq', model: 'openai/gpt-oss-120b', wasCompleted: true,
        };
      }
      lastFailureReason = 'PROVIDER_BAD_REQUEST';
      lastResponseDiagnostics = {
        provider: 'groq', configuredModel: 'openai/gpt-oss-120b', returnedModel: null,
        endpointHostname: 'api.groq.com', httpStatus: 400, latencyMs: 7, completionReason: null,
        outputBytes: 0, providerRequestId: 'req_error-002', providerPromptTokens: null,
        providerCompletionTokens: null, providerReportedTokens: null, effectiveOutputTokenCeiling: 512,
        responseFormatMode: 'json_object', strictSchema: false, schemaName: null,
        reasoningEffort: 'low', reasoningFormat: null, reasoningIncluded: false,
        errorClassification: 'PROVIDER_BAD_REQUEST', providerErrorCode: 'JSON_VALIDATE_FAILED',
      };
      return null;
    },
  };
  await assert.rejects(
    runLivePlanReviewEvaluations({
      dataset: [{ ...freshCase, liveModelRequired: true }],
      runner: ({ caseDefinition }) => runIsolatedPlanReviewCase({ caseDefinition, provider }),
    }),
    error => {
      const item = error.cases[0];
      assert.equal(error.totalProviderCalls, 2);
      assert.equal(error.totalReportedTokens, 4);
      assert.equal(error.reportedTokensComplete, false);
      assert.equal(item.tokens, 4);
      assert.equal(item.tokenUsageComplete, false);
      assert.equal(item.providerAttempts[1].httpStatus, 400);
      assert.equal(item.providerAttempts[1].providerErrorCode, 'JSON_VALIDATE_FAILED');
      assert.equal(item.providerAttempts[1].endpointHostname, 'api.groq.com');
      assert.equal(item.providerAttempts[1].responseFormatMode, 'json_object');
      assert.equal(item.providerAttempts[1].strictSchema, false);
      assert.equal(item.providerAttempts[1].reasoningEffort, 'low');
      assert.equal(item.providerAttempts[1].reasoningFormat, null);
      assert.equal(item.providerAttempts[1].reasoningIncluded, false);
      assert.equal(item.providerAttempts[0].providerRequestId, 'req_plan-001');
      assert.equal(item.providerAttempts[0].promptTokens, 3);
      assert.equal(item.providerAttempts[0].completionTokens, 1);
      assert.equal(item.providerAttempts[0].reportedTokens, 4);
      assert.equal(item.providerAttempts[1].providerRequestId, 'req_error-002');
      assert.equal(item.providerAttempts[1].promptTokens, null);
      return error.code === 'LIVE_EVAL_GATE_FAILED';
    },
  );
});

test('live-model-required cases fail when actual graph execution falls back', async () => {
  const caseDefinition = createLiveEvalCase({ liveModelRequired: true });
  await assert.rejects(
    runLivePlanReviewEvaluations({
      dataset: [caseDefinition],
      runner: async () => createActualResult({
        providerUsage: {
          ...createActualResult().providerUsage,
          providerCalls: 1,
          tokensUsed: 10,
          plannerFallback: true,
        },
      }),
    }),
    error => error.code === 'LIVE_EVAL_GATE_FAILED'
      && error.aggregate.providerExecutionFailureRate === 1,
  );
});

test('live evaluation rejects provider-call budget violations and calls for the cross-user case', async () => {
  const liveCase = createLiveEvalCase({ liveModelRequired: true });
  await assert.rejects(
    runLivePlanReviewEvaluations({
      dataset: [liveCase],
      runner: async () => createActualResult({
        providerUsage: {
          ...createActualResult().providerUsage,
          providerCalls: 3,
          tokensUsed: 30,
          plannerFallback: false,
          explanationFallback: false,
        },
      }),
    }),
    error => error.code === 'LIVE_EVAL_GATE_FAILED'
      && error.cases[0].providerCallBudgetCompliant === false
      && error.aggregate.providerExecutionFailureRate === 1,
  );

  await assert.rejects(
    runLivePlanReviewEvaluations({
      dataset: [createLiveEvalCase({ liveModelRequired: false })],
      runner: async () => createActualResult({
        providerUsage: { ...createActualResult().providerUsage, providerCalls: 1 },
      }),
    }),
    error => error.code === 'LIVE_EVAL_GATE_FAILED'
      && error.cases[0].unexpectedProviderExecution === true,
  );
});
