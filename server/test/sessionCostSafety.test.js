import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { processChat } from '../services/geminiChatService.js';
import { ProviderManager } from '../services/providerAbstraction.js';
import FinancialProfile from '../models/FinancialProfile.js';
import FinancialProfileState from '../models/FinancialProfileState.js';
import ConversationHistory from '../models/ConversationHistory.js';
import Recommendation from '../models/Recommendation.js';
import RecommendationState from '../models/RecommendationState.js';
import RecommendationAllocationRevision from '../models/RecommendationAllocationRevision.js';
import { canonicalProfile } from './helpers/canonicalProfile.js';
import { installMockChatSessionStore } from './helpers/mockChatSessionStore.js';

describe('grounded chat session-cost safety', () => {
  const userId = '64b0f0000000000000000001';
  let originals;
  let env;
  let session;
  let providerCalls;
  let restoreChatStore;

  beforeEach(() => {
    originals = {
      profileFindOne: FinancialProfile.findOne,
      profileStateFindOne: FinancialProfileState.findOne,
      conversationFindOne: ConversationHistory.findOne,
      recommendationFindOne: Recommendation.findOne,
      recommendationStateFindOne: RecommendationState.findOne,
      allocationRevisionFindOne: RecommendationAllocationRevision.findOne,
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
    FinancialProfile.findOne = () => ({ sort() { return this; }, lean: async () => ({
      _id: '64b0f0000000000000000002', userId,
      ...canonicalProfile({ age: 32, monthlySavings: 45000, investmentHorizonYears: 15 }),
    }) });
    FinancialProfileState.findOne = () => ({ lean: async () => ({
      userId,
      currentProfileId: '64b0f0000000000000000002',
      revision: 1,
      promotionFence: 1,
      resolutionStatus: 'CURRENT',
    }) });
    Recommendation.findOne = () => ({ sort: () => ({ lean: async () => null }) });
    RecommendationState.findOne = () => ({ lean: async () => null });
    RecommendationAllocationRevision.findOne = () => ({ sort() { return this; }, lean: async () => null });
    session = {
      userId,
      profileId: '64b0f0000000000000000002',
      session_id: 'cost-safety',
      messages: [],
      cumulative_tokens: 0,
      save: async function save() { return this; },
    };
    ConversationHistory.findOne = async () => session;
    restoreChatStore = installMockChatSessionStore(async () => session);
    providerCalls = 0;
    ProviderManager.gemini.generate = async () => {
      providerCalls += 1;
      const text = 'The final suitability ceiling is Moderate [E_PROFILE_RISK].';
      return {
        provider: 'gemini', model: 'gemini-cost-test', tokensUsed: 250,
        text: JSON.stringify({ text, evidenceIdsUsed: ['E_PROFILE_RISK'], claims: [{ text, evidenceIds: ['E_PROFILE_RISK'] }], financialClaims: [], unavailableFacts: [] }),
      };
    };
  });

  afterEach(() => {
    restoreChatStore?.();
    FinancialProfile.findOne = originals.profileFindOne;
    FinancialProfileState.findOne = originals.profileStateFindOne;
    ConversationHistory.findOne = originals.conversationFindOne;
    Recommendation.findOne = originals.recommendationFindOne;
    RecommendationState.findOne = originals.recommendationStateFindOne;
    RecommendationAllocationRevision.findOne = originals.allocationRevisionFindOne;
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

  it('counts only final provider usage and performs no LLM-controlled replan', async () => {
    const response = await processChat({ userId, user: {}, message: 'Given my profile, explain suitability.', sessionId: 'cost-safety' });
    assert.equal(providerCalls, 1);
    assert.equal(session.cumulative_tokens, 250);
    assert.equal(session.messages.at(-1).metadata.tokens_used, 250);
    assert.equal(response.provider, 'GEMINI');
    assert.equal(response.audit, undefined);
    assert.equal(response.replan_count, undefined);
  });

  it('does not contact any external provider after the cumulative token cap', async () => {
    session.cumulative_tokens = 52000;
    const response = await processChat({ userId, user: {}, message: 'Given my profile, explain suitability.', sessionId: 'cost-safety' });
    assert.equal(providerCalls, 0);
    assert.equal(response.provider, 'DETERMINISTIC_TEMPLATE');
    assert.equal(response.fallback, true);
    assert.equal(session.cumulative_tokens, 52000);
    assert.ok(session.messages.at(-1).metadata.validation_reason_codes.includes('PROVIDER_BUDGET_EXHAUSTED'));
  });

  it('persists no hidden reasoning or raw provider payload at any token count', async () => {
    ProviderManager.gemini.generate = async () => {
      providerCalls += 1;
      const text = 'The final suitability ceiling is Moderate [E_PROFILE_RISK].';
      return {
        provider: 'gemini', model: 'gemini-cost-test', tokensUsed: 13000,
        text: JSON.stringify({ text, evidenceIdsUsed: ['E_PROFILE_RISK'], claims: [{ text, evidenceIds: ['E_PROFILE_RISK'] }], financialClaims: [], unavailableFacts: [] }),
      };
    };
    await processChat({ userId, user: {}, message: 'Given my profile, explain suitability.', sessionId: 'cost-safety' });
    const metadata = session.messages.at(-1).metadata;
    assert.equal(metadata.tokens_used, 13000);
    assert.equal(metadata.chain_of_thought, undefined);
    assert.equal(metadata.raw_prompt, undefined);
    assert.equal(metadata.raw_provider_response, undefined);
    assert.equal(metadata.tool_outputs, undefined);
  });
});
