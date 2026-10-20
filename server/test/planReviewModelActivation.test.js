import assert from 'node:assert/strict';
import test from 'node:test';
import { isLivePlanReviewPlannerReady } from '../agents/planReview/planReviewService.js';

test('optional model planner never turns on without a genuine configured primary', () => {
  const base = { AGENT_USE_MODEL_PLANNER: 'true' };
  assert.equal(isLivePlanReviewPlannerReady(base), false);
  assert.equal(isLivePlanReviewPlannerReady({ ...base, GROQ_API_KEY: 'your_groq_api_key_here' }), false);
  assert.equal(isLivePlanReviewPlannerReady({ ...base, GROQ_API_KEY: 'CHANGE_ME_GROQ_API_KEY' }), false);
  assert.equal(isLivePlanReviewPlannerReady({ ...base, GROQ_API_KEY: 'unit-test-configured-groq' }), true);
  assert.equal(isLivePlanReviewPlannerReady({ ...base, GROQ_API_KEY: 'unit-test-configured-groq', AGENT_USE_MODEL_PLANNER: 'false' }), false);
  assert.equal(isLivePlanReviewPlannerReady({ ...base, GROQ_API_KEY: 'unit-test-configured-groq', LLM_DEFAULT_PROVIDER: 'mock' }), false);
  assert.equal(isLivePlanReviewPlannerReady({ ...base, GROQ_API_KEY: 'unit-test-configured-groq', LLM_PRIMARY_PROVIDER: 'UNKNOWN' }), false);
});

test('explicit non-Groq providers need their own key; unrelated keys never authorize planning', () => {
  const base = { AGENT_USE_MODEL_PLANNER: 'true', GROQ_API_KEY: 'unit-test-groq-key' };
  assert.equal(isLivePlanReviewPlannerReady({ ...base, LLM_PRIMARY_PROVIDER: 'GEMINI' }), false);
  assert.equal(isLivePlanReviewPlannerReady({ ...base, LLM_PRIMARY_PROVIDER: 'GEMINI', GEMINI_API_KEY: 'your_gemini_api_key_here' }), false);
  assert.equal(isLivePlanReviewPlannerReady({ ...base, LLM_PRIMARY_PROVIDER: 'GEMINI', GEMINI_API_KEY: 'unit-test-gemini-key' }), true);
  assert.equal(isLivePlanReviewPlannerReady({ ...base, LLM_PRIMARY_PROVIDER: 'NVIDIA_NIM', NVIDIA_API_KEY: 'unit-test-nvidia-key' }), true);
  assert.equal(isLivePlanReviewPlannerReady({ ...base, LLM_PRIMARY_PROVIDER: 'NVIDIA_NIM' }), false);
});
