export const BACKEND_TO_LOCAL_MAP = Object.freeze({
  Equity_MF: 'index_mf',
  ETF: 'nifty_etf',
  ELSS: 'elss',
  FD: 'fd',
  NPS: 'nps',
  RBI_Bond: 'rbi_bonds',
  Gold: 'gold_etf',
  SGB: 'sgb',
  Debt_MF: 'debt_mf',
  Liquid_MF: 'liquid_mf',
  Arbitrage_MF: 'arbitrage_mf',
  Hybrid_MF: 'hybrid_mf',
  Index_MF: 'index_mf',
  Midcap_MF: 'midcap_mf',
  Smallcap_MF: 'smallcap_mf',
  PPF: 'ppf',
  SCSS: 'scss',
  SSY: 'ssy',
  'G-Sec': 'g-sec',
});

export const LOCAL_TO_BACKEND_MAP = Object.freeze({
  equity_mf: 'Equity_MF',
  index_mf: 'Index_MF',
  nifty_etf: 'ETF',
  elss: 'ELSS',
  fd: 'FD',
  nps: 'NPS',
  rbi_bonds: 'RBI_Bond',
  gold_etf: 'Gold',
  sgb: 'SGB',
  debt_mf: 'Debt_MF',
  liquid_mf: 'Liquid_MF',
  arbitrage_mf: 'Arbitrage_MF',
  hybrid_mf: 'Hybrid_MF',
  midcap_mf: 'Midcap_MF',
  smallcap_mf: 'Smallcap_MF',
  ppf: 'PPF',
  scss: 'SCSS',
  ssy: 'SSY',
  sukanya: 'SSY',
  'g-sec': 'G-Sec',
});

export const OPTIMISABLE_BACKEND_KEYS = new Set([
  'Equity_MF', 'ELSS', 'ETF', 'Debt_MF', 'FD', 'Gold', 'NPS', 'PPF',
  'RBI_Bond', 'G-Sec', 'SGB', 'Liquid_MF', 'Arbitrage_MF', 'Hybrid_MF', 'Index_MF',
  'Midcap_MF', 'Smallcap_MF', 'SCSS', 'SSY',
]);

// Keep optimizer support aligned with server/services/portfolioEngine.js
// ASSET_KEYS and COVARIANCE_ALIAS. SCSS and SSY are explicit optimizer aliases;
// Monte Carlo can still report them unavailable because it requires ASSET_KEYS.
export const PORTFOLIO_OPTIMIZER_SUPPORTED_KEYS = new Set(OPTIMISABLE_BACKEND_KEYS);

export function backendToLocalInstrument(type) {
  if (!type) return null;
  return BACKEND_TO_LOCAL_MAP[type] || null;
}

export function localToBackendInstrument(id) {
  if (!id) return '';
  return LOCAL_TO_BACKEND_MAP[id] || String(id);
}

export function getOptimisableBackendKey(investment) {
  if (!investment || !investment.id) return null;
  const backendKey = localToBackendInstrument(investment.id);
  return OPTIMISABLE_BACKEND_KEYS.has(backendKey) ? backendKey : null;
}

export function assertKnownBackendInstrumentTypes(types, context = 'backend instruments') {
  const missing = Array.from(new Set((types || []).filter(Boolean)))
    .filter(type => !BACKEND_TO_LOCAL_MAP[type]);

  if (missing.length > 0) {
    throw new TypeError(`${context}: unknown backend instrument type(s): ${missing.join(', ')}`);
  }

  return missing;
}

