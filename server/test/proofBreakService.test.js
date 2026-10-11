import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createProofWatch, getProofWatchAvailability, listProofBreakEvents, listProofWatches, updateProofWatchStatus, acknowledgeProofBreakEvent } from '../agents/genieProof/proofBreakService.js';
import { computeGenieProofSourceDefinitionHash } from '../agents/genieProof/genieProofEvidenceRegistryService.js';
import { GENIEPROOF_SOURCE_CATALOG_CANDIDATES } from '../agents/genieProof/genieProofSourceCatalog.js';
import { withdrawGenieProofConsent } from '../agents/genieProof/genieProofService.js';

const owner = '65b000000000000000000001';
const otherOwner = '65b000000000000000000002';
const timestamp = new Date('2026-10-11T12:00:00.000Z');
const caseId = '00000000-0000-4000-8000-000000000001';
const claimId = 'a'.repeat(32);

function query(value) {
  return { session() { return this; }, sort() { return this; }, limit() { return this; }, select() { return this; }, lean: async () => value };
}

function fixture() {
  const cases = [{
    userId: owner,
    caseId,
    submissionHash: 'b'.repeat(64),
    confirmedClaims: [{ claimId, statement: 'The current official PPF interest rate is 7.1% p.a.', claimType: 'CURRENT_NOMINAL_RATE', productId: 'government:india-post:ppf', value: 7.1, unit: 'PERCENT_PER_ANNUM' }],
    consentWithdrawnAt: null,
    latestRevision: 1,
    latestManifestHash: 'c'.repeat(64),
    expiresAt: new Date(timestamp.getTime() + 86400000),
    deletedAt: null,
  }];
  const watches = [];
  const jobs = [];
  const events = [];
  const outbox = [];
  const sessions = [];
  const startSession = async () => {
    const session = { active: false, startTransaction() { this.active = true; }, async commitTransaction() { this.active = false; }, async abortTransaction() { this.active = false; }, inTransaction() { return this.active; }, async endSession() {} };
    sessions.push(session);
    return session;
  };
  const caseModel = {
    findOne(filter) { return query(cases.find(row => row.userId === filter.userId && row.caseId === filter.caseId && !row.deletedAt && row.expiresAt > timestamp) || null); },
    async updateOne(filter, update) { const row = cases.find(item => item.userId === filter.userId && item.caseId === filter.caseId && item.consentWithdrawnAt === null); if (!row) return { modifiedCount: 0 }; Object.assign(row, structuredClone(update.$set)); for (const [key, value] of Object.entries(update.$inc || {})) row[key] = (row[key] || 0) + value; return { modifiedCount: 1 }; },
    findOneAndDelete() { return query(null); },
  };
  const source = {
    sourceId: 'india-post-small-savings', revision: 1, productIds: ['government:india-post:ppf'], claimTypes: ['CURRENT_NOMINAL_RATE'],
    qualificationStatus: 'BLOCKED_REUSE_RIGHTS', reusePermissionStatus: 'BLOCKED', reviewRecord: { reviewedAt: null, reference: null, scope: null },
    parserVersion: 'india-post-small-savings/qualified-identities-2', ruleVersion: 'genieproof-current-nominal-rate/0.1.0',
    definitionHash: 'd'.repeat(64), revocationReasonCode: null,
  };
  const sourceModel = { find() { return { sort() { return this; }, session() { return this; }, lean: async () => [source] }; } };
  const watchModel = {
    async create([input]) {
      if (watches.some(item => item.userId === input.userId && item.creationKeyHash === input.creationKeyHash)) throw Object.assign(new Error('duplicate'), { code: 11000 });
      if (watches.some(item => item.userId === input.userId && item.caseId === input.caseId && !['CANCELLED', 'EXPIRED'].includes(item.status))) throw Object.assign(new Error('duplicate'), { code: 11000 });
      const saved = { ...structuredClone(input), _id: new mongooseId(), createdAt: timestamp };
      watches.push(saved);
      return [saved];
    },
    findOne(filter) { return query(watches.find(item => Object.entries(filter).every(([key, value]) => (
      key === 'status' && value?.$nin ? !value.$nin.includes(item[key]) : item[key] === value
    ))) || null); },
    find(filter) {
      let rows = watches.filter(item => Object.entries(filter).every(([key, value]) => item[key] === value));
      return { sort() { return this; }, limit(n) { rows = rows.slice(0, n); return this; }, lean: async () => rows };
    },
    findOneAndUpdate(filter, update) {
      const item = watches.find(row => Object.entries(filter).every(([key, value]) => row[key] === value));
      if (!item) return query(null);
      Object.assign(item, structuredClone(update.$set || {}));
      for (const [key, value] of Object.entries(update.$inc || {})) item[key] = (item[key] || 0) + value;
      return query(item);
    },
    async deleteMany(filter) { const count = watches.filter(row => row.userId === filter.userId && row.caseId === filter.caseId).length; for (let i = watches.length - 1; i >= 0; i -= 1) if (watches[i].userId === filter.userId && watches[i].caseId === filter.caseId) watches.splice(i, 1); return { deletedCount: count }; },
    async updateMany(filter, update) { let modifiedCount = 0; for (const item of watches) if (item.userId === filter.userId && item.caseId === filter.caseId && filter.status.$in.includes(item.status)) { Object.assign(item, structuredClone(update.$set)); for (const [key, value] of Object.entries(update.$inc || {})) item[key] = (item[key] || 0) + value; modifiedCount += 1; } return { modifiedCount }; },
    async findOneAndDelete(filter) { const index = watches.findIndex(row => row.userId === filter.userId && row.watchId === filter.watchId); return index < 0 ? null : watches.splice(index, 1)[0]; },
  };
  const jobModel = {
    async create([input]) { const row = { ...structuredClone(input), _id: new mongooseId() }; jobs.push(row); return [row]; },
    async updateMany(filter, update) { for (const row of jobs) if ((filter.watchId === undefined || row.watchId === filter.watchId) && row.userId === filter.userId && row.caseId === filter.caseId && filter.status.$in.includes(row.status)) Object.assign(row, structuredClone(update.$set)); return { modifiedCount: 1 }; },
    async deleteMany(filter) { for (let i = jobs.length - 1; i >= 0; i -= 1) if (jobs[i].userId === filter.userId && jobs[i].watchId === filter.watchId) jobs.splice(i, 1); return { deletedCount: 0 }; },
  };
  const eventModel = {
    find(filter) {
      let rows = events.filter(item => item.userId === filter.userId && item.caseId === filter.caseId
        && (!filter.$or || filter.$or.some(condition => (
          condition.publishedAt?.$lt ? item.publishedAt < condition.publishedAt.$lt
            : item.publishedAt.getTime() === condition.publishedAt?.getTime()
              && item._id < String(condition._id?.$lt)
        ))));
      return { sort() { rows = [...rows].sort((a, b) => b.publishedAt - a.publishedAt || String(b._id).localeCompare(String(a._id))); return this; }, limit(n) { rows = rows.slice(0, n); return this; }, lean: async () => rows };
    },
    findOneAndUpdate(filter, update) { const item = events.find(row => row.userId === filter.userId && row.eventId === filter.eventId && row.acknowledgedAt === null); if (item) Object.assign(item, update.$set); return query(item || null); },
    async exists(filter) { return events.some(row => row.userId === filter.userId && row.eventId === filter.eventId); },
    async deleteMany(filter) { for (let i = events.length - 1; i >= 0; i -= 1) if (events[i].userId === filter.userId && events[i].watchId === filter.watchId) events.splice(i, 1); return { deletedCount: 0 }; },
    async updateMany(filter, update) { let modifiedCount = 0; for (const item of events) if (item.userId === filter.userId && item.caseId === filter.caseId && item.notificationStatus === filter.notificationStatus) { Object.assign(item, structuredClone(update.$set)); modifiedCount += 1; } return { modifiedCount }; },
  };
  const outboxModel = {
    async deleteMany(filter) { for (let i = outbox.length - 1; i >= 0; i -= 1) if (outbox[i].userId === filter.userId && outbox[i].watchId === filter.watchId) outbox.splice(i, 1); return { deletedCount: 0 }; },
    async updateMany(filter, update) { let modifiedCount = 0; for (const item of outbox) if (item.userId === filter.userId && item.caseId === filter.caseId && filter.status.$in.includes(item.status)) { Object.assign(item, structuredClone(update.$set)); modifiedCount += 1; } return { modifiedCount }; },
  };
  const workerHeartbeatModel = { async exists() { return false; } };
  return { cases, watches, jobs, events, outbox, sessions, caseModel, sourceModel, watchModel, jobModel, eventModel, outboxModel, workerHeartbeatModel, startSession };
}

function mongooseId() { return crypto.randomBytes(12).toString('hex'); }

test('watch creation records separate consent and stays blocked without approved source rights', async () => {
  const f = fixture();
  const created = await createProofWatch({
    userId: owner, caseId, watchConsent: true, idempotencyKey: 'proof-watch-create-1',
    ...f, now: () => timestamp,
  });
  assert.equal(created.created, true);
  assert.equal(created.watch.status, 'BLOCKED_SOURCE_RIGHTS');
  assert.equal(created.watch.sourceAvailability, 'RIGHTS_BLOCKED');
  assert.equal(created.watch.nextCheckAt, null);
  assert.deepEqual(f.jobs, [], 'blocked sources never become scheduled monitoring');
  assert.equal(created.watch.requestedClaimIds[0], claimId);
  const replay = await createProofWatch({
    userId: owner, caseId, watchConsent: true, idempotencyKey: 'proof-watch-create-1',
    ...f, now: () => timestamp,
  });
  assert.equal(replay.created, false);
  assert.equal(replay.watch.watchId, created.watch.watchId);
});

test('watch creation rejects missing consent, cross-owner cases, and duplicate active watches', async () => {
  const f = fixture();
  await assert.rejects(createProofWatch({ userId: owner, caseId, watchConsent: false, idempotencyKey: 'proof-watch-no-consent', ...f, now: () => timestamp }), error => error.code === 'PROOFBREAK_CONSENT_REQUIRED');
  await assert.rejects(createProofWatch({ userId: otherOwner, caseId, watchConsent: true, idempotencyKey: 'proof-watch-other-owner', ...f, now: () => timestamp }), error => error.code === 'GENIEPROOF_CASE_NOT_FOUND');
  await createProofWatch({ userId: owner, caseId, watchConsent: true, idempotencyKey: 'proof-watch-once-1', ...f, now: () => timestamp });
  await assert.rejects(createProofWatch({ userId: owner, caseId, watchConsent: true, idempotencyKey: 'proof-watch-once-2', ...f, now: () => timestamp }), error => error.code === 'PROOFBREAK_WATCH_ALREADY_EXISTS');
});

test('availability explains blocked and unsupported claims without implying that monitoring is active', async () => {
  const f = fixture();
  f.cases[0].confirmedClaims.push({ claimId: 'f'.repeat(32), statement: 'Guaranteed return', claimType: 'UNSUPPORTED', productId: null, value: null, unit: 'UNKNOWN' });
  const availability = await getProofWatchAvailability({ userId: owner, caseId, ...f, now: () => timestamp });
  assert.equal(availability.canEnable, false);
  assert.equal(availability.workerStatus, 'UNAVAILABLE');
  assert.equal(availability.sourceStatus, 'RIGHTS_BLOCKED');
  assert.deepEqual(availability.claims.map(item => item.status), ['SOURCE_RIGHTS_BLOCKED', 'NOT_SUPPORTED']);
});

test('eligible source cannot create a watch from a liveness-only or degraded worker heartbeat', async () => {
  const f = fixture();
  const permitted = {
    ...GENIEPROOF_SOURCE_CATALOG_CANDIDATES[0],
    qualificationStatus: 'QUALIFIED_FOR_USER_PRESENTATION',
    reusePermissionStatus: 'APPROVED',
    reviewRecord: { reviewedAt: timestamp, reference: 'TEST_ONLY', scope: 'TESTS_ONLY' },
  };
  permitted.definitionHash = computeGenieProofSourceDefinitionHash(permitted);
  f.sourceModel.find = () => ({ sort() { return this; }, session() { return this; }, lean: async () => [permitted] });
  let readinessFilter;
  f.workerHeartbeatModel.findOne = filter => { readinessFilter = filter; return query(null); };
  await assert.rejects(createProofWatch({
    userId: owner, caseId, watchConsent: true, idempotencyKey: 'proof-watch-no-worker', ...f, now: () => timestamp,
  }), error => error.code === 'PROOFBREAK_WORKER_UNAVAILABLE' && error.status === 503);
  assert.equal(f.watches.length, 0);
  assert.deepEqual(readinessFilter.lastSuccessfulPollAt, { $ne: null });
  assert.equal(readinessFilter.lastPollErrorCode, null);
});

test('availability and watch creation reject an approved source that the fetch gate would reject', async () => {
  const f = fixture();
  const misconfigured = {
    ...GENIEPROOF_SOURCE_CATALOG_CANDIDATES[0],
    endpoint: 'https://example.invalid/forged-financial-facts',
    qualificationStatus: 'QUALIFIED_FOR_USER_PRESENTATION',
    reusePermissionStatus: 'APPROVED',
    reviewRecord: { reviewedAt: timestamp, reference: 'TEST_ONLY', scope: 'TESTS_ONLY' },
  };
  misconfigured.definitionHash = computeGenieProofSourceDefinitionHash(misconfigured);
  f.sourceModel.find = () => ({ sort() { return this; }, session() { return this; }, lean: async () => [misconfigured] });
  f.workerHeartbeatModel.exists = async () => true;

  const availability = await getProofWatchAvailability({ userId: owner, caseId, ...f, now: () => timestamp });
  assert.equal(availability.canEnable, false);
  assert.equal(availability.sourceStatus, 'TECHNICALLY_BLOCKED');
  assert.equal(availability.claims[0].status, 'SOURCE_TECHNICALLY_BLOCKED');

  const created = await createProofWatch({
    userId: owner, caseId, watchConsent: true, idempotencyKey: 'proof-watch-bad-endpoint', ...f, now: () => timestamp,
  });
  assert.equal(created.watch.status, 'FAILED_TERMINAL');
  assert.equal(created.watch.sourceAvailability, 'TECHNICALLY_BLOCKED');
  assert.deepEqual(f.jobs, []);
});

test('watch listing honors the validated limit', async () => {
  const f = fixture();
  f.watches.push(...[1, 2, 3].map(index => ({
    watchId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    userId: owner,
    caseId,
    status: 'BLOCKED_SOURCE_RIGHTS',
  })));
  assert.equal((await listProofWatches({ userId: owner, caseId, limit: 1, ...f })).length, 1);
});

test('watch listing reports an expired active watch as expired immediately', async () => {
  const f = fixture();
  f.watches.push({ watchId: '00000000-0000-4000-8000-000000000007', userId: owner, caseId, status: 'ACTIVE', expiresAt: new Date(timestamp.getTime() - 1) });
  const listed = await listProofWatches({ userId: owner, caseId, ...f, now: () => timestamp });
  assert.equal(listed[0].status, 'EXPIRED');
});

test('watch pause, resume, and disable are owner-scoped and fence scheduled jobs', async () => {
  const f = fixture();
  const created = await createProofWatch({ userId: owner, caseId, watchConsent: true, idempotencyKey: 'proof-watch-lifecycle', ...f, now: () => timestamp });
  const paused = await updateProofWatchStatus({ userId: owner, watchId: created.watch.watchId, action: 'pause', ...f, now: () => timestamp });
  assert.equal(paused.status, 'PAUSED');
  assert.equal(f.watches[0].generation, 2);
  const resumed = await updateProofWatchStatus({ userId: owner, watchId: created.watch.watchId, action: 'resume', ...f, now: () => timestamp });
  assert.equal(resumed.status, 'BLOCKED_SOURCE_RIGHTS');
  assert.equal(resumed.nextCheckAt, null);
  assert.equal(await updateProofWatchStatus({ userId: otherOwner, watchId: created.watch.watchId, action: 'disable', ...f, now: () => timestamp }), null);
  const disabled = await updateProofWatchStatus({ userId: owner, watchId: created.watch.watchId, action: 'disable', ...f, now: () => timestamp });
  assert.equal(disabled.status, 'CANCELLED');
  assert.ok(disabled.consentWithdrawnAt);
  await assert.rejects(updateProofWatchStatus({ userId: owner, watchId: created.watch.watchId, action: 'resume', ...f, now: () => timestamp }), error => error.code === 'PROOFBREAK_WATCH_CANCELLED');
});

test('withdrawing processing consent transactionally cancels ProofBreak watches and pending jobs', async () => {
  const f = fixture();
  const created = await createProofWatch({ userId: owner, caseId, watchConsent: true, idempotencyKey: 'proof-watch-consent-withdraw', ...f, now: () => timestamp });
  assert.equal(await withdrawGenieProofConsent({ userId: owner, caseId, ...f, now: () => timestamp }), true);
  assert.equal(f.watches[0].status, 'CANCELLED');
  assert.ok(f.watches[0].consentWithdrawnAt);
  assert.equal(f.watches[0].generation, 2);
  assert.equal(f.jobs.length, 0);
  assert.equal(await withdrawGenieProofConsent({ userId: owner, caseId, ...f, now: () => timestamp }), true);
  await assert.rejects(createProofWatch({ userId: owner, caseId, watchConsent: true, idempotencyKey: 'proof-watch-after-withdraw', ...f, now: () => timestamp }), error => error.code === 'GENIEPROOF_CONSENT_WITHDRAWN');
  assert.ok(created.watch.watchId);
});

test('timeline pagination and acknowledgement are owner-bound', async () => {
  const f = fixture();
  for (let index = 0; index < 3; index += 1) {
    f.events.push({ _id: `${index}`.padStart(24, '0'), userId: owner, caseId, eventId: `00000000-0000-4000-8000-00000000000${index + 1}`, watchId: '00000000-0000-4000-8000-000000000009', claimId, previousAssessmentId: 'case:1', newAssessmentId: `case:${index + 2}`, eventType: 'RECHECK_UNCHANGED', publishedAt: new Date(timestamp.getTime() - index), detectedAt: timestamp, notificationStatus: 'DELIVERED', acknowledgedAt: null });
  }
  const first = await listProofBreakEvents({ userId: owner, caseId, limit: 2, ...f });
  assert.equal(first.events.length, 2);
  assert.ok(first.nextCursor);
  const next = await listProofBreakEvents({ userId: owner, caseId, limit: 2, cursor: first.nextCursor, ...f });
  assert.equal(next.events.length, 1);
  assert.equal((await listProofBreakEvents({ userId: otherOwner, caseId, ...f })).events.length, 0);
  assert.equal(await acknowledgeProofBreakEvent({ userId: otherOwner, eventId: f.events[0].eventId, ...f, now: () => timestamp }), false);
  assert.equal(await acknowledgeProofBreakEvent({ userId: owner, eventId: f.events[0].eventId, ...f, now: () => timestamp }), true);
  assert.ok(f.events[0].acknowledgedAt);
});
