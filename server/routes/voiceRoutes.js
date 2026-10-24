import { Router } from 'express';
import Joi from 'joi';
import { verifyJWT } from '../middleware/authMiddleware.js';
import { asyncHandler, createError } from '../middleware/errorHandler.js';
import { validate } from '../validation/schemas.js';
import { classifyVoiceIntent, VOICE_INTENT_VERSION } from '../services/voiceIntentPolicy.js';
import { resolveCurrentFinancialProfile } from '../services/currentFinancialProfile.js';
import { FinancialToolRegistry } from '../services/financialToolRegistry.js';
import { compareVoiceSipScenarios } from '../services/voiceSipComparison.js';


const transcriptSchema=Joi.object({ transcript:Joi.string().trim().min(1).max(1000).required() }).unknown(false);

const compareSchema=Joi.object({
  monthlyInvestment: Joi.number().integer().min(100).max(10000000).required(),
  years: Joi.number().integer().min(1).max(30).required(),
  annualReturnAssumptionsPct: Joi.array().items(Joi.number().min(0.1).max(30).precision(3))
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
  router.post('/interpret',validate(transcriptSchema),asyncHandler(async(req,res)=>{
    res.json({...classifyVoiceIntent(req.body.transcript),version:VOICE_INTENT_VERSION});
  }));
  // Explicit user-reviewed inputs only; not parsed or executed from raw ASR.
  router.post('/sip-compare',validate(compareSchema),asyncHandler(async(req,res)=>{
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
