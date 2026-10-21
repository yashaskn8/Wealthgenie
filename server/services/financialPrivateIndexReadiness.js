import InvestorTaxContext from '../models/InvestorTaxContext.js';
import RecommendationShortlist from '../models/RecommendationShortlist.js';
import FinancialCalculationRun from '../models/FinancialCalculationRun.js';
import InvestorHoldingLot from '../models/InvestorHoldingLot.js';
import HoldingValuationSnapshot from '../models/HoldingValuationSnapshot.js';
import { verifyPersistenceIndexes } from './persistenceIndexReadiness.js';

export const FINANCIAL_PRIVATE_INDEX_MODELS = Object.freeze([
  InvestorTaxContext,RecommendationShortlist,FinancialCalculationRun,
  InvestorHoldingLot,HoldingValuationSnapshot,
]);
export async function verifyFinancialPrivateIndexes() {
  // Existing shared checker validates every declared unique index without creating indexes.
  await verifyPersistenceIndexes({models:FINANCIAL_PRIVATE_INDEX_MODELS,force:true,scope:'financial'});
  let indexes;
  try { indexes = await HoldingValuationSnapshot.collection.indexes(); }
  catch { throw Object.assign(new Error('FINANCIAL_VALUATION_TTL_INDEX_MISSING'),{code:'FINANCIAL_VALUATION_TTL_INDEX_MISSING'}); }
  if (!indexes.some(index=>index.key?.retainedUntil===1
    && Object.keys(index.key).length===1 && index.expireAfterSeconds===0)) {
    throw Object.assign(new Error('FINANCIAL_VALUATION_TTL_INDEX_MISSING'),{code:'FINANCIAL_VALUATION_TTL_INDEX_MISSING'});
  }
  return {ready:true,models:FINANCIAL_PRIVATE_INDEX_MODELS.length,retentionTtlVerified:true};
}
export async function migrateFinancialPrivateIndexes() {
  for(const model of FINANCIAL_PRIVATE_INDEX_MODELS)await model.createIndexes();
  return verifyFinancialPrivateIndexes();
}
