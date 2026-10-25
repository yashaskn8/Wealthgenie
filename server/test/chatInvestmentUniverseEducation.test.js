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
  assert.match(s.displayValue, /not (?:an? )?individual product recommendations|None of these are individual product recommendations/i);
  assert.match(l.displayValue, /not (?:an? )?individual product recommendations|None of these are individual product recommendations/i);
});

test('authenticated evidence packet includes 250-entry educational scope, never product recommendation', async () => {
  const packet = await buildChatEvidencePacket({
    question: 'Explain the 250 investment options in WealthGenie',
    profile: null, recommendation: null, userId: null,
  }, { queryRegulatoryRag: async () => null });
  const scope = packet.entries.find(x => x.id === 'E_EDU_UNIVERSE_SCOPE');
  assert.ok(scope);
  assert.equal(scope.value.productRecommendation, false);
  assert.equal(scope.dataClass, 'INTERNAL_CATALOG_DISCOVERY');
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

test('index product names containing 250 never collide with catalog-wide count requests', () => {
  const actualIndex = CATALOG.find(entry => entry.id === 'catalog_2026_index_smallcap250');
  assert.ok(actualIndex, 'Catalog must contain the independently reviewed index archetype');
  const query = 'Explain ' + actualIndex.name + ' as an investment option';
  const entries = retrieveInvestmentUniverseEducation(query);
  assert.ok(entries.every(entry => entry.id !== 'E_EDU_UNIVERSE_SCOPE'));
  assert.ok(entries.length > 0);
});

test('wedding investment question does not turn a named existing principal into an investment return forecast', () => {
  const question = 'Suppose a man has to invest 2 crores for his daughters marriage; what should he do?';
  const goal = retrieveChatGoalPlanningEvidence(question);
  const guidance = goal.find(entry => entry.id === 'E_GOAL_PLANNING_GUIDANCE');
  assert.ok(guidance);
  assert.equal(goal.some(entry => entry.id === 'E_GOAL_RETURN_SCENARIO'), false);
  assert.match(guidance.displayValue, /already available to invest or is the amount the goal must reach/);
});

test('capital available for investment must not be misrepresented as an already-known wedding target', () => {
  const question = 'Suppose a man has to invest 2 crores for his daughters marriage; what should he do?';
  const entries = retrieveChatGoalPlanningEvidence(question);
  assert.equal(entries.some(x => x.id === 'E_GOAL_STATED_TARGET'), false);
  assert.equal(entries.some(x => x.id === 'E_GOAL_MONTHLY_BASELINE'), false);
  assert.equal(entries.some(x => x.id === 'E_GOAL_RETURN_SCENARIO'), false);
  const guidance = entries.find(x => x.id === 'E_GOAL_PLANNING_GUIDANCE');
  assert.ok(guidance);
  assert.match(guidance.displayValue, /already available to invest or is the amount the goal must reach/);
});

test('explicit wedding target remains calculable from an exact date and zero earmarked savings', () => {
  const entries = retrieveChatGoalPlanningEvidence(
    "I need ₹2 crore for my daughter's marriage in 10 years, starting with zero savings."
  );
  assert.equal(entries.find(x => x.id === 'E_GOAL_STATED_TARGET')?.value.targetAmount, 20000000);
  assert.equal(entries.find(x => x.id === 'E_GOAL_MONTHLY_BASELINE')?.value.horizonMonths, 120);
  assert.equal(entries.find(x => x.id === 'E_GOAL_RETURN_SCENARIO'), undefined);
});

test('emergency-expense goal classification works without investment advice', () => {
  const question = 'I need ₹15 lakh for emergency expenses in a year';
  assert.equal(isFinancialGoalPlanningQuestion(question), true);
  const facts = retrieveChatGoalPlanningEvidence(question);
  const explanation = facts.find(item => item.id === 'E_GOAL_PLANNING_GUIDANCE');
  assert.ok(explanation);
  assert.match(explanation.displayValue, /emergency reserve/);
  assert.equal(facts.some(x => x.id === 'E_GOAL_RETURN_SCENARIO'), false);
});

test('third-person real-life goal statements are recognized without a first-person pronoun', () => {
  for (const query of [
    "A father needs ₹2 crore for his daughter's marriage in 10 years",
    "A family needs ₹40 lakh for a home down payment in 4 years",
    "A business goal needs ₹25 lakh in 36 months",
    "A parent wants ₹12 lakh for education in 6 years",
  ]) {
    assert.equal(isFinancialGoalPlanningQuestion(query), true, query);
    assert.ok(retrieveChatGoalPlanningEvidence(query).some(x => x.id === 'E_GOAL_PLANNING_GUIDANCE'));
  }
});

test('catalog provenance cannot masquerade as a public regulatory source', () => {
  const sample = CATALOG[0];
  const [internal] = retrieveInvestmentUniverseEducation(
    'Explain ' + sample.name + ' as an investment option',
  );
  assert.equal(internal.source.provider, 'WEALTHGENIE_CATALOG');
  assert.equal(internal.source.url, null);
  assert.equal(internal.authority, 'WEALTHGENIE_BACKEND');
  assert.equal(internal.dataClass, 'INTERNAL_CATALOG_DISCOVERY');
  const goal = retrieveChatGoalPlanningEvidence(
    "I need ₹2 crore for my daughter's wedding in 12 years."
  );
  const horizon = retrieveGoalHorizonEducation(
    "I need ₹2 crore for my daughter's wedding in 12 years.", goal
  )[0];
  assert.equal(horizon.dataClass, 'CURATED_PUBLIC_EDUCATION');
  assert.equal(horizon.source.provider, 'NISM');
});
