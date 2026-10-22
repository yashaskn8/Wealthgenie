/**
 * Historical NAV/close-price volatility is a risk descriptor, NOT a forward
 * expected return, source-adjusted total-return series, or trading signal.
 * The only accepted observations are already licensed and source-validated
 * by the financial Postgres store. Fail closed on gaps and identity drift.
 */
const tradingDaysPerYear = 252;
function unavailable(code) {
  return {status:'UNAVAILABLE',reasonCode:code,annualVolatility:null,
    expectedAnnualReturn:null,metric:'OBSERVED_EOD_PRICE_CHANGE_VOLATILITY',
    isForecast:false,isTotalReturn:false};
}
export function estimateQualifiedHistoricalVolatility(rows,{now=new Date()}={}) {
  if(!Array.isArray(rows)||rows.length<90||rows.length>1000)
    return unavailable('INSUFFICIENT_QUALIFIED_MARKET_HISTORY');
  if(!(now instanceof Date)||!Number.isFinite(+now))
    return unavailable('INVALID_AS_OF_TIME');
  const series=[];
  const seenDays=new Set(),seenObservationIds=new Set();
  let source=null,instrument=null;
  for(const r of rows){
    if(!r||r.data_class!=='END_OF_DAY'
      ||typeof r.source_id!=='string'||!r.source_id
      ||typeof r.source_instrument_id!=='string'||!r.source_instrument_id)
      return unavailable('UNQUALIFIED_EOD_IDENTITY');
    if(source!==null && (source!==r.source_id||instrument!==r.source_instrument_id))
      return unavailable('MIXED_SOURCE_OR_INSTRUMENT');
    source=r.source_id;instrument=r.source_instrument_id;
    const observed=new Date(r.observed_at);
    if(!Number.isFinite(+observed)||observed>now)
      return unavailable('INVALID_MARKET_OBSERVATION_DATE');
    const date=observed.toISOString().slice(0,10);
    if(seenDays.has(date)||seenObservationIds.has(String(r.id)))
      return unavailable('DUPLICATE_HISTORY_DAY_OR_ID');
    seenDays.add(date);seenObservationIds.add(String(r.id));
    if(typeof r.value!=='string'||!/^(?:[0-9]+)(?:\.[0-9]{1,8})?$/.test(r.value))
      return unavailable('UNQUALIFIED_PRICE_PRECISION');
    const price=Number(r.value);
    if(!Number.isFinite(price)||price<=0||price>1e12)
      return unavailable('INVALID_HISTORICAL_PRICE');
    series.push({timestamp:+observed,price});
  }
  series.sort((a,b)=>a.timestamp-b.timestamp);
  const calendarDays=(series.at(-1).timestamp-series[0].timestamp)/86400000;
  const lastAgeDays=(+now-series.at(-1).timestamp)/86400000;
  if(calendarDays<180||lastAgeDays>10)
    return unavailable('INSUFFICIENT_SPAN_OR_STALE_HISTORY');
  const logReturns=[];
  for(let i=1;i<series.length;i++){
    const gap=(series[i].timestamp-series[i-1].timestamp)/86400000;
    if(gap<=0||gap>20)return unavailable('DISCONTINUOUS_MARKET_HISTORY');
    const logReturn=Math.log(series[i].price/series[i-1].price);
    // Large jumps usually mean unresolved splits, dividend distributions,
    // provider corruption or instrument drift; require manual reconciliation.
    if(!Number.isFinite(logReturn)||Math.abs(logReturn)>Math.log(1.5))
      return unavailable('UNVERIFIED_CORPORATE_ACTION_OR_PRICE_JUMP');
    logReturns.push(logReturn);
  }
  const mean=logReturns.reduce((sum,v)=>sum+v,0)/logReturns.length;
  const variance=logReturns.reduce((sum,v)=>sum+(v-mean)**2,0)/(logReturns.length-1);
  const annualVolatility=Math.sqrt(variance*tradingDaysPerYear);
  if(!Number.isFinite(annualVolatility)||annualVolatility<=0||annualVolatility>0.6)
    return unavailable('VOLATILITY_OUTSIDE_VALIDATED_MODEL_RANGE');
  return {status:'CALCULATED',reasonCode:null,annualVolatility,
    expectedAnnualReturn:null,sourceId:source,sourceInstrumentId:instrument,
    sampleCount:series.length,firstObservedAt:new Date(series[0].timestamp).toISOString(),
    lastObservedAt:new Date(series.at(-1).timestamp).toISOString(),
    metric:'OBSERVED_EOD_PRICE_CHANGE_VOLATILITY',
    isForecast:false,isTotalReturn:false,corporateActionAdjusted:false,
    excludes:['FORWARD_RETURN_PREDICTION','TOTAL_RETURN_REINVESTMENT',
      'CORPORATE_ACTION_ADJUSTMENT_NOT_ESTABLISHED','FUTURE_TAX_RULES'],
    assumptions:{tradingDaysPerYear}};
}
