import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isInvestmentUniverseEducationQuestion,
  listInvestmentUniverseEducationEntries,
  retrieveInvestmentUniverseEducation,
  retrieveGoalHorizonEducation,
} from '../services/chatInvestmentUniverseEducation.js';
import { isGeneralChatQuestion } from '../services/generalChatService.js';
import { classifyGenieChatQuestion } from '../services/chatQuestionRouting.js';
import {
  isFinancialGoalPlanningQuestion,
  retrieveChatGoalPlanningEvidence,
} from '../services/chatGoalPlanning.js';
import { buildChatEvidencePacket, generateGroundedExplanation } from '../services/groundedExplanationService.js';

const CATALOG = listInvestmentUniverseEducationEntries();

test('exactly 250 entries are indexed as non-investable discovery education, not tradable products', () => {
  assert.equal(CATALOG.length, 250);
  assert.equal(new Set(CATALOG.map(item => item.id)).size, 250);
  assert.equal(new Set(CATALOG.map(item => item.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())).size, 250);
  assert.equal(CATALOG.filter(x => x.sourceKind === 'LEGACY_CATALOG_UNVERIFIED').length, 155);
  assert.equal(CATALOG.filter(x => x.sourceKind === 'CATEGORY_ARCHETYPE_UNVERIFIED').length, 95);
  for (const entry of CATALOG) {
    assert.equal(entry.availabilityVerified, false);
    assert.equal(entry.investmentTermsVerified, false);
    assert.equal(entry.suitableForInvestor, null);
  }
});

test('all 250 named entries are findable without inventing rate, return, tax or suitability facts', () => {
  for (const item of CATALOG) {
    const question = 'Explain ' + item.name + ' as an investment option';
    assert.equal(isInvestmentUniverseEducationQuestion(question), true, item.id);
    assert.equal(isGeneralChatQuestion(question), false, item.id);
    assert.equal(classifyGenieChatQuestion(question), 'FINANCIAL_GROUNDED', item.id);
    const entries = retrieveInvestmentUniverseEducation(question);
    assert.ok(entries.length >= 1 && entries.length <= 2, item.id);
    assert.ok(entries.some(x => x.id === 'E_EDU_CATALOG_' + item.id.toUpperCase().replace(/[^A-Z0-9_]/g, '_')), item.id);
    for (const entry of entries) {
      assert.equal(entry.kind, 'EDUCATION');
      assert.equal(entry.value.productRecommendation, false);
      assert.equal(entry.value.currentProductFactsVerified, false);
      assert.match(entry.displayValue, /not a verified available security or personal recommendation/);
      assert.doesNotMatch(entry.displayValue, /\b(?:CAGR|assured\s+return|guaranteed\s+profit|current\s+NAV\s+is)\b/i);
    }
  }
});

test('catalog overview is factual about coverage and explicit about unavailable qualification', () => {
  for (const question of [
    'List all 250 investment options',
    'How many investment options are in the catalog?',
    'Show WealthGenie investment universe',
  ]) {
    const [entry] = retrieveInvestmentUniverseEducation(question);
    assert.equal(entry.id, 'E_EDU_UNIVERSE_SCOPE');
    assert.match(entry.displayValue, /155 legacy catalog entries and 95 newer/);
    assert.match(entry.displayValue, /not 250 verified purchasable products/);
    assert.equal(entry.value.productRecommendation, false);
  }
});

test('adversarial investment questions cannot turn catalog into live rates or buy instructions', () => {
  const sample = CATALOG.slice(0, 35);
  for (const item of sample) {
    const question = 'What is the guaranteed return and exact tax when I buy ' + item.name + '?';
    const answer = retrieveInvestmentUniverseEducation(question);
    assert.ok(answer.length, item.id);
    assert.ok(answer.some(x => /does not verify a current rate/.test(x.displayValue)), item.id);
    assert.ok(answer.every(x => x.source?.url === null && x.source?.provider === 'WEALTHGENIE_CATALOG'));
    assert.ok(answer.every(x => x.authority === 'WEALTHGENIE_BACKEND'));
  }
  assert.deepEqual(retrieveInvestmentUniverseEducation('Who won the football final yesterday?'), []);
});

const toughCases = [
  "Suppose a man has to invest 2 crores for his daughters marriage; what should he do?",
  "A father needs ₹2 crore for his daughter's marriage. How should he plan?",
  "I must pay ₹2 crore for my daughter's wedding in two years, what should I save?",
  "We need 2 crores for a wedding in 15 years and have no savings",
  "I want to accumulate 2 crore in 10 years",
  "My son's education will cost ₹80 lakh in five years, what should I save?",
  "For my parents retirement I need 3 crore in 20 years",
  "I need ₹15 lakh for emergency expenses in a year",
  "A family needs ₹40 lakh for a home down payment in 4 years",
  "We want ₹10 lakh for our vehicle in three years",
  "Our medical fund target is ₹30 lakh in 7 years",
  "I need ₹6 lakh for a vacation in 18 months",
  "A business goal needs ₹25 lakh in 36 months",
];

test('hard goal prompts route through the grounded goal planner instead of unverified LLM', () => {
  for (const prompt of toughCases) {
    assert.equal(isFinancialGoalPlanningQuestion(prompt), true, prompt);
    assert.equal(isGeneralChatQuestion(prompt), false, prompt);
    assert.equal(classifyGenieChatQuestion(prompt), 'FINANCIAL_GROUNDED', prompt);
    const evidence = retrieveChatGoalPlanningEvidence(prompt);
    assert.ok(evidence.some(x => x.id === 'E_GOAL_PLANNING_GUIDANCE'), prompt);
    assert.equal(retrieveGoalHorizonEducation(prompt, evidence).length, 1, prompt);
  }
});

test('ambiguous ₹2 crore wedding case asks about target versus existing principal and timeline', () => {
  const question = "Suppose a man has to invest 2 crores for his daughters marriage; what should he do?";
  const goal = retrieveChatGoalPlanningEvidence(question);
  const guide = goal.find(x => x.id === 'E_GOAL_PLANNING_GUIDANCE');
  assert.match(guide.displayValue, /deadline/);
  assert.match(guide.displayValue, /already available to invest or is the amount the goal must reach/);
  const horizon = retrieveGoalHorizonEducation(question, goal)[0];
  assert.match(horizon.displayValue, /Without a deadline/);
});

test('short and long marriage deadlines produce different conservative horizon evidence', () => {
  const qShort = "I need ₹2 crore for my daughter's wedding in 2 years. Starting from zero savings.";
  const qLong = "I need ₹2 crore for my daughter's wedding in 12 years. Starting from zero savings.";
  const short = retrieveChatGoalPlanningEvidence(qShort);
  const long = retrieveChatGoalPlanningEvidence(qLong);
  const s = retrieveGoalHorizonEducation(qShort, short)[0];
  const l = retrieveGoalHorizonEducation(qLong, long)[0];
  assert.match(s.displayValue, /within three years/);
  assert.match(l.displayValue, /more than seven years/);
  assert.match(s.displayValue, /not individual product recommendations/);
  assert.match(l.displayValue, /not individual product recommendations/);
});

test('authenticated evidence packet includes 250-entry educational scope, never product recommendation', async () => {
  const packet = await buildChatEvidencePacket({
    question: 'Explain the 250 investment options in WealthGenie',
    profile: null, recommendation: null, userId: null,
  }, { queryRegulatoryRag: async () => null });
  const scope = packet.entries.find(x => x.id === 'E_EDU_UNIVERSE_SCOPE');
  assert.ok(scope);
  assert.equal(scope.value.productRecommendation, false);
  assert.equal(scope.dataClass, 'CURATED_PUBLIC_EDUCATION');
  assert.equal(packet.entries.some(x => x.value?.verifiedPurchasableProduct === true), false);
});

test('deterministic grounded response to difficult wedding prompt explains the plan', async () => {
  const question = 'I need ₹2 crore for my daughter wedding in 2 years. Starting from zero savings.';
  const packet = await buildChatEvidencePacket({
    question, profile: null, recommendation: null, userId: null,
  }, { queryRegulatoryRag: async () => null });
  assert.ok(packet.entries.some(x => x.id === 'E_EDU_GOAL_HORIZON'));
  const answer = await generateGroundedExplanation({ question, evidencePacket: packet }, {
    providers: [], getCache: async () => null, setCache: async () => false,
  });
  assert.match(answer.text, /goal|wedding|marriage/i);
  assert.match(answer.text, /within three years/);
  assert.doesNotMatch(answer.text, /guaranteed return|buy a specific/i);
});
