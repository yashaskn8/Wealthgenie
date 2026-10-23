import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import express from 'express';
import coverageRoutes from '../routes/coverage.js';
import { errorHandler } from '../middleware/errorHandler.js';
import CoverageLedger from '../models/CoverageLedger.js';
import CoverageResult from '../models/CoverageResult.js';
import CoverageDeletionReceipt from '../models/CoverageDeletionReceipt.js';
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
    const app = express();
    app.use(express.json());
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
    const replay = await call(owner, 'PUT', '/ledger', submitted, 0, firstKey);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.revision, 1);
    assert.equal(await CoverageResult.countDocuments({ userId: owner }), 1);

    const stale = await call(owner, 'PUT', '/ledger', submitted, 0, randomUUID());
    assert.equal(stale.status, 409);
    const sameKeyOtherRevision = await call(owner, 'PUT', '/ledger', submitted, 1, firstKey);
    assert.equal(sameKeyOtherRevision.status, 409);
    assert.equal(sameKeyOtherRevision.body.code, 'IDEMPOTENCY_PAYLOAD_CONFLICT');
    // Independent owner: two clients race on the same confirmed revision.
    const racer = new mongoose.Types.ObjectId();
    const racerBase = payload();
    assert.equal((await call(racer, 'PUT', '/ledger', racerBase, 0, randomUUID())).status, 200);
    const race = await Promise.all([
      call(racer, 'PUT', '/ledger', { ...racerBase, openingCashPaise: 80_000 }, 1, randomUUID()),
      call(racer, 'PUT', '/ledger', { ...racerBase, openingCashPaise: 90_000 }, 1, randomUUID()),
    ]);
    assert.deepEqual(race.map(r => r.status).sort(), [200, 409]);
    assert.equal((await call(racer, 'GET', '/ledger')).body.revision, 2);
    assert.equal(await CoverageResult.countDocuments({ userId: racer }), 2);
    const otherRead = await call(other, 'GET', '/ledger');
    assert.equal(otherRead.status, 200);
    assert.equal(otherRead.body.revision, 0);
    assert.equal((await call(other, 'GET', '/revisions/1')).status, 404);
    assert.equal((await call(other, 'DELETE', '/ledger', undefined, 1, randomUUID())).status, 409);

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
    const preview = await call(owner, 'POST', '/scenarios/preview',
      { revision: 2, excludedVoluntaryEntryIds: ['sip_confirmed'] });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.result.status, 'NO_SHORTFALL_IN_ENTERED_PLAN');
    assert.equal(await CoverageResult.countDocuments({ userId: owner }), 2);
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
    assert.deepEqual((await call(owner, 'GET', '/export')).body.records, []);
    assert.equal(await CoverageDeletionReceipt.countDocuments({ userId: owner }), 1);
    assert.equal((await call(owner, 'GET', '/revisions/1')).status, 404);
    const deletedRead = await call(owner, 'GET', '/ledger');
    assert.equal(deletedRead.body.revision, 3);
    assert.equal(deletedRead.body.ledger, null);
    assert.equal(deletedRead.body.deleted, true);
    assert.equal((await call(owner, 'PUT', '/ledger', submitted, 0, randomUUID())).status, 409);
    assert.equal((await call(owner, 'PUT', '/ledger', submitted, 2, randomUUID())).status, 409);
    const newPlan = await call(owner, 'PUT', '/ledger', submitted, 3, randomUUID());
    assert.equal(newPlan.status, 200);
    assert.equal(newPlan.body.revision, 4);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await teardownTestDatabase();
  }
});
