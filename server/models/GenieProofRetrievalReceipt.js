import mongoose from 'mongoose';

const genieProofRetrievalReceiptSchema = new mongoose.Schema({
  retrievalId: { type: String, required: true, match: /^[0-9a-f-]{36}$/i, immutable: true },
  sourceId: { type: String, required: true, maxlength: 120, immutable: true },
  sourceRevision: { type: Number, required: true, min: 1, validate: Number.isInteger, immutable: true },
  requestedUrl: { type: String, required: true, maxlength: 2048, immutable: true },
  finalUrl: { type: String, required: true, maxlength: 2048, immutable: true },
  redirectCount: { type: Number, required: true, min: 0, max: 10, validate: Number.isInteger, immutable: true },
  statusCode: { type: Number, required: true, min: 100, max: 599, immutable: true },
  contentType: { type: String, required: true, maxlength: 160, immutable: true },
  contentBytes: { type: Number, required: true, min: 0, immutable: true },
  contentSha256: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
  retrievedAt: { type: Date, required: true, immutable: true },
  publicationAt: { type: Date, default: null, immutable: true },
  fetchClassification: {
    type: String,
    required: true,
    enum: ['SUCCESS', 'HTTP_ERROR', 'TIMEOUT', 'NETWORK_ERROR', 'REDIRECT_REJECTED', 'MIME_REJECTED', 'SCHEMA_REJECTED'],
    immutable: true,
  },
  fetcherVersion: { type: String, required: true, maxlength: 120, immutable: true },
  responseLineage: { type: [String], default: [], maxlength: 50, immutable: true },
  receiptHash: { type: String, required: true, match: /^[a-f0-9]{64}$/, immutable: true },
}, { strict: 'throw', timestamps: { createdAt: true, updatedAt: false }, versionKey: false });

genieProofRetrievalReceiptSchema.index(
  { retrievalId: 1 },
  { unique: true, name: 'uniq_genieproof_retrieval_id' },
);
genieProofRetrievalReceiptSchema.index(
  { sourceId: 1, sourceRevision: 1, contentSha256: 1 },
  { name: 'genieproof_source_content_receipts' },
);

export default mongoose.models.GenieProofRetrievalReceipt
  || mongoose.model('GenieProofRetrievalReceipt', genieProofRetrievalReceiptSchema);
