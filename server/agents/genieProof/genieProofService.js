import crypto from 'node:crypto';
import mongoose from 'mongoose';
import GenieProofCase from '../../models/GenieProofCase.js';
import GenieProofRevision from '../../models/GenieProofRevision.js';
import ProofWatch from '../../models/ProofWatch.js';
import ProofBreakJob from '../../models/ProofBreakJob.js';
import ProofBreakEvent from '../../models/ProofBreakEvent.js';
import ProofNotificationOutbox from '../../models/ProofNotificationOutbox.js';
import { canonicalSha256 } from '../../utils/canonicalJson.js';
import { GENIEPROOF_MAX_CASES_PER_USER, getGenieProofExpiry } from './genieProofPolicy.js';
import {
  GENIEPROOF_EVIDENCE_VERIFIER_VERSION,
  buildGenieProofManifest,
  extractGenieProofClaims,
  verifyConfirmedGenieProofClaim,
} from './genieProofCore.js';

export const GENIEPROOF_SAVING_CONSENT_VERSION = 'genieproof-private-save/1';
const PROOFBREAK_EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

function serviceError(status, code, message) {
  return Object.assign(new Error(message), { status, code, clientMessage: message });
}

function isTransientTransactionConflict(error) {
  return error?.hasErrorLabel?.('TransientTransactionError') === true
    || error?.code === 112
    || error?.codeName === 'WriteConflict';
}

function validateConfirmation({ offerText, submissionHash, confirmedClaims }) {
  const extraction = extractGenieProofClaims(offerText);
  if (!extraction.ok) throw serviceError(400, extraction.code, 'The offer text could not be processed.');
  if (extraction.inputHash !== submissionHash) {
    throw serviceError(409, 'GENIEPROOF_INPUT_CHANGED', 'The submitted offer changed after claim extraction. Extract claims again before confirming.');
  }
  const extractedById = new Map(extraction.claims.map(claim => [claim.claimId, claim]));
  const submittedIds = new Set();
  const confirmationMatchesExtraction = confirmedClaims.every(claim => {
    const candidate = extractedById.get(claim.claimId);
    if (!candidate || submittedIds.has(claim.claimId)) return false;
    submittedIds.add(claim.claimId);
    const expected = {
      claimId: candidate.claimId,
      statement: candidate.originalSpan,
      claimType: candidate.claimType,
      productId: candidate.productId,
      value: Number.isFinite(candidate.value) ? candidate.value : null,
      unit: candidate.unit,
    };
    const submitted = {
      claimId: claim.claimId,
      statement: claim.statement,
      claimType: claim.claimType,
      productId: claim.productId,
      value: claim.value,
      unit: claim.unit,
    };
    return canonicalSha256(submitted) === canonicalSha256(expected);
  });
  if (!confirmationMatchesExtraction) {
    throw serviceError(400, 'GENIEPROOF_CLAIM_NOT_FROM_SUBMISSION', 'A confirmed claim was not extracted from this offer.');
  }
  return extraction;
}

function copyConfirmedClaims(claims) {
  return claims.map(claim => ({
    claimId: claim.claimId,
    statement: claim.statement,
    claimType: claim.claimType,
    productId: claim.productId,
    value: claim.value,
    unit: claim.unit,
  }));
}

function signedPassport({
  caseId,
  userId,
  submissionHash,
  confirmedClaims,
  revision,
  previousManifestHash,
  signer,
  assessedAt,
  evidenceSnapshot = { byClaimId: {}, registrySnapshotHash: canonicalSha256([]) },
}) {
  const findings = confirmedClaims.map(claim => verifyConfirmedGenieProofClaim({
    ...claim,
    productId: claim.productId,
  }, {
    verifierVersion: GENIEPROOF_EVIDENCE_VERIFIER_VERSION,
    evidenceRevisions: evidenceSnapshot.byClaimId?.[claim.claimId] || [],
    signatureVerifier: signer,
    now: assessedAt,
  }));
  const { manifest } = buildGenieProofManifest({
    caseId,
    ownerId: userId,
    submissionHash,
    confirmedClaims,
    findings,
    revision,
    previousManifestHash,
    assessedAt: assessedAt.toISOString(),
    verifierVersion: GENIEPROOF_EVIDENCE_VERIFIER_VERSION,
    evidenceRegistrySnapshotHash: evidenceSnapshot.registrySnapshotHash,
  });
  return signer.signManifest(manifest);
}

function evidenceReferences(finding) {
  const revisions = Array.isArray(finding?.evidence?.revisions) ? finding.evidence.revisions : [];
  return revisions.map(item => ({
    id: `${item.evidenceId}:${item.revision}`,
    sourceId: item.sourceId,
    sourceRevision: item.sourceRevision,
    sourceDefinitionHash: item.sourceDefinitionHash,
    factHash: item.factHash,
    fact: item.fact,
    effectiveFrom: item.effectiveFrom || item.fact?.effectiveFrom || null,
    effectiveTo: item.effectiveTo || item.fact?.effectiveTo || null,
    conditions: item.fact?.conditions || [],
  }));
}

function proofBreakEventType(previousFinding, nextFinding) {
  if (nextFinding?.finding === 'OUTDATED_EVIDENCE' && previousFinding?.finding !== 'OUTDATED_EVIDENCE') return 'EVIDENCE_EXPIRED';
  if (nextFinding?.reasonCodes?.some(code => /SOURCE_(?:NOT|REUSE)|POLICY_REVIEW/.test(code))) return 'POLICY_REVIEW_REQUIRED';
  if (previousFinding?.finding !== nextFinding?.finding) return 'FINDING_CHANGED';
  const previous = evidenceReferences(previousFinding);
  const next = evidenceReferences(nextFinding);
  const oldConditions = canonicalSha256(previous.map(item => item.conditions));
  const newConditions = canonicalSha256(next.map(item => item.conditions));
  if (oldConditions !== newConditions) return 'CONDITIONS_CHANGED';
  if (canonicalSha256(previous.map(item => item.factHash).sort()) !== canonicalSha256(next.map(item => item.factHash).sort())) return 'EVIDENCE_CHANGED';
  return 'RECHECK_UNCHANGED';
}

function changedEvidenceFields(previousFinding, nextFinding) {
  const previous = evidenceReferences(previousFinding).map(item => item.fact).filter(Boolean);
  const next = evidenceReferences(nextFinding).map(item => item.fact).filter(Boolean);
  const fields = ['claimType', 'productId', 'value', 'unit', 'effectiveFrom', 'effectiveTo', 'conditions'];
  return fields.filter(field => canonicalSha256(previous.map(item => item[field] ?? null).sort((a, b) => String(a).localeCompare(String(b))))
    !== canonicalSha256(next.map(item => item[field] ?? null).sort((a, b) => String(a).localeCompare(String(b)))));
}

function eventPeriodImplications(previousFinding, nextFinding) {
  const before = evidenceReferences(previousFinding)[0];
  const after = evidenceReferences(nextFinding)[0];
  return {
    previousEffectiveFrom: before?.effectiveFrom ? new Date(before.effectiveFrom) : null,
    previousEffectiveTo: before?.effectiveTo ? new Date(before.effectiveTo) : null,
    currentEffectiveFrom: after?.effectiveFrom ? new Date(after.effectiveFrom) : null,
    currentEffectiveTo: after?.effectiveTo ? new Date(after.effectiveTo) : null,
  };
}

async function publishProofBreakReassessment({
  row,
  previous,
  passport,
  session,
  watchFence,
  watchModel,
  jobModel,
  eventModel,
  outboxModel,
  assessedAt,
  now = () => new Date(),
  retrievalReceiptIds = [],
}) {
  const publicationAt = now();
  const watchQuery = watchModel.findOne({
    userId: row.userId,
    caseId: row.caseId,
    watchId: watchFence.watchId,
    status: 'ACTIVE',
    generation: watchFence.watchGeneration,
    consentWithdrawnAt: null,
    expiresAt: { $gt: publicationAt },
  });
  if (typeof watchQuery.session === 'function') watchQuery.session(session);
  const watch = await watchQuery.lean();
  if (!watch) throw serviceError(409, 'PROOFBREAK_WATCH_FENCE_LOST', 'The ProofBreak watch changed during this check.');

  const jobQuery = jobModel.findOne({
    userId: row.userId,
    caseId: row.caseId,
    watchId: watch.watchId,
    jobId: watchFence.jobId,
    status: 'LEASED',
    leaseOwner: watchFence.leaseOwner,
    executionGeneration: watchFence.executionGeneration,
    leaseUntil: { $gt: publicationAt },
  });
  if (typeof jobQuery.session === 'function') jobQuery.session(session);
  const job = await jobQuery.lean();
  if (!job) throw serviceError(409, 'PROOFBREAK_JOB_FENCE_LOST', 'The ProofBreak worker lease was lost during this check.');

  const previousFindings = new Map((previous.manifest.findings || []).map(finding => [finding.claimId, finding]));
  const nextFindings = new Map((passport.manifest.findings || []).map(finding => [finding.claimId, finding]));
  const eventRows = [];
  const outboxRows = [];
  for (const claimId of watch.requestedClaimIds || []) {
    const before = previousFindings.get(claimId);
    const after = nextFindings.get(claimId);
    if (!before || !after) continue;
    const eventType = proofBreakEventType(before, after);
    const beforeEvidence = evidenceReferences(before);
    const afterEvidence = evidenceReferences(after);
    const eventId = crypto.randomUUID();
    const deduplicationKey = canonicalSha256([watch.watchId, job.scheduleKey, claimId, eventType, beforeEvidence.map(item => item.factHash), afterEvidence.map(item => item.factHash)]);
    eventRows.push({
      eventId,
      deduplicationKey,
      userId: row.userId,
      caseId: row.caseId,
      watchId: watch.watchId,
      claimId,
      previousAssessmentId: `${row.caseId}:${previous.manifest.revision}`,
      newAssessmentId: `${row.caseId}:${passport.manifest.revision}`,
      previousEvidenceRevision: beforeEvidence[0]?.id || null,
      newEvidenceRevision: afterEvidence[0]?.id || null,
      retrievalReceiptIds,
      changedFactFields: changedEvidenceFields(before, after),
      effectivePeriodImplications: eventPeriodImplications(before, after),
      eventType,
      detectedAt: assessedAt,
      publishedAt: publicationAt,
      notificationStatus: eventType === 'RECHECK_UNCHANGED' ? 'NOT_REQUIRED' : 'PENDING',
      acknowledgedAt: null,
      expiresAt: row.expiresAt || new Date(assessedAt.getTime() + PROOFBREAK_EVENT_RETENTION_MS),
    });
    if (eventType !== 'RECHECK_UNCHANGED') {
      outboxRows.push({
        outboxId: crypto.randomUUID(),
        eventId,
        userId: row.userId,
        caseId: row.caseId,
        watchId: watch.watchId,
        status: 'PENDING',
        attempt: 0,
        nextAttemptAt: publicationAt,
        executionGeneration: 0,
        expiresAt: row.expiresAt || new Date(assessedAt.getTime() + PROOFBREAK_EVENT_RETENTION_MS),
      });
    }
  }
  if (eventRows.length) await eventModel.create(eventRows, { session });
  if (outboxRows.length) await outboxModel.create(outboxRows, { session });
  const watchUpdate = await watchModel.updateOne({
    userId: row.userId,
    caseId: row.caseId,
    watchId: watch.watchId,
    status: 'ACTIVE',
    generation: watchFence.watchGeneration,
    consentWithdrawnAt: null,
    expiresAt: { $gt: now() },
  }, {
    $set: {
      lastSuccessfulCheckAt: publicationAt,
      nextCheckAt: new Date(publicationAt.getTime() + 6 * 60 * 60 * 1000),
      lastFailureCode: null,
    },
  }, { session });
  if (Number(watchUpdate?.modifiedCount ?? watchUpdate?.nModified ?? 0) !== 1) {
    throw serviceError(409, 'PROOFBREAK_WATCH_FENCE_LOST', 'The ProofBreak watch changed during publication.');
  }
  const finalizedAt = now();
  const jobUpdate = await jobModel.updateOne({
    userId: row.userId,
    watchId: watch.watchId,
    jobId: watchFence.jobId,
    status: 'LEASED',
    leaseOwner: watchFence.leaseOwner,
    executionGeneration: watchFence.executionGeneration,
    leaseUntil: { $gt: finalizedAt },
  }, {
    $set: { status: 'COMPLETED', leaseOwner: null, leaseUntil: null, heartbeatAt: finalizedAt, failureCode: null },
  }, { session });
  if (Number(jobUpdate?.modifiedCount ?? jobUpdate?.nModified ?? 0) !== 1) {
    throw serviceError(409, 'PROOFBREAK_JOB_FENCE_LOST', 'The ProofBreak worker lease was lost during publication.');
  }
}

async function defaultEvidenceResolver({ claims }) {
  return { byClaimId: Object.fromEntries((claims || []).map(claim => [claim.claimId, []])), registrySnapshotHash: canonicalSha256([]) };
}

export async function createGenieProofCase({
  userId,
  offerText,
  submissionHash,
  savingConsent,
  confirmedClaims,
  idempotencyKey,
  signer,
  caseModel = GenieProofCase,
  revisionModel = GenieProofRevision,
  watchModel = ProofWatch,
  jobModel = ProofBreakJob,
  eventModel = ProofBreakEvent,
  outboxModel = ProofNotificationOutbox,
  startSession = () => mongoose.startSession(),
  now = () => new Date(),
  evidenceResolver = defaultEvidenceResolver,
  transactionAttempt = 0,
}) {
  if (!signer) throw serviceError(503, 'GENIEPROOF_SIGNER_UNAVAILABLE', 'The passport signer is unavailable.');
  if (savingConsent !== true) {
    throw serviceError(400, 'GENIEPROOF_SAVING_CONSENT_REQUIRED', 'Confirm that you want to save the claim text in a private passport.');
  }
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
    throw serviceError(400, 'GENIEPROOF_IDEMPOTENCY_KEY_REQUIRED', 'A valid request key is required.');
  }
  const extraction = validateConfirmation({ offerText, submissionHash, confirmedClaims });
  if (extraction.claimsTruncated) {
    throw serviceError(400, 'GENIEPROOF_EXTRACTION_TRUNCATED', 'The offer contains more claims than can be reviewed at once. Shorten the submitted offer and extract claims again.');
  }
  if (confirmedClaims.length > extraction.claims.length) {
    throw serviceError(400, 'GENIEPROOF_CLAIM_LIMIT_EXCEEDED', 'Too many claims were confirmed.');
  }
  const claims = copyConfirmedClaims(confirmedClaims);
  const requestHash = canonicalSha256({ submissionHash, confirmedClaims: claims, savingConsentVersion: GENIEPROOF_SAVING_CONSENT_VERSION });
  const idempotencyKeyHash = canonicalSha256([String(userId), idempotencyKey]);
  const caseId = crypto.randomUUID();
  const assessedAt = now();
  const expiresAt = getGenieProofExpiry(assessedAt);
  const session = await startSession();
  let retryTransaction = false;
  try {
    session.startTransaction({
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      readPreference: 'primary',
    });
    const expiredCasesQuery = caseModel.find({ userId, deletedAt: null, expiresAt: { $lte: assessedAt } });
    if (typeof expiredCasesQuery.session === 'function') expiredCasesQuery.session(session);
    const expiredCases = await expiredCasesQuery.select('caseId').lean();
    for (const expiredCase of expiredCases) {
      await revisionModel.deleteMany({ userId, caseId: expiredCase.caseId }, { session });
      await watchModel.deleteMany({ userId, caseId: expiredCase.caseId }, { session });
      await jobModel.deleteMany({ userId, caseId: expiredCase.caseId }, { session });
      await eventModel.deleteMany({ userId, caseId: expiredCase.caseId }, { session });
      await outboxModel.deleteMany({ userId, caseId: expiredCase.caseId }, { session });
      await caseModel.deleteOne({ userId, caseId: expiredCase.caseId, expiresAt: { $lte: assessedAt } }, { session });
    }
    const replay = await findIdempotentReplay({
      userId,
      idempotencyKeyHash,
      requestHash,
      assessedAt,
      caseModel,
      revisionModel,
      session,
    });
    if (replay) {
      await session.commitTransaction();
      return replay;
    }
    const activeCasesQuery = caseModel.find(activeCaseFilter(userId, null, assessedAt));
    if (typeof activeCasesQuery.session === 'function') activeCasesQuery.session(session);
    const activeCases = await activeCasesQuery.select('quotaSlot').lean();
    if (activeCases.length >= GENIEPROOF_MAX_CASES_PER_USER) {
      throw serviceError(429, 'GENIEPROOF_CASE_QUOTA_REACHED', 'You have reached the 25 saved passport limit. Delete a case or wait for an expired case to be removed.');
    }
    const occupiedSlots = new Set(activeCases
      .map(row => row.quotaSlot)
      .filter(slot => Number.isInteger(slot) && slot >= 0 && slot < GENIEPROOF_MAX_CASES_PER_USER));
    // Older records do not have a slot. Reserve virtual slots for them so that
    // newly created records remain within the same hard per-user quota.
    for (const row of activeCases) {
      if (Number.isInteger(row.quotaSlot)) continue;
      let legacySlot = 0;
      while (occupiedSlots.has(legacySlot) && legacySlot < GENIEPROOF_MAX_CASES_PER_USER) legacySlot += 1;
      if (legacySlot < GENIEPROOF_MAX_CASES_PER_USER) occupiedSlots.add(legacySlot);
    }
    let quotaSlot = 0;
    while (occupiedSlots.has(quotaSlot) && quotaSlot < GENIEPROOF_MAX_CASES_PER_USER) quotaSlot += 1;
    if (quotaSlot >= GENIEPROOF_MAX_CASES_PER_USER) {
      throw serviceError(429, 'GENIEPROOF_CASE_QUOTA_REACHED', 'You have reached the 25 saved passport limit. Delete a case or wait for an expired case to be removed.');
    }
    const evidenceSnapshot = await evidenceResolver({ claims, now: () => assessedAt, session });
    const passport = signedPassport({
      caseId,
      userId,
      submissionHash,
      confirmedClaims: claims,
      revision: 1,
      previousManifestHash: null,
      signer,
      assessedAt,
      evidenceSnapshot,
    });
    const [caseDoc] = await caseModel.create([{
      caseId,
      userId,
      quotaSlot,
      submissionHash,
      requestHash,
      idempotencyKeyHash,
      confirmedClaims: claims,
      savingConsentVersion: GENIEPROOF_SAVING_CONSENT_VERSION,
      savingConsentAt: assessedAt,
      latestRevision: 1,
      latestManifestHash: passport.manifestHash,
      expiresAt,
    }], { session });
    await revisionModel.create([{
      userId,
      caseId,
      revision: 1,
      manifest: passport.manifest,
      manifestHash: passport.manifestHash,
      signature: passport.signature,
      assessedAt,
      expiresAt,
    }], { session });
    await session.commitTransaction();
    return { created: true, case: toCaseSummary(caseDoc), passport };
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction().catch(() => {});
    if (error?.name === 'ValidationError' || error?.name === 'CastError') {
      throw serviceError(400, 'GENIEPROOF_RECORD_INVALID', 'The confirmed claims could not be saved. Review them and try again.');
    }
    if (error?.code === 11000) {
      const replay = await findIdempotentReplay({
        userId,
        idempotencyKeyHash,
        requestHash,
        assessedAt,
        now,
        caseModel,
        revisionModel,
      });
      if (replay) return replay;
      if (error.keyPattern?.quotaSlot || error.message?.includes('uniq_genieproof_owner_quota_slot')) {
        throw serviceError(409, 'GENIEPROOF_CASE_QUOTA_RACE', 'Another save used this case slot at the same time. Refresh your cases and try again.');
      }
    }
    if (isTransientTransactionConflict(error) && transactionAttempt < 2) {
      retryTransaction = true;
    } else if (isTransientTransactionConflict(error)) {
      const unavailable = serviceError(503, 'GENIEPROOF_TRANSACTION_RETRY_EXHAUSTED', 'The case could not be saved because the database transaction conflicted repeatedly. Try again shortly.');
      unavailable.cause = error;
      throw unavailable;
    } else {
      throw error;
    }
  } finally {
    await session.endSession();
  }
  if (retryTransaction) {
    return createGenieProofCase({
      userId,
      offerText,
      submissionHash,
      savingConsent,
      confirmedClaims,
      idempotencyKey,
      signer,
      caseModel,
      revisionModel,
      watchModel,
      jobModel,
      eventModel,
      outboxModel,
      startSession,
      now,
      evidenceResolver,
      transactionAttempt: transactionAttempt + 1,
    });
  }
}

async function findReassessmentReplay({ userId, caseId, idempotencyKeyHash, requestHash, revisionModel, session = null }) {
  const query = revisionModel.findOne({ userId, caseId, idempotencyKeyHash });
  if (session && typeof query.session === 'function') query.session(session);
  const existing = await query.lean();
  if (!existing) return null;
  if (existing.requestHash !== requestHash) {
    throw serviceError(409, 'GENIEPROOF_IDEMPOTENCY_CONFLICT', 'This request key was already used for a different reassessment.');
  }
  return { created: false, passport: toSignedPassport(existing), revision: Number(existing.revision), manifestHash: existing.manifestHash };
}

/** Append a newly signed assessment while atomically advancing the case head. */
export async function reassessGenieProofCase({
  userId,
  caseId,
  expectedRevision,
  expectedManifestHash,
  reassessmentConsent,
  idempotencyKey,
  signer,
  caseModel = GenieProofCase,
  revisionModel = GenieProofRevision,
  startSession = () => mongoose.startSession(),
  now = () => new Date(),
  evidenceResolver = defaultEvidenceResolver,
  watchFence = null,
  watchModel = ProofWatch,
  jobModel = ProofBreakJob,
  eventModel = ProofBreakEvent,
  outboxModel = ProofNotificationOutbox,
  proofBreakRetrievalReceiptIds = [],
  transactionAttempt = 0,
}) {
  if (!signer) throw serviceError(503, 'GENIEPROOF_SIGNER_UNAVAILABLE', 'The passport signer is unavailable.');
  if (reassessmentConsent !== true) throw serviceError(400, 'GENIEPROOF_REASSESSMENT_CONSENT_REQUIRED', 'Confirm that you want to create a new private assessment.');
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1
      || !/^[a-f0-9]{64}$/.test(expectedManifestHash || '')) {
    throw serviceError(400, 'GENIEPROOF_CASE_HEAD_REQUIRED', 'The current passport revision is required to reassess this case.');
  }
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
    throw serviceError(400, 'GENIEPROOF_IDEMPOTENCY_KEY_REQUIRED', 'A valid request key is required.');
  }
  const boundedProofBreakRetrievalReceiptIds = [...new Set(Array.isArray(proofBreakRetrievalReceiptIds) ? proofBreakRetrievalReceiptIds : [])];
  if (boundedProofBreakRetrievalReceiptIds.length > 40
      || boundedProofBreakRetrievalReceiptIds.some(value => !/^[0-9a-f-]{36}$/i.test(value))) {
    throw serviceError(400, 'PROOFBREAK_RETRIEVAL_RECEIPTS_INVALID', 'The source retrieval receipt set is invalid.');
  }
  const assessedAt = now();
  const idempotencyKeyHash = canonicalSha256([String(userId), String(caseId), idempotencyKey]);
  const requestHash = canonicalSha256({ caseId, expectedRevision, expectedManifestHash, reassessmentConsent: true });
  const session = await startSession();
  let retryTransaction = false;
  try {
    session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
    const replay = await findReassessmentReplay({ userId, caseId, idempotencyKeyHash, requestHash, revisionModel, session });
    if (replay) {
      await session.commitTransaction();
      return replay;
    }
    const rowQuery = caseModel.findOne({
      $and: [
        activeCaseFilter(userId, caseId, assessedAt),
        { latestRevision: expectedRevision, latestManifestHash: expectedManifestHash, consentWithdrawnAt: null },
      ],
    });
    if (typeof rowQuery.session === 'function') rowQuery.session(session);
    const row = await rowQuery.lean();
    if (!row) {
      const existingCase = await caseModel.findOne({ userId, caseId }).select('expiresAt deletedAt consentWithdrawnAt latestRevision latestManifestHash').lean();
      if (!existingCase) throw serviceError(404, 'GENIEPROOF_CASE_NOT_FOUND', 'The saved passport was not found.');
      if (existingCase.consentWithdrawnAt) throw serviceError(403, 'GENIEPROOF_CONSENT_WITHDRAWN', 'Reassessment is unavailable because private processing consent was withdrawn.');
      if (existingCase.expiresAt && new Date(existingCase.expiresAt) <= assessedAt) throw serviceError(410, 'GENIEPROOF_CASE_EXPIRED', 'This saved passport has expired.');
      throw serviceError(409, 'GENIEPROOF_STALE_CASE_HEAD', 'The passport changed since it was opened. Refresh its revision history before reassessing.');
    }
    const previousQuery = revisionModel.findOne({ userId, caseId, revision: expectedRevision });
    if (typeof previousQuery.session === 'function') previousQuery.session(session);
    const previous = await previousQuery.lean();
    const previousClaims = (row.confirmedClaims || []).map(claim => ({
      claimId: claim.claimId,
      statement: claim.statement,
      claimType: claim.claimType,
      productId: claim.productId,
      value: claim.value,
      unit: claim.unit,
    })).sort((a, b) => a.claimId.localeCompare(b.claimId));
    const previousSignature = previous && signer.verifySignedManifest?.({
      manifest: previous.manifest,
      manifestHash: previous.manifestHash,
      signature: previous.signature,
    });
    const previousBindingValid = previous
      && previousSignature?.valid === true
      && previousSignature?.trustedIssuer === true
      && previous.manifestHash === expectedManifestHash
      && previous.manifest?.caseId === String(row.caseId)
      && Number(previous.manifest?.revision) === expectedRevision
      && previous.manifest?.ownerBindingHash === canonicalSha256([String(row.caseId), String(userId)])
      && previous.manifest?.submissionHash === row.submissionHash
      && previous.manifest?.confirmedClaimsHash === canonicalSha256(previousClaims);
    if (!previousBindingValid) {
      throw serviceError(503, 'GENIEPROOF_CASE_HEAD_MISMATCH', 'The saved passport head cannot be verified.');
    }
    const freshEvidenceSnapshot = await evidenceResolver({ claims: row.confirmedClaims || [], now: () => assessedAt, session });
    const passport = signedPassport({
      caseId,
      userId,
      submissionHash: row.submissionHash,
      confirmedClaims: row.confirmedClaims || [],
      revision: expectedRevision + 1,
      previousManifestHash: previous.manifestHash,
      signer,
      assessedAt,
      evidenceSnapshot: freshEvidenceSnapshot,
    });
    const publicationAt = now();
    const update = await caseModel.updateOne({
      $and: [
        activeCaseFilter(userId, caseId, publicationAt),
        { latestRevision: expectedRevision, latestManifestHash: expectedManifestHash, consentWithdrawnAt: null },
      ],
    }, {
      $set: { latestRevision: expectedRevision + 1, latestManifestHash: passport.manifestHash },
    }, { session });
    if (update.modifiedCount !== 1) {
      throw serviceError(409, 'GENIEPROOF_STALE_CASE_HEAD', 'The passport changed during reassessment. Refresh its revision history and try again.');
    }
    await revisionModel.create([{
      userId,
      caseId,
      revision: expectedRevision + 1,
      idempotencyKeyHash,
      requestHash,
      manifest: passport.manifest,
      manifestHash: passport.manifestHash,
      signature: passport.signature,
      assessedAt,
      expiresAt: row.expiresAt,
    }], { session });
    if (watchFence) {
      await publishProofBreakReassessment({
        row,
        previous,
        passport,
        session,
        watchFence,
        watchModel,
        jobModel,
        eventModel,
        outboxModel,
        assessedAt,
        now,
        retrievalReceiptIds: boundedProofBreakRetrievalReceiptIds,
      });
    }
    await session.commitTransaction();
    return { created: true, revision: expectedRevision + 1, manifestHash: passport.manifestHash, passport };
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction().catch(() => {});
    if (error?.code === 11000) {
      const replay = await findReassessmentReplay({ userId, caseId, idempotencyKeyHash, requestHash, revisionModel });
      if (replay) return replay;
    }
    if (isTransientTransactionConflict(error) && transactionAttempt < 2) retryTransaction = true;
    else if (isTransientTransactionConflict(error)) {
      throw serviceError(503, 'GENIEPROOF_TRANSACTION_RETRY_EXHAUSTED', 'The reassessment conflicted repeatedly. Try again shortly.');
    } else throw error;
  } finally {
    await session.endSession();
  }
  if (retryTransaction) {
    return reassessGenieProofCase({
      userId, caseId, expectedRevision, expectedManifestHash, reassessmentConsent, idempotencyKey,
      signer, caseModel, revisionModel, startSession, now, evidenceResolver, watchFence,
      watchModel, jobModel, eventModel, outboxModel,
      proofBreakRetrievalReceiptIds: boundedProofBreakRetrievalReceiptIds,
      transactionAttempt: transactionAttempt + 1,
    });
  }
  throw serviceError(503, 'GENIEPROOF_REASSESSMENT_FAILED', 'The reassessment could not be saved.');
}

export async function withdrawGenieProofConsent({
  userId,
  caseId,
  caseModel = GenieProofCase,
  watchModel = ProofWatch,
  jobModel = ProofBreakJob,
  eventModel = ProofBreakEvent,
  outboxModel = ProofNotificationOutbox,
  startSession = () => mongoose.startSession(),
  now = () => new Date(),
}) {
  const assessedAt = now();
  const session = await startSession();
  try {
    session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
    const updated = await caseModel.updateOne({
      ...activeCaseFilter(userId, caseId, assessedAt),
      consentWithdrawnAt: null,
    }, { $set: { consentWithdrawnAt: assessedAt }, $inc: { consentGeneration: 1 } }, { session });
    if (Number(updated?.modifiedCount ?? updated?.nModified ?? 0) !== 1) {
      const existingQuery = caseModel.findOne({ userId, caseId, consentWithdrawnAt: { $ne: null } });
      if (typeof existingQuery.session === 'function') existingQuery.session(session);
      const alreadyWithdrawn = await existingQuery.select('caseId').lean();
      await session.commitTransaction();
      return Boolean(alreadyWithdrawn);
    }
    await watchModel.updateMany({ userId, caseId, status: { $in: ['ACTIVE', 'PAUSED', 'WAITING_FOR_SOURCE', 'BLOCKED_SOURCE_RIGHTS', 'FAILED_RETRYABLE', 'FAILED_TERMINAL'] } }, {
      $set: { status: 'CANCELLED', consentWithdrawnAt: assessedAt, nextCheckAt: null, lastFailureCode: 'PROCESSING_CONSENT_WITHDRAWN' },
      $inc: { generation: 1 },
    }, { session });
    await jobModel.updateMany({ userId, caseId, status: { $in: ['QUEUED', 'LEASED'] } }, {
      $set: { status: 'CANCELLED', leaseOwner: null, leaseUntil: null, failureCode: 'PROCESSING_CONSENT_WITHDRAWN' },
      $inc: { executionGeneration: 1 },
    }, { session });
    await outboxModel.updateMany({ userId, caseId, status: { $in: ['PENDING', 'LEASED', 'FAILED_RETRYABLE'] } }, {
      $set: { status: 'CANCELLED', leaseOwner: null, leaseUntil: null, failureCode: 'PROCESSING_CONSENT_WITHDRAWN' },
      $inc: { executionGeneration: 1 },
    }, { session });
    await eventModel.updateMany({ userId, caseId, notificationStatus: 'PENDING' }, {
      $set: { notificationStatus: 'CANCELLED' },
    }, { session });
    await session.commitTransaction();
    return true;
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction().catch(() => {});
    throw error;
  } finally {
    await session.endSession();
  }
}

async function findIdempotentReplay({ userId, idempotencyKeyHash, requestHash, assessedAt, caseModel, revisionModel, session }) {
  const caseQuery = caseModel.findOne({ userId, idempotencyKeyHash, deletedAt: null });
  if (session && typeof caseQuery.session === 'function') caseQuery.session(session);
  const existing = await caseQuery.lean();
  if (!existing) return null;
  if (existing.expiresAt && new Date(existing.expiresAt) <= assessedAt) {
    throw serviceError(410, 'GENIEPROOF_CASE_EXPIRED', 'This saved passport has expired. Start a new private review.');
  }
  if (existing.requestHash !== requestHash) {
    throw serviceError(409, 'GENIEPROOF_IDEMPOTENCY_CONFLICT', 'This idempotency key was already used for a different case.');
  }
  const revisionQuery = revisionModel.findOne({ userId, caseId: existing.caseId, revision: existing.latestRevision });
  if (session && typeof revisionQuery.session === 'function') revisionQuery.session(session);
  const revision = await revisionQuery.lean();
  if (!revision) throw serviceError(503, 'GENIEPROOF_REVISION_UNAVAILABLE', 'The saved passport revision is unavailable.');
  return { created: false, case: toCaseSummary(existing), passport: toSignedPassport(revision) };
}

function toSignedPassport(revision) {
  return {
    manifest: revision.manifest,
    manifestHash: revision.manifestHash,
    signature: revision.signature,
  };
}

function toCaseSummary(row) {
  return {
    caseId: String(row.caseId),
    revision: Number(row.latestRevision),
    manifestHash: row.latestManifestHash,
    claimCount: row.confirmedClaims?.length || 0,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt || null,
  };
}

function activeCaseFilter(userId, caseId, now) {
  return {
    userId,
    ...(caseId ? { caseId } : {}),
    deletedAt: null,
    $or: [
      { expiresAt: { $gt: now } },
      // A read-only compatibility path keeps pre-retention records reachable
      // until the explicit migration assigns their 90-day expiry window.
      { expiresAt: { $exists: false } },
    ],
  };
}

async function loadOwnedCaseAndLatestRevision({ userId, caseId, caseModel, revisionModel, now = () => new Date() }) {
  const row = await caseModel.findOne(activeCaseFilter(userId, caseId, now())).lean();
  if (!row) return null;
  const revision = await revisionModel.findOne({ userId, caseId, revision: row.latestRevision }).lean();
  if (!revision) throw serviceError(503, 'GENIEPROOF_REVISION_UNAVAILABLE', 'The saved passport revision is unavailable.');
  return { row, revision };
}

export async function listGenieProofCases({ userId, caseModel = GenieProofCase, limit = 25, now = () => new Date() }) {
  const rows = await caseModel.find(activeCaseFilter(userId, null, now()))
    .sort({ createdAt: -1, _id: -1 }).limit(limit).lean();
  return rows.map(toCaseSummary);
}

export async function getGenieProofCase({
  userId,
  caseId,
  caseModel = GenieProofCase,
  revisionModel = GenieProofRevision,
  currentEvidenceStatusResolver = null,
  now = () => new Date(),
}) {
  const loaded = await loadOwnedCaseAndLatestRevision({ userId, caseId, caseModel, revisionModel, now });
  if (!loaded) return null;
  const passport = toSignedPassport(loaded.revision);
  const currentEvidenceStatus = currentEvidenceStatusResolver
    ? await currentEvidenceStatusResolver({ manifest: passport.manifest, now })
    : null;
  return {
    case: toCaseSummary(loaded.row),
    passport,
    ...(currentEvidenceStatus ? { currentEvidenceStatus } : {}),
  };
}

export async function verifyGenieProofCase({
  userId,
  caseId,
  signer,
  caseModel = GenieProofCase,
  revisionModel = GenieProofRevision,
  currentEvidenceStatusResolver = null,
  now = () => new Date(),
}) {
  const loaded = await loadOwnedCaseAndLatestRevision({ userId, caseId, caseModel, revisionModel, now });
  if (!loaded) return null;
  const { row, revision } = loaded;
  const { manifest, manifestHash, signature } = toSignedPassport(revision);
  const signatureResult = signer.verifySignedManifest({ manifest, manifestHash, signature });
  const normalizedCaseClaims = (row.confirmedClaims || []).map(claim => ({
    claimId: claim.claimId,
    statement: claim.statement,
    claimType: claim.claimType,
    productId: claim.productId,
    value: claim.value,
    unit: claim.unit,
  })).sort((a, b) => a.claimId.localeCompare(b.claimId));
  const bindingValid = manifest.caseId === String(row.caseId)
    && manifest.revision === Number(row.latestRevision)
    && manifest.ownerBindingHash === canonicalSha256([String(row.caseId), String(userId)])
    && manifest.submissionHash === row.submissionHash
    && manifest.confirmedClaimsHash === canonicalSha256(normalizedCaseClaims)
    && manifestHash === row.latestManifestHash;
  const currentEvidenceStatus = currentEvidenceStatusResolver
    ? await currentEvidenceStatusResolver({ manifest, now })
    : null;
  return {
    caseId: String(row.caseId),
    revision: Number(row.latestRevision),
    manifestHash,
    integrity: !signatureResult.integrityValid || !bindingValid
      ? 'INVALID'
      : signatureResult.valid && signatureResult.trustedIssuer ? 'VALID' : 'CONTENT_HASH_MATCHES',
    signature: signatureResult.valid ? 'VERIFIED' : 'UNVERIFIED',
    trustedIssuer: signatureResult.trustedIssuer,
    financialCorrectness: 'NOT_ESTABLISHED_BY_SIGNATURE',
    ...(currentEvidenceStatus ? { currentEvidenceStatus } : {}),
    code: bindingValid ? signatureResult.code : 'PASSPORT_CASE_BINDING_MISMATCH',
  };
}

function verifyRevisionBinding({ row, revision, userId, signer, previousRevision, currentEvidenceStatus = null }) {
  const passport = toSignedPassport(revision);
  const signatureResult = signer.verifySignedManifest(passport);
  const claims = (row.confirmedClaims || []).map(claim => ({
    claimId: claim.claimId,
    statement: claim.statement,
    claimType: claim.claimType,
    productId: claim.productId,
    value: claim.value,
    unit: claim.unit,
  })).sort((a, b) => a.claimId.localeCompare(b.claimId));
  const manifest = revision.manifest;
  const bindingValid = manifest.caseId === String(row.caseId)
    && manifest.revision === Number(revision.revision)
    && manifest.ownerBindingHash === canonicalSha256([String(row.caseId), String(userId)])
    && manifest.submissionHash === row.submissionHash
    && manifest.confirmedClaimsHash === canonicalSha256(claims)
    && revision.manifestHash === canonicalSha256(manifest);
  const chainContinuity = previousRevision
    ? manifest.previousManifestHash === previousRevision.manifestHash
      && Number(revision.revision) === Number(previousRevision.revision) + 1
      ? 'VERIFIED'
      : 'INVALID'
    : Number(revision.revision) === 1
      ? manifest.previousManifestHash == null ? 'VERIFIED' : 'INVALID'
      : 'INCOMPLETE';
  const valid = signatureResult.integrityValid && bindingValid && chainContinuity === 'VERIFIED';
  const trusted = valid && signatureResult.valid && signatureResult.trustedIssuer;
  const integrity = !signatureResult.integrityValid || !bindingValid || chainContinuity === 'INVALID'
    ? 'INVALID'
    : trusted && chainContinuity === 'VERIFIED' ? 'VALID' : 'CONTENT_HASH_MATCHES';
  return {
    caseId: String(row.caseId),
    revision: Number(revision.revision),
    manifestHash: revision.manifestHash,
    integrity,
    signature: signatureResult.valid ? 'VERIFIED' : 'UNVERIFIED',
    trustedIssuer: signatureResult.trustedIssuer,
    financialCorrectness: 'NOT_ESTABLISHED_BY_SIGNATURE',
    ...(currentEvidenceStatus ? { currentEvidenceStatus } : {}),
    chainContinuity,
    code: !bindingValid ? 'PASSPORT_CASE_BINDING_MISMATCH'
      : chainContinuity === 'INVALID' ? 'PASSPORT_REVISION_CHAIN_MISMATCH'
        : chainContinuity === 'INCOMPLETE' ? 'PASSPORT_REVISION_CHAIN_PREFIX_UNVERIFIED'
          : signatureResult.code,
  };
}

export async function listGenieProofRevisions({
  userId,
  caseId,
  signer,
  caseModel = GenieProofCase,
  revisionModel = GenieProofRevision,
  now = () => new Date(),
  currentEvidenceStatusResolver = null,
  limit = 25,
}) {
  const row = await caseModel.findOne(activeCaseFilter(userId, caseId, now())).lean();
  if (!row) return null;
  if (!signer) throw serviceError(503, 'GENIEPROOF_SIGNER_UNAVAILABLE', 'The passport verifier is unavailable.');
  const revisions = await revisionModel.find(activeCaseFilter(userId, caseId, now()))
    .sort({ revision: -1 }).limit(Math.min(limit, 25)).lean();
  const ascending = [...revisions].sort((a, b) => a.revision - b.revision);
  const declaredHead = ascending.at(-1);
  if (!declaredHead
      || Number(declaredHead.revision) !== Number(row.latestRevision)
      || declaredHead.manifestHash !== row.latestManifestHash) {
    throw serviceError(503, 'GENIEPROOF_CASE_HEAD_MISMATCH', 'The saved passport history does not match its recorded latest revision and cannot be verified.');
  }
  const verified = await Promise.all(ascending.map(async (revision, index) => {
    const passport = toSignedPassport(revision);
    const currentEvidenceStatus = currentEvidenceStatusResolver
      ? await currentEvidenceStatusResolver({ manifest: passport.manifest, now })
      : null;
    return {
      revision: Number(revision.revision),
      manifestHash: revision.manifestHash,
      assessedAt: revision.assessedAt,
      verification: verifyRevisionBinding({
        row,
        revision,
        userId,
        signer,
        previousRevision: index ? ascending[index - 1] : null,
        currentEvidenceStatus,
      }),
      passport,
      ...(currentEvidenceStatus ? { currentEvidenceStatus } : {}),
    };
  }));
  return { caseId: String(row.caseId), revisions: verified.reverse() };
}

export async function deleteGenieProofCase({
  userId,
  caseId,
  caseModel = GenieProofCase,
  revisionModel = GenieProofRevision,
  watchModel = ProofWatch,
  jobModel = ProofBreakJob,
  eventModel = ProofBreakEvent,
  outboxModel = ProofNotificationOutbox,
  startSession = () => mongoose.startSession(),
}) {
  const session = await startSession();
  try {
    session.startTransaction({
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      readPreference: 'primary',
    });
    const deleted = await caseModel.findOneAndDelete({ userId, caseId, deletedAt: null }, { session });
    if (!deleted) {
      await session.abortTransaction();
      return false;
    }
    await revisionModel.deleteMany({ userId, caseId }, { session });
    await watchModel.deleteMany({ userId, caseId }, { session });
    await jobModel.deleteMany({ userId, caseId }, { session });
    await eventModel.deleteMany({ userId, caseId }, { session });
    await outboxModel.deleteMany({ userId, caseId }, { session });
    await session.commitTransaction();
    return true;
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction().catch(() => {});
    throw error;
  } finally {
    await session.endSession();
  }
}
