import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildGroundedEvidencePacket } from '../services/groundedEvidence.js';
import { generateGroundedExplanation } from '../services/groundedExplanationService.js';
import { createPlanReviewTokenBudget } from '../agents/planReview/planReviewTokenBudget.js';

function packet() {
  return buildGroundedEvidencePacket({
    question: 'Given my profile, explain suitability.',
    profile: {
      age: 35,
      monthlySavings: 20000,
      riskTolerance: 'Moderate',
      suitabilityRisk: 'Moderate',
      investmentHorizonYears: 10,
      investmentGoals: ['Wealth Growth'],
      suitabilityReasonCodes: ['PREFERENCE_CAP'],
    },
  });
}

function output(value = 'Moderate') {
  const text = `The backend suitability ceiling is ${value} [E_PROFILE_RISK].`;
  return JSON.stringify({
    text,
    evidenceIdsUsed: ['E_PROFILE_RISK'],
    claims: [{ text, evidenceIds: ['E_PROFILE_RISK'] }],
    financialClaims: [],
    unavailableFacts: [],
  });
}

const noCache = { getCache: async () => null, setCache: async () => false };

describe('Phase 6 bounded grounded generation', () => {
  it('never exposes tools or starts an LLM-controlled replan loop', async () => {
    let calls = 0;
    let request;
    const provider = {
      name: 'nvidia_nim',
      configuredModel: () => 'test-model',
      generate: async args => {
        calls += 1;
        request = args;
        return { provider: 'nvidia_nim', model: 'test-model', text: output(), tool_calls: [{ tool: 'portfolio_optimizer' }] };
      },
    };
    const result = await generateGroundedExplanation({ question: 'Explain suitability.', evidencePacket: packet() }, {
      providers: [provider], ...noCache,
    });
    assert.equal(calls, 1);
    assert.equal(request.tools, null);
    assert.equal(result.provider, 'NVIDIA_NIM');
    assert.equal(result.validation.status, 'PASS');
    assert.equal(result.toolCalls, undefined);
  });

  it('uses the identical evidence contract for explicitly budgeted Groq-to-Gemini transport fallback', async () => {
    const requests = [];
    const first = {
      name: 'groq', configuredModel: () => 'openai/gpt-oss-120b',
      generate: async args => {
        requests.push(args);
        first.lastFailureReason = 'PROVIDER_SERVER_ERROR';
        return null;
      },
    };
    const second = {
      name: 'gemini', configuredModel: () => 'gemini-test',
      generate: async args => {
        requests.push(args);
        return { provider: 'gemini', model: 'gemini-test', text: output(), tokensUsed: 5 };
      },
    };
    const requestBudget = createPlanReviewTokenBudget({
      maxInputTokens: 4000,
      maxOutputTokens: 1200,
      maxTotalTokens: 5200,
      maxModelCalls: 2,
      onReserve: async () => undefined,
    });
    const result = await generateGroundedExplanation({ question: 'Explain suitability.', evidencePacket: packet() }, {
      providers: [first, second],
      allowGeminiFallback: true,
      requestBudget,
      ...noCache,
    });
    assert.equal(requests.length, 2);
    assert.equal(requests[0].recentHistory[0].parts[0].text, requests[1].recentHistory[0].parts[0].text);
    assert.equal(result.provider, 'GEMINI');
    assert.equal(result.model, 'gemini-test');
    assert.equal(result.fallback, true);
    assert.ok(result.validation.reasonCodes.includes('PROVIDER_SERVER_ERROR'));
    assert.equal(requestBudget.modelCalls, 2);
  });

  it('malformed structured output is not retried against another provider', async () => {
    let calls = 0;
    const providers = Array.from({ length: 3 }, (_, index) => ({
      name: `provider_${index}`,
      configuredModel: () => `model_${index}`,
      generate: async () => {
        calls += 1;
        return { provider: `provider_${index}`, model: `model_${index}`, text: '{malformed' };
      },
    }));
    const result = await generateGroundedExplanation({ question: 'Explain suitability.', evidencePacket: packet() }, {
      providers, ...noCache,
    });
    assert.equal(calls, 1);
    assert.equal(result.provider, 'DETERMINISTIC_TEMPLATE');
    assert.equal(result.fallback, true);
    assert.ok(result.validation.reasonCodes.includes('MALFORMED_GROUNDED_JSON'));
  });
});
