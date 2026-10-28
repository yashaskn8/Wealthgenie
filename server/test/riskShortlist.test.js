import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRiskShortlist, RISK_SHORTLIST_POLICY_VERSION } from '../services/riskShortlist.js';
import { runPipeline } from '../services/RecommendationPipeline.js';
import { investmentDatabase } from '../data/investmentDatabase.js';
import { canonicalProfile } from './helpers/canonicalProfile.js';

test('Top 5 risk categories use the same eligibility and ranking policy as current recommendations',()=>{
  const profile=canonicalProfile();
  const recommendation=runPipeline(profile);
  const a=buildRiskShortlist({profile,instruments:recommendation.instruments});
  const b=buildRiskShortlist({profile,instruments:recommendation.instruments});
  assert.deepEqual(a,b,'Scores and order must be deterministic for the same profile');
  assert.equal(a.shortlistPolicyVersion,RISK_SHORTLIST_POLICY_VERSION);
  assert.ok(a.selectedCount>0 && a.selectedCount<=15);
  assert.equal(a.maxPerGroup,5);
  assert.equal(a.catalogCoverage.totalCategories,250);
  assert.equal(a.catalogCoverage.modelEvaluatedLegacyCategories,155);
  assert.equal(a.catalogCoverage.extensionCategoriesMissingSuitabilityEvidence,95);
  assert.equal(a.catalogCoverage.legacyProfileEligibleCount+a.catalogCoverage.legacyProfileExcludedCount,155);
  assert.equal(a.catalogCoverage.productApprovedByCatalog,0);
  assert.equal(a.catalogCoverage.assessmentScope,'CATEGORY_SCREENING_NOT_PRODUCT_RECOMMENDATION');
  assert.equal(a.catalogAssessments.length,250);
  assert.equal(new Set(a.catalogAssessments.map(x=>x.id)).size,250);
  assert.equal(a.catalogAssessments.filter(x=>x.source==='EXISTING_155_MODEL').length,155);
  const extra=a.catalogAssessments.filter(x=>x.source==='EXTENDED_95_DISCOVERY');
  assert.equal(extra.length,95);
  assert.ok(extra.every(x=>x.profileAssessment==='MISSING_SUITABILITY_EVIDENCE'
    && x.scoreAvailable===false && x.productQualified===false
    && x.reasonCode==='UNVERIFIED_CATEGORY_RISK_ELIGIBILITY_AND_TERMS'));
  assert.ok(a.catalogAssessments.filter(x=>x.profileAssessment==='PROFILE_EXCLUDED_CATEGORY')
    .every(x=>typeof x.reasonCode==='string' && !x.scoreAvailable));
  assert.ok(a.catalogAssessments.filter(x=>x.profileAssessment==='PROFILE_ELIGIBLE_CATEGORY')
    .every(x=>x.reasonCode===null && x.scoreAvailable));
  assert.equal(a.notFilledWithUnsuitableInstruments,true);
  const parentIds=new Set(investmentDatabase.map(e=>e.id));
  const ids=new Set();
  for(const [group,picks] of Object.entries(a.groups)){
    assert.ok(picks.length<=5,group);
    for(const item of picks){
      assert.ok(parentIds.has(item.canonicalParentId),item.canonicalParentId);
      assert.ok(!item.canonicalParentId.startsWith('catalog_2026_'));
      assert.ok(!ids.has(item.canonicalParentId));
      ids.add(item.canonicalParentId);
      assert.equal(item.productSpecificSuitability,'NOT_ESTABLISHED');
      assert.equal(item.suitabilityScope,'PROFILE_ELIGIBLE_PARENT_CATEGORY');
      assert.ok(item.rankScore>=0 && item.rankScore<=100);
      assert.ok(['CURRENT_SAVED_ALLOCATION','ADDITIONAL_PROFILE_ELIGIBLE_CANDIDATE']
        .includes(item.shortlistSource));
      assert.equal(item.riskGroup,group);
      assert.ok(item.riskScore<=a.suitabilityLevel);
    }
  }
});
test('conservative profile cannot be served moderate/high products solely to fill quotas',()=>{
  const profile=canonicalProfile({riskTolerance:'Conservative'});
  const recommended=runPipeline(profile);
  const shortlist=buildRiskShortlist({profile,instruments:recommended.instruments});
  assert.equal(shortlist.groups.AGGRESSIVE.length,0);
  assert.ok(shortlist.groups.LOW.length<=5);
});
test('mismatched, duplicate, or forged saved allocation fails closed',()=>{
  const profile=canonicalProfile();
  const recommended=runPipeline(profile).instruments;
  assert.throws(()=>buildRiskShortlist({profile,instruments:[{id:'catalog_2026_nps_lc75'}]}),
    /unsupported catalog identity/);
  assert.throws(()=>buildRiskShortlist({profile,instruments:[recommended[0],recommended[0]]}),
    /Duplicate instrument/);
  assert.throws(()=>buildRiskShortlist({profile,instruments:[]}),/empty/);
});
