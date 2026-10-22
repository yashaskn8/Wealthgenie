/**
 * Explicitly bounded Indian resident-individual TY2026-27 computation.
 * Applicable only when ordinary taxable income >= Rs 13 lakh, all input amounts
 * are multiples of Rs 10, aggregate total income <= Rs 50 lakh, and all 196/198
 * annual capital gains have already been independently qualified/netted.
 * We deliberately refuse marginal section 156 rebate, basic-exemption transfers,
 * surcharge, loss set-offs and arbitrary input types rather than estimate them.
 * Sources: Income-tax Act 2025 (as amended 2026), ss. 19, 156, 196, 198, 202, 516.
 */
const VERSION = 'verified-capital-gains-TY2026-27-v1';
const SOURCE = 'https://www.incometaxindia.gov.in/documents/d/guest/income_tax_act_2025_as_amended_by_fa_act_2026-pdf';
const LIMIT = 1000000000n;
const MIN_ORDINARY = 1300000n;
const MAX_TOTAL = 5000000n;
const keys = ['taxYear','residency','incomeType','primaryIncome','otherOrdinaryIncome',
  'stcg196','ltcg198','completeYearGainsConfirmed','sttAndClassificationConfirmed',
  'noOtherTaxSituationsConfirmed'];
const slabs = [[0n,400000n,0n],[400000n,800000n,5n],[800000n,1200000n,10n],
  [1200000n,1600000n,15n],[1600000n,2000000n,20n],
  [2000000n,2400000n,25n],[2400000n,null,30n]];
function min(a,b){return a<b?a:b;}
function max(a,b){return a>b?a:b;}
function fail(code,message) {throw Object.assign(new TypeError(message),{code});}
function parseTen(s,label) {
  if (typeof s !== 'string' || !/^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,2})?$/.test(s))
    fail('INVALID_MONEY',label+' must be a non-negative rupee string');
  const [whole,decimal=''] = s.split('.');
  const paise=BigInt(whole)*100n+BigInt(decimal.padEnd(2,'0')||'0');
  if (paise>LIMIT*100n || paise%1000n!==0n)
    fail('INVALID_MONEY',label+' must be a whole multiple of Rs 10 and within range');
  return paise/100n;
}
function slabTax(rupees){
  let amount=0n;
  for(const [from,to,pct] of slabs){
    if(rupees>from)amount+=(min(rupees,to??rupees)-from)*pct*100n;
  }
  return amount; // 1/1000 rupee units; Rs 1 = 1000 units
}
function decimal(units){return (units/1000n).toString()+'.'+(units%1000n).toString().padStart(3,'0');}
export function calculateVerifiedComplexCapitalGainsTax(input){
  if(!input || typeof input!=='object' || Array.isArray(input)
     || Object.keys(input).length!==keys.length
     || Object.keys(input).some(k=>!keys.includes(k))
     || keys.some(k=>!Object.prototype.hasOwnProperty.call(input,k)))fail('INVALID_TAX_REQUEST','Unsupported or missing request fields');
  if(input.taxYear!=='2026-27')fail('UNSUPPORTED_TAX_YEAR','Only Tax Year 2026-27 is supported');
  if(!['resident','non_resident','unknown'].includes(input.residency)
    || !['salary','pension','already_taxable'].includes(input.incomeType)
    || ['completeYearGainsConfirmed','sttAndClassificationConfirmed','noOtherTaxSituationsConfirmed']
      .some(k=>typeof input[k]!=='boolean'))fail('INVALID_TAX_REQUEST','Invalid tax context');
  const primary=parseTen(input.primaryIncome,'primaryIncome');
  const other=parseTen(input.otherOrdinaryIncome,'otherOrdinaryIncome');
  const stcg=parseTen(input.stcg196,'stcg196');
  const ltcg=parseTen(input.ltcg198,'ltcg198');
  const deduction=input.incomeType==='already_taxable'?0n:min(primary,75000n);
  const ordinary=primary+other-deduction;
  const total=ordinary+stcg+ltcg;
  const reasons=[];
  if(input.residency!=='resident')reasons.push('RESIDENT_INDIVIDUAL_ONLY');
  if(!input.completeYearGainsConfirmed)reasons.push('YEAR_WIDE_NET_GAINS_UNVERIFIED');
  if(!input.sttAndClassificationConfirmed)reasons.push('SPECIAL_RATE_ELIGIBILITY_UNVERIFIED');
  if(!input.noOtherTaxSituationsConfirmed)reasons.push('OTHER_TAX_FACTS_UNCONFIRMED');
  if(stcg===0n && ltcg===0n)reasons.push('NO_SPECIAL_RATE_GAINS');
  if(ordinary<MIN_ORDINARY)reasons.push('BASIC_EXEMPTION_OR_87A_REBATE_REQUIRES_FULL_RETURN');
  if(total>MAX_TOTAL)reasons.push('SURCHARGE_REQUIRES_FULL_RETURN');
  if(total>LIMIT)reasons.push('INCOME_OVER_SUPPORTED_LIMIT');
  const base={taxYear:'2026-27',policyVersion:VERSION,sourceReferences:[SOURCE],inputsUsed:{...input}};
  if(reasons.length)return {...base,status:'UNAVAILABLE',unavailableReasons:reasons,finalTax:null};
  // No section 156 rebate: ordinary taxable income alone exceeds the upper
  // marginal-rebate region. No capital-gains basic-exemption reallocation.
  const ordinaryTax=slabTax(ordinary);
  const shortTax=stcg*200n; // 20% * 1000 units
  const exempt=min(ltcg,125000n);
  const longTax=(ltcg-exempt)*125n; // 12.5% * 1000 units
  const beforeCess=ordinaryTax+shortTax+longTax;
  const cess=beforeCess*4n/100n;
  const unrounded=beforeCess+cess;
  const finalTax=((unrounded/1000n+5n)/10n)*10n;
  return {...base,status:'CALCULATED',unavailableReasons:[],
    calculationClass:'VERIFIED_RESIDENT_EQUITY_GAINS_ABOVE_REBATE_BELOW_SURCHARGE',
    ordinaryTaxableIncome:ordinary.toString(),shortTermGains:stcg.toString(),
    longTermGains:ltcg.toString(),grossTotalIncome:total.toString(),
    standardDeduction:deduction.toString(),
    section198ExemptLongTermGain:exempt.toString(),
    ordinarySlabTax:decimal(ordinaryTax),section196Tax:decimal(shortTax),
    section198Tax:decimal(longTax),rebate:'0.000',surcharge:'0.000',
    cess:decimal(cess),taxBeforeStatutoryRounding:decimal(unrounded),
    finalTax:finalTax.toString()};
}
