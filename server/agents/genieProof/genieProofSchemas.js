import Joi from 'joi';

const hash = Joi.string().pattern(/^[a-f0-9]{64}$/).required();
const claimId = Joi.string().pattern(/^[a-f0-9]{32}$/).required();

export const genieProofExtractSchema = Joi.object({
  offerText: Joi.string().min(1).max(16_000).required(),
}).unknown(false);

const confirmedClaimSchema = Joi.object({
  claimId,
  statement: Joi.string().trim().min(1).max(500).required(),
  claimType: Joi.string().valid('CURRENT_NOMINAL_RATE', 'UNSUPPORTED').required(),
  productId: Joi.string().valid('government:india-post:ppf').allow(null).required(),
  value: Joi.number().min(0).max(100).allow(null).required(),
  unit: Joi.string().valid('PERCENT_PER_ANNUM', 'UNKNOWN').required(),
}).unknown(false);

export const genieProofCreateCaseSchema = Joi.object({
  offerText: Joi.string().min(1).max(16_000).required(),
  submissionHash: hash,
  confirmedClaims: Joi.array().items(confirmedClaimSchema).min(1).max(10).unique('claimId').required(),
}).unknown(false);
