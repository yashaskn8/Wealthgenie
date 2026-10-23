/**
 * Independent transport/normalization for a SECOND free AMFI-derived mirror.
 * It helps detect accidental scheme swaps, stale mirror data, and NAV typos.
 * Neither MFapi nor mfnav grants upstream AMFI production redistribution rights.
 */
const BASE='https://api.mfapi.in';
const MAX_RESPONSE_BYTES=250000;
const MIN_DATE='2000-01-01';
function unknown(code) {
 return {status:'NOT_VERIFIED',reasonCode:code,provider:'MFapi.in',
  productionUseAllowed:false,independentUnderlyingFeed:false};
}
function utcIsoFromIndianDate(value){
 if(typeof value!=='string')return null;
 const m=/^(\d{2})-(\d{2})-(\d{4})$/.exec(value);
 if(!m)return null;
 const iso=m[3]+'-'+m[2]+'-'+m[1];
 const dt=new Date(iso+'T00:00:00.000Z');
 return Number.isFinite(+dt)&&dt.toISOString().slice(0,10)===iso?iso:null;
}
function positiveNav(value){
 if(typeof value!=='string'&&typeof value!=='number')return null;
 if(!/^\d+(?:\.\d{1,8})?$/.test(String(value)))return null;
 const n=Number(value);
 return Number.isFinite(n)&&n>0&&n<1e9?n:null;
}
export function normalizeMfapiLatest(raw,requestedSchemeCode){
 const code=String(requestedSchemeCode);
 if(!/^[1-9]\d{4,6}$/.test(code))return unknown('INVALID_SCHEME_CODE');
 if(raw?.status!=='SUCCESS'||!raw.meta||!Array.isArray(raw.data)
     ||raw.data.length!==1)return unknown('MFAPI_SCHEMA_UNAVAILABLE');
 if(String(raw.meta.scheme_code)!==code)return unknown('MFAPI_SCHEME_CODE_MISMATCH');
 const name=raw.meta.scheme_name;
 if(typeof name!=='string'||!name.trim()||name.length>250)
   return unknown('MFAPI_FUND_NAME_INVALID');
 const first=raw.data[0],date=utcIsoFromIndianDate(first?.date),nav=positiveNav(first?.nav);
 if(!date||date<MIN_DATE||nav===null)return unknown('MFAPI_NAV_VALUE_OR_DATE_INVALID');
 return {
  status:'AVAILABLE',provider:'MFapi.in',schemeCode:code,
  fundName:name,fundHouse:typeof raw.meta.fund_house==='string'?raw.meta.fund_house:null,
  navDate:date,nav,
  isin:typeof raw.meta.isin_growth==='string'?raw.meta.isin_growth:null,
  sourceUrl:BASE+'/mf/'+code+'/latest',
  productionUseAllowed:false,independentUnderlyingFeed:false,
 };
}
async function getBoundedJson(url,{fetchImpl=globalThis.fetch}={}){
 const response=await fetchImpl(url,{
  method:'GET',redirect:'error',headers:{Accept:'application/json'},
  signal:AbortSignal.timeout(5500),
 });
 if(response?.status!==200)throw new Error('MFAPI_SOURCE_UNAVAILABLE');
 const size=Number(response.headers?.get?.('content-length')||0);
 if(size>MAX_RESPONSE_BYTES)throw new Error('MFAPI_RESPONSE_TOO_LARGE');
 const stream=response.body?.getReader?.();
 if(!stream){
  const t=await response.text();
  if(Buffer.byteLength(t,'utf8')>MAX_RESPONSE_BYTES)throw new Error('MFAPI_RESPONSE_TOO_LARGE');
  return JSON.parse(t);
 }
 let bytes=0;const chunks=[];
 while(true){
  const {done,value}=await stream.read();
  if(done)break;
  bytes+=value.byteLength;
  if(bytes>MAX_RESPONSE_BYTES){
   await stream.cancel().catch(()=>{});
   throw new Error('MFAPI_RESPONSE_TOO_LARGE');
  }
  chunks.push(Buffer.from(value));
 }
 return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
/**
 * Fallback history if the primary free NAV mirror is offline. It is NOT an
 * authoritative financial-market provider or a substitute for source rights.
 * Only one year of recent scheme-level history is requested to avoid a bulk
 * AMFI extraction. Parsed with the same strict NAV risk normalizer.
 */
export async function getMfapiHistoryResearch(schemeCode,options={}){
 if(typeof schemeCode!=='string'||!/^[1-9]\d{4,6}$/.test(schemeCode))
  throw new RangeError('INVALID_FUND_SCHEME_CODE');
 const now=options.now instanceof Date?options.now:new Date();
 if(!Number.isFinite(+now))return unknown('INVALID_AS_OF_DATE');
 const end=now.toISOString().slice(0,10);
 const start=new Date(+now-400*86400000).toISOString().slice(0,10);
 let raw;
 try{
  raw=await getBoundedJson(BASE+'/mf/'+schemeCode+
   '?startDate='+start+'&endDate='+end,options);
 }catch{return unknown('MFAPI_HISTORY_SOURCE_UNAVAILABLE');}
 if(raw?.status!=='SUCCESS'||!raw.meta||!Array.isArray(raw.data)
  ||raw.data.length>600||String(raw.meta.scheme_code)!==schemeCode)
  return unknown('MFAPI_HISTORY_IDENTITY_OR_SCHEMA_INVALID');
 const history=[];
 for(const item of raw.data){
  const date=utcIsoFromIndianDate(item?.date);
  const nav=positiveNav(item?.nav);
  if(!date||nav===null)return unknown('MFAPI_HISTORY_DATE_OR_VALUE_INVALID');
  history.push({nav_date:date,nav});
 }
 // A second upstream transport does not make an AMFI-derived NAV publication
 // independent. Retain this provenance in the response and never persist.
 const {normalizeFreeNavHistory}=await import('./freeMutualFundNav.js');
 const normalized=normalizeFreeNavHistory({
  fund_details:{
   scheme_code:raw.meta.scheme_code,scheme_name:raw.meta.scheme_name,
   fund_house:raw.meta.fund_house,
   isin:raw.meta.isin_growth||raw.meta.isin_div_reinvestment||null,
   category:raw.meta.scheme_category||null,
  },data:history,
 },schemeCode,{now});
 if(normalized.status!=='AVAILABLE')return unknown(
  normalized.reasonCode||'MFAPI_HISTORY_NOT_QUALIFIED');
 return {...normalized,dataClass:'RESEARCH_ONLY_MFAPI_AMFI_DERIVED_NAV',
  source:{provider:'MFapi.in',url:BASE+'/mf/'+schemeCode,
   termsUrl:'https://www.mfapi.in/docs/'},
  sourceRightsStatus:'RESEARCH_ONLY_UPSTREAM_AMFI_RIGHTS_NOT_QUALIFIED',
  primarySourceUnavailable:true,
  productionInvestmentQualification:false,
 };
}

/**
 * Strict fallback fund discovery. MFapi's /mf/search contains only a scheme
 * code and name, so its results are PROVISIONAL. Never forge a fund house,
 * ISIN, plan type, category or rights qualification from search text.
 */
export function normalizeMfapiSearch(raw) {
 if(!Array.isArray(raw))return unknown('MFAPI_SEARCH_SCHEMA_INVALID');
 const results=[];
 const seen=new Set();
 for(const item of raw.slice(0,60)){
  const code=String(item?.schemeCode??'');
  const name=item?.schemeName;
  if(!/^[1-9]\d{4,6}$/.test(code)||seen.has(code)
   ||typeof name!=='string'||name.trim().length<5||name.length>250)
    continue;
  seen.add(code);
  const normalized=name.trim().replace(/\s+/g,' ');
  const growth=/\bGROWTH\b/i.test(normalized)
    && !/\b(?:IDCW|DIVIDEND|DISTRIBUTION)\b/i.test(normalized);
  results.push({
   schemeCode:Number(code),name:normalized,
   fundHouse:null,isin:null,category:null,subcategory:null,
   planType:null,optionType:null,
   navOnlyRiskEligible:growth,
   identityValidation:'PENDING_DIRECT_SCHEME_DETAILS',
  });
  if(results.length>=20)break;
 }
 return {
  status:'AVAILABLE',dataClass:'RESEARCH_ONLY_AMFI_DERIVED_NAV',
  results,source:{provider:'MFapi.in',url:'https://www.mfapi.in/docs/'},
  searchSourceStatus:'FALLBACK_PROVISIONAL_IDENTITIES_REQUIRE_DIRECT_LOOKUP',
  sourceRightsStatus:'RESEARCH_ONLY_UPSTREAM_AMFI_RIGHTS_NOT_QUALIFIED',
  postTaxAvailable:false,productionInvestmentQualification:false,
 };
}
export async function searchMfapiFunds(query,options={}) {
 if(typeof query!=='string'||query.trim().length<2||query.length>80
  ||!/^[a-zA-Z0-9 .()&_-]+$/.test(query.trim()))
  throw new RangeError('INVALID_FUND_SEARCH');
 try{
  const data=await getBoundedJson(BASE+'/mf/search?q='+
   encodeURIComponent(query.trim()),options);
  return normalizeMfapiSearch(data);
 }catch{
  return unknown('MFAPI_SEARCH_UNAVAILABLE');
 }
}

export async function getMfapiLatest(schemeCode,options={}){
 if(typeof schemeCode!=='string'||!/^[1-9]\d{4,6}$/.test(schemeCode))
  throw new RangeError('INVALID_FUND_SCHEME_CODE');
 try{
  const result=await getBoundedJson(BASE+'/mf/'+schemeCode+'/latest',options);
  return normalizeMfapiLatest(result,schemeCode);
 }catch{
  return unknown('MFAPI_SOURCE_UNAVAILABLE');
 }
}
/**
 * Both sites derive NAV from AMFI; a match is a consistency check, NOT
 * independent validation of the underlying AMFI publication or its license.
 */
function canonicalSchemeName(name){
 if(typeof name!=='string')return null;
 const normalized=name.normalize('NFKC').toUpperCase()
  .replace(/[^A-Z0-9]+/g,' ').trim().replace(/\s+/g,' ');
 return normalized||null;
}
export function reconcileFreeNavSources(primary,secondary,{now=new Date()}={}){
 const summary={
  primaryProvider:'mfnav.in',secondaryProvider:'MFapi.in',
  independentUnderlyingFeed:false,productionUseAllowed:false,
  status:'SINGLE_SOURCE',reasonCode:'SECONDARY_NOT_AVAILABLE',
  asOf:primary?.latestNavDate||null,
 };
 if(!primary||primary.status!=='AVAILABLE')return {
  ...summary,status:'UNAVAILABLE',reasonCode:'PRIMARY_NAV_NOT_QUALIFIED',
 };
 if(secondary?.status!=='AVAILABLE')return {...summary,
  reasonCode:secondary?.reasonCode||summary.reasonCode};
 if(String(primary.fund?.schemeCode)!==String(secondary.schemeCode))
  return {...summary,status:'CONFLICT',reasonCode:'CROSS_SOURCE_SCHEME_ID_CONFLICT'};
 if(primary.fund?.isin&&secondary.isin
   &&primary.fund.isin.toUpperCase()!==secondary.isin.toUpperCase())
  return {...summary,status:'CONFLICT',reasonCode:'CROSS_SOURCE_ISIN_CONFLICT'};
 // Scheme code alone is not enough if a mirror mislabels its fund name or
 // plan. A valid ISIN can be missing for older schemes, so preserve a second
 // scheme-identity fence before publishing simulated financial values.
 const primaryHouse=canonicalSchemeName(primary.fund?.fundHouse);
 const secondaryHouse=canonicalSchemeName(secondary.fundHouse);
 if(primaryHouse&&secondaryHouse&&primaryHouse!==secondaryHouse)
  return {...summary,status:'CONFLICT',reasonCode:'CROSS_SOURCE_FUND_HOUSE_CONFLICT'};
 const primaryName=canonicalSchemeName(primary.fund?.name);
 const secondaryName=canonicalSchemeName(secondary.fundName);
 if(primaryName&&secondaryName&&primaryName!==secondaryName)
  return {...summary,status:'CONFLICT',reasonCode:'CROSS_SOURCE_FUND_NAME_CONFLICT'};
 const primaryDate=Date.parse(primary.latestNavDate),secondaryDate=Date.parse(secondary.navDate);
 if(!Number.isFinite(primaryDate)||!Number.isFinite(secondaryDate)||!Number.isFinite(+now))
  return {...summary,status:'CONFLICT',reasonCode:'CROSS_SOURCE_INVALID_DATE'};
 const dateGap=Math.abs(primaryDate-secondaryDate)/86400000;
 if(dateGap>3)return {...summary,status:'CONFLICT',reasonCode:'CROSS_SOURCE_NAV_DATE_CONFLICT',
  secondaryNavDate:secondary.navDate};
 if(dateGap>0)return {...summary,
  reasonCode:'FREE_NAV_MIRRORS_ON_DIFFERENT_RECENT_DATES',
  secondaryNavDate:secondary.navDate};
 const difference=Math.abs(primary.latestNav-secondary.nav);
 const maxDifference=Math.max(0.0001,primary.latestNav*0.000001);
 if(difference>maxDifference)
  return {...summary,status:'CONFLICT',reasonCode:'CROSS_SOURCE_NAV_VALUE_CONFLICT',
   secondaryNavDate:secondary.navDate,absoluteDifference:difference};
 return {...summary,status:'MATCHED_SAME_AMFI_SOURCE',
  reasonCode:null,secondaryNavDate:secondary.navDate,
  maxAcceptedNavDifference:maxDifference,absoluteDifference:difference};
}
