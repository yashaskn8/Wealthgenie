import { Router } from 'express';
import Joi from 'joi';
import { verifyJWT } from '../middleware/authMiddleware.js';
import { asyncHandler, createError } from '../middleware/errorHandler.js';
import { validate } from '../validation/schemas.js';
import { classifyVoiceIntent, VOICE_INTENT_VERSION } from '../services/voiceIntentPolicy.js';

const transcriptSchema=Joi.object({ transcript:Joi.string().trim().min(1).max(1000).required() }).unknown(false);

export function createVoiceRouter({ enabled=false }={}) {
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
  return router;
}
