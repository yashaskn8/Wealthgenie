/**
 * Bounded Indian-rupee goal-intent extraction, not a product recommendation.
 * All arithmetic uses ONLY values from this current user question.
 */
const GOAL_SUBJECT = /\b(?:daughter(?:s|'s)?|daugter(?:s|'s)?|saugter(?:s|'s)?|sons?|children|child|kids?|marriage|wedding|college|university|education|home|house|vehicle|car|retirement|financial goal|goal corpus)\b/i;
const GOAL_INTENT = /\b(?:need|want|save|fund|afford|plan|target|goal|corpus|budget|reach|arrange|require|how much|collect|build)\b/i;
const AMOUNT = /(?:₹\s*|(?:rs\.?|inr)\s*)?(\d+(?:\.\d+)?)\s*(crores?|crors?|crs?|cr|lakhs?|lacs?|lac)\b/gi;
const INR = amount => 'INR ' + amount.toLocaleString('en-IN', { maximumFractionDigits: 2 });

export function isFinancialGoalPlanningQuestion(question) {
  const text = String(question || '').slice(0, 1000);
  return GOAL_SUBJECT.test(text) && (GOAL_INTENT.test(text) || new RegExp(AMOUNT.source, 'i').test(text));
}

function extractMoney(question) {
  const rows = [];
  for (const match of String(question || '').matchAll(AMOUNT)) {
    const value = Number(match[1]);
    const unit = match[2].toLowerCase();
    const factor = /^cr/.test(unit) ? 10_000_000 : 100_000;
    const amount = Math.round(value * factor);
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 100_000_000_000) continue;
    const prefix = String(question).slice(Math.max(0, match.index - 52), match.index).toLowerCase();
    const suffix = String(question).slice(match.index + match[0].length, match.index + match[0].length + 24);
    rows.push({
      amount,
      savings: /(?:already\s+)?(?:have|saved|earmarked|set aside|saved up|have put aside)\s*(?:up to\s*)?(?:₹\s*|(?:rs\.?|inr)\s*)?$/i.test(prefix.trim())
        || /^\s*(?:already\s+)?(?:saved|earmarked|set aside|put aside)\b/i.test(suffix),
    });
  }
  return rows;
}

function contextLabel(question) {
  const text = String(question || '');
  if (/\b(?:daughter(?:s|'s)?|daugter(?:s|'s)?|saugter(?:s|'s)?)\b/i.test(text)
      && /\b(?:wedding|marriage)\b/i.test(text)) return "your daughter's marriage";
  if (/\b(?:wedding|marriage)\b/i.test(text)) return 'the wedding';
  if (/\b(?:college|university|education)\b/i.test(text)) return 'the education goal';
  if (/\b(?:house|home)\b/i.test(text)) return 'the home goal';
  if (/\b(?:vehicle|car)\b/i.test(text)) return 'the vehicle goal';
  if (/\bretirement\b/i.test(text)) return 'the retirement goal';
  return 'this financial goal';
}

function financialGoalHistory(priorTurns) {
  return Array.isArray(priorTurns) ? priorTurns
    .filter(turn => turn?.role === 'user' && typeof turn.content === 'string')
    .slice(-4).map(turn => turn.content.slice(0, 1000)) : [];
}

export function isFinancialGoalFollowUpQuestion(question, priorTurns = []) {
  const previous = financialGoalHistory(priorTurns);
  if (!previous.some(text => isFinancialGoalPlanningQuestion(text))) return false;
  return /^(?:(?:in|within|after|over)\s+\d|(?:i(?:'ve| have)|we(?:'ve| have))\s+(?:already\s+)?sav|(?:i|we)\s+can\s+(?:save|contribute)|(?:i|we)\s+have\s+(?:saved|set aside)|(?:starting|start)\s+(?:from|with)\s+(?:zero|nothing))/i
    .test(String(question || '').slice(0, 1000).trim());
}

export function retrieveChatGoalPlanningEvidence(question, priorTurns = []) {
  // Reuse *user-authored* turns only, never model-authored explanations.
  const previous = financialGoalHistory(priorTurns);
  const current = String(question || '').slice(0, 1000);
  const text = isFinancialGoalFollowUpQuestion(current, priorTurns)
    ? [...previous, current].join(' ').slice(-4000) : current;
  if (!isFinancialGoalPlanningQuestion(text)) return [];
  const amounts = extractMoney(text);
  const targets = amounts.filter(item => !item.savings);
  const savings = amounts.filter(item => item.savings);
  const target = targets.length === 1 ? targets[0].amount : null;
  const existing = savings.length === 1 ? savings[0].amount
    : /\b(?:no savings|nothing saved|zero saved|saved zero|starting from zero)\b/i.test(text) ? 0 : null;
  const horizonMatch = text.match(/\b(?:in|within|after|over)\s+(\d{1,2}(?:\.\d+)?)\s*(years?|yrs?|months?|mos?)\b/i);
  const months = horizonMatch ? Math.round(Number(horizonMatch[1])
    * (/^mo/i.test(horizonMatch[2]) ? 1 : 12)) : null;
  const validMonths = Number.isSafeInteger(months) && months > 0 && months <= 600;
  const capacityMatch = text.match(/\b(?:can\s+(?:save|contribute|afford)|monthly\s+(?:savings|saving|capacity|contribution))\s+(?:(?:₹|rs\.?|inr)\s*)?([\d,]+(?:\.\d+)?)\s*(k|thousand|lakhs?|lacs?)?\s*(?:per\s+month|monthly|a\s+month)?\b/i);
  const capacityMultiplier = /^k$|^thousand$/i.test(capacityMatch?.[2] || '') ? 1000
    : /^(?:lakh|lakhs|lac|lacs)$/i.test(capacityMatch?.[2] || '') ? 100_000 : 1;
  const capacity = capacityMatch ? Number(capacityMatch[1].replace(/,/g, '')) * capacityMultiplier : null;
  const validCapacity = Number.isSafeInteger(capacity) && capacity >= 0 && capacity <= 100_000_000;
  const missing = [];
  if (target === null) missing.push('a single clear target amount');
  if (!validMonths) missing.push('the deadline in years');
  if (existing === null) missing.push('how much is already earmarked for this goal (or confirm zero)');
  if (!validCapacity) missing.push('how much you can set aside monthly');
  const guidance = 'For ' + contextLabel(text) + ', '
    + (missing.length
      ? 'to build a usable funding plan please confirm ' + missing.join(', ') + '.'
      : 'your stated inputs allow a contribution-only funding check.')
    + ' Any contribution-only illustration excludes investment growth and inflation; future costs, taxes, investment performance and product suitability need independent verified inputs.';
  const entries = [{
    id: 'E_GOAL_PLANNING_GUIDANCE', kind: 'ANSWER_BOUNDARY',
    value: { goalContext: contextLabel(text), forecastAuthorized: false, sourceScope: 'CURRENT_USER_MESSAGE' },
    displayValue: guidance, dataClass: 'DETERMINISTIC_GOAL_PLANNING_BOUNDARY',
    source: null, observedAt: null, freshness: null, authority: 'WEALTHGENIE_BACKEND',
  }];
  if (target !== null) entries.unshift({
    id: 'E_GOAL_STATED_TARGET', kind: 'GOAL_TARGET',
    value: { targetAmount: target, sourceScope: 'CURRENT_USER_MESSAGE' },
    displayValue: 'Goal target: ' + INR(target),
    dataClass: 'USER_INPUT', source: null, observedAt: null, freshness: null, authority: 'USER_INPUT',
  });
  if (target !== null && validMonths && (existing === null || existing <= target)) {
    // Without known savings, offer an explicit ZERO-START scenario, never claim
    // to know the user's current balance or manufacture an expected return.
    const scenarioSavings = existing === null ? 0 : existing;
    const baseline = Math.ceil(((target - scenarioSavings) * 100) / months) / 100;
    if (Number.isFinite(baseline) && baseline > 0) entries.push({
      id: 'E_GOAL_MONTHLY_BASELINE', kind: 'GOAL_CALCULATION',
      value: { monthlyRequiredAmount: baseline, targetAmount: target,
        earmarkedSavingsAmount: scenarioSavings,
        scenario: existing === null ? 'ZERO_START_CONDITIONAL' : 'DECLARED_SAVINGS',
        horizonMonths: months, assumedGrowthRate: null,
        inflationRate: null, returnForecast: false, sourceScope: 'CURRENT_USER_MESSAGE' },
      displayValue: 'Funding-only baseline: ' + INR(baseline)
        + ' per month ' + (existing === null
          ? 'IF starting with no earmarked savings'
          : 'after subtracting the stated earmarked savings')
        + ', with no investment growth, inflation or taxes assumed',
      dataClass: 'DETERMINISTIC_NO_RETURN_ILLUSTRATION',
      source: null, observedAt: null, freshness: null, authority: 'WEALTHGENIE_BACKEND',
    });
    if (validCapacity && existing !== null) {
      const affordable = capacity >= baseline;
      entries.push({
        id: 'E_GOAL_CAPACITY_CHECK', kind: 'GOAL_CAPACITY',
        value: { monthlyCapacityAmount: capacity, monthlyRequiredAmount: baseline,
          goalIsContributionFundable: affordable, returnForecast: false,
          sourceScope: 'CURRENT_USER_MESSAGE' },
        displayValue: affordable
          ? 'At the monthly saving capacity you supplied, the contribution-only baseline is within capacity. This is not a prediction of market returns or future costs'
          : 'At the monthly saving capacity you supplied, this target is not fundable from contributions alone by the requested deadline. Consider revising the target or date; do not assume higher returns will close the gap',
        dataClass: 'DETERMINISTIC_GOAL_CAPACITY_CHECK',
        source: null, observedAt: null, freshness: null, authority: 'WEALTHGENIE_BACKEND',
      });
    }
  }
  return entries;
}
