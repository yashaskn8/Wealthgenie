import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isInvestmentScenarioQuestion, retrieveInvestmentScenarioEducation,
} from '../services/chatInvestmentScenarioEducation.js';
import { isGeneralChatQuestion } from '../services/generalChatService.js';
import { classifyGenieChatQuestion } from '../services/chatQuestionRouting.js';
import { buildChatEvidencePacket, generateGroundedExplanation } from '../services/groundedExplanationService.js';

const scenarios = [
  ['What should someone do after inheriting ₹80 lakh?', 'E_SCENARIO_WIND_FALL'],
  ['If I have a 2 crore lump sum where should I invest?', 'E_SCENARIO_WIND_FALL'],
  ['Suppose the stock market crashes before the goal?', 'E_SCENARIO_MARKET_DECLINE'],
  ['Should I pay off a loan or invest the extra money?', 'E_SCENARIO_DEBT_VS_INVEST'],
  ['How do I fund retirement monthly income?', 'E_SCENARIO_RETIREMENT'],
  ['If I lose my job where should emergency savings go?', 'E_SCENARIO_EMERGENCY'],
  ['Compare FD vs mutual fund for my goal', 'E_SCENARIO_PRODUCT_COMPARISON'],
  ['How should a parent plan for a wedding in 7 years?', 'E_SCENARIO_GOAL_PLANNING'],
  ['Where should I put money for long-term investing?', 'E_SCENARIO_GENERAL_DECISION'],
  ['Is an ETF better than a bond in uncertain markets?', 'E_SCENARIO_PRODUCT_COMPARISON'],
  ['How do I plan a portfolio without knowing future returns?', 'E_SCENARIO_PRODUCT_COMPARISON'],
];

test('hard investment scenarios retrieve real educational sources and route away from general LLM', () => {
  for (const [question, id] of scenarios) {
    assert.equal(isInvestmentScenarioQuestion(question), true, question);
    assert.equal(isGeneralChatQuestion(question), false, question);
    assert.equal(classifyGenieChatQuestion(question), 'FINANCIAL_GROUNDED', question);
    const evidence = retrieveInvestmentScenarioEducation(question);
    assert.equal(evidence.length, 1, question);
    assert.equal(evidence[0].id, id, question);
    assert.equal(evidence[0].kind, 'EDUCATION');
    assert.equal(evidence[0].dataClass, 'CURATED_PUBLIC_EDUCATION');
    assert.equal(evidence[0].value.personalizedAdvice, false);
    assert.ok(evidence[0].source.url.startsWith('https://'));
    assert.doesNotMatch(evidence[0].displayValue, /I do not have (?:enough|this|the) information/i);
  }
});

test('unsupported exact tax and account claims do not become generic educational authority', () => {
  for (const query of [
    'What is my portfolio balance?',
    'How much income tax is owed on my investments?',
    'Which funds are in my demat account?',
    'What is my latest account valuation?',
  ]) assert.deepEqual(retrieveInvestmentScenarioEducation(query), []);
  assert.deepEqual(retrieveInvestmentScenarioEducation('Who won the football final?'), []);
});

test('authenticated investment scenario has a verified deterministic answer, even with no product quotes', async () => {
  const question = 'What should someone do after inheriting ₹80 lakh?';
  const packet = await buildChatEvidencePacket({
    question, userId: 'test', profile: null, recommendation: null,
  }, {
    queryRegulatoryRag: async () => null,
    getLiveMarketContext: async () => null,
  });
  assert.ok(packet.entries.some(x => x.id === 'E_SCENARIO_WIND_FALL'));
  const result = await generateGroundedExplanation({ question, evidencePacket: packet }, {
    providers: [], getCache: async () => null, setCache: async () => false,
  });
  assert.equal(result.validation.status, 'PASS');
  assert.match(result.text, /large lump sum|inheritance/i);
  assert.doesNotMatch(result.text, /I do not have enough qualified evidence/i);
  assert.ok(result.citations.some(c => c.source_url?.includes('sebi.gov.in')));
});

test('financial answer under uncertain return assumptions contains no invented yields', async () => {
  const question = 'How should I approach investing 50 lakh if I do not know future returns?';
  const evidence = retrieveInvestmentScenarioEducation(question);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].value.currentProductFactsVerified, false);
  assert.doesNotMatch(evidence[0].displayValue, /\b\d+(?:\.\d+)?%|\bNAV\s+(?:is|of)\s+\d/i);
});

test('dated goal prompts are supported without routing normal events as finance', () => {
  assert.equal(isInvestmentScenarioQuestion(
    'How should parents prepare a savings strategy for a wedding in 9 years?'
  ), true);
  assert.equal(isInvestmentScenarioQuestion(
    'What flowers should I order for a wedding?'
  ), false);
});
