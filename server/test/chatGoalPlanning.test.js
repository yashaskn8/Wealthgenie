import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isFinancialGoalPlanningQuestion,
  retrieveChatGoalPlanningEvidence,
} from '../services/chatGoalPlanning.js';
import {
  buildChatEvidencePacket,
  generateGroundedExplanation,
} from '../services/groundedExplanationService.js';
import { validateGroundedExplanation } from '../services/groundingValidator.js';
import { isGeneralChatQuestion } from '../services/generalChatService.js';

const profile = Object.freeze({
  age: 40, monthlySavings: 20000,
  riskTolerance: 'Moderate', suitabilityRisk: 'Moderate',
  investmentHorizonYears: 12,
});
const dependencies = { providers: [], getCache: async () => null, setCache: async () => false };
const createPacket = question => buildChatEvidencePacket({
  question, profile, recommendation: null,
}, { queryRegulatoryRag: async () => null });

test('daughter wedding funding: parses crore target, not investment product recommendation', async () => {
  const question = "I need 2 crore for my daughter's marriage. How should I plan?";
  assert.equal(isFinancialGoalPlanningQuestion(question), true);
  assert.equal(isGeneralChatQuestion(question), false);
  const packet = await createPacket(question);
  const goal = packet.entries.find(entry => entry.id === 'E_GOAL_STATED_TARGET');
  assert.equal(goal.value.targetAmount, 20_000_000);
  assert.equal(goal.source, null, 'user-supplied amount must never carry a fake external URL');
  assert.equal(packet.entries.some(entry => entry.id === 'E_GOAL_MONTHLY_BASELINE'), false);
  const answer = await generateGroundedExplanation({ question, evidencePacket: packet }, dependencies);
  assert.equal(answer.provider, 'DETERMINISTIC_TEMPLATE');
  assert.equal(answer.validation.status, 'PASS');
  assert.match(answer.text, /2,00,00,000/);
  assert.match(answer.text, /deadline in years/);
  assert.match(answer.text, /how much is already earmarked/);
  assert.match(answer.text, /monthly/);
  assert.doesNotMatch(answer.text, /guaranteed|12%|suitable mutual fund|definition of SIP/i);
  assert.ok(answer.citations.some(item => item.citation_id === 'E_GOAL_STATED_TARGET' && item.source_url === null));
});

test('spoken expo typo and crore spelling still reach the same checked goal response', async () => {
  const question = 'my saugters marriage I need 2 cror so what should I do';
  assert.equal(isFinancialGoalPlanningQuestion(question), true);
  assert.equal(isGeneralChatQuestion(question), false);
  const packet = await createPacket(question);
  assert.equal(packet.entries.find(entry => entry.id === 'E_GOAL_STATED_TARGET')?.value.targetAmount, 20_000_000);
  const answer = await generateGroundedExplanation({ question, evidencePacket: packet }, dependencies);
  assert.equal(answer.validation.status, 'PASS');
  assert.match(answer.text, /2,00,00,000/);
  assert.match(answer.text, /daughter's marriage/);
});

test('stated zero savings, 2-crore target and 10-year deadline yield an exact paise baseline, never a forecast', async () => {
  const question = 'I need 2 crore for my daughter wedding in 10 years, starting from zero.';
  const packet = await createPacket(question);
  const result = packet.entries.find(item => item.id === 'E_GOAL_MONTHLY_BASELINE');
  assert.equal(result.value.targetAmount, 20_000_000);
  assert.equal(result.value.earmarkedSavingsAmount, 0);
  assert.equal(result.value.horizonMonths, 120);
  assert.equal(result.value.monthlyRequiredAmount, 166666.67);
  assert.equal(result.value.assumedGrowthRate, null);
  assert.equal(result.value.inflationRate, null);
  const answer = await generateGroundedExplanation({ question, evidencePacket: packet }, dependencies);
  assert.equal(answer.validation.status, 'PASS');
  assert.equal(answer.provider, 'DETERMINISTIC_TEMPLATE');
  assert.match(answer.text, /1,66,666\.67 per month/);
  assert.doesNotMatch(answer.text, /10% return|assured|FD recommendation/i);
  assert.ok(answer.financialClaims.some(item => item.type === 'GOAL_TARGET'));
  assert.ok(answer.financialClaims.some(item => item.type === 'GOAL_MONTHLY_BASELINE' && item.value === 166666.67));
  assert.equal(validateGroundedExplanation({
    text: answer.text,
    claims: answer.claims, evidenceIdsUsed: answer.evidenceIdsUsed,
    financialClaims: answer.financialClaims, unavailableFacts: answer.unavailableFacts,
  }, packet).valid, true);
});

test('compares stated monthly saving capacity instead of giving generic SIP definitions', async () => {
  const question = "Need 2 crore for daughter's marriage in 10 years. I have already saved 20 lakh; I can save 50k per month.";
  const packet = await createPacket(question);
  assert.equal(packet.entries.find(e => e.id === 'E_GOAL_MONTHLY_BASELINE')?.value.monthlyRequiredAmount, 150000);
  const capacity = packet.entries.find(e => e.id === 'E_GOAL_CAPACITY_CHECK');
  assert.equal(capacity.value.monthlyCapacityAmount, 50000);
  assert.equal(capacity.value.goalIsContributionFundable, false);
  const answer = await generateGroundedExplanation({ question, evidencePacket: packet }, dependencies);
  assert.equal(answer.validation.status, 'PASS');
  assert.match(answer.text, /1,50,000 per month/);
  assert.match(answer.text, /not fundable from contributions alone/i);
  assert.match(answer.text, /revising the target or date/i);
  assert.ok(answer.citations.some(citation => citation.citation_id === 'E_GOAL_CAPACITY_CHECK'));
  assert.doesNotMatch(answer.text, /What is a SIP|SIP stands for|guaranteed returns/i);
});

test('ambiguous amounts and incomplete horizon abstain rather than inventing a monthly SIP', async () => {
  for (const question of [
    "Need 1 crore or 2 crore for my daughter's wedding.",
    'Want funds for a home and retirement in the future.',
    "Need 2 crore for marriage in a few years.",
    'Save 2 crore for my child education in 0 years',
  ]) {
    const packet = await createPacket(question);
    assert.equal(packet.entries.some(e => e.id === 'E_GOAL_MONTHLY_BASELINE'), false, question);
    const answer = await generateGroundedExplanation({ question, evidencePacket: packet }, dependencies);
    assert.equal(answer.validation.status, 'PASS', question);
    assert.equal(answer.provider, 'DETERMINISTIC_TEMPLATE', question);
    assert.doesNotMatch(answer.text, /baseline: INR.*per month/i, question);
  }
});

test('financial goal input is checked by a deterministic planner without calling LLM or unrelated public reference', async () => {
  const question = 'I want 2 crore for my daughter marriage in 10 years starting from zero';
  const packet = await createPacket(question);
  let called = 0;
  const answer = await generateGroundedExplanation({ question, evidencePacket: packet }, {
    ...dependencies,
    providers: [{ name: 'groq', isConfigured: () => true, async generate() { called++; return {
      text: 'Buy this risky asset; you will earn 35% guaranteed.' };
    } }],
  });
  assert.equal(called, 0);
  assert.equal(answer.validation.status, 'PASS');
  assert.equal(answer.provider, 'DETERMINISTIC_TEMPLATE');
  assert.equal(answer.providerAttemptCount, 0);
  assert.ok(answer.citations.every(citation => citation.source_url === null
    || !citation.citation_id.startsWith('E_GOAL_')));
  assert.doesNotMatch(answer.text, /35% guaranteed|Buy this risky asset/i);
});

test('unrelated ordinary conversational questions remain on the general LLM route', () => {
  assert.equal(isFinancialGoalPlanningQuestion('Write a Python function to reverse a list'), false);
  assert.equal(isGeneralChatQuestion('Write a Python function to reverse a list'), true);
  assert.equal(isFinancialGoalPlanningQuestion('What is an Indian wedding tradition?'), false);
  assert.equal(isFinancialGoalPlanningQuestion('How do I plan to save for a house?'), true);
});
