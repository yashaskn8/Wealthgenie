import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildGenieProofManifest, extractGenieProofClaims, GENIEPROOF_SUPPORTED_PRODUCT_ID } from '../agents/genieProof/genieProofCore.js';
import { GenieProofPassportSigner } from '../agents/genieProof/genieProofPassportSignature.js';
import { createGenieProofCase, deleteGenieProofCase, getGenieProofCase, listGenieProofCases, listGenieProofRevisions, reassessGenieProofCase, verifyGenieProofCase, withdrawGenieProofConsent } from '../agents/genieProof/genieProofService.js';
import { GENIEPROOF_MAX_CASES_PER_USER, GENIEPROOF_RETENTION_DAYS } from '../agents/genieProof/genieProofPolicy.js';
import { genieProofCreateCaseSchema } from '../agents/genieProof/genieProofSchemas.js';

const userOne = '65b000000000000000000001';
const userTwo = '65b000000000000000000002';
const now = () => new Date('2026-10-11T08:00:00.000Z');

function fixture() {
  const cases = [];
  const revisions = [];
  const watches = [];
  const jobs = [];
  const events = [];
  const outbox = [];
  const session = {
    active: false,
    committed: false,
    aborted: false,
    startTransaction() { this.active = true; },
    async commitTransaction() { this.committed = true; this.active = false; },
    async abortTransaction() { this.aborted = true; this.active = false; },
    inTransaction() { return this.active; },
    async endSession() {},
  };
  const matches = (row, filter) => Object.entries(filter).every(([key, value]) => {
    if (key === '$and') return value.every(condition => matches(row, condition));
    if (key === '$or') return value.some(condition => matches(row, condition));
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if (Object.hasOwn(value, '$gt')) return new Date(row[key]) > new Date(value.$gt);
      if (Object.hasOwn(value, '$lte')) return new Date(row[key]) <= new Date(value.$lte);
      if (Object.hasOwn(value, '$exists')) return (row[key] !== undefined) === value.$exists;
      if (Object.hasOwn(value, '$ne')) return String(row[key] ?? '') !== String(value.$ne ?? '');
    }
    return String(row[key] ?? '') === String(value ?? '');
  });
  const leanQuery = value => ({ session() { return this; }, select() { return this; }, lean: async () => value });
  const caseModel = {
    async create([input]) {
      if (cases.some(row => row.userId === input.userId && row.idempotencyKeyHash === input.idempotencyKeyHash)) {
        throw Object.assign(new Error('duplicate'), { code: 11000, keyPattern: { idempotencyKeyHash: 1 } });
      }
      if (cases.some(row => row.userId === input.userId && row.quotaSlot === input.quotaSlot)) {
        throw Object.assign(new Error('duplicate'), { code: 11000, keyPattern: { quotaSlot: 1 } });
      }
      const row = { ...structuredClone(input), createdAt: now() };
      cases.push(row);
      return [row];
    },
    findOne(filter) { return leanQuery(cases.find(row => matches(row, filter)) || null); },
    find(filter) {
      let result = cases.filter(row => matches(row, filter));
      const query = {
        session() { return query; },
        select() { return query; },
        sort(order) {
          const [[key, direction]] = Object.entries(order);
          result = [...result].sort((a, b) => direction * (new Date(a[key] || 0) - new Date(b[key] || 0)));
          return query;
        },
        limit(value) { result = result.slice(0, value); return query; },
        lean: async () => result,
      };
      return query;
    },
    async deleteOne(filter) {
      const index = cases.findIndex(row => matches(row, filter));
      if (index < 0) return { deletedCount: 0 };
      cases.splice(index, 1);
      return { deletedCount: 1 };
    },
    async findOneAndDelete(filter) {
      const index = cases.findIndex(row => matches(row, filter));
      if (index < 0) return null;
      return cases.splice(index, 1)[0];
    },
    async updateOne(filter, update) {
      const row = cases.find(item => matches(item, filter));
      if (!row) return { modifiedCount: 0 };
      Object.assign(row, structuredClone(update.$set || {}));
      for (const [field, amount] of Object.entries(update.$inc || {})) row[field] = (row[field] || 0) + amount;
      return { modifiedCount: 1 };
    },
    findOneAndUpdate(filter, update) {
      const row = cases.find(item => matches(item, filter));
      if (row) {
        Object.assign(row, structuredClone(update.$set || {}));
        for (const [field, amount] of Object.entries(update.$inc || {})) row[field] = (row[field] || 0) + amount;
      }
      return leanQuery(row || null);
    },
  };
  const revisionModel = {
    async create([input]) {
      if (revisions.some(row => row.userId === input.userId && row.caseId === input.caseId && row.revision === input.revision)) {
        throw Object.assign(new Error('duplicate revision'), { code: 11000, keyPattern: { revision: 1 } });
      }
      if (input.idempotencyKeyHash && revisions.some(row => row.userId === input.userId && row.caseId === input.caseId && row.idempotencyKeyHash === input.idempotencyKeyHash)) {
        throw Object.assign(new Error('duplicate reassessment key'), { code: 11000, keyPattern: { idempotencyKeyHash: 1 } });
      }
      const row = structuredClone(input); revisions.push(row); return [row];
    },
    findOne(filter) { return leanQuery(revisions.find(row => matches(row, filter)) || null); },
    find(filter) {
      let result = revisions.filter(row => matches(row, filter));
      const query = {
        sort(order) {
          const [[key, direction]] = Object.entries(order);
          result = [...result].sort((a, b) => direction * (Number(a[key]) - Number(b[key])));
          return query;
        },
        limit(value) { result = result.slice(0, value); return query; },
        lean: async () => result,
      };
      return query;
    },
    async deleteMany(filter) {
      const before = revisions.length;
      for (let i = revisions.length - 1; i >= 0; i -= 1) if (matches(revisions[i], filter)) revisions.splice(i, 1);
      return { deletedCount: before - revisions.length };
    },
  };
  const childModel = rows => ({
    async deleteMany(filter) {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i -= 1) if (rows[i].userId === filter.userId && rows[i].caseId === filter.caseId) rows.splice(i, 1);
      return { deletedCount: before - rows.length };
    },
    async updateMany(filter, update) {
      let modifiedCount = 0;
      for (const row of rows) {
        if (row.userId === filter.userId && row.caseId === filter.caseId) {
          Object.assign(row, structuredClone(update.$set || {}));
          for (const [key, value] of Object.entries(update.$inc || {})) row[key] = (row[key] || 0) + value;
          modifiedCount += 1;
        }
      }
      return { modifiedCount };
    },
  });
  const pair = crypto.generateKeyPairSync('ed25519');
  const signer = new GenieProofPassportSigner({
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
    keyId: 'test-local-key',
  });
  return {
    cases, revisions, watches, jobs, events, outbox, session, caseModel, revisionModel, signer,
    watchModel: childModel(watches), jobModel: childModel(jobs), eventModel: childModel(events), outboxModel: childModel(outbox),
    startSession: async () => session,
  };
}

function requestFor(text = 'The current official PPF interest rate is 7.1% p.a.') {
  const extraction = extractGenieProofClaims(text);
  return {
    offerText: text,
    submissionHash: extraction.inputHash,
    savingConsent: true,
    confirmedClaims: extraction.claims.map(candidate => ({
      claimId: candidate.claimId,
      statement: candidate.originalSpan,
      claimType: candidate.claimType,
      productId: candidate.productId || GENIEPROOF_SUPPORTED_PRODUCT_ID,
      value: candidate.value,
      unit: candidate.unit,
    })),
  };
}

test('case persistence refuses sensitive inputs before opening any transaction', async () => {
  const f = fixture();
  let sessionsStarted = 0;
  const offerText = 'My PAN ABCDE 1234 F guarantees 12% profits.';
  await assert.rejects(createGenieProofCase({
    userId: userOne,
    offerText,
    submissionHash: '0'.repeat(64),
    savingConsent: true,
    confirmedClaims: [],
    idempotencyKey: 'genieproof-pii-rejected-before-save',
    signer: f.signer,
    startSession: async () => { sessionsStarted += 1; return f.session; },
  }), error => error.code === 'GENIEPROOF_SENSITIVE_IDENTIFIERS'
    && !error.clientMessage.includes('ABCDE'));
  assert.equal(sessionsStarted, 0);
  assert.equal(f.cases.length, 0);
});

test('case creation checks the original input hash, requires extracted claim IDs, and never stores offer text', async () => {
  const f = fixture();
  const request = requestFor();
  const created = await createGenieProofCase({
    userId: userOne, ...request, idempotencyKey: 'genieproof-test-1', signer: f.signer,
    ...f, now,
  });
  assert.equal(created.created, true);
  assert.equal(created.passport.manifest.findings[0].finding, 'NOT_VERIFIABLE');
  assert.equal(created.passport.manifest.confirmedClaims[0].statement, request.confirmedClaims[0].statement);
  assert.equal(Object.hasOwn(f.cases[0], 'offerText'), false);
  assert.equal(f.cases[0].confirmedClaims[0].statement, request.offerText);
  assert.equal(f.cases[0].savingConsentVersion, 'genieproof-private-save/1');
  assert.equal(f.cases[0].savingConsentAt.toISOString(), now().toISOString());
  assert.equal(f.cases[0].expiresAt.toISOString(), new Date(now().getTime() + GENIEPROOF_RETENTION_DAYS * 86400000).toISOString());
  assert.equal(created.case.expiresAt, f.cases[0].expiresAt);
  assert.equal(f.session.committed, true);
  assert.equal(f.revisions.length, 1);

  await assert.rejects(() => createGenieProofCase({
    userId: userOne,
    ...request,
    submissionHash: 'a'.repeat(64),
    idempotencyKey: 'genieproof-test-2',
    signer: f.signer,
    ...f,
    now,
  }), error => error.code === 'GENIEPROOF_INPUT_CHANGED');
});

test('case creation rejects altered claim text or structured values before signing or persistence', async () => {
  const f = fixture();
  const request = requestFor();
  const alteredText = structuredClone(request);
  alteredText.confirmedClaims[0].statement = 'The current official PPF interest rate is 99% p.a.';
  await assert.rejects(() => createGenieProofCase({
    userId: userOne, ...alteredText, idempotencyKey: 'genieproof-altered-text', signer: f.signer,
    ...f, now,
  }), error => error.code === 'GENIEPROOF_CLAIM_NOT_FROM_SUBMISSION');

  const alteredValue = structuredClone(request);
  alteredValue.confirmedClaims[0].value = 99;
  await assert.rejects(() => createGenieProofCase({
    userId: userOne, ...alteredValue, idempotencyKey: 'genieproof-altered-value', signer: f.signer,
    ...f, now,
  }), error => error.code === 'GENIEPROOF_CLAIM_NOT_FROM_SUBMISSION');
  assert.equal(f.cases.length, 0);
  assert.equal(f.revisions.length, 0);
});

test('case creation requires explicit private-save consent', async () => {
  const f = fixture();
  const request = requestFor();
  await assert.rejects(() => createGenieProofCase({
    userId: userOne,
    ...request,
    savingConsent: false,
    idempotencyKey: 'genieproof-no-consent',
    signer: f.signer,
    ...f,
    now,
  }), error => error.code === 'GENIEPROOF_SAVING_CONSENT_REQUIRED');
  assert.equal(f.cases.length, 0);
  assert.equal(f.revisions.length, 0);
});

test('case creation rejects a truncated extraction before signing or persistence', async () => {
  const f = fixture();
  const request = requestFor(Array(11).fill('The current official PPF interest rate is 7.1% p.a.').join('\n'));
  assert.equal(request.confirmedClaims.length, 10);

  await assert.rejects(() => createGenieProofCase({
    userId: userOne,
    ...request,
    idempotencyKey: 'genieproof-truncated-offer',
    signer: { signManifest() { assert.fail('truncated submissions must not be signed'); } },
    ...f,
    now,
  }), error => error.code === 'GENIEPROOF_EXTRACTION_TRUNCATED');
  assert.equal(f.cases.length, 0);
  assert.equal(f.revisions.length, 0);
  assert.equal(f.session.committed, false);
});

test('same idempotency key replays only the same owner-bound request', async () => {
  const f = fixture();
  const request = requestFor();
  const first = await createGenieProofCase({ userId: userOne, ...request, idempotencyKey: 'genieproof-idem-1', signer: f.signer, ...f, now });
  const replay = await createGenieProofCase({ userId: userOne, ...request, idempotencyKey: 'genieproof-idem-1', signer: f.signer, ...f, now });
  assert.equal(replay.created, false);
  assert.equal(replay.case.caseId, first.case.caseId);
  await assert.rejects(() => createGenieProofCase({
    userId: userOne,
    ...requestFor('The current official PPF interest rate is 7.2% p.a.'),
    idempotencyKey: 'genieproof-idem-1', signer: f.signer, ...f, now,
  }), error => error.code === 'GENIEPROOF_IDEMPOTENCY_CONFLICT');
});

test('passport reads, integrity verification, deletion, and IDOR checks are owner-scoped', async () => {
  const f = fixture();
  const created = await createGenieProofCase({ userId: userOne, ...requestFor(), idempotencyKey: 'genieproof-owner-1', signer: f.signer, ...f, now });
  const hidden = await getGenieProofCase({ userId: userTwo, caseId: created.case.caseId, ...f });
  assert.equal(hidden, null);
  const verification = await verifyGenieProofCase({ userId: userOne, caseId: created.case.caseId, signer: f.signer, ...f });
  assert.equal(verification.integrity, 'VALID');
  assert.equal(verification.signature, 'VERIFIED');
  assert.equal(verification.financialCorrectness, 'NOT_ESTABLISHED_BY_SIGNATURE');
  assert.equal(await deleteGenieProofCase({ userId: userTwo, caseId: created.case.caseId, ...f }), false);
  assert.equal(await deleteGenieProofCase({ userId: userOne, caseId: created.case.caseId, ...f }), true);
  assert.equal(f.cases.length, 0);
  assert.equal(f.revisions.length, 0);
});

test('stored passport with a noncanonical signature is never presented as verified', async () => {
  const f = fixture();
  const created = await createGenieProofCase({ userId: userOne, ...requestFor(), idempotencyKey: 'genieproof-malformed-signature', signer: f.signer, ...f, now });
  f.revisions[0].signature.value += ' ';

  const verification = await verifyGenieProofCase({ userId: userOne, caseId: created.case.caseId, signer: f.signer, ...f });
  assert.equal(verification.integrity, 'INVALID');
  assert.equal(verification.signature, 'UNVERIFIED');
  assert.equal(verification.code, 'PASSPORT_SIGNATURE_MALFORMED');
});

test('stored passport with a canonical invalid signature is not misreported as an untrusted key', async () => {
  const f = fixture();
  const created = await createGenieProofCase({ userId: userOne, ...requestFor(), idempotencyKey: 'genieproof-invalid-signature', signer: f.signer, ...f, now });
  f.revisions[0].signature.value = 'A'.repeat(86);

  const verification = await verifyGenieProofCase({ userId: userOne, caseId: created.case.caseId, signer: f.signer, ...f });
  assert.equal(verification.integrity, 'CONTENT_HASH_MATCHES');
  assert.equal(verification.signature, 'UNVERIFIED');
  assert.equal(verification.trustedIssuer, false);
  assert.equal(verification.code, 'PASSPORT_SIGNATURE_INVALID');
});

test('passport history is owner-scoped and independently checks each immutable revision', async () => {
  const f = fixture();
  const created = await createGenieProofCase({ userId: userOne, ...requestFor(), idempotencyKey: 'genieproof-history-1', signer: f.signer, ...f, now });
  const currentEvidenceStatus = { byClaimId: { example: { status: 'SOURCE_REVOKED' } } };
  const history = await listGenieProofRevisions({
    userId: userOne,
    caseId: created.case.caseId,
    signer: f.signer,
    currentEvidenceStatusResolver: async () => currentEvidenceStatus,
    ...f,
    now,
  });
  assert.equal(history.revisions.length, 1);
  assert.equal(history.revisions[0].revision, 1);
  assert.equal(history.revisions[0].verification.integrity, 'VALID');
  assert.equal(history.revisions[0].verification.financialCorrectness, 'NOT_ESTABLISHED_BY_SIGNATURE');
  assert.deepEqual(history.revisions[0].verification.currentEvidenceStatus, currentEvidenceStatus);
  assert.deepEqual(history.revisions[0].currentEvidenceStatus, currentEvidenceStatus);
  assert.equal(await listGenieProofRevisions({ userId: userTwo, caseId: created.case.caseId, signer: f.signer, ...f, now }), null);

  f.revisions[0].manifest.confirmedClaims[0].value = 99;
  const tampered = await listGenieProofRevisions({ userId: userOne, caseId: created.case.caseId, signer: f.signer, ...f, now });
  assert.equal(tampered.revisions[0].verification.integrity, 'INVALID');
});

test('passport history never presents a noncanonical signature as verified', async () => {
  const f = fixture();
  const created = await createGenieProofCase({ userId: userOne, ...requestFor(), idempotencyKey: 'genieproof-history-malformed-signature', signer: f.signer, ...f, now });
  f.revisions[0].signature.value += ' ';

  const history = await listGenieProofRevisions({ userId: userOne, caseId: created.case.caseId, signer: f.signer, ...f, now });
  assert.equal(history.revisions[0].verification.integrity, 'INVALID');
  assert.equal(history.revisions[0].verification.signature, 'UNVERIFIED');
  assert.equal(history.revisions[0].verification.code, 'PASSPORT_SIGNATURE_MALFORMED');
});

test('passport history fails closed when its latest signed revision disagrees with the stored case head', async () => {
  const f = fixture();
  const created = await createGenieProofCase({ userId: userOne, ...requestFor(), idempotencyKey: 'genieproof-head-check', signer: f.signer, ...f, now });
  f.cases[0].latestManifestHash = 'f'.repeat(64);

  await assert.rejects(
    listGenieProofRevisions({ userId: userOne, caseId: created.case.caseId, signer: f.signer, ...f, now }),
    error => error.status === 503 && error.code === 'GENIEPROOF_CASE_HEAD_MISMATCH',
  );
});

test('bounded passport history does not claim a complete chain without its predecessor', async () => {
  const f = fixture();
  const created = await createGenieProofCase({ userId: userOne, ...requestFor(), idempotencyKey: 'genieproof-prefix-check', signer: f.signer, ...f, now });
  const previous = f.revisions[0];
  const signed = buildGenieProofManifest({
    caseId: created.case.caseId,
    ownerId: userOne,
    submissionHash: previous.manifest.submissionHash,
    confirmedClaims: previous.manifest.confirmedClaims,
    findings: previous.manifest.findings,
    revision: 2,
    previousManifestHash: previous.manifestHash,
    assessedAt: now().toISOString(),
  });
  const passport = f.signer.signManifest(signed.manifest);
  f.revisions.push({
    userId: userOne,
    caseId: created.case.caseId,
    revision: 2,
    manifest: passport.manifest,
    manifestHash: passport.manifestHash,
    signature: passport.signature,
    assessedAt: now(),
    expiresAt: previous.expiresAt,
  });
  f.cases[0].latestRevision = 2;
  f.cases[0].latestManifestHash = passport.manifestHash;

  const history = await listGenieProofRevisions({ userId: userOne, caseId: created.case.caseId, signer: f.signer, limit: 1, ...f, now });
  assert.equal(history.revisions[0].revision, 2);
  assert.equal(history.revisions[0].verification.signature, 'VERIFIED');
  assert.equal(history.revisions[0].verification.integrity, 'CONTENT_HASH_MATCHES');
  assert.equal(history.revisions[0].verification.chainContinuity, 'INCOMPLETE');
  assert.equal(history.revisions[0].verification.code, 'PASSPORT_REVISION_CHAIN_PREFIX_UNVERIFIED');
});

test('case quota is a hard 25-case limit and expired records stop appearing in active reads', async () => {
  const f = fixture();
  const request = requestFor();
  for (let index = 0; index < GENIEPROOF_MAX_CASES_PER_USER; index += 1) {
    await createGenieProofCase({ userId: userOne, ...request, idempotencyKey: `genieproof-quota-${String(index).padStart(2, '0')}`, signer: f.signer, ...f, now });
  }
  assert.equal(new Set(f.cases.map(row => row.quotaSlot)).size, GENIEPROOF_MAX_CASES_PER_USER);
  await assert.rejects(() => createGenieProofCase({
    userId: userOne, ...request, idempotencyKey: 'genieproof-quota-over',
    signer: { signManifest() { assert.fail('quota rejection must happen before signing'); } }, ...f, now,
  }), error => error.code === 'GENIEPROOF_CASE_QUOTA_REACHED' && error.status === 429);
  assert.equal((await listGenieProofCases({ userId: userOne, ...f, now })).length, GENIEPROOF_MAX_CASES_PER_USER);

  const expiredCaseId = f.cases[0].caseId;
  for (const rows of [f.watches, f.jobs, f.events, f.outbox]) {
    rows.push({ userId: userOne, caseId: expiredCaseId });
  }
  const expiredAt = new Date(now().getTime() + GENIEPROOF_RETENTION_DAYS * 86400000 + 1);
  assert.deepEqual(await listGenieProofCases({ userId: userOne, ...f, now: () => expiredAt }), []);
  await createGenieProofCase({
    userId: userOne, ...request, idempotencyKey: 'genieproof-after-expiry', signer: f.signer, ...f, now: () => expiredAt,
  });
  assert.equal(f.cases.length, 1, 'expired cases and their revisions are pruned transactionally before a new save');
  assert.equal(f.revisions.length, 1);
  for (const rows of [f.watches, f.jobs, f.events, f.outbox]) {
    assert.equal(rows.length, 0, 'expired case-scoped ProofBreak records are pruned in the same transaction');
  }
});

test('an exact idempotent retry replays the last quota slot and rejects a changed payload at quota', async () => {
  const f = fixture();
  const request = requestFor();
  const keys = [];
  for (let index = 0; index < GENIEPROOF_MAX_CASES_PER_USER; index += 1) {
    const idempotencyKey = `genieproof-last-slot-${String(index).padStart(2, '0')}`;
    keys.push(idempotencyKey);
    await createGenieProofCase({ userId: userOne, ...request, idempotencyKey, signer: f.signer, ...f, now });
  }

  const firstCase = f.cases.find(row => row.idempotencyKeyHash);
  const replay = await createGenieProofCase({ userId: userOne, ...request, idempotencyKey: keys[0], signer: f.signer, ...f, now });
  assert.equal(replay.created, false);
  assert.equal(replay.case.caseId, firstCase.caseId);
  await assert.rejects(() => createGenieProofCase({
    userId: userOne,
    ...requestFor('The current official PPF interest rate is 7.2% p.a.'),
    idempotencyKey: keys[0],
    signer: f.signer,
    ...f,
    now,
  }), error => error.code === 'GENIEPROOF_IDEMPOTENCY_CONFLICT' && error.status === 409);
});

test('untrusted signer reports a matching content hash without claiming verified integrity', async () => {
  const f = fixture();
  const created = await createGenieProofCase({ userId: userOne, ...requestFor(), idempotencyKey: 'genieproof-unknown-key', signer: f.signer, ...f, now });
  const otherPair = crypto.generateKeyPairSync('ed25519');
  const otherSigner = new GenieProofPassportSigner({
    privateKeyPem: otherPair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem: otherPair.publicKey.export({ type: 'spki', format: 'pem' }),
    keyId: 'untrusted-key',
  });
  const verification = await verifyGenieProofCase({ userId: userOne, caseId: created.case.caseId, ...f, signer: otherSigner });
  assert.equal(verification.integrity, 'CONTENT_HASH_MATCHES');
  assert.equal(verification.signature, 'UNVERIFIED');
  assert.equal(verification.trustedIssuer, false);
});

test('passport verification detects divergence between signed claims and mutable case metadata', async () => {
  const f = fixture();
  const created = await createGenieProofCase({ userId: userOne, ...requestFor(), idempotencyKey: 'genieproof-case-binding', signer: f.signer, ...f, now });
  f.cases[0].confirmedClaims[0].value = 99;
  const verification = await verifyGenieProofCase({ userId: userOne, caseId: created.case.caseId, ...f });
  assert.equal(verification.integrity, 'INVALID');
  assert.equal(verification.code, 'PASSPORT_CASE_BINDING_MISMATCH');
});

test('reassessment appends a signed revision, binds the prior head, and replays idempotently', async () => {
  const f = fixture();
  const created = await createGenieProofCase({
    userId: userOne, ...requestFor(), idempotencyKey: 'genieproof-reassess-create', signer: f.signer, ...f, now,
  });
  const original = structuredClone(f.revisions[0]);
  const request = {
    userId: userOne,
    caseId: created.case.caseId,
    expectedRevision: 1,
    expectedManifestHash: created.passport.manifestHash,
    reassessmentConsent: true,
    idempotencyKey: 'genieproof-reassess-one',
    signer: f.signer,
    ...f,
    now,
  };
  const reassessed = await reassessGenieProofCase(request);
  assert.equal(reassessed.created, true);
  assert.equal(reassessed.revision, 2);
  assert.equal(reassessed.passport.manifest.previousManifestHash, original.manifestHash);
  assert.equal(f.cases[0].latestRevision, 2);
  assert.equal(f.revisions.length, 2);
  assert.deepEqual(f.revisions[0], original, 'the earlier assessment remains unchanged');

  const replay = await reassessGenieProofCase(request);
  assert.equal(replay.created, false);
  assert.equal(replay.revision, 2);
  assert.equal(replay.manifestHash, reassessed.manifestHash);
  assert.equal(f.revisions.length, 2);
  await assert.rejects(reassessGenieProofCase({ ...request, expectedRevision: 2 }), error => (
    error.code === 'GENIEPROOF_IDEMPOTENCY_CONFLICT' && error.status === 409
  ));
  await assert.rejects(reassessGenieProofCase({ ...request, idempotencyKey: 'genieproof-reassess-stale' }), error => (
    error.code === 'GENIEPROOF_STALE_CASE_HEAD' && error.status === 409
  ));
});

test('reassessment refuses a previous revision whose signed manifest was altered', async () => {
  const f = fixture();
  const created = await createGenieProofCase({
    userId: userOne, ...requestFor(), idempotencyKey: 'genieproof-invalid-parent-create', signer: f.signer, ...f, now,
  });
  f.revisions[0].manifest.findings[0].finding = 'SUPPORTED';

  await assert.rejects(reassessGenieProofCase({
    userId: userOne,
    caseId: created.case.caseId,
    expectedRevision: 1,
    expectedManifestHash: created.passport.manifestHash,
    reassessmentConsent: true,
    idempotencyKey: 'genieproof-invalid-parent-reassess',
    signer: f.signer,
    ...f,
    now,
  }), error => error.code === 'GENIEPROOF_CASE_HEAD_MISMATCH' && error.status === 503);
  assert.equal(f.revisions.length, 1);
  assert.equal(f.cases[0].latestRevision, 1);
});

test('consent withdrawal prevents a later reassessment and is idempotent', async () => {
  const f = fixture();
  const created = await createGenieProofCase({
    userId: userOne, ...requestFor(), idempotencyKey: 'genieproof-consent-create', signer: f.signer, ...f, now,
  });
  assert.equal(await withdrawGenieProofConsent({ userId: userOne, caseId: created.case.caseId, ...f, now }), true);
  assert.equal(await withdrawGenieProofConsent({ userId: userOne, caseId: created.case.caseId, ...f, now }), true);
  await assert.rejects(reassessGenieProofCase({
    userId: userOne,
    caseId: created.case.caseId,
    expectedRevision: 1,
    expectedManifestHash: created.passport.manifestHash,
    reassessmentConsent: true,
    idempotencyKey: 'genieproof-consent-reassess',
    signer: f.signer,
    ...f,
    now,
  }), error => error.code === 'GENIEPROOF_CONSENT_WITHDRAWN' && error.status === 403);
  assert.equal(f.revisions.length, 1);
  assert.equal(f.cases[0].latestRevision, 1);
});

test('create API schema rejects extra keys and unsupported products', () => {
  const request = requestFor();
  assert.equal(genieProofCreateCaseSchema.validate(request).error, undefined);
  assert.ok(genieProofCreateCaseSchema.validate({ ...request, savingConsent: false }).error);
  const withoutConsent = { ...request };
  delete withoutConsent.savingConsent;
  assert.ok(genieProofCreateCaseSchema.validate(withoutConsent).error);
  assert.ok(genieProofCreateCaseSchema.validate({ ...request, userId: userOne }).error);
  assert.ok(genieProofCreateCaseSchema.validate({
    ...request,
    confirmedClaims: request.confirmedClaims.map(claim => ({ ...claim, productId: 'government:india-post:nsc' })),
  }).error);
});
