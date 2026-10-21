import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContractualCashflowLedger } from '../services/contractCashflowLedger.js';
import { calculateQualifiedProductCashflow } from '../services/productCashflowEngine.js';
test('single redemption reconciles in integer paise', () => {
  const ledger=buildContractualCashflowLedger({principal:10000,tenureMonths:60,
    cashflowType:'MATURITY_COMPOUND',annualPayouts:[],
    grossMaturityProceeds:14500,grossTotalProceeds:14500});
  assert.equal(ledger.totalReceiptsPaise,1450000);
  assert.equal(ledger.grossGainPaise,450000);
  assert.deepEqual(ledger.events.map(e=>e.amountPaise),[-1000000,1450000]);
  assert.equal(ledger.xirrStatus,'UNAVAILABLE_WITHOUT_VERIFIED_PAYMENT_DATES');
});
test('annual interest payouts and terminal principal are distinct and reconciled', () => {
  const coupons=[12,24,36,48,60].map(month=>({month,annualInterestPaid:400}));
  const ledger=buildContractualCashflowLedger({principal:10000,tenureMonths:60,
    cashflowType:'ANNUAL_PAYOUT',annualPayouts:coupons,
    grossMaturityProceeds:10400,grossTotalProceeds:12000});
  assert.equal(ledger.events.length,7);
  assert.equal(ledger.events.filter(e=>e.monthOffset===60&&e.amountPaise>0)
    .reduce((s,e)=>s+e.amountPaise,0),1040000);
  assert.equal(ledger.totalReceiptsPaise,1200000);
});
test('bad coupons, dates and totals are rejected', () => {
  const base={principal:10000,tenureMonths:24,cashflowType:'ANNUAL_PAYOUT',
    annualPayouts:[{month:12,annualInterestPaid:400},{month:24,annualInterestPaid:400}],
    grossMaturityProceeds:10400,grossTotalProceeds:10800};
  assert.throws(()=>buildContractualCashflowLedger({...base,grossTotalProceeds:11000}),/reconcile/);
  assert.throws(()=>buildContractualCashflowLedger({...base,
    annualPayouts:[{month:13,annualInterestPaid:400},base.annualPayouts[1]]}),/mismatch/);
  assert.throws(()=>buildContractualCashflowLedger({...base,annualPayouts:[]}),/incomplete/);
  assert.throws(()=>buildContractualCashflowLedger({...base,grossTotalProceeds:NaN}),/finite/);
});
test('sub-paisa values fail closed, and exact paisa cash flows reconcile',()=>{
  const values={principal:1000.29,tenureMonths:12,cashflowType:'MATURITY_COMPOUND',
    annualPayouts:[],grossMaturityProceeds:1000.39,grossTotalProceeds:1000.39};
  const l=buildContractualCashflowLedger(values);
  assert.equal(l.grossGainPaise,10);
  assert.equal(l.totalReceiptsPaise,100039);
  for(const invalid of [0.001, 10000.005, 10000.999, 1.2345])
    assert.throws(()=>buildContractualCashflowLedger({...values,principal:invalid}),/two decimal places/);
  assert.throws(()=>buildContractualCashflowLedger({...values,
    grossMaturityProceeds:1000.395,grossTotalProceeds:1000.395}),/two decimal places/);
});

test('unqualified product never produces a payment ledger',()=>{
  const result=calculateQualifiedProductCashflow({product:{canonicalProductId:'government:india-post:nsc'},
    principal:10000,enforceSourceRights:true,productionUseAllowed:false});
  assert.equal(result.status,'UNAVAILABLE');
  assert.equal(result.cashflowLedger,null);
});
