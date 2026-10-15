/**
 * Chat Routes — POST /api/chat/message, GET /api/chat/history, DELETE /api/chat/session/:sessionId
 */
import { Router } from 'express';
import crypto from 'crypto';
import { verifyJWT } from '../middleware/authMiddleware.js';
import { asyncHandler, createError } from '../middleware/errorHandler.js';
import { validate, chatMessageSchema } from '../validation/schemas.js';
import { chatHistoryQuerySchema, validateQuery } from '../validation/schemas.js';
import { processChat, buildClientResponseDTO, resolveCurrentChatSessionBinding } from '../services/geminiChatService.js';
import {
  inspectTokenBudget,
  recordTokenUsage,
  reserveTokenBudget,
  settleTokenBudget,
} from '../middleware/tokenBudget.js';
import ConversationHistory from '../models/ConversationHistory.js';
import { defaultChatSessionStore } from '../services/chatSessionStore.js';

const router = Router();

/**
 * POST /api/chat/message [Protected]
 * Send a message to the AI chat assistant.
 * Completed turn replays are resolved before token and hourly quotas are checked.
 */
router.post('/message', verifyJWT, validate(chatMessageSchema), asyncHandler(async (req, res) => {
  const { message, session_id } = req.body;
  const suppliedIdempotencyKey = req.get('Idempotency-Key');
  if (suppliedIdempotencyKey && !/^[A-Za-z0-9._:-]{8,128}$/.test(suppliedIdempotencyKey)) {
    throw createError(400, 'Invalid Idempotency-Key header.', 'Invalid chat request key.', { code: 'INVALID_IDEMPOTENCY_KEY' });
  }
  const idempotencyKey = suppliedIdempotencyKey || crypto.randomUUID();
  // A first-message retry without an explicit session ID must resolve to the
  // same opaque server-owned session while it reuses the same request key.
  const sessionId = session_id || `idem-${crypto.createHash('sha256')
    .update(`${req.user.userId}\0${idempotencyKey}`).digest('hex')}`;

  const result = await processChat({
    userId: req.user.userId,
    user: req.user,
    message: message.trim(),
    sessionId,
    idempotencyKey,
  }, {
    beforeGeneration: async () => {
      const budget = await inspectTokenBudget(req);
      if (!budget.allowed) {
        res.setHeader('Retry-After', String(budget.retryAfterSeconds));
        throw createError(429,
          `You have used ${budget.totalTokens} tokens in the current window (limit: ${budget.maxTokens}).`,
          'The chat token budget has been reached. Retry after the current window resets.',
          { code: 'TOKEN_BUDGET_EXCEEDED', details: { retryAfterSeconds: budget.retryAfterSeconds } });
      }
    },
    reserveProviderAttempt: async ({ tokenUpperBound }) => {
      try {
        return await reserveTokenBudget(req, tokenUpperBound);
      } catch (error) {
        if (error?.code === 'TOKEN_BUDGET_EXCEEDED') {
          const retryAfter = error?.details?.retryAfterSeconds;
          if (Number.isSafeInteger(retryAfter) && retryAfter > 0) res.setHeader('Retry-After', String(retryAfter));
        }
        throw error;
      }
    },
    settleProviderAttempt: ({ reservation, actualTokens }) => settleTokenBudget(reservation, actualTokens),
  });

  // Record token usage from the AI response for budget tracking
  const tokensUsed = result?.usage?.totalTokens || result?.tokenCount || Math.ceil(message.length / 4);
  if (!result?.idempotent_replay && !req.tokenBudgetProviderAttempts) await recordTokenUsage(req, tokensUsed);

  res.json(buildClientResponseDTO(result));
}));

/**
 * GET /api/chat/history [Protected]
 * Retrieve conversation history for the current user.
 */
router.get('/history', verifyJWT, validateQuery(chatHistoryQuerySchema), asyncHandler(async (req, res) => {
  const { session_id } = req.query;

  // Clamp limit to prevent excessive queries
  const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);

  const binding = await resolveCurrentChatSessionBinding({ userId: req.user.userId });
  if (!binding) return res.json({ conversations: [] });

  // History is exposed only when the stored conversation matches the current
  // server-owned profile, recommendation and allocation revision.
  const query = {
    userId: req.user.userId,
    is_active: true,
    profileId: binding.profileId,
    profileVersion: binding.profileVersion,
    financialProfileStateRevision: binding.financialProfileStateRevision,
    profileInputHash: binding.profileInputHash,
    sourceRecommendationId: binding.sourceRecommendationId,
    sourceAllocationRevisionId: binding.sourceAllocationRevisionId,
    sourceRecommendationFingerprint: binding.sourceRecommendationFingerprint,
    sourcePortfolioFingerprint: binding.sourcePortfolioFingerprint,
  };
  if (session_id) query.session_id = session_id;

  const conversations = await ConversationHistory
    .find(query)
    .sort({ updated_at: -1 })
    .limit(limit)
    .select('session_id messages message_count created_at updated_at')
    .lean();

  res.json({ conversations });
}));

/**
 * DELETE /api/chat/session/:sessionId [Protected]
 * Soft-delete a chat session (marks as inactive).
 */
router.delete('/session/:sessionId', verifyJWT, asyncHandler(async (req, res) => {
  const { sessionId } = req.params;

  if (!/^[A-Za-z0-9._:-]{1,100}$/.test(sessionId || '')) {
    throw createError(400, 'Invalid sessionId', 'Invalid session ID.');
  }

  await defaultChatSessionStore.close({ userId: req.user.userId, sessionId });

  res.json({ message: 'Session cleared.' });
}));

export default router;
