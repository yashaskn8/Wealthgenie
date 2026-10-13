const STRICT_FINANCIAL_DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Reject absence and malformed values before numeric coercion can turn them into zero. */
export function isPresentFiniteFinancialNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length > 0
    && STRICT_FINANCIAL_DECIMAL.test(trimmed)
    && Number.isFinite(Number(trimmed));
}

export function toOptionalFinancialNumber(value) {
  return isPresentFiniteFinancialNumber(value) ? Number(value) : null;
}
