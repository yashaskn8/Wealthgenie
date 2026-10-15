import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import express from 'express';
import jwt from 'jsonwebtoken';
import { setupTestDatabase, teardownTestDatabase } from './helpers/mongoTestHelper.js';
import { canonicalProfilePayload } from './helpers/canonicalProfile.js';

import AuditRecord from '../models/AuditRecord.js';
import User from '../models/User.js';
import FinancialProfile from '../models/FinancialProfile.js';
import Recommendation from '../models/Recommendation.js';
import FinancialProfileState from '../models/FinancialProfileState.js';
import RecommendationState from '../models/RecommendationState.js';
import RecommendationAllocationRevision from '../models/RecommendationAllocationRevision.js';
import IdempotencyKey from '../models/IdempotencyKey.js';
import profileRoutes from '../routes/profile.js';
import recommendRoutes from '../routes/recommend.js';
import { RECOMMENDATION_POLICY_VERSION } from '../services/recommendationProfile.js';
import { getCurrentRegulatoryRuleVersion } from '../services/taxEngine.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { correlationIdMiddleware } from '../middleware/correlation.js';
import { withServer, jsonRequest } from '../test-utils/httpTestUtils.js';
import { assertRuntimeResponseMatchesContract } from './helpers/openapiRuntimeContract.js';

process.env.JWT_SECRET = 'audit-trail-test-secret';
process.env.NODE_ENV = 'test';
process.env.DISABLE_RATE_LIMIT = 'true';

const testUserId = new mongoose.Types.ObjectId();
const otherUserId = new mongoose.Types.ObjectId();
const testToken = jwt.sign({ userId: testUserId.toString(), role: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });
const otherToken = jwt.sign({ userId: otherUserId.toString(), role: 'user' }, process.env.JWT_SECRET, { expiresIn: '1h' });

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(correlationIdMiddleware);
  app.use('/api/profile', profileRoutes);
  app.use('/api/recommend', recommendRoutes);
  app.use(errorHandler);
  return app;
}

describe('AuditRecord - Complete Advisory Audit Trail Verification', () => {
  let profile;

  before(async () => {
    await setupTestDatabase({ requireReplicaSet: true });
    await User.create([
      { _id: testUserId, name: 'Audit Trail Test User', email: `audit-${testUserId}@example.test`, passwordHash: 'test-only-hash' },
      { _id: otherUserId, name: 'Audit Trail Other User', email: `audit-${otherUserId}@example.test`, passwordHash: 'test-only-hash' },
    ]);

    await withServer(buildApp(), async baseUrl => {
      const { response, body } = await jsonRequest(`${baseUrl}/api/profile/complete`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${testToken}`,
          'Idempotency-Key': 'audit-current-profile-setup-001',
        },
        body: JSON.stringify(canonicalProfilePayload({
        monthlyTakeHome: 150000, monthlySavings: 50000, age: 32,
        liquidSavings: 500000, investmentHorizonYears: 15,
        })),
      });
      assert.equal(response.status, 200, JSON.stringify(body));
      profile = { _id: body.profile.profileId, userId: testUserId };
    });
  });

  after(async () => {
    await User.deleteMany({ _id: { $in: [testUserId, otherUserId] } });
    await FinancialProfile.deleteMany({ userId: { $in: [testUserId, otherUserId] } });
    await Recommendation.deleteMany({ userId: { $in: [testUserId, otherUserId] } });
    await AuditRecord.collection.deleteMany({ userId: { $in: [testUserId, otherUserId] } });
    await Promise.all([
      FinancialProfileState.deleteMany({ userId: { $in: [testUserId, otherUserId] } }),
      RecommendationState.deleteMany({ userId: { $in: [testUserId, otherUserId] } }),
      RecommendationAllocationRevision.collection.deleteMany({ userId: { $in: [testUserId, otherUserId] } }),
      IdempotencyKey.deleteMany({ userId: { $in: [testUserId, otherUserId] } }),
    ]);
    await teardownTestDatabase();
  });

  it('1. Generates recommendation and synchronously creates tamper-evident AuditRecord', async () => {
    const priorAudit = await AuditRecord.findOne({ userId: testUserId }).sort({ chain_sequence: -1 }).lean();
    assert.ok(priorAudit, 'Profile completion must persist its initial audit entry');
    await withServer(buildApp(), async (baseUrl) => {
      const { response, body } = await jsonRequest(`${baseUrl}/api/recommend`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${testToken}`,
          'X-Correlation-ID': 'audit-test-corr-001',
          'Idempotency-Key': 'audit-success-001',
        },
        body: JSON.stringify({ profileId: profile._id.toString() }),
      });

      assert.equal(response.status, 200, `Expected 200, got ${response.status}: ${JSON.stringify(body)}`);
      assertRuntimeResponseMatchesContract({
        method: 'POST', path: '/api/recommend', status: response.status,
        contentType: response.headers.get('content-type'), body,
      });
      assert.ok(body.recommendationId, 'Expected recommendationId');
      assert.ok(body.audit_id, 'Expected audit_id in response');
      assert.ok(body.audit_hash, 'Expected audit_hash in response');
      assert.equal(body.recommendation_policy_version, RECOMMENDATION_POLICY_VERSION);
      const regulatoryRuleVersion = getCurrentRegulatoryRuleVersion();
      assert.ok(regulatoryRuleVersion);
      assert.notEqual(RECOMMENDATION_POLICY_VERSION, regulatoryRuleVersion);

      // Verify AuditRecord in MongoDB
      const auditDoc = await AuditRecord.findById(body.audit_id);
      assert.ok(auditDoc, 'AuditRecord document must exist in MongoDB');
      assert.equal(auditDoc.userId.toString(), testUserId.toString());
      assert.equal(auditDoc.profileId.toString(), profile._id.toString());
      assert.equal(auditDoc.recommendationId.toString(), body.recommendationId.toString());
      assert.equal(auditDoc.correlationId, 'audit-test-corr-001');
      assert.equal(auditDoc.record_hash, body.audit_hash);
      assert.equal(auditDoc.previous_hash, priorAudit.record_hash);
      assert.equal(auditDoc.chain_sequence, priorAudit.chain_sequence + 1);
      assert.equal(auditDoc.hash_algorithm, 'sha256');
      assert.equal(auditDoc.schema_version, '1.0');
      assert.ok(auditDoc.version_id, 'Must have model/engine version_id');
      assert.equal(auditDoc.regulatory_rule_version, regulatoryRuleVersion);
      assert.equal(auditDoc.inputs.regulatory_rule_version, regulatoryRuleVersion);
      assert.equal(auditDoc.inputs.recommendation_policy_version, RECOMMENDATION_POLICY_VERSION);
      assert.ok(auditDoc.inputs, 'Must store sanitized inputs');
      assert.equal(auditDoc.inputs.age, 32);
      assert.equal(auditDoc.inputs.monthly_take_home, 150000);
      assert.equal(auditDoc.inputs.monthly_savings, 50000);
      assert.equal(auditDoc.inputs.final_suitability_risk, 'Moderate');
      assert.equal(auditDoc.inputs.annual_income, undefined);
      assert.equal(auditDoc.inputs.tax_regime, undefined);
      assert.ok(auditDoc.recommendations, 'Must store recommendations output');
      assert.ok(Array.isArray(auditDoc.recommendations.instruments), 'Must store instruments');
      assert.ok(['ml_service', 'rule_fallback', 'rule_based'].includes(auditDoc.engine), `Valid engine: ${auditDoc.engine}`);
    });
  });

  it('2. GET /api/recommend/audit retrieves user audit history with pagination', async () => {
    const storedBeforeRead = await AuditRecord.find({ userId: testUserId }).sort({ chain_sequence: 1 }).lean();
    await withServer(buildApp(), async (baseUrl) => {
      const { response, body } = await jsonRequest(`${baseUrl}/api/recommend/audit?limit=10&skip=0`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${testToken}`,
        },
      });

      assert.equal(response.status, 200);
      assertRuntimeResponseMatchesContract({
        method: 'GET', path: '/api/recommend/audit', status: response.status,
        contentType: response.headers.get('content-type'), body,
      });
      assert.equal(body.status, 'success');
      assert.ok(body.total >= 1, 'Total records should be >= 1');
      assert.ok(body.records.length >= 1, 'Records array should not be empty');
      assert.equal(body.records[0].userId.toString(), testUserId.toString());
      assert.ok(body.records[0].input_hash, 'Record should have input_hash');
    });
    const storedAfterRead = await AuditRecord.find({ userId: testUserId }).sort({ chain_sequence: 1 }).lean();
    assert.deepEqual(storedAfterRead, storedBeforeRead, 'audit list reads must not modify persisted append-only records');
  });

  it('GET /api/recommend/audit/verify validates the authenticated user chain', async () => {
    await withServer(buildApp(), async (baseUrl) => {
      const { response, body } = await jsonRequest(`${baseUrl}/api/recommend/audit/verify`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${testToken}` },
      });
      assert.equal(response.status, 200);
      assertRuntimeResponseMatchesContract({
        method: 'GET', path: '/api/recommend/audit/verify', status: response.status,
        contentType: response.headers.get('content-type'), body,
      });
      assert.equal(body.valid, true, JSON.stringify(body.errors));
      assert.ok(body.checkedRecords >= 1);
    });
  });

  it('3. GET /api/recommend/audit/:id retrieves specific audit record and enforces ownership', async () => {
    // Find an existing audit record for testUserId
    const auditDoc = await AuditRecord.findOne({ userId: testUserId });
    assert.ok(auditDoc, 'Pre-existing auditDoc required');
    const storedBeforeRead = await AuditRecord.findById(auditDoc._id).lean();

    await withServer(buildApp(), async (baseUrl) => {
      // Authorized owner request
      const { response: okRes, body: okBody } = await jsonRequest(`${baseUrl}/api/recommend/audit/${auditDoc._id}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${testToken}` },
      });
      assert.equal(okRes.status, 200);
      assertRuntimeResponseMatchesContract({
        method: 'GET', path: '/api/recommend/audit/{id}', status: okRes.status,
        contentType: okRes.headers.get('content-type'), body: okBody,
      });
      assert.equal(okBody.record._id.toString(), auditDoc._id.toString());

      // Unauthorized other user request
      const { response: denyRes } = await jsonRequest(`${baseUrl}/api/recommend/audit/${auditDoc._id}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${otherToken}` },
      });
      assert.equal(denyRes.status, 403, 'Should deny access to non-owner non-admin');
      const denyBody = await denyRes.json();
      assertRuntimeResponseMatchesContract({
        method: 'GET', path: '/api/recommend/audit/{id}', status: denyRes.status,
        contentType: denyRes.headers.get('content-type'), body: denyBody,
      });
    });
    const storedAfterRead = await AuditRecord.findById(auditDoc._id).lean();
    assert.deepEqual(storedAfterRead, storedBeforeRead, 'audit detail reads must not modify persisted append-only records');
  });

  it('4. Strict Fail-Loudly: If AuditRecord.create fails, recommendation request FAILS with HTTP 500', async () => {
    const originalCreate = AuditRecord.create;
    // Mock AuditRecord.create to simulate a database write error
    AuditRecord.create = async () => {
      throw new Error('Database disk I/O failure during audit write');
    };

    try {
      await withServer(buildApp(), async (baseUrl) => {
        const { response, body } = await jsonRequest(`${baseUrl}/api/recommend`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${testToken}`,
            'X-Correlation-ID': 'fail-loudly-corr-test',
            'Idempotency-Key': 'audit-failure-001',
          },
          body: JSON.stringify({ profileId: profile._id.toString() }),
        });

        assert.equal(response.status, 500, 'Must return HTTP 500 when audit write fails');
        assert.ok(
          (body.message && body.message.toLowerCase().includes('audit')) || (body.error && body.error.toLowerCase().includes('audit')),
          `Expected audit error message, got: ${JSON.stringify(body)}`
        );
      });
    } finally {
      // Restore original AuditRecord.create
      AuditRecord.create = originalCreate;
    }
  });
});
