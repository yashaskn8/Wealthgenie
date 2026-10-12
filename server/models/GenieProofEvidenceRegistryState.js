import mongoose from 'mongoose';

export const GENIEPROOF_EVIDENCE_REGISTRY_STATE_ID = 'current-source-registry';

const genieProofEvidenceRegistryStateSchema = new mongoose.Schema({
  _id: { type: String, required: true, enum: [GENIEPROOF_EVIDENCE_REGISTRY_STATE_ID], immutable: true },
  generation: { type: Number, required: true, min: 0, validate: Number.isInteger },
  updatedAt: { type: Date, required: true },
}, { strict: 'throw', timestamps: false, versionKey: false });

export default mongoose.models.GenieProofEvidenceRegistryState
  || mongoose.model('GenieProofEvidenceRegistryState', genieProofEvidenceRegistryStateSchema);
