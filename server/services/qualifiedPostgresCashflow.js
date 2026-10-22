import {createFinancialStore} from '../postgres/financialStore.js';
import {calculateQualifiedProductCashflow} from './productCashflowEngine.js';

const officialUrl='https://www.indiapost.gov.in/banking-services/savings';
const knownSchedules=Object.freeze({
 'government:india-post:post-office-td-1y':{months:12,periods:4,basis:'Quarterly'},
 'government:india-post:post-office-td-2y':{months:24,periods:4,basis:'Quarterly'},
 'government:india-post:post-office-td-3y':{months:36,periods:4,basis:'Quarterly'},
 'government:india-post:post-office-td-5y':{months:60,periods:4,basis:'Quarterly'},
 'government:india-post:nsc':{months:60,periods:1,basis:'Annually'},
});
function unavailable(code,productId){
 return {status:'UNAVAILABLE',reasonCode:code,canonicalProductId:productId,
  postTaxProceeds:null,grossMaturityProceeds:null,
  dataClass:'NOT_ESTABLISHED',source:null};
}
/**
 * This only bridges a source-verified published scheme rate AND independent
 * scheme terms to the existing contract engine. It never manufactures a
 * generic fixed-deposit rate or converts quotes into guaranteed coupons.
 */
export async function calculateSourceBoundContractCashflow({
 pool,productId,principal,now=new Date(),taxEventContext=null,store=null,
}={}){
 if(typeof productId!=='string'||!Object.hasOwn(knownSchedules,productId))
  return unavailable('PRODUCT_CONTRACT_MODEL_NOT_QUALIFIED',productId||null);
 if(!pool || typeof pool.query!=='function')throw new TypeError('PostgreSQL pool is required');
 if(!(now instanceof Date)||!Number.isFinite(+now))throw new TypeError('Valid as-of timestamp required');
 const authority=store||createFinancialStore(pool);
 const fact=await authority.latestPublishableObservation(productId,'PUBLISHED_RATE',now);
 if(!fact || fact.unit!=='PERCENT_PER_ANNUM'||fact.data_class!=='PUBLISHED_RATE')
  return unavailable('QUALIFIED_PUBLISHED_RATE_UNAVAILABLE',productId);
 const {rows:identity}=await pool.query(`
   SELECT p.id,p.record_kind,p.availability,p.qualified_tax_class,
           p.tax_class_evidence_url,p.tax_class_reviewed_at,r.endpoint_url
     FROM finance.products p JOIN finance.provider_rights r ON r.source_id=$2
    WHERE p.id=$1 AND p.record_kind='ACTUAL_PRODUCT'
      AND p.availability='AVAILABLE' AND r.endpoint_url=$3
      AND r.access_allowed AND r.extraction_allowed AND r.storage_allowed
      AND r.derivation_allowed AND r.public_display_allowed
      AND r.commercial_use_allowed AND r.redistribution_allowed
      AND r.reviewed_at IS NOT NULL AND r.revoked_at IS NULL
      AND (r.expires_at IS NULL OR r.expires_at>$4)
    LIMIT 1`,
  [productId,fact.source_id,officialUrl,now]);
 if(identity.length!==1)return unavailable('ISSUER_OR_SOURCE_RIGHTS_NOT_QUALIFIED',productId);
 if(taxEventContext && (identity[0].qualified_tax_class!=='ORDINARY_INTEREST'
   ||!identity[0].tax_class_evidence_url
   ||!identity[0].tax_class_reviewed_at))
   return unavailable('PRODUCT_TAX_CLASS_NOT_VERIFIED',productId);
 const {rows:termRows}=await pool.query(`
  SELECT t.term_type,t.term_value::text AS value,t.unit
    FROM finance.product_terms t
   WHERE t.product_id=$1 AND t.source_id=$2
     AND t.effective_from<=($3::timestamptz AT TIME ZONE 'Asia/Kolkata')::date
     AND (t.effective_to IS NULL OR t.effective_to>=
       ($3::timestamptz AT TIME ZONE 'Asia/Kolkata')::date)
   ORDER BY t.term_type`,[productId,fact.source_id,now]);
 const terms=new Map();
 for(const row of termRows){
  if(terms.has(row.term_type))return unavailable('CONFLICTING_PRODUCT_CONTRACT_TERMS',productId);
  terms.set(row.term_type,row);
 }
 const schedule=knownSchedules[productId];
 const months=terms.get('TENURE_MONTHS');
 const compounding=terms.get('COMPOUNDING_PERIODS_PER_YEAR');
 if(months?.unit!=='MONTHS'||Number(months.value)!==schedule.months
   ||compounding?.unit!=='PER_YEAR'||Number(compounding.value)!==schedule.periods)
   return unavailable('ISSUER_CONTRACT_TERMS_NOT_VERIFIED',productId);
 const effectiveFrom=typeof fact.effective_from==='string'
   ?fact.effective_from:new Date(fact.effective_from).toISOString().slice(0,10);
 if(!fact.effective_to)return unavailable('PUBLISHED_RATE_VALIDITY_WINDOW_MISSING',productId);
 const effectiveTo=typeof fact.effective_to==='string'
   ?fact.effective_to:new Date(fact.effective_to).toISOString().slice(0,10);
 const rate=Number(fact.value);
 if(!Number.isFinite(rate)||rate<0||rate>30)
  return unavailable('INVALID_PUBLISHED_PRODUCT_RATE',productId);
 const product={
   id:productId,canonicalProductId:productId,
   presentationStatus:'VERIFIED_COMPARABLE_OPTION',
   availabilityStatus:'AVAILABLE',
   tenureMonths:schedule.months,
   compoundingBasis:schedule.basis,
   source:{provider:'GOVERNMENT_OF_INDIA',url:officialUrl},
   freshness:{status:'FRESH'},
   officialRate:{value:rate,dataClass:'QUARTERLY_OFFICIAL_RATE',
     basis:'OFFICIAL_NOMINAL_RATE_PER_ANNUM',unit:'PERCENT_PER_ANNUM',
     effectiveFrom,effectiveTo},
 };
 const result=calculateQualifiedProductCashflow({
   product,principal,now,enforceSourceRights:true,productionUseAllowed:true,taxEventContext,
 });
 // Rates, models, investor inputs and settlement dates are separate evidence.
 return {...result,dataClass:'QUALIFIED_PUBLISHED_RATE',
   officialSourceId:fact.source_id,officialObservationId:String(fact.id),
   sourceObservationTime:fact.observed_at,
   sourceTermsReviewedIndependently:false,
   notMarketPrice:true,
 };
}
