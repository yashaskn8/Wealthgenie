import crypto from 'node:crypto';
import { createError } from '../../middleware/errorHandler.js';
import { CHAT_SESSION_TOKEN_CAP, defaultChatSessionStore } from '../../services/chatSessionStore.js';

export function createMockChatSessionStore(getSession) {
  let activeOwner = null;
  const receiptsBySession = new Map();
  const sessionKey = (userId, sessionId) => `${String(userId)}:${String(sessionId)}`;

  return {
    async findReceipt({ userId, sessionId, keyHash, requestHash }) {
      const receipt = (receiptsBySession.get(sessionKey(userId, sessionId)) || []).find(item => item.keyHash === keyHash);
      if (!receipt) return null;
      if (receipt.requestHash !== requestHash) {
        throw createError(409, 'The idempotency key was already used for a different chat message.', 'This chat request key cannot be reused for different text.', {
          code: 'CHAT_IDEMPOTENCY_KEY_REUSED',
        });
      }
      return receipt.response;
    },
    async acquire({ userId, sessionId, binding }) {
      const conversation = await getSession({ userId, sessionId });
      if (!conversation) throw new Error('The mock must supply a chat session.');
      conversation.userId ??= userId;
      conversation.session_id ??= sessionId;
      conversation.turnReceipts = receiptsBySession.get(sessionKey(userId, sessionId)) || [];
      if (activeOwner) {
        throw createError(409, 'Another message is currently being processed.', 'Retry the chat message.', { code: 'CHAT_SESSION_BUSY' });
      }
      if (!conversation.profileInputHash) {
        Object.assign(conversation, binding);
      } else if (String(conversation.profileId) !== String(binding.profileId)
          || Number(conversation.profileVersion) !== Number(binding.profileVersion)
          || conversation.profileInputHash !== binding.profileInputHash) {
        throw createError(409, 'The chat profile state changed.', 'Start a new chat session.', { code: 'CHAT_PROFILE_STATE_CHANGED' });
      }
      activeOwner = crypto.randomUUID();
      return {
        conversation,
        ownerId: activeOwner,
        tokenReservation: 0,
      };
    },
    async reserveBudget(claim, reservation) {
      const total = Number(claim.conversation.cumulative_tokens || 0)
        + Number(claim.conversation.reserved_tokens || 0)
        + reservation;
      if (total > CHAT_SESSION_TOKEN_CAP) return false;
      claim.tokenReservation = Number(claim.tokenReservation || 0) + reservation;
      claim.conversation.reserved_tokens = Number(claim.conversation.reserved_tokens || 0) + reservation;
      return true;
    },
    async renew(claim) {
      if (activeOwner !== claim.ownerId) throw createError(409, 'Chat session lease was lost.', 'Start a new message.', { code: 'CHAT_SESSION_STATE_CHANGED' });
    },
    async complete({ claim, userMessage, modelMessage, actualTokens, chargeReservation = false, turnReceipt, preserveLease = false }) {
      if (activeOwner !== claim.ownerId) throw createError(409, 'Chat session lease was lost.', 'Start a new message.', { code: 'CHAT_SESSION_STATE_CHANGED' });
      const sequence = Number(claim.conversation.message_sequence || 0);
      const provenance = {
        profileId: claim.conversation.profileId,
        profileVersion: claim.conversation.profileVersion,
        financialProfileStateRevision: claim.conversation.financialProfileStateRevision,
        profileInputHash: claim.conversation.profileInputHash,
        recommendationId: claim.conversation.sourceRecommendationId || undefined,
        allocationRevisionId: claim.conversation.sourceAllocationRevisionId || undefined,
        recommendationFingerprint: claim.conversation.sourceRecommendationFingerprint || undefined,
        portfolioFingerprint: claim.conversation.sourcePortfolioFingerprint || undefined,
      };
      claim.conversation.messages.push(
        { ...userMessage, metadata: { ...userMessage.metadata, ...provenance, client_turn_hash: turnReceipt.clientKeyHash, message_sequence: sequence + 1 } },
        { ...modelMessage, metadata: { ...modelMessage.metadata, ...provenance, client_turn_hash: turnReceipt.clientKeyHash, message_sequence: sequence + 2 } },
      );
      claim.conversation.messages = claim.conversation.messages.slice(-200);
      claim.conversation.turnReceipts ||= [];
      claim.conversation.turnReceipts.push(turnReceipt);
      claim.conversation.turnReceipts = claim.conversation.turnReceipts.slice(-200);
      receiptsBySession.set(sessionKey(claim.conversation.userId, claim.conversation.session_id), claim.conversation.turnReceipts);
      claim.conversation.message_count = claim.conversation.messages.length;
      claim.conversation.message_sequence = sequence + 2;
      claim.conversation.session_version = Number(claim.conversation.session_version || 1) + 1;
      claim.conversation.cumulative_tokens = Number(claim.conversation.cumulative_tokens || 0)
        + (chargeReservation ? claim.tokenReservation : actualTokens);
      claim.conversation.reserved_tokens = Math.max(0,
        Number(claim.conversation.reserved_tokens || 0) - Number(claim.tokenReservation || 0));
      if (!preserveLease) {
        claim.conversation.processing_owner_id = null;
        activeOwner = null;
      }
      return claim.conversation;
    },
    async finalizeCompletedTurn({ claim }) {
      if (activeOwner !== claim.ownerId) throw createError(409, 'Chat session lease was lost.', 'Start a new message.', { code: 'CHAT_SESSION_STATE_CHANGED' });
      claim.conversation.processing_owner_id = null;
      activeOwner = null;
      return true;
    },
    async discardCompletedTurn({ userId, sessionId, keyHash, clientKeyHash, ownerId }) {
      const conversation = await getSession({ userId, sessionId });
      if (!conversation) return false;
      const keptMessages = (conversation.messages || []).filter(message => message.metadata?.client_turn_hash !== clientKeyHash);
      conversation.messages.splice(0, conversation.messages.length, ...keptMessages);
      const receipts = (receiptsBySession.get(sessionKey(userId, sessionId)) || [])
        .filter(receipt => !(receipt.keyHash === keyHash && receipt.clientKeyHash === clientKeyHash));
      conversation.turnReceipts = receipts;
      receiptsBySession.set(sessionKey(userId, sessionId), receipts);
      if (!ownerId || activeOwner === ownerId) {
        conversation.processing_owner_id = null;
        activeOwner = null;
      }
      return true;
    },
    async release(claim, { chargeReservation = false } = {}) {
      if (activeOwner !== claim.ownerId) return;
      if (chargeReservation) {
        claim.conversation.cumulative_tokens = Number(claim.conversation.cumulative_tokens || 0)
          + Number(claim.tokenReservation || 0);
      }
      claim.conversation.reserved_tokens = Math.max(0,
        Number(claim.conversation.reserved_tokens || 0) - Number(claim.tokenReservation || 0));
      claim.conversation.processing_owner_id = null;
      activeOwner = null;
    },
    async close() {
      activeOwner = null;
    },
  };
}

export function installMockChatSessionStore(getSession) {
  const previous = { ...defaultChatSessionStore };
  Object.assign(defaultChatSessionStore, createMockChatSessionStore(getSession));
  return () => Object.assign(defaultChatSessionStore, previous);
}
