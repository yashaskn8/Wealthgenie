import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import taxRoutes from '../routes/tax.js';
import { errorHandler } from '../middleware/errorHandler.js';
import { jsonRequest, withServer } from '../test-utils/httpTestUtils.js';

const input={
  taxYear:'2026-27',residency:'resident',incomeType:'already_taxable',
  primaryIncome:'1500000',otherOrdinaryIncome:'0',
  stcg196:'200000',ltcg198:'225000',
  completeYearGainsConfirmed:true,sttAndClassificationConfirmed:true,
  noOtherTaxSituationsConfirmed:true,
};
const post=(url,payload)=>jsonRequest(url+'/api/tax/new-regime-verified-complex',{method:'POST',body:JSON.stringify(payload)});
function appForTax(){
  const app=express();
  app.use(express.json({strict:true}));
  app.use('/api/tax',taxRoutes);
  app.use(errorHandler);
  return app;
}
test('complex endpoint returns verified 196/198 breakdown without caching',async()=>{
  await withServer(appForTax(),async url=>{
    const {response,body}=await post(url,input);
    assert.equal(response.status,200,JSON.stringify(body));
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal(body.status,'CALCULATED');
    assert.equal(body.section196Tax,'40000.000');
    assert.equal(body.section198Tax,'12500.000');
    assert.equal(body.section198ExemptLongTermGain,'125000');
    assert.equal(body.finalTax,'163800');
    assert.deepEqual(body.inputsUsed,input);
  });
});
test('complex endpoint refuses unsupported cases with null tax',async()=>{
  await withServer(appForTax(),async url=>{
    for(const patch of [
      {residency:'non_resident'},{primaryIncome:'1200000'},
      {primaryIncome:'4990000'},{completeYearGainsConfirmed:false},
      {noOtherTaxSituationsConfirmed:false},
    ]){
      const {response,body}=await post(url,{...input,...patch});
      assert.equal(response.status,200);
      assert.equal(response.headers.get('cache-control'),'no-store');
      assert.equal(body.status,'UNAVAILABLE',JSON.stringify({patch,body}));
      assert.equal(body.finalTax,null);
      assert.ok(body.unavailableReasons.length);
    }
  });
});
test('complex endpoint rejects incorrect types, amounts and years',async()=>{
  await withServer(appForTax(),async url=>{
    for(const patch of [{primaryIncome:1500000},{stcg196:'0.01'},{incomeType:'business'},
      {noOtherTaxSituationsConfirmed:'yes'},{unexpectedDeduction:'50000'}]){
      const {response,body}=await post(url,{...input,...patch});
      assert.equal(response.status,400,JSON.stringify({patch,body}));
      assert.equal(response.headers.get('cache-control'),'no-store');
    }
    const {response,body}=await post(url,{...input,taxYear:'2025-26'});
    assert.equal(response.status,422);
    assert.equal(body.code,'UNSUPPORTED_TAX_YEAR');
  });
});
