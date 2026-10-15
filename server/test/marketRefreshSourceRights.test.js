import assert from 'node:assert/strict';
import test from 'node:test';
import { respondToManualMarketRefresh } from '../routes/market.js';

test('manual market refresh reports unqualified source rights instead of claiming completion', () => {
  const response = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  const request = { correlationId: 'rights-request-id' };
  const result = respondToManualMarketRefresh(request, response, [
    { status: 'fulfilled', value: {
      status: 'UNAVAILABLE',
      error: { code: 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED' },
      persistence: { status: 'NOT_PERSISTED' },
    } },
    { status: 'fulfilled', value: { status: 'UNAVAILABLE', reasonCodes: ['MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED'] } },
  ]);

  assert.equal(result, response);
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, 'MARKET_DATA_SOURCE_RIGHTS_UNVERIFIED');
  assert.equal(response.body.request_id, request.correlationId);
  assert.match(response.body.message, /source-use permission is not qualified/i);
});
