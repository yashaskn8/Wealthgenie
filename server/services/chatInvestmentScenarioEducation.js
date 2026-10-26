/**
 * Goal-first, source-labelled education for investment hypotheticals.
 *
 * This is NOT a general advice model or a 250-product facts database.
 * It supplies independently reviewed decision principles when current,
 * profile-specific or issuer-specific figures are unavailable.
 */
const SEBI_GOALS = 'https://investor.sebi.gov.in/moneymatters-budandfinangoal.html';
const SEBI_INVESTING = 'https://investor.sebi.gov.in/investment-thingsbeforeinv.html';
const SEBI_RISKS = 'https://investor.sebi.gov.in/securities-risks_trade_derivatives.html';
const NISM_SELECTION = 'https://www.nism.ac.in/revamp-nism/things-to-consider-before-investing/';

const FINANCE_SUBJECT = /\b(?:invest(?:ing|ment|ments|or|ors)?|money|wealth|funds?|mutual\s*funds?|equity|shares?|stocks?|etfs?|bonds?|deposit|fd|sip|portfolio|savings?|retire(?:ment)?|risk|returns?|market|asset(?:\s+allocation)?|capital|inflation|liquidity|corpus|crores?|crors?|lakhs?|lacs?|diversif\w*|emergency\s+fund|income\s+stream|windfall|inherit(?:ed|ance)?)\b|₹\s*\d/i;
const QUESTION_STYLE = /\b(?:what|how|which|should|could|would|can|where|why|when|suppose|imagine|if|compare|versus|vs|plan|choose|protect|manage|invest|save|allocate|split|withdraw|start|build|explain|help)\b/i;
const ACCOUNT_SPECIFIC = /\b(?:my|our)\s+(?:account|holdings?|transactions?|demat|kyc|profile|current\s+portfolio|saved\s+recommendations?|risk\s+assessment|stock\s+positions?)\b/i;
const TAX_SPECIFIC = /\b(?:income[ -]?tax|tax\s+(?:slab|liability|refund|deduction|rebate|regime|amount|rate|calculator)|ltcg|stcg|section\s+\d+[a-z]?)\b/i;

const SCENARIOS = Object.freeze([
  Object.freeze({
    id: 'E_SCENARIO_MARKET_DECLINE',
    match: /\b(?:market|stocks?|shares?|mutual\s*funds?|portfolio|equity)\b.{0,110}\b(?:crash(?:ed|es|ing)?|fall(?:ing)?|drop(?:ped)?|volatile|loss|downturn|panic)\b|\b(?:crash|downturn|falling\s+market)\b/i,
    source: ['SEBI_INVESTOR', 'Key risks in investing', SEBI_RISKS],
    text: 'For a market decline, first distinguish money needed soon from longer-term investments. Check the goal deadline, exposure to one asset class, emergency reserves and ability to withstand further losses. Review diversification and rebalancing rather than assuming the market will recover before the money is needed. Avoid a buy-or-sell instruction without a verified portfolio and suitability assessment.',
  }),
  Object.freeze({
    id: 'E_SCENARIO_DEBT_VS_INVEST',
    match: /\b(?:debt|loan|emi|credit\s+card|borrow(?:ing)?)\b.{0,100}\b(?:invest|save|repay|pay\s+off|prepay|fund)\b|\b(?:invest|save|repay|prepay)\b.{0,100}\b(?:debt|loan|emi|credit\s+card)\b/i,
    source: ['SEBI_INVESTOR', 'Factors to consider before investing', SEBI_INVESTING],
    text: 'For a choice between debt repayment and investing, first compare the loan terms, required repayments, liquidity needs and emergency reserve. An investment return is uncertain, while a borrowing cost is contractual. Model both paths using the actual lender terms and verified investment costs; do not assume the investment will outperform the debt.',
  }),
  Object.freeze({
    id: 'E_SCENARIO_EMERGENCY',
    match: /\b(?:emergency|job\s+loss|(?:lost|lose|losing)\s+(?:(?:my|his|her|their)\s+)?job|unemployment|unexpected\s+medical|rainy\s+day)\b/i,
    source: ['SEBI_INVESTOR', 'Financial goals and budgeting', SEBI_GOALS],
    text: 'For an emergency reserve, priority is dependable access to money when needed, not maximizing expected growth. Separate an immediate cash need from long-term investment goals, review regular expenses and existing liquid savings, and compare access restrictions and protection terms before selecting any account or product. A specific reserve amount depends on actual household obligations.',
  }),
  Object.freeze({
    id: 'E_SCENARIO_RETIREMENT',
    match: /\b(?:retire(?:ment)?|pension|monthly\s+income|regular\s+income|withdraw(?:al|als)?|swp)\b/i,
    source: ['NISM', 'Things to consider before investing', NISM_SELECTION],
    text: 'For retirement or recurring income, calculate the essential annual spending target, income already available, inflation exposure and years the money may need to last. Evaluate liquidity, concentration and sequence-of-returns risk before comparing income-oriented categories. No fixed withdrawal percentage or lasting income stream can be promised without the investor’s finances and verified product facts.',
  }),
  Object.freeze({
    id: 'E_SCENARIO_WIND_FALL',
    match: /\b(?:inherit(?:ed|ance|ing)?|windfall|bonus|lump[ -]?sum|received?\s+(?:₹|rs|inr|\d)|have\s+\d[\d,.]*\s*(?:crores?|lakhs?|crs?))\b/i,
    source: ['SEBI_INVESTOR', 'Factors to consider before investing', SEBI_INVESTING],
    text: 'For a large lump sum or inheritance, first separate money reserved for near-term expenses, emergency needs and liabilities from funds genuinely available for long-term investing. Avoid committing the whole amount to one security or illiquid product. Compare diversification, liquidity, costs and risk capacity before deciding how or when to invest. Clarify whether the stated amount is available capital or a future target.',
  }),
  Object.freeze({
    id: 'E_SCENARIO_PRODUCT_COMPARISON',
    match: /\b(?:compare|versus|vs|better|best|which|choose|fd|deposit|mutual\s*fund|etf|ppf|nps|gold|equity|bond|sip|nav|interest\s+rate|returns?)\b/i,
    source: ['SEBI_INVESTOR', 'Factors to consider before investing', SEBI_INVESTING],
    text: 'To compare investment options, use the same goal deadline and evaluate the risk of losing principal, how quickly money can be accessed, diversification, fees, lock-in rules and tax implications. Obtain current issuer or regulator documentation before quoting a rate, NAV or scheme-specific return. A catalogue category or historical performance is not evidence that a particular product is available or suitable today.',
  }),
  Object.freeze({
    id: 'E_SCENARIO_GOAL_PLANNING',
    match: /\b(?:wedding|marriage|daughter|child|children|college|education|home|house|property|business|vehicle|car|vacation|travel|goal|within\s+\d+\s+years?)\b/i,
    source: ['SEBI_INVESTOR', 'Financial goals and budgeting', SEBI_GOALS],
    text: 'For a time-bound goal, begin with the goal amount, payment date, funds already earmarked and contributions affordable. Money needed soon generally puts greater weight on liquidity and limiting loss; a longer horizon may allow considering diversified growth exposure if the investor can bear declines. Review the plan as the deadline approaches. Establish whether a stated amount is existing capital or the future goal before calculating a funding shortfall.',
  }),
]);

function evidence(scenario) {
  const [provider, title, url] = scenario.source;
  return {
    id: scenario.id, kind: 'EDUCATION',
    value: { educationalOnly: true, personalizedAdvice: false, currentProductFactsVerified: false,
      scenarioCategory: scenario.id, referenceVersion: 'scenario-education-1.0.0' },
    displayValue: scenario.text,
    dataClass: 'CURATED_PUBLIC_EDUCATION',
    source: { provider, title, url, publicationDate: null, instrumentId: null },
    observedAt: null, freshness: null, authority: 'PUBLIC_EDUCATIONAL_SOURCE',
  };
}

export function isInvestmentScenarioQuestion(question, { allowAccountContext = false } = {}) {
  const text = String(question || '').slice(0, 1000);
  // A goal with a dated horizon may be financial even without the word
  // "investment". Keep ordinary wedding/event chatter on the general route.
  const datedGoal = /\b(?:wedding|marriage|education|college|retirement|home|house)\b.{0,75}\b(?:\d{1,3}\s+(?:years?|months?)|save|invest|fund|money|budget)\b/i.test(text);
  if (!text.trim() || (!FINANCE_SUBJECT.test(text) && !datedGoal)
      || (!allowAccountContext && ACCOUNT_SPECIFIC.test(text)) || TAX_SPECIFIC.test(text)) return false;
  return QUESTION_STYLE.test(text) || SCENARIOS.some(x => x.match.test(text));
}

export function retrieveInvestmentScenarioEducation(question, { allowAccountContext = false } = {}) {
  const text = String(question || '').slice(0, 1000);
  if (!isInvestmentScenarioQuestion(text, { allowAccountContext })) return [];
  const selected = SCENARIOS.find(item => item.match.test(text));
  if (selected) return [evidence(selected)];
  // Broad investment questions still deserve a concrete decision framework.
  // Never fill missing quote, market, suitability or tax facts with a guess.
  return [evidence({
    id: 'E_SCENARIO_GENERAL_DECISION',
    source: ['SEBI_INVESTOR', 'Factors to consider before investing', SEBI_INVESTING],
    text: 'Start with the purpose of the investment, when the money must be available and how much loss the investor could tolerate. Compare safety, liquidity, diversification, costs and verified current terms before narrowing the choices. A clear next step is to specify the goal deadline and whether the amount is money already available or a target to accumulate. No return or product suitability can be promised from a question alone.',
  })];
}
