import test from 'node:test';
import assert from 'node:assert/strict';
import IdempotencyKey from '../models/IdempotencyKey.js';
import User from '../models/User.js';
import UserIntentMandate from '../models/UserIntentMandate.js';
import PasskeyCredential from '../models/PasskeyCredential.js';
import MandateApprovalChallenge from '../models/MandateApprovalChallenge.js';
import ExecutionReceipt from '../models/ExecutionReceipt.js';
import AuthorizedExecutionAttempt from '../models/AuthorizedExecutionAttempt.js';
import GenieProofCase from '../models/GenieProofCase.js';
import GenieProofRevision from '../models/GenieProofRevision.js';
import GenieProofSourceDefinition from '../models/GenieProofSourceDefinition.js';
import GenieProofRetrievalReceipt from '../models/GenieProofRetrievalReceipt.js';
import GenieProofEvidenceRevision from '../models/GenieProofEvidenceRevision.js';
import GenieProofEvidenceRegistryState from '../models/GenieProofEvidenceRegistryState.js';
import {
  AUTHORIZATION_INDEX_MODELS,
  GENIEPROOF_INDEX_MODELS,
  MIGRATION_INDEX_MODELS,
  migratePersistenceIndexes,
  verifyAuthorizationPersistenceIndexes,
  verifyGenieProofPersistenceIndexes,
  verifyPersistenceIndexes,
} from '../services/persistenceIndexReadiness.js';

function fakeModel(indexes = []) {
  let currentIndexes = indexes;
  return {
    modelName: 'FixtureModel',
    schema: { indexes: () => [[{ owner: 1, resource: 1 }, { unique: true, name: 'unique_owner_resource' }]] },
    collection: {
      collectionName: 'fixture_records',
      async indexes() { return currentIndexes; },
    },
    async createCollection() {},
    async createIndexes() {
      currentIndexes = [{ key: { owner: 1, resource: 1 }, unique: true, name: 'unique_owner_resource' }];
    },
  };
}

test('runtime index verification is read-only and accepts the required uniqueness index', async () => {
  const model = fakeModel([{ key: { owner: 1, resource: 1 }, unique: true, name: 'unique_owner_resource' }]);
  let ddlCalls = 0;
  model.collection.createIndex = async () => { ddlCalls += 1; };
  model.collection.dropIndex = async () => { ddlCalls += 1; };
  const result = await verifyPersistenceIndexes({ models: [model], force: true });
  assert.equal(result.ready, true);
  assert.equal(ddlCalls, 0);
});

test('runtime readiness fails closed when a required unique index is missing', async () => {
  await assert.rejects(
    verifyPersistenceIndexes({ models: [fakeModel()], force: true }),
    error => error.status === 503
      && error.code === 'PERSISTENCE_INDEXES_UNAVAILABLE'
      && error.clientDetails.missing.includes('fixture_records:unique_owner_resource'),
  );
});

test('runtime readiness rejects the obsolete idempotency TTL index without removing it', async () => {
  const originalIndexes = IdempotencyKey.collection.indexes;
  const originalDropIndex = IdempotencyKey.collection.dropIndex;
  let drops = 0;
  IdempotencyKey.collection.indexes = async () => [
    { name: '_id_', key: { _id: 1 }, unique: true },
    { name: 'createdAt_1', key: { createdAt: 1 }, expireAfterSeconds: 300 },
  ];
  IdempotencyKey.collection.dropIndex = async () => { drops += 1; };
  try {
    await assert.rejects(
      verifyPersistenceIndexes({ models: [IdempotencyKey], force: true }),
      error => error.code === 'PERSISTENCE_INDEXES_UNAVAILABLE',
    );
    assert.equal(drops, 0, 'request-time readiness must never drop a TTL index');
  } finally {
    IdempotencyKey.collection.indexes = originalIndexes;
    IdempotencyKey.collection.dropIndex = originalDropIndex;
  }
});

test('explicit Phase 2 migration includes user and verifiable-authorization identity indexes', () => {
  const expected = new Map([
    [User, ['email']],
    [UserIntentMandate, ['mandateId', 'nonce']],
    [PasskeyCredential, ['credentialId']],
    [MandateApprovalChallenge, ['mandateId']],
    [ExecutionReceipt, ['receiptId', 'mandateId']],
    [AuthorizedExecutionAttempt, ['executionId', 'mandateId']],
  ]);

  for (const [model, fields] of expected) {
    assert.ok(MIGRATION_INDEX_MODELS.includes(model), `${model.modelName} must be explicitly migrated`);
    for (const field of fields) {
      const hasUniqueIndex = model.schema.indexes().some(([key, options]) => (
        options.unique === true && Object.keys(key).length === 1 && key[field] === 1
      ));
      assert.ok(hasUniqueIndex, `${model.modelName}.${field} must have a unique schema index`);
    }
  }

  for (const model of AUTHORIZATION_INDEX_MODELS) {
    assert.ok(MIGRATION_INDEX_MODELS.includes(model), `${model.modelName} authorization indexes must be in migration`);
  }

  for (const model of [GenieProofCase, GenieProofRevision, GenieProofSourceDefinition, GenieProofRetrievalReceipt, GenieProofEvidenceRevision]) {
    assert.ok(GENIEPROOF_INDEX_MODELS.includes(model), `${model.modelName} must be in the GenieProof readiness gate`);
    assert.ok(MIGRATION_INDEX_MODELS.includes(model), `${model.modelName} indexes must be in the explicit migration`);
  }
});

test('GenieProof migrations declare the owner quota fence and both 90-day TTL indexes', () => {
  const quotaIndex = GenieProofCase.schema.indexes().find(([, options]) => options.name === 'uniq_genieproof_owner_quota_slot');
  assert.ok(quotaIndex);
  assert.equal(quotaIndex[1].unique, true);
  assert.deepEqual(quotaIndex[1].partialFilterExpression, { quotaSlot: { $type: 'number' } });

  for (const model of [GenieProofCase, GenieProofRevision]) {
    const expiryIndex = model.schema.indexes().find(([, options]) => options.expireAfterSeconds === 0);
    assert.ok(expiryIndex, `${model.modelName} must expire records by expiresAt`);
    assert.deepEqual(expiryIndex[0], { expiresAt: 1 });
  }
});

test('GenieProof runtime readiness fails closed when a required expiry index is missing', async () => {
  const originals = new Map(GENIEPROOF_INDEX_MODELS.map(model => [model, model.collection.indexes]));
  const originalCounts = new Map([GenieProofCase, GenieProofRevision].map(model => [model, model.collection.countDocuments]));
  const originalFindById = GenieProofEvidenceRegistryState.findById;
  const indexesFor = model => model.schema.indexes().map(([key, options]) => ({
    key,
    ...(options.unique ? { unique: true } : {}),
    ...(options.partialFilterExpression ? { partialFilterExpression: options.partialFilterExpression } : {}),
    ...(options.expireAfterSeconds !== undefined ? { expireAfterSeconds: options.expireAfterSeconds } : {}),
    name: options.name,
  }));
  try {
    GenieProofEvidenceRegistryState.findById = () => ({ lean: async () => ({ generation: 0 }) });
    for (const model of GENIEPROOF_INDEX_MODELS) {
      model.collection.indexes = async () => indexesFor(model);
    }
    for (const model of [GenieProofCase, GenieProofRevision]) {
      model.collection.countDocuments = async () => 0;
    }
    assert.equal((await verifyGenieProofPersistenceIndexes({ force: true })).ready, true);
    GenieProofRevision.collection.indexes = async () => indexesFor(GenieProofRevision).filter(index => index.expireAfterSeconds === undefined);
    await assert.rejects(
      verifyGenieProofPersistenceIndexes({ force: true }),
      error => error.status === 503 && error.clientDetails.missing.includes('genieproofrevisions:genieproof_revision_expiry'),
    );
  } finally {
    GenieProofEvidenceRegistryState.findById = originalFindById;
    for (const [model, indexes] of originals) model.collection.indexes = indexes;
    for (const [model, countDocuments] of originalCounts) model.collection.countDocuments = countDocuments;
  }
});

test('GenieProof runtime readiness fails closed until the explicit legacy expiry migration has completed', async () => {
  const originals = new Map(GENIEPROOF_INDEX_MODELS.map(model => [model, {
    indexes: model.collection.indexes,
    countDocuments: model.collection.countDocuments,
  }]));
  const originalFindById = GenieProofEvidenceRegistryState.findById;
  const indexesFor = model => model.schema.indexes().map(([key, options]) => ({
    key,
    ...(options.unique ? { unique: true } : {}),
    ...(options.partialFilterExpression ? { partialFilterExpression: options.partialFilterExpression } : {}),
    ...(options.expireAfterSeconds !== undefined ? { expireAfterSeconds: options.expireAfterSeconds } : {}),
    name: options.name,
  }));
  try {
    GenieProofEvidenceRegistryState.findById = () => ({ lean: async () => ({ generation: 0 }) });
    for (const model of GENIEPROOF_INDEX_MODELS) {
      model.collection.indexes = async () => indexesFor(model);
    }
    for (const model of [GenieProofCase, GenieProofRevision]) {
      model.collection.countDocuments = async () => model === GenieProofCase ? 1 : 0;
    }
    await assert.rejects(
      verifyGenieProofPersistenceIndexes({ force: true }),
      error => error.status === 503
        && error.clientDetails.missing.includes('genieproofcases:legacy-expiry-migration-required'),
    );
    GenieProofCase.collection.countDocuments = async () => 0;
    assert.equal((await verifyGenieProofPersistenceIndexes({ force: true })).ready, true);
  } finally {
    GenieProofEvidenceRegistryState.findById = originalFindById;
    for (const [model, originalsForModel] of originals) {
      model.collection.indexes = originalsForModel.indexes;
      if (model === GenieProofCase || model === GenieProofRevision) model.collection.countDocuments = originalsForModel.countDocuments;
    }
  }
});

test('authorization readiness fails closed and performs no index DDL when required uniqueness is missing', async () => {
  const model = fakeModel();
  let ddlCalls = 0;
  model.collection.createIndex = async () => { ddlCalls += 1; };

  await assert.rejects(
    verifyAuthorizationPersistenceIndexes({ models: [model], force: true }),
    error => error.status === 503
      && error.code === 'PERSISTENCE_INDEXES_UNAVAILABLE'
      && error.clientMessage.startsWith('Authorization services')
      && error.clientDetails.missing.includes('fixture_records:unique_owner_resource'),
  );
  assert.equal(ddlCalls, 0);
});

test('explicit migration removes the obsolete idempotency TTL and creates required schema indexes', async () => {
  const originalIndexes = IdempotencyKey.collection.indexes;
  const originalDropIndex = IdempotencyKey.collection.dropIndex;
  const dropped = [];
  IdempotencyKey.collection.indexes = async () => [
    { name: 'createdAt_1', key: { createdAt: 1 }, expireAfterSeconds: 300 },
  ];
  IdempotencyKey.collection.dropIndex = async name => { dropped.push(name); };
  const model = fakeModel();
  try {
    const result = await migratePersistenceIndexes({ models: [model] });
    assert.deepEqual(dropped, ['createdAt_1']);
    assert.equal(result.ready, true);
  } finally {
    IdempotencyKey.collection.indexes = originalIndexes;
    IdempotencyKey.collection.dropIndex = originalDropIndex;
  }
});
