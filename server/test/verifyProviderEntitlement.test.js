import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { verifyProviderEntitlement } from '../postgres/verifyProviderEntitlement.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const anchor = [{
  kid:'provider-live-2026', issuer:'provider.example',
  endpointUrls:['https://data.provider.example/retail-feed'],
  publicKeyPem:publicKey.export({ type:'spki', format:'pem' }),
}];
const now = new Date('2026-10-28T11:00:00Z');
const claims = () => ({
  version:1, action:'GRANT', issuer:'provider.example', sourceId:'debt-feed-v1',
  endpointUrl:'https://data.provider.example/retail-feed',
  grantId:'provider-grant-0001', revision:1,
  issuedAt:'2026-10-28T10:00:00Z', notBefore:'2026-10-28T10:00:00Z',
  expiresAt:'2026-11-20T10:00:00Z', retentionSeconds:86400,
  permissions:{
    access:true,extraction:true,storage:true,derivation:true,
    publicDisplay:false,commercialUse:false,redistribution:false,
  },
});
const signed = value => {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  const signature = sign(null, Buffer.from('wealthgenie-provider-entitlement-v1.'+payload),
    privateKey).toString('base64url');
  return {kid:anchor[0].kid,payload,signature};
};
test('authentic independent provider signature binds exact endpoint, expiry and scopes',()=>{
  const verified=verifyProviderEntitlement(signed(claims()),anchor,{now});
  assert.equal(verified.permissionState,'VERIFIED');
  assert.equal(verified.permissions.commercialUse,false);
  assert.equal(verified.sourceId,'debt-feed-v1');
  assert.match(verified.receiptSha256,/^[a-f0-9]{64}$/);
});
test('untrusted keys, tampered scope, wrong source, stale receipt and future dates fail closed',()=>{
  const raw=signed(claims());
  const mut = JSON.parse(Buffer.from(raw.payload,'base64url').toString('utf8'));
  mut.permissions.commercialUse=true;
  for(const [receipt,anchors,clock] of [
    [{...raw,payload:Buffer.from(JSON.stringify(mut)).toString('base64url')},anchor,now],
    [raw,[],now],
    [raw,[{...anchor[0],issuer:'other-provider'}],now],
    [signed({...claims(),endpointUrl:'https://unapproved.example/feed'}),anchor,now],
    [signed({...claims(),expiresAt:'2026-10-28T10:30:00Z'}),anchor,now],
    [raw,anchor,new Date('2026-12-01T10:00:00Z')],
    [signed({...claims(),issuedAt:'2026-11-01T10:00:00Z'}),anchor,now],
    [signed({...claims(),retentionSeconds:999999999}),anchor,now],
  ])assert.throws(()=>verifyProviderEntitlement(receipt,anchors,{now:clock}),/PROVIDER_ENTITLEMENT_UNVERIFIED/);
});
test('signed revocation cannot carry active rights or retention',()=>{
  const v={...claims(),action:'REVOKE',permissions:Object.fromEntries(
    Object.keys(claims().permissions).map(k=>[k,false])),retentionSeconds:0};
  assert.equal(verifyProviderEntitlement(signed(v),anchor,{now}).permissionState,'REVOKED');
  assert.throws(()=>verifyProviderEntitlement(signed({...v,permissions:claims().permissions}),anchor,{now}),
    /PROVIDER_ENTITLEMENT_UNVERIFIED/);
});
