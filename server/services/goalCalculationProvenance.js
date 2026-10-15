import crypto from 'node:crypto';

// Bump whenever the deterministic goal calculation's inputs or policy change.
// Legacy results without this identity are intentionally stale until recalculated.
export const GOAL_CALCULATION_POLICY_VERSION = 'goal-plan-policy-1.0.2';

const MILLISECONDS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/**
 * Match the monthly horizon used by the projection engine. A stored plan
 * becomes stale when passage of time moves it into a different modeled month;
 * callers must not silently persist a replacement calculation.
 */
export function getGoalProjectionYearsRemaining(targetDate, now = new Date()) {
  const date = targetDate ? new Date(targetDate) : null;
  const currentDate = now instanceof Date ? now : new Date(now);
  if (!date || Number.isNaN(date.getTime()) || Number.isNaN(currentDate.getTime())) return null;
  if (date <= currentDate) return null;
  const totalMonths = Math.round(((date - currentDate) / MILLISECONDS_PER_YEAR) * 12);
  return Number.isFinite(totalMonths) && totalMonths >= 1 ? totalMonths / 12 : null;
}

export function buildGoalCalculationInputFingerprint(goal) {
  const goalId = goal?._id ? String(goal._id) : String(goal?.goalId || '');
  const profileId = goal?.profileId ? String(goal.profileId) : '';
  const targetAmount = Number(goal?.target_amount);
  const currentSavings = Number(goal?.current_savings);
  const targetDate = goal?.target_date ? new Date(goal.target_date) : null;
  const inflationAssumption = Number(goal?.inflation_assumption);
  const modeledYearsRemaining = Number(goal?.years_remaining);

  if (!goalId || !profileId || !Number.isFinite(targetAmount) || targetAmount < 0
      || !Number.isFinite(currentSavings) || currentSavings < 0
      || !targetDate || Number.isNaN(targetDate.getTime())
      || !Number.isFinite(modeledYearsRemaining) || modeledYearsRemaining <= 0
      || !Number.isFinite(inflationAssumption) || inflationAssumption < 0 || inflationAssumption > 1) {
    return null;
  }

  const payload = {
    goalId,
    profileId,
    targetAmount,
    targetDate: targetDate.toISOString(),
    currentSavings,
    modeledYearsRemaining,
    inflationAssumption,
    calculationPolicyVersion: GOAL_CALCULATION_POLICY_VERSION,
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
