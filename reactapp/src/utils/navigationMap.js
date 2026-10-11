/**
 * Navigation Architecture & URL State Resolver
 * Single source of truth for WealthGenie beginner navigation.
 */

export const NAV_PAGES = {
  HOME: 'home',
  PLAN: 'plan',
  INVESTMENTS: 'investments',
  TAXES: 'taxes',
  PROGRESS: 'progress',
  ADVANCED: 'advanced',
  ACCOUNT: 'account',
  HELP: 'help',
};

export const PAGE_ALLOWLIST = [
  NAV_PAGES.HOME,
  NAV_PAGES.PLAN,
  NAV_PAGES.INVESTMENTS,
  NAV_PAGES.TAXES,
  NAV_PAGES.PROGRESS,
  NAV_PAGES.ADVANCED,
  NAV_PAGES.ACCOUNT,
  NAV_PAGES.HELP,
];

export const HUB_TABS = {
  [NAV_PAGES.TAXES]: {
    default: 'regime-savings',
    allowed: ['regime-savings', 'real-returns'],
  },
  [NAV_PAGES.PROGRESS]: {
    default: 'goals',
    allowed: ['goals', 'plan-goal', 'grow-sip', 'health', 'rebalancer'],
  },
  [NAV_PAGES.ADVANCED]: {
    default: 'comparison',
    allowed: ['comparison', 'insights', 'diagnostics', 'genieproof'],
  },
};

/**
 * Mapping of legacy activePage strings to canonical { page, tab }
 */
export const LEGACY_NAV_MAP = {
  'dashboard':       { page: NAV_PAGES.HOME,        tab: null },
  'allocation':      { page: NAV_PAGES.PLAN,        tab: null },
  'where-to-invest': { page: NAV_PAGES.INVESTMENTS, tab: null },
  'tax-optimizer':   { page: NAV_PAGES.TAXES,       tab: 'regime-savings' },
  'taxes':           { page: NAV_PAGES.TAXES,       tab: 'regime-savings' },
  'post-tax':        { page: NAV_PAGES.TAXES,       tab: 'real-returns' },
  'goals':           { page: NAV_PAGES.PROGRESS,    tab: 'goals' },
  'goal-planner':    { page: NAV_PAGES.PROGRESS,    tab: 'plan-goal' },
  'sip-planner':     { page: NAV_PAGES.PROGRESS,    tab: 'grow-sip' },
  'health':          { page: NAV_PAGES.PROGRESS,    tab: 'health' },
  'rebalancer':      { page: NAV_PAGES.PROGRESS,    tab: 'rebalancer' },
  'compare':         { page: NAV_PAGES.ADVANCED,    tab: 'comparison' },
  'insights':        { page: NAV_PAGES.ADVANCED,    tab: 'insights' },
  'diagnostics':     { page: NAV_PAGES.ADVANCED,    tab: 'diagnostics' },
  'profile':         { page: NAV_PAGES.ACCOUNT,     tab: null },
  'account':         { page: NAV_PAGES.ACCOUNT,     tab: null },
  'help':            { page: NAV_PAGES.HELP,        tab: null },
};

/**
 * Normalizes a page and tab to safe, allowlisted values.
 * Returns { page, tab, isNormalized: boolean }
 */
export function normalizeNavigation(rawPage, rawTab) {
  let page = rawPage;
  let tab = rawTab;

  // Resolve legacy aliases first if rawPage is a legacy identifier
  if (LEGACY_NAV_MAP[page]) {
    const legacy = LEGACY_NAV_MAP[page];
    page = legacy.page;
    if (!tab) {
      tab = legacy.tab;
    }
  }

  // Validate page against allowlist
  if (!PAGE_ALLOWLIST.includes(page)) {
    page = NAV_PAGES.HOME;
    tab = null;
  }

  // Handle tab constraints based on whether page is a hub
  const hubConfig = HUB_TABS[page];
  if (hubConfig) {
    if (!tab || !hubConfig.allowed.includes(tab)) {
      tab = hubConfig.default;
    }
  } else {
    // Non-hub pages MUST have tab === null (no leaking)
    tab = null;
  }

  const isNormalized = page !== rawPage || (tab ?? null) !== (rawTab ?? null);
  return { page, tab, isNormalized };
}

/**
 * Resolves any target (string or object) into a canonical { page, tab }
 * Note: Explicit tab: null MUST clear a previous tab and not leak it.
 */
export function resolveNavigation(target, explicitTab = undefined) {
  if (!target) {
    return { page: NAV_PAGES.HOME, tab: null };
  }

  let requestedPage;
  let requestedTab;

  if (typeof target === 'object') {
    requestedPage = target.page;
    requestedTab = target.tab !== undefined ? target.tab : null;
  } else if (LEGACY_NAV_MAP[target]) {
    const mapped = LEGACY_NAV_MAP[target];
    requestedPage = mapped.page;
    requestedTab = explicitTab !== undefined ? explicitTab : mapped.tab;
  } else {
    requestedPage = target;
    requestedTab = explicitTab !== undefined ? explicitTab : null;
  }

  const { page, tab } = normalizeNavigation(requestedPage, requestedTab);
  return { page, tab };
}

/**
 * Extracts normalized navigation state from URLSearchParams
 */
export function fromSearchParams(searchParams) {
  const rawPage = searchParams.get('page');
  const rawTab = searchParams.get('tab');
  const { page, tab, isNormalized } = normalizeNavigation(rawPage, rawTab);

  const needsReplace = isNormalized || !searchParams.has('page') || (searchParams.has('tab') && tab === null);
  return { page, tab, needsReplace };
}

/**
 * Converts { page, tab } to an object suitable for setSearchParams
 */
export function toSearchParams({ page, tab }) {
  const params = { page };
  if (tab) {
    params.tab = tab;
  }
  return params;
}
