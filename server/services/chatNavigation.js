// In-app destinations only. These instructions describe navigation, not financial advice.
const DESTINATIONS = Object.freeze([
  { pattern: /\b(?:tax(?:es)?|regime|deductions?|post[ -]?tax)\b/i, taskPattern: /\b(?:tax optimizer|tax regime|deduction breakdown|post[ -]?tax|tax assumptions?)\b/i, page: 'taxes', label: 'Taxes', instruction: 'Open Taxes to enter the required tax details and review the backend calculation.' },
  { pattern: /\b(?:goals?|retirement target)\b/i, taskPattern: /\b(?:my goal|goal planning|retirement goal|goal funding)\b/i, page: 'goals', label: 'Goals', instruction: 'Open Goals to create or review a savings target.' },
  { pattern: /\b(?:sip|step[ -]?up)\b/i, taskPattern: /\b(?:sip|step[ -]?up|grow my sip)\b/i, page: 'grow-my-sip', label: 'Grow My SIP', instruction: 'Open Grow My SIP to explore contribution planning.' },
  { pattern: /\b(?:rebalanc|keep on track)\w*/i, taskPattern: /\b(?:rebalanc|portfolio balancing|keep on track)\w*/i, page: 'keep-on-track', label: 'Keep on Track', instruction: 'Open Keep on Track to review your plan and rebalancing workflow.' },
  { pattern: /\b(?:compare investments|investment options|where to invest|verified options|find a fund)\b/i, taskPattern: /\b(?:where to invest|investment options|find (?:a )?fund|verified options)\b/i, page: 'investments', label: 'Where to Invest', instruction: 'Open Where to Invest to inspect the categories in your plan and any source-verified options.' },
  { pattern: /\b(?:profile|account details)\b/i, taskPattern: /\b(?:my profile|account details)\b/i, page: 'account', label: 'My Profile', instruction: 'Open My Profile to review your saved financial profile.' },
  { pattern: /\b(?:portfolio|allocation|my plan|recommendation)\b/i, taskPattern: /\b(?:review my portfolio|my saved plan|my recommendation|my allocation|my investment plan)\b/i, page: 'plan', label: 'My Plan', instruction: 'Open My Plan to review your saved recommendation and category allocations.' },
]);

const NAVIGATION_INTENT = /\b(?:where (?:can|do) i (?:find|see|open|review)|how (?:can|do) i (?:find|open|reach|get to)|(?:open|go to|take me to|navigate to|help me find|help me navigate to))\b/i;
const ALLOWED_DESTINATIONS = new Set(DESTINATIONS.map(item => item.page));

export function getChatNavigationDestination(question) {
  if (typeof question !== 'string') return null;
  const explicitRequest = NAVIGATION_INTENT.test(question);
  const destination = DESTINATIONS.find(item => item.pattern.test(question)
    && (explicitRequest || item.taskPattern?.test(question)));
  return destination ? Object.freeze({
    page: destination.page,
    label: destination.label,
    instruction: destination.instruction,
    explicitRequest,
  }) : null;
}

export function buildChatNavigationActionCard({ validationStatus, destinationEvidence }) {
  if (validationStatus !== 'PASS'
      || destinationEvidence?.id !== 'E_APP_NAVIGATION'
      || destinationEvidence?.kind !== 'APP_NAVIGATION'
      || destinationEvidence?.dataClass !== 'APP_ROUTE'
      || !ALLOWED_DESTINATIONS.has(destinationEvidence.value?.page)) return [];
  const labels = new Map(DESTINATIONS.map(item => [item.page, item.label]));
  return [{
    kind: 'APP_NAVIGATION',
    label: `Open ${labels.get(destinationEvidence.value.page)}`,
    target: destinationEvidence.value.page,
  }];
}
