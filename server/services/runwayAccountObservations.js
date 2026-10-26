/**
 * Statements are self-labeled evidence, not authoritative account identities.
 * Never sum closing balances, even if nicknames differ or look bank-issued.
 */
export function buildRunwayObservedAccounts(sources, today) {
  if (!Array.isArray(sources) || sources.length > 30) throw new Error('Invalid account source set.');
  const labels = new Map();
  const items = sources.map(record => {
    const statement = record.statement;
    const label = statement.accountLabel.trim();
    const normalized = label.toLowerCase().normalize('NFC');
    labels.set(normalized, (labels.get(normalized) || 0) + 1);
    return {
      statementId: String(record._id), accountNickname: label,
      asOfDate: statement.periodEnd,
      closingBalancePaise: statement.closingBalancePaise,
      evidenceStatus: 'USER_IMPORTED_UNVERIFIED',
      freshness: statement.periodEnd === today ? 'OBSERVED_TODAY_UNVERIFIED' : 'HISTORICAL_OBSERVATION',
      importedAt: record.importedAt,
    };
  }).sort((a, b) =>
    b.asOfDate.localeCompare(a.asOfDate) ||
    new Date(b.importedAt).getTime() - new Date(a.importedAt).getTime());
  return {
    items, householdTotalPaise: null, independentlyVerified: false,
    identityStatus: 'USER_SUPPLIED_NICKNAMES_ARE_NOT_ACCOUNT_IDENTIFIERS',
    potentiallyOverlappingNicknames: [...labels.entries()]
      .filter(([, n]) => n > 1).map(([label]) => label).sort(),
    warning: 'Individual account statements may overlap, be stale or omit pending transactions. Never add these balances to obtain household cash.',
  };
}
