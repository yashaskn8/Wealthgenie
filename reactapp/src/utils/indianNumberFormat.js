import { isPresentFiniteNumber } from './financialValues';

/**
 * Formats a number into Indian currency format with ₹ symbol.
 * Examples: 
 *   1234 -> "₹1,234"
 *   150000 -> "₹1,50,000"
 *   2500000 -> "₹25,00,000"
 */
export function formatINR(val) {
  if (!isPresentFiniteNumber(val)) return '—';
  const num = Number(val);
  // Guard against overflow / absurdly large numbers
  if (!isFinite(num)) return '—';
  const abs = Math.abs(num);
  const sign = num < 0 ? '-' : '';
  if (abs >= 1e15) return `${sign}₹999+ L Cr`;
  if (abs >= 1e12) return `${sign}₹${(abs / 1e12).toFixed(2)} L Cr`;   // Lakh Crore
  if (abs >= 1e10) return `${sign}₹${(abs / 1e10).toFixed(2)} K Cr`;   // Thousand Crore
  if (abs >= 10000000) {
    return `${sign}₹${(abs / 10000000).toFixed(2)} Cr`;
  } else if (abs >= 100000) {
    return `${sign}₹${(abs / 100000).toFixed(2)} L`;
  }
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(num);
}

/**
 * Formats a number into compact Indian notation.
 * 150000 -> "₹1.5L", 25000000 -> "₹2.5Cr"
 */
export function formatCompactINR(val) {
  if (!isPresentFiniteNumber(val)) return '—';
  const num = Number(val);
  if (!isFinite(num)) return '—';
  const abs = Math.abs(num);
  const sign = num < 0 ? '-' : '';
  if (abs >= 1e15) return `${sign}₹999+ L Cr`;
  if (abs >= 1e12) return `${sign}₹${(abs / 1e12).toFixed(1)} L Cr`;   // Lakh Crore
  if (abs >= 1e10) return `${sign}₹${(abs / 1e10).toFixed(1)} K Cr`;   // Thousand Crore
  if (abs >= 10000000) return `${sign}₹${(abs / 10000000).toFixed(1)} Cr`;
  if (abs >= 100000) return `${sign}₹${(abs / 100000).toFixed(1)} L`;
  if (abs >= 1000) return `${sign}₹${(abs / 1000).toFixed(1)} K`;
  return `${sign}₹${Math.round(abs)}`;
}

/**
 * Formats a percentage cleanly (e.g. 12.5 -> "12.5%", 12.0 -> "12%").
 */
export function formatPercent(val, decimals = 1) {
  if (!isPresentFiniteNumber(val)) return '—';
  const num = Number(val);
  if (!isFinite(num)) return '—';
  return `${Number.isInteger(num) ? num : num.toFixed(decimals)}%`;
}
