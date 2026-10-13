import { toOptionalNumber } from './financialValues';

const CATEGORY_EXPLANATIONS = Object.freeze({
  cash: 'Cash investments',
  sovereign: 'Sovereign instruments',
  equity: 'Equity investments',
  debt: 'Debt investments',
  government: 'Government savings instruments',
  'equity-debt': 'Equity and debt investments',
  commodity: 'Commodity investments',
  alternative: 'Alternative investments',
  gold: 'Gold investments',
});

export function formatCurrency(value) {
  const amount = toOptionalNumber(value);
  return amount === undefined ? 'Unavailable' : `₹${Math.round(amount).toLocaleString('en-IN')}`;
}

export function getCategoryDescription(item = {}) {
  const category = String(item.assetClass || item.cat || item.category || '').trim().toLowerCase();
  return CATEGORY_EXPLANATIONS[category] || 'Investment category';
}