/**
 * Conservative Indian-rupee financial-goal planner. It operates only on the
 * present question and short account-bound USER turns supplied by chat.
 * No model-return assumption, tax rate, product recommendation or live quote
 * is created by this module.
 */
const SUBJECT = /\b(?:daughter(?:s|'s)?|daugter(?:s|'s)?|saugter(?:s|'s)?|sons?|children|child|kids?|marriage|wedding|college|university|education|study|home|house|property|down payment|vehicle|car|retirement|financial goal|goal corpus|medical|hospital|healthcare|vacation|travel|trip|startup|business|ceremony|emergency fund|school|tuition)\b/i;
const GOAL_INTENT = /\b(?:need|want|save|fund|afford|plan|target|goal|corpus|budget|reach|arrange|require|how much|collect|build|set aside|prepare|raise)\b/i;
const AMOUNT = /(?:₹\s*|(?:rs\.?|inr)\s*)?(\d[\d,]*(?:\.\d+)?)\s*(crores?|crors?|crs?|cr|lakhs?|lacs?|lac|thousands?|k)\b|(?:₹|inr|rs\.?)\s*(\d[\d,]*(?:\.\d+)?)(?!\s*(?:%|years?|months?))/gi;
const INR = amount => 'INR ' + amount.toLocaleString('en-IN', { maximumFractionDigits: 2 });
const goalText = value => String(value || '').slice(0, 1000).trim();

export function isFinancialGoalPlanningQuestion(question) {
  const text = goalText(question);
  // Never divert ordinary travel, healthcare, education or wedding questions
  // into the financial engine based solely on a shared subject word.
  const explicitAmount = new RegExp(AMOUNT.source, 'i').test(text);
  const fundingIntent = /\b(?:sav(?:e|ing|ings)|fund(?:s|ing)?|financ(?:e|es|ial)|afford|target|budget|corpus|rupees?|money|invest(?:ing|ment)?|monthly|lump[ -]?sum|costs?|expenses?|payments?|set aside)\b/i.test(text);
  return SUBJECT.test(text) && GOAL_INTENT.test(text)
    && (explicitAmount || fundingIntent);
}

function authenticatedUserTurns(priorTurns) {
  // Only user-authored text from the already verified account/profile binding.
  const turns = Array.isArray(priorTurns) ? priorTurns
    : Array.isArray(priorTurns?.priorUserTurns) ? priorTurns.priorUserTurns : [];
  return turns.filter(turn => typeof turn === 'string' || turn?.role === 'user')
    .map(turn => goalText(typeof turn === 'string' ? turn : turn.content)).slice(-4);
}

export function isFinancialGoalFollowUpQuestion(question, priorTurns = []) {
  return isGoalPlanningFollowUp(question)
    && authenticatedUserTurns(priorTurns).some(isFinancialGoalPlanningQuestion);
}

export function isGoalPlanningFollowUp(question) {
  const text = goalText(question);
  if (!text || text.length > 240) return false;
  return /^(?:in|within|after|over)\s+\d/i.test(text)
    || /\b(?:saved|savings|set aside|already have|starting from zero|nothing saved|no savings|per month|monthly|years?|months?|horizon|deadline|timeline|afford|can contribute|can save|can invest)\b/i.test(text);
}

function moneyIn(question) {
  const found = [];
  for (const match of goalText(question).matchAll(AMOUNT)) {
    const amountUnit = String(match[3] ? '' : match[2] || '').toLowerCase();
    const factor = /^cr/.test(amountUnit) ? 10_000_000
      : /^(?:lakh|lac)/.test(amountUnit) ? 100_000
        : /^(?:k|thousand)/.test(amountUnit) ? 1000 : 1;
    const raw = match[1] || match[3];
    const amount = Number(raw.replace(/,/g, '')) * factor;
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 100_000_000_000) continue;
    const before = String(question).slice(Math.max(0, match.index - 55), match.index).toLowerCase();
    const after = String(question).slice(match.index + match[0].length, match.index + match[0].length + 34).toLowerCase();
    const savings = /(?:already\s+)?(?:have|saved|earmarked|set aside|saved up|have put aside|accumulated|existing savings)\s*(?:up to\s*)?(?:₹\s*|(?:rs\.?|inr)\s*)?$/i.test(before.trim())
      || /^\s*(?:already\s+saved|saved\s+already|in savings)\b/i.test(after);
    const monthly = !savings && (/(?:can\s+(?:save|invest|contribute)|monthly\s+(?:saving|contribution)|per month)\s*(?:₹\s*|(?:rs\.?|inr)\s*)?$/i.test(before.trim())
      || /^\s*(?:per month|monthly|\/month)\b/i.test(after));
    found.push({ amount, role: savings ? 'SAVINGS' : monthly ? 'CAPACITY' : 'TARGET' });
  }
  return found;
}

function goalHorizonMonths(question) {
  const text = goalText(question);
  const years = text.match(/\b(?:in|within|after|over|next|timeframe(?: of)?|horizon(?: of)?)\s+(\d{1,2}(?:\.5)?)\s+years?\b/i);
  const months = text.match(/\b(?:in|within|after|over|next|timeframe(?: of)?|horizon(?: of)?)\s+(\d{1,3})\s+months?\b/i);
  const value = years ? Number(years[1]) * 12 : months ? Number(months[1]) : null;
  return Number.isSafeInteger(value) && value >= 1 && value <= 600 ? value : null;
}

function goalName(text) {
  if (/\b(?:daughter(?:s|'s)?|daugter(?:s|'s)?|saugter(?:s|'s)?)\b/i.test(text) && /\bmarriage\b/i.test(text)) return "your daughter's marriage";
  if (/\b(?:daughter(?:s|'s)?|daugter(?:s|'s)?|saugter(?:s|'s)?)\b/i.test(text) && /\bwedding\b/i.test(text)) return "your daughter's wedding";
  if (/\b(?:marriage|wedding|ceremony)\b/i.test(text)) return 'the wedding';
  if (/\b(?:college|university|education|study|school|tuition)\b/i.test(text)) return 'the education goal';
  if (/\b(?:medical|hospital|healthcare)\b/i.test(text)) return 'the medical expense';
  if (/\b(?:home|house|property|down payment)\b/i.test(text)) return 'the home goal';
  if (/\b(?:car|vehicle)\b/i.test(text)) return 'the vehicle goal';
  if (/\b(?:travel|vacation|trip)\b/i.test(text)) return 'the travel goal';
  if (/\b(?:startup|business)\b/i.test(text)) return 'the business goal';
  if (/\bretirement\b/i.test(text)) return 'retirement';
  return 'this goal';
}

export function retrieveChatGoalPlanningEvidence(question, { priorUserTurns = [] } = {}) {
  const text = goalText(question);
  const past = authenticatedUserTurns(priorUserTurns);
  const direct = isFinancialGoalPlanningQuestion(text);
  const previousGoalIndex = past.findLastIndex(isFinancialGoalPlanningQuestion);
  if (!direct && (previousGoalIndex < 0 || !isGoalPlanningFollowUp(text))) return [];

  // A new named goal must not inherit amounts from an unrelated older goal.
  const used = direct ? [text] : [...past.slice(previousGoalIndex), text];
  const source = direct ? text : past[previousGoalIndex];
  let target = null;
  let saved = null;
  let horizon = null;
  let monthlyCapacity = null;
  let ambiguousTarget = false;
  for (const turn of used) {
    const amounts = moneyIn(turn);
    const targets = amounts.filter(item => item.role === 'TARGET');
    const savings = amounts.filter(item => item.role === 'SAVINGS');
    const capacities = amounts.filter(item => item.role === 'CAPACITY');
    if (targets.length > 1) { target = null; ambiguousTarget = true; }
    else if (targets.length === 1) { target = targets[0].amount; ambiguousTarget = false; }
    if (savings.length === 1) saved = savings[0].amount;
    else if (savings.length > 1) saved = null;
    if (/\b(?:no savings|nothing saved|zero saved|saved zero|starting from zero)\b/i.test(turn)) saved = 0;
    if (capacities.length === 1) monthlyCapacity = capacities[0].amount;
    const months = goalHorizonMonths(turn);
    if (months !== null) horizon = months;
  }

  const context = goalName(source);
  const missing = [];
  if (target === null) missing.push(ambiguousTarget ? 'which amount is the actual goal target' : 'the target amount');
  if (horizon === null) missing.push('the deadline in years');
  if (saved === null) missing.push('how much is already earmarked for this goal');
  const scope = used.length > 1 ? 'TRUSTED_FINANCIAL_CHAT' : 'CURRENT_USER_MESSAGE';

  let guidance;
  if (target !== null && horizon !== null && saved !== null && saved >= target) {
    guidance = 'Your stated earmarked savings already cover the stated target for ' + context
      + ' before inflation or changes in future costs. Confirm whether the target is in today’s rupees and whether those funds are accessible. No investment return has been assumed.';
  } else if (missing.length) {
    guidance = 'To plan for ' + context + ', please confirm ' + missing.join(' and ')
      + '. Once those are confirmed, I can check the monthly saving required without guessing an investment return.';
  } else {
    guidance = 'For ' + context + ', the funding-only monthly amount is based on your stated target, savings and deadline. Compare it with what you can set aside each month. This is not a return forecast; future costs, taxes and inflation are not estimated here.';
  }
  if (monthlyCapacity !== null && saved !== null && horizon !== null && target !== null) {
    const required = Math.ceil(((Math.max(0, target - saved)) / horizon) * 100) / 100;
    guidance += monthlyCapacity >= required
      ? ' Your stated monthly capacity is at least this contribution-only baseline.'
      : ' Your stated monthly capacity is below this contribution-only baseline; the goal, deadline or contributions would need reviewing.';
  }
  const entries = [{
    id: 'E_GOAL_PLANNING_GUIDANCE', kind: 'ANSWER_BOUNDARY',
    value: { goalContext: context, forecastAuthorized: false, sourceScope: scope },
    displayValue: guidance, dataClass: 'DETERMINISTIC_GOAL_PLANNING_BOUNDARY',
    source: null, observedAt: null, freshness: null, authority: 'WEALTHGENIE_BACKEND',
  }];
  if (target !== null) entries.unshift({
    id: 'E_GOAL_STATED_TARGET', kind: 'GOAL_TARGET',
    value: { targetAmount: target, sourceScope: scope },
    displayValue: 'Goal target: ' + INR(target),
    dataClass: 'USER_INPUT', source: null, observedAt: null, freshness: null, authority: 'USER_INPUT',
  });
  if (target !== null && horizon !== null && (saved === null || saved < target)) {
    const scenarioSavings = saved === null ? 0 : saved;
    const scenario = saved === null ? 'ZERO_START_CONDITIONAL' : 'DECLARED_SAVINGS';
    const baseline = Math.ceil(((target - scenarioSavings) * 100) / horizon) / 100;
    if (Number.isFinite(baseline) && baseline > 0) entries.push({
      id: 'E_GOAL_MONTHLY_BASELINE', kind: 'GOAL_CALCULATION',
      value: { monthlyRequiredAmount: baseline, targetAmount: target,
        earmarkedSavingsAmount: scenarioSavings, scenario,
        horizonMonths: horizon, assumedGrowthRate: null,
        inflationRate: null, returnForecast: false, sourceScope: scope },
      displayValue: 'Funding-only baseline: ' + INR(baseline)
        + ' per month ' + (scenario === 'ZERO_START_CONDITIONAL'
          ? 'IF starting with no earmarked savings' : 'after deducting the savings stated for this goal')
        + '; no investment returns, inflation or tax effects assumed',
      dataClass: 'DETERMINISTIC_NO_RETURN_ILLUSTRATION',
      source: null, observedAt: null, freshness: null, authority: 'WEALTHGENIE_BACKEND',
    });
    if (monthlyCapacity !== null && saved !== null) {
      const fundableFromContributions = monthlyCapacity >= baseline;
      entries.push({
        id: 'E_GOAL_CAPACITY_CHECK', kind: 'GOAL_CAPACITY',
        value: { monthlyCapacityAmount: monthlyCapacity, monthlyRequiredAmount: baseline,
          goalIsContributionFundable: fundableFromContributions,
          returnForecast: false, sourceScope: scope },
        displayValue: fundableFromContributions
          ? 'Your stated monthly savings capacity covers this contribution-only baseline; this does not predict future investment value'
          : 'At your stated monthly capacity this target is not fundable from contributions alone before the deadline; consider revising the target or date or affordable contributions rather than assuming higher returns',
        dataClass: 'DETERMINISTIC_GOAL_CAPACITY_CHECK',
        source: null, observedAt: null, freshness: null, authority: 'WEALTHGENIE_BACKEND',
      });
    }
  }
  return entries;
}
