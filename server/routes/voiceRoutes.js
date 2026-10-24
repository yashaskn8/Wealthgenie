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
import { previewSovereignReadOnlyTask } from '../services/sovereignReadOnlyTaskPreview.js';
import {
  getSovereignTaskReceipt,recordSovereignTaskPreview
} from '../services/sovereignTaskReceiptStore.js';


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

const taskPreviewSchema=Joi.object({
  plan:Joi.object({
    version:Joi.string().valid('sovereign-task-plan-v1').required(),
    // Pure task validator checks the complete structural and action allowlists.
    steps:Joi.array().min(1).max(6).required()
  }).unknown(false).required()
}).unknown(false);

const recordedPreviewSchema=taskPreviewSchema.keys({
  persistReceipt:Joi.boolean().valid(true).required()
});
const taskReceiptReadLimiter=()=>createEndpointRateLimiter({
  windowMs:60_000,max:30,prefix:'rl:ep:genievoice:receipt-read:',
  keyGenerator:req=>String(req.user.userId)
});
const taskPreviewLimiter=()=>createEndpointRateLimiter({
  windowMs:60_000,max:6,prefix:'rl:ep:genievoice:preview:',
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
  enabled=false,receiptsEnabled=false,
  resolveProfile=resolveCurrentFinancialProfile,
  financialRegistry=FinancialToolRegistry,
  receiptRepository,ensureReceiptReady,receiptHashSecret,
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
    const cancel=new AbortController();
    const onDisconnect=()=>cancel.abort();
    res.once('close',onDisconnect);
    try {
      const signal=AbortSignal.any([cancel.signal,AbortSignal.timeout(12_000)]);
      const comparison=await compareVoiceSipScenarios({
        userId:req.user.userId,
        input:req.body,
        resolveProfile,
        financialRegistry,
        signal
      });
      if(!signal.aborted && !res.destroyed)res.json(comparison);
    } finally {
      res.off('close',onDisconnect);
    }
  }));
  // No planner autonomy: client supplies a reviewable plan and receives
  // independently validated proposals/calculations, never executed navigation.
  router.post('/task-preview',taskPreviewLimiter(),validate(taskPreviewSchema),asyncHandler(async(req,res)=>{
    const cancel=new AbortController();
    const onDisconnect=()=>cancel.abort();
    res.once('close',onDisconnect);
    try {
      const signal=AbortSignal.any([cancel.signal,AbortSignal.timeout(12_000)]);
      const preview=await previewSovereignReadOnlyTask({
        userId:req.user.userId,
        plan:req.body.plan,resolveProfile,financialRegistry,signal
      });
      if(!signal.aborted && !res.destroyed)res.json(preview);
    } finally {
      res.off('close',onDisconnect);
    }
  }));
  // Explicit opt-in persistence is restricted to NON-MUTATING receipt metadata.
  // The original /task-preview path remains completely unsaved.
  router.post('/task-preview/recorded',taskPreviewLimiter(),
    validate(recordedPreviewSchema),asyncHandler(async(req,res)=>{
      if(!receiptsEnabled)throw createError(404,'Task receipts are disabled.',
        'Task receipts are not enabled.',{code:'SOVEREIGN_RECEIPTS_DISABLED'});
      const cancel=new AbortController();
      const onDisconnect=()=>cancel.abort();
      res.once('close',onDisconnect);
      try {
        const signal=AbortSignal.any([cancel.signal,AbortSignal.timeout(12_000)]);
        const output=await recordSovereignTaskPreview({
          userId:req.user.userId,
          key:req.headers['idempotency-key'],
          plan:req.body.plan,signal,resolveProfile,financialRegistry,
          ...(receiptRepository?{repository:receiptRepository}:{}),
          ...(ensureReceiptReady?{ensureReady:ensureReceiptReady}:{}),
          ...(receiptHashSecret?{secret:receiptHashSecret}:{})
        });
        if(!signal.aborted&&!res.destroyed)
          res.status(output.outcome==='COMPLETED'?201:200).json(output);
      }finally{res.off('close',onDisconnect);}
    }));
  router.get('/task-preview/receipts/:id',taskReceiptReadLimiter(),
    asyncHandler(async(req,res)=>{
      if(!receiptsEnabled)throw createError(404,'Task receipts are disabled.',
        'Task receipts are not enabled.',{code:'SOVEREIGN_RECEIPTS_DISABLED'});
      const receipt=await getSovereignTaskReceipt({
        userId:req.user.userId,id:req.params.id,
        ...(receiptRepository?{repository:receiptRepository}:{}),
        ...(ensureReceiptReady?{ensureReady:ensureReceiptReady}:{})
      });
      res.json({receipt});
    }));
  return router;
}
