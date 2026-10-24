/** Exact decimal precision for explicitly reviewed nominal return percentages. */
export function validSovereignAnnualAssumptionPct(value) {
  return typeof value === 'number' && Number.isFinite(value) &&
    value >= 0.1 && value <= 30 &&
    /^\\d+(?:\\.\\d{1,3})?$/.test(String(value));
}
