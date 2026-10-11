import mongoose from 'mongoose';

export const GENIEPROOF_SOURCE_QUALIFICATION_STATES = Object.freeze([
  'PENDING_REVIEW',
  'QUALIFIED_FOR_INTERNAL_TESTING',
  'QUALIFIED_FOR_USER_PRESENTATION',
  'BLOCKED_REUSE_RIGHTS',
  'BLOCKED_TECHNICAL',
  'REVOKED',
]);

export const GENIEPROOF_SOURCE_REUSE_STATES = Object.freeze([
  'UNREVIEWED',
  'APPROVED',
  'BLOCKED',
  'REVOKED',
]);

const supersedesSchema = new mongoose.Schema({
  sourceId: { type: String, required: true, maxlength: 120 },
  revision: { type: Number, required: true, min: 1, validate: Number.isInteger },
}, { _id: false, strict: 'throw' });

const genieProofSourceDefinitionSchema = new mongoose.Schema({
  sourceId: { type: String, required: true, match: /^[a-z0-9][a-z0-9._:-]{1,119}$/, immutable: true },
  revision: { type: Number, required: true, min: 1, validate: Number.isInteger, immutable: true },
  publisher: { type: String, required: true, maxlength: 200, immutable: true },
  officialIdentity: { type: String, required: true, maxlength: 500, immutable: true },
  endpoint: { type: String, required: true, maxlength: 2048, immutable: true },
  sourceClass: { type: String, required: true, enum: ['QUARTERLY_OFFICIAL_RATE', 'OFFICIAL_PRODUCT_FACT', 'OFFICIAL_LEGAL_TEXT'], immutable: true },
  productIds: { type: [String], required: true, validate: values => values.length > 0 && values.length <= 100, immutable: true },
  claimTypes: { type: [String], required: true, validate: values => values.length > 0 && values.length <= 30, immutable: true },
  expectedMimeTypes: { type: [String], required: true, validate: values => values.length > 0 && values.length <= 8, immutable: true },
  parserVersion: { type: String, required: true, maxlength: 120, immutable: true },
  ruleVersion: { type: String, required: true, maxlength: 120, immutable: true },
  lineage: { type: [String], default: [], maxlength: 100, immutable: true },
  qualificationStatus: { type: String, required: true, enum: GENIEPROOF_SOURCE_QUALIFICATION_STATES, immutable: true },
  reusePermissionStatus: { type: String, required: true, enum: GENIEPROOF_SOURCE_REUSE_STATES, immutable: true },
  reviewRecord: {
    reviewedAt: { type: Date, default: null, immutable: true },
    reference: { type: String, default: null, maxlength: 500, immutable: true },
    scope: { type: String, default: null, maxlength: 500, immutable: true },
  },
  supersedes: { type: supersedesSchema, default: null, immutable: true },
  revocationReasonCode: { type: String, default: null, maxlength: 120, immutable: true },
  definitionHash: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
}, { strict: 'throw', timestamps: { createdAt: true, updatedAt: false }, versionKey: false });

genieProofSourceDefinitionSchema.index(
  { sourceId: 1, revision: 1 },
  { unique: true, name: 'uniq_genieproof_source_revision' },
);
genieProofSourceDefinitionSchema.index(
  { sourceId: 1, definitionHash: 1 },
  { unique: true, name: 'uniq_genieproof_source_definition_hash' },
);
genieProofSourceDefinitionSchema.index(
  { qualificationStatus: 1, reusePermissionStatus: 1, sourceId: 1, revision: -1 },
  { name: 'genieproof_source_qualification_lookup' },
);

export default mongoose.models.GenieProofSourceDefinition
  || mongoose.model('GenieProofSourceDefinition', genieProofSourceDefinitionSchema);
