import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeCachedInstrumentPage, serializeInstrument, serializeInstrumentPage } from '../services/instrumentDto.js';
import { instrumentListQuerySchema } from '../validation/schemas.js';

test('instrument public serializer excludes persistence and unreviewed future model fields', () => {
  const dto = serializeInstrument({
    _id: 'private-document-id', __v: 9, secretInternalNotes: 'do not expose',
    id: 'catalog:fd:test', name: 'Test Bank Deposit', type: 'FD', interestRate: 7.1,
    eligibility: { minAge: 18, notes: 'Published eligibility', internalReview: 'private' },
  });
  assert.deepEqual(dto, {
    id: 'catalog:fd:test', name: 'Test Bank Deposit', type: 'FD', interestRate: 7.1,
    eligibility: { minAge: 18, notes: 'Published eligibility' },
  });
  for (const hidden of ['_id', '__v', 'secretInternalNotes']) assert.equal(dto[hidden], undefined);
});

test('instrument page DTO and query reject coercive or unknown filter input', () => {
  const page = serializeInstrumentPage({ instruments: [], total: 0, page: 1, pageSize: 20 });
  assert.deepEqual(page, { instruments: [], total: 0, page: 1, pageSize: 20, totalPages: 0 });
  assert.equal(instrumentListQuerySchema.validate({ limit: '20garbage' }).error !== undefined, true);
  assert.equal(instrumentListQuerySchema.validate({ unexpected: 'broadens-query' }).error !== undefined, true);
  assert.equal(instrumentListQuerySchema.validate({ limit: '20', page: '2', sort: 'name', order: 'asc' }).error, undefined);
});

test('category/subcategory catalog query accepts real labels and rejects unsafe or unknown fields', () => {
  const accepted = instrumentListQuerySchema.validate({
    category: 'REITs & InvITs', subCategory: 'Listed REITs', limit: '20', page: '1',
  });
  assert.equal(accepted.error, undefined);
  assert.equal(accepted.value.category, 'REITs & InvITs');
  assert.equal(instrumentListQuerySchema.validate({ category: '' }).error !== undefined, true);
  assert.equal(instrumentListQuerySchema.validate({ subCategory: 'x'.repeat(101) }).error !== undefined, true);
  assert.equal(instrumentListQuerySchema.validate({ category: { $ne: 'Debt' } }).error !== undefined, true);
  assert.equal(instrumentListQuerySchema.validate({ category: 'Equity\nFake' }).error !== undefined, true);
  assert.equal(instrumentListQuerySchema.validate({ unknown: 'Equity' }).error !== undefined, true);
});

test('instrument cache entries are reserialized through the public DTO allowlist', () => {
  const cached = serializeCachedInstrumentPage({
    instruments: [{
      id: 'catalog:fd:cached',
      name: 'Cached Deposit',
      type: 'FD',
      internalPersistenceFlag: 'must-not-escape',
      futurePrivateField: { owner: 'internal' },
    }],
    total: 1,
    page: 1,
    pageSize: 20,
    totalPages: 99,
    internalCacheVersion: 'old',
  });
  assert.deepEqual(cached, {
    instruments: [{ id: 'catalog:fd:cached', name: 'Cached Deposit', type: 'FD' }],
    total: 1,
    page: 1,
    pageSize: 20,
    totalPages: 1,
  });
  assert.equal(serializeCachedInstrumentPage([{ id: 'catalog:fd:legacy', name: 'Legacy raw response' }]), null);
  assert.equal(serializeCachedInstrumentPage({ instruments: [{ name: 'Missing public ID' }], total: 1, page: 1, pageSize: 20 }), null);
});
