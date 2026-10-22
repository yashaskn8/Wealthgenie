import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateHoldingValuation} from '../services/holdingValuation.js';
test('decimal market value retains paise precision and preserves unrealized classification',()=>{
 const value=calculateHoldingValuation({units:'12.5',unitPrice:'101.2345',costBasisPaise:'100000'});
 assert.equal(value.currentValueInr,'1265.43');
 assert.equal(value.unrealizedGainInr,'265.43');
 assert.equal(value.basis,'MARK_TO_MARKET_UNREALIZED_NOT_POST_TAX');
});
test('unqualified currency or missing/invalid financial facts fail closed',()=>{
 assert.throws(()=>calculateHoldingValuation({units:'1',unitPrice:'1',currency:'USD',costBasisPaise:'0'}));
 assert.throws(()=>calculateHoldingValuation({units:'1',unitPrice:'NaN',costBasisPaise:'0'}));
 assert.throws(()=>calculateHoldingValuation({units:'0',unitPrice:'1',costBasisPaise:'0'}));
 assert.throws(()=>calculateHoldingValuation({units:'1',unitPrice:'1',costBasisPaise:'-1'}));
});
