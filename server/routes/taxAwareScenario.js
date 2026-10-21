import {Router} from 'express';
import Joi from 'joi';
import crypto from 'node:crypto';
import {verifyJWT} from '../middleware/authMiddleware.js';
import {validate} from '../validation/schemas.js';
import {asyncHandler,sendError,createError} from '../middleware/errorHandler.js';
import {executeMonteCarlo} from '../services/monteCarloExecutor.js';
import FinancialProfile from '../models/FinancialProfile.js';
import InvestorTaxContext from '../models/InvestorTaxContext.js';
import FinancialCalculationRun from '../models/FinancialCalculationRun.js';
const router=Router();
const objectId=Joi.string().pattern(/^[a-fA-F0-9]{24}$/);
const isoDate=Joi.string().pattern(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
const schema=Joi.object({
 profileId:objectId.required(),
 taxContextVersion:Joi.number().integer().min(1).required(),
 principal:Joi.number().greater(0).max(1e10).required(),
 annualExpectedReturn:Joi.number().greater(-1).max(1).required(),
 annualVolatility:Joi.number().min(0).max(0.6).required(),
 years:Joi.number().integer().min(1).max(30).required(),
 simulations:Joi.number().integer().min(100).max(1000).required(),
 inflationRate:Joi.number().min(0).max(1).required(),
 seed:Joi.number().integer().min(0).max(4294967295).required(),
 targetAmount:Joi.number().greater(0).max(1e12).allow(null).required(),
 acquisitionDate:isoDate.required(),
 redemptionDate:isoDate.required(),
}).unknown(false);
router.post('/equity-lump-sum',verifyJWT,validate(schema),asyncHandler(async(req,res)=>{
 const userId=req.user.userId;
 const profile=await FinancialProfile.findOne({_id:req.body.profileId,userId}).lean();
 if(!profile)throw createError(404,'Financial profile not found','Financial profile not found');
 const tax=await InvestorTaxContext.findOne({userId,profileId:profile._id}).sort({version:-1}).lean();
 if(!tax || tax.version!==req.body.taxContextVersion || tax.profileVersion!==profile.version){
   return sendError(req,res,409,'Saved tax context does not match the current financial profile.','TAX_CONTEXT_STALE');
 }
 const {profileId,taxContextVersion,...scenario}=req.body;
 const result=await executeMonteCarlo({
   scenarioMode:'USER_DECLARED_EQUITY_LUMP_SUM',
   ...scenario,
   taxContext:{
     annualGrossIncome:tax.annualGrossIncome,incomeSource:tax.incomeSource,
     regime:tax.regime,fiscalYear:tax.fiscalYear,userAge:tax.userAge,
     deductions:tax.deductions,section112AExemptionUsed:tax.section112AExemptionUsed,
   },
 });
 const [latestProfile,latestTax]=await Promise.all([
   FinancialProfile.findOne({_id:profile._id,userId}).lean(),
   InvestorTaxContext.findOne({userId,profileId:profile._id}).sort({version:-1}).lean(),
 ]);
 if(!latestProfile || latestProfile.version!==profile.version
    ||!latestTax || String(latestTax._id)!==String(tax._id)){
   return sendError(req,res,409,'Financial profile or tax context changed during computation.','FINANCIAL_CONTEXT_CHANGED');
 }
 const fingerprint=crypto.createHash('sha256').update(JSON.stringify({
   scenario,profileVersion:profile.version,taxContextId:String(tax._id),
 })).digest('hex');
 const saved=await FinancialCalculationRun.create({
   userId,profileId:profile._id,profileVersion:profile.version,
   taxContextId:tax._id,taxContextVersion:tax.version,
   kind:'USER_DECLARED_EQUITY_LUMP_SUM',
   inputFingerprint:fingerprint,result,
 });
 res.set('Cache-Control','private, no-store');
 return res.json({runId:String(saved._id),...result});
}));
export default router;
