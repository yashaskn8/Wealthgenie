import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { FinancialToolRegistry } from '../services/financialToolRegistry.js';
import { WealthGenieMcpServer } from '../mcp/wealthgenieMcpServer.js';
import { processChat } from '../services/geminiChatService.js';
import { ProviderManager } from '../services/providerAbstraction.js';
import FinancialProfile from '../models/FinancialProfile.js';
import FinancialProfileState from '../models/FinancialProfileState.js';
import Recommendation from '../models/Recommendation.js';
import RecommendationState from '../models/RecommendationState.js';
import RecommendationAllocationRevision from '../models/RecommendationAllocationRevision.js';
import Goal from '../models/Goal.js';
import User from '../models/User.js';
import ConversationHistory from '../models/ConversationHistory.js';
import { canonicalProfile } from './helpers/canonicalProfile.js';
import { installMockChatSessionStore } from './helpers/mockChatSessionStore.js';

const mockUserId = '60d5ecb8b3b3a72d9c8e4a11';
const mockSessionId = 'test-validation-session';

const mockUser = {
  _id: mockUserId,
  email: 'validation@example.com',
  name: 'Validation Test User',
};

const mockProfile = {
  _id: '60d5ecb8b3b3a72d9c8e4a22',
  userId: mockUserId,
  ...canonicalProfile({
    age: 28,
    monthlyTakeHome: 80000,
    monthlySavings: 15000,
    riskTolerance: 'Conservative',
  }),
};

describe('Tool Execution Error & Parameter Validation Fallback Tests', () => {
  // ── FinancialToolRegistry Direct Validation Tests ──

  it('executeTool returns graceful error for completely unknown tool name', async () => {
    const result = await FinancialToolRegistry.executeTool('imaginary_tool_xyz', { foo: 'bar' });
    assert.equal(result.success, false);
    assert.match(result.error, /Unknown tool/i);
    assert.equal(result.result, null);
    assert.ok(result.execution_time_ms >= 0, 'Must include execution_time_ms');
  });

  it('sip_projection rejects missing required field monthlyInvestment', async () => {
    const result = await FinancialToolRegistry.executeTool('sip_projection', {
      annualRate: 0.12,
      years: 10,
      // monthlyInvestment intentionally missing
    });
    assert.equal(result.success, false);
    assert.match(result.error, /monthlyInvestment/i);
  });

  it('sip_projection rejects monthlyInvestment below minimum (100)', async () => {
    const result = await FinancialToolRegistry.executeTool('sip_projection', {
      monthlyInvestment: 10, // below 100 min
      annualRate: 0.12,
      years: 10,
    });
    assert.equal(result.success, false);
    assert.match(result.error, /monthlyInvestment|must be greater|minimum/i);
  });

  it('sip_projection rejects annualRate above maximum (0.50)', async () => {
    const result = await FinancialToolRegistry.executeTool('sip_projection', {
      monthlyInvestment: 10000,
      annualRate: 0.99, // above 0.50 max
      years: 10,
    });
    assert.equal(result.success, false);
    assert.match(result.error, /annualRate|must be less|maximum/i);
  });

  it('lump_sum_projection rejects principal below minimum (1000)', async () => {
    const result = await FinancialToolRegistry.executeTool('lump_sum_projection', {
      principal: 100, // below 1000 min
      annualRate: 0.10,
      years: 5,
    });
    assert.equal(result.success, false);
    assert.match(result.error, /principal|must be greater|minimum/i);
  });

  it('lump_sum_projection rejects years above maximum (50)', async () => {
    const result = await FinancialToolRegistry.executeTool('lump_sum_projection', {
      principal: 500000,
      annualRate: 0.10,
      years: 100, // above 50 max
    });
    assert.equal(result.success, false);
    assert.match(result.error, /years|must be less|maximum/i);
  });

  it('tax_calculator rejects invalid regime value', async () => {
    const result = await FinancialToolRegistry.executeTool('tax_calculator', {
      income: 1500000,
      regime: 'mythical', // only 'new' or 'old' are valid
    });
    assert.equal(result.success, false);
    assert.match(result.error, /regime|must be one of/i);
  });

  it('tax_calculator accepts valid params and returns success', async () => {
    const result = await FinancialToolRegistry.executeTool('tax_calculator', {
      income: 1500000,
      incomeSource: 'salary',
      fiscalYear: 'FY2026-27',
      age: 35,
      regime: 'new',
      section80C: 0,
      nps80CCD1B: 0,
      section80D_self: 0,
      section80D_parents: 0,
      parentsSenior: false,
      hra: 0,
    });
    assert.equal(result.success, true);
    assert.ok(result.result, 'Must return a result object');
    assert.equal(result.result.regime, 'new');
  });

  it('xirr_calculator rejects cashflows with fewer than 2 entries', async () => {
    const result = await FinancialToolRegistry.executeTool('xirr_calculator', {
      cashflows: [{ amount: -100000, date: '2023-01-01' }],
    });
    assert.equal(result.success, false);
    assert.match(result.error, /cashflows|must contain at least|minimum/i);
  });

  it('reverse_sip rejects targetAmount below minimum (1000)', async () => {
    const result = await FinancialToolRegistry.executeTool('reverse_sip', {
      targetAmount: 100, // below 1000
      annualRate: 0.12,
      years: 10,
    });
    assert.equal(result.success, false);
    assert.match(result.error, /targetAmount|must be greater|minimum/i);
  });

  it('portfolio_optimizer rejects invalid strategy', async () => {
    const result = await FinancialToolRegistry.executeTool('portfolio_optimizer', {
      strategy: 'maximum_chaos',
      assets: ['Equity_MF', 'Debt_MF'],
    });
    assert.equal(result.success, false);
    assert.match(result.error, /strategy|must be one of/i);
  });

  it('portfolio_optimizer accepts valid min_variance strategy', async () => {
    const result = await FinancialToolRegistry.executeTool('portfolio_optimizer', {
      strategy: 'min_variance',
      assets: ['Equity_MF', 'Debt_MF', 'Gold'],
    });
    assert.equal(result.success, true);
    assert.equal(result.result.strategy, 'min_variance');
  });

  it('rebalance_calculator rejects missing required current_allocation', async () => {
    const result = await FinancialToolRegistry.executeTool('rebalance_calculator', {
      target_allocation: { Equity_MF: 50, Debt_MF: 50 },
      threshold: 5.0,
      // current_allocation intentionally missing
    });
    assert.equal(result.success, false);
    assert.match(result.error, /current_allocation|required/i);
  });

  it('rebalance_calculator rejects threshold above maximum (50)', async () => {
    const result = await FinancialToolRegistry.executeTool('rebalance_calculator', {
      current_allocation: { Equity_MF: 70, Debt_MF: 30 },
      target_allocation: { Equity_MF: 50, Debt_MF: 50 },
      threshold: 60, // above 50 max
    });
    assert.equal(result.success, false);
    assert.match(result.error, /threshold|must be less|maximum/i);
  });

  // ── MCP Server Unknown Tool Handling ──

  it('MCP server has no unscoped direct execution bypass', () => {
    assert.equal(WealthGenieMcpServer.executeTool, undefined);
    assert.equal(WealthGenieMcpServer.prototype.executeTool, undefined);
    assert.ok(WealthGenieMcpServer.getToolDefinitions({ transport: 'remote' }).length > 0);
  });

  // ── Rejects Unknown Keys at the strict calculation boundary ──

  it('sip_projection rejects unknown keys', async () => {
    const result = await FinancialToolRegistry.executeTool('sip_projection', {
      monthlyInvestment: 10000,
      annualRate: 0.12,
      years: 10,
      unknownJunkField: 'should be stripped',
      anotherUnknown: 42,
    });
    assert.equal(result.success, false);
    assert.match(result.error, /Invalid tool arguments/);
  });

  // ── processChat Tool Error Isolation via Two-Pass ──

  let originalPost;
  let originalProfileFindOne;
  let originalProfileStateFindOne;
  let originalRecFindOne;
  let originalRecommendationStateFindOne;
  let originalAllocationRevisionFindOne;
  let originalGoalFind;
  let originalUserFindById;
  let originalConvFindOne;
  let originalNvidiaKey;
  let originalPrimaryProvider;
  let savedMessages = [];
  let restoreChatStore;

  beforeEach(() => {
    originalPost = axios.post;
    originalProfileFindOne = FinancialProfile.findOne;
    originalProfileStateFindOne = FinancialProfileState.findOne;
    originalRecFindOne = Recommendation.findOne;
    originalRecommendationStateFindOne = RecommendationState.findOne;
    originalAllocationRevisionFindOne = RecommendationAllocationRevision.findOne;
    originalGoalFind = Goal.find;
    originalUserFindById = User.findById;
    originalConvFindOne = ConversationHistory.findOne;
    originalNvidiaKey = process.env.NVIDIA_API_KEY;
    originalPrimaryProvider = process.env.LLM_PRIMARY_PROVIDER;
    savedMessages = [];

    process.env.GEMINI_API_KEY = 'mock-gemini-key';
    process.env.GROQ_API_KEY = 'mock-groq-key';
    process.env.NVIDIA_API_KEY = '';
    process.env.LLM_PRIMARY_PROVIDER = 'GEMINI';

    ProviderManager.gemini.reset();
    ProviderManager.groq.reset();

    FinancialProfile.findOne = () => ({ sort() { return this; }, lean: async () => mockProfile });
    FinancialProfileState.findOne = () => ({ lean: async () => ({
      userId: mockUserId,
      currentProfileId: mockProfile._id,
      revision: 1,
      promotionFence: 1,
      resolutionStatus: 'CURRENT',
    }) });
    Recommendation.findOne = () => ({ sort: () => ({ lean: async () => null }) });
    RecommendationState.findOne = () => ({ lean: async () => null });
    RecommendationAllocationRevision.findOne = () => ({ sort() { return this; }, lean: async () => null });
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
    RecommendationState.findOne = originalRecommendationStateFindOne;
    RecommendationAllocationRevision.findOne = originalAllocationRevisionFindOne;
    Goal.find = originalGoalFind;
    User.findById = originalUserFindById;
    ConversationHistory.findOne = originalConvFindOne;
    restoreChatStore?.();
    if (originalNvidiaKey === undefined) delete process.env.NVIDIA_API_KEY; else process.env.NVIDIA_API_KEY = originalNvidiaKey;
    if (originalPrimaryProvider === undefined) delete process.env.LLM_PRIMARY_PROVIDER; else process.env.LLM_PRIMARY_PROVIDER = originalPrimaryProvider;
  });

  it('processChat: hostile request for an unknown financial tool is blocked before generation', async () => {
    let callCount = 0;

    axios.post = async (url) => {
      if (url.includes('generativelanguage.googleapis.com')) {
        callCount++;
        if (callCount === 1) {
          return {
            data: {
              candidates: [{
                content: {
                  parts: [{
                    functionCall: {
                      name: 'cryptocurrency_predictor', // doesn't exist
                      args: { coin: 'BTC', horizon: '1y' },
                    },
                  }],
                },
                finishReason: 'STOP',
              }],
              usageMetadata: { totalTokenCount: 80 },
            },
          };
        } else {
          return {
            data: {
              candidates: [{
                content: {
                  parts: [{ text: 'I could not compute cryptocurrency predictions, but here is general investment advice.' }],
                },
                finishReason: 'STOP',
              }],
              usageMetadata: { totalTokenCount: 100 },
            },
          };
        }
      }
      throw new Error('Unexpected URL');
    };

    const result = await processChat({
      userId: mockUserId,
      user: mockUser,
      message: 'Predict Bitcoin price',
      sessionId: mockSessionId,
    });

    assert.equal(callCount, 0, 'Injection guard must block external generation');
    const lastSavedModelMsg = savedMessages.filter(m => m.role === 'model').slice(-1)[0];
    assert.equal(lastSavedModelMsg.metadata.tool_outputs, undefined);
    assert.equal(lastSavedModelMsg.metadata.prompt_injection_detected, true);
    assert.equal(result.tool_results, undefined);
    assert.equal(result.provider, 'DETERMINISTIC_TEMPLATE');
    assert.doesNotMatch(result.response, /cryptocurrency|bitcoin/i);
  });

  it('processChat: provider tool-call output is not executed and fails closed', async () => {
    let callCount = 0;

    axios.post = async (url) => {
      if (url.includes('generativelanguage.googleapis.com')) {
        callCount++;
        if (callCount === 1) {
          return {
            data: {
              candidates: [{
                content: {
                  parts: [{
                    functionCall: {
                      name: 'sip_projection',
                      args: {
                        monthlyInvestment: -500, // negative, below min of 100
                        annualRate: 'not-a-number',
                        years: 10,
                      },
                    },
                  }],
                },
                finishReason: 'STOP',
              }],
              usageMetadata: { totalTokenCount: 70 },
            },
          };
        } else {
          return {
            data: {
              candidates: [{
                content: {
                  parts: [{ text: 'The SIP calculation encountered parameter issues. Please provide valid inputs.' }],
                },
                finishReason: 'STOP',
              }],
              usageMetadata: { totalTokenCount: 90 },
            },
          };
        }
      }
      throw new Error('Unexpected URL');
    };

    const result = await processChat({
      userId: mockUserId,
      user: mockUser,
      message: 'Calculate SIP with negative investment',
      sessionId: mockSessionId,
    });

    assert.equal(callCount, 1);
    const lastSavedModelMsg = savedMessages.filter(m => m.role === 'model').slice(-1)[0];
    assert.equal(lastSavedModelMsg.metadata.tool_outputs, undefined);
    assert.ok(lastSavedModelMsg.metadata.validation_reason_codes.includes('EMPTY_COMPLETION'));
    assert.equal(result.tool_results, undefined);
    assert.equal(result.provider, 'DETERMINISTIC_TEMPLATE');
  });

  it('processChat: all providers failing yields a deterministic profile-grounded response', async () => {
    axios.post = async () => {
      throw new Error('All providers catastrophically offline');
    };

    const result = await processChat({
      userId: mockUserId,
      user: mockUser,
      message: 'What should my portfolio allocation be?',
      sessionId: mockSessionId,
    });

    assert.equal(result.provider, 'DETERMINISTIC_TEMPLATE');
    assert.equal(result.fallback, true);
    assert.equal(result.tool_results, undefined);
    assert.ok(result.response.length > 50, 'Fallback must generate a meaningful response');
    assert.match(result.response, /authoritative backend reports/i);
  });

  it('processChat: tax stays unavailable without explicit tax-tool inputs', async () => {
    axios.post = async () => {
      throw Object.assign(new Error('provider unavailable'), { code: 'ECONNRESET' });
    };

    const result = await processChat({
      userId: mockUserId,
      user: mockUser,
      message: 'What tax regime should I choose?',
      sessionId: mockSessionId,
    });

    assert.equal(result.provider, 'DETERMINISTIC_TEMPLATE');
    assert.ok(result.unavailable_facts.includes('POST_TAX_RETURN_UNAVAILABLE_MISSING_TAX_INPUTS'));
    assert.equal(result.version, '3.0');
  });
});
