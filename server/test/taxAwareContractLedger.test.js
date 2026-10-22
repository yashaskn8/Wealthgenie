import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateTaxedContractLedger} from '../services/taxAwareContractLedger.js';
const ledger={
 status:'RECONCILED',events:[
  {id:'subscription',kind:'SUBSCRIPTION',amountPaise:-1000000},
  {id:'coupon:12',kind:'INTEREST_PAYOUT',amountPaise:100000},
  {id:'principal',kind:'PRINCIPAL_REDEMPTION',amountPaise:1000000},
 ]};
const options={
 ledger,eventDates:{subscription:'2026-04-01','coupon:12':'2027-03-31',principal:'2027-03-31'},
 taxContexts:{'FY2026-27':{
  fiscalYear:'FY2026-27',annualGrossIncome:2000000,userAge:35,
  incomeSource:'salary',regime:'new',deductions:{},
  baselineExcludesTheseInterestEvents:true,
 }},
 qualifiedProductTaxClass:'ORDINARY_INTEREST',sourceRightsQualified:true,
};
test('verified dated coupon events use shared tax law and preserve principal',()=>{
 const r=calculateTaxedContractLedger(options);
 assert.equal(r.status,'CALCULATED');
 assert.ok(r.netTotalReceiptsPaise<=1100000);
 assert.ok(r.totalIncrementalTaxPaise>=0);
 assert.ok(Number.isFinite(r.netXirr));
 assert.equal(r.afterTaxCashflows.find(e=>e.id==='principal').netAmountPaise,1000000);
});
test('ordinary contract tax fails closed for missing fiscal-year inputs or source permission',()=>{
 for(const patch of [
  {sourceRightsQualified:false},{taxContexts:{}},{eventDates:{}},
  {qualifiedProductTaxClass:'EQUITY_GAIN'},
  {ledger:{status:'RECONCILED',events:[ledger.events[0],ledger.events[2]]}},
 ]){
  const r=calculateTaxedContractLedger({...options,...patch});
  assert.equal(r.status,'UNAVAILABLE');
  assert.equal(r.netTotalReceiptsPaise,null);
 }
});

test('taxed contractual ledger rejects duplicate, sign-forged and principal-inconsistent events',()=>{
 const broken=[
  [...ledger.events, {...ledger.events[1]}],
  [{...ledger.events[0],amountPaise:100000},...ledger.events.slice(1)],
  [ledger.events[0],{...ledger.events[1],amountPaise:-100000},ledger.events[2]],
  [ledger.events[0],ledger.events[1],{...ledger.events[2],amountPaise:999999}],
  [ledger.events[0],ledger.events[1],{...ledger.events[2],kind:'INTEREST_PAYOUT'}],
 ];
 for(const events of broken){
  const result=calculateTaxedContractLedger({...options,ledger:{status:'RECONCILED',events}});
  assert.equal(result.status,'UNAVAILABLE',JSON.stringify(events));
  assert.equal(result.netTotalReceiptsPaise,null);
 }
 const result=calculateTaxedContractLedger({...options,taxContexts:{
  'FY2026-27':{...options.taxContexts['FY2026-27'],baselineExcludesTheseInterestEvents:'true'},
 }});
 assert.equal(result.status,'UNAVAILABLE','Only an explicit boolean may authorize baseline exclusion');
});
