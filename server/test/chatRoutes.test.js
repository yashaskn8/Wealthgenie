import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import chatRouter from '../routes/chatRoutes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { withServer, rawRequest } from '../test-utils/httpTestUtils.js';
import FinancialProfile from '../models/FinancialProfile.js';
import FinancialProfileState from '../models/FinancialProfileState.js';
import Recommendation from '../models/Recommendation.js';
import RecommendationState from '../models/RecommendationState.js';
import RecommendationAllocationRevision from '../models/RecommendationAllocationRevision.js';
import Goal from '../models/Goal.js';
import ConversationHistory from '../models/ConversationHistory.js';
import User from '../models/User.js';
import { defaultChatSessionStore } from '../services/chatSessionStore.js';
import { ProviderManager } from '../services/providerAbstraction.js';
import { resolveCurrentChatSessionBinding } from '../services/geminiChatService.js';
import { canonicalProfile } from './helpers/canonicalProfile.js';
import { installMockChatSessionStore } from './helpers/mockChatSessionStore.js';
import { assertRuntimeResponseMatchesContract } from './helpers/openapiRuntimeContract.js';

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-wealthgenie-2026';
process.env.JWT_SECRET = JWT_SECRET;

const mockUserId = '60d5ecb8b3b3a72d9c8e4a11';
const validToken = jwt.sign({ userId: mockUserId, email: 'test@example.com' }, JWT_SECRET, { expiresIn: '1h' });

const mockProfile = {
  _id: '60d5ecb8b3b3a72d9c8e4a22',
  userId: mockUserId,
  ...canonicalProfile({ age: 30, monthlySavings: 25000, investmentHorizonYears: 15 }),
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/chat', chatRouter);
  app.use(errorHandler);
  return app;
}

describe('Chat Routes Integration & Input Validation Tests', () => {
  let originalProfileFindOne;
  let originalProfileStateFindOne;
  let originalRecFindOne;
  let originalRecommendationStateFindOne;
  let originalAllocationRevisionFindOne;
  let originalGoalFind;
  let originalConvFindOne;
  let originalConvFind;
  let originalUserFindById;
  let originalConnectionReadyState;
  let restoreChatStore;
  let lastHistoryQuery;

  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'mock-gemini-key';
    process.env.GROQ_API_KEY = 'mock-groq-key';
    ProviderManager.gemini.reset();
    ProviderManager.groq.reset();

    originalProfileFindOne = FinancialProfile.findOne;
    originalProfileStateFindOne = FinancialProfileState.findOne;
    originalRecFindOne = Recommendation.findOne;
    originalRecommendationStateFindOne = RecommendationState.findOne;
    originalAllocationRevisionFindOne = RecommendationAllocationRevision.findOne;
    originalGoalFind = Goal.find;
    originalConvFindOne = ConversationHistory.findOne;
    originalConvFind = ConversationHistory.find;
    originalUserFindById = User.findById;
    originalConnectionReadyState = mongoose.connection.readyState;
    mongoose.connection.readyState = 1;

    FinancialProfile.findOne = query => ({
      sort() { return this; },
      lean: async () => (query?.userId === mockUserId ? mockProfile : null),
    });
    FinancialProfileState.findOne = query => ({
      lean: async () => (query?.userId === mockUserId ? {
        userId: mockUserId,
        currentProfileId: mockProfile._id,
        revision: 1,
        promotionFence: 1,
        resolutionStatus: 'CURRENT',
      } : {
        userId: query?.userId,
        currentProfileId: null,
        revision: 0,
        promotionFence: 0,
        resolutionStatus: 'NO_CURRENT',
      }),
    });

    Recommendation.findOne = () => ({
      sort: () => ({
        lean: async () => null,
      }),
    });
    RecommendationState.findOne = () => ({ lean: async () => null });
    RecommendationAllocationRevision.findOne = () => ({ sort() { return this; }, lean: async () => null });

    Goal.find = () => ({
      sort: () => ({
        lean: async () => [],
      }),
    });

    ConversationHistory.findOne = async (query) => ({
      userId: query?.userId || mockUserId,
      session_id: query?.session_id || 'test-session-123',
      messages: [],
      save: async () => true,
    });
    ConversationHistory.find = query => {
      lastHistoryQuery = query;
      return ({
      sort() { return this; },
      limit() { return this; },
      select() { return this; },
      lean: async () => [],
      });
    };
    restoreChatStore = installMockChatSessionStore(async ({ userId, sessionId }) => ({
      userId,
      profileId: mockProfile._id,
      profileVersion: mockProfile.version || 1,
      profileInputHash: null,
      session_id: sessionId,
      messages: [],
      message_sequence: 0,
      session_version: 1,
      cumulative_tokens: 0,
      reserved_tokens: 0,
    }));

    User.findById = () => ({
      select() { return this; },
      lean: async () => ({ role: 'user', name: 'Test User', email: 'test@example.com' }),
    });
  });

  afterEach(() => {
    FinancialProfile.findOne = originalProfileFindOne;
    FinancialProfileState.findOne = originalProfileStateFindOne;
    Recommendation.findOne = originalRecFindOne;
    RecommendationState.findOne = originalRecommendationStateFindOne;
    RecommendationAllocationRevision.findOne = originalAllocationRevisionFindOne;
    Goal.find = originalGoalFind;
    ConversationHistory.findOne = originalConvFindOne;
    ConversationHistory.find = originalConvFind;
    User.findById = originalUserFindById;
    mongoose.connection.readyState = originalConnectionReadyState;
    restoreChatStore?.();
  });

  it('POST /api/chat/message rejects unauthenticated request with 401', async () => {
    await withServer(buildApp(), async (baseUrl) => {
      const res = await rawRequest(`${baseUrl}/api/chat/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'Hello' }),
      });
      assert.equal(res.status, 401);
      assertRuntimeResponseMatchesContract({
        method: 'POST', path: '/api/chat/message', status: res.status,
        contentType: res.headers.get('content-type'), body: await res.json(),
      });
    });
  });

  it('POST /api/chat/message rejects empty message with 400 Bad Request', async () => {
    await withServer(buildApp(), async (baseUrl) => {
      const res = await rawRequest(`${baseUrl}/api/chat/message`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${validToken}`,
        },
        body: JSON.stringify({ message: '   ' }),
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assertRuntimeResponseMatchesContract({
        method: 'POST', path: '/api/chat/message', status: res.status,
        contentType: res.headers.get('content-type'), body: data,
      });
      assert.match(data.error || data.details?.[0], /Validation failed|cannot be empty/);
    });
  });

  it('POST /api/chat/message rejects message exceeding 1000 chars with 400', async () => {
    await withServer(buildApp(), async (baseUrl) => {
      const hugeMessage = 'A'.repeat(1001);
      const res = await rawRequest(`${baseUrl}/api/chat/message`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${validToken}`,
        },
        body: JSON.stringify({ message: hugeMessage }),
      });
      assert.equal(res.status, 400);
      assertRuntimeResponseMatchesContract({
        method: 'POST', path: '/api/chat/message', status: res.status,
        contentType: res.headers.get('content-type'), body: await res.json(),
      });
    });
  });

  it('same literal session ID never reveals or closes another user conversation over HTTP', async () => {
    const otherUserId = '60d5ecb8b3b3a72d9c8e4a99';
    const otherToken = jwt.sign({ userId: otherUserId, email: 'other@example.com' }, JWT_SECRET, { expiresIn: '1h' });
    const originalFind = ConversationHistory.find;
    const originalClose = defaultChatSessionStore.close;
    const binding = await resolveCurrentChatSessionBinding({ userId: mockUserId });
    assert.ok(binding);
    const ownerConversation = {
      ...binding,
      userId: mockUserId,
      session_id: 'shared-name',
      is_active: true,
      messages: [{ role: 'user', content: 'private owner message', sourceIds: ['private-source'] }],
      message_count: 1,
    };
    const staleConversation = {
      ...ownerConversation,
      profileInputHash: 'stale-profile-input-hash',
      messages: [{ role: 'user', content: 'stale private owner message' }],
    };
    const queries = [];
    let closedBy;
    ConversationHistory.find = query => {
      queries.push(query);
      const matchesQuery = conversation => Object.entries(query).every(([key, expected]) => (
        expected == null && conversation[key] == null
          ? true
          : String(conversation[key]) === String(expected)
      ));
      const conversations = String(query.userId) === mockUserId
        ? [ownerConversation, staleConversation].filter(matchesQuery)
        : [];
      return {
        sort() { return this; },
        limit() { return this; },
        select() { return this; },
        lean: async () => conversations,
      };
    };
    defaultChatSessionStore.close = async input => { closedBy = input; };

    try {
      await withServer(buildApp(), async baseUrl => {
        const ownerResponse = await rawRequest(`${baseUrl}/api/chat/history?session_id=shared-name`, {
          headers: { authorization: `Bearer ${validToken}` },
        });
        assert.equal(ownerResponse.status, 200);
        const ownerBody = await ownerResponse.json();
        assertRuntimeResponseMatchesContract({
          method: 'GET', path: '/api/chat/history', status: ownerResponse.status,
          contentType: ownerResponse.headers.get('content-type'), body: ownerBody,
        });
        assert.equal(ownerBody.conversations[0].messages[0].content, 'private owner message');
        assert.equal(ownerBody.conversations.length, 1);
        assert.ok([
          'profileId',
          'profileVersion',
          'financialProfileStateRevision',
          'profileInputHash',
          'sourceRecommendationId',
          'sourceAllocationRevisionId',
          'sourceRecommendationFingerprint',
          'sourcePortfolioFingerprint',
        ].every(key => Object.hasOwn(queries[0], key)));

        const otherResponse = await rawRequest(`${baseUrl}/api/chat/history?session_id=shared-name`, {
          headers: { authorization: `Bearer ${otherToken}` },
        });
        assert.equal(otherResponse.status, 200);
        const otherBody = await otherResponse.json();
        assertRuntimeResponseMatchesContract({
          method: 'GET', path: '/api/chat/history', status: otherResponse.status,
          contentType: otherResponse.headers.get('content-type'), body: otherBody,
        });
        assert.deepEqual(otherBody.conversations, []);
        assert.deepEqual(queries.map(query => String(query.userId)), [mockUserId]);

        const deleteResponse = await rawRequest(`${baseUrl}/api/chat/session/shared-name`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${otherToken}` },
        });
        assert.equal(deleteResponse.status, 200);
        assertRuntimeResponseMatchesContract({
          method: 'DELETE', path: '/api/chat/session/{sessionId}', status: deleteResponse.status,
          contentType: deleteResponse.headers.get('content-type'), body: await deleteResponse.json(),
        });
        assert.deepEqual(closedBy, { userId: otherUserId, sessionId: 'shared-name' });
      });
    } finally {
      ConversationHistory.find = originalFind;
      defaultChatSessionStore.close = originalClose;
    }
  });

  // ── MCP Two-Pass Contract Protocol & Route Coverage ──
  // Cross-Reference: Service-level execution mechanics are tested in server/test/twoPassChatLoop.test.js and server/test/geminiChatService.test.js

  it('POST /api/chat/message responds with 200 and complete V3 contract response shape', async () => {
    await withServer(buildApp(), async (baseUrl) => {
      const res = await rawRequest(`${baseUrl}/api/chat/message`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${validToken}`,
        },
        body: JSON.stringify({ message: 'What is my optimal tax regime?' }),
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assertRuntimeResponseMatchesContract({
        method: 'POST', path: '/api/chat/message', status: res.status,
        contentType: res.headers.get('content-type'), body: data,
      });
      assert.equal(typeof data.response, 'string');
      assert.equal(typeof data.session_id, 'string');
      assert.equal(data.version, '3.0');
      assert.equal(typeof data.latency_ms, 'number');
      assert.equal(typeof data.grounded, 'boolean');
      assert.ok(Array.isArray(data.citations), 'Response must contain citations array');
      assert.ok(Array.isArray(data.action_cards), 'Response must contain action_cards array');

      // Negative Security Assertions: Internal audit/governance/raw LLM fields MUST NOT leak to client
      assert.equal(data.audit, undefined, 'Response must NOT contain internal audit object');
      assert.equal(data.original_llm_response, undefined, 'Response must NOT contain raw pre-compliance LLM output');
      assert.equal(data.execution_graph, undefined, 'Response must NOT contain internal execution graph');
      assert.equal(data.tool_outputs, undefined, 'Response must NOT contain raw tool outputs');
      assert.equal(data.tool_requests, undefined, 'Response must NOT contain raw tool requests');
      assert.equal(data.tool_calls, undefined, 'Response must NOT contain raw function calling payload');
      assert.equal(data.tool_results, undefined, 'Response must NOT contain raw tool execution results');
      assert.equal(data.governance, undefined, 'Response must NOT contain trace graph governance metadata');
      assert.equal(data.verification, undefined, 'Response must NOT contain internal verification metadata');
      assert.equal(data.explainability, undefined, 'Response must NOT contain internal explainability object');
    });
  });

  it('POST /api/chat/message invokes one grounded read-only generation with no financial tools', async () => {
    const originalGenerate = ProviderManager.gemini.generate;
    const originalNvidia = process.env.NVIDIA_API_KEY;
    const originalPrimary = process.env.LLM_PRIMARY_PROVIDER;
    let callCount = 0;
    let generationArgs;
    process.env.NVIDIA_API_KEY = '';
    process.env.LLM_PRIMARY_PROVIDER = 'GEMINI';
    ProviderManager.gemini.generate = async args => {
      callCount += 1;
      generationArgs = args;
      const text = 'The final suitability ceiling is Moderate [E_PROFILE_RISK].';
      return {
        provider: 'gemini', model: 'gemini-route-test', tokensUsed: 10,
        text: JSON.stringify({
          text,
          evidenceIdsUsed: ['E_PROFILE_RISK'],
          claims: [{ text, evidenceIds: ['E_PROFILE_RISK'] }],
          financialClaims: [],
          unavailableFacts: [],
        }),
      };
    };

    try {
      await withServer(buildApp(), async (baseUrl) => {
        const res = await rawRequest(`${baseUrl}/api/chat/message`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${validToken}`,
          },
          body: JSON.stringify({ message: 'Explain my suitability.' }),
        });

        assert.equal(res.status, 200);
        const data = await res.json();
        assertRuntimeResponseMatchesContract({
          method: 'POST', path: '/api/chat/message', status: res.status,
          contentType: res.headers.get('content-type'), body: data,
        });
        assert.equal(callCount, 1);
        assert.equal(generationArgs.tools, null);
        assert.equal(generationArgs.jsonMode, true);
        assert.equal(data.provider, 'GEMINI');
        assert.match(data.response, /Moderate \[E_PROFILE_RISK\]/);
        assert.equal(data.tool_results, undefined, 'Tool results must not leak to client response');
        assert.equal(data.audit, undefined, 'Audit metadata must not leak to client response');
      });
    } finally {
      ProviderManager.gemini.generate = originalGenerate;
      if (originalNvidia === undefined) delete process.env.NVIDIA_API_KEY; else process.env.NVIDIA_API_KEY = originalNvidia;
      if (originalPrimary === undefined) delete process.env.LLM_PRIMARY_PROVIDER; else process.env.LLM_PRIMARY_PROVIDER = originalPrimary;
    }
  });

  it('DELETE /api/chat/session/:sessionId clears session idempotently', async () => {
    const originalClose = defaultChatSessionStore.close;
    let closedSession;
    defaultChatSessionStore.close = async args => {
      closedSession = args;
      return { session_id: args.sessionId, is_active: false };
    };

    try {
      await withServer(buildApp(), async (baseUrl) => {
        const res = await rawRequest(`${baseUrl}/api/chat/session/sess-123`, {
          method: 'DELETE',
          headers: {
            authorization: `Bearer ${validToken}`,
          },
        });
        assert.equal(res.status, 200);
        const data = await res.json();
        assertRuntimeResponseMatchesContract({
          method: 'DELETE', path: '/api/chat/session/{sessionId}', status: res.status,
          contentType: res.headers.get('content-type'), body: data,
        });
        assert.equal(data.message, 'Session cleared.');
        assert.deepEqual(closedSession, { userId: mockUserId, sessionId: 'sess-123' });
      });
    } finally {
      defaultChatSessionStore.close = originalClose;
    }
  });

  it('GET /api/chat/history validates the live authenticated response envelope', async () => {
    lastHistoryQuery = null;
    await withServer(buildApp(), async baseUrl => {
      const res = await rawRequest(`${baseUrl}/api/chat/history?limit=10`, {
        headers: { authorization: `Bearer ${validToken}` },
      });
      assert.equal(res.status, 200);
      assertRuntimeResponseMatchesContract({
        method: 'GET', path: '/api/chat/history', status: res.status,
        contentType: res.headers.get('content-type'), body: await res.json(),
      });
      assert.equal(String(lastHistoryQuery.userId), mockUserId);
      assert.equal(String(lastHistoryQuery.profileId), mockProfile._id);
      assert.equal(lastHistoryQuery.profileVersion, 1);
      assert.equal(lastHistoryQuery.financialProfileStateRevision, 1);
      assert.match(lastHistoryQuery.profileInputHash, /^[a-f0-9]{64}$/);
      assert.equal(lastHistoryQuery.sourceRecommendationId, null);
      assert.equal(lastHistoryQuery.sourceAllocationRevisionId, null);
    });
  });
});
