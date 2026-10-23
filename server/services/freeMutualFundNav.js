/**
 * Keyless, read-through mutual-fund research. Explicitly separate from the
 * licensed PostgreSQL authority: NEVER cache, persist, recommend, or infer tax.
 * mfnav.in offers a free API, but underlying AMFI commercial rights have not
 * been independently confirmed for WealthGenie's redistribution use.
 */
const SOURCE='https://mfnav.in';
const MAX_BYTES=450000;
function unavailable(code){return {status:'UNAVAILABLE',reasonCode:code,netFutureValue:null,postTaxAvailable:false};}
function validSchemeCode(v){return typeof v==='string'&&/^[1-9][0-9]{4,6}$/.test(v);}
function isoDate(s){
 if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(s))return null;
 const t=new Date(s+'T00:00:00Z');
 return Number.isFinite(+t)&&t.toISOString().slice(0,10)===s?t:null;
}
async function requestJson(path,{fetchImpl=globalThis.fetch}={}){
 const url=SOURCE+path; // built only from bounded integer scheme codes / encoded search
 const response=await fetchImpl(url,{
   method:'GET',redirect:'error',headers:{Accept:'application/json'},
   signal:AbortSignal.timeout(6500),
 });
 if(!response||response.status!==200)throw new Error('FREE_NAV_PROVIDER_UNAVAILABLE');
 const size=Number(response.headers?.get?.('content-length')||0);
 if(Number.isFinite(size)&&size>MAX_BYTES)throw new Error('FREE_NAV_RESPONSE_TOO_LARGE');
 const reader=response.body?.getReader?.();
 if(!reader) {
   const raw=await response.text();
   if(Buffer.byteLength(raw,'utf8')>MAX_BYTES)throw new Error('FREE_NAV_RESPONSE_TOO_LARGE');
   return JSON.parse(raw);
 }
 const chunks=[];let bytes=0;
 while(true){
  const {done,value}=await reader.read();
  if(done)break;
  bytes+=value.byteLength;
  if(bytes>MAX_BYTES){await reader.cancel().catch(()=>{});throw new Error('FREE_NAV_RESPONSE_TOO_LARGE');}
  chunks.push(Buffer.from(value));
 }
 return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function text(v,max=150){return typeof v==='string'?v.slice(0,max):null;}
function validNavValue(value){
  // JSON booleans and whitespace are not fund prices. A generic Number()
  // cast silently changes true to 1 and '' to 0, distorting volatility.
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string'
    && !/^(?:0|[1-9]\\d*)(?:\\.\\d{1,8})?$/.test(value)) return null;
  const nav = Number(value);
  return Number.isFinite(nav) && nav > 0 && nav < 1e9 ? nav : null;
}
function normalizedFund(data,requestedCode){
 const code=Number(data?.scheme_code);
 if(!Number.isSafeInteger(code)||String(code)!==String(requestedCode))return null;
 const name=text(data.scheme_name);
 const house=text(data.fund_house);
 if(!name||!house)return null;
 return {schemeCode:code,name,fundHouse:house,isin:text(data.isin,16),
  category:text(data.category,80),subcategory:text(data.sub_category,100),
  planType:text(data.plan_type,25),optionType:text(data.option_type,25)};
}
export function normalizeFreeFundSearch(raw){
 if(!Array.isArray(raw?.results))return unavailable('UNEXPECTED_FREE_NAV_SCHEMA');
 const results=[];
 for(const item of raw.results.slice(0,20)){
  if(!validSchemeCode(String(item?.scheme_code||'')))continue;
  const normalized=normalizedFund(item,String(item.scheme_code));
  if(normalized)results.push(normalized);
 }
 return {
  status:'AVAILABLE',dataClass:'RESEARCH_ONLY_AMFI_DERIVED_NAV',
  results,source:{provider:'mfnav.in',url:SOURCE+'/api-docs',termsUrl:SOURCE+'/terms'},
  postTaxAvailable:false,productionInvestmentQualification:false,
  sourceRightsStatus:'RESEARCH_ONLY_UPSTREAM_AMFI_RIGHTS_NOT_QUALIFIED',
 };
}
export async function searchFreeFunds(q,options={}){
 if(typeof q!=='string'||q.trim().length<2||q.length>80)throw new RangeError('INVALID_FUND_SEARCH');
 const data=await requestJson('/api/funds/search?q='+encodeURIComponent(q.trim())+'&page=1&page_size=20',options);
 return normalizeFreeFundSearch(data);
}
export function normalizeFreeNavHistory(raw,schemeCode,{now=new Date()}={}){
 const fund=normalizedFund(raw?.fund_details,schemeCode);
 if(!fund||!Array.isArray(raw?.data))return unavailable('FREE_NAV_IDENTITY_OR_SCHEMA_INVALID');
 if(raw.data.length>1000)return unavailable('FREE_NAV_HISTORY_TOO_LARGE');
 const daily=[];const seen=new Set();
 for(const row of raw.data){
  const date=isoDate(row?.nav_date);const nav=validNavValue(row?.nav);
  if(!date||nav===null||seen.has(date))
   return unavailable('FREE_NAV_DATE_OR_VALUE_INVALID');
  seen.add(date);daily.push({date,nav});
 }
 daily.sort((a,b)=>a.date.localeCompare(b.date));
 if(daily.length<90)return unavailable('INSUFFICIENT_NAV_HISTORY');
 const days=(Date.parse(daily.at(-1).date)-(Date.parse(daily[0].date)))/86400000;
 const lastAge=(+now-(Date.parse(daily.at(-1).date)))/86400000;
 if(days<180||lastAge<0||lastAge>10)return unavailable('NAV_HISTORY_STALE_OR_TOO_SHORT');
 let n=0,sum=0,sumSquared=0;
 for(let i=1;i<daily.length;i++){
  const gap=(Date.parse(daily[i].date)-(Date.parse(daily[i-1].date)))/86400000;
  if(gap>20||gap<=0)return unavailable('NAV_HISTORY_GAP');
  const r=Math.log(daily[i].nav/daily[i-1].nav);
  if(!Number.isFinite(r)||Math.abs(r)>Math.log(1.5))
   return unavailable('NAV_JUMP_REQUIRES_ADJUSTMENT_REVIEW');
  n++;sum+=r;sumSquared+=r*r;
 }
 const variance=(sumSquared-sum*sum/n)/(n-1);
 const volatility=Math.sqrt(Math.max(0,variance)*252);
 if(!Number.isFinite(volatility)||volatility<=0||volatility>0.6)
   return unavailable('NAV_VOLATILITY_OUTSIDE_MODEL_RANGE');
 return {status:'AVAILABLE',dataClass:'RESEARCH_ONLY_AMFI_DERIVED_NAV',
  fund,latestNav:daily.at(-1).nav,latestNavDate:daily.at(-1).date,
  sampleCount:daily.length,firstNavDate:daily[0].date,
  observedAnnualVolatility:volatility,
  source:{provider:'mfnav.in',url:SOURCE+'/api/nav/'+schemeCode,termsUrl:SOURCE+'/terms'},
  sourceRightsStatus:'RESEARCH_ONLY_UPSTREAM_AMFI_RIGHTS_NOT_QUALIFIED',
  volatilityBasis:'HISTORICAL_NAV_CHANGE_NOT_FORWARD_EXPECTED_RETURN',
  forwardReturn:null,postTaxAvailable:false,postTaxFutureValue:null,
  productionInvestmentQualification:false,
  exclusions:['DIVIDENDS_AND_DISTRIBUTIONS','SCHEME_CORPORATE_ACTIONS','FEES_NOT_EXPLICITLY_MODELED',
  'SOURCE_COMMERCIAL_REUSE_NOT_INDEPENDENTLY_REVIEWED','PRODUCT_TAX_CLASS_NOT_VERIFIED']};
}
export async function getFreeFundNavResearch(schemeCode,options={}){
 if(!validSchemeCode(schemeCode))throw new RangeError('INVALID_FUND_SCHEME_CODE');
 const data=await requestJson('/api/nav/'+schemeCode+'?page=1&page_size=250',options);
 return normalizeFreeNavHistory(data,schemeCode,options);
}
