import { Router } from 'express';
import Joi from 'joi';
import { asyncHandler, sendError } from '../middleware/errorHandler.js';
import { validateQuery } from '../validation/schemas.js';
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
