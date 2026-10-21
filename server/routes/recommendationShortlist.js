import { Router } from 'express';
import Joi from 'joi';
import { verifyJWT } from '../middleware/authMiddleware.js';
import { validate, validateQuery } from '../validation/schemas.js';
import { asyncHandler, sendError } from '../middleware/errorHandler.js';
import { requireFreshRecommendationState } from '../services/recommendationState.js';
import { buildRiskShortlist } from '../services/riskShortlist.js';
import RecommendationShortlist from '../models/RecommendationShortlist.js';
const router=Router();
const schema=Joi.object({profileId:Joi.string().pattern(/^[a-fA-F0-9]{24}$/).required()}).unknown(false);
function binding(state) {
 return {userId:state.profile.userId,profileId:state.profile._id,
  recommendationId:state.recommendation._id,
  allocationRevisionId:state.allocationRevision._id,
  profileVersion:state.profileVersion,
  portfolioFingerprint:state.portfolioFingerprint};
}
function selections(state){
 const current=state.currentAllocation?.instruments;
 if(!Array.isArray(current))throw Object.assign(new Error('Current allocation is not qualified'),{status:503,code:'SHORTLIST_SOURCE_MISSING'});
 return buildRiskShortlist({profile:state.profile,instruments:current});
}
router.get('/',verifyJWT,validateQuery(schema),asyncHandler(async(req,res)=>{
 const state=await requireFreshRecommendationState({userId:req.user.userId,profileId:req.query.profileId});
 const shortlist=selections(state);
 res.set('Cache-Control','private, no-store');
 res.json({status:'PROFILE_APPROVED_PARENT_CHOICES',...shortlist,source:binding(state)});
}));
router.post('/save',verifyJWT,validate(schema),asyncHandler(async(req,res)=>{
 const options={userId:req.user.userId,profileId:req.body.profileId};
 const state=await requireFreshRecommendationState(options);
 const shortlist=selections(state);
 const source=binding(state);
 const groupedPicks=Object.values(shortlist.groups).flat();
 const uniqueKey={userId:source.userId,profileId:source.profileId,
  recommendationId:source.recommendationId,allocationRevisionId:source.allocationRevisionId};
 let saved=await RecommendationShortlist.findOne(uniqueKey).lean();
 if(saved && (saved.portfolioFingerprint!==source.portfolioFingerprint
    ||saved.profileVersion!==source.profileVersion)){
  return sendError(req,res,409,'Saved shortlist belongs to a different financial state.','SHORTLIST_STATE_CONFLICT');
 }
 if(!saved){
   try {saved=await RecommendationShortlist.create({...source,groupedPicks});}
   catch(error){
     if(error?.code!==11000)throw error;
     saved=await RecommendationShortlist.findOne(uniqueKey).lean();
     if(!saved||saved.portfolioFingerprint!==source.portfolioFingerprint){
       return sendError(req,res,409,'Conflicting saved shortlist financial state.','SHORTLIST_STATE_CONFLICT');
     }
   }
 }
 const current=await requireFreshRecommendationState(options);
 if(String(current.allocationRevision?._id)!==String(source.allocationRevisionId)
   ||String(current.recommendation?._id)!==String(source.recommendationId)
   ||current.profileVersion!==source.profileVersion
   ||current.portfolioFingerprint!==source.portfolioFingerprint){
   return sendError(req,res,409,'Financial state changed; saved shortlist is historical.','SHORTLIST_STATE_CHANGED');
 }
 res.set('Cache-Control','private, no-store');
 return res.json({status:'SAVED',shortlistId:String(saved._id),...shortlist,source});
}));
export default router;
