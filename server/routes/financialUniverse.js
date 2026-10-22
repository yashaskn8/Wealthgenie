import { Router } from 'express';
import Joi from 'joi';
import { asyncHandler, sendError } from '../middleware/errorHandler.js';
import { validate, validateQuery } from '../validation/schemas.js';
import { verifyJWT } from '../middleware/authMiddleware.js';
import { taxDeductionSchema } from '../validation/taxSchemas.js';
import { calculateSourceBoundContractCashflow } from '../services/qualifiedPostgresCashflow.js';
import { getFinancialPostgresPool } from '../postgres/connection.js';
import { createFinancialStore } from '../postgres/financialStore.js';
const router = Router();
const slug = Joi.string().trim().min(1).max(160).pattern(/^[a-zA-Z0-9:_-]+$/);
const browseSchema = Joi.object({
  category: slug.optional(),
  subcategory: slug.optional(),
  cursor: slug.optional(),
  limit: Joi.string().pattern(/^(?:[1-9]|[1-9][0-9]|100)$/).optional(),
}).unknown(false);
router.get('/', validateQuery(browseSchema), asyncHandler(async (req, res) => {
  const pool = await getFinancialPostgresPool();
  if (!pool) return sendError(req,res,503,'Financial-universe PostgreSQL is not enabled.','FINANCIAL_UNIVERSE_NOT_ENABLED');
  res.set('Cache-Control','no-store');
  const catalog = createFinancialStore(pool);
  return res.json(await catalog.browse({
    category: req.query.category || null, subcategory: req.query.subcategory || null,
    cursor: req.query.cursor || null, limit: req.query.limit ? Number(req.query.limit) : 20,
  }));
}));
router.get('/categories', asyncHandler(async(req,res)=>{
  const pool=await getFinancialPostgresPool();
  if(!pool) return sendError(req,res,503,
    'Financial-universe PostgreSQL is not enabled.','FINANCIAL_UNIVERSE_NOT_ENABLED');
  res.set('Cache-Control','no-store');
  const {rows}=await pool.query(`
    SELECT c.id,c.label,count(p.id)::integer AS archetype_count
      FROM finance.categories c
      LEFT JOIN finance.products p ON p.category_id=c.id AND p.record_kind='ARCHETYPE'
     GROUP BY c.id,c.label ORDER BY c.label,c.id`);
  return res.json({status:'DISCOVERY_ONLY',categories:rows});
}));
const fy=Joi.string().pattern(/^FY[0-9]{4}-[0-9]{2}$/);
const taxFacts=Joi.object({
 fiscalYear:fy.required(),
 annualGrossIncome:Joi.number().min(0).max(1e9).required(),
 userAge:Joi.number().integer().min(18).max(120).required(),
 incomeSource:Joi.string().valid('salary','pension','family_pension','business','other').required(),
 regime:Joi.string().valid('new','old').required(),
 deductions:taxDeductionSchema.required(),
 baselineExcludesTheseInterestEvents:Joi.boolean().valid(true).required(),
}).unknown(false);
const contractSchema=Joi.object({
 principal:Joi.number().greater(0).max(1e10).required(),
 taxEventContext:Joi.object({
   eventDates:Joi.object().pattern(Joi.string().pattern(/^[a-zA-Z0-9:_-]{1,90}$/),
     Joi.string().pattern(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/)).min(1).max(40).required(),
   taxContexts:Joi.object().pattern(fy,taxFacts).min(1).max(30).required(),
 }).unknown(false).allow(null).optional(),
}).unknown(false);
router.post('/:productId/contract-cashflow',verifyJWT,validate(contractSchema),
 asyncHandler(async(req,res)=>{
  if(process.env.FINANCIAL_ARCHITECTURE_ENABLED!=='true')
   return sendError(req,res,503,'Financial cashflow extension not enabled.',
     'FINANCIAL_ARCHITECTURE_NOT_ENABLED');
  const pool=await getFinancialPostgresPool();
  if(!pool)return sendError(req,res,503,'Financial PostgreSQL unavailable.','FINANCIAL_POSTGRES_NOT_ENABLED');
  const now=new Date();
  const result=await calculateSourceBoundContractCashflow({
    pool,productId:req.params.productId,principal:req.body.principal,now,
    taxEventContext:req.body.taxEventContext||null,
  });
  res.set('Cache-Control','private, no-store');
  if(result.status!=='CALCULATED')return res.json(result);
  const stillQualified=await createFinancialStore(pool)
    .latestPublishableObservation(req.params.productId,'PUBLISHED_RATE');
  if(!stillQualified||String(stillQualified.id)!==result.officialObservationId)
   return sendError(req,res,409,'Product rate or provider rights changed during calculation.',
     'CONTRACT_SOURCE_CHANGED');
  return res.json(result);
 }));
router.get('/:productId/observation', validateQuery(Joi.object({
  kind: Joi.string().valid('PRICE','NAV','PUBLISHED_RATE','YIELD','VOLUME').required(),
}).unknown(false)), asyncHandler(async (req,res) => {
  const pool = await getFinancialPostgresPool();
  if (!pool) return sendError(req,res,503,'Financial-universe PostgreSQL is not enabled.','FINANCIAL_UNIVERSE_NOT_ENABLED');
  res.set('Cache-Control','no-store');
  const store = createFinancialStore(pool);
  const fact = await store.latestPublishableObservation(req.params.productId,req.query.kind);
  if (!fact) return res.json({status:'UNAVAILABLE',reasonCode:'QUALIFIED_MARKET_FACT_UNAVAILABLE',value:null});
  return res.json({status:'AVAILABLE',dataClass:fact.data_class,observation:fact});
}));
export default router;
