import 'dotenv/config';
if(!process.env.FINANCIAL_POSTGRES_URL)throw new Error('FINANCIAL_POSTGRES_URL_REQUIRED');
const {Pool}=await import('pg');
const pool=new Pool({connectionString:process.env.FINANCIAL_POSTGRES_URL,max:1,connectionTimeoutMillis:5000,
 statement_timeout:30000});
try{
 // Observation corrections cascade when the linked source data is deleted.
 // Never purge live holdings or private financial state; they are MongoDB-owned.
 const result=await pool.query(
  'DELETE FROM finance.market_observations WHERE retain_until IS NOT NULL AND retain_until<=now()'
 );
 process.stdout.write(JSON.stringify({status:'PRUNED',expiredObservations:result.rowCount})+'\n');
}finally{await pool.end();}
