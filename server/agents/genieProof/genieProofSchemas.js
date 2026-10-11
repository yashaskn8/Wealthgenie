import Joi from 'joi';

const hash = Joi.string().pattern(/^[a-f0-9]{64}$/).required();
const claimId = Joi.string().pattern(/^[a-f0-9]{32}$/).required();

export const genieProofExtractSchema = Joi.object({
  offerText: Joi.string().min(1).max(16_000).required(),
}).unknown(false);

export const genieProofConfirmedClaimSchema = Joi.object({
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
  savingConsent: Joi.boolean().valid(true).required(),
  confirmedClaims: Joi.array().items(genieProofConfirmedClaimSchema).min(1).max(10).unique('claimId').required(),
}).unknown(false);

export const genieProofReassessSchema = Joi.object({
  expectedRevision: Joi.number().integer().min(1).required(),
  expectedManifestHash: hash,
  reassessmentConsent: Joi.boolean().valid(true).required(),
}).unknown(false);

export const genieProofConsentWithdrawalSchema = Joi.object({
  withdrawConsent: Joi.boolean().valid(true).required(),
}).unknown(false);

export const proofWatchCreateSchema = Joi.object({
  watchConsent: Joi.boolean().valid(true).required(),
}).unknown(false);

export const proofWatchActionSchema = Joi.object({
  action: Joi.string().valid('pause', 'resume', 'disable').required(),
}).unknown(false);

export const proofBreakAcknowledgeSchema = Joi.object({
  acknowledge: Joi.boolean().valid(true).required(),
}).unknown(false);

export const proofBreakTimelineQuerySchema = Joi.object({
  limit: Joi.number().integer().min(1).max(50).default(25),
  cursor: Joi.string().max(256).allow(''),
}).unknown(false);
