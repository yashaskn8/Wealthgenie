import {Router} from 'express';
import Joi from 'joi';
import {verifyJWT} from '../middleware/authMiddleware.js';
import {createEndpointRateLimiter} from '../middleware/rateLimiter.js';
import {validate,validateQuery} from '../validation/schemas.js';
import {asyncHandler,sendError} from '../middleware/errorHandler.js';
import {searchFreeFunds,getFreeFundNavResearch} from '../services/freeMutualFundNav.js';
import {getMfapiLatest,getMfapiHistoryResearch,reconcileFreeNavSources} from '../services/freeNavSecondaryVerification.js';
import {
 getPublicSmallSavingsRates,calculatePublicSmallSavingsGrossResearch,
} from '../services/publicSmallSavingsResearch.js';
import {executeMonteCarlo} from '../services/monteCarloExecutor.js';
import {getFreeFinancialSourceDirectory} from '../services/freeFinancialSourceDirectory.js';

const router=Router();
// No-key providers still have finite capacity. This per-client quota is
// shared via Redis on production replicas; failures refuse work rather than
// flooding AMFI-derived free APIs or spawning excess CPU-heavy workers.
const freeProviderLimiter=createEndpointRateLimiter({
 windowMs:60_000,max:30,prefix:'rl:ep:free-financial-research:',
 message:'Free financial research requests are temporarily rate limited.',
 // Auth is evaluated before this limiter on every route, so a bystander
 // sharing a demo Wi-Fi IP cannot consume another visitor's entire quota.
 keyGenerator:req=>req.user?.userId||'unauthenticated-rejected-by-jwt',
});
const schemeCode=Joi.string().pattern(/^[1-9][0-9]{4,6}$/);
const searchSchema=Joi.object({
 q:Joi.string().trim().min(2).max(80).pattern(/^[a-zA-Z0-9 .()&_-]+$/).required(),
}).unknown(false);
const simulateSchema=Joi.object({
 schemeCode:schemeCode.required(),
 monthlyInvestment:Joi.number().min(0).max(1e7).required(),
 currentSavings:Joi.number().min(0).max(1e10).required(),
 annualExpectedReturn:Joi.number().greater(-1).max(1).required(),
 years:Joi.number().integer().min(1).max(30).required(),
 simulations:Joi.number().integer().min(100).max(1000).required(),
 inflationRate:Joi.number().min(0).max(1).required(),
 seed:Joi.number().integer().min(0).max(4294967295).required(),
 targetAmount:Joi.number().greater(0).max(1e12).allow(null).required(),
}).custom((v,h)=>v.monthlyInvestment===0&&v.currentSavings===0?
 h.error('any.custom'):v).unknown(false);
// Two no-key mirrors are compared by exact scheme/date/NAV. Both derive from
// AMFI, so this is a consistency check rather than independent licensing.
async function loadResearchWithMirror(code){
 let primary;
 try{primary=await getFreeFundNavResearch(code);}
 catch{primary={status:'UNAVAILABLE',reasonCode:'MFNAV_PRIMARY_SOURCE_UNAVAILABLE'};}
 if(primary.status!=='AVAILABLE'){
  // If the primary responded but failed identity, freshness or arithmetic
  // validation, never mask that warning with a second-provider fallback.
  // Fall back ONLY for transport/provider outage.
  if(primary.reasonCode!=='MFNAV_PRIMARY_SOURCE_UNAVAILABLE')return primary;
  const secondaryHistory=await getMfapiHistoryResearch(code);
  if(secondaryHistory.status!=='AVAILABLE')return {
   status:'UNAVAILABLE',postTaxAvailable:false,postTaxFutureValue:null,
   reasonCode:'BOTH_FREE_NAV_HISTORY_SOURCES_UNAVAILABLE',
   sourceChecks:{status:'UNAVAILABLE',primaryReason:primary.reasonCode,
    secondaryReason:secondaryHistory.reasonCode,independentUnderlyingFeed:false},
  };
  return {...secondaryHistory,sourceChecks:{
   status:'SINGLE_SOURCE',primaryProvider:'mfnav.in',
   primaryReason:primary.reasonCode,secondaryProvider:'MFapi.in',
   independentUnderlyingFeed:false,productionUseAllowed:false,
   reasonCode:'MFNAV_PRIMARY_SOURCE_UNAVAILABLE',
  }};
 }
 const secondary=await getMfapiLatest(code);
 const crossCheck=reconcileFreeNavSources(primary,secondary);
 if(crossCheck.status==='CONFLICT')return {
  status:'UNAVAILABLE',reasonCode:crossCheck.reasonCode,postTaxAvailable:false,
  postTaxFutureValue:null,sourceChecks:crossCheck,
 };
 return {...primary,sourceChecks:crossCheck};
}
const smallCashflowSchema=Joi.object({
 productId:Joi.string().pattern(/^[a-z0-9:_-]{4,100}$/).required(),
 principal:Joi.number().integer().min(1000).max(1e10).required(),
}).unknown(false);

router.use((req,res,next)=>{
 res.set('Cache-Control','private, no-store');
 next();
});
// Apply per-user/provider quota AFTER JWT verification, never to anonymous traffic.
router.get('/mutual-funds/search',verifyJWT,freeProviderLimiter,validateQuery(searchSchema),asyncHandler(async(req,res)=>{
 try{return res.json(await searchFreeFunds(req.query.q));}
 catch{return sendError(req,res,503,'Free mutual-fund research source is unavailable.','FREE_NAV_SOURCE_UNAVAILABLE');}
}));
router.get('/mutual-funds/:schemeCode',verifyJWT,freeProviderLimiter,asyncHandler(async(req,res)=>{
 const {error}=schemeCode.validate(req.params.schemeCode);
 if(error)return sendError(req,res,400,'Invalid scheme code.','SCHEME_CODE_INVALID');
 try{return res.json(await loadResearchWithMirror(req.params.schemeCode));}
 catch{return sendError(req,res,503,'Free mutual-fund research source is unavailable.','FREE_NAV_SOURCE_UNAVAILABLE');}
}));
router.post('/mutual-funds/simulate',verifyJWT,freeProviderLimiter,validate(simulateSchema),asyncHandler(async(req,res)=>{
 let nav;
 try{nav=await loadResearchWithMirror(req.body.schemeCode);}
 catch{return sendError(req,res,503,'Free NAV source unavailable.','FREE_NAV_SOURCE_UNAVAILABLE');}
 if(nav.status!=='AVAILABLE')return res.json({
  status:'UNAVAILABLE',reasonCode:nav.reasonCode,
  dataClass:'RESEARCH_ONLY_AMFI_DERIVED_NAV',postTaxAvailable:false,
  postTaxFutureValue:null,grossScenario:null,
  sourceChecks:nav.sourceChecks||null,
 });
 const {schemeCode,...scenario}=req.body;
 let result;
 try {
  result=await executeMonteCarlo({...scenario,
   annualVolatility:nav.observedAnnualVolatility,
  });
 } catch(error) {
  if(error?.code==='SIMULATION_WEALTH_PRECISION_EXCEEDED')return res.json({
   status:'UNAVAILABLE',reasonCode:'SIMULATION_WEALTH_PRECISION_EXCEEDED',
   dataClass:'UNVERIFIED_NAV_RISK_USER_DECLARED_EXPECTED_RETURN',
   postTaxAvailable:false,postTaxFutureValue:null,grossScenario:null,
   sourceChecks:nav.sourceChecks||null,
   productionInvestmentQualification:false,
  });
  throw error;
 }
 // No market-history rights/issuer tax qualification is assumed.
 return res.json({
  status:'CALCULATED',dataClass:'UNVERIFIED_NAV_RISK_USER_DECLARED_EXPECTED_RETURN',
  futureReturnsGuaranteed:false,sourceRightsStatus:nav.sourceRightsStatus,
  productionInvestmentQualification:false,
  persistenceStatus:'NOT_STORED_RESEARCH_ONLY',
  asset:{...nav.fund,latestNav:nav.latestNav,navDate:nav.latestNavDate},
  source:nav.source,
  sourceChecks:nav.sourceChecks,
  calibration:{
   observedAnnualVolatility:nav.observedAnnualVolatility,
   historicalNavCount:nav.sampleCount,
   firstNavDate:nav.firstNavDate,lastNavDate:nav.latestNavDate,
   basis:nav.volatilityBasis,
  },
  expectedReturnBasis:'EXPLICIT_USER_ASSUMPTION_NOT_PREDICTED_FROM_NAV',
  grossScenario:result,
  postTaxAvailable:false,postTaxFutureValue:null,
  postTaxReasonCode:'NO_PRODUCT_SPECIFIC_VERIFIED_TAX_AND_TRANSACTION_FACTS',
  exclusions:nav.exclusions,
 });
}));
router.get('/coverage',verifyJWT,freeProviderLimiter,asyncHandler(async(req,res)=>
 res.json(getFreeFinancialSourceDirectory())));
router.get('/small-savings',verifyJWT,freeProviderLimiter,asyncHandler(async(req,res)=>
 res.json(getPublicSmallSavingsRates())));
router.post('/small-savings/calculate',verifyJWT,freeProviderLimiter,validate(smallCashflowSchema),
 asyncHandler(async(req,res)=>res.json(calculatePublicSmallSavingsGrossResearch(req.body))));
export default router;
