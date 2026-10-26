import {describe,it} from 'node:test';
import assert from 'node:assert/strict';
import {sipFV} from '../services/projectionEngine.js';

/**
 * An independent, exact rational reference for annuity-due SIPs.
 * This oracle does not import the implementation's monthly-rate converter,
 * floating-point annuity formula, or its iterative comparison verifier.
 *
 * Every percentage is specified to exactly three decimal places or fewer:
 * nominal monthly rate = (annual percentage * 1000) / 1,200,000.
 * Integer arithmetic computes all 360 monthly compounding steps exactly.
 */
function exactRupeeValue(amount,percent,years) {
  const milliPercent=BigInt(Math.round(percent*1000));
  const denominatorRate=1_200_000n;
  const multiplier=denominatorRate+milliPercent;
  let numerator=0n,denominator=1n;
  for(let month=0;month<years*12;month++){
    numerator=(numerator+BigInt(amount)*denominator)*multiplier;
    denominator*=denominatorRate;
  }
  return (numerator+denominator/2n)/denominator;
}
describe('GenieVoice nominal SIP independent exact rational oracle',()=>{
  it('agrees with the canonical annuity-due engine across 160 economic boundary cases',()=>{
    const amounts=[100,5000,100000,10000000];
    const rates=[0.1,0.125,7,7.123,10,12.345,24.999,30];
    const years=[1,5,10,20,30];
    let checked=0;
    for(const monthly of amounts)for(const pct of rates)for(const horizon of years){
      const exact=exactRupeeValue(monthly,pct,horizon);
      const actual=Math.round(sipFV(monthly,pct/100,horizon));
      assert.ok(Number.isSafeInteger(actual));
      assert.ok(Math.abs(actual-Number(exact))<=2,
        'SIP numerical discrepancy: monthly='+monthly+
        ', percent='+pct+', years='+horizon+
        ', expected='+exact+', actual='+actual);
      checked++;
    }
    assert.equal(checked,160);
  });
});
