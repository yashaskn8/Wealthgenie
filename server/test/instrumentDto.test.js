import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
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
  assert.equal(instrumentListQuerySchema.validate({ type: 'Planning_Strategy' }).error, undefined);
  assert.equal(instrumentListQuerySchema.validate({ type: 'Insurance_Archetype' }).error, undefined);
  assert.equal(instrumentListQuerySchema.validate({ type: 'Equity_Archetype' }).error, undefined);
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

test('old Mongo and Redis rows cannot publish a combined term-cover plus fund return', () => {
  const stale = {
    id: 'term_mf_combo', name: 'Term Insurance + Mutual Fund', type: 'Mutual_Fund',
    expectedReturn: 12.75, rate: 12.75, interestRate: 12.75,
    returns1yr: 17.5, expenseRatio: 0.012, risk: 3, lockIn: 0,
    taxType: 'ltcg', desc: 'Guaranteed combined strategy return',
  };
  for (const dto of [
    serializeInstrument(stale),
    serializeCachedInstrumentPage({ instruments: [stale], total: 1, page: 1, pageSize: 20 }).instruments[0],
  ]) {
    assert.equal(dto.type, 'Planning_Strategy');
    assert.equal(dto.expectedReturn, null);
    assert.equal(dto.rate, null);
    assert.equal(dto.returns1yr, undefined);
    assert.equal(dto.expenseRatio, null);
    assert.equal(dto.risk, null);
    assert.equal(dto.lockIn, null);
    assert.equal(dto.taxType, null);
    assert.match(dto.desc, /not one investable product/i);
  }
});

test('the unavailable planning-strategy DTO satisfies the public OpenAPI contract', () => {
  const contract = parse(readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ strict: false }).compile(contract.components.schemas.Instrument);
  const dto = serializeInstrument({ id: 'term_mf_combo', name: 'Old name', expectedReturn: 12.75 });
  assert.equal(validate(dto), true, JSON.stringify(validate.errors));
});

test('old ULIP Mongo and Redis rows cannot publish a blanket tax exemption or return', () => {
  const stale = {
    id: 'ulip', name: 'Unit Linked Insurance Plan', type: 'Mutual_Fund',
    expectedReturn: 10.25, rate: 10.25, returns1yr: 14.5,
    taxType: 'eee', expenseRatio: 0.02, risk: 3, lockIn: 5,
    desc: 'Guaranteed tax-free return',
  };
  const contract = parse(readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ strict: false }).compile(contract.components.schemas.Instrument);
  for (const dto of [
    serializeInstrument(stale),
    serializeCachedInstrumentPage({ instruments: [stale], total: 1, page: 1, pageSize: 20 }).instruments[0],
  ]) {
    assert.equal(dto.type, 'Insurance_Archetype');
    assert.equal(dto.expectedReturn, null);
    assert.equal(dto.returns1yr, undefined);
    assert.equal(dto.taxType, null);
    assert.equal(dto.expenseRatio, null);
    assert.equal(dto.risk, null);
    assert.equal(dto.lockIn, null);
    assert.match(dto.desc, /qualified product and taxpayer facts/i);
    assert.equal(validate(dto), true, JSON.stringify(validate.errors));
  }
});

test('old endowment Mongo and Redis rows cannot publish fabricated plans, return or exemption', () => {
  const stale = {
    id: 'endowment_plan', name: 'Endowment Insurance Policy', type: 'Mutual_Fund',
    expectedReturn: 5.5, rate: 5.5, returns1yr: 6,
    taxType: 'eee', expenseRatio: 0.025, risk: 2, lockIn: 10,
    desc: 'Guaranteed low risk and tax-free return',
  };
  const contract = parse(readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ strict: false }).compile(contract.components.schemas.Instrument);
  for (const dto of [
    serializeInstrument(stale),
    serializeCachedInstrumentPage({ instruments: [stale], total: 1, page: 1, pageSize: 20 }).instruments[0],
  ]) {
    assert.equal(dto.type, 'Insurance_Archetype');
    assert.equal(dto.expectedReturn, null);
    assert.equal(dto.returns1yr, undefined);
    assert.equal(dto.taxType, null);
    assert.equal(dto.expenseRatio, null);
    assert.equal(dto.risk, null);
    assert.equal(dto.lockIn, null);
    assert.match(dto.desc, /exact insurer illustration/i);
    assert.equal(validate(dto), true, JSON.stringify(validate.errors));
  }
});

test('old blue-chip Mongo and Redis rows cannot publish brokers as securities or a fund return', () => {
  const stale = {
    id: 'bluechip_stocks', name: 'Nifty 50 Blue-Chip Stocks', type: 'ETF',
    expectedReturn: 14, rate: 14, returns1yr: 21,
    taxType: 'ltcg', expenseRatio: 0, risk: 4, lockIn: 0,
    desc: 'Guaranteed 14% return through broker apps',
  };
  const contract = parse(readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ strict: false }).compile(contract.components.schemas.Instrument);
  for (const dto of [
    serializeInstrument(stale),
    serializeCachedInstrumentPage({ instruments: [stale], total: 1, page: 1, pageSize: 20 }).instruments[0],
  ]) {
    assert.equal(dto.type, 'Equity_Archetype');
    assert.equal(dto.expectedReturn, null);
    assert.equal(dto.returns1yr, undefined);
    assert.equal(dto.taxType, null);
    assert.equal(dto.expenseRatio, null);
    assert.equal(dto.risk, null);
    assert.equal(dto.lockIn, null);
    assert.match(dto.desc, /not one investable product/i);
    assert.equal(validate(dto), true, JSON.stringify(validate.errors));
  }
});
