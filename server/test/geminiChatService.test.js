import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { processChat as processChatService, isUnboundGoalFollowUp } from '../services/geminiChatService.js';
import { AIToolOrchestrator } from '../services/aiToolOrchestrator.js';
import { ConversationStateMachine, CONVERSATION_STATES } from '../services/conversationStateMachine.js';
import { LayeredMemoryManager } from '../services/layeredMemoryManager.js';
import { ExplainabilityEngine } from '../services/explainabilityEngine.js';
import { ToolTraceGraph, promptVersion } from '../services/toolTraceGraph.js';
import { ProviderManager } from '../services/providerAbstraction.js';
import FinancialProfile from '../models/FinancialProfile.js';
import FinancialProfileState from '../models/FinancialProfileState.js';
import Recommendation from '../models/Recommendation.js';
import RecommendationState from '../models/RecommendationState.js';
import Goal from '../models/Goal.js';
import User from '../models/User.js';
import ConversationHistory from '../models/ConversationHistory.js';
import { defaultChatSessionStore } from '../services/chatSessionStore.js';
import { canonicalProfile } from './helpers/canonicalProfile.js';
import { installMockChatSessionStore } from './helpers/mockChatSessionStore.js';

const mockUserId = '60d5ecb8b3b3a72d9c8e4a11';
const mockSessionId = 'test-session-123';
let defaultTestRateLimitOptions;

function processChat(request, options = {}) {
  return processChatService(request, {
    rateLimitOptions: defaultTestRateLimitOptions,
    groundedExplanationDependencies: {
      getCache: async () => null,
      setCache: async () => true,
    },
    ...options,
  });
}

const mockUser = {
  _id: mockUserId,
  email: 'test@example.com',
  name: 'Test Investor',
};

const mockProfile = {
  _id: '60d5ecb8b3b3a72d9c8e4a22',
  userId: mockUserId,
  ...canonicalProfile({
    age: 32,
    monthlySavings: 30000,
    investmentHorizonYears: 15,
    hasLumpSum: true,
    lumpSumAmount: 500000,
  }),
};

function groundedGeminiPayload(text = 'The final suitability ceiling is Moderate [E_PROFILE_RISK].') {
  return {
    data: {
      modelVersion: 'gemini-runtime-test',
      candidates: [{
        content: { parts: [{ text: JSON.stringify({
          text,
          evidenceIdsUsed: ['E_PROFILE_RISK'],
          claims: [{ text, evidenceIds: ['E_PROFILE_RISK'] }],
          financialClaims: [],
          unavailableFacts: [],
        }) }] },
        finishReason: 'STOP',
      }],
      usageMetadata: { totalTokenCount: 50 },
    },
  };
}

describe('GenieChat V3 Enterprise Architecture Tests', () => {
  let originalPost;
  let originalProfileFindOne;
  let originalProfileStateFindOne;
  let originalRecFindOne;
  let originalRecommendationStateFindOne;
  let originalGoalFind;
  let originalUserFindById;
  let originalConvFindOne;
  let originalEnvGemini;
  let originalEnvGroq;
  let originalEnvNvidia;
  let originalPrimaryProvider;
  let savedMessages = [];
  let restoreChatStore;

  beforeEach(() => {
    originalPost = axios.post;
    originalProfileFindOne = FinancialProfile.findOne;
    originalProfileStateFindOne = FinancialProfileState.findOne;
    originalRecFindOne = Recommendation.findOne;
    originalRecommendationStateFindOne = RecommendationState.findOne;
    originalGoalFind = Goal.find;
    originalUserFindById = User.findById;
    originalConvFindOne = ConversationHistory.findOne;
    originalEnvGemini = process.env.GEMINI_API_KEY;
    originalEnvGroq = process.env.GROQ_API_KEY;
    originalEnvNvidia = process.env.NVIDIA_API_KEY;
    originalPrimaryProvider = process.env.LLM_PRIMARY_PROVIDER;
    savedMessages = [];
    defaultTestRateLimitOptions = {
      env: { NODE_ENV: 'test' },
      localHits: new Map(),
      getRedisState: () => ({ client: null, available: false }),
    };

    process.env.GEMINI_API_KEY = 'mock-gemini-key';
    process.env.GROQ_API_KEY = 'mock-groq-key';
    process.env.NVIDIA_API_KEY = '';
    process.env.LLM_PRIMARY_PROVIDER = 'GEMINI';

    // Reset circuit breakers
    ProviderManager.gemini.reset();
    ProviderManager.groq.reset();

    // Mock DB queries
    FinancialProfile.findOne = () => {
      const query = { sort: () => query, lean: async () => mockProfile };
      return query;
    };
    FinancialProfileState.findOne = query => ({
      lean: async () => (String(query?.userId) === mockUserId ? {
        userId: mockUserId,
        currentProfileId: mockProfile._id,
        revision: 1,
        promotionFence: 0,
        resolutionStatus: 'CURRENT',
      } : null),
    });

    Recommendation.findOne = () => ({
      sort: () => ({
        lean: async () => null,
      }),
    });
    RecommendationState.findOne = () => ({ lean: async () => null });

    Goal.find = () => ({
      sort: () => ({
        lean: async () => [],
      }),
    });

    User.findById = () => ({
      select() { return this; },
      lean: async () => mockUser,
    });

    ConversationHistory.findOne = async () => ({
      userId: mockUserId,
      session_id: mockSessionId,
      messages: savedMessages,
      save: async function () {
        return true;
      },
    });
    restoreChatStore = installMockChatSessionStore(async () => ({
      userId: mockUserId,
      profileId: mockProfile._id,
      profileVersion: 1,
      profileInputHash: null,
      messages: savedMessages,
      cumulative_tokens: 0,
    }));
  });

  afterEach(() => {
    restoreChatStore?.();
    axios.post = originalPost;
    FinancialProfile.findOne = originalProfileFindOne;
    FinancialProfileState.findOne = originalProfileStateFindOne;
    Recommendation.findOne = originalRecFindOne;
    RecommendationState.findOne = originalRecommendationStateFindOne;
    Goal.find = originalGoalFind;
    User.findById = originalUserFindById;
    ConversationHistory.findOne = originalConvFindOne;
    if (originalEnvGemini === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = originalEnvGemini;
    if (originalEnvGroq === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = originalEnvGroq;
    if (originalEnvNvidia === undefined) delete process.env.NVIDIA_API_KEY; else process.env.NVIDIA_API_KEY = originalEnvNvidia;
    if (originalPrimaryProvider === undefined) delete process.env.LLM_PRIMARY_PROVIDER; else process.env.LLM_PRIMARY_PROVIDER = originalPrimaryProvider;
  });

  it('Provider Abstraction & Fallback: ProviderManager executes Gemini adapter', async () => {
    axios.post = async (url) => {
      if (url.includes('generativelanguage.googleapis.com')) {
        return groundedGeminiPayload();
      }
      throw new Error('Unexpected URL');
    };

    const result = await processChat({
      userId: mockUserId,
      user: mockUser,
      message: 'Rebalance my portfolio.',
      sessionId: mockSessionId,
    });

    assert.equal(result.version, '3.0');
    assert.equal(result.provider, 'GEMINI');
    assert.equal(result.model, 'gemini-runtime-test');
    const lastSavedModelMsg = savedMessages.filter(m => m.role === 'model').slice(-1)[0];
    assert.equal(lastSavedModelMsg.metadata.validation_status, 'PASS');
    assert.deepEqual(lastSavedModelMsg.metadata.evidence_ids_used, ['E_PROFILE_RISK', 'E_REGULATORY_NOTICE']);
    assert.equal(lastSavedModelMsg.metadata.tool_outputs, undefined);
    assert.equal(result.explainability, undefined);
    assert.equal(result.governance, undefined);
    assert.match(result.response, /Moderate \[E_PROFILE_RISK\]/);
  });

  it('processChat retries a rejected Groq answer with a separately reserved Gemini attempt', async () => {
    const reservations = [];
    const settlements = [];
    let groqCalls = 0;
    let geminiCalls = 0;
    const groq = {
      name: 'groq',
      configuredModel: () => 'groq-test-model',
      isConfigured: () => true,
      async generate() {
        groqCalls += 1;
        const text = 'This profile is guaranteed to earn 25% each year [E_PROFILE_RISK].';
        return {
          provider: 'groq', model: 'groq-test-model', tokensUsed: 42,
          text: JSON.stringify({
            text,
            evidenceIdsUsed: ['E_PROFILE_RISK'],
            claims: [{ text, evidenceIds: ['E_PROFILE_RISK'] }],
            financialClaims: [],
            unavailableFacts: [],
          }),
        };
      },
    };
    const gemini = {
      name: 'gemini',
      configuredModel: () => 'gemini-runtime-test',
      isConfigured: () => true,
      async generate() {
        geminiCalls += 1;
        return {
          provider: 'gemini', model: 'gemini-runtime-test', tokensUsed: 17,
          text: JSON.stringify({
            text: 'The final suitability ceiling is Moderate [E_PROFILE_RISK].',
            evidenceIdsUsed: ['E_PROFILE_RISK'],
            claims: [{ text: 'The final suitability ceiling is Moderate [E_PROFILE_RISK].', evidenceIds: ['E_PROFILE_RISK'] }],
            financialClaims: [],
            unavailableFacts: [],
          }),
        };
      },
    };

    const result = await processChat({
      userId: mockUserId,
      user: mockUser,
      message: 'Explain my suitability risk.',
      sessionId: mockSessionId,
      idempotencyKey: 'groq-gemini-chat-fallback-001',
    }, {
      reserveProviderAttempt: async ({ providerAttemptCount }) => {
        const reservation = { reservationId: `provider-attempt-${providerAttemptCount}`, tokens: 90 };
        reservations.push(reservation);
        return reservation;
      },
      settleProviderAttempt: async ({ reservation, actualTokens }) => {
        settlements.push({ reservation, actualTokens });
        return { settled: true };
      },
      groundedExplanationDependencies: {
        providers: [groq, gemini],
        allowGeminiFallback: true,
        getCache: async () => null,
        setCache: async () => false,
      },
    });

    assert.equal(groqCalls, 1);
    assert.equal(geminiCalls, 1);
    assert.equal(reservations.length, 2);
    assert.equal(result.provider, 'GEMINI');
    assert.equal(result.fallback, true);
    assert.equal(result.validation_status, 'PASS');
    assert.equal(result.response.includes('25%'), false);
    assert.match(result.response, /Moderate \[E_PROFILE_RISK\]/);
    assert.deepEqual(settlements.map(item => item.actualTokens), [42, 17]);
    assert.equal(savedMessages.filter(message => message.role === 'model').at(-1).metadata.tokens_used, 59);
  });

  it('reports exhausted session token budget instead of mislabeling it as missing provider configuration', async () => {
    const sessionStore = {
      ...defaultChatSessionStore,
      reserveBudget: async () => false,
    };

    const result = await processChat({
      userId: mockUserId,
      user: mockUser,
      message: 'Explain my suitability risk.',
      sessionId: mockSessionId,
    }, { sessionStore });

    assert.equal(result.provider, 'DETERMINISTIC_TEMPLATE');
    assert.ok(result.fallback_reason_codes.includes('PROVIDER_BUDGET_EXHAUSTED'));
    assert.equal(result.fallback_reason_codes.includes('NO_LLM_PROVIDER_CONFIGURED'), false);
  });

  it('replays a completed turn by its stable key without another provider call or quota charge', async () => {
    let providerCalls = 0;
    axios.post = async url => {
      if (url.includes('generativelanguage.googleapis.com')) {
        providerCalls += 1;
        return groundedGeminiPayload();
      }
      throw new Error('Unexpected URL');
    };
    const rateOptions = {
      env: { NODE_ENV: 'test' },
      localHits: new Map(),
      now: () => 10_000,
      getRedisState: () => ({ client: null, available: false }),
    };
    const request = {
      userId: mockUserId,
      user: mockUser,
      message: 'Explain my suitability.',
      sessionId: mockSessionId,
      idempotencyKey: 'stable-chat-turn-001',
    };

    const first = await processChat(request, { rateLimitOptions: rateOptions });
    const replay = await processChat(request, { rateLimitOptions: rateOptions });

    assert.equal(providerCalls, 1);
    assert.equal(savedMessages.length, 2);
    assert.equal(first.idempotent_replay, false);
    assert.equal(replay.idempotent_replay, true);
    assert.equal(replay.response, first.response);
    assert.equal(rateOptions.localHits.get(`chat:ratelimit:${mockUserId}`).count, 1);
  });

  it('rejects a completed receipt replay when the financial binding changes during receipt lookup', async () => {
    let revision = 1;
    let providerCalls = 0;
    const originalFindReceipt = defaultChatSessionStore.findReceipt;
    const rateLimitOptions = {
      env: { NODE_ENV: 'test' }, localHits: new Map(), now: () => 10_000,
      getRedisState: () => ({ client: null, available: false }),
    };
    FinancialProfileState.findOne = query => ({
      lean: async () => (String(query?.userId) === mockUserId ? {
        userId: mockUserId,
        currentProfileId: mockProfile._id,
        revision,
        promotionFence: 0,
        resolutionStatus: 'CURRENT',
      } : null),
    });
    axios.post = async url => {
      if (url.includes('generativelanguage.googleapis.com')) {
        providerCalls += 1;
        return groundedGeminiPayload();
      }
      throw new Error('Unexpected URL');
    };
    const request = {
      userId: mockUserId,
      user: mockUser,
      message: 'Explain my suitability.',
      sessionId: mockSessionId,
      idempotencyKey: 'stale-replay-001',
    };

    try {
      await processChat(request, { rateLimitOptions });
      defaultChatSessionStore.findReceipt = async args => {
        const receipt = await originalFindReceipt(args);
        revision = 2;
        return receipt;
      };
      await assert.rejects(processChat(request, { rateLimitOptions }), error => {
        assert.equal(error.status, 409);
        assert.equal(error.code, 'CHAT_PROFILE_STATE_CHANGED');
        return true;
      });
      assert.equal(providerCalls, 1);
      assert.equal(savedMessages.length, 2);
    } finally {
      defaultChatSessionStore.findReceipt = originalFindReceipt;
    }
  });

  it('rejects reuse of a completed chat key for different message text', async () => {
    let providerCalls = 0;
    axios.post = async url => {
      if (url.includes('generativelanguage.googleapis.com')) {
        providerCalls += 1;
        return groundedGeminiPayload();
      }
      throw new Error('Unexpected URL');
    };
    const request = {
      userId: mockUserId,
      user: mockUser,
      message: 'Explain my suitability.',
      sessionId: mockSessionId,
      idempotencyKey: 'stable-chat-turn-002',
    };
    const rateLimitOptions = {
      env: { NODE_ENV: 'test' }, localHits: new Map(), now: () => 10_000,
      getRedisState: () => ({ client: null, available: false }),
    };
    await processChat(request, { rateLimitOptions });

    await assert.rejects(processChat({ ...request, message: 'Tell me something else.' }, { rateLimitOptions }), error => {
      assert.equal(error.status, 409);
      assert.equal(error.code, 'CHAT_IDEMPOTENCY_KEY_REUSED');
      return true;
    });
    assert.equal(providerCalls, 1);
    assert.equal(savedMessages.length, 2);
  });

  it('uses only a bounded, provenance-matched prior pair for follow-up context', async () => {
    let secondPrompt;
    let call = 0;
    const rateLimitOptions = {
      env: { NODE_ENV: 'test' }, localHits: new Map(), now: () => 10_000,
      getRedisState: () => ({ client: null, available: false }),
    };
    axios.post = async (url, body) => {
      if (url.includes('generativelanguage.googleapis.com')) {
        call += 1;
        if (call === 2) secondPrompt = JSON.parse(body.contents[0].parts[0].text);
        return groundedGeminiPayload();
      }
      throw new Error('Unexpected URL');
    };

    await processChat({ userId: mockUserId, user: mockUser, message: 'Explain suitability.', sessionId: mockSessionId, idempotencyKey: 'context-first-001' }, { rateLimitOptions });
    await processChat({ userId: mockUserId, user: mockUser, message: 'Can you explain that simply?', sessionId: mockSessionId, idempotencyKey: 'context-second-001' }, { rateLimitOptions });

    assert.deepEqual(secondPrompt.PRIOR_TURNS_UNTRUSTED.map(turn => turn.role), ['user', 'model']);
    assert.equal(secondPrompt.PRIOR_TURNS_UNTRUSTED[0].content, 'Explain suitability.');
    assert.equal(JSON.stringify(secondPrompt.PRIOR_TURNS_UNTRUSTED).includes('citations'), false);
  });

  it('does not persist or return an answer when the financial binding changes during generation', async () => {
    let revision = 1;
    const rateLimitOptions = {
      env: { NODE_ENV: 'test' }, localHits: new Map(), now: () => 10_000,
      getRedisState: () => ({ client: null, available: false }),
    };
    FinancialProfileState.findOne = query => ({
      lean: async () => (String(query?.userId) === mockUserId ? {
        userId: mockUserId,
        currentProfileId: mockProfile._id,
        revision,
        promotionFence: 0,
        resolutionStatus: 'CURRENT',
      } : null),
    });
    axios.post = async url => {
      if (url.includes('generativelanguage.googleapis.com')) {
        revision = 2;
        return groundedGeminiPayload();
      }
      throw new Error('Unexpected URL');
    };

    await assert.rejects(processChat({
      userId: mockUserId,
      user: mockUser,
      message: 'Explain suitability.',
      sessionId: mockSessionId,
      idempotencyKey: 'stale-binding-001',
    }, { rateLimitOptions }), error => {
      assert.equal(error.status, 409);
      assert.equal(error.code, 'CHAT_PROFILE_STATE_CHANGED');
      return true;
    });
    assert.equal(savedMessages.length, 0);
  });

  it('rechecks the financial binding after quota admission and before the provider receives evidence', async () => {
    let revision = 1;
    let providerCalls = 0;
    const settledUsage = [];
    const rateLimitOptions = {
      env: { NODE_ENV: 'test' }, localHits: new Map(), now: () => 10_000,
      getRedisState: () => ({ client: null, available: false }),
    };
    FinancialProfileState.findOne = query => ({
      lean: async () => (String(query?.userId) === mockUserId ? {
        userId: mockUserId,
        currentProfileId: mockProfile._id,
        revision,
        promotionFence: 0,
        resolutionStatus: 'CURRENT',
      } : null),
    });
    axios.post = async url => {
      if (url.includes('generativelanguage.googleapis.com')) {
        providerCalls += 1;
        return groundedGeminiPayload();
      }
      throw new Error('Unexpected URL');
    };

    await assert.rejects(processChat({
      userId: mockUserId,
      user: mockUser,
      message: 'Explain my suitability.',
      sessionId: mockSessionId,
      idempotencyKey: 'admission-binding-race-001',
    }, {
      rateLimitOptions,
      reserveProviderAttempt: async () => {
        revision = 2;
        return { reservationId: 'admission-race', tokens: 90 };
      },
      settleProviderAttempt: async ({ actualTokens }) => {
        settledUsage.push(actualTokens);
        return { settled: true };
      },
    }), error => {
      assert.equal(error.status, 409);
      assert.equal(error.code, 'CHAT_PROFILE_STATE_CHANGED');
      return true;
    });

    assert.equal(providerCalls, 0, 'provider must not receive stale evidence');
    assert.deepEqual(settledUsage, [0], 'a provider attempt rejected before invocation incurs no usage');
    assert.equal(savedMessages.length, 0);
  });

  it('discards a completed turn if the financial binding changes during persistence', async () => {
    let revision = 1;
    const originalComplete = defaultChatSessionStore.complete;
    const originalFindOne = FinancialProfileState.findOne;
    FinancialProfileState.findOne = query => ({
      lean: async () => (String(query?.userId) === mockUserId ? {
        userId: mockUserId,
        currentProfileId: mockProfile._id,
        revision,
        promotionFence: 0,
        resolutionStatus: 'CURRENT',
      } : null),
    });
    defaultChatSessionStore.complete = async args => {
      const completedTurn = await originalComplete(args);
      revision = 2;
      return completedTurn;
    };

    axios.post = async url => {
      if (url.includes('generativelanguage.googleapis.com')) return groundedGeminiPayload();
      throw new Error('Unexpected URL');
    };

    try {
      await assert.rejects(processChat({
        userId: mockUserId,
        user: mockUser,
        message: 'Explain suitability.',
        sessionId: mockSessionId,
        idempotencyKey: 'post-persist-binding-001',
      }), error => {
        assert.equal(error.status, 409);
        assert.equal(error.code, 'CHAT_PROFILE_STATE_CHANGED');
        return true;
      });
      assert.equal(savedMessages.length, 0);
    } finally {
      defaultChatSessionStore.complete = originalComplete;
      FinancialProfileState.findOne = originalFindOne;
    }
  });

  it('reports the precise quota reset after the final successful chat message and on the next denial', async () => {
    const originalStateFindOne = FinancialProfileState.findOne;
    const localHits = new Map();
    const options = {
      env: { NODE_ENV: 'test' },
      localHits,
      now: () => 12_345,
      getRedisState: () => ({ client: null, available: false }),
    };
    FinancialProfileState.findOne = () => ({
      lean: async () => ({
        userId: mockUserId,
        currentProfileId: null,
        revision: 0,
        promotionFence: 0,
        resolutionStatus: 'NO_CURRENT',
      }),
    });

    try {
      for (let count = 0; count < 29; count += 1) {
        await processChat({
          userId: mockUserId,
          user: mockUser,
          message: 'Use a prior quota slot',
          sessionId: mockSessionId,
        }, { rateLimitOptions: options });
      }

      const finalAllowed = await processChat({
        userId: mockUserId,
        user: mockUser,
        message: 'Check remaining quota',
        sessionId: mockSessionId,
      }, { rateLimitOptions: options });
      const resetAt = new Date(12_345 + (60 * 60 * 1000)).toISOString();
      assert.equal(finalAllowed.rate_limit_remaining, 0);
      assert.equal(finalAllowed.rate_limit_reset_at, resetAt);

      await assert.rejects(processChat({
        userId: mockUserId,
        user: mockUser,
        message: 'Check exhausted quota',
        sessionId: mockSessionId,
      }, { rateLimitOptions: options }), error => {
        assert.equal(error.status, 429);
        assert.equal(error.code, 'CHAT_RATE_LIMIT_EXCEEDED');
        assert.equal(error.clientDetails.retryAfterSeconds, 3600);
        assert.equal(error.clientDetails.resetAt, resetAt);
        return true;
      });
    } finally {
      FinancialProfileState.findOne = originalStateFindOne;
    }
  });
  it('Phase 1: AIToolOrchestrator resolves parallel tool calls in a DAG graph', async () => {
    const toolRequests = [
      { tool: 'sip_projection', arguments: { monthlyInvestment: 10000, annualRate: 0.12, years: 10 } },
      { tool: 'lump_sum_projection', arguments: { principal: 500000, annualRate: 0.10, years: 5 } },
    ];

    const orchestration = await AIToolOrchestrator.orchestrate(toolRequests, { profile: mockProfile });
    assert.equal(orchestration.toolResults.length, 2);
    assert.equal(orchestration.executionGraph.status, 'SUCCESS');
    assert.equal(orchestration.toolResults[0].success, true);
    assert.equal(orchestration.toolResults[1].success, true);
  });

  it('Phase 3: ConversationStateMachine tracks explicit state transitions', () => {
    const state1 = ConversationStateMachine.transition(CONVERSATION_STATES.IDLE, { hasTools: true });
    assert.equal(state1.nextState, CONVERSATION_STATES.EXECUTING_TOOLS);

    const state2 = ConversationStateMachine.transition(CONVERSATION_STATES.IDLE, { isFallback: true });
    assert.equal(state2.nextState, CONVERSATION_STATES.FALLBACK);
  });

  it('Phase 4 & 5: LayeredMemoryManager constructs context dynamically without dumping full raw history', () => {
    const memory = LayeredMemoryManager.buildRetrievedContext('SIP planning', mockProfile, [], null, []);
    assert.equal(memory.profileMemory.age, 32);
    assert.equal(memory.preferenceMemory.riskTolerance, 'Moderate');
    assert.equal(memory.preferenceMemory.taxRegime, undefined);

    const formattedPrompt = LayeredMemoryManager.formatForPrompt(memory);
    assert.match(formattedPrompt, /"age":\s*32/);
  });

  it('Phase 6: ExplainabilityEngine produces deterministic non-hallucinated explanations', () => {
    const explanation = ExplainabilityEngine.generateExplanation(
      mockProfile,
      [{ tool: 'sip_projection', success: true, result: {} }],
      { verification_status: 'verified' }
    );

    assert.equal(explanation.arithmeticVerificationStatus, 'verified');
    assert.ok(explanation.financialEnginesUsed.includes('projectionEngine.sipFV'));
    assert.match(explanation.riskDisclosure, /market risks/i);
  });

  it('Phase 7 & 16: ToolTraceGraph & AI Governance calculate SHA-256 reproducibility hashes', () => {
    const trace = ToolTraceGraph.buildTraceGraph({
      sessionId: mockSessionId,
      userId: mockUserId,
      userMessage: 'Test query',
      stateTransition: { nextState: 'ExecutingTools' },
      provider: 'gemini',
      responseText: 'Financial output string.',
    });

    assert.ok(trace.traceId.startsWith('trace-'));
    assert.ok(trace.governance.governanceHash);
    assert.equal(trace.governance.promptVersion, promptVersion.version);
  });

  it('Phase 9 & 14: Provider Circuit Breaker opens after 3 consecutive failures', async () => {
    axios.post = async () => {
      throw Object.assign(new Error('provider unavailable'), { response: { status: 503 } });
    };

    // 3 failures
    await ProviderManager.gemini.generate({ systemPrompt: 'test', recentHistory: [] });
    await ProviderManager.gemini.generate({ systemPrompt: 'test', recentHistory: [] });
    await ProviderManager.gemini.generate({ systemPrompt: 'test', recentHistory: [] });

    assert.equal(ProviderManager.gemini.isHealthy(), false);
  });

  it('Phase 6: processChat performs one read-only grounded call and exposes no tool surface', async () => {
    let callCount = 0;
    let requestBody;
    axios.post = async (url, body) => {
      if (url.includes('generativelanguage.googleapis.com')) {
        callCount += 1;
        requestBody = body;
        return groundedGeminiPayload();
      }
      throw new Error('Unexpected URL');
    };

    const result = await processChat({
      userId: mockUserId,
      user: mockUser,
      message: 'Explain my suitability.',
      sessionId: mockSessionId,
    });

    assert.equal(callCount, 1);
    assert.equal(requestBody.tools, undefined);
    assert.equal(requestBody.generationConfig.responseFormat.text.mimeType, 'APPLICATION_JSON');
    assert.ok(requestBody.generationConfig.responseFormat.text.schema.required.includes('financialClaims'));
    assert.equal(Object.hasOwn(requestBody.generationConfig, 'temperature'), false);
    const lastSavedModelMsg = savedMessages.filter(m => m.role === 'model').slice(-1)[0];
    assert.equal(lastSavedModelMsg.metadata.tool_outputs, undefined);
    assert.equal(result.tool_results, undefined);
    assert.match(result.response, /Moderate \[E_PROFILE_RISK\]/);
  });

  it('Phase 6: processChat accepts only structured cited provider output', async () => {
    let callCount = 0;
    axios.post = async (url) => {
      if (url.includes('generativelanguage.googleapis.com')) {
        callCount++;
        return groundedGeminiPayload();
      }
      throw new Error('Unexpected URL');
    };

    const result = await processChat({
      userId: mockUserId,
      user: mockUser,
      message: 'How does diversification affect my portfolio?',
      sessionId: mockSessionId,
    });

    assert.equal(callCount, 1);
    assert.equal(result.tool_results, undefined);
    assert.equal(result.validation_status, 'PASS');
    assert.match(result.response, /\[E_PROFILE_RISK\]/);
  });

  it('answers general programming questions through Groq without sending profile data or inventing sources', async () => {
    const originalGroqGenerate = ProviderManager.groq.generate;
    const originalGeneralFlag = process.env.CHAT_GENERAL_MODE_ENABLED;
    let providerCalls = 0;
    try {
      process.env.CHAT_GENERAL_MODE_ENABLED = 'true';
      ProviderManager.groq.generate = async request => {
        providerCalls += 1;
        assert.equal(request.jsonMode, false);
        assert.equal(request.tools, null);
        assert.doesNotMatch(JSON.stringify(request), /monthlySavings|riskTolerance|E_PROFILE_|_id|allocation_pct/);
        return { text: 'Python generators produce items lazily.', provider: 'groq',
          model: 'test-groq-general', tokensUsed: 24, wasCompleted: true };
      };
      const result = await processChat({
        userId: mockUserId,
        user: mockUser,
        message: 'Explain Python generators.',
        sessionId: mockSessionId,
        idempotencyKey: 'general-python-turn-001',
      }, { groundedExplanationDependencies: { providers: [ProviderManager.groq] } });
      assert.equal(providerCalls, 1);
      assert.equal(result.provider, 'GROQ');
      assert.equal(result.grounded, false);
      assert.equal(result.validation_status, 'UNVERIFIED_GENERAL_CHAT');
      assert.deepEqual(result.citations, []);
      assert.deepEqual(result.evidence_ids_used, []);
      assert.equal(result.response, 'Python generators produce items lazily.');
      const saved = savedMessages.filter(message => message.role === 'model').at(-1);
      assert.equal(saved.metadata.grounded_on_profile, false);
      assert.deepEqual(saved.metadata.citations, []);
    } finally {
      ProviderManager.groq.generate = originalGroqGenerate;
      if (originalGeneralFlag === undefined) delete process.env.CHAT_GENERAL_MODE_ENABLED;
      else process.env.CHAT_GENERAL_MODE_ENABLED = originalGeneralFlag;
    }
  });

  it('keeps ambiguous follow-ups evidence-grounded after a financial chat turn', async () => {
    const originalGeneralFlag = process.env.CHAT_GENERAL_MODE_ENABLED;
    const originalGroqGenerate = ProviderManager.groq.generate;
    let generalCalls = 0;
    try {
      process.env.CHAT_GENERAL_MODE_ENABLED = 'true';
      ProviderManager.groq.generate = async () => {
        generalCalls += 1;
        return { provider: 'groq', text: 'I would invent a financial reason.' };
      };
      // Complete a real bound financial turn. Hand-inserting messages without
      // binding provenance is not trusted history and must not authorize a
      // personalized follow-up.
      const prior = await processChat({
        userId: mockUserId, user: mockUser,
        message: 'Explain my suitability.', sessionId: mockSessionId,
        idempotencyKey: 'financial-first-turn-001',
      }, {
        groundedExplanationDependencies: {
          providers: [], getCache: async () => null, setCache: async () => false,
        },
      });
      assert.equal(prior.grounded, true);
      assert.equal(prior.validation_status, 'PASS');
      const answer = await processChat({
        userId: mockUserId, user: mockUser,
        message: 'Why?', sessionId: mockSessionId,
        idempotencyKey: 'financial-followup-001',
      }, {
        groundedExplanationDependencies: {
          providers: [], getCache: async () => null, setCache: async () => false,
        },
      });
      assert.equal(generalCalls, 0);
      assert.equal(answer.grounded, true);
      assert.equal(answer.validation_status, 'PASS');
      assert.ok(answer.evidence_ids_used.includes('E_PROFILE_RISK'));
      assert.ok(answer.citations.length > 0);
      assert.match(answer.response, /suitability|risk/i);
      assert.doesNotMatch(answer.response, /invent a financial reason/i);
    } finally {
      ProviderManager.groq.generate = originalGroqGenerate;
      if (originalGeneralFlag === undefined) delete process.env.CHAT_GENERAL_MODE_ENABLED;
      else process.env.CHAT_GENERAL_MODE_ENABLED = originalGeneralFlag;
    }
  });

  it('end-to-end: Explain tax assumptions uses verified new-regime policy, not a provider fallback banner', async () => {
    let calls = 0;
    axios.post = async () => {
      calls += 1;
      throw new Error('An external LLM must not be used for policy explanations');
    };
    const result = await processChat({
      userId: mockUserId,
      user: mockUser,
      message: 'Explain tax assumptions',
      sessionId: mockSessionId,
      idempotencyKey: 'new-regime-tax-policy-20261023',
    }, { groundedExplanationDependencies: {
      providers: [], getCache: async () => null, setCache: async () => false,
    } });
    assert.equal(calls, 0);
    assert.equal(result.provider, 'DETERMINISTIC_TEMPLATE');
    assert.equal(result.grounded, true);
    assert.equal(result.fallback, false);
    assert.equal(result.validation_status, 'PASS');
    assert.match(result.response, /only the new income-tax regime/i);
    assert.match(result.response, /annual income, tax regime.*income-source breakdown/i);
    assert.doesNotMatch(result.response, /source-backed fallback|model answer was unavailable/i);
    assert.ok(result.citations.some(c => c.source === 'WealthGenie backend policy'));
    assert.ok(result.citations.every(c => c.source_url === null));
    assert.ok(!result.unavailable_facts.includes('POST_TAX_RETURN_UNAVAILABLE_MISSING_TAX_INPUTS'));
  });

  it('no-profile path: tax assumptions are explained without requiring a financial form', async () => {
    const originalStateLookup = FinancialProfileState.findOne;
    try {
      FinancialProfileState.findOne = () => ({
        lean: async () => ({
          currentProfileId: null, resolutionStatus: 'NO_CURRENT',
          revision: 0, promotionFence: 0,
        }),
      });
      const result = await processChat({
        userId: mockUserId, user: mockUser, sessionId: mockSessionId,
        idempotencyKey: 'no-profile-tax-assumptions-20261023',
        message: 'Which tax regime does WealthGenie use?',
      });
      assert.equal(result.provider, 'DETERMINISTIC_TEMPLATE');
      assert.equal(result.grounded, true);
      assert.equal(result.fallback, false);
      assert.match(result.response, /only the new income-tax regime/i);
      assert.ok(result.citations.some(c => c.source === 'WealthGenie backend policy'));
    } finally {
      FinancialProfileState.findOne = originalStateLookup;
    }
  });

  it('Phase 6: provider failure returns a deterministic evidence-backed fallback', async () => {
    axios.post = async () => {
      throw Object.assign(new Error('provider unavailable'), { code: 'ECONNRESET' });
    };

    const result = await processChat({
      userId: mockUserId,
      user: mockUser,
      message: 'Rebalance my portfolio.',
      sessionId: mockSessionId,
    });

    assert.equal(result.provider, 'DETERMINISTIC_TEMPLATE');
    assert.equal(result.fallback, true);
    assert.equal(result.tool_results, undefined);
    assert.match(result.response, /authoritative backend reports/i);
    assert.match(result.response, /\[E_PROFILE_RISK\]/);
  });
  it('end-to-end red-team: processChat routes goal arithmetic through verified deterministic answer', async () => {
    const result = await processChat({
      userId: mockUserId,
      user: mockUser,
      sessionId: mockSessionId,
      idempotencyKey: 'adversarial-goal-amount-20261023',
      message: "Need 2 crore for daughter's wedding in 10 years. I have ₹20 lakh saved. I can save 50k per month.",
    }, { groundedExplanationDependencies: {
      providers: [], getCache: async () => null, setCache: async () => false,
    } });
    assert.equal(result.provider, 'DETERMINISTIC_TEMPLATE');
    assert.equal(result.validation_status, 'PASS');
    assert.equal(result.grounded, true);
    assert.match(result.response, /2,00,00,000/);
    assert.match(result.response, /1,50,000 per month/);
    assert.match(result.response, /not fundable from contributions alone/i);
    assert.ok(result.citations.some(c => c.citation_id === 'E_GOAL_MONTHLY_BASELINE'));
    assert.ok(result.citations.filter(c => c.citation_id.startsWith('E_GOAL_'))
      .every(c => c.source_url === null));
  });

  it('end-to-end red-team: bad monetary precision fails closed before chat response', async () => {
    const result = await processChat({
      userId: mockUserId,
      user: mockUser,
      sessionId: mockSessionId,
      idempotencyKey: 'adversarial-invalid-paise-20261023',
      message: "Need ₹1.005 for daughter's wedding in 3 months starting from zero.",
    }, { groundedExplanationDependencies: {
      providers: [], getCache: async () => null, setCache: async () => false,
    } });
    assert.equal(result.provider, 'DETERMINISTIC_TEMPLATE');
    assert.equal(result.validation_status, 'PASS');
    assert.doesNotMatch(result.response, /Funding-only baseline/i);
    assert.match(result.response, /ambiguous or invalid/i);
  });

});


describe('Unbound goal follow-up routing', () => {
  it('never treats elliptical numeric goal turns as independent general LLM questions', () => {
    for (const q of ['in 10 years', 'within 2.5 years', 'starting from zero',
      'What about in 10 years?', "My daughter's marriage is in 12 years."]) {
      assert.equal(isUnboundGoalFollowUp(q), true, q);
    }
    for (const q of ['Explain Python from 10 years ago', 'Write a wedding story', 'Hello Genie']) {
      assert.equal(isUnboundGoalFollowUp(q), false, q);
    }
  });
});
