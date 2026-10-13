export function isPresentFiniteNumber(value) {
  if (!['number', 'string'].includes(typeof value)) return false;
  if (value === null || value === undefined || value === '') return false;
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)) return false;
  }
  return Number.isFinite(Number(value));
}

export function toOptionalNumber(value) {
  return isPresentFiniteNumber(value) ? Number(value) : undefined;
}
