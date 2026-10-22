import mongoose from 'mongoose';
import { optionalUniqueIndex } from '../config/mongoCompatibility.js';
import { protectImmutableIdentity } from './immutableIdentity.js';

const scoreFactorSchema = new mongoose.Schema({
  expectedReturn: { type: Number, min: 0, max: 100, required: true },
  riskFit: { type: Number, min: 0, max: 100, required: true },
  liquidity: { type: Number, min: 0, max: 100, required: true },
  goalFit: { type: Number, min: 0, max: 100, required: true },
  horizonFit: { type: Number, min: 0, max: 100, required: true },
  cost: { type: Number, min: 0, max: 100, required: true },
  // Legacy persisted recommendations may still contain this telemetry field.
  // It is optional and is never used to score or allocate instruments.
  mlConfidence: { type: Number, min: 0, max: 100, required: false },
}, { _id: false, strict: 'throw' });

const instrumentDetailSchema = new mongoose.Schema({
  id: { type: String, required: true },
  name: { type: String, required: true },
  type: { type: String, required: true },
  assetClass: { type: String, required: true },
  nominalReturn: { type: Number, min: -100, max: 100, required: true },
  postTaxReturn: { type: Number, default: null },
  effectiveYield: { type: Number, min: -100, max: 100, required: true },
  returnBasis: { type: String, enum: ['PRE_TAX_NOMINAL'], required: true },
  returnDataClass: { type: String, enum: ['MODEL_ASSUMPTION'], default: 'MODEL_ASSUMPTION', required: true },
  returnAssumptionVersion: { type: String, default: 'wealthgenie-projection-assumptions-1.1.0', required: true },
  returnAssumptionHash: { type: String, match: /^[a-f0-9]{64}$/, default: null },
  returnSource: { type: String, enum: ['WEALTHGENIE_MODEL_POLICY'], default: 'WEALTHGENIE_MODEL_POLICY', required: true },
  observedMarketFact: { type: Boolean, enum: [false], default: false, required: true },
  providerForecast: { type: Boolean, enum: [false], default: false, required: true },
  expenseRatio: { type: Number, min: 0, max: 1, required: true },
  riskLevel: { type: String, required: true },
  riskScore: { type: Number, min: 1, max: 5, required: true },
  lockIn: { type: Number, min: 0, max: 100, required: true },
  tags: { type: [String], required: true },
  taxNotes: String,
  sharpeRatio: Number,
  score: { type: Number, min: 0, max: 100, required: true },
  scoreFactors: { type: scoreFactorSchema, required: true },
  allocation_pct: { type: Number, min: 0, max: 100, required: true },
  allocationWeight: { type: Number, min: 0, max: 1, required: true },
}, { _id: false, strict: 'throw' });

const recommendationUsabilitySchema = new mongoose.Schema({
  status: { type: String, enum: ['USABLE', 'NOT_USABLE'], default: null },
  reasonCodes: { type: [String], default: [] },
  observedAgeSeconds: { type: Number, min: 0, default: null },
  maxAgeSeconds: { type: Number, min: 0, default: null },
}, { _id: false, strict: false });

// Keep generation-time market evidence typed at its stable boundary while
// allowing additive fields from older/newer snapshots to round-trip safely.
const marketAdjustmentSchema = new mongoose.Schema({
  status: { type: String, enum: ['APPLIED', 'NOT_APPLIED', 'UNAVAILABLE'], default: null },
  // Internal generation-time provenance. It is intentionally excluded from
  // recommendation response snapshots and public DTOs.
  sourceProvider: { type: String, enum: ['NSE', 'UPSTOX', null], default: null },
  contextStatus: { type: String, default: null },
  context: { type: String, default: null },
  policyVersion: { type: String, default: null },
  observedAt: { type: Date, default: null },
  evaluatedAt: { type: Date, default: null },
  reasonCodes: { type: [String], default: [] },
  adjustmentVersion: { type: String, default: null },
  applied: { type: Boolean, default: false },
  maxTotalTiltPct: { type: Number, min: 0, default: null },
  actualTotalTiltPct: { type: Number, min: 0, default: null },
  baseWeights: { type: Map, of: Number, default: null },
  adjustedWeights: { type: Map, of: Number, default: null },
  changedInstruments: { type: [mongoose.Schema.Types.Mixed], default: [] },
  suitabilityValidation: { type: String, default: null },
  concentrationValidation: { type: String, default: null },
  recommendationUsability: { type: recommendationUsabilitySchema, default: null },
  currentAllocationSource: { type: String, enum: ['ORIGINAL_RECOMMENDATION', 'MARKET_CONTEXT_ADJUSTED', 'USER_REBALANCED'], default: null },
  supersededByManualRebalanceAt: { type: Date, default: null },
}, { _id: false, strict: false });

const recommendationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  profileId: { type: mongoose.Schema.Types.ObjectId, ref: 'FinancialProfile', required: true, immutable: true },
  instruments: [instrumentDetailSchema],
  advisoryText: { type: String },
  advisoryMetadata: { type: mongoose.Schema.Types.Mixed, default: null },
  confidenceScores: {
    type: Map,
    of: { type: Number, min: 0, max: 1 },
    default: {},
  },
  mlFallback: { type: Boolean, required: true },
  modelVersion: { type: String, required: true },
  regulatoryRuleVersion: { type: String, required: true },
  profileInputHash: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  profileVersion: { type: Number, required: true, min: 1, validate: Number.isInteger },
  recommendationPolicyVersion: { type: String, default: 'suitability-freeze-1.2.0', required: true },
  returnAssumptionHash: { type: String, match: /^[a-f0-9]{64}$/, default: null },
  recommendationGeneration: { type: Number, min: 1, default: 1, required: true },
  // Optional unique fields are omitted when absent so the indexes remain
  // compatible with MongoDB and Amazon DocumentDB.
  profileCompletionCandidateId: { type: String, immutable: true },
  idempotencyOperationId: { type: String, immutable: true },
  idempotencyRequestHash: { type: String, default: null, immutable: true },
  responseSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
  marketAdjustment: { type: marketAdjustmentSchema, default: null },
  currentAllocationSource: {
    type: String,
    enum: ['ORIGINAL_RECOMMENDATION', 'MARKET_CONTEXT_ADJUSTED', 'USER_REBALANCED'],
    default: 'ORIGINAL_RECOMMENDATION',
  },
  marketAdjustmentSupersededAt: { type: Date, default: null },
  generatedAt: { type: Date, default: Date.now },
}, { strict: 'throw' });

const IMMUTABLE_GENERATION_FIELDS = new Set([
  'instruments',
  'modelVersion',
  'regulatoryRuleVersion',
  'profileInputHash',
  'profileVersion',
  'recommendationPolicyVersion',
  'returnAssumptionHash',
  'recommendationGeneration',
  'responseSnapshot',
  'marketAdjustment',
  'currentAllocationSource',
  'generatedAt',
  'userId',
  'profileId',
  'idempotencyOperationId',
  'idempotencyRequestHash',
  'profileCompletionCandidateId',
]);

protectImmutableIdentity(recommendationSchema, [...IMMUTABLE_GENERATION_FIELDS], {
  code: 'RECOMMENDATION_GENERATION_IMMUTABLE',
  label: 'Recommendation generation',
});

recommendationSchema.index({ userId: 1, generatedAt: -1 });
recommendationSchema.index({ profileId: 1 });
const candidateIndex = optionalUniqueIndex('profileCompletionCandidateId', 'unique_profile_completion_candidate');
recommendationSchema.index(candidateIndex.key, candidateIndex.options);
const idempotencyIndex = optionalUniqueIndex('idempotencyOperationId', 'unique_advisory_idempotency_operation');
recommendationSchema.index(idempotencyIndex.key, idempotencyIndex.options);

recommendationSchema.pre('validate', function validateAuthoritativeRecommendation(next) {
  if (!Array.isArray(this.instruments) || this.instruments.length === 0) {
    this.invalidate('instruments', 'At least one authoritative instrument is required.');
    return next();
  }
  const ids = this.instruments.map(instrument => instrument.id);
  if (new Set(ids).size !== ids.length) this.invalidate('instruments', 'Instrument ids must be unique.');
  const totalWeight = this.instruments.reduce((sum, instrument) => sum + Number(instrument.allocationWeight), 0);
  if (!Number.isFinite(totalWeight) || Math.abs(totalWeight - 1) > 0.001) {
    this.invalidate('instruments', 'Instrument allocation weights must total 1.');
  }
  for (const instrument of this.instruments) {
    if (instrument.postTaxReturn !== null) {
      this.invalidate('instruments', 'Personalized recommendations must not persist post-tax returns.');
    }
    if (Math.abs(Number(instrument.allocation_pct) - Number(instrument.allocationWeight) * 100) > 0.011) {
      this.invalidate('instruments', `Allocation representations disagree for ${instrument.id}.`);
    }
    if (Number(instrument.effectiveYield) !== Number(instrument.nominalReturn)) {
      this.invalidate('instruments', `Effective yield must remain pre-tax nominal for ${instrument.id}.`);
    }
  }
  next();
});

export default mongoose.model('Recommendation', recommendationSchema);
