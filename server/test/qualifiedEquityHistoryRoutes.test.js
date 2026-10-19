import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createMarketDataAdminRouter } from '../routes/marketDataAdmin.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { jsonRequest, withServer } from '../test-utils/httpTestUtils.js';

const query = 'exchange=NSE&symbol=RELIANCE&isin=INE002A01018&fromDate=2026-10-15&toDate=2026-10-16';
const body = {
  exchange: 'NSE', symbol: 'RELIANCE', isin: 'INE002A01018',
  fromDate: '2026-10-15', toDate: '2026-10-16', basis: 'RAW',
};
test('qualified EOD APIs enforce admin-only writes, validation and authenticated readback', async () => {
  const calls = [];
  const router = createMarketDataAdminRouter({
    authenticate(req, res, next) {
      const t = req.headers.authorization;
      if (t !== 'Bearer user' && t !== 'Bearer admin') {
        res.status(401).json({ code: 'AUTH_REQUIRED' }); return;
      }
      req.user = { userId: '64a000000000000000000001',
        role: t === 'Bearer admin' ? 'admin' : 'user' };
      next();
    },
    authorizeAdmin(req, res, next) {
      if (req.user.role !== 'admin') { res.status(403).json({ code: 'AUTH_ROLE_REQUIRED' }); return; }
      next();
    },
    limiter(_req, _res, next) { next(); },
    fetchHistory: async value => {
      calls.push(['fetch', value]); return { status: 'AVAILABLE', candles: [{ close: 100 }] };
    },
    persistHistory: async (_snapshot, value) => {
      calls.push(['store', value]); return { status: 'PERSISTED', written: 1 };
    },
    readStoredHistory: async value => {
      calls.push(['read', value]); return { status: 'AVAILABLE', bars: [{ tradingDate: '2026-10-15', close: 100 }] };
    },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/market-data', router);
  app.use(errorHandler);
  await withServer(app, async base => {
    const root = base + '/api/market-data/';
    const unauth = await jsonRequest(root + 'equity-history/persisted?' + query);
    assert.equal(unauth.response.status, 401);
    const normalRead = await jsonRequest(root + 'equity-history/persisted?' + query, {
      headers: { Authorization: 'Bearer user' },
    });
    assert.equal(normalRead.response.status, 200);
    assert.equal(normalRead.body.bars[0].tradingDate, '2026-10-15');
    assert.equal(normalRead.response.headers.get('cache-control'), 'private, no-store');
    const noAdminWrite = await jsonRequest(root + 'admin/equity-history/ingest', {
      method: 'POST', body: JSON.stringify(body), headers: { Authorization: 'Bearer user' },
    });
    assert.equal(noAdminWrite.response.status, 403);
    const invalid = await jsonRequest(root + 'admin/equity-history/ingest', {
      method: 'POST', body: JSON.stringify({ ...body, fromDate: '2026-02-30' }),
      headers: { Authorization: 'Bearer admin' },
    });
    assert.equal(invalid.response.status, 400);
    assert.equal(calls.length, 1);
    const write = await jsonRequest(root + 'admin/equity-history/ingest', {
      method: 'POST', body: JSON.stringify(body), headers: { Authorization: 'Bearer admin' },
    });
    assert.equal(write.response.status, 201);
    assert.equal(write.body.written, 1);
    assert.deepEqual(calls.map(call => call[0]), ['read', 'fetch', 'store']);
  });
});
