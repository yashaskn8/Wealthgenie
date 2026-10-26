import { createError } from '../middleware/errorHandler.js';
import { validateSovereignTaskPlan } from './sovereignTaskPlanPolicy.js';
import { compareVoiceSipScenarios } from './voiceSipComparison.js';

export const SOVEREIGN_READ_ONLY_PREVIEW_VERSION = 'sovereign-task-preview-v1';

function fail(status, code, message) {
  return createError(status, message, message, { code });
}
function active(signal) {
  if (signal?.aborted) {
    throw fail(409, 'SOVEREIGN_PREVIEW_CANCELLED', 'Preview cancelled. No navigation or financial changes were applied.');
  }
}

/**
 * Runs only approved, read-only financial calculations. APP_NAVIGATE steps are
 * returned as proposals: this server never clicks, navigates, or writes.
 * Rejected plans do not execute any tools, and failed previews return no
 * partial success receipt. No model, web, browser or filesystem access.
 */
export async function previewSovereignReadOnlyTask({
  userId, plan, resolveProfile, financialRegistry, signal
}) {
  if (!userId || typeof userId !== 'string') {
    throw fail(401, 'SOVEREIGN_PREVIEW_AUTH_REQUIRED', 'Sign in before previewing tasks.');
  }
  const validated=validateSovereignTaskPlan(plan);
  if(!validated.ok) {
    throw fail(422,'SOVEREIGN_PREVIEW_PLAN_REJECTED','Task plan rejected. No action was executed.');
  }
  // One comparison uses two supported deterministic projections. Bound total work.
  const financialSteps=validated.steps.filter(s=>s.operation==='SIP_COMPARE_DRAFT');
  if(financialSteps.length>1) {
    throw fail(422,'SOVEREIGN_PREVIEW_BUDGET_EXCEEDED','One financial comparison is allowed per task preview.');
  }
  active(signal);
  const stepsById=new Map(validated.steps.map(step=>[step.id,step]));
  const receipts=[];
  const completed=new Set();
  for(const wave of validated.waves) {
    // Sequential execution prevents accidental concurrent financial requests.
    for(const id of wave) {
      active(signal);
      const step=stepsById.get(id);
      if(!step || step.dependsOn.some(dep=>!completed.has(dep))) {
        throw fail(422,'SOVEREIGN_PREVIEW_DEPENDENCY_FAILED','Task dependencies could not be verified.');
      }
      if(step.operation==='APP_NAVIGATE') {
        receipts.push({
          id,kind:'NAVIGATION_PROPOSAL',status:'PREVIEWED',
          page:step.arguments.page,tab:null,applied:false
        });
      } else if(step.operation==='SIP_COMPARE_DRAFT') {
        const comparison=await compareVoiceSipScenarios({
          userId,input:step.arguments,resolveProfile,financialRegistry,signal
        });
        active(signal);
        receipts.push({
          id,kind:'FINANCIAL_COMPARISON',status:'VERIFIED',
          comparison
        });
      } else {
        throw fail(422,'SOVEREIGN_PREVIEW_TOOL_DENIED','The requested task operation is not allowed.');
      }
      completed.add(id);
    }
  }
  active(signal);
  return {
    version:SOVEREIGN_READ_ONLY_PREVIEW_VERSION,
    classification:'READ_ONLY_USER_REVIEWED_PREVIEW',
    persisted:false,
    navigationApplied:false,
    financialStateModified:false,
    steps:receipts
  };
}
