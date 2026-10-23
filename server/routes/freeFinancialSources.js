import {Router} from 'express';
import Joi from 'joi';
import {verifyJWT} from '../middleware/authMiddleware.js';
import {validate,validateQuery} from '../validation/schemas.js';
import {asyncHandler,sendError} from '../middleware/errorHandler.js';
import {searchFreeFunds,getFreeFundNavResearch} from '../services/freeMutualFundNav.js';
import {
 getPublicSmallSavingsRates,calculatePublicSmallSavingsGrossResearch,
} from '../services/publicSmallSavingsResearch.js';
import {executeMonteCarlo} from '../services/monteCarloExecutor.js';

const router=Router();
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
const smallCashflowSchema=Joi.object({
 productId:Joi.string().pattern(/^[a-z0-9:_-]{4,100}$/).required(),
 principal:Joi.number().integer().min(1000).max(1e10).required(),
}).unknown(false);

router.use((req,res,next)=>{
 res.set('Cache-Control','private, no-store');
 next();
});
router.get('/mutual-funds/search',verifyJWT,validateQuery(searchSchema),asyncHandler(async(req,res)=>{
 try{return res.json(await searchFreeFunds(req.query.q));}
 catch{return sendError(req,res,503,'Free mutual-fund research source is unavailable.','FREE_NAV_SOURCE_UNAVAILABLE');}
}));
router.get('/mutual-funds/:schemeCode',verifyJWT,asyncHandler(async(req,res)=>{
 const {error}=schemeCode.validate(req.params.schemeCode);
 if(error)return sendError(req,res,400,'Invalid scheme code.','SCHEME_CODE_INVALID');
 try{return res.json(await getFreeFundNavResearch(req.params.schemeCode));}
 catch{return sendError(req,res,503,'Free mutual-fund research source is unavailable.','FREE_NAV_SOURCE_UNAVAILABLE');}
}));
router.post('/mutual-funds/simulate',verifyJWT,validate(simulateSchema),asyncHandler(async(req,res)=>{
 let nav;
 try{nav=await getFreeFundNavResearch(req.body.schemeCode);}
 catch{return sendError(req,res,503,'Free NAV source unavailable.','FREE_NAV_SOURCE_UNAVAILABLE');}
 if(nav.status!=='AVAILABLE')return res.json({
  status:'UNAVAILABLE',reasonCode:nav.reasonCode,
  dataClass:'RESEARCH_ONLY_AMFI_DERIVED_NAV',postTaxAvailable:false,
  postTaxFutureValue:null,grossScenario:null,
 });
 const {schemeCode,...scenario}=req.body;
 const result=await executeMonteCarlo({...scenario,
  annualVolatility:nav.observedAnnualVolatility,
 });
 // No market-history rights/issuer tax qualification is assumed.
 return res.json({
  status:'CALCULATED',dataClass:'UNVERIFIED_NAV_RISK_USER_DECLARED_EXPECTED_RETURN',
  futureReturnsGuaranteed:false,sourceRightsStatus:nav.sourceRightsStatus,
  productionInvestmentQualification:false,
  persistenceStatus:'NOT_STORED_RESEARCH_ONLY',
  asset:{...nav.fund,latestNav:nav.latestNav,navDate:nav.latestNavDate},
  source:nav.source,
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
router.get('/small-savings',verifyJWT,asyncHandler(async(req,res)=>
 res.json(getPublicSmallSavingsRates())));
router.post('/small-savings/calculate',verifyJWT,validate(smallCashflowSchema),
 asyncHandler(async(req,res)=>res.json(calculatePublicSmallSavingsGrossResearch(req.body))));
export default router;
