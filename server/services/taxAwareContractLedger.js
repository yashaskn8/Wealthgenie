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
 if(!eventDates||typeof eventDates!=='object'||Array.isArray(eventDates))return unavailable('EXACT_SETTLEMENT_DATES_REQUIRED');
 if(!taxContexts||typeof taxContexts!=='object'||Array.isArray(taxContexts))return unavailable('TAX_YEARS_REQUIRED');
 const events=[];
 for(const item of ledger.events) {
  const date=eventDates[item.id];
  if(!dateValid(date))return unavailable('EXACT_SETTLEMENT_DATE_MISSING:'+item.id);
  if(!Number.isSafeInteger(item.amountPaise))return unavailable('CASHFLOW_PRECISION_INVALID');
  events.push({id:item.id,kind:item.kind,date,grossAmountPaise:item.amountPaise,netAmountPaise:item.amountPaise});
 }
 events.sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id));
 if(!['SUBSCRIPTION'].includes(events[0]?.kind))return unavailable('MISSING_INITIAL_SUBSCRIPTION');
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
 for(const [year,amountPaise] of totals) {
  const context=taxContexts[year];
  if(!context||context.fiscalYear!==year
     ||!Number.isFinite(context.annualGrossIncome)||context.annualGrossIncome<0
     ||!Number.isInteger(context.userAge)||context.userAge<18||context.userAge>120
     ||!['salary','pension','family_pension','business','other'].includes(context.incomeSource)
     ||!['new','old'].includes(context.regime)
     ||!context.baselineExcludesTheseInterestEvents
     ||!context.deductions||typeof context.deductions!=='object')return unavailable('INCOMPLETE_INVESTOR_TAX_YEAR:'+year);
  try {
   getTaxPolicyMetadata(year);
   const args=[context.annualGrossIncome,context.regime,context.deductions,
     context.incomeSource,year,context.userAge];
   const baseline=computeTax(...args);
   const withInterest=computeTax(context.annualGrossIncome+amountPaise/100,
      context.regime,context.deductions,context.incomeSource,year,context.userAge);
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
