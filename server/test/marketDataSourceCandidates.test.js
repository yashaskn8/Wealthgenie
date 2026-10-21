import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSourceRights, getPostTaxSourceRightsRegister } from '../services/postTaxSourceRights.js';
import { evaluateMarketDataProductionRights } from '../services/marketData/marketDataRights.js';

const candidates = [
  ['UPSTOX', 'https://api.upstox.com/v2/mf/holdings', 'UPSTOX_MF_HOLDINGS_USER_AUTHORIZED'],
  ['UPSTOX', 'https://api.upstox.com/v2/mf/orders', 'UPSTOX_MF_ORDERS_USER_AUTHORIZED'],
  ['NSI', 'https://www.nsiindia.gov.in/InternalPage.aspx?Id_Pk=132',
    'NSI_QUARTERLY_SMALL_SAVINGS_RATE_TABLE'],
];
test('newly researched data sources remain unlicensed and cannot enter production',()=>{
  for(const [provider,url,id] of candidates){
    const source=resolveSourceRights({provider,url});
    assert.equal(source.sourceId,id);
    assert.equal(source.status,'LICENSE_UNVERIFIED');
    assert.equal(source.productionPostTaxUseAllowed,false);
    assert.equal(evaluateMarketDataProductionRights(provider,url).productionUseAllowed,false);
    assert.deepEqual(source.approvedScopes,[]);
    for(const right of ['storage','publicDisplay','commercialUse','derivedCalculation'])
      assert.equal(source.rights[right],'LICENSE_UNVERIFIED');
  }
});
test('source URL, provider or query tampering cannot inherit candidate rights',()=>{
  for(const [provider,url] of candidates){
    const altered=new URL(url); altered.searchParams.set('unreviewed','1');
    assert.equal(resolveSourceRights({provider,url:altered.toString()}).sourceId,null);
    assert.equal(resolveSourceRights({provider:'UNKNOWN_PROVIDER',url}).sourceId,null);
    const fake=url.replace('https://','http://');
    assert.equal(resolveSourceRights({provider,url:fake}).sourceId,null);
  }
});
test('candidate sources are discoverable but not active production subscriptions',()=>{
  const items=getPostTaxSourceRightsRegister();
  for(const [, ,id] of candidates){
    const record=items.find(item=>item.sourceId===id);
    assert.ok(record,id);
    assert.equal(record.productionPostTaxUseAllowed,false);
  }
});
