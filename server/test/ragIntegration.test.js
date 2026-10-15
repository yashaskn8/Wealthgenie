/**
 * Phase 6 integration coverage for the chat grounding boundary. Historical RAG
 * content is not allowed to bypass the versioned authoritative evidence packet.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import express from 'express';
import jwt from 'jsonwebtoken';
import chatRouter from '../routes/chatRoutes.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { withServer, jsonRequest } from '../test-utils/httpTestUtils.js';
import FinancialProfile from '../models/FinancialProfile.js';
import Recommendation from '../models/Recommendation.js';
import Goal from '../models/Goal.js';
import ConversationHistory from '../models/ConversationHistory.js';
import User from '../models/User.js';
import FinancialProfileState from '../models/FinancialProfileState.js';
import { canonicalProfile } from './helpers/canonicalProfile.js';
import { installMockChatSessionStore } from './helpers/mockChatSessionStore.js';
import { withMockAuthAccountState } from './helpers/mockAuthAccountState.js';

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

describe('Phase 1 Architecture Truth — RAG Chat Integration Tests', () => {
  let originalProfileFindOne;
  let originalRecFindOne;
  let originalGoalFind;
  let originalConvFindOne;
  let originalUserFindById;
  let originalProfileStateFindOne;
  let originalEnvironment;
  let restoreChatStore;

  beforeEach(() => {
    originalProfileFindOne = FinancialProfile.findOne;
    originalRecFindOne = Recommendation.findOne;
    originalGoalFind = Goal.find;
    originalConvFindOne = ConversationHistory.findOne;
    originalUserFindById = User.findById;
    originalProfileStateFindOne = FinancialProfileState.findOne;
    originalEnvironment = {
      nvidia: process.env.NVIDIA_API_KEY,
      gemini: process.env.GEMINI_API_KEY,
      groq: process.env.GROQ_API_KEY,
    };
    process.env.NVIDIA_API_KEY = '';
    process.env.GEMINI_API_KEY = '';
    process.env.GROQ_API_KEY = '';

    FinancialProfile.findOne = (query) => {
      const profileQuery = {
        lean: async () => (String(query?.userId) === mockUserId
          && String(query?._id) === String(mockProfile._id) ? mockProfile : null),
        sort: () => profileQuery,
      };
      return profileQuery;
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

    ConversationHistory.findOne = async (query) => ({
      userId: query?.userId || mockUserId,
      session_id: query?.session_id || 'test-session',
      messages: [],
      save: async () => true,
    });
    restoreChatStore = installMockChatSessionStore(async ({ userId, sessionId }) => ({
      userId,
      profileId: mockProfile._id,
      profileVersion: mockProfile.version || 1,
      financialProfileStateRevision: 1,
      session_id: sessionId,
      messages: [],
      message_sequence: 0,
      session_version: 1,
      cumulative_tokens: 0,
      reserved_tokens: 0,
    }));

    User.findById = () => ({
      select() { return this; },
      lean: async () => ({ name: 'Test User', email: 'test@example.com' }),
    });
  });

  afterEach(() => {
    FinancialProfile.findOne = originalProfileFindOne;
    Recommendation.findOne = originalRecFindOne;
    Goal.find = originalGoalFind;
    ConversationHistory.findOne = originalConvFindOne;
    restoreChatStore?.();
    User.findById = originalUserFindById;
    FinancialProfileState.findOne = originalProfileStateFindOne;
    if (originalEnvironment.nvidia === undefined) delete process.env.NVIDIA_API_KEY; else process.env.NVIDIA_API_KEY = originalEnvironment.nvidia;
    if (originalEnvironment.gemini === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = originalEnvironment.gemini;
    if (originalEnvironment.groq === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = originalEnvironment.groq;
  });

  it('keeps a factual tax question unavailable without canonical tax inputs and a tax-engine result', async () => {
    const app = buildApp();

    await withMockAuthAccountState(() => withServer(app, async (baseUrl) => {
      const { response, body } = await jsonRequest(`${baseUrl}/api/chat/message`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${validToken}`,
        },
        body: JSON.stringify({
          message: 'How much deduction is allowed under Section 80C for ELSS?',
        }),
      });

      assert.equal(response.status, 200, `Expected status 200, got ${response.status}`);

      assert.equal(body.provider, 'DETERMINISTIC_TEMPLATE');
      assert.equal(body.grounded, true);
      assert.equal(body.fallback, true);
      assert.ok(body.unavailable_facts.includes('POST_TAX_RETURN_UNAVAILABLE_MISSING_TAX_INPUTS'));
      assert.equal(body.retrieved_chunks, undefined);
      assert.equal(body.tool_results, undefined);
    }), { preserveUserLookup: true });
  });

  it('never exposes the old direct RAG provider path', async () => {
    const app = buildApp();

    await withMockAuthAccountState(() => withServer(app, async (baseUrl) => {
      const { response, body } = await jsonRequest(`${baseUrl}/api/chat/message`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${validToken}`,
        },
        body: JSON.stringify({
          message: 'Hello Genie, how are you today?',
        }),
      });

      assert.equal(response.status, 200);
      assert.equal(body.provider, 'DETERMINISTIC_TEMPLATE');
      assert.notEqual(body.provider, 'rag');
    }), { preserveUserLookup: true });
  });

  it('ConversationHistory accepts Phase 6 grounded-provider audit metadata', async () => {
    const doc = new ConversationHistory({
      userId: mockUserId,
      profileId: new mongoose.Types.ObjectId(),
      session_id: 'rag-test-session-001',
      profileVersion: 1,
      financialProfileStateRevision: 1,
      profileInputHash: 'a'.repeat(64),
      messages: [
        {
          role: 'user',
          content: 'What is 80C limit?',
          timestamp: new Date(),
        },
        {
          role: 'model',
          content: '₹1.5 Lakhs limit under Section 80C.',
          timestamp: new Date(),
          metadata: {
            tokens_used: 45,
            provider: 'DETERMINISTIC_TEMPLATE',
            grounding_version: 'grounded-financial-evidence-1.0.0',
            prompt_version: 'grounded-financial-explanation-prompt-1.1.0',
            evidence_ids_used: ['E_TAX_INPUT_BOUNDARY'],
            validation_status: 'PASS',
            fallback_used: true,
          },
        }
      ]
    });

    // Validate the document directly against Mongoose schema
    const validationError = doc.validateSync();
    assert.equal(validationError, undefined, 'Grounded explanation metadata must pass Mongoose validation');
  });
});
