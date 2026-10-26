import { describe, expect, it } from 'vitest';
import { normalizeFeatureCard, SAFE_FEATURE_LABELS } from '../featureNavigationCard';

const sample={
  version:'genie-feature-card-v1',
  kind:'FEATURE_NAVIGATION_SUGGESTION',
  page:'grow-my-sip',
  tab:null,
  label:'source label',
  description:'source description',
  requiresUserClick:true,
};
describe('Feature navigation UI policy',()=>{
  it('always renders canonical local labels',()=>{
    expect(normalizeFeatureCard(sample)).toEqual({
      page:'grow-my-sip',tab:null,label:SAFE_FEATURE_LABELS['grow-my-sip']
    });
  });
  it('declines unrecognized pages and unsupported card formats',()=>{
    for(const candidate of [
      {...sample,page:'nonexistent'},
      {...sample,page:'genieproof'},
      {...sample,tab:'rebalancer'},
      {...sample,requiresUserClick:false},
      {...sample,version:'old-version'},
      {...sample,kind:'OTHER'},
      null,
      ['goals'],
    ]) expect(normalizeFeatureCard(candidate)).toBeNull();
  });
});
