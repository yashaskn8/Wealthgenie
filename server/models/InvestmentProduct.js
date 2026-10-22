import mongoose from 'mongoose';

const externalIdSchema = new mongoose.Schema({
  source: { type: String, required: true, trim: true },
  value: { type: String, required: true, trim: true },
}, { _id: false, strict: 'throw' });

const issuerSchema = new mongoose.Schema({
  canonicalIssuerId: { type: String, default: null, trim: true },
  name: { type: String, default: null, trim: true },
  issuerType: { type: String, enum: [
    'AMC', 'BANK', 'SMALL_FINANCE_BANK', 'COOPERATIVE_BANK', 'NBFC', 'COMPANY',
    'GOVERNMENT', 'PENSION_FUND_MANAGER', 'INSURER', 'REIT', 'INVIT', 'OTHER', null,
  ], default: null },
  website: { type: String, default: null, trim: true },
}, { _id: false, strict: 'throw' });

const verifiedTermSchema = new mongoose.Schema({
  status: { type: String, enum: ['VERIFIED', 'UNVERIFIED', 'NOT_APPLICABLE'], default: 'UNVERIFIED' },
  value: { type: mongoose.Schema.Types.Mixed, default: null },
  unit: { type: String, default: null, trim: true },
  effectiveFrom: { type: Date, default: null },
  effectiveTo: { type: Date, default: null },
  sourceReferenceId: { type: String, default: null, trim: true },
}, { _id: false, strict: 'throw' });

const eligibilitySchema = new mongoose.Schema({
  status: { type: String, enum: ['VERIFIED', 'UNVERIFIED', 'NOT_APPLICABLE'], default: 'UNVERIFIED' },
  minimumAge: { type: Number, default: null, min: 0, max: 150 },
  maximumAge: { type: Number, default: null, min: 0, max: 150 },
  investorClasses: { type: [String], default: [] },
  residencyRules: { type: [String], default: [] },
  employmentRules: { type: [String], default: [] },
  minimumInvestment: { type: Number, default: null, min: 0 },
  maximumInvestment: { type: Number, default: null, min: 0 },
  annualContributionLimit: { type: Number, default: null, min: 0 },
  sourceReferenceId: { type: String, default: null, trim: true },
}, { _id: false, strict: 'throw' });

const lifecycleSchema = new mongoose.Schema({
  status: { type: String, enum: [
    'OPEN_FOR_SUBSCRIPTION', 'OPEN_FOR_TRADING', 'SECONDARY_MARKET_ONLY',
    'CLOSED_TO_NEW_SUBSCRIPTIONS', 'DISCONTINUED', 'DORMANT', 'NOT_VERIFIED',
  ], default: 'NOT_VERIFIED' },
  effectiveFrom: { type: Date, default: null },
  effectiveTo: { type: Date, default: null },
  sourceReferenceId: { type: String, default: null, trim: true },
}, { _id: false, strict: 'throw' });

const availabilitySchema = new mongoose.Schema({
  status: { type: String, enum: ['AVAILABLE', 'HISTORICAL_ONLY', 'REFERENCE_ONLY', 'NOT_AVAILABLE', 'RIGHTS_UNVERIFIED', 'NOT_VERIFIED'], default: 'NOT_VERIFIED' },
  sourceReferenceId: { type: String, default: null, trim: true },
  observedAt: { type: Date, default: null },
  fetchedAt: { type: Date, default: null },
  dataClass: { type: String, enum: ['LIVE', 'DELAYED', 'DAILY', 'HISTORICAL', 'REFERENCE', 'MODEL_ASSUMPTION', null], default: null },
}, { _id: false, strict: 'throw' });

const dataAvailabilitySchema = new mongoose.Schema({
  currentPrice: { type: availabilitySchema, default: () => ({}) },
  nav: { type: availabilitySchema, default: () => ({}) },
  currentRate: { type: availabilitySchema, default: () => ({}) },
  historicalData: { type: availabilitySchema, default: () => ({}) },
  terms: { type: availabilitySchema, default: () => ({}) },
}, { _id: false, strict: 'throw' });

const investmentProductSchema = new mongoose.Schema({
  schemaVersion: { type: String, required: true },
  canonicalProductId: { type: String, required: true, unique: true, index: true },
  productType: { type: String, enum: [
    'MUTUAL_FUND', 'MARKET_INSTRUMENT', 'GOVERNMENT_SCHEME', 'GOVERNMENT_BOND', 'BANK_TERM_DEPOSIT',
    'SAVINGS_ACCOUNT', 'RECURRING_DEPOSIT', 'COMPANY_DEPOSIT', 'MUTUAL_FUND_SCHEME',
    'EXCHANGE_TRADED_FUND', 'LISTED_EQUITY', 'GOVERNMENT_SECURITY', 'CORPORATE_DEBT',
    'REIT_SCHEME', 'INVIT_SCHEME', 'RETIREMENT_PLAN', 'INSURANCE_PRODUCT',
    'ALTERNATIVE_INVESTMENT', 'COMMODITY_LINKED_PRODUCT', 'OTHER',
  ], required: true },
  assetClassId: { type: String, default: null, trim: true },
  categoryId: { type: String, default: null, trim: true },
  subcategoryId: { type: String, default: null, trim: true },
  name: { type: String, required: true, trim: true },
  aliases: { type: [String], default: [] },
  issuer: { type: issuerSchema, default: undefined },
  providerName: { type: String, default: null, trim: true },
  schemeCategory: { type: String, default: null, trim: true },
  plan: { type: String, default: null, trim: true },
  option: { type: String, default: null, trim: true },
  tenureMonths: { type: Number, default: null, min: 0 },
  tenureLabel: { type: String, default: null, trim: true },
  tenureMinDays: { type: Number, default: null, min: 0 },
  tenureMaxDaysExclusive: { type: Number, default: null, min: 1 },
  depositorType: { type: String, enum: ['GENERAL_PUBLIC', 'SENIOR_CITIZEN', null], default: null },
  depositType: { type: String, default: null, trim: true },
  callability: { type: String, default: null, trim: true },
  riskQuality: { type: String, default: null, trim: true },
  lifecycle: { type: lifecycleSchema, default: () => ({}) },
  eligibility: { type: eligibilitySchema, default: () => ({}) },
  minimumInvestment: { type: verifiedTermSchema, default: () => ({}) },
  maximumInvestment: { type: verifiedTermSchema, default: () => ({}) },
  investmentLimit: { type: verifiedTermSchema, default: () => ({}) },
  lockIn: { type: verifiedTermSchema, default: () => ({}) },
  liquidity: { type: verifiedTermSchema, default: () => ({}) },
  riskDimensions: {
    market: { type: verifiedTermSchema, default: () => ({}) },
    credit: { type: verifiedTermSchema, default: () => ({}) },
    liquidity: { type: verifiedTermSchema, default: () => ({}) },
  },
  feeTerms: { type: [verifiedTermSchema], default: [] },
  taxClassification: {
    status: { type: String, enum: ['VERIFIED', 'UNVERIFIED', 'NOT_APPLICABLE'], default: 'UNVERIFIED' },
    classificationId: { type: String, default: null, trim: true },
    fiscalYear: { type: String, default: null, trim: true },
    sourceReferenceId: { type: String, default: null, trim: true },
  },
  dataAvailability: { type: dataAvailabilitySchema, default: () => ({}) },
  externalIds: { type: [externalIdSchema], default: [] },
  source: {
    provider: { type: String, enum: ['AMFI', 'NSE', 'UPSTOX', 'GOVERNMENT_OF_INDIA', 'SBI', 'RBI'], required: true },
    url: { type: String, required: true },
  },
  sourceUpdatedAt: { type: Date, default: null },
  lastVerifiedAt: { type: Date, required: true },
}, { strict: 'throw', timestamps: true });

investmentProductSchema.index({ 'externalIds.source': 1, 'externalIds.value': 1 });
investmentProductSchema.index({ productType: 1, providerName: 1 });

export default mongoose.model('InvestmentProduct', investmentProductSchema);
