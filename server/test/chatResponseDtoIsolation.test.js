import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import chatRouter from '../routes/chatRoutes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import FinancialProfile from '../models/FinancialProfile.js';
import FinancialProfileState from '../models/FinancialProfileState.js';
import Recommendation from '../models/Recommendation.js';
import ConversationHistory from '../models/ConversationHistory.js';
import { ProviderManager } from '../services/providerAbstraction.js';
import { processChat } from '../services/geminiChatService.js';
import { installMockChatSessionStore } from './helpers/mockChatSessionStore.js';
import { withMockAuthAccountState } from './helpers/mockAuthAccountState.js';
import { withServer, rawRequest } from '../test-utils/httpTestUtils.js';
import { canonicalProfile } from './helpers/canonicalProfile.js';

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-wealthgenie-2026';
process.env.JWT_SECRET = JWT_SECRET;
const userId = '64b0f0000000000000000001';
const profile = {
  _id: '64b0f0000000000000000002',
  userId,
  ...canonicalProfile({ age: 32, monthlySavings: 50000, investmentHorizonYears: 15 }),
};
const token = jwt.sign({ userId, email: 'isolation@example.com' }, JWT_SECRET, { expiresIn: '1h' });

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/chat', chatRouter);
  app.use(errorHandler);
  return app;
}

function validProviderResult() {
  const text = 'The final suitability ceiling is Moderate [E_PROFILE_RISK].';
  return {
    provider: 'gemini',
    model: 'gemini-runtime-test',
    tokensUsed: 12,
    text: JSON.stringify({
      text,
      evidenceIdsUsed: ['E_PROFILE_RISK'],
      claims: [{ text, evidenceIds: ['E_PROFILE_RISK'] }],
      financialClaims: [],
      unavailableFacts: [],
    }),
  };
}

describe('grounded chat DTO and persistence isolation', () => {
  let originals;
  let env;
  let conversation;
  let restoreChatStore;
  let profileStateStatus;

  beforeEach(() => {
    originals = {
      profileFindOne: FinancialProfile.findOne,
      profileStateFindOne: FinancialProfileState.findOne,
      recommendationFindOne: Recommendation.findOne,
      conversationFindOne: ConversationHistory.findOne,
      geminiGenerate: ProviderManager.gemini.generate,
    };
    env = {
      nvidia: process.env.NVIDIA_API_KEY,
      gemini: process.env.GEMINI_API_KEY,
      groq: process.env.GROQ_API_KEY,
      primary: process.env.LLM_PRIMARY_PROVIDER,
    };
    process.env.NVIDIA_API_KEY = '';
    process.env.GEMINI_API_KEY = 'unit-test-only';
    process.env.GROQ_API_KEY = '';
    process.env.LLM_PRIMARY_PROVIDER = 'GEMINI';
    profileStateStatus = 'CURRENT';
    ProviderManager.gemini.reset();
    FinancialProfile.findOne = () => {
      const query = { sort: () => query, lean: async () => profile };
      return query;
    };
    FinancialProfileState.findOne = query => ({
      lean: async () => (String(query?.userId) === userId ? {
        userId,
        currentProfileId: profileStateStatus === 'CURRENT' ? profile._id : null,
        revision: profileStateStatus === 'CURRENT' ? 1 : 0,
        promotionFence: 0,
        resolutionStatus: profileStateStatus,
      } : null),
    });
    Recommendation.findOne = () => ({ sort: () => ({ lean: async () => null }) });
    conversation = {
      userId,
      profileId: profile._id,
      financialProfileStateRevision: 1,
      session_id: 'session-grounded',
      messages: [],
      cumulative_tokens: 0,
      save: async function save() { return this; },
    };
    ConversationHistory.findOne = async () => conversation;
    restoreChatStore = installMockChatSessionStore(async () => conversation);
    ProviderManager.gemini.generate = async () => validProviderResult();
  });

  afterEach(() => {
    restoreChatStore?.();
    FinancialProfile.findOne = originals.profileFindOne;
    FinancialProfileState.findOne = originals.profileStateFindOne;
    Recommendation.findOne = originals.recommendationFindOne;
    ConversationHistory.findOne = originals.conversationFindOne;
    ProviderManager.gemini.generate = originals.geminiGenerate;
    for (const [name, value] of Object.entries({
      NVIDIA_API_KEY: env.nvidia,
      GEMINI_API_KEY: env.gemini,
      GROQ_API_KEY: env.groq,
      LLM_PRIMARY_PROVIDER: env.primary,
    })) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });

  it('returns grounded metadata but never exposes raw prompts, tools, or audit internals', async () => {
    await withMockAuthAccountState(() => withServer(buildApp(), async baseUrl => {
      const response = await rawRequest(`${baseUrl}/api/chat/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ message: 'Why is my suitability Moderate?' }),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.version, '3.0');
      assert.equal(body.provider, 'GEMINI');
      assert.equal(body.model, 'gemini-runtime-test');
      assert.equal(body.grounding_version, 'grounded-financial-evidence-1.0.0');
      assert.equal(body.validation_status, 'PASS');
      assert.deepEqual(body.fallback_reason_codes, []);
      assert.deepEqual(body.evidence_ids_used, ['E_PROFILE_RISK', 'E_REGULATORY_NOTICE']);
      for (const forbidden of ['original_llm_response', 'execution_graph', 'tool_outputs', 'tool_calls', 'tool_results', 'replans', 'governance', 'verification', 'audit', 'state']) {
        assert.equal(body[forbidden], undefined, `${forbidden} must not be exposed`);
      }
    }));

    const modelMessage = conversation.messages.find(message => message.role === 'model');
    assert.ok(modelMessage);
    assert.equal(modelMessage.metadata.provider, 'GEMINI');
    assert.equal(modelMessage.metadata.model, 'gemini-runtime-test');
    assert.equal(modelMessage.metadata.validation_status, 'PASS');
    assert.equal(modelMessage.metadata.original_llm_response, undefined);
    assert.equal(modelMessage.metadata.tool_outputs, undefined);
    assert.equal(conversation.cumulative_tokens, 12);
  });

  it('rejects invalid provider content and persists only deterministic grounded fallback', async () => {
    ProviderManager.gemini.generate = async () => {
      const text = 'Use a 25% expected return [E_PROFILE_RISK].';
      return {
        provider: 'gemini', model: 'gemini-runtime-test', tokensUsed: 10,
        text: JSON.stringify({ text, evidenceIdsUsed: ['E_PROFILE_RISK'], claims: [{ text, evidenceIds: ['E_PROFILE_RISK'] }], financialClaims: [], unavailableFacts: [] }),
      };
    };
    const result = await processChat({
      userId, user: { email: 'isolation@example.com' }, message: 'Explain my plan.', sessionId: 'session-grounded',
    });
    assert.equal(result.provider, 'DETERMINISTIC_TEMPLATE');
    assert.equal(result.fallback, true);
    assert.doesNotMatch(result.response, /25%/);
    const saved = conversation.messages.find(message => message.role === 'model');
    assert.doesNotMatch(saved.content, /25%/);
    assert.ok(saved.metadata.validation_reason_codes.includes('LLM_GROUNDING_VALIDATION_FAILED'));
    assert.ok(result.fallback_reason_codes.includes('LLM_GROUNDING_VALIDATION_FAILED'));
    assert.ok(result.fallback_reason_codes.includes('UNSUPPORTED_FINANCIAL_NUMBER'));
    assert.ok(result.fallback_reason_codes.every(code => /^[A-Z][A-Z0-9_]+$/.test(code)));
  });

  it('uses the deterministic evidence template without contacting a provider after the session cap', async () => {
    conversation.cumulative_tokens = 50000;
    let providerCalls = 0;
    ProviderManager.gemini.generate = async () => { providerCalls += 1; return validProviderResult(); };
    const result = await processChat({
      userId, user: {}, message: 'Explain my plan.', sessionId: 'session-grounded',
    });
    assert.equal(providerCalls, 0);
    assert.equal(result.provider, 'DETERMINISTIC_TEMPLATE');
    assert.equal(result.fallback, true);
    assert.ok(conversation.messages.at(-1).metadata.validation_reason_codes.includes('PROVIDER_BUDGET_EXHAUSTED'));
  });

  it('returns a minimal system response when no Financial Profile exists', async () => {
    profileStateStatus = 'NO_CURRENT';
    FinancialProfile.findOne = () => ({ sort: () => ({ lean: async () => null }) });
    const result = await processChat({
      userId, user: {}, message: 'Hello', sessionId: 'session-grounded',
    });
    assert.equal(result.version, '3.0');
    assert.equal(result.grounded, false);
    assert.equal(result.provider, 'SYSTEM');
    assert.match(result.response, /complete the profile flow/i);
  });
});
