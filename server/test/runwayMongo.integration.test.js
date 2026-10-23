import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { canonicalSha256 } from '../utils/canonicalJson.js';
import { createRunwaySeal, createRunwayLedgerSeal, RUNWAY_SEAL_VERSION } from '../services/runwaySeal.js';
import User from '../models/User.js';
import FinancialProfile from '../models/FinancialProfile.js';
import Goal from '../models/Goal.js';
import Recommendation from '../models/Recommendation.js';
import { RunwayLedgerState, RunwayLedgerRevision, RunwaySnapshot, RunwaySnapshotDeletion, RunwayMutationReceipt } from '../models/Runway.js';
import { RunwayStatement, RunwaySignal, RunwaySettlement } from '../models/RunwayEvidence.js';
import { setupTestDatabase, teardownTestDatabase } from './helpers/mongoTestHelper.js';
import { withServer, jsonRequest } from '../test-utils/httpTestUtils.js';

process.env.NODE_ENV = 'test';
process.env.DISABLE_RATE_LIMIT = 'true';
process.env.JWT_SECRET ||= 'runway-mongo-integration-test-secret';
process.env.RUNWAY_INTEGRITY_SECRET ||= '84ba1e61657ab8a4b989e710a9b35e39d2f0b5f1c749d364fdbb0a81a55efb96'; // disposable test key only
const { createApp } = await import('../app.js');

const today = () => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const part = type => parts.find(p => p.type === type)?.value;
  return part('year') + '-' + part('month') + '-' + part('day');
};
const token = id => jwt.sign({
  userId: String(id), jti: crypto.randomUUID(), token_use: 'session',
}, process.env.JWT_SECRET, { expiresIn: '1h' });

test('Runway Mongo: owner isolation, CAS race, persisted replay, snapshot recompute and deletion', async () => {
  await setupTestDatabase({ requireReplicaSet: true });
  try {
    await RunwayLedgerRevision.collection.createIndex({ userId: 1, revision: 1 }, {
      unique: true, name: 'uniq_runway_ledger_revision',
    });
    await RunwaySnapshot.collection.createIndex({ userId: 1, createdAt: -1 }, {
      name: 'runway_snapshots_by_owner',
    });
    await RunwaySnapshotDeletion.collection.createIndex({ expiresAt: 1 }, {
      name: 'runway_deleted_snapshot_ttl', expireAfterSeconds: 0,
    });
    await RunwayStatement.collection.createIndex({ userId: 1, importedAt: -1 }, {
      name: 'runway_statement_owner_newest',
    });
    await RunwaySignal.collection.createIndex({ userId: 1, _id: 1 }, {
      name: 'runway_signal_owner_cursor',
    });
    await RunwaySignal.collection.createIndex({ expiresAt: 1 }, {
      name: 'runway_signal_ttl', expireAfterSeconds: 0,
    });
    await RunwaySettlement.collection.createIndex({ userId: 1, decidedAt: -1 }, {
      name: 'runway_settlement_owner_audit',
    });
    const [userA, userB] = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
    await User.create([
      { _id: userA, name: 'Runway A', email: 'runway-a-' + crypto.randomUUID() + '@example.test', passwordHash: 'test-hash' },
      { _id: userB, name: 'Runway B', email: 'runway-b-' + crypto.randomUUID() + '@example.test', passwordHash: 'test-hash' },
    ]);
    const app = createApp({ env: { ...process.env, NODE_ENV: 'test', RUNWAY_ENABLED: 'true' } });
    const now = today();
    const bill = { id: 'rent', label: 'Rent', kind: 'OBLIGATION', amountPaise: '12000',
      date: now, recurrence: 'NONE' };
    const salary = { id: 'salary', label: 'Future salary', kind: 'EXPECTED_INCOME', amountPaise: '20000',
      date: now, recurrence: 'NONE' };
    const ledger = { asOfDate: now, confirmationDate: now, openingCashPaise: '10000', entries: [bill, salary] };
    const authA = { Authorization: 'Bearer ' + token(userA) };
    const authB = { Authorization: 'Bearer ' + token(userB) };
    const write = (base, entry, expected, key, auth = authA) =>
      jsonRequest(base + '/api/runway/ledger', {
        method: 'PUT',
        headers: { ...auth, 'Content-Type': 'application/json', 'If-Match': '"' + expected + '"', 'Idempotency-Key': key },
        body: JSON.stringify(entry),
      });
    const mutation = (base, path, payload, auth = authA, key = crypto.randomUUID()) =>
      jsonRequest(base + '/api/runway/' + path, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify(payload),
      });

    await withServer(app, async base => {
      const ownedBase = base + '/api/runway/';
      const initial = await write(base, ledger, 0, 'runway-initial-001');
      assert.equal(initial.response.status, 201, JSON.stringify(initial.body));
      assert.equal(initial.body.revision, 1);
      assert.equal(initial.body.ledger.openingCashPaise, '10000');

      const replay = await write(base, ledger, 0, 'runway-initial-001');
      assert.equal(replay.response.status, 200);
      assert.equal(replay.body.replayed, true);
      assert.equal(replay.body.revision, 1);

      const reused = await write(base, { ...ledger, openingCashPaise: '11000' }, 0, 'runway-initial-001');
      assert.equal(reused.response.status, 409);
      assert.equal(reused.body.code, 'RUNWAY_IDEMPOTENCY_CONFLICT');

      // Free statement ingestion never silently redefines the verified opening
      // ledger or counts posted transfers as brand-new expected income.
      const csv = [
        'date,description,debit,credit,balance,reference',
        now + ',Salary credit,0,125.00,125.00,salary-001',
      ].join('\n');
      const imported = await mutation(base, 'live/statements', {
        accountLabel: 'Salary account', csvText: csv,
      });
      assert.equal(imported.response.status, 201, JSON.stringify(imported.body));
      assert.equal(imported.body.verification, 'USER_IMPORTED_UNVERIFIED');
      assert.equal(imported.body.closingBalancePaise, '12500');
      const replayImport = await mutation(base, 'live/statements', {
        accountLabel: 'Salary account', csvText: csv,
      });
      assert.equal(replayImport.response.status, 200);
      assert.equal(replayImport.body.replayed, true);
      assert.equal(await RunwayStatement.countDocuments({ userId: userA }), 1);
      const foreignEvidence = await jsonRequest(ownedBase + 'live/statements', { headers: authB });
      assert.equal(foreignEvidence.response.status, 200);
      assert.equal(foreignEvidence.body.items.length, 0);
      const userEvidence = await jsonRequest(ownedBase + 'live/statements', { headers: authA });
      assert.equal(userEvidence.body.items[0].statementId, imported.body.statementId);
      const evidenceDetails = await jsonRequest(ownedBase + 'live/statements/' + imported.body.statementId,
        { headers: authA });
      assert.equal(evidenceDetails.body.records[0].creditPaise, '12500');
      const wrongOwnerEvidence = await jsonRequest(ownedBase + 'live/statements/' + imported.body.statementId,
        { headers: authB });
      assert.equal(wrongOwnerEvidence.response.status, 404);
      const live = await jsonRequest(ownedBase + 'live/overview?horizonDays=1', { headers: authA });
      assert.equal(live.response.status, 200, JSON.stringify(live.body));
      assert.equal(live.body.bankConnected, false);
      assert.equal(live.body.modeled.baseline.cashAlreadyAvailable.endBalancePaise, '-2000');
      assert.equal(live.body.observedStatement.closingBalancePaise, '12500');
      const changes = await jsonRequest(ownedBase + 'live/events', { headers: authA });
      assert.ok(changes.body.items.some(item => item.eventType === 'LEDGER_UPDATED'));
      assert.ok(changes.body.items.some(item => item.eventType === 'STATEMENT_IMPORTED'));
      const eventCursor = changes.body.nextCursor;
      const again = await jsonRequest(ownedBase + 'live/events?after=' + eventCursor, { headers: authA });
      assert.equal(again.body.items.length, 0);
      const otherEvents = await jsonRequest(ownedBase + 'live/events', { headers: authB });
      assert.equal(otherEvents.body.items.length, 0);
      const badStatement = await mutation(base, 'live/statements', {
        accountLabel: 'Salary account', csvText: csv + '\n' + now + ',Rent,20.00,0,100.00,rent-001',
      });
      assert.equal(badStatement.response.status, 400);
      const savedEvidence = await RunwayStatement.collection.findOne({ _id: imported.body.statementId });
      await RunwayStatement.collection.updateOne({ _id: imported.body.statementId },
        { $set: { 'statement.closingBalancePaise': '99999999' } });
      const tampered = await jsonRequest(ownedBase + 'live/overview', { headers: authA });
      assert.equal(tampered.response.status, 503);
      assert.equal(tampered.body.code, 'RUNWAY_EVIDENCE_INVALID');
      await RunwayStatement.collection.updateOne({ _id: imported.body.statementId },
        { $set: { 'statement.closingBalancePaise': savedEvidence.statement.closingBalancePaise } });
      const ownExport = await jsonRequest(ownedBase + 'ledger/revisions?page=0', { headers: authA });
      assert.equal(ownExport.response.status, 200);
      assert.equal(ownExport.body.format, 'WEALTHGENIE_RUNWAY_LEDGER_HISTORY_V1');
      assert.equal(ownExport.body.total, 1);
      assert.equal(ownExport.body.items[0].ledger.openingCashPaise, '10000');
      const otherExport = await jsonRequest(ownedBase + 'ledger/revisions?page=0', { headers: authB });
      assert.equal(otherExport.response.status, 200);
      assert.equal(otherExport.body.total, 0);
      const invalidExportPage = await jsonRequest(ownedBase + 'ledger/revisions?page=21', { headers: authA });
      assert.equal(invalidExportPage.response.status, 400);
      const otherUser = await jsonRequest(ownedBase + 'current', { headers: authB });
      assert.equal(otherUser.response.status, 404);
      assert.equal(otherUser.response.headers.get('cache-control'), 'no-store');

      const request = { ledgerRevision: 1, horizonDays: 1, scenarios: [] };
      const simulation = await mutation(base, 'simulations', request);
      assert.equal(simulation.response.status, 200, JSON.stringify(simulation.body));
      assert.equal(simulation.body.scenarios[0].cashAlreadyAvailable.status, 'LISTED_SHORTFALL');
      assert.equal(simulation.body.scenarios[0].ifExpectedIncomeArrives.status, 'SAME_DAY_TIMING_UNKNOWN');

       const browserTamper = await mutation(base, 'snapshots', { ...request, allegedBalancePaise: '999999' });
      assert.equal(browserTamper.response.status, 400);
      assert.equal(await RunwaySnapshot.countDocuments({ userId: userA }), 0);

      const snapshot = await mutation(base, 'snapshots', request, authA, 'runway-snapshot-001');
      assert.equal(snapshot.response.status, 201, JSON.stringify(snapshot.body));
      const duplicated = await mutation(base, 'snapshots', request, authA, 'runway-snapshot-001');
      assert.equal(duplicated.response.status, 200);
      assert.equal(duplicated.body.snapshotId, snapshot.body.snapshotId);
      assert.equal(await RunwaySnapshot.countDocuments({ userId: userA }), 1);
      const listing = await jsonRequest(ownedBase + 'snapshots?page=0', { headers: authA });
      assert.equal(listing.response.status, 200);
      assert.equal(listing.body.total, 1);
      assert.equal(listing.body.items[0].snapshotId, snapshot.body.snapshotId);
      assert.equal(listing.body.items[0].status, 'CURRENT');
      const exportedSnapshots = await jsonRequest(ownedBase + 'export/snapshots?page=0', { headers: authA });
      assert.equal(exportedSnapshots.response.status, 200);
      assert.equal(exportedSnapshots.body.format, 'WEALTHGENIE_RUNWAY_SNAPSHOT_HISTORY_V1');
      assert.equal(exportedSnapshots.body.total, 1);
      assert.equal(exportedSnapshots.body.items[0].snapshotId, snapshot.body.snapshotId);
      assert.equal(exportedSnapshots.body.items[0].verification, 'RECOMPUTED_CURRENT_ENGINE');
      const otherSnapshots = await jsonRequest(ownedBase + 'export/snapshots?page=0', { headers: authB });
      assert.equal(otherSnapshots.body.total, 0);
      const wrongExportPage = await jsonRequest(ownedBase + 'export/snapshots?page=5', { headers: authA });
      assert.equal(wrongExportPage.response.status, 400);
      const privateListing = await jsonRequest(ownedBase + 'snapshots?page=0', { headers: authB });
      assert.equal(privateListing.body.total, 0);
      const invalidPage = await jsonRequest(ownedBase + 'snapshots?page=-1', { headers: authA });
      assert.equal(invalidPage.response.status, 400);

      const invisible = await jsonRequest(ownedBase + 'snapshots/' + snapshot.body.snapshotId, { headers: authB });
      assert.equal(invisible.response.status, 404);
      const ownedSnapshot = await jsonRequest(ownedBase + 'snapshots/' + snapshot.body.snapshotId, { headers: authA });
      assert.equal(ownedSnapshot.body.status, 'CURRENT');
      assert.equal(ownedSnapshot.body.result.scenarios[0].ifExpectedIncomeArrives.endBalancePaise, '18000');
      const additional = await mutation(base, 'snapshots', request, authA, 'runway-snapshot-002');
      assert.equal(additional.response.status, 201);
      const privateDelete = await jsonRequest(ownedBase + 'snapshots/' + additional.body.snapshotId,
        { method: 'DELETE', headers: authB });
      assert.equal(privateDelete.response.status, 404);
      const deletedOne = await jsonRequest(ownedBase + 'snapshots/' + additional.body.snapshotId,
        { method: 'DELETE', headers: authA });
      assert.equal(deletedOne.response.status, 200);
      assert.equal(await RunwaySnapshot.countDocuments({ userId: userA }), 1);
      assert.equal(await RunwaySnapshotDeletion.countDocuments({ userId: userA }), 1);
      const tombstone = await RunwaySnapshotDeletion.findById(additional.body.snapshotId).lean();
      assert.ok(tombstone.expiresAt > tombstone.deletedAt);
      assert.ok(tombstone.expiresAt.getTime() - tombstone.deletedAt.getTime()
        === 45 * 24 * 60 * 60 * 1000);
      const delayedReplayAfterDeletion = await mutation(base, 'snapshots', request, authA, 'runway-snapshot-002');
      assert.equal(delayedReplayAfterDeletion.response.status, 409);
      assert.equal(delayedReplayAfterDeletion.body.code, 'RUNWAY_SNAPSHOT_DELETED');
      assert.equal(await RunwaySnapshot.countDocuments({ userId: userA }), 1);
      const repeatDeletion = await jsonRequest(ownedBase + 'snapshots/' + additional.body.snapshotId,
        { method: 'DELETE', headers: authA });
      assert.equal(repeatDeletion.response.status, 404);

      const original = await RunwaySnapshot.collection.findOne({ _id: snapshot.body.snapshotId });
      await RunwaySnapshot.collection.updateOne({ _id: snapshot.body.snapshotId },
        { $set: { 'result.disclaimer': 'Forged reassurance' } });
      const corrupted = await jsonRequest(ownedBase + 'snapshots/' + snapshot.body.snapshotId, { headers: authA });
      assert.equal(corrupted.response.status, 503);
      assert.equal(corrupted.body.code, 'RUNWAY_SEAL_INVALID');
      // A database writer can recompute an unkeyed checksum, but cannot
      // rewrite the server-held HMAC. It must remain rejected.
      const checksumForgery = { ...original.result, disclaimer: 'FORGED_SAFE' };
      await RunwaySnapshot.collection.updateOne({ _id: snapshot.body.snapshotId },
        { $set: { result: checksumForgery, resultHash: canonicalSha256(checksumForgery) } });
      const forgedChecksum = await jsonRequest(ownedBase + 'snapshots/' + snapshot.body.snapshotId, { headers: authA });
      assert.equal(forgedChecksum.response.status, 503);
      assert.equal(forgedChecksum.body.code, 'RUNWAY_SEAL_INVALID');
      const rejectedExport = await jsonRequest(ownedBase + 'export/snapshots?page=0', { headers: authA });
      assert.equal(rejectedExport.response.status, 503);
      assert.equal(rejectedExport.body.code, 'RUNWAY_SEAL_INVALID');
      const forgedExplanation = await mutation(base, 'explanations', { snapshotId: snapshot.body.snapshotId });
      assert.equal(forgedExplanation.response.status, 503);
      assert.equal(forgedExplanation.body.code, 'RUNWAY_SEAL_INVALID');
      const forgedReplay = await mutation(base, 'snapshots', request, authA, 'runway-snapshot-001');
      assert.equal(forgedReplay.response.status, 503);
      assert.equal(forgedReplay.body.code, 'RUNWAY_SEAL_INVALID');
      await RunwaySnapshot.collection.updateOne({ _id: snapshot.body.snapshotId },
        { $set: { 'result.disclaimer': original.result.disclaimer } });
      const historicalResult = { ...original.result, engineVersion: 'runway-cashflow-0.9.0' };
      const historicRecord = { ...original, result: historicalResult, resultHash: canonicalSha256(historicalResult) };
      await RunwaySnapshot.collection.updateOne({ _id: snapshot.body.snapshotId },
        { $set: { result: historicalResult, resultHash: historicRecord.resultHash,
          sealHmac: createRunwaySeal(historicRecord) } });
      const oldEngineRead = await jsonRequest(ownedBase + 'snapshots/' + snapshot.body.snapshotId, { headers: authA });
      assert.equal(oldEngineRead.response.status, 200);
      assert.equal(oldEngineRead.body.engineStatus, 'HISTORICAL_ENGINE');
      assert.equal(oldEngineRead.body.verification, 'STORED_HASH_ONLY');
      const oldEngineList = await jsonRequest(ownedBase + 'snapshots?page=0', { headers: authA });
      assert.equal(oldEngineList.body.items[0].status, 'HISTORICAL');
      assert.equal(oldEngineList.body.items[0].engineStatus, 'HISTORICAL_ENGINE');
      const historicalExplanation = await mutation(base, 'explanations', { snapshotId: snapshot.body.snapshotId });
      assert.equal(historicalExplanation.response.status, 409);
      assert.equal(historicalExplanation.body.code, 'RUNWAY_HISTORICAL_ENGINE_UNSUPPORTED');
      await RunwaySnapshot.collection.updateOne({ _id: snapshot.body.snapshotId },
        { $set: { result: original.result, resultHash: original.resultHash, sealHmac: original.sealHmac } });

      // Forging a ledger plus its unkeyed input hash must NOT be accepted
      // without the server-only HMAC seal.
      const sourceRevision = await RunwayLedgerRevision.collection.findOne({ userId: userA, revision: 1 });
      const forgedLedger = { ...sourceRevision.ledger, openingCashPaise: '999999999' };
      await RunwayLedgerRevision.collection.updateOne({ userId: userA, revision: 1 },
        { $set: { ledger: forgedLedger, inputHash: canonicalSha256(forgedLedger) } });
      const forgedLedgerExport = await jsonRequest(ownedBase + 'ledger/revisions?page=0', { headers: authA });
      assert.equal(forgedLedgerExport.response.status, 503);
      assert.equal(forgedLedgerExport.body.code, 'RUNWAY_LEDGER_SEAL_INVALID');
      const forgedLedgerSnapshot = await jsonRequest(ownedBase + 'snapshots/' + snapshot.body.snapshotId, { headers: authA });
      assert.equal(forgedLedgerSnapshot.response.status, 503);
      assert.equal(forgedLedgerSnapshot.body.code, 'RUNWAY_INTEGRITY_UNAVAILABLE');
      const forgedSourceList = await jsonRequest(ownedBase + 'snapshots?page=0', { headers: authA });
      assert.equal(forgedSourceList.response.status, 503);
      assert.equal(forgedSourceList.body.code, 'RUNWAY_LEDGER_SEAL_INVALID');
      await RunwayLedgerRevision.collection.updateOne({ userId: userA, revision: 1 },
        { $set: { ledger: sourceRevision.ledger, inputHash: sourceRevision.inputHash } });

      const updatedLedger = { ...ledger, openingCashPaise: '9000' };
      const raced = await Promise.all([
        write(base, updatedLedger, 1, 'runway-race-001'),
        write(base, { ...ledger, openingCashPaise: '8000' }, 1, 'runway-race-002'),
      ]);
      assert.deepEqual(raced.map(x => x.response.status).sort(), [201, 409]);
      const current = await jsonRequest(ownedBase + 'current', { headers: authA });
      assert.equal(current.body.revision, 2);
      // State rollback to a formerly valid, properly sealed revision must fail closed.
      await RunwayLedgerState.collection.updateOne({ _id: userA }, { $set: { revision: 1 } });
      const rolledBackPointer = await jsonRequest(ownedBase + 'current', { headers: authA });
      assert.equal(rolledBackPointer.response.status, 503);
      assert.equal(rolledBackPointer.body.code, 'RUNWAY_REVISION_POINTER_INVALID');
      const rolledBackSnapshotList = await jsonRequest(ownedBase + 'snapshots?page=0', { headers: authA });
      assert.equal(rolledBackSnapshotList.response.status, 503);
      await RunwayLedgerState.collection.updateOne({ _id: userA }, { $set: { revision: 2 } });
      const receiptId = canonicalSha256({ operation: 'LEDGER', key: 'runway-initial-001', userId: String(userA) });
      await RunwayMutationReceipt.collection.updateOne({ _id: receiptId }, { $set: { revision: 2 } });
      const forgedReceiptReplay = await write(base, ledger, 0, 'runway-initial-001');
      assert.equal(forgedReceiptReplay.response.status, 503);
      assert.equal(forgedReceiptReplay.body.code, 'RUNWAY_RECEIPT_INTEGRITY_INVALID');
      await RunwayMutationReceipt.collection.updateOne({ _id: receiptId }, { $set: { revision: 1 } });
      const replayAfterRepair = await write(base, ledger, 0, 'runway-initial-001');
      assert.equal(replayAfterRepair.response.status, 200);
      assert.equal(replayAfterRepair.body.ledger.openingCashPaise, '10000');
      const historic = await jsonRequest(ownedBase + 'snapshots/' + snapshot.body.snapshotId, { headers: authA });
      assert.equal(historic.body.status, 'HISTORICAL');
      const stale = await mutation(base, 'simulations', request);
      assert.equal(stale.response.status, 409);
      assert.equal(stale.body.code, 'RUNWAY_STALE_INPUT');
      const future = new Date(Date.UTC(Number(now.slice(0, 4)), Number(now.slice(5, 7)) - 1,
        Number(now.slice(8, 10)) + 10)).toISOString().slice(0, 10);
      const horizonLedger = { ...ledger, entries: [{ ...bill, date: future }] };
      const third = await write(base, horizonLedger, 2, 'runway-third-003');
      assert.equal(third.response.status, 201);
      const tooShort = { ledgerRevision: 3, horizonDays: 1, scenarios: [] };
      const noBillInHorizon = await mutation(base, 'simulations', tooShort);
      assert.equal(noBillInHorizon.response.status, 200);
      assert.equal(noBillInHorizon.body.status, 'INSUFFICIENT_INPUT');
      const blockedEmptySnapshot = await mutation(base, 'snapshots', tooShort);
      assert.equal(blockedEmptySnapshot.response.status, 400);
      assert.equal(blockedEmptySnapshot.body.code, 'RUNWAY_INSUFFICIENT_INPUT');

      // Red-team the owner-scoped snapshot cap at the concurrency boundary:
      // 99 prior records + two simultaneous writers must yield exactly 100,
      // never the invalid 101st result.
      const originalForCap = await RunwaySnapshot.collection.findOne({ _id: snapshot.body.snapshotId });
      const filler = Array.from({ length: 98 }, (_, i) => ({
        ...originalForCap,
        _id: crypto.createHash('sha256').update('runway-cap-filler-' + i).digest('hex'),
        createdAt: new Date(),
      }));
      await RunwaySnapshot.collection.insertMany(filler);
      assert.equal(await RunwaySnapshot.countDocuments({ userId: userA }), 99);
      const capRequest = { ledgerRevision: 3, horizonDays: 11, scenarios: [] };
      const capResults = await Promise.all([
        mutation(base, 'snapshots', capRequest, authA, 'runway-cap-race-001'),
        mutation(base, 'snapshots', capRequest, authA, 'runway-cap-race-002'),
      ]);
      assert.deepEqual(capResults.map(x => x.response.status).sort(), [201, 409]);
      assert.equal(await RunwaySnapshot.countDocuments({ userId: userA }), 100);
      assert.equal(capResults.find(x => x.response.status === 409).body.code, 'RUNWAY_SNAPSHOT_LIMIT');

      // Quota is enforced before a new immutable revision is created.
      await RunwayLedgerState.create({ _id: userB, revision: 2048, snapshotGeneration: 0 });
      const cappedRevision = { userId: userB, revision: 2048, ledger, inputHash: canonicalSha256(ledger),
        confirmedAt: new Date(), sealVersion: RUNWAY_SEAL_VERSION };
      cappedRevision.sealHmac = createRunwayLedgerSeal(cappedRevision);
      await RunwayLedgerRevision.create(cappedRevision);
      const blockedRevision = await write(base, ledger, 2048, 'runway-revision-cap', authB);
      assert.equal(blockedRevision.response.status, 409);
      assert.equal(blockedRevision.body.code, 'RUNWAY_REVISION_LIMIT');

      const invalidDelete = await jsonRequest(ownedBase + 'data', {
        method: 'DELETE', headers: { ...authB, 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: 'wrong' }),
      });
      assert.equal(invalidDelete.response.status, 400);
      const deleted = await jsonRequest(ownedBase + 'data', {
        method: 'DELETE', headers: { ...authA, 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: 'DELETE_RUNWAY_DATA' }),
      });
      assert.equal(deleted.response.status, 200);
      assert.equal(deleted.body.status, 'DELETED');
      assert.equal(await RunwayLedgerRevision.countDocuments({ userId: userA }), 0);
      assert.equal(await RunwaySnapshot.countDocuments({ userId: userA }), 0);
      assert.equal(await RunwaySnapshotDeletion.countDocuments({ userId: userA }), 0);
      assert.equal(await RunwayStatement.countDocuments({ userId: userA }), 0);
      assert.equal(await RunwaySignal.countDocuments({ userId: userA }), 0);
      assert.equal(await RunwaySettlement.countDocuments({ userId: userA }), 0);
      const missing = await jsonRequest(ownedBase + 'snapshots/' + snapshot.body.snapshotId, { headers: authA });
      assert.equal(missing.response.status, 404);
      assert.equal(await FinancialProfile.countDocuments({ userId: userA }), 0);
      assert.equal(await Goal.countDocuments({ userId: userA }), 0);
      assert.equal(await Recommendation.countDocuments({ userId: userA }), 0);
    });
  } finally {
    await teardownTestDatabase();
  }
});


test('Runway settlement: user-confirmed cash, bank-evidence ambiguity, idempotent replay and sealed history', async () => {
  await setupTestDatabase({ requireReplicaSet: true });
  try {
    // These are the same explicitly migrated indexes checked by readiness.
    await RunwayLedgerRevision.collection.createIndex({ userId: 1, revision: 1 },
      { name: 'uniq_runway_ledger_revision', unique: true });
    await RunwaySnapshot.collection.createIndex({ userId: 1, createdAt: -1 },
      { name: 'runway_snapshots_by_owner' });
    await RunwaySnapshotDeletion.collection.createIndex({ expiresAt: 1 },
      { name: 'runway_deleted_snapshot_ttl', expireAfterSeconds: 0 });
    await RunwayStatement.collection.createIndex({ userId: 1, importedAt: -1 },
      { name: 'runway_statement_owner_newest' });
    await RunwaySignal.collection.createIndex({ userId: 1, _id: 1 },
      { name: 'runway_signal_owner_cursor' });
    await RunwaySignal.collection.createIndex({ expiresAt: 1 },
      { name: 'runway_signal_ttl', expireAfterSeconds: 0 });
    await RunwaySettlement.collection.createIndex({ userId: 1, decidedAt: -1 },
      { name: 'runway_settlement_owner_audit' });
    const [userA, userB] = [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()];
    await User.create([
      { _id: userA, name: 'Settlement A', email: 'r-a-' + crypto.randomUUID() + '@example.test',
        passwordHash: 'test-hash' },
      { _id: userB, name: 'Settlement B', email: 'r-b-' + crypto.randomUUID() + '@example.test',
        passwordHash: 'test-hash' },
    ]);
    const now = today();
    const ledger = { asOfDate: now, confirmationDate: now, openingCashPaise: '5000000',
      entries: [
        { id: 'rent', label: 'Rent', kind: 'OBLIGATION', amountPaise: '1500000',
          date: now, recurrence: 'NONE' },
        { id: 'salary', label: 'Salary', kind: 'EXPECTED_INCOME', amountPaise: '3000000',
          date: now, recurrence: 'NONE' },
      ] };
    const csv = [
      'date,description,debit,credit,balance,reference',
      now + ',Rent posted,15000.00,0,35000.00,pay-1',
      now + ',Salary credit,0,30000.00,65000.00,pay-2',
    ].join('\n');
    const app = createApp({ env: { ...process.env, RUNWAY_ENABLED: 'true', NODE_ENV: 'test' } });
    const authA = { Authorization: 'Bearer ' + token(userA) };
    const authB = { Authorization: 'Bearer ' + token(userB) };
    const send = (base, endpoint, body, auth = authA, key = crypto.randomUUID()) =>
      jsonRequest(base + '/api/runway/' + endpoint, {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json',
          'Idempotency-Key': key }, body: JSON.stringify(body),
      });
    await withServer(app, async base => {
      const root = base + '/api/runway/';
      const created = await jsonRequest(root + 'ledger', {
        method: 'PUT', headers: { ...authA, 'Content-Type': 'application/json',
          'If-Match': '"0"', 'Idempotency-Key': 'settlement-create-ledger-1' },
        body: JSON.stringify(ledger),
      });
      assert.equal(created.response.status, 201, JSON.stringify(created.body));
      const imported = await send(base, 'live/statements', {
        accountLabel: 'Single salary account', csvText: csv,
      });
      assert.equal(imported.response.status, 201, JSON.stringify(imported.body));
      const candidates = await jsonRequest(root + 'live/matches', { headers: authA });
      assert.equal(candidates.response.status, 200);
      assert.equal(candidates.body.revision, 1);
      assert.deepEqual(candidates.body.items.map(x => x.status),
        ['UNIQUE_POSSIBLE_MATCH', 'UNIQUE_POSSIBLE_MATCH']);
      const otherMatches = await jsonRequest(root + 'live/matches', { headers: authB });
      assert.equal(otherMatches.body.items.length, 0);
      const before = await jsonRequest(root + 'current', { headers: authA });
      assert.equal(before.body.ledger.entries.length, 2, 'Preview must never mutate saved cash');
      const request = {
        ledgerRevision: 1, statementId: imported.body.statementId, rowIndex: 0,
        entryId: 'rent', openingCashPaise: '3500000',
        confirmation: 'I_RECONFIRM_HOUSEHOLD_CASH_AFTER_TRANSACTION',
      };
      const missingConsent = await send(base, 'live/settlements', { ...request, confirmation: 'YES' });
      assert.equal(missingConsent.response.status, 400);
      const posted = await send(base, 'live/settlements', request, authA, 'rent-posting-unique-1');
      assert.equal(posted.response.status, 201, JSON.stringify(posted.body));
      assert.equal(posted.body.revision, 2);
      assert.equal(posted.body.evidenceStatus, 'USER_CONFIRMED_NOT_BANK_VERIFIED');
      const after = await jsonRequest(root + 'current', { headers: authA });
      assert.equal(after.body.revision, 2);
      assert.equal(after.body.ledger.openingCashPaise, '3500000');
      assert.deepEqual(after.body.ledger.entries.map(x => x.id), ['salary']);
      const original = await RunwayLedgerRevision.findOne({ userId: userA, revision: 1 }).lean();
      assert.equal(original.ledger.entries.length, 2, 'Prior signed ledger must remain immutable');
      const replay = await send(base, 'live/settlements', request, authA, 'rent-posting-unique-1');
      assert.equal(replay.response.status, 200);
      assert.equal(replay.body.replayed, true);
      assert.equal(await RunwayLedgerRevision.countDocuments({ userId: userA }), 2);
      const misuse = await send(base, 'live/settlements',
        { ...request, openingCashPaise: '9000000' }, authA, 'rent-posting-unique-1');
      assert.equal(misuse.response.status, 409);
      assert.equal(misuse.body.code, 'RUNWAY_IDEMPOTENCY_CONFLICT');
      const stale = await send(base, 'live/settlements', request, authA, 'different-key-stale');
      assert.equal(stale.response.status, 409);
      assert.equal(stale.body.code, 'RUNWAY_STALE_INPUT');
      const foreign = await send(base, 'live/settlements', request, authB, 'foreign-settlement-1');
      assert.notEqual(foreign.response.status, 201);
      const history = await jsonRequest(root + 'live/settlements?page=0', { headers: authA });
      assert.equal(history.response.status, 200);
      assert.equal(history.body.total, 1);
      assert.equal(history.body.items[0].resultRevision, 2);
      const foreignHistory = await jsonRequest(root + 'live/settlements?page=0', { headers: authB });
      assert.equal(foreignHistory.body.total, 0);
      const events = await jsonRequest(root + 'live/events', { headers: authA });
      assert.ok(events.body.items.some(x => x.eventType === 'SETTLEMENT_CONFIRMED'));
      // Database-only writers can tamper with amounts and recompute ordinary
      // SHA digests. They cannot forge the server-owned HMAC of a receipt.
      await RunwaySettlement.collection.updateOne({ _id: posted.body.receiptId },
        { $set: { confirmedCashPaise: '9900000' } });
      const forged = await jsonRequest(root + 'live/settlements?page=0', { headers: authA });
      assert.equal(forged.response.status, 503);
      assert.equal(forged.body.code, 'RUNWAY_SETTLEMENT_INTEGRITY_INVALID');
      await jsonRequest(root + 'data', {
        method: 'DELETE', headers: { ...authA, 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: 'DELETE_RUNWAY_DATA' }),
      });
      assert.equal(await RunwaySettlement.countDocuments({ userId: userA }), 0);
      assert.equal(await RunwayLedgerRevision.countDocuments({ userId: userA }), 0);
    });
  } finally { await teardownTestDatabase(); }
});
