import React, { useEffect, useRef, useState } from 'react';
import api from '../services/api';
import './NewRegimeTaxScreen.css';

const YEAR='2026-27';
const VERSION='verified-capital-gains-TY2026-27-v1';
const AMOUNT=/^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,2})?$/;
const INITIAL={
  taxYear:YEAR,residency:'unknown',incomeType:'',
  primaryIncome:'',otherOrdinaryIncome:'',stcg196:'',ltcg198:'',
  completeYearGainsConfirmed:false,sttAndClassificationConfirmed:false,
  noOtherTaxSituationsConfirmed:false,
};
function rupees(v){
  if(typeof v!=='string' || !AMOUNT.test(v))return null;
  const [whole,fraction='']=v.split('.');
  const paise=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0')||'0');
  return paise%1000n===0n&&paise<=100000000000n?paise/100n:null;
}
function display(v){
  if(v==null||!/^(0|[1-9]\d*)(?:\.\d{1,3})?$/.test(String(v)))return 'Unavailable';
  const [integer,fraction='']=String(v).split('.');
  const f=fraction.replace(/0+$/,'');
  return '₹'+BigInt(integer).toLocaleString('en-IN')+(f?'.'+f:'');
}
function assertBound(result,request){
  if(!result||result.policyVersion!==VERSION||result.taxYear!==YEAR||
     !result.inputsUsed||typeof result.inputsUsed!=='object'||Array.isArray(result.inputsUsed)||
     Object.keys(result.inputsUsed).length!==Object.keys(request).length||
     Object.keys(request).some(k=>request[k]!==result.inputsUsed[k]))return false;
  if(result.status==='UNAVAILABLE')return result.finalTax===null
    && Array.isArray(result.unavailableReasons)&&result.unavailableReasons.length>0
    && result.unavailableReasons.every(reason=>typeof reason==='string');
  if(result.status!=='CALCULATED' || result.calculationClass!=='VERIFIED_RESIDENT_EQUITY_GAINS_ABOVE_REBATE_BELOW_SURCHARGE'
    || result.unavailableReasons?.length!==0 || request.residency!=='resident'
    || !request.completeYearGainsConfirmed || !request.sttAndClassificationConfirmed
    || !request.noOtherTaxSituationsConfirmed)return false;
  const integerFields=['ordinaryTaxableIncome','grossTotalIncome','shortTermGains','longTermGains',
    'standardDeduction','section198ExemptLongTermGain','finalTax'];
  const decimalFields=['ordinarySlabTax','section196Tax','section198Tax','rebate','surcharge','cess',
    'taxBeforeStatutoryRounding'];
  return integerFields.every(key=>typeof result[key]==='string'&&/^\d+$/.test(result[key]))
    && decimalFields.every(key=>typeof result[key]==='string'&&/^\d+\.\d{3}$/.test(result[key]));
}
const BREAKDOWN=[
  ['Ordinary taxable income','ordinaryTaxableIncome'],
  ['Standard deduction applied','standardDeduction'],
  ['Short-term equity gains (Section 196)','shortTermGains'],
  ['Long-term equity gains (Section 198)','longTermGains'],
  ['Section 198 gains not charged at 12.5% (annual ₹1.25L band)','section198ExemptLongTermGain'],
  ['Ordinary income slab tax','ordinarySlabTax'],
  ['Short-term equity gain tax at 20%','section196Tax'],
  ['Long-term equity gain tax at 12.5%','section198Tax'],
  ['Rebate','rebate'],
  ['Surcharge','surcharge'],
  ['Health and education cess (4%)','cess'],
  ['Tax before statutory rounding','taxBeforeStatutoryRounding'],
];
const UNAVAILABLE_REASON_MESSAGES=Object.freeze({
  RESIDENT_INDIVIDUAL_ONLY:'This calculation supports resident individuals only.',
  YEAR_WIDE_NET_GAINS_UNVERIFIED:'Confirm that the amounts cover all annual net gains from every account.',
  SPECIAL_RATE_ELIGIBILITY_UNVERIFIED:'Confirm the gains meet the required tax classification and eligibility conditions.',
  OTHER_TAX_FACTS_UNCONFIRMED:'Confirm that no other tax situations apply before using this restricted calculation.',
  NO_SPECIAL_RATE_GAINS:'Enter at least one eligible capital-gain amount for this calculation.',
  BASIC_EXEMPTION_OR_87A_REBATE_REQUIRES_FULL_RETURN:'Basic-exemption or rebate rules for this case need a full tax calculation.',
  SURCHARGE_REQUIRES_FULL_RETURN:'This case needs surcharge rules outside the calculator’s supported scope.',
  INCOME_OVER_SUPPORTED_LIMIT:'This income is above the calculator’s supported range.',
});
function describeUnavailableReason(reason){
  return Object.hasOwn(UNAVAILABLE_REASON_MESSAGES,reason)
    ? UNAVAILABLE_REASON_MESSAGES[reason]
    : 'This case is outside the calculator’s verified scope. A full tax computation is required.';
}
export default function VerifiedCapitalGainsTaxScreen(){
  const [form,setForm]=useState(INITIAL);
  const [result,setResult]=useState(null);
  const [error,setError]=useState('');
  const [pending,setPending]=useState(false);
  const controller=useRef(null),generation=useRef(0);
  useEffect(()=>()=>{generation.current++;controller.current?.abort();},[]);
  function change(key,value){
    generation.current++;
    controller.current?.abort();
    setPending(false);setError('');setResult(null);
    setForm(f=>({...f,[key]:value}));
  }
  async function submit(event){
    event.preventDefault();
    const request={...form};
    if(!['salary','pension','already_taxable'].includes(request.incomeType)){
      setResult(null);
      setError('Choose an ordinary income category before calculating. No financial amounts were submitted.');
      return;
    }
    if(['primaryIncome','otherOrdinaryIncome','stcg196','ltcg198'].some(k=>rupees(request[k])===null)){
      setResult(null);
      setError('Choose an income category and enter all amounts as non-negative whole multiples of ₹10 (enter 0 where none).');
      return;
    }
    if(request.residency!=='resident' || !request.completeYearGainsConfirmed
      || !request.sttAndClassificationConfirmed || !request.noOtherTaxSituationsConfirmed){
      setResult(null);
      setError('This specialized calculator requires a confirmed resident individual, a complete year-wide gain ledger, verified rate eligibility and confirmation of no other tax situations. No financial amounts were submitted.');
      return;
    }
    const id=++generation.current;
    controller.current?.abort();
    const current=new AbortController();
    controller.current=current;
    setPending(true);setError('');setResult(null);
    try{
      const response=await api.computeVerifiedComplexCapitalGainsTax(request,{signal:current.signal});
      if(id!==generation.current||current.signal.aborted)return;
      if(!assertBound(response,request))throw new Error('The server returned a mismatched or unverifiable computation.');
      setResult(response);
    }catch(e){
      if(id!==generation.current||current.signal.aborted)return;
      setError('Calculation unavailable. '+(e?.message||'Please check the submitted tax facts.'));
      setResult(null);
    }finally{if(id===generation.current)setPending(false);}
  }
  return <section className="wg-new-tax" aria-label="Qualified resident capital gains tax calculator">
    <header className="wg-new-tax__header">
      <p className="wg-new-tax__eyebrow">ADVANCED · VERIFIED EQUITY GAINS · TY 2026–27</p>
      <h2>Income Tax with Capital Gains</h2>
      <p>A narrow and verifiable new-regime calculation for resident individuals with already-computed,
        year-wide Section 196 short-term and Section 198 long-term equity gains. Requires ordinary
        taxable income of at least ₹13 lakh and total income not above ₹50 lakh.
        Other circumstances are explicitly declined instead of estimated.</p>
    </header>
    <form className="wg-new-tax__form" onSubmit={submit} noValidate>
      <label htmlFor="capital-income-type">Ordinary income type</label>
      <select id="capital-income-type" value={form.incomeType} onChange={e=>change('incomeType',e.target.value)}>
        <option value="">Select income type</option>
        <option value="salary">Gross taxable salary before standard deduction</option>
        <option value="pension">Own qualifying pension before standard deduction</option>
        <option value="already_taxable">Already-computed ordinary taxable income</option>
      </select>
      {[
        ['primaryIncome','Annual primary ordinary income'],
        ['otherOrdinaryIncome','Additional ordinary-rate taxable income'],
        ['stcg196','Net annual STCG eligible for Section 196 (20%)'],
        ['ltcg198','Net annual LTCG eligible for Section 198 (12.5%)'],
      ].map(([field,label])=><React.Fragment key={field}>
        <label htmlFor={'capital-'+field}>{label} (₹, multiples of ₹10)</label>
        <input id={'capital-'+field} type="text" inputMode="decimal" autoComplete="off"
          value={form[field]} placeholder="0" maxLength={13}
          onChange={e=>change(field,e.target.value)} required />
      </React.Fragment>)}
      <p className="wg-new-tax__hint">The capital gains must be NET TAXABLE GAINS already reconciled
        for all holdings for this tax year, after independently establishing cost basis,
        grandfathering, applicable exemptions and permissible loss set-offs. Do not enter
        proceeds, portfolio value or investment principal. The Section 198 ₹1.25 lakh annual 12.5%-rate threshold
        is applied ONCE across qualifying annual gains, never per transaction. The full gain still
        counts toward total-income thresholds.</p>
      <label htmlFor="capital-residency">Tax residence</label>
      <select id="capital-residency" value={form.residency} onChange={e=>change('residency',e.target.value)}>
        <option value="unknown">Unknown — calculation unavailable</option>
        <option value="resident">Resident individual in India</option>
        <option value="non_resident">Non-resident — calculation unavailable</option>
      </select>
      {[
        ['completeYearGainsConfirmed','I confirm the amounts include ALL annual net Section 196/198 gains from every account, with loss and cost-base treatment independently checked.'],
        ['sttAndClassificationConfirmed','I confirm each gain qualifies for the specified STT and classification conditions, including Section 198 acquisition requirements.'],
        ['noOtherTaxSituationsConfirmed','I confirm no other special-rate income, carried losses, house-property adjustments, additional deductions, agricultural-income rate integration, foreign tax credits, or other unmodelled tax provisions apply.'],
      ].map(([field,label])=><label className="wg-new-tax__confirm" key={field}>
        <input type="checkbox" checked={form[field]} onChange={e=>change(field,e.target.checked)} />
        <span>{label}</span>
      </label>)}
      <button type="submit" disabled={pending}>{pending?'Verifying…':'Calculate verified equity-gains tax'}</button>
    </form>
    {error&&<p className="wg-new-tax__alert" role="alert">{error}</p>}
    {result?.status==='UNAVAILABLE'&&<div className="wg-new-tax__alert" role="status">
      <p>No tax figure is available for this case. A full tax computation may be required.</p>
      <ul>{result.unavailableReasons.map((reason,index)=><li key={`${reason}-${index}`}>
        {describeUnavailableReason(reason)}
      </li>)}</ul>
      <p>No speculative figure is displayed.</p>
    </div>}
    {result?.status==='CALCULATED'&&<section className="wg-new-tax__result" aria-label="Verified capital gains tax result">
      <p>Estimated liability on the exact declared and qualified tax heads</p>
      <strong className="wg-new-tax__amount">{display(result.finalTax)}</strong>
      <p>Total income {display(result.grossTotalIncome)} · Tax Year 2026–27 · {result.policyVersion}</p>
      <details open><summary>Calculation ledger and statutory rounding</summary><table><tbody>
        {BREAKDOWN.map(([label,key])=><tr key={key}>
          <th scope="row">{label}</th><td>{display(result[key])}</td>
        </tr>)}
        <tr><th scope="row">Final estimated tax</th><td><strong>{display(result.finalTax)}</strong></td></tr>
      </tbody></table></details>
    </section>}
    <p className="wg-new-tax__footnote">This is not a return filing, annual gains extraction,
      broker reconciliation, tax-withheld calculation, refund calculation or substitute for
      professional advice. The form does not collect PAN, account numbers, or API keys.
      Unsupported cases are intentionally refused.</p>
    <p className="wg-new-tax__sources">Statutory source: <a
      href="https://www.incometaxindia.gov.in/documents/d/guest/income_tax_act_2025_as_amended_by_fa_act_2026-pdf"
      target="_blank" rel="noopener noreferrer">Income-tax Act 2025, as amended by Finance Act 2026</a>.</p>
  </section>;
}
