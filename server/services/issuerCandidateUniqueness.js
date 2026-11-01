/**
 * Discovery-only product identity guard shared by all 250 investment families.
 * A market product may be a valid type of more than one archetype, but it
 * must not be silently recycled between families of the same catalog category
 * just to make two superficially different "Top 3" lists.
 *
 * Product labels are not approval or licensed observations. This guard is
 * intentionally independent of the protected production suitability gates.
 */
function identity(value) {
  if (typeof value !== 'string') return '';
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}
export function assertDistinctIssuerOptionsByCategory(families) {
  if (!Array.isArray(families) || families.length !== 250) {
    throw new Error('FINANCIAL_DISTINCT_TOP_THREE_REQUIRES_250_FAMILIES');
  }
  const productOwners = new Map();
  const familyIds = new Set();
  for (const family of families) {
    if (!family || typeof family.id !== 'string' || familyIds.has(family.id)
      || !identity(family.category) || !Array.isArray(family.researchCandidates)
      || family.researchCandidates.length > 3) {
      throw new Error('FINANCIAL_DISTINCT_TOP_THREE_INVALID_FAMILY');
    }
    familyIds.add(family.id);
    const category = identity(family.category);
    for (const product of family.researchCandidates) {
      if (!product || typeof product.name !== 'string' || !identity(product.name)
        || typeof product.issuer !== 'string' || !identity(product.issuer)) {
        throw new Error('FINANCIAL_DISTINCT_TOP_THREE_INVALID_PRODUCT');
      }
      const key = category + ':' + identity(product.name);
      const owner = productOwners.get(key);
      if (owner) {
        // Fail closed on within-family duplicates as well as cross-family
        // category reuse; never silently trim and call the remainder top 3.
        throw new Error('FINANCIAL_DUPLICATE_PRODUCT_IN_CATEGORY:' + owner + ':' + family.id);
      }
      productOwners.set(key, family.id);
    }
  }
  return {
    familyCount: familyIds.size,
    issuerExampleCount: productOwners.size,
    familiesWithIssuerExamples: families.filter(row => row.researchCandidates.length > 0).length,
    crossFamilyCategoryDuplicates: 0,
  };
}
