import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { setupTestDatabase, teardownTestDatabase } from './helpers/mongoTestHelper.js';
import { withServer, jsonRequest } from '../test-utils/httpTestUtils.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { createDecisionsRouter } from '../routes/decisionScenarios.js';
import { createDecisionEventsRouter } from '../routes/decisionEvents.js';
import { createDecisionMonitorRoutes } from '../routes/decisionMonitor.js';
import { scanDecisionMonitors } from '../services/genieDecision/monitor.js';
import DecisionMonitor from '../models/DecisionMonitor.js';
import DecisionAssessment from '../models/DecisionAssessment.js';
import DecisionWorkerHeartbeat from '../models/DecisionWorkerHeartbeat.js';
import { createDecisionWorkerHeartbeat } from '../services/genieDecision/workerHeartbeat.js';
import DecisionEvent from '../models/DecisionEvent.js';
import DecisionEventState from '../models/DecisionEventState.js';
import { canonicalProfile } from './helpers/canonicalProfile.js';
import User from '../models/User.js';
import FinancialProfile from '../models/FinancialProfile.js';
import FinancialProfileState from '../models/FinancialProfileState.js';
import DecisionScenario from '../models/DecisionScenario.js';
import DecisionScenarioRevision from '../models/DecisionScenarioRevision.js';
import DecisionRun from '../models/DecisionRun.js';
import { signDecisionReceipt } from '../services/genieDecision/integrity.js';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'geniedecision-test-secret-only-2026';
process.env.DISABLE_RATE_LIMIT = 'true';
process.env.GENIEDECISION_MONITOR_ENABLED = 'true';
const userOne = new mongoose.Types.ObjectId();
const userTwo = new mongoose.Types.ObjectId();
let profile;
function token(userId) {
  return jwt.sign({ userId: String(userId), role: 'user' }, process.env.JWT_SECRET,
    { expiresIn: '30m' });
}
function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/decisions', createDecisionsRouter());
  instance.use('/api/decisions', createDecisionEventsRouter());
  instance.use('/api/decisions', createDecisionMonitorRoutes());
  instance.use(errorHandler);
  return instance;
}
function call(base, userId, path, method = 'GET', body, key) {
  return jsonRequest(`${base}/api/decisions${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      authorization: `Bearer ${token(userId)}`,
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
  });
}
const scenarioInput = () => ({
  profileId: String(profile._id), expectedProfileStateRevision: 1,
  title: 'My income interruption assessment', scenarioType: 'INCOME_INTERRUPTION',
  horizonMonths: 6,
  baseline: {
    monthlyLivingExpenses: '50000.00', monthlyDebtPayments: '20000.00',
    monthlyInvestments: '20000.00',
  },
  goalReservations: [{ goalId: 'retirement', monthlyAllocation: '10000.00' }],
  details: { startMonth: 2, durationMonths: 3, incomeLossPerMonth: '100000.00' },
});
test.before(async () => {
  await setupTestDatabase({ requireReplicaSet: true });
  for (const model of [DecisionScenario, DecisionScenarioRevision, DecisionRun,
    DecisionEvent, DecisionEventState, DecisionMonitor, DecisionAssessment, DecisionWorkerHeartbeat]) {
    await model.createIndexes();
  }
  await User.create([
    { _id: userOne, name: 'Decision Test One', email: `decision-${userOne}@example.test`, passwordHash: 'test-password-hash' },
    { _id: userTwo, name: 'Decision Test Two', email: `decision-${userTwo}@example.test`, passwordHash: 'test-password-hash' },
  ]);
  profile = await FinancialProfile.create({
    userId: userOne, ...canonicalProfile({
      monthlyTakeHome: 100000, monthlySavings: 30000, liquidSavings: 100000,
    }), recommendationProfileVersion: 'financial-profile-1.0.0',
  });
  await FinancialProfileState.create({
    userId: userOne, currentProfileId: profile._id,
    resolutionStatus: 'CURRENT', revision: 1, promotionFence: 0,
  });
});
test.after(async () => { await teardownTestDatabase(); });

test('scenario persists atomically, replays idempotently, revisions are append-only, and cross-user reads are denied', async () => {
  await withServer(app(), async base => {
    const payload = scenarioInput();
    const creation = await call(base, userOne, '/scenarios', 'POST', payload, 'decision-create-0001');
    assert.equal(creation.response.status, 201, JSON.stringify(creation.body));
    assert.equal(creation.response.headers.get('cache-control'), 'private, no-store, max-age=0');
    assert.equal(creation.response.headers.get('pragma'), 'no-cache');
    const id = creation.body.scenario.id;
    assert.equal(creation.body.scenario.revision, 1);
    const ownerEvents = await call(base, userOne, '/events?after=0');
    assert.equal(ownerEvents.response.status, 200);
    assert.equal(ownerEvents.body.resetRequired, false);
    assert.deepEqual(ownerEvents.body.events.map(event => event.type), ['SCENARIO_CREATED']);
    assert.deepEqual(Object.keys(ownerEvents.body.events[0]).sort(),
      ['createdAt', 'scenarioId', 'scenarioRevision', 'sequence', 'type']);
    // End-to-end SSE: credentials are header-scoped, the server emits only
    // owner events and the receiver can abort without leaving a live lease.
    const streamController = new AbortController();
    const streamDeadline = setTimeout(() => streamController.abort(), 6000);
    try {
      const stream = await fetch(`${base}/api/decisions/events/stream?after=0`, {
        headers: { authorization: `Bearer ${token(userOne)}`, accept: 'text/event-stream' },
        signal: streamController.signal,
      });
      assert.equal(stream.status, 200);
      assert.match(stream.headers.get('content-type'), /^text\/event-stream/);
      const reader = stream.body.getReader();
      const decoder = new TextDecoder();
      let observed = '';
      const expires = Date.now() + 4000;
      while (!observed.includes('event: decision') && Date.now() < expires) {
        const next = await reader.read();
        if (next.done) break;
        observed += decoder.decode(next.value);
      }
      assert.ok(observed.includes('event: connected'), 'Stream handshake must complete');
      assert.ok(observed.includes('event: decision'), 'Stream must replay a committed owner event');
      assert.ok(observed.includes('SCENARIO_CREATED'));
      assert.ok(!observed.includes('monthlyTakeHome'), 'Never send financial data in SSE notifications');
      assert.ok(!observed.includes('100000.00'), 'Never send financial amounts in SSE notifications');
    } finally {
      clearTimeout(streamDeadline);
      streamController.abort();
    }
    const noSseAccept = await call(base, userOne, '/events/stream?after=0');
    assert.equal(noSseAccept.response.status, 406);

    const otherEvents = await call(base, userTwo, '/events?after=0');
    assert.equal(otherEvents.response.status, 200);
    assert.deepEqual(otherEvents.body.events, []);
    assert.equal(otherEvents.body.latestSequence, 0);
    assert.equal(otherEvents.response.headers.get('cache-control'), 'no-store, no-transform');

    const simulation = await call(base, userOne, '/simulate', 'POST', payload);
    assert.equal(simulation.response.status, 200, JSON.stringify(simulation.body));
    assert.equal(simulation.body.previewOnly, true);
    assert.equal(simulation.body.status, 'PARTIAL');
    assert.equal(simulation.body.result.alternatives.length, 2);
    assert.equal(await DecisionRun.countDocuments({ userId: userOne }), 0,
      'Live simulation must not persist a report or mutate a portfolio');
    assert.equal(await DecisionEvent.countDocuments({ userId: userOne }), 1,
      'Live simulation must not publish a decision event');

    const replay = await call(base, userOne, '/scenarios', 'POST', payload, 'decision-create-0001');
    assert.equal(replay.response.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.scenario.id, id);
    assert.equal(await DecisionEvent.countDocuments({ userId: userOne }), 1,
      'idempotency replay must not write another notification');

    const collision = await call(base, userOne, '/scenarios', 'POST',
      { ...payload, title: 'Different decision input' }, 'decision-create-0001');
    assert.equal(collision.response.status, 409);
    assert.equal(collision.body.code, 'IDEMPOTENCY_PAYLOAD_CONFLICT');

    const forbidden = await call(base, userTwo, `/scenarios/${id}`);
    assert.equal(forbidden.response.status, 404);
    assert.equal(forbidden.response.headers.get('cache-control'), 'private, no-store, max-age=0');

    // A database-side mutation which forgets to advance the financial state
    // revision must still make the pinned scenario unusable for new writes.
    await FinancialProfile.collection.updateOne({ _id: profile._id },
      { $set: { monthlySavings: 31000 } });
    try {
      const blocked = await call(base, userOne, `/scenarios/${id}`, 'PATCH', {
        expectedRevision: 1, title: 'Must not recompute on changed profile facts',
        horizonMonths: payload.horizonMonths, baseline: payload.baseline,
        goalReservations: payload.goalReservations, details: payload.details,
      });
      assert.equal(blocked.response.status, 409);
      assert.equal(blocked.body.code, 'DECISION_STALE_PROFILE');
    } finally {
      await FinancialProfile.collection.updateOne({ _id: profile._id },
        { $set: { monthlySavings: 30000 } });
    }

    const modified = await call(base, userOne, `/scenarios/${id}`, 'PATCH', {
      expectedRevision: 1, title: 'Revised income scenario', horizonMonths: payload.horizonMonths,
      baseline: payload.baseline, goalReservations: payload.goalReservations,
      details: payload.details,
    });
    assert.equal(modified.response.status, 200, JSON.stringify(modified.body));
    assert.equal(modified.body.scenario.revision, 2);

    const oldRevision = await DecisionScenarioRevision.findOne({
      userId: userOne, scenarioId: id, revision: 1,
    }).lean();
    assert.equal(oldRevision.payload.title, payload.title);
    assert.equal(oldRevision.revision, 1);
    const staleEdit = await call(base, userOne, `/scenarios/${id}`, 'PATCH', {
      expectedRevision: 1, title: 'Conflicting edit', horizonMonths: payload.horizonMonths,
      baseline: payload.baseline, goalReservations: payload.goalReservations,
      details: payload.details,
    });
    assert.equal(staleEdit.response.status, 409);
    assert.equal(staleEdit.body.code, 'DECISION_REVISION_CONFLICT');
    assert.equal(await DecisionEvent.countDocuments({ userId: userOne }), 2,
      'failed edit must not publish an event');

    const evaluated = await call(base, userOne, `/scenarios/${id}/evaluate`, 'POST',
      { expectedRevision: 2 }, 'decision-evaluate-0001');
    assert.equal(evaluated.response.status, 201, JSON.stringify(evaluated.body));
    const reportId = evaluated.body.run.id;
    assert.equal(evaluated.body.run.status, 'PARTIAL');
    assert.equal(evaluated.body.run.result.alternatives.length, 2);
    assert.match(evaluated.body.run.result.financialInputFingerprint, /^[0-9a-f]{64}$/);

    const evalReplay = await call(base, userOne, `/scenarios/${id}/evaluate`, 'POST',
      { expectedRevision: 2 }, 'decision-evaluate-0001');
    assert.equal(evalReplay.response.status, 200);
    assert.equal(evalReplay.body.run.id, reportId);
    assert.equal(evalReplay.body.replayed, true);
    assert.equal(await DecisionEvent.countDocuments({ userId: userOne }), 3,
      'replayed evaluation must publish no duplicate event');

    const beforePointerAttack = await DecisionScenario.findById(id).lean();
    assert.equal(String(beforePointerAttack.lastRunId), reportId);
    await DecisionScenario.collection.updateOne({ _id: beforePointerAttack._id }, {
      $set: { lastRunId: new mongoose.Types.ObjectId() },
    });
    const misbound = await call(base, userOne, `/scenarios/${id}`);
    assert.equal(misbound.response.status, 503);
    assert.equal(misbound.body.code, 'DECISION_RUN_POINTER_INTEGRITY_FAILURE');
    const misboundList = await call(base, userOne, '/scenarios');
    assert.equal(misboundList.response.status, 503);
    assert.equal(misboundList.body.code, 'DECISION_RUN_POINTER_INTEGRITY_FAILURE');
    await DecisionScenario.collection.updateOne({ _id: beforePointerAttack._id }, {
      $set: { lastRunId: beforePointerAttack.lastRunId },
    });
    const restoredPointer = await call(base, userOne, `/scenarios/${id}`);
    assert.equal(restoredPointer.response.status, 200);

    const slot = await DecisionScenario.findById(id).lean();
    assert.ok(Number.isInteger(slot.quotaSlot) && slot.quotaSlot >= 0 && slot.quotaSlot < 50);
    // The same evaluation key is a durable receipt for revision 2 even after
    // the scenario advances to revision 3. It must not be recomputed.
    const third = await call(base, userOne, `/scenarios/${id}`, 'PATCH', {
      expectedRevision: 2, title: 'Edited after published report', horizonMonths: payload.horizonMonths,
      baseline: payload.baseline, goalReservations: payload.goalReservations,
      details: payload.details,
    });
    assert.equal(third.response.status, 200);
    assert.equal(third.body.scenario.revision, 3);
    const eventsAfterFirst = await call(base, userOne, '/events?after=1');
    assert.equal(eventsAfterFirst.response.status, 200);
    assert.deepEqual(eventsAfterFirst.body.events.map(item => item.type),
      ['SCENARIO_UPDATED', 'RUN_PUBLISHED', 'SCENARIO_UPDATED']);
    assert.deepEqual(eventsAfterFirst.body.events.map(item => item.sequence), [2, 3, 4]);
    const postEditReplay = await call(base, userOne, `/scenarios/${id}/evaluate`, 'POST',
      { expectedRevision: 2 }, 'decision-evaluate-0001');
    assert.equal(postEditReplay.response.status, 200, JSON.stringify(postEditReplay.body));
    assert.equal(postEditReplay.body.run.id, reportId);
    assert.equal(postEditReplay.body.replayed, true);
    assert.equal(postEditReplay.body.run.status, 'HISTORICAL');
    assert.deepEqual(postEditReplay.body.run.reasonCodes, ['DECISION_SCENARIO_REVISION_SUPERSEDED']);

    const runList = await call(base, userOne, `/scenarios/${id}/runs`);
    assert.equal(runList.response.status, 200, JSON.stringify(runList.body));
    assert.equal(runList.body.runs.length, 1);
    assert.equal(runList.body.runs[0].id, reportId);
    assert.equal(runList.body.runs[0].status, 'HISTORICAL');
    assert.equal(Object.hasOwn(runList.body.runs[0], 'result'), false);
    const otherUserRunList = await call(base, userTwo, `/scenarios/${id}/runs`);
    assert.equal(otherUserRunList.response.status, 404);
    const changedKey = await call(base, userOne, `/scenarios/${id}/evaluate`, 'POST',
      { expectedRevision: 3 }, 'decision-evaluate-0001');
    assert.equal(changedKey.response.status, 409);
    assert.equal(changedKey.body.code, 'IDEMPOTENCY_PAYLOAD_CONFLICT');

    const secret = await call(base, userTwo, `/runs/${reportId}`);
    assert.equal(secret.response.status, 404);

    await FinancialProfileState.updateOne({ userId: userOne }, { $inc: { revision: 1 } });
    const history = await call(base, userOne, `/runs/${reportId}`);
    assert.equal(history.response.status, 200);
    assert.equal(history.body.run.status, 'HISTORICAL');
    assert.equal(history.body.run.originalStatus, 'PARTIAL');

    // A profile mutation that bypasses the normal version increment cannot
    // silently preserve a report's CURRENT classification.
    await FinancialProfile.collection.updateOne({ _id: profile._id },
      { $set: { monthlySavings: 31000 } });
    const drifted = await call(base, userOne, `/runs/${reportId}`);
    assert.equal(drifted.response.status, 200);
    assert.ok(drifted.body.run.reasonCodes.includes('DECISION_CANONICAL_FACTS_CHANGED'));
    await FinancialProfile.collection.updateOne({ _id: profile._id },
      { $set: { monthlySavings: 30000 } });

    // A recalculation-policy upgrade does not rewrite history or present an
    // outdated numerical report as if it came from today's code.
    const originalRun = await DecisionRun.findById(reportId).lean();
    // Forging just the revision pointer must not turn a HISTORICAL report
    // into a CURRENT one, even if the underlying input values are equal.
    await DecisionRun.collection.updateOne({ _id: originalRun._id },
      { $set: { profileStateRevision: 2 } });
    const forgedStateRevision = await call(base, userOne, `/runs/${reportId}`);
    assert.equal(forgedStateRevision.response.status, 503);
    assert.equal(forgedStateRevision.body.code, 'DECISION_REPORT_INTEGRITY_FAILURE');
    await DecisionRun.collection.updateOne({ _id: originalRun._id },
      { $set: { profileStateRevision: originalRun.profileStateRevision } });

    assert.equal((await call(base, userOne, `/runs/${reportId}`)).body.run.asOf, originalRun.issuedAt);
    await DecisionRun.collection.updateOne({ _id: originalRun._id },
      { $set: { issuedAt: '2099-01-01T00:00:00.000Z' } });
    const falsifiedFreshness = await call(base, userOne, `/runs/${reportId}`);
    assert.equal(falsifiedFreshness.response.status, 503);
    assert.equal(falsifiedFreshness.body.code, 'DECISION_REPORT_INTEGRITY_FAILURE');
    await DecisionRun.collection.updateOne({ _id: originalRun._id },
      { $set: { issuedAt: originalRun.issuedAt } });

    const previousModelResult = { ...originalRun.result, modelVersion: 'geniedecision-ledger-0.0.1' };
    const oldResultHash = crypto.createHash('sha256').update(JSON.stringify(previousModelResult)).digest('hex');
    // A *legitimately signed* historical report must remain readable but
    // historical. A database attacker without the active signing key cannot
    // construct this signature.
    const oldReceipt = signDecisionReceipt('decision_run', {
      userId: String(originalRun.userId), scenarioId: String(originalRun.scenarioId),
      revision: originalRun.revision, profileId: String(originalRun.profileId),
      profileFactsHash: originalRun.profileFactsHash, inputHash: originalRun.inputHash,
      runKeyHash: originalRun.runKeyHash,
      profileStateRevision: originalRun.profileStateRevision, profileVersion: originalRun.profileVersion,
      profileFinancialFence: originalRun.profileFinancialFence, issuedAt: originalRun.issuedAt,
    }, { resultHash: oldResultHash });
    await DecisionRun.collection.updateOne({ _id: originalRun._id },
      { $set: { result: previousModelResult, resultHash: oldResultHash, ...oldReceipt } });
    const previousPolicy = await call(base, userOne, `/runs/${reportId}`);
    assert.equal(previousPolicy.response.status, 200);
    assert.ok(previousPolicy.body.run.reasonCodes.includes('DECISION_CALCULATION_POLICY_SUPERSEDED'));
    await DecisionRun.collection.updateOne({ _id: originalRun._id },
      { $set: {
        result: originalRun.result, resultHash: originalRun.resultHash,
        integrityKeyId: originalRun.integrityKeyId, integrityTag: originalRun.integrityTag,
      } });

    // Even if a database attacker recomputes the plain SHA-256 hash after
    // changing money, they cannot forge the HMAC receipt with a key not in DB.
    const forgedResult = structuredClone(originalRun.result);
    forgedResult.alternatives[0].endingProjectedLiquidCash = '999999999.00';
    const forgedHash = crypto.createHash('sha256')
      .update(JSON.stringify(forgedResult)).digest('hex');
    await DecisionRun.collection.updateOne({ _id: new mongoose.Types.ObjectId(reportId) },
      { $set: { result: forgedResult, resultHash: forgedHash } });
    const tampered = await call(base, userOne, `/runs/${reportId}`);
    assert.equal(tampered.response.status, 503);
    assert.equal(tampered.body.code, 'DECISION_REPORT_INTEGRITY_FAILURE');

    // A database-only attacker cannot forge displayed scenario titles by
    // modifying the mutable head while keeping the signed revision untouched.
    await DecisionScenario.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) },
      { $set: { title: 'Attacker-controlled headline' } });
    const forgedListing = await call(base, userOne, '/scenarios');
    assert.equal(forgedListing.response.status, 503);
    assert.equal(forgedListing.body.code, 'DECISION_REVISION_INTEGRITY_FAILURE');
    await DecisionScenario.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) },
      { $set: { title: 'Edited after published report' } });
    const restoredListing = await call(base, userOne, '/scenarios');
    assert.equal(restoredListing.response.status, 200);

    const revisionRecord = await DecisionScenarioRevision.findOne({
      userId: userOne, scenarioId: id, revision: 3,
    }).lean();
    const forgedRevision = structuredClone(revisionRecord.payload);
    forgedRevision.title = 'Forger changed decision inputs';
    const forgedRevisionHash = crypto.createHash('sha256')
      .update(JSON.stringify(forgedRevision)).digest('hex');
    await DecisionScenarioRevision.collection.updateOne({ _id: revisionRecord._id }, {
      $set: { payload: forgedRevision, inputHash: forgedRevisionHash },
    });
    const tamperedRevision = await call(base, userOne, `/scenarios/${id}`);
    assert.equal(tamperedRevision.response.status, 503);
    assert.equal(tamperedRevision.body.code, 'DECISION_REVISION_INTEGRITY_FAILURE');

    const deleting = await call(base, userOne, `/scenarios/${id}`, 'DELETE',
      { expectedRevision: 3 });
    assert.equal(deleting.response.status, 200);
    assert.equal(deleting.body.deleted, true);
    const deletionEvents = await call(base, userOne, '/events?after=4');
    assert.equal(deletionEvents.response.status, 200);
    assert.deepEqual(deletionEvents.body.events.map(item => item.type), ['SCENARIO_DELETED']);
    assert.deepEqual(deletionEvents.body.events.map(item => item.sequence), [5]);
    assert.equal(await DecisionEventState.findOne({ userId: userOne }).then(x => x.sequence), 5);
    // Simulate TTL purging earlier event records: a disconnected client must
    // receive an explicit reset rather than silently missing committed work.
    await DecisionEvent.deleteMany({ userId: userOne, sequence: { $lte: 3 } });
    const expired = await call(base, userOne, '/events?after=1');
    assert.equal(expired.response.status, 200);
    assert.equal(expired.body.resetRequired, true);
    assert.equal(expired.body.latestSequence, 5);
    assert.deepEqual(expired.body.events, []);
    const futureCursor = await call(base, userOne, '/events?after=100');
    assert.equal(futureCursor.response.status, 200);
    assert.equal(futureCursor.body.resetRequired, true);

    assert.equal(await DecisionScenario.exists({ _id: id }), null);
    assert.equal(await DecisionScenarioRevision.countDocuments({ scenarioId: id }), 0);
    assert.equal(await DecisionRun.countDocuments({ scenarioId: id }), 0);
    const deletedReport = await call(base, userOne, `/runs/${reportId}`);
    assert.equal(deletedReport.response.status, 404);
  });
});

test('malformed and unauthenticated requests fail before persistence', async () => {
  await withServer(app(), async base => {
    const unauth = await jsonRequest(`${base}/api/decisions/scenarios`, {
      method: 'POST', body: JSON.stringify(scenarioInput()),
    });
    assert.equal(unauth.response.status, 401);
    const invalid = await call(base, userOne, '/scenarios', 'POST', {
      ...scenarioInput(), extraProviderOverride: 'fabricated',
    }, 'decision-malformed-0001');
    assert.equal(invalid.response.status, 400);
    const missingKey = await call(base, userOne, '/scenarios', 'POST', scenarioInput());
    assert.equal(missingKey.response.status, 400);
    const badSimulation = await call(base, userOne, '/simulate', 'POST', {
      ...scenarioInput(), expectedProfileStateRevision: 999,
    });
    assert.equal(badSimulation.response.status, 409);
    assert.equal(await DecisionRun.countDocuments({ userId: userOne }), 0);
    const invalidCursor = await call(base, userOne, '/events?after=-1');
    assert.equal(invalidCursor.response.status, 400);
    const invalidCursorArray = await call(base, userOne, '/events?after=1&after=2');
    assert.equal(invalidCursorArray.response.status, 400);
    const noAuthEvents = await jsonRequest(`${base}/api/decisions/events?after=0`);
    assert.equal(noAuthEvents.response.status, 401);
  });
});


test('monitored decisions create signed candidate assessments, fail closed on changed assumptions and obey opt-out', async () => {
  await withServer(app(), async base => {
    const input = { ...scenarioInput(), expectedProfileStateRevision: 2,
      title: 'Monitor my changing budget' };
    const created = await call(base, userOne, '/scenarios', 'POST', input, 'monitor-test-create-0001');
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    const id = created.body.scenario.id;
    const monitorPath = `/scenarios/${id}/monitor`;
    const unauthWatch = await call(base, userTwo, monitorPath);
    assert.equal(unauthWatch.response.status, 404);

    const initial = await call(base, userOne, monitorPath);
    assert.equal(initial.response.status, 200);
    assert.equal(initial.body.monitor.enabled, false);
    assert.deepEqual(initial.body.assessments, []);
    assert.equal(initial.body.monitor.workerConfigured, false);
    const refusedWithoutWorker = await call(base, userOne, monitorPath, 'PUT',
      { enabled: true, expectedRevision: 1 });
    assert.equal(refusedWithoutWorker.response.status, 503);
    assert.equal(await DecisionMonitor.countDocuments({ userId: userOne, scenarioId: id }), 0);

    // A recent database timestamp is not authenticated proof of a worker.
    await DecisionWorkerHeartbeat.collection.insertOne({
      _id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      heartbeatAt: new Date(), expiresAt: new Date(Date.now() + 60000),
    });
    const spoofedWorker = await call(base, userOne, monitorPath, 'PUT',
      { enabled: true, expectedRevision: 1 });
    assert.equal(spoofedWorker.response.status, 503);
    await DecisionWorkerHeartbeat.collection.deleteOne({
      _id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    const heartbeat = createDecisionWorkerHeartbeat();
    await heartbeat.beat();
    const enabled = await call(base, userOne, monitorPath, 'PUT',
      { enabled: true, expectedRevision: 1 });
    assert.equal(enabled.response.status, 200, JSON.stringify(enabled.body));
    assert.equal(enabled.body.monitor.enabled, true);
    const gen = enabled.body.monitor.generation;
    assert.equal(enabled.body.monitor.workerConfigured, true);
    const consent = await DecisionMonitor.findOne({ userId: userOne, scenarioId: id }).lean();
    assert.match(consent.integrityTag, /^[a-f0-9]{64}$/);
    // An attacker changing a DB boolean cannot manufacture valid user consent.
    await DecisionMonitor.collection.updateOne({ _id: consent._id },
      { $set: { enabled: false } });
    const forgedConsent = await call(base, userOne, monitorPath);
    assert.equal(forgedConsent.response.status, 503);
    assert.equal(forgedConsent.body.code, 'DECISION_MONITOR_CONSENT_INTEGRITY_FAILURE');
    await DecisionMonitor.collection.updateOne({ _id: consent._id },
      { $set: { enabled: true } });
    const repeated = await call(base, userOne, monitorPath, 'PUT',
      { enabled: true, expectedRevision: 1 });
    assert.equal(repeated.response.status, 200);
    assert.equal(repeated.body.monitor.generation, gen);
    const unchanged = await scanDecisionMonitors();
    assert.ok(unchanged.statuses.UNCHANGED >= 1);
    assert.equal(await DecisionAssessment.countDocuments({ userId: userOne, scenarioId: id }), 0);
    const monitorBeforeLease = await DecisionMonitor.findOne({ userId: userOne, scenarioId: id }).lean();
    await DecisionMonitor.collection.updateOne({ _id: monitorBeforeLease._id },
      { $set: { leaseToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        leaseUntil: new Date(Date.now() + 60000) } });
    const noDoubleClaim = await scanDecisionMonitors();
    assert.equal(noDoubleClaim.inspected, 0,
      'A second worker must not claim an unexpired lease');
    await DecisionMonitor.collection.updateOne({ _id: monitorBeforeLease._id },
      { $set: { leaseUntil: new Date(Date.now() - 10) } });
    const crashRecovery = await scanDecisionMonitors();
    assert.equal(crashRecovery.inspected, 1,
      'An abandoned lease must be reclaimed without operator intervention');
    assert.equal(crashRecovery.statuses.UNCHANGED, 1);

    // Income changed but previous expense/debt/savings assumptions no longer
    // reconcile. Publishing a made-up balancing expense would be unacceptable.
    await FinancialProfile.collection.updateOne({ _id: profile._id },
      { $set: { monthlyTakeHome: 90000 } });
    const invalidCandidate = await scanDecisionMonitors();
    assert.equal(invalidCandidate.created, 1, JSON.stringify(invalidCandidate));
    const review = await call(base, userOne, monitorPath);
    assert.equal(review.response.status, 200, JSON.stringify(review.body));
    assert.equal(review.body.assessments[0].originalStatus, 'NEEDS_REVIEW');
    assert.equal(review.body.assessments[0].result, null);
    assert.equal(review.body.assessments[0].requiresUserReview, true);
    const repeatedInvalid = await scanDecisionMonitors();
    assert.equal(repeatedInvalid.created, 0);
    assert.equal(await DecisionAssessment.countDocuments({ userId: userOne, scenarioId: id }), 1);
    const otherRead = await call(base, userTwo, monitorPath);
    assert.equal(otherRead.response.status, 404);

    // Reconciliation restored under *new* source facts: deterministic engine
    // produces a candidate report without updating the old signed run.
    await FinancialProfile.collection.updateOne({ _id: profile._id },
      { $set: { monthlyTakeHome: 110000, monthlySavings: 40000 } });
    const validCandidate = await scanDecisionMonitors();
    assert.equal(validCandidate.created, 1, JSON.stringify(validCandidate));
    const history = await call(base, userOne, monitorPath);
    assert.equal(history.response.status, 200, JSON.stringify(history.body));
    assert.equal(history.body.assessments.length, 2);
    assert.equal(history.body.assessments[0].originalStatus, 'RECALCULATED');
    assert.equal(history.body.assessments[0].result.alternatives.length, 2);
    assert.equal(history.body.assessments[1].status, 'HISTORICAL');
    assert.equal(await DecisionRun.countDocuments({ userId: userOne, scenarioId: id }), 0);
    const latest = await DecisionAssessment.findOne({
      userId: userOne, scenarioId: id, status: 'RECALCULATED',
    }).lean();
    assert.ok(latest.integrityTag);
    // A different canonical profile record with the same visible facts is
    // NOT the same deduplication identity. Insert a deliberately unsigned
    // index-only sentinel, then delete it before any read-path verification.
    const sentinelId = new mongoose.Types.ObjectId();
    await DecisionAssessment.collection.insertOne({
      ...latest, _id: sentinelId, profileId: new mongoose.Types.ObjectId(),
    });
    try {
      assert.equal(await DecisionAssessment.countDocuments({ userId: userOne, scenarioId: id }), 3);
    } finally {
      await DecisionAssessment.collection.deleteOne({ _id: sentinelId });
    }
    assert.equal(latest.sourceSnapshot.facts.length, 3);
    assert.ok(latest.sourceSnapshot.facts.every(fact =>
      fact.verificationStatus === 'DECLARED' && fact.sourceType === 'USER_DECLARED'
      && fact.consentReference === null && fact.observedAt === null));
    assert.equal(history.body.assessments[0].source.sourceSnapshotHash, latest.sourceSnapshotHash);
    assert.equal(history.body.assessments[0].source.facts[1].value, '110000.00');
 
    await DecisionAssessment.collection.updateOne({ _id: latest._id },
      { $set: { 'sourceSnapshot.facts.1.value': '999999.00' } });
    const spoofedSource = await call(base, userOne, monitorPath);
    assert.equal(spoofedSource.response.status, 503);
    assert.equal(spoofedSource.body.code, 'DECISION_ASSESSMENT_INTEGRITY_FAILURE');
    await DecisionAssessment.collection.updateOne({ _id: latest._id },
      { $set: { sourceSnapshot: latest.sourceSnapshot } });
    const modified = await DecisionAssessment.collection.updateOne({ _id: latest._id },
      { $set: { 'result.alternatives.0.endingProjectedLiquidCash': '999999999.00' } });
    assert.equal(modified.modifiedCount, 1);
    const forged = await call(base, userOne, monitorPath);
    assert.equal(forged.response.status, 503);
    assert.equal(forged.body.code, 'DECISION_ASSESSMENT_INTEGRITY_FAILURE');
    await DecisionAssessment.collection.updateOne({ _id: latest._id },
      { $set: { result: latest.result } });

    // Historical evidence must still be browsable when the source-state
    // pointer becomes ambiguous. It must *never* retain a CURRENT badge.
    await FinancialProfileState.collection.updateOne({ userId: userOne },
      { $set: { resolutionStatus: 'LEGACY_AMBIGUOUS' } });
    try {
      const unavailableSourceHistory = await call(base, userOne, monitorPath);
      assert.equal(unavailableSourceHistory.response.status, 200,
        JSON.stringify(unavailableSourceHistory.body));
      assert.ok(unavailableSourceHistory.body.assessments.length >= 2);
      assert.ok(unavailableSourceHistory.body.assessments.every(item =>
        item.status === 'HISTORICAL' && item.isCurrent === false
        && item.requiresUserReview === true));
    } finally {
      await FinancialProfileState.collection.updateOne({ userId: userOne },
        { $set: { resolutionStatus: 'CURRENT' } });
    }

    const off = await call(base, userOne, monitorPath, 'PUT',
      { enabled: false, expectedRevision: 1 });
    assert.equal(off.response.status, 200);
    assert.equal(off.body.monitor.enabled, false);
    await FinancialProfile.collection.updateOne({ _id: profile._id },
      { $set: { monthlyTakeHome: 120000, monthlySavings: 50000 } });
    const afterOff = await scanDecisionMonitors();
    assert.equal(afterOff.created, 0);
    assert.equal(await DecisionAssessment.countDocuments({ userId: userOne, scenarioId: id }), 2);

    await FinancialProfile.collection.updateOne({ _id: profile._id },
      { $set: { monthlyTakeHome: 100000, monthlySavings: 30000 } });
    const deleted = await call(base, userOne, `/scenarios/${id}`, 'DELETE',
      { expectedRevision: 1 });
    assert.equal(deleted.response.status, 200);
    assert.equal(await DecisionMonitor.countDocuments({ userId: userOne, scenarioId: id }), 0);
    assert.equal(await DecisionAssessment.countDocuments({ userId: userOne, scenarioId: id }), 0);
  });
});

test('monitor reassesses signed outdated policy and revised user-approved scenario without invented source updates', async () => {
  await withServer(app(), async base => {
    const input = { ...scenarioInput(), expectedProfileStateRevision: 2,
      title: 'Policy and scenario drift monitor' };
    const creation = await call(base, userOne, '/scenarios', 'POST',
      input, 'decision-policy-monitor-create-0001');
    assert.equal(creation.response.status, 201, JSON.stringify(creation.body));
    const id = creation.body.scenario.id;
    const evaluated = await call(base, userOne, `/scenarios/${id}/evaluate`, 'POST',
      { expectedRevision: 1 }, 'decision-policy-monitor-evaluate-0001');
    assert.equal(evaluated.response.status, 201, JSON.stringify(evaluated.body));
    const report = await DecisionRun.findById(evaluated.body.run.id).lean();
    const oldResult = { ...report.result, modelVersion: 'geniedecision-ledger-0.0.1' };
    const resultHash = crypto.createHash('sha256')
      .update(JSON.stringify(oldResult)).digest('hex');
    // Model a legitimate earlier release: the historical report stays
    // cryptographically authentic but no longer uses the deployed policy.
    const receipt = signDecisionReceipt('decision_run', {
      userId: String(report.userId), scenarioId: String(report.scenarioId),
      revision: report.revision, profileId: String(report.profileId),
      profileFactsHash: report.profileFactsHash, inputHash: report.inputHash,
      runKeyHash: report.runKeyHash,
      profileStateRevision: report.profileStateRevision, profileVersion: report.profileVersion,
      profileFinancialFence: report.profileFinancialFence, issuedAt: report.issuedAt,
    }, { resultHash });
    await DecisionRun.collection.updateOne({ _id: report._id },
      { $set: { result: oldResult, resultHash, ...receipt } });
    const enabled = await call(base, userOne, `/scenarios/${id}/monitor`, 'PUT',
      { enabled: true, expectedRevision: 1 });
    assert.equal(enabled.response.status, 200, JSON.stringify(enabled.body));
    const policy = await scanDecisionMonitors();
    assert.equal(policy.created, 1, JSON.stringify(policy));
    const monitorPath = `/scenarios/${id}/monitor`;
    const beforeRevision = await call(base, userOne, monitorPath);
    assert.equal(beforeRevision.response.status, 200, JSON.stringify(beforeRevision.body));
    assert.equal(beforeRevision.body.assessments[0].reasonCode, 'CALCULATION_POLICY_CHANGED');
    assert.equal(beforeRevision.body.assessments[0].originalStatus, 'RECALCULATED');
    assert.equal(beforeRevision.body.assessments[0].result.alternatives.length, 2);
    const duplicate = await scanDecisionMonitors();
    assert.equal(duplicate.created, 0);
    assert.equal(await DecisionAssessment.countDocuments({ userId: userOne, scenarioId: id }), 1);

    const edited = await call(base, userOne, `/scenarios/${id}`, 'PATCH', {
      expectedRevision: 1, title: 'Revised decision assumptions',
      baseline: input.baseline, horizonMonths: input.horizonMonths,
      goalReservations: input.goalReservations, details: input.details,
    });
    assert.equal(edited.response.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.scenario.revision, 2);
    const revisionRecheck = await scanDecisionMonitors();
    assert.equal(revisionRecheck.created, 1, JSON.stringify(revisionRecheck));
    const afterRevision = await call(base, userOne, monitorPath);
    assert.equal(afterRevision.response.status, 200);
    assert.equal(afterRevision.body.assessments[0].reasonCode, 'SCENARIO_REVISION_CHANGED');
    assert.equal(afterRevision.body.assessments[0].scenarioRevision, 2);
    assert.equal(afterRevision.body.assessments[1].status, 'HISTORICAL');
    assert.equal(await DecisionAssessment.countDocuments({ userId: userOne, scenarioId: id }), 2);
    const removed = await call(base, userOne, `/scenarios/${id}`, 'DELETE',
      { expectedRevision: 2 });
    assert.equal(removed.response.status, 200);
  });
});


test('signed historical decisions remain owner-readable when canonical profile currentness is unavailable', async () => {
  await withServer(app(), async base => {
    const input = { ...scenarioInput(), expectedProfileStateRevision: 2,
      title: 'Historical report when profile currentness is unavailable' };
    const created = await call(base, userOne, '/scenarios', 'POST',
      input, 'decision-history-unavailable-create-0001');
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    const scenarioId = created.body.scenario.id;
    const key = 'decision-history-unavailable-eval-0001';
    const evaluated = await call(base, userOne, `/scenarios/${scenarioId}/evaluate`,
      'POST', { expectedRevision: 1 }, key);
    assert.equal(evaluated.response.status, 201, JSON.stringify(evaluated.body));
    const runId = evaluated.body.run.id;
    const stranger = await call(base, userTwo, `/runs/${runId}`);
    assert.equal(stranger.response.status, 404);
    await FinancialProfileState.collection.updateOne({ userId: userOne },
      { $set: { resolutionStatus: 'LEGACY_AMBIGUOUS' } });
    try {
      const historical = await call(base, userOne, `/runs/${runId}`);
      assert.equal(historical.response.status, 200, JSON.stringify(historical.body));
      assert.equal(historical.body.run.status, 'HISTORICAL');
      assert.equal(historical.body.run.id, runId);
      assert.ok(historical.body.run.reasonCodes.includes('DECISION_SOURCE_PROFILE_SUPERSEDED'));
      const history = await call(base, userOne, `/scenarios/${scenarioId}/runs`);
      assert.equal(history.response.status, 200, JSON.stringify(history.body));
      assert.ok(history.body.runs.some(item => item.id === runId && item.status === 'HISTORICAL'));
      const replay = await call(base, userOne, `/scenarios/${scenarioId}/evaluate`,
        'POST', { expectedRevision: 1 }, key);
      assert.equal(replay.response.status, 200, JSON.stringify(replay.body));
      assert.equal(replay.body.replayed, true);
      assert.equal(replay.body.run.status, 'HISTORICAL');
      const fresh = await call(base, userOne, `/scenarios/${scenarioId}/evaluate`,
        'POST', { expectedRevision: 1 }, 'decision-history-unavailable-eval-0002');
      assert.equal(fresh.response.status, 503,
        'A new assessment must still fail closed until the profile pointer is restored');
    } finally {
      await FinancialProfileState.collection.updateOne({ userId: userOne },
        { $set: { resolutionStatus: 'CURRENT' } });
    }
    const removed = await call(base, userOne, `/scenarios/${scenarioId}`,
      'DELETE', { expectedRevision: 1 });
    assert.equal(removed.response.status, 200, JSON.stringify(removed.body));
  });
});
