import crypto from 'node:crypto';
import mongoose from 'mongoose';
import GenieProofCase from '../../models/GenieProofCase.js';
import GenieProofRevision from '../../models/GenieProofRevision.js';
import { canonicalSha256 } from '../../utils/canonicalJson.js';
import {
  buildGenieProofManifest,
  extractGenieProofClaims,
  verifyConfirmedGenieProofClaim,
} from './genieProofCore.js';

export const GENIEPROOF_SAVING_CONSENT_VERSION = 'genieproof-private-save/1';

function serviceError(status, code, message) {
  return Object.assign(new Error(message), { status, code, clientMessage: message });
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
}) {
  if (!signer) throw serviceError(503, 'GENIEPROOF_SIGNER_UNAVAILABLE', 'The passport signer is unavailable.');
  if (savingConsent !== true) {
    throw serviceError(400, 'GENIEPROOF_SAVING_CONSENT_REQUIRED', 'Confirm that you want to save the claim text in a private passport.');
  }
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
    throw serviceError(400, 'GENIEPROOF_IDEMPOTENCY_KEY_REQUIRED', 'A valid request key is required.');
  }
  const extraction = validateConfirmation({ offerText, submissionHash, confirmedClaims });
  if (confirmedClaims.length > extraction.claims.length) {
    throw serviceError(400, 'GENIEPROOF_CLAIM_LIMIT_EXCEEDED', 'Too many claims were confirmed.');
  }
  const claims = copyConfirmedClaims(confirmedClaims);
  const requestHash = canonicalSha256({ submissionHash, confirmedClaims: claims, savingConsentVersion: GENIEPROOF_SAVING_CONSENT_VERSION });
  const idempotencyKeyHash = canonicalSha256([String(userId), idempotencyKey]);
  const caseId = crypto.randomUUID();
  const assessedAt = now();
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
  const session = await startSession();
  try {
    session.startTransaction({
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      readPreference: 'primary',
    });
    const [caseDoc] = await caseModel.create([{
      caseId,
      userId,
      submissionHash,
      requestHash,
      idempotencyKeyHash,
      confirmedClaims: claims,
      savingConsentVersion: GENIEPROOF_SAVING_CONSENT_VERSION,
      savingConsentAt: assessedAt,
      latestRevision: 1,
      latestManifestHash: passport.manifestHash,
    }], { session });
    await revisionModel.create([{
      userId,
      caseId,
      revision: 1,
      manifest: passport.manifest,
      manifestHash: passport.manifestHash,
      signature: passport.signature,
      assessedAt,
    }], { session });
    await session.commitTransaction();
    return { created: true, case: toCaseSummary(caseDoc), passport };
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction().catch(() => {});
    if (error?.name === 'ValidationError' || error?.name === 'CastError') {
      throw serviceError(400, 'GENIEPROOF_RECORD_INVALID', 'The confirmed claims could not be saved. Review them and try again.');
    }
    if (error?.code === 11000) {
      const existing = await caseModel.findOne({ userId, idempotencyKeyHash, deletedAt: null }).lean();
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw serviceError(409, 'GENIEPROOF_IDEMPOTENCY_CONFLICT', 'This idempotency key was already used for a different case.');
        }
        const revision = await revisionModel.findOne({ userId, caseId: existing.caseId, revision: existing.latestRevision }).lean();
        if (!revision) throw serviceError(503, 'GENIEPROOF_REVISION_UNAVAILABLE', 'The saved passport revision is unavailable.');
        return { created: false, case: toCaseSummary(existing), passport: toSignedPassport(revision) };
      }
    }
    throw error;
  } finally {
    await session.endSession();
  }
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
  };
}

async function loadOwnedCaseAndLatestRevision({ userId, caseId, caseModel, revisionModel }) {
  const row = await caseModel.findOne({ userId, caseId, deletedAt: null }).lean();
  if (!row) return null;
  const revision = await revisionModel.findOne({ userId, caseId, revision: row.latestRevision }).lean();
  if (!revision) throw serviceError(503, 'GENIEPROOF_REVISION_UNAVAILABLE', 'The saved passport revision is unavailable.');
  return { row, revision };
}

export async function listGenieProofCases({ userId, caseModel = GenieProofCase, limit = 25 }) {
  const rows = await caseModel.find({ userId, deletedAt: null })
    .sort({ createdAt: -1, _id: -1 }).limit(limit).lean();
  return rows.map(toCaseSummary);
}

export async function getGenieProofCase({ userId, caseId, caseModel = GenieProofCase, revisionModel = GenieProofRevision }) {
  const loaded = await loadOwnedCaseAndLatestRevision({ userId, caseId, caseModel, revisionModel });
  if (!loaded) return null;
  return { case: toCaseSummary(loaded.row), passport: toSignedPassport(loaded.revision) };
}

export async function verifyGenieProofCase({ userId, caseId, signer, caseModel = GenieProofCase, revisionModel = GenieProofRevision }) {
  const loaded = await loadOwnedCaseAndLatestRevision({ userId, caseId, caseModel, revisionModel });
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
