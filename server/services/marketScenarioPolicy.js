/** Market-price GBM admission; source licensing & calibration are separate gates. */
export const GBM_SCENARIO_POLICY_VERSION='gbm-admission-1.0.0';
export const GBM_MARKET_CATEGORIES=Object.freeze([
  'Equity_MF','ELSS','ETF','Debt_MF','Liquid_MF','Arbitrage_MF',
  'Hybrid_MF','Index_MF','Midcap_MF','Smallcap_MF',
]);
const eligible=new Set(GBM_MARKET_CATEGORIES);
export function evaluateGbmScenarioAdmission(keys) {
  if(!Array.isArray(keys)||!keys.length||keys.some(k=>typeof k!=='string'||!k.length||k.length>64))
    return {admitted:false,reasonCode:'INVALID_ASSET_CLASSIFICATION',unsupportedKeys:[]};
  const unsupportedKeys=[...new Set(keys.filter(k=>!eligible.has(k)))].sort();
  return {admitted:unsupportedKeys.length===0,
    reasonCode:unsupportedKeys.length?'ASSET_SPECIFIC_CASHFLOW_MODEL_REQUIRED':null,
    unsupportedKeys,policyVersion:GBM_SCENARIO_POLICY_VERSION};
}
