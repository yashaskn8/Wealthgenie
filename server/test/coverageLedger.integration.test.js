import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import express from 'express';
import coverageRoutes from '../routes/coverage.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { createCsrfProtection } from '../middleware/csrf.js';
import CoverageLedger from '../models/CoverageLedger.js';
import User from '../models/User.js';
import CoverageResult from '../models/CoverageResult.js';
import CoverageDeletionReceipt from '../models/CoverageDeletionReceipt.js';
import CoverageRiskAlert from '../models/CoverageRiskAlert.js';
import CoverageSettlement from '../models/CoverageSettlement.js';
import { sweepStaleCashDeclarations } from '../jobs/coverageRiskAlerts.js';
import { setupTestDatabase, teardownTestDatabase } from './helpers/mongoTestHelper.js';

const SECRET = 'cash-check-isolated-integration-secret';
process.env.JWT_SECRET = SECRET;
process.env.NODE_ENV = 'test';

function indiaToday() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const fields = Object.fromEntries(parts.filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return fields.year + '-' + fields.month + '-' + fields.day;
}
const ownerToken = userId => jwt.sign({ userId: String(userId) }, SECRET, { expiresIn: '1h' });
const payload = () => ({
  asOfDate: indiaToday(),
  openingCashPaise: 20_000,
  cashSource: 'USER_DECLARED_BANK_CASH',
  completenessConfirmed: true,
  entries: [{
    id: 'rent', label: 'Rent', type: 'ESSENTIAL_PAYMENT',
    amountPaise: 19_000, startDate: indiaToday(), recurrence: 'ONCE',
  }],
});

test('coverage: atomic revisions, replay fencing, ownership, preview and deletion', async () => {
  let server;
  let baseUrl;
  try {
    await setupTestDatabase({ requireReplicaSet: true });
    const owner = new mongoose.Types.ObjectId();
    const other = new mongoose.Types.ObjectId();
    // Authentication validates current account existence, not just JWT syntax.
    // Create actual accounts rather than bypassing verification in the test.
    const makeUser = id => ({
      _id: id, name: 'Coverage Test Account',
      email: 'coverage-' + String(id) + '@example.invalid',
      passwordHash: 'not-a-usable-login-hash',
      role: 'user',
    });
    await User.create([makeUser(owner), makeUser(other)]);
    const app = express();
    app.use(express.json());
    app.use('/api', createCsrfProtection({
      isProduction: true, allowedOrigins: ['https://coverage.example.test'],
    }));
    app.use('/api/coverage', coverageRoutes);
    app.use(errorHandler);
    await new Promise(resolve => {
      server = app.listen(0, '127.0.0.1', () => {
        baseUrl = 'http://127.0.0.1:' + server.address().port + '/api/coverage';
        resolve();
      });
    });
    async function call(userId, method, path, body, revision, key) {
      const headers = { Authorization: 'Bearer ' + ownerToken(userId) };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (revision !== undefined) headers['If-Match'] = '"' + revision + '"';
      if (key) headers['Idempotency-Key'] = key;
      const r = await fetch(baseUrl + path, {
        method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: r.status, body: await r.json() };
    }
    assert.deepEqual((await call(owner, 'GET', '/ledger')).body,
      { revision: 0, ledger: null, latestResult: null });
    // Every cash surface must authenticate before touching sensitive data.
    for (const [method, target, body] of [
      ['GET', '/ledger'],
      ['GET', '/revisions/1'],
      ['GET', '/export'],
      ['POST', '/scenarios/preview', { revision: 1, excludedVoluntaryEntryIds: [] }],
      ['PUT', '/ledger', payload()],
      ['DELETE', '/ledger'],
    ]) {
      const response = await fetch(baseUrl + target, {
        method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      assert.equal(response.status, 401, method + ' ' + target + ' must authenticate');
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    // Mutation preconditions are mandatory even for an authenticated owner.
    assert.equal((await call(owner, 'PUT', '/ledger', payload(), undefined, randomUUID())).status, 428);
    assert.equal((await call(owner, 'DELETE', '/ledger', undefined, undefined, randomUUID())).status, 428);

    const yesterday = new Date(Date.parse(indiaToday() + 'T00:00:00Z') - 86_400_000).toISOString().slice(0, 10);
    const staleDeclaration = await call(owner, 'PUT', '/ledger', {
      ...payload(), asOfDate: yesterday,
    }, 0, randomUUID());
    assert.equal(staleDeclaration.status, 400);
    const firstKey = randomUUID();
    const submitted = payload();
    const first = await call(owner, 'PUT', '/ledger', submitted, 0, firstKey);
    assert.equal(first.status, 200);
    assert.equal(first.body.revision, 1);
    assert.equal(first.body.result.status, 'NO_SHORTFALL_IN_ENTERED_PLAN');
    assert.equal((await call(owner, 'GET', '/alerts')).status, 200);
    assert.deepEqual((await call(owner, 'GET', '/alerts')).body.alerts, []);
    assert.equal(await CoverageRiskAlert.countDocuments({ userId: owner }), 0);
    const replay = await call(owner, 'PUT', '/ledger', submitted, 0, firstKey);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.revision, 1);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.superseded, false);
    assert.equal(await CoverageResult.countDocuments({ userId: owner }), 1);

    // Real browser cookie-session mutations require double-submit CSRF AND
    // a production-allowlisted Origin. Bearer clients are tested separately.
    const cookie = 'wg_session=' + ownerToken(owner) + '; wg_csrf=csrf-test-token';
    const cookiePreview = async extra => {
      const response = await fetch(baseUrl + '/scenarios/preview', {
        method: 'POST',
        headers: {
          Cookie: cookie, 'Content-Type': 'application/json', ...extra,
        },
        body: JSON.stringify({ revision: 1, excludedVoluntaryEntryIds: [] }),
      });
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await cookiePreview({ Origin: 'https://coverage.example.test' })).status, 403);
    assert.equal((await cookiePreview({
      Origin: 'https://attacker.example.test', 'X-CSRF-Token': 'csrf-test-token',
    })).status, 403);
    const csrfAccepted = await cookiePreview({
      Origin: 'https://coverage.example.test', 'X-CSRF-Token': 'csrf-test-token',
    });
    assert.equal(csrfAccepted.status, 200);
    assert.equal(csrfAccepted.body.revision, 1);
    // An idempotent replay of the current revision is not a fresh-policy
    // calculation if its stored model policy has since been retired.
    const firstSnapshot = await CoverageResult.findOne({ userId: owner, ledgerRevision: 1 });
    await CoverageResult.collection.updateOne({ _id: firstSnapshot._id }, {
      $set: { policyVersion: 'retired-policy-before-replay' },
    });
    const retiredReplay = await call(owner, 'PUT', '/ledger', submitted, 0, firstKey);
    assert.equal(retiredReplay.status, 200);
    assert.equal(retiredReplay.body.replayed, true);
    assert.equal(retiredReplay.body.superseded, true);
    assert.equal(retiredReplay.body.currentRevision, 1);
    await CoverageResult.collection.updateOne({ _id: firstSnapshot._id }, {
      $set: { policyVersion: firstSnapshot.policyVersion },
    });

    const stale = await call(owner, 'PUT', '/ledger', submitted, 0, randomUUID());
    assert.equal(stale.status, 409);
    const sameKeyOtherRevision = await call(owner, 'PUT', '/ledger', submitted, 1, firstKey);
    assert.equal(sameKeyOtherRevision.status, 409);
    assert.equal(sameKeyOtherRevision.body.code, 'IDEMPOTENCY_PAYLOAD_CONFLICT');
    // Independent owner: two clients race on the same confirmed revision.
    const racer = new mongoose.Types.ObjectId();
    await User.create(makeUser(racer));
    const racerBase = payload();
    assert.equal((await call(racer, 'PUT', '/ledger', racerBase, 0, randomUUID())).status, 200);
    const race = await Promise.all([
      call(racer, 'PUT', '/ledger', { ...racerBase, openingCashPaise: 80_000 }, 1, randomUUID()),
      call(racer, 'PUT', '/ledger', { ...racerBase, openingCashPaise: 90_000 }, 1, randomUUID()),
    ]);
    assert.deepEqual(race.map(r => r.status).sort(), [200, 409]);
    assert.equal((await call(racer, 'GET', '/ledger')).body.revision, 2);
    assert.equal(await CoverageResult.countDocuments({ userId: racer }), 2);
    // Crash injection: a failing snapshot insert must roll back the ledger CAS,
    // leaving no apparently-current calculation without an immutable result.
    const crashOwner = new mongoose.Types.ObjectId();
    await User.create(makeUser(crashOwner));
    const beforeCrash = payload();
    assert.equal((await call(crashOwner, 'PUT', '/ledger', beforeCrash, 0, randomUUID())).status, 200);
    const originalCreate = CoverageResult.create;
    CoverageResult.create = async function injectedSnapshotFailure(documents, options) {
      if (String(documents?.[0]?.userId) === String(crashOwner)
          && documents?.[0]?.ledgerRevision === 2) {
        throw new Error('INJECTED_SNAPSHOT_WRITE_FAILURE');
      }
      return originalCreate.call(this, documents, options);
    };
    try {
      const crashed = await call(crashOwner, 'PUT', '/ledger', {
        ...beforeCrash, openingCashPaise: 30_000,
      }, 1, randomUUID());
      assert.equal(crashed.status, 500);
    } finally {
      CoverageResult.create = originalCreate;
    }
    const retainedAfterCrash = await CoverageLedger.findOne({ userId: crashOwner }).lean();
    assert.equal(retainedAfterCrash.revision, 1);
    assert.equal(retainedAfterCrash.input.openingCashPaise, 20_000);
    assert.equal(await CoverageResult.countDocuments({ userId: crashOwner }), 1);
    const recoveredAfterCrash = await call(crashOwner, 'PUT', '/ledger', {
      ...beforeCrash, openingCashPaise: 30_000,
    }, 1, randomUUID());
    assert.equal(recoveredAfterCrash.status, 200);
    assert.equal(recoveredAfterCrash.body.revision, 2);

    const otherRead = await call(other, 'GET', '/ledger');
    assert.equal(otherRead.status, 200);
    assert.equal(otherRead.body.revision, 0);
    assert.equal((await call(other, 'GET', '/revisions/1')).status, 404);
    assert.equal((await call(other, 'DELETE', '/ledger', undefined, 1, randomUUID())).status, 409);

    // Never infer bank settlement: explicit one-off user confirmation plus
    // a fresh cash balance are mandatory. Commit cash, immutable history and
    // the settlement record under the same If-Match/idempotency identity.
    const settledOwner = new mongoose.Types.ObjectId();
    await User.create(makeUser(settledOwner));
    const originalBill = await call(settledOwner, 'PUT', '/ledger', payload(), 0, randomUUID());
    assert.equal(originalBill.status, 200);
    const unconfirmedPayment = await call(settledOwner, 'POST', '/commitments/rent/settle', {
      asOfDate: indiaToday(), openingCashPaise: 1000,
      completenessConfirmed: true, settlementConfirmed: false,
    }, 1, randomUUID());
    assert.equal(unconfirmedPayment.status, 400);
    const settlementBody = {
      asOfDate: indiaToday(), openingCashPaise: 1000,
      completenessConfirmed: true, settlementConfirmed: true,
    };
    // The settlement record is inseparable from the new cash revision.
    const originalSettlementCreate = CoverageSettlement.create;
    CoverageSettlement.create = async function injectedSettlementOutage(rows, options) {
      if (String(rows?.[0]?.userId) === String(settledOwner)) {
        throw new Error('INJECTED_SETTLEMENT_AUDIT_FAILURE');
      }
      return originalSettlementCreate.call(this, rows, options);
    };
    try {
      const missingAudit = await call(settledOwner, 'POST', '/commitments/rent/settle',
        settlementBody, 1, randomUUID());
      assert.equal(missingAudit.status, 500);
    } finally { CoverageSettlement.create = originalSettlementCreate; }
    assert.equal((await CoverageLedger.findOne({ userId: settledOwner }).lean()).revision, 1);
    assert.equal(await CoverageResult.countDocuments({ userId: settledOwner }), 1);
    assert.equal(await CoverageSettlement.countDocuments({ userId: settledOwner }), 0);
    const settlementKey = randomUUID();
    const paid = await call(settledOwner, 'POST', '/commitments/rent/settle',
      settlementBody, 1, settlementKey);
    assert.equal(paid.status, 200);
    assert.equal(paid.body.revision, 2);
    assert.equal(paid.body.result.status, 'NO_SHORTFALL_IN_ENTERED_PLAN');
    assert.equal(paid.body.bankVerified, false);
    const paymentReplay = await call(settledOwner, 'POST', '/commitments/rent/settle',
      settlementBody, 1, settlementKey);
    assert.equal(paymentReplay.status, 200);
    assert.equal(paymentReplay.body.revision, 2);
    assert.equal(paymentReplay.body.replayed, true);
    const paidLedger = await call(settledOwner, 'GET', '/ledger');
    assert.equal(paidLedger.body.revision, 2);
    assert.equal(paidLedger.body.ledger.openingCashPaise, 1000);
    assert.deepEqual(paidLedger.body.ledger.entries, []);
    assert.equal((await call(settledOwner, 'POST', '/commitments/rent/settle',
      settlementBody, 1, randomUUID())).status, 409);
    assert.equal((await call(other, 'GET', '/settlements')).body.settlements.length, 0);
    const settlementHistory = await call(settledOwner, 'GET', '/settlements');
    assert.equal(settlementHistory.status, 200);
    assert.equal(settlementHistory.body.settlements.length, 1);
    assert.equal(settlementHistory.body.settlements[0].entryId, 'rent');
    assert.equal(settlementHistory.body.settlements[0].amountPaise, 19000);
    assert.equal(settlementHistory.body.settlements[0].provenance, 'USER_CONFIRMED_NOT_BANK_VERIFIED');
    const settlementExport = await call(settledOwner, 'GET', '/settlements?afterRevision=0&limit=1');
    assert.equal(settlementExport.status, 200);
    assert.equal(settlementExport.body.settlements.length, 1);
    assert.equal(settlementExport.body.nextAfterRevision, null);
    assert.equal((await call(other, 'GET', '/settlements?afterRevision=0')).body.settlements.length, 0);
    assert.equal((await call(settledOwner, 'GET', '/settlements?afterRevision=bad')).status, 400);
    assert.equal(await CoverageSettlement.countDocuments({ userId: settledOwner }), 1);
    const settleDeleted = await call(settledOwner, 'DELETE', '/ledger', undefined, 2, randomUUID());
    assert.equal(settleDeleted.status, 200);
    assert.equal(await CoverageSettlement.countDocuments({ userId: settledOwner }), 0);
    assert.deepEqual((await call(settledOwner, 'GET', '/settlements')).body.settlements, []);

    // A risk-event persistence outage must roll back the ledger and immutable
    // snapshot, not leave a cash forecast without its necessary notification.
    const originalAlertCreate = CoverageRiskAlert.create;
    CoverageRiskAlert.create = async function injectedAlertOutage(rows, options) {
      if (String(rows?.[0]?.userId) === String(owner)
          && rows?.[0]?.kind === 'SHORTFALL_DETECTED') {
        throw new Error('INJECTED_RISK_ALERT_OUTBOX_FAILURE');
      }
      return originalAlertCreate.call(this, rows, options);
    };
    try {
      const failedRisk = await call(owner, 'PUT', '/ledger', {
        ...submitted,
        entries: [...submitted.entries, {
          id: 'sip_confirmed', label: 'Chosen SIP', type: 'VOLUNTARY_CONTRIBUTION',
          amountPaise: 8_000, startDate: indiaToday(), recurrence: 'ONCE',
        }],
      }, 1, randomUUID());
      assert.equal(failedRisk.status, 500);
    } finally { CoverageRiskAlert.create = originalAlertCreate; }
    assert.equal((await CoverageLedger.findOne({ userId: owner }).lean()).revision, 1);
    assert.equal(await CoverageResult.countDocuments({ userId: owner }), 1);
    assert.equal(await CoverageRiskAlert.countDocuments({ userId: owner }), 0);

    const second = await call(owner, 'PUT', '/ledger', {
      ...submitted,
      entries: [...submitted.entries, {
        id: 'sip_confirmed', label: 'Chosen SIP', type: 'VOLUNTARY_CONTRIBUTION',
        amountPaise: 8_000, startDate: indiaToday(), recurrence: 'ONCE',
      }],
    }, 1, randomUUID());
    assert.equal(second.status, 200);
    assert.equal(second.body.revision, 2);
    assert.equal(second.body.result.status, 'SHORTFALL_IN_ENTERED_PLAN');
    const riskInbox = await call(owner, 'GET', '/alerts');
    assert.equal(riskInbox.status, 200);
    assert.equal(riskInbox.body.revision, 2);
    assert.equal(riskInbox.body.alerts.length, 1);
    assert.equal(riskInbox.body.alerts[0].kind, 'SHORTFALL_DETECTED');
    assert.equal(riskInbox.body.alerts[0].acknowledged, false);
    const riskId = riskInbox.body.alerts[0].id;
    assert.equal((await call(other, 'PATCH', '/alerts/' + riskId + '/ack', {})).status, 404);
    assert.equal((await call(other, 'GET', '/alerts')).body.alerts.length, 0);
    assert.equal((await call(owner, 'PATCH', '/alerts/' + riskId + '/ack', {})).status, 200);
    assert.equal((await call(owner, 'PATCH', '/alerts/' + riskId + '/ack', {})).status, 200);
    assert.equal((await call(owner, 'GET', '/alerts')).body.alerts[0].acknowledged, true);
    assert.equal((await call(owner, 'GET', '/alerts?limit=21')).status, 400);
    // Worker never calculates risk from yesterday's money; it generates a
    // durable once-per-revision reconfirmation warning instead.
    const tomorrow = new Date(Date.parse(indiaToday() + 'T00:00:00Z') + 2 * 86400000);
    const firstSweep = await sweepStaleCashDeclarations({ now: tomorrow, limit: 100 });
    assert.ok(firstSweep.created >= 1);
    const secondSweep = await sweepStaleCashDeclarations({ now: tomorrow, limit: 100 });
    assert.equal(secondSweep.created, 0);
    const staleEvents = await CoverageRiskAlert.find({
      userId: owner, kind: 'CASH_RECONFIRMATION_REQUIRED',
    }).lean();
    assert.equal(staleEvents.length, 1);
    assert.equal(staleEvents[0].ledgerRevision, 2);
    const lateReplay = await call(owner, 'PUT', '/ledger', submitted, 0, firstKey);
    assert.equal(lateReplay.status, 200);
    assert.equal(lateReplay.body.revision, 1);
    assert.equal(lateReplay.body.replayed, true);
    assert.equal(lateReplay.body.superseded, true);
    assert.equal(lateReplay.body.currentRevision, 2);
    const preview = await call(owner, 'POST', '/scenarios/preview',
      { revision: 2, excludedVoluntaryEntryIds: ['sip_confirmed'] });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.result.status, 'NO_SHORTFALL_IN_ENTERED_PLAN');
    assert.equal(await CoverageResult.countDocuments({ userId: owner }), 2);
    // Simulated policy rollout: old user-owned history stays readable/exportable
    // but the current plan requires explicit reconfirmation before presentation.
    const currentSnapshot = await CoverageResult.findOne({ userId: owner, ledgerRevision: 2 });
    await CoverageResult.collection.updateOne({ _id: currentSnapshot._id }, {
      $set: { policyVersion: 'retired-cash-policy-v0' },
    });
    const policyRead = await call(owner, 'GET', '/ledger');
    assert.equal(policyRead.status, 200);
    assert.equal(policyRead.body.requiresPolicyReconfirmation, true);
    assert.equal(policyRead.body.latestResult.policyVersion, 'retired-cash-policy-v0');
    const blockedOldPreview = await call(owner, 'POST', '/scenarios/preview',
      { revision: 2, excludedVoluntaryEntryIds: ['sip_confirmed'] });
    assert.equal(blockedOldPreview.status, 409);
    assert.equal(blockedOldPreview.body.code, 'COVERAGE_POLICY_RECONFIRMATION_REQUIRED');
    const exportAcrossPolicies = await call(owner, 'GET', '/export?afterRevision=1');
    assert.equal(exportAcrossPolicies.status, 200);
    assert.equal(exportAcrossPolicies.body.records.length, 1);
    assert.equal(exportAcrossPolicies.body.records[0].policyVersion, 'retired-cash-policy-v0');
    const policyRevision = await call(owner, 'GET', '/revisions/2');
    assert.equal(policyRevision.status, 200);
    assert.equal(policyRevision.body.policyVersion, 'retired-cash-policy-v0');
    await CoverageResult.collection.updateOne({ _id: currentSnapshot._id }, {
      $set: { policyVersion: currentSnapshot.policyVersion },
    });
    const policyCurrent = await call(owner, 'GET', '/ledger');
    assert.equal(policyCurrent.body.requiresPolicyReconfirmation, false);
    const exportFirst = await call(owner, 'GET', '/export?limit=1');
    assert.equal(exportFirst.status, 200);
    assert.equal(exportFirst.body.records.length, 1);
    assert.equal(exportFirst.body.nextAfterRevision, 1);
    assert.equal(exportFirst.body.records[0].revision, 1);
    const exportSecond = await call(owner, 'GET', '/export?limit=1&afterRevision=1');
    assert.equal(exportSecond.status, 200);
    assert.equal(exportSecond.body.records.length, 1);
    assert.equal(exportSecond.body.nextAfterRevision, null);
    assert.equal(exportSecond.body.records[0].revision, 2);
    const foreignExport = await call(other, 'GET', '/export');
    assert.equal(foreignExport.status, 200);
    assert.deepEqual(foreignExport.body.records, []);
    assert.equal((await call(owner, 'GET', '/export?limit=21')).status, 400);

    const deletionKey = randomUUID();
    const deleted = await call(owner, 'DELETE', '/ledger', undefined, 2, deletionKey);
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.deleted, true);
    const deleteReplay = await call(owner, 'DELETE', '/ledger', undefined, 2, deletionKey);
    assert.equal(deleteReplay.status, 200);
    assert.equal(deleteReplay.body.deletedRevision, 2);
    const fenced = await CoverageLedger.findOne({ userId: owner }).lean();
    assert.equal(fenced.revision, 3);
    assert.equal(fenced.input, null);
    assert.ok(fenced.deletedAt);
    assert.equal(deleted.body.nextRevision, 3);
    assert.equal(await CoverageLedger.countDocuments({ userId: owner }), 1);
    assert.equal(await CoverageResult.countDocuments({ userId: owner }), 0);
    assert.equal(await CoverageRiskAlert.countDocuments({ userId: owner }), 0);
    await sweepStaleCashDeclarations({ now: tomorrow, limit: 100 });
    assert.equal(await CoverageRiskAlert.countDocuments({ userId: owner }), 0,
      'background stale-cash sweep must never resurrect deleted financial alerts');
    assert.deepEqual((await call(owner, 'GET', '/alerts')).body.alerts, []);
    assert.deepEqual((await call(owner, 'GET', '/export')).body.records, []);
    assert.equal(await CoverageDeletionReceipt.countDocuments({ userId: owner }), 1);
    assert.equal((await call(owner, 'GET', '/revisions/1')).status, 404);
    const deletedRead = await call(owner, 'GET', '/ledger');
    assert.equal(deletedRead.body.revision, 3);
    assert.equal(deletedRead.body.ledger, null);
    assert.equal(deletedRead.body.deleted, true);
    assert.equal((await call(owner, 'PUT', '/ledger', submitted, 0, randomUUID())).status, 409);
    assert.equal((await call(owner, 'PUT', '/ledger', submitted, 2, randomUUID())).status, 409);
    assert.equal((await call(owner, 'POST', '/scenarios/preview',
      { revision: 3, excludedVoluntaryEntryIds: [] })).status, 409);
    const newPlan = await call(owner, 'PUT', '/ledger', submitted, 3, randomUUID());
    assert.equal(newPlan.status, 200);
    assert.equal(newPlan.body.revision, 4);
    // A cryptographically valid token for a deleted account cannot read
    // sensitive saved cash plans or their historical revisions.
    await User.deleteOne({ _id: owner });
    assert.equal((await call(owner, 'GET', '/ledger')).status, 401);
    assert.equal((await call(owner, 'GET', '/export')).status, 401);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await teardownTestDatabase();
  }
});
