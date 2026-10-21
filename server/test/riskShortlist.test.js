import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRiskShortlist} from '../services/riskShortlist.js';
import {canonicalProfile} from './helpers/canonicalProfile.js';
test('risk shortlist stays within authoritative allocation and never fills nonexistent categories',()=>{
 const result=buildRiskShortlist({profile:canonicalProfile(),instruments:[
  {id:'ppf'}, {id:'ppf'}, {id:'totally-nonexistent'}, {id:'sbi_fd'},
 ]});
 assert.ok(result.selectedCount<=2);
 assert.ok(result.selectedCount<=15);
 assert.equal(result.maxPerGroup,5);
 assert.equal(result.notFilledWithUnsuitableInstruments,true);
 for(const group of Object.values(result.groups)){
  assert.ok(group.length<=5);
  for(const pick of group)assert.equal(pick.productSpecificSuitability,'NOT_ESTABLISHED');
 }
});
