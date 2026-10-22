import { Router } from 'express';
import { createHash } from 'node:crypto';
import Joi from 'joi';
import { verifyJWT } from '../middleware/authMiddleware.js';
import { validate, validateQuery } from '../validation/schemas.js';
import { asyncHandler, sendError } from '../middleware/errorHandler.js';
import { requireFreshRecommendationState } from '../services/recommendationState.js';
import { buildRiskShortlist, RISK_SHORTLIST_POLICY_VERSION } from '../services/riskShortlist.js';
import RecommendationShortlist from '../models/RecommendationShortlist.js';

const router = Router();
const schema = Joi.object({
  profileId: Joi.string().pattern(/^[a-fA-F0-9]{24}$/).required(),
}).unknown(false);

function binding(state) {
  return {
    userId: state.profile.userId,
    profileId: state.profile._id,
    recommendationId: state.recommendation._id,
    allocationRevisionId: state.allocationRevision._id,
    profileVersion: state.profileVersion,
    portfolioFingerprint: state.portfolioFingerprint,
  };
}
function selections(state) {
  const current = state.currentAllocation?.instruments;
  if (!Array.isArray(current)) {
    return null;
  }
  return buildRiskShortlist({ profile:state.profile, instruments:current });
}
function identity(source) {
  return {
    userId:source.userId,profileId:source.profileId,
    recommendationId:source.recommendationId,allocationRevisionId:source.allocationRevisionId,
  };
}
function selectionFingerprint(source, shortlist) {
  return createHash('sha256').update(JSON.stringify({
    identity: Object.fromEntries(Object.entries(source).map(([k,v])=>[k,String(v)])),
    shortlistPolicyVersion: RISK_SHORTLIST_POLICY_VERSION,
    groupedPicks:Object.values(shortlist.groups).flat(),
  })).digest('hex');
}
router.get('/', verifyJWT, validateQuery(schema), asyncHandler(async(req,res)=>{
  const state = await requireFreshRecommendationState({
    userId:req.user.userId,profileId:req.query.profileId,
  });
  const shortlist = selections(state);
  if(!shortlist) return sendError(req,res,503,'Authoritative allocation is unavailable.','SHORTLIST_SOURCE_MISSING');
  res.set('Cache-Control','private, no-store');
  return res.json({status:'PROFILE_ELIGIBLE_PARENT_CATEGORIES',...shortlist,source:binding(state)});
}));
router.get('/saved', verifyJWT, validateQuery(schema), asyncHandler(async(req,res)=>{
  const state = await requireFreshRecommendationState({
    userId:req.user.userId,profileId:req.query.profileId,
  });
  const source = binding(state);
  const saved = await RecommendationShortlist.findOne(identity(source)).lean();
  res.set('Cache-Control','private, no-store');
  if(!saved) return res.json({status:'NOT_SAVED',savedShortlist:null,source});
  if(saved.profileVersion!==source.profileVersion
    ||saved.portfolioFingerprint!==source.portfolioFingerprint
    ||saved.shortlistPolicyVersion!==RISK_SHORTLIST_POLICY_VERSION) {
    return sendError(req,res,409,'The saved shortlist belongs to a superseded financial state.',
      'SHORTLIST_STATE_CHANGED');
  }
  return res.json({status:'SAVED',savedShortlist:{
    id:String(saved._id),shortlistPolicyVersion:saved.shortlistPolicyVersion,
    createdAt:saved.createdAt,groupedPicks:saved.groupedPicks,
  },source});
}));
router.post('/save', verifyJWT, validate(schema), asyncHandler(async(req,res)=>{
  const options = {userId:req.user.userId,profileId:req.body.profileId};
  const state = await requireFreshRecommendationState(options);
  const shortlist = selections(state);
  if(!shortlist) return sendError(req,res,503,'Authoritative allocation is unavailable.','SHORTLIST_SOURCE_MISSING');
  const source = binding(state);
  const groupedPicks=Object.values(shortlist.groups).flat();
  const fingerprint=selectionFingerprint(source,shortlist);
  const uniqueKey=identity(source);
  let saved=await RecommendationShortlist.findOne(uniqueKey).lean();
  if(saved && (saved.portfolioFingerprint!==source.portfolioFingerprint
    ||saved.profileVersion!==source.profileVersion
    ||saved.selectionFingerprint!==fingerprint
    ||saved.shortlistPolicyVersion!==RISK_SHORTLIST_POLICY_VERSION)) {
    return sendError(req,res,409,'Saved shortlist conflicts with the current financial policy or profile.',
      'SHORTLIST_STATE_CONFLICT');
  }
  if(!saved) {
    try {
      saved=await RecommendationShortlist.create({
        ...source,groupedPicks,selectionFingerprint:fingerprint,
        shortlistPolicyVersion:RISK_SHORTLIST_POLICY_VERSION,
      });
    } catch(error) {
      if(error?.code!==11000)throw error;
      saved=await RecommendationShortlist.findOne(uniqueKey).lean();
      if(!saved || saved.selectionFingerprint!==fingerprint
        ||saved.portfolioFingerprint!==source.portfolioFingerprint) {
        return sendError(req,res,409,'Concurrent shortlist publication conflict.','SHORTLIST_STATE_CONFLICT');
      }
    }
  }
  const current=await requireFreshRecommendationState(options);
  if(String(current.allocationRevision?._id)!==String(source.allocationRevisionId)
    ||String(current.recommendation?._id)!==String(source.recommendationId)
    ||current.profileVersion!==source.profileVersion
    ||current.portfolioFingerprint!==source.portfolioFingerprint) {
    return sendError(req,res,409,'Financial state changed; the saved shortlist is historical.',
      'SHORTLIST_STATE_CHANGED');
  }
  res.set('Cache-Control','private, no-store');
  return res.json({status:'SAVED',shortlistId:String(saved._id),...shortlist,source});
}));
export default router;
