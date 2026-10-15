import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import AuditRecord from '../models/AuditRecord.js';
import recommendRoutes from '../routes/recommend.js';
import { correlationIdMiddleware } from '../middleware/correlation.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { withServer, jsonRequest } from '../test-utils/httpTestUtils.js';
import { calculateAuditRecordHash } from '../services/auditChain.js';
import { setRedisAvailable, setRedisClient } from '../config/redis.js';
import { withMockAuthAccountState } from './helpers/mockAuthAccountState.js';

process.env.JWT_SECRET = 'recommendation-audit-provenance-test-secret';
process.env.NODE_ENV = 'test';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(correlationIdMiddleware);
  app.use('/api/recommend', recommendRoutes);
  app.use(errorHandler);
  return app;
}

function queryResult(records) {
  return {
    sort() { return this; },
    skip() { return this; },
    limit() { return this; },
    async lean() { return records; },
  };
}

test('audit list and detail fail closed for unproven legacy adjustments without mutating records', async () => {
  const userId = new mongoose.Types.ObjectId();
  const token = jwt.sign({ userId: String(userId), role: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const listRecord = {
    _id: new mongoose.Types.ObjectId(),
    userId,
    currentAllocationSource: 'MARKET_CONTEXT_ADJUSTED',
    recommendations: { instruments: [{ id: 'fixture', allocationWeight: 1 }] },
    record_hash: 'a'.repeat(64),
  };
  const detailRecord = {
    _id: new mongoose.Types.ObjectId(),
    userId,
    recommendations: {
      marketAdjustment: { applied: true, status: 'APPLIED' },
      allocationSource: 'MARKET_CONTEXT_ADJUSTED',
    },
    record_hash: 'b'.repeat(64),
  };
  const storedBefore = JSON.stringify({ listRecord, detailRecord });
  const originalFind = AuditRecord.find;
  const originalCountDocuments = AuditRecord.countDocuments;
  const originalFindById = AuditRecord.findById;
  const originalSave = AuditRecord.prototype.save;
  const originalUpdateOne = AuditRecord.updateOne;
  AuditRecord.find = () => queryResult([listRecord]);
  AuditRecord.countDocuments = async () => 1;
  AuditRecord.findById = () => ({ async lean() { return detailRecord; } });
  AuditRecord.prototype.save = () => { throw new Error('audit route must not mutate history'); };
  AuditRecord.updateOne = () => { throw new Error('audit route must not mutate history'); };

  try {
    await withMockAuthAccountState(() => withServer(buildApp(), async baseUrl => {
      const headers = { Authorization: `Bearer ${token}` };
      const list = await jsonRequest(`${baseUrl}/api/recommend/audit?limit=10&skip=0`, { headers });
      assert.equal(list.response.status, 503);
      assert.equal(list.body.code, 'MARKET_ADJUSTMENT_PROVIDER_PROVENANCE_MISSING');

      const detail = await jsonRequest(`${baseUrl}/api/recommend/audit/${detailRecord._id}`, { headers });
      assert.equal(detail.response.status, 503);
      assert.equal(detail.body.code, 'MARKET_ADJUSTMENT_PROVIDER_PROVENANCE_MISSING');
    }));
    assert.equal(JSON.stringify({ listRecord, detailRecord }), storedBefore, 'read gates must not alter persisted audit payloads');
  } finally {
    AuditRecord.find = originalFind;
    AuditRecord.countDocuments = originalCountDocuments;
    AuditRecord.findById = originalFindById;
    AuditRecord.prototype.save = originalSave;
    AuditRecord.updateOne = originalUpdateOne;
  }
});

test('audit HTTP reads gate hash-bound UPSTOX and NSE outputs under production policy without writes', async () => {
  const userId = new mongoose.Types.ObjectId();
  const token = jwt.sign({ userId: String(userId), role: 'user', jti: 'audit-route-production-jti' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const originalNodeEnv = process.env.NODE_ENV;
  const originalUpstoxConfirmation = process.env.UPSTOX_PUBLIC_MARKET_DATA_LICENSE_CONFIRMED;
  const originalFind = AuditRecord.find;
  const originalCountDocuments = AuditRecord.countDocuments;
  const originalFindById = AuditRecord.findById;
  const originalUpdateOne = AuditRecord.updateOne;
  let auditRecord;
  AuditRecord.find = () => queryResult([auditRecord]);
  AuditRecord.countDocuments = async () => 1;
  AuditRecord.findById = () => ({ async lean() { return auditRecord; } });
  AuditRecord.updateOne = () => { throw new Error('audit reads must not issue writes'); };

  const buildHashBoundAudit = sourceProvider => {
    const record = {
      _id: new mongoose.Types.ObjectId(),
      userId,
      profileId: new mongoose.Types.ObjectId(),
      recommendationId: new mongoose.Types.ObjectId(),
      correlationId: `audit-provider-${sourceProvider.toLowerCase()}`,
      traceId: '',
      version_id: 'fixture-model-v1',
      regulatory_rule_version: 'fixture-rules-v1',
      input_hash: 'e'.repeat(64),
      inputs: { fixture: true },
      recommendations: {
        allocationSource: 'MARKET_CONTEXT_ADJUSTED',
        marketAdjustment: {
          applied: true,
          status: 'APPLIED',
          currentAllocationSource: 'MARKET_CONTEXT_ADJUSTED',
          sourceProvider,
        },
      },
      cited_rag_chunk_ids: [],
      engine: 'rule_based',
      timestamp: new Date('2026-10-14T00:00:00.000Z'),
      previous_hash: 'GENESIS',
      hash_algorithm: 'sha256',
      schema_version: '1.0',
      chain_sequence: 1,
    };
    record.record_hash = calculateAuditRecordHash(record);
    return record;
  };

  try {
    process.env.NODE_ENV = 'production';
    setRedisClient({ async get() { return null; } });
    setRedisAvailable(true);
    for (const scenario of [
      { provider: 'UPSTOX', confirmation: undefined, expectedStatus: 503 },
      { provider: 'NSE', confirmation: undefined, expectedStatus: 200 },
      { provider: 'UPSTOX', confirmation: 'true', expectedStatus: 200 },
    ]) {
      if (scenario.confirmation === undefined) delete process.env.UPSTOX_PUBLIC_MARKET_DATA_LICENSE_CONFIRMED;
      else process.env.UPSTOX_PUBLIC_MARKET_DATA_LICENSE_CONFIRMED = scenario.confirmation;
      auditRecord = buildHashBoundAudit(scenario.provider);
      const storedBefore = JSON.stringify(auditRecord);

      await withMockAuthAccountState(() => withServer(buildApp(), async baseUrl => {
        const headers = { Authorization: `Bearer ${token}` };
        const list = await jsonRequest(`${baseUrl}/api/recommend/audit?limit=10&skip=0`, { headers });
        assert.equal(list.response.status, scenario.expectedStatus, `${scenario.provider} audit list status`);
        if (scenario.expectedStatus === 503) {
          assert.equal(list.body.code, 'UPSTOX_PUBLIC_DISTRIBUTION_NOT_CONFIRMED');
        } else {
          assert.equal(list.body.records[0].record_hash, auditRecord.record_hash);
        }

        const detail = await jsonRequest(`${baseUrl}/api/recommend/audit/${auditRecord._id}`, { headers });
        assert.equal(detail.response.status, scenario.expectedStatus, `${scenario.provider} audit detail status`);
        if (scenario.expectedStatus === 503) {
          assert.equal(detail.body.code, 'UPSTOX_PUBLIC_DISTRIBUTION_NOT_CONFIRMED');
        } else {
          assert.equal(detail.body.record.record_hash, auditRecord.record_hash);
        }
      }));
      assert.equal(JSON.stringify(auditRecord), storedBefore, `${scenario.provider} audit reads must not mutate the hash-bound record`);
      assert.equal(auditRecord.record_hash, calculateAuditRecordHash(auditRecord), `${scenario.provider} audit hash remains valid`);
    }
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalUpstoxConfirmation === undefined) delete process.env.UPSTOX_PUBLIC_MARKET_DATA_LICENSE_CONFIRMED;
    else process.env.UPSTOX_PUBLIC_MARKET_DATA_LICENSE_CONFIRMED = originalUpstoxConfirmation;
    setRedisAvailable(false);
    setRedisClient(null);
    AuditRecord.find = originalFind;
    AuditRecord.countDocuments = originalCountDocuments;
    AuditRecord.findById = originalFindById;
    AuditRecord.updateOne = originalUpdateOne;
  }
});
