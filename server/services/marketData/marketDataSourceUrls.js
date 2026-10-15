// Canonical provider endpoints live outside adapter modules so the rights
// registry can import them without loading provider classes or creating cycles.
export const AMFI_NAV_URL = 'https://portal.amfiindia.com/spages/NAVAll.txt';
export const AMFI_NAV_HISTORY_URL = 'https://portal.amfiindia.com/DownloadNAVHistoryReport_Po.aspx';
export const AMFI_NAV_HISTORY_RIGHTS_URL = `${AMFI_NAV_HISTORY_URL}?frmdt={from}&todt={to}`;

export const NSE_HISTORICAL_INDEX_URL = 'https://www.nseindia.com/api/historicalOR/indicesHistory';
export const NSE_HISTORICAL_INDEX_RIGHTS_URL = `${NSE_HISTORICAL_INDEX_URL}?indexType={indexType}&from={from}&to={to}`;
export const NSE_TRADING_HOLIDAY_BASE_URL = 'https://www.nseindia.com/api/holiday-master';
export const NSE_TRADING_HOLIDAY_URL = `${NSE_TRADING_HOLIDAY_BASE_URL}?type=trading`;

export const UPSTOX_QUOTE_URL = 'https://api.upstox.com/v3/market-quote/quotes';
export const UPSTOX_QUOTE_RIGHTS_URL = `${UPSTOX_QUOTE_URL}?instrument_key={instrumentKeys}`;

export function buildMarketDataRequestUrl(baseUrl, parameters = {}) {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export function buildNseHistoricalIndexRequestUrl({ indexType, from, to }) {
  return buildMarketDataRequestUrl(NSE_HISTORICAL_INDEX_URL, { indexType, from, to });
}

export function buildUpstoxQuoteRequestUrl(instrumentKeys) {
  if (!Array.isArray(instrumentKeys) || instrumentKeys.length === 0) {
    throw new TypeError('instrumentKeys must be a non-empty array.');
  }
  return buildMarketDataRequestUrl(UPSTOX_QUOTE_URL, { instrument_key: instrumentKeys.join(',') });
}

export const INDIA_POST_SAVINGS_URL = 'https://www.indiapost.gov.in/banking-services/savings';
export const INDIA_POST_SCRIPT_CHUNK_RIGHTS_URL = 'https://www.indiapost.gov.in/_next/static/chunks/{chunk}';

export const SBI_TERM_DEPOSIT_URL = 'https://sbi.bank.in/web/interest-rates/deposit-rates/retail-domestic-term-deposits';
export const RBI_FRSB_NOTIFICATION_URL = 'https://www.rbi.org.in/scripts/NotificationUser.aspx?Id=11924';
