import { describe, expect, it } from 'vitest';
import { selectProfileCategoryMatches } from './profileCategoryMatches';

const profileId='64b000000000000000000001';
const candidate=(id,group,score,extra={})=>({
 canonicalParentId:id,name:'Option '+id,riskGroup:group,riskScore:group==='LOW'?2:group==='MODERATE'?3:4,
 suitabilityScope:'PROFILE_ELIGIBLE_PARENT_CATEGORY',
 productSpecificSuitability:'NOT_ESTABLISHED',
 shortlistSource:'ADDITIONAL_PROFILE_ELIGIBLE_CANDIDATE',
 rankScore:score,
 ...extra,
});
const result=()=>({
 status:'PROFILE_ELIGIBLE_PARENT_CATEGORIES',qualificationScope:'PARENT_CATEGORY_ONLY',
 source:{profileId,profileVersion:2},
 groups:{
  LOW:[candidate('a','LOW',80),candidate('b','LOW',40)],
  MODERATE:[candidate('c','MODERATE',95)],
  AGGRESSIVE:[candidate('d','AGGRESSIVE',72)],
 },
 selectedCount:4,discoveryArchetypesRecommendationEligible:false,
});
describe('ranked educational category matches from current financial profile',()=>{
 it('uses existing backend scores to select distinct top three across groups',()=>{
  expect(selectProfileCategoryMatches(result(),profileId,2).map(x=>x.id)).toEqual(['c','a','d']);
 });
 it('changes when a risk-eligible candidate is excluded by a different profile result',()=>{
  const changed=result();changed.groups.AGGRESSIVE=[];
  changed.groups.MODERATE[0].rankScore=35;changed.selectedCount=3;
  expect(selectProfileCategoryMatches(changed,profileId,2).map(x=>x.id)).toEqual(['a','b','c']);
 });
 it('rejects stale, unbound, duplicate or self-approved ranking input',()=>{
  expect(selectProfileCategoryMatches(result(),'64b000000000000000000002',2)).toEqual([]);
  expect(selectProfileCategoryMatches(result(),profileId,3)).toEqual([]);
  const duplicate=result();duplicate.groups.LOW.push(candidate('c','LOW',99));duplicate.selectedCount++;
  expect(selectProfileCategoryMatches(duplicate,profileId,2)).toEqual([]);
  const forged=result();forged.groups.MODERATE[0].productSpecificSuitability='VERIFIED';
  expect(selectProfileCategoryMatches(forged,profileId,2)).toEqual([]);
  const badCount=result();badCount.selectedCount=3;
  expect(selectProfileCategoryMatches(badCount,profileId,2)).toEqual([]);
  const noScore=result();noScore.groups.MODERATE[0].rankScore=NaN;
  expect(selectProfileCategoryMatches(noScore,profileId,2)).toEqual([]);
 });
});

describe('extension archetypes cannot become profile-ranked matches',()=>{
 it('rejects forged sovereign and bank extensions even with plausible category scores',()=>{
  const a=result();a.groups.LOW[0]=candidate('catalog_2026_gsec_coupon_strip','LOW',99);
  expect(selectProfileCategoryMatches(a,profileId,2)).toEqual([]);
  const b=result();b.groups.MODERATE[0]=candidate('catalog_2026_bank_tax_saver_fd','MODERATE',99);
  expect(selectProfileCategoryMatches(b,profileId,2)).toEqual([]);
 });
});
