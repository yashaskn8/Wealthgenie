/**
 * Conservative Indian-rupee financial-goal planner. It operates only on the
 * present question and short account-bound USER turns supplied by chat.
 * No model-return assumption, tax rate, product recommendation or live quote
 * is created by this module.
 */
const SUBJECT = /\b(?:daughter(?:s|'s)?|daugter(?:s|'s)?|saugter(?:s|'s)?|sons?|children|child|kids?|marriage|wedding|college|university|education|study|home|house|property|down payment|vehicle|car|retirement|financial goal|goal corpus|medical|hospital|healthcare|vacation|travel|trip|startup|business|ceremony|emergency fund|school|tuition)\b/i;
const GOAL_INTENT = /\b(?:need|want|save|fund|afford|plan|target|goal|corpus|budget|reach|arrange|require|how much|collect|build|set aside|prepare|raise)\b/i;
const AMOUNT = /(?:₹\s*|(?:rs\.?|inr)\s*)?(\d[\d,]*(?:\.\d+)?)\s*(crores?|crors?|crs?|cr|lakhs?|lacs?|lac|thousands?|k)\b|(?:₹|inr|rs\.?)\s*(\d[\d,]*(?:\.\d+)?)(?!\d|[,.](?=\d)|\s*(?:%|years?\b|months?\b|yrs?\b|mos?\b))/gi;
const INR = amount => 'INR ' + amount.toLocaleString('en-IN', { maximumFractionDigits: 2 });
const goalText = value => String(value || '').slice(0, 1000).trim();

export function isFinancialGoalPlanningQuestion(question) {
  const text = goalText(question);
  // Never divert ordinary travel, healthcare, education or wedding questions
  // into the financial engine based solely on a shared subject word.
  const explicitAmount = new RegExp(AMOUNT.source, 'i').test(text);
  const fundingIntent = /\b(?:sav(?:e|ing|ings)|fund(?:s|ing)?|financ(?:e|es|ial)|afford|target|budget|corpus|rupees?|money|invest(?:ing|ment)?|monthly|lump[ -]?sum|costs?|expenses?|payments?|set aside|crores?|crors?|lakhs?|lacs?|paise)\b/i.test(text);
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
  // A correction to an already established goal must supersede the old
  // target instead of falling through to an unrelated generic finance reply.
  const targetRevision = /\b(?:actually|instead|make\s+(?:it|that)|change\s+(?:the\s+)?(?:goal|target)|(?:my|the)\s+(?:goal|target)\s+(?:is|should\s+be))\b/i.test(text)
    && moneyIn(text).some(item => item.role === 'TARGET');
  if (targetRevision) return true;
  return /^(?:(?:in|within|after|over)\s+)?\d+(?:\.\d+)?\s*(?:years?|yrs?|months?|mos?)\b/i.test(text)
    || /^(?:in|within|after|over)\s+\d/i.test(text)
    || /\b(?:saved|savings|set aside|already have|starting from zero|nothing saved|no savings|per month|monthly|years?|yrs?|months?|mos?|horizon|deadline|timeline|afford|can contribute|can save|can invest)\b/i.test(text);
}

function parseExactRupees(raw, factor) {
  if (!/^(?:\d+(?:\.\d+)?|\d{1,3}(?:,\d{2})*,\d{3}(?:\.\d+)?|\d{1,3}(?:,\d{3})+(?:\.\d+)?)$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.replace(/,/g, '').split('.');
  if (fraction.length > 12) return null;
  const divisor = 10n ** BigInt(fraction.length);
  const fractionalPaiseNumerator = BigInt(fraction || '0') * factor * 100n;
  if (fractionalPaiseNumerator % divisor !== 0n) return null;
  const paise = BigInt(whole) * factor * 100n + fractionalPaiseNumerator / divisor;
  if (paise < 0n || paise > 100_000_000_000n * 100n || paise > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(paise) / 100;
}

function moneyIn(question) {
  const found = [];
  for (const match of goalText(question).matchAll(AMOUNT)) {
    const unit = String(match[2] || '').toLowerCase();
    const factor = /^cr/.test(unit) ? 10_000_000n
      : /^(?:lakh|lac)/.test(unit) ? 100_000n
        : /^(?:k|thousand)/.test(unit) ? 1000n : 1n;
    const amount = parseExactRupees(match[1] || match[3], factor);
    if (amount === null) { found.push({ amount: null, role: 'INVALID' }); continue; }
    const before = goalText(question).slice(Math.max(0, match.index - 70), match.index).toLowerCase().trim();
    const after = goalText(question).slice(match.index + match[0].length, match.index + match[0].length + 55).toLowerCase();
    // Never turn an explicitly foreign or negative amount into a positive INR goal.
    if (/(?:[-−]|minus|negative)\s*(?:₹\s*|(?:rs\.?|inr)\s*)?$|(?:\b(?:usd|gbp|eur|aed|cad|aud|dollars?|pounds?|euros?)|\$|€|£)\s*$/.test(before)) {
      found.push({ amount: null, role: 'INVALID' });
      continue;
    }
    const targetCue = /\b(?:need|want|target(?:\s+is)?|goal(?:\s+is)?|save|raise|require)\s*(?:₹\s*|(?:rs\.?|inr)\s*)?$/i.test(before);
    const savings = !targetCue && (/(?:already\s+)?(?:have\s+saved|have\s+put\s+aside|currently\s+saving|saving|saved|saved\s+up|earmarked|set\s+aside|accumulated|existing\s+savings|savings(?:\s+(?:of|are|is))?|starting\s+(?:with|from))\s*(?:up\s+to\s*)?(?:₹\s*|(?:rs\.?|inr)\s*)?$/i.test(before)
      || /^\s*(?:already\s+saved|saved(?:\s+already)?|earmarked|in\s+savings|as\s+savings|in\s+(?:my|our)\s+savings|set\s+aside)\b/i.test(after));
    const capacity = !savings && (/(?:can|could|able\s+to)\s+(?:save|invest|contribute)\s*(?:₹\s*|(?:rs\.?|inr)\s*)?$/i.test(before)
      || /(?:monthly\s+(?:saving|contribution|capacity|budget)|per\s+month|each\s+month)\s*(?:of\s*)?(?:₹\s*|(?:rs\.?|inr)\s*)?$/i.test(before)
      || /^\s*(?:per\s+month|each\s+month|monthly|\/month|a\s+month|pm\b)\b/i.test(after));
    const unrelated = !savings && !capacity && (/\b(?:salary|income|earn(?:ings)?|emi|rent|debt|loan|expenses?|spend(?:ing)?|paid|premium)\s*(?:of|is|are|:)?\s*(?:₹\s*|(?:rs\.?|inr)\s*)?$/i.test(before)
      || /^\s*(?:salary|income|emi|rent|loan|in\s+debt|as\s+(?:emi|debt|loan|mortgage|expenses?))\b/i.test(after));
    const ambiguousHolding = !savings && !capacity && !unrelated
      && /\b(?:i|we)\s+have\s*(?:₹\s*|(?:rs\.?|inr)\s*)?$/i.test(before)
      && !/^\s*(?:as\s+(?:my|our|the)\s+(?:target|goal)|(?:for|towards)\s+(?:my|our|the)\s+goal)\b/i.test(after);
    found.push({ amount, role: savings ? 'SAVINGS' : capacity ? 'CAPACITY'
      : unrelated ? 'OTHER' : ambiguousHolding ? 'AMBIGUOUS' : 'TARGET' });
  }
  return found;
}

function goalHorizonMonths(question) {
  const candidates = [];
  const supplied = goalText(question);
  const text = /^\d{1,3}(?:\.\d+)?\s*(?:years?|yrs?|months?|mos?)(?:\s*(?:and\s*)?\d{1,2}\s*months?)?[.!]?$/i.test(supplied)
    ? 'in ' + supplied : supplied;
  const pattern = /\b(?:in|within|after|over|next|for|timeframe(?: of)?|horizon(?: of)?|deadline(?: of| in)?)\s+(\d{1,3}(?:\.\d+)?)\s*(years?|yrs?|months?|mos?)\b(?:\s*(?:and\s*)?(\d{1,2})\s*months?\b)?/gi;
  for (const match of text.matchAll(pattern)) {
    const [whole, fraction = ''] = match[1].split('.');
    if (fraction.length > 6) return -1;
    const scale = 10n ** BigInt(fraction.length);
    const count = BigInt(whole) * scale + BigInt(fraction || '0');
    const isYears = /^(?:year|yr)/i.test(match[2]);
    const numerator = count * (isYears ? 12n : 1n);
    if (numerator % scale !== 0n) return -1;
    const remainderMonths = match[3] ? BigInt(match[3]) : 0n;
    if (!isYears && remainderMonths) return -1;
    const months = numerator / scale + remainderMonths;
    if (months < 1n || months > 600n) return -1;
    candidates.push(Number(months));
  }
  return candidates.length ? (candidates.every(months => months === candidates[0]) ? candidates[0] : -1) : null;
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
  let invalidAmount = false;
  let contradictorySavings = false;
  for (const turn of used) {
    const amounts = moneyIn(turn);
    if (amounts.some(item => item.role === 'INVALID' || item.role === 'AMBIGUOUS')) invalidAmount = true;
    if (/\b(?:₹|rs\.?|inr)\s*[-−]\s*\d/i.test(turn)) invalidAmount = true;
    const targets = amounts.filter(item => item.role === 'TARGET');
    const savings = amounts.filter(item => item.role === 'SAVINGS');
    const capacities = amounts.filter(item => item.role === 'CAPACITY');
    if (targets.length > 1 || targets.some(item => item.amount <= 0)) { target = null; ambiguousTarget = true; invalidAmount = true; }
    else if (targets.length === 1) { target = targets[0].amount; ambiguousTarget = false; }
    if (savings.length === 1) saved = savings[0].amount;
    else if (savings.length > 1) { saved = null; invalidAmount = true; }
    const zeroSavings = /\b(?:no savings|nothing saved|zero saved|saved zero|starting from zero|0 savings|zero savings)\b/i.test(turn);
    if (zeroSavings && savings.length > 0) contradictorySavings = true;
    else if (zeroSavings) saved = 0;
    if (capacities.length === 1) monthlyCapacity = capacities[0].amount;
    else if (capacities.length > 1) { monthlyCapacity = null; invalidAmount = true; }
    const months = goalHorizonMonths(turn);
    if (months === -1) { horizon = null; ambiguousHorizon = true; }
    else if (months !== null) { horizon = months; ambiguousHorizon = false; }
  }

  // Fail closed on ambiguous savings or amounts with fractional paise.
  if (invalidAmount || contradictorySavings) { target = null; saved = null; monthlyCapacity = null; invalidAmount = true; }
  const context = goalName(source);
  const missing = [];
  if (target === null) missing.push(invalidAmount ? 'the exact goal and savings amounts (one amount was ambiguous or invalid)' : ambiguousTarget ? 'which amount is the actual goal target' : 'the target amount');
  if (horizon === null) missing.push(ambiguousHorizon ? 'a valid unambiguous deadline expressed in whole months' : 'the deadline in years');
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
    const leftPaise = BigInt(Math.round(target * 100)) - BigInt(Math.round(saved * 100));
    const required = Number((leftPaise + BigInt(horizon) - 1n) / BigInt(horizon)) / 100;
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
    const remainingPaise = BigInt(Math.round(target * 100)) - BigInt(Math.round(scenarioSavings * 100));
    const baseline = Number((remainingPaise + BigInt(horizon) - 1n) / BigInt(horizon)) / 100;
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
