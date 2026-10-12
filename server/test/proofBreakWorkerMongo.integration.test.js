import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import GenieProofCase from '../models/GenieProofCase.js';
import GenieProofRevision from '../models/GenieProofRevision.js';
import GenieProofSourceDefinition from '../models/GenieProofSourceDefinition.js';
import GenieProofRetrievalReceipt from '../models/GenieProofRetrievalReceipt.js';
import GenieProofEvidenceRevision from '../models/GenieProofEvidenceRevision.js';
import ProofWatch from '../models/ProofWatch.js';
import ProofBreakJob from '../models/ProofBreakJob.js';
import ProofBreakEvent from '../models/ProofBreakEvent.js';
import ProofNotificationOutbox from '../models/ProofNotificationOutbox.js';
import ProofBreakWorkerHeartbeat from '../models/ProofBreakWorkerHeartbeat.js';
import { extractGenieProofClaims } from '../agents/genieProof/genieProofCore.js';
import { createGenieProofCase, deleteGenieProofCase, listGenieProofRevisions, reassessGenieProofCase, withdrawGenieProofConsent } from '../agents/genieProof/genieProofService.js';
import { GenieProofPassportSigner } from '../agents/genieProof/genieProofPassportSignature.js';
import { createProofWatch, listProofBreakEvents, updateProofWatchStatus } from '../agents/genieProof/proofBreakService.js';
import { ProofBreakWorker } from '../agents/genieProof/proofBreakWorker.js';
import {
  buildGenieProofEvidenceAttestationPayload,
  buildGenieProofEvidenceFactHash,
  GENIEPROOF_PPF_PARSER_VERSION,
  GENIEPROOF_PPF_RATE_RULE_VERSION,
} from '../agents/genieProof/genieProofEvidenceContract.js';
import {
  computeGenieProofRetrievalReceiptHash,
  computeGenieProofSourceDefinitionHash,
  refreshGenieProofIndiaPostPpfEvidence,
  resolveGenieProofEvidenceForClaims,
} from '../agents/genieProof/genieProofEvidenceRegistryService.js';
import { GENIEPROOF_SOURCE_CATALOG_CANDIDATES } from '../agents/genieProof/genieProofSourceCatalog.js';
import { migratePersistenceIndexes, verifyGenieProofPersistenceIndexes } from '../services/persistenceIndexReadiness.js';
import { setupTestDatabase, teardownTestDatabase } from './helpers/mongoTestHelper.js';

const noMongoPartition = process.env.MONGO_TEST_PARTITION === 'NO_MONGO';

function makeFixtureReceipt({ source, url, contentType, body, responseLineage, now }) {
  const contentSha256 = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
  const receipt = {
    retrievalId: crypto.randomUUID(),
    sourceId: source.sourceId,
    sourceRevision: source.revision,
    requestedUrl: url,
    finalUrl: url,
    redirectCount: 0,
    statusCode: 200,
    contentType,
    contentBytes: Buffer.byteLength(body, 'utf8'),
    contentSha256,
    retrievedAt: now,
    publicationAt: null,
    fetchClassification: 'SUCCESS',
    fetcherVersion: 'proofbreak-mongo-test-fixture/1',
    responseLineage,
  };
  return { ...receipt, receiptHash: computeGenieProofRetrievalReceiptHash(receipt) };
}

async function saveSyntheticEvidenceRevision({ source, signer, fact, evidenceId, revision, receipts, now, supersedes = null }) {
  const evidence = {
    evidenceId,
    revision,
    sourceId: source.sourceId,
    sourceRevision: source.revision,
    sourceDefinitionHash: source.definitionHash,
    retrievalIds: receipts.map(receipt => receipt.retrievalId),
    retrievalReceiptHashes: receipts.map(receipt => receipt.receiptHash),
    publicationAt: null,
    retrievedAt: now,
    sourceContentCommitment: receipts.find(receipt => receipt.contentType === 'application/javascript').contentSha256,
    sourceQualificationAtAssessment: source.qualificationStatus,
    reusePermissionAtAssessment: source.reusePermissionStatus,
    freshnessStatus: 'FRESH',
    revocationStatus: 'ACTIVE',
    fact,
    parserVersion: GENIEPROOF_PPF_PARSER_VERSION,
    ruleVersion: GENIEPROOF_PPF_RATE_RULE_VERSION,
    sourceLineage: ['test-fixture://synthetic-only', receipts[0].contentSha256],
    supersedes,
  };
  evidence.factHash = buildGenieProofEvidenceFactHash(fact);
  evidence.attestation = signer.signManifest(buildGenieProofEvidenceAttestationPayload(evidence));
  await GenieProofEvidenceRevision.create(evidence);
  return evidence;
}

test('Mongo ProofBreak worker completes a real reassessment and publishes a scoped event/outbox', {
  skip: noMongoPartition,
  timeout: 90_000,
}, async () => {
  await setupTestDatabase({ requireReplicaSet: true });
  const userId = new mongoose.Types.ObjectId();
  const otherUserId = new mongoose.Types.ObjectId();
  const revokedUserId = new mongoose.Types.ObjectId();
  const raceUserId = new mongoose.Types.ObjectId();
  const deletionRaceUserId = new mongoose.Types.ObjectId();
  const nowAt = new Date();
  const privateKey = crypto.generateKeyPairSync('ed25519');
  const signer = new GenieProofPassportSigner({
    privateKeyPem: privateKey.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem: privateKey.publicKey.export({ type: 'spki', format: 'pem' }),
    keyId: `proofbreak-mongo-${crypto.randomUUID()}`,
  });
  const offerText = 'The PPF interest rate is 7.1% p.a.';
  const extraction = extractGenieProofClaims(offerText);
  assert.equal(extraction.claims.length, 1);
  assert.equal(extraction.claims[0].claimType, 'CURRENT_NOMINAL_RATE');
  let sourceId = null;
  let watchId = null;
  let revokedCaseId = null;
  let revokedWatchId = null;
  let readinessWorkerId = null;
  let raceCaseId = null;
  let raceWatchId = null;
  let deletionRaceCaseId = null;
  let deletionRaceWatchId = null;

  try {
    await migratePersistenceIndexes();
    assert.equal((await verifyGenieProofPersistenceIndexes({ force: true })).ready, true);

    const createdCase = await createGenieProofCase({
      userId,
      offerText,
      submissionHash: extraction.inputHash,
      savingConsent: true,
      confirmedClaims: extraction.claims.map(claim => ({
        claimId: claim.claimId,
        statement: claim.originalSpan,
        claimType: claim.claimType,
        productId: claim.productId,
        value: claim.value,
        unit: claim.unit,
      })),
      idempotencyKey: `proofbreak-worker-${crypto.randomUUID()}`,
      signer,
      now: () => nowAt,
    });
    assert.equal(createdCase.passport.manifest.findings[0].finding, 'NOT_VERIFIABLE');

    // This source definition is a disposable synthetic test fixture. It does not
    // change or qualify the production catalog candidate or authorize live fetches.
    const catalogCandidate = GENIEPROOF_SOURCE_CATALOG_CANDIDATES[0];
    sourceId = catalogCandidate.sourceId;
    const source = {
      ...catalogCandidate,
      sourceId,
      revision: catalogCandidate.revision + 1,
      qualificationStatus: 'QUALIFIED_FOR_USER_PRESENTATION',
      reusePermissionStatus: 'APPROVED',
      lineage: [`${catalogCandidate.sourceId}:${catalogCandidate.revision}`],
      supersedes: { sourceId: catalogCandidate.sourceId, revision: catalogCandidate.revision },
      reviewRecord: {
        reviewedAt: nowAt,
        reference: 'test-fixture://synthetic-only',
        scope: 'Disposable Mongo test fixture; no external source reuse or fetch.',
      },
    };
    source.definitionHash = computeGenieProofSourceDefinitionHash(source);
    await GenieProofSourceDefinition.create(source);

    const rootBody = 'Synthetic source page fixture; no network request was made.';
    const rootReceipt = makeFixtureReceipt({
      source,
      url: source.endpoint,
      contentType: 'text/html',
      body: rootBody,
      responseLineage: [],
      now: nowAt,
    });
    const scriptBody = 'Synthetic source bundle fixture; no financial facts are derived from this body.';
    const scriptUrl = new URL('/_next/static/chunks/test-fixture.js', source.endpoint).toString();
    const scriptReceipt = makeFixtureReceipt({
      source,
      url: scriptUrl,
      contentType: 'application/javascript',
      body: scriptBody,
      responseLineage: [rootReceipt.contentSha256],
      now: nowAt,
    });
    await GenieProofRetrievalReceipt.create([rootReceipt, scriptReceipt]);

    // Synthetic fixture facts exist only to exercise deterministic replay and
    // the transactional worker pipeline; they are not claims about current rates.
    const initialFact = {
      claimType: 'CURRENT_NOMINAL_RATE',
      productId: 'government:india-post:ppf',
      value: 7.1,
      unit: 'PERCENT_PER_ANNUM',
      effectiveFrom: new Date(nowAt.getTime() - 60_000),
      effectiveTo: new Date(nowAt.getTime() + 60 * 60 * 1000),
      conditions: [],
    };
    const evidenceId = `${sourceId}:synthetic-fixture`;
    await saveSyntheticEvidenceRevision({
      source,
      signer,
      fact: initialFact,
      evidenceId,
      revision: 1,
      receipts: [rootReceipt, scriptReceipt],
      now: nowAt,
    });
    const fixtureResolution = await resolveGenieProofEvidenceForClaims({
      claims: createdCase.passport.manifest.confirmedClaims,
      now: () => nowAt,
    });
    assert.equal(
      fixtureResolution.byClaimId[extraction.claims[0].claimId]?.length,
      1,
      'the synthetic test fixture should resolve through the persisted evidence registry',
    );

    const initialReassessment = await reassessGenieProofCase({
      userId,
      caseId: createdCase.case.caseId,
      expectedRevision: createdCase.passport.manifest.revision,
      expectedManifestHash: createdCase.passport.manifestHash,
      reassessmentConsent: true,
      idempotencyKey: `proofbreak-initial-${crypto.randomUUID()}`,
      signer,
      evidenceResolver: resolveGenieProofEvidenceForClaims,
      now: () => nowAt,
    });
    assert.equal(initialReassessment.revision, 2);
    assert.equal(initialReassessment.passport.manifest.findings[0].finding, 'SUPPORTED');

    readinessWorkerId = `proofbreak-readiness-${crypto.randomUUID()}`;
    await ProofBreakWorkerHeartbeat.create({
      workerId: readinessWorkerId,
      status: 'RUNNING',
      startedAt: nowAt,
      heartbeatAt: nowAt,
      lastSuccessfulPollAt: nowAt,
      lastPollErrorCode: null,
      expiresAt: new Date(nowAt.getTime() + 30_000),
    });
    const watchResult = await createProofWatch({
      userId,
      caseId: createdCase.case.caseId,
      watchConsent: true,
      idempotencyKey: `proofbreak-watch-${crypto.randomUUID()}`,
      now: () => nowAt,
    });
    watchId = watchResult.watch.watchId;
    assert.equal(watchResult.created, true);
    assert.equal(watchResult.watch.status, 'ACTIVE');

    let checkReceiptIds = [];
    const worker = new ProofBreakWorker({
      signer,
      workerId: `proofbreak-worker-${crypto.randomUUID()}`,
      now: () => nowAt,
      refreshEvidence: async () => {
        const observedAt = new Date(nowAt.getTime() + 1);
        const observedRoot = makeFixtureReceipt({ source, url: source.endpoint, contentType: 'text/html', body: `${rootBody} Updated synthetic retrieval.`, responseLineage: [], now: observedAt });
        const observedScript = makeFixtureReceipt({ source, url: scriptUrl, contentType: 'application/javascript', body: `${scriptBody} Revision two.`, responseLineage: [observedRoot.contentSha256], now: observedAt });
        await GenieProofRetrievalReceipt.create([observedRoot, observedScript]);
        checkReceiptIds = [observedRoot.retrievalId, observedScript.retrievalId];
        const changedFact = { ...initialFact, value: 7.4 };
        await saveSyntheticEvidenceRevision({
          source,
          signer,
          fact: changedFact,
          evidenceId,
          revision: 2,
          receipts: [observedRoot, observedScript],
          now: observedAt,
          supersedes: `${evidenceId}:1`,
        });
        return { created: true, retrievalIds: checkReceiptIds };
      },
      evidenceResolver: resolveGenieProofEvidenceForClaims,
    });
    const check = await worker.processNext();
    assert.equal(check.status, 'COMPLETED');
    assert.equal(check.revision, 3);

    const [savedCase, savedJob, savedWatch, revisions, ownerTimeline, otherTimeline, outbox] = await Promise.all([
      GenieProofCase.findOne({ userId, caseId: createdCase.case.caseId }).lean(),
      ProofBreakJob.findOne({ watchId }).lean(),
      ProofWatch.findOne({ userId, watchId }).lean(),
      listGenieProofRevisions({ userId, caseId: createdCase.case.caseId, signer }),
      listProofBreakEvents({ userId, caseId: createdCase.case.caseId }),
      listProofBreakEvents({ userId: otherUserId, caseId: createdCase.case.caseId }),
      ProofNotificationOutbox.find({ userId, watchId }).lean(),
    ]);
    assert.equal(savedCase.latestRevision, 3);
    assert.equal(savedJob.status, 'COMPLETED');
    assert.equal(savedWatch.status, 'ACTIVE');
    assert.equal(revisions.revisions.length, 3);
    assert.ok(revisions.revisions.every(row => row.verification.integrity === 'VALID'));
    assert.equal(
      revisions.revisions[0].passport.manifest.findings[0].finding,
      'CONTRADICTED',
      JSON.stringify(revisions.revisions[0].passport.manifest.findings[0]),
    );
    assert.equal(revisions.revisions[1].passport.manifest.findings[0].finding, 'SUPPORTED');
    assert.equal(ownerTimeline.events[0].previousAssessmentId, `${createdCase.case.caseId}:2`);
    assert.equal(ownerTimeline.events[0].newAssessmentId, `${createdCase.case.caseId}:3`);
    assert.equal(ownerTimeline.events[0].previousEvidenceRevision, `${evidenceId}:1`);
    assert.equal(ownerTimeline.events[0].newEvidenceRevision, `${evidenceId}:2`);
    assert.ok(ownerTimeline.events[0].changedFactFields.includes('value'));
    assert.equal(ownerTimeline.events.length, 1);
    assert.equal(ownerTimeline.events[0].eventType, 'FINDING_CHANGED');
    assert.deepEqual(ownerTimeline.events[0].retrievalReceiptIds, checkReceiptIds);
    assert.equal(ownerTimeline.events[0].notificationStatus, 'PENDING');
    assert.equal(otherTimeline.events.length, 0);
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].status, 'PENDING');

    const notification = await worker.processNext();
    assert.deepEqual(notification, { processed: true, kind: 'NOTIFICATION', status: 'DELIVERED' });
    const [deliveredOutbox, deliveredTimeline] = await Promise.all([
      ProofNotificationOutbox.findOne({ userId, watchId }).lean(),
      listProofBreakEvents({ userId, caseId: createdCase.case.caseId }),
    ]);
    assert.equal(deliveredOutbox.status, 'DELIVERED');
    assert.equal(deliveredTimeline.events[0].notificationStatus, 'DELIVERED');
    assert.equal(await ProofBreakEvent.countDocuments({ userId: otherUserId, caseId: createdCase.case.caseId }), 0);

    await ProofWatch.updateOne({ userId, watchId }, { $set: { nextCheckAt: new Date(nowAt.getTime() - 1) } });
    const processingFailureWorker = new ProofBreakWorker({
      signer,
      workerId: `proofbreak-processing-failure-${crypto.randomUUID()}`,
      now: () => nowAt,
      refreshEvidence: async () => { throw Object.assign(new Error('Assessment state could not be loaded.'), { code: 'GENIEPROOF_CASE_HEAD_MISMATCH', status: 503 }); },
    });
    const processingFailure = await processingFailureWorker.processNext();
    assert.equal(processingFailure.status, 'FAILED_RETRYABLE');
    const failureTimeline = await listProofBreakEvents({ userId, caseId: createdCase.case.caseId });
    assert.ok(failureTimeline.events.some(event => event.eventType === 'PROCESSING_FAILED'));
    assert.equal(await ProofBreakEvent.countDocuments({ userId, caseId: createdCase.case.caseId, eventType: 'SOURCE_UNAVAILABLE' }), 0);

    assert.equal((await updateProofWatchStatus({ userId, watchId, action: 'pause' })).status, 'PAUSED');
    assert.equal((await updateProofWatchStatus({ userId, watchId, action: 'resume' })).status, 'ACTIVE');
    assert.equal((await updateProofWatchStatus({ userId, watchId, action: 'disable' })).status, 'CANCELLED');
    assert.equal(await ProofBreakJob.countDocuments({ userId, watchId, status: { $in: ['QUEUED', 'LEASED'] } }), 0);

    assert.equal(await withdrawGenieProofConsent({ userId, caseId: createdCase.case.caseId }), true);
    const withdrawnWatch = await ProofWatch.findOne({ userId, watchId }).lean();
    assert.equal(withdrawnWatch.status, 'CANCELLED');
    assert.ok(withdrawnWatch.consentWithdrawnAt);

    assert.equal(await deleteGenieProofCase({ userId, caseId: createdCase.case.caseId }), true);
    assert.equal(await GenieProofCase.countDocuments({ userId, caseId: createdCase.case.caseId }), 0);
    assert.equal(await GenieProofRevision.countDocuments({ userId, caseId: createdCase.case.caseId }), 0);
    assert.equal(await ProofWatch.countDocuments({ userId, caseId: createdCase.case.caseId }), 0);
    assert.equal(await ProofBreakJob.countDocuments({ userId, caseId: createdCase.case.caseId }), 0);
    assert.equal(await ProofBreakEvent.countDocuments({ userId, caseId: createdCase.case.caseId }), 0);
    assert.equal(await ProofNotificationOutbox.countDocuments({ userId, caseId: createdCase.case.caseId }), 0);

    const revokedCase = await createGenieProofCase({
      userId: revokedUserId,
      offerText,
      submissionHash: extraction.inputHash,
      savingConsent: true,
      confirmedClaims: extraction.claims.map(claim => ({
        claimId: claim.claimId,
        statement: claim.originalSpan,
        claimType: claim.claimType,
        productId: claim.productId,
        value: claim.value,
        unit: claim.unit,
      })),
      idempotencyKey: `proofbreak-revoked-source-${crypto.randomUUID()}`,
      signer,
      now: () => nowAt,
    });
    revokedCaseId = revokedCase.case.caseId;
    await ProofBreakWorkerHeartbeat.updateOne({ workerId: readinessWorkerId }, {
      $set: { heartbeatAt: nowAt, lastSuccessfulPollAt: nowAt, lastPollErrorCode: null, expiresAt: new Date(nowAt.getTime() + 30_000) },
    });
    const revokedWatch = await createProofWatch({
      userId: revokedUserId,
      caseId: revokedCaseId,
      watchConsent: true,
      idempotencyKey: `proofbreak-revoked-watch-${crypto.randomUUID()}`,
      now: () => nowAt,
    });
    revokedWatchId = revokedWatch.watch.watchId;
    assert.equal(revokedWatch.watch.status, 'ACTIVE');

    const revokedSource = {
      ...source,
      revision: source.revision + 1,
      qualificationStatus: 'REVOKED',
      reusePermissionStatus: 'REVOKED',
      revocationReasonCode: 'TEST_FIXTURE_PERMISSION_REVOKED',
      lineage: [...source.lineage, `revoked-test-revision:${source.revision}`],
      supersedes: { sourceId, revision: source.revision },
    };
    revokedSource.definitionHash = computeGenieProofSourceDefinitionHash(revokedSource);
    await GenieProofSourceDefinition.create(revokedSource);

    let revokedFetchCalls = 0;
    const revokedWorker = new ProofBreakWorker({
      signer,
      workerId: `proofbreak-revoked-worker-${crypto.randomUUID()}`,
      now: () => nowAt,
      refreshEvidence: options => refreshGenieProofIndiaPostPpfEvidence({
        ...options,
        sourceModel: GenieProofSourceDefinition,
        fetcher: { async fetchDocument() { revokedFetchCalls += 1; throw new Error('Revoked source must not be fetched.'); } },
      }),
      evidenceResolver: resolveGenieProofEvidenceForClaims,
    });
    const revokedCheck = await revokedWorker.processNext();
    assert.equal(revokedCheck.status, 'BLOCKED_SOURCE_RIGHTS');
    assert.equal(revokedFetchCalls, 0, 'revocation must block the worker before source retrieval');
    const [revokedJob, revokedPersistedWatch, revokedEvent] = await Promise.all([
      ProofBreakJob.findOne({ userId: revokedUserId, watchId: revokedWatchId }).lean(),
      ProofWatch.findOne({ userId: revokedUserId, watchId: revokedWatchId }).lean(),
      ProofBreakEvent.findOne({ userId: revokedUserId, watchId: revokedWatchId }).lean(),
    ]);
    assert.equal(revokedJob.status, 'FAILED_TERMINAL');
    assert.equal(revokedJob.failureCode, 'GENIEPROOF_SOURCE_REVOKED');
    assert.equal(revokedPersistedWatch.status, 'BLOCKED_SOURCE_RIGHTS');
    assert.equal(revokedPersistedWatch.sourceAvailability, 'RIGHTS_BLOCKED');
    assert.equal(revokedPersistedWatch.lastFailureCode, 'GENIEPROOF_SOURCE_REVOKED');
    assert.equal(revokedPersistedWatch.nextCheckAt, null);
    assert.equal(revokedEvent.eventType, 'POLICY_REVIEW_REQUIRED');
    assert.equal(await ProofBreakJob.countDocuments({ userId: revokedUserId, watchId: revokedWatchId, status: { $in: ['QUEUED', 'LEASED'] } }), 0);
    assert.equal(await ProofBreakEvent.countDocuments({ userId: revokedUserId, watchId: revokedWatchId, eventType: 'SOURCE_UNAVAILABLE' }), 0);

    const raceCase = await createGenieProofCase({
      userId: raceUserId,
      offerText,
      submissionHash: extraction.inputHash,
      savingConsent: true,
      confirmedClaims: extraction.claims.map(claim => ({
        claimId: claim.claimId,
        statement: claim.originalSpan,
        claimType: claim.claimType,
        productId: claim.productId,
        value: claim.value,
        unit: claim.unit,
      })),
      idempotencyKey: `proofbreak-race-${crypto.randomUUID()}`,
      signer,
      now: () => nowAt,
    });
    raceCaseId = raceCase.case.caseId;
    const [watchCreation, consentWithdrawal] = await Promise.allSettled([
      createProofWatch({
        userId: raceUserId,
        caseId: raceCaseId,
        watchConsent: true,
        idempotencyKey: `proofbreak-race-watch-${crypto.randomUUID()}`,
        now: () => nowAt,
      }),
      withdrawGenieProofConsent({ userId: raceUserId, caseId: raceCaseId, now: () => nowAt }),
    ]);
    const isTransientTransactionConflict = error => error?.hasErrorLabel?.('TransientTransactionError') === true
      || [112, 251].includes(error?.code);
    if (watchCreation.status === 'rejected') {
      assert.ok(['GENIEPROOF_CONSENT_WITHDRAWN', 'GENIEPROOF_CASE_CHANGED'].includes(watchCreation.reason.code)
        || isTransientTransactionConflict(watchCreation.reason), `Unexpected watch race failure: ${watchCreation.reason.code || watchCreation.reason.name}`);
    }
    if (consentWithdrawal.status === 'rejected') {
      assert.ok(isTransientTransactionConflict(consentWithdrawal.reason), `Unexpected consent race failure: ${consentWithdrawal.reason.code || consentWithdrawal.reason.name}`);
      await withdrawGenieProofConsent({ userId: raceUserId, caseId: raceCaseId, now: () => nowAt });
    }
    if (watchCreation.status === 'fulfilled') raceWatchId = watchCreation.value.watch.watchId;
    const activeRaceWatch = await ProofWatch.countDocuments({
      userId: raceUserId,
      caseId: raceCaseId,
      status: { $in: ['ACTIVE', 'PAUSED', 'WAITING_FOR_SOURCE', 'BLOCKED_SOURCE_RIGHTS', 'FAILED_RETRYABLE', 'FAILED_TERMINAL'] },
    });
    const queuedRaceJobs = await ProofBreakJob.countDocuments({ userId: raceUserId, caseId: raceCaseId, status: { $in: ['QUEUED', 'LEASED'] } });
    assert.equal(activeRaceWatch, 0);
    assert.equal(queuedRaceJobs, 0);
    assert.equal(await deleteGenieProofCase({ userId: raceUserId, caseId: raceCaseId }), true);

    const deletionRaceCase = await createGenieProofCase({
      userId: deletionRaceUserId,
      offerText,
      submissionHash: extraction.inputHash,
      savingConsent: true,
      confirmedClaims: extraction.claims.map(claim => ({
        claimId: claim.claimId,
        statement: claim.originalSpan,
        claimType: claim.claimType,
        productId: claim.productId,
        value: claim.value,
        unit: claim.unit,
      })),
      idempotencyKey: `proofbreak-delete-race-${crypto.randomUUID()}`,
      signer,
      now: () => nowAt,
    });
    deletionRaceCaseId = deletionRaceCase.case.caseId;
    const [deletionWatchCreation, caseDeletion] = await Promise.allSettled([
      createProofWatch({
        userId: deletionRaceUserId,
        caseId: deletionRaceCaseId,
        watchConsent: true,
        idempotencyKey: `proofbreak-delete-race-watch-${crypto.randomUUID()}`,
        now: () => nowAt,
      }),
      deleteGenieProofCase({ userId: deletionRaceUserId, caseId: deletionRaceCaseId }),
    ]);
    if (deletionWatchCreation.status === 'rejected') {
      assert.ok(['GENIEPROOF_CASE_NOT_FOUND', 'GENIEPROOF_CASE_CHANGED'].includes(deletionWatchCreation.reason.code)
        || isTransientTransactionConflict(deletionWatchCreation.reason), `Unexpected delete race failure: ${deletionWatchCreation.reason.code || deletionWatchCreation.reason.name}`);
    }
    if (deletionWatchCreation.status === 'fulfilled') deletionRaceWatchId = deletionWatchCreation.value.watch.watchId;
    if (caseDeletion.status === 'rejected') {
      assert.ok(isTransientTransactionConflict(caseDeletion.reason), `Unexpected case deletion race failure: ${caseDeletion.reason.code || caseDeletion.reason.name}`);
      assert.equal(await deleteGenieProofCase({ userId: deletionRaceUserId, caseId: deletionRaceCaseId }), true);
    } else {
      assert.equal(caseDeletion.value, true);
    }
    assert.equal(await GenieProofCase.countDocuments({ userId: deletionRaceUserId, caseId: deletionRaceCaseId }), 0);
    assert.equal(await ProofWatch.countDocuments({ userId: deletionRaceUserId, caseId: deletionRaceCaseId }), 0);
    assert.equal(await ProofBreakJob.countDocuments({ userId: deletionRaceUserId, caseId: deletionRaceCaseId }), 0);
  } finally {
    await Promise.all([
      GenieProofRevision.deleteMany({ userId }),
      GenieProofCase.deleteMany({ userId }),
      ...(watchId ? [
        ProofWatch.deleteMany({ watchId }),
        ProofBreakJob.deleteMany({ watchId }),
        ProofBreakEvent.deleteMany({ watchId }),
        ProofNotificationOutbox.deleteMany({ watchId }),
      ] : []),
      ...(sourceId ? [
        GenieProofEvidenceRevision.deleteMany({ sourceId }),
        GenieProofRetrievalReceipt.deleteMany({ sourceId }),
        GenieProofSourceDefinition.deleteMany({ sourceId }),
      ] : []),
      ...(revokedCaseId ? [
        ...(revokedWatchId ? [
          ProofWatch.deleteMany({ userId: revokedUserId, watchId: revokedWatchId }),
          ProofBreakJob.deleteMany({ userId: revokedUserId, watchId: revokedWatchId }),
          ProofBreakEvent.deleteMany({ userId: revokedUserId, watchId: revokedWatchId }),
          ProofNotificationOutbox.deleteMany({ userId: revokedUserId, watchId: revokedWatchId }),
        ] : []),
        ProofWatch.deleteMany({ userId: revokedUserId, caseId: revokedCaseId }),
        ProofBreakJob.deleteMany({ userId: revokedUserId, caseId: revokedCaseId }),
        ProofBreakEvent.deleteMany({ userId: revokedUserId, caseId: revokedCaseId }),
        ProofNotificationOutbox.deleteMany({ userId: revokedUserId, caseId: revokedCaseId }),
        GenieProofRevision.deleteMany({ userId: revokedUserId, caseId: revokedCaseId }),
        GenieProofCase.deleteMany({ userId: revokedUserId, caseId: revokedCaseId }),
      ] : []),
      ProofBreakWorkerHeartbeat.deleteMany({ workerId: /^proofbreak-readiness-/ }),
      ...(raceCaseId ? [
        ...(raceWatchId ? [
          ProofWatch.deleteMany({ userId: raceUserId, watchId: raceWatchId }),
          ProofBreakJob.deleteMany({ userId: raceUserId, watchId: raceWatchId }),
          ProofBreakEvent.deleteMany({ userId: raceUserId, watchId: raceWatchId }),
          ProofNotificationOutbox.deleteMany({ userId: raceUserId, watchId: raceWatchId }),
        ] : []),
        ProofWatch.deleteMany({ userId: raceUserId, caseId: raceCaseId }),
        ProofBreakJob.deleteMany({ userId: raceUserId, caseId: raceCaseId }),
        ProofBreakEvent.deleteMany({ userId: raceUserId, caseId: raceCaseId }),
        ProofNotificationOutbox.deleteMany({ userId: raceUserId, caseId: raceCaseId }),
        GenieProofRevision.deleteMany({ userId: raceUserId, caseId: raceCaseId }),
        GenieProofCase.deleteMany({ userId: raceUserId, caseId: raceCaseId }),
      ] : []),
      ...(deletionRaceCaseId ? [
        ...(deletionRaceWatchId ? [
          ProofWatch.deleteMany({ userId: deletionRaceUserId, watchId: deletionRaceWatchId }),
          ProofBreakJob.deleteMany({ userId: deletionRaceUserId, watchId: deletionRaceWatchId }),
          ProofBreakEvent.deleteMany({ userId: deletionRaceUserId, watchId: deletionRaceWatchId }),
          ProofNotificationOutbox.deleteMany({ userId: deletionRaceUserId, watchId: deletionRaceWatchId }),
        ] : []),
        ProofWatch.deleteMany({ userId: deletionRaceUserId, caseId: deletionRaceCaseId }),
        ProofBreakJob.deleteMany({ userId: deletionRaceUserId, caseId: deletionRaceCaseId }),
        ProofBreakEvent.deleteMany({ userId: deletionRaceUserId, caseId: deletionRaceCaseId }),
        ProofNotificationOutbox.deleteMany({ userId: deletionRaceUserId, caseId: deletionRaceCaseId }),
        GenieProofRevision.deleteMany({ userId: deletionRaceUserId, caseId: deletionRaceCaseId }),
        GenieProofCase.deleteMany({ userId: deletionRaceUserId, caseId: deletionRaceCaseId }),
      ] : []),
    ]);
    await teardownTestDatabase();
  }
});
