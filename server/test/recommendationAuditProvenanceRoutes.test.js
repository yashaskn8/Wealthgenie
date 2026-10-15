import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import AuditRecord from '../models/AuditRecord.js';
import User from '../models/User.js';
import recommendRoutes from '../routes/recommend.js';
import { correlationIdMiddleware } from '../middleware/correlation.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { withServer, jsonRequest } from '../test-utils/httpTestUtils.js';
import { setupTestDatabase, teardownTestDatabase } from './helpers/mongoTestHelper.js';

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
test('audit API denial leaves persisted legacy audit documents byte-equivalent', async () => {
  await setupTestDatabase();
  const userId = new mongoose.Types.ObjectId();
  const profileId = new mongoose.Types.ObjectId();
  const recommendationId = new mongoose.Types.ObjectId();
  const token = jwt.sign({ userId: String(userId), role: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });

  await User.create({
    _id: userId,
    name: 'Audit Provenance Test User',
    email: `audit-provenance-${userId}@example.test`,
    passwordHash: 'test-only-hash',
  });
  const auditEntries = await AuditRecord.create([
    {
      userId,
      profileId,
      recommendationId,
      correlationId: 'audit-provenance-list-legacy',
      version_id: 'fixture-model-v1',
      regulatory_rule_version: 'fixture-rules-v1',
      input_hash: 'a'.repeat(64),
      inputs: { fixture: true },
      recommendations: {
        allocationSource: 'MARKET_CONTEXT_ADJUSTED',
        marketAdjustment: { applied: true, status: 'APPLIED' },
      },
      engine: 'rule_based',
      previous_hash: 'GENESIS',
      record_hash: 'b'.repeat(64),
      hash_algorithm: 'sha256',
      schema_version: '1.0',
      chain_sequence: 1,
    },
    {
      userId,
      profileId,
      recommendationId,
      correlationId: 'audit-provenance-detail-legacy',
      version_id: 'fixture-model-v1',
      regulatory_rule_version: 'fixture-rules-v1',
      input_hash: 'c'.repeat(64),
      inputs: { fixture: true },
      recommendations: {
        instruments: [{ id: 'fixture', allocationWeight: 1 }],
        marketAdjustment: { applied: true, status: 'APPLIED' },
      },
      engine: 'rule_based',
      previous_hash: 'b'.repeat(64),
      record_hash: 'd'.repeat(64),
      hash_algorithm: 'sha256',
      schema_version: '1.0',
      chain_sequence: 2,
    },
  ]);

  try {
    const before = await AuditRecord.collection.find({ userId }).sort({ chain_sequence: 1 }).toArray();
    const beforeJson = JSON.stringify(before);
    await withServer(buildApp(), async baseUrl => {
      const headers = { Authorization: `Bearer ${token}` };
      const list = await jsonRequest(`${baseUrl}/api/recommend/audit?limit=10&skip=0`, { headers });
      assert.equal(list.response.status, 503);
      assert.equal(list.body.code, 'MARKET_ADJUSTMENT_PROVIDER_PROVENANCE_MISSING');

      const detail = await jsonRequest(`${baseUrl}/api/recommend/audit/${auditEntries[1]._id}`, { headers });
      assert.equal(detail.response.status, 503);
      assert.equal(detail.body.code, 'MARKET_ADJUSTMENT_PROVIDER_PROVENANCE_MISSING');
    });
    const after = await AuditRecord.collection.find({ userId }).sort({ chain_sequence: 1 }).toArray();
    assert.equal(JSON.stringify(after), beforeJson, 'denial must not mutate persisted append-only audit documents');
  } finally {
    await AuditRecord.collection.deleteMany({ userId });
    await User.deleteOne({ _id: userId });
    await teardownTestDatabase();
  }
});
