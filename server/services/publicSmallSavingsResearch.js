/**
 * Manually reviewed, dated PUBLIC reference from Indian Bank's published
 * Government small-savings table for 1 Oct through 31 Dec 2026.
 * Not a live scraper, permission grant, fresh future-quarter rate or
 * qualification to reproduce protected source material commercially.
 * Product-specific gross calculations use the canonical paise ledger.
 */
import {buildContractualCashflowLedger} from './contractCashflowLedger.js';
export const SMALL_SAVINGS_Q3_FY27_SOURCE=
 'https://indianbank.bank.in/en/interest-rates-for-small-savings-schemes';
const from='2026-10-01',to='2026-12-31';
const table=Object.freeze([
 ['government:india-post:ppf','Public Provident Fund',7.1,'Annually',null],
 ['government:india-post:sukanya','Sukanya Samriddhi',8.2,'Annually',null],
 ['government:india-post:scss','Senior Citizens Savings Scheme',8.2,'Quarterly',null],
 ['government:india-post:kvp','Kisan Vikas Patra',7.5,'Annually',115],
 ['government:india-post:nsc','National Savings Certificate',7.7,'Annually',60],
 ['government:india-post:pomis','Post Office Monthly Income Scheme',7.4,'Monthly payout',null],
 ['government:india-post:post-office-td-1y','Post Office Time Deposit (1 year)',6.9,'Quarterly',12],
 ['government:india-post:post-office-td-2y','Post Office Time Deposit (2 years)',7.0,'Quarterly',24],
 ['government:india-post:post-office-td-3y','Post Office Time Deposit (3 years)',7.1,'Quarterly',36],
 ['government:india-post:post-office-td-5y','Post Office Time Deposit (5 years)',7.5,'Quarterly',60],
]);
function dateAt(now){
 if(!(now instanceof Date)||!Number.isFinite(+now))throw new TypeError('Invalid as-of date');
 const p=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
 const o=Object.fromEntries(p.filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
 return o.year+'-'+o.month+'-'+o.day;
}
export function getPublicSmallSavingsRates({now=new Date()}={}){
 const today=dateAt(now),current=today>=from&&today<=to;
 return {
  status:current?'DATED_REFERENCE_AVAILABLE':'REFERENCE_EXPIRED',
  dataClass:'DATED_PUBLIC_REFERENCE_NOT_LIVE_MARKET_DATA',asOfDate:today,
  effectiveFrom:from,effectiveTo:to,
  source:{publisher:'Indian Bank quoting Government of India memorandum dated 2026-09-30',
    url:SMALL_SAVINGS_Q3_FY27_SOURCE},
  permittedAsProductionProductFact:false,postTaxAvailable:false,
  sourceRightsStatus:'REFERENCE_RESEARCH_ONLY_COMMERCIAL_REUSE_NOT_QUALIFIED',
  rates:table.map(([id,name,annualRatePercent,compoundingBasis,tenureMonths])=>({
    id,name,annualRatePercent,compoundingBasis,tenureMonths,
    grossCashflowSupported:id==='government:india-post:nsc'
      ||id.startsWith('government:india-post:post-office-td-'),
  })),
 };
}
export function calculatePublicSmallSavingsGrossResearch({productId,principal,now=new Date()}={}){
 const ref=getPublicSmallSavingsRates({now});
 const empty=(code)=>({
  status:'UNAVAILABLE',reasonCode:code,productId,
  grossTotalProceeds:null,grossMaturityProceeds:null,postTaxProceeds:null,
  postTaxAvailable:false,source:ref.source,
 });
 if(ref.status!=='DATED_REFERENCE_AVAILABLE')return empty('REFERENCE_RATE_EXPIRED');
 const row=ref.rates.find(x=>x.id===productId);
 if(!row||!row.grossCashflowSupported)return empty('PRODUCT_CONTRACT_NOT_SUPPORTED');
 const increment=productId==='government:india-post:nsc'?100:1000;
 if(!Number.isSafeInteger(principal)||principal<1000||principal>1e10
    ||principal%increment!==0)return empty('INVALID_EXPLICIT_PRINCIPAL_OR_DENOMINATION');
 const tenure=row.tenureMonths;
 let total, maturity, coupons=[],kind;
 if(productId==='government:india-post:nsc'){
  kind='MATURITY_COMPOUND';
  maturity=Math.round(principal*Math.pow(1+row.annualRatePercent/100,tenure/12));
  total=maturity;
 }else{
  // Existing TD contract: quarterly compounding of deposited funds, annual
  // interest PAID OUT, not silently reinvested in the term deposit.
  kind='ANNUAL_PAYOUT';
  const annualInterest=Math.round(principal*
   (Math.pow(1+row.annualRatePercent/400,4)-1));
  coupons=Array.from({length:tenure/12},(_,i)=>({
    month:(i+1)*12,annualInterestPaid:annualInterest,
  }));
  total=principal+annualInterest*coupons.length;
  maturity=principal+annualInterest;
 }
 if(!Number.isSafeInteger(total)||total>Number.MAX_SAFE_INTEGER/100)
  return empty('GROSS_MONEY_PRECISION_EXCEEDED');
 const ledger=buildContractualCashflowLedger({
  principal,tenureMonths:tenure,cashflowType:kind,
  annualPayouts:coupons,grossMaturityProceeds:maturity,
  grossTotalProceeds:total,
 });
 return {
  status:'CALCULATED',dataClass:'DATED_REFERENCE_GROSS_ILLUSTRATION',
  productId,productName:row.name,principal,
  annualRatePercent:row.annualRatePercent,rateEffectiveFrom:from,
  rateEffectiveTo:to,tenureMonths:tenure,
  grossMaturityProceeds:maturity,grossTotalProceeds:total,
  grossGain:total-principal,annualPayouts:coupons,cashflowLedger:ledger,
  postTaxProceeds:null,postTaxAvailable:false,
  postTaxReasonCode:'ACCOUNT_AND_PRODUCT_TAX_FACTS_NOT_QUALIFIED',
  scenarioClass:'USER_PRINCIPAL_DATED_OFFICIAL_REFERENCE_NOT_VERIFIED_OFFER',
  productionProductQualification:false,
  sourceRightsStatus:ref.sourceRightsStatus,source:ref.source,
  caveat:'Historical quarter reference: not a live rate, guaranteed future renewal, personalized recommendation, or verified net-of-tax outcome.',
 };
}
