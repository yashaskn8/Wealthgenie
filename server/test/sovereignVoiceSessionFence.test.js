import { describe,it } from 'node:test';
import assert from 'node:assert/strict';
import { assertSovereignVoiceSessionCurrent } from '../services/sovereignVoiceSessionFence.js';
const token=()=>({userId:'60d5ecb8b3b3a72d9c8e4a11',jti:'voice-test',
  exp:Math.floor(Date.now()/1000)+60});
const options={isDatabaseReady:()=>true,loadAccount:async()=>({role:'user'}),
  checkRevocation:async()=>false};
describe('GenieVoice final session publication fence',()=>{
  it('allows a still-active authenticated session',async()=>{
    await assertSovereignVoiceSessionCurrent(token(),options);
  });
  it('fails closed on logout and account deletion',async()=>{
    await assert.rejects(()=>assertSovereignVoiceSessionCurrent(token(),{
      ...options,checkRevocation:async()=>true
    }),{code:'VOICE_SESSION_REVOKED'});
    await assert.rejects(()=>assertSovereignVoiceSessionCurrent(token(),{
      ...options,loadAccount:async()=>null
    }),{code:'VOICE_SESSION_REVOKED'});
  });
  it('fails closed if the revocation store or account database is unavailable',async()=>{
    await assert.rejects(()=>assertSovereignVoiceSessionCurrent(token(),{
      ...options,isDatabaseReady:()=>false
    }),{code:'VOICE_SESSION_STATE_UNAVAILABLE'});
    await assert.rejects(()=>assertSovereignVoiceSessionCurrent(token(),{
      ...options,checkRevocation:async()=>{throw new Error('Redis down');}
    }),{code:'VOICE_SESSION_STATE_UNAVAILABLE'});
    await assert.rejects(()=>assertSovereignVoiceSessionCurrent(token(),{
      ...options,loadAccount:async()=>{throw new Error('Mongo down');}
    }),{code:'VOICE_SESSION_STATE_UNAVAILABLE'});
  });
  it('fails closed within a bounded deadline if account or revocation lookups stall',async()=>{
    await assert.rejects(()=>assertSovereignVoiceSessionCurrent(token(),{
      ...options,timeoutMs:15,checkRevocation:()=>new Promise(()=>{})
    }),{code:'VOICE_SESSION_STATE_UNAVAILABLE'});
  });
  it('rejects an aborted request while revocation validation is pending',async()=>{
    const controller=new AbortController();
    const work=assertSovereignVoiceSessionCurrent(token(),{
      ...options,signal:controller.signal,loadAccount:()=>new Promise(()=>{})
    });
    controller.abort();
    await assert.rejects(work,{code:'VOICE_SESSION_REVOKED'});
  });
  it('rejects tokens that expire while lookups run',async()=>{
    const expiring=token();
    expiring.exp=Math.floor(Date.now()/1000)+1;
    await assert.rejects(()=>assertSovereignVoiceSessionCurrent(expiring,{
      ...options,now:()=>expiring.exp*1000
    }),{code:'VOICE_SESSION_REVOKED'});
  });
});
