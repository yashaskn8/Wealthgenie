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
  return GOAL_SUBJECT.test(text) && GOAL_INTENT.test(text);
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
    rows.push({
      amount,
      savings: /(?:already\s+)?(?:have|saved|earmarked|set aside|saved up|have put aside)\s*(?:up to\s*)?(?:₹\s*|(?:rs\.?|inr)\s*)?$/i.test(prefix.trim()),
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

export function retrieveChatGoalPlanningEvidence(question) {
  if (!isFinancialGoalPlanningQuestion(question)) return [];
  const text = String(question || '').slice(0, 1000);
  const amounts = extractMoney(text);
  const targets = amounts.filter(item => !item.savings);
  const savings = amounts.filter(item => item.savings);
  const target = targets.length === 1 ? targets[0].amount : null;
  const existing = savings.length === 1 ? savings[0].amount
    : /\b(?:no savings|nothing saved|zero saved|saved zero|starting from zero)\b/i.test(text) ? 0 : null;
  const horizonMatch = text.match(/\b(?:in|within|after|over)\s+(\d{1,2}(?:\.\d+)?)\s+years?\b/i);
  const months = horizonMatch ? Number(horizonMatch[1]) * 12 : null;
  const validMonths = Number.isSafeInteger(months) && months > 0 && months <= 600;
  const guidance = 'For ' + contextLabel(text)
    + ', I can plan a funding target, not promise an investment outcome. Please confirm when the money is needed, how much is already saved specifically for this goal, and how much can be saved each month. A contribution-only calculation assumes no investment growth or inflation; actual future costs, returns, taxes and product suitability require separate verified inputs.';
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
  if (target !== null && existing !== null && validMonths && existing <= target) {
    const baseline = Math.ceil(((target - existing) / months) * 100) / 100;
    if (Number.isFinite(baseline) && baseline > 0) entries.push({
      id: 'E_GOAL_MONTHLY_BASELINE', kind: 'GOAL_CALCULATION',
      value: { monthlyRequiredAmount: baseline, targetAmount: target,
        earmarkedSavingsAmount: existing, horizonMonths: months, assumedGrowthRate: null,
        inflationRate: null, returnForecast: false, sourceScope: 'CURRENT_USER_MESSAGE' },
      displayValue: 'Funding-only baseline: ' + INR(baseline)
        + ' per month using the stated target and earmarked funds over the stated horizon, with no investment growth or inflation assumed',
      dataClass: 'DETERMINISTIC_NO_RETURN_ILLUSTRATION',
      source: null, observedAt: null, freshness: null, authority: 'WEALTHGENIE_BACKEND',
    });
  }
  return entries;
}
