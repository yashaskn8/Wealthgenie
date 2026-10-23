import test from 'node:test';
import assert from 'node:assert/strict';
import {
 normalizeFreeFundSearch,normalizeFreeNavHistory,
 searchFreeFunds,getFreeFundNavResearch,
} from '../services/freeMutualFundNav.js';
import {
 getPublicSmallSavingsRates,calculatePublicSmallSavingsGrossResearch,
} from '../services/publicSmallSavingsResearch.js';
import {runMonteCarloWithGoal} from '../services/monteCarloEngine.js';

const now=new Date('2026-10-23T08:00:00Z');
const info={
 scheme_code:100641,scheme_name:'TEST SBI LIQUID GROWTH',
 fund_house:'Test Mutual Fund',plan_type:'Direct',option_type:'Growth',
 isin:'INF200K01LJ4',category:'Debt Scheme',
};
function observedNav(){
 const history=[];
 for(let i=0;i<120;i++){
  const date=new Date(Date.parse('2026-10-21T00:00:00Z')-i*3*86400000)
   .toISOString().slice(0,10);
  history.push({nav_date:date,nav:(100+(119-i)*0.07+
   Math.sin(i/3)*0.9).toFixed(4)});
 }
 return {fund_details:info,data:history};
}
test('keyless search preserves unique exact scheme identities and does not infer tax rights',()=>{
 const out=normalizeFreeFundSearch({results:[info]});
 assert.equal(out.status,'AVAILABLE');
 assert.equal(out.results[0].schemeCode,100641);
 assert.equal(out.postTaxAvailable,false);
 assert.equal(out.productionInvestmentQualification,false);
});
test('no-key NAV history calculates observed risk without using historical returns as forecasts',()=>{
 const out=normalizeFreeNavHistory(observedNav(),'100641',{now});
 assert.equal(out.status,'AVAILABLE',out.reasonCode);
 assert.ok(out.observedAnnualVolatility>0&&out.observedAnnualVolatility<0.6);
 assert.equal(out.postTaxFutureValue,null);
 assert.equal(out.forwardReturn,null);
 assert.equal(out.sourceRightsStatus,
  'RESEARCH_ONLY_UPSTREAM_AMFI_RIGHTS_NOT_QUALIFIED');
 const simulated=runMonteCarloWithGoal({
  monthlyInvestment:10000,currentSavings:0,
  annualExpectedReturn:0.08,annualVolatility:out.observedAnnualVolatility,
  years:5,simulations:200,inflationRate:0.05,seed:17,targetAmount:null,
 });
 assert.ok(Number.isFinite(simulated.p50.at(-1)));
 assert.ok(simulated.p10.at(-1)<simulated.p90.at(-1));
});
test('NAV identity mismatch, duplicate trading day, stale history and extreme jump fail closed',()=>{
 assert.equal(normalizeFreeNavHistory(observedNav(),'100642',{now}).status,'UNAVAILABLE');
 const duplicate=observedNav();duplicate.data[1].nav_date=duplicate.data[0].nav_date;
 assert.equal(normalizeFreeNavHistory(duplicate,'100641',{now}).status,'UNAVAILABLE');
 assert.equal(normalizeFreeNavHistory(observedNav(),'100641',{
  now:new Date('2026-12-01T00:00:00Z'),
 }).reasonCode,'NAV_HISTORY_STALE_OR_TOO_SHORT');
 const jump=observedNav();jump.data[2].nav='1000';
 assert.equal(normalizeFreeNavHistory(jump,'100641',{now}).reasonCode,
  'NAV_JUMP_REQUIRES_ADJUSTMENT_REVIEW');
});
test('no-key adapter uses fixed source, no redirects, and never accepts arbitrary scheme URL',async()=>{
 const calls=[];
 const fetchImpl=async(url,options)=>{
  calls.push({url,options});
  return new Response(JSON.stringify({results:[info]}),{
   headers:{'content-type':'application/json'},
  });
 };
 const out=await searchFreeFunds('SBI',{fetchImpl});
 assert.equal(out.status,'AVAILABLE');
 assert.ok(calls[0].url.startsWith('https://mfnav.in/api/funds/search?'));
 assert.equal(calls[0].options.redirect,'error');
 await assert.rejects(()=>getFreeFundNavResearch('https://evil.test/',{fetchImpl}),
  /INVALID_FUND_SCHEME_CODE/);
 assert.equal(calls.length,1);
});
test('cashflow free reference lists published rates but refuses unsupported product contracts',()=>{
 const reference=getPublicSmallSavingsRates({now});
 assert.equal(reference.status,'DATED_REFERENCE_AVAILABLE');
 assert.ok(reference.rates.length>=9);
 assert.equal(reference.postTaxAvailable,false);
 const unavailable=calculatePublicSmallSavingsGrossResearch({
  productId:'government:india-post:ppf',principal:10000,now,
 });
 assert.equal(unavailable.status,'UNAVAILABLE');
 assert.equal(unavailable.postTaxProceeds,null);
});
test('NSC and term deposits independently reconcile source-dated gross paise ledgers',()=>{
 const input={principal:10000,now};
 const nsc=calculatePublicSmallSavingsGrossResearch({
  ...input,productId:'government:india-post:nsc',
 });
 assert.equal(nsc.status,'CALCULATED',nsc.reasonCode);
 assert.equal(nsc.grossTotalProceeds,Math.round(10000*Math.pow(1.077,5)));
 assert.equal(nsc.cashflowLedger.totalReceiptsPaise,nsc.grossTotalProceeds*100);
 assert.equal(nsc.postTaxAvailable,false);
 const td=calculatePublicSmallSavingsGrossResearch({
  ...input,productId:'government:india-post:post-office-td-2y',
 });
 const coupon=Math.round(10000*(Math.pow(1+.07/4,4)-1));
 assert.equal(td.status,'CALCULATED',td.reasonCode);
 assert.equal(td.annualPayouts.length,2);
 assert.equal(td.grossTotalProceeds,10000+coupon*2);
 assert.equal(td.cashflowLedger.totalReceiptsPaise,td.grossTotalProceeds*100);
});
test('published reference quarter expiry and unsupported deposit denomination fail closed',()=>{
 const expired=calculatePublicSmallSavingsGrossResearch({
  productId:'government:india-post:nsc',principal:10000,
  now:new Date('2027-01-01T00:00:00Z'),
 });
 assert.equal(expired.status,'UNAVAILABLE');
 assert.equal(expired.reasonCode,'REFERENCE_RATE_EXPIRED');
 const invalid=calculatePublicSmallSavingsGrossResearch({
  productId:'government:india-post:post-office-td-1y',principal:1050,now,
 });
 assert.equal(invalid.status,'UNAVAILABLE');
 assert.equal(invalid.grossTotalProceeds,null);
});
