import 'dotenv/config';
import crypto from 'node:crypto';
import { investmentDatabase } from '../data/investmentDatabase.js';
if(!process.env.FINANCIAL_POSTGRES_URL)throw new Error('FINANCIAL_POSTGRES_URL_REQUIRED');
const {Pool}=await import('pg');
const pool=new Pool({connectionString:process.env.FINANCIAL_POSTGRES_URL,max:1,connectionTimeoutMillis:5000});
function slug(label){
 const normalized=label.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,55)||'category';
 return normalized+'-'+crypto.createHash('sha256').update(label).digest('hex').slice(0,8);
}
const client=await pool.connect();
let inserted=0;
try{
 await client.query('BEGIN');
 const seen=new Set();
 for(const entry of investmentDatabase){
  const id=String(entry.id||'');
  if(!/^[a-zA-Z0-9:_-]{1,160}$/.test(id)||seen.has(id))throw new Error('CATALOG_DUPLICATE_OR_INVALID_ID:'+JSON.stringify(id));
  seen.add(id);
  const category=String(entry.category||'').trim();
  if(!category)throw new Error('CATALOG_CATEGORY_MISSING');
  const catId=slug(category);
  const sub=typeof entry.subCategory==='string'?entry.subCategory.trim():'';
  const subId=sub?slug(category+'::'+sub):null;
  await client.query(
    'INSERT INTO finance.categories(id,label) VALUES($1,$2) ON CONFLICT(id) DO NOTHING',
    [catId,category]);
  if(subId)await client.query(
    'INSERT INTO finance.subcategories(id,category_id,label) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',
    [subId,catId,sub]);
  const exists=await client.query(
    'SELECT name,category_id,subcategory_id,record_kind FROM finance.products WHERE id=$1',[id]);
  if(exists.rows.length){
    const p=exists.rows[0];
    if(p.name!==entry.name||p.category_id!==catId||p.subcategory_id!==subId||p.record_kind!=='ARCHETYPE'){
      throw new Error('CATALOG_IDENTITY_CONFLICT:'+id);
    }
    continue;
  }
  await client.query(
    `INSERT INTO finance.products(id,name,record_kind,category_id,subcategory_id,
        availability,recommendation_eligible)
       VALUES($1,$2,'ARCHETYPE',$3,$4,'UNVERIFIED',false)`,
    [id,entry.name,catId,subId]);
  inserted+=1;
 }
 const counts=await client.query('SELECT count(*)::integer AS count FROM finance.products WHERE record_kind=$1',['ARCHETYPE']);
 if(counts.rows[0].count<seen.size)throw new Error('CATALOG_COUNT_RECONCILIATION_FAILED');
 await client.query('COMMIT');
 process.stdout.write(JSON.stringify({status:'RECONCILED',sourceCount:seen.size,inserted,existing:counts.rows[0].count})+'\n');
}catch(error){await client.query('ROLLBACK');throw error;}
finally{client.release();await pool.end();}
