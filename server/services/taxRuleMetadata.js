/**
 * Statute-versioned semantic identifiers for tax policies.
 *
 * These semantic identifiers describe implemented behavior. They do not
 * assert that a provision in the repealed 1961 Act maps one-to-one to a
 * numbered provision in the Income-tax Act, 2025. Official statute metadata
 * and source references remain the legal authority. Legacy labels are
 * retained only as explicitly marked compatibility aliases.
 */
const LEGACY_RULE_SEMANTICS = Object.freeze({
  SECTION_87A_REBATE: 'REBATE_POLICY',
  SECTION_80CCD_2_VERSIONED_LIMIT: 'EMPLOYER_NPS_DEDUCTION_POLICY',
  SECTION_111A_STCG_SPECIAL_RATE: 'EQUITY_STCG_SPECIAL_RATE_POLICY',
  SECTION_112A_LTCG_SPECIAL_RATE: 'EQUITY_LTCG_SPECIAL_RATE_POLICY',
  SECTION_112_LTCG_SPECIAL_RATE: 'OTHER_LTCG_SPECIAL_RATE_POLICY',
  SECTION_112A_ANNUAL_EXEMPTION: 'EQUITY_LTCG_ANNUAL_EXEMPTION_POLICY',
  SPECIAL_RATE_INCOME_EXCLUDED_FROM_87A_REBATE: 'SPECIAL_RATE_INCOME_REBATE_EXCLUSION_POLICY',
  SECTION_10_11_EEE_TREATMENT: 'PPF_SCHEDULE_II_PROVIDENT_FUND_EXCLUSION',
  SECTION_10_11A_EEE_TREATMENT: 'SSY_SCHEDULE_II_ACCOUNT_EXCLUSION',
  SGB_MATURITY_EXEMPTION_CONDITIONAL: 'SGB_MATURITY_CAPITAL_GAINS_EXEMPTION_POLICY',
  SGB_SECONDARY_MARKET_EXEMPTION_NOT_AVAILABLE: 'SGB_SECONDARY_MARKET_EXEMPTION_EXCLUSION_POLICY',
});

const CURRENT_RULE_SEMANTICS = Object.freeze({
  NEW_REGIME_SLABS: 'NEW_REGIME_SLABS',
  OLD_REGIME_NON_SENIOR_SLABS: 'OLD_REGIME_NON_SENIOR_SLABS',
  OLD_REGIME_SENIORCITIZEN_SLABS: 'OLD_REGIME_SENIOR_CITIZEN_SLABS',
  OLD_REGIME_SUPERSENIORCITIZEN_SLABS: 'OLD_REGIME_SUPER_SENIOR_CITIZEN_SLABS',
  STANDARD_DEDUCTION: 'STANDARD_DEDUCTION',
  FAMILY_PENSION_VERSIONED_DEDUCTION: 'FAMILY_PENSION_DEDUCTION',
  FAMILY_PENSION_DEDUCTION: 'FAMILY_PENSION_DEDUCTION',
  SECTION_80CCD_2_VERSIONED_LIMIT: 'EMPLOYER_NPS_DEDUCTION_POLICY',
  EMPLOYER_NPS_DEDUCTION_POLICY: 'EMPLOYER_NPS_DEDUCTION_POLICY',
  OLD_REGIME_DEDUCTIONS: 'OLD_REGIME_DEDUCTIONS',
  PPF_ACCOUNT_EXCLUSION_CONDITIONAL: 'PPF_ACCOUNT_EXCLUSION_CONDITIONAL',
  SSY_ACCOUNT_EXCLUSION_CONDITIONAL: 'SSY_ACCOUNT_EXCLUSION_CONDITIONAL',
  HEALTH_INSURANCE_DEDUCTION: 'HEALTH_INSURANCE_DEDUCTION',
  HOUSING_INTEREST_DEDUCTION: 'HOUSING_INTEREST_DEDUCTION',
  SAVINGS_INTEREST_DEDUCTION: 'SAVINGS_INTEREST_DEDUCTION',
  SECTION_87A_REBATE: 'REBATE_POLICY',
  MARGINAL_RELIEF: 'MARGINAL_RELIEF_POLICY',
  SURCHARGE: 'SURCHARGE_POLICY',
  HEALTH_AND_EDUCATION_CESS: 'HEALTH_EDUCATION_CESS_POLICY',
  BANK_DEPOSIT_INTEREST_TAXED_AT_INCOME_TAX_RATES: 'BANK_DEPOSIT_INTEREST_TAXATION',
  BANK_INTEREST_TDS_THRESHOLD: 'BANK_INTEREST_TDS_THRESHOLD_POLICY',
  SECURITY_INTEREST_TDS_THRESHOLD: 'SECURITY_INTEREST_TDS_THRESHOLD_POLICY',
  BANK_INTEREST_TDS: 'BANK_INTEREST_TDS_POLICY',
  PPF_ACCOUNT_TAX_TREATMENT: 'PPF_SCHEDULE_II_PROVIDENT_FUND_EXCLUSION',
  SSY_ACCOUNT_TAX_TREATMENT: 'SSY_SCHEDULE_II_ACCOUNT_EXCLUSION',
  FRSB_INTEREST_TAXABLE: 'FRSB_TAXABLE_INTEREST_POLICY',
  SGB_MATURITY_EXEMPTION_REQUIRES_ORIGINAL_ISSUE_AND_CONTINUOUS_HOLDING: 'SGB_MATURITY_CAPITAL_GAINS_EXEMPTION_POLICY',
  SGB_COUPON_TAXABLE: 'SGB_COUPON_TAXATION_POLICY',
  SGB_COUPON_TAXATION_POLICY: 'SGB_COUPON_TAXATION_POLICY',
  EQUITY_STCG_SPECIAL_RATE_POLICY: 'EQUITY_STCG_SPECIAL_RATE_POLICY',
  EQUITY_LTCG_SPECIAL_RATE_POLICY: 'EQUITY_LTCG_SPECIAL_RATE_POLICY',
  OTHER_LTCG_SPECIAL_RATE_POLICY: 'OTHER_LTCG_SPECIAL_RATE_POLICY',
  EQUITY_LTCG_ANNUAL_EXEMPTION_POLICY: 'EQUITY_LTCG_ANNUAL_EXEMPTION_POLICY',
  SPECIAL_RATE_SURCHARGE_CAPPED_AT_15_PERCENT: 'SPECIAL_RATE_SURCHARGE_CAP_POLICY',
  SPECIAL_RATE_INCOME_EXCLUDED_FROM_87A_REBATE: 'SPECIAL_RATE_REBATE_EXCLUSION_POLICY',
  SGB_SECONDARY_MARKET_EXEMPTION_NOT_AVAILABLE: 'SGB_SECONDARY_MARKET_EXEMPTION_EXCLUSION_POLICY',
});

const LEGACY_CLASS_SEMANTICS = Object.freeze({
  EQUITY_MF_SECTION_112A: 'EQUITY_MF_TAX_CLASSIFICATION',
  EQUITY_MF_ELSS_SECTION_112A: 'ELSS_TAX_CLASSIFICATION',
  DEBT_MF_SECTION_50AA: 'DEBT_MF_TAX_CLASSIFICATION',
  EQUITY_LTCG_SECTION_112A: 'EQUITY_LTCG_TAX_CLASSIFICATION',
  EQUITY_STCG_SECTION_111A: 'EQUITY_STCG_TAX_CLASSIFICATION',
});

const CURRENT_STATUTE = 'INCOME_TAX_ACT_2025';
const OFFICIAL_2025_ACT_URL = 'https://www.incometaxindia.gov.in/documents/d/guest/income_tax_act_2025_as_amended_by_fa_act_2026-pdf';
const OFFICIAL_BUDGET_2026_FAQ_URL = 'https://www.incometaxindia.gov.in/documents/20117/15766092/FAQs-Budget-2026%2BUpdated.pdf/daf54d14-aca9-c4ea-b786-598fd2f8d4c4';
const VERIFIED_CURRENT_REFERENCES = Object.freeze({
  NEW_REGIME_SLABS: 'Section 202',
  STANDARD_DEDUCTION: 'Section 19',
  FAMILY_PENSION_DEDUCTION: 'Section 93(1)(d)',
  EMPLOYER_NPS_DEDUCTION_POLICY: 'Section 124',
  OLD_REGIME_DEDUCTIONS: 'Sections 22, 123, 124 and 126; Schedule XV',
  HEALTH_INSURANCE_DEDUCTION: 'Section 126',
  HOUSING_INTEREST_DEDUCTION: 'Section 22',
  SAVINGS_INTEREST_DEDUCTION: 'Section 153(2)(b)',
  REBATE_POLICY: 'Section 156',
  MARGINAL_RELIEF_POLICY: 'Section 156 and Finance Act 2026',
  SURCHARGE_POLICY: 'Finance Act 2026, First Schedule',
  HEALTH_EDUCATION_CESS_POLICY: 'Finance Act 2026, First Schedule',
  OLD_REGIME_NON_SENIOR_SLABS: 'Finance Act 2026, First Schedule',
  OLD_REGIME_SENIOR_CITIZEN_SLABS: 'Finance Act 2026, First Schedule',
  OLD_REGIME_SUPER_SENIOR_CITIZEN_SLABS: 'Finance Act 2026, First Schedule',
  EQUITY_STCG_SPECIAL_RATE_POLICY: 'Section 196',
  OTHER_LTCG_SPECIAL_RATE_POLICY: 'Section 197',
  EQUITY_LTCG_SPECIAL_RATE_POLICY: 'Section 198',
  EQUITY_LTCG_ANNUAL_EXEMPTION_POLICY: 'Section 198',
  SGB_MATURITY_CAPITAL_GAINS_EXEMPTION_POLICY: 'Section 70(1)(x)',
  SGB_SECONDARY_MARKET_EXEMPTION_EXCLUSION_POLICY: 'Section 70(1)(x)',
  BANK_INTEREST_TDS_THRESHOLD_POLICY: 'Section 393(1), Table 5(ii)',
  SECURITY_INTEREST_TDS_THRESHOLD_POLICY: 'Section 393(1), Table 5(i)',
  PPF_SCHEDULE_II_PROVIDENT_FUND_EXCLUSION: 'Schedule II, Table, Sl. No. 3 (conditional)',
  SSY_SCHEDULE_II_ACCOUNT_EXCLUSION: 'Schedule II, Table, Sl. No. 5 (account-qualified payment)',
  PPF_ACCOUNT_EXCLUSION_CONDITIONAL: 'Schedule II, Table, Sl. No. 3 (conditional)',
  SSY_ACCOUNT_EXCLUSION_CONDITIONAL: 'Schedule II, Table, Sl. No. 5 (account-qualified payment)',
});

const OFFICIAL_FINANCE_2026_MEMO_URL = 'https://www.incometaxindia.gov.in/documents/81799/11848482/memo-2026.pdf/fe530cfa-9c49-fc5c-4bfa-fc96fd5e7b7a';
const OFFICIAL_TDS_SECTION_URL = 'https://www.incometaxindia.gov.in/w/section-393-5';
const OFFICIAL_STANDARD_DEDUCTION_SECTION_URL = 'https://wmstatic-prd.incometaxindia.gov.in/web/guest/w/section-19-199';
const OFFICIAL_NPS_EMPLOYER_SECTION_URL = OFFICIAL_2025_ACT_URL;
const OFFICIAL_HEALTH_DEDUCTION_SECTION_URL = OFFICIAL_2025_ACT_URL;
const OFFICIAL_HOUSING_DEDUCTION_SECTION_URL = 'https://www.incometaxindia.gov.in/w/section-22-211';
const OFFICIAL_SAVINGS_DEDUCTION_RULES_URL = OFFICIAL_2025_ACT_URL;
const OFFICIAL_SGB_RULE_SOURCE_URL = 'https://www.incometaxindia.gov.in/documents/20117/15766092/FAQs-Budget-2026%2BUpdated.pdf/daf54d14-aca9-c4ea-b786-598fd2f8d4c4';

function referencesForRule(ruleId) {
  const sources = [
    { authority: 'Income Tax Department — Government of India', title: 'Income-tax Act, 2025 as amended by Finance Act, 2026', url: OFFICIAL_2025_ACT_URL },
    { authority: 'Income Tax Department — Government of India', title: 'Updated Budget 2026 tax FAQs', url: OFFICIAL_BUDGET_2026_FAQ_URL },
  ];
  if (ruleId === 'BANK_INTEREST_TDS_THRESHOLD_POLICY' || ruleId === 'SECURITY_INTEREST_TDS_THRESHOLD_POLICY') {
    sources.push({ authority: 'Income Tax Department — Government of India', title: 'Income-tax Act, 2025 section 393', url: OFFICIAL_TDS_SECTION_URL });
  }
  if (ruleId === 'STANDARD_DEDUCTION') {
    sources.push({ authority: 'Income Tax Department — Government of India', title: 'Income-tax Act, 2025 section 19', url: OFFICIAL_STANDARD_DEDUCTION_SECTION_URL });
  }
  if (ruleId === 'EMPLOYER_NPS_DEDUCTION_POLICY') {
    sources.push({ authority: 'Income Tax Department — Government of India', title: 'Income-tax Act, 2025 section 124 (employer and individual NPS contributions)', url: OFFICIAL_NPS_EMPLOYER_SECTION_URL });
  }
  if (ruleId === 'HEALTH_INSURANCE_DEDUCTION') {
    sources.push({ authority: 'Income Tax Department — Government of India', title: 'Income-tax Act, 2025 section 126 (health insurance deduction)', url: OFFICIAL_HEALTH_DEDUCTION_SECTION_URL });
  }
  if (ruleId === 'HOUSING_INTEREST_DEDUCTION') {
    sources.push({ authority: 'Income Tax Department — Government of India', title: 'Income-tax Act, 2025 section 22 (house-property interest deduction)', url: OFFICIAL_HOUSING_DEDUCTION_SECTION_URL });
  }
  if (ruleId === 'SAVINGS_INTEREST_DEDUCTION') {
    sources.push({ authority: 'Income Tax Department — Government of India', title: 'Income-tax Act, 2025 section 153 (savings-deposit interest deduction)', url: OFFICIAL_SAVINGS_DEDUCTION_RULES_URL });
  }
  if (ruleId.includes('PPF_') || ruleId.includes('SSY_')) {
    sources.push({ authority: 'Income Tax Department — Government of India', title: 'Income-tax Act, 2025 Schedule II (conditional excluded-income rules)', url: OFFICIAL_NPS_EMPLOYER_SECTION_URL });
  }
  if (ruleId.includes('SGB_')) {
    sources.push({ authority: 'Income Tax Department — Government of India', title: 'Updated Budget 2026 FAQs — Sovereign Gold Bond treatment', url: OFFICIAL_SGB_RULE_SOURCE_URL });
  }
  if (ruleId === 'HEALTH_EDUCATION_CESS_POLICY' || ruleId === 'SURCHARGE_POLICY'
      || ruleId === 'MARGINAL_RELIEF_POLICY' || ruleId === 'OLD_REGIME_NON_SENIOR_SLABS'
      || ruleId === 'OLD_REGIME_SENIOR_CITIZEN_SLABS' || ruleId === 'OLD_REGIME_SUPER_SENIOR_CITIZEN_SLABS') {
    sources.push({ authority: 'Government of India — Finance Act 2026 memorandum', title: 'Finance Act 2026 tax rates and cess', url: OFFICIAL_FINANCE_2026_MEMO_URL });
  }
  return sources;
}

function currentRuleId(statute, semanticName) {
  return `${statute}_${semanticName}`;
}

/** Build a versioned record and return safe rule IDs for the given statute. */
export function buildTaxRuleMetadata({ statuteMetadata = null, identifiers = [], taxClass = null } = {}) {
  if (!statuteMetadata?.statute) return null;
  const ids = [...new Set((Array.isArray(identifiers) ? identifiers : [])
    .filter(value => typeof value === 'string' && value.length > 0))];
  const current = statuteMetadata.statute === CURRENT_STATUTE;
  const mapped = ids.map(id => {
    if (!current) return id;
    if (LEGACY_RULE_SEMANTICS[id]) return currentRuleId(statuteMetadata.statute, LEGACY_RULE_SEMANTICS[id]);
    if (id.startsWith(`${CURRENT_STATUTE}_`)) return id;
    const semantic = CURRENT_RULE_SEMANTICS[id] || id;
    // Calculation/display policies are versioned by WealthGenie, not presented
    // as statutory provisions merely because a tax policy is also in scope.
    if (semantic.startsWith('CURRENT_RATE_') || semantic.startsWith('WEALTHGENIE_')) return semantic;
    return currentRuleId(statuteMetadata.statute, semantic);
  });
  const legacyAliases = current
    ? ids.filter(id => Boolean(LEGACY_RULE_SEMANTICS[id]))
    : [];
  const semanticClass = taxClass ? LEGACY_CLASS_SEMANTICS[taxClass] || taxClass : null;
  const currentRuleReferences = current
    ? [...new Set(mapped.map(id => id.startsWith(`${CURRENT_STATUTE}_`) ? id.slice(CURRENT_STATUTE.length + 1) : '')
      .filter(semantic => VERIFIED_CURRENT_REFERENCES[semantic]))]
      .map(semantic => ({
        statute: CURRENT_STATUTE,
        ruleId: currentRuleId(CURRENT_STATUTE, semantic),
        reference: VERIFIED_CURRENT_REFERENCES[semantic],
        effectiveFrom: '2026-04-01',
        sourceReferences: referencesForRule(semantic),
      }))
    : [];
  return Object.freeze({
    statute: statuteMetadata.statute,
    fiscalYear: statuteMetadata.fiscalYear,
    taxYear: statuteMetadata.taxYear,
    effectiveFrom: statuteMetadata.effectiveFrom,
    policyStatus: statuteMetadata.policyStatus,
    currentRuleIds: Object.freeze(current ? [...new Set(mapped)] : []),
    rulesApplied: Object.freeze(current ? [...new Set(mapped)] : ids),
    legacyAliases: Object.freeze(legacyAliases),
    currentRuleReferences: Object.freeze(currentRuleReferences),
    classificationId: semanticClass ? currentRuleId(statuteMetadata.statute, semanticClass) : null,
    legacyClassificationAlias: current && taxClass && semanticClass !== taxClass ? taxClass : null,
    authority: 'STATUTE_METADATA_AND_OFFICIAL_SOURCE_REFERENCES',
  });
}

export { LEGACY_CLASS_SEMANTICS, LEGACY_RULE_SEMANTICS };
