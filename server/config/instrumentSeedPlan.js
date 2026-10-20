import { LEGACY_TYPE_MAP } from './instrumentMapping.js';

// Only catalog-owned descriptive and static assumption fields are overwritten.
// Live NAV, trailing returns, pricing observations, and creation timestamps
// belong to separate workflows and must survive catalog synchronization.
export function mapCatalogInstrument(inv) {
  const legacyType = inv.taxType === 'elss'
    ? 'ELSS'
    : (LEGACY_TYPE_MAP[inv.category] || LEGACY_TYPE_MAP[inv.cat] || 'Mutual_Fund');

  return {
    id: inv.id,
    name: inv.name,
    abbr: inv.abbr,
    type: legacyType,
    category: inv.category ?? inv.cat,
    cat: inv.cat ?? inv.category,
    subCategory: inv.subCategory,
    assetClass: inv.assetClass,
    provider: inv.provider,
    expectedReturn: inv.expectedReturn ?? inv.rate,
    rate: inv.rate ?? inv.expectedReturn,
    returnRange: inv.returnRange,
    interestRate: inv.interestRate ?? inv.expectedReturn ?? inv.rate,
    risk: inv.dynamicData?.risk?.value ?? inv.riskLevel ?? 3,
    riskLabel: inv.riskLabel,
    volatility: inv.volatility,
    liquidityScore: inv.liquidityScore,
    lockIn: inv.lockIn ?? 0,
    lockInYears: inv.lockIn ?? 0,
    taxType: inv.taxType,
    taxEfficiencyScore: inv.taxEfficiencyScore,
    taxation: inv.taxation,
    expenseRatio: inv.expenseRatio ?? 0,
    minMonthlyInvestment: inv.minMonthlyInvestment,
    maxAnnualInvestment: inv.maxAnnualInvestment,
    minInvestment: inv.minMonthlyInvestment ?? inv.minInvestment,
    idealHorizon: inv.idealHorizon,
    goalTags: inv.goalTags ?? [],
    eligibility: inv.eligibility,
    color: inv.color,
    desc: inv.desc,
    sovereignGuarantee: inv.assetClass === 'Sovereign',
  };
}

export function buildInstrumentSeedOperations(catalog) {
  if (!Array.isArray(catalog) || catalog.length === 0) {
    throw new TypeError('Instrument catalog must be a nonempty array.');
  }
  const ids = new Set();
  const typeCounts = {};
  const operations = [];
  for (const item of catalog) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
        || typeof item.id !== 'string' || !item.id.trim()
        || typeof item.name !== 'string' || !item.name.trim()) {
      throw new TypeError('Catalog instrument must have a nonempty string id and name.');
    }
    if (ids.has(item.id)) {
      throw new Error('Catalog contains duplicate instrument ids.');
    }
    ids.add(item.id);
    const mapped = mapCatalogInstrument(item);
    for (const field of ['expectedReturn', 'rate', 'interestRate', 'expenseRatio', 'lockIn']) {
      if (mapped[field] !== undefined && mapped[field] !== null
          && (typeof mapped[field] !== 'number' || !Number.isFinite(mapped[field]))) {
        throw new TypeError('Catalog contains invalid numeric assumptions.');
      }
    }
    // Descriptive catalog identity may be updated. Financial measurements and
    // policy-sensitive classifications are defaults for NEW instruments only:
    // provider-qualified rate, NAV, risk and tax facts must not be overwritten
    // by a static catalog refresh, even when that catalog changes later.
    const financialOrPolicyFacts = new Set([
      'expectedReturn', 'rate', 'returnRange', 'interestRate', 'risk',
      'riskLabel', 'volatility', 'liquidityScore', 'lockIn', 'lockInYears',
      'taxType', 'taxEfficiencyScore', 'taxation', 'expenseRatio',
      'minMonthlyInvestment', 'maxAnnualInvestment', 'minInvestment',
      'idealHorizon', 'eligibility', 'sovereignGuarantee',
    ]);
    const entries = Object.entries(mapped).filter(([, value]) => value !== undefined);
    const descriptive = Object.fromEntries(entries.filter(([name]) => !financialOrPolicyFacts.has(name)));
    const defaults = Object.fromEntries(entries.filter(([name]) => financialOrPolicyFacts.has(name)));
    const update = { $set: descriptive };
    if (Object.keys(defaults).length) update.$setOnInsert = defaults;
    operations.push({ updateOne: { filter: { id: item.id }, update, upsert: true } });
    typeCounts[mapped.type] = (typeCounts[mapped.type] ?? 0) + 1;
  }
  return { operations, typeCounts };
}
