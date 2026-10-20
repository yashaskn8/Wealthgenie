import assert from 'node:assert/strict';
import test from 'node:test';
import { createModelGateway } from '../agents/modelGateway.js';
import {
  createBudgetedPlanReviewProvider,
  createPlanReviewTokenBudget,
  estimatePlanReviewInputTokens,
} from '../agents/planReview/planReviewTokenBudget.js';

test('PlanReview reserves input and output before provider execution and rejects oversized input', async () => {
  const budget = createPlanReviewTokenBudget({ maxInputTokens: 16, maxOutputTokens: 8, maxTotalTokens: 24 });
  let called = 0;
  const provider = createBudgetedPlanReviewProvider({
    async generate(args) { called += 1; assert.equal(args.maxTokens, 8); return { text: 'ok', tokensUsed: 12 }; },
  }, budget);
  await provider.generate({ systemPrompt: 'a'.repeat(32), recentHistory: [], maxTokens: 8 });
  assert.equal(budget.accountedTokens, 12);
  await assert.rejects(
    provider.generate({ systemPrompt: 'b'.repeat(100), maxTokens: 8 }),
    error => error.code === 'AGENT_BUDGET_EXCEEDED' && error.reason === 'INPUT_TOKENS',
  );
  assert.equal(called, 1, 'oversized input is rejected before provider execution');
});

test('budget estimates never replace provider-reported token usage', async () => {
  const budget = createPlanReviewTokenBudget({ maxInputTokens: 64, maxOutputTokens: 8, maxTotalTokens: 100 });
  const provider = createBudgetedPlanReviewProvider({
    async generate() { return { text: 'ok', tokensUsed: 1 }; },
  }, budget);
  const response = await provider.generate({ systemPrompt: 'a'.repeat(40), maxTokens: 8 });
  assert.equal(response.tokensUsed, 1, 'the exact provider usage survives even when lower than the input estimate');
  assert.ok(budget.accountedTokens > response.tokensUsed, 'internal budget accounting remains conservatively reserved');

  const missingUsageBudget = createPlanReviewTokenBudget({ maxInputTokens: 64, maxOutputTokens: 8, maxTotalTokens: 100 });
  const missingUsageProvider = createBudgetedPlanReviewProvider({
    async generate() { return { text: 'ok' }; },
  }, missingUsageBudget);
  const missingUsageResponse = await missingUsageProvider.generate({ systemPrompt: 'bounded', maxTokens: 8 });
  assert.equal(Object.hasOwn(missingUsageResponse, 'tokensUsed'), false, 'missing provider usage remains missing');
  assert.ok(missingUsageBudget.accountedTokens > 0, 'missing usage does not erase conservative run accounting');
});

test('calibrated reservation rejects the previously undercounted 1,542-token Groq prompt before a call', async () => {
  const historicalPromptBytes = 5735;
  const oldEstimate = Math.ceil(historicalPromptBytes / 4);
  const calibratedEstimate = estimatePlanReviewInputTokens(historicalPromptBytes);
  assert.equal(oldEstimate, 1434);
  assert.equal(calibratedEstimate, 1649);
  assert.ok(calibratedEstimate >= 1542, 'the calibrated reservation covers the observed provider prompt usage');

  const budget = createPlanReviewTokenBudget({
    maxInputTokens: 5000,
    maxOutputTokens: 512,
    maxTotalTokens: 2500,
    initialUsage: 461,
  });
  let called = false;
  const provider = createBudgetedPlanReviewProvider({
    async generate() { called = true; return { text: 'must not execute', tokensUsed: 1 }; },
  }, budget);

  await assert.rejects(provider.generate({
    systemPrompt: 's'.repeat(2098),
    recentHistory: 'u'.repeat(3636),
    maxTokens: 512,
  }), error => error.code === 'AGENT_BUDGET_EXCEEDED' && error.reason === 'TOTAL_TOKENS');
  assert.equal(called, false, 'the old prompt cannot enter the provider with a falsely safe reservation');
  assert.equal(budget.modelCalls, 0);
});

test('Groq token admission includes strict schema overhead while JSON Object Mode keeps its application gate', async () => {
  const makeBudget = () => createPlanReviewTokenBudget({
    maxInputTokens: 5000,
    maxOutputTokens: 512,
    maxTotalTokens: 2500,
    initialUsage: 522,
  });
  let strictCalls = 0;
  const strictProvider = createBudgetedPlanReviewProvider({
    name: 'groq',
    async generate() { strictCalls += 1; return { text: '{}', tokensUsed: 1 }; },
  }, makeBudget());
  await assert.rejects(strictProvider.generate({
    systemPrompt: 's'.repeat(4450),
    recentHistory: [],
    maxTokens: 512,
    jsonMode: true,
    outputContract: 'GROUNDED_EXPLANATION_V1',
  }), error => error.code === 'AGENT_BUDGET_EXCEEDED' && error.reason === 'TOTAL_TOKENS');
  assert.equal(strictCalls, 0, 'schema-bearing request must be rejected before inference when the case budget cannot reserve it');

  let objectCalls = 0;
  const objectProvider = createBudgetedPlanReviewProvider({
    name: 'groq',
    async generate(args) {
      objectCalls += 1;
      assert.equal(args.maxTokens, 512);
      return { text: '{}', tokensUsed: 10 };
    },
  }, makeBudget());
  await objectProvider.generate({
    systemPrompt: 's'.repeat(4450),
    recentHistory: [],
    maxTokens: 512,
    jsonMode: true,
    outputContract: 'GROUNDED_EXPLANATION_V1',
    providerOutputMode: 'GROQ_JSON_OBJECT',
  });
  assert.equal(objectCalls, 1, 'Object Mode remains subject to the unchanged application output/grounding validators');
});

test('model gateway reserves strict planner schema overhead before provider execution', async () => {
  const budget = createPlanReviewTokenBudget({
    maxInputTokens: 200,
    maxOutputTokens: 20,
    maxTotalTokens: 1000,
  });
  let providerCalls = 0;
  const gateway = createModelGateway({
    providers: [{
      name: 'groq',
      async generate() { providerCalls += 1; return { text: '{"checks":[]}', tokensUsed: 1 }; },
    }],
    maxOutputTokens: 20,
  });

  await assert.rejects(gateway.generate({
    role: 'PLANNER',
    systemPrompt: 'p'.repeat(500),
    recentHistory: [],
    maxTokens: 20,
    jsonMode: true,
    outputContract: 'PLAN_REVIEW_PLANNER_V1',
    requestBudget: budget,
  }), error => error.code === 'AGENT_BUDGET_EXCEEDED' && error.reason === 'INPUT_TOKENS');
  assert.equal(providerCalls, 0, 'the strict schema overhead is reserved before the provider request');
  assert.equal(budget.modelCalls, 0, 'a rejected reservation does not count as an inference call');
});

test('provider fallback attempts share one hard total-token budget', async () => {
  let secondProviderCalls = 0;
  const first = {
    name: 'groq',
    async generate() { this.lastFailureReason = 'PROVIDER_SERVER_ERROR'; return null; },
  };
  const second = {
    name: 'gemini',
    async generate() { secondProviderCalls += 1; return { text: 'must not run', tokensUsed: 1 }; },
  };
  const budget = createPlanReviewTokenBudget({
    maxInputTokens: 20, maxOutputTokens: 20, maxTotalTokens: 50, maxModelCalls: 5,
    onReserve: async () => undefined,
  });
  const gateway = createModelGateway({ providers: [first, second], maxOutputTokens: 20, allowGeminiFallback: true });
  await assert.rejects(
    gateway.generate({ role: 'PLANNER', systemPrompt: 'a'.repeat(40), recentHistory: [], maxTokens: 20, requestBudget: budget }),
    error => error.code === 'AGENT_BUDGET_EXCEEDED' && error.reason === 'TOTAL_TOKENS',
  );
  assert.equal(secondProviderCalls, 0, 'fallback cannot exceed the shared run budget');
  assert.equal(budget.accountedTokens, 32, 'failed provider attempt keeps its calibrated pre-reserved budget');
  assert.equal(budget.modelCalls, 1, 'only the provider actually entered is counted');
});

test('an unconfigured Groq primary fails closed without routing around its missing credential', async () => {
  let configuredCalls = 0;
  const unconfigured = {
    name: 'unconfigured',
    isConfigured: () => false,
    async generate() { throw new Error('must not be called'); },
  };
  const configured = {
    name: 'gemini',
    isConfigured: () => true,
    async generate() { configuredCalls += 1; return { text: 'ok', tokensUsed: 5, provider: 'gemini' }; },
  };
  const budget = createPlanReviewTokenBudget({ maxInputTokens: 64, maxOutputTokens: 8, maxTotalTokens: 100, maxModelCalls: 2 });
  unconfigured.name = 'groq';
  const gateway = createModelGateway({ providers: [unconfigured, configured], maxOutputTokens: 8, allowGeminiFallback: true });
  const result = await gateway.generate({ role: 'EXPLAINER', systemPrompt: 'safe', requestBudget: budget });
  assert.equal(result.text, null);
  assert.equal(result.fallback, false);
  assert.equal(configuredCalls, 0);
  assert.equal(budget.modelCalls, 0);
  assert.equal(budget.accountedTokens, 0);
});

test('model gateway forwards Groq JSON Object Mode only for grounded explanations', async () => {
  const seen = [];
  const groq = {
    name: 'groq',
    async generate(args) { seen.push({ provider: this.name, ...args }); return { text: '{}', tokensUsed: 1 }; },
  };
  const gemini = {
    name: 'gemini',
    async generate(args) { seen.push({ provider: this.name, ...args }); return { text: '{}', tokensUsed: 1 }; },
  };
  const run = async (provider, args) => createModelGateway({ providers: [provider], maxOutputTokens: 32 }).generate({
    systemPrompt: 'bounded', recentHistory: [], maxTokens: 16, jsonMode: true,
    providerOutputMode: 'GROQ_JSON_OBJECT', ...args,
  });

  await run(groq, { role: 'EXPLAINER', outputContract: 'GROUNDED_EXPLANATION_V1' });
  await run(groq, { role: 'PLANNER', outputContract: 'PLAN_REVIEW_PLANNER_V1' });
  await run(groq, { role: 'EXPLAINER', outputContract: 'PLAN_REVIEW_PLANNER_V1' });
  await run(gemini, { role: 'EXPLAINER', outputContract: 'GROUNDED_EXPLANATION_V1' });

  assert.equal(seen[0].providerOutputMode, 'GROQ_JSON_OBJECT');
  for (const call of seen.slice(1)) assert.equal(Object.hasOwn(call, 'providerOutputMode'), false);
});

test('provider cancellation is signalled and cannot fall through to another model', async () => {
  let signalObserved = false;
  let started;
  const providerStarted = new Promise(resolve => { started = resolve; });
  const provider = {
    name: 'cancellable',
    async generate({ signal }) {
      started();
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          signalObserved = true;
          reject(signal.reason || Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      });
    },
  };
  let fallbackCalls = 0;
  const fallback = { name: 'must-not-run', async generate() { fallbackCalls += 1; return { text: 'unsafe late fallback' }; } };
  const budget = createPlanReviewTokenBudget({ maxInputTokens: 64, maxOutputTokens: 8, maxTotalTokens: 100, maxModelCalls: 2 });
  const controller = new AbortController();
  const gateway = createModelGateway({ providers: [provider, fallback], maxOutputTokens: 8 });
  const pending = gateway.generate({ role: 'EXPLAINER', systemPrompt: 'safe', requestBudget: budget, signal: controller.signal });
  await providerStarted;
  const cancellation = Object.assign(new Error('run cancelled'), { name: 'AbortError' });
  controller.abort(cancellation);
  await assert.rejects(pending, error => error === cancellation);
  assert.equal(signalObserved, true);
  assert.equal(fallbackCalls, 0);
});

test('provider that ignores abort cannot publish a late planner result', async () => {
  let releaseProvider;
  let started;
  const providerStarted = new Promise(resolve => { started = resolve; });
  const provider = {
    name: 'non-cancellable',
    async generate() {
      started();
      return new Promise(resolve => { releaseProvider = resolve; });
    },
  };
  const budget = createPlanReviewTokenBudget({ maxInputTokens: 64, maxOutputTokens: 8, maxTotalTokens: 100, maxModelCalls: 2 });
  const controller = new AbortController();
  const wrapped = createBudgetedPlanReviewProvider(provider, budget);
  const pending = wrapped.generate({ systemPrompt: 'safe', maxTokens: 8, signal: controller.signal });
  await providerStarted;
  const cancellation = Object.assign(new Error('run timed out'), { name: 'AbortError' });
  controller.abort(cancellation);
  releaseProvider({ text: 'late result must not be used', tokensUsed: 1 });
  await assert.rejects(pending, error => error === cancellation);
  assert.equal(budget.modelCalls, 1);
  assert.ok(budget.accountedTokens > 0, 'reserved cost remains conservatively charged despite the late response');
});

test('provider fallback cannot exceed the hard model-call ceiling', async () => {
  let secondProviderCalls = 0;
  const first = {
    name: 'groq',
    async generate() { this.lastFailureReason = 'PROVIDER_TIMEOUT'; return null; },
  };
  const second = { name: 'gemini', async generate() { secondProviderCalls += 1; return { text: 'must not run' }; } };
  const budget = createPlanReviewTokenBudget({
    maxInputTokens: 20, maxOutputTokens: 20, maxTotalTokens: 500, maxModelCalls: 1,
    onReserve: async () => undefined,
  });
  const gateway = createModelGateway({ providers: [first, second], maxOutputTokens: 20, allowGeminiFallback: true });
  await assert.rejects(
    gateway.generate({ role: 'PLANNER', systemPrompt: 'safe bounded prompt', maxTokens: 20, requestBudget: budget }),
    error => error.code === 'AGENT_BUDGET_EXCEEDED' && error.reason === 'MODEL_CALLS',
  );
  assert.equal(secondProviderCalls, 0);
  assert.equal(budget.modelCalls, 1);
});

test('provider is never called when durable budget reservation fails', async () => {
  let providerCalls = 0;
  const budget = createPlanReviewTokenBudget({
    onReserve: async () => { throw Object.assign(new Error('Mongo reservation write failed'), { code: 'AGENT_BUDGET_PERSISTENCE_UNAVAILABLE' }); },
  });
  const provider = createBudgetedPlanReviewProvider({ async generate() { providerCalls += 1; return { text: 'unsafe to call' }; } }, budget);
  await assert.rejects(provider.generate({ systemPrompt: 'bounded input', maxTokens: 4 }), error => error.code === 'AGENT_BUDGET_PERSISTENCE_UNAVAILABLE');
  assert.equal(providerCalls, 0);
  assert.equal(budget.modelCalls, 1, 'the failed durable reservation remains conservatively accounted locally');
});

test('invalid restored token usage fails closed', () => {
  const budget = createPlanReviewTokenBudget({ maxTotalTokens: 40 });
  assert.throws(() => budget.restore(41), error => error.code === 'AGENT_BUDGET_EXCEEDED');
});

test('closed PlanReview budget prevents post-timeout provider retries', () => {
  const budget = createPlanReviewTokenBudget();
  budget.close();
  return assert.rejects(budget.reserve({ systemPrompt: 'safe' }), error => error.code === 'AGENT_BUDGET_EXCEEDED' && error.reason === 'RUN_CLOSED');
});

test('grounded explanation does not swallow a hard PlanReview budget rejection', async () => {
  const { generateGroundedExplanation } = await import('../services/groundedExplanationService.js');
  const budgetError = Object.assign(new Error('hard budget reached'), { code: 'AGENT_BUDGET_EXCEEDED' });
  await assert.rejects(
    generateGroundedExplanation({
      question: 'Explain only this safe evidence.',
      evidencePacket: {
        evidenceHash: 'fixture-hash',
        entries: [{ id: 'E_PLAN', kind: 'RECOMMENDATION', dataClass: 'DERIVED_VALUE', displayValue: 'Plan evidence.' }],
        unavailableFacts: [],
      },
    }, {
      providers: [{ name: 'budgeted', async generate() { throw budgetError; } }],
      getCache: async () => null,
      setCache: async () => undefined,
    }),
    error => error === budgetError,
  );
});

test('model gateway rejects zero, negative, fractional and non-finite token caps before provider or budget', async () => {
  let calls = 0;
  let reservations = 0;
  const gateway = createModelGateway({
    providers: [{ name: 'groq', async generate() { calls += 1; return { text: 'must not run' }; } }],
    maxOutputTokens: 32,
  });
  const budget = {
    async reserve() { reservations += 1; throw new Error('unexpected reservation'); },
    settle() {},
  };
  for (const maxTokens of [0, -1, 1.5, Number.NaN, Infinity, -Infinity, '8', null]) {
    await assert.rejects(
      gateway.generate({ role: 'PLANNER', systemPrompt: 'safe', maxTokens, requestBudget: budget }),
      error => error instanceof RangeError && /maxTokens/.test(error.message),
    );
  }
  assert.equal(calls, 0);
  assert.equal(reservations, 0);
  for (const maxOutputTokens of [0, -5, 1.1, Number.NaN, Infinity, '32']) {
    assert.throws(() => createModelGateway({ providers: [], maxOutputTokens }), RangeError);
  }
});

test('valid model output token requests are capped conservatively before provider invocation', async () => {
  let seen;
  const gateway = createModelGateway({
    providers: [{ name: 'groq', async generate(args) { seen = args.maxTokens; return { text: 'ok', tokensUsed: 1 }; } }],
    maxOutputTokens: 24,
  });
  const result = await gateway.generate({ role: 'PLANNER', systemPrompt: 'safe', maxTokens: 100 });
  assert.equal(seen, 24);
  assert.equal(result.text, 'ok');
});
