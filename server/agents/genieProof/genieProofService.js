import crypto from 'node:crypto';
import mongoose from 'mongoose';
import GenieProofCase from '../../models/GenieProofCase.js';
import GenieProofRevision from '../../models/GenieProofRevision.js';
import { canonicalSha256 } from '../../utils/canonicalJson.js';
import { GENIEPROOF_MAX_CASES_PER_USER, getGenieProofExpiry } from './genieProofPolicy.js';
import {
  buildGenieProofManifest,
  extractGenieProofClaims,
  verifyConfirmedGenieProofClaim,
} from './genieProofCore.js';

export const GENIEPROOF_SAVING_CONSENT_VERSION = 'genieproof-private-save/1';

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

function signedPassport({ caseId, userId, submissionHash, confirmedClaims, revision, previousManifestHash, signer, assessedAt }) {
  // No live provider is called here. Existing market adapters lack an approved
  // GenieProof reuse contract and signed raw-body-to-fact binding, so the
  // verifier deliberately abstains instead of promoting adapter output.
  const findings = confirmedClaims.map(claim => verifyConfirmedGenieProofClaim({
    ...claim,
    productId: claim.productId,
  }, { snapshot: null, now: assessedAt, sourceReusePermission: 'UNVERIFIED' }));
  const { manifest } = buildGenieProofManifest({
    caseId,
    ownerId: userId,
    submissionHash,
    confirmedClaims,
    findings,
    revision,
    previousManifestHash,
    assessedAt: assessedAt.toISOString(),
  });
  return signer.signManifest(manifest);
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
  startSession = () => mongoose.startSession(),
  now = () => new Date(),
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
    const passport = signedPassport({
      caseId,
      userId,
      submissionHash,
      confirmedClaims: claims,
      revision: 1,
      previousManifestHash: null,
      signer,
      assessedAt,
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
      startSession,
      now,
      transactionAttempt: transactionAttempt + 1,
    });
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

export async function getGenieProofCase({ userId, caseId, caseModel = GenieProofCase, revisionModel = GenieProofRevision, now = () => new Date() }) {
  const loaded = await loadOwnedCaseAndLatestRevision({ userId, caseId, caseModel, revisionModel, now });
  if (!loaded) return null;
  return { case: toCaseSummary(loaded.row), passport: toSignedPassport(loaded.revision) };
}

export async function verifyGenieProofCase({ userId, caseId, signer, caseModel = GenieProofCase, revisionModel = GenieProofRevision, now = () => new Date() }) {
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
    code: bindingValid ? signatureResult.code : 'PASSPORT_CASE_BINDING_MISMATCH',
  };
}

function verifyRevisionBinding({ row, revision, userId, signer, previousRevision }) {
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
  const verified = ascending.map((revision, index) => ({
    revision: Number(revision.revision),
    manifestHash: revision.manifestHash,
    assessedAt: revision.assessedAt,
    verification: verifyRevisionBinding({
      row,
      revision,
      userId,
      signer,
      previousRevision: index ? ascending[index - 1] : null,
    }),
    passport: toSignedPassport(revision),
  }));
  return { caseId: String(row.caseId), revisions: verified.reverse() };
}

export async function deleteGenieProofCase({
  userId,
  caseId,
  caseModel = GenieProofCase,
  revisionModel = GenieProofRevision,
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
    await session.commitTransaction();
    return true;
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction().catch(() => {});
    throw error;
  } finally {
    await session.endSession();
  }
}
