import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { processChat } from '../services/geminiChatService.js';
import { AIToolOrchestrator } from '../services/aiToolOrchestrator.js';
import { ConversationStateMachine, CONVERSATION_STATES } from '../services/conversationStateMachine.js';
import { LayeredMemoryManager } from '../services/layeredMemoryManager.js';
import { ExplainabilityEngine } from '../services/explainabilityEngine.js';
import { ToolTraceGraph, promptVersion } from '../services/toolTraceGraph.js';
import { ProviderManager } from '../services/providerAbstraction.js';
import FinancialProfile from '../models/FinancialProfile.js';
import FinancialProfileState from '../models/FinancialProfileState.js';
import Recommendation from '../models/Recommendation.js';
import Goal from '../models/Goal.js';
import User from '../models/User.js';
import ConversationHistory from '../models/ConversationHistory.js';
import { canonicalProfile } from './helpers/canonicalProfile.js';
import { installMockChatSessionStore } from './helpers/mockChatSessionStore.js';

const mockUserId = '60d5ecb8b3b3a72d9c8e4a11';
const mockSessionId = 'test-session-123';

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
    originalGoalFind = Goal.find;
    originalUserFindById = User.findById;
    originalConvFindOne = ConversationHistory.findOne;
    originalEnvGemini = process.env.GEMINI_API_KEY;
    originalEnvGroq = process.env.GROQ_API_KEY;
    originalEnvNvidia = process.env.NVIDIA_API_KEY;
    originalPrimaryProvider = process.env.LLM_PRIMARY_PROVIDER;
    savedMessages = [];

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
      message: 'Rebalance portfolio',
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
      message: 'What is diversification?',
      sessionId: mockSessionId,
    });

    assert.equal(callCount, 1);
    assert.equal(result.tool_results, undefined);
    assert.equal(result.validation_status, 'PASS');
    assert.match(result.response, /\[E_PROFILE_RISK\]/);
  });

  it('Phase 6: provider failure returns a deterministic evidence-backed fallback', async () => {
    axios.post = async () => {
      throw Object.assign(new Error('provider unavailable'), { code: 'ECONNRESET' });
    };

    const result = await processChat({
      userId: mockUserId,
      user: mockUser,
      message: 'Rebalance portfolio advice',
      sessionId: mockSessionId,
    });

    assert.equal(result.provider, 'DETERMINISTIC_TEMPLATE');
    assert.equal(result.fallback, true);
    assert.equal(result.tool_results, undefined);
    assert.match(result.response, /authoritative backend reports/i);
    assert.match(result.response, /\[E_PROFILE_RISK\]/);
  });
});
