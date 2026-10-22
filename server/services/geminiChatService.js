/**
 * Genie Chat — grounded explanation boundary.
 * Financial authority remains in the canonical backend services. External LLMs
 * receive a minimal read-only evidence packet and no executable tools.
 */
import crypto from 'node:crypto';
import { redisClient, redisAvailable } from '../config/redis.js';
import { createError } from '../middleware/errorHandler.js';
import { ImmutableSecurityPipeline } from './immutableSecurityPipeline.js';
import { PrometheusMetrics } from './metricsCollector.js';
import {
  buildRecommendationProfile,
  buildRecommendationProfileHash,
  buildLlmFinancialContext,
} from './recommendationProfile.js';
import { assessSuitabilityRisk } from './riskProfiler.js';
import { classifyGenieChatQuestion } from './chatQuestionRouting.js';
import { generateGeneralChat, getGeneralChatTokenUpperBound } from './generalChatService.js';
import {
  buildChatEvidencePacket,
  generateGroundedExplanation,
  getGroundedExplanationTokenUpperBound,
  isGroundingBoundaryAttack,
  sanitizeExternalQuestion,
} from './groundedExplanationService.js';
import { resolveCurrentRecommendationState } from './recommendationState.js';
import { resolveCurrentFinancialProfile } from './currentFinancialProfile.js';
import {
  CHAT_SESSION_TOKEN_CAP,
  chatSessionBindingMatches,
  defaultChatSessionStore,
} from './chatSessionStore.js';
import { CHAT_RATE_LIMIT, checkChatRateLimit } from './chatRateLimit.js';

const SESSION_CUMULATIVE_TOKEN_CAP = CHAT_SESSION_TOKEN_CAP;

export async function checkRateLimit(userId, {
  getRedisState = () => ({ client: redisClient, available: redisAvailable }),
  ...options
} = {}) {
  return checkChatRateLimit(userId, { ...options, redisState: getRedisState() });
}

export function buildClientResponseDTO({
  version = '3.0',
  response,
  session_id,
  latency_ms = 0,
  grounded = true,
  provider = 'DETERMINISTIC_TEMPLATE',
  model = null,
  prompt_version = null,
  grounding_version = null,
  evidence_ids_used = [],
  unavailable_facts = [],
  validation_status = null,
  fallback = false,
  fallback_reason_codes = [],
  messages_this_hour = 1,
  rate_limit_remaining = 30,
  rate_limit_reset_at = null,
  citations = [],
  action_cards = [],
  idempotent_replay = false,
}) {
  return {
    version,
    response,
    session_id,
    latency_ms,
    grounded,
    provider,
    model,
    prompt_version,
    grounding_version,
    evidence_ids_used,
    unavailable_facts,
    validation_status,
    fallback,
    fallback_reason_codes,
    messages_this_hour,
    rate_limit_remaining,
    rate_limit_reset_at,
    citations,
    action_cards,
    idempotent_replay,
  };
}

function noProfileResponse(sessionId, rateCheck) {
  return buildClientResponseDTO({
    response: "I don't have your Financial Profile yet. Complete the profile flow before requesting a personalized explanation.",
    session_id: sessionId,
    grounded: false,
    provider: 'SYSTEM',
    messages_this_hour: rateCheck.count,
    rate_limit_remaining: CHAT_RATE_LIMIT - rateCheck.count,
    rate_limit_reset_at: new Date(rateCheck.resetAt).toISOString(),
  });
}

async function resolveChatRecommendation(userId, profileId, profile) {
  try {
    const state = await resolveCurrentRecommendationState({ userId, profileId, profile });
    const recommendation = state.freshness.fresh ? state.currentRecommendationView : null;
    return recommendation ? { recommendation, recommendationState: state } : { recommendation: null, recommendationState: null };
  } catch {
    // Chat remains available as a non-personalized grounded explanation when
    // the authoritative recommendation is stale or unavailable.
    return { recommendation: null, recommendationState: null };
  }
}

function createChatSessionBinding(canonicalProfile, storedProfile, recommendation, recommendationState) {
  const modelVersion = recommendation?.modelVersion || 'chat-profile-only-v1';
  return {
    profileId: storedProfile._id,
    profileVersion: Number(storedProfile.version || 1),
    financialProfileStateRevision: Number(canonicalProfile.state.revision),
    profileInputHash: buildRecommendationProfileHash(storedProfile, { modelVersion }),
    sourceRecommendationId: recommendation?._id || null,
    sourceAllocationRevisionId: recommendationState?.allocationRevision?._id || null,
    sourceRecommendationFingerprint: recommendationState?.recommendationFingerprint || null,
    sourcePortfolioFingerprint: recommendationState?.portfolioFingerprint || null,
  };
}

export async function resolveCurrentChatSessionBinding({ userId } = {}) {
  const canonicalProfile = await resolveCurrentFinancialProfile({ userId, requireRecommendation: false });
  const storedProfile = canonicalProfile.profile;
  if (!storedProfile) return null;
  const profile = buildRecommendationProfile(storedProfile);
  const { recommendation, recommendationState } = await resolveChatRecommendation(userId, storedProfile._id, profile);
  return createChatSessionBinding(canonicalProfile, storedProfile, recommendation, recommendationState);
}

function buildTurnHashes(userId, sessionId, message, idempotencyKey) {
  const keyHash = crypto.createHash('sha256')
    .update(`${String(userId)}\0${String(sessionId)}\0${String(idempotencyKey)}`)
    .digest('hex');
  const requestHash = crypto.createHmac('sha256', String(idempotencyKey))
    .update(String(message || '').trim())
    .digest('hex');
  const clientKeyHash = crypto.createHash('sha256')
    .update(`${String(sessionId)}\0${String(idempotencyKey)}\0${String(message || '').trim()}`)
    .digest('hex');
  return { keyHash, requestHash, clientKeyHash };
}

function truncateUtf8(value, maxBytes) {
  let output = '';
  let byteLength = 0;
  for (const character of String(value || '')) {
    const nextLength = Buffer.byteLength(character, 'utf8');
    if (byteLength + nextLength > maxBytes) break;
    output += character;
    byteLength += nextLength;
  }
  return output;
}

function sameNullableId(left, right) {
  return (left == null && right == null) || String(left) === String(right);
}

function chatMessageMatchesBinding(message, binding) {
  const metadata = message?.metadata || {};
  return sameNullableId(metadata.profileId, binding.profileId)
    && Number(metadata.profileVersion) === Number(binding.profileVersion)
    && Number(metadata.financialProfileStateRevision) === Number(binding.financialProfileStateRevision)
    && metadata.profileInputHash === binding.profileInputHash
    && sameNullableId(metadata.recommendationId, binding.sourceRecommendationId)
    && sameNullableId(metadata.allocationRevisionId, binding.sourceAllocationRevisionId)
    && (metadata.recommendationFingerprint || null) === (binding.sourceRecommendationFingerprint || null)
    && (metadata.portfolioFingerprint || null) === (binding.sourcePortfolioFingerprint || null);
}

function isContextDependentFollowUp(question) {
  return /^(?:why\??|how\s+(?:so|come)\b|tell\s+me\s+more\b|can\s+you\s+explain\b|explain\s+(?:that|it|more|the\s+previous)\b|what\s+about\s+(?:it|that|this)\b|continue\b)/i.test(String(question || '').trim());
}

function lastChatTurnWasFinancial(conversation) {
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
  const latest = [...messages].reverse().find(item => item.role === 'model');
  return Boolean(latest && (latest.metadata?.grounded_on_profile !== false
    || latest.metadata?.validation_status !== 'GENERAL_UNCITED'));
}

function buildTrustedPriorTurns(conversation, binding, mode = 'FINANCIAL') {
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
  const newestPairs = [];
  for (let index = messages.length - 2; index >= 0 && newestPairs.length < 2; index -= 2) {
    const userMessage = messages[index];
    const modelMessage = messages[index + 1];
    if (userMessage?.role !== 'user' || modelMessage?.role !== 'model'
        || !chatMessageMatchesBinding(userMessage, binding)
        || !chatMessageMatchesBinding(modelMessage, binding)) break;
    // A general chat must not inherit prior account-specific financial answers.
    // A financial chat must not treat unconstrained general answers as evidence.
    const isGeneralPair = userMessage.metadata?.grounded_on_profile === false
      && modelMessage.metadata?.grounded_on_profile === false
      && modelMessage.metadata?.validation_status === 'GENERAL_UNCITED';
    if ((mode === 'GENERAL') !== isGeneralPair) break;
    const pair = [
      { role: 'user', content: truncateUtf8(sanitizeExternalQuestion(userMessage.content), 1000) },
      { role: 'model', content: truncateUtf8(sanitizeExternalQuestion(modelMessage.content), 1000) },
    ];
    const pairBytes = Buffer.byteLength(JSON.stringify(pair), 'utf8');
    const priorBytes = newestPairs.reduce((total, item) => total + Buffer.byteLength(JSON.stringify(item), 'utf8'), 0);
    if (pairBytes + priorBytes > 4096) break;
    newestPairs.push(pair);
  }
  return newestPairs.reverse().flat();
}

async function requireCurrentBinding(binding, userId) {
  const currentBinding = await resolveCurrentChatSessionBinding({ userId });
  if (!currentBinding || !chatSessionBindingMatches(currentBinding, binding)) {
    throw createError(409, 'The financial source state changed while the chat answer was being generated.', 'Your profile or recommendation changed. Start a new chat session.', {
      code: 'CHAT_PROFILE_STATE_CHANGED',
    });
  }
}

export async function processChat({ userId, user: _user, message, sessionId, idempotencyKey = crypto.randomUUID() }, {
  sessionStore = defaultChatSessionStore,
  rateLimitOptions,
  beforeGeneration,
  reserveProviderAttempt,
  settleProviderAttempt,
  groundedExplanationDependencies = {},
} = {}) {
  const canonicalProfile = await resolveCurrentFinancialProfile({ userId, requireRecommendation: false });
  const storedProfile = canonicalProfile.profile;
  if (!storedProfile) {
    await beforeGeneration?.();
    const rateCheck = await checkRateLimit(userId, rateLimitOptions);
    if (!rateCheck.allowed) {
      throw createError(429, 'Chat user rate limit exceeded.', 'The hourly chat message limit has been reached.', {
        code: 'CHAT_RATE_LIMIT_EXCEEDED',
        details: { retryAfterSeconds: rateCheck.ttl, resetAt: new Date(rateCheck.resetAt).toISOString() },
      });
    }
    return noProfileResponse(sessionId, rateCheck);
  }
  const profile = buildRecommendationProfile(storedProfile);
  const suitability = assessSuitabilityRisk(profile);
  const llmProfile = buildLlmFinancialContext(profile, suitability);
  const securityContext = ImmutableSecurityPipeline.processInput(message, profile);
  const promptInjectionDetected = securityContext.isInjection
    || isGroundingBoundaryAttack(securityContext.sanitizedMessage);
  if (promptInjectionDetected) PrometheusMetrics.inc('prompt_injection_attempts_total');

  const { recommendation, recommendationState } = await resolveChatRecommendation(userId, storedProfile._id, profile);
  const binding = createChatSessionBinding(canonicalProfile, storedProfile, recommendation, recommendationState);
  const { keyHash, requestHash, clientKeyHash } = buildTurnHashes(userId, sessionId, message, idempotencyKey);
  const previousResult = await sessionStore.findReceipt({
    userId,
    sessionId,
    binding,
    keyHash,
    requestHash,
  });
  if (previousResult) {
    await requireCurrentBinding(binding, userId);
    return { ...previousResult, idempotent_replay: true };
  }

  const claim = await sessionStore.acquire({ userId, sessionId, binding });
  let providerAttempted = false;
  let completed = false;
  let sessionReservationSettled = false;
  let leaseFailure = null;
  let heartbeatBusy = false;
  const heartbeat = setInterval(() => {
    if (heartbeatBusy || leaseFailure) return;
    heartbeatBusy = true;
    sessionStore.renew(claim).catch(error => { leaseFailure = error; }).finally(() => { heartbeatBusy = false; });
  }, Math.floor(90000 / 3));
  heartbeat.unref?.();

  try {
    const rateCheck = await checkRateLimit(userId, rateLimitOptions);
    if (!rateCheck.allowed) {
      throw createError(429, 'Chat user rate limit exceeded.', 'The hourly chat message limit has been reached.', {
        code: 'CHAT_RATE_LIMIT_EXCEEDED',
        details: { retryAfterSeconds: rateCheck.ttl, resetAt: new Date(rateCheck.resetAt).toISOString() },
      });
    }
    const isGeneralQuestion = !promptInjectionDetected
      && classifyGenieChatQuestion(securityContext.sanitizedMessage) === 'GENERAL_UNCITED';
    // Never give the general-purpose LLM the user's private profile or recommendation.
    const evidencePacket = isGeneralQuestion ? null : await buildChatEvidencePacket({
      question: securityContext.sanitizedMessage,
      profile: llmProfile,
      recommendation,
      userId,
    });
    if (leaseFailure) throw leaseFailure;
    const priorTurns = buildTrustedPriorTurns(claim.conversation, binding,
      isGeneralQuestion ? 'GENERAL' : 'FINANCIAL');
    const providerBudgetUpperBound = isGeneralQuestion
      ? getGeneralChatTokenUpperBound({ question: securityContext.sanitizedMessage, priorTurns })
      : getGroundedExplanationTokenUpperBound({
        question: securityContext.sanitizedMessage,
        evidencePacket,
        priorTurns,
      });
    const alreadyUsed = Number(claim.conversation.cumulative_tokens || 0)
      + Number(claim.conversation.reserved_tokens || 0);
    const remainingBudget = Math.max(0, SESSION_CUMULATIVE_TOKEN_CAP - alreadyUsed);
    const canReserveProvider = providerBudgetUpperBound <= remainingBudget
      && await sessionStore.reserveBudget(claim, providerBudgetUpperBound);
    const startedAt = Date.now();
    let initialProviderReservationAvailable = canReserveProvider;
    const explanation = await (isGeneralQuestion ? generateGeneralChat : generateGroundedExplanation)(
      { question: securityContext.sanitizedMessage, evidencePacket, priorTurns },
      {
        ...groundedExplanationDependencies,
        ...(canReserveProvider ? {
        beforeProviderAttempt: async () => {
          await requireCurrentBinding(binding, userId);
          if (initialProviderReservationAvailable) {
            initialProviderReservationAvailable = false;
            return true;
          }
          return sessionStore.reserveBudget(claim, providerBudgetUpperBound);
        },
        } : {
          providers: [],
          preflightFailureCodes: ['PROVIDER_BUDGET_EXHAUSTED'],
        }),
        ...(reserveProviderAttempt ? {
          reserveProviderAttempt: async ({ provider, providerAttemptCount }) => reserveProviderAttempt({
            userId,
            sessionId,
            provider,
            providerAttemptCount,
            tokenUpperBound: providerBudgetUpperBound,
          }),
        } : {}),
        ...(settleProviderAttempt ? {
          settleProviderAttempt: async ({ reservation, actualTokens, provider, providerAttemptCount }) => settleProviderAttempt({
            reservation,
            actualTokens,
            userId,
            sessionId,
            provider,
            providerAttemptCount,
          }),
        } : {}),
        onProviderAttemptStart: async () => {
          await requireCurrentBinding(binding, userId);
          providerAttempted = true;
        },
      },
    );
    if (leaseFailure) throw leaseFailure;
    const latencyMs = Date.now() - startedAt;
    PrometheusMetrics.recordLatency(explanation.provider, latencyMs);

    const attemptedProviderFailure = Number(explanation.providerAttemptFailureCount || 0) > 0
      || (explanation.fallback
        && (explanation.reasonCodes || []).some(reason => /REQUEST_FAILED|EMPTY_COMPLETION|GROUNDING_VALIDATION_FAILED/.test(reason)));
    const auditMetadata = {
      provider: explanation.provider,
      model: explanation.model,
      grounded_on_profile: !isGeneralQuestion,
      grounding_version: explanation.groundingVersion,
      prompt_version: explanation.promptVersion,
      evidence_hash: explanation.evidenceHash,
      evidence_ids_used: explanation.evidenceIdsUsed,
      unavailable_facts: explanation.unavailableFacts,
      citations: explanation.citations,
      validation_status: explanation.validation.status,
      validation_reason_codes: explanation.validation.reasonCodes,
      fallback_used: explanation.fallback,
      prompt_injection_detected: promptInjectionDetected,
      tokens_used: explanation.tokensUsed,
      latency_ms: latencyMs,
      generated_at: explanation.generatedAt,
    };
    const userMessage = {
      role: 'user',
      content: securityContext.sanitizedMessage,
      metadata: { grounded_on_profile: !isGeneralQuestion, prompt_injection_detected: promptInjectionDetected },
    };
    const modelMessage = { role: 'model', content: explanation.text, metadata: auditMetadata };
    const actualProviderTokens = explanation.cached
      ? 0
      : Number(explanation.tokensUsed || 0);
    const usageUnavailable = !explanation.cached
      && explanation.provider !== 'DETERMINISTIC_TEMPLATE'
      && actualProviderTokens === 0;
      const chargeSessionReservation = usageUnavailable
        || (attemptedProviderFailure && explanation.providerUsageComplete !== true);
    const result = buildClientResponseDTO({
      response: explanation.text,
      session_id: sessionId,
      latency_ms: latencyMs,
      grounded: !isGeneralQuestion,
      provider: explanation.provider,
      model: explanation.model,
      prompt_version: explanation.promptVersion,
      grounding_version: explanation.groundingVersion,
      evidence_ids_used: explanation.evidenceIdsUsed,
      unavailable_facts: explanation.unavailableFacts,
      validation_status: explanation.validation.status,
      fallback: explanation.fallback,
      fallback_reason_codes: explanation.fallback ? explanation.validation.reasonCodes : [],
      messages_this_hour: rateCheck.count,
      rate_limit_remaining: CHAT_RATE_LIMIT - rateCheck.count,
      rate_limit_reset_at: new Date(rateCheck.resetAt).toISOString(),
      citations: explanation.citations,
      action_cards: [],
    });
    await requireCurrentBinding(binding, userId);
    await sessionStore.complete({
      claim,
      userMessage,
      modelMessage,
      actualTokens: actualProviderTokens,
      chargeReservation: chargeSessionReservation,
      preserveLease: true,
      turnReceipt: {
        keyHash,
        clientKeyHash,
        requestHash,
        response: result,
        createdAt: new Date(),
      },
    });
    sessionReservationSettled = true;
    try {
      await requireCurrentBinding(binding, userId);
      if (typeof sessionStore.finalizeCompletedTurn === 'function') {
        await sessionStore.finalizeCompletedTurn({ claim });
      } else {
        await sessionStore.release(claim, { chargeReservation: false });
      }
      completed = true;
    } catch (error) {
      if (error?.code === 'CHAT_PROFILE_STATE_CHANGED'
          && typeof sessionStore.discardCompletedTurn === 'function') {
        await sessionStore.discardCompletedTurn({
          userId,
          sessionId,
          binding,
          keyHash,
          clientKeyHash,
          ownerId: claim.ownerId,
        }).catch(() => {});
      }
      throw error;
    }
    return result;
  } finally {
    clearInterval(heartbeat);
    if (!completed) {
      await sessionStore.release(claim, {
        chargeReservation: providerAttempted && !sessionReservationSettled,
      }).catch(() => {});
    }
  }
}
