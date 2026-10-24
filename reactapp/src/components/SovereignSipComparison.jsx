import React, { useEffect, useRef, useState } from 'react';
import * as api from '../services/api';

const money=new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0});
/** Explicitly confirmed read-only comparisons; never parses money from speech. */
export default function SovereignSipComparison({ disabled=false,onClose }) {
  const [monthly,setMonthly]=useState('');
  const [years,setYears]=useState('');
  const [first,setFirst]=useState('');
  const [second,setSecond]=useState('');
  const [loading,setLoading]=useState(false);
  const [result,setResult]=useState(null);
  const [error,setError]=useState('');
  const active=useRef(null);
  const generation=useRef(0);
  useEffect(()=>()=>{generation.current+=1;active.current?.abort();},[]);
  const hasInputs=monthly!=='' && years!=='' && first!=='' && second!=='' &&
    Number.isSafeInteger(Number(monthly)) && Number(monthly)>=100 &&
    Number.isSafeInteger(Number(years)) && Number(years)>=1 && Number(years)<=30 &&
    Number.isFinite(Number(first)) && Number(first)>=0.1 && Number(first)<=30 &&
    Number.isFinite(Number(second)) && Number(second)>=0.1 && Number(second)<=30 &&
    Number(first)!==Number(second);
  async function run(event) {
    event.preventDefault();
    if(disabled||loading||!hasInputs)return;
    active.current?.abort();
    const controller=new AbortController();
    const id=++generation.current;
    active.current=controller;
    setLoading(true);setError('');setResult(null);
    try {
      const response=await api.compareVoiceSipScenarios({
        monthlyInvestment:Number(monthly),
        years:Number(years),
        annualReturnAssumptionsPct:[Number(first),Number(second)]
      },{signal:controller.signal});
      if(id!==generation.current||controller.signal.aborted)return;
      if(response?.version!=='sovereign-voice-sip-compare-v1' ||
         response.classification!=='UNSAVED_WHAT_IF_SIMULATION' ||
         response.persisted!==false || !Array.isArray(response.scenarios) ||
         response.scenarios.length!==2 ||
         response.scenarios.some(s=>s?.returnBasis!=='USER_SUPPLIED_NOMINAL_ASSUMPTION' ||
           !Number.isFinite(s.futureValue)||!Number.isFinite(s.totalInvested))) {
        setError('Unverified comparison response; results were not displayed.');
        return;
      }
      setResult(response);
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
            value={monthly} onChange={e=>{setMonthly(e.target.value);setResult(null);}} disabled={disabled||loading} />
        </label>
        <label>Years
          <input aria-label="SIP years" type="number" min="1" max="30" step="1"
            value={years} onChange={e=>{setYears(e.target.value);setResult(null);}} disabled={disabled||loading} />
        </label>
        <label>First assumed annual return (%)
          <input aria-label="First annual return assumption" type="number" min="0.1" max="30" step="0.1"
            value={first} onChange={e=>{setFirst(e.target.value);setResult(null);}} disabled={disabled||loading} />
        </label>
        <label>Second assumed annual return (%)
          <input aria-label="Second annual return assumption" type="number" min="0.1" max="30" step="0.1"
            value={second} onChange={e=>{setSecond(e.target.value);setResult(null);}} disabled={disabled||loading} />
        </label>
        <button type="submit" disabled={disabled||loading||!hasInputs} aria-label="Run SIP comparison">
          {loading?'Comparing…':'Run SIP comparison'}
        </button>
        <button type="button" onClick={onClose}>Close</button>
      </form>
      {error&&<p role="alert">{error}</p>}
      {result&&(
        <div role="status">
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
