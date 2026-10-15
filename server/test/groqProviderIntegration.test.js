import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { processChat } from '../services/geminiChatService.js';
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
const mockSessionId = 'test-groq-session';

const mockUser = {
  _id: mockUserId,
  email: 'groqtest@example.com',
  name: 'Groq Test Investor',
};

const mockProfile = {
  _id: '60d5ecb8b3b3a72d9c8e4a22',
  userId: mockUserId,
  ...canonicalProfile({
    age: 35,
    monthlyTakeHome: 150000,
    monthlySavings: 40000,
    riskTolerance: 'Aggressive',
    investmentHorizonYears: 20,
    hasLumpSum: true,
    lumpSumAmount: 1000000,
  }),
};

describe('Groq Provider Native Tool-Calling Integration Tests', () => {
  let originalPost;
  let originalProfileFindOne;
  let originalProfileStateFindOne;
  let originalRecFindOne;
  let originalGoalFind;
  let originalUserFindById;
  let originalConvFindOne;
  let originalNvidiaKey;
  let originalGeminiKey;
  let originalGroqKey;
  let originalPrimaryProvider;
  let originalFallbackSetting;
  let restoreChatStore;
  let savedMessages = [];

  beforeEach(() => {
    originalPost = axios.post;
    originalProfileFindOne = FinancialProfile.findOne;
    originalProfileStateFindOne = FinancialProfileState.findOne;
    originalRecFindOne = Recommendation.findOne;
    originalGoalFind = Goal.find;
    originalUserFindById = User.findById;
    originalConvFindOne = ConversationHistory.findOne;
    originalNvidiaKey = process.env.NVIDIA_API_KEY;
    originalGeminiKey = process.env.GEMINI_API_KEY;
    originalGroqKey = process.env.GROQ_API_KEY;
    originalPrimaryProvider = process.env.LLM_PRIMARY_PROVIDER;
    originalFallbackSetting = process.env.LLM_GEMINI_FALLBACK_ENABLED;
    savedMessages = [];

    process.env.GEMINI_API_KEY = 'mock-gemini-key';
    process.env.GROQ_API_KEY = 'mock-groq-key';
    process.env.NVIDIA_API_KEY = '';
    process.env.LLM_PRIMARY_PROVIDER = 'GROQ';
    process.env.LLM_GEMINI_FALLBACK_ENABLED = 'false';

    ProviderManager.gemini.reset();
    ProviderManager.groq.reset();

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
    Recommendation.findOne = () => ({ sort: () => ({ lean: async () => null }) });
    Goal.find = () => ({ sort: () => ({ lean: async () => [] }) });
    User.findById = () => ({ select() { return this; }, lean: async () => mockUser });
    ConversationHistory.findOne = async () => ({
      userId: mockUserId,
      session_id: mockSessionId,
      messages: savedMessages,
      save: async function () { return true; },
    });
    restoreChatStore = installMockChatSessionStore(async () => ({
      userId: mockUserId,
      profileId: mockProfile._id,
      profileVersion: mockProfile.version || 1,
      session_id: mockSessionId,
      messages: savedMessages,
      message_sequence: 0,
      session_version: 1,
      cumulative_tokens: 0,
      reserved_tokens: 0,
    }));
  });

  afterEach(() => {
    axios.post = originalPost;
    FinancialProfile.findOne = originalProfileFindOne;
    FinancialProfileState.findOne = originalProfileStateFindOne;
    Recommendation.findOne = originalRecFindOne;
    Goal.find = originalGoalFind;
    User.findById = originalUserFindById;
    ConversationHistory.findOne = originalConvFindOne;
    restoreChatStore?.();
    if (originalNvidiaKey === undefined) delete process.env.NVIDIA_API_KEY; else process.env.NVIDIA_API_KEY = originalNvidiaKey;
    if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = originalGeminiKey;
    if (originalGroqKey === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = originalGroqKey;
    if (originalPrimaryProvider === undefined) delete process.env.LLM_PRIMARY_PROVIDER; else process.env.LLM_PRIMARY_PROVIDER = originalPrimaryProvider;
    if (originalFallbackSetting === undefined) delete process.env.LLM_GEMINI_FALLBACK_ENABLED; else process.env.LLM_GEMINI_FALLBACK_ENABLED = originalFallbackSetting;
  });

  // ── Groq Adapter Unit Tests ──

  it('GroqProviderAdapter parses OpenAI-format tool_calls into normalized { tool, arguments } shape', async () => {
    let groqCallCount = 0;

    axios.post = async (url) => {
      if (url.includes('api.groq.com')) {
        groqCallCount++;
        return {
          data: {
            choices: [{
              message: {
                content: null,
                tool_calls: [
                  {
                    function: {
                      name: 'tax_calculator',
                      arguments: JSON.stringify({ income: 1500000, regime: 'new' }),
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { total_tokens: 95 },
          },
        };
      }
      throw new Error('Unexpected URL');
    };

    const result = await ProviderManager.groq.generate({
      systemPrompt: 'You are a financial advisor.',
      recentHistory: [{ role: 'user', parts: [{ text: 'Calculate my tax' }] }],
      tools: [{ name: 'tax_calculator', description: 'Tax calc', parameters: { type: 'object' } }],
    });

    assert.equal(groqCallCount, 1);
    assert.equal(result.provider, 'groq');
    assert.equal(result.tool_calls.length, 1);
    assert.equal(result.tool_calls[0].tool, 'tax_calculator');
    assert.deepEqual(result.tool_calls[0].arguments, { income: 1500000, regime: 'new' });
  });

  it('GroqProviderAdapter handles stringified JSON arguments correctly', async () => {
    axios.post = async (url) => {
      if (url.includes('api.groq.com')) {
        return {
          data: {
            choices: [{
              message: {
                content: null,
                tool_calls: [{
                  function: {
                    name: 'sip_projection',
                    arguments: '{"monthlyInvestment":25000,"annualRate":0.12,"years":15}',
                  },
                }],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { total_tokens: 80 },
          },
        };
      }
      throw new Error('Unexpected URL');
    };

    const result = await ProviderManager.groq.generate({
      systemPrompt: 'Test',
      recentHistory: [{ role: 'user', parts: [{ text: 'SIP calc' }] }],
    });

    assert.equal(result.tool_calls[0].arguments.monthlyInvestment, 25000);
    assert.equal(result.tool_calls[0].arguments.annualRate, 0.12);
    assert.equal(result.tool_calls[0].arguments.years, 15);
  });

  it('GroqProviderAdapter handles malformed/unparseable arguments gracefully (defaults to {})', async () => {
    axios.post = async (url) => {
      if (url.includes('api.groq.com')) {
        return {
          data: {
            choices: [{
              message: {
                content: null,
                tool_calls: [{
                  function: {
                    name: 'sip_projection',
                    arguments: 'THIS IS NOT JSON AT ALL',
                  },
                }],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { total_tokens: 50 },
          },
        };
      }
      throw new Error('Unexpected URL');
    };

    const result = await ProviderManager.groq.generate({
      systemPrompt: 'Test',
      recentHistory: [{ role: 'user', parts: [{ text: 'broken args' }] }],
    });

    assert.equal(result.tool_calls.length, 1);
    assert.equal(result.tool_calls[0].tool, 'sip_projection');
    assert.deepEqual(result.tool_calls[0].arguments, {}, 'Malformed arguments must default to empty object');
  });

  it('GroqProviderAdapter returns null when GROQ_API_KEY is missing', async () => {
    const savedKey = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;

    const result = await ProviderManager.groq.generate({
      systemPrompt: 'Test',
      recentHistory: [],
    });

    assert.equal(result, null, 'Must return null when API key is missing');
    process.env.GROQ_API_KEY = savedKey;
  });

  it('GroqProviderAdapter returns null when circuit breaker is open', async () => {
    ProviderManager.groq.reset();
    for (let failure = 0; failure < ProviderManager.groq.failureThreshold; failure += 1) {
      ProviderManager.groq.recordFailure(ProviderManager.groq.acquirePermit());
    }
    assert.equal(ProviderManager.groq.circuitState, 'OPEN');

    const result = await ProviderManager.groq.generate({
      systemPrompt: 'Test',
      recentHistory: [],
    });

    assert.equal(result, null, 'Must return null when circuit is open');
    ProviderManager.groq.reset();
  });

  it('Groq diagnostics retain sanitized parsed-response usage and request ID', async () => {
    const responseText = JSON.stringify({
      text: 'A synthetic fact is supported [E_SYNTHETIC].',
      evidenceIdsUsed: ['E_SYNTHETIC'],
      claims: [{ text: 'A synthetic fact is supported [E_SYNTHETIC].', evidenceIds: ['E_SYNTHETIC'] }],
      financialClaims: [],
      unavailableFacts: [],
    });
    let requestBody;
    axios.post = async (_url, body) => {
      requestBody = body;
      return ({
      status: 200,
      headers: { 'x-request-id': 'req_test-123' },
      data: {
        model: 'openai/gpt-oss-120b',
        choices: [{ message: { content: responseText }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 111,
          completion_tokens: 45,
          total_tokens: 156,
          completion_tokens_details: { reasoning_tokens: 12 },
        },
      },
      });
    };

    const result = await ProviderManager.groq.generate({
      systemPrompt: 'Use the supplied synthetic evidence only.',
      recentHistory: [{ role: 'user', parts: [{ text: 'Explain the synthetic evidence.' }] }],
      maxTokens: 512,
      jsonMode: true,
      outputContract: 'GROUNDED_EXPLANATION_V1',
    });

    assert.equal(result.provider, 'groq');
    assert.equal(result.diagnostics.httpStatus, 200);
    assert.equal(result.diagnostics.providerRequestId, 'req_test-123');
    assert.equal(result.diagnostics.providerPromptTokens, 111);
    assert.equal(result.diagnostics.providerCompletionTokens, 45);
    assert.equal(result.diagnostics.providerReasoningTokens, 12);
    assert.equal(result.diagnostics.providerReportedTokens, 156);
    assert.equal(result.diagnostics.completionReason, 'stop');
    assert.equal(requestBody.reasoning_effort, 'low');
    assert.equal(requestBody.include_reasoning, false);
    assert.equal(Object.hasOwn(requestBody, 'reasoning_format'), false);
    assert.equal(result.diagnostics.reasoningEffort, 'low');
    assert.equal(result.diagnostics.reasoningIncluded, false);
    assert.equal(result.diagnostics.reasoningFormat, null);
  });

  it('Groq JSON Object Mode rejects a length-finished response and reports reasoning usage only as diagnostics', async () => {
    const responseText = JSON.stringify({
      text: 'A synthetic fact is supported [E_SYNTHETIC].',
      evidenceIdsUsed: ['E_SYNTHETIC'],
      claims: [{ text: 'A synthetic fact is supported [E_SYNTHETIC].', evidenceIds: ['E_SYNTHETIC'] }],
      financialClaims: [],
      unavailableFacts: [],
    });
    axios.post = async () => ({
      status: 200,
      data: {
        model: 'openai/gpt-oss-120b',
        choices: [{ message: { content: responseText }, finish_reason: 'length' }],
        usage: {
          prompt_tokens: 307,
          completion_tokens: 512,
          total_tokens: 819,
          completion_tokens_details: { reasoning_tokens: 176 },
        },
      },
    });

    const result = await ProviderManager.groq.generate({
      systemPrompt: 'Use only synthetic evidence.',
      recentHistory: [{ role: 'user', parts: [{ text: 'Explain the synthetic fact.' }] }],
      maxTokens: 512,
      jsonMode: true,
      outputContract: 'GROUNDED_EXPLANATION_V1',
      providerOutputMode: 'GROQ_JSON_OBJECT',
    });

    assert.equal(result.wasCompleted, false);
    assert.equal(result.diagnostics.completionReason, 'length');
    assert.equal(result.diagnostics.providerReasoningTokens, 176);
    assert.equal(result.diagnostics.providerCompletionTokens, 512);
    assert.equal(result.tokensUsed, 819, 'the reasoning subtotal is not added a second time to provider-reported total usage');
    assert.equal(ProviderManager.groq.lastFailureReason, 'PROVIDER_INCOMPLETE_OUTPUT');
  });

  it('Groq error diagnostics keep response identity without retaining provider error text', async () => {
    axios.post = async () => {
      throw Object.assign(new Error('sensitive provider response text'), {
        response: {
          status: 400,
          headers: { 'x-request-id': 'req_bad-schema-456' },
          data: { error: { code: 'JSON_VALIDATE_FAILED', message: 'sensitive body detail' } },
        },
      });
    };

    const result = await ProviderManager.groq.generate({
      systemPrompt: 'Synthetic test request.',
      recentHistory: [],
      maxTokens: 512,
      jsonMode: true,
      outputContract: 'GROUNDED_EXPLANATION_V1',
    });
    const diagnostics = ProviderManager.groq.lastResponseDiagnostics;

    assert.equal(result, null);
    assert.equal(diagnostics.httpStatus, 400);
    assert.equal(diagnostics.errorClassification, 'PROVIDER_BAD_REQUEST');
    assert.equal(diagnostics.providerErrorCode, 'JSON_VALIDATE_FAILED');
    assert.equal(diagnostics.providerRequestId, 'req_bad-schema-456');
    assert.equal(diagnostics.providerPromptTokens, null);
    assert.equal(diagnostics.providerCompletionTokens, null);
    assert.equal(diagnostics.providerReportedTokens, null);
    assert.doesNotMatch(JSON.stringify(diagnostics), /sensitive|mock-groq-key/i);
  });

  it('Groq error diagnostics tolerate malformed provider detail shapes without exposing them', async () => {
    axios.post = async () => {
      throw Object.assign(new Error('sensitive provider response text'), {
        response: {
          status: 400,
          data: { error: { code: 'INVALID_REQUEST', details: 'sensitive malformed detail payload' } },
        },
      });
    };

    const result = await ProviderManager.groq.generate({
      systemPrompt: 'Synthetic test request.',
      recentHistory: [],
      maxTokens: 32,
      jsonMode: true,
      outputContract: 'GROUNDED_EXPLANATION_V1',
    });
    const diagnostics = ProviderManager.groq.lastResponseDiagnostics;

    assert.equal(result, null);
    assert.equal(diagnostics.errorClassification, 'PROVIDER_BAD_REQUEST');
    assert.equal(diagnostics.providerErrorCode, 'INVALID_REQUEST');
    assert.equal(diagnostics.providerErrorField, null);
    assert.doesNotMatch(JSON.stringify(diagnostics), /sensitive malformed detail payload|sensitive provider response text/i);
  });

  it('GroqProviderAdapter records failure and opens circuit after 3 consecutive HTTP errors', async () => {
    ProviderManager.groq.reset(); // reset

    axios.post = async () => { throw Object.assign(new Error('provider unavailable'), { response: { status: 503 } }); };

    await ProviderManager.groq.generate({ systemPrompt: 'test', recentHistory: [] });
    assert.equal(ProviderManager.groq.failureCount, 1);
    assert.equal(ProviderManager.groq.isHealthy(), true);

    await ProviderManager.groq.generate({ systemPrompt: 'test', recentHistory: [] });
    assert.equal(ProviderManager.groq.failureCount, 2);
    assert.equal(ProviderManager.groq.isHealthy(), true);

    await ProviderManager.groq.generate({ systemPrompt: 'test', recentHistory: [] });
    assert.equal(ProviderManager.groq.failureCount, 3);
    assert.equal(ProviderManager.groq.isHealthy(), false, 'Circuit must open after 3 failures');

    // Reset for other tests
    ProviderManager.groq.reset();
  });

  // ── Groq grounded explanation integration via processChat ──

  it('Groq primary receives one read-only grounded request with no tool surface', async () => {
    let groqCallCount = 0;
    let requestBody;

    axios.post = async (url, body) => {
      // Gemini fails
      if (url.includes('generativelanguage.googleapis.com')) {
        throw Object.assign(new Error('provider unavailable'), { response: { status: 503 } });
      }

      if (url.includes('api.groq.com')) {
        groqCallCount++;
        requestBody = body;
        const text = 'The profile age is 35 years [E_PROFILE_AGE].';
        return { data: {
          model: 'openai/gpt-oss-120b',
          choices: [{ message: { content: JSON.stringify({
            text, evidenceIdsUsed: ['E_PROFILE_AGE'], claims: [{ text, evidenceIds: ['E_PROFILE_AGE'] }], financialClaims: [], unavailableFacts: [],
          }) }, finish_reason: 'stop' }],
          usage: { total_tokens: 80 },
        } };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const result = await processChat({
      userId: mockUserId,
      user: mockUser,
      message: 'Explain my age evidence.',
      sessionId: mockSessionId,
    });

    assert.equal(groqCallCount, 1);
    assert.equal(requestBody.tools, undefined);
    assert.equal(requestBody.response_format.type, 'json_schema');
    assert.equal(requestBody.response_format.json_schema.name, 'grounded_explanation_v1');
    assert.equal(requestBody.response_format.json_schema.strict, true);
    assert.equal(requestBody.max_completion_tokens, 1200);
    assert.equal(result.provider, 'GROQ');
    assert.equal(result.model, 'openai/gpt-oss-120b');
    const lastSavedModelMsg = savedMessages.filter(m => m.role === 'model').slice(-1)[0];
    assert.equal(lastSavedModelMsg.metadata.tool_outputs, undefined);
    assert.equal(result.tool_results, undefined);
    assert.match(result.response, /35 years \[E_PROFILE_AGE\]/);
  });

  it('Groq tool-call-only output is never executed and fails closed', async () => {
    let groqCallCount = 0;

    axios.post = async (url) => {
      if (url.includes('generativelanguage.googleapis.com')) {
        throw Object.assign(new Error('provider unavailable'), { code: 'ECONNRESET' });
      }

      if (url.includes('api.groq.com')) {
        groqCallCount++;
        return { data: {
          model: 'openai/gpt-oss-120b',
          choices: [{ message: { content: null, tool_calls: [{
            function: { name: 'portfolio_optimizer', arguments: '{}' },
          }] }, finish_reason: 'tool_calls' }],
          usage: { total_tokens: 50 },
        } };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const result = await processChat({
      userId: mockUserId,
      user: mockUser,
      message: 'Calculate my SIP projection and tax',
      sessionId: mockSessionId,
    });

    assert.equal(groqCallCount, 1);
    assert.equal(result.provider, 'DETERMINISTIC_TEMPLATE');
    const lastSavedModelMsg = savedMessages.filter(m => m.role === 'model').slice(-1)[0];
    assert.equal(lastSavedModelMsg.metadata.tool_outputs, undefined);
    assert.ok(lastSavedModelMsg.metadata.validation_reason_codes.includes('EMPTY_COMPLETION'));
    assert.equal(result.tool_results, undefined);
  });

  it('Groq direct answer: non-tool query completes in single pass without Pass 2', async () => {
    let groqCallCount = 0;

    axios.post = async (url) => {
      if (url.includes('generativelanguage.googleapis.com')) {
        throw Object.assign(new Error('provider unavailable'), { code: 'ECONNRESET' });
      }

      if (url.includes('api.groq.com')) {
        groqCallCount++;
        const text = 'The profile age is 35 years [E_PROFILE_AGE].';
        return { data: {
          model: 'openai/gpt-oss-120b',
          choices: [{ message: { content: JSON.stringify({
            text, evidenceIdsUsed: ['E_PROFILE_AGE'], claims: [{ text, evidenceIds: ['E_PROFILE_AGE'] }], financialClaims: [], unavailableFacts: [],
          }) }, finish_reason: 'stop' }],
          usage: { total_tokens: 60 },
        } };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const result = await processChat({
      userId: mockUserId,
      user: mockUser,
      message: 'Explain my age evidence.',
      sessionId: mockSessionId,
    });

    assert.equal(groqCallCount, 1, 'Non-tool query must complete in single Groq pass');
    assert.equal(result.provider, 'GROQ');
    assert.equal(result.tool_results, undefined);
    assert.match(result.response, /35 years \[E_PROFILE_AGE\]/);
  });
});
