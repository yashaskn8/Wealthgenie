export const MINIMUM_USEFUL_PRODUCTS = 2;
export const MAXIMUM_DISPLAYED_PRODUCTS = 3;

// Database qualification is only a candidate count. Investor suitability is a
// separate gate, and a Top 3 surface must never pad a one-product result.
export function summarizeTopThreeCoverage(rows, at = new Date().toISOString(), { expectedFamilyIds = null } = {}) {
  if (!Array.isArray(rows)) throw new TypeError('Coverage rows must be an array.');
  if (expectedFamilyIds !== null) {
    if (!Array.isArray(expectedFamilyIds) || expectedFamilyIds.length !== 250
      || expectedFamilyIds.some(id => typeof id !== 'string' || !id.trim())
      || new Set(expectedFamilyIds).size !== 250) {
      throw new TypeError('EXPECTED_250_FAMILY_IDS_INVALID');
    }
    const actual = new Set(rows.map(row => row?.id));
    const expected = new Set(expectedFamilyIds);
    if (rows.length !== 250 || actual.size !== 250
      || expectedFamilyIds.some(id => !actual.has(id))) {
      throw new Error('FINANCIAL_250_FAMILY_DATABASE_INVENTORY_MISMATCH');
    }
  }
  const seen = new Set();
  const deficits = rows.map(row => {
    if (!row || typeof row.id !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(row.id)
      || seen.has(row.id) || typeof row.name !== 'string' || !row.name.trim()
      || typeof row.category !== 'string' || !row.category.trim()) {
      throw new Error('FINANCIAL_FAMILY_RESULT_DUPLICATE_OR_INVALID');
    }
    seen.add(row.id);
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
