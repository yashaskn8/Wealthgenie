import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isFinancialGoalPlanningQuestion,
  isFinancialGoalFollowUpQuestion,
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


test('successive follow-ups retain only trusted user goal inputs, never model-generated assumptions', async () => {
  const priorTurns = [
    { role: 'user', content: "I need 2 crore for my daughter's marriage" },
    { role: 'model', content: 'Assume a guaranteed 15% return and 4 years.' },
    { role: 'user', content: 'In 10 years' },
    { role: 'model', content: 'You have saved 60 lakh already.' },
    { role: 'user', content: 'I have saved 20 lakh' },
    { role: 'model', content: 'Your interest rate is 18%.' },
  ];
  const question = 'I can save 50k per month';
  assert.equal(isFinancialGoalFollowUpQuestion(question, priorTurns), true);
  // Alone this is ambiguous; the authenticated router must override the general route.
  assert.equal(isGeneralChatQuestion(question), true);
  const packet = await buildChatEvidencePacket({
    question, profile, recommendation: null, priorTurns,
  }, { queryRegulatoryRag: async () => null });
  const target = packet.entries.find(item => item.id === 'E_GOAL_STATED_TARGET');
  const monthly = packet.entries.find(item => item.id === 'E_GOAL_MONTHLY_BASELINE');
  const capacity = packet.entries.find(item => item.id === 'E_GOAL_CAPACITY_CHECK');
  assert.equal(target.value.targetAmount, 20_000_000);
  assert.equal(monthly.value.earmarkedSavingsAmount, 2_000_000);
  assert.equal(monthly.value.horizonMonths, 120);
  assert.equal(monthly.value.monthlyRequiredAmount, 150000);
  assert.equal(capacity.value.monthlyCapacityAmount, 50000);
  assert.equal(capacity.value.goalIsContributionFundable, false);
  assert.doesNotMatch(JSON.stringify(packet), /guaranteed 15%|interest rate is 18%|saved 60 lakh/);
  const answer = await generateGroundedExplanation({ question, evidencePacket: packet }, dependencies);
  assert.equal(answer.validation.status, 'PASS');
  assert.match(answer.text, /not fundable from contributions alone/i);
  assert.doesNotMatch(answer.text, /15%|18%|60 lakh/);
});

test('short horizon answer stays financial but unrelated general conversation does not inherit a goal', () => {
  const prior = [{ role: 'user', content: 'Need 2 crore for daughter wedding' },
    { role: 'model', content: 'Please give your deadline.' }];
  assert.equal(isFinancialGoalFollowUpQuestion('In 15 years', prior), true);
  assert.equal(isFinancialGoalFollowUpQuestion('I have already saved 10 lakh', prior), true);
  assert.equal(isFinancialGoalFollowUpQuestion('Explain Python decorators', prior), false);
  assert.equal(isFinancialGoalFollowUpQuestion('Write a story about a wedding', prior), false);
});

test('a conditional zero-savings scenario is never mistaken for confirmed existing savings', async () => {
  const question = 'Need 2 crore for a wedding in 10 years, can I afford it?';
  const packet = await createPacket(question);
  const baseline = packet.entries.find(item => item.id === 'E_GOAL_MONTHLY_BASELINE');
  assert.ok(baseline);
  assert.equal(baseline.value.scenario, 'ZERO_START_CONDITIONAL');
  assert.equal(baseline.value.earmarkedSavingsAmount, 0);
  const answer = await generateGroundedExplanation({ question, evidencePacket: packet }, dependencies);
  assert.equal(answer.validation.status, 'PASS');
  assert.match(answer.text, /1,66,666\.67 per month/);
  assert.match(answer.text, /earmarked|already saved/i);
  assert.ok(packet.entries.find(e => e.id === 'E_GOAL_PLANNING_GUIDANCE')
    .displayValue.includes('how much is already earmarked'));
});


test('goal deadline and savings follow-ups preserve verified user input without recycling LLM text', async () => {
  const first = "I need 2 crore for my daughter's marriage";
  const deadline = 'in 10 years';
  const saved = 'I have already saved 20 lakh';
  const firstTurn = [{ role: 'user', content: first }, { role: 'model', content: 'Generic advice is not evidence.' }];
  const deadlinePacket = await buildChatEvidencePacket({
    question: deadline, profile, recommendation: null, priorTurns: firstTurn,
  }, { queryRegulatoryRag: async () => null });
  const initial = deadlinePacket.entries.find(entry => entry.id === 'E_GOAL_STATED_TARGET');
  const zeroStart = deadlinePacket.entries.find(entry => entry.id === 'E_GOAL_MONTHLY_BASELINE');
  assert.equal(initial?.value.targetAmount, 20_000_000);
  assert.equal(zeroStart?.value.scenario, 'ZERO_START_CONDITIONAL');
  assert.equal(zeroStart?.value.monthlyRequiredAmount, 166666.67);
  const provisional = await generateGroundedExplanation({
    question: deadline, evidencePacket: deadlinePacket,
  }, dependencies);
  assert.equal(provisional.validation.status, 'PASS');
  assert.match(provisional.text, /If starting with no savings earmarked/);
  assert.equal(provisional.financialClaims.some(claim => claim.type === 'GOAL_MONTHLY_BASELINE'), true);

  const secondTurn = [...firstTurn, { role: 'user', content: deadline },
    { role: 'model', content: 'An LLM guessed 99% returns, ignore it.' }];
  const savedPacket = await buildChatEvidencePacket({
    question: saved, profile, recommendation: null, priorTurns: secondTurn,
  }, { queryRegulatoryRag: async () => null });
  const savedBaseline = savedPacket.entries.find(entry => entry.id === 'E_GOAL_MONTHLY_BASELINE');
  assert.equal(savedBaseline?.value.scenario, 'DECLARED_SAVINGS');
  assert.equal(savedBaseline?.value.earmarkedSavingsAmount, 2_000_000);
  assert.equal(savedBaseline?.value.monthlyRequiredAmount, 150000);
  const result = await generateGroundedExplanation({ question: saved, evidencePacket: savedPacket }, dependencies);
  assert.equal(result.provider, 'DETERMINISTIC_TEMPLATE');
  assert.equal(result.validation.status, 'PASS');
  assert.match(result.text, /1,50,000 per month/);
  assert.doesNotMatch(result.text, /99% returns/);
  assert.ok(result.citations.every(citation =>
    !citation.citation_id.startsWith('E_GOAL_') || citation.source_url === null));
});

test('broad real-world goals receive actionable missing-input checks, not irrelevant definitions', async () => {
  for (const question of [
    'I need 40 lakh for my son college tuition',
    'We want 50 lakh for buying our first home',
    'I need 15 lakh for hospital expenses',
    'Want 8 lakh for a family trip',
    'I need 1 crore as my startup corpus',
  ]) {
    const packet = await createPacket(question);
    assert.ok(packet.entries.some(entry => entry.id === 'E_GOAL_STATED_TARGET'), question);
    const answer = await generateGroundedExplanation({ question, evidencePacket: packet }, dependencies);
    assert.equal(answer.provider, 'DETERMINISTIC_TEMPLATE', question);
    assert.equal(answer.validation.status, 'PASS', question);
    assert.match(answer.text, /deadline|years/, question);
    assert.doesNotMatch(answer.text, /SIP stands for|What is (?:saving|investment|mutual fund)|guaranteed returns/i, question);
  }
});

test('a new named goal does not inherit older daughter-wedding target or savings', () => {
  const prior = [
    "I need 2 crore for my daughter's marriage",
    'in 10 years',
    'I have already saved 20 lakh',
  ];
  const result = retrieveChatGoalPlanningEvidence('I need 15 lakh for hospital expenses', {
    priorUserTurns: prior,
  });
  const goal = result.find(entry => entry.id === 'E_GOAL_STATED_TARGET');
  assert.equal(goal?.value.targetAmount, 1_500_000);
  assert.equal(result.some(entry => entry.id === 'E_GOAL_MONTHLY_BASELINE'), false);
});


test('red-team: monthly salary, EMI debt and earmarked savings never overwrite the goal', () => {
  const input = 'Need 2 crore for daughter marriage in 10 years, my monthly income ₹2 lakh, ' +
    'EMI debt ₹30 lakh, and saved ₹20 lakh.';
  const entries = retrieveChatGoalPlanningEvidence(input);
  assert.equal(entries.find(e => e.id === 'E_GOAL_STATED_TARGET')?.value.targetAmount, 20_000_000);
  const baseline = entries.find(e => e.id === 'E_GOAL_MONTHLY_BASELINE');
  assert.equal(baseline?.value.monthlyRequiredAmount, 150_000);
  assert.equal(baseline?.value.earmarkedSavingsAmount, 2_000_000);
});

test('red-team: currently saving, abbreviated deadlines and exact paise arithmetic', () => {
  const cases = [
    ["Need 2 crore for daughter wedding in 10 years, saving ₹20 lakh currently.", 150_000],
    ["Need 2 crore for wedding in 2 yrs, starting from zero.", 833_333.34],
    ["Need 2 crore for wedding in 2.5 yrs, starting from zero.", 666_666.67],
    ["Need ₹1.01 for wedding in 2 months, starting from zero.", 0.51],
    ["Need ₹0.01 for wedding in 2 months, starting from zero.", 0.01],
  ];
  for (const [input, expected] of cases) {
    const baseline = retrieveChatGoalPlanningEvidence(input)
      .find(e => e.id === 'E_GOAL_MONTHLY_BASELINE');
    assert.equal(baseline?.value.monthlyRequiredAmount, expected, input);
    assert.equal(baseline?.value.assumedGrowthRate, null);
    assert.equal(baseline?.value.inflationRate, null);
  }
});

test('red-team: misleading user input fails closed instead of emitting false numbers', () => {
  for (const input of [
    'Need ₹0.001 for wedding in 2 months, starting from zero.',
    'Need 2 crore or 3 crore for wedding in 10 years, starting from zero.',
    'Need 2 crore for wedding in 10 years and I have 20 lakh.',
    'Need 2 crore for wedding in 10 years, saved ₹20 lakh, starting from zero.',
  ]) {
    const entries = retrieveChatGoalPlanningEvidence(input);
    assert.equal(entries.some(e => e.id === 'E_GOAL_MONTHLY_BASELINE'), false, input);
  }
});

test('red-team: deadline abbreviations remain goal follow-ups, not detached general chat', () => {
  const trusted = [{ role: 'user', content: 'Need 2 crore for daughter wedding' }];
  for (const question of ['in 2 yrs', '2 yrs', 'in 30 mos']) {
    assert.equal(isFinancialGoalFollowUpQuestion(question, trusted), true, question);
  }
});


test('goal red-team: exact paise are preserved and each payment rounds upward, never down', async () => {
  const question = "Need ₹100.01 for daughter's wedding in 3 months; I have saved ₹0";
  const packet = await createPacket(question);
  assert.equal(packet.entries.find(e => e.id === 'E_GOAL_STATED_TARGET')?.value.targetAmount, 100.01);
  const monthly = packet.entries.find(e => e.id === 'E_GOAL_MONTHLY_BASELINE');
  assert.equal(monthly?.value.earmarkedSavingsAmount, 0);
  assert.equal(monthly?.value.monthlyRequiredAmount, 33.34);
  const answer = await generateGroundedExplanation({ question, evidencePacket: packet }, dependencies);
  assert.equal(answer.validation.status, 'PASS');
  assert.equal(answer.financialClaims.find(claim => claim.type === 'GOAL_MONTHLY_BASELINE')?.value, 33.34);
  assert.match(answer.text, /100\.01/);
  assert.match(answer.text, /33\.34 per month/);
});

test('goal red-team: fractional crore converted to paise without assuming returns', () => {
  const evidence = retrieveChatGoalPlanningEvidence(
    "Need 2.000000001 crore for daughter wedding in 3 months and I have saved ₹0.01",
  );
  assert.equal(evidence.find(e => e.id === 'E_GOAL_STATED_TARGET')?.value.targetAmount, 20_000_000.01);
  const monthly = evidence.find(e => e.id === 'E_GOAL_MONTHLY_BASELINE');
  assert.equal(monthly?.value.monthlyRequiredAmount, 6_666_666.67);
  assert.equal(monthly?.value.assumedGrowthRate, null);
  assert.equal(monthly?.value.inflationRate, null);
});

test('goal red-team: existing savings, salary and EMI never become the target', () => {
  const evidence = retrieveChatGoalPlanningEvidence(
    "Need 2 crore for daughter's wedding in 10 years; I have ₹20 lakh saved; my salary is 3 lakh and EMI is 50k",
  );
  assert.equal(evidence.find(e => e.id === 'E_GOAL_STATED_TARGET')?.value.targetAmount, 20_000_000);
  assert.equal(evidence.find(e => e.id === 'E_GOAL_MONTHLY_BASELINE')?.value.earmarkedSavingsAmount, 2_000_000);
  assert.equal(evidence.find(e => e.id === 'E_GOAL_MONTHLY_BASELINE')?.value.monthlyRequiredAmount, 150_000);
});

test('goal red-team: contradictory, negative, zero-target and sub-paise inputs abstain', () => {
  for (const question of [
    "Need ₹1.005 for daughter's wedding in 3 months starting from zero",
    "Need ₹0 for daughter's wedding in 3 months starting from zero",
    "Need ₹2 crore for daughter's wedding in 3 months, I have ₹20 lakh",
    "Need ₹2 crore for daughter's wedding in 3 months, already saved ₹20 lakh, starting from zero",
    "Need ₹2 crore for daughter's wedding in 3 months, I have saved ₹-20 lakh",
    "Need 1 crore or 2 crore for daughter's wedding in 10 years and starting from zero",
    "Need ₹2 crore for daughter's wedding in 10 years and in 5 years, starting from zero",
    "Need ₹2 crore for daughter's wedding in 2.3 years starting from zero",
  ]) {
    const evidence = retrieveChatGoalPlanningEvidence(question);
    assert.equal(evidence.some(e => e.id === 'E_GOAL_MONTHLY_BASELINE'), false, question);
  }
});

test('goal red-team: zero balances and bare deadline follow-ups work without model-created state', () => {
  const priorUserTurns = ["Need 2 crore for daughter's wedding"];
  const evidence = retrieveChatGoalPlanningEvidence('5 years', { priorUserTurns });
  assert.equal(isFinancialGoalFollowUpQuestion('5 years', priorUserTurns), true);
  assert.equal(evidence.find(e => e.id === 'E_GOAL_MONTHLY_BASELINE')?.value.horizonMonths, 60);
  assert.equal(evidence.find(e => e.id === 'E_GOAL_MONTHLY_BASELINE')?.value.monthlyRequiredAmount, 333_333.34);
  const evidenceZero = retrieveChatGoalPlanningEvidence(
    "Need ₹1 lakh for daughter's wedding in 7 months, saved ₹0 and I can save ₹14285.72 per month",
  );
  assert.equal(evidenceZero.find(e => e.id === 'E_GOAL_CAPACITY_CHECK')?.value.goalIsContributionFundable, true);
  assert.equal(evidenceZero.find(e => e.id === 'E_GOAL_MONTHLY_BASELINE')?.value.monthlyRequiredAmount, 14285.72);
});

test('goal red-team: money and savings requests cannot escape to unsourced general chat', () => {
  for (const question of [
    'I can save 50k per month',
    'Can I afford ₹2 crore?',
    'I need INR 20 lakh',
    'I want to save every month',
    'Need 2 crore for my wedding',
  ]) assert.equal(isGeneralChatQuestion(question), false, question);
  assert.equal(isGeneralChatQuestion('How to save a Python file?'), true);
});
