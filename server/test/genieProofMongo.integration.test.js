import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import GenieProofCase from '../models/GenieProofCase.js';
import GenieProofRevision from '../models/GenieProofRevision.js';
import { extractGenieProofClaims } from '../agents/genieProof/genieProofCore.js';
import { createGenieProofCase, deleteGenieProofCase, listGenieProofCases, listGenieProofRevisions } from '../agents/genieProof/genieProofService.js';
import { GENIEPROOF_MAX_CASES_PER_USER, GENIEPROOF_RETENTION_DAYS } from '../agents/genieProof/genieProofPolicy.js';
import { GenieProofPassportSigner } from '../agents/genieProof/genieProofPassportSignature.js';
import { migratePersistenceIndexes, verifyGenieProofPersistenceIndexes } from '../services/persistenceIndexReadiness.js';
import { setupTestDatabase, teardownTestDatabase } from './helpers/mongoTestHelper.js';

const noMongoPartition = process.env.MONGO_TEST_PARTITION === 'NO_MONGO';

test('Mongo GenieProof transactions enforce owner quota, retain verifiable history, and delete revisions atomically', {
  skip: noMongoPartition,
  timeout: 60_000,
}, async () => {
  await setupTestDatabase({ requireReplicaSet: true });
  const userId = new mongoose.Types.ObjectId();
  const concurrencyUserId = new mongoose.Types.ObjectId();
  const legacyUserId = new mongoose.Types.ObjectId();
  const pair = crypto.generateKeyPairSync('ed25519');
  const signer = new GenieProofPassportSigner({
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
    keyId: 'genieproof-mongo-integration',
  });
  const offerText = 'The current official PPF interest rate is 7.1% p.a.';
  const extraction = extractGenieProofClaims(offerText);
  const request = {
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
    signer,
  };
  const caseIds = [];

  try {
    await migratePersistenceIndexes();
    assert.equal((await verifyGenieProofPersistenceIndexes({ force: true })).ready, true);

    const legacyCaseId = crypto.randomUUID();
    await GenieProofCase.collection.insertOne({
      userId: legacyUserId,
      caseId: legacyCaseId,
      submissionHash: 'a'.repeat(64),
      requestHash: 'b'.repeat(64),
      idempotencyKeyHash: 'c'.repeat(64),
      confirmedClaims: [],
      savingConsentVersion: 'genieproof-private-save/1',
      savingConsentAt: new Date(),
      latestRevision: 1,
      latestManifestHash: 'd'.repeat(64),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await GenieProofRevision.collection.insertOne({
      userId: legacyUserId,
      caseId: legacyCaseId,
      revision: 1,
      manifest: { caseId: legacyCaseId, revision: 1 },
      manifestHash: 'd'.repeat(64),
      signature: { algorithm: 'Ed25519', keyId: 'legacy', publicKeyFingerprint: 'e'.repeat(64), value: 'signature' },
      assessedAt: new Date(),
      createdAt: new Date(),
    });
    await migratePersistenceIndexes();
    const [legacyCase, legacyRevision] = await Promise.all([
      GenieProofCase.collection.findOne({ userId: legacyUserId, caseId: legacyCaseId }),
      GenieProofRevision.collection.findOne({ userId: legacyUserId, caseId: legacyCaseId }),
    ]);
    assert.ok(legacyCase.expiresAt instanceof Date);
    assert.ok(legacyRevision.expiresAt instanceof Date);
    assert.equal(legacyCase.expiresAt.getTime(), legacyRevision.expiresAt.getTime());
    assert.ok(legacyCase.expiresAt > new Date(Date.now() + (GENIEPROOF_RETENTION_DAYS - 1) * 86400000));

    for (let index = 0; index < GENIEPROOF_MAX_CASES_PER_USER; index += 1) {
      const created = await createGenieProofCase({
        ...request,
        idempotencyKey: `genieproof-mongo-${userId}-${index}`,
      });
      caseIds.push(created.case.caseId);
    }

    assert.equal((await listGenieProofCases({ userId })).length, GENIEPROOF_MAX_CASES_PER_USER);
    await assert.rejects(
      createGenieProofCase({ ...request, idempotencyKey: `genieproof-mongo-${userId}-over` }),
      error => error.code === 'GENIEPROOF_CASE_QUOTA_REACHED' && error.status === 429,
    );

    for (let index = 0; index < GENIEPROOF_MAX_CASES_PER_USER - 1; index += 1) {
      await createGenieProofCase({
        ...request,
        userId: concurrencyUserId,
        idempotencyKey: `genieproof-concurrency-${concurrencyUserId}-${index}`,
      });
    }
    const concurrentResults = await Promise.allSettled([
      createGenieProofCase({ ...request, userId: concurrencyUserId, idempotencyKey: `genieproof-concurrent-a-${concurrencyUserId}` }),
      createGenieProofCase({ ...request, userId: concurrencyUserId, idempotencyKey: `genieproof-concurrent-b-${concurrencyUserId}` }),
    ]);
    assert.equal(concurrentResults.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(
      concurrentResults.filter(result => result.status === 'rejected'
        && result.reason.code === 'GENIEPROOF_CASE_QUOTA_REACHED'
        && result.reason.status === 429).length,
      1,
      JSON.stringify(concurrentResults.map(result => result.status === 'rejected'
        ? { status: result.status, code: result.reason.code, mongoCode: result.reason.mongoCode, message: result.reason.message }
        : { status: result.status })),
    );
    assert.equal((await listGenieProofCases({ userId: concurrencyUserId })).length, GENIEPROOF_MAX_CASES_PER_USER);

    const history = await listGenieProofRevisions({ userId, caseId: caseIds[0], signer });
    assert.equal(history.revisions.length, 1);
    assert.equal(history.revisions[0].verification.integrity, 'VALID');

    assert.equal(await deleteGenieProofCase({ userId, caseId: caseIds[0] }), true);
    assert.equal(await GenieProofRevision.countDocuments({ userId, caseId: caseIds[0] }), 0);
    assert.equal(await GenieProofCase.countDocuments({ userId, caseId: caseIds[0] }), 0);
  } finally {
    await GenieProofRevision.deleteMany({ userId });
    await GenieProofCase.deleteMany({ userId });
    await GenieProofRevision.deleteMany({ userId: concurrencyUserId });
    await GenieProofCase.deleteMany({ userId: concurrencyUserId });
    await GenieProofRevision.deleteMany({ userId: legacyUserId });
    await GenieProofCase.deleteMany({ userId: legacyUserId });
    await teardownTestDatabase();
  }
});
