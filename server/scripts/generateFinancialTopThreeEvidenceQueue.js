import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { investmentDatabase } from '../data/investmentDatabase.js';

const manifest=JSON.parse(readFileSync(new URL('../data/investmentUniverseExtensions2026.json',import.meta.url),'utf8'));
export const REVIEW_QUEUE_STATUS='ACTUAL_PRODUCT_EVIDENCE_REQUIRED';
const csv=value=>'"'+String(value??'').replaceAll('"','""')+'"';
export function buildTopThreeProductEvidenceQueue({
  legacy=investmentDatabase,extensions=manifest.entries,
}={}){
  if(!Array.isArray(legacy)||!Array.isArray(extensions)||legacy.length!==155
    ||extensions.length!==95)throw new Error('FINANCIAL_250_FAMILY_INVENTORY_INVALID');
  const combined=[
    ...legacy.map(f=>({id:f.id,name:f.name,category:f.category,sourceUrl:null,recordKind:'ARCHETYPE'})),
    ...extensions.map(f=>({id:f.id,name:f.name,category:f.category,
      sourceUrl:f.sourceUrl,recordKind:f.recordKind})),
  ];
  const seen=new Set();
  for(const f of combined){
    if(typeof f.id!=='string'||!/^[a-zA-Z0-9:_-]{1,160}$/.test(f.id)
      ||seen.has(f.id)||typeof f.name!=='string'||!f.name.trim()
      ||typeof f.category!=='string'||!f.category.trim()
      ||f.recordKind!=='ARCHETYPE')
      throw new Error('FINANCIAL_FAMILY_INVENTORY_DUPLICATE_OR_INVALID');
    seen.add(f.id);
  }
  return combined.flatMap(f=>[1,2,3].map(slot=>({
    familyId:f.id,familyName:f.name,category:f.category,slot,
    categoryEvidenceUrl:f.sourceUrl||'',
    actualProductId:'',issuerName:'',issuerOfficialDocumentUrl:'',
    officialProductTermsUrl:'',riskEvidenceUrl:'',taxEvidenceUrl:'',
    providerSourceId:'',providerInstrumentId:'',dataUseRightsEvidenceUrl:'',
    independentReviewer:'',approvedAt:'',expiresAt:'',
    status:REVIEW_QUEUE_STATUS,
  })));
}
export function topThreeEvidenceQueueCsv(rows=buildTopThreeProductEvidenceQueue()){
  if(!Array.isArray(rows)||rows.length!==750)
    throw new Error('FINANCIAL_REVIEW_QUEUE_MUST_CONTAIN_750_DISTINCT_SLOTS');
  const keys=['familyId','familyName','category','slot','categoryEvidenceUrl',
    'actualProductId','issuerName','issuerOfficialDocumentUrl','officialProductTermsUrl',
    'riskEvidenceUrl','taxEvidenceUrl','providerSourceId','providerInstrumentId',
    'dataUseRightsEvidenceUrl','independentReviewer','approvedAt','expiresAt','status'];
  return keys.join(',')+'\n'+rows.map(row=>keys.map(key=>csv(row[key])).join(',')).join('\n')+'\n';
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  process.stdout.write(topThreeEvidenceQueueCsv());
}
