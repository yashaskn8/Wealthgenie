import mongoose from 'mongoose';
import { protectImmutableIdentity } from './immutableIdentity.js';

const MessageSchema = new mongoose.Schema({
  role: {
    type: String,
    enum: ['user', 'model'],
    required: true,
  },
  content: {
    type: String,
    required: true,
    maxlength: 8000,
  },
  timestamp: {
    type: Date,
    default: Date.now,
  },
  metadata: {
    // Populated only for model messages
    tokens_used: Number,
    latency_ms: Number,
    grounded_on_profile: Boolean,
    disclaimer_appended: Boolean,
    provider: { type: String, enum: ['gemini', 'groq', 'NVIDIA_NIM', 'GEMINI', 'GROQ', 'DETERMINISTIC_TEMPLATE', 'SYSTEM'] },
    model: { type: String, default: null },
    grounding_version: String,
    prompt_version: String,
    evidence_hash: String,
    evidence_ids_used: [String],
    unavailable_facts: [String],
    citations: [mongoose.Schema.Types.Mixed],
    validation_status: String,
    validation_reason_codes: [String],
    fallback_used: Boolean,
    prompt_injection_detected: Boolean,
    generated_at: Date,
    message_sequence: { type: Number, min: 1 },
    profileId: { type: mongoose.Schema.Types.ObjectId, ref: 'FinancialProfile' },
    financialProfileStateRevision: { type: Number, min: 0, validate: Number.isSafeInteger },
    profileVersion: { type: Number, min: 1 },
    profileInputHash: { type: String, match: /^[a-f0-9]{64}$/ },
    client_turn_hash: { type: String, match: /^[a-f0-9]{64}$/ },
    recommendationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Recommendation' },
    allocationRevisionId: { type: mongoose.Schema.Types.ObjectId, ref: 'RecommendationAllocationRevision' },
    recommendationFingerprint: { type: String, match: /^[a-f0-9]{64}$/ },
    portfolioFingerprint: { type: String, match: /^[a-f0-9]{64}$/ },
  },
});

const TurnReceiptSchema = new mongoose.Schema({
  keyHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  clientKeyHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  requestHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  response: { type: mongoose.Schema.Types.Mixed, required: true },
  createdAt: { type: Date, required: true },
}, { _id: false, strict: true });

const ConversationHistorySchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  profileId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'FinancialProfile',
    required: true,
  },
  session_id: {
    type: String,
    required: true,
    maxlength: 100,
  },
  profileVersion: { type: Number, min: 1, required: true },
  financialProfileStateRevision: { type: Number, min: 0, required: true, validate: Number.isSafeInteger },
  profileInputHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  sourceRecommendationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Recommendation', default: null },
  sourceAllocationRevisionId: { type: mongoose.Schema.Types.ObjectId, ref: 'RecommendationAllocationRevision', default: null },
  sourceRecommendationFingerprint: { type: String, match: /^[a-f0-9]{64}$/, default: null },
  sourcePortfolioFingerprint: { type: String, match: /^[a-f0-9]{64}$/, default: null },
  session_version: { type: Number, min: 1, default: 1 },
  message_sequence: { type: Number, min: 0, default: 0 },
  reserved_tokens: { type: Number, min: 0, default: 0 },
  processing_owner_id: { type: String, default: null, select: false },
  processing_lease_until: { type: Date, default: null, select: false },
  messages: [MessageSchema],
  // Kept independently of the visible message cap so a lost-response retry
  // can replay its accepted turn without calling a provider again.
  turnReceipts: { type: [TurnReceiptSchema], default: [] },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
  message_count: { type: Number, default: 0 },
  cumulative_tokens: { type: Number, default: 0 },
  cumulative_hops: { type: Number, default: 0 },
  is_active: { type: Boolean, default: true },
});

const MAX_MESSAGES_PER_SESSION = 200;

// Auto-update updated_at, message_count, and enforce message cap on save
ConversationHistorySchema.pre('save', function (next) {
  this.updated_at = new Date();
  // Enforce maximum messages per session — trim oldest if exceeded
  if (this.messages.length > MAX_MESSAGES_PER_SESSION) {
    this.messages = this.messages.slice(-MAX_MESSAGES_PER_SESSION);
  }
  this.message_count = this.messages.length;
  next();
});

// Index for efficient session retrieval
ConversationHistorySchema.index({ userId: 1, updated_at: -1 });
ConversationHistorySchema.index({ userId: 1, session_id: 1 }, { unique: true, name: 'unique_user_chat_session' });
ConversationHistorySchema.index({ userId: 1, is_active: 1, updated_at: -1 });

protectImmutableIdentity(ConversationHistorySchema, [
  'userId', 'profileId', 'session_id', 'profileVersion', 'profileInputHash',
  'financialProfileStateRevision',
  'sourceRecommendationId', 'sourceAllocationRevisionId',
  'sourceRecommendationFingerprint', 'sourcePortfolioFingerprint',
], {
  code: 'CONVERSATION_IDENTITY_IMMUTABLE',
  label: 'Conversation identity and financial provenance',
});

export default mongoose.model('ConversationHistory', ConversationHistorySchema);
