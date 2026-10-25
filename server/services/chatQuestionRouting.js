/**
 * One-way isolation between conversational questions and the financial
 * authority pipeline. General answers never receive private financial
 * evidence, and financial questions never use an uncited general model answer.
 *
 * Be deliberately over-inclusive here: ambiguity goes to the grounded
 * financial boundary, not to a model that can invent rates or allocations.
 */
import { isFinancialGoalPlanningQuestion } from './chatGoalPlanning.js';
import { isInvestmentUniverseEducationQuestion } from './chatInvestmentUniverseEducation.js';
import { isInvestmentScenarioQuestion } from './chatInvestmentScenarioEducation.js';

const FINANCIAL_QUESTION = /\b(?:financ(?:e|es|ial|ially)|invest(?:ment|ments|ing|or|ors)?|portfolio|wealthgenie|genie\s*chat|recommend(?:ation|ations)|suitab(?:le|ility)|risk\s*(?:tolerance|capacity|profile|level|appetite|assessment)|allocation|rebalanc(?:e|ing)|mutual\s*funds?|exchange\s*traded\s*funds?|etfs?|stocks?|share\s*(?:market|price|trading|trades)|stock\s*(?:market|price|trading|trades)|nifty|sensex|nse|bse|sebi|rbi|amfi|upstox|market\s*(?:data|price|rate|returns?|risk|volatility|trend)|trading|trades?|brokers?|dividends?|capital\s*gains?|ltcg|stcg|incom[e]?\s*tax|tax(?:ation|es|able|ability)?|gst|deductions?|rebates?|post[ -]?tax|pre[ -]?tax|sip|sips|swp|stp|ppf|epf|nps|scss|sukanya|nsc|kvp|pomis|fixed\s*deposit|term\s*deposit|recurring\s*deposit|bank\s*(?:fd|rd|interest)|bonds?|treasur(?:y|ies)|g-?secs?|government\s*savings|nav|interest\s*rate|return\s*on\s*investment|returns?\s*on\s*(?:investment|fund|stock|deposit)|earnings\s*yield|insurance|loan|emi|credit\s*score|debt\s*fund|tax\s*optimizer)\b/i;
const PRIVATE_FINANCIAL_CONTEXT = /\b(?:my|our|mine)\s+(?:age|plan|profile|risk|savings|salary|income|investments?|portfolio|allocation|recommendations?|tax|returns?|projections?|financial|balance|deposit|fund|holdings?|account)\b/i;

/**
 * Public question classification, with no LLM decisions and no side effects.
 * Unknown general subjects can be answered conversationally WITHOUT citations,
 * but anything financial is sent back to the evidence-only explanation path.
 */
export function classifyGenieChatQuestion(question) {
  const text = String(question || '').slice(0, 1000).trim();
  if (!text || FINANCIAL_QUESTION.test(text) || PRIVATE_FINANCIAL_CONTEXT.test(text)
      || isFinancialGoalPlanningQuestion(text) || isInvestmentUniverseEducationQuestion(text)
      || isInvestmentScenarioQuestion(text)) return 'FINANCIAL_GROUNDED';
  return 'GENERAL_UNCITED';
}
