import {computeTax,getTaxPolicyMetadata} from './taxEngine.js';
/**
 * Add exact investor-declared tax events to an already source-qualified
 * contractual cash-flow ledger. Never treat month offsets as settlement dates.
 * Unsupported tax years, missing dates, or undefined statutory classifications
 * return unavailable, rather than a fictitious maturity estimate.
 */
function unavailable(reason) {
 return {status:'UNAVAILABLE',reasonCodes:[reason],netTotalReceiptsPaise:null,
   totalIncrementalTaxPaise:null,afterTaxCashflows:null,netXirr:null};
}
function fy(date) {
 const y=Number(date.slice(0,4)),m=Number(date.slice(5,7));
 return 'FY'+(m>=4?y:y-1)+'-'+String(m>=4?y+1:y).slice(-2);
}
function dateValid(text) {
 if(typeof text!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(text))return false;
 const d=new Date(text+'T00:00:00.000Z');
 return Number.isFinite(+d)&&d.toISOString().slice(0,10)===text;
}
function calculateXirr(events) {
 const first=Math.min(...events.map(e=>Date.parse(e.date+'T00:00:00Z')));
 const flows=events.map(e=>({y:(Date.parse(e.date+'T00:00:00Z')-first)/86400000/365,
   amount:e.netAmountPaise/100}));
 if(!flows.some(e=>e.amount<0)||!flows.some(e=>e.amount>0))return null;
 const npv=rate=>flows.reduce((sum,e)=>sum+e.amount/Math.pow(1+rate,e.y),0);
 let low=-0.9999,high=1000;
 if(!Number.isFinite(npv(low))||!Number.isFinite(npv(high))
     ||npv(low)*npv(high)>0)return null;
 for(let i=0;i<130;i++){
  const middle=(low+high)/2;
  const value=npv(middle);
  if(!Number.isFinite(value))return null;
  if(Math.abs(value)<0.0000001) return middle;
  if(npv(low)*value<=0)high=middle;else low=middle;
 }
 return (low+high)/2;
}
export function calculateTaxedContractLedger({
 ledger,eventDates,taxContexts,qualifiedProductTaxClass,sourceRightsQualified=false,
}={}) {
 if(!sourceRightsQualified)return unavailable('SOURCE_RIGHTS_UNQUALIFIED');
 if(qualifiedProductTaxClass!=='ORDINARY_INTEREST')return unavailable('TAX_CLASS_NOT_QUALIFIED');
 if(ledger?.status!=='RECONCILED'||!Array.isArray(ledger.events))return unavailable('CONTRACT_LEDGER_UNQUALIFIED');
 if(ledger.events.length<3 || ledger.events.length>40) return unavailable('CONTRACT_LEDGER_EVENT_COUNT_INVALID');
 if(ledger.currency && ledger.currency!=='INR')return unavailable('CONTRACT_LEDGER_CURRENCY_UNQUALIFIED');
 if(ledger.timingBasis && ledger.timingBasis!=='RELATIVE_MONTH_OFFSETS_NOT_SETTLEMENT_DATES')
   return unavailable('CONTRACT_LEDGER_TIMING_BASIS_UNQUALIFIED');
 if(!eventDates||typeof eventDates!=='object'||Array.isArray(eventDates))return unavailable('EXACT_SETTLEMENT_DATES_REQUIRED');
 if(!taxContexts||typeof taxContexts!=='object'||Array.isArray(taxContexts))return unavailable('TAX_YEARS_REQUIRED');
 const events=[];
 const uniqueIds=new Set();
 for(const item of ledger.events) {
  if(typeof item?.id!=='string'||uniqueIds.has(item.id))
    return unavailable('CONTRACT_LEDGER_DUPLICATE_OR_INVALID_EVENT_ID');
  uniqueIds.add(item.id);
  if(item.kind==='SUBSCRIPTION' && item.amountPaise>=0
    ||item.kind==='INTEREST_PAYOUT' && item.amountPaise<=0
    ||item.kind==='PRINCIPAL_REDEMPTION' && item.amountPaise<=0)
    return unavailable('CONTRACT_LEDGER_INVALID_CASHFLOW_SIGN');
  const date=eventDates[item.id];
  if(!dateValid(date))return unavailable('EXACT_SETTLEMENT_DATE_MISSING:'+item.id);
  if(!Number.isSafeInteger(item.amountPaise))return unavailable('CASHFLOW_PRECISION_INVALID');
  events.push({id:item.id,kind:item.kind,date,grossAmountPaise:item.amountPaise,netAmountPaise:item.amountPaise});
 }
 events.sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id));
 if(events.filter(e=>e.kind==='SUBSCRIPTION').length!==1
  ||events[0]?.kind!=='SUBSCRIPTION')return unavailable('MISSING_OR_DUPLICATED_INITIAL_SUBSCRIPTION');
 const principalEvents=events.filter(e=>e.kind==='PRINCIPAL_REDEMPTION');
 if(principalEvents.length!==1 || principalEvents[0].grossAmountPaise!==-events[0].grossAmountPaise)
   return unavailable('PRINCIPAL_REDEMPTION_RECONCILIATION_FAILED');
 if(principalEvents[0].date < events.at(-1).date)
   return unavailable('PRINCIPAL_REDEMPTION_PRECEDES_FINAL_CASHFLOW');
 if(new Set(events.map(e=>e.id)).size!==events.length)
   return unavailable('CONTRACT_LEDGER_DUPLICATE_EVENT_ID');
 const interest=events.filter(e=>e.kind==='INTEREST_PAYOUT');
 if(!interest.length)return unavailable('VERIFIED_INTEREST_ACCRUAL_SCHEDULE_REQUIRED');
 if(events.some(e=>!['SUBSCRIPTION','INTEREST_PAYOUT','PRINCIPAL_REDEMPTION'].includes(e.kind))){
  return unavailable('UNSUPPORTED_TAX_EVENT_TYPE');
 }
 const totals=new Map();
 for(const event of interest){
  const year=fy(event.date);
  totals.set(year,(totals.get(year)||0)+event.grossAmountPaise);
 }
 const taxByYear=new Map();
 if(ledger.totalReceiptsPaise!==undefined){
  const receipts=events.reduce((sum,e)=>sum+Math.max(0,e.grossAmountPaise),0);
  if(!Number.isSafeInteger(receipts)||receipts!==ledger.totalReceiptsPaise)
   return unavailable('CONTRACT_LEDGER_SOURCE_RECEIPTS_MISMATCH');
 }
 for(const [year,amountPaise] of totals) {
  const context=taxContexts[year];
  if(!context||context.fiscalYear!==year
     ||!Number.isFinite(context.annualGrossIncome)||context.annualGrossIncome<0
     ||!Number.isInteger(context.userAge)||context.userAge<18||context.userAge>120
     ||!['salary','pension','family_pension','business','other'].includes(context.incomeSource)
     ||!['new','old'].includes(context.regime)
     ||context.baselineExcludesTheseInterestEvents!==true
     ||!context.deductions||typeof context.deductions!=='object')return unavailable('INCOMPLETE_INVESTOR_TAX_YEAR:'+year);
  try {
   getTaxPolicyMetadata(year);
   const args=[context.annualGrossIncome,context.regime,context.deductions,
     context.incomeSource,year,context.userAge];
   const baseline=computeTax(...args);
   const withInterest=computeTax(context.annualGrossIncome+amountPaise/100,
      context.regime,context.deductions,context.incomeSource,year,context.userAge);
   if(!Number.isFinite(withInterest.taxAmount)||!Number.isFinite(baseline.taxAmount))
     return unavailable('TAX_AMOUNT_NOT_ESTABLISHED:'+year);
   const liability=Math.max(0,Math.round((withInterest.taxAmount-baseline.taxAmount)*100));
   if(!Number.isSafeInteger(liability))return unavailable('TAX_PRECISION_INVALID');
   taxByYear.set(year,liability);
  } catch {return unavailable('TAX_POLICY_OR_CALCULATION_UNAVAILABLE:'+year);}
 }
 for(const [year,tax] of taxByYear){
  const payable=interest.filter(e=>fy(e.date)===year);
  const last=payable.at(-1);
  if(!last||last.grossAmountPaise<tax)return unavailable('WITHHOLDING_EXCEEDS_LAST_PAYOUT:'+year);
  last.netAmountPaise-=tax;
 }
 const taxTotal=[...taxByYear.values()].reduce((sum,n)=>sum+n,0);
 const grossReceipts=events.reduce((s,e)=>s+Math.max(0,e.grossAmountPaise),0);
 if(!Number.isSafeInteger(grossReceipts)||taxTotal>grossReceipts)return unavailable('NET_CASHFLOW_RECONCILIATION_FAILED');
 return {status:'CALCULATED',reasonCodes:[],netTotalReceiptsPaise:grossReceipts-taxTotal,
   totalIncrementalTaxPaise:taxTotal,afterTaxCashflows:events,
   netXirr:calculateXirr(events),
   inputClass:'USER_DECLARED_DATED_TAX_EVENTS',
   taxTreatment:'ORDINARY_INTEREST_BY_FISCAL_YEAR',
   verifiedFutureTaxLaw:false};
}
