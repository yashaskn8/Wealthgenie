/**
 * Navigation Architecture & URL State Resolver
 * Single source of truth for WealthGenie beginner navigation.
 */

export const NAV_PAGES = {
  HOME: 'home',
  PLAN: 'plan',
  INVESTMENTS: 'investments',
  TAXES: 'taxes',
  PROGRESS: 'progress', // Existing mobile Progress hub remains unchanged.
  GOALS: 'goals',
  GROW_MY_SIP: 'grow-my-sip',
  KEEP_ON_TRACK: 'keep-on-track',
  GENIEPROOF: 'genieproof',
  RUNWAY: 'runway',
  ACCOUNT: 'account',
  HELP: 'help',
};

export const PAGE_ALLOWLIST = [
  NAV_PAGES.HOME,
  NAV_PAGES.PLAN,
  NAV_PAGES.INVESTMENTS,
  NAV_PAGES.TAXES,
  NAV_PAGES.PROGRESS,
  NAV_PAGES.GOALS,
  NAV_PAGES.GROW_MY_SIP,
  NAV_PAGES.KEEP_ON_TRACK,
  NAV_PAGES.GENIEPROOF,
  NAV_PAGES.RUNWAY,
  NAV_PAGES.ACCOUNT,
  NAV_PAGES.HELP,
];

export const DESKTOP_PROGRESS_DESTINATIONS = Object.freeze({
  goals: NAV_PAGES.GOALS,
  'grow-sip': NAV_PAGES.GROW_MY_SIP,
  rebalancer: NAV_PAGES.KEEP_ON_TRACK,
});
export const HUB_TABS = {
  [NAV_PAGES.TAXES]: {
    default: 'regime-savings',
    allowed: ['regime-savings', 'real-returns'],
  },
  [NAV_PAGES.PROGRESS]: {
    default: 'goals',
    allowed: ['goals', 'grow-sip', 'rebalancer'],
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
  'goals':           { page: NAV_PAGES.GOALS,       tab: null },
  'my-goals':        { page: NAV_PAGES.GOALS,       tab: null },
  'plan-a-goal':     { page: NAV_PAGES.GOALS,       tab: null },
  'goal-planner':    { page: NAV_PAGES.GOALS,       tab: null },
  'financial-indicators': { page: NAV_PAGES.HOME,  tab: null },
  'health':          { page: NAV_PAGES.HOME,       tab: null },
  'sip-planner':     { page: NAV_PAGES.GROW_MY_SIP, tab: null },
  'rebalancer':      { page: NAV_PAGES.PROGRESS,    tab: 'rebalancer' },
  'compare':         { page: NAV_PAGES.HOME,        tab: null },
  'insights':        { page: NAV_PAGES.HOME,        tab: null },
  'diagnostics':     { page: NAV_PAGES.HOME,        tab: null },
  'genieproof':      { page: NAV_PAGES.GENIEPROOF,  tab: null },
  'runway':          { page: NAV_PAGES.RUNWAY,      tab: null },
  'profile':         { page: NAV_PAGES.ACCOUNT,     tab: null },
  'account':         { page: NAV_PAGES.ACCOUNT,     tab: null },
  'help':            { page: NAV_PAGES.HELP,        tab: null },
};

/**
 * Normalizes a page and tab to safe, allowlisted values.
 * Returns { page, tab, isNormalized: boolean }
 */
export function normalizeNavigation(rawPage, rawTab, { allowGenieProof = false, allowRunway = false } = {}) {
  let page = rawPage;
  let tab = rawTab;

  // The old Advanced URL is retained only as a gated entry point for GenieProof.
  // All other retired Advanced URLs normalize to Home.
  if (page === 'advanced') {
    page = allowGenieProof && tab === 'genieproof' ? NAV_PAGES.GENIEPROOF : NAV_PAGES.HOME;
    tab = null;
  }

  // Resolve legacy aliases first if rawPage is a legacy identifier
  if (LEGACY_NAV_MAP[page]) {
    const legacy = LEGACY_NAV_MAP[page];
    page = legacy.page;
    if (!tab) {
      tab = legacy.tab;
    }
  }

  if (page === NAV_PAGES.GENIEPROOF && !allowGenieProof) {
    page = NAV_PAGES.HOME;
    tab = null;
  }

  if (page === NAV_PAGES.RUNWAY && !allowRunway) {
    page = NAV_PAGES.HOME;
    tab = null;
  }

  // Validate page against allowlist
  if (!PAGE_ALLOWLIST.includes(page)) {
    page = NAV_PAGES.HOME;
    tab = null;
  }

  // Removed Progress views are mapped to the single retained Goals workflow.
  if (page === NAV_PAGES.PROGRESS && (tab === 'indicators' || tab === 'plan-goal')) tab = 'goals';

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
export function resolveNavigation(target, explicitTab = undefined, options = {}) {
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

  const { page, tab } = normalizeNavigation(requestedPage, requestedTab, options);
  return { page, tab };
}

/**
 * Extracts normalized navigation state from URLSearchParams
 */
export function fromSearchParams(searchParams, options = {}) {
  const rawPage = searchParams.get('page');
  const rawTab = searchParams.get('tab');
  const { page, tab, isNormalized } = normalizeNavigation(rawPage, rawTab, options);

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
