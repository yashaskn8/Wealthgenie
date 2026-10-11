import mongoose from 'mongoose';

const factSchema = new mongoose.Schema({
  claimType: { type: String, required: true, maxlength: 100 },
  productId: { type: String, required: true, maxlength: 200 },
  value: { type: Number, required: true, validate: Number.isFinite },
  unit: { type: String, required: true, maxlength: 80 },
  effectiveFrom: { type: Date, required: true },
  effectiveTo: { type: Date, required: true },
  conditions: { type: [String], default: [], maxlength: 100 },
}, { _id: false, strict: 'throw' });

const genieProofEvidenceRevisionSchema = new mongoose.Schema({
  evidenceId: { type: String, required: true, match: /^[a-z0-9][a-z0-9._:-]{1,119}$/, immutable: true },
  revision: { type: Number, required: true, min: 1, validate: Number.isInteger, immutable: true },
  sourceId: { type: String, required: true, maxlength: 120, immutable: true },
  sourceRevision: { type: Number, required: true, min: 1, validate: Number.isInteger, immutable: true },
  sourceDefinitionHash: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
  retrievalIds: { type: [String], required: true, validate: values => values.length > 0 && values.length <= 25, immutable: true },
  retrievalReceiptHashes: { type: [String], required: true, validate: values => values.length > 0 && values.length <= 25, immutable: true },
  publicationAt: { type: Date, default: null, immutable: true },
  retrievedAt: { type: Date, required: true, immutable: true },
  sourceContentCommitment: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
  sourceQualificationAtAssessment: {
    type: String,
    required: true,
    enum: ['PENDING_REVIEW', 'QUALIFIED_FOR_INTERNAL_TESTING', 'QUALIFIED_FOR_USER_PRESENTATION', 'BLOCKED_REUSE_RIGHTS', 'BLOCKED_TECHNICAL', 'REVOKED'],
    immutable: true,
  },
  reusePermissionAtAssessment: { type: String, required: true, enum: ['UNREVIEWED', 'APPROVED', 'BLOCKED', 'REVOKED'], immutable: true },
  freshnessStatus: { type: String, required: true, enum: ['FRESH', 'STALE', 'UNKNOWN'], immutable: true },
  revocationStatus: { type: String, required: true, enum: ['ACTIVE', 'REVOKED'], immutable: true },
  fact: { type: factSchema, required: true, immutable: true },
  parserVersion: { type: String, required: true, maxlength: 120, immutable: true },
  ruleVersion: { type: String, required: true, maxlength: 120, immutable: true },
  sourceLineage: { type: [String], default: [], maxlength: 100, immutable: true },
  supersedes: { type: String, default: null, maxlength: 160, immutable: true },
  factHash: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
  attestation: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
}, { strict: 'throw', timestamps: { createdAt: true, updatedAt: false }, versionKey: false });

genieProofEvidenceRevisionSchema.index(
  { evidenceId: 1, revision: 1 },
  { unique: true, name: 'uniq_genieproof_evidence_revision' },
);
genieProofEvidenceRevisionSchema.index(
  { sourceId: 1, sourceRevision: 1, sourceContentCommitment: 1 },
  { unique: true, name: 'uniq_genieproof_source_observation' },
);
genieProofEvidenceRevisionSchema.index(
  { 'fact.productId': 1, 'fact.claimType': 1, 'fact.effectiveFrom': -1 },
  { name: 'genieproof_fact_resolution' },
);

export default mongoose.models.GenieProofEvidenceRevision
  || mongoose.model('GenieProofEvidenceRevision', genieProofEvidenceRevisionSchema);
