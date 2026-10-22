import { calculateGoalCompoundingScenario } from './chatGoalScenarioMath.js';
/**
 * Conservative Indian-rupee financial-goal planner. It operates only on the
 * present question and short account-bound USER turns supplied by chat.
 * No model-return assumption, tax rate, product recommendation or live quote
 * is created by this module.
 */
const SUBJECT = /\b(?:daughter(?:s|'s)?|daugter(?:s|'s)?|saugter(?:s|'s)?|sons?|children|child|kids?|marriage|wedding|college|university|education|study|home|house|property|down payment|vehicle|car|retirement|financial goal|goal corpus|medical|hospital|healthcare|vacation|travel|trip|startup|business|ceremony|emergency fund|school|tuition)\b/i;
const GOAL_INTENT = /\b(?:need|want|save|fund|afford|plan|target|goal|corpus|budget|reach|arrange|require|how much|collect|build|set aside|prepare|raise|costs?|pay|spend|estimate)\b/i;
const AMOUNT = /(?:₹\s*|(?:rs\.?|inr)\s*)?(\d[\d,]*(?:\.\d+)?)\s*(crores?|crors?|crs?|cr|lakhs?|lacs?|lac|thousands?|k|l)\b|(?:₹|inr|rs\.?)\s*(\d[\d,]*(?:\.\d+)?)(?!\d|[,.](?=\d)|[A-Za-z]|\s*(?:%|years?\b|months?\b|yrs?\b|mos?\b))/gi;
const INR = amount => 'INR ' + amount.toLocaleString('en-IN', { maximumFractionDigits: 2 });
const goalText = value => String(value || '').slice(0, 1000).trim();

export function isFinancialGoalPlanningQuestion(question) {
  const text = goalText(question);
  // Never divert ordinary travel, healthcare, education or wedding questions
  // into the financial engine based solely on a shared subject word.
  const explicitAmount = new RegExp(AMOUNT.source, 'i').test(text)
    || /(?:₹|\binr\b|\brs\.?)\s*[-−]?\s*\d[\d,.]*(?:\s*[a-z]+)?/i.test(text);
  const fundingIntent = /\b(?:sav(?:e|ing|ings)|fund(?:s|ing)?|financ(?:e|es|ial)|afford|target|budget|corpus|rupees?|money|invest(?:ing|ment)?|monthly|lump[ -]?sum|costs?|expenses?|payments?|pay|spend|price|set aside|crores?|crors?|lakhs?|lacs?|paise)\b/i.test(text);
  // Financial targets do not require a wedding/house/etc. noun. Otherwise
  // "I want to accumulate 2 crore in 10 years" falls through to a generic
  // finance reply even though the deterministic calculation has the inputs.
  // Require an amount and a clear goal-forming intent: mentioning an income,
  // salary, EMI, or a product rate by itself must not become a new goal.
  const genericGoalIntent = /\b(?:want|need|plan|planning|aim|hope|trying)\s+(?:to\s+)?(?:save|accumulate|build|reach|raise|collect|have)\b|\b(?:accumulate|save|build|reach|raise|collect)\s+(?:up\s+)?(?:₹|rs\.?|inr|\d)|\b(?:target|goal|corpus)\s*(?:is|of|:)?\s*(?:₹|rs\.?|inr|\d)/i.test(text)
    || /\b(?:need|want|require)\s+(?:₹|rs\.?|inr|\d)\s*[\d,.]*(?:\s*(?:crores?|crors?|crs?|cr|lakhs?|lacs?|lac))?\s+(?:in|within|over|after)\s+\d{1,3}\s*(?:years?|yrs?|months?|mos?)\b/i.test(text);
  const namedGoal = SUBJECT.test(text) && (GOAL_INTENT.test(text)
    || /\b(?:will|would|may)\s+cost\b/i.test(text)
    || /^\s*(?:₹|inr|rs\.?)\s*\d[\d,]*(?:\.\d+)?\s*(?:crores?|crors?|crs?|cr|lakhs?|lacs?|lac|l)\b.*\b(?:daughter|son|my|our|wedding|marriage)\b/i.test(text))
    && (explicitAmount || fundingIntent);
  return namedGoal || (explicitAmount && genericGoalIntent);
}


const PERCENT_INPUT = /(?<![\d.])(-?\d{1,3}(?:\.\d{1,4})?)\s*%/g;
function goalRateMentions(question) {
  const text = goalText(question);
  const matches = [];
  for (const match of text.matchAll(PERCENT_INPUT)) {
    const before = text.slice(Math.max(0, match.index - 50), match.index).toLowerCase();
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 50).toLowerCase();
    const inflation = /^\s*(?:(?:annual|yearly|p\.?a\.?)\s+)?(?:inflation|price inflation)\b/.test(after)
      || /\b(?:inflation|price inflation|cost inflation)\s*(?:rate|is|of|at|:)?\s*$/.test(before);
    const investment = /^\s*(?:(?:annual|yearly|p\.?a\.?)\s+)?(?:returns?|cagr|investment growth)\b/.test(after)
      || /\b(?:investment\s+)?(?:returns?|cagr|growth)\s*(?:rate|is|of|at|:)?\s*$/.test(before);
    // Never reinterpret nominal, simple or nonannual rates as an effective CAGR.
    const immediateContext = text.slice(Math.max(0, match.index - 20),
      match.index + match[0].length + 20);
    const incompatibleRateBasis = /\b(?:monthly|quarterly|weekly|daily|nominal|simple interest|post[- ]tax|after[- ]tax)\b/i.test(immediateContext)
      && (inflation || investment || /\b(?:nominal|simple interest|post[- ]tax|after[- ]tax)\b/i.test(immediateContext));
    if (incompatibleRateBasis) matches.push({ kind: 'INVALID' });
    else if (inflation && investment) matches.push({ kind: 'INVALID' });
    else if (inflation || investment) matches.push({ kind: inflation ? 'INFLATION' : 'RETURN', rate: match[1] });
  }
  return matches;
}
function isGoalScenarioRateQuestion(question) {
  const text = goalText(question);
  return text.length > 0 && text.length <= 240 && /\d(?:\.\d+)?\s*%/.test(text)
    && /\b(?:inflation|returns?|cagr|investment growth|compounding)\b/i.test(text);
}
function isTargetPresentCost(question) {
  return /\b(?:today'?s|current|present(?:-day)?)\s+(?:rupees|cost|costs|price|prices|value|money)\b|\b(?:cost|price|value)\s+(?:today|now)\b/i.test(question);
}

function authenticatedUserTurns(priorTurns) {
  // Only user-authored text from the already verified account/profile binding.
  const turns = Array.isArray(priorTurns) ? priorTurns
    : Array.isArray(priorTurns?.priorUserTurns) ? priorTurns.priorUserTurns : [];
  return turns.filter(turn => typeof turn === 'string' || turn?.role === 'user')
    .map(turn => goalText(typeof turn === 'string' ? turn : turn.content)).slice(-4);
}

// Never revive an older goal after an intervening finance topic. A short
// "in 10 years" / "why that number?" is only meaningful within one continuous
// run of goal-related user turns, even when all turns share the same profile.
function goalScopedUserTurns(priorTurns) {
  const turns = authenticatedUserTurns(priorTurns);
  let start = turns.length;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (!isFinancialGoalPlanningQuestion(turns[index])
        && !isGoalPlanningFollowUp(turns[index])) break;
    start = index;
  }
  return turns.slice(start);
}

export function isFinancialGoalFollowUpQuestion(question, priorTurns = []) {
  return isGoalPlanningFollowUp(question)
    && goalScopedUserTurns(priorTurns).some(isFinancialGoalPlanningQuestion);
}

export function isGoalCalculationFollowUp(question) {
  const text = goalText(question);
  if (!text || text.length > 160) return false;
  if (/^(?:why(?:\s+(?:is|was)\s+(?:that|this|it|the\s+monthly\s+(?:amount|saving)))?(?:\s+so\s+much)?|how\s+(?:was|is)\s+(?:that|this|it|the\s+(?:amount|baseline|monthly\s+amount))\s+calculated|how\s+did\s+you\s+(?:calculate|work\s+out|arrive\s+at)\s+(?:that|this|it|the\s+(?:amount|number|baseline))|show\s+(?:me\s+)?(?:the\s+)?(?:math|calculation|steps)|break\s+(?:it|that)\s+down|explain\s+(?:(?:that|this|it)(?:\s+(?:amount|baseline))?|the\s+(?:amount|baseline))(?:\s+simply)?)\s*[?.!]*$/i.test(text)) return true;
  return /^why\s+(?:(?:is|was)\s+(?:that|this|it)\s+)?(?:₹\s*|(?:rs\.?|inr)\s*)?\d[\d,]*(?:\.\d+)?(?:\s*(?:lakhs?|lacs?|crs?|crores?|l))?(?:\s+per\s+month)?\s*[?.!]*$/i.test(text);
}

export function isGoalPlanningFollowUp(question) {
  const text = goalText(question);
  if (!text || text.length > 240) return false;
  const targetRevision = /\b(?:actually|instead|make\s+(?:it|that)|change\s+(?:the\s+)?(?:goal|target)|(?:my|the)\s+(?:goal|target)\s+(?:is|should\s+be))\b/i.test(text)
    && moneyIn(text).some(item => item.role === 'TARGET');
  if (targetRevision) return true;
  if (isGoalCalculationFollowUp(text) || isGoalScenarioRateQuestion(text)) return true;
  // Stray time references in unrelated questions must not rewrite an active goal.
  const simpleDeadline = /^(?:(?:in|within|after|over|next|for)\s+)?\d{1,3}(?:\.\d+)?\s*(?:years?|yrs?|months?|mos?)(?:\s+(?:and\s+)?\d{1,2}\s+months?)?(?:\s+instead)?\s*[.!?]?$/i;
  const namedDeadline = /^(?:(?:the|my|our|this|that)\s+)?(?:goal\s+)?(?:deadline|timeline|horizon|timeframe)\s*(?:is|of|to|:)?\s*(?:in|within|after|over)?\s*\d{1,3}(?:\.\d+)?\s*(?:years?|yrs?|months?|mos?)(?:\s+(?:and\s+)?\d{1,2}\s+months?)?\s*[.!?]?$/i;
  const referencedGoalDeadline = /^(?:(?:i|we)\s+(?:want|need|plan|hope)\s+(?:to\s+(?:do|reach|achieve|fund|make)\s+)?(?:it|that|this|the goal)?\s*)?(?:in|within|after|over)\s+\d{1,3}(?:\.\d+)?\s*(?:years?|yrs?|months?|mos?)(?:\s+(?:and\s+)?\d{1,2}\s+months?)?\s*[.!?]?$/i;
  if (simpleDeadline.test(text) || namedDeadline.test(text) || referencedGoalDeadline.test(text)) return true;
  if (/\b(?:no savings|nothing saved|zero saved|saved zero|starting from zero|zero savings|0 savings)\b/i.test(text)) return true;
  return moneyIn(text).some(item => ['SAVINGS', 'CAPACITY', 'AMBIGUOUS', 'INVALID', 'UNSPECIFIED_FREQUENCY'].includes(item.role));
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
  // Explicit currency with an unknown suffix must never be truncated to an
  // apparently valid smaller rupee amount. E.g. ₹20m is NOT ₹20.
  const unsupportedCurrencyUnit = [...goalText(question).matchAll(
    /(?:₹|inr\b|rs\.?)\s*\d[\d,]*(?:\.\d+)?\s*(?:million|billion|bn)\b|(?:₹|inr\b|rs\.?)\s*\d[\d,]*(?:\.\d+)?([A-Za-z][A-Za-z0-9]*)/gi,
  )].some(match => !match[1] || !/^(?:k|l|cr|crs|cror|crors|crore|crores|lac|lacs|lakh|lakhs|thousand|thousands)$/i.test(match[1]));
  if (unsupportedCurrencyUnit) found.push({ amount: null, role: 'INVALID' });
  for (const match of goalText(question).matchAll(AMOUNT)) {
    const unit = String(match[2] || '').toLowerCase();
    const factor = /^cr/.test(unit) ? 10_000_000n
      : /^(?:l$|lakh|lac)/.test(unit) ? 100_000n
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
    // Recurring contributions are not an existing cash corpus.
    const monthlyBefore = /\b(?:monthly\s+(?:savings?|contributions?|capacity|budget)|(?:per|each|every)\s+month)(?:\s+(?:of|is|are|:))?\s*$/i.test(before);
    const monthlyAfter = /^\s*(?:\/\s*month\b|per\s+month\b|each\s+month\b|every\s+month\b|a\s+month\b|monthly\b|pm\b)/i.test(after);
    const savingsFlowBefore = /\b(?:(?:(?:i|we)\s+)?(?:can|could|will|would|plan\s+to|able\s+to|am|are|currently)\s+)?(?:save|saving|contribute|contributing|set\s+aside)\s*$|\b(?:can|could|able\s+to|plan\s+to)\s+invest\s*$/i.test(before);
    const recurring = (monthlyBefore || monthlyAfter) && (monthlyBefore || savingsFlowBefore);
    const unlabelledMonthlyAmount = (monthlyBefore || monthlyAfter) && !recurring;
    const statedSavedFlow = recurring && /\b(?:have|has|had)\s+saved\s*$|\bsaved\s*$/i.test(before);
    const recurringGoalBudget = recurring && /\b(?:goal|target|need|require|want)\s*(?:is|of|to\s+be)?\s*$/i.test(before);
    // "I can save ₹50k" does not establish ₹50k PER MONTH or an existing
    // ₹50k balance. A cadence must be supplied before comparing affordability.
    const unspecifiedFrequency = !monthlyBefore && !monthlyAfter
      && /\b(?:(?:i|we)\s+)?(?:can|could|will|would|plan\s+to|able\s+to)\s+(?:save|invest|contribute|set\s+aside)\s*$/i.test(before);
    const ambiguousSaving = !recurring && /\b(?:am|are|been|currently)?\s*saving\s*$|\b(?:i|we)\s+save\s*$/i.test(before);
    const savings = !recurring && !unspecifiedFrequency && !targetCue && (/(?:already\s+)?(?:have\s+saved|have\s+put\s+aside|currently\s+saving|saving|saved|saved\s+up|earmarked|set\s+aside|accumulated|existing\s+savings|savings(?:\s+(?:of|are|is))?|starting\s+(?:with|from))\s*(?:up\s+to\s*)?(?:₹\s*|(?:rs\.?|inr)\s*)?$/i.test(before)
      || /^\s*(?:already\s+saved|saved(?:\s+already)?|earmarked|in\s+savings|as\s+savings|in\s+(?:my|our)\s+savings|set\s+aside)\b/i.test(after));
    // A planned payment *for an explicitly named goal* is a target, while a
    // rent/loan/EMI payment remains an outflow. Without this distinction,
    // "I need to pay ₹2 crore for my daughter's wedding" silently loses its target.
    const namedGoalPayment = /\b(?:need|want|plan|planning|must|will|would)\s+(?:to\s+)?pay\s*$/i.test(before)
      && /\b(?:for|toward(?:s)?)\s+(?:(?:my|our|the|a)\s+)?(?:daughter(?:'s)?|son(?:'s)?|child(?:'s)?|wedding|marriage|education|college|home|house|vehicle|car|retirement|medical|hospital)\b/i.test(after)
      && !/\b(?:emi|loan|rent|mortgage|debt|premium|bills?)\b/i.test(after);
    const unrelated = !savings && !namedGoalPayment && (/\b(?:salary|income|earn(?:ings)?|wages?|paycheck|take[ -]?home|emi|rent|debt|loan|expenses?|spend(?:ing)?|pay(?:ing|ments?)?|paid|borrow(?:ing)?|bills?|groceries|premium)\s*(?:of|is|are|:)?\s*(?:₹\s*|(?:rs\.?|inr)\s*)?$/i.test(before)
      || /^\s*(?:salary|income|wages?|paycheck|emi|rent|loan|in\s+debt|as\s+(?:emi|debt|loan|mortgage|expenses?))\b/i.test(after));
    const capacity = !savings && !unrelated && (recurring
      || /(?:monthly\s+(?:saving|contribution|capacity|budget)|per\s+month|each\s+month)\s*(?:of\s*)?(?:₹\s*|(?:rs\.?|inr)\s*)?$/i.test(before)
      || /^\s*(?:per\s+month|each\s+month|monthly|\/month|a\s+month|pm\b)\b/i.test(after));
    const ambiguousHolding = !savings && !capacity && !unrelated
      && /\b(?:i|we)\s+(?:(?:already|currently)\s+)?have(?:\s+(?:already|currently))?\s*(?:₹\s*|(?:rs\.?|inr)\s*)?$/i.test(before)
      && !/^\s*(?:as\s+(?:my|our|the)\s+(?:target|goal)|(?:for|towards)\s+(?:my|our|the)\s+goal)\b/i.test(after);
    found.push({ amount, role: (statedSavedFlow || recurringGoalBudget) ? 'INVALID'
      : unspecifiedFrequency ? 'UNSPECIFIED_FREQUENCY'
      : unlabelledMonthlyAmount && !unrelated ? 'AMBIGUOUS'
      : ambiguousSaving ? 'AMBIGUOUS'
        : savings ? 'SAVINGS' : capacity ? 'CAPACITY'
          : unrelated ? 'OTHER' : ambiguousHolding ? 'AMBIGUOUS' : 'TARGET' });
  }
  return found;
}

// The same canonical paise arithmetic is reused when generating and validating
// financial claims. No binary floating-point ceiling can add or lose a paisa.
export function calculateGoalMonthlyBaseline(target, savings, months) {
  if (!Number.isSafeInteger(months) || months < 1 || months > 600
      || !Number.isFinite(target) || !Number.isFinite(savings)
      || target <= 0 || savings < 0 || savings > target) return null;
  // Do not multiply money by 100 in binary floating point. For example,
  // valid high-value inputs with two decimal places can produce paise values
  // off by >0.0001 due solely to IEEE-754 representation and be rejected.
  // The shortest-roundtrip decimal string preserves the user's exact paise.
  const exactPaise = value => {
    const match = String(value).match(/^(\d+)(?:\.(\d{1,2}))?$/);
    if (!match) return null;
    const result = BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0') || '0');
    return result <= BigInt(Number.MAX_SAFE_INTEGER) ? result : null;
  };
  const targetPaise = exactPaise(target);
  const savingsPaise = exactPaise(savings);
  if (targetPaise === null || savingsPaise === null) return null;
  const remainingPaise = targetPaise - savingsPaise;
  return Number((remainingPaise + BigInt(months) - 1n) / BigInt(months)) / 100;
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

function namedGoalTopics(text) {
  const topics = [];
  if (/\b(?:marriage|wedding|ceremony)\b/i.test(text)) topics.push('WEDDING');
  if (/\b(?:college|university|education|study|school|tuition)\b/i.test(text)) topics.push('EDUCATION');
  if (/\b(?:medical|hospital|healthcare)\b/i.test(text)) topics.push('HEALTH');
  if (/\b(?:home|house|property|down payment)\b/i.test(text)) topics.push('HOME');
  if (/\b(?:car|vehicle)\b/i.test(text)) topics.push('VEHICLE');
  if (/\b(?:travel|vacation|trip)\b/i.test(text)) topics.push('TRAVEL');
  if (/\b(?:startup|business)\b/i.test(text)) topics.push('BUSINESS');
  if (/\bretirement\b/i.test(text)) topics.push('RETIREMENT');
  if (/\bemergency fund\b/i.test(text)) topics.push('EMERGENCY');
  return topics;
}

export function retrieveChatGoalPlanningEvidence(question, { priorUserTurns = [] } = {}) {
  const text = goalText(question);
  const past = goalScopedUserTurns(priorUserTurns);
  const direct = isFinancialGoalPlanningQuestion(text);
  // A repeated goal label with only a savings-flow update is not a new target.
  // Walk backward within the latest same-topic goal segment so subsequent
  // follow-ups can still access the original trusted target, never another goal.
  const latestNamedIndex = past.findLastIndex(isFinancialGoalPlanningQuestion);
  let previousGoalIndex = latestNamedIndex;
  if (latestNamedIndex >= 0) {
    const latestTopics = namedGoalTopics(past[latestNamedIndex]);
    if (latestTopics.length === 1 && !moneyIn(past[latestNamedIndex]).some(item => item.role === 'TARGET')) {
      for (let index = latestNamedIndex - 1; index >= 0; index -= 1) {
        const topics = namedGoalTopics(past[index]);
        if (topics.length > 0 && (topics.length !== 1 || topics[0] !== latestTopics[0])) break;
        if (isFinancialGoalPlanningQuestion(past[index])
            && moneyIn(past[index]).some(item => item.role === 'TARGET')) {
          previousGoalIndex = index;
          break;
        }
      }
    }
  }
  if (!direct && (previousGoalIndex < 0 || !isGoalPlanningFollowUp(text))) return [];
  // A later, distinctly named goal must never reuse an older goal's corpus.
  const questionTopics = namedGoalTopics(text);
  const priorTopics = previousGoalIndex >= 0 ? namedGoalTopics(past[previousGoalIndex]) : [];
  if (!direct && questionTopics.length > 0
      && (questionTopics.length !== 1 || priorTopics.length !== 1
        || questionTopics[0] !== priorTopics[0])) return [];

  // A new named goal must not inherit amounts from an unrelated older goal.
  // A follow-up that explicitly repeats the SAME named goal must not lose
  // its previously stated target and horizon just because it mentions "wedding".
  // New targets or distinct goals start a new scope; only verified user turns
  // can provide the carried inputs.
  const sameNamedGoal = previousGoalIndex >= 0
    && questionTopics.length === 1 && priorTopics.length === 1
    && questionTopics[0] === priorTopics[0];
  const continuation = sameNamedGoal && isGoalPlanningFollowUp(text)
    && !moneyIn(text).some(item => item.role === 'TARGET');
  const reset = direct && !continuation;
  const used = reset ? [text] : [...past.slice(previousGoalIndex), text];
  const source = reset ? text : past[previousGoalIndex];
  let target = null;
  let saved = null;
  let horizon = null;
  let monthlyCapacity = null;
  let ambiguousTarget = false;
  let ambiguousHorizon = false;
  let invalidAmount = false;
  let contradictorySavings = false;
  let unspecifiedFrequency = false;
  let declaredAnnualReturn = null;
  let declaredAnnualInflation = null;
  let conflictingRates = false;
  let targetIsPresentCost = false;
  let unsupportedNetModel = false;
  for (const turn of used) {
    // Numbers echoed in calculation questions never rewrite the user's target.
    const amounts = isGoalCalculationFollowUp(turn) ? [] : moneyIn(turn);
    if (isTargetPresentCost(turn)) targetIsPresentCost = true;
    if (/\b(?:after[- ]tax|post[- ]tax|net\s+(?:returns?|of\s+(?:tax|fees?))|expense ratio|fees?\s+(?:of|at|included|deducted)|tax\s+adjusted)\b/i.test(turn)) unsupportedNetModel = true;
    const rateMentions = goalRateMentions(turn);
    for (const kind of ['RETURN', 'INFLATION']) {
      const rates = rateMentions.filter(item => item.kind === kind).map(item => item.rate);
      if (rates.length > 1 && new Set(rates).size > 1) conflictingRates = true;
      if (rates.length) {
        if (kind === 'RETURN') declaredAnnualReturn = rates[rates.length - 1];
        else declaredAnnualInflation = rates[rates.length - 1];
      }
    }
    if (rateMentions.some(item => item.kind === 'INVALID')) conflictingRates = true;
    if (amounts.some(item => item.role === 'INVALID' || item.role === 'AMBIGUOUS')) invalidAmount = true;
    if (amounts.some(item => item.role === 'UNSPECIFIED_FREQUENCY')) unspecifiedFrequency = true;
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
  if (unsupportedNetModel) guidance += ' A net-of-tax or fee-adjusted SIP cannot be calculated from gross annual-return inputs alone. Confirm the exact net-return convention and applicable tax/fee facts; no net scenario is presented.';
  if (conflictingRates) guidance += ' Conflicting annual-rate assumptions were supplied; give one investment return rate and one inflation rate before using a growth scenario.';
  if (declaredAnnualInflation !== null && !targetIsPresentCost) guidance += ' You supplied an inflation rate, but the goal target is not clearly stated in today’s rupees. Confirm whether the target is a present-day cost or already the amount needed at the deadline; I will not inflate it twice.';
  if (unspecifiedFrequency) guidance += ' You mentioned a possible saving or contribution without a frequency. Please confirm whether that amount is monthly, a one-time contribution, or already earmarked before I compare affordability.';
  if (isGoalCalculationFollowUp(text) && target !== null && horizon !== null) {
    guidance += ' Calculation method: subtract confirmed earmarked savings from the goal target, divide the remainder by the deadline in whole months, then round each required monthly payment upward to the next paisa. This baseline assumes no investment growth.';
  }
  if (monthlyCapacity !== null && saved !== null && horizon !== null && target !== null && saved < target) {
    const required = calculateGoalMonthlyBaseline(target, saved, horizon);
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
    const baseline = calculateGoalMonthlyBaseline(target, scenarioSavings, horizon);
    if (baseline !== null && baseline > 0) entries.push({
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
  // This optional growth scenario uses user-supplied rates only. The exact
  // zero-growth obligation remains visible independently as a safety baseline.
  // An inflation rate without a present-day target is not safe to apply.
  if (target !== null && horizon !== null && !invalidAmount && !conflictingRates
      && !unsupportedNetModel
      && (declaredAnnualReturn !== null || declaredAnnualInflation !== null)
      && (declaredAnnualInflation === null || targetIsPresentCost)) {
    const scenarioSavings = saved === null ? 0 : saved;
    const scenario = calculateGoalCompoundingScenario({
      target, earmarkedSavings: scenarioSavings, months: horizon,
      annualReturnPercent: declaredAnnualReturn === null ? '0' : declaredAnnualReturn,
      annualInflationPercent: declaredAnnualInflation,
      targetIsPresentValue: targetIsPresentCost,
    });
    if (scenario) {
      const assumptionText = 'using ' + (declaredAnnualReturn === null
        ? 'zero investment growth' : 'your stated ' + declaredAnnualReturn + '% effective annual investment return')
        + (declaredAnnualInflation === null ? ' and no modeled inflation'
          : ', your stated ' + declaredAnnualInflation + '% effective annual inflation on a current-price target')
        + '. Existing earmarked savings are held constant; investments are made at month-end. Before taxes, fees and uncertainty.';
      entries.push({
        id: 'E_GOAL_RETURN_SCENARIO', kind: 'GOAL_CALCULATION',
        value: {
          monthlyRequiredAmount: scenario.requiredMonthlyContribution,
          inflationAdjustedTargetAmount: scenario.inflatedTarget,
          targetAmount: target, earmarkedSavingsAmount: scenarioSavings,
          horizonMonths: horizon,
          annualReturnPercent: scenario.annualReturnPercent,
          annualInflationPercent: scenario.annualInflationPercent,
          targetIsPresentCost, scenario: saved === null ? 'ZERO_START_CONDITIONAL' : 'DECLARED_SAVINGS',
          rateConvention: scenario.rateConvention, monthlyPaymentTiming: scenario.monthlyPaymentTiming,
          savedBalanceGrowth: scenario.savedBalanceGrowth, illustrativeOnly: true, beforeTax: true,
          sourceScope: scope,
        },
        displayValue: 'Illustrative monthly goal payment: ' + INR(scenario.requiredMonthlyContribution)
          + ' per month, not a forecast. ' + assumptionText,
        dataClass: 'DETERMINISTIC_USER_ASSUMPTION_SCENARIO',
        source: null, observedAt: null, freshness: null, authority: 'WEALTHGENIE_BACKEND',
      });
      if (declaredAnnualInflation !== null) {
        entries.push({
          id: 'E_GOAL_INFLATED_TARGET', kind: 'GOAL_CALCULATION',
          value: {
            inflatedTargetAmount: scenario.inflatedTarget, originalTargetAmount: target,
            earmarkedSavingsAmount: scenarioSavings, horizonMonths: horizon,
            annualReturnPercent: scenario.annualReturnPercent,
            annualInflationPercent: scenario.annualInflationPercent,
            targetIsPresentCost: true,
            sourceScope: scope, illustrativeOnly: true, beforeTax: true,
          },
          displayValue: 'Inflation-adjusted goal target: ' + INR(scenario.inflatedTarget)
            + ' from your present-day target using your explicitly stated inflation assumption; not a verified cost forecast.',
          dataClass: 'DETERMINISTIC_USER_INFLATION_SCENARIO',
          source: null, observedAt: null, freshness: null, authority: 'WEALTHGENIE_BACKEND',
        });
      }
      guidance += ' I can also show an illustrative monthly goal payment based on your stated rate assumptions; that is not a prediction or verified market rate.';
    } else {
      guidance += ' The growth assumptions are outside the supported exact calculation range or are contradictory; no return-based amount was calculated.';
    }
  }
  return entries;
}
