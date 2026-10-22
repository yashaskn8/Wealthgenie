/**
 * An exchange quote and mutual-fund NAV have different valuation meanings.
 * Unsupported identities must not silently choose the newest available metric.
 */
export function resolveQualifiedValuationKind(canonicalProductId){
 if(typeof canonicalProductId!=='string')return null;
 if(canonicalProductId.startsWith('mf:amfi:'))return 'NAV';
 if(['equity:isin:','stock:isin:','etf:isin:'].some(prefix=>canonicalProductId.startsWith(prefix)))
   return 'PRICE';
 return null;
}
const DECIMAL=/^(0|[1-9][0-9]*)(?:\.([0-9]{1,8}))?$/;
const SCALE=100000000n;
function toScaled(value){
 if(typeof value!=='string')throw new TypeError('Decimal value must be an explicit string');
 const match=DECIMAL.exec(value);
 if(!match)throw new TypeError('Invalid financial decimal');
 const whole=BigInt(match[1]);
 if(whole>1000000000000n)throw new RangeError('Financial amount exceeds supported range');
 return whole*SCALE+BigInt((match[2]||'').padEnd(8,'0'));
}
export function calculateHoldingValuation({units,unitPrice,currency='INR',costBasisPaise}){
 if(currency!=='INR')throw new RangeError('Unknown or non-INR market fact cannot value an INR investment');
 const u=toScaled(units),p=toScaled(unitPrice);
 const cost=BigInt(costBasisPaise);
 if(u<=0n||p<=0n||cost<0n||cost>100000000000000000n)throw new RangeError('Invalid holding quantity, price or acquisition cost');
 const paise=(u*p*100n+(SCALE*SCALE/2n))/(SCALE*SCALE);
 if(paise>100000000000000000n)throw new RangeError('Holding valuation exceeds supported precision');
 const unrealized=paise-cost;
 function inr(value){
  const negative=value<0n;const absolute=negative?-value:value;
  return (negative?'-':'')+String(absolute/100n)+'.'+String(absolute%100n).padStart(2,'0');
 }
 return {currentValueInr:inr(paise),unrealizedGainInr:inr(unrealized),
  costBasisInr:inr(cost),currency:'INR',
  basis:'MARK_TO_MARKET_UNREALIZED_NOT_POST_TAX'};
}
