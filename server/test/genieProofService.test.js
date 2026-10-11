import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { extractGenieProofClaims, GENIEPROOF_SUPPORTED_PRODUCT_ID } from '../agents/genieProof/genieProofCore.js';
import { GenieProofPassportSigner } from '../agents/genieProof/genieProofPassportSignature.js';
import { createGenieProofCase, deleteGenieProofCase, getGenieProofCase, verifyGenieProofCase } from '../agents/genieProof/genieProofService.js';
import { genieProofCreateCaseSchema } from '../agents/genieProof/genieProofSchemas.js';

const userOne = '65b000000000000000000001';
const userTwo = '65b000000000000000000002';
const now = () => new Date('2026-10-11T08:00:00.000Z');

function fixture() {
  const cases = [];
  const revisions = [];
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
  const matches = (row, filter) => Object.entries(filter).every(([key, value]) => String(row[key] ?? '') === String(value ?? ''));
  const leanQuery = value => ({ lean: async () => value });
  const caseModel = {
    async create([input]) {
      if (cases.some(row => row.userId === input.userId && row.idempotencyKeyHash === input.idempotencyKeyHash)) {
        throw Object.assign(new Error('duplicate'), { code: 11000 });
      }
      const row = { ...structuredClone(input), createdAt: now() };
      cases.push(row);
      return [row];
    },
    findOne(filter) { return leanQuery(cases.find(row => matches(row, filter)) || null); },
    find(filter) {
      let result = cases.filter(row => matches(row, filter));
      const query = {
        sort() { return query; },
        limit(value) { result = result.slice(0, value); return query; },
        lean: async () => result,
      };
      return query;
    },
    async findOneAndDelete(filter) {
      const index = cases.findIndex(row => matches(row, filter));
      if (index < 0) return null;
      return cases.splice(index, 1)[0];
    },
  };
  const revisionModel = {
    async create([input]) { const row = structuredClone(input); revisions.push(row); return [row]; },
    findOne(filter) { return leanQuery(revisions.find(row => matches(row, filter)) || null); },
    async deleteMany(filter) {
      const before = revisions.length;
      for (let i = revisions.length - 1; i >= 0; i -= 1) if (matches(revisions[i], filter)) revisions.splice(i, 1);
      return { deletedCount: before - revisions.length };
    },
  };
  const pair = crypto.generateKeyPairSync('ed25519');
  const signer = new GenieProofPassportSigner({
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
    keyId: 'test-local-key',
  });
  return { cases, revisions, session, caseModel, revisionModel, signer, startSession: async () => session };
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
