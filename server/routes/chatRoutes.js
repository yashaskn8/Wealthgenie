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
import { checkTokenBudget, recordTokenUsage } from '../middleware/tokenBudget.js';
import ConversationHistory from '../models/ConversationHistory.js';
import { defaultChatSessionStore } from '../services/chatSessionStore.js';

const router = Router();

/**
 * POST /api/chat/message [Protected]
 * Send a message to the AI chat assistant.
 * Token budget middleware prevents cost/abuse spikes from long prompts.
 */
router.post('/message', verifyJWT, checkTokenBudget(), validate(chatMessageSchema), asyncHandler(async (req, res) => {
  const { message, session_id } = req.body;

  const sessionId = session_id || crypto.randomUUID();

  const result = await processChat({
    userId: req.user.userId,
    user: req.user,
    message: message.trim(),
    sessionId,
  });

  // Record token usage from the AI response for budget tracking
  const tokensUsed = result?.usage?.totalTokens || result?.tokenCount || Math.ceil(message.length / 4);
  recordTokenUsage(req, tokensUsed);

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
