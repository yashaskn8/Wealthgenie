import 'dotenv/config';
import {readFile,stat,realpath} from 'node:fs/promises';
import {isAbsolute,relative,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Pool} from 'pg';
import {createFinancialPostgresPoolOptions} from '../postgres/poolConfig.js';
import {applySignedProviderEntitlement} from '../postgres/applySignedProviderEntitlement.js';

// Trust anchors must be independently established with each provider, then
// provisioned outside the repo and outside the signed receipt file itself.
// No agreement, agreement hash or phone document is ever accessed.
const repoRoot=dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const withinRepo = p => {const r=relative(repoRoot,p);return r===''||(!r.startsWith('..')&&!isAbsolute(r));};
async function loadExternalJson(path,maxSize){
  if(!isAbsolute(path||''))throw new Error('TRUSTED_LOCAL_RECEIPT_PATH_REQUIRED');
  const abs=await realpath(path);
  if(withinRepo(abs))throw new Error('ENTITLEMENT_INPUT_MUST_BE_OUTSIDE_REPOSITORY');
  const info=await stat(abs);
  if(!info.isFile()||info.size<1||info.size>maxSize)throw new Error('ENTITLEMENT_INPUT_SIZE_INVALID');
  return JSON.parse(await readFile(abs,'utf8'));
}
if(process.argv.length!==4||process.argv[3]!=='--apply'
  ||process.env.FINANCE_RIGHTS_OPERATOR_CONFIRMED!=='yes'
  ||!process.env.FINANCIAL_POSTGRES_URL
  ||!process.env.FINANCE_PROVIDER_TRUST_ANCHORS_PATH)
  throw new Error('EXPLICIT_VERIFIED_PROVIDER_OPERATOR_REQUIRED');
const anchors=await loadExternalJson(process.env.FINANCE_PROVIDER_TRUST_ANCHORS_PATH,65536);
const receipt=await loadExternalJson(process.argv[2],32768);
const pool=new Pool(createFinancialPostgresPoolOptions(process.env,{max:1}));
try{
  const result=await applySignedProviderEntitlement(pool,receipt,anchors);
  process.stdout.write(JSON.stringify(result)+'\n');
}finally{await pool.end();}
