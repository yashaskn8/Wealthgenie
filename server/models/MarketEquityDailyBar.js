import mongoose from 'mongoose';

/**
 * Qualified, rights-cleared daily equity observations only. Separate from
 * MarketObservation because a trading DATE is not an intraday trade timestamp,
 * and adjusted closes must not overwrite raw closes.
 */
const marketEquityDailyBarSchema = new mongoose.Schema({
  schemaVersion: { type: String, required: true },
  provider: { type: String, enum: ['UPSTOX'], required: true },
  exchange: { type: String, enum: ['NSE', 'BSE'], required: true },
  isin: { type: String, required: true, match: /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/ },
  symbol: { type: String, default: null },
  tradingDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  priceBasis: { type: String, enum: ['UPSTOX_PROVIDER_NATIVE'], required: true },
  open: { type: Number, required: true, min: 0 },
  high: { type: Number, required: true, min: 0 },
  low: { type: Number, required: true, min: 0 },
  close: { type: Number, required: true, min: 0 },
  volume: { type: Number, default: null, min: 0 },
  adjustedClose: { type: Number, default: null, min: 0 },
  adjustmentFactor: { type: Number, default: null, min: 0 },
  source: {
    url: { type: String, required: true },
    instrumentId: { type: String, required: true },
    requestUrls: [{ type: String }],
    qualificationSourceUrls: [{
      provider: { type: String, enum: ['NSE', 'UPSTOX'], required: true },
      url: { type: String, required: true },
    }],
    datasetRevision: { type: String, default: null },
  },
  qualifiedCoverage: { type: String, required: true },
  qualificationBatchId: { type: String, required: true },
  coverageFromDate: { type: String, required: true },
  coverageToDate: { type: String, required: true },
  coverageSessionCount: { type: Number, required: true, min: 1 },
  fetchedAt: { type: Date, required: true },
  providerObservedAt: { type: Date, default: null },
  retainedUntil: { type: Date, required: true },
}, { strict: 'throw', timestamps: true, collection: 'market_equity_daily_bars' });

// Disjoint provider/price bases and immutable trading-date identity.
marketEquityDailyBarSchema.index({
  provider: 1, exchange: 1, isin: 1, priceBasis: 1, tradingDate: 1,
}, { unique: true, name: 'unique_qualified_equity_daily_bar' });
// A true TTL deletes records on or after the permitted retention deadline.
marketEquityDailyBarSchema.index({ retainedUntil: 1 }, {
  expireAfterSeconds: 0, name: 'expire_qualified_equity_daily_bar',
});
marketEquityDailyBarSchema.index({ exchange: 1, isin: 1, tradingDate: -1 });
marketEquityDailyBarSchema.index({
  qualificationBatchId: 1, provider: 1, exchange: 1, isin: 1,
  priceBasis: 1, tradingDate: 1,
}, { name: 'qualified_equity_history_batch_read' });

export default mongoose.model('MarketEquityDailyBar', marketEquityDailyBarSchema);
