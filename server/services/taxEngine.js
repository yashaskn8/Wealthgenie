import { buildTaxRuleMetadata } from './taxRuleMetadata.js';
/**
 * Dynamically computes India's current fiscal year (April 1st to March 31st).
 * @returns {string} e.g. "FY2026-27"
 */
export function getCurrentFiscalYear(now = new Date()) {
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
        throw new TypeError('now must be a valid Date');
    }
    // Fiscal-year selection is based on the India calendar, not the host
    // machine's local timezone. This matters around 31 March / 1 April UTC.
    const indiaParts = new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: 'numeric',
    }).formatToParts(now);
    const year = Number(indiaParts.find(part => part.type === 'year')?.value);
    const month = Number(indiaParts.find(part => part.type === 'month')?.value);
    // India's fiscal year starts in April (month number 4).
    const isAprilOrLater = month >= 4;
    const startYear = isAprilOrLater ? year : year - 1;
    const endYear = startYear + 1;
    return `FY${startYear}-${endYear.toString().slice(-2)}`;
}
export const CURRENT_FY = getCurrentFiscalYear();

function parseCalendarDate(value, fieldName) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new TypeError(`${fieldName} must be an ISO calendar date (YYYY-MM-DD)`);
    }
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
        throw new RangeError(`${fieldName} must be a real calendar date`);
    }
    return date;
}

function addCalendarMonths(date, months) {
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + months;
    const day = date.getUTCDate();
    const target = new Date(Date.UTC(year, month, 1));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(day, lastDay));
    return target;
}

/**
 * Classify a holding period from exact transaction dates. The anniversary is
 * included so callers can test the statutory threshold without rounding a
 * date difference into a misleading number of months.
 */
export function classifyHoldingPeriodByDates({ acquisitionDate, redemptionDate, thresholdMonths }) {
    if (!Number.isInteger(thresholdMonths) || thresholdMonths <= 0 || thresholdMonths > 120) {
        throw new TypeError('thresholdMonths must be an explicit positive integer');
    }
    const acquired = parseCalendarDate(acquisitionDate, 'acquisitionDate');
    const redeemed = parseCalendarDate(redemptionDate, 'redemptionDate');
    if (redeemed < acquired) throw new RangeError('redemptionDate cannot precede acquisitionDate');
    const thresholdDate = addCalendarMonths(acquired, thresholdMonths);
    const dayCount = Math.round((redeemed.getTime() - acquired.getTime()) / 86400000);
    return {
        // The statutory test is strictly greater than the minimum holding
        // period. The anniversary itself is still short-term.
        isLongTerm: redeemed > thresholdDate,
        thresholdMonths,
        thresholdDate: thresholdDate.toISOString().slice(0, 10),
        holdingDays: dayCount,
        acquisitionDate,
        redemptionDate,
        holdingPeriodBasis: 'EXACT_TRANSACTION_DATES',
    };
}
const defineSlabs = (slabs) => Object.freeze(slabs.map(slab => Object.freeze({ ...slab })));
const FY2025_26_NEW_SLABS = defineSlabs([
    { min: 0, max: 400000, rate: 0 },
    { min: 400000, max: 800000, rate: 0.05 },
    { min: 800000, max: 1200000, rate: 0.10 },
    { min: 1200000, max: 1600000, rate: 0.15 },
    { min: 1600000, max: 2000000, rate: 0.20 },
    { min: 2000000, max: 2400000, rate: 0.25 },
    { min: 2400000, max: Infinity, rate: 0.30 },
]);
const FY2026_27_NEW_SLABS = defineSlabs([
    { min: 0, max: 400000, rate: 0 },
    { min: 400000, max: 800000, rate: 0.05 },
    { min: 800000, max: 1200000, rate: 0.10 },
    { min: 1200000, max: 1600000, rate: 0.15 },
    { min: 1600000, max: 2000000, rate: 0.20 },
    { min: 2000000, max: 2400000, rate: 0.25 },
    { min: 2400000, max: Infinity, rate: 0.30 },
]);
const FY2025_26_OLD_NON_SENIOR_SLABS = defineSlabs([
    { min: 0, max: 250000, rate: 0 },
    { min: 250000, max: 500000, rate: 0.05 },
    { min: 500000, max: 1000000, rate: 0.20 },
    { min: 1000000, max: Infinity, rate: 0.30 },
]);
const FY2025_26_OLD_SENIOR_SLABS = defineSlabs([
    { min: 0, max: 300000, rate: 0 },
    { min: 300000, max: 500000, rate: 0.05 },
    { min: 500000, max: 1000000, rate: 0.20 },
    { min: 1000000, max: Infinity, rate: 0.30 },
]);
const FY2025_26_OLD_SUPER_SENIOR_SLABS = defineSlabs([
    { min: 0, max: 500000, rate: 0 },
    { min: 500000, max: 1000000, rate: 0.20 },
    { min: 1000000, max: Infinity, rate: 0.30 },
]);
const FY2026_27_OLD_NON_SENIOR_SLABS = defineSlabs([
    { min: 0, max: 250000, rate: 0 },
    { min: 250000, max: 500000, rate: 0.05 },
    { min: 500000, max: 1000000, rate: 0.20 },
    { min: 1000000, max: Infinity, rate: 0.30 },
]);
const FY2026_27_OLD_SENIOR_SLABS = defineSlabs([
    { min: 0, max: 300000, rate: 0 },
    { min: 300000, max: 500000, rate: 0.05 },
    { min: 500000, max: 1000000, rate: 0.20 },
    { min: 1000000, max: Infinity, rate: 0.30 },
]);
const FY2026_27_OLD_SUPER_SENIOR_SLABS = defineSlabs([
    { min: 0, max: 500000, rate: 0 },
    { min: 500000, max: 1000000, rate: 0.20 },
    { min: 1000000, max: Infinity, rate: 0.30 },
]);

const TAX_SOURCES = Object.freeze({
    'FY2025-26': Object.freeze([
        Object.freeze({
            authority: 'Government of India — Union Budget',
            title: 'Finance Bill 2025 Memorandum — AY 2026-27 tax changes',
            url: 'https://www.indiabudget.gov.in/budget2025-26/doc/memo.pdf',
            role: 'TAX_POLICY',
        }),
        Object.freeze({
            authority: 'Income Tax Department',
            title: 'AY 2026-27 individual and senior-citizen tax guidance',
            url: 'https://www.incometax.gov.in/iec/foportal/help/individual/return-applicable-2',
            role: 'TAX_POLICY',
        }),
    ]),
    'FY2026-27': Object.freeze([
        Object.freeze({
            authority: 'Income Tax Department — Government of India',
            title: 'Income-tax Act, 2025 as amended by Finance Act, 2026',
            url: 'https://www.incometaxindia.gov.in/documents/d/guest/income_tax_act_2025_as_amended_by_fa_act_2026-pdf',
            role: 'TAX_POLICY',
        }),
        Object.freeze({
            authority: 'Income Tax Department — Government of India',
            title: 'Updated Budget 2026 tax FAQs and slab/rebate explanation',
            url: 'https://www.incometaxindia.gov.in/documents/20117/15766092/FAQs-Budget-2026%2BUpdated.pdf/daf54d14-aca9-c4ea-b786-598fd2f8d4c4',
            role: 'TAX_POLICY',
        }),
        Object.freeze({
            authority: 'Income Tax Department — Government of India',
            title: 'Objective and scope of the new Income-tax Act, 2025',
            url: 'https://www.incometax.gov.in/iec/foportal/help/all-topics/e-filing-services/objective-and-scope-new-act',
            role: 'STATUTE_EFFECTIVE_DATE',
        }),
        Object.freeze({
            authority: 'Government of India — Union Budget',
            title: 'Finance Bill 2026 Memorandum',
            url: 'https://www.indiabudget.gov.in/doc/memo.pdf',
            role: 'TAX_POLICY',
        }),
    ]),
});

const TAX_STATUTE_METADATA = Object.freeze({
    'FY2025-26': Object.freeze({
        statute: 'INCOME_TAX_ACT_1961',
        effectiveFrom: '1961-04-01',
        fiscalYear: 'FY2025-26',
        taxYear: 'TY2025-26',
        policyStatus: 'HISTORICAL_PRIOR_LAW',
    }),
    'FY2026-27': Object.freeze({
        statute: 'INCOME_TAX_ACT_2025',
        effectiveFrom: '2026-04-01',
        fiscalYear: 'FY2026-27',
        taxYear: 'TY2026-27',
        policyStatus: 'CURRENT_STATUTE_VERSIONED',
        legacyReferencePolicy: 'Legacy section labels may be retained only as aliases; they are not current statutory authority.',
    }),
});

const TAX_POLICY_RULES = Object.freeze({
    'FY2025-26': Object.freeze({
        newRegime87ALimit: 1200000,
        newRegime87ARebate: 60000,
        oldRegime87ALimit: 500000,
        oldRegime87ARebate: 12500,
        standardDeduction: Object.freeze({ salary: Object.freeze({ new: 75000, old: 50000 }), pension: Object.freeze({ new: 75000, old: 50000 }) }),
        familyPensionDeductionLimit: Object.freeze({ new: 25000, old: 15000 }),
        employerNpsLimitPct: Object.freeze({ government: 0.14, nonGovernmentOldRegime: 0.10, nonGovernmentNewRegime: 0.14 }),
        oldRegimeBasicExemption: Object.freeze({ nonSenior: 250000, seniorCitizen: 300000, superSeniorCitizen: 500000 }),
        capitalGains112AExemption: 125000,
        capitalGains111ARate: 0.20,
        capitalGains112ARate: 0.125,
        specialRateSurchargeCap: 0.15,
        capitalGainsHoldingPeriodMonths: Object.freeze({ listed: 12, other: 24 }),
        bankInterestTdsThreshold: Object.freeze({ general: 50000, senior: 100000 }),
        bankInterestTdsRate: 0.10,
        securityInterestTdsThreshold: 10000,
        securityInterestTdsRate: 0.10,
        healthAndEducationCessRate: 0.04,
        deductionLimits: Object.freeze({
            section80C: 150000,
            section80CCD1B: 50000,
            section80DSelf: 25000,
            section80DSelfSenior: 50000,
            section80DParents: 25000,
            section80DParentsSenior: 50000,
            section80DCombined: 100000,
            homeLoanInterest: 200000,
            section80EEA: 150000,
            section80TTA: 10000,
            section80TTB: 50000,
        }),
    }),
    'FY2026-27': Object.freeze({
        newRegime87ALimit: 1200000,
        newRegime87ARebate: 60000,
        oldRegime87ALimit: 500000,
        oldRegime87ARebate: 12500,
        standardDeduction: Object.freeze({ salary: Object.freeze({ new: 75000, old: 50000 }), pension: Object.freeze({ new: 75000, old: 50000 }) }),
        familyPensionDeductionLimit: Object.freeze({ new: 25000, old: 15000 }),
        employerNpsLimitPct: Object.freeze({ government: 0.14, nonGovernmentOldRegime: 0.10, nonGovernmentNewRegime: 0.14 }),
        oldRegimeBasicExemption: Object.freeze({ nonSenior: 250000, seniorCitizen: 300000, superSeniorCitizen: 500000 }),
        capitalGains112AExemption: 125000,
        capitalGains111ARate: 0.20,
        capitalGains112ARate: 0.125,
        specialRateSurchargeCap: 0.15,
        capitalGainsHoldingPeriodMonths: Object.freeze({ listed: 12, other: 24 }),
        bankInterestTdsThreshold: Object.freeze({ general: 50000, senior: 100000 }),
        bankInterestTdsRate: 0.10,
        securityInterestTdsThreshold: 10000,
        securityInterestTdsRate: 0.10,
        healthAndEducationCessRate: 0.04,
        deductionLimits: Object.freeze({
            section80C: 150000,
            section80CCD1B: 50000,
            section80DSelf: 25000,
            section80DSelfSenior: 50000,
            section80DParents: 25000,
            section80DParentsSenior: 50000,
            section80DCombined: 100000,
            homeLoanInterest: 200000,
            section80EEA: 150000,
            section80TTA: 10000,
            section80TTB: 50000,
        }),
    }),
});

// Historical compatibility export only. Runtime calculations resolve limits
// from the selected fiscal-year policy below.
export const TAX_DEDUCTION_LIMITS = Object.freeze({ ...TAX_POLICY_RULES['FY2025-26'].deductionLimits });

export const TAX_SLABS_BY_FY = Object.freeze({
    'FY2025-26': Object.freeze({
        verified: true,
        policyVersion: 'tax-policy-FY2025-26-v2',
        sourceReferences: TAX_SOURCES['FY2025-26'],
        statuteMetadata: TAX_STATUTE_METADATA['FY2025-26'],
        verifiedRuleIds: Object.freeze([
            'FY2025-26_NEW_SLABS', 'FY2025-26_OLD_SLABS', 'FY2025-26_STANDARD_DEDUCTION',
            'FY2025-26_FAMILY_PENSION_DEDUCTION', 'FY2025-26_OLD_REGIME_DEDUCTION_LIMITS',
            'FY2025-26_HEALTH_DEDUCTION_LIMITS', 'FY2025-26_HOUSING_INTEREST_LIMIT',
            'FY2025-26_SAVINGS_INTEREST_LIMITS', 'FY2025-26_EMPLOYER_NPS_LIMITS',
            'FY2025-26_REBATE', 'FY2025-26_MARGINAL_RELIEF', 'FY2025-26_SURCHARGE',
            'FY2025-26_CESS', 'FY2025-26_CAPITAL_GAINS', 'FY2025-26_BANK_INTEREST_TDS',
            'FY2025-26_SECURITY_INTEREST_TDS',
        ]),
        new: FY2025_26_NEW_SLABS,
        old: FY2025_26_OLD_NON_SENIOR_SLABS,
        oldByAge: Object.freeze({
            nonSenior: FY2025_26_OLD_NON_SENIOR_SLABS,
            seniorCitizen: FY2025_26_OLD_SENIOR_SLABS,
            superSeniorCitizen: FY2025_26_OLD_SUPER_SENIOR_SLABS,
        }),
    }),
    'FY2026-27': Object.freeze({
        verified: true,
        policyVersion: 'tax-policy-FY2026-27-v2',
        sourceReferences: TAX_SOURCES['FY2026-27'],
        statuteMetadata: TAX_STATUTE_METADATA['FY2026-27'],
        verifiedRuleIds: Object.freeze([
            'FY2026-27_NEW_SLABS', 'FY2026-27_OLD_SLABS', 'FY2026-27_STANDARD_DEDUCTION',
            'FY2026-27_FAMILY_PENSION_DEDUCTION', 'FY2026-27_OLD_REGIME_DEDUCTION_LIMITS',
            'FY2026-27_HEALTH_DEDUCTION_LIMITS', 'FY2026-27_HOUSING_INTEREST_LIMIT',
            'FY2026-27_SAVINGS_INTEREST_LIMITS', 'FY2026-27_EMPLOYER_NPS_LIMITS',
            'FY2026-27_REBATE', 'FY2026-27_MARGINAL_RELIEF', 'FY2026-27_SURCHARGE',
            'FY2026-27_CESS', 'FY2026-27_CAPITAL_GAINS', 'FY2026-27_BANK_INTEREST_TDS',
            'FY2026-27_SECURITY_INTEREST_TDS',
            'FY2026-27_PPF_CONDITIONAL_EXCLUSION', 'FY2026-27_SSY_CONDITIONAL_EXCLUSION',
            'FY2026-27_SGB_MATURITY_QUALIFICATION',
        ]),
        new: FY2026_27_NEW_SLABS,
        old: FY2026_27_OLD_NON_SENIOR_SLABS,
        oldByAge: Object.freeze({
            nonSenior: FY2026_27_OLD_NON_SENIOR_SLABS,
            seniorCitizen: FY2026_27_OLD_SENIOR_SLABS,
            superSeniorCitizen: FY2026_27_OLD_SUPER_SENIOR_SLABS,
        }),
    }),
});

/**
 * Resolve the verified statutory policy for the current India fiscal year at
 * call time. Do not replace this with a module-level snapshot in audit paths:
 * a long-lived process can cross the April 1 IST boundary without restarting.
 */
export function getCurrentRegulatoryRuleVersion(now = new Date()) {
    const fiscalYear = getCurrentFiscalYear(now);
    const policy = TAX_SLABS_BY_FY[fiscalYear];
    return policy?.verified === true ? policy.policyVersion ?? null : null;
}

/**
 * @deprecated Compatibility snapshot for older callers. New audit writes must
 * use getCurrentRegulatoryRuleVersion() so fiscal-year rollover is respected.
 */
export const REGULATORY_RULE_VERSION = getCurrentRegulatoryRuleVersion();

export function getTaxPolicyMetadata(fiscalYear) {
    const policy = getTaxSlabsForFY(fiscalYear);
    const rules = TAX_POLICY_RULES[fiscalYear];
    return {
        policyVersion: policy.policyVersion,
        fiscalYear,
        verified: true,
        statuteMetadata: policy.statuteMetadata,
        verifiedRuleIds: policy.verifiedRuleIds,
        sourceReferences: policy.sourceReferences.map(source => ({ ...source })),
        rules: { ...rules, deductionLimits: { ...rules.deductionLimits } },
    };
}
export function getSupportedFiscalYears() {
    return Object.keys(TAX_SLABS_BY_FY).filter(fiscalYear => TAX_SLABS_BY_FY[fiscalYear].verified === true);
}
export function getTaxPolicyCatalog() {
    const currentFiscalYear = getCurrentFiscalYear();
    return {
        currentFiscalYear,
        currentFiscalYearVerified: isFYVerified(currentFiscalYear),
        verifiedFiscalYears: getSupportedFiscalYears(),
        policies: getSupportedFiscalYears().map(fiscalYear => getTaxPolicyMetadata(fiscalYear)),
    };
}
export function getTaxSlabsForFY(fiscalYear) {
    const slabs = TAX_SLABS_BY_FY[fiscalYear];
    if (!slabs || slabs.verified !== true) {
        const error = new RangeError(`Verified tax slabs are unavailable for ${fiscalYear}`);
        error.code = 'FISCAL_YEAR_UNSUPPORTED';
        throw error;
    }
    return slabs;
}
/**
 * Check whether the tax slabs for a given fiscal year have been verified
 * against an official gazette/Union Budget source.
 */
export function isFYVerified(fiscalYear) {
    const entry = TAX_SLABS_BY_FY[fiscalYear];
    return entry ? entry.verified === true : false;
}
function getTaxPolicyRules(fiscalYear) {
    getTaxSlabsForFY(fiscalYear);
    const rules = TAX_POLICY_RULES[fiscalYear];
    if (!rules) {
        const error = new RangeError(`Verified tax policy rules are unavailable for ${fiscalYear}`);
        error.code = 'FISCAL_YEAR_UNSUPPORTED';
        throw error;
    }
    return rules;
}

export function getCapitalGainsHoldingPeriodMonths(fiscalYear, assetType = 'other') {
    const rules = getTaxPolicyRules(fiscalYear);
    const threshold = rules.capitalGainsHoldingPeriodMonths[assetType];
    if (!Number.isInteger(threshold)) {
        throw new RangeError(`Verified holding-period rule is unavailable for ${assetType}`);
    }
    return threshold;
}

function normalizeUserAge(deductions = {}, explicitUserAge) {
    const candidate = explicitUserAge ?? deductions.userAge ?? deductions.age;
    if (candidate === undefined || candidate === null || candidate === '') return null;
    const numericAge = Number(candidate);
    return Number.isInteger(numericAge) && numericAge >= 18 && numericAge <= 120 ? numericAge : null;
}

function requireUserAge(regime, deductions = {}, explicitUserAge) {
    const userAge = normalizeUserAge(deductions, explicitUserAge);
    if (regime === 'old' && userAge === null) {
        throw new TypeError('USER_AGE_REQUIRED_FOR_OLD_REGIME');
    }
    return userAge;
}

function getOldRegimeAgeBand(userAge) {
    if (userAge >= 80) return 'superSeniorCitizen';
    if (userAge >= 60) return 'seniorCitizen';
    return 'nonSenior';
}

function getRegimeSlabs(regime, fiscalYear, userAge) {
    const slabs = getTaxSlabsForFY(fiscalYear);
    if (regime !== 'old') return slabs.new;
    const resolvedAge = requireUserAge('old', {}, userAge);
    return slabs.oldByAge[getOldRegimeAgeBand(resolvedAge)];
}
/**
 * Calculate tax from slab structure.
 */
function calculateFromSlabs(taxableIncome, slabs) {
    let tax = 0;
    for (const slab of slabs) {
        if (taxableIncome <= slab.min)
            break;
        const taxableInSlab = Math.min(taxableIncome, slab.max) - slab.min;
        tax += taxableInSlab * slab.rate;
    }
    return tax;
}
/**
 * Compute surcharge on base tax for high-income individuals.
 */
function computeSurcharge(taxBeforeSurcharge, taxableIncome, regime) {
    if (taxableIncome <= 5000000)
        return 0; // Below ₹50L: no surcharge
    let surchargeRate = 0;
    if (regime === 'new') {
        if (taxableIncome <= 10000000)
            surchargeRate = 0.10;
        else if (taxableIncome <= 20000000)
            surchargeRate = 0.15;
        else
            surchargeRate = 0.25;
    }
    else {
        // Old regime
        if (taxableIncome <= 10000000)
            surchargeRate = 0.10;
        else if (taxableIncome <= 20000000)
            surchargeRate = 0.15;
        else if (taxableIncome <= 50000000)
            surchargeRate = 0.25;
        else
            surchargeRate = 0.37;
    }
    return taxBeforeSurcharge * surchargeRate;
}
/**
 * Compute surcharge WITH marginal relief.
 */
function computeMarginalRelief(baseTax, surcharge, taxableIncome, regime, fiscalYear, userAge) {
    if (taxableIncome <= 5000000)
        return 0;
    const SURCHARGE_THRESHOLDS = regime === 'new'
        ? [5000000, 10000000, 20000000]
        : [5000000, 10000000, 20000000, 50000000];
    // Find the highest active threshold strictly below the taxable income
    let threshold = 5000000;
    for (const t of SURCHARGE_THRESHOLDS) {
        if (taxableIncome > t) {
            threshold = t;
        }
    }
    const slabs = getRegimeSlabs(regime, fiscalYear, userAge);
    const baseTaxAtThreshold = calculateFromSlabs(threshold, slabs);
    // Surcharge rate AT exactly the threshold limit
    let thresholdSurchargeRate = 0;
    if (threshold === 10000000) {
        thresholdSurchargeRate = 0.10;
    }
    else if (threshold === 20000000) {
        thresholdSurchargeRate = 0.15;
    }
    else if (threshold === 50000000 && regime === 'old') {
        thresholdSurchargeRate = 0.25;
    }
    const taxAtThreshold = baseTaxAtThreshold * (1 + thresholdSurchargeRate);
    // Total tax at actual income
    const totalActual = baseTax + surcharge;
    // Income gain above threshold
    const incomeGain = taxableIncome - threshold;
    // Relief: tax should not exceed tax-at-threshold + income-gain
    const maxAllowedTax = taxAtThreshold + incomeGain;
    const marginalRelief = totalActual > maxAllowedTax ? totalActual - maxAllowedTax : 0;
    return Math.round(marginalRelief);
}
/**
 * Helper to compute allowed standard and section-wise deductions and taxable income.
 */
function validateTaxContext(annualIncome, regime, incomeSource) {
    if (!Number.isFinite(annualIncome) || annualIncome < 0) {
        throw new TypeError('annualIncome must be an explicit non-negative finite number');
    }
    if (regime !== 'new' && regime !== 'old') {
        throw new TypeError('regime must be explicitly provided as new or old');
    }
    if (!['salary', 'pension', 'family_pension', 'business', 'other'].includes(incomeSource)) {
        throw new TypeError('incomeSource must be explicitly provided');
    }
}

export function calculateTaxableIncome(annualIncome, regime, deductions = {}, incomeSource, fiscalYear, explicitUserAge) {
    validateTaxContext(annualIncome, regime, incomeSource);
    const resolvedFiscalYear = fiscalYear || getCurrentFiscalYear();
    const policyRules = getTaxPolicyRules(resolvedFiscalYear);
    const deductionLimits = policyRules.deductionLimits;
    if (Number(deductions.other) > 0) {
        throw new TypeError('Unclassified deductions are not accepted; submit only a supported, explicitly named deduction.');
    }
    const userAge = requireUserAge(regime, deductions, explicitUserAge);
    let standardDeduction = 0;
    if (incomeSource === 'salary' || incomeSource === 'pension') {
        standardDeduction = policyRules.standardDeduction[incomeSource][regime];
    }
    else if (incomeSource === 'family_pension') {
        standardDeduction = Math.min(annualIncome / 3, policyRules.familyPensionDeductionLimit[regime]);
    }
    // Section 80CCD(2) - Employer NPS Contribution (available under both regimes)
    const requestedNps80CCD2 = Number(deductions.nps80CCD2 || 0);
    let nps80CCD2 = 0;
    if (requestedNps80CCD2 > 0) {
        if (!Number.isFinite(deductions.basicSalary) || deductions.basicSalary < 0
            || typeof deductions.isGovtEmployee !== 'boolean') {
            throw new TypeError('basicSalary and isGovtEmployee are required for an nps80CCD2 claim');
        }
        const nps80CCD2LimitPercent = deductions.isGovtEmployee
            ? policyRules.employerNpsLimitPct.government
            : (regime === 'new'
                ? policyRules.employerNpsLimitPct.nonGovernmentNewRegime
                : policyRules.employerNpsLimitPct.nonGovernmentOldRegime);
        nps80CCD2 = Math.min(requestedNps80CCD2, deductions.basicSalary * nps80CCD2LimitPercent);
    }
    const section80C = Math.min(deductions.section80C || 0, deductionLimits.section80C);
    const nps80CCD1B = Math.min(deductions.nps80CCD1B || deductions.section80CCD || 0, deductionLimits.section80CCD1B);
    // Section 80D Granular Self vs. Parents
    const healthOrInterestFactsPresent = Number(deductions.section80D || 0) > 0
        || Number(deductions.section80D_self || 0) > 0
        || Number(deductions.section80D_parents || 0) > 0
        || Number(deductions.savingsInterest || 0) > 0
        || Number(deductions.section80TTA || 0) > 0
        || Number(deductions.section80TTB || 0) > 0;
    if (healthOrInterestFactsPresent && userAge === null) {
        throw new TypeError('age is required for age-dependent deductions');
    }
    const age = userAge ?? 0;
    const selfSenior = age >= 60 || deductions.self_senior === true;
    const parentsSenior = deductions.parents_senior === true;
    const max80D_self = selfSenior ? deductionLimits.section80DSelfSenior : deductionLimits.section80DSelf;
    const max80D_parents = parentsSenior ? deductionLimits.section80DParentsSenior : deductionLimits.section80DParents;
    let allowed80D = 0;
    if (deductions.section80D_self !== undefined || deductions.section80D_parents !== undefined) {
        const allowed80D_self = Math.min(deductions.section80D_self || 0, max80D_self);
        const allowed80D_parents = Math.min(deductions.section80D_parents || 0, max80D_parents);
        allowed80D = allowed80D_self + allowed80D_parents;
    }
    else {
        allowed80D = Math.min(deductions.section80D || 0, deductionLimits.section80DCombined);
    }
    const hra = deductions.hra || 0;
    const homeLoanInterest = Math.min(deductions.homeLoanInterest || 0, deductionLimits.homeLoanInterest);
    const section80EEA = Math.min(deductions.section80EEA || 0, deductionLimits.section80EEA);
    const savingsInterest = deductions.savingsInterest || 0;
    let section80TTA = deductions.section80TTA || 0;
    let section80TTB = deductions.section80TTB || 0;
    if (savingsInterest > 0) {
        if (age >= 60) {
            section80TTB = Math.max(section80TTB, savingsInterest);
        }
        else {
            section80TTA = Math.max(section80TTA, savingsInterest);
        }
    }
    const allowed80TTA = age < 60 ? Math.min(section80TTA, deductionLimits.section80TTA) : 0;
    const allowed80TTB = age >= 60 ? Math.min(section80TTB, deductionLimits.section80TTB) : 0;
    const oldRegimeDeductions = regime === 'old'
        ? (section80C + nps80CCD1B + allowed80D + hra + homeLoanInterest + section80EEA + allowed80TTA + allowed80TTB)
        : 0;
    const taxableIncome = Math.max(0, annualIncome - standardDeduction - nps80CCD2 - oldRegimeDeductions);
    return { standardDeduction, oldRegimeDeductions, taxableIncome, nps80CCD2, allowed80D, userAge };
}
/**
 * Compute full tax breakdown for a given annual income.
 */
export function computeTax(annualIncome, regime, deductions = {}, incomeSource, fiscalYear, explicitUserAge) {
    validateTaxContext(annualIncome, regime, incomeSource);
    const policyRules = getTaxPolicyRules(fiscalYear);
    const { standardDeduction, oldRegimeDeductions, taxableIncome, nps80CCD2, allowed80D, userAge } = calculateTaxableIncome(
        annualIncome,
        regime,
        deductions,
        incomeSource,
        fiscalYear,
        explicitUserAge,
    );
    const slabs = getRegimeSlabs(regime, fiscalYear, userAge);
    let taxBeforeCess = calculateFromSlabs(taxableIncome, slabs);
    let rebateApplied = false;
    let marginalReliefApplied = false;
    let marginalReliefAmount87A = 0;
    const rebateLimit = regime === 'new'
        ? policyRules.newRegime87ALimit
        : policyRules.oldRegime87ALimit;
    const rebateMaximum = regime === 'new'
        ? policyRules.newRegime87ARebate
        : policyRules.oldRegime87ARebate;
    if (taxableIncome <= rebateLimit) {
        const rebate = Math.min(taxBeforeCess, rebateMaximum);
        taxBeforeCess = Math.max(0, taxBeforeCess - rebate);
        rebateApplied = rebate > 0;
    }
    else if (regime === 'new') {
        // Section 87A Proviso (Marginal relief under Section 115BAC):
        // Tax payable shall not exceed the amount by which total income exceeds rebate limit
        const excessOverLimit = taxableIncome - rebateLimit;
        if (taxBeforeCess > excessOverLimit) {
            marginalReliefAmount87A = taxBeforeCess - excessOverLimit;
            taxBeforeCess = excessOverLimit;
            marginalReliefApplied = true;
        }
    }
    const surcharge = computeSurcharge(taxBeforeCess, taxableIncome, regime);
    const relief = computeMarginalRelief(taxBeforeCess, surcharge, taxableIncome, regime, fiscalYear, userAge);
    const taxAfterSurcharge = taxBeforeCess + surcharge - relief;
    // 4% Health & Education Cess (applied on tax + surcharge)
    const cess = taxAfterSurcharge * policyRules.healthAndEducationCessRate;
    const taxAmount = taxAfterSurcharge + cess;
    const effectiveRate = annualIncome > 0
        ? parseFloat(((taxAmount / annualIncome) * 100).toFixed(2))
        : 0;
    const policy = getTaxPolicyMetadata(fiscalYear);
    const rulesApplied = [
        `${regime.toUpperCase()}_REGIME_SLABS`,
        rebateApplied ? 'SECTION_87A_REBATE' : null,
        (marginalReliefApplied || relief > 0) ? 'MARGINAL_RELIEF' : null,
        surcharge > 0 ? 'SURCHARGE' : null,
        regime === 'old' ? `OLD_REGIME_${getOldRegimeAgeBand(userAge).toUpperCase()}_SLABS` : null,
        incomeSource === 'family_pension' ? 'FAMILY_PENSION_VERSIONED_DEDUCTION' : null,
        standardDeduction > 0 ? 'STANDARD_DEDUCTION' : null,
        oldRegimeDeductions > 0 ? 'OLD_REGIME_DEDUCTIONS' : null,
        allowed80D > 0 ? 'HEALTH_INSURANCE_DEDUCTION' : null,
        Number(deductions.homeLoanInterest) > 0 ? 'HOUSING_INTEREST_DEDUCTION' : null,
        Number(deductions.savingsInterest) > 0 || Number(deductions.section80TTA) > 0 || Number(deductions.section80TTB) > 0
            ? 'SAVINGS_INTEREST_DEDUCTION' : null,
        nps80CCD2 > 0 ? 'SECTION_80CCD_2_VERSIONED_LIMIT' : null,
        'HEALTH_AND_EDUCATION_CESS',
    ].filter(Boolean);
    const taxRuleMetadata = buildTaxRuleMetadata({ statuteMetadata: policy.statuteMetadata, identifiers: rulesApplied });
    return {
        taxAmount: Math.round(taxAmount),
        effectiveRate,
        regime,
        rebateApplied,
        marginalReliefApplied: marginalReliefApplied || relief > 0,
        marginalReliefAmount: Math.round(relief + marginalReliefAmount87A),
        surchargeApplied: surcharge > 0,
        surchargeAmount: Math.round(surcharge),
        cess: Math.round(cess),
        taxBeforeCess: Math.round(taxBeforeCess),
        taxableIncome,
        annualIncome,
        standardDeduction,
        oldRegimeDeductions,
        nps80CCD2,
        allowed80D,
        userAge,
        fiscalYear,
        policyVersion: policy.policyVersion,
        statuteMetadata: policy.statuteMetadata,
        sourceReferences: policy.sourceReferences,
        inputsUsed: {
            annualIncome,
            regime,
            incomeSource,
            userAge,
            fiscalYear,
            deductions: { ...deductions },
        },
        rulesApplied: taxRuleMetadata?.rulesApplied || rulesApplied,
        taxRuleMetadata,
        assumptions: [],
        unavailableReasons: [],
    };
}

function getSpecialRateSurchargeRate(totalTaxableIncome) {
    if (totalTaxableIncome <= 5000000) return 0;
    if (totalTaxableIncome <= 10000000) return 0.10;
    return 0.15;
}

/**
 * Compute a qualified equity capital-gains bucket without applying ordinary
 * slab tax or Section 87A to the special-rate gain. This is intentionally
 * separate from computeTax: product capital gains must never be folded into
 * ordinary salary/business income by accident.
 *
 * For combined taxable income above ₹50 lakh, the current product contract
 * fails closed because surcharge marginal-relief interaction requires the
 * taxpayer's complete special-rate return context and cannot be inferred from
 * a product comparison card.
 */
export function computeCapitalGainsTaxBuckets({
    shortTerm111AGain = 0,
    longTerm112AGain = 0,
    longTermOtherGain = 0,
    annualIncome,
    regime,
    deductions = {},
    incomeSource,
    fiscalYear,
    userAge,
    section112AExemptionUsed,
    section112AExemptionAppliedOverride = null,
}) {
    for (const [name, value] of Object.entries({ shortTerm111AGain, longTerm112AGain, longTermOtherGain })) {
        if (!Number.isFinite(value) || value < 0) {
            throw new TypeError(`${name} must be an explicit non-negative finite number`);
        }
    }
    if (!Number.isFinite(section112AExemptionUsed) || section112AExemptionUsed < 0) {
        throw new TypeError('section112AExemptionUsed must be an explicit non-negative finite number');
    }
    if (section112AExemptionAppliedOverride !== null
        && (!Number.isFinite(section112AExemptionAppliedOverride) || section112AExemptionAppliedOverride < 0)) {
        throw new TypeError('section112AExemptionAppliedOverride must be an explicit non-negative finite number when supplied');
    }
    validateTaxContext(annualIncome, regime, incomeSource);
    const policy = getTaxPolicyMetadata(fiscalYear);
    const policyRules = getTaxPolicyRules(fiscalYear);
    const ordinary = calculateTaxableIncome(annualIncome, regime, deductions, incomeSource, fiscalYear, userAge);
    const totalGain = shortTerm111AGain + longTerm112AGain + longTermOtherGain;
    const combinedTaxableIncome = ordinary.taxableIncome + totalGain;

    if (combinedTaxableIncome > 5000000) {
        return {
            status: 'UNAVAILABLE',
            grossGain: totalGain,
            taxableGain: null,
            exemptionApplied: null,
            taxAmount: null,
            cess: null,
            surcharge: null,
            marginalRelief: null,
            policyVersion: policy.policyVersion,
            statuteMetadata: policy.statuteMetadata,
            fiscalYear,
            userAge: ordinary.userAge,
            sourceReferences: policy.sourceReferences,
            unavailableReasons: ['SPECIAL_RATE_HIGH_INCOME_REQUIRES_FULL_TAX_CONTEXT'],
        };
    }

    const available112AExemption = Math.max(0, policyRules.capitalGains112AExemption - section112AExemptionUsed);
    if (section112AExemptionAppliedOverride !== null && section112AExemptionAppliedOverride > available112AExemption) {
        throw new RangeError('section112AExemptionAppliedOverride exceeds the remaining fiscal-year policy exemption');
    }
    const exemptionApplied = section112AExemptionAppliedOverride === null
        ? Math.min(longTerm112AGain, available112AExemption)
        : Math.min(longTerm112AGain, section112AExemptionAppliedOverride);
    const taxable112A = Math.max(0, longTerm112AGain - exemptionApplied);
    const taxableGain = shortTerm111AGain + taxable112A + longTermOtherGain;

    // Resident individuals/HUFs may use unused basic-exemption headroom
    // against taxable special-rate gains: Sections 111A/112/112A for
    // FY2025-26 and Sections 196/197/198 for FY2026-27. Residency is not
    // collected by this product, so fail closed only when a taxable gain
    // remains and that interaction could change the result.
    const maximumNotChargeable = getRegimeSlabs(regime, fiscalYear, ordinary.userAge)[0]?.max;
    const unusedBasicExemption = Number.isFinite(maximumNotChargeable)
        ? Math.max(0, maximumNotChargeable - ordinary.taxableIncome)
        : 0;
    if (taxableGain > 0 && unusedBasicExemption > 0) {
        return {
            status: 'UNAVAILABLE',
            grossGain: totalGain,
            taxableGain: null,
            taxable112A: null,
            exemptionApplied: null,
            taxAmount: null,
            cess: null,
            surcharge: null,
            marginalRelief: null,
            policyVersion: policy.policyVersion,
            statuteMetadata: policy.statuteMetadata,
            fiscalYear,
            userAge: ordinary.userAge,
            sourceReferences: policy.sourceReferences,
            unavailableReasons: ['TAX_RESIDENCY_REQUIRED_FOR_BASIC_EXEMPTION_INTERACTION'],
        };
    }

    const taxBeforeSurcharge = (shortTerm111AGain * policyRules.capitalGains111ARate)
        + (taxable112A * policyRules.capitalGains112ARate)
        + (longTermOtherGain * policyRules.capitalGains112ARate);
    const surchargeRate = Math.min(getSpecialRateSurchargeRate(combinedTaxableIncome), policyRules.specialRateSurchargeCap);
    const surcharge = taxBeforeSurcharge * surchargeRate;
    const taxAfterSurcharge = taxBeforeSurcharge + surcharge;
    const cess = taxAfterSurcharge * policyRules.healthAndEducationCessRate;
    const taxAmount = Math.round(taxAfterSurcharge + cess);
    const rawRulesApplied = [];
    if (shortTerm111AGain > 0) rawRulesApplied.push('SECTION_111A_STCG_SPECIAL_RATE');
    if (longTerm112AGain > 0) rawRulesApplied.push('SECTION_112A_LTCG_SPECIAL_RATE');
    if (longTermOtherGain > 0) rawRulesApplied.push('SECTION_112_LTCG_SPECIAL_RATE');
    if (exemptionApplied > 0) rawRulesApplied.push('SECTION_112A_ANNUAL_EXEMPTION');
    if (surcharge > 0) rawRulesApplied.push('SPECIAL_RATE_SURCHARGE_CAPPED_AT_15_PERCENT');
    rawRulesApplied.push('SPECIAL_RATE_INCOME_EXCLUDED_FROM_87A_REBATE', 'HEALTH_AND_EDUCATION_CESS');
    const taxRuleMetadata = buildTaxRuleMetadata({ statuteMetadata: policy.statuteMetadata, identifiers: rawRulesApplied });
    const rulesApplied = taxRuleMetadata?.rulesApplied || rawRulesApplied;

    return {
        status: 'CALCULATED',
        grossGain: totalGain,
        taxableGain,
        taxable112A,
        exemptionApplied,
        taxAmount,
        cess: Math.round(cess),
        surcharge: Math.round(surcharge),
        surchargeRate,
        marginalRelief: 0,
        rebateApplied: false,
        rate: totalGain > 0 ? taxBeforeSurcharge / Math.max(1, taxableGain) : 0,
        holdingPeriodBasis: 'EXPLICIT_TAX_BUCKETS',
        fiscalYear,
        policyVersion: policy.policyVersion,
        statuteMetadata: policy.statuteMetadata,
        taxRuleMetadata,
        userAge: ordinary.userAge,
        sourceReferences: policy.sourceReferences,
        rulesApplied,
        unavailableReasons: [],
    };
}

export function computeEquityCapitalGainsTax({
    grossGain,
    holdingPeriodMonths,
    annualIncome,
    regime,
    deductions = {},
    incomeSource,
    fiscalYear,
    userAge,
    section112AExemptionUsed,
    holdingPeriodClassification = null,
    section112AExemptionAppliedOverride = null,
}) {
    if (!Number.isFinite(grossGain) || grossGain < 0) {
        throw new TypeError('grossGain must be an explicit non-negative finite number');
    }
    if (holdingPeriodClassification === null
        && (!Number.isFinite(holdingPeriodMonths) || holdingPeriodMonths < 0)) {
        throw new TypeError('holdingPeriodMonths must be an explicit non-negative finite number');
    }
    if (!Number.isFinite(section112AExemptionUsed) || section112AExemptionUsed < 0) {
        throw new TypeError('section112AExemptionUsed must be an explicit non-negative finite number');
    }
    if (holdingPeriodClassification !== null
        && typeof holdingPeriodClassification.isLongTerm !== 'boolean') {
        throw new TypeError('holdingPeriodClassification.isLongTerm must be explicit when supplied');
    }
    const isLongTerm = holdingPeriodClassification?.isLongTerm
        ?? (holdingPeriodMonths > getCapitalGainsHoldingPeriodMonths(fiscalYear, 'listed'));
    const result = computeCapitalGainsTaxBuckets({
        shortTerm111AGain: isLongTerm ? 0 : grossGain,
        longTerm112AGain: isLongTerm ? grossGain : 0,
        annualIncome,
        regime,
        deductions,
        incomeSource,
        fiscalYear,
        userAge,
        section112AExemptionUsed,
        section112AExemptionAppliedOverride,
    });
    return {
        ...result,
        taxClass: isLongTerm ? 'EQUITY_LTCG_SECTION_112A' : 'EQUITY_STCG_SECTION_111A',
        taxClassificationMetadata: buildTaxRuleMetadata({
            statuteMetadata: result.statuteMetadata,
            identifiers: result.rulesApplied,
            taxClass: isLongTerm ? 'EQUITY_LTCG_SECTION_112A' : 'EQUITY_STCG_SECTION_111A',
        }),
    };
}
/**
 * Compute tax with deductions (convenience wrapper/alias).
 */
export function computeTaxWithDeductions(annualIncome, regime, deductions = {}, incomeSource, fiscalYear, userAge) {
    return computeTax(annualIncome, regime, deductions, incomeSource, fiscalYear, userAge);
}
/**
 * Get the marginal (highest applicable) tax slab percentage.
 */
export function getTaxSlab(annualIncome, regime, deductions = {}, incomeSource, fiscalYear, userAge) {
    validateTaxContext(annualIncome, regime, incomeSource);
    const { taxableIncome, userAge: resolvedUserAge } = calculateTaxableIncome(
        annualIncome,
        regime,
        deductions,
        incomeSource,
        fiscalYear,
        userAge,
    );
    const slabs = getRegimeSlabs(regime, fiscalYear, resolvedUserAge);
    let marginalRate = 0;
    for (const slab of slabs) {
        if (taxableIncome > slab.min) {
            marginalRate = slab.rate;
        }
    }
    return marginalRate;
}
/**
 * Compare both regimes and return the better one.
 */
export function compareTaxRegimes(annualIncome, deductions = {}, incomeSource, fiscalYear, userAge) {
    if (!Number.isFinite(annualIncome) || annualIncome < 0) {
        throw new TypeError('annualIncome must be an explicit non-negative finite number');
    }
    if (!['salary', 'pension', 'family_pension', 'business', 'other'].includes(incomeSource)) {
        throw new TypeError('incomeSource must be explicitly provided');
    }
    const newRegime = computeTax(annualIncome, 'new', deductions, incomeSource, fiscalYear, userAge);
    const oldRegime = computeTax(annualIncome, 'old', deductions, incomeSource, fiscalYear, userAge);
    const recommended = newRegime.taxAmount <= oldRegime.taxAmount ? 'new' : 'old';
    return { newRegime, oldRegime, recommended };
}

function formatSlabLabel(slab) {
    const formatLakhs = value => {
        const lakhs = value / 100000;
        return Number.isInteger(lakhs) ? `${lakhs}L` : `${lakhs.toFixed(1)}L`;
    };
    if (!Number.isFinite(slab.max)) return `Above ₹${formatLakhs(slab.min)}`;
    return `₹${formatLakhs(slab.min)} - ₹${formatLakhs(slab.max)}`;
}

/**
 * Presentation-ready slab rows derived from the same verified policy table and
 * computed liability used by computeTax. This prevents the browser from
 * maintaining a second, potentially stale tax engine.
 */
export function buildTaxSlabBreakdown(computation, fiscalYear) {
    if (!computation || !Number.isFinite(computation.taxableIncome)) {
        throw new TypeError('A completed tax computation is required');
    }
    const slabs = getRegimeSlabs(computation.regime, fiscalYear, computation.userAge);
    const rows = [];
    let baseTax = 0;

    for (const slab of slabs) {
        if (computation.taxableIncome <= slab.min) break;
        const taxableInSlab = Math.max(0, Math.min(computation.taxableIncome, slab.max) - slab.min);
        if (taxableInSlab <= 0) continue;
        const taxInSlab = Math.round(taxableInSlab * slab.rate);
        baseTax += taxInSlab;
        rows.push({
            label: formatSlabLabel(slab),
            rate: slab.rate * 100,
            taxableInSlab: Math.round(taxableInSlab),
            taxInSlab,
        });
    }

    if (computation.rebateApplied && baseTax > 0) {
        rows.push({
            label: 'Government tax rebate under the selected fiscal-year policy',
            rate: '',
            taxableInSlab: 0,
            taxInSlab: -baseTax,
            isRebateRow: true,
        });
    }

    rows.push({
        label: 'Your Total Tax',
        rate: '',
        taxableInSlab: Math.round(computation.taxableIncome),
        taxInSlab: computation.taxAmount,
        isTotalRow: true,
    });
    return rows;
}

/**
 * Computes the old-regime outcome after filling only the remaining 80C and
 * 80CCD(1B) room. No product or suitability recommendation is made here.
 */
export function analyzeTaxOptimization(annualIncome, deductions = {}, incomeSource, fiscalYear, userAge) {
    validateTaxContext(annualIncome, 'old', incomeSource);
    const policyRules = getTaxPolicyRules(fiscalYear || getCurrentFiscalYear());
    const limits = policyRules.deductionLimits;
    const section80C = Math.min(Number(deductions.section80C) || 0, limits.section80C);
    const nps80CCD1B = Math.min(Number(deductions.nps80CCD1B ?? deductions.section80CCD) || 0, limits.section80CCD1B);
    const age = Number.isInteger(deductions.age) ? deductions.age : null;
    const parentsSeniorKnown = typeof deductions.parents_senior === 'boolean';
    const parentsSenior = deductions.parents_senior === true;
    const deductionLimits = {
        section80C: limits.section80C,
        section80CCD1B: limits.section80CCD1B,
        section80DSelf: age !== null && age >= 60
            ? limits.section80DSelfSenior
            : limits.section80DSelf,
        section80DParents: parentsSeniorKnown
            ? (parentsSenior
                ? limits.section80DParentsSenior
                : limits.section80DParents)
            : null,
    };
    const remaining = {
        section80C: Math.max(0, deductionLimits.section80C - section80C),
        section80CCD1B: Math.max(0, deductionLimits.section80CCD1B - nps80CCD1B),
    };
    const currentOld = computeTax(annualIncome, 'old', deductions, incomeSource, fiscalYear, userAge);
    const optimizedDeductions = {
        ...deductions,
        section80C: deductionLimits.section80C,
        nps80CCD1B: deductionLimits.section80CCD1B,
    };
    const optimizedOld = computeTax(annualIncome, 'old', optimizedDeductions, incomeSource, fiscalYear, userAge);
    const newRegime = computeTax(annualIncome, 'new', deductions, incomeSource, fiscalYear, userAge);

    let crossoverBreakpoint = null;
    const currentRelevantDeductions = section80C + nps80CCD1B;
    const availableAdditional = remaining.section80C + remaining.section80CCD1B;
    if (currentOld.taxAmount <= newRegime.taxAmount) {
        crossoverBreakpoint = currentRelevantDeductions;
    } else if (optimizedOld.taxAmount <= newRegime.taxAmount && availableAdditional > 0) {
        let low = 0;
        let high = availableAdditional;
        while (low < high) {
            const additional = Math.floor((low + high) / 2);
            const add80C = Math.min(remaining.section80C, additional);
            const addNps = Math.min(remaining.section80CCD1B, Math.max(0, additional - add80C));
            const candidate = computeTax(annualIncome, 'old', {
                ...deductions,
                section80C: section80C + add80C,
                nps80CCD1B: nps80CCD1B + addNps,
            }, incomeSource, fiscalYear, userAge);
            if (candidate.taxAmount <= newRegime.taxAmount) high = additional;
            else low = additional + 1;
        }
        crossoverBreakpoint = currentRelevantDeductions + low;
    }

    return {
        deductionLimits,
        remaining,
        optimizedOld,
        potentialSaving: Math.max(0, currentOld.taxAmount - optimizedOld.taxAmount),
        crossoverBreakpoint,
    };
}
/**
 * Get the effective marginal tax rate (slab + surcharge + cess) for a given income level.
 * Useful for post-tax drag adjustments on future returns.
 */
export function getEffectiveMarginalRate(annualIncome, regime, deductions = {}, incomeSource, fiscalYear, userAge) {
    validateTaxContext(annualIncome, regime, incomeSource);
    // WG-040: If actual liability at this income is already ₹0 (inside a Section 87A
    // rebate zone), report 0 directly. A finite-difference window straddling the rebate
    // cliff otherwise produces a spurious, ceiling-clamped rate (up to 0.45) for someone
    // who owes no tax at all.
    const actualTax = computeTax(annualIncome, regime, deductions, incomeSource, fiscalYear, userAge).taxAmount;
    if (actualTax === 0) return 0;

    const delta = 10000;
    const highIncome = annualIncome + delta;
    const lowIncome = Math.max(0, annualIncome - delta);
    const highRes = computeTax(highIncome, regime, deductions, incomeSource, fiscalYear, userAge);
    const lowRes = computeTax(lowIncome, regime, deductions, incomeSource, fiscalYear, userAge);
    const deltaIncome = highIncome - lowIncome;
    if (deltaIncome <= 0)
        return 0;
    const deltaTax = highRes.taxAmount - lowRes.taxAmount;
    const effectiveMarginal = deltaTax / deltaIncome;
    return parseFloat(Math.max(0, Math.min(effectiveMarginal, 0.45)).toFixed(4));
}
