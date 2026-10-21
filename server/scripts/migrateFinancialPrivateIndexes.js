import mongoose from 'mongoose';
import { migrateFinancialPrivateIndexes } from '../services/financialPrivateIndexReadiness.js';
const uri=String(process.env.MONGODB_MIGRATION_URI||'').trim();
if(!uri)throw new Error('MONGODB_MIGRATION_URI is required for the explicit financial-state index migration');
try{
 await mongoose.connect(uri,{autoIndex:false});
 const readiness=await migrateFinancialPrivateIndexes();
 process.stdout.write(JSON.stringify({status:'PRIVATE_FINANCIAL_INDEXES_READY',...readiness})+'\n');
}catch(error){
 process.stderr.write('Financial index migration failed: '+(error.code||error.name||'UNKNOWN')+'\n');
 process.exitCode=1;
}finally{await mongoose.disconnect();}
