import {Router} from 'express';
import Joi from 'joi';
import crypto from 'node:crypto';
import {verifyJWT} from '../middleware/authMiddleware.js';
import {validate,validateQuery} from '../validation/schemas.js';
import {asyncHandler,createError,sendError} from '../middleware/errorHandler.js';
import FinancialProfile from '../models/FinancialProfile.js';
import InvestorHoldingLot from '../models/InvestorHoldingLot.js';
import HoldingValuationSnapshot from '../models/HoldingValuationSnapshot.js';
import {getFinancialPostgresPool} from '../postgres/connection.js';
import {createFinancialStore} from '../postgres/financialStore.js';
import {calculateHoldingValuation} from '../services/holdingValuation.js';
const router=Router();
const objectId=Joi.string().pattern(/^[a-fA-F0-9]{24}$/);
const productId=Joi.string().min(3).max(160).pattern(/^[a-zA-Z0-9:_-]+$/);
const decimal=Joi.string().pattern(/^(0|[1-9][0-9]*)(?:\.[0-9]{1,8})?$/);
const paise=Joi.string().pattern(/^(0|[1-9][0-9]*)$/).max(19);
const date=Joi.string().pattern(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
const createSchema=Joi.object({
 profileId:objectId.required(),canonicalProductId:productId.required(),
 clientMutationId:Joi.string().guid({version:'uuidv4'}).required(),
 quantityDecimal:decimal.required(),costBasisPaise:paise.required(),
 acquisitionDate:date.required(),
}).unknown(false);
const querySchema=Joi.object({profileId:objectId.required()}).unknown(false);
const valuationSchema=Joi.object({holdingLotId:objectId.required()}).unknown(false);
async function ownedProfile(userId,profileId){
 const found=await FinancialProfile.findOne({_id:profileId,userId}).lean();
 if(!found)throw createError(404,'Profile not found','Profile not found');
 return found;
}
async function requiredStore(req,res){
 const pool=await getFinancialPostgresPool();
 if(!pool){
  sendError(req,res,503,'Qualified investment product data is unavailable.','FINANCIAL_POSTGRES_NOT_ENABLED');
  return null;
 }
 return createFinancialStore(pool);
}
function summarizeHolding(row){
 return {id:String(row._id),profileId:String(row.profileId),canonicalProductId:row.canonicalProductId,
  quantityDecimal:row.quantityDecimal,costBasisPaise:row.costBasisPaise,
  acquisitionDate:row.acquisitionDate,evidenceClass:row.evidenceClass,createdAt:row.createdAt};
}
router.get('/',verifyJWT,validateQuery(querySchema),asyncHandler(async(req,res)=>{
 await ownedProfile(req.user.userId,req.query.profileId);
 const lots=await InvestorHoldingLot.find({userId:req.user.userId,profileId:req.query.profileId})
   .sort({createdAt:-1,_id:-1}).limit(200).lean();
 res.set('Cache-Control','private, no-store');
 res.json({status:'USER_DECLARED_HOLDINGS',lots:lots.map(summarizeHolding),currentMarketValue:null});
}));
router.post('/',verifyJWT,validate(createSchema),asyncHandler(async(req,res)=>{
 const {profileId,canonicalProductId,clientMutationId,quantityDecimal,costBasisPaise,acquisitionDate}=req.body;
 await ownedProfile(req.user.userId,profileId);
 // The user is declaring a purchased lot; it is not source-verified execution evidence.
 if(quantityDecimal==='0')return sendError(req,res,400,'Quantity must exceed zero','HOLDING_QUANTITY_INVALID');
 const parsed=new Date(acquisitionDate+'T00:00:00.000Z');
 if(!Number.isFinite(+parsed)||parsed.toISOString().slice(0,10)!==acquisitionDate
     ||parsed>new Date())return sendError(req,res,400,'Acquisition date is invalid','HOLDING_DATE_INVALID');
 const inputFingerprint=crypto.createHash('sha256').update(JSON.stringify({
  profileId,canonicalProductId,quantityDecimal,costBasisPaise,acquisitionDate,
 })).digest('hex');
 const existing=await InvestorHoldingLot.findOne({userId:req.user.userId,clientMutationId}).lean();
 if(existing){
  if(existing.inputFingerprint!==inputFingerprint)return sendError(req,res,409,'Mutation ID was reused with different holding facts','HOLDING_IDEMPOTENCY_CONFLICT');
  res.set('Cache-Control','private, no-store');
  return res.json({status:'UNCHANGED',holding:summarizeHolding(existing)});
 }
 const store=await requiredStore(req,res);if(!store)return;
 const pool=await getFinancialPostgresPool();
 const {rows}=await pool.query('SELECT record_kind FROM finance.products WHERE id=$1',[canonicalProductId]);
 if(rows[0]?.record_kind!=='ACTUAL_PRODUCT')return sendError(req,res,422,'A verified actual product identity is required','ACTUAL_INVESTMENT_PRODUCT_NOT_FOUND');
 let saved;
 try{
  saved=await InvestorHoldingLot.create({userId:req.user.userId,profileId,canonicalProductId,
   clientMutationId,quantityDecimal,costBasisPaise,acquisitionDate,inputFingerprint,evidenceClass:'USER_DECLARED'});
 }catch(error){
  if(error?.code!==11000)throw error;
  saved=await InvestorHoldingLot.findOne({userId:req.user.userId,clientMutationId}).lean();
  if(saved.inputFingerprint!==inputFingerprint)return sendError(req,res,409,'Conflicting holding request','HOLDING_IDEMPOTENCY_CONFLICT');
 }
 res.set('Cache-Control','private, no-store');
 return res.status(201).json({status:'SAVED',holding:summarizeHolding(saved)});
}));
router.post('/valuation',verifyJWT,validate(valuationSchema),asyncHandler(async(req,res)=>{
 const lot=await InvestorHoldingLot.findOne({_id:req.body.holdingLotId,userId:req.user.userId}).lean();
 if(!lot)return sendError(req,res,404,'Holding lot was not found','HOLDING_NOT_FOUND');
 await ownedProfile(req.user.userId,lot.profileId);
 const store=await requiredStore(req,res);if(!store)return;
 const facts=await Promise.all(['PRICE','NAV'].map(kind=>store.latestPublishableObservation(lot.canonicalProductId,kind)));
 const available=facts.filter(Boolean).sort((a,b)=>+new Date(b.observed_at)-+new Date(a.observed_at));
 const fact=available[0];
 if(!fact)return res.json({status:'UNAVAILABLE',reasonCode:'QUALIFIED_MARKET_VALUE_UNAVAILABLE',value:null});
 if(fact.currency!=='INR')return res.json({status:'UNAVAILABLE',reasonCode:'MARKET_VALUE_CURRENCY_NOT_QUALIFIED',value:null});
 const deadlines=[fact.retain_until,fact.rights_expire_at].filter(Boolean).map(t=>new Date(t));
 if(!fact.retain_until || deadlines.some(t=>!Number.isFinite(+t))){
  return res.json({status:'UNAVAILABLE',reasonCode:'VALUATION_RETENTION_UNVERIFIED',value:null});
 }
 const retainedUntil=new Date(Math.min(...deadlines.map(t=>+t)));
 if(retainedUntil<=new Date()){
  return res.json({status:'UNAVAILABLE',reasonCode:'VALUATION_RETENTION_EXPIRED',value:null});
 }
 const value=calculateHoldingValuation({units:lot.quantityDecimal,unitPrice:fact.value,
  currency:fact.currency,costBasisPaise:lot.costBasisPaise});
 const binding={userId:req.user.userId,profileId:lot.profileId,holdingLotId:lot._id,
   canonicalProductId:lot.canonicalProductId,observationId:String(fact.id),
   observationKind:fact.observation_type,sourceId:fact.source_id,dataClass:fact.data_class,
   observedAt:fact.observed_at,retainedUntil,result:value};
 let snapshot;
 try{snapshot=await HoldingValuationSnapshot.create(binding);}
 catch(error){
  if(error?.code!==11000)throw error;
  snapshot=await HoldingValuationSnapshot.findOne({
   userId:req.user.userId,holdingLotId:lot._id,observationId:String(fact.id),
  }).lean();
 }
 res.set('Cache-Control','private, no-store');
 return res.json({status:'QUALIFIED_SNAPSHOT',valuationId:String(snapshot._id),
   observedAt:fact.observed_at,sourceId:fact.source_id,dataClass:fact.data_class,
   value:snapshot.result});
}));
export default router;
