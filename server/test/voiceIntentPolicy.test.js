import { describe,it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyVoiceIntent,VOICE_INTENT_VERSION } from '../services/voiceIntentPolicy.js';
import { PAGE_ALLOWLIST } from '../../reactapp/src/utils/navigationMap.js';

describe('Sovereign X fail-closed voice policy',()=>{
  it('navigates only canonical pages',()=>{
    assert.deepEqual(classifyVoiceIntent('Please open my goals'),{action:'APP_NAVIGATE',page:'goals',tab:null,version:VOICE_INTENT_VERSION});
    assert.equal(classifyVoiceIntent('navigate to tax analysis screen').page,'taxes');
    assert.equal(classifyVoiceIntent('take me to grow my sip page').page,'grow-my-sip');
    assert.equal(classifyVoiceIntent('show where to invest').page,'investments');
  });
  it('keeps every proposed destination inside the real React page allowlist',()=>{
    for(const input of ['open goals','open taxes','show investments','open profile','go to progress','show help','open rebalancer']) {
      const result=classifyVoiceIntent(input);
      assert.equal(result.action,'APP_NAVIGATE',input);
      assert.ok(PAGE_ALLOWLIST.includes(result.page),input);
    }
  });
  it('can open the explicitly reviewed SIP comparison panel, never execute a projection from audio',()=>{
    assert.deepEqual(classifyVoiceIntent('open sip comparison'),{
      action:'OPEN_SIP_COMPARISON',version:VOICE_INTENT_VERSION
    });
    assert.notEqual(classifyVoiceIntent('open sip comparison and assume 15%').action,'OPEN_SIP_COMPARISON');
  });
  it('does not recognize compound commands',()=>{
    for(const input of ['open goals and investments','open /admin','open my account and update it','open genieproof','goals','explain SIP']){
      assert.notEqual(classifyVoiceIntent(input).action,'APP_NAVIGATE',input);
    }
  });
  it('denies external websites, URLs and mutating operations',()=>{
    for(const input of ['open google','open https://evil.example','open my goals and delete them','open account and transfer money','open website','navigate to profile and change my risk','show my goals; approve purchase']){
      assert.equal(classifyVoiceIntent(input).action,'REJECTED',input);
    }
  });
  it('rejects control characters, long payloads and invalid types',()=>{
    for(const input of ['', ' ', 'open\u0000goals','x'.repeat(1001),null,{},[]]){
      assert.equal(classifyVoiceIntent(input).action,'REJECTED');
    }
  });
});
