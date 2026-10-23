import test from 'node:test';
import assert from 'node:assert/strict';
import {
 normalizeMfapiLatest,getMfapiLatest,reconcileFreeNavSources,
} from '../services/freeNavSecondaryVerification.js';
import {getFreeFinancialSourceDirectory} from '../services/freeFinancialSourceDirectory.js';

const code='100641';
const primary={
 status:'AVAILABLE',
 fund:{schemeCode:100641,isin:'INF200K01LJ4'},
 latestNavDate:'2026-10-21',latestNav:6460.4688,
};
const latest={
 status:'SUCCESS',
 meta:{scheme_code:100641,scheme_name:'SBI Ultra Short Term Fund - Regular Plan - Growth',
  isin_growth:'INF200K01LJ4'},
 data:[{date:'21-10-2026',nav:'6460.46880'}],
};

test('MFapi dates are parsed as DD-MM-YYYY and exact scheme identity is mandatory',()=>{
 const parsed=normalizeMfapiLatest(latest,code);
 assert.equal(parsed.status,'AVAILABLE');
 assert.equal(parsed.navDate,'2026-10-21');
 assert.equal(parsed.nav,6460.4688);
 assert.equal(normalizeMfapiLatest(latest,'100642').status,'NOT_VERIFIED');
 assert.equal(normalizeMfapiLatest({...latest,data:[{...latest.data[0],date:'31-02-2026'}]},code).status,'NOT_VERIFIED');
 assert.equal(normalizeMfapiLatest({...latest,data:[{...latest.data[0],nav:'Infinity'}]},code).status,'NOT_VERIFIED');
});

test('both no-key AMFI mirrors must agree on identity, NAV date and price',()=>{
 const secondary=normalizeMfapiLatest(latest,code);
 const ok=reconcileFreeNavSources(primary,secondary);
 assert.equal(ok.status,'MATCHED_SAME_AMFI_SOURCE');
 assert.equal(ok.independentUnderlyingFeed,false);
 assert.equal(ok.productionUseAllowed,false);
 assert.equal(reconcileFreeNavSources(primary,{...secondary,nav:6400}).reasonCode,
  'CROSS_SOURCE_NAV_VALUE_CONFLICT');
 assert.equal(reconcileFreeNavSources(primary,{...secondary,schemeCode:'100642'}).status,'CONFLICT');
 assert.equal(reconcileFreeNavSources(primary,{...secondary,isin:'INF111111111'}).status,'CONFLICT');
 assert.equal(reconcileFreeNavSources(primary,{...secondary,navDate:'2026-10-01'}).status,'CONFLICT');
 const sameWeekDifferentDay=reconcileFreeNavSources(primary,{...secondary,navDate:'2026-10-22'});
 assert.equal(sameWeekDifferentDay.status,'SINGLE_SOURCE');
 assert.equal(reconcileFreeNavSources(primary,{status:'NOT_VERIFIED'}).status,'SINGLE_SOURCE');
});

test('MFapi is pinned to a fixed HTTPS host and does not accept redirects',async()=>{
 const calls=[];
 const fetchImpl=async(url,params)=>{
  calls.push({url,params});
  return new Response(JSON.stringify(latest),{status:200,
   headers:{'content-type':'application/json'}});
 };
 const actual=await getMfapiLatest(code,{fetchImpl});
 assert.equal(actual.status,'AVAILABLE');
 assert.equal(calls.length,1);
 assert.equal(calls[0].url,'https://api.mfapi.in/mf/100641/latest');
 assert.equal(calls[0].params.redirect,'error');
 const bad=await getMfapiLatest(code,{fetchImpl:async()=>new Response('',{status:302})});
 assert.equal(bad.status,'NOT_VERIFIED');
 assert.equal(bad.reasonCode,'MFAPI_SOURCE_UNAVAILABLE');
 await assert.rejects(()=>getMfapiLatest('https://bad.host',{fetchImpl}),
  /INVALID_FUND_SCHEME_CODE/);
});

test('financial source directory cannot imply any production qualification',()=>{
 const out=getFreeFinancialSourceDirectory();
 assert.equal(out.count,19);
 assert.equal(out.sources.length,19);
 assert.equal(out.productionQualifiedSourceCount,0);
 assert.equal(out.verifiedLiveProviderResponses,false);
 assert.deepEqual(out.noKeyExternalResearchFeedsIntegrated,['MFNAV','MFAPI']);
 assert.equal(new Set(out.sources.map(x=>x.id)).size,out.count);
 assert.ok(out.sources.every(x=>x.automatedProductionDataEligible===false));
 assert.ok(out.sources.every(x=>new URL(x.url).protocol==='https:'));
 assert.equal(out.sources.find(x=>x.id==='NSE_DATA').rightsStatus,'COMMERCIAL_REUSE_RESTRICTED');
 assert.equal(out.sources.find(x=>x.id==='OGD_INDIA').rightsStatus,
  'OGDL_APPLIES_TO_COVERED_DATASETS_ONLY');
});
