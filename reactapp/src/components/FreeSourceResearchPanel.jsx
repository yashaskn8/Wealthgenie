import React,{useEffect,useRef,useState} from 'react';
import {
 searchFreeMutualFunds,simulateFreeMutualFundNavResearch,
 getFreeSmallSavingsRates,calculateFreeSmallSavingsGross,
 getFreeFinancialSourceCoverage,
} from '../services/api';

const INR=n=>Number.isFinite(n)?new Intl.NumberFormat('en-IN',{
 style:'currency',currency:'INR',maximumFractionDigits:0,
}).format(n):'Unavailable';
const style={
 panel:{marginTop:22,padding:16,border:'1px solid rgba(56,189,248,.28)',
  borderRadius:12,background:'rgba(3,16,31,.5)',color:'#e2e8f0'},
 field:{padding:8,borderRadius:7,border:'1px solid #64748b',
  background:'#0f172a',color:'#f8fafc',maxWidth:'100%'},
 action:{padding:'9px 12px',borderRadius:8,border:'1px solid #38bdf8',
  background:'#075985',color:'#f8fafc',cursor:'pointer'},
};
export default function FreeSourceResearchPanel(){
 const [open,setOpen]=useState(false);
 const [mode,setMode]=useState('mf');
 const [query,setQuery]=useState('HDFC');
 const [funds,setFunds]=useState([]);
 const [selected,setSelected]=useState(null);
 const [expectedReturn,setExpectedReturn]=useState('8');
 const [horizon,setHorizon]=useState('5');
 const [monthly,setMonthly]=useState('10000');
 const [rates,setRates]=useState(null);
 const [directory,setDirectory]=useState(null);
 const [showSources,setShowSources]=useState(false);
 const [productId,setProductId]=useState('government:india-post:nsc');
 const [principal,setPrincipal]=useState('10000');
 const [result,setResult]=useState(null);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const controller=useRef(null);
 useEffect(()=>()=>controller.current?.abort(),[]);
 function invalidateFinancialResult(){
  controller.current?.abort();
  setBusy(false);
  setError('');
  setResult(null);
 }
 async function request(fn,onDone){
  controller.current?.abort();
  const c=new AbortController();controller.current=c;
  setBusy(true);setError('');setResult(null);
  try{const value=await fn(c.signal);if(!c.signal.aborted)onDone(value);}
  catch(err){if(!c.signal.aborted)setError(err?.message||'Source unavailable');}
  finally{if(!c.signal.aborted)setBusy(false);}
 }
 const search=()=>{
  setFunds([]);setSelected(null);
  request(signal=>searchFreeMutualFunds(query,{signal}),value=>{
  if(value?.status!=='AVAILABLE'||!Array.isArray(value.results))
   throw new Error('Source returned no qualified research list');
  setFunds(value.results);setSelected(null);
  });
 };
 const loadRates=()=>request(signal=>getFreeSmallSavingsRates({signal}),setRates);
 const loadSources=()=>{
  if(showSources){setShowSources(false);return;}
  if(directory){setShowSources(true);return;}
  request(signal=>getFreeFinancialSourceCoverage({signal}),value=>{
   if(value?.status!=='SOURCE_CANDIDATE_DIRECTORY'||!Array.isArray(value.sources))
    throw new Error('Provider directory is unavailable.');
   setDirectory(value);setShowSources(true);
  });
 };
 const simulate=()=>{
  const amount=Number(monthly),rate=Number(expectedReturn),years=Number(horizon);
  if(!selected||!Number.isFinite(amount)||amount<=0||amount>1e7
   ||!Number.isFinite(rate)||rate<=-100||rate>100
   ||!Number.isInteger(years)||years<1||years>30){
   setError('Choose a scheme and enter valid monthly SIP, annual assumption and duration.');return;
  }
  request(signal=>simulateFreeMutualFundNavResearch({
   schemeCode:String(selected.schemeCode),monthlyInvestment:amount,
   currentSavings:0,annualExpectedReturn:rate/100,
   years,simulations:400,inflationRate:0.05,seed:20261023,
   targetAmount:null,
  },{signal}),setResult);
 };
 const calculate=()=>{
  const value=Number(principal);
  if(!Number.isSafeInteger(value)||value<1000||value>1e10){
   setError('Principal must be a whole-rupee amount of at least ₹1,000.');return;
  }
  request(signal=>calculateFreeSmallSavingsGross({productId,principal:value},{signal}),setResult);
 };
 const showResult=result&&result.status==='CALCULATED';
 return (
  <section data-testid="free-source-research-panel" aria-label="Free public financial data research"
   style={style.panel}>
   <div style={{display:'flex',gap:12,alignItems:'center',justifyContent:'space-between',flexWrap:'wrap'}}>
    <div>
     <strong>Explore free online financial data</strong>
     <p style={{fontSize:12,color:'#cbd5e1',margin:'5px 0 0'}}>
      On-demand, no external API key. Separate from verified personalized investment advice.
     </p>
    </div>
    <button type="button" style={style.action} onClick={()=>setOpen(!open)}
     aria-expanded={open}>{open?'Hide data research':'Open free-source research'}</button>
   </div>
   {open&&(
    <div style={{marginTop:14}}>
     <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:14}}>
      <button type="button" style={style.action} aria-pressed={mode==='mf'}
       onClick={()=>{invalidateFinancialResult();setMode('mf');}}>Mutual fund NAV risk</button>
      <button type="button" style={style.action} aria-pressed={mode==='savings'}
       onClick={()=>{invalidateFinancialResult();setMode('savings');}}>Government savings cash flows</button>
     </div>
     {mode==='mf'?(
      <div>
       <p style={{fontSize:12,color:'#cbd5e1'}}>
        Search individual AMFI scheme codes through mfnav.in. Historical NAV volatility
        calibrates a <strong>pre-tax</strong> Monte Carlo illustration; expected return is your assumption.
        Only identified Growth plans support this NAV-only simulation. IDCW distributions
        need a separate verified total-return history.
       </p>
       <label style={{fontSize:12}}>Scheme search{' '}
        <input style={style.field} aria-label="Search mutual fund scheme" value={query}
         maxLength={80} onChange={e=>{invalidateFinancialResult();setQuery(e.target.value);setSelected(null);setFunds([]);}}/></label>{' '}
       <button type="button" style={style.action} disabled={busy} onClick={search}>Search online NAV</button>
       {funds.length>0&&(
        <label style={{display:'block',marginTop:10,fontSize:12}}>Exact scheme and plan
         <select style={{...style.field,display:'block',marginTop:6,width:'100%'}}
          aria-label="Choose mutual fund NAV scheme" value={selected?.schemeCode||''}
          onChange={e=>{invalidateFinancialResult();setSelected(funds.find(f=>String(f.schemeCode)===e.target.value)||null);}}>
          <option value="">Choose a real scheme</option>
          {funds.map(f=><option key={f.schemeCode} value={f.schemeCode}
           disabled={!f.navOnlyRiskEligible}>
           {f.schemeCode} — {f.name}{f.navOnlyRiskEligible?'':' (NAV-only risk unavailable)'}</option>)}
         </select>
        </label>
       )}
       {selected&&(
        <div style={{display:'flex',gap:12,flexWrap:'wrap',marginTop:12,alignItems:'end'}}>
         <label style={{fontSize:12}}>Monthly SIP (₹)<input aria-label="Free NAV monthly SIP" style={{...style.field,display:'block',width:120}}
          inputMode="numeric" value={monthly} onChange={e=>{invalidateFinancialResult();setMonthly(e.target.value);}}/></label>
         <label style={{fontSize:12}}>Assumed annual return (%)<input aria-label="Free NAV assumed annual return" style={{...style.field,display:'block',width:120}}
          inputMode="decimal" value={expectedReturn} onChange={e=>{invalidateFinancialResult();setExpectedReturn(e.target.value);}}/></label>
         <label style={{fontSize:12}}>Years<input aria-label="Free NAV horizon years" style={{...style.field,display:'block',width:80}}
          inputMode="numeric" value={horizon} onChange={e=>{invalidateFinancialResult();setHorizon(e.target.value);}}/></label>
         <button type="button" style={style.action} disabled={busy} onClick={simulate}>
          Simulate with observed NAV volatility</button>
        </div>
       )}
       {showResult&&result.grossScenario&&(
        <div role="status" style={{marginTop:12}}>
         <strong>{result.asset?.name}</strong>
         <p>Latest NAV: ₹{Number(result.asset?.latestNav).toFixed(4)} ({result.asset?.navDate});
          observed annualized NAV volatility: {(result.calibration?.observedAnnualVolatility*100).toFixed(2)}%</p>
         <p>MFapi.in cross-check: <strong>{result.sourceChecks?.status||'NOT_VERIFIED'}</strong>.
          {result.sourceChecks?.status==='MATCHED_SAME_AMFI_SOURCE'
           ? ' NAV date and value match a second API serving the same AMFI publication.'
           : ' Two feeds have not independently confirmed the same dated NAV.'}
          {' '}Neither API certifies future returns or grants publisher redistribution rights.</p>
         <p>Illustrative pre-tax future value — 10th: {INR(result.grossScenario.p10?.at(-1))};
          median: {INR(result.grossScenario.p50?.at(-1))};
          90th: {INR(result.grossScenario.p90?.at(-1))}.</p>
         <p>Investment assumptions: {result.scenarioAssumptions?.monthlyContributionTiming==='BEGINNING_OF_MONTH'
           ? 'Monthly SIPs are invested at the beginning of each month, before simulated returns.'
           : 'Contribution timing was not qualified.'}
           {' '}Expected return: {typeof result.scenarioAssumptions?.annualExpectedReturn==='number'
             ? (result.scenarioAssumptions.annualExpectedReturn*100).toFixed(2)+'% annually (your assumption)'
             : 'Unavailable'}.
           {' '}Inflation: {typeof result.scenarioAssumptions?.annualInflationRate==='number'
             ? (result.scenarioAssumptions.annualInflationRate*100).toFixed(2)+'% assumed'
             : 'Unavailable'}.
         </p>
         <p>After-tax: <strong>Unavailable</strong>. Scheme-specific tax evidence and transactions
          are not verified. Fees, NAV distributions and future returns are not guaranteed or separately modeled.</p>
        </div>
       )}
       <p style={{fontSize:11,color:'#94a3b8',marginTop:10}}>
        Research provider used: {result?.source?.provider==='MFapi.in'
         ? <a href="https://www.mfapi.in/docs/" target="_blank" rel="noopener noreferrer">MFapi.in (fallback)</a>
         : <a href="https://mfnav.in/api-docs" target="_blank" rel="noopener noreferrer">mfnav.in</a>}.
        {' '}This is research-only data with no persistent storage and no implied rights to redistribute AMFI data.
       </p>
      </div>
     ):(
      <div>
       <p style={{fontSize:12,color:'#cbd5e1'}}>
        Read a dated Government of India small-savings interest-rate reference,
        then calculate supported gross contractual payouts. No tax exemption is inferred.
       </p>
       <button type="button" style={style.action} disabled={busy} onClick={loadRates}>
        Load public savings rates</button>
       {rates&&(
        <div style={{marginTop:10}}>
         <p role="status">Reference {rates.effectiveFrom} to {rates.effectiveTo};
          status: {rates.status}. Rates outside this period are not current.</p>
         <div style={{maxHeight:160,overflow:'auto',fontSize:12}}>
          {rates.rates?.map(r=><div key={r.id}>{r.name}: {r.annualRatePercent}% p.a.
           {' '}({r.compoundingBasis}){r.grossCashflowSupported?' — gross cash flows supported':''}
           {' · '}<a href={r.rateSourceUrl} target="_blank" rel="noopener noreferrer">
             Publisher reference</a></div>)}
         </div>
         <label style={{display:'block',fontSize:12,marginTop:10}}>Gross contractual example
          <select style={{...style.field,display:'block'}} aria-label="Choose savings cashflow product"
           value={productId} onChange={e=>{invalidateFinancialResult();setProductId(e.target.value);}}>
           {rates.rates?.filter(r=>r.grossCashflowSupported).map(r=>
            <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
         </label>
         <label style={{fontSize:12}}>Investment principal (₹){' '}
          <input style={style.field} aria-label="Small savings principal" inputMode="numeric"
           value={principal} onChange={e=>{invalidateFinancialResult();setPrincipal(e.target.value);}}/></label>{' '}
         <button type="button" style={style.action} disabled={busy} onClick={calculate}>
          Calculate gross cash flows</button>
        </div>
       )}
       {showResult&&result.cashflowLedger&&(
        <div role="status" style={{marginTop:12}}>
         <strong>{result.productName}</strong>
         <p>Principal: {INR(result.principal)}; nominal published rate {result.annualRatePercent}%;
          total contractual gross receipts: {INR(result.grossTotalProceeds)};
          gross interest: {INR(result.grossGain)}.</p>
         <p>Ledger: {result.cashflowLedger.status}, {result.cashflowLedger.events.length} payment events.
          <strong> After-tax proceeds: unavailable</strong> pending qualified tax facts.</p>
        </div>
       )}
       <p style={{fontSize:11,color:'#94a3b8',marginTop:10}}>
        Dated source: <a href="https://indianbank.bank.in/en/interest-rates-for-small-savings-schemes"
         target="_blank" rel="noreferrer">Indian Bank — Government small savings rates</a>.
        A reference rate is not a live renewal quote or permission to store provider data.
       </p>
      </div>
     )}
     <div style={{marginTop:16,borderTop:'1px solid #334155',paddingTop:10}}>
      <button type="button" style={style.action} disabled={busy} onClick={loadSources}
       aria-expanded={showSources}>{showSources?'Hide all sources':'See all supported and candidate free sources'}</button>
      {showSources&&directory&&(
       <div style={{marginTop:8,maxHeight:290,overflow:'auto',fontSize:12}}>
        <p>Research directory: {directory.count} providers or official references.
         Live production-qualified sources: {directory.productionQualifiedSourceCount}.
         Entries labelled reference-only are not connected calculation feeds.</p>
        {directory.sources.map(source=>(
         <div key={source.id} style={{padding:'7px 0',borderBottom:'1px solid #334155'}}>
          <a href={source.url} target="_blank" rel="noopener noreferrer">{source.name}</a>
          <div>{source.categories.join(', ')} · {source.mode.replaceAll('_',' ')}</div>
          <div style={{color:'#fbbf24'}}>Reuse status: {source.rightsStatus.replaceAll('_',' ')}</div>
         </div>
        ))}
       </div>
      )}
     </div>
     {busy&&<p role="status">Checking the selected financial source...</p>}
     {result?.status==='UNAVAILABLE'&&<p role="alert">
      Source or calculation unavailable: {result.reasonCode||result.postTaxReasonCode||'EVIDENCE_NOT_QUALIFIED'}.
      No replacement numbers were generated.</p>}
     {error&&<p role="alert">Data request failed: {error}. No financial results were substituted.</p>}
    </div>
   )}
  </section>
 );
}
