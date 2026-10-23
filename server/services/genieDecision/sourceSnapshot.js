import crypto from 'node:crypto';
import { fromPaise } from './ledger.js';

// Immutable, disclosure-friendly record of precisely what the decision worker used.
// Current V1 facts are USER_DECLARED. No bank/broker verification is asserted.
const fields = Object.freeze([
  ['openingLiquidCash', 'liquidSavings'],
  ['monthlyTakeHome', 'monthlyTakeHome'],
  ['declaredMonthlySavings', 'monthlySavings'],
]);
function exactMoney(number, field) {
  if (typeof number !== 'number' || !Number.isFinite(number) || number < 0
      || !Number.isSafeInteger(Math.round(number * 100))
      || Math.abs(number * 100 - Math.round(number * 100)) > 0.000001) {
    throw new Error('INVALID_DECISION_SNAPSHOT_SOURCE_' + field);
  }
  return fromPaise(BigInt(Math.round(number * 100)));
}
export function makeDecisionSourceSnapshot(current, ingestedAt = new Date().toISOString()) {
  if (!current?.profile || current.state?.resolutionStatus !== 'CURRENT'
      || !Number.isSafeInteger(current.state.revision) || current.state.revision < 1
      || !/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$/.test(ingestedAt)) {
    throw new Error('DECISION_SNAPSHOT_SOURCE_UNAVAILABLE');
  }
  const profile = current.profile;
  return {
    schemaVersion: 'decision-source-snapshot-1.0.0',
    profileId: String(profile._id),
    profileStateRevision: current.state.revision,
    profileVersion: profile.version,
    profileFinancialFence: Number(profile.financialStateFence ?? 0),
    ingestedAt,
    facts: fields.map(([field, profileField]) => ({
      field, value: exactMoney(profile[profileField], field),
      sourceType: 'USER_DECLARED', sourceReference: String(profile._id),
      observedAt: null, ingestedAt,
      verificationStatus: 'DECLARED',
      consentReference: null, rightsDecision: 'FIRST_PARTY_USER_INPUT',
    })),
  };
}
export function hashDecisionSourceSnapshot(snapshot) {
  return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}
export function verifyDecisionSourceSnapshot(snapshot, candidate) {
  if (!snapshot || snapshot.schemaVersion !== 'decision-source-snapshot-1.0.0'
      || !Array.isArray(snapshot.facts) || snapshot.facts.length !== fields.length
      || snapshot.profileId !== String(candidate.profileId)
      || snapshot.profileStateRevision !== candidate.profileStateRevision
      || snapshot.profileVersion !== candidate.profileVersion
      || snapshot.profileFinancialFence !== candidate.profileFinancialFence
      || snapshot.facts.some((fact, index) => fact.field !== fields[index][0]
        || typeof fact.value !== 'string'
        || !/^(?:0|[1-9]\\d{0,11})\\.\\d{2}$/.test(fact.value)
        || fact.sourceType !== 'USER_DECLARED'
        || fact.sourceReference !== snapshot.profileId
        || fact.observedAt !== null || fact.ingestedAt !== snapshot.ingestedAt
        || fact.verificationStatus !== 'DECLARED'
        || fact.consentReference !== null || fact.rightsDecision !== 'FIRST_PARTY_USER_INPUT')
      || hashDecisionSourceSnapshot(snapshot) !== candidate.sourceSnapshotHash) {
    const error = new Error('Financial source snapshot integrity verification failed.');
    error.code = 'DECISION_ASSESSMENT_INTEGRITY_FAILURE';
    throw error;
  }
}
