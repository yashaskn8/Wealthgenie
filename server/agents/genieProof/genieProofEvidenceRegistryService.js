import crypto from 'node:crypto';
import mongoose from 'mongoose';
import GenieProofEvidenceRevision from '../../models/GenieProofEvidenceRevision.js';
import GenieProofEvidenceRegistryState, { GENIEPROOF_EVIDENCE_REGISTRY_STATE_ID } from '../../models/GenieProofEvidenceRegistryState.js';
import GenieProofRetrievalReceipt from '../../models/GenieProofRetrievalReceipt.js';
import GenieProofSourceDefinition from '../../models/GenieProofSourceDefinition.js';
import { SafePublicDocumentFetcher } from '../research/safePublicDocumentFetcher.js';
import { extractOfficialScriptUrls, INDIA_POST_SAVINGS_URL } from '../../services/marketData/GovernmentSmallSavingsProvider.js';
import { parseGenieProofIndiaPostPpfBundle } from './genieProofIndiaPostSourceParser.js';
import { canonicalSha256 } from '../../utils/canonicalJson.js';
import {
  buildGenieProofEvidenceAttestationPayload,
  buildGenieProofEvidenceFactHash,
  GENIEPROOF_PPF_PARSER_VERSION,
  GENIEPROOF_PPF_RATE_RULE_VERSION,
} from './genieProofEvidenceContract.js';

const FETCHER_VERSION = 'genieproof-bounded-public-fetch/1.0.0';
const SOURCE_ID = 'india-post-small-savings';
const PRODUCT_ID = 'government:india-post:ppf';
const MAX_SCRIPT_DOCUMENTS = 20;

function asDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('Evidence timestamp is invalid.');
  return date;
}

function sourcePayload(source) {
  return {
    sourceId: source.sourceId,
    revision: source.revision,
    publisher: source.publisher,
    officialIdentity: source.officialIdentity,
    endpoint: source.endpoint,
    sourceClass: source.sourceClass,
    productIds: [...(source.productIds || [])],
    claimTypes: [...(source.claimTypes || [])],
    expectedMimeTypes: [...(source.expectedMimeTypes || [])],
    parserVersion: source.parserVersion,
    ruleVersion: source.ruleVersion,
    lineage: [...(source.lineage || [])],
    qualificationStatus: source.qualificationStatus,
    reusePermissionStatus: source.reusePermissionStatus,
    reviewRecord: source.reviewRecord || { reviewedAt: null, reference: null, scope: null },
    supersedes: source.supersedes || null,
    revocationReasonCode: source.revocationReasonCode || null,
  };
}

export function computeGenieProofSourceDefinitionHash(source) {
  return canonicalSha256(sourcePayload(source));
}

export async function advanceGenieProofEvidenceRegistryFence({
  session,
  stateModel = GenieProofEvidenceRegistryState,
  now = () => new Date(),
}) {
  if (!session) throw sourceFailure('GENIEPROOF_SOURCE_REGISTRY_TRANSACTION_REQUIRED');
  const update = await stateModel.updateOne({ _id: GENIEPROOF_EVIDENCE_REGISTRY_STATE_ID }, {
    $inc: { generation: 1 },
    $set: { updatedAt: now() },
  }, { session });
  if (Number(update?.modifiedCount ?? update?.nModified ?? 0) !== 1) {
    throw sourceFailure('GENIEPROOF_SOURCE_REGISTRY_STATE_UNAVAILABLE');
  }
}

/** Append a source revision while fencing in-flight assessments in the same transaction. */
export async function appendGenieProofSourceDefinitionRevision({
  source,
  sourceModel = GenieProofSourceDefinition,
  stateModel = GenieProofEvidenceRegistryState,
  startSession = () => mongoose.startSession(),
  now = () => new Date(),
  transactionAttempt = 0,
}) {
  if (!source || source.definitionHash !== computeGenieProofSourceDefinitionHash(source)) {
    throw sourceFailure('GENIEPROOF_SOURCE_DEFINITION_HASH_MISMATCH');
  }
  const session = await startSession();
  let retryTransaction = false;
  try {
    session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
    const existingQuery = sourceModel.findOne({ sourceId: source.sourceId, revision: source.revision });
    if (typeof existingQuery.session === 'function') existingQuery.session(session);
    const existing = await existingQuery.lean();
    if (existing) {
      if (existing.definitionHash !== source.definitionHash) {
        throw sourceFailure('GENIEPROOF_SOURCE_CATALOG_CONFLICT');
      }
      await session.commitTransaction();
      return { created: false, source: existing };
    }

    const latestQuery = sourceModel.findOne({ sourceId: source.sourceId }).sort({ revision: -1 });
    if (typeof latestQuery.session === 'function') latestQuery.session(session);
    const latest = await latestQuery.lean();
    if ((!latest && (source.revision !== 1 || source.supersedes))
        || (latest && (source.revision !== Number(latest.revision) + 1
          || source.supersedes?.sourceId !== latest.sourceId
          || source.supersedes?.revision !== latest.revision))) {
      throw sourceFailure('GENIEPROOF_SOURCE_REVISION_CHAIN_INVALID');
    }

    await advanceGenieProofEvidenceRegistryFence({ session, stateModel, now });
    const [created] = await sourceModel.create([{ ...source }], { session });
    await session.commitTransaction();
    return { created: true, source: created };
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction().catch(() => {});
    const transient = error?.hasErrorLabel?.('TransientTransactionError') === true
      || error?.code === 112
      || error?.codeName === 'WriteConflict';
    if (transient && transactionAttempt < 2) retryTransaction = true;
    else throw error;
  } finally {
    await session.endSession();
  }
  if (retryTransaction) {
    return appendGenieProofSourceDefinitionRevision({
      source, sourceModel, stateModel, startSession, now, transactionAttempt: transactionAttempt + 1,
    });
  }
  throw sourceFailure('GENIEPROOF_SOURCE_REVISION_APPEND_FAILED');
}

export function computeGenieProofRetrievalReceiptHash(receipt) {
  return canonicalSha256({
    retrievalId: receipt.retrievalId,
    sourceId: receipt.sourceId,
    sourceRevision: receipt.sourceRevision,
    requestedUrl: receipt.requestedUrl,
    finalUrl: receipt.finalUrl,
    redirectCount: receipt.redirectCount,
    statusCode: receipt.statusCode,
    contentType: receipt.contentType,
    contentBytes: receipt.contentBytes,
    contentSha256: receipt.contentSha256,
    retrievedAt: receipt.retrievedAt,
    publicationAt: receipt.publicationAt || null,
    fetchClassification: receipt.fetchClassification,
    fetcherVersion: receipt.fetcherVersion,
    responseLineage: [...(receipt.responseLineage || [])],
  });
}

function sourceFailure(code, status = 503) {
  return Object.assign(new Error('The qualified financial evidence source is unavailable.'), { status, code });
}

export function assertUnambiguousGenieProofIndiaPostBundle(bundleText) {
  parseGenieProofIndiaPostPpfBundle(bundleText);
}

export function validateGenieProofSourceDefinition(source) {
  let endpoint;
  try { endpoint = new URL(source?.endpoint); } catch { throw sourceFailure('GENIEPROOF_SOURCE_ENDPOINT_REJECTED', 422); }
  if (source?.sourceId !== SOURCE_ID || source.endpoint !== INDIA_POST_SAVINGS_URL
      || endpoint.protocol !== 'https:' || endpoint.hostname !== 'www.indiapost.gov.in'
      || endpoint.port || endpoint.pathname !== '/banking-services/savings'
      || !source.productIds?.includes(PRODUCT_ID)
      || !source.claimTypes?.includes('CURRENT_NOMINAL_RATE')) {
    throw sourceFailure('GENIEPROOF_SOURCE_NOT_ALLOWLISTED', 422);
  }
  if (source.definitionHash !== computeGenieProofSourceDefinitionHash(source)) {
    throw sourceFailure('GENIEPROOF_SOURCE_DEFINITION_HASH_MISMATCH', 503);
  }
  if (source.revocationReasonCode || source.qualificationStatus === 'REVOKED'
      || source.reusePermissionStatus === 'REVOKED') {
    throw sourceFailure('GENIEPROOF_SOURCE_REVOKED', 410);
  }
  if (source.qualificationStatus !== 'QUALIFIED_FOR_USER_PRESENTATION'
      || source.reusePermissionStatus !== 'APPROVED') {
    throw sourceFailure('GENIEPROOF_SOURCE_REUSE_NOT_APPROVED', 403);
  }
  const reviewedAt = source.reviewRecord?.reviewedAt ? asDate(source.reviewRecord.reviewedAt) : null;
  if (!reviewedAt || !String(source.reviewRecord?.reference || '').trim()
      || !String(source.reviewRecord?.scope || '').trim()
      || source.parserVersion !== GENIEPROOF_PPF_PARSER_VERSION
      || source.ruleVersion !== GENIEPROOF_PPF_RATE_RULE_VERSION) {
    throw sourceFailure('GENIEPROOF_SOURCE_REVIEW_RECORD_REQUIRED', 403);
  }
  return endpoint;
}

function validateFetchedDocument(document, requestedUrl, expectedMimeTypes) {
  const bodyHash = typeof document?.body === 'string'
    ? crypto.createHash('sha256').update(Buffer.from(document.body, 'utf8')).digest('hex')
    : null;
  if (!document || document.statusCode < 200 || document.statusCode >= 300
      || document.requestedUrl !== requestedUrl || document.url !== requestedUrl
      || document.redirectCount !== 0 || !expectedMimeTypes.includes(document.contentType)
      || !/^[a-f0-9]{64}$/.test(document.rawBodySha256 || '')
      || typeof document.body !== 'string' || !document.body.length
      || bodyHash !== document.rawBodySha256) {
    throw sourceFailure('GENIEPROOF_SOURCE_DOCUMENT_REJECTED', 503);
  }
}

function toReceipt({ source, document, responseLineage = [] }) {
  const receipt = {
    retrievalId: crypto.randomUUID(),
    sourceId: source.sourceId,
    sourceRevision: source.revision,
    requestedUrl: document.requestedUrl,
    finalUrl: document.url,
    redirectCount: document.redirectCount,
    statusCode: document.statusCode,
    contentType: document.contentType,
    contentBytes: Buffer.byteLength(document.body, 'utf8'),
    contentSha256: document.rawBodySha256,
    retrievedAt: asDate(document.retrievedAt),
    publicationAt: null,
    fetchClassification: 'SUCCESS',
    fetcherVersion: FETCHER_VERSION,
    responseLineage,
  };
  return { ...receipt, receiptHash: computeGenieProofRetrievalReceiptHash(receipt) };
}

function effectiveDay(value, endOfDay = false) {
  const suffix = endOfDay ? 'T23:59:59.999+05:30' : 'T00:00:00.000+05:30';
  return asDate(`${value}${suffix}`);
}

async function latestSource({ sourceId, sourceModel, session = null }) {
  const query = sourceModel.findOne({ sourceId }).sort({ revision: -1 });
  if (session && typeof query.session === 'function') query.session(session);
  return query.lean();
}

/**
 * Fetch one fixed, reviewed provider page and append its raw-content receipts
 * and typed PPF fact. The rights gate runs before any network request.
 */
export async function refreshGenieProofIndiaPostPpfEvidence({
  signer,
  sourceModel = GenieProofSourceDefinition,
  stateModel = GenieProofEvidenceRegistryState,
  receiptModel = GenieProofRetrievalReceipt,
  evidenceModel = GenieProofEvidenceRevision,
  fetcher = new SafePublicDocumentFetcher({ maxRedirects: 0, extraContentTypes: ['application/javascript', 'text/javascript'] }),
  startSession = () => mongoose.startSession(),
  // Trusted server dependency injection for synthetic lifecycle tests. HTTP
  // callers never supply this dependency; production uses the fail-closed gate.
  parseSourceBundle = parseGenieProofIndiaPostPpfBundle,
  signal = null,
  now = () => new Date(),
}) {
  if (!signer?.signManifest) throw sourceFailure('GENIEPROOF_SIGNER_UNAVAILABLE');
  const source = await latestSource({ sourceId: SOURCE_ID, sourceModel });
  if (!source) throw sourceFailure('GENIEPROOF_SOURCE_NOT_REGISTERED', 503);
  const endpoint = validateGenieProofSourceDefinition(source);
  const page = await fetcher.fetchDocument(endpoint.toString(), { signal });
  validateFetchedDocument(page, endpoint.toString(), ['text/html']);
  const scriptUrls = extractOfficialScriptUrls(page.body, endpoint.toString());
  if (!scriptUrls.length || scriptUrls.length > MAX_SCRIPT_DOCUMENTS) {
    throw sourceFailure('GENIEPROOF_SOURCE_SCHEMA_REJECTED', 503);
  }

  const bundles = [];
  for (const scriptUrl of scriptUrls.slice(0, MAX_SCRIPT_DOCUMENTS)) {
    const parsedUrl = new URL(scriptUrl);
    if (parsedUrl.origin !== endpoint.origin || !parsedUrl.pathname.startsWith('/_next/static/chunks/')) {
      throw sourceFailure('GENIEPROOF_SOURCE_REDIRECT_REJECTED', 503);
    }
    try {
      const candidate = await fetcher.fetchDocument(scriptUrl, { signal });
      validateFetchedDocument(candidate, scriptUrl, ['application/javascript', 'text/javascript']);
      if (candidate.body.includes('Post Office Small Savings Schemes')) {
        bundles.push(candidate);
      }
    } catch (error) {
      if (error?.code === 'GENIEPROOF_SOURCE_DOCUMENT_REJECTED') continue;
      if (error?.code === 'RESEARCH_DOCUMENT_UNAVAILABLE' || error?.code === 'RESEARCH_CONTENT_TYPE_REJECTED') continue;
      throw error;
    }
  }
  if (!bundles.length) throw sourceFailure('GENIEPROOF_SOURCE_BUNDLE_UNAVAILABLE', 503);
  if (bundles.length !== 1) throw sourceFailure('GENIEPROOF_SOURCE_SCHEMA_REJECTED', 503);
  const [bundle] = bundles;

  let parsed;
  try {
    parsed = parseSourceBundle(bundle.body, {
      fetchedAt: bundle.retrievedAt,
      now: now(),
      sourceUrl: endpoint.toString(),
    });
  } catch {
    throw sourceFailure('GENIEPROOF_SOURCE_SCHEMA_REJECTED', 503);
  }
  const fact = parsed.facts.find(item => item.canonicalProductId === PRODUCT_ID);
  if (!fact || fact.availabilityStatus !== 'AVAILABLE' || !Number.isFinite(fact.value)
      || fact.value <= 0 || fact.unit !== 'PERCENT_PER_ANNUM'
      || !fact.effectiveFrom || !fact.effectiveTo) {
    throw sourceFailure('GENIEPROOF_SOURCE_FACT_UNAVAILABLE', 503);
  }

  const pageReceipt = toReceipt({ source, document: page });
  const bundleReceipt = toReceipt({ source, document: bundle, responseLineage: [page.rawBodySha256] });
  const receipts = [pageReceipt, bundleReceipt];
  const evidenceId = `${SOURCE_ID}:${PRODUCT_ID}:current-nominal-rate`;
  const currentTime = asDate(now());
  const factRecord = {
    claimType: 'CURRENT_NOMINAL_RATE',
    productId: PRODUCT_ID,
    value: fact.value,
    unit: 'PERCENT_PER_ANNUM',
    effectiveFrom: effectiveDay(fact.effectiveFrom),
    effectiveTo: effectiveDay(fact.effectiveTo, true),
    conditions: [],
  };
  const factHash = buildGenieProofEvidenceFactHash(factRecord);
  const session = await startSession();
  try {
    session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
    await advanceGenieProofEvidenceRegistryFence({ session, stateModel, now });
    const currentSource = await latestSource({ sourceId: SOURCE_ID, sourceModel, session });
    if (!currentSource || currentSource.revision !== source.revision
        || currentSource.definitionHash !== source.definitionHash) throw sourceFailure('GENIEPROOF_SOURCE_REVIEW_CHANGED', 409);
    validateGenieProofSourceDefinition(currentSource);
    const duplicate = await evidenceModel.findOne({
      sourceId: SOURCE_ID,
      sourceRevision: source.revision,
      sourceContentCommitment: bundle.rawBodySha256,
    }).session(session).lean();
    if (duplicate) {
      // Keep a durable receipt for each successful recheck even when the raw
      // content matches an existing immutable evidence revision.
      await receiptModel.create(receipts.map(receipt => ({ ...receipt })), { session });
      await session.commitTransaction();
      return { created: false, evidence: duplicate, retrievalIds: receipts.map(receipt => receipt.retrievalId) };
    }
    const latest = await evidenceModel.findOne({ evidenceId }).sort({ revision: -1 }).session(session).lean();
    const revision = Number(latest?.revision || 0) + 1;
    await receiptModel.create(receipts.map(receipt => ({ ...receipt })), { session });
    const evidence = {
      evidenceId,
      revision,
      sourceId: SOURCE_ID,
      sourceRevision: source.revision,
      sourceDefinitionHash: source.definitionHash,
      retrievalIds: receipts.map(receipt => receipt.retrievalId),
      retrievalReceiptHashes: receipts.map(receipt => receipt.receiptHash),
      publicationAt: null,
      retrievedAt: asDate(bundle.retrievedAt),
      sourceContentCommitment: bundle.rawBodySha256,
      sourceQualificationAtAssessment: source.qualificationStatus,
      reusePermissionAtAssessment: source.reusePermissionStatus,
      freshnessStatus: currentTime >= factRecord.effectiveFrom && currentTime <= factRecord.effectiveTo ? 'FRESH' : 'STALE',
      revocationStatus: 'ACTIVE',
      fact: factRecord,
      parserVersion: source.parserVersion,
      ruleVersion: source.ruleVersion,
      sourceLineage: [endpoint.origin, page.rawBodySha256],
      supersedes: latest ? `${latest.evidenceId}:${latest.revision}` : null,
      factHash,
    };
    const attestation = signer.signManifest(buildGenieProofEvidenceAttestationPayload(evidence));
    const [saved] = await evidenceModel.create([{ ...evidence, attestation }], { session });
    await session.commitTransaction();
    return { created: true, evidence: saved.toObject(), retrievalIds: receipts.map(receipt => receipt.retrievalId) };
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction().catch(() => {});
    if (error?.code === 11000) {
      const duplicate = await evidenceModel.findOne({
        sourceId: SOURCE_ID,
        sourceRevision: source.revision,
        sourceContentCommitment: bundle.rawBodySha256,
      }).lean();
      if (duplicate) {
        // A racing evidence insert aborts this transaction, including its
        // receipt writes. Persist this independent successful retrieval audit.
        await receiptModel.create(receipts.map(receipt => ({ ...receipt })));
        return { created: false, evidence: duplicate, retrievalIds: receipts.map(receipt => receipt.retrievalId) };
      }
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

function normalizedSourceDefinition(source) {
  return {
    sourceId: source.sourceId,
    revision: source.revision,
    definitionHash: source.definitionHash,
    qualificationStatus: source.qualificationStatus,
    reusePermissionStatus: source.reusePermissionStatus,
  };
}

function receiptIsBound(receipt, source) {
  if (!receipt || receipt.sourceId !== source.sourceId || receipt.sourceRevision !== source.revision
      || receipt.fetchClassification !== 'SUCCESS' || receipt.statusCode < 200 || receipt.statusCode >= 300
      || receipt.redirectCount !== 0 || !source.expectedMimeTypes.includes(receipt.contentType)
      || !Number.isSafeInteger(receipt.contentBytes) || receipt.contentBytes < 1
      || !Array.isArray(receipt.responseLineage)
      || receipt.responseLineage.some(hash => !/^[a-f0-9]{64}$/.test(hash))
      || receipt.requestedUrl !== receipt.finalUrl
      || !/^[a-f0-9]{64}$/.test(receipt.contentSha256 || '')
      || receipt.receiptHash !== computeGenieProofRetrievalReceiptHash(receipt)) return false;
  try {
    const endpoint = new URL(source.endpoint);
    const requested = new URL(receipt.requestedUrl);
    if (requested.username || requested.password || requested.hash || requested.search
        || requested.origin !== endpoint.origin) return false;
    if (requested.href === endpoint.href) {
      return receipt.contentType === 'text/html' && receipt.responseLineage.length === 0;
    }
    return receipt.contentType === 'application/javascript' || receipt.contentType === 'text/javascript'
      ? requested.pathname.startsWith('/_next/static/chunks/') && receipt.responseLineage.length === 1
      : false;
  } catch { return false; }
}

/** Resolve only persisted, currently user-qualified revisions and their receipts. */
export async function resolveGenieProofEvidenceForClaims({
  claims,
  sourceModel = GenieProofSourceDefinition,
  receiptModel = GenieProofRetrievalReceipt,
  evidenceModel = GenieProofEvidenceRevision,
  now = () => new Date(),
  session = null,
}) {
  const byClaimId = {};
  const registrySnapshots = [];
  if (session && (claims || []).length) {
    await advanceGenieProofEvidenceRegistryFence({ session });
  }
  for (const claim of claims || []) {
    // Select the newest source definition before checking claim scope. A later
    // revision may intentionally narrow or revoke an older definition.
    const sourceQuery = sourceModel.find({}).sort({ sourceId: 1, revision: -1 });
    if (session && typeof sourceQuery.session === 'function') sourceQuery.session(session);
    const sources = await sourceQuery.lean();
    const latestById = new Map();
    for (const source of sources) if (!latestById.has(source.sourceId)) latestById.set(source.sourceId, source);
    const latestSources = [...latestById.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId));
    registrySnapshots.push(...latestSources.map(normalizedSourceDefinition));
    const applicableSources = latestSources.filter(source => source.productIds?.includes(claim.productId)
      && source.claimTypes?.includes(claim.claimType));
    const eligibleSources = applicableSources.filter(source => source.qualificationStatus === 'QUALIFIED_FOR_USER_PRESENTATION'
      && source.reusePermissionStatus === 'APPROVED' && !source.revocationReasonCode
      && source.reviewRecord?.reviewedAt && String(source.reviewRecord?.reference || '').trim()
      && String(source.reviewRecord?.scope || '').trim()
      && source.parserVersion === GENIEPROOF_PPF_PARSER_VERSION
      && source.ruleVersion === GENIEPROOF_PPF_RATE_RULE_VERSION);
    const candidates = [];
    for (const source of eligibleSources) {
      if (source.definitionHash !== computeGenieProofSourceDefinitionHash(source)) continue;
      const revisionsQuery = evidenceModel.find({
        sourceId: source.sourceId,
        sourceRevision: source.revision,
      }).sort({ evidenceId: 1, revision: -1 }).limit(100);
      if (session && typeof revisionsQuery.session === 'function') revisionsQuery.session(session);
      const revisions = await revisionsQuery.lean();
      const latestEvidence = new Map();
      for (const revision of revisions) if (!latestEvidence.has(revision.evidenceId)) latestEvidence.set(revision.evidenceId, revision);
      for (const revision of latestEvidence.values()) {
        if (revision.revocationStatus !== 'ACTIVE'
            || revision.fact?.productId !== claim.productId
            || revision.fact?.claimType !== claim.claimType
            || revision.sourceDefinitionHash !== source.definitionHash
            || revision.sourceQualificationAtAssessment !== source.qualificationStatus
            || revision.reusePermissionAtAssessment !== source.reusePermissionStatus) continue;
        const receiptQuery = receiptModel.find({ retrievalId: { $in: revision.retrievalIds } });
        if (session && typeof receiptQuery.session === 'function') receiptQuery.session(session);
        const receipts = await receiptQuery.lean();
        const receiptsById = new Map(receipts.map(receipt => [receipt.retrievalId, receipt]));
        const orderedReceipts = revision.retrievalIds.map(id => receiptsById.get(id));
        if (orderedReceipts.some(receipt => !receiptIsBound(receipt, source))) continue;
        const rootReceipt = orderedReceipts.find(receipt => receipt.requestedUrl === source.endpoint);
        const scriptReceipts = orderedReceipts.filter(receipt => receipt.requestedUrl !== source.endpoint
          && receipt.responseLineage.includes(rootReceipt?.contentSha256));
        if (!rootReceipt || !scriptReceipts.length
            || !scriptReceipts.some(receipt => receipt.contentSha256 === revision.sourceContentCommitment)) continue;
        const receiptHashes = orderedReceipts.map(receipt => receipt.receiptHash);
        if (canonicalSha256(receiptHashes) !== canonicalSha256(revision.retrievalReceiptHashes || [])) continue;
        const resolved = { ...revision, retrievalReceiptHashes: receiptHashes };
        candidates.push(resolved);
      }
    }
    registrySnapshots.push(...candidates.map(item => ({
      evidenceId: item.evidenceId,
      revision: item.revision,
      factHash: item.factHash,
      attestationHash: item.attestation?.manifestHash || null,
    })));
    byClaimId[claim.claimId] = candidates;
  }
  return {
    byClaimId,
    registrySnapshotHash: canonicalSha256({ assessedAt: asDate(now()).toISOString(), records: registrySnapshots }),
  };
}

export async function getGenieProofCurrentEvidenceStatus({
  manifest,
  sourceModel = GenieProofSourceDefinition,
  now = () => new Date(),
}) {
  const asOf = asDate(now());
  const claimsById = new Map((manifest?.confirmedClaims || []).map(claim => [claim.claimId, claim]));
  const findings = Array.isArray(manifest?.findings) ? manifest.findings : [];
  if (!findings.length) return { asOf: asOf.toISOString(), byClaimId: {} };

  const sourceQuery = sourceModel.find({}).sort({ sourceId: 1, revision: -1 });
  const sources = await sourceQuery.lean();
  const latestById = new Map();
  for (const source of sources) if (!latestById.has(source.sourceId)) latestById.set(source.sourceId, source);
  const latestSources = [...latestById.values()];
  const byClaimId = {};

  for (const finding of findings) {
    const claim = claimsById.get(finding.claimId);
    const recordedReferences = Array.isArray(finding?.evidence?.revisions) ? finding.evidence.revisions : [];
    const applicable = latestSources.filter(source => source.productIds?.includes(claim?.productId)
      && source.claimTypes?.includes(claim?.claimType));
    const relevant = applicable.length
      ? applicable
      : latestSources.filter(source => recordedReferences.some(reference => reference.sourceId === source.sourceId));
    if (!claim || !relevant.length) {
      byClaimId[finding.claimId] = {
        status: 'NO_CURRENT_QUALIFIED_SOURCE',
        sourceIds: [],
        currentSourceRevisions: [],
      };
      continue;
    }

    const statuses = relevant.map(source => {
      const recorded = recordedReferences.find(reference => reference.sourceId === source.sourceId) || null;
      let status;
      if (source.definitionHash !== computeGenieProofSourceDefinitionHash(source)) status = 'SOURCE_DEFINITION_INVALID';
      else if (source.revocationReasonCode || source.qualificationStatus === 'REVOKED'
          || source.reusePermissionStatus === 'REVOKED') status = 'SOURCE_REVOKED';
      else if (source.qualificationStatus === 'BLOCKED_TECHNICAL') status = 'SOURCE_TECHNICALLY_BLOCKED';
      else if (source.qualificationStatus !== 'QUALIFIED_FOR_USER_PRESENTATION'
          || source.reusePermissionStatus !== 'APPROVED') status = 'SOURCE_REUSE_NOT_APPROVED';
      else if (!source.reviewRecord?.reviewedAt
          || !String(source.reviewRecord?.reference || '').trim()
          || !String(source.reviewRecord?.scope || '').trim()) status = 'SOURCE_REVIEW_UNQUALIFIED';
      else if (source.parserVersion !== GENIEPROOF_PPF_PARSER_VERSION
          || source.ruleVersion !== GENIEPROOF_PPF_RATE_RULE_VERSION) status = 'SOURCE_PARSER_SUPERSEDED';
      else if (!recorded) status = 'CURRENT_SOURCE_EVIDENCE_UNAVAILABLE';
      else if (Number(recorded.sourceRevision) !== Number(source.revision)
          || recorded.sourceDefinitionHash !== source.definitionHash) status = 'SOURCE_DEFINITION_SUPERSEDED';
      else {
        const effectiveTo = recorded.effectiveTo || recorded.fact?.effectiveTo;
        status = effectiveTo && asDate(effectiveTo) <= asOf
          ? 'EVIDENCE_PERIOD_ENDED'
          : 'CURRENT_SOURCE_REASSESSMENT_REQUIRED';
      }
      return {
        sourceId: source.sourceId,
        currentSourceRevision: Number(source.revision),
        recordedSourceRevision: recorded ? Number(recorded.sourceRevision) : null,
        status,
      };
    });
    const priority = [
      'SOURCE_REVOKED', 'SOURCE_DEFINITION_INVALID', 'SOURCE_TECHNICALLY_BLOCKED',
      'SOURCE_REUSE_NOT_APPROVED', 'SOURCE_REVIEW_UNQUALIFIED', 'SOURCE_PARSER_SUPERSEDED', 'SOURCE_DEFINITION_SUPERSEDED',
      'EVIDENCE_PERIOD_ENDED', 'CURRENT_SOURCE_EVIDENCE_UNAVAILABLE', 'CURRENT_SOURCE_REASSESSMENT_REQUIRED',
    ];
    statuses.sort((a, b) => priority.indexOf(a.status) - priority.indexOf(b.status));
    byClaimId[finding.claimId] = {
      status: statuses[0]?.status || 'NO_CURRENT_QUALIFIED_SOURCE',
      sourceIds: statuses.map(item => item.sourceId).sort(),
      currentSourceRevisions: statuses.map(({ sourceId, currentSourceRevision, recordedSourceRevision, status }) => ({
        sourceId, currentSourceRevision, recordedSourceRevision, status,
      })),
    };
  }
  return { asOf: asOf.toISOString(), byClaimId };
}
