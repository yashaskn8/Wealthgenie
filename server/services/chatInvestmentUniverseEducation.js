/**
 * Read-only educational lookup over WealthGenie's 250 discovery *archetypes*.
 * The legacy 155 entries and 95 extensions are NOT 250 current, available
 * purchase recommendations. Never repeat static returns/rates/tax/eligibility.
 * Official links below support general investor-education principles only,
 * not assertions about a specific fund, issuer or security.
 */
import { readFileSync } from 'node:fs';
import { investmentDatabase } from '../data/investmentDatabase.js';

const extensions = JSON.parse(readFileSync(
  new URL('../data/investmentUniverseExtensions2026.json', import.meta.url), 'utf8',
)).entries;

export const INVESTMENT_UNIVERSE_EDUCATION_VERSION = 'universe-education-1.0.0';
const ADVICE_URL = 'https://investor.sebi.gov.in/investment-thingsbeforeinv.html';
const RISK_URL = 'https://www.nism.ac.in/how-to-manage-investment-risks-2/';
const TOPIC = /\b(?:invest(?:ing|ment|ments)?|product|instrument|option|fund|scheme|portfolio|risk|liquid(?:ity)?|lock.?in|return|compare|versus|vs|explain|meaning|about|what\s+is|how\s+does|should\s+i|category|catalog(?:ue)?)\b/i;
// Require an actual catalog overview request. Merely naming the "Smallcap 250"
// index must never resolve to the generic list of 250 archetypes.
const CATALOG_SCOPE = /(?:\b(?:list|show|browse|explore)\s+(?:me\s+)?(?:all\s+)?(?:the\s+)?(?:250|all)\s+(?:indian\s+)?investment\s+(?:options?|products?|instruments?)\b|\bhow\s+many\s+investment\s+(?:options?|products?|instruments?)\b|\b(?:wealthgenie\s+)?investment\s+(?:catalog(?:ue)?|universe)\b|\b250\s+investment\s+(?:options?|entries|products?|instruments?)\b)/i;
const ADVICE_CONSTRAINTS = /\b(?:guarantee(?:d)?|best|top|highest|recommend|buy|sell|allocate|split|percentage|%|interest|tax|nav|yield|expense\s+ratio|price|returns?|maturity|lock.?in|payout|risk(?:\s+score)?)\b/i;

function norm(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
const raw = [
  ...investmentDatabase.map(item => ({ id: item.id, name: item.name, category: item.category,
    discoveredOnly: true, sourceKind: 'LEGACY_CATALOG_UNVERIFIED' })),
  ...extensions.map(item => ({ id: item.id, name: item.name, category: item.category,
    discoveredOnly: true, sourceKind: 'CATEGORY_ARCHETYPE_UNVERIFIED' })),
];
const seenIds = new Set();
const seenNames = new Set();
for (const item of raw) {
  const canonicalName = norm(item.name);
  if (!/^[a-z0-9_-]{1,140}$/i.test(item.id) || canonicalName.length < 3
      || seenIds.has(item.id) || seenNames.has(canonicalName)) {
    throw new Error('INVALID_INVESTMENT_UNIVERSE_EDUCATION_CATALOG');
  }
  seenIds.add(item.id); seenNames.add(canonicalName);
}
if (raw.length !== 250 || investmentDatabase.length !== 155 || extensions.length !== 95) {
  throw new Error('INVESTMENT_UNIVERSE_EDUCATION_COUNT_CHANGED_REVIEW_REQUIRED');
}

const CATALOG = Object.freeze(raw.map(item => Object.freeze({
  ...item, normalizedName: norm(item.name),
})));

export function listInvestmentUniverseEducationEntries() {
  return CATALOG.map(({ id, name, category, sourceKind }) => ({
    id, name, category, sourceKind,
    availabilityVerified: false, investmentTermsVerified: false,
    suitableForInvestor: null,
  }));
}

function evidence(id, explanation, title = 'WealthGenie discovery catalog', url = null) {
  return {
    id, kind: 'EDUCATION',
    value: { educationalOnly: true, productRecommendation: false,
      currentProductFactsVerified: false, datasetVersion: INVESTMENT_UNIVERSE_EDUCATION_VERSION },
    displayValue: explanation,
    dataClass: url ? 'CURATED_PUBLIC_EDUCATION' : 'INTERNAL_CATALOG_DISCOVERY',
    source: { provider: url === RISK_URL ? 'NISM' : url === ADVICE_URL ? 'SEBI_INVESTOR' : 'WEALTHGENIE_CATALOG', title, url,
      publicationDate: null, instrumentId: null },
    observedAt: null, freshness: null,
    authority: url ? 'PUBLIC_EDUCATIONAL_SOURCE' : 'WEALTHGENIE_BACKEND',
  };
}

export function isInvestmentUniverseEducationQuestion(question) {
  const text = String(question || '').slice(0, 1000);
  if (!text.trim()) return false;
  if (CATALOG_SCOPE.test(text)) return true;
  if (!TOPIC.test(text)) return false;
  const q = ' ' + norm(text) + ' ';
  return CATALOG.some(item => q.includes(' ' + item.normalizedName + ' '));
}

export function retrieveInvestmentUniverseEducation(question, { maxEntries = 2 } = {}) {
  const text = String(question || '').slice(0, 1000);
  const limit = Number.isSafeInteger(maxEntries) ? Math.max(0, Math.min(2, maxEntries)) : 2;
  if (!limit) return [];
  if (CATALOG_SCOPE.test(text)) {
    return [evidence('E_EDU_UNIVERSE_SCOPE',
      'WealthGenie lists 250 Indian investment discovery entries: 155 legacy catalog entries and 95 newer regulatory-category or index archetypes. These are not 250 verified purchasable products. Entries require independent current checks for actual availability, investor eligibility, cost, liquidity, tax treatment, and suitability. For a meaningful comparison, provide the goal deadline and the names of the options.')];
  }
  if (!isInvestmentUniverseEducationQuestion(text)) return [];
  const words = ' ' + norm(text) + ' ';
  const matches = CATALOG.filter(item => words.includes(' ' + item.normalizedName + ' '))
    .sort((a, b) => b.normalizedName.length - a.normalizedName.length || a.id.localeCompare(b.id));
  // If a longer product/category name contains a shorter label, do not
  // misrepresent it as two independently selected items.
  const chosen = [];
  for (const item of matches) {
    if (chosen.some(other => other.normalizedName.includes(item.normalizedName))) continue;
    chosen.push(item);
    if (chosen.length === limit) break;
  }
  return chosen.map(item => {
    const suffix = item.id.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    const caution = ADVICE_CONSTRAINTS.test(text)
      ? ' This catalog does not verify a current rate, return, price, lock-in, tax outcome, or that this option is suitable for the investor.'
      : '';
    return evidence('E_EDU_CATALOG_' + suffix,
      item.name + ' is listed as a ' + item.category
      + ' discovery entry in WealthGenie, not a verified available security or personal recommendation.'
      + ' When evaluating this category, compare the goal horizon, ability to bear losses, liquidity, diversification, costs and current issuer documentation.'
      + caution);
  });
}

/**
 * Goal-horizon education complements the separate deterministic funding math.
 * No portfolio percentages, product returns or personal suitability inferred.
 */
export function retrieveGoalHorizonEducation(question, goalEntries = []) {
  if (!Array.isArray(goalEntries) || !goalEntries.some(x => x.id === 'E_GOAL_PLANNING_GUIDANCE')) return [];
  const months = goalEntries.find(x => x.id === 'E_GOAL_MONTHLY_BASELINE')?.value?.horizonMonths
    ?? goalEntries.find(x => x.id === 'E_GOAL_RETURN_SCENARIO')?.value?.horizonMonths
    ?? null;
  let detail;
  if (months === null) {
    detail = 'For a wedding, education, home or other time-bound goal, first establish when the expense is due, whether the stated amount is the future target or money already available, the budget buffer, and loss tolerance. Without a deadline, a particular investment mix cannot responsibly be selected.';
  } else if (months <= 36) {
    detail = 'For a goal due within three years, access to money and limiting loss near the payment date are especially important. Compare accessible deposit or cash-equivalent categories and their actual terms; volatile equity investments may be unsuitable for a near-term fixed expense.';
  } else if (months <= 84) {
    detail = 'For a three-to-seven-year goal, weigh liquidity needs and capacity for losses before considering a mixture of lower-volatility and growth-oriented categories. Avoid assuming a recovery from a market fall will occur before the payment deadline.';
  } else {
    detail = 'For a goal more than seven years away, a longer horizon may permit considering diversified growth-oriented categories, subject to risk capacity; as the payment approaches, assess reducing volatility and ensuring funds are available when required.';
  }
  return [evidence('E_EDU_GOAL_HORIZON',
    detail + ' None of these are individual product recommendations, promised returns or an allocation; first check eligibility, current terms, taxation, and emergency reserves.',
    'How to manage investment risks', RISK_URL)];
}
