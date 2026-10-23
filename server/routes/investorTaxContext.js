import { Router } from 'express';
import crypto from 'node:crypto';
import Joi from 'joi';
import { verifyJWT } from '../middleware/authMiddleware.js';
import { asyncHandler, createError, sendError } from '../middleware/errorHandler.js';
import { validate, validateQuery } from '../validation/schemas.js';
import { taxDeductionSchema, requirePostTaxDependencyFacts } from '../validation/taxSchemas.js';
import { getTaxPolicyMetadata } from '../services/taxEngine.js';
import FinancialProfile from '../models/FinancialProfile.js';
import InvestorTaxContext from '../models/InvestorTaxContext.js';
const router = Router();
const id = Joi.string().pattern(/^[a-fA-F0-9]{24}$/);
const requestSchema = Joi.object({
  profileId:id.required(),
  expectedProfileVersion:Joi.number().integer().min(1).required(),
  annualGrossIncome:Joi.number().min(0).max(1_000_000_000).required(),
  incomeSource:Joi.string().valid('salary','pension','family_pension','business','other').required(),
  regime:Joi.string().valid('new').required(),
  fiscalYear:Joi.string().pattern(/^FY[0-9]{4}-[0-9]{2}$/).required(),
  userAge:Joi.number().integer().min(18).max(120).required(),
  // Empty {} means explicitly declaring no eligible deductions, not unknown.
  deductions:taxDeductionSchema.required(),
  section112AExemptionUsed:Joi.number().min(0).max(125000).allow(null).required(),
}).custom(requirePostTaxDependencyFacts).unknown(false);
const querySchema = Joi.object({profileId:id.required()}).unknown(false);
async function ownedProfile(userId,profileId) {
  const profile = await FinancialProfile.findOne({_id:profileId,userId}).lean();
  if (!profile) throw createError(404,'Financial profile not found','Financial profile not found');
  return profile;
}
function present(row) {
  if(!row) return null;
  return {id:String(row._id),profileId:String(row.profileId),profileVersion:row.profileVersion,
    version:row.version,fiscalYear:row.fiscalYear,userAge:row.userAge,
    annualGrossIncome:row.annualGrossIncome,incomeSource:row.incomeSource,regime:row.regime,
    deductions:row.deductions,section112AExemptionUsed:row.section112AExemptionUsed,
    inputFingerprint:row.inputFingerprint,userDeclared:true,createdAt:row.createdAt};
}
router.get('/',verifyJWT,validateQuery(querySchema),asyncHandler(async(req,res)=>{
  const profile=await ownedProfile(req.user.userId,req.query.profileId);
  const row=await InvestorTaxContext.findOne({userId:req.user.userId,profileId:profile._id})
    .sort({version:-1}).lean();
  res.set('Cache-Control','private, no-store');
  return res.json({status:row?'AVAILABLE':'NOT_SAVED',context:present(row),
    currentProfileVersion:profile.version,
    isCurrent:row ? row.profileVersion===profile.version : false});
}));
router.post('/',verifyJWT,validate(requestSchema),asyncHandler(async(req,res)=>{
  const profile=await ownedProfile(req.user.userId,req.body.profileId);
  if (profile.version!==req.body.expectedProfileVersion) return sendError(req,res,409,
    'Profile changed; refresh before saving the tax context.','TAX_CONTEXT_PROFILE_CHANGED');
  if (req.body.userAge !== profile.age) {
    return sendError(req,res,409,
      'Tax age differs from the current financial profile. Update and reconfirm the profile first.',
      'TAX_CONTEXT_PROFILE_AGE_MISMATCH');
  }
  getTaxPolicyMetadata(req.body.fiscalYear); // Reject unsupported fiscal years, never default.
  const {profileId,expectedProfileVersion,...facts}=req.body;
  const fingerprint=crypto.createHash('sha256').update(JSON.stringify(facts)).digest('hex');
  const last=await InvestorTaxContext.findOne({userId:req.user.userId,profileId})
    .sort({version:-1}).lean();
  if(last?.inputFingerprint===fingerprint && last.profileVersion===expectedProfileVersion) {
    res.set('Cache-Control','private, no-store');
    return res.json({status:'UNCHANGED',context:present(last)});
  }
  let saved;
  try {
    saved=await InvestorTaxContext.create({userId:req.user.userId,profileId,
      profileVersion:expectedProfileVersion,version:(last?.version||0)+1,
      ...facts,inputFingerprint:fingerprint,userDeclared:true});
  } catch (error) {
    if(error?.code===11000) return sendError(req,res,409,'Tax context updated concurrently; retry.','TAX_CONTEXT_CONFLICT');
    throw error;
  }
  const current=await ownedProfile(req.user.userId,profileId);
  if(current.version!==expectedProfileVersion) return sendError(req,res,409,
    'Profile changed after tax-context submission. The saved revision cannot be used for calculations.','TAX_CONTEXT_PROFILE_CHANGED');
  res.set('Cache-Control','private, no-store');
  return res.status(201).json({status:'SAVED',context:present(saved)});
}));
export default router;
