import React, { useLayoutEffect, useRef, useState } from 'react';
import * as api from '../services/api';

const money=new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0});
/** Explicitly confirmed read-only comparisons; never parses money from speech. */
export default function SovereignSipComparison({ disabled=false,onClose }) {
  const [monthly,setMonthly]=useState('');
  const [years,setYears]=useState('');
  const [first,setFirst]=useState('');
  const [second,setSecond]=useState('');
  const [includeGoals,setIncludeGoals]=useState(false);
  const [previewedGoals,setPreviewedGoals]=useState(false);
  const [loading,setLoading]=useState(false);
  const [result,setResult]=useState(null);
  const [error,setError]=useState('');
  const active=useRef(null);
  const generation=useRef(0);
  // Any edited input invalidates the submitted scenario before an old result can render.
  const invalidateDraft=()=>{
    generation.current+=1;
    active.current?.abort();
    active.current=null;
    setLoading(false);
    setResult(null);
    setPreviewedGoals(false);
    setError('');
  };
  useLayoutEffect(()=>()=>{generation.current+=1;active.current?.abort();},[]);
  useLayoutEffect(()=>{
    if(disabled) {
      generation.current+=1;
      active.current?.abort();
      active.current=null;
      // Revoking access must discard private financial results AND release the
      // loading latch, otherwise re-enabling can expose stale account data or
      // leave the comparison permanently blocked by a cancelled request.
      setLoading(false);
      setResult(null);
      setPreviewedGoals(false);
      setError('');
    }
  },[disabled]);
  const hasInputs=monthly!=='' && years!=='' && first!=='' && second!=='' &&
    Number.isSafeInteger(Number(monthly)) && Number(monthly)>=100 && Number(monthly)<=10000000 &&
    Number.isSafeInteger(Number(years)) && Number(years)>=1 && Number(years)<=30 &&
    /^[0-9]+(?:\.[0-9]{1,3})?$/.test(first) &&
    Number.isFinite(Number(first)) && Number(first)>=0.1 && Number(first)<=30 &&
    /^[0-9]+(?:\.[0-9]{1,3})?$/.test(second) &&
    Number.isFinite(Number(second)) && Number(second)>=0.1 && Number(second)<=30 &&
    Number(first)!==Number(second);
  async function run(event) {
    event.preventDefault();
    if(disabled||loading||!hasInputs)return;
    active.current?.abort();
    const controller=new AbortController();
    const id=++generation.current;
    active.current=controller;
    setLoading(true);setError('');setResult(null);setPreviewedGoals(false);
    const scenarioInput={
      monthlyInvestment:Number(monthly),
      years:Number(years),
      annualReturnAssumptionsPct:[Number(first),Number(second)]
    };
    try {
      const response=includeGoals
        ? await api.previewSovereignTask({
          version:'sovereign-task-plan-v1',
          steps:[
            {id:'goals',operation:'APP_NAVIGATE',arguments:{page:'goals',tab:null},dependsOn:[]},
            {id:'compare',operation:'SIP_COMPARE_DRAFT',arguments:scenarioInput,dependsOn:['goals']}
          ]
        },{signal:controller.signal})
        : await api.compareVoiceSipScenarios(scenarioInput,{signal:controller.signal});
      if(id!==generation.current||controller.signal.aborted||disabled)return;
      let comparison=response;
      if(includeGoals) {
        const steps=response?.steps;
        const proposed=steps?.[0];
        const calculated=steps?.[1];
        if(response?.version!=='sovereign-task-preview-v1' ||
           response.classification!=='READ_ONLY_USER_REVIEWED_PREVIEW' ||
           response.persisted!==false ||
           response.navigationApplied!==false || response.financialStateModified!==false ||
           !Array.isArray(steps) || steps.length!==2 ||
           proposed?.id!=='goals' || proposed.kind!=='NAVIGATION_PROPOSAL' ||
           proposed.status!=='PREVIEWED' || proposed.page!=='goals' ||
           proposed.tab!==null || proposed.applied!==false ||
           calculated?.id!=='compare' || calculated.kind!=='FINANCIAL_COMPARISON' ||
           calculated.status!=='VERIFIED') {
          setError('Unverified task preview; no results were displayed.');
          return;
        }
        comparison=calculated.comparison;
      }
      const expectedInvested=Number(monthly)*Number(years)*12;
      const expectedRates=[Number(first),Number(second)];
      if(comparison?.version!=='sovereign-voice-sip-compare-v1' ||
         comparison.classification!=='UNSAVED_WHAT_IF_SIMULATION' ||
         comparison.persisted!==false ||
         typeof comparison.note!=='string' || !comparison.note.includes('hypothetical') ||
         !Array.isArray(comparison.scenarios) || comparison.scenarios.length!==2 ||
         comparison.scenarios.some((s,i)=>s?.returnBasis!=='USER_SUPPLIED_NOMINAL_ASSUMPTION' ||
           s.classification!=='NON_RECOMMENDATION_PROFILE_CONSTRAINED_WHAT_IF' ||
           s.monthlyInvestment!==Number(monthly) || s.years!==Number(years) ||
           !Number.isFinite(s.assumedAnnualReturnPct) ||
           Math.abs(s.assumedAnnualReturnPct-expectedRates[i])>1e-7 ||
           !Number.isSafeInteger(s.futureValue) || !Number.isSafeInteger(s.totalInvested) ||
           !Number.isSafeInteger(s.totalReturns) || s.futureValue<0 ||
           s.totalInvested!==expectedInvested ||
           s.totalReturns!==s.futureValue-s.totalInvested) ||
         !Number.isSafeInteger(comparison.differences?.futureValue) ||
         comparison.differences.futureValue!==comparison.scenarios[1].futureValue-comparison.scenarios[0].futureValue ||
         comparison.differences.invested!==0) {
        setError('Unverified comparison response; results were not displayed.');
        return;
      }
      setResult(comparison);
      setPreviewedGoals(includeGoals);
    } catch {
      if(id===generation.current&&!controller.signal.aborted)
        setError('Comparison unavailable. Check your profile and inputs, then retry.');
    } finally {
      if(active.current===controller)active.current=null;
      if(id===generation.current)setLoading(false);
    }
  }
  return (
    <section aria-label="SIP scenario comparison" className="sovereign-sip-comparison">
      <p><strong>Unsaved SIP what-if comparison</strong></p>
      <p>These are user-selected hypothetical annual return assumptions, not live product rates or guaranteed results. No investment will be purchased or goal saved.</p>
      <form onSubmit={run}>
        <label>Monthly SIP (₹)
          <input aria-label="Monthly SIP amount" inputMode="numeric" type="number" min="100" max="10000000" step="1"
            value={monthly} onChange={e=>{invalidateDraft();setMonthly(e.target.value);}} disabled={disabled||loading} />
        </label>
        <label>Years
          <input aria-label="SIP years" type="number" min="1" max="30" step="1"
            value={years} onChange={e=>{invalidateDraft();setYears(e.target.value);}} disabled={disabled||loading} />
        </label>
        <label>First assumed annual return (%)
          <input aria-label="First annual return assumption" type="number" min="0.1" max="30" step="0.001"
            value={first} onChange={e=>{invalidateDraft();setFirst(e.target.value);}} disabled={disabled||loading} />
        </label>
        <label>Second assumed annual return (%)
          <input aria-label="Second annual return assumption" type="number" min="0.1" max="30" step="0.001"
            value={second} onChange={e=>{invalidateDraft();setSecond(e.target.value);}} disabled={disabled||loading} />
        </label>
        <label className="sovereign-task-preview-option">
          <input type="checkbox" checked={includeGoals} disabled={disabled||loading}
            onChange={e=>{invalidateDraft();setIncludeGoals(e.target.checked);}}
            aria-label="Include Goals navigation proposal" />
          Also preview opening Goals (no navigation, no changes)
        </label>
        <button type="submit" disabled={disabled||loading||!hasInputs} aria-label="Run SIP comparison">
          {loading?'Comparing…':'Run SIP comparison'}
        </button>
        <button type="button" onClick={()=>{invalidateDraft();onClose?.();}}>Close</button>
      </form>
      {error&&<p role="alert">{error}</p>}
      {!disabled&&result&&(
        <div role="status">
          {previewedGoals&&<p>Goals page: proposed, not opened. The task did not save or modify anything.</p>}
          <p>{result.note}</p>
          <table>
            <caption>Verified deterministic, nominal, hypothetical SIP projections</caption>
            <thead><tr><th scope="col">Assumed annual return</th><th scope="col">Total invested</th>
              <th scope="col">Projected value</th></tr></thead>
            <tbody>{result.scenarios.map(s=>(
              <tr key={s.assumedAnnualReturnPct}>
                <td>{s.assumedAnnualReturnPct}%</td><td>{money.format(s.totalInvested)}</td>
                <td>{money.format(s.futureValue)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}
