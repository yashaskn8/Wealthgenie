import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {applySignedProviderEntitlement} from '../postgres/applySignedProviderEntitlement.js';

const {privateKey,publicKey}=generateKeyPairSync('ed25519');
const anchors=[{kid:'issuer-1',issuer:'market-data.example',
 endpointUrls:['https://market-data.example/quotes'],
 publicKeyPem:publicKey.export({type:'spki',format:'pem'})}];
const now=new Date('2026-10-28T10:30:00Z');
const permissions={access:true,extraction:true,storage:true,derivation:true,
 publicDisplay:false,commercialUse:false,redistribution:false};
const claims=(patch={})=>({
 version:1,action:'GRANT',issuer:'market-data.example',sourceId:'s1',
 endpointUrl:'https://market-data.example/quotes',grantId:'unique-grant-id-001',
 revision:1,issuedAt:'2026-10-28T10:00:00Z',notBefore:'2026-10-28T10:00:00Z',
 expiresAt:'2026-11-01T10:30:00Z',retentionSeconds:3600,permissions,...patch,
});
function receipt(c){
 const payload=Buffer.from(JSON.stringify(c)).toString('base64url');
 return{kid:'issuer-1',payload,
 signature:sign(null,Buffer.from('wealthgenie-provider-entitlement-v1.'+payload),
 privateKey).toString('base64url')};
}
function db(prior=null) {
 const calls=[];
 const client={async query(sql,args=[]){
  calls.push({sql,args});
  if(sql.includes('FOR UPDATE'))return{rows:prior?[prior]:[]};
  if(sql.startsWith('SELECT endpoint_url'))return{rows:prior?[{endpoint_url:prior.endpoint_url}]:[]};
  return {rows:[],rowCount:1};
 },release(){}};
 return{pool:{connect:async()=>client},calls};
}
test('authenticated document-free grant is stored with narrow real scopes',async()=>{
 const x=db();const result=await applySignedProviderEntitlement(x.pool,receipt(claims()),anchors,{now});
 assert.equal(result.status,'VERIFIED');assert.equal(result.documentAccessed,false);
 const insert=x.calls.find(x=>x.sql.includes('INSERT INTO finance.provider_rights'));
 assert.ok(insert);assert.ok(insert.args.includes(false));
 assert.ok(insert.args.some(x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x)));
 assert.ok(!x.calls.some(x=>JSON.stringify(x).includes('approvalDocumentPath')));
});
test('same or older signed revision cannot replay, even with a different grant ID',async()=>{
 const x=db({source_id:'s1',verification_state:'VERIFIED',verification_revision:1,
   verification_issuer:'market-data.example',endpoint_url:claims().endpointUrl});
 await assert.rejects(applySignedProviderEntitlement(x.pool,receipt(claims()),anchors,{now}),
  /PROVIDER_PERMISSION_REPLAY_OR_TERMINAL/);
 assert.ok(x.calls.some(x=>x.sql==='ROLLBACK'));
});
test('a terminal source cannot be reactivated by a newer grant',async()=>{
 const x=db({verification_state:'REVOKED',verification_revision:1,
 verification_issuer:'market-data.example'});
 await assert.rejects(applySignedProviderEntitlement(x.pool,receipt(claims({
 revision:2,grantId:'unique-grant-id-002'})),anchors,{now}),/PROVIDER_PERMISSION_REPLAY_OR_TERMINAL/);
});
test('only a provider-signed revocation can move a source to revoked in this API',async()=>{
 const revoked=claims({action:'REVOKE',grantId:'revocation-0002',revision:2,
  permissions:Object.fromEntries(Object.keys(permissions).map(k=>[k,false])),retentionSeconds:0});
 const x=db({verification_state:'VERIFIED',verification_revision:1,
  verification_issuer:'market-data.example'});
 const res=await applySignedProviderEntitlement(x.pool,receipt(revoked),anchors,{now});
 assert.equal(res.status,'REVOKED');
 const sql=x.calls.find(c=>c.sql.includes("verification_state='REVOKED'"));
 assert.ok(sql);assert.ok(sql.sql.includes('redistribution_allowed=false'));
});
test('a forged signature cannot run any SQL transaction',async()=>{
 const x=db();
 const original=receipt(claims()),forged={...original,signature:original.signature.slice(0,-2)+'AB'};
 await assert.rejects(applySignedProviderEntitlement(x.pool,forged,anchors,{now}),
  /PROVIDER_ENTITLEMENT_UNVERIFIED/);
 assert.equal(x.calls.length,0);
});
