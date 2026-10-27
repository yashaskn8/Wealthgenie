export const MINIMUM_USEFUL_PRODUCTS = 2;
export const MAXIMUM_DISPLAYED_PRODUCTS = 3;

// Database qualification is only a candidate count. Investor suitability is a
// separate gate, and a Top 3 surface must never pad a one-product result.
export function summarizeTopThreeCoverage(rows, at = new Date().toISOString()) {
  if (!Array.isArray(rows)) throw new TypeError('Coverage rows must be an array.');
  const deficits = rows.map(row => {
    const rawCount = row.potentially_qualified;
    const validShape = typeof rawCount === 'number'
      || (typeof rawCount === 'string' && /^\d+$/.test(rawCount));
    const potentialProducts = Number(rawCount);
    if (!validShape || !Number.isSafeInteger(potentialProducts) || potentialProducts < 0) {
      throw new TypeError('Qualified product count must be a nonnegative integer.');
    }
    return {
      familyId: row.id,
      name: row.name,
      category: row.category,
      potentialProducts,
      slotsMissing: Math.max(0, MINIMUM_USEFUL_PRODUCTS - potentialProducts),
      topThreeSlotsOpen: Math.max(0, MAXIMUM_DISPLAYED_PRODUCTS - potentialProducts),
    };
  });
  return {
    status: 'EVIDENCE_MEASURED_NOT_INFERRED',
    at,
    families: rows.length,
    minimumUsefulProducts: MINIMUM_USEFUL_PRODUCTS,
    maximumDisplayedProducts: MAXIMUM_DISPLAYED_PRODUCTS,
    familiesWithTwoOrMorePotentialProducts: deficits.filter(item => item.slotsMissing === 0).length,
    familiesWithThreePotentialProducts: deficits.filter(item => item.topThreeSlotsOpen === 0).length,
    familiesWithFewerThanTwo: deficits.filter(item => item.slotsMissing > 0).length,
    familiesWithFewerThanThree: deficits.filter(item => item.topThreeSlotsOpen > 0).length,
    remainingMinimumSlots: deficits.reduce((n, item) => n + item.slotsMissing, 0),
    remainingTopThreeSlots: deficits.reduce((n, item) => n + item.topThreeSlotsOpen, 0),
    topThreeIsMaximumNotQuota: true,
    qualifiedForAnySpecificInvestor: 'NOT_ASSESSED',
    missingOrUnderfilledFamilies: deficits.filter(item => item.slotsMissing > 0),
  };
}
