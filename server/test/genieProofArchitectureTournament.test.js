import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessArchitecture, runGenieProofArchitectureTournament,
  EVIDENCE_BACKBONES, DATA_LIFECYCLES, EXPERIENCE_MODELS,
} from '../agents/genieProof/genieProofArchitectureTournament.js';

test('1,000 reproducible combinations battle through mandatory production gates', () => {
  assert.equal(EVIDENCE_BACKBONES.length,10);
  assert.equal(DATA_LIFECYCLES.length,10);
  assert.equal(EXPERIENCE_MODELS.length,10);
  const result=runGenieProofArchitectureTournament();
  assert.equal(result.generatedArchitectures,1000);
  assert.equal(result.qualifiedArchitectures,100);
  assert.equal(result.rejectedArchitectures,900);
  assert.equal(result.finalists.length,10);
  assert.equal(result.winner.id,
    'signed_attested_rules::ephemeral_minimal_no_account_record::scope_first_reason_coded_triage');
  assert.equal(result.winner.score,98.5);
  assert.ok(Object.values(result.winner.gate).every(Boolean));
  assert.equal(result.scoringBasis,'DECLARED_ORDINAL_ENGINEERING_HEURISTICS_NOT_EMPIRICAL_BENCHMARK');
  assert.deepEqual(result, runGenieProofArchitectureTournament());
});
test('all design permutations that lack any one critical control are disqualified', () => {
  for (const backbone of EVIDENCE_BACKBONES) {
    for (const lifecycle of DATA_LIFECYCLES) {
      for (const experience of EXPERIENCE_MODELS) {
        const output=assessArchitecture(backbone,lifecycle,experience);
        const all=Object.values(output.gate).every(Boolean);
        assert.equal(output.qualified, all);
        assert.equal(output.qualified,output.score!==null);
        if (output.score!==null) assert.ok(output.score>=0 && output.score<=100);
      }
    }
  }
  assert.ok(!assessArchitecture(EVIDENCE_BACKBONES[5],DATA_LIFECYCLES[0],EXPERIENCE_MODELS[0]).qualified,
    'An LLM cannot be the final evidentiary judge');
  assert.ok(!assessArchitecture(EVIDENCE_BACKBONES[0],DATA_LIFECYCLES[5],EXPERIENCE_MODELS[0]).qualified,
    'Unconsented raw text persistence cannot qualify');
  assert.ok(!assessArchitecture(EVIDENCE_BACKBONES[0],DATA_LIFECYCLES[0],EXPERIENCE_MODELS[5]).qualified,
    'An opaque positive badge cannot hide abstention');
});
test('forged tuning and missing rights can never win through higher numerical scores', () => {
  const safe=EVIDENCE_BACKBONES[0], privateData=DATA_LIFECYCLES[0], clearUx=EXPERIENCE_MODELS[0];
  const attacks=[
    [{...safe,rights:false},privateData,clearUx],
    [{...safe,signatures:false},privateData,clearUx],
    [{...safe,freshness:false},privateData,clearUx],
    [{...safe,abstains:false},privateData,clearUx],
    [{...safe,aiVerdict:true},privateData,clearUx],
    [safe,{...privateData,consentBound:false},clearUx],
    [safe,{...privateData,dataMinimized:false},clearUx],
    [safe,privateData,{...clearUx,aiChangesVerdict:true}],
    [safe,privateData,{...clearUx,distinguishesAbstention:false}],
  ];
  for(const [b,d,e] of attacks) {
    const selected=assessArchitecture({...b,safety:1000000},{...d,privacy:1000000},{...e,clarity:1000000});
    assert.equal(selected.qualified,false);
    assert.equal(selected.score,null);
  }
});
