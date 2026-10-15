import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateMarketDataProductionRights } from '../services/marketData/marketDataRights.js';
import { AMFI_NAV_URL } from '../services/marketData/AmfiNavProvider.js';
import { AMFI_NAV_HISTORY_RIGHTS_URL } from '../services/marketData/AmfiNavHistoryProvider.js';
import { NSE_ALL_INDICES_URL } from '../services/marketData/NseMarketDataProvider.js';
import { NSE_HISTORICAL_INDEX_RIGHTS_URL } from '../services/marketData/NseHistoricalDataProvider.js';
import { NSE_TRADING_HOLIDAY_URL } from '../services/marketData/nseTradingCalendar.js';
import {
  UPSTOX_HISTORICAL_CANDLE_V3_RIGHTS_URL,
} from '../services/marketData/UpstoxHistoricalCandleProvider.js';
import { UPSTOX_QUOTE_RIGHTS_URL } from '../services/marketData/UpstoxMarketDataProvider.js';
import { UPSTOX_INSTRUMENT_REGISTRY } from '../services/marketData/upstoxInstrumentRegistry.js';
import { TEJHQ_API_BASE_URL } from '../services/marketData/TejHqHistoricalDataProvider.js';
import {
  INDIA_POST_SAVINGS_URL,
  INDIA_POST_SCRIPT_CHUNK_RIGHTS_URL,
} from '../services/marketData/GovernmentSmallSavingsProvider.js';
import { SBI_TERM_DEPOSIT_URL } from '../services/marketData/SbiTermDepositProvider.js';
import { RBI_FRSB_NOTIFICATION_URL } from '../services/marketData/RbiFloatingRateSavingsBondProvider.js';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverDirectory = path.resolve(scriptDirectory, '..');
const catalogPath = path.join(serverDirectory, 'data', 'investment_master.json');
const outputPath = path.join(serverDirectory, 'data', 'market_data_coverage.json');

const NOT_PROBED = 'NOT_PROBED';
const INDIA_POST_RIGHTS_ENDPOINTS = Object.freeze([
  { provider: 'GOVERNMENT_OF_INDIA', url: INDIA_POST_SAVINGS_URL },
  { provider: 'GOVERNMENT_OF_INDIA', url: INDIA_POST_SCRIPT_CHUNK_RIGHTS_URL },
]);

const PROVIDER_PATHS = Object.freeze([
  {
    pathId: 'nse.market-context-pair',
    provider: 'NSE',
    rightsEndpoints: [
      { provider: 'NSE', url: NSE_ALL_INDICES_URL },
      { provider: 'NSE', url: NSE_HISTORICAL_INDEX_RIGHTS_URL },
      { provider: 'NSE', url: NSE_TRADING_HOLIDAY_URL },
    ],
    exactIdentity: ['market:index:nifty-50', 'market:index:india-vix'],
    dataTypes: ['LIVE_INDEX_QUOTES', 'NIFTY_50_DAILY_HISTORY'],
    authorizationGate: 'Exact NSE market-data endpoint permissions are not present in the repository source-rights register; production fetching and display fail closed.',
    implementationAvailability: 'IMPLEMENTED',
    runtimeAvailability: NOT_PROBED,
    freshnessSemantics: 'Quote observation timestamps and freshness; historical NIFTY 50 candles are checked against the qualified NSE weekday-minus-holiday session model. Exceptional weekend sessions and unscheduled closures are outside that calendar model.',
    implementedConsumers: {
      api: [
        { method: 'GET', path: '/api/regime/current', use: 'Coherent quote-and-history pair for deterministic market context.' },
        { method: 'POST', path: '/api/market/refresh', use: 'Admin refresh includes the qualified NSE market-context pair when NSE is selected and permitted.' },
      ],
      internal: ['marketContextService.getLiveMarketContext', 'marketDataService.fetchQualifiedMarketContextSnapshots'],
      frontend: [{ component: 'useMarketContext', api: 'GET /api/regime/current', status: 'ACTIVE_CALLER' }],
      operatorScripts: [{
        command: 'npm run qualify:nse --prefix server',
        use: 'Explicit operator qualification reads NSE index quotes, historical index evidence, and the holiday calendar.',
        requiredGates: ['Exact source rights for every endpoint and the intended-use scope.', 'MARKET_DATA_QUALIFICATION_LIVE_ENABLED=true.'],
      }],
    },
    missingPrerequisites: ['Provider service and source freshness were not probed in this report run.'],
  },
  {
    pathId: 'nse.index-quotes',
    provider: 'NSE',
    rightsEndpoints: [
      { provider: 'NSE', url: NSE_ALL_INDICES_URL },
      { provider: 'NSE', url: NSE_TRADING_HOLIDAY_URL },
    ],
    exactIdentity: ['market:index:nifty-50', 'market:index:india-vix'],
    dataTypes: ['LIVE_INDEX_QUOTES'],
    authorizationGate: 'Exact NSE market-data endpoint permissions are not present in the repository source-rights register; production quote fetching and display fail closed.',
    implementationAvailability: 'IMPLEMENTED',
    runtimeAvailability: NOT_PROBED,
    freshnessSemantics: 'Quote observation timestamps and freshness; the NSE holiday endpoint is also checked by the bounded benchmark-quote service gate.',
    implementedConsumers: {
      api: [
        { method: 'GET', path: '/api/market/benchmarks', use: 'Bounded NIFTY 50 and India VIX quote snapshot when NSE is the configured primary market provider.' },
        { method: 'GET', path: '/api/market/rates', use: 'Benchmark quote and source-health summary when NSE is the configured primary market provider.' },
      ],
      internal: ['marketDataService.fetchBenchmarkQuotes'],
      frontend: [],
    },
    missingPrerequisites: ['Exact NSE quote and holiday endpoint permissions are not qualified.', 'Provider service and source freshness were not probed in this report run.'],
  },
  {
    pathId: 'nse.index-history',
    provider: 'NSE',
    rightsEndpoints: [
      { provider: 'NSE', url: NSE_HISTORICAL_INDEX_RIGHTS_URL },
      { provider: 'NSE', url: NSE_TRADING_HOLIDAY_URL },
    ],
    exactIdentity: ['market:index:nifty-50', 'market:index:india-vix'],
    dataTypes: ['NIFTY_50_DAILY_HISTORY', 'INDIA_VIX_DAILY_HISTORY'],
    authorizationGate: 'Exact NSE historical-index and trading-calendar endpoint permissions plus the separate live-qualification opt-in are required before operator export.',
    implementationAvailability: 'IMPLEMENTED',
    runtimeAvailability: NOT_PROBED,
    freshnessSemantics: 'NSE historical index observations are qualified against the provider calendar; this operator export does not create current market-context state or recommendation authority.',
    implementedConsumers: {
      api: [],
      internal: ['NseHistoricalDataProvider.getDailyCandles', 'nseTradingCalendar.fetchNseTradingHolidays'],
      frontend: [],
      operatorScripts: [{
        command: 'npm run export:market-regime-data -- --from <date> --to <date> --output <path>',
        use: 'Explicit operator export of historical NIFTY 50 and India VIX observations for the shadow market-regime dataset.',
        requiredGates: [
          'Exact source rights for every endpoint and the intended-use scope.',
          'MARKET_DATA_QUALIFICATION_LIVE_ENABLED=true.',
        ],
      }],
    },
    missingPrerequisites: ['Provider reachability and requested historical coverage were not probed.'],
  },
  {
    pathId: 'upstox.market-context-pair',
    provider: 'UPSTOX',
    rightsEndpoints: [
      { provider: 'UPSTOX', url: UPSTOX_QUOTE_RIGHTS_URL },
      { provider: 'UPSTOX', url: UPSTOX_HISTORICAL_CANDLE_V3_RIGHTS_URL },
    ],
    exactIdentity: {
      quotes: ['market:index:nifty-50', 'market:index:india-vix'],
      providerKeys: Object.values(UPSTOX_INSTRUMENT_REGISTRY).map(identity => identity.upstoxInstrumentKey),
      history: 'market:index:nifty-50',
    },
    providerAccessStatus: 'NOT_LIVE_VERIFIED',
    dataTypes: ['LIVE_INDEX_QUOTES', 'NIFTY_50_DAILY_HISTORY'],
    authorizationGate: 'Exact provider and endpoint rights plus the approved production market-data scope are required; UPSTOX_PUBLIC_MARKET_DATA_LICENSE_CONFIRMED=true is an additional operator gate and cannot grant rights.',
    implementationAvailability: 'IMPLEMENTED',
    runtimeAvailability: NOT_PROBED,
    freshnessSemantics: 'Quote observation timestamps and freshness; history is checked for provider identity, daily-candle structure, timestamp bounds, and freshness. This market-context path does not apply the NSE expected-session coverage check used by the separate equity-history path.',
    implementedConsumers: {
      api: [
        { method: 'GET', path: '/api/regime/current', use: 'Coherent quote-and-history pair only when production distribution gate permits Upstox provenance.' },
        { method: 'POST', path: '/api/market/refresh', use: 'Admin refresh includes the qualified Upstox market-context pair when Upstox is selected and permitted.' },
      ],
      internal: ['marketDataService.fetchQualifiedMarketContextSnapshots', 'marketContextService.getLiveMarketContext'],
      frontend: [{ component: 'useMarketContext', api: 'GET /api/regime/current', status: 'ACTIVE_CALLER_WHEN_PROVIDER_PATH_IS_ALLOWED' }],
    },
    missingPrerequisites: ['Exact quote/history endpoint rights and production scope are unverified.', 'Provider credentials, account access, and live response have not been probed.'],
  },
  {
    pathId: 'upstox.index-quotes',
    provider: 'UPSTOX',
    rightsEndpoints: [{ provider: 'UPSTOX', url: UPSTOX_QUOTE_RIGHTS_URL }],
    exactIdentity: {
      canonicalIds: ['market:index:nifty-50', 'market:index:india-vix'],
      providerKeys: Object.values(UPSTOX_INSTRUMENT_REGISTRY).map(identity => identity.upstoxInstrumentKey),
    },
    providerAccessStatus: 'NOT_LIVE_VERIFIED',
    dataTypes: ['LIVE_INDEX_QUOTES'],
    authorizationGate: 'Exact Upstox quote-endpoint rights and the approved production market-data scope are required; UPSTOX_PUBLIC_MARKET_DATA_LICENSE_CONFIRMED=true is an additional operator gate and cannot grant rights.',
    implementationAvailability: 'IMPLEMENTED',
    runtimeAvailability: NOT_PROBED,
    freshnessSemantics: 'Quote observation timestamps and freshness; this path covers standalone quote snapshots and does not require historical-candle endpoint rights.',
    implementedConsumers: {
      api: [
        { method: 'GET', path: '/api/market/benchmarks', use: 'Bounded NIFTY 50 and India VIX quote snapshot when Upstox is the configured primary market provider.' },
        { method: 'GET', path: '/api/market/rates', use: 'Benchmark quote and source-health summary when Upstox is the configured primary market provider.' },
        { method: 'GET', path: '/api/market-data/quotes', use: 'Allowlisted canonical index quotes; production route requires exact source rights and its additional distribution gate.' },
      ],
      internal: ['marketDataService.fetchBenchmarkQuotes', 'marketDataService.fetchUpstoxCanonicalQuotes'],
      frontend: [{ component: 'DataFreshnessBar', api: 'GET /api/market/rates', status: 'ACTIVE_CALLER_FOR_SOURCE_SUMMARY' }],
    },
    missingPrerequisites: ['Exact quote-endpoint rights and production scope are unverified.', 'Provider credentials, account access, and live response have not been probed.'],
  },
  {
    pathId: 'upstox.nse-equity-history',
    provider: 'UPSTOX',
    rightsEndpoints: [
      { provider: 'UPSTOX', url: UPSTOX_HISTORICAL_CANDLE_V3_RIGHTS_URL },
      { provider: 'NSE', url: NSE_TRADING_HOLIDAY_URL },
    ],
    exactIdentity: null,
    identityRequirements: 'Per request: NSE exchange, verified ISIN, and current exchange symbol continuity; no catalog-bound equity identity is declared here.',
    dataTypes: ['RAW_DAILY_OHLC_HISTORY'],
    authorizationGate: 'Exact historical endpoint rights and the approved production market-data scope are required; the operator flag cannot grant rights.',
    implementationAvailability: 'IMPLEMENTED',
    runtimeAvailability: NOT_PROBED,
    freshnessSemantics: 'Expected NSE weekday-minus-holiday sessions are checked for exact date coverage. Current-session candles are rejected without publication evidence. BSE requests fail closed because no qualified BSE session calendar is present.',
    implementedConsumers: {
      api: [{ method: 'GET', path: '/api/market-data/admin/equity-history', use: 'Admin-only qualified raw history; not a recommendation or catalog-price feed.' }],
      internal: ['marketDataService.fetchQualifiedEquityHistory', 'UpstoxHistoricalCandleProvider.getDailyCandles', 'nseTradingCalendar.fetchNseTradingHolidays'],
      frontend: [],
    },
    missingPrerequisites: ['A per-request qualified NSE symbol/ISIN identity is required.', 'Exact NSE holiday-calendar endpoint rights are also required to qualify expected trading sessions.', 'Provider credentials, account access, and live response have not been probed.', 'BSE history is unavailable until a qualified BSE calendar is implemented.'],
  },
  {
    pathId: 'tejhq.nse-equity-history-fallback',
    provider: 'TEJHQ',
    rightsEndpoints: [
      { provider: 'TEJHQ', url: `${TEJHQ_API_BASE_URL}/v1/ohlcv/nse/{symbol}?from={fromDate}&to={toDate}` },
      { provider: 'TEJHQ', url: `${TEJHQ_API_BASE_URL}/v1/symbols/nse?isin={isin}` },
      { provider: 'TEJHQ', url: `${TEJHQ_API_BASE_URL}/v1/status` },
      { provider: 'NSE', url: NSE_TRADING_HOLIDAY_URL },
    ],
    exactIdentity: null,
    identityRequirements: 'Per request: qualified NSE exchange and ISIN, verified symbol-history continuity, exact expected trading-date coverage, and acceptable provider publication status.',
    dataTypes: ['RAW_DAILY_OHLC_HISTORY'],
    authorizationGate: 'Exact TejHQ endpoint rights and the approved production market-data scope are required before the adapter can read cache or call the provider. Environment flags are additional gates only.',
    implementationAvailability: 'IMPLEMENTED',
    runtimeAvailability: NOT_PROBED,
    freshnessSemantics: 'Publication status, symbol history, and exact expected NSE session dates qualify fallback data; date-only observations do not establish intraday freshness.',
    implementedConsumers: {
      api: [{ method: 'GET', path: '/api/market-data/admin/equity-history', use: 'NSE EOD fallback after Upstox history is unqualified; admin-only.' }],
      internal: ['marketDataService.fetchQualifiedEquityHistory', 'TejHqHistoricalDataProvider.getRawHistory', 'TejHqHistoricalDataProvider.getSymbolHistory', 'TejHqHistoricalDataProvider.getStatus', 'nseTradingCalendar.fetchNseTradingHolidays'],
      frontend: [],
    },
    missingPrerequisites: ['Permitted use/license remains unconfirmed and feature is disabled by default.', 'Exact TejHQ OHLCV, NSE symbol-history, publication-status, and NSE holiday-calendar endpoint rights are required.', 'API key, capability access, and runtime response have not been probed.', 'A qualified NSE identity and publication evidence are required per request.'],
  },
  {
    pathId: 'tejhq.adjusted-equity-history',
    provider: 'TEJHQ',
    rightsEndpoints: [
      { provider: 'TEJHQ', url: `${TEJHQ_API_BASE_URL}/v1/adjusted/nse/{symbol}?from={fromDate}&to={toDate}` },
      { provider: 'TEJHQ', url: `${TEJHQ_API_BASE_URL}/v1/symbols/nse?isin={isin}` },
      { provider: 'TEJHQ', url: `${TEJHQ_API_BASE_URL}/v1/status` },
      { provider: 'NSE', url: NSE_TRADING_HOLIDAY_URL },
    ],
    exactIdentity: null,
    identityRequirements: 'Per request: qualified exchange, ISIN, and symbol continuity; adjusted-history parser additionally requires corporate-action adjustment-chain evidence.',
    dataTypes: ['BACK_ADJUSTED_CLOSE_WITH_RAW_OHLC'],
    authorizationGate: 'Exact TejHQ endpoint rights and the approved production market-data scope are required before the adapter can read cache or call the provider. Environment flags and credentials do not prove the license scope.',
    implementationAvailability: 'IMPLEMENTED',
    runtimeAvailability: NOT_PROBED,
    freshnessSemantics: 'Provider dataset dates plus bounded cache. Output preserves raw OHLC and exposes adjusted close separately; this is historical adjusted evidence, not a live price.',
    implementedConsumers: {
      api: [{ method: 'GET', path: '/api/market-data/admin/equity-history', use: 'Admin-only adjusted history when the adjusted query mode is requested.' }],
      internal: ['marketDataService.fetchQualifiedEquityHistory', 'TejHqHistoricalDataProvider.getAdjustedHistory', 'TejHqHistoricalDataProvider.getSymbolHistory', 'TejHqHistoricalDataProvider.getStatus', 'nseTradingCalendar.fetchNseTradingHolidays'],
      frontend: [],
    },
    missingPrerequisites: ['Permitted use/license scope remains unconfirmed.', 'Exact TejHQ adjusted-history, NSE symbol-history, publication-status, and NSE holiday-calendar endpoint rights are required.', 'Keyed capability, adjustment-chain evidence, and runtime response have not been probed.', 'Exact per-request security identity is required.'],
  },
  {
    pathId: 'tejhq.corporate-actions',
    provider: 'TEJHQ',
    rightsEndpoints: [
      { provider: 'TEJHQ', url: `${TEJHQ_API_BASE_URL}/v1/actions/{symbol}` },
      { provider: 'TEJHQ', url: `${TEJHQ_API_BASE_URL}/v1/symbols/{exchange}?isin={isin}` },
    ],
    exactIdentity: null,
    identityRequirements: 'Per request: exact provider trading symbol; action response must match that symbol.',
    dataTypes: ['CORPORATE_ACTION_EVENTS'],
    authorizationGate: 'Exact TejHQ endpoint rights and the approved production market-data scope are required before the adapter can read cache or call the provider. Environment flags are additional gates only.',
    implementationAvailability: 'IMPLEMENTED',
    runtimeAvailability: NOT_PROBED,
    freshnessSemantics: 'Provider event dates and bounded cache; no live freshness claim is made by this coverage report.',
    implementedConsumers: {
      api: [{ method: 'GET', path: '/api/market-data/admin/tejhq/corporate-actions', use: 'Admin-only corporate-action evidence.' }],
      internal: ['marketDataService.fetchTejHqCorporateActionEvidence', 'TejHqHistoricalDataProvider.getCorporateActions', 'TejHqHistoricalDataProvider.getSymbolHistory'],
      frontend: [],
    },
    missingPrerequisites: ['Permitted use/license remains unconfirmed and feature is disabled by default.', 'Keyed provider capability and live response have not been probed.', 'Exact provider symbol is required per request.'],
  },
  {
    pathId: 'tejhq.publication-status',
    provider: 'TEJHQ',
    rightsEndpoints: [{ provider: 'TEJHQ', url: `${TEJHQ_API_BASE_URL}/v1/status` }],
    exactIdentity: 'provider:tejhq:publication-status',
    dataTypes: ['DATASET_PUBLICATION_STATUS'],
    authorizationGate: 'Exact TejHQ endpoint rights and the approved production market-data scope are required before the adapter can read cache or call the provider. Environment flags are additional gates only.',
    implementationAvailability: 'IMPLEMENTED',
    runtimeAvailability: NOT_PROBED,
    freshnessSemantics: 'Status snapshot reports dataset trading date and reported publication timestamps; expected exchange-session status remains unknown without a qualified session calendar.',
    implementedConsumers: {
      api: [{ method: 'GET', path: '/api/market-data/admin/tejhq/status', use: 'Admin-only provider publication status.' }],
      internal: ['marketDataService.fetchTejHqProviderPublicationStatus', 'marketDataService.fetchQualifiedEquityHistory'],
      frontend: [],
    },
    missingPrerequisites: ['Permitted use/license remains unconfirmed and provider is disabled by default.', 'Status endpoint reachability and current publication state have not been probed.'],
  },
  {
    pathId: 'amfi.mutual-fund-nav-and-history',
    provider: 'AMFI',
    rightsEndpoints: [
      { provider: 'AMFI', url: AMFI_NAV_URL },
      { provider: 'AMFI', url: AMFI_NAV_HISTORY_RIGHTS_URL },
    ],
    exactIdentity: null,
    identityRequirements: 'An exact AMFI scheme code and source-qualified product/category mapping are required; this catalog matrix does not infer scheme identity from product names.',
    dataTypes: ['CURRENT_NAV', 'HISTORICAL_NAV'],
    authorizationGate: 'The repository source-rights register blocks production reuse/display pending qualifying permission.',
    implementationAvailability: 'IMPLEMENTED',
    runtimeAvailability: NOT_PROBED,
    freshnessSemantics: 'Current NAV requires a positive fresh observation (maximum age 4 days); history is fetched with a bounded cache and the ranking contract requires an approximately one-year verified date pair.',
    implementedConsumers: {
      api: [
        { method: 'GET', path: '/api/market/mutual-funds/nav', use: 'Bounded lookup for explicitly supplied AMFI scheme codes.' },
        { method: 'GET', path: '/api/market/rates', use: 'AMFI source-health summary.' },
        { method: 'POST', path: '/api/market/refresh', use: 'Admin refresh fetches and persists current AMFI NAV and historical AMFI NAV evidence.' },
        { method: 'POST', path: '/api/instruments/rank-wti', use: 'AMFI evidence for server-side mutual-fund ranking/comparison when the exact product contract qualifies.' },
      ],
      internal: ['RecommendationPipeline AMFI ranking/comparison', 'marketDataService.getMarketDataSummary'],
      frontend: [{ component: 'DataFreshnessBar', api: 'GET /api/market/rates', status: 'ACTIVE_CALLER_FOR_SOURCE_SUMMARY' }],
    },
    missingPrerequisites: ['Catalog products without an exact AMFI scheme-code binding remain unmapped.', 'Provider reachability and current data have not been probed.'],
  },
  {
    pathId: 'india-post.small-savings-rates',
    provider: 'Government of India / India Post',
    rightsEndpoints: INDIA_POST_RIGHTS_ENDPOINTS,
    exactIdentity: ['government:india-post:ppf', 'government:india-post:scss', 'government:india-post:sukanya', 'government:india-post:nsc', 'government:india-post:kvp', 'government:india-post:pomis', 'government:india-post:post-office-rd-5y', 'government:india-post:post-office-td-1y'],
    dataTypes: ['OFFICIAL_EFFECTIVE_INTERVAL_RATE'],
    authorizationGate: 'The repository source-rights register blocks public/commercial display pending qualifying permission.',
    implementationAvailability: 'IMPLEMENTED',
    runtimeAvailability: NOT_PROBED,
    freshnessSemantics: 'Rate facts carry official effective intervals and are evaluated against the current date; publication cycle is quarterly.',
    implementedConsumers: {
      api: [
        { method: 'GET', path: '/api/market/government-schemes', use: 'Official small-savings snapshot.' },
        { method: 'GET', path: '/api/market/rates', use: 'Source-health summary.' },
        { method: 'POST', path: '/api/market/refresh', use: 'Admin refresh fetches and persists the official small-savings snapshot.' },
        { method: 'POST', path: '/api/instruments/rank-wti', use: 'Official small-savings facts in server-side fixed-income comparison when the exact product contract qualifies.' },
      ],
      internal: ['RecommendationPipeline fixed-income eligibility/comparison', 'RbiFloatingRateSavingsBondProvider NSC reset-rate input'],
      frontend: [{ component: 'DataFreshnessBar', api: 'GET /api/market/rates', status: 'ACTIVE_CALLER_FOR_SOURCE_SUMMARY' }],
      operatorScripts: [{
        command: 'npm run qualify:fixed-income --prefix server',
        use: 'Explicit operator qualification reads the official India Post small-savings rate source.',
        requiredGates: ['Exact source rights for the requested endpoint and the intended-use scope.', 'MARKET_DATA_QUALIFICATION_LIVE_ENABLED=true.'],
      }],
    },
    missingPrerequisites: ['Product-specific user eligibility and tax treatment are outside this provider coverage report.', 'Provider reachability and current rate interval have not been probed.'],
  },
  {
    pathId: 'sbi.retail-domestic-term-deposit-rates',
    provider: 'State Bank of India',
    rightsEndpoints: [{ provider: 'SBI', url: SBI_TERM_DEPOSIT_URL }],
    exactIdentity: null,
    identityRequirements: 'A qualified SBI retail domestic term-deposit row must include requested tenure and depositor category; parent catalog entry sbi_fd does not supply those exact facts.',
    dataTypes: ['PUBLISHED_CARD_RATE'],
    authorizationGate: 'The repository source-rights register blocks public/commercial card-rate display pending qualifying permission.',
    implementationAvailability: 'IMPLEMENTED',
    runtimeAvailability: NOT_PROBED,
    freshnessSemantics: 'Published card-rate date plus tenure and depositor category; the provider is limited to SBI retail domestic card rates.',
    implementedConsumers: {
      api: [
        { method: 'GET', path: '/api/market/fixed-deposits/sbi', use: 'Qualified SBI retail domestic term-deposit snapshot.' },
        { method: 'GET', path: '/api/market/rates', use: 'Source-health summary.' },
        { method: 'POST', path: '/api/market/refresh', use: 'Admin refresh fetches and persists qualified SBI retail domestic card rates.' },
        { method: 'POST', path: '/api/instruments/rank-wti', use: 'Qualified SBI term-deposit facts in server-side fixed-income comparison.' },
      ],
      internal: ['RecommendationPipeline fixed-income eligibility/comparison', 'marketDataService.getMarketDataSummary'],
      frontend: [{ component: 'DataFreshnessBar', api: 'GET /api/market/rates', status: 'ACTIVE_CALLER_FOR_SOURCE_SUMMARY' }],
      operatorScripts: [{
        command: 'npm run qualify:fixed-income --prefix server',
        use: 'Explicit operator qualification reads the qualified SBI retail domestic term-deposit rate source.',
        requiredGates: ['Exact source rights for the requested endpoint and the intended-use scope.', 'MARKET_DATA_QUALIFICATION_LIVE_ENABLED=true.'],
      }],
    },
    missingPrerequisites: ['The sbi_fd parent catalog row has no exact tenure/depositor-category observation binding.', 'Provider reachability and current card rates have not been probed.'],
  },
  {
    pathId: 'rbi.floating-rate-savings-bond',
    provider: 'Reserve Bank of India / Government of India',
    rightsEndpoints: [
      { provider: 'RBI', url: RBI_FRSB_NOTIFICATION_URL },
      ...INDIA_POST_RIGHTS_ENDPOINTS,
    ],
    exactIdentity: 'government:rbi:frsb-2020-taxable',
    dataTypes: ['CURRENT_RESET_PERIOD_COUPON', 'OFFICIAL_BOND_TERMS'],
    authorizationGate: 'RBI and its India Post NSC dependency remain unverified or blocked in the repository source-rights register.',
    implementationAvailability: 'IMPLEMENTED',
    runtimeAvailability: NOT_PROBED,
    freshnessSemantics: 'Current coupon is tied to the applicable NSC reset-date evidence and Jan 1/Jul 1 reset periods; it is not a fixed lifetime rate.',
    implementedConsumers: {
      api: [{ method: 'POST', path: '/api/instruments/rank-wti', use: 'Server-authoritative fixed-income comparison when reset-period evidence qualifies.' }],
      internal: ['RecommendationPipeline fixed-income eligibility/comparison', 'RbiFloatingRateSavingsBondProvider'],
      frontend: [],
      operatorScripts: [{
        command: 'npm run qualify:fixed-income --prefix server',
        use: 'Explicit operator qualification reads RBI bond-rule evidence and the India Post NSC reset-rate input.',
        requiredGates: ['Exact source rights for both endpoints and the intended-use scope.', 'MARKET_DATA_QUALIFICATION_LIVE_ENABLED=true.'],
      }],
    },
    missingPrerequisites: ['Applicable reset-date NSC evidence must be available and fresh.', 'Provider inputs and current reset-period coupon have not been probed.'],
  },
  {
    pathId: 'wealthgenie.projection-model-assumptions',
    provider: 'WealthGenie model policy (not an external provider)',
    exactIdentity: null,
    identityRequirements: 'Uses versioned model assumption keys; no provider security identity applies.',
    dataTypes: ['MODEL_ASSUMPTION'],
    authorizedUseStatus: 'INTERNAL_SIMULATION_POLICY_ONLY',
    authorizationGate: 'Projection responses explicitly mark assumptions as not observed market facts and not provider forecasts.',
    implementationAvailability: 'IMPLEMENTED',
    runtimeAvailability: NOT_PROBED,
    freshnessSemantics: 'Versioned policy values, not a market observation; provider refresh must not rewrite the assumptions.',
    implementedConsumers: {
      api: [
        { method: 'POST', path: '/api/projection', use: 'Simulation only.' },
        { method: 'POST', path: '/api/projection/step-up', use: 'Simulation only.' },
        { method: 'POST', path: '/api/projection/compare', use: 'Simulation only.' },
        { method: 'POST', path: '/api/projection/stress-test', use: 'Simulation only.' },
      ],
      internal: ['projectionEngine', 'marketDataService.getInstrumentModelAssumptions'],
      frontend: [{ component: 'Projection and deep-dive API clients', api: 'POST /api/projection/*', status: 'ACTIVE_CALLER' }],
    },
    missingPrerequisites: ['No external provider observation is applicable; assumptions must remain visibly identified by policy version and simulation semantics.'],
  },
]);

const OFFICIAL_RATE_FACTS = Object.freeze({
  ppf: {
    dataClass: 'PUBLISHED_RATE',
    canonicalSourceId: 'government:india-post:ppf',
    provider: 'Government of India / India Post',
    rightsEndpoints: INDIA_POST_RIGHTS_ENDPOINTS,
    service: 'GovernmentSmallSavingsProvider',
    freshnessSemantics: 'Official effective interval; quarterly publication cycle.',
  },
  scss: {
    dataClass: 'PUBLISHED_RATE',
    canonicalSourceId: 'government:india-post:scss',
    provider: 'Government of India / India Post',
    rightsEndpoints: INDIA_POST_RIGHTS_ENDPOINTS,
    service: 'GovernmentSmallSavingsProvider',
    freshnessSemantics: 'Official effective interval; quarterly publication cycle.',
  },
  sukanya: {
    dataClass: 'PUBLISHED_RATE',
    canonicalSourceId: 'government:india-post:sukanya',
    provider: 'Government of India / India Post',
    rightsEndpoints: INDIA_POST_RIGHTS_ENDPOINTS,
    service: 'GovernmentSmallSavingsProvider',
    freshnessSemantics: 'Official effective interval; quarterly publication cycle.',
  },
  nsc: {
    dataClass: 'PUBLISHED_RATE',
    canonicalSourceId: 'government:india-post:nsc',
    provider: 'Government of India / India Post',
    rightsEndpoints: INDIA_POST_RIGHTS_ENDPOINTS,
    service: 'GovernmentSmallSavingsProvider',
    freshnessSemantics: 'Official effective interval; quarterly publication cycle.',
  },
  kvp: {
    dataClass: 'PUBLISHED_RATE',
    canonicalSourceId: 'government:india-post:kvp',
    provider: 'Government of India / India Post',
    rightsEndpoints: INDIA_POST_RIGHTS_ENDPOINTS,
    service: 'GovernmentSmallSavingsProvider',
    freshnessSemantics: 'Official effective interval; quarterly publication cycle.',
  },
  pomis: {
    dataClass: 'PUBLISHED_RATE',
    canonicalSourceId: 'government:india-post:pomis',
    provider: 'Government of India / India Post',
    rightsEndpoints: INDIA_POST_RIGHTS_ENDPOINTS,
    service: 'GovernmentSmallSavingsProvider',
    freshnessSemantics: 'Official effective interval; quarterly publication cycle.',
  },
  po_rd: {
    dataClass: 'PUBLISHED_RATE',
    canonicalSourceId: 'government:india-post:post-office-rd-5y',
    provider: 'Government of India / India Post',
    rightsEndpoints: INDIA_POST_RIGHTS_ENDPOINTS,
    service: 'GovernmentSmallSavingsProvider',
    freshnessSemantics: 'Official effective interval; five-year Post Office RD only.',
  },
  po_td_1yr: {
    dataClass: 'PUBLISHED_RATE',
    canonicalSourceId: 'government:india-post:post-office-td-1y',
    provider: 'Government of India / India Post',
    rightsEndpoints: INDIA_POST_RIGHTS_ENDPOINTS,
    service: 'GovernmentSmallSavingsProvider',
    freshnessSemantics: 'Official effective interval; one-year Post Office TD only.',
  },
  sbi_fd: {
    dataClass: 'PUBLISHED_RATE',
    canonicalSourceId: null,
    provider: 'State Bank of India',
    rightsEndpoints: [{ provider: 'SBI', url: SBI_TERM_DEPOSIT_URL }],
    service: 'SbiTermDepositProvider',
    freshnessSemantics: 'SBI retail domestic card-rate publication date; requires tenure and depositor category.',
  },
  rbi_bonds: {
    dataClass: 'AUCTION_OR_BOND_TERMS',
    canonicalSourceId: 'government:rbi:frsb-2020-taxable',
    provider: 'Reserve Bank of India / Government of India',
    rightsEndpoints: [
      { provider: 'RBI', url: RBI_FRSB_NOTIFICATION_URL },
      ...INDIA_POST_RIGHTS_ENDPOINTS,
    ],
    service: 'RbiFloatingRateSavingsBondProvider',
    freshnessSemantics: 'Current reset-period coupon and official bond terms; not a fixed lifetime rate.',
  },
});

function assessRightsEndpoints(endpoints = []) {
  return endpoints.map(({ provider, url }) => evaluateMarketDataProductionRights(provider, url));
}

function rightsStatus(rightsChecks) {
  if (rightsChecks.length === 0) return 'NOT_APPLICABLE';
  const priority = [
    'BLOCKED_REUSE_RIGHTS',
    'BLOCKED_AUTOMATED_ACCESS',
    'DEVELOPMENT_RESEARCH_ONLY',
    'PERSONAL_USE_ONLY',
    'LICENSE_UNVERIFIED',
    'APPROVED_LIMITED_USE',
    'APPROVED_FOR_INTENDED_USE',
  ];
  return priority.find(status => rightsChecks.some(check => check.status === status)) || 'LICENSE_UNVERIFIED';
}

function buildProviderPath(pathDefinition) {
  if (pathDefinition.pathId === 'wealthgenie.projection-model-assumptions') {
    return {
      ...pathDefinition,
      authorizedUseStatus: 'INTERNAL_SIMULATION_POLICY_ONLY',
      productionUseAllowed: true,
      availability: 'MODEL_POLICY_AVAILABLE',
      rightsChecks: [],
      validConsumers: pathDefinition.implementedConsumers,
      missingPrerequisites: pathDefinition.missingPrerequisites,
    };
  }
  const rightsChecks = assessRightsEndpoints(pathDefinition.rightsEndpoints);
  const productionUseAllowed = rightsChecks.length > 0
    && rightsChecks.every(check => check.productionUseAllowed);
  const missingPrerequisites = [...pathDefinition.missingPrerequisites];
  if (!productionUseAllowed) {
    missingPrerequisites.push('Exact provider and endpoint permission for production data use is blocked or unverified; no production consumer is authorized by this matrix.');
  }
  return {
    ...pathDefinition,
    rightsChecks,
    authorizedUseStatus: rightsStatus(rightsChecks),
    productionUseAllowed,
    availability: productionUseAllowed ? NOT_PROBED : 'UNAVAILABLE_SOURCE_RIGHTS',
    validConsumers: productionUseAllowed ? pathDefinition.implementedConsumers : { api: [], internal: [], frontend: [] },
    missingPrerequisites,
  };
}

const SOURCE_UNAVAILABLE_IDS = new Set([
  'sgb', 'mssc', 'apy', 'fd', 'hdfc_fd', 'icici_fd', 'axis_fd', 'kotak_fd', 'indusind_fd',
  'idfc_fd', 'au_sfb_fd', 'ujjivan_fd', 'equitas_fd', 'canara_fd', 'pnb_fd', 'bob_fd',
  'sgb_secondary', 'embassy_reit', 'mindspace_reit', 'brookfield_reit', 'nexus_reit',
  'indigrid_invit', 'powergrid_invit', 'aaa_corporate_bond', 'aa_corporate_bond',
  'tax_free_bonds', 'bharat_bond_direct', 'municipal_bonds', 'bonds_54ec', 'nps',
  'nps_tier_2', 'epf', 'vpf', 'ulip', 'endowment_plan', 'term_mf_combo',
  'parag_parikh_flexi', 'sbi_bluechip', 'hdfc_midcap', 'mirae_elss', 'bajaj_finance_fd',
  'shriram_finance_fd', 'lic_housing_fd', 'pnb_housing_fd', 'mahindra_finance_fd',
  'jana_sfb_fd', 'suryoday_sfb_fd', 'esaf_sfb_fd', 'utkarsh_sfb_fd', 'rbi_retail_direct_gilt',
  'digital_gold', 'motilal_nasdaq100_fof', 'motilal_sp500_index', 'motilal_nasdaq_q50_etf',
  'icici_us_bluechip_fund', 'franklin_us_opportunities', 'edelweiss_us_tech_fof',
  'kotak_nasdaq100_fof', 'mirae_nyse_fang_etf_fof', 'edelweiss_greater_china_fof',
  'dsp_us_flexible_equity',
]);

const UNSUPPORTED_IDS = new Set([
  'p2p_lending', 'smallcase_thematic', 'pre_ipo_unlisted_shares', 'commodity_futures',
  'futures_and_options', 'crypto_vda', 'direct_us_stocks_megacap', 'us_sp500_etf_lrs',
  'us_nasdaq100_etf_lrs', 'us_dividend_etf_lrs', 'us_global_total_world_etf_lrs',
]);

function buildEntry(instrument) {
  const source = OFFICIAL_RATE_FACTS[instrument.id];
  const dataClass = source?.dataClass
    || (UNSUPPORTED_IDS.has(instrument.id) ? 'UNSUPPORTED'
      : SOURCE_UNAVAILABLE_IDS.has(instrument.id) ? 'SOURCE_UNAVAILABLE'
        : 'EDUCATIONAL_ONLY');
  const hasBoundSourceIdentity = Boolean(source?.canonicalSourceId);
  const providerConsumers = source?.service === 'GovernmentSmallSavingsProvider'
    ? ['GET /api/market/government-schemes', 'GET /api/market/rates', 'RecommendationPipeline fixed-income comparison']
    : source?.service === 'SbiTermDepositProvider'
      ? ['GET /api/market/fixed-deposits/sbi', 'GET /api/market/rates', 'RecommendationPipeline fixed-income comparison']
      : source?.service === 'RbiFloatingRateSavingsBondProvider'
        ? ['RecommendationPipeline fixed-income comparison']
        : [];
  const rightsChecks = assessRightsEndpoints(source?.rightsEndpoints);
  const productionUseAllowed = Boolean(source && rightsChecks.length > 0
    && rightsChecks.every(check => check.productionUseAllowed));
  const missingPrerequisites = [];
  if (!hasBoundSourceIdentity) missingPrerequisites.push('Exact provider identity is not bound to this catalog row.');
  if (instrument.id === 'sbi_fd') missingPrerequisites.push('Exact tenure and depositor category are required before a card-rate fact can bind to this parent product.');
  if (instrument.id === 'rbi_bonds') missingPrerequisites.push('Applicable reset-date NSC evidence is required for a current coupon.');
  if (!source) missingPrerequisites.push('No catalog-bound qualified provider observation is declared; do not infer one from product name or category.');
  if (source && !productionUseAllowed) missingPrerequisites.push('Production data use is blocked or unverified by the exact provider/endpoint source-rights register.');
  return {
    catalogId: instrument.id,
    name: instrument.name,
    category: instrument.category,
    assetClass: instrument.assetClass,
    dataClass,
    catalogSupport: 'PRESENT',
    productIdentityAvailability: hasBoundSourceIdentity
      ? 'SOURCE_QUALIFIED'
      : source ? 'PARENT_PRODUCT_NEEDS_TENURE_AND_DEPOSITOR' : 'NO_QUALIFIED_PRODUCT_BINDING',
    providerQualification: source ? 'QUALIFIED_BACKEND_PROVIDER' : 'NO_PRODUCT_BOUND_SOURCE',
    sourceProvider: source?.provider ?? null,
    sourceService: source?.service ?? null,
    canonicalSourceId: source?.canonicalSourceId ?? null,
    exactIdentity: source?.canonicalSourceId ?? null,
    provider: source?.provider ?? null,
    dataType: source?.dataClass ?? (dataClass === 'EDUCATIONAL_ONLY' ? 'EDUCATIONAL_DESCRIPTION_ONLY' : dataClass),
    authorizedUseStatus: source ? rightsStatus(rightsChecks) : 'NO_QUALIFIED_SOURCE',
    productionUseAllowed,
    rightsChecks,
    implementationAvailability: source ? 'IMPLEMENTED' : 'NO_CATALOG_BOUND_PROVIDER_PATH',
    availability: source && !productionUseAllowed ? 'UNAVAILABLE_SOURCE_RIGHTS' : source ? 'NOT_PROBED' : 'NO_PRODUCT_LEVEL_OBSERVATION',
    runtimeAvailability: NOT_PROBED,
    implementedConsumers: providerConsumers,
    validConsumers: productionUseAllowed ? providerConsumers : [],
    missingPrerequisites,
    sourceSemantics: source?.freshnessSemantics
      ?? (dataClass === 'EDUCATIONAL_ONLY'
        ? 'Catalog entry is a parent/category description and has no individual market observation.'
        : 'No qualified product-level provider fact is currently bound to this catalog identity.'),
    productRiskEvidence: 'NOT_QUALIFIED_BY_MARKET_DATA_COVERAGE',
    productLiquidityEvidence: 'NOT_QUALIFIED_BY_MARKET_DATA_COVERAGE',
    taxClassification: 'AUTHORITATIVE_SERVER_TAX_POLICY_REQUIRED',
    investmentEligibility: 'EXISTING_SERVER_SUITABILITY_GATE_REMAINS_AUTHORITY',
    sourceFreshness: source ? 'PROVIDER_EFFECTIVE_OR_PUBLICATION_TIME' : 'NOT_AVAILABLE',
    marketDataAvailability: source ? 'SOURCE_SERVICE_EXISTS' : 'NO_PRODUCT_LEVEL_OBSERVATION',
    upstoxRegistryCoverage: false,
    tejHqIdentityCoverage: false,
    personalizedRecommendationEligibility: 'NOT_ESTABLISHED_BY_MARKET_DATA_COVERAGE',
  };
}

export function buildMarketDataCoverage(catalog) {
  if (!Array.isArray(catalog?.instruments)) throw new TypeError('Catalog must include an instruments array.');
  const ids = catalog.instruments.map(instrument => instrument.id);
  if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) {
    throw new Error('Catalog instrument IDs must be present and unique.');
  }
  const entries = catalog.instruments.map(buildEntry);
  const providerPaths = PROVIDER_PATHS.map(buildProviderPath);
  return {
    schemaVersion: 'wealthgenie-market-data-coverage-1.3.0',
    catalogVersion: catalog.catalogVersion ?? null,
    generatedAt: new Date().toISOString(),
    totalCatalogEntries: entries.length,
    classificationCounts: Object.fromEntries([...new Set(entries.map(entry => entry.dataClass))].sort()
      .map(dataClass => [dataClass, entries.filter(entry => entry.dataClass === dataClass).length])),
    scope: 'Static implementation, exact identity, endpoint-rights registry, and consumer coverage derived from repository contracts. Rights are not independently assessed legal conclusions, and runtime provider availability was not probed. This matrix does not determine suitability, eligibility, tax or recommendation ranking.',
    providerChecks: { liveProviderCallsMade: false, runtimeAvailability: NOT_PROBED, sourceTermsIndependentlyAssessed: false, repositoryRightsRegisterEvaluated: true },
    providerPaths,
    entries,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const coverage = buildMarketDataCoverage(catalog);
  fs.writeFileSync(outputPath, `${JSON.stringify(coverage, null, 2)}\n`, 'utf8');
  process.stdout.write(`Wrote ${coverage.totalCatalogEntries} market-data coverage rows.\n`);
}
