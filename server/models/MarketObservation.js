import mongoose from 'mongoose';

const freshnessSchema = new mongoose.Schema({
  status: { type: String, enum: ['FRESH', 'STALE', 'UNKNOWN'], required: true },
  ageSeconds: { type: Number, default: null, min: 0 },
  maxAgeSeconds: { type: Number, default: null, min: 0 },
  marketSession: { type: String, enum: ['MARKET_OPEN', 'MARKET_CLOSED', 'MARKET_HOLIDAY', 'UNKNOWN'], default: null },
  tradingDate: { type: String, default: null },
}, { _id: false, strict: 'throw' });

const metricsSchema = new mongoose.Schema({
  open: { type: Number, default: null },
  high: { type: Number, default: null },
  low: { type: Number, default: null },
  close: { type: Number, default: null },
  previousClose: { type: Number, default: null },
  volume: { type: Number, default: null },
  openInterest: { type: Number, default: null },
}, { _id: false, strict: 'throw' });

const marketObservationSchema = new mongoose.Schema({
  schemaVersion: { type: String, required: true },
  kind: {
    type: String,
    enum: [
      'MUTUAL_FUND_NAV',
      'MARKET_QUOTE',
      'MARKET_HISTORY_CANDLE',
      'MARKET_CONTEXT_SNAPSHOT',
      'SCHEME_INTEREST_RATE',
      'TERM_DEPOSIT_RATE',
    ],
    required: true,
  },
  canonicalProductId: { type: String, required: true, index: true },
  value: { type: Number, required: true },
  currency: { type: String, default: null },
  unit: { type: String, required: true },
  observedAt: { type: Date, required: true },
  providerTimestamp: { type: Date, default: null },
  effectiveTradingDate: { type: String, default: null },
  effectiveFrom: { type: String, default: null },
  effectiveTo: { type: String, default: null },
  publicationDate: { type: String, default: null },
  firstFetchedAt: { type: Date, required: true },
  lastFetchedAt: { type: Date, required: true },
  // Optional for legacy facts; only explicitly retained benchmark quotes carry
  // a deadline. MongoDB TTL ignores absent and null values.
  retainedUntil: { type: Date, default: null },
  dataClass: { type: String, enum: ['LIVE', 'DELAYED', 'DAILY', 'QUARTERLY_OFFICIAL_RATE', 'OFFICIAL_BANK_PUBLISHED_RATE', 'OFFICIAL_RBI_FLOATING_COUPON_RATE'], default: null },
  semanticClass: { type: String, enum: ['OBSERVED', 'DERIVED', 'POLICY_OUTPUT'], default: 'OBSERVED' },
  availabilityStatus: { type: String, enum: ['AVAILABLE'], required: true },
  freshness: { type: freshnessSchema, required: true },
  source: {
    provider: { type: String, enum: ['AMFI', 'NSE', 'UPSTOX', 'GOVERNMENT_OF_INDIA', 'SBI', 'RBI'], required: true },
    instrumentId: { type: String, required: true },
    url: { type: String, required: true },
  },
  metrics: { type: metricsSchema, default: () => ({}) },
  // A qualified market-context publication is derived from the observations
  // above. Keeping its immutable, provider-backed DTO beside those
  // observations lets the service recover after Redis/process restarts without
  // treating a cache entry as financial authority.
  snapshotPayload: { type: mongoose.Schema.Types.Mixed, default: null },
}, { strict: 'throw', timestamps: true });

marketObservationSchema.index(
  { kind: 1, 'source.provider': 1, 'source.instrumentId': 1, observedAt: 1 },
  { unique: true, name: 'unique_verified_market_observation' },
);
marketObservationSchema.index({ kind: 1, observedAt: -1 });
marketObservationSchema.index({ kind: 1, canonicalProductId: 1, 'source.provider': 1, observedAt: -1 },
  { name: 'latest_retained_benchmark_quote' });
marketObservationSchema.index({ retainedUntil: 1 },
  { expireAfterSeconds: 0, name: 'expire_retained_market_observation' });

export default mongoose.model('MarketObservation', marketObservationSchema);
