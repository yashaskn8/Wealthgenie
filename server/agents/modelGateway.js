import { ProviderManager } from '../services/providerAbstraction.js';

export const MODEL_ROLES = Object.freeze(['PLANNER', 'EXPLAINER', 'VERIFIER', 'EVOLUTION_RESEARCH']);

const GEMINI_FALLBACK_FAILURES = new Set([
  'PROVIDER_TIMEOUT',
  'PROVIDER_SERVER_ERROR',
  'PROVIDER_NETWORK_ERROR',
]);

function configuredOrder(allowGeminiFallback) {
  // CI/local lifecycle runs use the deterministic explanation path. Treat the
  // explicit mock setting as "no external model providers", not as permission
  // to route to a default real provider.
  if (String(process.env.LLM_DEFAULT_PROVIDER || '').trim().toLowerCase() === 'mock') return [];
  const primary = String(process.env.LLM_PRIMARY_PROVIDER || 'GROQ').trim().toUpperCase();
  const table = {
    NVIDIA_NIM: ProviderManager.nvidia,
    GEMINI: ProviderManager.gemini,
    GROQ: ProviderManager.groq,
  };
  const selected = [table[primary]];
  if (primary === 'GROQ' && allowGeminiFallback) selected.push(table.GEMINI);
  return selected.filter(Boolean);
}

function canUseGeminiFallback({ primary, candidate, allowGeminiFallback, requestBudget, fallbackAttempted }) {
  return !fallbackAttempted
    && allowGeminiFallback === true
    && primary?.name === 'groq'
    && candidate?.name === 'gemini'
    // Automatic failover requires the durable, run-scoped PlanReview budget.
    && requestBudget?.durableReservations === true
    && typeof requestBudget.reserve === 'function'
    && typeof requestBudget.settle === 'function';
}

export function createModelGateway({
  providers = null,
  maxOutputTokens = 1200,
  allowGeminiFallback = String(process.env.LLM_GEMINI_FALLBACK_ENABLED || '').trim().toLowerCase() === 'true',
} = {}) {
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) {
    throw new RangeError('Model gateway output token limit must be a positive safe integer.');
  }
  const providerChain = providers || configuredOrder(allowGeminiFallback);
  return {
    async generate({ role, systemPrompt, recentHistory = [], maxTokens = maxOutputTokens, jsonMode = false, outputContract = null, providerOutputMode = null, requestBudget = null, signal } = {}) {
      if (!MODEL_ROLES.includes(role)) throw new Error('Unknown model gateway role.');
      if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) {
        throw new RangeError('Model gateway maxTokens must be a positive safe integer.');
      }
      const boundedMaxTokens = Math.min(maxTokens, maxOutputTokens);
      const startedAt = Date.now();
      const failures = [];
      const attempts = [];
      let fallbackAttempted = false;

      for (let index = 0; index < Math.min(providerChain.length, 2); index += 1) {
        const provider = providerChain[index];
        const isFallback = index > 0;
        if (isFallback && !canUseGeminiFallback({
          primary: providerChain[0],
          candidate: provider,
          allowGeminiFallback,
          requestBudget,
          fallbackAttempted,
        })) break;
        if (!provider || typeof provider.generate !== 'function') continue;

        // A missing primary credential is a configuration failure, not a
        // transient outage. Never route around it with another provider.
        if (typeof provider.isConfigured === 'function' && !provider.isConfigured()) {
          const code = `${provider.name || 'provider'}_not_configured`;
          failures.push(code);
          attempts.push({ provider: provider.name || 'unknown', outcome: code });
          break;
        }

        let response = null;
        let reservation = null;
        try {
          reservation = requestBudget ? await requestBudget.reserve({
            systemPrompt,
            recentHistory,
            maxTokens: boundedMaxTokens,
            outputContract,
            providerOutputMode: role === 'EXPLAINER'
              && provider.name === 'groq'
              && outputContract === 'GROUNDED_EXPLANATION_V1'
              && providerOutputMode === 'GROQ_JSON_OBJECT'
              ? providerOutputMode
              : null,
            providerName: provider.name || null,
          }) : null;
          if (isFallback) fallbackAttempted = true;
          response = await provider.generate({
            systemPrompt,
            recentHistory,
            maxTokens: boundedMaxTokens,
            jsonMode,
            outputContract,
            ...(role === 'EXPLAINER'
              && provider.name === 'groq'
              && outputContract === 'GROUNDED_EXPLANATION_V1'
              && providerOutputMode === 'GROQ_JSON_OBJECT'
              ? { providerOutputMode }
              : {}),
            tools: null,
            signal,
          });
          if (signal?.aborted) throw signal.reason || Object.assign(new Error('Provider request aborted.'), { name: 'AbortError' });
          const usage = response?.tokensUsed ?? response?.usage?.totalTokens ?? response?.usageMetadata?.totalTokenCount;
          if (response && reservation) requestBudget.settle(reservation, usage);
        } catch (error) {
          if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ERR_CANCELED') throw error;
          if (error?.code === 'AGENT_BUDGET_EXCEEDED' || error?.code === 'AGENT_BUDGET_PERSISTENCE_UNAVAILABLE') throw error;
          const code = String(provider.lastFailureReason || error?.code || '');
          if (!code.startsWith('PROVIDER_')) throw error;
          failures.push(code);
          attempts.push({ provider: provider.name || 'unknown', outcome: code });
          const next = providerChain[index + 1];
          if (GEMINI_FALLBACK_FAILURES.has(code)
              && canUseGeminiFallback({
                primary: providerChain[0],
                candidate: next,
                allowGeminiFallback,
                requestBudget,
                fallbackAttempted,
              })) continue;
          break;
        }

        if (response) {
          attempts.push({ provider: provider.name || 'unknown', outcome: 'SUCCESS' });
          const providerFallbackReason = failures[0] || null;
          return {
            ...response,
            fallback: isFallback,
            fallbackReason: providerFallbackReason,
            routing: {
              role,
              provider: response.provider || provider.name,
              model: response.model || provider.configuredModel?.() || null,
              latencyMs: Date.now() - startedAt,
              tokensUsed: Number(response.tokensUsed ?? response.usage?.totalTokens ?? response.usageMetadata?.totalTokenCount) || 0,
              fallback: isFallback,
              attemptedProviders: attempts.map(attempt => attempt.provider),
              providerAttempts: attempts,
              fallbackReason: providerFallbackReason,
            },
          };
        }

        const code = String(provider.lastFailureReason || `${provider.name || 'provider'}_unavailable`);
        failures.push(code);
        attempts.push({ provider: provider.name || 'unknown', outcome: code });
        const next = providerChain[index + 1];
        if (GEMINI_FALLBACK_FAILURES.has(code)
            && canUseGeminiFallback({
              primary: providerChain[0],
              candidate: next,
              allowGeminiFallback,
              requestBudget,
              fallbackAttempted,
            })) continue;
        break;
      }

      return {
        text: null,
        fallback: fallbackAttempted,
        fallbackReason: failures[0] || 'NO_PROVIDER_RESPONSE',
        routing: {
          role,
          provider: null,
          model: null,
          latencyMs: Date.now() - startedAt,
          tokensUsed: 0,
          fallback: fallbackAttempted,
          attemptedProviders: attempts.map(attempt => attempt.provider),
          providerAttempts: attempts,
          fallbackReason: failures[0] || 'NO_PROVIDER_RESPONSE',
        },
      };
    },
  };
}
