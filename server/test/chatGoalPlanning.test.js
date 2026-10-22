import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isFinancialGoalPlanningQuestion,
  isFinancialGoalFollowUpQuestion,
  retrieveChatGoalPlanningEvidence,
  calculateGoalMonthlyBaseline,
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
    ["Need 2 crore for daughter wedding in 10 years, already saved ₹20 lakh.", 150_000],
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


test('goal red-team: explicit correction supersedes original target without resetting saved funds', () => {
  const priorUserTurns = [
    "Need 2 crore for daughter's wedding in 10 years",
    "I have saved 20 lakh",
  ];
  for (const text of ['Actually 3 crore', 'Make that 3 crore', 'My target is 3 crore']) {
    assert.equal(isFinancialGoalFollowUpQuestion(text, priorUserTurns), true, text);
    const evidence = retrieveChatGoalPlanningEvidence(text, { priorUserTurns });
    assert.equal(evidence.find(e => e.id === 'E_GOAL_STATED_TARGET')?.value.targetAmount, 30_000_000, text);
    const baseline = evidence.find(e => e.id === 'E_GOAL_MONTHLY_BASELINE');
    assert.equal(baseline?.value.earmarkedSavingsAmount, 2_000_000, text);
    assert.equal(baseline?.value.monthlyRequiredAmount, 233_333.34, text);
  }
});

test('goal red-team: retrieved fake citation URLs are never exposed as clickable sources', async () => {
  const question = "Need 1 crore for daughter's wedding";
  const packet = await createPacket(question);
  const target = packet.entries.find(e => e.id === 'E_GOAL_STATED_TARGET');
  target.source = { url: 'javascript:alert(1)', title: 'Fake source', provider: 'FAKE' };
  const answer = await generateGroundedExplanation({ question, evidencePacket: packet }, dependencies);
  assert.equal(answer.validation.status, 'PASS');
  assert.equal(answer.citations.find(c => c.citation_id === 'E_GOAL_STATED_TARGET')?.source_url, null);
});


test('red-team: 546 independent exact-paise goal math scenarios never underfund by a paisa', () => {
  const targetsInPaise = [
    1, 101, 199, 10001, 12500, 198765, 1000001, 2500000,
    123456789, 900000001, 2000000000, 2000000001, 2525252525, 1000000000000,
  ];
  const horizons = [1, 2, 3, 7, 11, 12, 24, 25, 60, 119, 120, 360, 600];
  for (const target of targetsInPaise) {
    for (const months of horizons) {
      for (const savingsFraction of [0, 0.25, 0.75]) {
        const savings = savingsFraction === 0 ? 0 : Math.floor(target * savingsFraction);
        const statedSavings = savings > 0
          ? 'saved ₹' + (savings / 100).toFixed(2) : 'starting from zero';
        const question = 'Need ₹' + (target / 100).toFixed(2)
          + ' for wedding in ' + months + ' months, ' + statedSavings + '.';
        const entry = retrieveChatGoalPlanningEvidence(question)
          .find(item => item.id === 'E_GOAL_MONTHLY_BASELINE');
        const expected = Math.ceil((target - savings) / months) / 100;
        assert.equal(entry?.value.monthlyRequiredAmount, expected, question);
        assert.equal(entry?.value.returnForecast, false);
        assert.equal(entry?.value.assumedGrowthRate, null);
      }
    }
  }
});

test('red-team: negative and foreign monetary units fail closed', () => {
  for (const question of [
    'Need ₹-2 crore for wedding in 10 years, starting from zero.',
    'Need -2 crore for wedding in 10 years, starting from zero.',
    'Need USD 2 crore for wedding in 10 years, starting from zero.',
    'Need $2 crore for wedding in 10 years, starting from zero.',
    'Need ₹1,00,000.001 for wedding in 10 years, starting from zero.',
  ]) {
    const entries = retrieveChatGoalPlanningEvidence(question);
    assert.equal(entries.some(e => e.id === 'E_GOAL_MONTHLY_BASELINE'), false, question);
    assert.equal(entries.some(e => e.id === 'E_GOAL_STATED_TARGET'), false, question);
  }
});

test('red-team: complete ₹50,000 monthly must not be truncated by regex lookahead', () => {
  const entries = retrieveChatGoalPlanningEvidence(
    'Need ₹2 crore for wedding in 10 years, saved ₹20 lakh, can save ₹50,000 monthly.',
  );
  assert.equal(entries.find(e => e.id === 'E_GOAL_STATED_TARGET')?.value.targetAmount, 20_000_000);
  assert.equal(entries.find(e => e.id === 'E_GOAL_MONTHLY_BASELINE')?.value.monthlyRequiredAmount, 150_000);
  assert.equal(entries.find(e => e.id === 'E_GOAL_CAPACITY_CHECK')?.value.monthlyCapacityAmount, 50_000);
});


test('goal red-team: 500 deterministic paise-level metamorphic funding cases', () => {
  const formatted = paise => `${paise / 100n}.${String(paise % 100n).padStart(2, '0')}`;
  for (let i = 1; i <= 500; i += 1) {
    // Keep all generated values within the verified exact-integer range.
    const targetPaise = 1_000_000n + BigInt(i) * 198_763n;
    const savingsPaise = BigInt(i * 123_457) % targetPaise;
    const months = i % 60 + 1;
    const question = `Need ₹${formatted(targetPaise)} for daughter's wedding in ${months} months; I have saved ₹${formatted(savingsPaise)}`;
    const evidence = retrieveChatGoalPlanningEvidence(question);
    const target = evidence.find(e => e.id === 'E_GOAL_STATED_TARGET')?.value.targetAmount;
    const baseline = evidence.find(e => e.id === 'E_GOAL_MONTHLY_BASELINE')?.value;
    const exactExpected = Number((targetPaise - savingsPaise + BigInt(months) - 1n) / BigInt(months)) / 100;
    assert.equal(target, Number(targetPaise) / 100, question);
    assert.equal(baseline?.earmarkedSavingsAmount, Number(savingsPaise) / 100, question);
    assert.equal(baseline?.monthlyRequiredAmount, exactExpected, question);
    assert.equal(baseline?.horizonMonths, months, question);
    assert.equal(baseline?.assumedGrowthRate, null, question);
  }
});


test('goal red-team: spoken amount words are never silently guessed by an unsourced general model', async () => {
  const question = "I need two crore for my daughter's wedding";
  assert.equal(isGeneralChatQuestion(question), false);
  assert.equal(isFinancialGoalPlanningQuestion(question), true);
  const packet = await createPacket(question);
  assert.equal(packet.entries.some(e => e.id === 'E_GOAL_STATED_TARGET'), false);
  assert.equal(packet.entries.some(e => e.id === 'E_GOAL_MONTHLY_BASELINE'), false);
  const answer = await generateGroundedExplanation({ question, evidencePacket: packet }, dependencies);
  assert.equal(answer.provider, 'DETERMINISTIC_TEMPLATE');
  assert.equal(answer.validation.status, 'PASS');
  assert.match(answer.text, /target amount/);
  assert.doesNotMatch(answer.text, /2,00,00,000|guaranteed returns/i);
});


test('red-team: previously floating-point false rejection accepts the exact ₹823.05 contribution', async () => {
  const question = "Need ₹1,15,710.77 for daughter's wedding in 134 months; I have saved ₹5,422.07";
  const packet = await createPacket(question);
  const baseline = packet.entries.find(entry => entry.id === 'E_GOAL_MONTHLY_BASELINE');
  assert.equal(baseline?.value.targetAmount, 115710.77);
  assert.equal(baseline?.value.earmarkedSavingsAmount, 5422.07);
  assert.equal(baseline?.value.monthlyRequiredAmount, 823.05);
  const answer = await generateGroundedExplanation({ question, evidencePacket: packet }, dependencies);
  assert.equal(answer.validation.status, 'PASS');
  assert.equal(answer.provider, 'DETERMINISTIC_TEMPLATE');
  assert.equal(answer.financialClaims.find(claim => claim.type === 'GOAL_MONTHLY_BASELINE')?.value, 823.05);
  assert.match(answer.text, /823\\.05 per month/);
});

test('red-team: salary is never silently relabelled as investable monthly capacity', async () => {
  for (const question of [
    "Need 2 crore for daughter's wedding in 10 years; salary is ₹50k per month; starting from zero",
    "Need 2 crore for daughter's wedding in 10 years; income is ₹50,000 monthly; saved ₹20 lakh",
    "Need 2 crore for daughter's wedding in 10 years; wages are ₹50k/month; starting from zero",
  ]) {
    const packet = await createPacket(question);
    assert.equal(packet.entries.find(entry => entry.id === 'E_GOAL_STATED_TARGET')?.value.targetAmount, 20000000, question);
    assert.equal(packet.entries.some(entry => entry.id === 'E_GOAL_CAPACITY_CHECK'), false, question);
    assert.equal(packet.entries.some(entry => entry.id === 'E_GOAL_MONTHLY_BASELINE'), true, question);
    const answer = await generateGroundedExplanation({ question, evidencePacket: packet }, dependencies);
    assert.equal(answer.validation.status, 'PASS', question);
    assert.doesNotMatch(answer.text, /Your stated monthly capacity is at least/i, question);
  }
});

test('red-team: invalid zero-year horizon never raises a ReferenceError or fabricates a baseline', async () => {
  const question = "Need 2 crore for daughter's wedding in 0 years, starting from zero";
  const packet = await createPacket(question);
  assert.equal(packet.entries.some(e => e.id === 'E_GOAL_MONTHLY_BASELINE'), false);
  const answer = await generateGroundedExplanation({ question, evidencePacket: packet }, dependencies);
  assert.equal(answer.validation.status, 'PASS');
  assert.match(answer.text, /valid unambiguous deadline/);
});

test('red-team: stated future wedding costs are recognised as a goal, not generic chit-chat', async () => {
  const question = "My daughter's wedding will cost ₹2 crore in 10 years";
  assert.equal(isFinancialGoalPlanningQuestion(question), true);
  assert.equal(isGeneralChatQuestion(question), false);
  const packet = await createPacket(question);
  assert.equal(packet.entries.find(entry => entry.id === 'E_GOAL_STATED_TARGET')?.value.targetAmount, 20000000);
  const answer = await generateGroundedExplanation({ question, evidencePacket: packet }, dependencies);
  assert.equal(answer.validation.status, 'PASS');
});


test('red-team: supported Indian L suffix is lakhs, not fractional rupees', async () => {
  for (const [suffix, expected] of [['₹20L', 2000000], ['₹1.5L', 150000], ['Rs.20l', 2000000]]) {
    const question = `Need ₹2 crore for daughter's wedding in 10 years; I have saved ${suffix}`;
    const packet = await createPacket(question);
    const goal = packet.entries.find(e => e.id === 'E_GOAL_STATED_TARGET');
    const monthly = packet.entries.find(e => e.id === 'E_GOAL_MONTHLY_BASELINE');
    assert.equal(goal?.value.targetAmount, 20000000, suffix);
    assert.equal(monthly?.value.earmarkedSavingsAmount, expected, suffix);
    assert.equal(monthly?.value.monthlyRequiredAmount,
      Math.ceil((20000000 - expected) * 100 / 120) / 100, suffix);
    const answer = await generateGroundedExplanation({ question, evidencePacket: packet }, dependencies);
    assert.equal(answer.validation.status, 'PASS', suffix);
  }
});

test('red-team: unknown currency suffixes never quietly become ₹20 or ₹1', () => {
  for (const suffix of ['₹20m', '₹1e6', '₹1.5 million', '₹1 billion']) {
    const question = `Need ₹2 crore for daughter's wedding in 10 years; I have saved ${suffix}`;
    const entries = retrieveChatGoalPlanningEvidence(question);
    assert.equal(entries.some(e => e.id === 'E_GOAL_STATED_TARGET'), false, suffix);
    assert.equal(entries.some(e => e.id === 'E_GOAL_MONTHLY_BASELINE'), false, suffix);
    assert.match(entries.find(e => e.id === 'E_GOAL_PLANNING_GUIDANCE')?.displayValue || '', /ambiguous or invalid/, suffix);
  }
});

test('red-team: standalone named wedding target cannot bypass the deterministic goal boundary', async () => {
  const question = "₹2 crore for daughter's wedding";
  assert.equal(isFinancialGoalPlanningQuestion(question), true);
  assert.equal(isGeneralChatQuestion(question), false);
  const packet = await createPacket(question);
  assert.equal(packet.entries.find(e => e.id === 'E_GOAL_STATED_TARGET')?.value.targetAmount, 20000000);
  assert.equal(packet.entries.some(e => e.id === 'E_GOAL_MONTHLY_BASELINE'), false);
  const answer = await generateGroundedExplanation({ question, evidencePacket: packet }, dependencies);
  assert.equal(answer.validation.status, 'PASS');
  assert.match(answer.text, /deadline/);
});

test('adversarial E2E: monthly savings flow never becomes an existing balance', async () => {
  const cases = [
    "Need ₹2 crore for daughter's wedding in 10 years, starting from zero. I save ₹50k monthly",
    "Need ₹2 crore for daughter's wedding in 10 years, starting from zero. Saving Rs 50000 every month",
    "Need ₹2 crore for daughter's wedding in 10 years, starting from zero. My monthly savings are ₹50,000",
    "Need ₹2 crore for daughter's wedding in 10 years, starting from zero. I can invest ₹50k per month",
  ];
  for (const question of cases) {
    const packet = await createPacket(question);
    const monthly = packet.entries.find(item => item.id === 'E_GOAL_MONTHLY_BASELINE');
    const capacity = packet.entries.find(item => item.id === 'E_GOAL_CAPACITY_CHECK');
    assert.equal(monthly?.value.earmarkedSavingsAmount, 0, question);
    assert.equal(monthly?.value.monthlyRequiredAmount, 166666.67, question);
    assert.equal(capacity?.value.monthlyCapacityAmount, 50000, question);
    assert.equal(capacity?.value.goalIsContributionFundable, false, question);
    const answer = await generateGroundedExplanation({ question, evidencePacket: packet }, dependencies);
    assert.equal(answer.validation.status, 'PASS', question);
    assert.equal(answer.provider, 'DETERMINISTIC_TEMPLATE', question);
    assert.ok(answer.financialClaims.some(claim => claim.type === 'GOAL_MONTHLY_BASELINE'
      && claim.value === 166666.67), question);
    assert.ok(answer.citations.every(citation => !citation.citation_id.startsWith('E_GOAL_')
      || citation.source_url === null), question);
    assert.doesNotMatch(answer.text, /(?:guaranteed\s+\d+%|projected\s+return)/i, question);
  }
});

test('adversarial E2E: existing savings, monthly capacity, salary and EMI remain separate', async () => {
  const question = "Need ₹2 crore for daughter's wedding in 10 years. " +
    'I have already saved ₹20 lakh; I save ₹50k monthly, earn ₹1 lakh monthly, and pay EMI ₹30k monthly';
  const packet = await createPacket(question);
  assert.equal(packet.entries.find(e => e.id === 'E_GOAL_STATED_TARGET')?.value.targetAmount, 20000000);
  assert.equal(packet.entries.find(e => e.id === 'E_GOAL_MONTHLY_BASELINE')?.value.earmarkedSavingsAmount, 2000000);
  assert.equal(packet.entries.find(e => e.id === 'E_GOAL_MONTHLY_BASELINE')?.value.monthlyRequiredAmount, 150000);
  assert.equal(packet.entries.find(e => e.id === 'E_GOAL_CAPACITY_CHECK')?.value.monthlyCapacityAmount, 50000);
  const answer = await generateGroundedExplanation({ question, evidencePacket: packet }, dependencies);
  assert.equal(answer.validation.status, 'PASS');
  assert.match(answer.text, /1,50,000 per month/);
  assert.match(answer.text, /not fundable from contributions alone/);
  assert.doesNotMatch(answer.text, /guaranteed investment returns/i);
});

test('adversarial E2E: periodic outflows and ambiguous accumulation cannot inflate capacity', () => {
  for (const sentence of [
    'I pay ₹50k monthly', 'I spend ₹50k per month', 'I borrow ₹50k every month',
    'My EMI is ₹50k monthly', 'My salary is ₹50k per month',
  ]) {
    const evidence = retrieveChatGoalPlanningEvidence(
      "Need ₹2 crore for daughter's wedding in 10 years starting from zero. " + sentence,
    );
    assert.equal(evidence.find(e => e.id === 'E_GOAL_STATED_TARGET')?.value.targetAmount, 20000000, sentence);
    assert.equal(evidence.some(e => e.id === 'E_GOAL_CAPACITY_CHECK'), false, sentence);
    assert.equal(evidence.find(e => e.id === 'E_GOAL_MONTHLY_BASELINE')?.value.monthlyRequiredAmount, 166666.67, sentence);
  }
  for (const sentence of ['I am saving ₹50k', 'I invest ₹50k monthly', 'I have ₹50k a month']) {
    const evidence = retrieveChatGoalPlanningEvidence(
      "Need ₹2 crore for daughter's wedding in 10 years starting from zero. " + sentence,
    );
    assert.equal(evidence.some(e => e.id === 'E_GOAL_MONTHLY_BASELINE'), false, sentence);
    assert.match(evidence.find(e => e.id === 'E_GOAL_PLANNING_GUIDANCE')?.displayValue || '', /ambiguous or invalid/);
  }
});

test('adversarial E2E: unrelated time references never mutate an existing goal', () => {
  const priorUserTurns = ["Need 2 crore for daughter's wedding", 'I have saved 20 lakh'];
  for (const question of [
    'In 10 years, will AI replace developers?',
    'The school closed 10 years ago',
    'Was Bitcoin growing for 10 years?',
    'My car loan is 3 years old',
    'How many years does an elephant live?',
  ]) {
    assert.equal(isFinancialGoalFollowUpQuestion(question, priorUserTurns), false, question);
    assert.deepEqual(retrieveChatGoalPlanningEvidence(question, { priorUserTurns }), [], question);
  }
  const confirmed = retrieveChatGoalPlanningEvidence('My deadline is 10 years', { priorUserTurns });
  assert.equal(confirmed.find(e => e.id === 'E_GOAL_STATED_TARGET')?.value.targetAmount, 20000000);
  assert.equal(confirmed.find(e => e.id === 'E_GOAL_MONTHLY_BASELINE')?.value.monthlyRequiredAmount, 150000);
});

test('adversarial E2E: distinct named goals cannot inherit wedding corpus', () => {
  const priorUserTurns = ["Need 2 crore for daughter's wedding in 10 years", 'I have saved 20 lakh'];
  for (const question of ['I have saved ₹5 lakh for my car', 'I have saved ₹5 lakh for college']) {
    assert.deepEqual(retrieveChatGoalPlanningEvidence(question, { priorUserTurns }), [], question);
  }
  const newGoal = retrieveChatGoalPlanningEvidence('I can save ₹50k monthly for college', { priorUserTurns });
  assert.equal(newGoal.some(e => e.id === 'E_GOAL_STATED_TARGET'), false);
  assert.equal(newGoal.find(e => e.id === 'E_GOAL_PLANNING_GUIDANCE')?.value.goalContext, 'the education goal');
});

test('adversarial exact arithmetic: 5000 independent integer-paise funding baselines', () => {
  let state = 0x25372545;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  for (let i = 0; i < 5000; i++) {
    const targetPaise = BigInt(random() % 1000000000 + 1);
    const savingsPaise = BigInt(random() % Number(targetPaise));
    const months = random() % 600 + 1;
    const target = Number(targetPaise) / 100;
    const saved = Number(savingsPaise) / 100;
    const expected = Number((targetPaise - savingsPaise + BigInt(months) - 1n) / BigInt(months)) / 100;
    assert.equal(calculateGoalMonthlyBaseline(target, saved, months), expected,
      'Vector ' + i + ' target ' + target + ' saved ' + saved + ' months ' + months);
  }
});

test('adversarial unsupported money suffix remains a clear missing-input error', () => {
  const question = "I need ₹20m for daughter's wedding in 10 years starting from zero";
  assert.equal(isFinancialGoalPlanningQuestion(question), true);
  assert.equal(isGeneralChatQuestion(question), false);
  const entries = retrieveChatGoalPlanningEvidence(question);
  assert.equal(entries.some(e => e.id === 'E_GOAL_STATED_TARGET'), false);
  assert.equal(entries.some(e => e.id === 'E_GOAL_MONTHLY_BASELINE'), false);
  assert.match(entries.find(e => e.id === 'E_GOAL_PLANNING_GUIDANCE')?.displayValue || '', /ambiguous or invalid/);
});

test('adversarial goal-explanation follow-ups reuse the verified target and ignore quoted amounts', async () => {
  const priorUserTurns = ["Need 2 crore for daughter's wedding in 10 years starting from zero"];
  for (const question of [
    'Why?', 'Show the math', 'How was that calculated?', 'Explain that amount',
    'Why is it ₹1.67 lakh per month?', 'Why ₹1,66,666.67?',
  ]) {
    assert.equal(isFinancialGoalFollowUpQuestion(question, priorUserTurns), true, question);
    const packet = await buildChatEvidencePacket({
      question, profile, recommendation: null,
      priorTurns: priorUserTurns.map(content => ({ role: 'user', content })),
    }, { queryRegulatoryRag: async () => null });
    const goal = packet.entries.find(e => e.id === 'E_GOAL_STATED_TARGET');
    const baseline = packet.entries.find(e => e.id === 'E_GOAL_MONTHLY_BASELINE');
    assert.equal(goal?.value.targetAmount, 20000000, question);
    assert.equal(baseline?.value.monthlyRequiredAmount, 166666.67, question);
    const answer = await generateGroundedExplanation({ question, evidencePacket: packet }, dependencies);
    assert.equal(answer.provider, 'DETERMINISTIC_TEMPLATE', question);
    assert.equal(answer.validation.status, 'PASS', question);
    assert.match(answer.text, /Calculation method:/, question);
    assert.match(answer.text, /1,66,666\.67 per month/, question);
  }
  for (const question of ['Why did NIFTY crash?', 'What is the latest NAV?', 'Show me market returns']) {
    assert.equal(isFinancialGoalFollowUpQuestion(question, priorUserTurns), false, question);
  }
});

test('adversarial named car loan expense does not erase the wedding goal', () => {
  const question = "Need ₹2 crore for daughter's wedding in 10 years, saved ₹20 lakh and have car loan EMI ₹30k";
  const evidence = retrieveChatGoalPlanningEvidence(question);
  assert.equal(evidence.find(e => e.id === 'E_GOAL_STATED_TARGET')?.value.targetAmount, 20000000);
  assert.equal(evidence.find(e => e.id === 'E_GOAL_MONTHLY_BASELINE')?.value.monthlyRequiredAmount, 150000);
  assert.equal(evidence.some(e => e.id === 'E_GOAL_CAPACITY_CHECK'), false);
});

test('adversarial three-turn continuity preserves the original goal target after a named capacity update', () => {
  const priorUserTurns = [
    "Need 2 crore for daughter's wedding in 10 years",
    "I can save ₹50k monthly for my daughter's wedding",
  ];
  const evidence = retrieveChatGoalPlanningEvidence('I have saved 20 lakh', { priorUserTurns });
  assert.equal(evidence.find(e => e.id === 'E_GOAL_STATED_TARGET')?.value.targetAmount, 20000000);
  assert.equal(evidence.find(e => e.id === 'E_GOAL_MONTHLY_BASELINE')?.value.monthlyRequiredAmount, 150000);
  const explanation = retrieveChatGoalPlanningEvidence('Why?', {
    priorUserTurns: [...priorUserTurns, 'I have saved 20 lakh'],
  });
  assert.equal(explanation.find(e => e.id === 'E_GOAL_STATED_TARGET')?.value.targetAmount, 20000000);
  assert.equal(explanation.find(e => e.id === 'E_GOAL_MONTHLY_BASELINE')?.value.monthlyRequiredAmount, 150000);
});

test('adversarial three-turn continuity cannot cross into a different named goal', () => {
  const priorUserTurns = [
    "Need 2 crore for daughter's wedding in 10 years",
    'I can save ₹50k monthly for college',
  ];
  const savings = retrieveChatGoalPlanningEvidence('I have saved ₹5 lakh', { priorUserTurns });
  assert.equal(savings.some(e => e.id === 'E_GOAL_STATED_TARGET'), false);
  assert.equal(savings.some(e => e.id === 'E_GOAL_MONTHLY_BASELINE'), false);
  const correction = retrieveChatGoalPlanningEvidence('Actually 1 crore', { priorUserTurns });
  assert.equal(correction.find(e => e.id === 'E_GOAL_STATED_TARGET')?.value.targetAmount, 10000000);
  assert.equal(correction.some(e => e.id === 'E_GOAL_MONTHLY_BASELINE'), false);
});


test('red-team E2E: unnamed rupee accumulation target gets the same verified contribution math', async () => {
  for (const question of [
    'I want to accumulate 2 crore in 10 years starting from zero',
    'I need ₹2 crore in 10 years, starting from zero',
    'Plan to save INR 2,00,00,000 in 10 years, starting from zero',
  ]) {
    assert.equal(isFinancialGoalPlanningQuestion(question), true, question);
    assert.equal(isGeneralChatQuestion(question), false, question);
    const packet = await createPacket(question);
    const baseline = packet.entries.find(e => e.id === 'E_GOAL_MONTHLY_BASELINE');
    assert.equal(baseline?.value?.targetAmount, 20_000_000, question);
    assert.equal(baseline?.value?.horizonMonths, 120, question);
    assert.equal(baseline?.value?.earmarkedSavingsAmount, 0, question);
    assert.equal(baseline?.value?.monthlyRequiredAmount, 166666.67, question);
    const answer = await generateGroundedExplanation({ question, evidencePacket: packet }, dependencies);
    assert.equal(answer.validation.status, 'PASS', question);
    assert.equal(answer.provider, 'DETERMINISTIC_TEMPLATE', question);
    assert.equal(answer.financialClaims.find(c => c.type === 'GOAL_MONTHLY_BASELINE')?.value, 166666.67, question);
    assert.ok(answer.citations.every(c => !c.citation_id.startsWith('E_GOAL_') || c.source_url === null), question);
    assert.doesNotMatch(answer.text, /guaranteed return|expected 12%|will grow/i, question);
  }
});

test('red-team: income mentions and missing inputs never forge a new goal amount or monthly obligation', async () => {
  for (const question of [
    'I earn ₹2 crore salary. Explain my income.',
    'My EMI is ₹35,000 per month. Why is it high?',
    'I have saved ₹20 lakh already.',
  ]) {
    assert.equal(isFinancialGoalPlanningQuestion(question), false, question);
    assert.deepEqual(retrieveChatGoalPlanningEvidence(question), [], question);
  }
  for (const question of [
    'I want to accumulate 2 crore.',
    'I want to accumulate 2 crore in 10 years.',
  ]) {
    const packet = await createPacket(question);
    assert.equal(packet.entries.some(e => e.id === 'E_GOAL_STATED_TARGET'), true, question);
    assert.equal(packet.entries.some(e => e.id === 'E_GOAL_MONTHLY_BASELINE'), false, question);
    const answer = await generateGroundedExplanation({ question, evidencePacket: packet }, dependencies);
    assert.equal(answer.validation.status, 'PASS', question);
    assert.match(answer.text, /how much is already earmarked/i, question);
  }
});

test('red-team: upward paisa rounding is exact and never silently underfunds small amounts', () => {
  assert.equal(calculateGoalMonthlyBaseline(1.01, 0, 3), 0.34);
  assert.equal(calculateGoalMonthlyBaseline(20_000_000, 2_000_000, 120), 150000);
  assert.equal(calculateGoalMonthlyBaseline(20_000_000, 0, 120), 166666.67);
  assert.equal(calculateGoalMonthlyBaseline(0.01, 0, 3), 0.01);
  assert.equal(calculateGoalMonthlyBaseline(20_000_000, 20_000_001, 120), null);
  assert.equal(calculateGoalMonthlyBaseline(20_000_000, 0, 0), null);
});


test('red-team E2E: switching to an unrelated finance topic fences the older goal', async () => {
  const priorTurns = [
    { role: 'user', content: 'I need 2 crore for my daughter wedding' },
    { role: 'model', content: 'Tell me your deadline and savings.' },
    { role: 'user', content: 'What is a fixed deposit?' },
    { role: 'model', content: 'A bank deposit.' },
  ];
  assert.equal(isFinancialGoalFollowUpQuestion('in 10 years', priorTurns), false);
  assert.deepEqual(retrieveChatGoalPlanningEvidence('in 10 years', { priorUserTurns: priorTurns }), []);
  const resumed = [
    ...priorTurns,
    { role: 'user', content: 'I want to accumulate 1 crore for retirement' },
    { role: 'model', content: 'Tell me your horizon and savings.' },
  ];
  const evidence = retrieveChatGoalPlanningEvidence('in 10 years', { priorUserTurns: resumed });
  assert.equal(evidence.find(e => e.id === 'E_GOAL_STATED_TARGET')?.value.targetAmount, 10_000_000);
  assert.equal(evidence.find(e => e.id === 'E_GOAL_STATED_TARGET')?.value.targetAmount === 20_000_000, false);
  assert.equal(isFinancialGoalFollowUpQuestion('in 10 years', resumed), true);
});


test('red-team: ambiguous already-have amounts must not silently overwrite a known wedding target', () => {
  for (const question of ['I already have 1 crore', 'I have already ₹1 crore', 'We currently have INR 1 crore']) {
    const turns = [
      { role: 'user', content: 'I need 2 crore for my daughter wedding in 10 years' },
      { role: 'model', content: 'How much is earmarked for this goal?' },
    ];
    const packetEntries = retrieveChatGoalPlanningEvidence(question, { priorUserTurns: turns });
    assert.equal(packetEntries.some(e => e.id === 'E_GOAL_MONTHLY_BASELINE'), false, question);
    assert.equal(packetEntries.some(e => e.id === 'E_GOAL_STATED_TARGET'), false, question);
    assert.ok(packetEntries.some(e => e.id === 'E_GOAL_PLANNING_GUIDANCE'
      && /ambiguous or invalid/.test(e.displayValue)), question);
  }
});


test('red-team: life-goal cost wording cannot escape to unsourced general chat', async () => {
  for (const question of [
    "What is the cost of my daughter's marriage?",
    "How much would I spend on my daughter's wedding?",
    "Estimate the cost of my daughter's wedding",
    "How much should I pay for my daughter's wedding?",
  ]) {
    assert.equal(isFinancialGoalPlanningQuestion(question), true, question);
    assert.equal(isGeneralChatQuestion(question), false, question);
    const entries = retrieveChatGoalPlanningEvidence(question);
    assert.ok(entries.some(entry => entry.id === 'E_GOAL_PLANNING_GUIDANCE'), question);
    assert.equal(entries.some(entry => entry.id === 'E_GOAL_MONTHLY_BASELINE'), false, question);
    assert.equal(entries.some(entry => entry.id === 'E_GOAL_STATED_TARGET'), false, question);
  }
  assert.equal(isGeneralChatQuestion('What is the cost of sorting a Python list?'), true);
  assert.equal(isGeneralChatQuestion('Write a wedding invitation message'), true);
});

test('red-team E2E: a stated wedding cost is a target, not an invented savings balance', async () => {
  for (const question of [
    "My daughter's wedding costs ₹2 crore in 10 years, starting from zero",
    "My daughter's wedding will cost 2 crore in 10 years, starting from zero",
    "I need to pay ₹2 crore for my daughter's wedding in 10 years, starting from zero",
  ]) {
    assert.equal(isFinancialGoalPlanningQuestion(question), true, question);
    assert.equal(isGeneralChatQuestion(question), false, question);
    const packet = await createPacket(question);
    const target = packet.entries.find(entry => entry.id === 'E_GOAL_STATED_TARGET');
    const monthly = packet.entries.find(entry => entry.id === 'E_GOAL_MONTHLY_BASELINE');
    assert.equal(target?.value.targetAmount, 20_000_000, question);
    assert.equal(monthly?.value.earmarkedSavingsAmount, 0, question);
    assert.equal(monthly?.value.horizonMonths, 120, question);
    assert.equal(monthly?.value.monthlyRequiredAmount, 166666.67, question);
    let llmCalled = false;
    const answer = await generateGroundedExplanation({ question, evidencePacket: packet }, {
      ...dependencies,
      providers: [{
        name: 'groq', isConfigured: () => true,
        async generate() { llmCalled = true; return { text: '10% guaranteed' }; },
      }],
    });
    assert.equal(llmCalled, false, question);
    assert.equal(answer.provider, 'DETERMINISTIC_TEMPLATE', question);
    assert.equal(answer.validation.status, 'PASS', question);
    assert.ok(answer.citations.every(citation =>
      !citation.citation_id.startsWith('E_GOAL_') || citation.source_url === null), question);
  }
});
