import { Router } from 'express';
import Joi from 'joi';
import { verifyJWT } from '../middleware/authMiddleware.js';
import { asyncHandler, createError } from '../middleware/errorHandler.js';
import { validate } from '../validation/schemas.js';
import { createEndpointRateLimiter } from '../middleware/rateLimiter.js';
import { classifyVoiceIntent, VOICE_INTENT_VERSION } from '../services/voiceIntentPolicy.js';
import { resolveCurrentFinancialProfile } from '../services/currentFinancialProfile.js';
import { FinancialToolRegistry } from '../services/financialToolRegistry.js';
import { compareVoiceSipScenarios } from '../services/voiceSipComparison.js';


const transcriptSchema=Joi.object({ transcript:Joi.string().trim().min(1).max(1000).required() }).unknown(false);

// These are separate distributed quotas in production. They fail closed if the
// shared rate-limit store is unavailable, unlike the permissive general API cap.
const interpretLimiter=()=>createEndpointRateLimiter({
  windowMs:60_000,max:40,prefix:'rl:ep:genievoice:interpret:',
  keyGenerator:req=>String(req.user.userId)
});
const comparisonLimiter=()=>createEndpointRateLimiter({
  windowMs:60_000,max:12,prefix:'rl:ep:genievoice:sip:',
  keyGenerator:req=>String(req.user.userId)
});

const compareSchema=Joi.object({
  monthlyInvestment: Joi.number().integer().min(100).max(10000000).required(),
  years: Joi.number().integer().min(1).max(30).required(),
  // Strict numeric validation prevents Joi's default conversion/rounding of
  // user-approved percentages (e.g. 7.12345 must not become 7.123).
  annualReturnAssumptionsPct: Joi.array().items(Joi.number().strict().min(0.1).max(30).precision(3))
    .length(2).unique().required(),
}).unknown(false);

export function createVoiceRouter({
  enabled=false,
  resolveProfile=resolveCurrentFinancialProfile,
  financialRegistry=FinancialToolRegistry,
}={}) {
  const router=Router();
  router.use(verifyJWT);
  router.use((_req,res,next)=>{
    res.setHeader('Cache-Control','no-store');
    if(!enabled)return next(createError(404,'GenieVoice tasks are disabled.','Voice tasks are not enabled.',{code:'VOICE_TASKS_DISABLED'}));
    return next();
  });
  router.post('/interpret',interpretLimiter(),validate(transcriptSchema),asyncHandler(async(req,res)=>{
    res.json({...classifyVoiceIntent(req.body.transcript),version:VOICE_INTENT_VERSION});
  }));
  // Explicit user-reviewed inputs only; not parsed or executed from raw ASR.
  router.post('/sip-compare',comparisonLimiter(),validate(compareSchema),asyncHandler(async(req,res)=>{
    const comparison=await compareVoiceSipScenarios({
      userId:req.user.userId,
      input:req.body,
      resolveProfile,
      financialRegistry,
    });
    res.json(comparison);
  }));
  return router;
}
