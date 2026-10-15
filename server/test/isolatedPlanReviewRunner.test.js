import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPlanReviewDataset } from '../agents/evals/planReviewEvals.js';
import { runIsolatedPlanReviewCase } from '../agents/evals/isolatedPlanReviewRunner.js';
import { estimatePlanReviewInputTokens } from '../agents/planReview/planReviewTokenBudget.js';
import { getProviderOutputContract, toGroqStrictSchema } from '../services/providerOutputContracts.js';

test('isolated live PlanReview reserves a bounded explanation call within its total token cap', async () => {
  const dataset = await loadPlanReviewDataset();
  const caseDefinition = dataset.find(item => item.profile === 'fixtures/profile-current.json');
  assert.ok(caseDefinition, 'the synthetic current-profile evaluation case exists');

  const requests = [];
  const provider = {
    name: 'offline-budget-regression',
    configuredModel: () => 'synthetic-budget-regression',
    isConfigured: () => true,
    async generate(args) {
      requests.push({ maxTokens: args.maxTokens });
      if (requests.length === 1) {
        return {
          text: JSON.stringify({ checks: ['check_recommendation_freshness'] }),
          tokensUsed: 360,
          provider: 'offline-budget-regression',
          model: 'synthetic-budget-regression',
        };
      }
      return null;
    },
  };

  const actual = await runIsolatedPlanReviewCase({ caseDefinition, provider });

  assert.deepEqual(requests, [{ maxTokens: 240 }, { maxTokens: 512 }]);
  assert.equal(actual.providerUsage.providerCalls, 2);
  assert.equal(actual.providerUsage.tokensUsed, 360);
  assert.equal(actual.result.explanation.fallback, true,
    'the offline null response remains a fallback and is not presented as a live evaluation pass');
});

test('freshness target reserves the compact JSON Object Mode cost for its explainer', async () => {
  const dataset = await loadPlanReviewDataset();
  const caseDefinition = dataset.find(item => item.id === 'fresh-read-only-plan');
  const requests = [];
  // This fixture reuses the previously observed 522-token planner usage for
  // conservative admission math; no provider or network request is made.
  const priorPlannerUsage = 522;
  const provider = {
    name: 'groq',
    configuredModel: () => 'openai/gpt-oss-120b',
    isConfigured: () => true,
    lastFailureReason: null,
    async generate(args) {
      requests.push(args);
      if (args.planReviewRole === 'PLANNER') {
        return {
          text: JSON.stringify({ checks: ['check_recommendation_freshness'] }),
          tokensUsed: priorPlannerUsage,
          provider: 'groq',
          model: 'openai/gpt-oss-120b',
        };
      }
      this.lastFailureReason = 'OFFLINE_BUDGET_PROBE';
      return null;
    },
  };

  const actual = await runIsolatedPlanReviewCase({ caseDefinition, provider });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].outputContract, 'PLAN_REVIEW_PLANNER_V1');
  assert.equal(requests[0].planReviewRole, 'PLANNER');
  assert.equal(requests[1].outputContract, 'GROUNDED_EXPLANATION_V1');
  assert.equal(requests[1].planReviewRole, 'EXPLAINER');
  assert.equal(requests[1].providerOutputMode, 'GROQ_JSON_OBJECT');
  assert.equal(requests[1].maxTokens, 512);

  const explainerHistory = requests[1].recentHistory
    .map(message => message.parts?.map(part => part.text || '').join('\n') || message.content || '')
    .join('\n');
  const explainerPromptBytes = Buffer.byteLength(`${requests[1].systemPrompt}\n${explainerHistory}`, 'utf8');
  const explainerInputEstimate = estimatePlanReviewInputTokens(explainerPromptBytes);
  const contract = getProviderOutputContract('GROUNDED_EXPLANATION_V1');
  const strictEnvelope = {
    response_format: {
      type: 'json_schema',
      json_schema: { name: contract.name, strict: true, schema: toGroqStrictSchema(contract.schema) },
    },
  };
  const strictSchemaBytes = Buffer.byteLength(JSON.stringify(strictEnvelope), 'utf8');
  const strictSchemaEstimate = estimatePlanReviewInputTokens(strictSchemaBytes);
  const objectModeTotalEstimate = priorPlannerUsage + explainerInputEstimate + 512;
  const strictModeTotalEstimate = objectModeTotalEstimate + strictSchemaEstimate;

  assert.equal(explainerPromptBytes, 2887);
  assert.equal(explainerInputEstimate, 831);
  assert.equal(strictSchemaBytes, 1529);
  assert.equal(strictSchemaEstimate, 440);
  assert.equal(objectModeTotalEstimate, 1865);
  assert.equal(strictModeTotalEstimate, 2305);
  assert.ok(objectModeTotalEstimate <= 2500);
  assert.ok(strictModeTotalEstimate > objectModeTotalEstimate,
    'the strict schema envelope has a separately measurable cost');
  assert.equal(actual.result.review.execution.tokenUsage, objectModeTotalEstimate,
    'runtime admission includes the prior planner usage and full explanation reservation');
  assert.equal(actual.result.explanation.fallback, true,
    'the offline probe does not fabricate a live explanation pass');
});

test('cross-user fixture records the actual caller-scoped denial without exposing profile data or invoking tools/models', async () => {
  const dataset = await loadPlanReviewDataset();
  const caseDefinition = dataset.find(item => item.id === 'cross-user-profile');
  const actual = await runIsolatedPlanReviewCase({ caseDefinition });

  assert.equal(actual.authorizationEvidence.schemaVersion, 'phase16-profile-access-evidence-v1');
  assert.equal(actual.authorizationEvidence.outcome, 'DENIED');
  assert.equal(actual.authorizationEvidence.fixtureOwnerMismatch, true);
  assert.equal(actual.authorizationEvidence.requestedProfileLookupObserved, true);
  assert.equal(actual.authorizationEvidence.callerScopedProfileLookupObserved, true);
  assert.equal(actual.authorizationEvidence.callerScopedLookupOutcome, 'NOT_FOUND');
  assert.equal(actual.authorizationEvidence.profileDataExposed, false);
  assert.deepEqual(actual.authorizationEvidence.requiredReasonCodesObserved, ['PROFILE_MISSING']);
  assert.equal(actual.authorizationEvidence.modelInvocationObserved, false);
  assert.equal(actual.authorizationEvidence.providerCalls, 0);
  assert.equal(actual.authorizationEvidence.providerCallAttempts, 0);
  assert.equal(actual.authorizationEvidence.selectedToolCount, 0);
  assert.equal(actual.authorizationEvidence.executedToolCount, 0);
  assert.equal(actual.result.review.recommendedAction, 'REVIEW_PROFILE');
  assert.equal(actual.result.profile, null);
  assert.equal(actual.result.profileContext, null);
  assert.equal(actual.result.currentState.profile, null);
  assert.deepEqual(actual.result.review.evidence.entries, []);
  assert.deepEqual(actual.trajectory.filter(event => ['TOOL_SELECTED', 'TOOL_SUCCEEDED'].includes(event.type)), []);
});
