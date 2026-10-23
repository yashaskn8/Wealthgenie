import Joi from 'joi';
import { GENIEPROOF_MAX_SUBMISSION_BYTES } from './genieProofCore.js';

const hash = Joi.string().pattern(/^[a-f0-9]{64}$/).required();
const claimId = Joi.string().pattern(/^[a-f0-9]{32}$/).required();
const offerText = Joi.string().min(1).max(16_000).custom((value, helpers) => (
  Buffer.byteLength(value, 'utf8') > GENIEPROOF_MAX_SUBMISSION_BYTES
    ? helpers.error('string.maxUtf8Bytes', { limit: GENIEPROOF_MAX_SUBMISSION_BYTES })
    : value
)).messages({ 'string.maxUtf8Bytes': '{{#label}} must be at most {{#limit}} UTF-8 bytes' });

export const genieProofExtractSchema = Joi.object({
  offerText: offerText.required(),
}).unknown(false);

// No passive or automatic third-party disclosure; consent must be explicit.
export const genieProofNvidiaReviewSchema = Joi.object({
  statement: Joi.string().min(1).max(500).custom((value, helpers) => (
    Buffer.byteLength(value, 'utf8') > 1600 ? helpers.error('string.maxUtf8Bytes') : value
  )).required(),
  claimId,
  consent: Joi.boolean().valid(true).required(),
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
  offerText: offerText.required(),
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

const scenarioAmount = Joi.string().pattern(/^(?:0|[1-9]\d{0,18})(?:\.\d{1,2})?$/);
const scenarioPercent = Joi.string().pattern(/^(?:0|[1-9]\d{0,2})(?:\.\d{1,4})?$/);

export const genieProofMathSchema = Joi.object({
  type: Joi.string().valid('LUMPSUM', 'SIP', 'EMI').required(),
  amountRupees: scenarioAmount.required(),
  annualRatePercent: scenarioPercent.required(),
  months: Joi.number().integer().min(1).max(600).strict().required(),
  stepUpPercent: Joi.when('type', { is: 'SIP', then: scenarioPercent.optional(), otherwise: Joi.forbidden() }),
  claimedResultRupees: scenarioAmount.optional(),
}).unknown(false);
