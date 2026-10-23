import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { canonicalSha256 } from '../utils/canonicalJson.js';
import User from '../models/User.js';
import FinancialProfile from '../models/FinancialProfile.js';
import Goal from '../models/Goal.js';
import Recommendation from '../models/Recommendation.js';
import { RunwayLedgerRevision, RunwaySnapshot } from '../models/Runway.js';
import { setupTestDatabase, teardownTestDatabase } from './helpers/mongoTestHelper.js';
import { withServer, jsonRequest } from '../test-utils/httpTestUtils.js';

process.env.NODE_ENV = 'test';
process.env.DISABLE_RATE_LIMIT = 'true';
process.env.JWT_SECRET ||= 'runway-mongo-integration-test-secret';
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

      const original = await RunwaySnapshot.collection.findOne({ _id: snapshot.body.snapshotId });
      await RunwaySnapshot.collection.updateOne({ _id: snapshot.body.snapshotId },
        { $set: { 'result.disclaimer': 'Forged reassurance' } });
      const corrupted = await jsonRequest(ownedBase + 'snapshots/' + snapshot.body.snapshotId, { headers: authA });
      assert.equal(corrupted.response.status, 503);
      assert.equal(corrupted.body.code, 'RUNWAY_INTEGRITY_UNAVAILABLE');
      const forgedExplanation = await mutation(base, 'explanations', { snapshotId: snapshot.body.snapshotId });
      assert.equal(forgedExplanation.response.status, 503);
      assert.equal(forgedExplanation.body.code, 'RUNWAY_INTEGRITY_UNAVAILABLE');
      const forgedReplay = await mutation(base, 'snapshots', request, authA, 'runway-snapshot-001');
      assert.equal(forgedReplay.response.status, 503);
      assert.equal(forgedReplay.body.code, 'RUNWAY_INTEGRITY_UNAVAILABLE');
      await RunwaySnapshot.collection.updateOne({ _id: snapshot.body.snapshotId },
        { $set: { 'result.disclaimer': original.result.disclaimer } });
      const historicalResult = { ...original.result, engineVersion: 'runway-cashflow-0.9.0' };
      await RunwaySnapshot.collection.updateOne({ _id: snapshot.body.snapshotId },
        { $set: { result: historicalResult, resultHash: canonicalSha256(historicalResult) } });
      const oldEngineRead = await jsonRequest(ownedBase + 'snapshots/' + snapshot.body.snapshotId, { headers: authA });
      assert.equal(oldEngineRead.response.status, 200);
      assert.equal(oldEngineRead.body.engineStatus, 'HISTORICAL_ENGINE');
      assert.equal(oldEngineRead.body.verification, 'STORED_HASH_ONLY');
      const historicalExplanation = await mutation(base, 'explanations', { snapshotId: snapshot.body.snapshotId });
      assert.equal(historicalExplanation.response.status, 200);
      assert.equal(historicalExplanation.body.engineStatus, 'HISTORICAL_ENGINE');
      await RunwaySnapshot.collection.updateOne({ _id: snapshot.body.snapshotId },
        { $set: { result: original.result, resultHash: original.resultHash } });

      const updatedLedger = { ...ledger, openingCashPaise: '9000' };
      const raced = await Promise.all([
        write(base, updatedLedger, 1, 'runway-race-001'),
        write(base, { ...ledger, openingCashPaise: '8000' }, 1, 'runway-race-002'),
      ]);
      assert.deepEqual(raced.map(x => x.response.status).sort(), [201, 409]);
      const current = await jsonRequest(ownedBase + 'current', { headers: authA });
      assert.equal(current.body.revision, 2);
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
