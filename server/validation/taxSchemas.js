import Joi from 'joi';

export const FISCAL_YEAR_PATTERN = /^FY\d{4}-\d{2}$/;
export const incomeSourceValues = ['salary', 'pension', 'family_pension', 'business', 'other'];

function validCalendarDate(value, helpers) {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    return helpers.message({ custom: 'must be a valid calendar date' });
  }
  return value;
}

const dateOnlySchema = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).custom(validCalendarDate);

export const taxDeductionFields = {
  section80C: Joi.number().min(0).max(150000).optional(),
  nps80CCD1B: Joi.number().min(0).max(50000).optional(),
  section80CCD: Joi.number().min(0).max(50000).optional(),
  nps80CCD2: Joi.number().min(0).max(100000000).optional(),
  basicSalary: Joi.number().min(0).max(1000000000).optional(),
  isGovtEmployee: Joi.boolean().optional(),
  section80D: Joi.number().min(0).max(100000).optional(),
  section80D_self: Joi.number().min(0).max(50000).optional(),
  section80D_parents: Joi.number().min(0).max(50000).optional(),
  parents_senior: Joi.boolean().optional(),
  self_senior: Joi.boolean().optional(),
  hra: Joi.number().min(0).max(100000000).optional(),
  homeLoanInterest: Joi.number().min(0).max(200000).optional(),
  section80EEA: Joi.number().min(0).max(150000).optional(),
  savingsInterest: Joi.number().min(0).max(100000000).optional(),
  section80TTA: Joi.number().min(0).max(10000).optional(),
  section80TTB: Joi.number().min(0).max(50000).optional(),
  // Retain the legacy zero-valued field for older clients; positive arbitrary
  // deductions are not an identifiable statutory category and fail closed.
  other: Joi.number().valid(0).optional(),
  age: Joi.number().integer().min(18).max(120).optional(),
};

export const taxDeductionSchema = Joi.object(taxDeductionFields).unknown(false);

export function requireTaxDependencyFacts(value, helpers) {
  // Regime comparison always computes the old regime, while a single new-regime
  // request may omit age because the new slabs are age-neutral.
  if (value.regime !== 'new' && !Number.isInteger(value.age)) {
    return helpers.message({ custom: 'USER_AGE_REQUIRED_FOR_OLD_REGIME' });
  }
  if (Number(value.nps80CCD2) > 0
      && (!Number.isFinite(value.basicSalary) || typeof value.isGovtEmployee !== 'boolean')) {
    return helpers.message({ custom: 'basicSalary and isGovtEmployee are required when nps80CCD2 is claimed' });
  }
  const healthDeduction = Number(value.section80D || 0)
    + Number(value.section80D_self || 0) + Number(value.section80D_parents || 0);
  if (healthDeduction > 0 && !Number.isInteger(value.age)) {
    return helpers.message({ custom: 'age is required when a Section 80D deduction is claimed' });
  }
  if (Number(value.section80D_parents) > 0 && typeof value.parents_senior !== 'boolean') {
    return helpers.message({ custom: 'parents_senior is required when a parents Section 80D deduction is claimed' });
  }
  return value;
}

// Post-tax routes keep deductions nested and expose age/regime at the request
// level. Validate the same dependency facts before the tax engine is called so
// a missing fact cannot be silently treated as zero or as a default.
export function requirePostTaxDependencyFacts(value, helpers) {
  const deductions = value.deductions || {};
  if (value.regime === 'old' && !Number.isInteger(value.userAge)) {
    return helpers.message({ custom: 'USER_AGE_REQUIRED_FOR_OLD_REGIME' });
  }
  if (Number(deductions.nps80CCD2) > 0
      && (!Number.isFinite(deductions.basicSalary) || typeof deductions.isGovtEmployee !== 'boolean')) {
    return helpers.message({ custom: 'basicSalary and isGovtEmployee are required when nps80CCD2 is claimed' });
  }
  const healthDeduction = Number(deductions.section80D || 0)
    + Number(deductions.section80D_self || 0) + Number(deductions.section80D_parents || 0);
  if (healthDeduction > 0 && !Number.isInteger(value.userAge)) {
    return helpers.message({ custom: 'age is required when a Section 80D deduction is claimed' });
  }
  if (Number(deductions.section80D_parents) > 0 && typeof deductions.parents_senior !== 'boolean') {
    return helpers.message({ custom: 'parents_senior is required when a parents Section 80D deduction is claimed' });
  }
  return value;
}

export const taxFields = {
  income: Joi.number().min(0).max(1000000000).required(),
  incomeSource: Joi.string().valid(...incomeSourceValues).required(),
  ...taxDeductionFields,
  fiscalYear: Joi.string().pattern(FISCAL_YEAR_PATTERN).required(),
};

export const taxCalculationContextSchema = Joi.object({
  fiscalYear: Joi.string().pattern(FISCAL_YEAR_PATTERN).optional(),
  incomeSource: Joi.string().valid(...incomeSourceValues).optional(),
  annualGrossIncome: Joi.number().min(0).max(1000000000).optional(),
  regime: Joi.string().valid('new', 'old').optional(),
  userAge: Joi.number().integer().min(18).max(120).optional(),
  deductions: taxDeductionSchema.optional(),
  illustrativePrincipal: Joi.number().greater(0).max(1000000000).optional(),
  holdingPeriodMonths: Joi.number().min(0).max(1200).optional(),
  section112AExemptionUsed: Joi.number().min(0).max(125000).optional(),
  sttConditionAssumedSatisfied: Joi.boolean().strict().optional(),
  acquisitionDate: dateOnlySchema.optional(),
  redemptionDate: dateOnlySchema.optional(),
  redemptionChannel: Joi.string().valid('RBI_REDEMPTION', 'MATURITY_REDEMPTION', 'SECONDARY_MARKET_SALE').optional(),
  acquiredAtOriginalIssue: Joi.boolean().optional(),
  heldContinuously: Joi.boolean().optional(),
  couponRate: Joi.number().min(0).max(1).optional(),
  annuityFraction: Joi.number().min(0).max(1).optional(),
  retirementTiming: Joi.string().trim().min(2).max(100).optional(),
}).custom((value, helpers) => {
  const taxKeys = ['annualGrossIncome', 'incomeSource', 'regime', 'fiscalYear', 'deductions', 'userAge'];
  const hasTaxContext = taxKeys.some(key => value[key] !== undefined);
  if (!hasTaxContext) return value;
  const missing = ['annualGrossIncome', 'incomeSource', 'regime', 'fiscalYear']
    .filter(key => value[key] === undefined);
  if (missing.length > 0) {
    return helpers.message({ custom: `taxCalculationContext requires: ${missing.join(', ')}` });
  }
  if (value.regime === 'old' && !Number.isInteger(value.userAge)) {
    return helpers.message({ custom: 'USER_AGE_REQUIRED_FOR_OLD_REGIME' });
  }
  if ((value.acquisitionDate === undefined) !== (value.redemptionDate === undefined)) {
    return helpers.message({ custom: 'acquisitionDate and redemptionDate must be supplied together' });
  }
  if (value.acquisitionDate && value.redemptionDate && value.redemptionDate < value.acquisitionDate) {
    return helpers.message({ custom: 'redemptionDate cannot precede acquisitionDate' });
  }
  for (const [key, dateValue] of [['acquisitionDate', value.acquisitionDate], ['redemptionDate', value.redemptionDate]]) {
    if (dateValue === undefined) continue;
    const [year, month, day] = dateValue.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
      return helpers.message({ custom: key + ' must be a real calendar date' });
    }
  }
  return requirePostTaxDependencyFacts(value, helpers);
}).unknown(false);
