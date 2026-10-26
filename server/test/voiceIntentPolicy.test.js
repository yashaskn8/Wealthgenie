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
    for(const input of ['', ' ', 'open\u0000goals','open\ngoals',
      'open\rgoals','open\tgoals','open goals\n',
      'open\nsip comparison','open\u2028goals','open\u2029goals',
      'open\u200Bgoals','open goals\uFEFF','x'.repeat(1001),null,{},[]]){
      assert.equal(classifyVoiceIntent(input).action,'REJECTED');
    }
  });
  it('accepts conversational invocations without extending the action allowlist',()=>{
    for (const input of ['Hey Genie, open my goals','Genie, bring up my profile',
      'could you please show investment options','can you navigate to the taxes page']) {
      assert.equal(classifyVoiceIntent(input).action,'APP_NAVIGATE',input);
    }
    assert.equal(classifyVoiceIntent('Hey Genie, what is SIP?').action,'CHAT');
    assert.equal(classifyVoiceIntent('Genie, open a random route').reason,'UNSUPPORTED_NAVIGATION');
    assert.equal(classifyVoiceIntent('Hey Genie, open my account and transfer money').action,'REJECTED');
  });

  it('answers educational finance questions without granting transaction powers',()=>{
    for (const question of [
      'How does buying a mutual fund work?',
      'What happens if I sell my shares?',
      'Could you explain rebalancing my portfolio?',
      'Why does a withdrawal change the investment projection?',
    ]) {
      const response=classifyVoiceIntent(question);
      assert.equal(response.action,'CHAT',question);
    }
    for (const command of [
      'Could you transfer my money?',
      'Can you please buy shares?',
      'How do I send money to https://bad.example',
      'Tell me about buying; execute trade',
    ]) {
      assert.equal(classifyVoiceIntent(command).action,'REJECTED',command);
    }
  });

});
