import 'dotenv/config';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { investmentDatabase } from '../data/investmentDatabase.js';

const extensionManifest = JSON.parse(
  readFileSync(new URL('../data/investmentUniverseExtensions2026.json', import.meta.url), 'utf8'),
);
if (!process.env.FINANCIAL_POSTGRES_URL) throw new Error('FINANCIAL_POSTGRES_URL_REQUIRED');
const { Pool } = await import('pg');
const pool = new Pool({
  connectionString:process.env.FINANCIAL_POSTGRES_URL,max:1,connectionTimeoutMillis:5000,
});
function slug(label) {
  const normalized = label.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,55)||'category';
  return normalized+'-'+crypto.createHash('sha256').update(label).digest('hex').slice(0,8);
}
function normalizedName(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
}
const entries = [
  ...investmentDatabase.map(entry => ({
    id:entry.id,name:entry.name,category:entry.category,subCategory:entry.subCategory || null,
    referenceUrl:null,verificationScope:'UNVERIFIED',assessedAsOf:null,discoveryMetadata:null,
  })),
  ...extensionManifest.entries.map(entry => ({
    id:entry.id,name:entry.name,category:entry.category,subCategory:entry.subCategory,
    referenceUrl:entry.sourceUrl,verificationScope:entry.verificationScope,
    assessedAsOf:extensionManifest.reviewedAsOf,
    recordKind:entry.recordKind,recommendationEligible:entry.recommendationEligible,
    availability:entry.availability,marketDataStatus:entry.marketDataStatus,
    postTaxStatus:entry.postTaxStatus,
    discoveryMetadata:{instrumentForm:entry.instrumentForm,researchEvidence:entry.researchEvidence,
      productIdentity:entry.productIdentity,productFacts:entry.productFacts,
      riskAndSuitability:entry.riskAndSuitability,taxAndCalculations:entry.taxAndCalculations,
      dataRights:entry.dataRights,investorWarnings:entry.investorWarnings}, 
  })),
];
if (!Array.isArray(extensionManifest.entries) || extensionManifest.entries.length < 1) {
  throw new Error('EXPANDED_INVESTMENT_UNIVERSE_MISSING');
}
if (entries.length < 250) throw new Error('INVESTMENT_UNIVERSE_BELOW_REQUIRED_COVERAGE');
const seenIds = new Set(),seenNames = new Set();
for (const item of entries) {
  if (typeof item.id!=='string' || !/^[a-zA-Z0-9:_-]{1,160}$/.test(item.id)
      || seenIds.has(item.id)) throw new Error('CATALOG_DUPLICATE_OR_INVALID_ID:'+item.id);
  seenIds.add(item.id);
  if (typeof item.name!=='string' || !normalizedName(item.name) || seenNames.has(normalizedName(item.name))) {
    throw new Error('CATALOG_DUPLICATE_OR_INVALID_NAME:'+item.id);
  }
  seenNames.add(normalizedName(item.name));
  if (!item.category || typeof item.category!=='string') throw new Error('CATALOG_CATEGORY_MISSING:'+item.id);
  if (item.referenceUrl !== null) {
    const parsed = new URL(item.referenceUrl);
    if (parsed.protocol!=='https:' || !['sebi.gov.in','www.sebi.gov.in','rbi.org.in',
      'www.rbi.org.in','m.rbi.org.in','indianbank.bank.in',
      'niftyindices.com','www.niftyindices.com','pfrda.org.in',
      'www.pfrda.org.in','bis.gov.in','www.bis.gov.in'].includes(parsed.hostname)) {
      throw new Error('CATALOG_REFERENCE_SOURCE_UNTRUSTED:'+item.id);
    }
    if (item.recordKind!=='ARCHETYPE' || item.recommendationEligible!==false
        || item.availability!=='UNVERIFIED'
        || item.marketDataStatus!=='UNAVAILABLE' || item.postTaxStatus!=='UNAVAILABLE'
        || item.verificationScope!=='REGULATORY_CATEGORY_OR_INDEX_ONLY') {
      throw new Error('CATALOG_EXTENSION_CLAIMS_UNVERIFIED_FACTS:'+item.id);
    }
  }
}
const client = await pool.connect();
let inserted=0;
try {
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtext('wealthgenie_financial_catalog_seed'))");
  for (const entry of entries) {
    const catId=slug(entry.category);
    const sub=typeof entry.subCategory==='string' ? entry.subCategory.trim():'';
    const subId=sub?slug(entry.category+'::'+sub):null;
    await client.query(
      'INSERT INTO finance.categories(id,label) VALUES($1,$2) ON CONFLICT(id) DO NOTHING',
      [catId,entry.category]);
    if (subId) await client.query(
      'INSERT INTO finance.subcategories(id,category_id,label) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',
      [subId,catId,sub]);
    const {rows} = await client.query(
      `SELECT name,category_id,subcategory_id,record_kind,recommendation_eligible,
         availability,discovery_reference_url,verification_scope,
         (discovery_metadata IS NOT DISTINCT FROM $2::jsonb) AS metadata_matches
         FROM finance.products WHERE id=$1 FOR UPDATE`,[entry.id,entry.discoveryMetadata ? JSON.stringify(entry.discoveryMetadata):null]);
    if (rows.length) {
      const p=rows[0];
      if (p.name!==entry.name || p.category_id!==catId
          || p.subcategory_id!==subId || p.record_kind!=='ARCHETYPE'
          || p.recommendation_eligible!==false || p.availability!=='UNVERIFIED'
          || p.discovery_reference_url!==(entry.referenceUrl||null)
          || p.verification_scope!==entry.verificationScope
          || p.metadata_matches!==true) {
        throw new Error('CATALOG_IDENTITY_OR_EVIDENCE_CONFLICT:'+entry.id);
      }
      continue;
    }
    await client.query(
      `INSERT INTO finance.products(id,name,record_kind,category_id,subcategory_id,
        availability,recommendation_eligible,discovery_reference_url,verification_scope,
        assessed_as_of,discovery_metadata)
       VALUES($1,$2,'ARCHETYPE',$3,$4,'UNVERIFIED',false,$5,$6,$7,$8::jsonb)`,
      [entry.id,entry.name,catId,subId,
        entry.referenceUrl,entry.verificationScope,entry.assessedAsOf,
        entry.discoveryMetadata ? JSON.stringify(entry.discoveryMetadata) : null]);
    inserted+=1;
  }
  const result=await client.query(
    "SELECT count(*)::integer AS count FROM finance.products WHERE record_kind='ARCHETYPE'",
  );
  if (result.rows[0].count < entries.length) throw new Error('CATALOG_COUNT_RECONCILIATION_FAILED');
  await client.query('COMMIT');
  process.stdout.write(JSON.stringify({
    status:'RECONCILED',
    existingCatalog:investmentDatabase.length,
    sourcedDiscoveryArchetypes:extensionManifest.entries.length,
    sourceCount:entries.length,inserted,existing:result.rows[0].count,
    inventedActualProducts:0,newlyEnabledRecommendations:0,
  })+'\n');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
