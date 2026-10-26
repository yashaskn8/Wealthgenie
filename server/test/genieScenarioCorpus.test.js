import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { classifyVoiceIntent } from '../services/voiceIntentPolicy.js';
import { retrieveIndicSipScenarioEvidence } from '../services/indicSipScenarioEvidence.js';
import { classifyGenieChatQuestion } from '../services/chatQuestionRouting.js';
import { isGeneralChatQuestion } from '../services/generalChatService.js';
import { suggestWealthGenieFeature } from '../services/featureSuggestionPolicy.js';
import { retrieveIndicFinancialEducation } from '../services/indicFinancialEducation.js';
import { PAGE_ALLOWLIST } from '../../reactapp/src/utils/navigationMap.js';

const location = fileURLToPath(new URL('./fixtures/genieScenarioCorpus.json', import.meta.url));
const corpus = JSON.parse(readFileSync(location, 'utf8'));
const named = new Set();
const EXPECTED_KINDS = new Set(['scenario','no-scenario','navigate','reject','comparison',
  'chat','financial','general','feature','no-feature','education','no-education']);
function assertCase({id,question,expected}) {
  assert.ok(typeof id === 'string' && id.length>4);
  assert.ok(!named.has(id), 'duplicate fixture id: '+id);
  named.add(id);
  assert.ok(typeof question==='string' && question.length>0);
  assert.ok(EXPECTED_KINDS.has(expected.kind));
  switch (expected.kind) {
    case 'scenario': {
      const evidence=retrieveIndicSipScenarioEvidence(question);
      assert.equal(evidence.length,1,id);
      assert.equal(evidence[0].id,expected.id,id);
      if(expected.id==='E_SIP_INFLATION_SCENARIO'){
        assert.ok(Number.isFinite(evidence[0].value.projectedNominal),id);
        assert.equal(evidence[0].value.illustrativeOnly,true,id);
      } else {
        assert.equal(evidence[0].value.calculationPerformed,false,id);
      }
      break;
    }
    case 'no-scenario':
      assert.deepEqual(retrieveIndicSipScenarioEvidence(question),[],id);
      break;
    case 'navigate': {
      const result=classifyVoiceIntent(question);
      assert.equal(result.action,'APP_NAVIGATE',id);
      assert.equal(result.page,expected.page,id);
      assert.ok(PAGE_ALLOWLIST.includes(result.page),id);
      assert.equal(result.tab,null,id);
      break;
    }
    case 'reject':
      assert.equal(classifyVoiceIntent(question).action,'REJECTED',id);
      break;
    case 'comparison':
      assert.equal(classifyVoiceIntent(question).action,'OPEN_SIP_COMPARISON',id);
      break;
    case 'chat':
      assert.equal(classifyVoiceIntent(question).action,'CHAT',id);
      break;
    case 'financial':
      assert.equal(classifyGenieChatQuestion(question),'FINANCIAL_GROUNDED',id);
      assert.equal(isGeneralChatQuestion(question),false,id);
      break;
    case 'general':
      assert.equal(classifyGenieChatQuestion(question),'GENERAL_UNCITED',id);
      assert.equal(isGeneralChatQuestion(question),true,id);
      break;
    case 'feature': {
      const cards=suggestWealthGenieFeature(question);
      assert.equal(cards.length,1,id);
      assert.equal(cards[0].page,expected.page,id);
      assert.equal(cards[0].requiresUserClick,true,id);
      assert.ok(PAGE_ALLOWLIST.includes(cards[0].page),id);
      break;
    }
    case 'no-feature':
      assert.deepEqual(suggestWealthGenieFeature(question),[],id);
      break;
    case 'education':
      assert.equal(retrieveIndicFinancialEducation(question)[0]?.id,expected.id,id);
      break;
    case 'no-education':
      assert.deepEqual(retrieveIndicFinancialEducation(question),[],id);
      break;
    default: throw Error('Unexpected fixture kind');
  }
}

describe('GenieVoice multilingual scenario evaluation corpus',()=>{
  it('has a stable version, unique ids and substantive coverage',()=>{
    assert.equal(corpus.version,'genie-scenarios-v1');
    assert.ok(corpus.scenarios.length>=75,'must maintain broad evaluation coverage');
    const counts=Object.groupBy(corpus.scenarios,item=>item.expected.kind);
    for(const kind of EXPECTED_KINDS)assert.ok(counts[kind]?.length,kind);
  });
  for(const scenario of corpus.scenarios)
    it(scenario.id,()=>assertCase(scenario));
});
