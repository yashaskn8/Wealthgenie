import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { GENIEPROOF_SOURCE_CATALOG_CANDIDATES } from '../agents/genieProof/genieProofSourceCatalog.js';
import {
  assertUnambiguousGenieProofIndiaPostBundle,
  computeGenieProofSourceDefinitionHash,
  refreshGenieProofIndiaPostPpfEvidence,
  resolveGenieProofEvidenceForClaims,
  validateGenieProofSourceDefinition,
} from '../agents/genieProof/genieProofEvidenceRegistryService.js';
import { INDIA_POST_SAVINGS_URL } from '../services/marketData/GovernmentSmallSavingsProvider.js';
import { GENIEPROOF_SUPPORTED_PRODUCT_ID } from '../agents/genieProof/genieProofCore.js';

function sourceModelFor(source) {
  return {
    findOne() {
      return {
        sort() { return this; },
        async lean() { return source; },
      };
    },
  };
}

test('persisted source catalog candidate is content-bound and blocked from user evidence reuse', async () => {
  const [candidate] = GENIEPROOF_SOURCE_CATALOG_CANDIDATES;
  assert.equal(candidate.definitionHash, computeGenieProofSourceDefinitionHash(candidate));
  assert.equal(candidate.qualificationStatus, 'BLOCKED_REUSE_RIGHTS');
  assert.equal(candidate.reusePermissionStatus, 'BLOCKED');
  let fetchCalls = 0;
  await assert.rejects(refreshGenieProofIndiaPostPpfEvidence({
    signer: { signManifest() { assert.fail('blocked source must not be signed'); } },
    sourceModel: sourceModelFor(candidate),
    fetcher: { async fetchDocument() { fetchCalls += 1; throw new Error('network should not run'); } },
  }), error => error.code === 'GENIEPROOF_SOURCE_REUSE_NOT_APPROVED' && error.status === 403);
  assert.equal(fetchCalls, 0, 'the legal/source-rights gate runs before outbound requests');
});

test('revoked source approval is rejected before any retrieval or signing', async () => {
  const [candidate] = GENIEPROOF_SOURCE_CATALOG_CANDIDATES;
  const revoked = {
    ...candidate,
    qualificationStatus: 'QUALIFIED_FOR_USER_PRESENTATION',
    reusePermissionStatus: 'APPROVED',
    reviewRecord: { reviewedAt: new Date('2026-01-01T00:00:00.000Z'), reference: 'TEST_ONLY_SYNTHETIC_FIXTURE', scope: 'TESTS_ONLY' },
    revocationReasonCode: 'SOURCE_APPROVAL_WITHDRAWN',
  };
  revoked.definitionHash = computeGenieProofSourceDefinitionHash(revoked);
  let fetchCalls = 0;
  assert.throws(() => validateGenieProofSourceDefinition(revoked), error => error.code === 'GENIEPROOF_SOURCE_REVOKED');
  await assert.rejects(refreshGenieProofIndiaPostPpfEvidence({
    signer: { signManifest() { assert.fail('revoked sources must not be signed'); } },
    sourceModel: sourceModelFor(revoked),
    fetcher: { async fetchDocument() { fetchCalls += 1; throw new Error('network should not run'); } },
  }), error => error.code === 'GENIEPROOF_SOURCE_REVOKED');
  assert.equal(fetchCalls, 0, 'revocation is enforced by the shared source gate before outbound requests');
});

test('a forged official-looking host is rejected before DNS or HTTP activity', async () => {
  const [candidate] = GENIEPROOF_SOURCE_CATALOG_CANDIDATES;
  const forged = { ...candidate, endpoint: 'https://www.indiapost.gov.in.attacker.example/banking-services/savings' };
  forged.definitionHash = computeGenieProofSourceDefinitionHash(forged);
  let fetchCalls = 0;
  await assert.rejects(refreshGenieProofIndiaPostPpfEvidence({
    signer: { signManifest() { assert.fail('forged source must not be signed'); } },
    sourceModel: sourceModelFor(forged),
    fetcher: { async fetchDocument() { fetchCalls += 1; } },
  }), error => error.code === 'GENIEPROOF_SOURCE_NOT_ALLOWLISTED');
  assert.equal(fetchCalls, 0);
});

test('India Post marker counts do not establish a qualified record association', () => {
  const interval = 'Post Office Small Savings Schemes (w.e.f 01.10.2026 to 31.12.2026)';
  const table = `JSON.parse('[{"slNo":"10.","instrument":"Public Provident Fund Scheme","interestRate":"7.1%"}]')`;
  assert.throws(() => assertUnambiguousGenieProofIndiaPostBundle(`${interval};${table}`), error => error.code === 'GENIEPROOF_SOURCE_SCHEMA_REJECTED');
  assert.throws(() => assertUnambiguousGenieProofIndiaPostBundle(`${interval};${interval};${table}`), error => error.code === 'GENIEPROOF_SOURCE_SCHEMA_REJECTED');
  assert.throws(() => assertUnambiguousGenieProofIndiaPostBundle(`${interval};${table};${table}`), error => error.code === 'GENIEPROOF_SOURCE_SCHEMA_REJECTED');
});

test('GenieProof rejects non-quarter and overlong source effective periods', () => {
  const table = `JSON.parse('[{"slNo":"10.","instrument":"Public Provident Fund Scheme","interestRate":"7.1%"}]')`;
  for (const interval of [
    'Post Office Small Savings Schemes (w.e.f 15.10.2026 to 31.12.2026)',
    'Post Office Small Savings Schemes (w.e.f 01.10.2026 to 30.11.2026)',
    'Post Office Small Savings Schemes (w.e.f 01.10.2026 to 31.12.2027)',
  ]) {
    assert.throws(() => assertUnambiguousGenieProofIndiaPostBundle(`${interval};${table}`), error => error.code === 'GENIEPROOF_SOURCE_SCHEMA_REJECTED');
  }
  assert.throws(() => assertUnambiguousGenieProofIndiaPostBundle(
    'Post Office Small Savings Schemes (w.e.f 01.10.2026 to 31.12.2026);'
      + table,
  ), error => error.code === 'GENIEPROOF_SOURCE_SCHEMA_REJECTED');
});

test('injected synthetic fact exercises append-only receipts and persistence independently of provider qualification', async () => {
  const candidate = GENIEPROOF_SOURCE_CATALOG_CANDIDATES[1];
  const source = {
    ...candidate,
    qualificationStatus: 'QUALIFIED_FOR_USER_PRESENTATION',
    reusePermissionStatus: 'APPROVED',
    reviewRecord: { reviewedAt: new Date('2026-01-01T00:00:00.000Z'), reference: 'TEST_ONLY_SYNTHETIC_FIXTURE', scope: 'TESTS_ONLY' },
  };
  source.definitionHash = computeGenieProofSourceDefinitionHash(source);
  const receipts = [];
  const evidenceRows = [];
  const sourceRows = [source];
  const sourceModel = {
    findOne() { return { sort() { return this; }, session() { return this; }, lean: async () => source }; },
    find() { return { sort() { return this; }, session() { return this; }, lean: async () => [...sourceRows].sort((a, b) => b.revision - a.revision) }; },
  };
  const receiptModel = {
    async create(rows) { receipts.push(...structuredClone(rows)); return rows; },
    find(filter) { return { session() { return this; }, lean: async () => receipts.filter(item => filter.retrievalId.$in.includes(item.retrievalId)) }; },
  };
  const evidenceModel = {
    findOne(filter) {
      return {
        sort() { return this; },
        session() { return this; },
        lean: async () => [...evidenceRows]
          .filter(row => Object.entries(filter || {}).every(([key, value]) => row[key] === value))
          .sort((a, b) => b.revision - a.revision)[0] || null,
      };
    },
    async create([row]) { const saved = { ...row, toObject() { return { ...this }; } }; evidenceRows.push(saved); return [saved]; },
    find() { return { sort() { return this; }, limit() { return this; }, session() { return this; }, lean: async () => [...evidenceRows].sort((a, b) => b.revision - a.revision) }; },
  };
  const session = { startTransaction() {}, inTransaction() { return true; }, async commitTransaction() {}, async abortTransaction() {}, async endSession() {} };
  let registryFenceAdvances = 0;
  const stateModel = { async updateOne() { registryFenceAdvances += 1; return { modifiedCount: 1 }; } };
  const rows = [
    { slNo: '01.', instrument: 'Post Office Savings Account', interestRate: '4.0%', compoundingFrequency: 'Annually' },
    { slNo: '02.', instrument: '1 Year Time Deposit', interestRate: '6.9%', compoundingFrequency: 'Quarterly' },
    { slNo: '03.', instrument: '2 Year Time Deposit', interestRate: '7.0%', compoundingFrequency: 'Quarterly' },
    { slNo: '04.', instrument: '3 Year Time Deposit', interestRate: '7.1%', compoundingFrequency: 'Quarterly' },
    { slNo: '05.', instrument: '5 Year Time Deposit', interestRate: '7.5%', compoundingFrequency: 'Quarterly' },
    { slNo: '06.', instrument: '5 Year Recurring Deposit Scheme', interestRate: '6.7%', compoundingFrequency: 'Quarterly' },
    { slNo: '07.', instrument: 'Senior Citizen Savings Scheme', interestRate: '8.2%', compoundingFrequency: 'Quarterly and Paid' },
    { slNo: '08.', instrument: 'Monthly Income Account', interestRate: '7.4%', compoundingFrequency: 'Monthly and paid' },
    { slNo: '09.', instrument: 'National Savings Certificate (VIII Issue)', interestRate: '7.7%', compoundingFrequency: 'Annually' },
    { slNo: '10.', instrument: 'Public Provident Fund Scheme', interestRate: '6.25%', compoundingFrequency: 'Annually' },
    { slNo: '11.', instrument: 'Kisan Vikas Patra', interestRate: '7.5%', compoundingFrequency: 'Annually' },
    { slNo: '13.', instrument: 'Sukanya Samriddhi Account Scheme', interestRate: '8.2%', compoundingFrequency: 'Annually' },
  ];
  const bundle = `const w=JSON.parse('${JSON.stringify(rows)}'),S()=>"Post Office Small Savings Schemes (w.e.f 01.10.2026 to 31.12.2026)";`;
  const page = '<html><script src="/_next/static/chunks/main.js"></script></html>';
  const pageHash = crypto.createHash('sha256').update(page).digest('hex');
  const bundleHash = crypto.createHash('sha256').update(bundle).digest('hex');
  const fetcher = {
    async fetchDocument(url) {
      if (url === INDIA_POST_SAVINGS_URL) return { requestedUrl: url, url, statusCode: 200, redirectCount: 0, contentType: 'text/html', body: page, rawBodySha256: pageHash, retrievedAt: '2026-10-11T12:00:00.000Z' };
      assert.equal(url, 'https://www.indiapost.gov.in/_next/static/chunks/main.js');
      return { requestedUrl: url, url, statusCode: 200, redirectCount: 0, contentType: 'application/javascript', body: bundle, rawBodySha256: bundleHash, retrievedAt: '2026-10-11T12:00:00.000Z' };
    },
  };
  const signer = { signManifest(manifest) { return { manifest, manifestHash: '3'.repeat(64), signature: { testOnly: true } }; } };
  // This hand-authored test dependency is intentionally not a provider parser
  // or proof that the loose synthetic source bytes establish a financial fact.
  const parseSourceBundle = () => ({ facts: [{
    canonicalProductId: GENIEPROOF_SUPPORTED_PRODUCT_ID,
    value: 6.25,
    unit: 'PERCENT_PER_ANNUM',
    availabilityStatus: 'AVAILABLE',
    effectiveFrom: '2026-10-01',
    effectiveTo: '2026-12-31',
  }] });
  const refreshed = await refreshGenieProofIndiaPostPpfEvidence({
    signer, sourceModel, stateModel, receiptModel, evidenceModel, fetcher, parseSourceBundle, startSession: async () => session,
    now: () => new Date('2026-10-11T12:00:00.000Z'),
  });
  assert.equal(refreshed.created, true);
  assert.equal(registryFenceAdvances, 1, 'evidence refresh shares the source-registry transaction fence');
  assert.equal(receipts.length, 2);
  assert.equal(evidenceRows[0].fact.value, 6.25);
  assert.equal(evidenceRows[0].fact.productId, GENIEPROOF_SUPPORTED_PRODUCT_ID);
  assert.equal(evidenceRows[0].sourceContentCommitment, bundleHash);
  assert.equal(evidenceRows[0].sourceQualificationAtAssessment, 'QUALIFIED_FOR_USER_PRESENTATION');
  const repeatedFetch = await refreshGenieProofIndiaPostPpfEvidence({
    signer, sourceModel, stateModel, receiptModel, evidenceModel, fetcher, parseSourceBundle, startSession: async () => session,
    now: () => new Date('2026-10-11T12:00:00.000Z'),
  });
  assert.equal(repeatedFetch.created, false);
  assert.equal(registryFenceAdvances, 2);
  assert.equal(evidenceRows.length, 1, 'unchanged bytes reuse the immutable evidence revision');
  assert.equal(receipts.length, 4, 'each successful recheck keeps its own persisted retrieval receipts');
  assert.equal(repeatedFetch.retrievalIds.length, 2);
  const claim = { claimId: 'a'.repeat(32), productId: GENIEPROOF_SUPPORTED_PRODUCT_ID, claimType: 'CURRENT_NOMINAL_RATE' };
  const resolved = await resolveGenieProofEvidenceForClaims({ claims: [claim], sourceModel, receiptModel, evidenceModel, now: () => new Date('2026-10-11T12:00:00.000Z') });
  assert.equal(resolved.byClaimId[claim.claimId].length, 1);
  assert.equal(resolved.byClaimId[claim.claimId][0].factHash, evidenceRows[0].factHash);
  const narrowedSource = { ...source, revision: source.revision + 1, productIds: [], claimTypes: [] };
  narrowedSource.definitionHash = computeGenieProofSourceDefinitionHash(narrowedSource);
  sourceRows.push(narrowedSource);
  const afterSourceNarrowing = await resolveGenieProofEvidenceForClaims({ claims: [claim], sourceModel, receiptModel, evidenceModel, now: () => new Date('2026-10-11T12:00:00.000Z') });
  assert.equal(afterSourceNarrowing.byClaimId[claim.claimId].length, 0, 'a newer source definition that narrows claim scope supersedes the older approval');
  sourceRows.pop();
  evidenceRows.push({ ...evidenceRows[0], revision: 2, revocationStatus: 'REVOKED' });
  const afterEvidenceRevocation = await resolveGenieProofEvidenceForClaims({ claims: [claim], sourceModel, receiptModel, evidenceModel, now: () => new Date('2026-10-11T12:00:00.000Z') });
  assert.equal(afterEvidenceRevocation.byClaimId[claim.claimId].length, 0, 'a revoked latest evidence revision cannot fall back to an older active revision');
  evidenceRows.pop();
  const oldParserSource = { ...source, parserVersion: 'india-post-small-savings/qualified-identities-2' };
  oldParserSource.definitionHash = computeGenieProofSourceDefinitionHash(oldParserSource);
  sourceRows[0] = oldParserSource;
  evidenceRows[0] = {
    ...evidenceRows[0],
    parserVersion: oldParserSource.parserVersion,
    sourceDefinitionHash: oldParserSource.definitionHash,
  };
  const afterParserSuperseded = await resolveGenieProofEvidenceForClaims({ claims: [claim], sourceModel, receiptModel, evidenceModel, now: () => new Date('2026-10-11T12:00:00.000Z') });
  assert.equal(afterParserSuperseded.byClaimId[claim.claimId].length, 0, 'cached evidence from the loose source association parser cannot authorize a new current finding');
  assert.notEqual(source.qualificationStatus, candidate.qualificationStatus, 'the test-only qualification exists only in memory');
});
