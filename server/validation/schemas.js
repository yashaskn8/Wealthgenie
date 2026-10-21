import Joi from 'joi';
import { sendError } from '../middleware/errorHandler.js';
import {
  FISCAL_YEAR_PATTERN,
  incomeSourceValues,
  requirePostTaxDependencyFacts,
  requireTaxDependencyFacts,
  taxDeductionFields,
  taxDeductionSchema,
} from './taxSchemas.js';

/**
 * Validation for non-Financial-Profile APIs.
 * Profile, recommendation, WTI, portfolio, projection, Monte Carlo, and goal
 * schemas live in financialSchemas.js so legacy fields cannot re-enter those paths.
 */
export const registerSchema = Joi.object({
  name: Joi.string().trim().min(2).max(100).required(),
  email: Joi.string().trim().lowercase().email().max(254).required(),
  mobile: Joi.string().trim().pattern(/^[6-9]\d{9}$/).optional(),
  password: Joi.string().min(8).max(128).required()
    .pattern(/[A-Z]/, 'uppercase')
    .pattern(/[a-z]/, 'lowercase')
    .pattern(/[0-9]/, 'digit')
    .pattern(/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/, 'special character'),
}).unknown(false);

export const loginSchema = Joi.object({
  email: Joi.string().trim().lowercase().email().required(),
  password: Joi.string().min(1).required(),
}).unknown(false);

const taxFields = {
  income: Joi.number().min(0).max(1000000000).required(),
  incomeSource: Joi.string().valid(...incomeSourceValues).required(),
  ...taxDeductionFields,
  fiscalYear: Joi.string().pattern(FISCAL_YEAR_PATTERN).required(),
};

export const taxCompareSchema = Joi.object(taxFields).custom(requireTaxDependencyFacts).unknown(false);
export const taxComputeSchema = Joi.object({
  ...taxFields,
  regime: Joi.string().valid('new', 'old').required(),
}).custom(requireTaxDependencyFacts).unknown(false);

const transactionDateFields = {
  acquisitionDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
  redemptionDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional(),
};

function validatePostTaxTransactionDates(value, helpers) {
  const hasAcquisition = value.acquisitionDate !== undefined;
  const hasRedemption = value.redemptionDate !== undefined;
  if (hasAcquisition !== hasRedemption) {
    return helpers.message({ custom: 'acquisitionDate and redemptionDate must be supplied together' });
  }
  if (hasAcquisition && value.redemptionDate < value.acquisitionDate) {
    return helpers.message({ custom: 'redemptionDate cannot precede acquisitionDate' });
  }
  for (const [key, dateValue] of [['acquisitionDate', value.acquisitionDate], ['redemptionDate', value.redemptionDate]]) {
    if (dateValue === undefined) continue;
    const [year, month, day] = dateValue.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
      return helpers.message({ custom: `${key} must be a real calendar date` });
    }
  }
  return value;
}

const postTaxInstrumentSchema = Joi.object({
  instrumentType: Joi.string().trim().min(1).max(50).required(),
  nominalRate: Joi.number().min(0).max(1).required(),
  holdingYears: Joi.number().min(0.01).max(100).required(),
  monthlySIP: Joi.number().min(0).max(100000000).required(),
  ...transactionDateFields,
  redemptionChannel: Joi.string().valid('RBI_REDEMPTION', 'MATURITY_REDEMPTION', 'SECONDARY_MARKET_SALE').optional(),
  acquiredAtOriginalIssue: Joi.boolean().optional(),
  heldContinuously: Joi.boolean().optional(),
  couponRate: Joi.number().min(0).max(1).optional(),
  annuityFraction: Joi.number().min(0).max(1).optional(),
  retirementTiming: Joi.string().trim().min(2).max(100).optional(),
}).custom(validatePostTaxTransactionDates).unknown(false);

export const postTaxReturnSchema = postTaxInstrumentSchema.keys({
  annualIncome: Joi.number().min(0).max(1000000000).required(),
  regime: Joi.string().valid('new', 'old').required(),
  userAge: Joi.number().integer().min(18).max(120).required(),
  incomeSource: Joi.string().valid('salary', 'pension', 'family_pension', 'business', 'other').required(),
  fiscalYear: Joi.string().pattern(FISCAL_YEAR_PATTERN).required(),
  deductions: taxDeductionSchema.optional(),
  ...transactionDateFields,
  redemptionChannel: Joi.string().valid('RBI_REDEMPTION', 'MATURITY_REDEMPTION', 'SECONDARY_MARKET_SALE').optional(),
  acquiredAtOriginalIssue: Joi.boolean().optional(),
  heldContinuously: Joi.boolean().optional(),
  couponRate: Joi.number().min(0).max(1).optional(),
  annuityFraction: Joi.number().min(0).max(1).optional(),
  retirementTiming: Joi.string().trim().min(2).max(100).optional(),
  section112AExemptionUsed: Joi.number().min(0).max(125000).optional(),
}).custom(validatePostTaxTransactionDates).custom(requirePostTaxDependencyFacts).unknown(false);

export const postTaxReturnBatchSchema = Joi.object({
  instruments: Joi.array().items(postTaxInstrumentSchema).min(1).max(50).required(),
  annualIncome: Joi.number().min(0).max(1000000000).required(),
  regime: Joi.string().valid('new', 'old').required(),
  userAge: Joi.number().integer().min(18).max(120).required(),
  incomeSource: Joi.string().valid('salary', 'pension', 'family_pension', 'business', 'other').required(),
  inflationRate: Joi.number().min(0).max(1).required(),
  fiscalYear: Joi.string().pattern(FISCAL_YEAR_PATTERN).required(),
  deductions: taxDeductionSchema.optional(),
  section112AExemptionUsed: Joi.number().min(0).max(125000).optional(),
}).custom(requirePostTaxDependencyFacts).unknown(false);

const userDeclaredScenarioInstrumentIds = ['fd', 'sbi_fd', 'rbi_bonds', 'sgb', 'nifty_etf'];
export const userDeclaredPostTaxScenarioSchema = Joi.object({
  canonicalInstrumentId: Joi.string().valid(...userDeclaredScenarioInstrumentIds).required(),
  scenarioType: Joi.string().valid('INTEREST_INCOME', 'EQUITY_REALIZED_GAIN').required(),
  canonicalProductId: Joi.when('canonicalInstrumentId', {
    is: 'nifty_etf', then: Joi.string().valid('etf:isin:INF204KB14I2').required(), otherwise: Joi.forbidden(),
  }),
  interestReceived: Joi.number().min(0).max(1000000000).when('scenarioType', {
    is: 'INTEREST_INCOME', then: Joi.required(), otherwise: Joi.forbidden(),
  }),
  acquisitionCostBasis: Joi.number().greater(0).max(1000000000).when('scenarioType', {
    is: 'EQUITY_REALIZED_GAIN', then: Joi.required(), otherwise: Joi.forbidden(),
  }),
  saleProceeds: Joi.number().min(0).max(1000000000).when('scenarioType', {
    is: 'EQUITY_REALIZED_GAIN', then: Joi.required(), otherwise: Joi.forbidden(),
  }),
  acquisitionDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).when('scenarioType', {
    is: 'EQUITY_REALIZED_GAIN', then: Joi.required(), otherwise: Joi.forbidden(),
  }),
  redemptionDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).when('scenarioType', {
    is: 'EQUITY_REALIZED_GAIN', then: Joi.required(), otherwise: Joi.forbidden(),
  }),
  section112AExemptionUsed: Joi.number().min(0).max(125000).when('scenarioType', {
    is: 'EQUITY_REALIZED_GAIN', then: Joi.required(), otherwise: Joi.forbidden(),
  }),
  sttConditionAssumedSatisfied: Joi.boolean().strict().when('scenarioType', {
    is: 'EQUITY_REALIZED_GAIN', then: Joi.required(), otherwise: Joi.forbidden(),
  }),
  annualGrossIncome: Joi.number().min(0).max(1000000000).required(),
  incomeSource: Joi.string().valid(...incomeSourceValues).required(),
  regime: Joi.string().valid('new', 'old').required(),
  fiscalYear: Joi.string().pattern(FISCAL_YEAR_PATTERN).required(),
  userAge: Joi.number().integer().min(18).max(120).required(),
  deductions: taxDeductionSchema.optional(),
}).custom((value, helpers) => {
  if (value.scenarioType === 'INTEREST_INCOME'
      && !['fd', 'sbi_fd', 'rbi_bonds', 'sgb'].includes(value.canonicalInstrumentId)) {
    return helpers.message({ custom: 'This investment does not have a qualified user-declared interest-tax scenario.' });
  }
  if (value.scenarioType === 'EQUITY_REALIZED_GAIN' && value.canonicalInstrumentId !== 'nifty_etf') {
    return helpers.message({ custom: 'An exact qualified product identity is required for this capital-gain scenario.' });
  }
  return validatePostTaxTransactionDates(value, helpers);
}).custom(requirePostTaxDependencyFacts).unknown(false);

export const marketContextQuerySchema = Joi.object({}).unknown(false);

export const marketNavQuerySchema = Joi.object({
  schemeCodes: Joi.string()
    .trim()
    .pattern(/^\d+(,\d+){0,49}$/)
    .max(600)
    .required(),
}).unknown(false);

// Canonical IDs only: instrument keys and arbitrary provider URLs never enter
// the public market-data request contract.
export const marketQuoteQuerySchema = Joi.object({
  ids: Joi.string()
    .trim()
    .pattern(/^[a-z0-9:-]+(?:,[a-z0-9:-]+){0,9}$/)
    .max(500)
    .required(),
}).unknown(false);

const marketHistoryIsoDate = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).custom((value, helpers) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    return helpers.error('date.base');
  }
  return value;
}, 'valid calendar date');

export const marketEquityHistoryQuerySchema = Joi.object({
  exchange: Joi.string().trim().uppercase().valid('NSE', 'BSE').required(),
  symbol: Joi.string().trim().uppercase().pattern(/^[A-Z0-9][A-Z0-9&-]{0,29}$/).required(),
  isin: Joi.string().trim().uppercase().pattern(/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/).required(),
  fromDate: marketHistoryIsoDate.required(),
  toDate: marketHistoryIsoDate.required(),
  basis: Joi.string().trim().uppercase().valid('RAW').default('RAW'),
}).custom((value, helpers) => value.fromDate <= value.toDate
  ? value
  : helpers.error('date.order'), 'ordered market-history range').unknown(false);

export const marketEquityIdentityQuerySchema = Joi.object({
  exchange: Joi.string().trim().uppercase().valid('NSE', 'BSE').required(),
  symbol: Joi.string().trim().uppercase().pattern(/^[A-Z0-9][A-Z0-9&-]{0,29}$/).required(),
  isin: Joi.string().trim().uppercase().pattern(/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/).required(),
}).unknown(false);

const boundedIntegerQuery = (min, max) => Joi.string()
  .pattern(/^(0|[1-9]\d*)$/)
  .custom((value, helpers) => Number(value) >= min && Number(value) <= max
    ? value
    : helpers.error('number.range', { limit: max }))
  .optional();

export const instrumentListQuerySchema = Joi.object({
  type: Joi.string().valid('FD', 'Mutual_Fund', 'ETF', 'Government', 'ELSS').optional(),
  category: Joi.string().trim().min(1).max(100).pattern(/^[^\x00-\x1f\x7f]+$/).optional(),
  subCategory: Joi.string().trim().min(1).max(100).pattern(/^[^\x00-\x1f\x7f]+$/).optional(),
  sort: Joi.string().valid('name', 'interestRate', 'rate', 'returns1yr', 'returns3yr', 'returns5yr', 'riskLevel', 'aumCr', 'expenseRatio').optional(),
  order: Joi.string().valid('asc', 'desc').optional(),
  limit: boundedIntegerQuery(1, 100),
  page: boundedIntegerQuery(1, 100000),
}).unknown(false);

const queryInteger = (minimum, maximum) => Joi.string()
  .pattern(/^(0|[1-9]\d*)$/)
  .custom((value, helpers) => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
      ? value
      : helpers.error('any.invalid');
  });

export const recommendationCurrentQuerySchema = Joi.object({
  profileId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required(),
}).unknown(false);

export const recommendationAuditQuerySchema = Joi.object({
  profileId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).optional(),
  limit: queryInteger(1, 100).optional(),
  skip: queryInteger(0, 10000000).optional(),
  correlationId: Joi.string().pattern(/^[A-Za-z0-9._:-]{1,128}$/).optional(),
}).unknown(false);

const sessionIdSchema = Joi.string().pattern(/^[A-Za-z0-9._:-]{1,100}$/);
export const chatMessageSchema = Joi.object({
  message: Joi.string().trim().min(1).max(1000).required(),
  session_id: sessionIdSchema.optional(),
}).unknown(false);

export const chatHistoryQuerySchema = Joi.object({
  session_id: sessionIdSchema.optional(),
  limit: queryInteger(1, 200).optional(),
}).unknown(false);

export const agentProfileQuerySchema = Joi.object({
  profileId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required(),
}).unknown(false);

export const mandateListQuerySchema = Joi.object({
  limit: queryInteger(1, 100).optional(),
}).unknown(false);

export const planHealthEventsQuerySchema = Joi.object({
  limit: queryInteger(1, 50).optional(),
}).unknown(false);

export const regimeAdjustSchema = Joi.object({
  profileId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).message('Invalid ID format').required(),
}).unknown(false);

function createValidator(schema, property) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[property], {
      abortEarly: false,
      allowUnknown: false,
      stripUnknown: false,
      convert: true,
    });
    if (error) {
      return sendError(
        req,
        res,
        400,
        'Validation failed',
        'VALIDATION_ERROR',
        error.details.map(detail => detail.message),
      );
    }
    req[property] = value;
    next();
  };
}

export function validate(schema) {
  return createValidator(schema, 'body');
}

export function validateQuery(schema) {
  return createValidator(schema, 'query');
}
