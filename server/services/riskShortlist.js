import { investmentDatabase } from '../data/investmentDatabase.js';
import { filterEligible, getInstrumentRisk } from './RecommendationPipeline.js';
const ORDER = Object.freeze(['LOW','MODERATE','AGGRESSIVE']);
export function buildRiskShortlist({ profile, instruments }) {
  if (!profile || !Array.isArray(instruments)) throw new TypeError('Current profile and allocation required');
  const output={LOW:[],MODERATE:[],AGGRESSIVE:[]};
  const seen=new Set();
  for(const item of instruments) {
    const id=item?.id;
    if(typeof id!=='string' || seen.has(id)) continue;
    seen.add(id);
    const product=investmentDatabase.find(p=>p.id===id);
    if(!product) continue;
    const eligible=filterEligible([product],profile);
    if(!eligible?.eligible?.some(p=>p.id===id)) continue;
    const score=getInstrumentRisk(product);
    if(!Number.isFinite(score) || score<1 || score>5) continue;
    const group=score<=2?'LOW':score===3?'MODERATE':'AGGRESSIVE';
    if(output[group].length===5) continue;
    output[group].push({
      canonicalParentId:id,
      name:product.name,
      riskGroup:group,
      riskScore:score,
      suitabilityScope:'SAVED_PARENT_CATEGORY',
      productSpecificSuitability:'NOT_ESTABLISHED',
    });
  }
  return {groups:output,selectedCount:ORDER.reduce((n,key)=>n+output[key].length,0),
    maxPerGroup:5,notFilledWithUnsuitableInstruments:true,qualificationScope:'PARENT_CATEGORY_ONLY'};
}
