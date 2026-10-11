import AuditChainHead from '../models/AuditChainHead.js';
import AuditRecord from '../models/AuditRecord.js';
import ConversationHistory from '../models/ConversationHistory.js';
import FinancialProfile from '../models/FinancialProfile.js';
import Goal from '../models/Goal.js';
import IdempotencyKey from '../models/IdempotencyKey.js';
import InvestmentProduct from '../models/InvestmentProduct.js';
import MarketObservation from '../models/MarketObservation.js';
import Recommendation from '../models/Recommendation.js';
import RecommendationAllocationRevision from '../models/RecommendationAllocationRevision.js';
import RecommendationState from '../models/RecommendationState.js';
import FinancialProfileState from '../models/FinancialProfileState.js';
import User from '../models/User.js';
import UserIntentMandate from '../models/UserIntentMandate.js';
import PasskeyCredential from '../models/PasskeyCredential.js';
import MandateApprovalChallenge from '../models/MandateApprovalChallenge.js';
import PasskeyRegistrationChallenge from '../models/PasskeyRegistrationChallenge.js';
import ExecutionReceipt from '../models/ExecutionReceipt.js';
import AuthorizedExecutionAttempt from '../models/AuthorizedExecutionAttempt.js';
import GenieProofCase from '../models/GenieProofCase.js';
import GenieProofRevision from '../models/GenieProofRevision.js';
import GenieProofSourceDefinition from '../models/GenieProofSourceDefinition.js';
import GenieProofRetrievalReceipt from '../models/GenieProofRetrievalReceipt.js';
import GenieProofEvidenceRevision from '../models/GenieProofEvidenceRevision.js';
import ProofWatch from '../models/ProofWatch.js';
import ProofBreakJob from '../models/ProofBreakJob.js';
import ProofBreakEvent from '../models/ProofBreakEvent.js';
import ProofNotificationOutbox from '../models/ProofNotificationOutbox.js';
import ProofBreakWorkerHeartbeat from '../models/ProofBreakWorkerHeartbeat.js';
import { GENIEPROOF_RETENTION_MS } from '../agents/genieProof/genieProofPolicy.js';
import { createError } from '../middleware/errorHandler.js';

export const PHASE2_INDEX_MODELS = Object.freeze([
  IdempotencyKey,
  FinancialProfile,
  FinancialProfileState,
  Recommendation,
  RecommendationState,
  RecommendationAllocationRevision,
  AuditRecord,
  AuditChainHead,
  Goal,
  ConversationHistory,
  User,
]);

// Unique identities for verifiable authorization and its durable receipts.
// These are deployed through the explicit Phase 2 migration and checked
// read-only at startup when verifiable actions are enabled.
export const AUTHORIZATION_INDEX_MODELS = Object.freeze([
  UserIntentMandate,
  PasskeyCredential,
  MandateApprovalChallenge,
  PasskeyRegistrationChallenge,
  ExecutionReceipt,
  AuthorizedExecutionAttempt,
]);

export const GENIEPROOF_INDEX_MODELS = Object.freeze([
  GenieProofCase,
  GenieProofRevision,
  GenieProofSourceDefinition,
  GenieProofRetrievalReceipt,
  GenieProofEvidenceRevision,
  ProofWatch,
  ProofBreakJob,
  ProofBreakEvent,
  ProofNotificationOutbox,
  ProofBreakWorkerHeartbeat,
]);

export const MIGRATION_INDEX_MODELS = Object.freeze([
  ...PHASE2_INDEX_MODELS,
  ...AUTHORIZATION_INDEX_MODELS,
  ...GENIEPROOF_INDEX_MODELS,
]);

// These schema-declared unique indexes fence every durable market-data upsert.
// They are provisioned by the already-ordered one-shot Phase 2 migration Job;
// application startup only verifies them.
export const MARKET_DATA_INDEX_MODELS = Object.freeze([
  InvestmentProduct,
  MarketObservation,
]);

const indexCache = new WeakMap();
const CACHE_TTL_MS = 5000;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function keyMatches(actual, expected) {
  return JSON.stringify(Object.entries(actual || {})) === JSON.stringify(Object.entries(expected || {}));
}

function requiredUniqueIndexes(model) {
  const indexes = model.schema.indexes()
    .filter(([, options]) => options.unique)
    .map(([key, options]) => ({
      key,
      unique: true,
      partialFilterExpression: options.partialFilterExpression,
      collation: options.collation,
      name: options.name,
    }));
  return indexes;
}

function collationMatches(actual, required) {
  if (!required) return true;
  return Object.entries(required).every(([key, value]) => actual?.[key] === value);
}

function indexMatches(actual, required) {
  if (!keyMatches(actual.key, required.key) || actual.unique !== true) return false;
  if (JSON.stringify(stableValue(actual.partialFilterExpression || null))
      !== JSON.stringify(stableValue(required.partialFilterExpression || null))) return false;
  if (!collationMatches(actual.collation, required.collation)) return false;
  return true;
}

function indexReadinessError(missing, scope = 'financial') {
  const subject = ['market-data', 'authorization', 'persistence', 'genieproof'].includes(scope) ? scope : 'financial';
  const displaySubject = subject === 'market-data' ? 'Market data' : subject[0].toUpperCase() + subject.slice(1);
  return createError(
    503,
    `Required ${subject} persistence indexes are unavailable.`,
    `${displaySubject} services are temporarily unavailable.`,
    { code: 'PERSISTENCE_INDEXES_UNAVAILABLE', details: { missing } },
  );
}

/** Read-only verification. This function must never create, drop, or alter indexes. */
export async function verifyPersistenceIndexes({ models = PHASE2_INDEX_MODELS, force = false, scope = 'financial' } = {}) {
  const connectionDb = models[0]?.db?.db;
  const modelSetKey = `${scope}:${models.map(model => model.modelName).sort().join('|')}`;
  if (connectionDb && !force) {
    const cached = indexCache.get(connectionDb)?.get(modelSetKey);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;
  }

  const verification = (async () => {
    const missing = [];
    for (const model of models) {
      let actualIndexes;
      try {
        actualIndexes = await model.collection.indexes();
      } catch {
        missing.push(`${model.collection.collectionName}:collection-or-index-list-unavailable`);
        continue;
      }

      for (const required of requiredUniqueIndexes(model)) {
        if (!actualIndexes.some(index => indexMatches(index, required))) {
          missing.push(`${model.collection.collectionName}:${required.name || JSON.stringify(required.key)}`);
        }
      }
      if (model === IdempotencyKey && actualIndexes.some(index => (
        index.expireAfterSeconds !== undefined
        && index.key?.createdAt === 1
        && Object.keys(index.key).length === 1
      ))) {
        missing.push(`${model.collection.collectionName}:dangerous-createdAt-ttl-index`);
      }
    }

    if (missing.length) throw indexReadinessError(missing, scope);
    return { ready: true, verifiedAt: new Date().toISOString() };
  })();

  if (connectionDb && !force) {
    let cachedByModelSet = indexCache.get(connectionDb);
    if (!cachedByModelSet) {
      cachedByModelSet = new Map();
      indexCache.set(connectionDb, cachedByModelSet);
    }
    cachedByModelSet.set(modelSetKey, { expiresAt: Date.now() + CACHE_TTL_MS, promise: verification });
    verification.catch(() => cachedByModelSet.delete(modelSetKey));
  }
  return verification;
}

/** Read-only startup gate for the two unique market-data upsert identities. */
export async function verifyMarketDataPersistenceIndexes({ models = MARKET_DATA_INDEX_MODELS, force = true } = {}) {
  return verifyPersistenceIndexes({ models, force, scope: 'market-data' });
}

/** Read-only startup gate for durable verifiable-authorization identities. */
export async function verifyAuthorizationPersistenceIndexes({ models = AUTHORIZATION_INDEX_MODELS, force = true } = {}) {
  return verifyPersistenceIndexes({ models, force, scope: 'authorization' });
}

/** Read-only startup gate for owner-bound GenieProof case and revision identities. */
export async function verifyGenieProofPersistenceIndexes({ models = GENIEPROOF_INDEX_MODELS, force = true } = {}) {
  const result = await verifyPersistenceIndexes({ models, force, scope: 'genieproof' });
  const missing = [];
  for (const model of models) {
    const requiredExpiryIndexes = model.schema.indexes()
      .filter(([, options]) => options.expireAfterSeconds !== undefined);
    if (!requiredExpiryIndexes.length) continue;
    let actualIndexes;
    try {
      actualIndexes = await model.collection.indexes();
    } catch {
      missing.push(`${model.collection.collectionName}:expiry-index-list-unavailable`);
      continue;
    }
    for (const [key, options] of requiredExpiryIndexes) {
      if (!actualIndexes.some(index => keyMatches(index.key, key)
        && index.expireAfterSeconds === options.expireAfterSeconds)) {
        missing.push(`${model.collection.collectionName}:${options.name || JSON.stringify(key)}`);
      }
    }
    // Only cases and revisions predate expiry metadata. Newer operational
    // collections are created with the required field and are governed by
    // their schema; probing them would turn index readiness into an implicit
    // migration contract for unrelated documents.
    if (model === GenieProofCase || model === GenieProofRevision) {
      try {
        if (typeof model.collection.countDocuments !== 'function') {
          missing.push(`${model.collection.collectionName}:expiry-migration-state-unavailable`);
        } else if (await model.collection.countDocuments({ expiresAt: { $exists: false } })) {
          missing.push(`${model.collection.collectionName}:legacy-expiry-migration-required`);
        }
      } catch {
        missing.push(`${model.collection.collectionName}:expiry-migration-state-unavailable`);
      }
    }
  }
  if (missing.length) throw indexReadinessError(missing, 'genieproof');
  return result;
}

/** Explicit migration entry point. Never call from an HTTP request or app startup. */
export async function migratePersistenceIndexes({ models = MIGRATION_INDEX_MODELS } = {}) {
  const idempotencyIndexes = await IdempotencyKey.collection.indexes().catch(error => {
    if (error.code === 26 || error.codeName === 'NamespaceNotFound') return [];
    throw error;
  });
  for (const index of idempotencyIndexes) {
    if (index.expireAfterSeconds !== undefined
        && index.key?.createdAt === 1
        && Object.keys(index.key).length === 1) {
      await IdempotencyKey.collection.dropIndex(index.name);
    }
  }

  for (const model of models) {
    try {
      await model.createCollection();
    } catch (error) {
      if (error.code !== 48 && error.codeName !== 'NamespaceExists') throw error;
    }
  }

  // Existing local GenieProof records predate expiry metadata. Give old cases
  // one complete retention window from migration, then align each old
  // revision's expiry with its parent case. Orphan revisions receive a bounded
  // fallback window and remain visible to the readiness check until assigned.
  const genieProofModels = models.filter(model => [GenieProofCase.modelName, GenieProofRevision.modelName].includes(model.modelName));
  if (genieProofModels.length) {
    const legacyExpiry = new Date(Date.now() + GENIEPROOF_RETENTION_MS);
    const caseModel = genieProofModels.find(model => model.modelName === GenieProofCase.modelName);
    const revisionModel = genieProofModels.find(model => model.modelName === GenieProofRevision.modelName);
    if (caseModel) {
      // Use the native collection because Mongoose marks expiry immutable.
      await caseModel.collection.updateMany({ expiresAt: { $exists: false } }, { $set: { expiresAt: legacyExpiry } });
    }
    if (revisionModel) {
      const cursor = revisionModel.collection.find({ expiresAt: { $exists: false } }, { projection: { userId: 1, caseId: 1 } });
      for await (const revision of cursor) {
        const parentCase = caseModel
          ? await caseModel.collection.findOne({ userId: revision.userId, caseId: revision.caseId }, { projection: { expiresAt: 1 } })
          : null;
        const expiresAt = parentCase?.expiresAt instanceof Date ? parentCase.expiresAt : legacyExpiry;
        await revisionModel.collection.updateOne(
          { _id: revision._id, expiresAt: { $exists: false } },
          { $set: { expiresAt } },
        );
      }
    }
  }

  for (const model of models) {
    await model.createIndexes();
  }
  return verifyPersistenceIndexes({ models, force: true, scope: 'persistence' });
}

/** Explicit GenieProof-only migration; startup remains read-only and other domains are untouched. */
export async function migrateGenieProofPersistenceIndexes({ models = GENIEPROOF_INDEX_MODELS } = {}) {
  for (const model of models) {
    try {
      await model.createCollection();
    } catch (error) {
      if (error.code !== 48 && error.codeName !== 'NamespaceExists') throw error;
    }
  }

  const caseModel = models.find(model => model.modelName === GenieProofCase.modelName);
  const revisionModel = models.find(model => model.modelName === GenieProofRevision.modelName);
  const legacyExpiry = new Date(Date.now() + GENIEPROOF_RETENTION_MS);
  if (caseModel) {
    await caseModel.collection.updateMany({ expiresAt: { $exists: false } }, { $set: { expiresAt: legacyExpiry } });
  }
  if (revisionModel) {
    const cursor = revisionModel.collection.find({ expiresAt: { $exists: false } }, { projection: { userId: 1, caseId: 1 } });
    for await (const revision of cursor) {
      const parentCase = caseModel
        ? await caseModel.collection.findOne({ userId: revision.userId, caseId: revision.caseId }, { projection: { expiresAt: 1 } })
        : null;
      const expiresAt = parentCase?.expiresAt instanceof Date ? parentCase.expiresAt : legacyExpiry;
      await revisionModel.collection.updateOne(
        { _id: revision._id, expiresAt: { $exists: false } },
        { $set: { expiresAt } },
      );
    }
  }
  for (const model of models) await model.createIndexes();
  return verifyGenieProofPersistenceIndexes({ models, force: true });
}

function migrationIndexOptions(required) {
  return Object.fromEntries(Object.entries({
    unique: true,
    name: required.name,
    partialFilterExpression: required.partialFilterExpression,
    collation: required.collation,
  }).filter(([, value]) => value !== undefined));
}

function marketIndexMigrationError(error, model, required) {
  const duplicate = error?.code === 11000
    || error?.codeName === 'DuplicateKey'
    || /duplicate key|E11000/i.test(error?.message || '');
  const wrapped = new Error(
    duplicate
      ? `Existing duplicate market-data identities block index creation for ${model.collection.collectionName}.`
      : `Required market-data index creation failed for ${model.collection.collectionName}.`,
    { cause: error },
  );
  wrapped.code = duplicate ? 'MARKET_DATA_INDEX_DUPLICATES' : 'MARKET_DATA_INDEX_CREATION_FAILED';
  wrapped.report = {
    collection: model.collection.collectionName,
    index: required.name || required.key,
    mongoCode: Number.isInteger(error?.code) ? error.code : null,
    ...(duplicate ? {
      duplicateKey: error?.keyValue || null,
      ...(error?.keyValue ? {} : { duplicateDetails: error?.message || 'MongoDB reported a duplicate-key conflict.' }),
    } : {}),
  };
  return wrapped;
}

/**
 * Explicit, repeatable DDL migration for market-data upsert identities.
 * It creates only the unique indexes declared by these two schemas and never
 * removes or rewrites existing data/indexes. MongoDB duplicate-key failures
 * are surfaced with the collection/index and duplicate-key details.
 */
export async function migrateMarketDataPersistenceIndexes({ models = MARKET_DATA_INDEX_MODELS } = {}) {
  for (const model of models) {
    try {
      await model.createCollection();
    } catch (error) {
      if (error.code !== 48 && error.codeName !== 'NamespaceExists') throw error;
    }

    for (const required of requiredUniqueIndexes(model)) {
      try {
        await model.collection.createIndex(required.key, migrationIndexOptions(required));
      } catch (error) {
        throw marketIndexMigrationError(error, model, required);
      }
    }
  }

  return verifyMarketDataPersistenceIndexes({ models, force: true });
}
