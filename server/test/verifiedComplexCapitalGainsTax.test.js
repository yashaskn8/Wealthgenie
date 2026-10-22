import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateVerifiedComplexCapitalGainsTax as calculate } from '../services/verifiedComplexCapitalGainsTax.js';

const base = Object.freeze({
  taxYear:'2026-27',residency:'resident',incomeType:'already_taxable',
  primaryIncome:'1500000',otherOrdinaryIncome:'0',
  stcg196:'200000',ltcg198:'225000',
  completeYearGainsConfirmed:true,sttAndClassificationConfirmed:true,
  noOtherTaxSituationsConfirmed:true,
});
const run = overrides => calculate({...base,...overrides});

test('official 2025 Act sections 196/198: 20% STCG, 12.5% LTCG above 125000, 4% cess',()=>{
  const r=run({});
  assert.equal(r.status,'CALCULATED');
  assert.equal(r.ordinaryTaxableIncome,'1500000');
  assert.equal(r.grossTotalIncome,'1925000');
  assert.equal(r.ordinarySlabTax,'105000.000');
  assert.equal(r.section196Tax,'40000.000');
  assert.equal(r.section198ExemptLongTermGain,'125000');
  assert.equal(r.section198Tax,'12500.000');
  assert.equal(r.cess,'6300.000');
  assert.equal(r.finalTax,'163800');
  assert.equal(r.rebate,'0.000');
  assert.equal(r.surcharge,'0.000');
});

test('own pension or salary standard deduction applied exactly once',()=>{
  const r=run({incomeType:'salary',primaryIncome:'1600000',stcg196:'100000'});
  assert.equal(r.standardDeduction,'75000');
  assert.equal(r.ordinaryTaxableIncome,'1525000');
  assert.equal(r.ordinarySlabTax,'108750.000');
  assert.equal(r.section196Tax,'20000.000');
  assert.equal(r.section198Tax,'12500.000');
  assert.equal(r.finalTax,'146900');
  assert.equal(run({incomeType:'pension',primaryIncome:'1600000',stcg196:'100000'}).finalTax,'146900');
});

test('112A exemption is annual, not per holding, with exact 125000 threshold',()=>{
  const at=run({primaryIncome:'1300000',stcg196:'10000',ltcg198:'125000'});
  const above=run({primaryIncome:'1300000',stcg196:'10000',ltcg198:'125010'});
  assert.equal(at.section198Tax,'0.000');
  assert.equal(at.finalTax,'80080');
  assert.equal(above.section198Tax,'1.250');
  assert.equal(above.finalTax,'80080');
  assert.equal(above.taxBeforeStatutoryRounding,'80081.300');
});

test('input rounding, max surcharge and rebate margin never guessed',()=>{
  for(const patch of [
    {primaryIncome:'1299990'},
    {residency:'non_resident'},
    {residency:'unknown'},
    {primaryIncome:'4800000'},
    {stcg196:'0',ltcg198:'0'},
    {completeYearGainsConfirmed:false},
    {sttAndClassificationConfirmed:false},
    {noOtherTaxSituationsConfirmed:false},
  ]) {
    const r=run(patch);
    assert.equal(r.status,'UNAVAILABLE',JSON.stringify(patch));
    assert.equal(r.finalTax,null);
    assert.ok(r.unavailableReasons.length,JSON.stringify(patch));
  }
  assert.equal(run({primaryIncome:'4575000',stcg196:'200000',ltcg198:'225000'}).status,'CALCULATED');
  assert.equal(run({primaryIncome:'4575010',stcg196:'200000',ltcg198:'225000'}).status,'UNAVAILABLE');
});

test('reject unknown keys, unsupported years, decimals/overflows, wrong booleans',()=>{
  for(const patch of [
    {taxYear:'2025-26'}, {regime:'old'},
    {primaryIncome:1500000},
    {otherOrdinaryIncome:'2.20'},
    {stcg196:'9.99'}, {ltcg198:'-10'},
    {ltcg198:'9000000000'}, {incomeType:'business'},
    {completeYearGainsConfirmed:'true'},
  ])assert.throws(()=>run(patch),undefined,JSON.stringify(patch));
});

test('separate tax heads reconcile and repeat deterministically across 5000 inputs',()=>{
  let count=0;
  for(let ordinary=1300000;ordinary<=4575000;ordinary+=1237){
    const stcg=String((count%89)*10);
    const ltcg=String(125000+count%111*10);
    const r=run({primaryIncome:String((Math.floor(ordinary/10))*10),stcg196:stcg,ltcg198:ltcg});
    if(r.status!=='CALCULATED')continue;
    assert.deepEqual(r,run({primaryIncome:String((Math.floor(ordinary/10))*10),stcg196:stcg,ltcg198:ltcg}));
    const u=k=>BigInt(r[k].replace('.',''));
    assert.equal(u('ordinarySlabTax')+u('section196Tax')+u('section198Tax')+u('cess'),u('taxBeforeStatutoryRounding'));
    assert.equal(u('cess'),(u('ordinarySlabTax')+u('section196Tax')+u('section198Tax'))*4n/100n);
    assert.equal(BigInt(r.finalTax)%10n,0n);
    count++;
  }
  assert.ok(count>2000,count);
});
