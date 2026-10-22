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
import { getFinancialPostgresPool } from '../postgres/connection.js';
import { createFinancialStore } from '../postgres/financialStore.js';
import { estimateQualifiedHistoricalVolatility } from '../services/qualifiedHistoricalVolatility.js';
import { fingerprintQualifiedHistory } from '../services/qualifiedHistoryFingerprint.js';
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
const sqlRiskSchema=schema.fork(['annualVolatility'],field=>field.forbidden()).keys({
 canonicalProductId:Joi.string().pattern(/^[a-zA-Z0-9:_-]{1,160}$/).required(),
 sourceId:Joi.string().pattern(/^[a-zA-Z0-9:_-]{1,160}$/).required(),
 observationKind:Joi.string().valid('PRICE','NAV').required(),
});

/**
 * Historical risk and hypothetical expected return are independent inputs:
 * the volatility comes ONLY from source-qualified, current EOD PostgreSQL
 * observations; forward expected return is explicitly user-declared.
 * Calculated results are ephemeral because provider-specific rights can
 * expire. In particular, they must not become permanent MongoDB snapshots.
 */
router.post('/equity-history-risk',verifyJWT,validate(sqlRiskSchema),asyncHandler(async(req,res)=>{
 const userId=req.user.userId;
 const profile=await FinancialProfile.findOne({_id:req.body.profileId,userId}).lean();
 if(!profile)throw createError(404,'Financial profile not found','Financial profile not found');
 const tax=await InvestorTaxContext.findOne({userId,profileId:profile._id}).sort({version:-1}).lean();
 if(!tax||tax.version!==req.body.taxContextVersion||tax.profileVersion!==profile.version)
   return sendError(req,res,409,'Saved tax context does not match the current profile.','TAX_CONTEXT_STALE');
 const pool=await getFinancialPostgresPool();
 if(!pool)return sendError(req,res,503,'Financial PostgreSQL unavailable.','FINANCIAL_POSTGRES_NOT_ENABLED');
 const store=createFinancialStore(pool);
 const history=await store.qualifiedHistoricalPrices(req.body.canonicalProductId,
   req.body.observationKind,req.body.sourceId);
 const calibration=estimateQualifiedHistoricalVolatility(history);
 res.set('Cache-Control','private, no-store');
 if(calibration.status!=='CALCULATED')return res.json({
   status:'UNAVAILABLE',reasonCode:calibration.reasonCode,afterTaxAvailable:false,
   sourceCalibration:calibration,results:null,
 });
 const qualifiedHistorySnapshot=fingerprintQualifiedHistory(history);
 const {profileId,taxContextVersion,canonicalProductId,sourceId,observationKind,...scenario}=req.body;
 const result=await executeMonteCarlo({
   scenarioMode:'USER_DECLARED_EQUITY_LUMP_SUM',
   ...scenario,annualVolatility:calibration.annualVolatility,
   taxContext:{
     annualGrossIncome:tax.annualGrossIncome,incomeSource:tax.incomeSource,
     regime:tax.regime,fiscalYear:tax.fiscalYear,userAge:tax.userAge,
     deductions:tax.deductions,section112AExemptionUsed:tax.section112AExemptionUsed,
   },
 });
 const [profileAfter,taxAfter,historyAfter]=await Promise.all([
   FinancialProfile.findOne({_id:profile._id,userId}).lean(),
   InvestorTaxContext.findOne({userId,profileId:profile._id}).sort({version:-1}).lean(),
   store.qualifiedHistoricalPrices(canonicalProductId,observationKind,sourceId),
 ]);
 if(!profileAfter||profileAfter.version!==profile.version
   ||!taxAfter||String(taxAfter._id)!==String(tax._id))
   return sendError(req,res,409,'Financial context changed during simulation.','FINANCIAL_CONTEXT_CHANGED');
 if(fingerprintQualifiedHistory(historyAfter)!==qualifiedHistorySnapshot)
   return sendError(req,res,409,'Historical source changed or lost data rights.','FINANCIAL_SOURCE_CHANGED');
 return res.json({
   ...result,
   expectedReturnBasis:'USER_DECLARED_ASSUMPTION_NOT_HISTORICAL_FORECAST',
   volatilityBasis:'QUALIFIED_RETAINED_END_OF_DAY_PRICE_CHANGES_NOT_TOTAL_RETURN',
   calibration:{...calibration,canonicalProductId,observationKind},
   persistenceStatus:'NOT_STORED_DUE_TO_SOURCE_RETENTION_RIGHTS',
 });
}));
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
