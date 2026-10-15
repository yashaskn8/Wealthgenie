import { buildGroundedEvidencePacket, makeEvidenceEntry } from './groundedEvidence.js';
import { generateGroundedExplanation } from './groundedExplanationService.js';

const ADVISORY_PROFILE_KEYS = Object.freeze([
  'monthlyTakeHome', 'monthlySavings', 'savingsRate', 'age', 'riskTolerance',
  'suitabilityRisk', 'liquidSavings', 'emiBurdenPct', 'financialDependents',
  'emergencyFundMonths', 'investmentGoals', 'investmentHorizonYears',
  'deployableLumpSum', 'suitabilityReasonCodes', 'taxEligibilityStatus',
]);

const GOAL_PLAN_STATUSES = new Set(['on_track', 'at_risk', 'off_track']);

function compactGoalPlanEvidence(goalEvidence) {
  if (!goalEvidence || typeof goalEvidence !== 'object' || Array.isArray(goalEvidence)) return null;
  const requiredSip = goalEvidence.recommendedSip;
  const savingsCapacity = goalEvidence.monthlySavingsCapacity;
  const status = GOAL_PLAN_STATUSES.has(goalEvidence.status) ? goalEvidence.status : null;
  const contributionWithinSavingsCapacity = Number.isFinite(requiredSip) && requiredSip >= 0
    && Number.isFinite(savingsCapacity) && savingsCapacity >= 0
    ? requiredSip <= savingsCapacity
    : null;
  return status || contributionWithinSavingsCapacity !== null
    ? { status, contributionWithinSavingsCapacity }
    : null;
}

export async function generateAdvisory(userContext) {
  const { profile, instruments, shapExplanation, modelVersion, policyVersion } = userContext;

  if (!profile || !Number.isFinite(profile.monthlyTakeHome) || !Number.isFinite(profile.monthlySavings)) {
    throw new TypeError('generateAdvisory requires canonical Financial Profile context');
  }
  const profileKeys = Object.keys(profile).sort();
  if (profileKeys.length !== ADVISORY_PROFILE_KEYS.length
      || ADVISORY_PROFILE_KEYS.some(key => !Object.hasOwn(profile, key))) {
    throw new TypeError('generateAdvisory requires the exact allowlisted LLM Financial Profile context');
  }
  if (typeof modelVersion !== 'string' || !modelVersion.trim()
      || typeof policyVersion !== 'string' || !policyVersion.trim()) {
    throw new TypeError('generateAdvisory requires explicit model and policy versions');
  }
  const additionalEntries = [];
  const topReason = typeof shapExplanation?.top_reason === 'string'
    ? shapExplanation.top_reason.trim()
    : '';
  if (topReason && topReason.length <= 240 && /^[\p{L}][\p{L}\s,'’.\-]*$/u.test(topReason)) {
    additionalEntries.push(makeEvidenceEntry('E_REC_EXPLANATION', 'RECOMMENDATION', {
      topReason,
    }, {
      dataClass: 'AUTHORITATIVE_BACKEND_RESULT',
      displayValue: String(shapExplanation.top_reason),
    }));
  }
  additionalEntries.push(makeEvidenceEntry('E_REC_VERSIONS', 'RECOMMENDATION', {
    modelVersion,
    policyVersion,
  }, {
    dataClass: 'REFERENCE_METADATA',
    displayValue: `Recommendation model ${modelVersion}; policy ${policyVersion}`,
  }));
  const evidencePacket = buildGroundedEvidencePacket({
    question: 'Explain why the authoritative recommendation suits this Financial Profile.',
    profile,
    recommendation: { instruments, modelVersion, profileInputHash: null },
    additionalEntries,
    purpose: 'RECOMMENDATION_EXPLANATION',
  });
  const result = await generateGroundedExplanation({
    question: 'Explain why the authoritative recommendation suits this Financial Profile.',
    evidencePacket,
  });
  return { ...result, modelUsed: result.model, cited_chunks: result.evidenceIdsUsed };
}

export async function getGoalAdvisory(message, profileContext, goalEvidence = null) {
  const compactGoalEvidence = compactGoalPlanEvidence(goalEvidence);
  const entries = compactGoalEvidence ? [makeEvidenceEntry('E_GOAL_PLAN', 'GOAL_PLAN', compactGoalEvidence, {
    dataClass: 'AUTHORITATIVE_BACKEND_RESULT',
    displayValue: `Goal status ${compactGoalEvidence.status || 'unavailable'}; required monthly contribution is ${compactGoalEvidence.contributionWithinSavingsCapacity === null
      ? 'not verified against'
      : compactGoalEvidence.contributionWithinSavingsCapacity ? 'within' : 'above'} profile savings capacity.`,
  })] : [];
  const question = compactGoalEvidence
    ? 'Suggest one adjustment to the saved goal using only its verified status and whether its monthly contribution fits within savings capacity. Do not calculate or assume exact amounts or returns.'
    : message;
  const evidencePacket = buildGroundedEvidencePacket({
    question,
    profile: profileContext,
    additionalEntries: entries,
    unavailableFacts: compactGoalEvidence ? [] : ['GOAL_PLAN_EVIDENCE_UNAVAILABLE'],
    purpose: 'GOAL_PLAN_EXPLANATION',
  });
  const result = await generateGroundedExplanation({ question, evidencePacket });
  return result.text;
}
