import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { investmentDatabase } from '../data/investmentDatabase.js';
import { REVIEWED_DISCOVERY_CORRECTIONS } from '../data/financialReferenceCorrections2026.js';

const { entries: extensions }=JSON.parse(readFileSync(
  new URL('../data/investmentUniverseExtensions2026.json',import.meta.url),'utf8',
));
const normalized=s=>s.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();

test('Indian investment discovery universe expands from 155 to 250 distinct catalog entries',()=>{
 assert.equal(investmentDatabase.length,155,'Preserve source master and original recommendation rules');
 assert.equal(extensions.length,95);
 assert.equal(investmentDatabase.length+extensions.length,250);
 const all=[...investmentDatabase,...extensions];
 assert.equal(new Set(all.map(e=>e.id)).size,250,'Canonical IDs are unique');
 assert.equal(new Set(all.map(e=>normalized(e.name))).size,250,'No duplicate entry names');
});
test('every extended investment is a source-referenced non-tradable catalog archetype',()=>{
 const categories=new Set(extensions.map(e=>e.category));
 assert.ok(categories.size>=8,'Include all essential investment families');
 for(const entry of extensions){
  assert.equal(entry.recordKind,'ARCHETYPE',entry.id);
  assert.equal(entry.availability,'UNVERIFIED',entry.id);
  assert.equal(entry.recommendationEligible,false,entry.id);
  assert.equal(entry.isActualPurchasableProduct,false,entry.id);
  assert.equal(entry.verificationScope,'REGULATORY_CATEGORY_OR_INDEX_ONLY',entry.id);
  assert.equal(entry.marketDataStatus,'UNAVAILABLE',entry.id);
  assert.equal(entry.postTaxStatus,'UNAVAILABLE',entry.id);
  assert.ok(entry.subCategory?.trim(),entry.id);
  assert.match(entry.sourceUrl,/^https:\/\//,entry.id);
 }
});

test('reviewed source corrections preserve family IDs and fail closed on actual product recommendations',()=>{
 assert.equal(Object.keys(REVIEWED_DISCOVERY_CORRECTIONS).length,28);
 const ids=new Set(extensions.map(e=>e.id));
 for(const [id,change] of Object.entries(REVIEWED_DISCOVERY_CORRECTIONS)){
  assert.ok(ids.has(id),id);
  const family=extensions.find(e=>e.id===id);
  assert.equal(family.name,change.currentName,id);
  assert.equal(family.sourceUrl,change.currentSourceUrl,id);
  assert.equal(new URL(family.sourceUrl).protocol,'https:',id);
  assert.equal(family.recommendationEligible,false,id);
  assert.equal(family.isActualPurchasableProduct,false,id);
  assert.equal(family.researchEvidence.actualIssuerOrSchemeVerified,false,id);
  assert.equal(family.dataRights.publicDisplay,false,id);
 }
});
